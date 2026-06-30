export async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  options: { delayMs?: number } = {}
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  let cursor = 0;
  const runnerCount = Math.min(limit, items.length);
  const delayMs = Math.max(0, options.delayMs ?? 0);

  await Promise.all(
    Array.from({ length: runnerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item === undefined) {
          return;
        }

        if (delayMs > 0) {
          await sleep(delayMs);
        }
        await worker(item, index);
      }
    })
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建一个异步互斥锁，保证同一 key 的任务串行执行。
 *
 * 用于切号/刷新 token 等需要按账号串行化的场景，避免切号与后台续期并发刷新同一账号 token。
 */
export function createKeyedMutex(): {
  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T>;
} {
  const tails = new Map<string, Promise<unknown>>();

  return {
    runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
      const tail = tails.get(key) ?? Promise.resolve();
      const next = tail.then(() => task());
      // 失败不阻断后续排队
      tails.set(key, next.then(() => undefined, () => undefined));
      return next;
    }
  };
}
