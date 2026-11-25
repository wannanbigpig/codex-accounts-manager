import * as vscode from "vscode";
import { CodexTokens } from "../core/types";
import { sameTokenSnapshot, withCredentialLock } from "./credentialLocks";

const SECRET_PREFIX = "codex.account.";

export class SecretStore {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly lockDirectory: string
  ) {}

  async getTokens(accountId: string): Promise<CodexTokens | undefined> {
    const raw = await this.secrets.get(`${SECRET_PREFIX}${accountId}`);
    if (!raw) {
      return undefined;
    }
    return JSON.parse(raw) as CodexTokens;
  }

  async setTokens(
    accountId: string,
    tokens: CodexTokens,
    options: {
      expectedTokens?: CodexTokens;
      beforeSave?: () => Promise<boolean>;
      afterSave?: (previous: CodexTokens | undefined) => Promise<void>;
    } = {}
  ): Promise<boolean> {
    return this.withTokenWrite(accountId, async (previous, save) => {
      if ("expectedTokens" in options && !sameTokenSnapshot(previous, options.expectedTokens)) {
        return false;
      }
      if (options.beforeSave && !(await options.beforeSave())) {
        return false;
      }
      await save(tokens);
      await options.afterSave?.(previous);
      return true;
    });
  }

  async withTokenWrite<T>(
    accountId: string,
    operation: (previous: CodexTokens | undefined, save: (tokens: CodexTokens) => Promise<void>) => Promise<T>
  ): Promise<T> {
    return withCredentialLock(this.lockDirectory, `write:${accountId}`, async (assertHeld) => {
      const previous = await this.getTokens(accountId);
      return operation(previous, async (tokens) => {
        assertHeld();
        if (!sameTokenSnapshot(previous, tokens)) {
          await this.secrets.store(`${SECRET_PREFIX}${accountId}`, JSON.stringify(tokens));
        }
      });
    });
  }

  async deleteTokens(accountId: string, afterDelete: () => Promise<void>): Promise<void> {
    await withCredentialLock(this.lockDirectory, `write:${accountId}`, async () => {
      await this.secrets.delete(`${SECRET_PREFIX}${accountId}`);
      await afterDelete();
    });
  }
}
