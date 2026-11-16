import { mkdir, mkdtemp, readFile, writeFile, rename, rm, stat, appendFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStringPromise, processors } from 'xml2js';
import { SyncError, planPurchases, reconcile, markdownReport, listAllPages, remoteName, remoteId, isFolder, verifyWebdavMetadata } from './purchase-sync-core.mjs';

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

/** The URL and WebDAV credentials travel through stdin so they never reach argv or logs. */
export function curlConfig(url, webdav) {
  return `url = ${JSON.stringify(url)}\n${webdav ? `user = ${JSON.stringify(`${webdav.username}:${webdav.password}`)}\n` : ''}`;
}

export function curlArgs(local, responsePath, { webdav, method = 'PUT', depth = 0, timeoutSeconds = 1200 } = {}) {
  const args = ['--disable', '--config', '-', '--silent', '--show-error', '--fail-with-body',
    '--proto', '=https', '--connect-timeout', '30', '--max-time', String(timeoutSeconds),
    '--speed-limit', '1024', '--speed-time', '90', '--header', 'Expect:', '--output', responsePath,
    '--max-filesize', '1048576', '--write-out', '%{http_code} %{size_upload}'];
  if (webdav) {
    args.push('--request', method);
    if (method === 'PUT') args.push('--upload-file', local.path, '--header', 'If-None-Match: *');
    if (method === 'PROPFIND') args.push('--header', `Depth: ${depth}`);
  } else {
    const filename = local.path.split('/').pop();
    args.push('--form-string', `name=${filename}`, '--form-string', `filesize=${local.fileSize}`,
      '--form', `file=@${local.path};filename=${filename};type=application/octet-stream`);
  }
  return args;
}

/** cURL config via stdin keeps signed URLs and WebDAV credentials out of process arguments/logs. */
export async function curlTransfer(url, local, options = {}) {
  const { webdav, method = 'PUT' } = options;
  httpsUrl(url, !webdav);
  const directory = local?.directory || await mkdtemp(join(tmpdir(), 'qnap-webdav-'));
  const responsePath = join(directory, 'upload-response.json');
  const args = curlArgs(local, responsePath, options);
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
    child.stdin.end(curlConfig(url, webdav));
    const code = await completed;
    const match = output.trim().match(/^(\d{3}) (\d+)$/);
    if (spawnFailed) fail(webdav ? 'WEBDAV_REQUEST_FAILED' : 'CURL_UNAVAILABLE');
    if (!match) fail(webdav ? 'WEBDAV_REQUEST_FAILED' : 'UPLOAD_AMBIGUOUS');
    const status = Number(match[1]), sent = Number(match[2]);
    if (webdav) {
      if (code !== 0 && code !== 22) fail('WEBDAV_REQUEST_FAILED');
      return { status, body: method === 'PROPFIND' ? await readFile(responsePath, 'utf8') : '' };
    }
    if (code !== 0 || status < 200 || status >= 300) fail(sent ? 'UPLOAD_AMBIGUOUS' : 'UPLOAD_NOT_SENT');
    if ((await stat(responsePath)).size > 1024 * 1024) fail('INVALID_UPLOAD_RESPONSE');
    let data;
    try { data = JSON.parse(await readFile(responsePath, 'utf8')); } catch { fail('INVALID_UPLOAD_RESPONSE'); }
    const item = Array.isArray(data) ? data[0] : data.files?.[0] ?? data.data ?? data;
    const id = remoteId(item).replace(/^f/, '');
    if (!/^\d+$/.test(id)) fail('INVALID_UPLOAD_RECEIPT');
    return { fileId: id };
  } finally {
    clearTimeout(timer);
    if (!local?.directory) await rm(directory, { recursive: true, force: true });
  }
}

export async function fetchPurchaseFeed(url, options, { fetchImpl = fetch,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(60000) });
    } catch {
      if (attempt === 2) fail('PURCHASE_FEED_NETWORK_FAILED');
      await pause(2000 * (attempt + 1)); continue;
    }
    if (response.ok) return response;
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const server = (response.headers.get('server') || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'unknown';
    // A sanitized page title distinguishes a WAF/login block page from a QNAP XML error.
    const title = (await response.text().catch(() => ''))
      .match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1]
      ?.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 100) || 'none';
    console.log(`PURCHASE_FEED_HTTP status=${response.status} content_type=${/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType) ? contentType : 'unknown'} server=${server} title=${title}`);
    if (attempt === 2 || (response.status !== 429 && response.status < 500) || response.status > 599) {
      fail(`PURCHASE_FEED_UNAVAILABLE_${response.status}`);
    }
    const retryAfter = response.headers.get('retry-after');
    await pause(retryAfter && /^\d+$/.test(retryAfter) && Number(retryAfter) <= 10
      ? Number(retryAfter) * 1000 : 2000 * (attempt + 1));
  }
}

/** One serialized API lane, with bounded Retry-After-aware recovery for reads. */
export function rateLimitedFetch(fetchImpl = fetch, { intervalMs = 1500, retries = 4,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  let next = 0, tail = Promise.resolve();
  return async (url, options, retryable = true) => {
    const target = httpsUrl(url, true);
    if (!['rest.ctfile.com', 'webapi.ctfile.com'].includes(target.hostname)) fail('UNSUPPORTED_CTFILE_API_HOST');
    const readEndpoint = /^\/v1\/public\/(file|folder)\/list$/.test(target.pathname);
    retryable = retryable && readEndpoint;
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      for (let attempt = 0; ; attempt++) {
        await pause(Math.max(0, next - now()));
        next = now() + intervalMs;
        let response;
        try {
          response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(60000) });
        } catch (error) {
          if (!retryable || attempt >= retries) throw new SyncError('CTFILE_NETWORK_FAILED');
          await pause(Math.min(30000, 2000 * 2 ** attempt));
          continue;
        }
        if (![429, 500, 502, 503, 504].includes(response.status) || !retryable || attempt >= retries) return response;
        const value = response.headers.get('retry-after');
        const requested = value && /^\d+$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - now() : NaN;
        await response.body?.cancel();
        if (requested > 300000) fail('CTFILE_RETRY_DEFERRED');
        const delay = Math.max(intervalMs, Math.min(10000, Number.isFinite(requested) ? requested : 2000 * 2 ** attempt));
        console.log(`CTFILE_API_RETRY status=${response.status} attempt=${attempt + 1} path=${target.pathname} delayMs=${delay}`);
        await pause(delay);
      }
    } finally { release(); }
  };
}

export function createAdapter(env, { fetchImpl = fetch, transfer = curlTransfer, requestIntervalMs = 1500 } = {}) {
  const apiFetch = rateLimitedFetch(fetchImpl, { intervalMs: requestIntervalMs });
  const session = required(env, 'CTFILE_SESSION');
  const rootId = folderId(required(env, 'CTFILE_FOLDER_ID'));
  const products = new Map();
  const fallback = env.WEBDAV_FALLBACK || 'on-failure';
  if (!['on-failure', 'always', 'off'].includes(fallback)) fail('INVALID_WEBDAV_FALLBACK');
  let uploadProvider = fallback === 'always' ? 'webdav' : 'ctfile';
  const webdavFolders = new Set();
  let root;
  const pathSegments = path => String(path).split('/').filter(Boolean).map(segment => {
    if (segment === '.' || segment === '..' || /[\\\r\n?#]/.test(segment)) fail('INVALID_WEBDAV_PATH');
    return encodeURIComponent(segment);
  });
  const webdavRoot = pathSegments(env.WEBDAV_ROOT_PATH || '/qnaporg-github').join('/');
  const webdavPath = (relativePath, filename) => [webdavRoot, ...pathSegments(relativePath), ...pathSegments(filename)].filter(Boolean).join('/');
  function webdavUrl(path) {
    if (!env.WEBDAV_URL || !env.WEBDAV_USERNAME || !env.WEBDAV_PASSWORD) fail('WEBDAV_NOT_CONFIGURED');
    const base = httpsUrl(env.WEBDAV_URL);
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/${path}`;
    base.search = ''; base.hash = '';
    return base.href;
  }
  const webdavOptions = (method, depth = 0) => ({ method, depth, webdav: { username: env.WEBDAV_USERNAME, password: env.WEBDAV_PASSWORD } });
  async function webdavUpload(file, url) {
    const response = await transfer(url, file, webdavOptions('PUT'));
    if (response.status !== 412 && (response.status < 200 || response.status >= 300)) fail('WEBDAV_UPLOAD_FAILED');
  }
  async function webdavStat(url) {
    let response;
    try { response = await transfer(url, undefined, webdavOptions('PROPFIND')); }
    catch { fail('WEBDAV_UPLOAD_NOT_VERIFIED'); }
    if (response.status === 404) return null;
    if (response.status !== 207 || /<!DOCTYPE|<!ENTITY/i.test(response.body)) fail('WEBDAV_UPLOAD_NOT_VERIFIED');
    let multistatus;
    try {
      multistatus = await parseStringPromise(response.body, { explicitArray: false, tagNameProcessors: [processors.stripPrefix] });
    } catch { fail('WEBDAV_UPLOAD_NOT_VERIFIED'); }
    const responses = multistatus?.multistatus?.response;
    const target = new URL(url);
    const matches = (Array.isArray(responses) ? responses : [responses]).filter(entry => {
      try { return new URL(entry.href, target).href === target.href; } catch { return false; }
    });
    if (matches.length !== 1) fail('WEBDAV_UPLOAD_NOT_VERIFIED');
    const properties = matches[0].propstat;
    for (const property of Array.isArray(properties) ? properties : [properties]) {
      const size = property?.prop?.getcontentlength;
      if (/^HTTP\/[\d.]+ 200(?:\s|$)/.test(property?.status) && /^\d+$/.test(String(size)) && Number.isSafeInteger(Number(size))) return { size: Number(size) };
    }
    fail('WEBDAV_UPLOAD_NOT_VERIFIED');
  }
  async function webdavList(url, depth = 1) {
    let response;
    try { response = await transfer(url, undefined, webdavOptions('PROPFIND', depth)); }
    catch { fail('WEBDAV_LIST_FAILED'); }
    if (response.status === 404) return [];
    if (response.status !== 207 || /<!DOCTYPE|<!ENTITY/i.test(response.body)) fail('WEBDAV_LIST_FAILED');
    let multistatus;
    try {
      multistatus = await parseStringPromise(response.body, { explicitArray: false, tagNameProcessors: [processors.stripPrefix] });
    } catch { fail('WEBDAV_LIST_FAILED'); }
    const entries = multistatus?.multistatus?.response;
    const self = new URL(url).href;
    return (Array.isArray(entries) ? entries : [entries]).filter(Boolean).flatMap(entry => {
      let href;
      try { href = new URL(entry.href, url).href; } catch { return []; }
      if (href === self) return [];
      const properties = Array.isArray(entry.propstat) ? entry.propstat : [entry.propstat];
      const prop = properties.find(p => /^HTTP\/[\d.]+ 200(?:\s|$)/.test(p?.status))?.prop || properties[0]?.prop || {};
      const pathname = decodeURIComponent(new URL(href).pathname);
      const name = pathname.split('/').filter(Boolean).pop() || '';
      const size = Number(prop.getcontentlength);
      return [{ href, name, folder: prop.resourcetype?.collection !== undefined || /\/$/.test(entry.href),
        size: Number.isSafeInteger(size) && size >= 0 ? size : undefined }];
    });
  }

  async function webdavEnsureFolder(url) {
    const base = new URL(webdavUrl(''));
    const target = new URL(url);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) fail('INVALID_WEBDAV_PATH');
    let folder = base.href.replace(/\/$/, '');
    for (const segment of target.pathname.slice(base.pathname.length).split('/').filter(Boolean)) {
      folder += `/${segment}`;
      if (webdavFolders.has(folder)) continue;
      const response = await transfer(folder, undefined, webdavOptions('MKCOL'));
      if (![301, 405].includes(response.status) && (response.status < 200 || response.status >= 300)) fail('WEBDAV_FOLDER_FAILED');
      webdavFolders.add(folder);
    }
  }
  async function verifyWebdav(plan, receipt, expected) {
    const month = String(receipt.path).split('/').at(-2);
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) ||
        receipt.path !== webdavPath(`${plan.folder}/${month}`, plan.filename)) fail('WEBDAV_UPLOAD_NOT_VERIFIED');
    return verifyWebdavMetadata(plan, receipt.path, await webdavStat(webdavUrl(receipt.path)), expected);
  }
  function degradeUploads() {
    if (fallback === 'off' || uploadProvider === 'webdav') return;
    uploadProvider = 'webdav';
    console.log('CTFILE_UPLOAD_DEGRADED switched=webdav');
  }
  async function uploadWebdav(plan, local, destination) {
    const path = webdavPath(destination.relativePath, plan.filename);
    const url = webdavUrl(path);
    try {
      await webdavEnsureFolder(url.slice(0, url.lastIndexOf('/')));
      await webdavUpload(local, url);
      await verifyWebdav(plan, { path }, local);
    } catch (error) {
      if (error instanceof SyncError && error.code.startsWith('WEBDAV_')) throw error;
      fail('WEBDAV_UPLOAD_FAILED');
    }
    return { storage: 'webdav', path };
  }
  async function request(endpoint, body) {
    return jsonResponse(await apiFetch(`https://rest.ctfile.com/v1/public/${endpoint}`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, session }), signal: AbortSignal.timeout(60000),
    }, endpoint.endsWith('/list')));
  }
  const list = (id, kind) => listAllPages((page, page_size) => request(`${kind}/list`, { folder_id: folderKey(id), page, page_size }));
  function uniqueFolder(rows, name) {
    const exact = rows.filter(r => isFolder(r) && remoteName(r) === name);
    const matches = exact.length ? exact : rows.filter(r => isFolder(r) && remoteName(r).toLowerCase() === name.toLowerCase());
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
  const webdavEnabled = fallback === 'always' || env.WEBDAV_INVENTORY === 'on';
  function webdavRelative(href) {
    const base = new URL(webdavUrl(''));
    const target = new URL(href);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) fail('INVALID_WEBDAV_PATH');
    return decodeURIComponent(target.pathname.slice(base.pathname.length)).replace(/^\/+/, '');
  }
  async function inventoryWebdav(plan) {
    if (products.has(plan.folder)) {
      const entry = products.get(plan.folder);
      if (entry.error) throw entry.error;
      return entry.files;
    }
    try {
      const rootEntries = (await webdavList(webdavUrl(''), 1)).filter(entry => entry.folder);
      const exact = rootEntries.filter(entry => entry.name === plan.folder);
      const matches = exact.length ? exact : rootEntries.filter(entry => entry.name.toLowerCase() === plan.folder.toLowerCase());
      if (matches.length > 1) fail('AMBIGUOUS_PRODUCT_FOLDER');
      const files = [];
      if (matches.length) {
        const todo = [matches[0].href], visited = new Set();
        while (todo.length) {
          const url = todo.shift();
          if (visited.has(url) || visited.size >= 500) fail('INVALID_FOLDER_TREE');
          visited.add(url);
          for (const entry of await webdavList(url, 1)) {
            if (entry.folder) todo.push(entry.href);
            else files.push({ storage: 'webdav', path: webdavRelative(entry.href), name: entry.name, size: entry.size });
          }
        }
      }
      const state = { files };
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
    inventory: webdavEnabled ? inventoryWebdav : inventory,
    webdavUpload, webdavStat, webdavEnsureFolder, webdavPath, verifyWebdav,
    async fallbackUpload(plan, local, destination) {
      if (fallback === 'off') fail('UPLOAD_NOT_VERIFIED');
      degradeUploads();
      return uploadWebdav(plan, local, destination);
    },
    async ensureDestination(plan) {
      const month = new Date().toISOString().slice(0, 7);
      const relativePath = `${plan.folder}/${month}`;
      if (uploadProvider === 'webdav') return { relativePath };
      const state = products.get(plan.folder);
      const product = state?.product ? folderId(remoteId(state.product)) : await ensureFolder(rootId, plan.folder);
      return { id: await ensureFolder(product, month), relativePath };
    },
    download: plan => downloadPackage(plan, fetchImpl),
    cleanup: local => rm(local.directory, { recursive: true, force: true }),
    async upload(plan, local, destination) {
      if (uploadProvider === 'webdav') return uploadWebdav(plan, local, destination);
      try {
        let data;
        try { data = await request('file/upload', { folder_id: folderKey(destination.id), name: plan.filename, size: String(local.fileSize), checksum: local.md5 }); }
        catch { fail('UPLOAD_URL_REQUEST_FAILED'); }
        if (String(data.code) !== '200' || !data.upload_url) fail('UPLOAD_URL_REQUEST_FAILED');
        return await transfer(data.upload_url, local);
      }
      catch (error) {
        degradeUploads();
        // Ambiguous transfers must finish CTFile read-back before using another channel.
        if (fallback === 'off' || !['UPLOAD_URL_REQUEST_FAILED', 'UPLOAD_NOT_SENT'].includes(error?.code)) throw error;
        return uploadWebdav(plan, local, destination);
      }
    },
    refresh: (_plan, destination) => list(destination.id, 'file'),
  };
}

export async function main(env = process.env, { fetchImpl = fetch, pause } = {}) {
  const reportDir = resolve('reports/purchases');
  const statePath = resolve('.sync-state/receipts.json');
  await mkdir(reportDir, { recursive: true });
  const save = async (report, receipts) => {
    await atomicJson(join(reportDir, 'report.json'), report);
    await writeFile(join(reportDir, 'links.md'), markdownReport(report));
    console.log(`PURCHASE_SYNC_PROGRESS verified=${report.verified.length} pending=${report.pending.length}`);
    if (report.mode === 'sync') await atomicJson(statePath, receipts);
  };
  let report;
  try {
    const url = httpsUrl(required(env, 'QNAP_DOWNLOAD_URL'));
    const auth = Buffer.from(`${required(env, 'QNAP_USERNAME')}:${required(env, 'QNAP_PASSWORD')}`).toString('base64');
    const response = await fetchPurchaseFeed(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/xml,text/xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    }, { fetchImpl, pause });
    const xml = await response.text();
    if (xml.length > 8 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) fail('INVALID_PURCHASE_FEED');
    const config = await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true, trim: true });
    let receipts = {};
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) receipts = parsed;
    } catch { /* Cache loss cannot hide missing packages: re-list every product. */ }
    const desired = planPurchases(config, env.SYNC_PRODUCT || '');
    console.log(`PURCHASE_SYNC_PLAN ${JSON.stringify({ packages: desired.plans.length, invalid: desired.failures.length, mode: env.SYNC_DRY_RUN === 'true' ? 'audit' : 'sync' })}`);
    report = await reconcile(desired, createAdapter(env, { fetchImpl }), { receipts, save, dryRun: env.SYNC_DRY_RUN === 'true' });
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
