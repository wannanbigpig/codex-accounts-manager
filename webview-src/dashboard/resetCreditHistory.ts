import type { CodexResetCreditHistoryEvent, CodexResetCreditLocalRecord, CodexResetCreditsSnapshot } from "../../src/core/types";
import type { DashboardAccountViewModel, DashboardClientMessage, DashboardHostMessage } from "../../src/domain/dashboard/types";
import { isAvailableResetCredit } from "../../src/domain/resetCredits";
import { createActionRequestId, getActionTimeoutMs } from "./host";

type HistoryActionResult = Extract<DashboardHostMessage, { type: "dashboard:action-result" }>;
type PageRequest = { cursor?: string; refresh?: boolean };
type ResetCreditScope = { accountId: string; scope: string };
type Cached<T> = { value: T; expiresAt: number };
type ResetCreditCache = {
  inventory?: Cached<CodexResetCreditsSnapshot>;
  history?: Cached<Pick<ResetCreditHistoryState, "events" | "nextCursor"> & { loadedCursors: string[] }>;
  local?: Cached<CodexResetCreditLocalRecord[]>;
};
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
export type ResetCreditTab = "available" | "history";

export interface ResetCreditHistoryState extends ResetCreditScope {
  tab: ResetCreditTab;
  inventory?: CodexResetCreditsSnapshot;
  inventoryLoading?: boolean;
  inventoryFailed?: boolean;
  redeemingCreditId?: string;
  events: CodexResetCreditHistoryEvent[];
  nextCursor?: string;
  loading: boolean;
  failed: boolean;
  local?: CodexResetCreditLocalRecord[];
  localFailed?: boolean;
}

export function resetCreditHistoryScope(account: Pick<DashboardAccountViewModel, "accountId" | "organizationId" | "userId"> & Partial<Pick<DashboardAccountViewModel, "isTeamWorkspace">>): string {
  return JSON.stringify([account.accountId, account.organizationId, account.userId, account.isTeamWorkspace]);
}

function cacheKey({ accountId, scope }: ResetCreditScope): string {
  return JSON.stringify([accountId, scope]);
}

function readFresh<T>(cached: Cached<T> | undefined): T | undefined {
  return cached && cached.expiresAt > Date.now() ? cached.value : undefined;
}

function cacheInventory(value: CodexResetCreditsSnapshot): Cached<CodexResetCreditsSnapshot> {
  const now = Date.now();
  let expiresAt = now + CACHE_TTL_MS;
  const nextExpiry = (value.nextExpiresAt ?? 0) * 1000;
  if (nextExpiry > now) {
    expiresAt = Math.min(expiresAt, nextExpiry);
  }
  for (const credit of value.credits) {
    if (credit.expires_at !== undefined && isAvailableResetCredit(credit, now)) {
      expiresAt = Math.min(expiresAt, credit.expires_at * 1000);
    }
  }
  return { value, expiresAt };
}

export function createResetCreditHistoryController(
  postMessage: (message: DashboardClientMessage) => void,
  onChange: (state: ResetCreditHistoryState | undefined) => void
) {
  let state: ResetCreditHistoryState | undefined;
  let requestId: string | undefined;
  let request: PageRequest | undefined;
  let localRequestId: string | undefined;
  let inventoryRequestId: string | undefined;
  let inventoryTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let historyStarted = false;
  let refreshQueued = false;
  const loadedCursors = new Set<string>();
  const cache = new Map<string, ResetCreditCache>();
  const redemptions = new Map<string, { scope: string; requestId: string }>();

  const cacheFor = (account: ResetCreditScope): ResetCreditCache => {
    const key = cacheKey(account);
    const entry = cache.get(key) ?? {};
    cache.set(key, entry);
    return entry;
  };

  const publish = (next: ResetCreditHistoryState | undefined): void => {
    state = next;
    onChange(next);
  };

  const clearRequest = (): void => {
    clearTimeout(timer);
    requestId = undefined;
  };

  const clearInventoryRequest = (): void => {
    clearTimeout(inventoryTimer);
    inventoryRequestId = undefined;
  };

  const loadInventory = (): void => {
    if (!state || state.inventoryLoading) {
      return;
    }
    const requestId = createActionRequestId();
    const { accountId } = state;
    inventoryRequestId = requestId;
    publish({ ...state, inventoryLoading: true, inventoryFailed: false });
    inventoryTimer = setTimeout(() => {
      applyActionResult({ type: "dashboard:action-result", action: "getResetCredits", accountId, requestId, status: "failed" });
    }, getActionTimeoutMs("getResetCredits"));
    postMessage({ type: "dashboard:action", action: "getResetCredits", accountId, requestId });
  };

  const load = (pageRequest: PageRequest): void => {
    if (!state || state.loading) {
      return;
    }

    const id = createActionRequestId();
    const { accountId } = state;
    requestId = id;
    request = pageRequest;
    publish({ ...state, loading: true, failed: false });
    timer = setTimeout(() => {
      applyActionResult({ type: "dashboard:action-result", action: "getResetCreditHistory", accountId, requestId: id, status: "failed" });
    }, getActionTimeoutMs("getResetCreditHistory"));
    postMessage({
      type: "dashboard:action",
      action: "getResetCreditHistory",
      requestId: id,
      accountId,
      payload: pageRequest.cursor === undefined ? undefined : { resetCreditHistoryCursor: pageRequest.cursor }
    });
  };

  const loadLocal = (): void => {
    if (state) {
      localRequestId = createActionRequestId();
      postMessage({ type: "dashboard:action", action: "getLocalResetCreditHistory", requestId: localRequestId, accountId: state.accountId });
    }
  };

  const applyActionResult = (message: HistoryActionResult): void => {
    if (message.action === "consumeResetCredit" && message.accountId !== undefined) {
      const redemption = redemptions.get(message.accountId);
      if (redemption?.requestId !== message.requestId) {
        return;
      }
      redemptions.delete(message.accountId);
      const inventory = message.status === "completed" ? message.payload?.resetCredits : undefined;
      const historyChanged = message.status === "completed" && message.payload?.resetCreditHistoryChanged === true;
      const failed = message.status === "failed";
      const historyInvalidated = historyChanged || failed;
      if (inventory || historyInvalidated) {
        const entry = cacheFor({ accountId: message.accountId, scope: redemption.scope });
        entry.inventory = inventory ? cacheInventory(inventory) : undefined;
        entry.local = undefined;
        if (historyInvalidated) {
          entry.history = undefined;
        }
      }
      if (state?.accountId !== message.accountId || state.scope !== redemption.scope) {
        return;
      }
      if (inventory) {
        clearInventoryRequest();
        publish({ ...state, redeemingCreditId: undefined, inventory, inventoryLoading: false, inventoryFailed: false });
      } else if (historyChanged) {
        // Keep a successful redemption even if its following inventory request failed.
        clearInventoryRequest();
        publish({ ...state, redeemingCreditId: undefined, inventory: undefined, inventoryLoading: false, inventoryFailed: true });
      } else if (failed) {
        clearInventoryRequest();
        publish({ ...state, redeemingCreditId: undefined, inventoryLoading: false });
      } else if (state.redeemingCreditId !== undefined) {
        publish({ ...state, redeemingCreditId: undefined });
      }
      if (historyStarted) {
        loadLocal();
      }
      if (historyStarted && historyInvalidated) {
        if (state.loading) {
          refreshQueued = true;
        } else {
          load({ refresh: true });
        }
      }
      return;
    }

    if (!state || message.accountId !== state.accountId) {
      return;
    }

    if (message.action === "getResetCredits" && message.requestId === inventoryRequestId) {
      clearInventoryRequest();
      const inventory = message.status === "completed" ? message.payload?.resetCredits : undefined;
      if (inventory) {
        cacheFor(state).inventory = cacheInventory(inventory);
      }
      publish({ ...state, inventory: inventory ?? state.inventory, inventoryLoading: false, inventoryFailed: !inventory });
      return;
    }

    if (message.action === "getLocalResetCreditHistory" && message.requestId === localRequestId) {
      localRequestId = undefined;
      const local = message.status === "completed" ? message.payload?.localResetCreditHistory : undefined;
      if (local) {
        cacheFor(state).local = { value: local, expiresAt: Date.now() + CACHE_TTL_MS };
      }
      publish({ ...state, local: local ?? state.local, localFailed: message.status === "failed" });
      return;
    }

    if (message.action !== "getResetCreditHistory" || message.requestId !== requestId || !request) {
      return;
    }

    clearRequest();
    const page = message.status === "completed" ? message.payload?.resetCreditHistory : undefined;
    if (page) {
      if (request.cursor === undefined && !request.refresh) {
        loadedCursors.clear();
      }
      if (request.cursor !== undefined) {
        loadedCursors.add(request.cursor);
      }
      const updatingFirstPage = request.refresh === true && state.events.length > 0;
      const priorEvents = request.cursor !== undefined || updatingFirstPage ? state.events : [];
      const combined = updatingFirstPage ? [...page.events, ...priorEvents] : [...priorEvents, ...page.events];
      const byId = new Map<string, CodexResetCreditHistoryEvent>();
      for (const event of combined) {
        if (!byId.has(event.id)) {
          byId.set(event.id, event);
        }
      }
      const nextCursor = updatingFirstPage ? state.nextCursor : page.nextCursor;
      const events = [...byId.values()];
      const next = nextCursor !== undefined && !loadedCursors.has(nextCursor) ? nextCursor : undefined;
      // Loading older pages does not extend the freshness of the first page.
      if (!refreshQueued) {
        const entry = cacheFor(state);
        const expiresAt = request.cursor === undefined ? Date.now() + CACHE_TTL_MS : entry.history?.expiresAt;
        if (expiresAt !== undefined) {
          entry.history = { value: { events, nextCursor: next, loadedCursors: [...loadedCursors] }, expiresAt };
        }
      }
      publish({
        ...state,
        events,
        nextCursor: next,
        loading: false,
        failed: false
      });
    } else {
      publish({ ...state, loading: false, failed: true });
    }

    if (refreshQueued) {
      refreshQueued = false;
      load({ refresh: true });
    }
  };

  const reset = (): void => {
    clearRequest();
    clearInventoryRequest();
    request = undefined;
    localRequestId = undefined;
    refreshQueued = false;
    historyStarted = false;
    loadedCursors.clear();
  };

  return {
    open(accountId: string, scope: string): void {
      if (state?.accountId === accountId && state.scope === scope) {
        return;
      }
      reset();
      for (const [key, entry] of cache) {
        if (!readFresh(entry.inventory) && !readFresh(entry.history) && !readFresh(entry.local)) {
          cache.delete(key);
        }
      }
      const inventory = readFresh(cache.get(cacheKey({ accountId, scope }))?.inventory);
      state = { accountId, scope, tab: "available", inventory, events: [], loading: false, failed: false };
      if (inventory) {
        publish(state);
      } else {
        loadInventory();
      }
    },
    selectTab(tab: ResetCreditTab): void {
      if (!state || state.tab === tab) {
        return;
      }
      publish({ ...state, tab });
      if (tab === "history" && !historyStarted) {
        historyStarted = true;
        const entry = cache.get(cacheKey(state));
        const history = readFresh(entry?.history);
        const local = readFresh(entry?.local);
        if (history || local) {
          publish({ ...state, events: history?.events ?? [], nextCursor: history?.nextCursor, local });
        }
        if (history) {
          history.loadedCursors.forEach((cursor) => loadedCursors.add(cursor));
        } else {
          load({});
        }
        if (!local) {
          loadLocal();
        }
      }
    },
    refresh(): void {
      if (state?.tab === "available") {
        loadInventory();
      } else if (state?.tab === "history" && !state.loading) {
        load({});
        loadLocal();
      }
    },
    reloadInventory(): void {
      loadInventory();
    },
    close(): void {
      reset();
      publish(undefined);
    },
    loadMore(): void {
      if (state?.nextCursor !== undefined && !state.failed) {
        load({ cursor: state.nextCursor });
      }
    },
    retry(): void {
      if (state?.failed && request) {
        load(request);
      }
    },
    watchRedemption(accountId: string, id: string, creditId?: string): void {
      if (state?.accountId === accountId) {
        redemptions.set(accountId, { scope: state.scope, requestId: id });
        publish({ ...state, redeemingCreditId: creditId });
      }
    },
    applyActionResult
  };
}
