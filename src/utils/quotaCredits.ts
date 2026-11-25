import type { CodexCreditsSummary } from "../core/types";

/** Normalize both freshly fetched and previously saved usage responses. */
export function readUsageCredits(usage: unknown, workspace: boolean): CodexCreditsSummary | undefined {
  const raw = readRecord(usage);
  const credits = readRecord(raw?.["credits"]);
  const spend = readRecord(raw?.["spend_control"]);
  const individual = readRecord(spend?.["individual_limit"]);
  const ambient = readRecord(raw?.["ambient_usage"]);
  const defaultUsage = readRecord(ambient?.["default"]);
  const source = readRecord(defaultUsage?.["source"])?.["kind"];

  const total = readNonNegative(individual?.["limit"]);
  const used = readNonNegative(individual?.["used"]);
  const individualRemaining = readNonNegative(individual?.["remaining"]) ??
    (total !== undefined && used !== undefined ? Math.max(0, total - used) : undefined);
  const sharedRemaining = readNonNegative(credits?.["remaining"]) ?? readNonNegative(credits?.["balance"]);
  const remaining = individualRemaining ?? readNonNegative(credits?.["remaining"]);
  const remainingPercent = readNonNegative(individual?.["remaining_percent"]) ??
    (total !== undefined && total > 0 && individualRemaining !== undefined ? (individualRemaining / total) * 100 : undefined);
  const hasCredits = readFlag(credits?.["has_credits"] ?? credits?.["hasCredits"]);
  const unlimited = readFlag(individual?.["unlimited"]) === true || readFlag(credits?.["unlimited"]) === true;
  const reached = readFlag(credits?.["overage_limit_reached"] ?? credits?.["overageLimitReached"]) === true ||
    (workspace && (readFlag(spend?.["reached"]) === true || readFlag(individual?.["reached"]) === true));
  const ambientCredits = workspace && source === "credits" && hasCredits === undefined;
  const measuredRemaining = individualRemaining ?? sharedRemaining;
  if (measuredRemaining === undefined && remainingPercent === undefined && total === undefined && used === undefined &&
    hasCredits === undefined && !unlimited && !reached && !ambientCredits) {
    return undefined;
  }

  let availability: NonNullable<CodexCreditsSummary["availability"]> = "unknown";
  if (reached) {
    availability = "limited";
  } else if (unlimited || (measuredRemaining ?? remainingPercent ?? 0) > 0) {
    availability = "available";
  } else if ((measuredRemaining ?? remainingPercent) === 0 || hasCredits === false) {
    availability = "exhausted";
  } else if (hasCredits || ambientCredits) {
    availability = "available";
  }

  const resetAt = readNonNegative(individual?.["reset_at"]);
  const resetAfter = readNonNegative(individual?.["reset_after_seconds"]);
  const resetTime = resetAt !== undefined
    ? Math.floor(resetAt > 1_000_000_000_000 ? resetAt / 1000 : resetAt)
    : resetAfter === undefined ? undefined : Math.floor(Date.now() / 1000 + resetAfter);
  const localMessages = credits?.["approx_local_messages"] ?? credits?.["approxLocalMessages"];
  const cloudMessages = credits?.["approx_cloud_messages"] ?? credits?.["approxCloudMessages"];
  return {
    availability,
    hasCredits: availability === "available",
    unlimited,
    overageLimitReached: reached,
    balance: measuredRemaining === undefined ? "" : String(measuredRemaining),
    approxLocalMessages: Array.isArray(localMessages) ? localMessages : [],
    approxCloudMessages: Array.isArray(cloudMessages) ? cloudMessages : [],
    total,
    used,
    remaining,
    remainingPercent: remainingPercent === undefined ? undefined : Math.round(Math.min(100, remainingPercent)),
    resetTime
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readNonNegative(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function readFlag(value: unknown): boolean | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (normalized === true || normalized === 1 || normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === false || normalized === 0 || normalized === "false" || normalized === "0") {
    return false;
  }
  return undefined;
}
