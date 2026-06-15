import { describe, expect, it } from "vitest";
import { sortDashboardAccounts } from "../src/application/dashboard/buildDashboardState";

describe("sortDashboardAccounts", () => {
  it("puts the current window account before active accounts", () => {
    const accounts = [
      { id: "active", isActive: true, createdAt: 3, email: "active@example.com" },
      { id: "current", isActive: false, createdAt: 2, email: "current@example.com" },
      { id: "other", isActive: false, createdAt: 1, email: "other@example.com" }
    ];

    const sorted = sortDashboardAccounts(accounts, "current");

    expect(sorted.map((account) => account.id)).toEqual(["current", "active", "other"]);
  });
});
