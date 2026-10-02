import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitedFetch, createAdapter } from '../scripts/sync-purchases.mjs';

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
