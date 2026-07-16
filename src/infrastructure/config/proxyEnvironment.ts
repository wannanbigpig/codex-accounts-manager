import * as fs from "fs/promises";
import * as path from "path";
import { Dispatcher, EnvHttpProxyAgent } from "undici";
import { getCodexHome } from "../../codex/authFile";

const PROXY_ENV_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"] as const;
let proxyDispatcher: Dispatcher | undefined;

export interface ProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

/**
 * Loads proxy settings from the current process and <CODEX_HOME>/.env, then
 * prepares a request-local proxy dispatcher for this extension.
 *
 * Existing process environment variables take precedence, matching dotenv's
 * default non-overriding behavior.
 */
export async function initializeCodexProxyEnvironment(): Promise<boolean> {
  const fileEnvironment = await readProxyEnvironmentFile(path.join(getCodexHome(), ".env"));
  const settings = resolveProxySettings(process.env, fileEnvironment);
  if (!settings.httpProxy && !settings.httpsProxy) {
    return false;
  }

  try {
    proxyDispatcher = new EnvHttpProxyAgent(settings);
    return true;
  } catch {
    console.warn("[codexAccounts] ignored invalid proxy settings from the process environment or Codex .env");
    return false;
  }
}

export function getCodexProxyDispatcher(): Dispatcher | undefined {
  return proxyDispatcher;
}

export function disposeCodexProxyEnvironment(): void {
  const dispatcher = proxyDispatcher;
  proxyDispatcher = undefined;
  if (dispatcher) {
    void dispatcher.close().catch(() => undefined);
  }
}

export async function readProxyEnvironmentFile(filePath: string): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (isFileNotFound(error)) {
      return {};
    }
    console.warn("[codexAccounts] unable to read proxy settings from .env:", formatError(error));
    return {};
  }
}

export function resolveProxySettings(
  processEnvironment: NodeJS.ProcessEnv,
  fileEnvironment: Readonly<Record<string, string>>
): ProxySettings {
  const getValue = (key: (typeof PROXY_ENV_KEYS)[number]): string | undefined =>
    readEnvironmentValue(processEnvironment, key) ?? readEnvironmentValue(fileEnvironment, key);

  const allProxy = getValue("ALL_PROXY");
  return {
    httpProxy: getValue("HTTP_PROXY") ?? allProxy,
    httpsProxy: getValue("HTTPS_PROXY") ?? allProxy,
    noProxy: getValue("NO_PROXY")
  };
}

/** Parses the dotenv syntax needed by proxy variables without loading secrets. */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?$/);
    if (!match) {
      continue;
    }

    const key = match[1]!;
    if (!isProxyEnvironmentKey(key)) {
      continue;
    }

    result[key] = parseEnvironmentValue(match[2] ?? "");
  }

  return result;
}

function parseEnvironmentValue(rawValue: string): string {
  const value = rawValue.trim();
  if (value.startsWith('"')) {
    const closingQuote = findClosingQuote(value, '"');
    const quoted = closingQuote >= 1 ? value.slice(1, closingQuote) : value.slice(1);
    return quoted.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"');
  }
  if (value.startsWith("'")) {
    const closingQuote = findClosingQuote(value, "'");
    return closingQuote >= 1 ? value.slice(1, closingQuote) : value.slice(1);
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function findClosingQuote(value: string, quote: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === quote && value[index - 1] !== "\\") {
      return index;
    }
  }
  return -1;
}

function isProxyEnvironmentKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return PROXY_ENV_KEYS.some((candidate) => candidate === normalized);
}

function readEnvironmentValue(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string>>,
  key: string
): string | undefined {
  return normalizeValue(environment[key.toLowerCase()]) ?? normalizeValue(environment[key]);
}

function normalizeValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
