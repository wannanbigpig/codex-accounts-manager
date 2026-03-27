import { describe, expect, it } from "vitest";
import { normalizeQuotaSummary } from "../src/utils/quotaWindows";
import { normalizeQuotaColorThresholds } from "../src/utils/ui";

describe("normalizeQuotaSummary", () => {
  it("reclassifies swapped hourly and weekly windows by duration", () => {
    const normalized = normalizeQuotaSummary({
      hourlyPercentage: 10,
      hourlyResetTime: 100,
      hourlyWindowMinutes: 10080,
      hourlyWindowPresent: true,
      weeklyPercentage: 80,
      weeklyResetTime: 200,
      weeklyWindowMinutes: 300,
      weeklyWindowPresent: true,
      codeReviewPercentage: 50
    });

    expect(normalized?.hourlyPercentage).toBe(80);
    expect(normalized?.hourlyWindowMinutes).toBe(300);
    expect(normalized?.weeklyPercentage).toBe(10);
    expect(normalized?.weeklyWindowMinutes).toBe(10080);
  });
});

describe("normalizeQuotaColorThresholds", () => {
  it("keeps green at least 10 points above yellow", () => {
    expect(normalizeQuotaColorThresholds(45, 44)).toEqual({
      green: 45,
      yellow: 35
    });
  });
});
