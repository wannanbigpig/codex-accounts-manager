import * as fs from "fs/promises";
import * as path from "path";
import { Dispatcher, EnvHttpProxyAgent } from "undici";
import { getCodexHome } from "../../codex/authFile";

const PROXY_ENV_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"] as const;
let proxyDispatcher: Dispatcher | undefined;
let proxyConfigurationError: CodexProxyConfigurationError | undefined;

export interface ProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

interface EnvironmentEntry {
  present: boolean;
  value?: string;
}

export class CodexProxyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexProxyConfigurationError";
  }
}

/**
 * Loads proxy settings from the current process and <CODEX_HOME>/.env, then
 * prepares a request-local proxy dispatcher for this extension.
 *
 * Existing process environment variables take precedence, matching dotenv's
 * default non-overriding behavior.
 */
export async function initializeCodexProxyEnvironment(): Promise<boolean> {
  try {
    const fileEnvironment = await readProxyEnvironmentFile(path.join(getCodexHome(), ".env"));
    return configureCodexProxyEnvironment(resolveProxySettings(process.env, fileEnvironment));
  } catch (error) {
    return rejectProxyConfiguration(error);
  }
}

export function configureCodexProxyEnvironment(settings: ProxySettings): boolean {
  disposeCodexProxyEnvironment();
  if (!settings.httpProxy && !settings.httpsProxy) {
    return false;
  }

  try {
    validateProxySettings(settings);
    proxyDispatcher = new EnvHttpProxyAgent(settings);
    return true;
  } catch (error) {
    return rejectProxyConfiguration(error);
  }
}

export function getCodexProxyDispatcher(): Dispatcher | undefined {
  if (proxyConfigurationError) {
    throw new CodexProxyConfigurationError(proxyConfigurationError.message);
  }
  return proxyDispatcher;
}

export function getCodexProxyConfigurationError(): CodexProxyConfigurationError | undefined {
  return proxyConfigurationError;
}

export function disposeCodexProxyEnvironment(): void {
  const dispatcher = proxyDispatcher;
  proxyDispatcher = undefined;
  proxyConfigurationError = undefined;
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
    throw new CodexProxyConfigurationError(
      "Unable to read the Codex proxy environment file. Check the CODEX_HOME/.env permissions."
    );
  }
}

export function resolveProxySettings(
  processEnvironment: NodeJS.ProcessEnv,
  fileEnvironment: Readonly<Record<string, string>>
): ProxySettings {
  const getEntry = (key: (typeof PROXY_ENV_KEYS)[number]): EnvironmentEntry => {
    const processEntry = readEnvironmentEntry(processEnvironment, key);
    return processEntry.present ? processEntry : readEnvironmentEntry(fileEnvironment, key);
  };

  const allProxy = getEntry("ALL_PROXY");
  const httpProxy = getEntry("HTTP_PROXY");
  const httpsProxy = getEntry("HTTPS_PROXY");

  return {
    httpProxy: httpProxy.value ?? allProxy.value,
    httpsProxy: httpsProxy.value ?? allProxy.value,
    noProxy: getEntry("NO_PROXY").value
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

function readEnvironmentEntry(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string>>,
  key: string
): EnvironmentEntry {
  for (const candidate of [key.toLowerCase(), key]) {
    if (Object.prototype.hasOwnProperty.call(environment, candidate)) {
      return { present: true, value: normalizeValue(environment[candidate]) };
    }
  }
  return { present: false };
}

function normalizeValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function validateProxySettings(settings: ProxySettings): void {
  validateProxyUrl("HTTP proxy", settings.httpProxy);
  validateProxyUrl("HTTPS proxy", settings.httpsProxy);
}

function validateProxyUrl(label: string, value: string | undefined): void {
  if (!value) {
    return;
  }

  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new CodexProxyConfigurationError(`${label} must be an absolute http:// or https:// URL.`);
  }

  if (protocol !== "http:" && protocol !== "https:") {
    throw new CodexProxyConfigurationError(
      `${label} uses the unsupported ${protocol || "unknown"} protocol. Only http:// and https:// proxy URLs are supported.`
    );
  }
}

function rejectProxyConfiguration(error: unknown): false {
  disposeCodexProxyEnvironment();
  proxyConfigurationError =
    error instanceof CodexProxyConfigurationError
      ? error
      : new CodexProxyConfigurationError(
          "Unable to initialize the Codex proxy. Check HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, and NO_PROXY."
        );
  console.error(`[codexAccounts] ${proxyConfigurationError.message}`);
  return false;
}
