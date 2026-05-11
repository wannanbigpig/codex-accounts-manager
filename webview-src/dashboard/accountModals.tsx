import type { DashboardCopy, DashboardOAuthSessionDescriptor } from "../../src/domain/dashboard/types";
import type { CodexImportPreviewSummary, CodexImportResultSummary } from "../../src/core/types";
import { ImportPreviewPanel, ImportResultPanel, ModalShell } from "./components";
import { createShareFileName, formatTemplate, maskSharedJson } from "./helpers";
import { CopyIcon, DownloadIcon, EyeIcon, EyeOffIcon, GlobeIcon, ImportIcon, SuccessIcon } from "./icons";

const IMPORT_SINGLE_EXAMPLE = `{
  "tokens": {
    "id_token": "eyJ...",
    "access_token": "eyJ...",
    "refresh_token": "rt_..."
  }
}`;

const IMPORT_BATCH_EXAMPLE = `[
  {
    "id": "codex_demo_1",
    "email": "user@example.com",
    "tokens": {
      "id_token": "eyJ...",
      "access_token": "eyJ...",
      "refresh_token": "rt_..."
    },
    "created_at": 1730000000,
    "last_used": 1730000000
  }
]`;

export function AddAccountModal(props: {
  open: boolean;
  tab: "oauth" | "import";
  copy: DashboardCopy;
  oauthSession?: DashboardOAuthSessionDescriptor;
  oauthCallbackUrl: string;
  oauthError?: string;
  importJsonText: string;
  importJsonError?: string;
  importPreview?: CodexImportPreviewSummary;
  importResult?: CodexImportResultSummary;
  copyFeedbackKey: string | null;
  startOAuthAutoPending: boolean;
  completeOAuthPending: boolean;
  previewImportPending: boolean;
  importSharedPending: boolean;
  onClose: () => void;
  onSelectTab: (tab: "oauth" | "import") => void;
  onCopyOauthLink: () => void;
  onOpenInBrowser: () => void;
  onOauthCallbackChange: (value: string) => void;
  onCompleteOAuth: () => void;
  onImportFileSelected: (file: File) => void;
  onImportTextChange: (value: string) => void;
  onOpenSessionTokenPage: () => void;
  onPreviewImport: () => void;
  onSubmitImport: () => void;
}) {
  return (
    <ModalShell
      open={props.open}
      title={props.copy.addAccountModalTitle}
      closeLabel={props.copy.closeModal}
      className="dashboard-modal-compact"
      onClose={props.onClose}
    >
      <div class="modal-tabs" role="tablist" aria-label={props.copy.addAccountModalTitle}>
        <button
          class={`modal-tab ${props.tab === "oauth" ? "active" : ""}`}
          type="button"
          onClick={() => props.onSelectTab("oauth")}
        >
          <span class="modal-tab-icon" aria-hidden="true">
            <GlobeIcon />
          </span>
          {props.copy.oauthTab}
        </button>
        <button
          class={`modal-tab ${props.tab === "import" ? "active" : ""}`}
          type="button"
          onClick={() => props.onSelectTab("import")}
        >
          <span class="modal-tab-icon" aria-hidden="true">
            <ImportIcon />
          </span>
          {props.copy.importJsonTab}
        </button>
      </div>
      {props.tab === "oauth" ? (
        <div class="modal-stack">
          <div class="modal-field">
            <div class="modal-label">{props.copy.authorizationLink}</div>
            <div class="modal-input-row">
              <input
                class="modal-input"
                type="text"
                readOnly
                value={props.oauthSession?.authUrl ?? ""}
                placeholder={props.copy.authorizationLink}
              />
              <button
                class={`modal-mini-btn modal-icon-btn ${props.copyFeedbackKey === "oauth-link" ? "is-success" : ""}`}
                type="button"
                disabled={!props.oauthSession?.authUrl}
                aria-label={props.copyFeedbackKey === "oauth-link" ? props.copy.copySuccess : props.copy.copyLink}
                onClick={props.onCopyOauthLink}
              >
                {props.copyFeedbackKey === "oauth-link" ? <SuccessIcon /> : <CopyIcon />}
              </button>
            </div>
          </div>
          <button
            class="modal-primary-btn"
            type="button"
            disabled={!props.oauthSession?.authUrl || props.startOAuthAutoPending}
            onClick={props.onOpenInBrowser}
          >
            <span class="modal-btn-icon" aria-hidden="true">
              <GlobeIcon />
            </span>
            {props.startOAuthAutoPending ? "..." : props.copy.openInBrowser}
          </button>
          <div class="modal-field">
            <div class="modal-label">{props.copy.manualCallbackLabel}</div>
            <div class="modal-input-row">
              <input
                class="modal-input"
                type="text"
                value={props.oauthCallbackUrl}
                placeholder={props.copy.manualCallbackPlaceholder}
                onInput={(event) => props.onOauthCallbackChange(event.currentTarget.value)}
              />
              <button
                class="modal-secondary-btn"
                type="button"
                disabled={!props.oauthSession || !props.oauthCallbackUrl.trim() || props.completeOAuthPending}
                onClick={props.onCompleteOAuth}
              >
                {props.completeOAuthPending ? "..." : props.copy.authorizedContinue}
              </button>
            </div>
          </div>
          <div class="modal-note">{props.copy.oauthReadyHint}</div>
          {props.oauthError ? <div class="modal-error">{props.oauthError}</div> : null}
        </div>
      ) : (
        <div class="modal-stack">
          <div class="modal-note">{props.copy.importJsonHint}</div>
          <button class="modal-secondary-btn" type="button" onClick={props.onOpenSessionTokenPage}>
            <span class="modal-btn-icon" aria-hidden="true">
              <GlobeIcon />
            </span>
            {props.copy.importJsonOpenSessionToken}
          </button>
          <div class="modal-note">{props.copy.importJsonSessionHint}</div>
          <details class="modal-disclosure">
            <summary>{props.copy.importJsonExamplesSummary}</summary>
            <div class="modal-disclosure-body">
              <div class="modal-note">{props.copy.importJsonExamplesHint}</div>
              <div class="modal-example-block">
                <div class="modal-example-label">{props.copy.importJsonSingleExampleLabel}</div>
                <pre class="modal-example-code">{IMPORT_SINGLE_EXAMPLE}</pre>
              </div>
              <div class="modal-example-block">
                <div class="modal-example-label">{props.copy.importJsonBatchExampleLabel}</div>
                <pre class="modal-example-code">{IMPORT_BATCH_EXAMPLE}</pre>
              </div>
            </div>
          </details>
          <textarea
            class="modal-textarea"
            value={props.importJsonText}
            placeholder={props.copy.importJsonPlaceholder}
            onInput={(event) => props.onImportTextChange(event.currentTarget.value)}
          />
          {props.importPreview ? <ImportPreviewPanel copy={props.copy} summary={props.importPreview} /> : null}
          {props.importResult ? <ImportResultPanel copy={props.copy} summary={props.importResult} /> : null}
          {props.importJsonError ? <div class="modal-error">{props.importJsonError}</div> : null}
          <div class="modal-actions">
            <label class="modal-secondary-btn">
              <span class="modal-btn-icon" aria-hidden="true">
                <ImportIcon />
              </span>
              {props.copy.importJsonChooseFile}
              <input
                class="modal-file-input"
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) {
                    props.onImportFileSelected(file);
                  }
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <button
              class="modal-secondary-btn"
              type="button"
              disabled={!props.importJsonText.trim() || props.previewImportPending}
              onClick={props.onPreviewImport}
            >
              {props.previewImportPending ? "..." : props.copy.importJsonValidate}
            </button>
            <button
              class="modal-primary-btn"
              type="button"
              disabled={!props.importJsonText.trim() || !props.importPreview || props.importPreview.valid <= 0 || props.importSharedPending}
              onClick={props.onSubmitImport}
            >
              {!props.importSharedPending ? (
                <span class="modal-btn-icon" aria-hidden="true">
                  <ImportIcon />
                </span>
              ) : null}
              {props.importSharedPending ? "..." : props.copy.importJsonSubmit}
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

export function ConfirmCancelOauthModal(props: {
  open: boolean;
  copy: DashboardCopy;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalShell
      open={props.open}
      title={props.copy.addAccountModalTitle}
      closeLabel={props.copy.closeModal}
      className="dashboard-modal-compact dashboard-confirm-modal"
      onClose={props.onClose}
    >
      <div class="modal-stack">
        <div class="modal-note">{props.copy.cancelOauthConfirm}</div>
        <div class="modal-actions">
          <button class="modal-secondary-btn" type="button" onClick={props.onClose}>
            {props.copy.continueOauthBtn}
          </button>
          <button class="modal-primary-btn" type="button" onClick={props.onConfirm}>
            {props.copy.cancelOauthBtn}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function ShareTokenModal(props: {
  open: boolean;
  copy: DashboardCopy;
  selectedCount: number;
  shareModalJson: string;
  sharePreviewExpanded: boolean;
  copyFeedbackKey: string | null;
  downloadSharePending: boolean;
  onClose: () => void;
  onTogglePreview: () => void;
  onCopyJson: () => void;
  onDownloadJson: (filename: string, text: string) => void;
}) {
  const previewValue = props.sharePreviewExpanded ? props.shareModalJson : maskSharedJson(props.shareModalJson);

  return (
    <ModalShell
      open={props.open}
      title={props.copy.shareTokenModalTitle}
      closeLabel={props.copy.closeModal}
      className="dashboard-modal-wide"
      onClose={props.onClose}
    >
      <div class="modal-stack">
        <div class="modal-toolbar">
          <button
            class={`modal-toolbar-btn ${props.sharePreviewExpanded ? "active" : ""}`}
            type="button"
            onClick={props.onTogglePreview}
          >
            <span class="modal-btn-icon" aria-hidden="true">
              {props.sharePreviewExpanded ? <EyeOffIcon /> : <EyeIcon />}
            </span>
            {props.copy.jsonPreview}
          </button>
          <button
            class={`modal-toolbar-btn ${props.copyFeedbackKey === "share-json" ? "is-success" : ""}`}
            type="button"
            onClick={props.onCopyJson}
          >
            <span class="modal-btn-icon" aria-hidden="true">
              {props.copyFeedbackKey === "share-json" ? <SuccessIcon /> : <CopyIcon />}
            </span>
            {props.copyFeedbackKey === "share-json" ? props.copy.copySuccess : props.copy.copyJson}
          </button>
          <button
            class="modal-toolbar-btn"
            type="button"
            disabled={props.downloadSharePending}
            onClick={() => props.onDownloadJson(createShareFileName(), props.shareModalJson)}
          >
            <span class="modal-btn-icon" aria-hidden="true">
              <DownloadIcon />
            </span>
            {props.copy.downloadJson}
          </button>
        </div>
        <div class="modal-note">
          {formatTemplate(props.copy.shareSelectedCount, {
            count: props.selectedCount
          })}
        </div>
        <div class="modal-note">{props.copy.shareTokenModeHint}</div>
        <textarea class="modal-textarea share-preview" readOnly value={previewValue} />
      </div>
    </ModalShell>
  );
}
