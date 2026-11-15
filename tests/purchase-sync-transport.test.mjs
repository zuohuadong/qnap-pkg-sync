import test from 'node:test';
import assert from 'node:assert/strict';
import { curlArgs, curlConfig } from '../scripts/sync-purchases.mjs';

const local = { path: '/tmp/purchase/a.qpkg', fileSize: 1024 };
const url = 'https://dav.example/base/qnaporg-github/One/2026-10/a.qpkg?token=PRIVATE_TOKEN';
const webdav = { username: 'PRIVATE_USER', password: 'PRIVATE_PASSWORD' };

test('cURL keeps the URL and WebDAV credentials in stdin, never in argv', () => {
  const config = curlConfig(url, webdav);
  assert.ok(config.includes(JSON.stringify(url)));
  assert.ok(config.includes(JSON.stringify('PRIVATE_USER:PRIVATE_PASSWORD')));
  for (const method of ['PUT', 'PROPFIND', 'MKCOL']) {
    const args = curlArgs(local, '/tmp/purchase/upload-response.json', { webdav, method });
    assert.ok(args.includes('--config') && args.includes('-'));
    for (const secret of ['dav.example', 'PRIVATE', 'token=', 'https://']) {
      assert.ok(!args.join(' ').includes(secret), `${method} args leaked ${secret}`);
    }
  }
});

test('WebDAV transfers are conditional and PROPFIND is bounded to depth 0', () => {
  const put = curlArgs(local, '/tmp/purchase/response.json', { webdav, method: 'PUT' });
  assert.deepEqual(put.slice(put.indexOf('--request'), put.indexOf('--request') + 2), ['--request', 'PUT']);
  assert.ok(put.includes('If-None-Match: *'));
  assert.deepEqual(put.slice(put.indexOf('--upload-file'), put.indexOf('--upload-file') + 2), ['--upload-file', local.path]);

  const propfind = curlArgs(undefined, '/tmp/purchase/response.json', { webdav, method: 'PROPFIND' });
  assert.deepEqual(propfind.slice(propfind.indexOf('--request'), propfind.indexOf('--request') + 2), ['--request', 'PROPFIND']);
  assert.deepEqual(propfind.slice(propfind.indexOf('--header', propfind.indexOf('--header') + 1), propfind.indexOf('--header', propfind.indexOf('--header') + 1) + 2), ['--header', 'Depth: 0']);
  assert.ok(!propfind.includes('--upload-file'));
});

test('CTFile uploads use multipart form fields without the signed URL or account credentials', () => {
  const args = curlArgs(local, '/tmp/purchase/response.json', {});
  assert.deepEqual(args.slice(args.indexOf('--form-string'), args.indexOf('--form-string') + 2), ['--form-string', 'name=a.qpkg']);
  assert.ok(args.includes('filesize=1024'));
  assert.ok(args.some(value => value.startsWith('file=@/tmp/purchase/a.qpkg;filename=a.qpkg')));
  assert.ok(!args.join(' ').includes('https://'));
  assert.ok(!args.includes('--request'));
});
