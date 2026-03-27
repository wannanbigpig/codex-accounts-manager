import type { DashboardCopy } from "../../src/domain/dashboard/types";
import type { CodexImportPreviewSummary, CodexImportResultSummary } from "../../src/core/types";

export function ImportPreviewPanel(props: { copy: DashboardCopy; summary: CodexImportPreviewSummary }) {
  return (
    <div class="modal-summary-card">
      <div class="modal-summary-title">{props.copy.importJsonSummaryTitle}</div>
      <div class="modal-summary-grid">
        <span>{props.copy.importJsonSummaryTotal}: {props.summary.total}</span>
        <span>{props.copy.importJsonSummaryValid}: {props.summary.valid}</span>
        <span>{props.copy.importJsonSummaryOverwrite}: {props.summary.overwriteCount}</span>
        <span>{props.copy.importJsonSummaryInvalid}: {props.summary.invalidCount}</span>
      </div>
      {props.summary.invalidEntries.length ? (
        <div class="modal-summary-list">
          <div class="modal-summary-list-title">{props.copy.importJsonSummaryFailures}</div>
          {props.summary.invalidEntries.map((entry) => (
            <div key={`${entry.index}-${entry.email ?? entry.accountId ?? entry.message}`} class="modal-summary-item">
              #{entry.index + 1} {entry.email ?? entry.accountId ?? "unknown"} · {entry.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ImportResultPanel(props: { copy: DashboardCopy; summary: CodexImportResultSummary }) {
  return (
    <div class="modal-summary-card is-success">
      <div class="modal-summary-title">{props.copy.importJsonResultsTitle}</div>
      <div class="modal-summary-grid">
        <span>{props.copy.importJsonResultsSuccess}: {props.summary.successCount}</span>
        <span>{props.copy.importJsonResultsOverwrite}: {props.summary.overwriteCount}</span>
        <span>{props.copy.importJsonResultsFailed}: {props.summary.failedCount}</span>
      </div>
      {props.summary.failures.length ? (
        <div class="modal-summary-list">
          {props.summary.failures.map((entry) => (
            <div key={`${entry.index}-${entry.email ?? entry.accountId ?? entry.message}`} class="modal-summary-item">
              #{entry.index + 1} {entry.email ?? entry.accountId ?? "unknown"} · {entry.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
