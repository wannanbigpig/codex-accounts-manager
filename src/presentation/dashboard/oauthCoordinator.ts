import * as vscode from "vscode";
import {
  checkOAuthCancellation,
  completeOAuthLoginSession,
  prepareOAuthLoginSession,
  PreparedOAuthLoginSession,
  runPreparedOAuthLoginSession
} from "../../auth/oauth";
import { refreshImportedAccountQuota } from "../../application/accounts/quota";
import type { AccountsRepository } from "../../storage";
import type { DashboardDeviceOAuthCancellation, DashboardHostMessage } from "../../domain/dashboard/types";
import type { TranslationKey, TranslationParams } from "../../utils/i18n";
import { completeDeviceOAuthGrant, DEVICE_LOGIN_TIMEOUT_MS, requestDeviceOAuthGrant, type DeviceOAuthGrant } from "../../auth/deviceOAuth";
import { DEVICE_VERIFICATION_URL } from "../../infrastructure/config/apiEndpoints";
import { extractClaims } from "../../utils/jwt";
import { conflictsWithAccessTokenIdentity } from "../../utils/accountIdentity";

type DeviceFlow = {
  id: string;
  controller: AbortController;
  expiresAt: number;
  timer?: NodeJS.Timeout;
  grant?: DeviceOAuthGrant;
  polling?: boolean;
  committing?: boolean;
};

export class DashboardOAuthCoordinator {
  private readonly oauthSessions = new Map<string, PreparedOAuthLoginSession>();
  private readonly oauthCancellationSources = new Map<string, vscode.CancellationTokenSource>();
  private deviceFlow?: DeviceFlow;
  private completingCallback = false;

  constructor(
    private readonly repo: AccountsRepository,
    private readonly schedulePublishState: () => void
  ) {}

  dispose(): void {
    this.cancelDeviceSession(this.deviceFlow?.id);
    this.oauthCancellationSources.forEach((source) => {
      source.cancel();
      source.dispose();
    });
    this.oauthCancellationSources.clear();
    this.oauthSessions.clear();
  }

  async prepareDeviceSession(id: string | undefined): Promise<{ deviceOAuthGrant: { userCode: string; verificationUrl: string; expiresAt: number } }> {
    if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || this.deviceFlow || this.oauthCancellationSources.size || this.completingCallback) {
      throw new Error("Another authorization is already running or the device session ID is invalid");
    }
    const flow: DeviceFlow = { id, controller: new AbortController(), expiresAt: Date.now() + DEVICE_LOGIN_TIMEOUT_MS };
    this.deviceFlow = flow;
    this.armDeviceDeadline(flow);
    try {
      const grant = await requestDeviceOAuthGrant(flow.controller.signal);
      this.checkDeviceFlow(flow);
      const expiresAt = Math.min(flow.expiresAt, grant.expiresAt);
      flow.expiresAt = expiresAt;
      flow.grant = { ...grant, expiresAt };
      this.armDeviceDeadline(flow);
      return { deviceOAuthGrant: { userCode: grant.userCode, verificationUrl: DEVICE_VERIFICATION_URL, expiresAt } };
    } catch (error) {
      this.finishDeviceFlow(flow);
      throw flow.controller.signal.reason ?? error;
    }
  }

  async completeDeviceSession(
    id: string | undefined,
    translate: (key: TranslationKey, values?: TranslationParams) => string
  ): Promise<{ email: string }> {
    const flow = this.deviceFlow;
    if (!flow || flow.id !== id || !flow.grant || flow.polling) {
      throw new Error("Device authorization session is no longer available");
    }
    flow.polling = true;
    try {
      this.checkDeviceFlow(flow);
      const tokens = await completeDeviceOAuthGrant(flow.grant, flow.controller.signal);
      this.checkDeviceFlow(flow);
      if (conflictsWithAccessTokenIdentity(extractClaims(tokens.idToken, tokens.accessToken), tokens.accessToken)) {
        throw new Error("Authorized tokens disagree on the Codex user or workspace");
      }
      const account = await this.repo.upsertFromTokens(tokens, false, () => {
        this.checkDeviceFlow(flow);
        // Once persistence starts, the authorization has completed and cannot be cancelled.
        flow.committing = true;
        clearTimeout(flow.timer);
      });
      this.schedulePublishState();
      void vscode.window.showInformationMessage(translate("message.oauthCompleted", { email: account.email }));
      void refreshImportedAccountQuota(this.repo, account.id).catch(() => undefined).finally(this.schedulePublishState);
      return { email: account.email };
    } catch (error) {
      throw flow.controller.signal.reason ?? error;
    } finally {
      this.finishDeviceFlow(flow);
    }
  }

  cancelDeviceSession(id: string | undefined): DashboardDeviceOAuthCancellation {
    const flow = this.deviceFlow;
    if (!flow || flow.id !== id) {
      return "inactive";
    }
    if (flow.committing) {
      return "committing";
    }
    flow.controller.abort(new Error("Device authorization cancelled"));
    this.finishDeviceFlow(flow);
    return "cancelled";
  }

  private armDeviceDeadline(flow: DeviceFlow): void {
    clearTimeout(flow.timer);
    flow.timer = setTimeout(() => {
      flow.controller.abort(new Error("Device authorization timed out"));
      this.finishDeviceFlow(flow);
    }, Math.max(0, flow.expiresAt - Date.now()));
    flow.timer.unref();
  }

  private checkDeviceFlow(flow: DeviceFlow): void {
    flow.controller.signal.throwIfAborted();
    if (Date.now() >= flow.expiresAt) {
      throw new Error("Device authorization timed out");
    }
    if (this.deviceFlow !== flow) {
      throw new Error("Device authorization session is no longer available");
    }
  }

  private finishDeviceFlow(flow: DeviceFlow): void {
    clearTimeout(flow.timer);
    if (this.deviceFlow === flow) {
      this.deviceFlow = undefined;
    }
  }

  prepareSession(
    translate: (key: TranslationKey, values?: TranslationParams) => string
  ): Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"] {
    try {
      const prepared = prepareOAuthLoginSession();
      const sessionId = `oauth-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      this.oauthSessions.set(sessionId, prepared);
      return {
        oauthSession: {
          sessionId,
          authUrl: prepared.authUrl,
          redirectUri: prepared.redirectUri
        }
      };
    } catch (error) {
      const message = translate("message.oauthPrepareFailed", {
        message: error instanceof Error ? error.message : String(error)
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message, { cause: error });
    }
  }

  cancelSession(oauthSessionId: string | undefined): void {
    if (!oauthSessionId) {
      return;
    }

    const source = this.oauthCancellationSources.get(oauthSessionId);
    if (source) {
      source.cancel();
      source.dispose();
      this.oauthCancellationSources.delete(oauthSessionId);
    }
    this.oauthSessions.delete(oauthSessionId);
  }

  async startAutoFlow(
    oauthSessionId: string | undefined,
    translate: (key: TranslationKey, values?: TranslationParams) => string
  ): Promise<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"] | undefined> {
    if (this.deviceFlow || this.completingCallback) {
      throw new Error("Another authorization is already running");
    }
    if (!oauthSessionId) {
      const message = translate("message.oauthPrepareFailed", {
        message: "Missing OAuth session"
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    const session = this.oauthSessions.get(oauthSessionId);
    if (!session) {
      const message = translate("message.oauthPrepareFailed", {
        message: "OAuth session expired"
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    if (this.oauthCancellationSources.has(oauthSessionId)) {
      throw new Error("Another authorization is already running");
    }
    const source = new vscode.CancellationTokenSource();
    this.oauthCancellationSources.set(oauthSessionId, source);
    try {
      const tokens = await runPreparedOAuthLoginSession(session, source.token);
      const created = await this.repo.upsertFromTokens(tokens, false, () => checkOAuthCancellation(source.token));
      await refreshImportedAccountQuota(this.repo, created.id);
      this.cancelSession(oauthSessionId);
      this.schedulePublishState();
      void vscode.window.showInformationMessage(
        translate("message.oauthCompleted", {
          email: created.email
        })
      );
      return {
        email: created.email
      };
    } catch (error) {
      const cancelled = error instanceof Error && error.message === "OAuth login cancelled by user.";
      this.oauthCancellationSources.get(oauthSessionId)?.dispose();
      this.oauthCancellationSources.delete(oauthSessionId);
      if (cancelled) {
        this.oauthSessions.delete(oauthSessionId);
        return undefined;
      }
      const message = translate("message.oauthCallbackFailed", {
        message: error instanceof Error ? error.message : String(error)
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message, { cause: error });
    }
  }

  async completeSession(
    oauthSessionId: string | undefined,
    callbackUrl: string | undefined,
    translate: (key: TranslationKey, values?: TranslationParams) => string
  ): Promise<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"]> {
    if (this.deviceFlow || this.completingCallback) {
      throw new Error("Another authorization is already running");
    }
    if (!oauthSessionId || !callbackUrl?.trim()) {
      const message = translate("message.oauthCallbackFailed", {
        message: "Missing OAuth session or callback URL"
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    const session = this.oauthSessions.get(oauthSessionId);
    if (!session) {
      const message = translate("message.oauthPrepareFailed", {
        message: "OAuth session expired"
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    this.completingCallback = true;
    const listening = this.oauthCancellationSources.get(oauthSessionId);
    const source = listening ?? new vscode.CancellationTokenSource();
    this.oauthCancellationSources.set(oauthSessionId, source);
    try {
      const tokens = await completeOAuthLoginSession(session, callbackUrl.trim(), source.token);
      const created = await this.repo.upsertFromTokens(tokens, false, () => checkOAuthCancellation(source.token));
      await refreshImportedAccountQuota(this.repo, created.id);
      this.cancelSession(oauthSessionId);
      this.schedulePublishState();
      void vscode.window.showInformationMessage(
        translate("message.oauthCompleted", {
          email: created.email
        })
      );
      return {
        email: created.email
      };
    } catch (error) {
      if (source.token.isCancellationRequested) {
        return undefined;
      }
      const message = translate("message.oauthCallbackFailed", {
        message: error instanceof Error ? error.message : String(error)
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message, { cause: error });
    } finally {
      if (!listening && this.oauthCancellationSources.get(oauthSessionId) === source) {
        source.dispose();
        this.oauthCancellationSources.delete(oauthSessionId);
      }
      this.completingCallback = false;
    }
  }
}
