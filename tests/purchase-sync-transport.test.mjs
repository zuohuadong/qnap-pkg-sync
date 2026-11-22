import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { curlArgs, curlConfig, bunUpload, parseUploadReceipt } from '../scripts/sync-purchases.mjs';

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

test('Bun upload sends multipart form data and returns the receipt file ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bun-upload-'));
  const file = join(directory, 'a.qpkg');
  await writeFile(file, Buffer.alloc(1024));
  try {
    const receipt = await bunUpload('https://upload.ctfile.com/upload?s=secret', { path: file, fileSize: 1024 }, {
      fetchImpl: async (url, init) => {
        assert.ok(!String(url).includes('PRIVATE'));
        assert.equal(init.method, 'POST');
        assert.ok(init.body instanceof FormData);
        assert.equal(init.body.get('name'), 'a.qpkg');
        assert.equal(init.body.get('filesize'), '1024');
        return Response.json({ file_id: 456 });
      },
    });
    assert.deepEqual(receipt, { fileId: '456' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Bun upload distinguishes unsent requests from ambiguous responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bun-upload-'));
  const file = join(directory, 'a.qpkg');
  await writeFile(file, Buffer.alloc(16));
  const local = { path: file, fileSize: 16 };
  const url = 'https://upload.ctfile.com/upload';
  try {
    await assert.rejects(bunUpload(url, local, { fetchImpl: async () => { throw new TypeError('network'); } }), /UPLOAD_NOT_SENT/);
    await assert.rejects(bunUpload(url, local, { fetchImpl: async () => new Response('busy', { status: 503 }) }), /UPLOAD_AMBIGUOUS/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('receipt parsing rejects oversized or non-JSON responses', () => {
  assert.deepEqual(parseUploadReceipt('{"files":[{"id":"f789"}]}'), { fileId: '789' });
  assert.throws(() => parseUploadReceipt('<html>'), /INVALID_UPLOAD_RESPONSE/);
  assert.throws(() => parseUploadReceipt('x'.repeat(1024 * 1024 + 1)), /INVALID_UPLOAD_RESPONSE/);
  assert.throws(() => parseUploadReceipt('{"id":"not-a-number"}'), /INVALID_UPLOAD_RECEIPT/);
});

test('CTFile uploads use multipart form fields without the signed URL or account credentials', () => {
  const args = curlArgs(local, '/tmp/purchase/response.json', {});
  assert.deepEqual(args.slice(args.indexOf('--form-string'), args.indexOf('--form-string') + 2), ['--form-string', 'name=a.qpkg']);
  assert.ok(args.includes('filesize=1024'));
  assert.ok(args.some(value => value.startsWith('file=@/tmp/purchase/a.qpkg;filename=a.qpkg')));
  assert.ok(!args.join(' ').includes('https://'));
  assert.ok(!args.includes('--request'));
});
