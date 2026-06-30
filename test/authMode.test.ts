import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAuthFile } from "../src/codex/authFile";
import type { CodexAccountRecord, CodexTokens } from "../src/core/types";
import { toSharedAccountJson } from "../src/storage/sharedAccounts";

function createTokens(): CodexTokens {
  return {
    idToken: "id-token",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accountId: "account-id"
  };
}

describe("Codex auth mode compatibility", () => {
  let tempCodexHome: string;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    tempCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-mode-test-"));
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempCodexHome;
  });

  afterEach(async () => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    await fs.rm(tempCodexHome, { recursive: true, force: true });
  });

  it("writes ChatGPT auth mode to auth.json", async () => {
    await writeAuthFile(createTokens());

    const authFile = JSON.parse(await fs.readFile(path.join(tempCodexHome, "auth.json"), "utf8"));

    expect(authFile.auth_mode).toBe("chatgpt");
  });

  it("exports shared accounts with ChatGPT auth mode", () => {
    const account: CodexAccountRecord = {
      id: "account",
      email: "dev@example.com",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000
    };

    const shared = toSharedAccountJson(account, createTokens());

    expect(shared.auth_mode).toBe("chatgpt");
  });
});
