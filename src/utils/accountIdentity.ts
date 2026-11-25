import * as crypto from "crypto";
import { readAuthFile } from "../codex";
import { extractClaims } from "./jwt";
import type { CodexAccountRecord, DecodedAuthClaims } from "../core/types";

export function buildAccountStorageId(email: string, accountId?: string, organizationId?: string): string {
  const seed = [email.trim(), accountId?.trim(), organizationId?.trim()].filter(Boolean).join("|");
  return `codex_${crypto.createHash("md5").update(seed).digest("hex")}`;
}

export function resolveAccountStorageId(
  claims: DecodedAuthClaims & { email: string },
  accounts: readonly CodexAccountRecord[]
): string {
  const derived = buildAccountStorageId(claims.email, claims.accountId, claims.organizationId);
  if (!claims.userId || !claims.accountId) {
    return derived;
  }
  const matching = accounts.filter((account) =>
    account.email.toLowerCase() === claims.email.toLowerCase() &&
    account.userId === claims.userId && account.accountId === claims.accountId &&
    account.organizationId === claims.organizationId
  );
  return matching.length === 1 ? matching[0]!.id : derived;
}

export function conflictsWithAccessTokenIdentity(claims: DecodedAuthClaims, accessToken: string): boolean {
  const access = extractClaims(accessToken, accessToken);
  return (["accountId", "organizationId", "userId"] as const).some((field) =>
    Boolean(claims[field] && access[field] && claims[field] !== access[field])
  );
}

export async function readCurrentAuthAccountStorageId(accounts: readonly CodexAccountRecord[] = []): Promise<string | undefined> {
  const auth = await readAuthFile();
  if (!auth?.tokens?.id_token || !auth.tokens.access_token) {
    return undefined;
  }

  const claims = extractClaims(auth.tokens.id_token, auth.tokens.access_token);
  if (!claims.email) {
    return undefined;
  }

  return resolveAccountStorageId({ ...claims, email: claims.email }, accounts);
}
