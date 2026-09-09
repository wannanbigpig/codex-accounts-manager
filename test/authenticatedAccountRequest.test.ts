import { describe, expect, it, vi } from "vitest";
import { APIError } from "../src/core/errors";

const { needsRefreshMock, refreshTokensMock } = vi.hoisted(() => ({
  needsRefreshMock: vi.fn(() => false),
  refreshTokensMock: vi.fn()
}));

vi.mock("../src/auth/oauth", () => ({
  needsRefresh: needsRefreshMock,
  refreshTokens: refreshTokensMock
}));

import { runAuthenticatedAccountRequest } from "../src/application/accounts/authenticatedAccountRequest";

describe("runAuthenticatedAccountRequest", () => {
  it("refreshes once and retries a request after a 401", async () => {
    refreshTokensMock.mockResolvedValue({
      idToken: "new-id-token",
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token"
    });
    const repo = {
      getTokens: vi.fn(async () => ({
        idToken: "old-id-token",
        accessToken: "old-access-token",
        refreshToken: "refresh-token",
        accountId: "acct-1"
      })),
      updateTokens: vi.fn(async () => undefined)
    };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new APIError("unauthorized", { statusCode: 401 }))
      .mockResolvedValueOnce("ok");

    const result = await runAuthenticatedAccountRequest(repo as never, "account-1", request);

    expect(result).toBe("ok");
    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({ accessToken: "old-access-token" }));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({ accessToken: "new-access-token" }));
    expect(refreshTokensMock).toHaveBeenCalledTimes(1);
    expect(repo.updateTokens).toHaveBeenCalledWith(
      "account-1",
      expect.objectContaining({ accessToken: "new-access-token", accountId: "acct-1" })
    );
  });
});
