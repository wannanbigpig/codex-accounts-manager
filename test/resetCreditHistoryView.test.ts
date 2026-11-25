import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexResetCreditHistoryPage, CodexResetCreditLocalRecord, CodexResetCreditsSnapshot } from "../src/core/types";
import type { DashboardClientMessage } from "../src/domain/dashboard/types";
import { createResetCreditHistoryController, type ResetCreditHistoryState } from "../webview-src/dashboard/resetCreditHistory";

type HistoryRequest = Extract<DashboardClientMessage, { type: "dashboard:action" }>;

function fixture() {
  let state: ResetCreditHistoryState | undefined;
  const messages: HistoryRequest[] = [];
  const localMessages: HistoryRequest[] = [];
  const inventoryMessages: HistoryRequest[] = [];
  const controller = createResetCreditHistoryController(
    (message) => {
      if (message.type === "dashboard:action") {
        if (message.action === "getResetCredits") {
          inventoryMessages.push(message);
        } else {
          (message.action === "getLocalResetCreditHistory" ? localMessages : messages).push(message);
        }
      }
    },
    (next) => { state = next; }
  );

  return {
    ...controller,
    state: () => state,
    messages,
    localMessages,
    inventoryMessages,
    openHistory(accountId: string, scope: string) {
      controller.open(accountId, scope);
      controller.selectTab("history");
    },
    respond(request: HistoryRequest, page?: CodexResetCreditHistoryPage): void {
      controller.applyActionResult({
        type: "dashboard:action-result",
        action: "getResetCreditHistory",
        accountId: request.accountId,
        requestId: request.requestId,
        status: page ? "completed" : "failed",
        payload: page ? { resetCreditHistory: page } : undefined
      });
    },
    respondInventory(request: HistoryRequest, inventory?: CodexResetCreditsSnapshot): void {
      controller.applyActionResult({
        type: "dashboard:action-result", action: "getResetCredits", accountId: request.accountId, requestId: request.requestId,
        status: inventory ? "completed" : "failed", payload: inventory ? { resetCredits: inventory } : undefined
      });
    },
    respondLocal(request: HistoryRequest, local: CodexResetCreditLocalRecord[]): void {
      controller.applyActionResult({
        type: "dashboard:action-result", action: "getLocalResetCreditHistory", accountId: request.accountId, requestId: request.requestId,
        status: "completed", payload: { localResetCreditHistory: local }
      });
    }
  };
}

const grant = { id: "grant", kind: "granted", occurredAt: "2026-11-01T13:00:00Z" };
const older = { id: "older", kind: "future_kind", occurredAt: "2026-10-02T13:00:00Z" };
const redemption = { id: "used", kind: "redeemed", occurredAt: "2026-11-23T13:00:00Z" };
const emptyInventory = { availableCount: 0, credits: [] };
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

describe("reset credit history view", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("loads only on open, passes opaque cursors and preserves history when a page fails", () => {
    const view = fixture();
    expect(view.messages).toHaveLength(0);
    view.open("account-a", "scope-a");
    expect(view.state()).toMatchObject({ tab: "available", inventoryLoading: true });
    expect(view.inventoryMessages).toHaveLength(1);
    expect(view.messages).toHaveLength(0);
    expect(view.localMessages).toHaveLength(0);
    view.openHistory("account-a", "scope-a");
    view.openHistory("account-a", "scope-a");
    expect(view.messages).toHaveLength(1);
    expect(view.state()?.loading).toBe(true);

    const cursor = " opaque+/= cursor ";
    view.respond(view.messages[0]!, { events: [grant], nextCursor: cursor });
    view.loadMore();
    view.loadMore();
    expect(view.messages).toHaveLength(2);
    expect(view.messages[1]?.payload?.resetCreditHistoryCursor).toBe(cursor);
    view.respond(view.messages[1]!);
    expect(view.state()).toMatchObject({ loading: false, failed: true, events: [grant] });

    view.retry();
    view.retry();
    expect(view.messages).toHaveLength(3);
    expect(view.messages[2]?.payload?.resetCreditHistoryCursor).toBe(cursor);
    view.respond(view.messages[2]!, { events: [grant, older], nextCursor: cursor });
    expect(view.state()).toMatchObject({ events: [grant, older], loading: false, failed: false });
    expect(view.state()?.nextCursor).toBeUndefined();
  });

  it("ignores responses from closed dialogs, other accounts or earlier workspace scopes", () => {
    const view = fixture();
    view.openHistory("account-a", "scope-a");
    view.openHistory("account-b", "scope-b");
    view.respond(view.messages[0]!, { events: [grant] });
    expect(view.state()).toMatchObject({ accountId: "account-b", events: [], loading: true });

    view.close();
    view.respond(view.messages[1]!, { events: [grant] });
    expect(view.state()).toBeUndefined();
    view.openHistory("account-b", "scope-b");
    view.respond(view.messages[1]!, { events: [grant] });
    expect(view.state()?.loading).toBe(true);
    view.respond(view.messages[2]!, { events: [older], nextCursor: "b-cursor" });

    view.loadMore();
    view.openHistory("account-b", "new-workspace");
    view.respond(view.messages[3]!, { events: [grant] });
    expect(view.messages[4]?.payload).toBeUndefined();
    expect(view.state()).toMatchObject({ accountId: "account-b", scope: "new-workspace", events: [], loading: true });
    view.respond(view.messages[4]!, { events: [] });
    expect(view.state()).toMatchObject({ events: [], loading: false, failed: false });
  });

  it("refreshes the first page after this dialog's confirmed reset without dropping earlier pages", () => {
    const view = fixture();
    const finish = (requestId: string, changed?: true) => view.applyActionResult({
      type: "dashboard:action-result",
      action: "consumeResetCredit",
      accountId: "account-a",
      requestId,
      status: "completed",
      payload: changed ? { resetCreditHistoryChanged: true } : undefined
    });

    view.openHistory("account-a", "scope-a");
    view.respond(view.messages[0]!, { events: [grant], nextCursor: "second" });
    view.watchRedemption("account-a", "cancelled");
    finish("cancelled");
    finish("stale", true);
    expect(view.messages).toHaveLength(1);

    view.loadMore();
    view.watchRedemption("account-a", "confirmed");
    finish("confirmed", true);
    expect(view.messages).toHaveLength(2);
    view.respond(view.messages[1]!, { events: [older], nextCursor: "third" });
    expect(view.messages).toHaveLength(3);
    expect(view.messages[2]?.payload).toBeUndefined();
    view.respond(view.messages[2]!, { events: [redemption, grant], nextCursor: "new-second" });
    expect(view.state()).toMatchObject({ events: [redemption, grant, older], nextCursor: "third", failed: false });
  });

  it("times out to a retryable error and ignores a late reply", () => {
    const view = fixture();
    view.openHistory("account-a", "scope-a");
    vi.advanceTimersByTime(60_000);
    expect(view.state()?.loading).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(view.state()).toMatchObject({ loading: false, failed: true });

    view.retry();
    view.respond(view.messages[0]!, { events: [grant] });
    expect(view.state()).toMatchObject({ loading: true, events: [] });
    view.respond(view.messages[1]!, { events: [older] });
    expect(view.state()).toMatchObject({ loading: false, failed: false, events: [older] });
  });

  it("loads local records independently of the official endpoint and ignores an obsolete workspace", () => {
    const view = fixture();
    view.openHistory("account-a", "old");
    view.openHistory("account-a", "new");
    const respond = (request: HistoryRequest, requestId: string) => view.applyActionResult({
      type: "dashboard:action-result", action: "getLocalResetCreditHistory", accountId: request.accountId,
      requestId: request.requestId, status: "completed", payload: { localResetCreditHistory: [{ requestId, outcome: "pending" }] }
    });
    respond(view.localMessages[0]!, "old");
    expect(view.state()?.local).toBeUndefined();
    view.respond(view.messages[1]!);
    respond(view.localMessages[1]!, "new");
    expect(view.state()).toMatchObject({ failed: true, local: [{ requestId: "new", outcome: "pending" }] });
  });

  it("uses the redemption snapshot without reading history or accepting a late inventory response", () => {
    const view = fixture();
    view.open("account-a", "scope-a");
    const inventoryRequest = view.inventoryMessages[0]!;
    view.watchRedemption("account-a", "redeem-current");
    view.applyActionResult({
      type: "dashboard:action-result", action: "consumeResetCredit", accountId: "account-a", requestId: "redeem-current",
      status: "completed", payload: { resetCredits: { availableCount: 0, credits: [] }, resetCreditHistoryChanged: true }
    });
    view.applyActionResult({
      type: "dashboard:action-result", action: "getResetCredits", accountId: "account-a", requestId: inventoryRequest.requestId,
      status: "completed", payload: { resetCredits: { availableCount: 2, credits: [] } }
    });
    expect(view.state()).toMatchObject({ inventory: { availableCount: 0 }, inventoryLoading: false });
    expect(view.messages).toHaveLength(0);
    expect(view.localMessages).toHaveLength(0);
    view.selectTab("history");
    view.selectTab("available");
    view.selectTab("history");
    expect(view.inventoryMessages).toHaveLength(1);
    expect(view.messages).toHaveLength(1);
    expect(view.localMessages).toHaveLength(1);
  });

  it("reopens with cached zero inventory and paged history for two hours, even after loading more", () => {
    const view = fixture();
    view.openHistory("same-account", "personal");
    view.respondInventory(view.inventoryMessages[0]!, emptyInventory);
    view.respond(view.messages[0]!, { events: [grant], nextCursor: "cursor-one" });
    view.respondLocal(view.localMessages[0]!, []);

    vi.advanceTimersByTime(TWO_HOURS_MS - 1);
    view.loadMore();
    view.respond(view.messages[1]!, { events: [older], nextCursor: "cursor-two" });
    view.close();
    view.open("same-account", "personal");
    expect(view.state()).toMatchObject({ tab: "available", inventory: emptyInventory });
    expect(view.state()?.inventoryLoading).toBeFalsy();
    expect(view.messages).toHaveLength(2);
    view.selectTab("history");
    expect(view.state()).toMatchObject({ events: [grant, older], nextCursor: "cursor-two", local: [], loading: false });
    expect(view.inventoryMessages).toHaveLength(1);
    expect(view.messages).toHaveLength(2);
    expect(view.localMessages).toHaveLength(1);

    vi.advanceTimersByTime(1);
    view.close();
    view.openHistory("same-account", "personal");
    expect(view.inventoryMessages).toHaveLength(2);
    expect(view.messages).toHaveLength(3);
    expect(view.localMessages).toHaveLength(2);
    expect(view.messages[2]?.payload).toBeUndefined();
  });

  it("expires inventory at the nearest card expiry and keeps each account/workspace cache separate", () => {
    const view = fixture();
    const inventory = { availableCount: 1, credits: [{ id: "personal-card", expires_at: (Date.now() + 60_000) / 1_000 }] };
    view.openHistory("same-account", "personal");
    view.respondInventory(view.inventoryMessages[0]!, inventory);
    view.respond(view.messages[0]!, { events: [grant] });
    view.openHistory("same-account", "business");
    expect(view.state()).toMatchObject({ inventoryLoading: true, events: [], loading: true });
    view.respondInventory(view.inventoryMessages[1]!, emptyInventory);
    view.respond(view.messages[1]!, { events: [] });
    view.open("other-account", "personal");
    expect(view.state()?.inventory).toBeUndefined();

    view.openHistory("same-account", "personal");
    expect(view.state()).toMatchObject({ inventory, events: [grant] });
    expect(view.inventoryMessages).toHaveLength(3);
    expect(view.messages).toHaveLength(2);
    view.close();
    vi.advanceTimersByTime(60_000);
    view.openHistory("same-account", "personal");
    expect(view.state()?.inventory).toBeUndefined();
    expect(view.state()?.events).toEqual([grant]);
    expect(view.inventoryMessages).toHaveLength(4);
  });

  it("forces a refresh of the selected tab, keeps old data on failure, and resets history pagination on success", () => {
    const view = fixture();
    view.open("account-a", "personal");
    view.respondInventory(view.inventoryMessages[0]!, emptyInventory);
    view.refresh();
    view.refresh();
    expect(view.inventoryMessages).toHaveLength(2);
    expect(view.messages).toHaveLength(0);
    view.respondInventory(view.inventoryMessages[1]!);
    expect(view.state()).toMatchObject({ inventory: emptyInventory, inventoryFailed: true });
    view.close();
    view.openHistory("account-a", "personal");
    expect(view.inventoryMessages).toHaveLength(2);
    view.respond(view.messages[0]!, { events: [grant], nextCursor: "old" });
    view.loadMore();
    view.respond(view.messages[1]!, { events: [older] });

    view.refresh();
    view.refresh();
    expect(view.messages).toHaveLength(3);
    expect(view.messages[2]?.payload).toBeUndefined();
    expect(view.inventoryMessages).toHaveLength(2);
    expect(view.localMessages).toHaveLength(2);
    expect(view.state()?.events).toEqual([grant, older]);
    view.respond(view.messages[2]!, { events: [redemption], nextCursor: "old" });
    expect(view.state()).toMatchObject({ events: [redemption], nextCursor: "old", loading: false });
    view.loadMore();
    expect(view.messages[3]?.payload?.resetCreditHistoryCursor).toBe("old");
  });

  it("updates cached inventory and invalidates the relevant history when redemption finishes after close", () => {
    const view = fixture();
    view.openHistory("account-a", "personal");
    view.respondInventory(view.inventoryMessages[0]!, { availableCount: 1, credits: [{ id: "used" }] });
    view.respond(view.messages[0]!, { events: [grant] });
    view.respondLocal(view.localMessages[0]!, []);
    view.watchRedemption("account-a", "exchange", "used");
    view.close();
    view.applyActionResult({
      type: "dashboard:action-result", action: "consumeResetCredit", requestId: "exchange", accountId: "account-a",
      status: "completed", payload: { resetCredits: emptyInventory, resetCreditHistoryChanged: true }
    });
    expect(view.state()).toBeUndefined();
    view.openHistory("account-a", "personal");
    expect(view.state()).toMatchObject({ inventory: emptyInventory, events: [], loading: true });
    expect(view.inventoryMessages).toHaveLength(1);
    expect(view.messages).toHaveLength(2);
    expect(view.localMessages).toHaveLength(2);
  });
});
