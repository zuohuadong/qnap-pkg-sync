import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
const normalized = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function packageFilename(location) {
  const url = new URL(location);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Package URL must use HTTPS without embedded credentials');
  const filename = basename(url.pathname);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.qpkg$/i.test(filename)) throw new Error('Unsafe or unsupported package filename');
  return filename;
}

export function selectPostgresql18(config) {
  const items = asArray(config?.plugins?.item).filter(app =>
    [app?.name, app?.internalName].some(value => ['postgresql18', 'postgres18'].includes(normalized(value)))
  );
  if (!items.length) throw new Error('PostgreSQL 18 is absent from the authenticated QNAP feed; check purchase entitlement and QNAP_DOWNLOAD_URL');
  const filenames = new Map();
  const selected = items.map(app => {
    const platforms = asArray(app.platform);
    if (!app.name || !app.version || !platforms.length) throw new Error('PostgreSQL 18 has incomplete package metadata');
    for (const platform of platforms) {
      if (!platform.platformID || typeof platform.location !== 'string') throw new Error('Platform metadata is incomplete');
      const filename = packageFilename(platform.location);
      const identity = JSON.stringify([String(app.version), platform.location, platform.signature]);
      if (filenames.has(filename) && filenames.get(filename) !== identity) throw new Error(`Conflicting package filename: ${filename}`);
      filenames.set(filename, identity);
    }
    return { ...app, platform: platforms };
  });
  return { plugins: { cachechk: config.plugins.cachechk, item: selected } };
}

export function ctfileLink(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value, 'https://url88.ctfile.com');
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    if (url.hostname !== 'ctfile.com' && !url.hostname.endsWith('.ctfile.com')) return undefined;
    if (!/^\/(f|file|d|dir)\//.test(url.pathname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function remoteShareLink(remote) {
  const link = [remote?.weblink, remote?.share_url, remote?.url, remote?.short_url, remote?.download_url].map(ctfileLink).find(Boolean);
  if (!link) return undefined;
  const url = new URL(link);
  if (remote.default_passcode && !url.searchParams.has('p')) url.searchParams.set('p', String(remote.default_passcode));
  return url.href;
}

export function verifiedEntry(expected, remote, folderUrl) {
  const filename = remote?.name || remote?.file_name;
  if (filename !== expected.filename || remote.icon === 'folder') throw new Error(`Remote file was not confirmed: ${expected.filename}`);
  const fileId = String(remote.key || remote.file_id || remote.id || '');
  if (!fileId || fileId.startsWith('d')) throw new Error(`Remote file has no valid ID: ${expected.filename}`);
  if (expected.fileId && fileId.replace(/^f/, '') !== String(expected.fileId).replace(/^f/, '')) throw new Error(`Remote file ID does not match upload receipt: ${expected.filename}`);
  const numericSize = [remote.file_size, remote.filesize, remote.size].find(value => typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)));
  if (numericSize !== undefined && expected.fileSize !== undefined && Number(numericSize) !== expected.fileSize) throw new Error(`Remote file size does not match: ${expected.filename}`);
  const downloadUrl = remoteShareLink(remote);
  const directoryUrl = ctfileLink(folderUrl);
  if (!downloadUrl && !directoryUrl) throw new Error(`No canonical CTFile link available: ${expected.filename}`);
  return {
    productName: expected.productName,
    version: expected.version,
    architecture: expected.architecture,
    filename: expected.filename,
    fileId,
    fileSize: numericSize !== undefined ? Number(numericSize) : expected.fileSize ?? remote.size ?? null,
    ctfileUrl: downloadUrl ?? directoryUrl,
    linkType: downloadUrl ? 'file' : 'folder',
    folderUrl: directoryUrl,
    verifiedAt: new Date().toISOString(),
  };
}

async function main() {
  const [{ loadEnv, getEnv }, { fetchXml, xmlToJson }, { downloadAllApps }, { CTFileClient }, { getProductFolderName }] = await Promise.all([
    import('../src/env.ts'), import('../src/fetch-xml.ts'), import('../src/download-apps.ts'),
    import('../src/ctfile.ts'), import('../src/ctfile-utils.ts'),
  ]);
  if (await Bun.file('.env').exists()) await loadEnv();
  const originalCwd = process.cwd();
  const reportDir = resolve(originalCwd, 'reports/postgresql18');
  await mkdir(reportDir, { recursive: true });
  const reports = [];
  const report = async () => {
    await writeFile(join(reportDir, 'links.json'), JSON.stringify(reports, null, 2) + '\n');
    const lines = ['# PostgreSQL 18 — CTFile', '', '| Architecture | Version | File | Link |', '|---|---|---|---|'];
    const cell = value => String(value).replace(/[|\r\n<>]/g, ' ');
    for (const item of reports) lines.push(`| ${cell(item.architecture)} | ${cell(item.version)} | ${cell(item.filename)} | [${item.linkType}](${item.ctfileUrl}) |`);
    await writeFile(join(reportDir, 'links.md'), lines.join('\n') + '\n');
  };
  const session = getEnv('CTFILE_SESSION');
  const rootId = getEnv('CTFILE_FOLDER_ID');
  const Client = process.env.CTFILE_UPLOAD_TRANSPORT === 'curl'
    ? (await import('../src/ctfile-curl.ts')).CurlCTFileClient : CTFileClient;
  const client = new Client(session);
  const folderKey = id => String(id) === '0' ? '0' : `d${String(id).replace(/^d/, '')}`;
  const idOf = item => String(item.key || item.folder_id || item.id || '').replace(/^d/, '');
  const nameOf = item => String(item.name || item.folder_name || item.file_name || '');
  const isFolder = item => item.icon === 'folder' || String(item.key || '').startsWith('d');
  async function list(folderId, kind = 'folder') {
    const all = [];
    const seen = new Set();
    for (let page = 1; page <= 100; page++) {
      const response = await fetch(`https://rest.ctfile.com/v1/public/${kind}/list`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, folder_id: folderKey(folderId), page, page_size: 100 }),
        signal: AbortSignal.timeout(60000),
      });
      const data = await response.json();
      if (!response.ok || String(data.code) !== '200') throw new Error(`CTFile listing failed (HTTP ${response.status}, code ${data.code ?? 'unknown'})`);
      const rows = data.results ?? data.data;
      if (!Array.isArray(rows)) throw new Error('Unexpected CTFile listing response');
      for (const row of rows) {
        const key = String(row.key || row.id || row.file_id || row.folder_id || nameOf(row));
        if (seen.has(key)) throw new Error('CTFile pagination repeated an entry; refusing an incomplete listing');
        seen.add(key);
        all.push({ ...row, default_passcode: row.default_passcode ?? data.default_passcode });
      }
      if (rows.length < 100) return all;
    }
    throw new Error('CTFile listing exceeded the pagination safety limit');
  }
  const xml = await fetchXml({ url: getEnv('QNAP_DOWNLOAD_URL'), username: getEnv('QNAP_USERNAME'), password: getEnv('QNAP_PASSWORD') });
  const config = selectPostgresql18(await xmlToJson(xml));
  const plans = [];
  const seen = new Set();
  for (const app of config.plugins.item) for (const platform of app.platform) {
    const filename = packageFilename(platform.location);
    if (seen.has(filename)) continue;
    seen.add(filename);
    plans.push({ app, platform, filename, productName: app.name, version: String(app.version), architecture: platform.platformID });
    if (process.env.GITHUB_ACTIONS) {
      const escape = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
      console.log(`::add-mask::${escape(platform.location)}`);
      if (platform.signature) console.log(`::add-mask::${escape(platform.signature)}`);
    }
  }
  console.log(`POSTGRESQL18_PLAN ${JSON.stringify(plans.map(({ productName, version, architecture, filename }) => ({ productName, version, architecture, filename })))}`);
  const rootEntries = await list(rootId);
  const workdir = await mkdtemp(join(tmpdir(), 'qnap-postgresql18-'));
  try {
    await mkdir(join(workdir, 'config'));
    process.chdir(workdir);
    const folders = new Map();
    for (const app of config.plugins.item) {
      if (folders.has(app.name)) continue;
      const folderName = getProductFolderName(app.name);
      let product = rootEntries.find(item => isFolder(item) && nameOf(item) === folderName);
      const productId = product ? idOf(product) : (await client.findOrCreateFolder(folderName, rootId, true)).folderId;
      if (!productId) throw new Error('CTFile did not return the product folder ID');
      if (!product) product = (await list(rootId)).find(item => isFolder(item) && idOf(item) === String(productId));
      const productEntries = await list(productId);
      const remoteFiles = (await list(productId, 'file')).filter(item => !isFolder(item)).map(file => ({ file, folderUrl: remoteShareLink(product) }));
      for (const child of productEntries.filter(isFolder)) {
        for (const file of (await list(idOf(child), 'file')).filter(item => !isFolder(item))) remoteFiles.push({ file, folderUrl: remoteShareLink(child) });
      }
      folders.set(app.name, { productId, productEntries, remoteFiles, monthlyId: null, monthlyUrl: undefined });
    }
    const missing = [];
    for (const plan of plans) {
      const folder = folders.get(plan.productName);
      const found = folder.remoteFiles.find(({ file }) => nameOf(file) === plan.filename);
      if (found) {
        reports.push(verifiedEntry(plan, found.file, found.folderUrl));
        console.log(`Already on CTFile: ${plan.filename}`);
      } else missing.push(plan);
    }
    await report();
    if (missing.length) {
      const filtered = { plugins: { item: config.plugins.item.map(app => ({ ...app, platform: app.platform.filter(platform => missing.some(plan => plan.filename === packageFilename(platform.location))) })).filter(app => app.platform.length) } };
      await writeFile('config/apps.json', JSON.stringify(filtered));
      await downloadAllApps();
      const metadata = JSON.parse(await readFile('config/metadata.json', 'utf8'));
      for (const plan of missing) {
        const meta = metadata.find(item => item.filename === plan.filename);
        if (!meta || !Number.isFinite(meta.fileSize) || meta.fileSize < 100) throw new Error(`Package download failed: ${plan.filename}`);
        const localPath = join(workdir, 'downloads', plan.filename);
        const prefix = await Bun.file(localPath).slice(0, 512).text();
        if (/^\s*(?:<!doctype\s+html|<html|<\?xml|\{\s*"(?:error|message)")/i.test(prefix)) throw new Error(`Downloaded an error document, not a QPKG: ${plan.filename}`);
        const folder = folders.get(plan.productName);
        if (!folder.monthlyId) {
          const month = new Date().toISOString().slice(0, 7);
          let existing = folder.productEntries.find(item => isFolder(item) && nameOf(item) === month);
          folder.monthlyId = existing ? idOf(existing) : (await client.findOrCreateFolder(month, folder.productId, true)).folderId;
          if (!folder.monthlyId) throw new Error('CTFile did not return the monthly folder ID');
          if (!existing) existing = (await list(folder.productId)).find(item => isFolder(item) && idOf(item) === String(folder.monthlyId));
          folder.monthlyUrl = remoteShareLink(existing);
        }
        const uploaded = await client.uploadFile(folder.monthlyId, localPath, true);
        let remote;
        for (let attempt = 0; attempt < 10; attempt++) {
          remote = (await list(folder.monthlyId, 'file')).find(item => !isFolder(item) && nameOf(item) === plan.filename);
          if (remote && (remoteShareLink(remote) || folder.monthlyUrl)) break;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        reports.push(verifiedEntry({ ...plan, fileSize: meta.fileSize, fileId: uploaded.fileId }, remote, folder.monthlyUrl));
        await report();
        await rm(localPath);
      }
    }
    if (reports.length !== plans.length) throw new Error('Some PostgreSQL 18 architectures were not verified on CTFile');
    console.log(`POSTGRESQL18_CTFILE_LINKS ${JSON.stringify(reports)}`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, await readFile(join(reportDir, 'links.md'), 'utf8'));
  } finally {
    process.chdir(originalCwd);
    await rm(workdir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
