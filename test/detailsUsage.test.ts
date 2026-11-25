import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAccountRecord, CodexTokens } from "../src/core/types";
import { recordQuotaHistory } from "../src/domain/quotaHistory";
import { fetchProfileLifetimeTokens } from "../src/services/usage";
import type { AccountsRepository } from "../src/storage";
import { openDetailsPanel, refreshDetailsPanel } from "../src/ui/details";

const { createWebviewPanel } = vi.hoisted(() => ({ createWebviewPanel: vi.fn() }));

vi.mock("vscode", () => ({
  env: { language: "en" },
  ViewColumn: { Beside: -2 },
  Uri: { joinPath: (_uri: unknown, ...parts: string[]) => parts.join("/") },
  window: { createWebviewPanel },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    onDidChangeConfiguration: () => ({ dispose: vi.fn() })
  }
}));

const tokens: CodexTokens = {
  idToken: "test-id-token",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  accountId: "token-workspace"
};
const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "claim-workspace" } })).toString("base64url");
const displayTokens: CodexTokens = { ...tokens, idToken: `header.${claims}.signature`, accessToken: `header.${claims}.signature` };
const account: CodexAccountRecord = {
  id: "saved-account",
  email: "dev@example.com",
  accountId: "selected-workspace",
  isActive: false,
  createdAt: 1,
  updatedAt: 1
};
const secondAccount: CodexAccountRecord = { ...account, id: "second", accountId: "second-workspace" };
const context = { extensionUri: {} } as vscode.ExtensionContext;
const dailyUsage = { days: 30, points: [{ date: "2026-11-20", total_tokens: 80 }] };
const fetchMock = vi.fn<typeof fetch>();

let onDispose: () => void;
const panel = {
  title: "",
  reveal: vi.fn(),
  dispose: () => onDispose?.(),
  onDidDispose: (handler: () => void) => {
    onDispose = handler;
  },
  webview: {
    html: "",
    cspSource: "test-source",
    onDidReceiveMessage: vi.fn(),
    asWebviewUri: (uri: string) => uri
  }
};

beforeEach(() => {
  panel.webview.html = "";
  createWebviewPanel.mockReturnValue(panel);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  panel.dispose();
  vi.unstubAllGlobals();
});

function createRepository(): AccountsRepository {
  return {
    getTokens: vi.fn(async () => displayTokens),
    getFreshTokens: vi.fn(async (_accountId: string, options?: { force?: boolean }) =>
      options?.force ? { ...tokens, accessToken: "refreshed" } : tokens
    ),
    getAccount: vi.fn(async (id: string) => (id === account.id ? account : secondAccount))
  } as unknown as AccountsRepository;
}

describe("official lifetime token usage", () => {
  it("preserves zero and sends the saved workspace ID ahead of the token ID", async () => {
    fetchMock.mockResolvedValue(Response.json({ stats: { lifetime_tokens: 0 } }));
    await expect(fetchProfileLifetimeTokens(tokens, account.accountId)).resolves.toBe(0);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://chatgpt.com/backend-api/wham/profiles/me");
    expect(new Headers(options?.headers).get("ChatGPT-Account-Id")).toBe("selected-workspace");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer test-access-token");
  });

  it("falls back to a token workspace and then its claim when saved metadata is missing", async () => {
    fetchMock.mockImplementation(async () => Response.json({ stats: { lifetime_tokens: 12 } }));
    await fetchProfileLifetimeTokens(tokens, " ");
    await fetchProfileLifetimeTokens({ ...displayTokens, accountId: " " });
    expect(fetchMock.mock.calls.map(([, options]) => new Headers(options?.headers).get("ChatGPT-Account-Id"))).toEqual([
      "token-workspace",
      "claim-workspace"
    ]);
  });

  it.each([{}, { stats: {} }, { stats: { lifetime_tokens: null } }])("treats missing totals as unavailable", async (body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(fetchProfileLifetimeTokens(tokens)).resolves.toBeUndefined();
  });

  it.each([-1, 1.25, "10", Number.MAX_SAFE_INTEGER + 1])("rejects invalid totals (%s)", async (value) => {
    fetchMock.mockResolvedValue(Response.json({ stats: { lifetime_tokens: value } }));
    await expect(fetchProfileLifetimeTokens(tokens)).rejects.toThrow("Invalid profile usage response");
  });
});

describe("account details usage", () => {
  it("renders a local zero separately from a missing window without another API request", async () => {
    fetchMock.mockImplementation(async (input) => String(input).endsWith("/profiles/me")
      ? Response.json({ stats: { lifetime_tokens: 0 } }) : Response.json(dailyUsage));
    const saved = { ...account };
    const now = Date.now();
    recordQuotaHistory(saved, {
      hourlyPercentage: 0, hourlyWindowPresent: true, hourlyResetTime: now + 60_000, weeklyPercentage: 0
    }, now - 60_000, displayTokens);
    const repo = createRepository();
    vi.mocked(repo.getAccount).mockResolvedValue(saved);
    openDetailsPanel(context, repo, saved);

    await vi.waitFor(() => expect(panel.webview.html).toContain('class="usage-chart"'));
    const history = panel.webview.html.match(/<section class="usage-card quota-history">[\s\S]*?<\/section>/)?.[0];
    expect(history).toContain('<span>0%</span><meter min="0" max="100" value="0"');
    expect(history).toContain('<td><span class="usage-note">—</span></td>');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("makes older snapshots available to the 30-day paginator and marks the 7-day subset", async () => {
    fetchMock.mockImplementation(async (input) => String(input).endsWith("/profiles/me")
      ? Response.json({ stats: { lifetime_tokens: 0 } }) : Response.json(dailyUsage));
    const saved = { ...account };
    const now = Date.now();
    for (let i = 16; i >= 1; i -= 1) {
      recordQuotaHistory(saved, { hourlyPercentage: i, hourlyWindowPresent: true, weeklyPercentage: 0 }, now - i * 86_400_000 + 10_000, displayTokens);
    }
    const repo = createRepository();
    vi.mocked(repo.getAccount).mockResolvedValue(saved);
    openDetailsPanel(context, repo, saved);
    await vi.waitFor(() => expect(panel.webview.html).toContain('class="usage-chart"'));
    expect(panel.webview.html.match(/<tr data-quota-week=/g)).toHaveLength(16);
    expect(panel.webview.html.match(/<tr data-quota-week="true"/g)).toHaveLength(7);
    expect(panel.webview.html).toContain('data-quota-page aria-live="polite">1 / 2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("displays an unknown Business credit balance while keeping the Token chart", async () => {
    fetchMock.mockImplementation(async (input) => String(input).endsWith("/profiles/me")
      ? Response.json({ stats: { lifetime_tokens: 0 } }) : Response.json(dailyUsage));
    const business = { ...account, planType: "business", accountStructure: "organization",
      quotaSummary: { hourlyPercentage: 0, weeklyPercentage: 40 } };
    const repo = createRepository();
    vi.mocked(repo.getAccount).mockResolvedValue(business);
    openDetailsPanel(context, repo, business);
    await vi.waitFor(() => {
      expect(panel.webview.html).toContain("Credits left: Unknown");
      expect(panel.webview.html).toContain('class="usage-chart"');
    });
  });

  it("renders zero and the daily chart and retries only the lifetime 401 against the same workspace", async () => {
    const lifetimeHeaders: Headers[] = [];
    const dailyRequests: Array<{ url: string; headers: Headers }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/profiles/me")) {
        lifetimeHeaders.push(new Headers(init?.headers));
        return lifetimeHeaders.length === 1
          ? new Response(null, { status: 401 })
          : Response.json({ stats: { lifetime_tokens: 0 } });
      }
      dailyRequests.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json(dailyUsage);
    });
    const repo = createRepository();
    openDetailsPanel(context, repo, account);

    await vi.waitFor(() => {
      expect(panel.webview.html).toContain("Official lifetime tokens: <strong>0</strong>");
      expect(panel.webview.html).toContain('class="usage-chart"');
      expect(panel.webview.html).toContain("Last 30 days");
    });
    expect(lifetimeHeaders.map((value) => value.get("Authorization"))).toEqual(["Bearer test-access-token", "Bearer refreshed"]);
    expect(lifetimeHeaders.map((value) => value.get("ChatGPT-Account-Id"))).toEqual(["selected-workspace", "selected-workspace"]);
    expect(dailyRequests.map(({ url, headers }) => [new URL(url).searchParams.get("days"), headers.get("ChatGPT-Account-Id")]))
      .toEqual([["30", "selected-workspace"]]);
    expect(repo.getFreshTokens).toHaveBeenCalledWith(account.id, { force: true, expectedTokens: tokens });
  });

  it.each([
    { response: () => Response.json({ stats: {} }), expected: "Unavailable" },
    { response: () => new Response(null, { status: 503 }), expected: "Failed to load" }
  ])("renders $expected without losing the daily chart", async ({ expected, response }) => {
    fetchMock.mockImplementation(async (input) => String(input).endsWith("/profiles/me") ? response() : Response.json(dailyUsage));
    openDetailsPanel(context, createRepository(), account);

    await vi.waitFor(() => {
      expect(panel.webview.html).toContain(`Official lifetime tokens: <strong>${expected}</strong>`);
      expect(panel.webview.html).toContain('class="usage-chart"');
    });
  });

  it("keeps the daily chart visible while lifetime usage loads and drops late results after an account switch", async () => {
    let finishFirst: (value: Response) => void = () => undefined;
    const first = new Promise<Response>((resolve) => { finishFirst = resolve; });
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/profiles/me")) {
        return new Headers(init?.headers).get("ChatGPT-Account-Id") === account.accountId
          ? first
          : Response.json({ stats: { lifetime_tokens: 42 } });
      }
      return Response.json(dailyUsage);
    });
    const repo = createRepository();
    openDetailsPanel(context, repo, account);
    await vi.waitFor(() => {
      expect(panel.webview.html).toContain('class="usage-chart"');
      expect(panel.webview.html).toContain("Official lifetime tokens: <strong>Loading…</strong>");
    });
    openDetailsPanel(context, repo, secondAccount);
    await vi.waitFor(() => expect(panel.webview.html).toContain("Official lifetime tokens: <strong>42</strong>"));
    finishFirst(Response.json({ stats: { lifetime_tokens: 777 } }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(panel.webview.html).toContain("Official lifetime tokens: <strong>42</strong>");
    expect(panel.webview.html).not.toContain("<strong>777</strong>");
  });

  it("reloads once for a corrected workspace on the same saved account and discards its previous pending result", async () => {
    let current = account;
    let finishOldUsage: (value: Response) => void = () => undefined;
    const oldUsage = new Promise<Response>((resolve) => { finishOldUsage = resolve; });
    const profileScopes: Array<string | null> = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (!String(input).endsWith("/profiles/me")) {
        return Response.json(dailyUsage);
      }
      const scope = new Headers(init?.headers).get("ChatGPT-Account-Id");
      profileScopes.push(scope);
      return scope === account.accountId ? oldUsage : Response.json({ stats: { lifetime_tokens: 42 } });
    });
    const repo = createRepository();
    vi.mocked(repo.getAccount).mockImplementation(async () => current);
    openDetailsPanel(context, repo, account);
    await vi.waitFor(() => expect(profileScopes).toEqual(["selected-workspace"]));

    try {
      current = { ...account, accountId: "corrected-workspace", organizationId: "corrected-org", userId: "corrected-user" };
      await refreshDetailsPanel();
      await vi.waitFor(() => expect(panel.webview.html).toContain("Official lifetime tokens: <strong>42</strong>"));
    } finally {
      finishOldUsage(Response.json({ stats: { lifetime_tokens: 777 } }));
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
    await refreshDetailsPanel();
    expect(profileScopes).toEqual(["selected-workspace", "corrected-workspace"]);
    expect(panel.webview.html).toContain("Official lifetime tokens: <strong>42</strong>");
    expect(panel.webview.html).not.toContain("<strong>777</strong>");
    expect(panel.webview.html).toContain('class="usage-chart"');
  });
});
