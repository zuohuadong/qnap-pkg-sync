import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SyncError, planPurchases, shareLink, verifyMetadata, listAllPages, reconcile, markdownReport } from '../scripts/purchase-sync-core.mjs';
import { downloadPackage, createAdapter, jsonResponse, httpsUrl } from '../scripts/sync-purchases.mjs';

const app = (name = 'New Software', version = '1.0', arch = 'x86_64') => ({ name, internalName: name.replaceAll(' ', ''), version,
  platform: [{ platformID: arch, location: `https://purchase.example/${name.replaceAll(' ', '')}_${version}_${arch}.qpkg?token=PRIVATE_TOKEN`, signature: 'opaque-signature' }] });
const feed = (...items) => ({ plugins: { item: items } });
const plan = (name = 'New Software') => planPurchases(feed(app(name))).plans[0];
const row = (p, id = '101', size = 1024) => ({ key: `f${id}`, name: p.filename, size,
  weblink: `https://url78.ctfile.com/f/59378-${id}-abcdef`, default_passcode: '1794' });
const pub = r => ({ code: 200, file: { file_id: r.key.slice(1), file_name: r.name } });
const md5 = 'd41d8cd98f00b204e9800998ecf8427e';
function fake(plans, initial = []) {
  const rows = [...initial], counts = { uploads: 0, downloads: 0, cleanup: 0, folder: 0 };
  const adapter = {
    inventory: async () => [...rows], publicInfo: async url => { const id = new URL(url).pathname.split('-')[1]; return pub(rows.find(r => r.key === `f${id}`)); },
    download: async () => { counts.downloads++; return { fileSize: 1024, md5, path: '/fake' }; },
    ensureDestination: async () => { counts.folder++; return { id: '1' }; },
    upload: async p => { const id = String(200 + ++counts.uploads); rows.push(row(p, id)); return { fileId: id }; },
    refresh: async () => [...rows], cleanup: async () => { counts.cleanup++; }, pause: async () => {},
  };
  return { adapter, rows, counts };
}

test('discovers every newly purchased product, not a PostgreSQL allowlist', () => {
  assert.equal(planPurchases(feed(app('PostgreSQL 18'), app('Another Purchase'))).plans.length, 2);
});
test('singleton XML items and platforms are normalized', () => {
  const a = app(); a.platform = a.platform[0];
  assert.equal(planPurchases({ plugins: { item: a } }).plans.length, 1);
});
test('NAS aliases sharing binary and rotating query tokens do not duplicate work', () => {
  const a = app(); a.platform.push({ ...a.platform[0], platformID: 'TS-NASX86', location: a.platform[0].location.replace('PRIVATE_TOKEN', 'ROTATED') });
  assert.equal(planPurchases(feed(a)).plans.length, 1);
});
test('same filename with conflicting signatures is blocked', () => {
  const a = app(); a.platform.push({ ...a.platform[0], signature: 'different' });
  const desired = planPurchases(feed(a));
  assert.equal(desired.plans.length, 0); assert.equal(desired.failures[0].error, 'CONFLICTING_PACKAGE_IDENTITY');
});
test('invalid product does not hide a valid product', () => {
  const desired = planPurchases(feed({ name: 'Broken' }, app()));
  assert.equal(desired.plans.length, 1); assert.equal(desired.failures.length, 1);
});
test('missing version can be recovered from versioned filename', () => {
  const a = app(); delete a.version;
  assert.equal(planPurchases(feed(a)).plans[0].version, '1.0');
});
test('invalid feed and absent explicit product fail closed', () => {
  assert.throws(() => planPurchases({}), /INVALID_PURCHASE_FEED/);
  assert.throws(() => planPurchases(feed(app()), 'Absent'), /PRODUCT_NOT_IN_PURCHASE_FEED/);
  assert.equal(planPurchases(feed()).plans.length, 0);
});
test('normalization collisions do not mix unrelated product folders', () => {
  const desired = planPurchases(feed(app('A+B'), app('AB')));
  assert.equal(desired.plans.length, 0);
  assert.ok(desired.failures.length);
});
test('rejects credential URLs, HTTP and encoded traversal filenames', () => {
  for (const url of ['http://example/a.qpkg', 'https://user:pass@example/a.qpkg', 'https://example/%2e%2e%2fa.qpkg']) {
    const a = app(); a.platform[0].location = url;
    assert.equal(planPurchases(feed(a)).plans.length, 0);
  }
});
test('returns only API-provided canonical shares with passcode, no other query secrets', () => {
  assert.equal(shareLink({ weblink: 'https://url78.ctfile.com/f/1-2-abc?session=SECRET', default_passcode: '1794' }), 'https://url78.ctfile.com/f/1-2-abc?p=1794');
  assert.throws(() => shareLink({ key: 'f123' }), /MISSING_CANONICAL/);
  assert.throws(() => shareLink({ weblink: 'https://ctfile.com.attacker.example/f/123' }), /MISSING_CANONICAL/);
  assert.throws(() => shareLink({ weblink: 'https://url78.ctfile.com/dir/123' }), /MISSING_CANONICAL/);
});
test('public filename, ID, byte size and available MD5 must match', () => {
  const p = plan(), r = row(p);
  assert.equal(verifyMetadata(p, r, pub(r), { fileId: '101', fileSize: 1024 }).filename, p.filename);
  assert.throws(() => verifyMetadata(p, r, pub(r), { fileId: '999' }), /RECEIPT/);
  assert.throws(() => verifyMetadata(p, r, pub(r), { fileSize: 2048 }), /SIZE/);
  assert.throws(() => verifyMetadata(p, r, { code: 401 }), /PUBLIC_SHARE/);
  assert.throws(() => verifyMetadata(p, r, { code: 200, file: { file_id: 101, file_name: 'different' } }), /PUBLIC_IDENTITY/);
  assert.throws(() => verifyMetadata(p, r, { ...pub(r), file: { ...pub(r).file, md5: '0'.repeat(32) } }, { md5 }), /CHECKSUM/);
});
test('paginated inventory passes default passcode to files and detects repeated pages', async () => {
  const p = plan();
  const result = await listAllPages(async page => ({ code: 200, results: page < 3 ? [row(p, String(page))] : [], default_passcode: '1234' }), 1);
  assert.equal(result.length, 2);
  await assert.rejects(listAllPages(async () => ({ code: 200, results: [row(p)] }), 1), /PAGINATION/);
  await assert.rejects(listAllPages(async () => ({ code: 403 })), /LIST_FAILED/);
});
test('uploads missing packages and skips verified remote files without any cache', async () => {
  const desired = planPurchases(feed(app('One'), app('Two'))), f = fake(desired.plans, [row(desired.plans[0])]);
  const report = await reconcile(desired, f.adapter);
  assert.equal(report.complete, true); assert.equal(f.counts.uploads, 1); assert.equal(f.counts.cleanup, 1);
});
test('failed upload remains pending; new runner re-downloads it even if the feed did not change', async () => {
  const desired = planPurchases(feed(app())), f = fake(desired.plans), good = f.adapter.upload;
  f.adapter.upload = async () => { throw new Error('timeout with SECRET'); };
  const first = await reconcile(desired, f.adapter);
  assert.equal(first.pending.length, 1); assert.equal(first.verified.length, 0);
  assert.ok(!JSON.stringify(first).includes('SECRET'));
  f.adapter.upload = good;
  const second = await reconcile(desired, f.adapter);
  assert.equal(second.complete, true); assert.equal(f.counts.downloads, 2);
});
test('lost upload acknowledgement is recovered by remote readback, no second upload', async () => {
  const desired = planPurchases(feed(app())), f = fake(desired.plans), good = f.adapter.upload;
  f.adapter.upload = async (...args) => { await good(...args); throw new Error('lost response'); };
  assert.equal((await reconcile(desired, f.adapter)).complete, true);
  assert.equal(f.counts.uploads, 1);
});
test('public API failure is pending verification, not another upload', async () => {
  const desired = planPurchases(feed(app())), f = fake(desired.plans, [row(desired.plans[0])]);
  f.adapter.publicInfo = async () => ({ code: 500 });
  const report = await reconcile(desired, f.adapter);
  assert.equal(report.pending[0].stage, 'verification'); assert.equal(f.counts.uploads, 0);
});
test('inventory failure never masquerades as an empty remote folder', async () => {
  const desired = planPurchases(feed(app())), f = fake(desired.plans);
  f.adapter.inventory = async () => { throw new Error('authentication failed'); };
  assert.equal((await reconcile(desired, f.adapter)).pending[0].stage, 'inventory');
  assert.equal(f.counts.downloads, 0);
});
test('a product failure does not prevent later purchases from syncing', async () => {
  const desired = planPurchases(feed(app('Bad'), app('Good'))), f = fake(desired.plans), original = f.adapter.download;
  f.adapter.download = async p => { if (p.productName === 'Bad') throw new Error('network'); return original(p); };
  const report = await reconcile(desired, f.adapter);
  assert.equal(report.pending.length, 1); assert.equal(report.verified.length, 1);
});
test('dry-run has no writes, folder creation, downloads, or uploads', async () => {
  const desired = planPurchases(feed(app())), f = fake(desired.plans), receipts = {};
  const report = await reconcile(desired, f.adapter, { dryRun: true, receipts });
  assert.equal(report.mode, 'audit'); assert.equal(report.pending[0].stage, 'missing');
  assert.deepEqual(receipts, {}); assert.equal(f.counts.folder + f.counts.downloads + f.counts.uploads, 0);
});
test('changed source signature republishes but unchanged receipts skip', async () => {
  const desired = planPurchases(feed(app())), p = desired.plans[0], f = fake(desired.plans, [row(p)]);
  const receipts = { [p.key]: { fingerprint: 'old', fileId: '101', fileSize: 1024 } };
  assert.equal((await reconcile(desired, f.adapter, { receipts })).complete, true);
  assert.equal(f.counts.uploads, 1);
  assert.equal((await reconcile(desired, f.adapter, { receipts })).complete, true);
  assert.equal(f.counts.uploads, 1);
});
test('old same-name revision cannot falsely confirm a failed republish', async () => {
  const desired = planPurchases(feed(app())), p = desired.plans[0], f = fake(desired.plans, [row(p)]);
  f.adapter.upload = async () => { throw new Error('lost'); };
  const receipts = { [p.key]: { fingerprint: 'old', fileId: '101', fileSize: 1024 } };
  const report = await reconcile(desired, f.adapter, { receipts });
  assert.equal(report.complete, false); assert.equal(receipts[p.key].fingerprint, 'old');
});
test('persisted reports contain unfinished packages from the outset and no source credentials', async () => {
  const desired = planPurchases(feed(app())), f = fake(desired.plans), snapshots = [];
  const report = await reconcile(desired, f.adapter, { save: async r => snapshots.push(JSON.stringify(r)) });
  assert.equal(JSON.parse(snapshots[0]).pending.length, 1);
  const outputs = snapshots.join('') + markdownReport(report);
  assert.ok(!outputs.includes('PRIVATE_TOKEN')); assert.ok(!outputs.includes('opaque-signature')); assert.ok(!outputs.includes('purchase.example'));
});
test('budget exhaustion preserves unprocessed work for next run', async () => {
  const desired = planPurchases(feed(app())), f = fake(desired.plans);
  const report = await reconcile(desired, f.adapter, { budgetMs: 0 });
  assert.equal(report.pending[0].stage, 'unprocessed'); assert.equal(f.counts.uploads, 0);
});
test('disk download validates actual byte count and checksum without forwarding credentials', async () => {
  const data = Buffer.alloc(1024, 7), p = plan(); p.signature = createHash('md5').update(data).digest('hex');
  let sent;
  const local = await downloadPackage(p, async (_url, options) => { sent = options; return new Response(data, { headers: { 'content-length': '1024' } }); });
  try {
    assert.equal(local.fileSize, 1024); assert.deepEqual(await readFile(local.path), data); assert.equal(sent.headers, undefined);
  } finally { await (await import('node:fs/promises')).rm(local.directory, { recursive: true, force: true }); }
});
test('rejects truncated payload, oversize payload, error document, and checksum mismatch', async () => {
  const p = plan(), data = Buffer.alloc(1024);
  await assert.rejects(downloadPackage(p, async () => new Response(data, { headers: { 'content-length': '2048' } })), /INCOMPLETE/);
  await assert.rejects(downloadPackage(p, async () => new Response(data), 512), /SIZE_LIMIT/);
  await assert.rejects(downloadPackage(p, async () => new Response('<html>' + 'a'.repeat(1024))), /ERROR_DOCUMENT/);
  p.signature = '1'.repeat(32);
  await assert.rejects(downloadPackage(p, async () => new Response(data)), /CHECKSUM/);
});
test('JSON stream preserves Unicode names split across network chunks', async () => {
  const bytes = new TextEncoder().encode('{"name":"软件"}');
  const body = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
  assert.deepEqual(await jsonResponse(new Response(body)), { name: '软件' });
});
test('adapter scans historical nested folders with the file-list endpoint', async () => {
  const p = plan(), calls = [];
  const adapter = createAdapter({ CTFILE_SESSION: 'secret', CTFILE_FOLDER_ID: '1' }, { fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push([url, body.folder_id]);
    const folder = url.includes('folder/list');
    const rows = body.folder_id === 'd1' ? [{ key: 'd2', icon: 'folder', name: p.folder }]
      : body.folder_id === 'd2' && folder ? [{ key: 'd3', icon: 'folder', name: '2025-01' }]
      : body.folder_id === 'd3' && !folder ? [row(p)] : [];
    return Response.json({ code: 200, results: rows });
  } });
  assert.equal((await adapter.inventory(p))[0].name, p.filename);
  assert.ok(calls.some(([url, id]) => url.endsWith('file/list') && id === 'd3'));
});
test('transport URL validation prevents credential disclosure to other hosts', () => {
  assert.throws(() => httpsUrl('https://ctfile.com.evil.example/upload', true), /UNSAFE_URL/);
  assert.throws(() => httpsUrl('https://user:secret@ctfile.com/upload', true), /UNSAFE_URL/);
});
test('unambiguous unsent REST upload can use configured CTFile WebDAV; ambiguity cannot', async () => {
  const p = plan(), calls = [], env = { CTFILE_SESSION: 's', CTFILE_FOLDER_ID: '1', WEBDAV_URL: 'https://webdav.ctfile.com', WEBDAV_USERNAME: 'u', WEBDAV_PASSWORD: 'p' };
  const adapter = createAdapter(env, { fetchImpl: async () => Response.json({ code: 200, upload_url: 'https://upload.ctfile.com/upload?s=secret' }),
    transfer: async (url, local, options) => { calls.push(url); if (!options) throw new SyncError('UPLOAD_NOT_SENT'); return {}; } });
  await adapter.upload(p, { fileSize: 1024, md5 }, { id: '2', relativePath: 'New_Software/2026-10' });
  assert.equal(calls.length, 2); assert.ok(calls[1].includes('/qnaporg-github/New_Software/2026-10/'));
  const ambiguous = createAdapter(env, { fetchImpl: async () => Response.json({ code: 200, upload_url: 'https://upload.ctfile.com/upload' }), transfer: async () => { throw new SyncError('UPLOAD_AMBIGUOUS'); } });
  await assert.rejects(ambiguous.upload(p, { fileSize: 1024, md5 }, { id: '2' }), /AMBIGUOUS/);
});
