import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CTFileClient } from '../src/ctfile';
import { remoteShareLink, verifiedEntry } from '../scripts/postgresql18.mjs';

const filename = 'test.qpkg';
const canonical = 'https://url88.ctfile.com/f/123-456-example';
const remote = { name: filename, key: 'f456', size: 1024, weblink: canonical };
const expected = { productName: 'PostgreSQL 18', version: '18.0.0', architecture: 'x86_64', filename };

async function withUpload(uploadResponse: (init: RequestInit) => Promise<Response>, check: (client: CTFileClient, path: string, timers: Set<unknown>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ctfile-test-'));
  const path = join(directory, filename);
  await Bun.write(path, new Uint8Array(1024));
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const deadlines = new Set<unknown>();
  globalThis.setTimeout = ((handler: any, delay: number, ...args: any[]) => {
    const timer = originalSetTimeout(handler, delay, ...args);
    if (delay === 60 * 60 * 1000) deadlines.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: any) => {
    deadlines.delete(timer);
    return originalClearTimeout(timer);
  }) as typeof clearTimeout;
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/public/file/upload')) return Response.json({ code: 200, upload_url: 'https://upload.ctfile.com/test' });
    if (url.endsWith('/public/file/list')) return Response.json({ code: 200, results: [remote], default_passcode: '1234' });
    if (url === 'https://upload.ctfile.com/test') return uploadResponse(init);
    throw new Error(`Unexpected test request: ${url}`);
  }) as typeof fetch;
  try {
    await check(new CTFileClient('test-session', 1, 0), path, deadlines);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    for (const timer of deadlines) originalClearTimeout(timer as any);
    await rm(directory, { recursive: true, force: true });
  }
}

test('uploads streaming FormData without keepalive and returns canonical share URL', async () => {
  await withUpload(async init => {
    expect(init.keepalive).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
    return Response.json({ file_id: 456 });
  }, async (client, path, timers) => {
    const uploaded = await client.uploadFile('123', path);
    expect(uploaded.fileId).toBe('456');
    expect(uploaded.downloadUrl).toBe(`${canonical}?p=1234`);
    expect(timers.size).toBe(0);
  });
});

test('clears the one-hour deadline when multipart fetch rejects', async () => {
  await withUpload(async () => { throw new TypeError('simulated network failure'); }, async (client, path, timers) => {
    await expect(client.uploadFile('123', path)).rejects.toThrow('simulated network failure');
    expect(timers.size).toBe(0);
  });
});

test('clears the deadline when the upload response is not JSON', async () => {
  await withUpload(async () => new Response('<html>error</html>'), async (client, path, timers) => {
    await expect(client.uploadFile('123', path)).rejects.toThrow('did not return valid JSON');
    expect(timers.size).toBe(0);
  });
});

test('prefers API weblink and preserves explicit passcodes', () => {
  expect(remoteShareLink({ ...remote, url: 'https://url88.ctfile.com/f/other', default_passcode: '1234' })).toBe(`${canonical}?p=1234`);
  expect(remoteShareLink({ weblink: `${canonical}?p=existing`, default_passcode: '1234' })).toBe(`${canonical}?p=existing`);
});

test('does not invent a share URL from a numeric file ID', () => {
  expect(remoteShareLink({ id: '456' })).toBeUndefined();
  expect(() => verifiedEntry(expected, { name: filename, key: 'f456' })).toThrow('No canonical CTFile link');
});

test('verifies receipt ID and byte size when supplied', () => {
  expect(verifiedEntry({ ...expected, fileId: '456', fileSize: 1024 }, remote).ctfileUrl).toBe(canonical);
  expect(() => verifiedEntry({ ...expected, fileId: 'other' }, remote)).toThrow('ID does not match');
  expect(() => verifiedEntry({ ...expected, fileSize: 2048 }, remote)).toThrow('size does not match');
});
