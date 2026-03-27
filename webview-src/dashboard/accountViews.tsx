import type { DashboardCopy, DashboardState } from "../../src/domain/dashboard/types";
import { formatTemplate } from "./helpers";
import { ActionButton } from "./primitives";

export * from "./overviewSection";

export function RecoveryPanel(props: {
  copy: DashboardCopy;
  health: DashboardState["indexHealth"];
  restoreBackupPending: boolean;
  restoreAuthPending: boolean;
  restoreJsonPending: boolean;
  onRestoreBackup: () => void;
  onRestoreAuth: () => void;
  onImportJson: () => void;
}) {
  const description =
    props.health.status === "restored_from_backup" ? props.copy.recoveryRestored : props.copy.recoveryCorrupted;

  return (
    <div class={`recovery-banner ${props.health.status === "corrupted_unrecoverable" ? "is-danger" : ""}`}>
      <div class="recovery-banner-body">
        <div class="recovery-banner-title">{props.copy.recoveryTitle}</div>
        <div class="recovery-banner-desc">{description}</div>
        <div class="recovery-banner-meta">
          <span>
            {props.copy.recoveryBackups}: {props.health.availableBackups}
          </span>
          {props.health.lastErrorMessage ? (
            <span>
              {props.copy.recoveryLastError}: {props.health.lastErrorMessage}
            </span>
          ) : null}
        </div>
      </div>
      <div class="recovery-banner-actions">
        <ActionButton
          class="toolbar-btn"
          pending={props.restoreBackupPending}
          onClick={props.onRestoreBackup}
          disabled={props.restoreAuthPending || props.restoreJsonPending}
        >
          {props.copy.recoveryRestoreBackupBtn}
        </ActionButton>
        <ActionButton
          class="toolbar-btn"
          pending={props.restoreAuthPending}
          onClick={props.onRestoreAuth}
          disabled={props.restoreBackupPending || props.restoreJsonPending}
        >
          {props.copy.recoveryRestoreAuthBtn}
        </ActionButton>
        <ActionButton
          class="toolbar-btn"
          pending={props.restoreJsonPending}
          onClick={props.onImportJson}
          disabled={props.restoreBackupPending || props.restoreAuthPending}
        >
          {props.copy.recoveryImportJsonBtn}
        </ActionButton>
      </div>
    </div>
  );
}

export function BatchSelectionBar(props: {
  copy: DashboardCopy;
  selectedCount: number;
  tagsPending: boolean;
  refreshPending: boolean;
  resyncPending: boolean;
  removePending: boolean;
  sharePending: boolean;
  onRefresh: () => void;
  onResync: () => void;
  onRemove: () => void;
  onShare: () => void;
  onAddTags: () => void;
  onRemoveTags: () => void;
}) {
  return (
    <div class="batch-bar">
      <div class="batch-bar-actions">
        <ActionButton class="toolbar-btn" pending={props.tagsPending} onClick={props.onAddTags}>
          {props.copy.addTagsBtn}
        </ActionButton>
        <ActionButton class="toolbar-btn" pending={props.tagsPending} onClick={props.onRemoveTags}>
          {props.copy.removeTagsBtn}
        </ActionButton>
        <ActionButton class="toolbar-btn" pending={props.refreshPending} onClick={props.onRefresh}>
          {props.copy.batchRefreshBtn}
        </ActionButton>
        <ActionButton class="toolbar-btn" pending={props.resyncPending} onClick={props.onResync}>
          {props.copy.batchResyncBtn}
        </ActionButton>
        <ActionButton class="toolbar-btn" pending={props.sharePending} onClick={props.onShare}>
          {props.copy.batchExportBtn}
        </ActionButton>
        <ActionButton class="toolbar-btn" pending={props.removePending} onClick={props.onRemove}>
          {props.copy.batchRemoveBtn}
        </ActionButton>
      </div>
      <div class="batch-bar-count">{formatTemplate(props.copy.batchSelectedCount, { count: props.selectedCount })}</div>
    </div>
  );
}

export * from "./savedAccountCard";
