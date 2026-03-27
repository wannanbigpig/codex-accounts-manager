const WORKSPACE_RETRY_STATUSES = [400, 401, 402, 403, 404, 409];

export function shouldRetryWithoutWorkspace(status: number, raw: string): boolean {
  if (!WORKSPACE_RETRY_STATUSES.includes(status)) {
    return false;
  }

  const normalized = raw.toLowerCase();
  return (
    normalized.includes("workspace") ||
    normalized.includes("account") ||
    normalized.includes("deactivated_workspace") ||
    normalized.includes("no active workspace")
  );
}
