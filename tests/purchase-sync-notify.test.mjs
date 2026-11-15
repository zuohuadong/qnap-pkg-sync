import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const workflow = await readFile(new URL('../.github/workflows/sync-packages.yml', import.meta.url), 'utf8');
const script = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/)[1].replace(/^          /gm, '');

async function notification(responses) {
  const directory = await mkdtemp(join(tmpdir(), 'purchase-notify-test-'));
  const summaryPath = join(directory, 'summary');
  const stub = `const responses = ${JSON.stringify(responses)};
    globalThis.fetch = async (url, options) => {
      console.log(options.method + ' ' + new URL(url).pathname);
      const response = responses.shift();
      if (!response) throw new Error('Unexpected API request');
      return Response.json(response.body, { status: response.status || 200 });
    };`;
  try {
    const execution = await execute(process.execPath, ['--input-type=module', '-e', stub + script], {
      env: { ...process.env, GITHUB_REPOSITORY: 'example/repo', GITHUB_STEP_SUMMARY: summaryPath,
        GH_TOKEN: 'test-token', GITHUB_RUN_ID: '1', SYNC_RESULT: 'failure', TEST_RESULT: 'success' },
    });
    let summary = '';
    try { summary = await readFile(summaryPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { ...execution, summary };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('notification checks repository and skips issues disabled without listing issues', async () => {
  const outcome = await notification([{ body: { has_issues: false } }]);
  assert.equal(outcome.summary, 'Issues disabled; failure notification skipped\n');
  assert.ok(!outcome.stdout.includes('/issues'));
});

test('notification treats issues 404 and 410 as unavailable during reads or writes', async () => {
  for (const status of [404, 410]) {
    for (const phase of ['list', 'write']) {
      const responses = [{ body: { has_issues: true } }];
      if (phase === 'write') responses.push({ body: [] });
      responses.push({ status, body: { message: 'Unavailable' } });
      const outcome = await notification(responses);
      assert.equal(outcome.summary, `Issues unavailable (HTTP ${status}); failure notification skipped\n`);
    }
  }
});

test('notification keeps repository errors and other issues errors fatal', async () => {
  await assert.rejects(notification([{ status: 404, body: {} }]), error => error.stderr.includes('Notification API HTTP 404'));
  await assert.rejects(notification([{ body: { has_issues: true } }, { status: 403, body: {} }]),
    error => error.stderr.includes('Notification API HTTP 403'));
});

test('notification still creates an issue when enabled', async () => {
  const outcome = await notification([{ body: { has_issues: true } }, { body: [] }, { body: { number: 1 } }]);
  assert.ok(outcome.stdout.includes('POST /repos/example/repo/issues'));
  assert.equal(outcome.summary, '');
});
