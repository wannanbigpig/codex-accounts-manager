import { afterEach, describe, expect, it, vi } from "vitest";
import { APIError } from "../src/core/errors";
import { fetchResetCreditHistory } from "../src/services/resetCreditHistory";

vi.mock("../src/infrastructure/config/proxyEnvironment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/infrastructure/config/proxyEnvironment")>()),
  getCodexProxyDispatcher: () => undefined
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchResetCreditHistory", () => {
  it("sends an account-scoped GET and round-trips an opaque cursor verbatim", async () => {
    const cursor = "  opaque+/=%2F#?&cursor=next  ";
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({
        events: [{ id: "grant-1", kind: "granted", occurred_at: "2026-11-01T19:55:00Z" }],
        next_cursor: cursor
      }))
      .mockResolvedValueOnce(Response.json({
        events: [{ id: "future-1", kind: "future_kind", occurred_at: "2026-11-02T01:00:00+08:00" }],
        next_cursor: null
      }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchResetCreditHistory("access-token", "acct-team");
    const last = await fetchResetCreditHistory("access-token", "acct-team", first.nextCursor);

    expect(first).toEqual({
      events: [{ id: "grant-1", kind: "granted", occurredAt: "2026-11-01T19:55:00Z" }],
      nextCursor: cursor
    });
    expect(last).toStrictEqual({ events: [{ id: "future-1", kind: "future_kind", occurredAt: "2026-11-02T01:00:00+08:00" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, init] = fetchMock.mock.calls[0]!;
    expect(firstUrl).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/history");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer access-token");
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct-team");
    expect(headers.get("Accept")).toBe("application/json");
    const nextUrl = new URL(fetchMock.mock.calls[1]![0]);
    expect([...nextUrl.searchParams.entries()]).toEqual([["cursor", cursor]]);
  });

  it.each([undefined, null, ""])("accepts an empty final page with cursor %s", async (nextCursor) => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ events: [], next_cursor: nextCursor }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchResetCreditHistory("access-token")).resolves.toStrictEqual({ events: [] });
    expect(new Headers(fetchMock.mock.calls[0]?.[1].headers).has("ChatGPT-Account-Id")).toBe(false);
  });

  it("leaves an empty traversable page and its whitespace-only cursor intact", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [], next_cursor: " " })));

    await expect(fetchResetCreditHistory("access-token", "acct-team")).resolves.toEqual({ events: [], nextCursor: " " });
  });

  it.each([
    "{",
    '{"error":"not a history page"}',
    '{"events":null}',
    '{"events":[{"id":"grant-1","occurred_at":"2026-11-01T19:55:00Z"}]}',
    '{"events":[],"next_cursor":123}'
  ])("rejects an invalid history response instead of returning partial or empty history", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));

    await expect(fetchResetCreditHistory("access-token", "acct-team")).rejects.toThrow(APIError);
  });

  it("preserves HTTP 401 for the caller's authorization retry without retrying the request itself", async () => {
    const fetchMock = vi.fn(async () => Response.json({ detail: "expired token" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchResetCreditHistory("access-token", "acct-team", "continuation")).rejects.toMatchObject({
      name: "APIError", statusCode: 401
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
