import { useEffect, useRef } from "preact/hooks";
import type { DashboardAccountViewModel, DashboardCopy } from "../../src/domain/dashboard/types";
import { isAvailableResetCredit } from "../../src/domain/resetCredits";
import { getIntlLocale, type DashboardLanguage } from "../../src/localization/languages";
import { getSensitiveDisplayValue } from "./helpers";
import { renderRefreshIcon } from "./icons";
import { ActionButton, ModalShell } from "./primitives";
import type { ResetCreditHistoryState, ResetCreditTab } from "./resetCreditHistory";

const TABS = ["available", "history"] as const;
const PANEL_PREFIX = "reset-credit-panel-";
const TAB_PREFIX = "reset-credit-tab-";

export function ResetCreditsModal(props: {
  account: DashboardAccountViewModel;
  history: ResetCreditHistoryState;
  copy: DashboardCopy;
  lang: DashboardLanguage;
  now: number;
  privacyMode: boolean;
  redemptionPending: boolean;
  disabled: boolean;
  onRedeem: (creditId?: string) => void;
  onTabChange: (tab: ResetCreditTab) => void;
  onRefresh: () => void;
  onReloadInventory: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { account, history, copy } = props;
  const accountLabel = getSensitiveDisplayValue(account.email, props.privacyMode, "email");
  const { inventory, tab } = history;
  const refreshing = tab === "available" ? history.inventoryLoading === true : history.loading;
  const available = inventory?.availableCount ?? account.resetCreditsAvailable;
  const pending = account.resetRedemptionPending === true;
  const pendingCreditId = pending ? account.resetRedemptionCreditId : undefined;
  const disableRedemption = props.disabled || props.redemptionPending || history.inventoryLoading === true;
  const tabsRef = useRef<HTMLDivElement>(null);
  const locale = getIntlLocale(props.lang);
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  const dateWithYear = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" });
  const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" });
  const currentYear = new Date(props.now).getFullYear();
  const formatDay = (value: Date) => (value.getFullYear() === currentYear ? date : dateWithYear).format(value);

  const credits = (inventory?.credits ?? [])
    .filter((credit) => isAvailableResetCredit(credit, props.now))
    .sort((left, right) => (left.expires_at ?? Infinity) - (right.expires_at ?? Infinity))
    .slice(0, available ?? 0);
  const showRecovery = pending && (pendingCreditId === undefined || !credits.some((credit) => credit.id === pendingCreditId));
  const expiryTime = (seconds?: number) => {
    const expiry = seconds === undefined ? undefined : new Date(seconds * 1000);
    return expiry && Number.isFinite(expiry.getTime()) && expiry.getTime() > props.now ? expiry : undefined;
  };
  const nextExpiry = expiryTime(inventory?.nextExpiresAt ?? account.resetCreditsNextExpiresAt);
  const renderExpiry = (template: string, value: Date) => (
    <time dateTime={value.toISOString()}>{template.replace("{value}", `${formatDay(value)} ${clock.format(value)}`)}</time>
  );
  const renderTimestamp = (value: Date) => Number.isFinite(value.getTime()) ? (
    <time class="reset-credit-event-date" dateTime={value.toISOString()}>
      <span>{formatDay(value)}</span>
      <span>{clock.format(value)}</span>
    </time>
  ) : <span class="reset-credit-event-date">{copy.unknown}</span>;

  useEffect(() => {
    const opener = document.activeElement;
    tabsRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);

  return (
    <ModalShell
      open
      className="reset-credits-modal"
      title={copy.resetCreditDialogTitle}
      closeLabel={copy.closeModal}
      onClose={props.onClose}
    >
      <div class="reset-credit-intro">
        <div class="reset-credit-account" title={accountLabel}>{accountLabel}</div>
        <p>{copy.resetCreditDialogHint}</p>
      </div>
      <div class="reset-credit-toolbar">
        <div
          class="modal-tabs"
          role="tablist"
          aria-label={copy.resetCreditDialogTitle}
          ref={tabsRef}
          onKeyDown={(event) => {
            const next = event.key === "Home" ? "available" : event.key === "End" ? "history" :
              event.key === "ArrowLeft" || event.key === "ArrowRight" ? (tab === "available" ? "history" : "available") : undefined;
            if (next) {
              event.preventDefault();
              props.onTabChange(next);
              tabsRef.current?.querySelector<HTMLButtonElement>(`#${TAB_PREFIX}${next}`)?.focus();
            }
          }}
        >
          {TABS.map((item) => (
            <button
              key={item}
              id={TAB_PREFIX + item}
              class={`modal-tab ${tab === item ? "active" : ""}`}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-controls={PANEL_PREFIX + item}
              tabIndex={tab === item ? 0 : -1}
              onClick={() => props.onTabChange(item)}
            >
              {item === "available" ? <>{copy.resetCreditAvailableTab}<span class="reset-credit-count">{available ?? "—"}</span></> : copy.resetCreditHistoryTab}
            </button>
          ))}
        </div>
        <ActionButton class="modal-secondary-btn" icon={renderRefreshIcon()} pending={refreshing}
          disabled={refreshing || props.redemptionPending} onClick={props.onRefresh}>
          {copy.resetCreditRefresh}
        </ActionButton>
      </div>
      <section class="reset-credit-panel" id={PANEL_PREFIX + "available"} role="tabpanel"
        aria-labelledby={TAB_PREFIX + "available"} hidden={tab !== "available"} tabIndex={0}>
        {pending ? <p class="reset-credit-pending" role="status">{copy.resetCreditsPendingNote}</p> : null}
        {showRecovery ? (
          <div class="reset-credit-feedback">
            <ActionButton class="modal-secondary-btn" pending={props.redemptionPending}
              disabled={disableRedemption} onClick={() => props.onRedeem(pendingCreditId)}>
              {copy.resetCreditsRetryBtn}
            </ActionButton>
          </div>
        ) : null}
        {credits.length ? (
          <ul class="reset-credit-list">
            {credits.map((credit, index) => {
              const { id } = credit;
              const expiry = expiryTime(credit.expires_at);
              const type = credit.reset_type?.toLowerCase();
              const retry = id !== undefined && id === pendingCreditId;
              const buttonLabel = retry ? copy.resetCreditsRetryBtn : copy.resetCreditUse;
              return (
                <li class="reset-credit-list-row reset-credit-available-row" key={id ?? `reset-${index}`}>
                  <div class="reset-credit-details">
                    <span class="reset-credit-item-title">
                      {type === "full" || type === "full_reset" || type === "codex_rate_limits" ? copy.resetCreditFull : copy.resetCreditItem}
                    </span>
                    <span class="reset-credit-row-note">{expiry ? renderExpiry(copy.resetCreditExpires, expiry) : copy.resetCreditExpiryUnknown}</span>
                  </div>
                  {id !== undefined ? (
                    <ActionButton class="modal-secondary-btn" pending={props.redemptionPending && history.redeemingCreditId === id}
                      label={expiry ? `${buttonLabel} · ${formatDay(expiry)} ${clock.format(expiry)}` : buttonLabel}
                      disabled={disableRedemption || (pending && !retry)} onClick={() => props.onRedeem(id)}>
                      {buttonLabel}
                    </ActionButton>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {history.inventoryLoading ? <p class="reset-credit-message" role="status">{copy.resetCreditInventoryLoading}</p> : null}
        {history.inventoryFailed ? (
          <div class="reset-credit-feedback">
            <div class="modal-error" role="alert">{copy.resetCreditInventoryError}</div>
            <button class="modal-secondary-btn" type="button" onClick={props.onReloadInventory}>{copy.resetCreditHistoryRetry}</button>
          </div>
        ) : null}
        {!credits.length && !history.inventoryLoading && (available ?? 0) > 0 ? (
          <p class="reset-credit-message">{nextExpiry ? renderExpiry(copy.resetCreditNextExpiry, nextExpiry) : copy.resetCreditExpiryUnknown}</p>
        ) : null}
        {!pending && !history.inventoryLoading && !history.inventoryFailed && (available ?? 0) > 0 && !credits.some((credit) => credit.id) ? (
          <div class="reset-credit-feedback">
            <p class="reset-credit-message">{copy.resetCreditCardsUnavailable}</p>
            <button class="modal-secondary-btn" type="button" onClick={props.onReloadInventory}>{copy.resetCreditHistoryRetry}</button>
          </div>
        ) : null}
        {!history.inventoryLoading && !history.inventoryFailed && available === 0 ? (
          <p class="reset-credit-message" role="status">{copy.resetCreditNoAvailable}</p>
        ) : null}
      </section>
      <section class="reset-credit-panel" id={PANEL_PREFIX + "history"} role="tabpanel"
        aria-labelledby={TAB_PREFIX + "history"} hidden={tab !== "history"} tabIndex={0}>
        {history.events.length ? (
          <ul class="reset-credit-list" aria-busy={history.loading}>
            {history.events.map((event) => (
              <li class="reset-credit-list-row reset-credit-history-row" key={event.id}>
                <span class="reset-credit-item-title">{resetCreditEventLabel(event.kind, copy)}</span>
                {renderTimestamp(new Date(event.occurredAt))}
              </li>
            ))}
          </ul>
        ) : null}
        {history.loading ? <p class="reset-credit-message" role="status">{copy.resetCreditHistoryLoading}</p> : null}
        {history.failed ? (
          <div class="reset-credit-feedback">
            <div class="modal-error" role="alert">{copy.resetCreditHistoryError}</div>
            <button class="modal-secondary-btn" type="button" onClick={props.onRetry}>{copy.resetCreditHistoryRetry}</button>
          </div>
        ) : null}
        {!history.loading && !history.failed && !history.events.length && history.nextCursor === undefined ? (
          <p class="reset-credit-message" role="status">{copy.resetCreditHistoryEmpty}</p>
        ) : null}
        {!history.failed && history.nextCursor !== undefined ? (
          <div class="reset-credit-feedback">
            <button class="modal-secondary-btn" type="button" disabled={history.loading} onClick={props.onLoadMore}>
              {copy.resetCreditHistoryMore}
            </button>
          </div>
        ) : null}
        {history.local?.length || history.localFailed ? (
          <details class="reset-credit-local-history">
            <summary>{copy.localResetHistoryTitle}</summary>
            {history.localFailed ? <div role="alert" class="modal-error">{copy.resetCreditHistoryError}</div> : null}
            {history.local?.length ? (
              <ul class="reset-credit-list">
                {history.local.map((row) => (
                  <li class="reset-credit-list-row reset-credit-history-row" key={row.requestId} title={row.requestId}>
                    <span class="reset-credit-item-title">{row.outcome === "pending" ? copy.resetCreditsPendingNote :
                      row.outcome === "reset" || row.outcome === "already_redeemed" ? copy.resetCreditHistoryRedeemed : copy.localResetNoCharge}</span>
                    {renderTimestamp(new Date(row.occurredAt ?? NaN))}
                  </li>
                ))}
              </ul>
            ) : null}
          </details>
        ) : null}
      </section>
    </ModalShell>
  );
}

function resetCreditEventLabel(kind: string, copy: DashboardCopy): string {
  switch (kind.trim().toLowerCase()) {
    case "granted":
      return copy.resetCreditHistoryGranted;
    case "redeemed":
    case "used":
    case "consumed":
      return copy.resetCreditHistoryRedeemed;
    default:
      return copy.resetCreditHistoryActivity;
  }
}
