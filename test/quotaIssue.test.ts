import { describe, expect, it } from "vitest";
import { getQuotaIssueKind } from "../src/utils/quotaIssue";

describe("quota issue classification", () => {
  it("keeps a 429 response classified as a quota failure even when its body mentions authorization", () => {
    expect(getQuotaIssueKind({ statusCode: 429, message: "API returned 429: authorization throughput exceeded", timestamp: 1 }))
      .toBe("quota");
  });

  it("recognizes structured authentication failures and old persisted errors", () => {
    expect(getQuotaIssueKind({ statusCode: 401, message: "Request denied", timestamp: 1 })).toBe("auth");
    expect(getQuotaIssueKind({ message: "API returned 401", timestamp: 1 })).toBe("auth");
  });
});
