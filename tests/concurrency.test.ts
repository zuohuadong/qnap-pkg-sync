import { test, expect } from 'bun:test';
import { promiseWithConcurrency, promiseWithConcurrencySafe } from '../src/utils/concurrency';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('awaits the final slow task and preserves input order', async () => {
  const completed: number[] = [];
  const results = await promiseWithConcurrency([1, 30, 50].map((delay, i) => async () => {
    await sleep(delay);
    completed.push(i);
    return i;
  }), 2);
  expect(completed.length).toBe(3);
  expect(results).toEqual([0, 1, 2]);
});

test('never exceeds the requested concurrency', async () => {
  let active = 0;
  let peak = 0;
  const results = await promiseWithConcurrency(Array.from({ length: 12 }, (_, i) => async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(i % 3 === 0 ? 1 : 10);
    active--;
    return i;
  }), 2);
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(results.length).toBe(12);
});

test('drains already started work before propagating a failure', async () => {
  let drained = false;
  let startedAfterFailure = false;
  const result = promiseWithConcurrency([
    async () => { await sleep(1); throw new Error('failure'); },
    async () => { await sleep(20); drained = true; return 1; },
    async () => { startedAfterFailure = true; return 2; },
  ], 2);
  await expect(result).rejects.toThrow('failure');
  expect(drained).toBe(true);
  expect(startedAfterFailure).toBe(false);
});

test('safe mode processes all tasks despite a synchronous throw', async () => {
  const results = await promiseWithConcurrencySafe([
    async () => 1,
    () => { throw new Error('expected test failure'); },
    async () => { await sleep(10); return 3; },
  ], 2);
  expect(results).toEqual([1, undefined, 3]);
});

test('handles empty input and rejects invalid limits', async () => {
  expect(await promiseWithConcurrency([], 2)).toEqual([]);
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    await expect(promiseWithConcurrency([], limit)).rejects.toThrow('positive integer');
  }
});
