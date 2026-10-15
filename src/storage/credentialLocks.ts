import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { lock } from "proper-lockfile";
import type { CodexTokens } from "../core/types";
import { createKeyedMutex } from "../utils/concurrency";

const mutex = createKeyedMutex();

export async function withCredentialLock<T>(
  directory: string,
  key: string,
  operation: (assertHeld: () => void) => Promise<T>
): Promise<T> {
  const target = path.join(directory, createHash("sha256").update(key).digest("hex"));
  return mutex.runExclusive(target, async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let compromised: Error | undefined;
    const release = await lock(target, {
      realpath: false,
      stale: 60_000,
      update: 10_000,
      retries: { retries: 120, minTimeout: 50, maxTimeout: 500 },
      onCompromised: (error) => {
        compromised = error;
      }
    });
    const assertHeld = (): void => {
      if (compromised) {
        throw compromised;
      }
    };
    try {
      const result = await operation(assertHeld);
      assertHeld();
      return result;
    } finally {
      await release();
    }
  });
}

export function sameTokenSnapshot(left?: CodexTokens, right?: CodexTokens): boolean {
  return (
    (left === undefined && right === undefined) ||
    Boolean(
      left &&
      right &&
      left.accessToken === right.accessToken &&
      left.refreshToken === right.refreshToken &&
      left.idToken === right.idToken &&
      left.accountId === right.accountId
    )
  );
}
