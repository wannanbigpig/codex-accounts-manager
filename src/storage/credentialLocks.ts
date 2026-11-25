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
  const target = credentialLockPath(directory, key);
  return mutex.runExclusive(target, async () => runLocked(await acquireLock(target, true), operation));
}

export async function tryWithCredentialLock(
  directory: string,
  key: string,
  operation: () => Promise<void>
): Promise<void> {
  const held = await acquireLock(credentialLockPath(directory, key), false).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ELOCKED") {
      throw error;
    }
    return undefined;
  });
  if (held) {
    await runLocked(held, operation);
  }
}

function credentialLockPath(directory: string, key: string): string {
  return path.join(directory, createHash("sha256").update(key).digest("hex"));
}

async function acquireLock(target: string, wait: boolean) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  let compromised: Error | undefined;
  const release = await lock(target, {
    realpath: false,
    stale: 60_000,
    update: 10_000,
    retries: wait ? { retries: 120, minTimeout: 50, maxTimeout: 500 } : 0,
    onCompromised: (error) => { compromised = error; }
  });
  return {
    release,
    assertHeld: () => {
      if (compromised) {
        throw compromised;
      }
    }
  };
}

async function runLocked<T>(held: Awaited<ReturnType<typeof acquireLock>>, operation: (assertHeld: () => void) => Promise<T>): Promise<T> {
  try {
    const result = await operation(held.assertHeld);
    held.assertHeld();
    return result;
  } finally {
    await held.release();
  }
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
