import { describe, expect, it, vi } from "vitest";
import { APIError } from "../src/core/errors";
import { runAuthenticatedAccountRequest } from "../src/application/accounts/authenticatedAccountRequest";
const original = { idToken: "old-id", accessToken: "old-access", refreshToken: "refresh", accountId: "acct-1" };
const renewed = { ...original, accessToken: "new-access" };
describe("runAuthenticatedAccountRequest", () => {
  it("refreshes once through the repository and retries after a 401", async () => {
    const repo = { getFreshTokens: vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(renewed) };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new APIError("unauthorized", { statusCode: 401 }))
      .mockResolvedValueOnce("ok");
    expect(await runAuthenticatedAccountRequest(repo, "account-1", request)).toBe("ok");
    expect(request).toHaveBeenNthCalledWith(1, original);
    expect(request).toHaveBeenNthCalledWith(2, renewed);
    expect(repo.getFreshTokens).toHaveBeenLastCalledWith("account-1", { force: true, expectedTokens: original });
  });
  it("does not replay non-authorization errors", async () => {
    const repo = { getFreshTokens: vi.fn().mockResolvedValue(original) };
    const request = vi.fn().mockRejectedValue(new APIError("limited", { statusCode: 429 }));
    await expect(runAuthenticatedAccountRequest(repo, "account-1", request)).rejects.toMatchObject({ statusCode: 429 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(repo.getFreshTokens).toHaveBeenCalledTimes(1);
  });
  it("does not retry a second authorization failure", async () => {
    const repo = { getFreshTokens: vi.fn().mockResolvedValue(original) };
    const request = vi.fn().mockRejectedValue(new APIError("unauthorized", { statusCode: 401 }));
    await expect(runAuthenticatedAccountRequest(repo, "account-1", request)).rejects.toMatchObject({ statusCode: 401 });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
