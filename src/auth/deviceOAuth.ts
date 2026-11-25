import { setTimeout as sleep } from "node:timers/promises";
import type { CodexTokens } from "../core/types";
import {
  DEVICE_EXCHANGE_REDIRECT_URI, DEVICE_TOKEN_ENDPOINT, DEVICE_USER_CODE_ENDPOINT,
  OAUTH_CLIENT_ID
} from "../infrastructure/config/apiEndpoints";
import { fetchWithTimeout } from "../utils/network";
import { exchangeCodeForTokens } from "./oauth";
import { isOAuthDeviceLimit } from "./oauthErrors";

export const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60_000;

export interface DeviceOAuthGrant {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
}

export async function requestDeviceOAuthGrant(signal: AbortSignal): Promise<DeviceOAuthGrant> {
  const response = await postDevice(DEVICE_USER_CODE_ENDPOINT, { client_id: OAUTH_CLIENT_ID }, signal);
  if (!response.ok) {
    throw new Error(`Device authorization request failed (HTTP ${response.status})`);
  }
  const data = parseDeviceResponse(await response.text());
  const deviceAuthId = readString(data?.["device_auth_id"]);
  const userCode = readString(data?.["user_code"]) ?? readString(data?.["usercode"]);
  if (!deviceAuthId || !userCode) {
    throw new Error("Device authorization response did not contain a code");
  }
  return {
    deviceAuthId,
    userCode,
    intervalMs: (readPositiveInt(data?.["interval"]) ?? 5) * 1000,
    expiresAt: Date.now() + Math.min((readPositiveInt(data?.["expires_in"]) ?? Infinity) * 1000, DEVICE_LOGIN_TIMEOUT_MS)
  };
}

export async function completeDeviceOAuthGrant(grant: DeviceOAuthGrant, signal: AbortSignal): Promise<CodexTokens> {
  let interval = grant.intervalMs;
  while (Date.now() < grant.expiresAt) {
    await sleep(Math.min(interval, grant.expiresAt - Date.now()), undefined, { signal });
    checkDeviceDeadline(grant.expiresAt, signal);
    const response = await postDevice(DEVICE_TOKEN_ENDPOINT, { device_auth_id: grant.deviceAuthId, user_code: grant.userCode }, signal);
    const raw = await response.text();
    const data = parseDeviceResponse(raw);
    checkDeviceDeadline(grant.expiresAt, signal);
    if (response.ok) {
      const code = readString(data?.["authorization_code"]);
      const verifier = readString(data?.["code_verifier"]);
      if (!code || !verifier) {
        throw new Error("Device authorization did not return an exchange code");
      }
      const tokens = await exchangeCodeForTokens(code, verifier, DEVICE_EXCHANGE_REDIRECT_URI, signal);
      checkDeviceDeadline(grant.expiresAt, signal);
      return tokens;
    }
    const errorDetails = readRecord(data?.["error"]);
    const error = readString(data?.["error"]) ?? readString(errorDetails?.["code"]);
    // A generic 403/404 can mean pending. An explicit device restriction is terminal.
    if (isOAuthDeviceLimit(raw, errorDetails?.["message"], data?.["message"], data?.["error_description"])) {
      throw new Error("Device limit reached");
    }
    if (error === "slow_down") {
      interval += 5000;
    } else if (error === "expired_token" || error === "access_denied") {
      throw new Error(error === "expired_token" ? "Device authorization timed out" : "Device authorization was denied");
    } else if (response.status !== 403 && response.status !== 404 && error !== "authorization_pending") {
      throw new Error(`Device authorization poll failed (HTTP ${response.status})`);
    }
  }
  throw new Error("Device authorization timed out");
}

function postDevice(url: string, body: Record<string, string>, signal: AbortSignal): Promise<Response> {
  return fetchWithTimeout(url, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body)
  }, 15_000, "Device authorization");
}

function checkDeviceDeadline(expiresAt: number, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (Date.now() >= expiresAt) {
    throw new Error("Device authorization timed out");
  }
}

function parseDeviceResponse(raw: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function readRecord(data: unknown): Record<string, unknown> | undefined {
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
