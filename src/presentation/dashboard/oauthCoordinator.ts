import * as vscode from "vscode";
import {
  completeOAuthLoginSession,
  prepareOAuthLoginSession,
  PreparedOAuthLoginSession,
  runPreparedOAuthLoginSession
} from "../../auth/oauth";
import { refreshImportedAccountQuota } from "../../application/accounts/quota";
import type { AccountsRepository } from "../../storage";
import type { DashboardHostMessage } from "../../domain/dashboard/types";
import type { TranslationKey, TranslationParams } from "../../utils/i18n";

export class DashboardOAuthCoordinator {
  private readonly oauthSessions = new Map<string, PreparedOAuthLoginSession>();
  private readonly oauthCancellationSources = new Map<string, vscode.CancellationTokenSource>();

  constructor(
    private readonly repo: AccountsRepository,
    private readonly schedulePublishState: () => void
  ) {}

  dispose(): void {
    this.oauthCancellationSources.forEach((source) => {
      source.cancel();
      source.dispose();
    });
    this.oauthCancellationSources.clear();
    this.oauthSessions.clear();
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
      throw new Error(message);
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

    try {
      const source = new vscode.CancellationTokenSource();
      this.oauthCancellationSources.set(oauthSessionId, source);
      const tokens = await runPreparedOAuthLoginSession(session, source.token);
      const created = await this.repo.upsertFromTokens(tokens, false);
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
      throw new Error(message);
    }
  }

  async completeSession(
    oauthSessionId: string | undefined,
    callbackUrl: string | undefined,
    translate: (key: TranslationKey, values?: TranslationParams) => string
  ): Promise<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"]> {
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

    try {
      const tokens = await completeOAuthLoginSession(session, callbackUrl.trim());
      const created = await this.repo.upsertFromTokens(tokens, false);
      this.oauthCancellationSources.get(oauthSessionId)?.dispose();
      this.oauthCancellationSources.delete(oauthSessionId);
      this.oauthSessions.delete(oauthSessionId);
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
      const message = translate("message.oauthCallbackFailed", {
        message: error instanceof Error ? error.message : String(error)
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }
  }
}
