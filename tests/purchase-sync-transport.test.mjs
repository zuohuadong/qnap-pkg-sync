import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, copyFile, chmod, symlink, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdapter } from '../scripts/sync-purchases.mjs';

test('real curl lane uses stdin credentials, conditional PUT and Depth 0 PROPFIND offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'purchase-curl-test-'));
  const originalEnv = { PATH: process.env.PATH, CURL_TEST_CAPTURE: process.env.CURL_TEST_CAPTURE, CURL_TEST_STATUS: process.env.CURL_TEST_STATUS };
  try {
    const binary = join(directory, 'curl.mjs'), capture = join(directory, 'capture.json');
    await copyFile(new URL('./fixtures/purchase-sync-curl.mjs', import.meta.url), binary);
    await chmod(binary, 0o700);
    await symlink(binary, join(directory, 'curl'));
    process.env.PATH = directory + delimiter + process.env.PATH;
    process.env.CURL_TEST_CAPTURE = capture;
    const adapter = createAdapter({ CTFILE_SESSION: 'test', CTFILE_FOLDER_ID: '1',
      WEBDAV_URL: 'https://dav.example/base', WEBDAV_USERNAME: 'PRIVATE_USER', WEBDAV_PASSWORD: 'PRIVATE_PASSWORD' });
    const url = 'https://dav.example/base/qnaporg-github/One/2026-10/a.qpkg?token=PRIVATE_TOKEN';
    const local = { directory, path: join(directory, 'a.qpkg'), fileSize: 1024 };
    await writeFile(local.path, Buffer.alloc(1024));

    for (const status of [201, 204, 412]) {
      process.env.CURL_TEST_STATUS = String(status);
      assert.equal(await adapter.webdavUpload(local, url), undefined);
      const audit = JSON.parse(await readFile(capture, 'utf8'));
      assert.ok(!audit.args.join(' ').includes('PRIVATE'));
      assert.ok(!audit.args.join(' ').includes('dav.example'));
      assert.ok(audit.args.includes('If-None-Match: *'));
      assert.equal(audit.method, 'PUT');
      assert.equal(audit.credentialsMatch, true); assert.equal(audit.hasSignedUrl, true);
    }
    process.env.CURL_TEST_STATUS = '500';
    await assert.rejects(adapter.webdavUpload(local, url), /WEBDAV_UPLOAD_FAILED/);

    process.env.CURL_TEST_STATUS = '207';
    const statUrl = url.split('?')[0];
    assert.deepEqual(await adapter.webdavStat(statUrl), { size: 1024 });
    const audit = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(audit.method, 'PROPFIND'); assert.ok(audit.args.includes('Depth: 0'));
    assert.equal(audit.credentialsMatch, true);
    process.env.CURL_TEST_STATUS = '404';
    assert.equal(await adapter.webdavStat(statUrl), null);

    process.env.CURL_TEST_STATUS = '405';
    await adapter.webdavEnsureFolder('https://dav.example/base/qnaporg-github/One/2026-10');
    assert.equal(JSON.parse(await readFile(capture, 'utf8')).method, 'MKCOL');
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
