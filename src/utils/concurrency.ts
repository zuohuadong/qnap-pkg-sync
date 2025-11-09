/**
 * Concurrency Control Utilities
 *
 * Functions for managing concurrent task execution with limits
 */

/**
 * Execute promises with concurrency limit
 *
 * This function executes an array of promise-returning tasks with a maximum
 * concurrency limit. It ensures that no more than `concurrency` tasks are
 * running at the same time.
 *
 * @template T - The return type of the tasks
 * @param tasks - Array of functions that return promises
 * @param concurrency - Maximum number of concurrent tasks
 * @returns Promise that resolves to an array of results in the same order as tasks
 *
 * @example
 * const tasks = urls.map(url => () => fetch(url));
 * const results = await promiseWithConcurrency(tasks, 5);
 */
export async function promiseWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

    const promise = (async () => {
      const result = await task();
      results[i] = result;
    })();

    executing.push(promise);

    // Wait if we've reached concurrency limit
    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // Remove completed promises
      executing.splice(
        executing.findIndex(p => p === promise),
        1
      );
    }
  }

  // Wait for all remaining promises to complete
  await Promise.all(executing);
  return results;
}

/**
 * Execute promises with concurrency limit and error handling
 *
 * Similar to promiseWithConcurrency, but wraps each task with error handling
 * to ensure that failures in one task don't affect other tasks.
 *
 * @template T - The return type of the tasks
 * @param tasks - Array of functions that return promises
 * @param concurrency - Maximum number of concurrent tasks
 * @returns Promise that resolves to an array of results (undefined for failed tasks)
 *
 * @example
 * const tasks = urls.map(url => () => uploadFile(url));
 * const results = await promiseWithConcurrencySafe(tasks, 2);
 */
export async function promiseWithConcurrencySafe<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];

  for (const [index, task] of tasks.entries()) {
    // Create a promise that executes the task and stores the result
    // Wrap with error handling to ensure one failure doesn't kill all tasks
    const promise = (async () => {
      try {
        const result = await task();
        results[index] = result;
      } catch (error) {
        // Log error but don't throw - let individual tasks handle their errors
        console.error(`  ⚠ Task ${index + 1} encountered an error: ${error instanceof Error ? error.message : error}`);
        // Store undefined result for failed tasks
        results[index] = undefined as any;
      }
    })();

    // Add to executing pool
    const wrappedPromise = promise.then(() => {
      // Remove from executing pool when done
      executing.splice(executing.indexOf(wrappedPromise), 1);
    }).catch((error) => {
      // Extra safety: catch any unhandled errors
      console.error(`  ⚠ Unhandled error in task wrapper: ${error instanceof Error ? error.message : error}`);
      executing.splice(executing.indexOf(wrappedPromise), 1);
    });

    executing.push(wrappedPromise);

    // Wait if we've reached concurrency limit
    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  // Wait for all remaining tasks to complete
  await Promise.all(executing);

  return results;
}
