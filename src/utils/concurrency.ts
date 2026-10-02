/** Concurrent task execution with bounded workers and ordered results. */
export async function promiseWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Concurrency must be a positive integer');
  }
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (!failed && nextIndex < tasks.length) {
      const index = nextIndex++;
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  }

  // Waiting on workers rather than a mutable Promise.race pool guarantees
  // the last file is complete before callers write metadata or remove files.
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  if (failed) throw firstError;
  return results;
}

/** Run all tasks, preserving the legacy undefined result for task failures. */
export async function promiseWithConcurrencySafe<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  return promiseWithConcurrency(tasks.map((task, index) => async () => {
    try {
      return await task();
    } catch (error) {
      console.error(`  ⚠ Task ${index + 1} encountered an error: ${error instanceof Error ? error.message : error}`);
      return undefined as T;
    }
  }), concurrency);
}
