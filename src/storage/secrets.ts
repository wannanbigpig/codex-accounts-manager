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
    options: { expectedTokens?: CodexTokens; afterSave?: () => Promise<void> } = {}
  ): Promise<boolean> {
    return withCredentialLock(this.lockDirectory, `write:${accountId}`, async (assertHeld) => {
      if ("expectedTokens" in options && !sameTokenSnapshot(await this.getTokens(accountId), options.expectedTokens)) {
        return false;
      }
      assertHeld();
      await this.secrets.store(`${SECRET_PREFIX}${accountId}`, JSON.stringify(tokens));
      await options.afterSave?.();
      return true;
    });
  }

  async deleteTokens(accountId: string): Promise<void> {
    await withCredentialLock(this.lockDirectory, `write:${accountId}`, async () => {
      await this.secrets.delete(`${SECRET_PREFIX}${accountId}`);
    });
  }
}
