/**
 * BullMQ's shared connection is configured with `maxRetriesPerRequest: null`
 * (required for Workers — see queue.module.ts) but that setting also means
 * a `Queue.add()` call retries forever and never rejects while Redis is
 * unreachable, hanging the HTTP request that triggered it indefinitely
 * (confirmed directly: a register request hung past 8s with zero response
 * before this existed). This wraps any such call so it fails after a
 * bounded wait instead, so callers can decide what "the queue is
 * unreachable" should mean for them — swallow-and-log for email, fail the
 * request for a webhook — rather than never finding out at all.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
