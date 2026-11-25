import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAccountRecord, CodexTokens } from "../src/core/types";
import { clearQuotaCacheForAccount, refreshQuota } from "../src/services/quota";

vi.mock("../src/infrastructure/config/proxyEnvironment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/infrastructure/config/proxyEnvironment")>()),
  getCodexProxyDispatcher: () => undefined
}));

const start = Date.parse("2026-11-24T12:00:00Z");
const tokens: CodexTokens = { idToken: "fixture-id", accessToken: "fixture-access", accountId: "acct_team" };
const activeTokens: CodexTokens = { ...tokens, accessToken: "rotated-access" };
let account: CodexAccountRecord;
let accountNumber = 0;
let requestTimes: number[];

function setResponses(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockImplementation(async () => {
    requestTimes.push(Date.now());
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected quota request");
    }
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function limited(header?: string): Response {
  return Response.json({ detail: { code: "rate_limit_exceeded" } }, {
    status: 429,
    headers: header === undefined ? undefined : { "Retry-After": header }
  });
}

function quota(): Response {
  return Response.json({ rate_limit: { primary_window: { used_percent: 20 } } });
}

function truncatedResponse(status: number, headers?: HeadersInit): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.error(new TypeError("Connection terminated after headers"));
    }
  }), { status, headers });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  requestTimes = [];
  account = {
    id: `quota-rate-limit-${++accountNumber}`,
    email: "dev@example.test",
    accountId: "acct_team",
    organizationId: "org_team",
    userId: "user_team",
    createdAt: start,
    updatedAt: start
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("quota Retry-After", () => {
  it.each(["2", new Date(start + 2_000).toUTCString()])("honors the short Retry-After %s and merges an identical inflight refresh", async (header) => {
    const fetchMock = setResponses(limited(header), quota());
    const first = refreshQuota(account, tokens, true);
    await vi.advanceTimersByTimeAsync(0);
    const merged = refreshQuota(account, tokens, true);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await first).quota?.hourlyPercentage).toBe(80);
    expect((await merged).quota?.hourlyPercentage).toBe(80);
    expect(requestTimes).toEqual([start, start + 2_000]);
  });

  it("honors Retry-After when the 429 response body is interrupted after its headers", async () => {
    const fetchMock = setResponses(truncatedResponse(429, { "Retry-After": "2" }), quota());
    const refresh = refreshQuota(account, tokens, true);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect((await refresh).quota?.hourlyPercentage).toBe(80);
    expect(requestTimes).toEqual([start, start + 2_000]);
  });

  it("blocks other credentials while a 429 body stalls and measures the deadline from the headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
      const signal = init?.signal;
      return new Response(new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        }
      }), { status: 429, headers: { "Retry-After": "45" } });
    }).mockResolvedValueOnce(quota());
    vi.stubGlobal("fetch", fetchMock);

    const refresh = refreshQuota(account, tokens, true);
    await vi.advanceTimersByTimeAsync(0);
    expect((await refreshQuota(account, activeTokens, true)).error?.retryAt).toBe(start + 45_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await refresh).error).toMatchObject({ statusCode: 429, retryAt: start + 45_000 });

    await vi.advanceTimersByTimeAsync(29_999);
    expect((await refreshQuota(account, activeTokens, true)).error?.retryAt).toBe(start + 45_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await refreshQuota(account, activeTokens, true)).quota?.hourlyPercentage).toBe(80);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "nonsense", "-3", "0.5"])("uses the original retry schedule for missing or invalid Retry-After %s", async (header) => {
    const fetchMock = setResponses(...Array.from({ length: 4 }, () => limited(header)));
    const refresh = refreshQuota(account, tokens, true);
    await vi.advanceTimersByTimeAsync(2_600);
    const result = await refresh;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requestTimes).toEqual([start, start + 300, start + 1_100, start + 2_600]);
    expect(result.error?.statusCode).toBe(429);
    expect(result.error?.retryAt).toBeUndefined();
  });

  it("returns a long cooldown promptly and respects it after force, token rotation and cache invalidation", async () => {
    const fetchMock = setResponses(limited("90"), quota(), quota());
    const first = await refreshQuota(account, tokens, true);
    expect(first.error).toMatchObject({ code: "rate_limit_exceeded", statusCode: 429, retryAt: start + 90_000 });
    expect(first.quota).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearQuotaCacheForAccount(account.id);
    const blocked = await refreshQuota(account, activeTokens, true);
    expect(blocked.error?.retryAt).toBe(start + 90_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect((await refreshQuota({ ...account, organizationId: "org_personal" }, tokens, true)).quota).toBeDefined();
    await vi.advanceTimersByTimeAsync(89_999);
    expect((await refreshQuota(account, activeTokens)).error?.retryAt).toBe(start + 90_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await refreshQuota(account, activeTokens, true)).quota).toBeDefined();
    expect(requestTimes).toEqual([start, start, start + 90_000]);
  });

  it("keeps the retry budget and leaves a cooldown after the last short 429", async () => {
    const fetchMock = setResponses(...Array.from({ length: 4 }, () => limited("2")));
    const refresh = refreshQuota(account, tokens, true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await refresh).error).toMatchObject({ statusCode: 429, retryAt: start + 8_000 });
    expect((await refreshQuota(account, activeTokens, true)).error?.retryAt).toBe(start + 8_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requestTimes).toEqual([start, start + 2_000, start + 4_000, start + 6_000]);
  });

  it("defers consecutive short hints when their combined inline delay would exceed 15 seconds", async () => {
    const fetchMock = setResponses(limited("8"), limited("8"));
    const refresh = refreshQuota(account, tokens, true);
    await vi.advanceTimersByTimeAsync(8_000);

    expect((await refresh).error?.retryAt).toBe(start + 16_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not serve a pre-429 cached success while waiting or after the cooldown ends", async () => {
    const fetchMock = setResponses(quota(), limited("20"), quota());
    expect((await refreshQuota(account, tokens)).quota).toBeDefined();
    expect((await refreshQuota(account, activeTokens, true)).error?.retryAt).toBe(start + 20_000);
    const blocked = await refreshQuota(account, tokens);
    expect(blocked.quota).toBeUndefined();
    expect(blocked.error?.retryAt).toBe(start + 20_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(20_000);
    expect((await refreshQuota(account, tokens)).quota).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["organizationId", "userId"] as const)("keeps an existing cooldown when a legacy workspace gains its %s", async (field) => {
    const fetchMock = setResponses(limited("30"));
    await refreshQuota({ ...account, [field]: undefined }, tokens, true);

    expect((await refreshQuota(account, activeTokens, true)).error?.retryAt).toBe(start + 30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("separates known users even when they share saved and remote workspace IDs", async () => {
    const fetchMock = setResponses(limited("30"), quota());
    await refreshQuota(account, tokens, true);

    expect((await refreshQuota({ ...account, userId: "other-user" }, tokens, true)).quota).toBeDefined();
    expect((await refreshQuota(account, activeTokens, true)).error?.retryAt).toBe(start + 30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors a persisted 429 after reopening and keeps the later in-memory deadline", async () => {
    const fetchMock = setResponses(limited("90"), quota());
    const saved = {
      ...account,
      quotaError: { statusCode: 429, retryAt: start + 45_000, message: "Limited", timestamp: start / 1_000 }
    };

    expect((await refreshQuota(saved, activeTokens, true)).error?.retryAt).toBe(start + 45_000);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(45_000);
    expect((await refreshQuota(saved, activeTokens, true)).error?.retryAt).toBe(start + 135_000);
    expect((await refreshQuota({ ...saved, quotaError: { ...saved.quotaError, retryAt: start + 60_000 } }, tokens)).error?.retryAt)
      .toBe(start + 135_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(90_000);
    expect((await refreshQuota(saved, activeTokens, true)).quota).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a queued backoff request bypass a newly observed cooldown", async () => {
    const fetchMock = setResponses(new Response(null, { status: 503 }), limited("30"));
    const first = refreshQuota(account, tokens, true);
    await vi.advanceTimersByTimeAsync(0);
    expect((await refreshQuota(account, activeTokens, true)).error?.retryAt).toBe(start + 30_000);
    await vi.advanceTimersByTimeAsync(300);
    expect((await first).error).toMatchObject({ statusCode: 429, retryAt: start + 30_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a scoped HTTP 401 without suppressing it via an unscoped retry", async () => {
    const fetchMock = setResponses(Response.json({ detail: { code: "workspace_authorization_required" } }, { status: 401 }), quota());
    const result = await refreshQuota(account, tokens, true);

    expect(result.error).toMatchObject({ statusCode: 401, code: "workspace_authorization_required" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("ChatGPT-Account-Id")).toBe("acct_team");
  });

  it("preserves the HTTP 401 status if its body disconnects", async () => {
    const fetchMock = setResponses(truncatedResponse(401), quota());
    const refresh = refreshQuota(account, tokens, true);
    await vi.advanceTimersByTimeAsync(300);

    expect((await refresh).error?.statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
