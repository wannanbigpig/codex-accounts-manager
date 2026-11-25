import { APIError } from "../core/errors";
import type { CodexResetCreditHistoryPage } from "../core/types";
import { RESET_CREDITS_HISTORY_URL } from "../infrastructure/config/apiEndpoints";
import { fetchWithTimeout } from "../utils/network";

export async function fetchResetCreditHistory(
  accessToken: string,
  accountId?: string,
  cursor?: string
): Promise<CodexResetCreditHistoryPage> {
  const url = new URL(RESET_CREDITS_HISTORY_URL);
  if (cursor !== undefined && cursor.length > 0) {
    url.searchParams.set("cursor", cursor);
  }

  const headers = new Headers({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" });
  if (accountId) {
    headers.set("ChatGPT-Account-Id", accountId);
  }

  const response = await fetchWithTimeout(url.toString(), { method: "GET", headers }, 15000, "Reset credit history request");
  if (!response.ok) {
    throw new APIError(`Reset credit history API returned HTTP ${response.status}`, { statusCode: response.status });
  }

  const raw = await response.text();
  const invalidPage = () => new APIError("Reset credit history API returned an invalid page", { statusCode: response.status });
  let page: unknown;
  try {
    page = JSON.parse(raw) as unknown;
  } catch {
    throw invalidPage();
  }

  if (!isRecord(page)) {
    throw invalidPage();
  }
  const { events: rawEvents, next_cursor: nextCursor } = page;
  if (!Array.isArray(rawEvents) || (nextCursor != null && typeof nextCursor !== "string")) {
    throw invalidPage();
  }

  const events = rawEvents.map((event: unknown) => {
    if (!isRecord(event)) {
      throw invalidPage();
    }
    const { id, kind, occurred_at: occurredAt } = event;
    if (typeof id !== "string" || typeof kind !== "string" || typeof occurredAt !== "string") {
      throw invalidPage();
    }
    return { id, kind, occurredAt };
  });
  return nextCursor ? { events, nextCursor } : { events };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
