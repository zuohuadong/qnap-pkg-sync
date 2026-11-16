import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from '../scripts/sync-purchases.mjs';
import { SyncError, planPurchases, reconcile, markdownReport } from '../scripts/purchase-sync-core.mjs';

const desired = (...names) => planPurchases({ plugins: { item: names.map(name => ({
  name, version: '1.0', platform: [{ platformID: 'x86_64',
    location: `https://purchase.example/${name}_1.0_x86_64.qpkg?token=PRIVATE_TOKEN`, signature: 'opaque' }],
})) } });
const md5 = '1'.repeat(32);
const env = { CTFILE_SESSION: 'PRIVATE_SESSION', CTFILE_FOLDER_ID: '1',
  WEBDAV_URL: 'https://dav.example/base%20folder?token=PRIVATE_QUERY',
  WEBDAV_USERNAME: 'PRIVATE_USERNAME', WEBDAV_PASSWORD: 'PRIVATE_PASSWORD' };
const statXml = (url, size = 1024) => `<d:multistatus xmlns:d="DAV:"><d:response>
  <d:href>${new URL(url).pathname}</d:href><d:propstat><d:prop><d:getcontentlength>${size}</d:getcontentlength></d:prop>
  <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

function harness(overrides = {}, configuration = {}) {
  const counts = { ctUploads: 0, puts: 0, stats: 0, downloads: 0, cleanup: 0, inventory: 0, refresh: 0 };
  const events = [], folders = [], rows = [];
  const adapter = createAdapter({ ...env, ...configuration }, {
    requestIntervalMs: 0,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/file/upload')) {
        counts.ctUploads++; events.push('ct-upload');
        return overrides.uploadResponse?.() || Response.json({ code: 503 });
      }
      if (url.endsWith('/file/list')) return Response.json({ code: 200, results: rows });
      if (url.endsWith('/folder/list')) return Response.json({ code: 200, results:
        body.folder_id === 'd1' ? [{ key: 'd2', icon: 'folder', name: 'One' }]
          : body.folder_id === 'd2' ? [{ key: 'd3', icon: 'folder', name: new Date().toISOString().slice(0, 7) }] : [] });
      assert.fail('Unexpected CTFile endpoint');
    },
    transfer: async (url, local, options) => {
      if (!options?.webdav) {
        events.push('ct-transfer');
        return overrides.ctTransfer?.(rows) || { fileId: '101' };
      }
      assert.ok(!url.includes('PRIVATE'));
      assert.equal(options.webdav.username, env.WEBDAV_USERNAME);
      assert.equal(options.webdav.password, env.WEBDAV_PASSWORD);
      if (options.method === 'MKCOL') {
        folders.push(new URL(url).pathname);
        return { status: overrides.folderStatus || 201 };
      }
      if (options.method === 'PUT') {
        counts.puts++; events.push('dav-put');
        assert.equal(local.fileSize, 1024);
        return { status: overrides.putStatus || 201 };
      }
      assert.equal(options.method, 'PROPFIND');
      counts.stats++; events.push('dav-stat');
      if (overrides.statError) throw new Error('PRIVATE transport diagnostic');
      return { status: overrides.statStatus || 207, body: overrides.statBody?.(url) || statXml(url, overrides.size ?? 1024) };
    },
  });
  adapter.inventory = async () => { counts.inventory++; return []; };
  adapter.download = async () => { counts.downloads++; return { fileSize: 1024, md5, path: '/fake' }; };
  adapter.cleanup = async () => { counts.cleanup++; };
  adapter.refresh = async () => { counts.refresh++; events.push('ct-refresh'); return rows; };
  adapter.pause = async () => {};
  return { adapter, counts, events, folders };
}

test('WEBDAV_FALLBACK=always lists and verifies purchases over PROPFIND only', async () => {
  const plans = desired('One');
  const listing = (path, entries) => `<d:multistatus xmlns:d="DAV:">${entries.map(([name, size, folder]) => `<d:response><d:href>${path}${encodeURIComponent(name)}${folder ? '/' : ''}</d:href><d:propstat><d:prop><d:resourcetype>${folder ? '<d:collection/>' : ''}</d:resourcetype>${size != null ? `<d:getcontentlength>${size}</d:getcontentlength>` : ''}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`;
  const adapter = createAdapter({ ...env, WEBDAV_FALLBACK: 'always' }, {
    requestIntervalMs: 0,
    fetchImpl: async () => assert.fail('CTFile API must not be called'),
    transfer: async (url, local, options) => {
      assert.equal(options.method, 'PROPFIND');
      const path = decodeURIComponent(new URL(url).pathname).replace(/\/$/, '');
      if (path === '/base folder') return { status: 207, body: listing('/base folder/', [['One', null, true]]) };
      if (path === '/base folder/One') return { status: 207, body: listing('/base folder/One/', [['2026-11', null, true]]) };
      if (path === '/base folder/One/2026-11') return { status: 207, body: listing('/base folder/One/2026-11/', [[plans.plans[0].filename, 1024, false]]) };
      return { status: 404, body: '' };
    },
  });
  const report = await reconcile(plans, adapter);
  assert.equal(report.pending.length, 0, JSON.stringify(report.pending));
  assert.equal(report.verified[0].storage, 'webdav');
  assert.ok(report.verified[0].webdavPath.endsWith(plans.plans[0].filename));
});

test('upload URL failure uses verified WebDAV, persists receipts, and opens the per-run circuit', async t => {
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(line));
  const plans = desired('One', 'Two'), h = harness(), receipts = {}, saved = [];
  const report = await reconcile(plans, h.adapter, { receipts, save: async (_report, current) => saved.push(structuredClone(current)) });
  assert.equal(report.complete, true); assert.equal(report.verified.length, 2);
  assert.equal(h.counts.ctUploads, 1); assert.equal(h.counts.downloads, 2); assert.equal(h.counts.puts, 2);
  assert.equal(h.counts.cleanup, 2); assert.equal(h.counts.refresh, 0);
  assert.deepEqual(logs, ['CTFILE_UPLOAD_DEGRADED switched=webdav']);
  assert.ok(h.folders.includes('/base%20folder/qnaporg-github'));
  for (const [index, plan] of plans.plans.entries()) {
    const verified = report.verified[index];
    const path = `qnaporg-github/${plan.folder}/${new Date().toISOString().slice(0, 7)}/${plan.filename}`;
    assert.equal(verified.storage, 'webdav'); assert.equal(verified.webdavPath, path);
    assert.equal(verified.ctfileUrl, undefined); assert.equal(verified.action, 'uploaded');
    assert.equal(verified.checksumVerified, false);
    assert.deepEqual(receipts[plan.key], { fingerprint: plan.fingerprint, storage: 'webdav', path, fileSize: 1024, md5 });
    assert.deepEqual(saved.at(-1)[plan.key], receipts[plan.key]);
    assert.ok(markdownReport(report).includes(`WebDAV: ${path}`));
  }
  assert.ok(markdownReport(report).includes('| Location |'));
  const output = JSON.stringify(report) + JSON.stringify(receipts) + markdownReport(report) + logs.join('\n');
  for (const secret of ['dav.example', 'purchase.example', 'PRIVATE', 'undefined', '[Download]']) assert.ok(!output.includes(secret));

  const second = harness();
  const nextReport = await reconcile(plans, second.adapter, { receipts });
  assert.equal(nextReport.complete, true);
  assert.ok(nextReport.verified.every(entry => entry.action === 'existing' && entry.storage === 'webdav'));
  assert.deepEqual(second.counts, { ctUploads: 0, puts: 0, stats: 2, downloads: 0, cleanup: 0, inventory: 0, refresh: 0 });
});

test('a missing or mismatched WebDAV receipt resumes normal inventory and transfer', async () => {
  for (const overrides of [{ statStatus: 404 }, { statStatus: 500 }, { size: 2048 }, { statError: true }]) {
    const plans = desired('One'), h = harness(overrides);
    const receipts = { [plans.plans[0].key]: { fingerprint: plans.plans[0].fingerprint, storage: 'webdav',
      path: h.adapter.webdavPath('One/2026-10', plans.plans[0].filename), fileSize: 1024, md5 } };
    await reconcile(plans, h.adapter, { receipts });
    assert.equal(h.counts.inventory, 1); assert.equal(h.counts.downloads, 1);
  }
});

test('audit can reuse WebDAV receipts without transfer or receipt mutation', async () => {
  const plans = desired('One'), h = harness();
  const receipts = { [plans.plans[0].key]: { fingerprint: plans.plans[0].fingerprint, storage: 'webdav',
    path: h.adapter.webdavPath('One/2026-10', plans.plans[0].filename), fileSize: 1024, md5 } };
  const original = structuredClone(receipts);
  const report = await reconcile(plans, h.adapter, { receipts, dryRun: true });
  assert.equal(report.complete, true); assert.equal(report.mode, 'audit');
  assert.equal(report.verified[0].action, 'existing'); assert.deepEqual(receipts, original);
  assert.equal(h.counts.downloads + h.counts.ctUploads + h.counts.puts, 0);
});

test('CTFile HTTP and network upload URL failures fall back without replaying writes', async () => {
  for (const uploadResponse of [() => new Response('', { status: 503 }), () => { throw new Error('PRIVATE network diagnostic'); }]) {
    const h = harness({ uploadResponse });
    const report = await reconcile(desired('One'), h.adapter);
    assert.equal(report.complete, true); assert.equal(h.counts.ctUploads, 1);
    assert.equal(h.counts.puts, 1); assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  }
});

test('a changed source fingerprint never reuses an old WebDAV receipt', async () => {
  const plans = desired('One'), h = harness();
  const receipts = { [plans.plans[0].key]: { fingerprint: 'old', storage: 'webdav',
    path: h.adapter.webdavPath('One/2026-10', plans.plans[0].filename), fileSize: 1024, md5 } };
  assert.equal((await reconcile(plans, h.adapter, { receipts })).complete, true);
  assert.equal(h.counts.downloads, 1); assert.equal(h.counts.stats, 2);
});

test('WebDAV size mismatch fails closed and never records a receipt', async () => {
  const plans = desired('One'), h = harness({ size: 2048 }), receipts = {};
  const report = await reconcile(plans, h.adapter, { receipts });
  assert.equal(report.complete, false); assert.equal(report.pending[0].error, 'WEBDAV_SIZE_MISMATCH');
  assert.equal(report.verified.length, 0); assert.deepEqual(receipts, {});
  assert.equal(h.counts.puts, 1); assert.equal(h.counts.refresh, 0);
});

test('always skips CTFile upload entirely, including for later packages', async () => {
  const h = harness({}, { WEBDAV_FALLBACK: 'always' });
  const report = await reconcile(desired('One', 'Two'), h.adapter);
  assert.equal(report.complete, true); assert.equal(h.counts.ctUploads, 0); assert.equal(h.counts.puts, 2);
});

test('412 PUT and existing MKCOL statuses still require size verification', async () => {
  for (const folderStatus of [301, 405]) {
    const h = harness({ putStatus: 412, folderStatus });
    assert.equal((await reconcile(desired('One'), h.adapter)).complete, true);
    assert.equal(h.counts.puts, 1); assert.equal(h.counts.stats, 2);
  }
  const mismatch = harness({ putStatus: 412, size: 512 });
  assert.equal((await reconcile(desired('One'), mismatch.adapter)).pending[0].error, 'WEBDAV_SIZE_MISMATCH');
});

test('unsent CTFile transfer immediately falls back; ambiguity first gets every readback attempt', async () => {
  for (const code of ['UPLOAD_NOT_SENT', 'UPLOAD_AMBIGUOUS']) {
    const h = harness({ uploadResponse: () => Response.json({ code: 200, upload_url: 'https://upload.ctfile.com/upload' }),
      ctTransfer: () => { throw new SyncError(code); } });
    assert.equal((await reconcile(desired('One'), h.adapter)).complete, true);
    assert.equal(h.counts.puts, 1);
    assert.equal(h.counts.refresh, code === 'UPLOAD_NOT_SENT' ? 0 : 5);
    if (code === 'UPLOAD_AMBIGUOUS') assert.ok(h.events.lastIndexOf('ct-refresh') < h.events.indexOf('dav-put'));
  }
});

test('an ambiguous CTFile transfer recovered by readback does not upload to WebDAV', async () => {
  const plans = desired('One');
  const h = harness({ uploadResponse: () => Response.json({ code: 200, upload_url: 'https://upload.ctfile.com/upload' }),
    ctTransfer: rows => {
      rows.push({ key: 'f101', name: plans.plans[0].filename, size: 1024, weblink: 'https://url88.ctfile.com/f/101-example' });
      throw new SyncError('UPLOAD_AMBIGUOUS');
    } });
  const receipts = {};
  const report = await reconcile(plans, h.adapter, { receipts });
  assert.equal(report.complete, true); assert.equal(h.counts.refresh, 1); assert.equal(h.counts.puts, 0);
  assert.equal(report.verified[0].storage, undefined);
  assert.deepEqual(receipts[plans.plans[0].key], { fingerprint: plans.plans[0].fingerprint, fileId: '101', fileSize: 1024, md5 });
  assert.ok(markdownReport(report).includes('[Download](https://url88.ctfile.com/f/101-example)'));
});

test('unverified successful CTFile acknowledgement falls back once after readback', async () => {
  const h = harness({ uploadResponse: () => Response.json({ code: 200, upload_url: 'https://upload.ctfile.com/upload' }) });
  assert.equal((await reconcile(desired('One'), h.adapter)).complete, true);
  assert.equal(h.counts.refresh, 5); assert.equal(h.counts.puts, 1);
});

test('missing WebDAV config reports a stable error; off never invokes WebDAV', async () => {
  const missing = harness({}, { WEBDAV_PASSWORD: '' });
  assert.equal((await reconcile(desired('One'), missing.adapter)).pending[0].error, 'WEBDAV_NOT_CONFIGURED');
  assert.equal(missing.counts.refresh, 0);
  const off = harness({}, { WEBDAV_FALLBACK: 'off', WEBDAV_PASSWORD: '' });
  assert.equal((await reconcile(desired('One'), off.adapter)).pending[0].error, 'UPLOAD_NOT_VERIFIED');
  assert.equal(off.counts.refresh, 5); assert.equal(off.counts.stats + off.counts.puts, 0);
});

test('PROPFIND rejects missing properties, unrelated hrefs, unsafe XML, and failed propstat', async () => {
  const invalidBodies = [
    '<multistatus xmlns="DAV:"/>',
    '<!DOCTYPE multistatus><multistatus/>',
    '<broken',
    url => statXml(url).replace('1024', '-1'),
    url => statXml(url).replace('200 OK', '404 Not Found'),
    url => statXml(url).replace(new URL(url).pathname, '/unrelated.qpkg'),
  ];
  for (const body of invalidBodies) {
    const h = harness({ statBody: typeof body === 'function' ? body : () => body });
    assert.equal((await reconcile(desired('One'), h.adapter)).pending[0].error, 'WEBDAV_UPLOAD_NOT_VERIFIED');
  }
});

test('PROPFIND transport failure remains unverified rather than invoking CTFile readback', async () => {
  const h = harness({ statError: true }, { WEBDAV_FALLBACK: 'always' });
  const report = await reconcile(desired('One'), h.adapter);
  assert.equal(report.pending[0].error, 'WEBDAV_UPLOAD_NOT_VERIFIED');
  assert.equal(report.verified.length, 0); assert.equal(h.counts.refresh, 0);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});

test('WebDAV paths stay encoded and a receipt with the wrong filename is never trusted', async () => {
  const plans = desired('One'), h = harness({}, { WEBDAV_ROOT_PATH: '/root folder' });
  assert.equal(h.adapter.webdavPath('One/2026-10', plans.plans[0].filename), `root%20folder/One/2026-10/${plans.plans[0].filename}`);
  const receipts = { [plans.plans[0].key]: { fingerprint: plans.plans[0].fingerprint, storage: 'webdav',
    path: 'https://PRIVATE_USERNAME:PRIVATE_PASSWORD@dav.example/wrong.qpkg', fileSize: 1024 } };
  const report = await reconcile(plans, h.adapter, { receipts });
  assert.equal(report.complete, true); assert.equal(h.counts.downloads, 1);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});
