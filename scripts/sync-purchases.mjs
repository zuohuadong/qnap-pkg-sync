import { mkdir, mkdtemp, readFile, writeFile, rename, rm, stat, appendFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SyncError, planPurchases, reconcile, markdownReport, listAllPages, remoteName, remoteId, isFolder } from './purchase-sync-core.mjs';

const fail = code => { throw new SyncError(code); };
const required = (env, key) => { if (!env[key]) fail(`MISSING_${key}`); return env[key]; };
const folderId = id => { const n = String(id).replace(/^d/, ''); if (!/^\d+$/.test(n)) fail('INVALID_FOLDER_ID'); return n; };
const folderKey = id => folderId(id) === '0' ? '0' : `d${folderId(id)}`;

export function httpsUrl(value, ctfileOnly = false) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      (ctfileOnly && url.hostname !== 'ctfile.com' && !url.hostname.endsWith('.ctfile.com'))) fail('UNSAFE_URL');
  return url;
}

export async function atomicJson(path, data) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export async function jsonResponse(response) {
  if (!response.ok) fail(`HTTP_${response.status}`);
  if (Number(response.headers.get('content-length') || 0) > 4 * 1024 * 1024) fail('OVERSIZE_API_RESPONSE');
  let text = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body || []) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > 4 * 1024 * 1024) fail('OVERSIZE_API_RESPONSE');
  }
  text += decoder.decode();
  try { return JSON.parse(text); } catch { fail('INVALID_API_JSON'); }
}

/** Bounded disk streaming. Never execute an installer or persist authenticated source URLs. */
export async function downloadPackage(plan, fetchImpl = fetch, limit = 8 * 1024 ** 3) {
  httpsUrl(plan.url);
  const directory = await mkdtemp(join(tmpdir(), 'qnap-purchase-'));
  const path = join(directory, plan.filename);
  try {
    // Package URLs carry their own purchase authorization; never forward account Basic Auth.
    const response = await fetchImpl(plan.url, { signal: AbortSignal.timeout(20 * 60 * 1000), redirect: 'follow' });
    if (!response.ok || !response.body) fail('DOWNLOAD_HTTP_FAILED');
    if (response.url) httpsUrl(response.url);
    const advertised = response.headers.get('content-length');
    if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > limit)) fail('DOWNLOAD_SIZE_LIMIT');
    if (/(?:text\/html|application\/(?:json|xml))/.test(response.headers.get('content-type') || '')) fail('DOWNLOAD_ERROR_DOCUMENT');
    let bytes = 0, prefix = Buffer.alloc(0);
    const hash = createHash('md5');
    const counter = new Transform({ transform(chunk, _, callback) {
      bytes += chunk.length;
      if (bytes > limit) { callback(new SyncError('DOWNLOAD_SIZE_LIMIT')); return; }
      hash.update(chunk);
      if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    if (bytes < 100 || (advertised && !response.headers.get('content-encoding') && bytes !== Number(advertised))) fail('INCOMPLETE_DOWNLOAD');
    if (/^\s*(?:<!doctype\s+html|<html|<\?xml|\{\s*"(?:error|message)")/i.test(prefix.toString('utf8'))) fail('DOWNLOAD_ERROR_DOCUMENT');
    const md5 = hash.digest('hex');
    // QNAP's opaque signatures are not necessarily MD5. Only enforce unambiguous hash formats.
    const signature = String(plan.signature || '').trim();
    const expected = /^[a-f0-9]{32}$/i.test(signature) ? signature.toLowerCase()
      : /^[A-Za-z0-9+/]{22}==$/.test(signature) ? Buffer.from(signature, 'base64').toString('hex') : undefined;
    if (expected && expected !== md5) fail('SOURCE_CHECKSUM_MISMATCH');
    return { path, directory, fileSize: bytes, md5 };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** cURL config via stdin keeps signed URLs and WebDAV credentials out of process arguments/logs. */
export async function curlTransfer(url, local, { webdav, timeoutSeconds = 1200 } = {}) {
  httpsUrl(url, true);
  const responsePath = join(local.directory, 'upload-response.json');
  const filename = local.path.split('/').pop();
  const args = ['--disable', '--config', '-', '--silent', '--show-error', '--fail-with-body',
    '--proto', '=https', '--connect-timeout', '30', '--max-time', String(timeoutSeconds),
    '--speed-limit', '1024', '--speed-time', '90', '--header', 'Expect:', '--output', responsePath,
    '--write-out', '%{http_code} %{size_upload}'];
  if (webdav) args.push('--upload-file', local.path, '--header', 'If-None-Match: *');
  else args.push('--form-string', `name=${filename}`, '--form-string', `filesize=${local.fileSize}`,
    '--form', `file=@${local.path};filename=${filename};type=application/octet-stream`);
  const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', spawnFailed = false;
  child.stdout.on('data', data => { if (output.length < 4096) output += data.toString(); });
  child.stderr.resume(); // Do not publish potentially signed URLs from cURL diagnostics.
  child.stdin.on('error', () => {});
  const completed = new Promise(resolve => {
    child.once('error', () => { spawnFailed = true; resolve(-1); });
    child.once('close', code => resolve(code ?? -1));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), (timeoutSeconds + 15) * 1000);
  try {
    child.stdin.end(`url = ${JSON.stringify(url)}\n${webdav ? `user = ${JSON.stringify(`${webdav.username}:${webdav.password}`)}\n` : ''}`);
    const code = await completed;
    const match = output.trim().match(/^(\d{3}) (\d+)$/);
    if (spawnFailed) fail('CURL_UNAVAILABLE');
    if (!match) fail('UPLOAD_AMBIGUOUS');
    const status = Number(match[1]), sent = Number(match[2]);
    if (code !== 0 || status < 200 || status >= 300) fail(sent ? 'UPLOAD_AMBIGUOUS' : 'UPLOAD_NOT_SENT');
    if (webdav) return {}; // The REST inventory + public link will supply the canonical receipt.
    if ((await stat(responsePath)).size > 1024 * 1024) fail('INVALID_UPLOAD_RESPONSE');
    let data;
    try { data = JSON.parse(await readFile(responsePath, 'utf8')); } catch { fail('INVALID_UPLOAD_RESPONSE'); }
    const item = Array.isArray(data) ? data[0] : data.files?.[0] ?? data.data ?? data;
    const id = remoteId(item).replace(/^f/, '');
    if (!/^\d+$/.test(id)) fail('INVALID_UPLOAD_RECEIPT');
    return { fileId: id };
  } finally { clearTimeout(timer); }
}

export function createAdapter(env, { fetchImpl = fetch, transfer = curlTransfer } = {}) {
  const session = required(env, 'CTFILE_SESSION');
  const rootId = folderId(required(env, 'CTFILE_FOLDER_ID'));
  const products = new Map();
  let root;
  async function request(endpoint, body) {
    return jsonResponse(await fetchImpl(`https://rest.ctfile.com/v1/public/${endpoint}`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, session }), signal: AbortSignal.timeout(60000),
    }));
  }
  const list = (id, kind) => listAllPages((page, page_size) => request(`${kind}/list`, { folder_id: folderKey(id), page, page_size }));
  function uniqueFolder(rows, name) {
    const matches = rows.filter(r => isFolder(r) && remoteName(r) === name);
    if (matches.length > 1) fail('AMBIGUOUS_PRODUCT_FOLDER');
    return matches[0];
  }
  async function inventory(plan) {
    if (products.has(plan.folder)) {
      const entry = products.get(plan.folder);
      if (entry.error) throw entry.error;
      return entry.files;
    }
    try {
      root ??= await list(rootId, 'folder');
      const product = uniqueFolder(root, plan.folder);
      const state = { product, files: [] };
      if (product) {
        const todo = [remoteId(product)], visited = new Set();
        while (todo.length) {
          const id = todo.shift();
          if (visited.has(id) || visited.size >= 500) fail('INVALID_FOLDER_TREE');
          visited.add(id);
          const files = await list(id, 'file');
          state.files.push(...files.filter(r => !isFolder(r)));
          const children = await list(id, 'folder');
          todo.push(...children.filter(isFolder).map(remoteId));
        }
      }
      products.set(plan.folder, state);
      return state.files;
    } catch (error) { products.set(plan.folder, { error }); throw error; }
  }
  async function ensureFolder(parent, name) {
    let rows = await list(parent, 'folder');
    let found = uniqueFolder(rows, name);
    if (!found) {
      // Even an 'already exists' receipt is untrusted until found under the requested parent.
      await request('folder/create', { folder_id: folderId(parent), name });
      rows = await list(parent, 'folder');
      found = uniqueFolder(rows, name);
    }
    if (!found) fail('FOLDER_CREATION_NOT_VERIFIED');
    return folderId(remoteId(found));
  }
  return {
    inventory,
    async ensureDestination(plan) {
      const state = products.get(plan.folder);
      const product = state?.product ? folderId(remoteId(state.product)) : await ensureFolder(rootId, plan.folder);
      const month = new Date().toISOString().slice(0, 7);
      return { id: await ensureFolder(product, month), relativePath: `${plan.folder}/${month}` };
    },
    download: plan => downloadPackage(plan, fetchImpl),
    cleanup: local => rm(local.directory, { recursive: true, force: true }),
    async upload(plan, local, destination) {
      let data;
      try { data = await request('file/upload', { folder_id: folderKey(destination.id), name: plan.filename, size: String(local.fileSize), checksum: local.md5 }); }
      catch { fail('UPLOAD_URL_REQUEST_FAILED'); }
      if (String(data.code) !== '200' || !data.upload_url) fail('UPLOAD_URL_REQUEST_FAILED');
      try { return await transfer(data.upload_url, local); }
      catch (error) {
        // Never blindly re-upload after a timeout with bytes transmitted.
        if (error?.code !== 'UPLOAD_NOT_SENT' || !env.WEBDAV_URL || !env.WEBDAV_USERNAME || !env.WEBDAV_PASSWORD) throw error;
        const base = httpsUrl(env.WEBDAV_URL, true);
        const path = [base.pathname, env.WEBDAV_ROOT_PATH || '/qnaporg-github', destination.relativePath, plan.filename]
          .join('/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
        base.pathname = `/${path}`; base.search = ''; base.hash = '';
        return transfer(base.href, local, { webdav: { username: env.WEBDAV_USERNAME, password: env.WEBDAV_PASSWORD } });
      }
    },
    refresh: (_plan, destination) => list(destination.id, 'file'),
    async publicInfo(link) {
      const share = httpsUrl(link, true);
      const api = new URL('https://webapi.ctfile.com/getfile.php');
      api.searchParams.set('path', share.pathname.split('/')[1]);
      api.searchParams.set('f', share.pathname.split('/')[2]);
      api.searchParams.set('passcode', share.searchParams.get('p') || '');
      return jsonResponse(await fetchImpl(api, { headers: { Referer: link }, redirect: 'error', signal: AbortSignal.timeout(30000) }));
    },
  };
}

export async function main(env = process.env) {
  const reportDir = resolve('reports/purchases');
  const statePath = resolve('.sync-state/receipts.json');
  await mkdir(reportDir, { recursive: true });
  const save = async (report, receipts) => {
    await atomicJson(join(reportDir, 'report.json'), report);
    await writeFile(join(reportDir, 'links.md'), markdownReport(report));
    if (report.mode === 'sync') await atomicJson(statePath, receipts);
  };
  let report;
  try {
    const url = httpsUrl(required(env, 'QNAP_DOWNLOAD_URL'));
    const auth = Buffer.from(`${required(env, 'QNAP_USERNAME')}:${required(env, 'QNAP_PASSWORD')}`).toString('base64');
    const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!response.ok) fail('PURCHASE_FEED_UNAVAILABLE');
    const xml = await response.text();
    if (xml.length > 8 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) fail('INVALID_PURCHASE_FEED');
    const { parseStringPromise } = await import('xml2js');
    const config = await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true, trim: true });
    let receipts = {};
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) receipts = parsed;
    } catch { /* Cache loss cannot hide missing packages: re-list every product. */ }
    const desired = planPurchases(config, env.SYNC_PRODUCT || '');
    console.log(`PURCHASE_SYNC_PLAN ${JSON.stringify({ packages: desired.plans.length, invalid: desired.failures.length, mode: env.SYNC_DRY_RUN === 'true' ? 'audit' : 'sync' })}`);
    report = await reconcile(desired, createAdapter(env), { receipts, save, dryRun: env.SYNC_DRY_RUN === 'true' });
  } catch (error) {
    report = { schemaVersion: 1, mode: env.SYNC_DRY_RUN === 'true' ? 'audit' : 'sync', complete: false,
      verified: [], pending: [{ stage: 'initialization', error: error instanceof SyncError ? error.code : 'INITIALIZATION_FAILED' }], finishedAt: new Date().toISOString() };
    // Never overwrite receipt state on initialization failure.
    await atomicJson(join(reportDir, 'report.json'), report);
    await writeFile(join(reportDir, 'links.md'), markdownReport(report));
  }
  const summary = { mode: report.mode, verified: report.verified.length, uploaded: report.verified.filter(p => p.action === 'uploaded').length, pending: report.pending.length, complete: report.complete };
  console.log(`PURCHASE_SYNC_RESULT ${JSON.stringify(summary)}`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, markdownReport(report));
  // Audit missing files are observations, not successful uploads; other failures still fail the job.
  const errors = report.pending.filter(p => report.mode !== 'audit' || !['missing', 'republished'].includes(p.stage));
  if (errors.length) process.exitCode = 1;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('SYNC_FATAL_ERROR'); process.exitCode = 1; });
}
