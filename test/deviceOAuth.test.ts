import * as fs from "node:fs/promises";
import { once } from "node:events";
import * as http from "http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { extractCodeFromCallbackUrl, prepareOAuthLoginSession, runPreparedOAuthLoginSession } from "../src/auth/oauth";
import { AccountsRepository } from "../src/storage";
import { DashboardOAuthCoordinator } from "../src/presentation/dashboard/oauthCoordinator";
import { DEVICE_EXCHANGE_REDIRECT_URI, DEVICE_TOKEN_ENDPOINT, DEVICE_USER_CODE_ENDPOINT, TOKEN_ENDPOINT } from "../src/infrastructure/config/apiEndpoints";

const { fetchWithTimeout, profile, refreshQuota } = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(), profile: vi.fn(), refreshQuota: vi.fn()
}));
vi.mock("../src/utils/network", async (original) => ({
  ...(await original<typeof import("../src/utils/network")>()), fetchWithTimeout
}));
vi.mock("../src/services/profile", () => ({ fetchRemoteAccountProfile: profile }));
vi.mock("../src/application/accounts/quota", () => ({ refreshImportedAccountQuota: refreshQuota }));
vi.mock("http", async (original) => ({ ...(await original<typeof http>()), createServer: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}

const translate = (key: string) => key;
const claims = Buffer.from(JSON.stringify({ email: "device@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "device-workspace" } })).toString("base64url");
const tokenResponse = () => Response.json({ id_token: `id.${claims}.fixture`, access_token: `access.${claims}.fixture`, refresh_token: "refresh-fixture" });
const approved = () => Response.json({ authorization_code: "approval-fixture", code_verifier: "verifier-fixture" });
const grant = (expiresIn = 60) => Response.json({ device_auth_id: "host-only-id", usercode: "CODE-1234", interval: "1", expires_in: expiresIn });

describe("device OAuth against the account repository", () => {
  let directory: string;
  let repo: AccountsRepository;
  let coordinator: DashboardOAuthCoordinator;
  let writeSecret: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-device-oauth-"));
    vi.stubEnv("CODEX_HOME", directory);
    vi.stubEnv("AIDECK_DATA_DIR", path.join(directory, "mirror"));
    await fs.writeFile(path.join(directory, "auth.json"), "existing auth");
    const secrets = new Map<string, string>();
    writeSecret = vi.fn(async (key: string, value: string) => { secrets.set(key, value); });
    repo = new AccountsRepository({ globalStorageUri: { fsPath: directory }, secrets: {
      get: async (key: string) => secrets.get(key), store: writeSecret
    } } as unknown as vscode.ExtensionContext);
    coordinator = new DashboardOAuthCoordinator(repo, vi.fn());
    profile.mockResolvedValue(undefined);
    refreshQuota.mockResolvedValue({});
  });

  afterEach(async () => {
    coordinator.dispose();
    repo.dispose();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function expectNoCredentials(): Promise<void> {
    expect(writeSecret).not.toHaveBeenCalled();
    expect(refreshQuota).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(directory, "auth.json"), "utf8")).toBe("existing auth");
    expect(await repo.listAccounts()).toEqual([]);
  }

  it("uses the advertised interval, exposes only the user code and exchanges through the device redirect", async () => {
    fetchWithTimeout.mockResolvedValueOnce(grant()).mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(approved()).mockResolvedValueOnce(tokenResponse());
    const prepared = await coordinator.prepareDeviceSession("test");
    expect(prepared.deviceOAuthGrant).toEqual({
      userCode: "CODE-1234", verificationUrl: "https://auth.openai.com/codex/device", expiresAt: expect.any(Number)
    });
    expect(JSON.stringify(prepared)).not.toContain("host-only-id");
    await expect(coordinator.completeDeviceSession("test", translate)).resolves.toEqual({ email: "device@example.test" });
    expect(fetchWithTimeout.mock.calls.map(([url]) => url)).toEqual([
      DEVICE_USER_CODE_ENDPOINT, DEVICE_TOKEN_ENDPOINT, DEVICE_TOKEN_ENDPOINT, TOKEN_ENDPOINT
    ]);
    const exchange = new URLSearchParams(fetchWithTimeout.mock.calls.at(-1)?.[1].body);
    expect(exchange.get("redirect_uri")).toBe(DEVICE_EXCHANGE_REDIRECT_URI);
    expect(exchange.get("code_verifier")).toBe("verifier-fixture");
    expect(writeSecret).toHaveBeenCalledTimes(1);
    expect(await repo.listAccounts()).toHaveLength(1);
  });

  it("ignores a late device-code response after cancellation", async () => {
    const codeRequest = deferred<Response>();
    fetchWithTimeout.mockReturnValueOnce(codeRequest.promise);
    const request = coordinator.prepareDeviceSession("late");
    const rejected = expect(request).rejects.toThrow("cancelled");
    coordinator.cancelDeviceSession("late");
    codeRequest.resolve(grant());
    await rejected;
    await expect(coordinator.completeDeviceSession("late", translate)).rejects.toThrow("no longer available");
    await expectNoCredentials();
  });

  it.each(["cancelled", "timed out"])("drops an exchange that resolves after the session has %s", async (reason) => {
    const exchangeStarted = deferred<void>();
    const heldExchange = deferred<Response>();
    fetchWithTimeout.mockResolvedValueOnce(grant(2)).mockResolvedValueOnce(approved()).mockImplementationOnce(() => {
      exchangeStarted.resolve();
      return heldExchange.promise;
    });
    const { deviceOAuthGrant } = await coordinator.prepareDeviceSession("exchange");
    const request = coordinator.completeDeviceSession("exchange", translate);
    const rejected = expect(request).rejects.toThrow(reason);
    await exchangeStarted.promise;
    const clock = reason === "timed out" ? vi.spyOn(Date, "now").mockReturnValue(deviceOAuthGrant.expiresAt) : undefined;
    if (!clock) {
      coordinator.cancelDeviceSession("exchange");
    }
    heldExchange.resolve(tokenResponse());
    try {
      await rejected;
      await expectNoCredentials();
    } finally {
      clock?.mockRestore();
    }
  });

  it("expires a session before any polling or credential write when the code lifetime ends", async () => {
    fetchWithTimeout.mockResolvedValueOnce(grant(1));
    await coordinator.prepareDeviceSession("expired");
    await expect(coordinator.completeDeviceSession("expired", translate)).rejects.toThrow("timed out");
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    await expectNoCredentials();
  });

  it("rechecks cancellation after the pre-save profile request and before persisting secrets", async () => {
    const profileStarted = deferred<void>();
    const heldProfile = deferred<undefined>();
    profile.mockImplementationOnce(() => { profileStarted.resolve(); return heldProfile.promise; });
    fetchWithTimeout.mockResolvedValueOnce(grant()).mockResolvedValueOnce(approved()).mockResolvedValueOnce(tokenResponse());
    await coordinator.prepareDeviceSession("pre-save");
    const request = coordinator.completeDeviceSession("pre-save", translate);
    const rejected = expect(request).rejects.toThrow("cancelled");
    await profileStarted.promise;
    expect(coordinator.cancelDeviceSession("pre-save")).toBe("cancelled");
    heldProfile.resolve(undefined);
    await rejected;
    await expectNoCredentials();
  });

  it("reports that cancellation is too late after the secret write starts and saves the account once", async () => {
    const writeStarted = deferred<void>();
    const resumeWrite = deferred<void>();
    const store = writeSecret.getMockImplementation()!;
    writeSecret.mockImplementationOnce(async (key: string, value: string) => {
      writeStarted.resolve();
      await resumeWrite.promise;
      await store(key, value);
    });
    fetchWithTimeout.mockResolvedValueOnce(grant()).mockResolvedValueOnce(approved()).mockResolvedValueOnce(tokenResponse());
    await coordinator.prepareDeviceSession("committing");
    const request = coordinator.completeDeviceSession("committing", translate);
    await writeStarted.promise;
    const cancellation = coordinator.cancelDeviceSession("committing");
    resumeWrite.resolve();

    await expect(request).resolves.toEqual({ email: "device@example.test" });
    expect(cancellation).toBe("committing");
    expect(coordinator.cancelDeviceSession("committing")).toBe("inactive");
    expect(writeSecret).toHaveBeenCalledTimes(1);
    expect(await repo.listAccounts()).toHaveLength(1);
  });

  it.each([
    () => new Response("Device limit reached.", { status: 403 }),
    () => Response.json({ error: { message: "Device limit reached" } }, { status: 403 }),
    () => Response.json({ error_description: "Device limit reached" }, { status: 403 })
  ])("stops after an explicit device-limit 403 without exchanging or writing credentials", async (denial) => {
    fetchWithTimeout.mockResolvedValueOnce(grant()).mockResolvedValueOnce(denial());
    await coordinator.prepareDeviceSession("denied");
    await expect(coordinator.completeDeviceSession("denied", translate)).rejects.toThrow("Device limit reached");
    expect(fetchWithTimeout.mock.calls.map(([url]) => url)).toEqual([DEVICE_USER_CODE_ENDPOINT, DEVICE_TOKEN_ENDPOINT]);
    await expectNoCredentials();
  });

  it("still validates and completes a manual PKCE callback after cancelling a device flow", async () => {
    const callbackSession = coordinator.prepareSession(translate)?.oauthSession!;
    const callback = new URL(callbackSession.redirectUri);
    callback.searchParams.set("code", "original-flow-code");
    callback.searchParams.set("state", "invalid");
    fetchWithTimeout.mockResolvedValueOnce(grant()).mockResolvedValueOnce(tokenResponse());
    await coordinator.prepareDeviceSession("device-fallback");
    coordinator.cancelDeviceSession("device-fallback");
    await expect(coordinator.completeSession(callbackSession.sessionId, callback.href, translate)).rejects.toMatchObject({
      message: "message.oauthCallbackFailed", cause: { message: "State mismatch in callback URL" }
    });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    callback.searchParams.set("state", new URL(callbackSession.authUrl).searchParams.get("state")!);

    await expect(coordinator.completeSession(callbackSession.sessionId, callback.href, translate)).resolves.toEqual({ email: "device@example.test" });
    const [url, init] = fetchWithTimeout.mock.calls.at(-1)!;
    expect(url).toBe(TOKEN_ENDPOINT);
    expect(new URLSearchParams(init.body).get("redirect_uri")).toBe(callbackSession.redirectUri);
    expect(writeSecret).toHaveBeenCalledTimes(1);
  });

  it("reports callback refusal only after verifying the OAuth state", () => {
    const session = prepareOAuthLoginSession();
    const callback = new URL(session.redirectUri);
    callback.searchParams.set("error", "access_denied");
    callback.searchParams.set("error_description", "Device limit reached.");
    expect(() => extractCodeFromCallbackUrl(callback.href, session.redirectUri, session.state)).toThrow("State mismatch");
    callback.searchParams.set("state", session.state);
    expect(() => extractCodeFromCallbackUrl(callback.href, session.redirectUri, session.state)).toThrow("Device limit reached");
  });

  it("does not write credentials after a callback is cancelled while preparing to save", async () => {
    const entered = deferred<void>();
    const resume = deferred<undefined>();
    profile.mockImplementationOnce(() => { entered.resolve(); return resume.promise; });
    const session = coordinator.prepareSession(translate)?.oauthSession!;
    const callback = new URL(session.redirectUri);
    callback.searchParams.set("state", new URL(session.authUrl).searchParams.get("state")!);
    callback.searchParams.set("code", "code");
    fetchWithTimeout.mockResolvedValueOnce(tokenResponse());
    const result = coordinator.completeSession(session.sessionId, callback.href, translate);
    await entered.promise;
    coordinator.cancelSession(session.sessionId);
    resume.resolve(undefined);
    await expect(result).resolves.toBeUndefined();
    await expectNoCredentials();
  });

  it("still exchanges an automatic OAuth callback received over local HTTP", async () => {
    const session = prepareOAuthLoginSession(0);
    const server = (await vi.importActual<typeof http>("http")).createServer();
    vi.mocked(http.createServer).mockReturnValueOnce(server);
    vi.mocked(vscode.env.openExternal).mockImplementationOnce(async () => {
      if (!server.listening) {
        await once(server, "listening");
      }
      const callback = new URL(session.redirectUri);
      callback.hostname = "127.0.0.1";
      callback.port = String((server.address() as AddressInfo).port);
      callback.searchParams.set("code", "automatic-flow-code");
      callback.searchParams.set("state", session.state);
      const response = await fetch(callback);
      await response.text();
      return response.ok;
    });
    fetchWithTimeout.mockResolvedValueOnce(tokenResponse());

    try {
      await expect(runPreparedOAuthLoginSession(session)).resolves.toMatchObject({ refreshToken: "refresh-fixture" });
      const [url, init] = fetchWithTimeout.mock.calls.at(-1)!;
      expect(url).toBe(TOKEN_ENDPOINT);
      expect(Object.fromEntries(new URLSearchParams(init.body))).toMatchObject({
        code: "automatic-flow-code", code_verifier: session.verifier, redirect_uri: session.redirectUri
      });
    } finally {
      server.close();
    }
  });
});
