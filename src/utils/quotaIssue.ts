import type { CodexQuotaErrorInfo } from "../core/types";

export type QuotaIssueKind = "disabled" | "auth" | "quota";

export function getQuotaIssueKind(error?: CodexQuotaErrorInfo): QuotaIssueKind | undefined {
  if (!error) {
    return undefined;
  }

  const message = (error.message ?? "").toLowerCase();
  const code = String(error.code ?? "").toLowerCase();

  if (
    code === "deactivated_workspace" ||
    message.includes("deactivated_workspace") ||
    message.includes("api returned 402")
  ) {
    return "disabled";
  }

  if (
    code === "unauthorized" ||
    code.startsWith("auth_") ||
    message.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("token expired") ||
    message.includes("token invalid") ||
    message.includes("token missing") ||
    message.includes("refresh token") ||
    message.includes("oauth") ||
    message.includes("authorization") ||
    message.includes("invalid_grant")
  ) {
    return "auth";
  }

  return "quota";
}
