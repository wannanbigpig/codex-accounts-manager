import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { ExtensionContext } from "vscode";
import { AccountsCommandService } from "../src/application/accounts/commandService";
import type { CodexTokens } from "../src/core/types";
import { AccountsRepository } from "../src/storage";

const { login, refreshQuota, fixtureHome, readAuth, writeAuth, authPath } = vi.hoisted(() => ({
  login: vi.fn(),
  refreshQuota: vi.fn(),
  fixtureHome: vi.fn<() => string | undefined>(),
  readAuth: vi.fn(),
  writeAuth: vi.fn(),
  authPath: vi.fn()
}));

vi.mock("os", async (original) => {
  const actual = await original<typeof import("os")>();
  return { ...actual, homedir: () => fixtureHome() ?? actual.homedir() };
});
vi.mock("../src/auth", async (original) => ({
  ...(await original<typeof import("../src/auth")>()),
  loginWithOAuth: login
}));
vi.mock("../src/codex", async (original) => ({
  ...(await original<typeof import("../src/codex")>()),
  getAuthJsonPath: authPath,
  readAuthFile: readAuth,
  writeAuthFile: writeAuth
}));
vi.mock("../src/application/accounts/quota", async (original) => ({
  ...(await original<typeof import("../src/application/accounts/quota")>()),
  refreshImportedAccountQuota: refreshQuota
}));
vi.mock("../src/services/profile", () => ({ fetchRemoteAccountProfile: async () => undefined }));

function tokens(
  accountId: string,
  generation: string,
  issuedAt?: number,
  expiresAt = Math.floor(Date.now() / 1000) + 3_600,
  identity?: { email: string; userId: string; organizationId?: string }
): CodexTokens {
  const payload = Buffer.from(
    JSON.stringify({
      email: identity?.email ?? `${accountId}@example.test`,
      iat: issuedAt,
      exp: expiresAt,
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId, chatgpt_user_id: identity?.userId, organization_id: identity?.organizationId
      }
    })
  ).toString("base64url");
  const token = `header.${payload}.${generation}`;
  return { idToken: token, accessToken: token, refreshToken: `refresh-${generation}`, accountId };
}

function profileContext(globalStoragePath: string): ExtensionContext {
  const secrets = new Map<string, string>();
  return {
    globalStorageUri: { fsPath: globalStoragePath },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      }
    }
  } as unknown as ExtensionContext;
}

describe("account reauthorization", () => {
  let directory: string;
  let context: ExtensionContext;
  let repo: AccountsRepository;
  let otherWindow: AccountsRepository;

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-reauthorization-"));
    fixtureHome.mockReturnValue(directory);
    vi.stubEnv("AIDECK_DATA_DIR", path.join(directory, "mirror"));
    authPath.mockReturnValue(path.join(directory, "auth.json"));
    refreshQuota.mockResolvedValue({});
    writeAuth.mockImplementation(async (value: CodexTokens) => {
      readAuth.mockResolvedValue({
        OPENAI_API_KEY: null,
        tokens: {
          id_token: value.idToken,
          access_token: value.accessToken,
          refresh_token: value.refreshToken,
          account_id: value.accountId
        }
      });
    });
    context = profileContext(directory);
    repo = new AccountsRepository(context);
    otherWindow = new AccountsRepository(context);
  });

  afterEach(async () => {
    repo?.dispose();
    otherWindow?.dispose();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("saves the new credentials without rolling back a switch made during OAuth", async () => {
    const former = await repo.upsertFromTokens(tokens("former", "original"));
    const replacement = await repo.upsertFromTokens(tokens("replacement", "original"));
    const active = await repo.switchAccount(former.id);
    const view = { refresh: vi.fn(), markObservedAuthIdentity: vi.fn() };
    const command = new AccountsCommandService(context, repo, view);
    const authorized = tokens("former", "reauthorized");
    writeAuth.mockClear();

    let finishLogin!: (value: CodexTokens) => void;
    login.mockReturnValue(
      new Promise<CodexTokens>((resolve) => {
        finishLogin = resolve;
      })
    );
    const reauthorization = command.reauthorizeAccount(active);
    try {
      await vi.waitFor(() => expect(login).toHaveBeenCalledOnce());
      await otherWindow.switchAccount(replacement.id);
    } finally {
      finishLogin(authorized);
      await reauthorization;
    }

    expect(writeAuth.mock.calls.map(([value]) => value.accountId)).toEqual(["replacement"]);
    expect((await repo.getAccount(replacement.id))?.isActive).toBe(true);
    expect((await repo.getAccount(former.id))?.isActive).toBe(false);
    expect(await repo.getTokens(former.id, { bypassCache: true, syncExternal: false })).toEqual(authorized);
    expect(view.markObservedAuthIdentity).not.toHaveBeenCalled();
    expect(refreshQuota).toHaveBeenCalledWith(repo, former.id);
  });

  it("updates auth.json and the observed identity if the reauthorized account is still active", async () => {
    const account = await repo.upsertFromTokens(tokens("active", "original"));
    const active = await repo.switchAccount(account.id);
    const view = { refresh: vi.fn(), markObservedAuthIdentity: vi.fn() };
    const command = new AccountsCommandService(context, repo, view);
    const authorized = tokens("active", "reauthorized");
    login.mockResolvedValue(authorized);
    writeAuth.mockClear();

    await command.reauthorizeAccount(active);

    expect(writeAuth).toHaveBeenCalledExactlyOnceWith(authorized);
    expect(view.markObservedAuthIdentity).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(refreshQuota).toHaveBeenCalledWith(repo, account.id);
  });

  it("keeps a renamed Business record, tags and active identity beside the same-email Personal workspace", async () => {
    const identity = { email: "before@example.test", userId: "user", organizationId: "org" };
    const renamed = { ...identity, email: "after@example.test" };
    const business = await repo.upsertFromTokens(tokens("shared", "business", undefined, undefined, identity));
    const personalTokens = tokens("shared", "personal", undefined, undefined, { ...renamed, organizationId: undefined });
    const personal = await repo.upsertFromTokens(personalTokens);
    await repo.setAccountTags(business.id, ["keep"]);
    await repo.switchAccount(business.id);
    const renewed = tokens("shared", "reauth", undefined, undefined, renamed);
    login.mockResolvedValue(renewed);
    const view = { refresh: vi.fn(), markObservedAuthIdentity: vi.fn() };
    await new AccountsCommandService(context, repo, view).reauthorizeAccount(business);
    await otherWindow.syncActiveAccountFromAuthFile();

    expect(await repo.getAccount(business.id)).toMatchObject({ email: renamed.email, tags: ["keep"], isActive: true });
    expect(await repo.getTokens(personal.id, { syncExternal: false, bypassCache: true })).toEqual(personalTokens);
    expect(await repo.getTokens(business.id, { syncExternal: false, bypassCache: true })).toEqual(renewed);
    expect(view.markObservedAuthIdentity).toHaveBeenCalledWith(business.id);
    const exported = await repo.exportSharedAccounts([business.id]);
    expect((await repo.previewSharedAccountsImport(exported)).overwriteCount).toBe(1);
    expect((await repo.importSharedAccounts(exported))[0]?.id).toBe(business.id);
    expect(await repo.listAccounts()).toHaveLength(2);
  });

  it.each(["different user", "different organization", "missing organization", "occupied record", "conflicting access token"])(
    "keeps credentials intact when a rename presents %s", async (mismatch) => {
      const identity = { email: "before@example.test", userId: "user", organizationId: "org" };
      const before = tokens("shared", "before", undefined, undefined, identity);
      const target = await repo.upsertFromTokens(before);
      await repo.switchAccount(target.id);
      const renamed = {
        email: "after@example.test", userId: mismatch === "different user" ? "other-user" : identity.userId,
        organizationId: mismatch === "different organization" ? "other-org"
          : mismatch === "missing organization" ? undefined : identity.organizationId
      };
      const candidate = tokens("shared", "candidate", undefined, undefined, renamed);
      if (mismatch === "conflicting access token") {
        candidate.accessToken = tokens("shared", "wrong-access", undefined, undefined, { ...renamed, organizationId: "other-org" }).accessToken;
      }
      if (mismatch === "occupied record") {
        await repo.upsertFromTokens(candidate);
      }
      writeAuth.mockClear();
      await expect(repo.reauthorizeAccount(target.id, async () => candidate)).rejects.toThrow();
      expect(writeAuth).not.toHaveBeenCalled();
      expect((await repo.getAccount(target.id))?.email).toBe(identity.email);
      expect(await repo.getTokens(target.id, { syncExternal: false, bypassCache: true })).toEqual(before);
    }
  );

  it.each([
    { scenario: "the same profile and an older iat", equalIssuedAt: false, separateProfiles: false },
    { scenario: "the same profile and identical iat and exp", equalIssuedAt: true, separateProfiles: false },
    { scenario: "a separate profile and an older iat", equalIssuedAt: false, separateProfiles: true },
    { scenario: "a separate profile and identical iat and exp", equalIssuedAt: true, separateProfiles: true }
  ])(
    "preserves a completed authorization against a late OAuth callback with $scenario",
    async ({ equalIssuedAt, separateProfiles }) => {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + 3_600;
      const original = tokens("active", "original", now - 120, expiresAt);
      const account = await repo.upsertFromTokens(original);
      const active = await repo.switchAccount(account.id);
      let secondContext = context;
      if (separateProfiles) {
        const secondStorage = path.join(directory, "second-profile");
        await fs.mkdir(secondStorage);
        secondContext = profileContext(secondStorage);
        otherWindow.dispose();
        otherWindow = new AccountsRepository(secondContext);
        await otherWindow.upsertFromTokens(original);
        await otherWindow.syncActiveAccountFromAuthFile();
      }
      const first = new AccountsCommandService(context, repo, { refresh: vi.fn() });
      const second = new AccountsCommandService(secondContext, otherWindow, { refresh: vi.fn() });
      const older = tokens("active", "first-callback", now - (equalIssuedAt ? 30 : 60), expiresAt);
      const newer = tokens("active", "second-callback", now - 30, expiresAt);
      writeAuth.mockClear();

      let finishFirst!: (value: CodexTokens) => void;
      login
        .mockReturnValueOnce(
          new Promise<CodexTokens>((resolve) => {
            finishFirst = resolve;
          })
        )
        .mockResolvedValueOnce(newer);
      const firstReauthorization = first.reauthorizeAccount(active);
      try {
        await vi.waitFor(() => expect(login).toHaveBeenCalledOnce());
        await second.reauthorizeAccount(active);
      } finally {
        finishFirst(older);
        await firstReauthorization;
      }

      expect(writeAuth).toHaveBeenCalledExactlyOnceWith(newer);
      expect(refreshQuota).toHaveBeenCalledExactlyOnceWith(otherWindow, account.id);
      expect(await repo.getTokens(account.id, { bypassCache: true, syncExternal: false })).toEqual(
        separateProfiles ? original : newer
      );
      expect(await otherWindow.getTokens(account.id, { bypassCache: true })).toEqual(newer);
    }
  );
});
