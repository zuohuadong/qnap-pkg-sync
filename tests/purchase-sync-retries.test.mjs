import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rateLimitedFetch, createAdapter, fetchPurchaseFeed, main } from '../scripts/sync-purchases.mjs';
import { SyncError } from '../scripts/purchase-sync-core.mjs';

test('429 respects Retry-After before replaying an inventory read', async () => {
  let calls = 0, clock = 0; const delays = [];
  const request = rateLimitedFetch(async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : Response.json({ code: 200 }),
    { intervalMs: 1000, now: () => clock, pause: async ms => { delays.push(ms); clock += ms; } });
  assert.equal((await request('https://rest.ctfile.com/v1/public/file/list', {})).status, 200);
  assert.equal(calls, 2); assert.ok(delays.includes(3000));
});
test('read retries are bounded and terminal 429 is not treated as empty inventory', async () => {
  let calls = 0;
  const request = rateLimitedFetch(async () => { calls++; return new Response('', { status: 429 }); }, { retries: 2, intervalMs: 0, pause: async () => {} });
  assert.equal((await request('https://rest.ctfile.com/v1/public/file/list', {})).status, 429);
  assert.equal(calls, 3);
});
test('folder creation is never blindly replayed after an uncertain response', async () => {
  let calls = 0;
  const request = rateLimitedFetch(async () => { calls++; throw new Error('network'); }, { intervalMs: 0, pause: async () => {} });
  await assert.rejects(request('https://rest.ctfile.com/v1/public/file/list', {}, false), /NETWORK_FAILED/);
  assert.equal(calls, 1);
});
test('requests from concurrent consumers still use one spaced API lane', async () => {
  let clock = 0; const times = [];
  const request = rateLimitedFetch(async () => { times.push(clock); return Response.json({ code: 200 }); },
    { intervalMs: 1500, now: () => clock, pause: async ms => { clock += ms; } });
  await Promise.all([request('https://rest.ctfile.com/v1/public/file/list', {}), request('https://rest.ctfile.com/v1/public/folder/list', {}), request('https://webapi.ctfile.com/getfile.php', {})]);
  assert.deepEqual(times, [0, 1500, 3000]);
});
test('legacy product folder capitalization is reused only when unambiguous', async () => {
  const options = { requestIntervalMs: 0, fetchImpl: async (url, init) => {
    const id = JSON.parse(init.body).folder_id;
    return Response.json({ code: 200, results: id === 'd1' ? [{ key: 'd2', icon: 'folder', name: 'OpenList' }]
      : url.endsWith('file/list') ? [{ key: 'f3', name: 'OpenList_4.2.2_x86_64.qpkg', size: 1024 }] : [] });
  } };
  const adapter = createAdapter({ CTFILE_SESSION: 'secret', CTFILE_FOLDER_ID: '1' }, options);
  assert.equal((await adapter.inventory({ folder: 'Openlist' })).length, 1);
});

test('long Retry-After defers work instead of retrying earlier than requested', async () => {
  let calls = 0;
  const request = rateLimitedFetch(async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '3600' } }); }, { intervalMs: 0, pause: async () => {} });
  await assert.rejects(request('https://rest.ctfile.com/v1/public/file/list', {}), /RETRY_DEFERRED/);
  assert.equal(calls, 1);
});
test('retry transport cannot send requests to unrelated hosts', async () => {
  let calls = 0;
  const request = rateLimitedFetch(async () => { calls++; return Response.json({}); });
  await assert.rejects(request('https://unrelated.example/collect', {}), /UNSAFE_URL/);
  assert.equal(calls, 0);
});

test('terminal purchase feed statuses survive main and report.json without secrets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'purchase-feed-test-'));
  const cwd = process.cwd(), exitCode = process.exitCode;
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(line));
  process.chdir(directory);
  try {
    await mkdir('.sync-state');
    await writeFile('.sync-state/receipts.json', '{"preserved":true}\n');
    for (const status of [401, 403, 404, 410]) {
      let calls = 0;
      const report = await main({ QNAP_DOWNLOAD_URL: 'https://purchase.example/feed?token=PRIVATE',
        QNAP_USERNAME: 'PRIVATE_USER', QNAP_PASSWORD: 'PRIVATE_PASSWORD' }, {
        fetchImpl: async (_url, options) => {
          calls++; assert.equal(options.redirect, 'error');
          return new Response('private body', { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
        }, pause: async () => assert.fail('Terminal status must not retry'),
      });
      assert.equal(calls, 1);
      assert.equal(report.pending[0].stage, 'initialization');
      assert.equal(report.pending[0].error, `PURCHASE_FEED_UNAVAILABLE_${status}`);
      const serialized = await readFile(join(directory, 'reports/purchases/report.json'), 'utf8');
      assert.equal(JSON.parse(serialized).pending[0].error, `PURCHASE_FEED_UNAVAILABLE_${status}`);
      assert.ok(!serialized.includes('PRIVATE'));
      assert.ok(!serialized.includes('purchase.example'));
      assert.ok(logs.includes(`PURCHASE_FEED_HTTP status=${status} content_type=text/html`));
      assert.equal(await readFile('.sync-state/receipts.json', 'utf8'), '{"preserved":true}\n');
    }
    assert.ok(!logs.join('\n').includes('PRIVATE'));
    assert.ok(!logs.join('\n').includes('purchase.example'));
  } finally {
    process.chdir(cwd); process.exitCode = exitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('purchase feed retries 429 with small Retry-After and then succeeds', async () => {
  let calls = 0; const delays = [];
  const response = await fetchPurchaseFeed('https://purchase.example/feed', {}, {
    fetchImpl: async () => ++calls === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : new Response('<plugins/>'),
    pause: async ms => delays.push(ms),
  });
  assert.equal(await response.text(), '<plugins/>');
  assert.equal(calls, 2); assert.deepEqual(delays, [3000]);
});

test('body cancellation failure cannot mask a terminal feed status', async () => {
  await assert.rejects(fetchPurchaseFeed('https://purchase.example/feed', {}, {
    fetchImpl: async () => ({ ok: false, status: 403, headers: new Headers({ 'content-type': 'text/html' }),
      body: { cancel: async () => { throw new Error('PRIVATE stream error'); } } }),
  }), error => error instanceof SyncError && error.code === 'PURCHASE_FEED_UNAVAILABLE_403');
});

test('purchase feed network, 429 and all 5xx retries are bounded with short backoff', async () => {
  for (const status of ['network', 429, 500, 501, 503, 599]) {
    let calls = 0; const delays = [];
    await assert.rejects(fetchPurchaseFeed('https://purchase.example/feed', {}, {
      fetchImpl: async () => {
        calls++;
        if (status === 'network') throw new Error('PRIVATE signed URL');
        return new Response('', { status, headers: { 'retry-after': '3600' } });
      }, pause: async ms => delays.push(ms),
    }), error => error instanceof SyncError && error.code === (status === 'network'
      ? 'PURCHASE_FEED_NETWORK_FAILED' : `PURCHASE_FEED_UNAVAILABLE_${status}`));
    assert.equal(calls, 3); assert.deepEqual(delays, [2000, 4000]);
  }
});

test('purchase feed still rejects DOCTYPE, ENTITY, and payloads over 8 MiB', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'purchase-feed-validation-'));
  const cwd = process.cwd(), exitCode = process.exitCode;
  process.chdir(directory);
  try {
    for (const xml of ['<!DOCTYPE plugins><plugins/>', '<!ENTITY secret "private"><plugins/>', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
      const report = await main({ QNAP_DOWNLOAD_URL: 'https://purchase.example/feed',
        QNAP_USERNAME: 'test', QNAP_PASSWORD: 'test' }, { fetchImpl: async () => new Response(xml) });
      assert.equal(report.pending[0].error, 'INVALID_PURCHASE_FEED');
    }
  } finally {
    process.chdir(cwd); process.exitCode = exitCode;
    await rm(directory, { recursive: true, force: true });
  }
});
