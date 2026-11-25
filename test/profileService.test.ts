import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexTokens } from "../src/core/types";

const { fetchWithTimeoutMock } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn()
}));

vi.mock("../src/services/workspaceRetry", () => ({
  shouldRetryWithoutWorkspace: vi.fn(() => false)
}));

vi.mock("../src/utils/debug", () => ({
  logNetworkEvent: vi.fn()
}));

vi.mock("../src/utils/network", () => ({
  fetchWithTimeout: fetchWithTimeoutMock,
  isRetriableHttpStatus: vi.fn(() => false),
  isRetriableNetworkError: vi.fn(() => false),
  retryWithBackoff: async <T>(operation: () => Promise<T>) => operation()
}));

import { fetchRemoteAccountProfile } from "../src/services/profile";

function createJwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

describe("fetchRemoteAccountProfile", () => {
  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
  });

  it("repairs a stale Team accountId by selecting the saved Personal structure", async () => {
    const tokens: CodexTokens = {
      idToken: createJwt({
        email: "dev@example.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_team" }
      }),
      accessToken: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_team" }
      }),
      accountId: "acct_team"
    };
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accounts: [
            { id: "acct_personal", structure: "personal", plan_type: "plus", name: null },
            { id: "acct_team", structure: "workspace", plan_type: "team", name: "Team Workspace" }
          ]
        }),
        { status: 200 }
      )
    );

    const profile = await fetchRemoteAccountProfile(tokens, {
      forceRefresh: true,
      preferredAccountName: "Personal",
      preferredAccountStructure: "personal"
    });

    expect(profile).toMatchObject({
      accountId: "acct_personal",
      accountStructure: "personal",
      planType: "plus"
    });
  });

  it("prefers selected workspace plan metadata over top-level user plan metadata", async () => {
    const tokens: CodexTokens = {
      idToken: createJwt({
        email: "dev@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_team",
          organization_id: "org_team"
        }
      }),
      accessToken: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_team",
          organization_id: "org_team"
        }
      }),
      accountId: "acct_team"
    };

    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          email: "dev@example.com",
          plan_type: "plus",
          subscription_active_until: "111",
          accounts: [
            {
              id: "acct_personal",
              plan_type: "plus",
              organization_id: "org_personal",
              subscription_active_until: "111",
              name: "Personal"
            },
            {
              id: "acct_team",
              plan_type: "team",
              organization_id: "org_team",
              subscription_active_until: "222",
              name: "Team Workspace",
              type: "workspace"
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const profile = await fetchRemoteAccountProfile(tokens, { forceRefresh: true });

    expect(profile).toMatchObject({
      email: "dev@example.com",
      accountId: "acct_team",
      organizationId: "org_team",
      accountName: "Team Workspace",
      accountStructure: "workspace",
      planType: "team",
      subscriptionActiveUntil: "222"
    });
  });

  it("disambiguates same accountId workspaces by organizationId", async () => {
    const personalTokens: CodexTokens = {
      idToken: createJwt({
        email: "dev@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_shared",
          organization_id: "org_personal"
        }
      }),
      accessToken: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_shared",
          organization_id: "org_personal"
        }
      }),
      accountId: "acct_shared"
    };
    const teamTokens: CodexTokens = {
      idToken: createJwt({
        email: "dev@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_shared",
          organization_id: "org_team"
        }
      }),
      accessToken: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_shared",
          organization_id: "org_team"
        }
      }),
      accountId: "acct_shared"
    };

    fetchWithTimeoutMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            email: "dev@example.com",
            accounts: [
              {
                id: "acct_shared",
                workspace_id: "ws_personal",
                organization_id: "org_personal",
                plan_type: "plus",
                subscription_active_until: "111",
                name: "Personal Workspace",
                type: "personal"
              },
              {
                id: "acct_shared",
                workspace_id: "ws_team",
                organization_id: "org_team",
                plan_type: "team",
                subscription_active_until: "222",
                name: "Team Workspace",
                type: "workspace"
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      )
    );

    const personalProfile = await fetchRemoteAccountProfile(personalTokens, { forceRefresh: true });
    const teamProfile = await fetchRemoteAccountProfile(teamTokens, { forceRefresh: true });

    expect(personalProfile).toMatchObject({
      accountId: "acct_shared",
      organizationId: "org_personal",
      accountName: "Personal Workspace",
      accountStructure: "personal",
      planType: "plus",
      subscriptionActiveUntil: "111"
    });
    expect(teamProfile).toMatchObject({
      accountId: "acct_shared",
      organizationId: "org_team",
      accountName: "Team Workspace",
      accountStructure: "workspace",
      planType: "team",
      subscriptionActiveUntil: "222"
    });
  });

  it("prefers confirmed account and organization IDs over a stale workspace name", async () => {
    const tokens: CodexTokens = {
      idToken: createJwt({ email: "dev@example.com", "https://api.openai.com/auth": { organization_id: "org_target" } }),
      accessToken: createJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_target" } })
    };
    fetchWithTimeoutMock.mockResolvedValueOnce(new Response(JSON.stringify({
      accounts: {
        acct_other: { account: { account_id: "acct_other", organization_id: "org_other", name: "Old Name", type: "workspace" } },
        acct_target: { account: { organization_id: "org_target", name: "New Name", type: "workspace" } }
      }
    })));

    expect(await fetchRemoteAccountProfile(tokens, { forceRefresh: true, preferredAccountName: "Old Name" }))
      .toMatchObject({ accountId: "acct_target", organizationId: "org_target", accountName: "New Name" });
  });

  it("rejects the same accountId when the response identifies a different organization", async () => {
    const tokens: CodexTokens = {
      idToken: createJwt({ email: "dev@example.com", "https://api.openai.com/auth": { organization_id: "org_target" } }),
      accessToken: createJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_target" } })
    };
    const response = JSON.stringify({
      accounts: [{ account_id: "acct_target", organization_id: "org_other", name: "Team", type: "workspace" }]
    });
    fetchWithTimeoutMock.mockImplementation(async () => new Response(response));

    expect(await fetchRemoteAccountProfile(tokens, { forceRefresh: true })).toBeUndefined();
  });

  it("matches and caches different saved organizations even when the token, accountId and workspace name are shared", async () => {
    const accessToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_shared"
      }
    });
    const tokens: CodexTokens = {
      idToken: createJwt({
        email: "dev@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_shared"
        }
      }),
      accessToken,
      accountId: "acct_shared"
    };
    const body = JSON.stringify({
      accounts: [
        { id: "acct_shared", organization_id: "org_personal", plan_type: "plus", name: "Shared" },
        { id: "acct_shared", organization_id: "org_team", plan_type: "team", name: "Shared" }
      ]
    });
    fetchWithTimeoutMock.mockImplementation(async () => new Response(body));

    const personalProfile = await fetchRemoteAccountProfile(tokens, { preferredOrganizationId: "org_personal", preferredAccountName: "Shared" });
    const teamProfile = await fetchRemoteAccountProfile(tokens, { preferredOrganizationId: "org_team", preferredAccountName: "Shared" });

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    expect(personalProfile?.organizationId).toBe("org_personal");
    expect(teamProfile?.organizationId).toBe("org_team");
    expect(teamProfile?.planType).toBe("team");
  });
});
