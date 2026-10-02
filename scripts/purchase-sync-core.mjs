import { createHash } from 'node:crypto';

export class SyncError extends Error {
  constructor(code) { super(code); this.name = 'SyncError'; this.code = code; }
}
const fail = code => { throw new SyncError(code); };
const array = x => x == null ? [] : Array.isArray(x) ? x : [x];
export const remoteName = x => String(x?.name || x?.file_name || x?.folder_name || '');
export const remoteId = x => String(x?.key || x?.file_id || x?.folder_id || x?.id || '');
export const isFolder = x => x?.icon === 'folder' || remoteId(x).startsWith('d');
export const folderName = name => String(name).replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').trim();
export const sourceFingerprint = signature => createHash('sha256').update(String(signature || '')).digest('hex');

export function packageFilename(location) {
  let url;
  try { url = new URL(location); } catch { fail('INVALID_PACKAGE_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('UNSAFE_PACKAGE_URL');
  const name = url.pathname.split('/').pop();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.qpkg$/i.test(name)) fail('INVALID_PACKAGE_FILENAME');
  return name;
}

/** The full authenticated feed is the desired state; local caches never remove work. */
export function planPurchases(config, product = '') {
  if (!config?.plugins || !Object.hasOwn(config.plugins, 'item')) fail('INVALID_PURCHASE_FEED');
  const plans = new Map();
  const failures = [];
  const owners = new Map();
  const blocked = new Set();
  for (const [index, app] of array(config.plugins.item).entries()) {
    if (product && app?.name !== product && app?.internalName !== product) continue;
    const productName = typeof app?.name === 'string' ? app.name : `Invalid item ${index + 1}`;
    try {
      const folder = folderName(productName);
      if (typeof app?.name !== 'string' || !folder || !array(app.platform).length) fail('INVALID_PRODUCT_METADATA');
      const owner = String(app.internalName || app.name);
      if (owners.has(folder) && owners.get(folder) !== owner) {
        blocked.add(folder);
        fail('PRODUCT_FOLDER_COLLISION');
      }
      owners.set(folder, owner);
      // Validate the entire product before admitting any of its binaries.
      const productPlans = [];
      for (const p of array(app.platform)) {
        const filename = packageFilename(p?.location);
        const version = String(app.version || filename.match(/_([\d.]+)_[^.]+\.qpkg$/)?.[1] || '');
        if (!version || !p.platformID) fail('INVALID_PLATFORM_METADATA');
        const key = `${folder}/${filename}`;
        const signature = typeof p.signature === 'string' ? p.signature : '';
        const fingerprint = sourceFingerprint(signature);
        productPlans.push({ key, folder, productName, version, filename,
          architecture: String(p.platformID), url: p.location, signature, fingerprint });
      }
      const local = new Map();
      for (const p of productPlans) {
        const previous = local.get(p.key) || plans.get(p.key);
        if (previous && (previous.fingerprint !== p.fingerprint || previous.version !== p.version ||
            new URL(previous.url).origin + new URL(previous.url).pathname !== new URL(p.url).origin + new URL(p.url).pathname)) {
          blocked.add(folder);
          fail('CONFLICTING_PACKAGE_IDENTITY');
        }
        if (!previous) local.set(p.key, p); // Multiple NAS model IDs may share one binary.
      }
      for (const [key, value] of local) plans.set(key, value);
    } catch (error) {
      failures.push({ productName, stage: 'metadata', error: error instanceof SyncError ? error.code : 'INVALID_PRODUCT_METADATA' });
    }
  }
  for (const [key, plan] of plans) if (blocked.has(plan.folder)) plans.delete(key);
  if (product && !plans.size && !failures.length) fail('PRODUCT_NOT_IN_PURCHASE_FEED');
  return { plans: [...plans.values()], failures };
}

export function shareLink(row) {
  for (const value of [row?.weblink, row?.share_url, row?.url, row?.short_url, row?.download_url]) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value, 'https://url88.ctfile.com');
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !(url.hostname === 'ctfile.com' || url.hostname.endsWith('.ctfile.com')) ||
          !/^\/(f|file)\/[A-Za-z0-9_-]+$/.test(url.pathname)) continue;
      // Only publish canonical share paths and the download passcode, not unrelated query tokens.
      const passcode = url.searchParams.get('p') ?? row.default_passcode;
      url.search = ''; url.hash = '';
      if (passcode) url.searchParams.set('p', String(passcode));
      return url.href;
    } catch { /* Try the next API-provided share field. */ }
  }
  fail('MISSING_CANONICAL_SHARE_LINK');
}

export function byteSize(row) {
  const value = [row?.file_size, row?.filesize, row?.size].find(x => typeof x === 'number' || (typeof x === 'string' && /^\d+$/.test(x)));
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 100) fail('INVALID_REMOTE_SIZE');
  return Number(value);
}

export function verifyMetadata(plan, row, publicData, expected = {}) {
  const id = remoteId(row).replace(/^f/, '');
  if (isFolder(row) || !/^\d+$/.test(id) || remoteName(row) !== plan.filename) fail('REMOTE_IDENTITY_MISMATCH');
  const size = byteSize(row);
  if (expected.fileId && id !== String(expected.fileId).replace(/^f/, '')) fail('UPLOAD_RECEIPT_MISMATCH');
  if (expected.fileSize != null && size !== expected.fileSize) fail('REMOTE_SIZE_MISMATCH');
  if (String(publicData?.code) !== '200') fail('PUBLIC_SHARE_UNAVAILABLE');
  const file = publicData.file || publicData.data?.file || publicData.data;
  if (!file || String(file.file_name || file.name || '') !== plan.filename ||
      String(file.file_id || file.id || '').replace(/^f/, '') !== id) fail('PUBLIC_IDENTITY_MISMATCH');
  const md5 = String(file.file_md5 || file.md5 || '').toLowerCase();
  if (expected.md5 && /^[a-f0-9]{32}$/.test(md5) && md5 !== expected.md5) fail('REMOTE_CHECKSUM_MISMATCH');
  return { ...publicPlan(plan), fileId: id, fileSize: size, ctfileUrl: shareLink(row),
    checksumVerified: Boolean(expected.md5 && md5 === expected.md5), verifiedAt: new Date().toISOString() };
}

export function publicPlan(p) {
  return { productName: p.productName, version: p.version, architecture: p.architecture, filename: p.filename };
}

export async function listAllPages(getPage, pageSize = 100) {
  const rows = [], seen = new Set();
  for (let page = 1; page <= 100; page++) {
    const data = await getPage(page, pageSize);
    if (String(data?.code) !== '200') fail('CTFILE_LIST_FAILED');
    const batch = data.results ?? data.data;
    if (!Array.isArray(batch)) fail('INVALID_CTFILE_LIST');
    for (const row of batch) {
      const key = remoteId(row);
      if (!key || seen.has(key)) fail('INCOMPLETE_CTFILE_PAGINATION');
      seen.add(key);
      rows.push({ ...row, default_passcode: row.default_passcode ?? data.default_passcode });
    }
    if (batch.length < pageSize) return rows;
  }
  fail('CTFILE_PAGINATION_LIMIT');
}

/** Adapter methods are injected so crash/retry and remote verification are testable offline. */
export async function reconcile({ plans, failures = [] }, adapter, options = {}) {
  const { dryRun = false, receipts = {}, save = async () => {}, budgetMs = 5 * 60 * 60 * 1000 } = options;
  const started = Date.now();
  const report = { schemaVersion: 1, mode: dryRun ? 'audit' : 'sync', startedAt: new Date().toISOString(),
    complete: false, verified: [], pending: [...failures, ...plans.map(p => ({ ...publicPlan(p), stage: 'unprocessed' }))] };
  const pending = new Map(plans.map(p => [p.key, { ...publicPlan(p), stage: 'unprocessed' }]));
  const persist = async () => {
    report.pending = [...failures, ...pending.values()];
    report.complete = report.pending.length === 0;
    report.updatedAt = new Date().toISOString();
    await save(report, receipts);
  };
  await persist();
  for (const plan of plans) {
    if (Date.now() - started >= budgetMs) break; // Untouched packages remain pending for the next full reconciliation.
    let local, stage = 'inventory';
    try {
      const records = (await adapter.inventory(plan)).filter(r => remoteName(r) === plan.filename && !isFolder(r));
      const previous = receipts[plan.key];
      const republished = previous && previous.fingerprint !== plan.fingerprint;
      const verify = async (record, expected = {}) => {
        const url = shareLink(record);
        return verifyMetadata(plan, record, await adapter.publicInfo(url), expected);
      };
      let verified;
      if (records.length && !republished) {
        stage = 'verification';
        // Prefer a known receipt when names collide, but do not trust it without checking the remote.
        const ordered = [...records].sort((a, b) => Number(remoteId(b).replace(/^f/, '') === previous?.fileId) - Number(remoteId(a).replace(/^f/, '') === previous?.fileId));
        let lastError;
        for (const record of ordered) {
          try { verified = await verify(record, previous?.fileId === remoteId(record).replace(/^f/, '') ? previous : {}); break; }
          catch (error) { lastError = error; }
        }
        if (!verified) throw lastError; // A transient verification failure must not trigger a duplicate upload.
      }
      if (!verified && dryRun) {
        pending.set(plan.key, { ...publicPlan(plan), stage: republished ? 'republished' : 'missing' });
        await persist(); continue;
      }
      if (!verified) {
        stage = 'download'; local = await adapter.download(plan);
        stage = 'folder'; const destination = await adapter.ensureDestination(plan);
        stage = 'upload'; let receipt;
        // A server can commit an upload but lose its response. Always read back before concluding failure.
        try { receipt = await adapter.upload(plan, local, destination); } catch { /* Resolve ambiguous outcome below. */ }
        stage = 'verification';
        const expected = { fileSize: local.fileSize, md5: local.md5, fileId: receipt?.fileId };
        let lastError;
        for (let attempt = 0; attempt < 5 && !verified; attempt++) {
          if (attempt) await (adapter.pause || (ms => new Promise(r => setTimeout(r, ms))))(2000 * attempt);
          try {
            const candidates = (await adapter.refresh(plan, destination)).filter(r => remoteName(r) === plan.filename && !isFolder(r));
            for (const candidate of candidates) {
              // Without a receipt, never mistake an old same-name revision for the new upload.
              if (republished && !receipt?.fileId && records.some(r => remoteId(r) === remoteId(candidate))) continue;
              try { verified = await verify(candidate, expected); break; } catch (error) { lastError = error; }
            }
          } catch (error) { lastError = error; }
        }
        if (!verified) throw lastError || new SyncError('UPLOAD_NOT_VERIFIED');
      }
      verified.action = local ? 'uploaded' : 'existing';
      if (!dryRun) receipts[plan.key] = { fingerprint: plan.fingerprint, fileId: verified.fileId, fileSize: verified.fileSize,
        ...(local?.md5 ? { md5: local.md5 } : previous?.fileId === verified.fileId && previous.md5 ? { md5: previous.md5 } : {}) };
      report.verified.push(verified);
      pending.delete(plan.key);
    } catch (error) {
      pending.set(plan.key, { ...publicPlan(plan), stage, error: error instanceof SyncError ? error.code : 'OPERATION_FAILED' });
    } finally {
      if (local) await adapter.cleanup(local).catch(() => {});
    }
    await persist();
  }
  report.finishedAt = new Date().toISOString();
  await persist();
  return report;
}

export function markdownReport(report) {
  const cell = x => String(x ?? '').replace(/[\r\n|<>\[\]`]/g, ' ');
  const lines = ['# QNAP purchased packages → CTFile', '', `Mode: ${report.mode}; verified: ${report.verified.length}; pending: ${report.pending.length}`, '',
    '| Product | Version | Architecture | File | CTFile |', '|---|---|---|---|---|'];
  for (const p of report.verified) lines.push(`| ${cell(p.productName)} | ${cell(p.version)} | ${cell(p.architecture)} | ${cell(p.filename)} | [Download](${p.ctfileUrl}) |`);
  if (report.pending.length) {
    lines.push('', '## Pending — retried from the complete purchase feed on the next run', '', '| File / Product | Stage | Error |', '|---|---|---|');
    for (const p of report.pending) lines.push(`| ${cell(p.filename || p.productName)} | ${cell(p.stage)} | ${cell(p.error)} |`);
  }
  return lines.join('\n') + '\n';
}
