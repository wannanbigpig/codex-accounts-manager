export async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  let cursor = 0;
  const runnerCount = Math.min(limit, items.length);

  await Promise.allSettled(
    Array.from({ length: runnerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item === undefined) {
          return;
        }

        await worker(item, index);
      }
    })
  );
}
