/**
 * Codex 认证文件操作模块
 *
 * 优化内容:
 * - OAuth 账号不再写入 auth_mode（对齐 cockpit-tools，避免 codex 新版拒绝 "chatgpt"）
 * - 原子写入 auth.json（临时文件 + rename），避免中断/磁盘满损坏
 * - macOS 下同步 Codex Keychain（service="Codex Auth"），避免 codex 扩展读旧凭证
 */

import * as crypto from "crypto";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { CodexAuthFile, CodexTokens } from "../core/types";

/** macOS 下 Codex 读取凭证的 Keychain service */
const CODEX_KEYCHAIN_SERVICE = "Codex Auth";

/**
 * 获取 Codex 主目录
 *
 * @returns CODEX_HOME 路径
 */
export function getCodexHome(): string {
  const envHome = process.env["CODEX_HOME"]?.trim();
  if (envHome) {
    return envHome.replace(/^['"]|['"]$/g, "");
  }
  return path.join(os.homedir(), ".codex");
}

/**
 * 获取 auth.json 文件路径
 */
export function getAuthJsonPath(): string {
  return path.join(getCodexHome(), "auth.json");
}

/**
 * 读取 auth.json 文件
 *
 * @returns 认证文件内容，如果不存在则返回 undefined
 */
export async function readAuthFile(): Promise<CodexAuthFile | undefined> {
  try {
    const raw = await fs.readFile(getAuthJsonPath(), "utf8");
    return JSON.parse(raw) as CodexAuthFile;
  } catch (error) {
    // 文件不存在是正常情况（首次启动或未登录）
    if (isFileNotFound(error)) {
      return undefined;
    }
    // 文件损坏 / 权限错误 / JSON 解析错误 → 打日志方便排查
    console.warn("[codexAccounts] unable to read auth.json:", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * 写入 auth.json 文件
 *
 * OAuth 账号不写 auth_mode 字段（由 codex 根据 token 推断），仅写 tokens/last_refresh。
 * 写入采用原子替换，并在 macOS 下同步 Keychain。
 *
 * @param tokens - 认证令牌
 */
export async function writeAuthFile(tokens: CodexTokens): Promise<void> {
  const authFile = buildAuthFile(tokens);
  const content = JSON.stringify(authFile, null, 2);

  await writeAuthJsonAtomic(getAuthJsonPath(), content);
  await syncCodexKeychain(content);
}

/**
 * 构建 auth.json 内容。OAuth 账号不写 auth_mode。
 */
function buildAuthFile(tokens: CodexTokens): CodexAuthFile {
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: tokens.accountId
    },
    last_refresh: new Date().toISOString()
  };
}

/**
 * 原子写入文件：先写临时文件，再 rename 替换，避免半写入。
 */
async function writeAuthJsonAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`);
  await fs.writeFile(tmpPath, content, "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * macOS 下同步 Codex Keychain。
 *
 * codex 在 macOS 优先从 Keychain（service="Codex Auth"，account="cli|<sha256(codex_home)[:16]>"）
 * 读取凭证。仅写 auth.json 会导致 codex 扩展仍使用旧账号凭证，表现为登出/账号串台。
 * 失败仅记录，不阻断主流程。
 */
async function syncCodexKeychain(authJsonContent: string): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    const account = await buildCodexKeychainAccount();
    await new Promise<void>((resolve, reject) => {
      execFile(
        "security",
        ["add-generic-password", "-U", "-s", CODEX_KEYCHAIN_SERVICE, "-a", account, "-w", authJsonContent],
        (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
  } catch {
    // Keychain 同步为 best-effort，失败不阻断 auth.json 写入。
  }
}

/**
 * 计算 Codex Keychain account 标识：cli|<sha256(canonicalize(codex_home))[:16]>。
 * 与 cockpit-tools / codex 官方读取逻辑保持一致。
 */
async function buildCodexKeychainAccount(): Promise<string> {
  const home = getCodexHome();
  let resolved = home;
  try {
    resolved = await fs.realpath(home);
  } catch {
    resolved = home;
  }
  const digest = crypto.createHash("sha256").update(resolved).digest("hex");
  return `cli|${digest.slice(0, 16)}`;
}
