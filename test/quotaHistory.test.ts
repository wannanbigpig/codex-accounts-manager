import { describe, expect, it } from "vitest";
import type { CodexAccountRecord, CodexQuotaSummary, CodexTokens } from "../src/core/types";
import { observedQuotaConsumption, readQuotaHistory, recordQuotaHistory } from "../src/domain/quotaHistory";

const now = Date.parse("2026-11-25T08:00:00Z");
const minute = 60_000;
const saved: CodexAccountRecord = { id: "personal", accountId: "shared", userId: "user", accountStructure: "personal",
  email: "same@example.test", isActive: true, createdAt: now, updatedAt: now };

function quota(hourly?: number, weekly?: number, resetAt?: number): CodexQuotaSummary {
  return { hourlyPercentage: hourly ?? 0, weeklyPercentage: weekly ?? 0, hourlyWindowPresent: hourly !== undefined,
    weeklyWindowPresent: weekly !== undefined, hourlyResetTime: resetAt, hourlyWindowMinutes: 300, weeklyWindowMinutes: 10_080 };
}

describe("local quota history", () => {
  it("separates same-email Personal and Business even when the remote account ID is shared", () => {
    const personal = { ...saved };
    const business = { ...saved, id: "business", accountStructure: "organization", organizationId: "org" };
    recordQuotaHistory(personal, quota(0), now);
    recordQuotaHistory(business, quota(undefined, 70), now);
    expect(readQuotaHistory(personal, undefined, now)[0]).toMatchObject({ hourly: { remaining: 0 }, weekly: undefined });
    expect(readQuotaHistory(business, undefined, now)[0]).toMatchObject({ hourly: undefined, weekly: { remaining: 70 } });
    expect(readQuotaHistory({ ...personal, organizationId: "org" }, undefined, now)).toEqual([]);
    expect(readQuotaHistory({ ...business, quotaHistory: personal.quotaHistory }, undefined, now)).toEqual([]);
  });

  it("counts observed drops without subtracting resets or inferring usage across missing windows", () => {
    const account = { ...saved };
    const firstReset = now + 10 * minute;
    const nextReset = firstReset + 300 * minute;
    recordQuotaHistory(account, quota(100, 50, firstReset), now);
    recordQuotaHistory(account, quota(70, 45, firstReset), now + minute);
    recordQuotaHistory(account, quota(0, 40, firstReset), now + 2 * minute);
    recordQuotaHistory(account, quota(80, 40, nextReset), now + 10 * minute);
    recordQuotaHistory(account, quota(60, 30, nextReset), now + 11 * minute);
    recordQuotaHistory(account, quota(undefined, 25), now + 12 * minute);
    recordQuotaHistory(account, quota(20, 20, nextReset), now + 13 * minute);
    const points = readQuotaHistory(account, undefined, now + 13 * minute);
    expect(observedQuotaConsumption(points, "hourly")).toBe(120);
    expect(observedQuotaConsumption(points, "weekly")).toBe(30);
    expect(points[2]?.hourly?.remaining).toBe(0);
    expect(points[5]?.hourly).toBeUndefined();
  });

  it("retains only recent changes and discards stale snapshots and small reset-time drift", () => {
    const account = { ...saved };
    const reset = now + 300 * minute;
    recordQuotaHistory(account, quota(60, 90, reset), now);
    recordQuotaHistory(account, quota(60, 90, reset + 1000), now + minute);
    recordQuotaHistory(account, quota(98, 100, reset), now + 30_000);
    expect(readQuotaHistory(account, undefined, now + minute)).toHaveLength(1);
    expect(readQuotaHistory(account, undefined, now + 31 * 86400_000)).toEqual([]);
  });

  it("skips the cross-window delta even if a reset is first observed after more quota was consumed", () => {
    const account = { ...saved };
    const reset = now + 2 * minute;
    recordQuotaHistory(account, quota(90, undefined, reset), now);
    recordQuotaHistory(account, quota(80, undefined, reset), now + minute);
    recordQuotaHistory(account, quota(65, undefined, reset + 300 * minute), reset + minute);
    expect(observedQuotaConsumption(readQuotaHistory(account, undefined, reset + minute), "hourly")).toBe(10);
  });

  it("falls back to verified credential scope when a legacy record lacks organization metadata", () => {
    const account = { ...saved, accountStructure: undefined };
    const make = (org: string): CodexTokens => {
      const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { organization_id: org } })).toString("base64url");
      return { idToken: `h.${payload}.s`, accessToken: `h.${payload}.s` };
    };
    recordQuotaHistory(account, quota(40), now, make("first"));
    expect(readQuotaHistory(account, make("first"), now)).toHaveLength(1);
    expect(readQuotaHistory(account, make("other"), now)).toEqual([]);
  });
});
