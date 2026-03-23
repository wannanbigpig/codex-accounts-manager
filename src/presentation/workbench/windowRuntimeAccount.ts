let currentWindowRuntimeAccountId: string | undefined;

export function getCurrentWindowRuntimeAccountId(): string | undefined {
  return currentWindowRuntimeAccountId;
}

export function setCurrentWindowRuntimeAccountId(accountId?: string): void {
  currentWindowRuntimeAccountId = accountId;
}

export function needsWindowReloadForAccount(accountId?: string): boolean {
  return Boolean(accountId) && currentWindowRuntimeAccountId !== accountId;
}
