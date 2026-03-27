import type {
  DashboardAccountViewModel,
  DashboardCopy,
  DashboardSettings,
  DashboardState
} from "../../src/domain/dashboard/types";
import {
  formatAutoSwitchReasonSummary,
  formatTimestamp,
  getSensitiveDisplayValue,
  renderTagList
} from "./helpers";
import {
  EditTagsIcon,
  renderDetailsIcon,
  renderRefreshIcon,
  renderReauthorizeIcon,
  renderReloadIcon,
  renderRemoveIcon,
  renderResyncProfileIcon,
  renderSwitchIcon
} from "./icons";
import { ActionButton } from "./primitives";
import { MetricRow, renderHealthPill } from "./accountMetricPrimitives";

export function SavedAccountCard(props: {
  account: DashboardAccountViewModel;
  lang: DashboardState["lang"];
  copy: DashboardCopy;
  settings: DashboardSettings;
  now: number;
  privacyMode: boolean;
  busy: boolean;
  reloadPromptPending: boolean;
  switchPending: boolean;
  reauthorizePending: boolean;
  resyncProfilePending: boolean;
  refreshPending: boolean;
  detailsPending: boolean;
  removePending: boolean;
  togglePending: boolean;
  updateTagsPending: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onEditTags: () => void;
  onAction: (
    action: "details" | "switch" | "reloadPrompt" | "reauthorize" | "resyncProfile" | "refresh" | "remove" | "toggleStatusBar",
    accountId?: string
  ) => void;
}) {
  const { account, copy, settings, now, onAction, privacyMode } = props;
  const accountIdDisplay = getSensitiveDisplayValue(account.accountId ?? account.userId, privacyMode, "id", "-");
  const selectionLabel = props.selected ? copy.deselectAccount : copy.selectAccount;
  const showReauthorizeButton = account.healthKind === "reauthorize" && !account.dismissedHealth;
  const showResyncButton = account.healthKind !== "reauthorize";
  const resyncButtonLabel =
    (account.healthKind === "disabled" || account.healthKind === "quota") && !account.dismissedHealth
      ? copy.resyncProfileBtn
      : copy.syncProfileBtn;

  return (
    <article class={`saved-card ${account.isActive ? "active" : ""} ${props.busy ? "is-busy" : ""} ${props.selected ? "selected" : ""}`}>
      <div class="saved-head">
        <div class="saved-top-actions">
          {!account.isActive ? (
            <button
              class={`saved-control saved-status-toggle ${account.canToggleStatusBar ? "" : "disabled"} ${account.showInStatusBar ? "is-checked" : ""}`}
              type="button"
              aria-label={account.statusToggleTitle}
              aria-pressed={account.showInStatusBar}
              aria-disabled={!account.canToggleStatusBar || props.busy}
              onClick={() => {
                if (!account.canToggleStatusBar || props.busy) {
                  return;
                }
                onAction("toggleStatusBar", account.id);
              }}
            >
              <span class="saved-status-toggle-indicator" aria-hidden="true">
                <span></span>
              </span>
              <span class="saved-control-tip align-right" aria-hidden="true">
                {account.statusToggleTitle}
              </span>
            </button>
          ) : null}
          <button class="saved-control saved-edit-tags-btn" type="button" aria-label={copy.editTagsBtn} disabled={props.busy} onClick={props.onEditTags}>
            {props.updateTagsPending ? <span class="saved-toggle-spinner" aria-hidden="true"></span> : <EditTagsIcon />}
            <span class="saved-control-tip align-right" aria-hidden="true">
              {copy.editTagsBtn}
            </span>
          </button>
        </div>
        <div class="saved-title">
          <h3>
            <button class={`saved-select-toggle ${props.selected ? "selected" : ""}`} type="button" aria-pressed={props.selected} aria-label={selectionLabel} onClick={props.onToggleSelected}>
              <span class="saved-select-toggle-mark" aria-hidden="true"></span>
              <span class="saved-control-tip align-left below" aria-hidden="true">
                {selectionLabel}
              </span>
            </button>
            <span class="saved-title-text">{getSensitiveDisplayValue(account.email, privacyMode, "email")}</span>
          </h3>
          <div class="saved-sub">{getSensitiveDisplayValue(account.accountName, privacyMode, "name", copy.unknown)}</div>
          <div class="saved-sub">
            {copy.login}: {account.authProviderLabel}
          </div>
          <div class="saved-sub truncate" title={`${copy.accountId}: ${accountIdDisplay}`}>
            {copy.accountId}: {accountIdDisplay}
          </div>
          <div class="saved-meta">
            {account.isActive ? <span class="pill active">{copy.primaryAccount}</span> : null}
            {account.isCurrentWindowAccount ? <span class="pill active">{copy.current}</span> : null}
            <span class="pill plan">{account.planTypeLabel}</span>
            {renderHealthPill(account)}
          </div>
          <div class="saved-tags-row">
            <div class="account-tag-row">{renderTagList(account.tags)}</div>
          </div>
          {account.lastAutoSwitchReason ? (
            <div class="saved-switch-reason">
              <strong>{copy.autoSwitchReasonTitle}:</strong> {formatAutoSwitchReasonSummary(account.lastAutoSwitchReason, copy)}
            </div>
          ) : null}
        </div>
      </div>
      <div class="saved-progress">
        {account.metrics
          .filter((metric) => metric.visible)
          .map((metric) => (
            <MetricRow key={metric.key} metric={metric} lang={props.lang} settings={settings} copy={copy} now={now} />
          ))}
      </div>
      <div class="saved-refresh">
        {copy.lastRefresh}: {formatTimestamp(account.lastQuotaAt, copy.never)}
      </div>
      <div class="saved-actions">
        {account.isActive && !account.isCurrentWindowAccount ? (
          <ActionButton icon={renderReloadIcon()} iconOnly label={copy.reloadBtn} pending={props.reloadPromptPending} disabled={props.busy} onClick={() => onAction("reloadPrompt", account.id)} />
        ) : null}
        {showReauthorizeButton ? (
          <ActionButton icon={renderReauthorizeIcon()} iconOnly label={copy.reauthorizeBtn} pending={props.reauthorizePending} disabled={props.busy} onClick={() => onAction("reauthorize", account.id)} />
        ) : null}
        {showResyncButton ? (
          <ActionButton icon={renderResyncProfileIcon()} iconOnly label={resyncButtonLabel} pending={props.resyncProfilePending} disabled={props.busy} onClick={() => onAction("resyncProfile", account.id)} />
        ) : null}
        <ActionButton icon={renderSwitchIcon()} iconOnly label={copy.switchBtn} pending={props.switchPending} disabled={props.busy} onClick={() => onAction("switch", account.id)} />
        <ActionButton icon={renderRefreshIcon()} iconOnly label={copy.refreshBtn} pending={props.refreshPending} disabled={props.busy} onClick={() => onAction("refresh", account.id)} />
        <ActionButton icon={renderDetailsIcon()} iconOnly label={copy.detailsBtn} pending={props.detailsPending} disabled={props.busy} onClick={() => onAction("details", account.id)} />
        <ActionButton icon={renderRemoveIcon()} iconOnly label={copy.removeBtn} pending={props.removePending} disabled={props.busy} onClick={() => onAction("remove", account.id)} />
      </div>
    </article>
  );
}
