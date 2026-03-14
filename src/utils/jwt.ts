import { DecodedAuthClaims } from "../types";

function decodeBase64Url(segment: string): string {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(padding), "base64").toString("utf8");
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("Invalid JWT token format");
  }

  return JSON.parse(decodeBase64Url(parts[1])) as Record<string, unknown>;
}

export function extractClaims(idToken: string, accessToken?: string): DecodedAuthClaims {
  const idPayload = decodeJwtPayload(idToken);
  const accessPayload = accessToken ? decodeJwtPayload(accessToken) : undefined;
  const idAuth = (idPayload["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const accessAuth = ((accessPayload?.["https://api.openai.com/auth"] ?? {}) as Record<
    string,
    unknown
  >);

  const organizations = Array.isArray(idAuth.organizations)
    ? (idAuth.organizations as Array<{ id?: string; title?: string }>)
    : undefined;

  return {
    email: typeof idPayload.email === "string" ? idPayload.email : undefined,
    userId:
      readString(idAuth, "chatgpt_user_id") ??
      readString(accessAuth, "chatgpt_user_id") ??
      readString(accessAuth, "user_id"),
    authProvider:
      typeof idPayload.auth_provider === "string" && idPayload.auth_provider.trim()
        ? idPayload.auth_provider
        : undefined,
    planType:
      readString(idAuth, "chatgpt_plan_type") ?? readString(accessAuth, "chatgpt_plan_type"),
    accountId:
      readString(idAuth, "chatgpt_account_id") ??
      readString(idAuth, "account_id") ??
      readString(accessAuth, "chatgpt_account_id"),
    organizationId:
      readString(idAuth, "organization_id") ??
      readString(idAuth, "chatgpt_organization_id") ??
      readString(idAuth, "org_id"),
    organizations
  };
}

export function getTokenExpiryEpochSeconds(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  return typeof payload.exp === "number" ? payload.exp : undefined;
}

export function isTokenExpired(token: string, skewSeconds = 60): boolean {
  const exp = getTokenExpiryEpochSeconds(token);
  if (!exp) {
    return false;
  }
  return exp <= Math.floor(Date.now() / 1000) + skewSeconds;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
