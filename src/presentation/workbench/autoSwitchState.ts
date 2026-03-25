import * as vscode from "vscode";
import { CodexAutoSwitchReason } from "../../core/types";

type AutoSwitchRuntimeState = {
  lockedAccountId?: string;
  lockedUntil?: number;
  lastReason?: CodexAutoSwitchReason;
};

const GLOBAL_STATE_KEY = "codexAccounts.autoSwitchRuntimeState";

const state: AutoSwitchRuntimeState = {};
let extensionContext: vscode.ExtensionContext | undefined;

export function initAutoSwitchRuntimeState(context: vscode.ExtensionContext): void {
  extensionContext = context;
  const saved = context.globalState.get<AutoSwitchRuntimeState>(GLOBAL_STATE_KEY);
  if (!saved) {
    pruneExpiredLock();
    return;
  }

  state.lockedAccountId = saved.lockedAccountId;
  state.lockedUntil = saved.lockedUntil;
  state.lastReason = saved.lastReason;
  pruneExpiredLock();
}

export function getAutoSwitchRuntimeSnapshot(): AutoSwitchRuntimeState {
  pruneExpiredLock();
  return {
    lockedAccountId: state.lockedAccountId,
    lockedUntil: state.lockedUntil,
    lastReason: state.lastReason ? { ...state.lastReason, matchedRules: [...state.lastReason.matchedRules] } : undefined
  };
}

export function setAutoSwitchLock(accountId: string | undefined, minutes: number): void {
  if (!accountId || !Number.isFinite(minutes) || minutes <= 0) {
    state.lockedAccountId = undefined;
    state.lockedUntil = undefined;
    persist();
    return;
  }

  state.lockedAccountId = accountId;
  state.lockedUntil = Date.now() + minutes * 60_000;
  persist();
}

export function clearAutoSwitchLock(accountId?: string): void {
  if (accountId && state.lockedAccountId && state.lockedAccountId !== accountId) {
    return;
  }
  state.lockedAccountId = undefined;
  state.lockedUntil = undefined;
  persist();
}

export function isAutoSwitchLocked(accountId: string | undefined): boolean {
  pruneExpiredLock();
  return Boolean(accountId && state.lockedAccountId === accountId && state.lockedUntil && state.lockedUntil > Date.now());
}

export function recordAutoSwitchReason(reason: CodexAutoSwitchReason): void {
  state.lastReason = {
    ...reason,
    matchedRules: [...reason.matchedRules]
  };
  persist();
}

function pruneExpiredLock(): void {
  if (!state.lockedUntil || state.lockedUntil > Date.now()) {
    return;
  }

  state.lockedAccountId = undefined;
  state.lockedUntil = undefined;
  persist();
}

function persist(): void {
  void extensionContext?.globalState.update(GLOBAL_STATE_KEY, {
    lockedAccountId: state.lockedAccountId,
    lockedUntil: state.lockedUntil,
    lastReason: state.lastReason
  });
}
