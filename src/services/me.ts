import { CodexTokens } from "../core/types";
import { APIError } from "../core/errors";
import { logNetworkEvent } from "../utils/debug";

export interface RemoteUserProfile {
  displayName?: string;
  avatarUrl?: string;
  email?: string;
}

export async function fetchRemoteUserProfile(tokens: CodexTokens): Promise<RemoteUserProfile | undefined> {
  const response = await fetch("https://chatgpt.com/backend-api/me", {
    method: "GET",
    headers: new Headers({
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: "application/json"
    })
  });

  const raw = await response.text();
  logNetworkEvent("me", {
    status: response.status,
    ok: response.ok,
    url: "https://chatgpt.com/backend-api/me",
    bodyPreview: raw.slice(0, 1000)
  });
  if (!response.ok) {
    throw new APIError(`Me API returned ${response.status}: ${raw.slice(0, 200)}`, {
      statusCode: response.status,
      responseBody: raw.slice(0, 200)
    });
  }

  const payload = JSON.parse(raw) as unknown;
  return parseRemoteUserProfile(payload);
}

function parseRemoteUserProfile(payload: unknown): RemoteUserProfile | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const nestedUser = isRecord(payload["user"]) ? payload["user"] : undefined;

  return {
    displayName:
      readString(payload, ["name", "display_name", "preferred_name"]) ??
      (nestedUser ? readString(nestedUser, ["name", "display_name", "preferred_name"]) : undefined),
    avatarUrl:
      readString(payload, ["picture", "avatar_url", "image", "profile_picture_url"]) ??
      (nestedUser ? readString(nestedUser, ["picture", "avatar_url", "image", "profile_picture_url"]) : undefined),
    email: readString(payload, ["email"]) ?? (nestedUser ? readString(nestedUser, ["email"]) : undefined)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
