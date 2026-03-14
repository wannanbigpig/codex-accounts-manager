import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { CodexAuthFile, CodexTokens } from "../types";

export function getCodexHome(): string {
  const envHome = process.env.CODEX_HOME?.trim();
  if (envHome) {
    return envHome.replace(/^['"]|['"]$/g, "");
  }
  return path.join(os.homedir(), ".codex");
}

export function getAuthJsonPath(): string {
  return path.join(getCodexHome(), "auth.json");
}

export async function readAuthFile(): Promise<CodexAuthFile | undefined> {
  try {
    const raw = await fs.readFile(getAuthJsonPath(), "utf8");
    return JSON.parse(raw) as CodexAuthFile;
  } catch {
    return undefined;
  }
}

export async function writeAuthFile(tokens: CodexTokens): Promise<void> {
  const authFile: CodexAuthFile = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: tokens.accountId
    },
    last_refresh: new Date().toISOString()
  };

  await fs.mkdir(getCodexHome(), { recursive: true });
  await fs.writeFile(getAuthJsonPath(), JSON.stringify(authFile, null, 2), "utf8");
}
