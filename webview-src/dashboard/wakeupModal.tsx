import { useEffect, useState } from "preact/hooks";
import type { DashboardAccountViewModel, DashboardHostMessage, DashboardState } from "../../src/domain/dashboard/types";
import type { WakeupRun, WakeupSnapshot, WakeupTask, WakeupTaskInput } from "../../src/domain/wakeup/types";
import { DEFAULT_WAKEUP_MODEL, DEFAULT_WAKEUP_PROMPT } from "../../src/domain/wakeup/types";
import { getWakeupCopy } from "../../src/domain/wakeup/copy";
import { getSensitiveDisplayValue } from "./helpers";
import { ModalShell, ActionButton } from "./primitives";
import type { SendAction } from "./hookTypes";
import { EditTagsIcon, renderRemoveIcon } from "./icons";

type ActionResult = Extract<DashboardHostMessage, { type: "dashboard:action-result" }>;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MODEL_PRESETS = [
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol"
];
const CUSTOM_MODEL = "__custom__";

function newDraft(): WakeupTaskInput {
  return {
    name: "",
    enabled: true,
    accountIds: [],
    time: "06:15",
    days: [0, 1, 2, 3, 4, 5, 6],
    scheduleMode: "calendar",
    intervalMinutes: 300,
    model: DEFAULT_WAKEUP_MODEL,
    effort: "low",
    prompt: DEFAULT_WAKEUP_PROMPT
  };
}

export function WakeupModal(props: {
  lang: DashboardState["lang"];
  wakeup?: WakeupSnapshot;
  accounts: DashboardAccountViewModel[];
  privacyMode: boolean;
  onClose: () => void;
  sendAction: SendAction;
  pending: boolean;
  result?: ActionResult;
}) {
  const copy = getWakeupCopy(props.lang);
  const [view, setView] = useState<"tasks" | "edit" | "history">("tasks");
  const [draft, setDraft] = useState<WakeupTaskInput>(newDraft);
  const [customModelMode, setCustomModelMode] = useState(false);
  const [customModelId, setCustomModelId] = useState("");
  const [intervalUnit, setIntervalUnit] = useState<"hours" | "minutes">("hours");
  const [search, setSearch] = useState("");
  const [formError, setFormError] = useState("");
  const [removeConfirm, setRemoveConfirm] = useState<string>();
  const [feedback, setFeedback] = useState<{ message: string; error: boolean }>();
  const state = props.wakeup;
  const tasks = state?.tasks ?? [];
  const history = state?.history ?? [];
  const busy = props.pending || Boolean(state?.storageError) || !state;
  const dateLabel = (at?: number): string =>
    at
      ? new Date(at).toLocaleString(props.lang.startsWith("zh") ? "zh-CN" : "en-GB", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        })
      : copy.never;
  const emailLabel = (id: string): string => {
    const account = props.accounts.find((item) => item.id === id);
    return account
      ? getSensitiveDisplayValue(account.email, props.privacyMode, "email")
      : props.privacyMode
        ? "•••"
        : id;
  };

  useEffect(() => {
    const result = props.result;
    if (!result) {
      return;
    }
    if (result.status === "failed") {
      setFeedback({ message: result.error ?? "Wakeup action failed", error: true });
    } else {
      setFeedback({
        message:
          result.action === "saveWakeupTask"
            ? copy.saved
            : result.action === "runWakeupTask"
              ? copy.runFinished
              : copy.updated,
        error: false
      });
      if (result.action === "saveWakeupTask") {
        setView("tasks");
      }
      if (result.action === "removeWakeupTask") {
        setRemoveConfirm(undefined);
      }
    }
  }, [props.result]);

  const edit = (task?: WakeupTask): void => {
    const value = task ? { ...task, accountIds: [...task.accountIds], days: [...task.days] } : newDraft();
    setDraft(value);
    setCustomModelMode(!MODEL_PRESETS.includes(value.model));
    setCustomModelId(MODEL_PRESETS.includes(value.model) ? "" : value.model);
    setIntervalUnit((value.intervalMinutes ?? 300) % 30 === 0 ? "hours" : "minutes");
    setSearch("");
    setFormError("");
    setFeedback(undefined);
    setView("edit");
  };
  const patch = (update: Partial<WakeupTaskInput>): void => setDraft((value) => ({ ...value, ...update }));
  const filteredAccounts = props.accounts.filter((account) => {
    const query = search.trim().toLowerCase();
    const visibleEmail = getSensitiveDisplayValue(account.email, props.privacyMode, "email");
    return (
      !query ||
      visibleEmail.toLowerCase().includes(query) ||
      account.tags.some((tag) => tag.toLowerCase().includes(query))
    );
  });
  const repeatLabel = (task: WakeupTask): string =>
    task.scheduleMode === "interval"
      ? copy.intervalSummary
          .replace(
            "{value}",
            String(task.intervalMinutes! % 60 === 0 ? task.intervalMinutes! / 60 : task.intervalMinutes)
          )
          .replace("{unit}", task.intervalMinutes! % 60 === 0 ? copy.hours : copy.minutes)
      : `${
          task.days.length === 7
            ? copy.daily
            : task.days.length === 5 && [1, 2, 3, 4, 5].every((day) => task.days.includes(day))
              ? copy.weekdays
              : [1, 2, 3, 4, 5, 6, 0]
                  .filter((day) => task.days.includes(day))
                  .map((day) => DAY_LABELS[day])
                  .join(" · ")
        }`;

  return (
    <ModalShell
      open
      title={view === "edit" ? (draft.id ? copy.edit : copy.create) : copy.title}
      closeLabel={copy.close}
      className={`wakeup-modal ${view === "tasks" ? "" : "wakeup-modal-compact"}`}
      onClose={props.onClose}
    >
      <div class="wakeup-intro">
        <p>{copy.description}</p>
        <p class="wakeup-muted">{copy.note}</p>
        <span class="wakeup-timezone">
          {copy.localTime} · {state?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
        </span>
      </div>
      {state?.storageError ? (
        <div class="modal-error" role="alert">
          {state.storageError}
        </div>
      ) : null}
      {feedback ? (
        <div class={feedback.error ? "modal-error" : "wakeup-feedback"} role={feedback.error ? "alert" : "status"}>
          {feedback.message}
        </div>
      ) : null}
      {view !== "edit" ? (
        <>
          <div class="wakeup-toolbar">
            <div class="wakeup-tabs" role="tablist" aria-label={copy.title}>
              <button
                type="button"
                role="tab"
                aria-selected={view === "tasks"}
                class={view === "tasks" ? "active" : ""}
                onClick={() => setView("tasks")}
              >
                {copy.tasks} <span>{tasks.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "history"}
                class={view === "history" ? "active" : ""}
                onClick={() => setView("history")}
              >
                {copy.history} <span>{history.length}</span>
              </button>
            </div>
            <div class="wakeup-toolbar-actions">
              <span class="wakeup-master-label">{copy.automation}</span>
              <button
                class={`settings-inline-toggle ${state?.enabled ? "active" : ""}`}
                type="button"
                role="switch"
                aria-checked={Boolean(state?.enabled)}
                aria-label={copy.automation}
                title={state?.enabled ? copy.pauseAll : copy.enableAll}
                disabled={busy}
                onClick={() => props.sendAction("setWakeupEnabled", undefined, { enabled: !state?.enabled })}
              >
                <span class="settings-inline-toggle-track">
                  <span class="settings-inline-toggle-thumb"></span>
                </span>
              </button>
              <span class="wakeup-muted">{state?.enabled ? copy.enabled : copy.disabled}</span>
              <ActionButton class="primary-btn" disabled={busy} onClick={() => edit()}>
                {copy.add}
              </ActionButton>
            </div>
          </div>
          {!state?.enabled && tasks.length ? <div class="settings-note">{copy.pausedHint}</div> : null}
          {view === "tasks" ? (
            tasks.length ? (
              <div class="wakeup-task-list">
                {tasks.map((task) => {
                  const lastRun = history.find((run) => run.taskId === task.id);
                  const running = history.some((run) => run.taskId === task.id && run.status === "running");
                  return (
                    <article
                      class={`wakeup-task ${task.enabled ? "" : "paused"} ${running ? "is-running" : ""}`}
                      key={task.id}
                    >
                      <div class="wakeup-task-header">
                        <h3 title={task.name}>{task.name}</h3>
                        <span
                          class="wakeup-status"
                          data-status={running ? "running" : task.enabled && state?.enabled ? "success" : "cancelled"}
                        >
                          {running
                            ? copy.running
                            : !task.enabled
                              ? copy.taskPaused
                              : state?.enabled
                                ? copy.waitingForRun
                                : copy.waitingForEnable}
                        </span>
                      </div>
                      <div class="wakeup-schedule">
                        <span class="wakeup-time">
                          {task.scheduleMode === "interval"
                            ? task.intervalMinutes! % 60 === 0
                              ? `${task.intervalMinutes! / 60}h`
                              : `${task.intervalMinutes}m`
                            : task.time}
                        </span>
                        <div class="wakeup-repeat">
                          <ClockIcon />
                          <span>{repeatLabel(task)}</span>
                        </div>
                      </div>
                      <div class="wakeup-task-accounts" title={task.accountIds.map(emailLabel).join(", ")}>
                        <div class="wakeup-accounts-caption">
                          {copy.accounts}
                          <span>
                            {task.accountIds.length} {copy.accountCount}
                          </span>
                        </div>
                        <div class="wakeup-selected-accounts">
                          {task.accountIds.slice(0, 3).map((id) => (
                            <span key={id} title={emailLabel(id)}>
                              {emailLabel(id)}
                            </span>
                          ))}
                          {task.accountIds.length > 3 ? (
                            <span class="wakeup-muted">+{task.accountIds.length - 3}</span>
                          ) : null}
                        </div>
                      </div>
                      <div class="wakeup-task-meta">
                        <span class="wakeup-model" title={task.model}>
                          {task.model}
                        </span>
                        <span>{task.effort}</span>
                      </div>
                      <div class="wakeup-run-summary">
                        <div>
                          {copy.last}: {dateLabel(lastRun?.startedAt)}{" "}
                          {lastRun ? (
                            <span class="wakeup-status" data-status={lastRun.status}>
                              {copy.statuses[lastRun.status]}
                            </span>
                          ) : null}
                        </div>
                        <div>
                          {copy.next}:{" "}
                          {!task.enabled
                            ? copy.taskPaused
                            : state?.enabled
                              ? dateLabel(task.nextRunAt)
                              : copy.automationOff}
                        </div>
                      </div>
                      <div class="wakeup-task-actions">
                        {removeConfirm === task.id ? (
                          <>
                            <ActionButton
                              class="danger-btn"
                              disabled={busy}
                              onClick={() => props.sendAction("removeWakeupTask", undefined, { wakeupTaskId: task.id })}
                            >
                              {copy.confirmRemove}
                            </ActionButton>
                            <ActionButton onClick={() => setRemoveConfirm(undefined)}>{copy.cancel}</ActionButton>
                          </>
                        ) : (
                          <>
                            <ActionButton
                              class="wakeup-run-btn"
                              disabled={busy || running}
                              pending={running}
                              onClick={() => props.sendAction("runWakeupTask", undefined, { wakeupTaskId: task.id })}
                            >
                              {running ? copy.running : copy.run}
                            </ActionButton>
                            <ActionButton
                              iconOnly
                              icon={<EditTagsIcon />}
                              label={copy.edit}
                              disabled={busy}
                              onClick={() => edit(task)}
                            />
                            <ActionButton
                              disabled={busy}
                              onClick={() =>
                                props.sendAction("toggleWakeupTask", undefined, {
                                  wakeupTaskId: task.id,
                                  enabled: !task.enabled
                                })
                              }
                            >
                              {task.enabled ? copy.pause : copy.resume}
                            </ActionButton>
                            <ActionButton
                              iconOnly
                              icon={renderRemoveIcon()}
                              label={copy.remove}
                              disabled={busy}
                              onClick={() => setRemoveConfirm(task.id)}
                            />
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div class="wakeup-empty">
                <ClockIcon />
                <h3>{copy.empty}</h3>
                <p>{copy.emptyHint}</p>
                <ActionButton class="primary-btn" disabled={busy} onClick={() => edit()}>
                  {copy.add}
                </ActionButton>
              </div>
            )
          ) : history.length ? (
            <div class="wakeup-history-list">
              {history.map((run) => (
                <HistoryRow key={run.id} run={run} lang={props.lang} emailLabel={emailLabel} dateLabel={dateLabel} />
              ))}
            </div>
          ) : (
            <div class="wakeup-empty">
              <p>{copy.noHistory}</p>
            </div>
          )}
        </>
      ) : (
        <form
          class="wakeup-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.accountIds.length) {
              setFormError(copy.accountSelectError);
              return;
            }
            if (draft.scheduleMode !== "interval" && !draft.days.length) {
              setFormError(copy.selectError);
              return;
            }
            setFormError("");
            props.sendAction("saveWakeupTask", undefined, { wakeupTask: draft });
          }}
        >
          <div class="wakeup-form-row">
            <label class="modal-field">
              <span>{copy.name}</span>
              <input
                required
                maxLength={80}
                placeholder={copy.namePlaceholder}
                value={draft.name}
                onInput={(event) => patch({ name: event.currentTarget.value })}
              />
            </label>
            <label class="modal-field">
              <span>{copy.schedule}</span>
              <select
                aria-label={copy.schedule}
                value={draft.scheduleMode ?? "calendar"}
                onChange={(event) => patch({ scheduleMode: event.currentTarget.value as "calendar" | "interval" })}
              >
                <option value="calendar">{copy.calendar}</option>
                <option value="interval">{copy.interval}</option>
              </select>
            </label>
          </div>
          {draft.scheduleMode === "interval" ? (
            <>
              <label class="modal-field">
                <span>{copy.intervalValue}</span>
                <div class="wakeup-interval-input">
                  <input
                    type="number"
                    required
                    aria-label={copy.intervalValue}
                    min={intervalUnit === "hours" ? 0.5 : 1}
                    max={intervalUnit === "hours" ? 168 : 10_080}
                    step={intervalUnit === "hours" ? 0.5 : 1}
                    value={(draft.intervalMinutes ?? 300) / (intervalUnit === "hours" ? 60 : 1)}
                    onInput={(event) =>
                      patch({
                        intervalMinutes: Number(event.currentTarget.value) * (intervalUnit === "hours" ? 60 : 1)
                      })
                    }
                  />
                  <select
                    aria-label={copy.intervalUnit}
                    value={intervalUnit}
                    onChange={(event) => setIntervalUnit(event.currentTarget.value as "hours" | "minutes")}
                  >
                    <option value="hours">{copy.hours}</option>
                    <option value="minutes">{copy.minutes}</option>
                  </select>
                </div>
              </label>
              <p class="wakeup-muted">{copy.intervalHint}</p>
            </>
          ) : (
            <>
              <label class="modal-field">
                <span>{copy.time}</span>
                <input
                  type="time"
                  required
                  value={draft.time}
                  onInput={(event) => patch({ time: event.currentTarget.value })}
                />
              </label>
              <div class="modal-field">
                <span>{copy.days}</span>
                <div class="wakeup-days">
                  <button
                    type="button"
                    class={draft.days.length === 7 ? "active" : ""}
                    onClick={() => patch({ days: [0, 1, 2, 3, 4, 5, 6] })}
                  >
                    {copy.daily}
                  </button>
                  <button
                    type="button"
                    class={
                      draft.days.length === 5 && [1, 2, 3, 4, 5].every((day) => draft.days.includes(day))
                        ? "active"
                        : ""
                    }
                    onClick={() => patch({ days: [1, 2, 3, 4, 5] })}
                  >
                    {copy.weekdays}
                  </button>
                  {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={draft.days.includes(day)}
                      class={draft.days.includes(day) ? "active" : ""}
                      onClick={() =>
                        patch({
                          days: draft.days.includes(day)
                            ? draft.days.filter((item) => item !== day)
                            : [...draft.days, day]
                        })
                      }
                    >
                      {DAY_LABELS[day]}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          <div class="modal-field">
            <div class="wakeup-account-heading">
              <span>
                {copy.accounts} · {draft.accountIds.length}
              </span>
              <div>
                <button
                  type="button"
                  onClick={() =>
                    patch({
                      accountIds: [...new Set([...draft.accountIds, ...filteredAccounts.map((account) => account.id)])]
                    })
                  }
                >
                  {copy.selectAll}
                </button>
                <button type="button" onClick={() => patch({ accountIds: [] })}>
                  {copy.clear}
                </button>
              </div>
            </div>
            <input
              type="search"
              aria-label={copy.search}
              placeholder={copy.search}
              value={search}
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
            <div class="wakeup-account-list">
              {filteredAccounts.length ? (
                filteredAccounts.map((account) => (
                  <label
                    key={account.id}
                    class={`wakeup-account-option ${draft.accountIds.includes(account.id) ? "selected" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={draft.accountIds.includes(account.id)}
                      onChange={(event) =>
                        patch({
                          accountIds: event.currentTarget.checked
                            ? [...draft.accountIds, account.id]
                            : draft.accountIds.filter((id) => id !== account.id)
                        })
                      }
                    />
                    <div>
                      <span class="wakeup-account-email" title={emailLabel(account.id)}>
                        {emailLabel(account.id)}
                      </span>
                      <div class="wakeup-account-quota">
                        {account.metrics
                          .filter((metric) => metric.visible && (metric.key === "hourly" || metric.key === "weekly"))
                          .map((metric) => `${metric.label} ${metric.percentage ?? "--"}%`)
                          .join(" · ")}
                      </div>
                    </div>
                    <span class="pill plan">{account.planTypeLabel}</span>
                  </label>
                ))
              ) : (
                <p class="wakeup-muted">{copy.noAccounts}</p>
              )}
            </div>
          </div>
          <div class="wakeup-form-row">
            <label class="modal-field">
              <span>{copy.model}</span>
              <select
                aria-label={copy.model}
                value={customModelMode ? CUSTOM_MODEL : draft.model}
                onChange={(event) => {
                  const model = event.currentTarget.value;
                  setCustomModelMode(model === CUSTOM_MODEL);
                  patch({ model: model === CUSTOM_MODEL ? customModelId : model });
                }}
              >
                {MODEL_PRESETS.map((model) => (
                  <option value={model} key={model}>
                    {model}
                  </option>
                ))}
                <option value={CUSTOM_MODEL}>{copy.customModel}</option>
              </select>
            </label>
            <label class="modal-field">
              <span>{copy.effort}</span>
              <select
                aria-label={copy.effort}
                value={draft.effort}
                onChange={(event) => patch({ effort: event.currentTarget.value as WakeupTaskInput["effort"] })}
              >
                {["low", "medium", "high"].map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {customModelMode ? (
            <label class="modal-field">
              <span>{copy.modelId}</span>
              <input
                required
                maxLength={100}
                pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]*"
                placeholder="gpt-6-luna"
                value={draft.model}
                onInput={(event) => {
                  setCustomModelId(event.currentTarget.value);
                  patch({ model: event.currentTarget.value });
                }}
              />
            </label>
          ) : null}
          <p class="wakeup-muted">{copy.modelHint}</p>
          {/^gpt-5\.5(?:$|-)/.test(draft.model.trim()) ? (
            <p class="wakeup-model-warning" role="status">
              {copy.modelRetirement}
            </p>
          ) : null}
          <label class="modal-field">
            <span>{copy.prompt}</span>
            <textarea
              required
              maxLength={500}
              rows={2}
              value={draft.prompt}
              onInput={(event) => patch({ prompt: event.currentTarget.value })}
            />
          </label>
          {formError ? (
            <div class="modal-error" role="alert">
              {formError}
            </div>
          ) : null}
          <div class="wakeup-form-actions">
            <ActionButton onClick={() => setView("tasks")}>{copy.cancel}</ActionButton>
            <button type="submit" class="action-btn primary-btn" disabled={busy}>
              <span class="button-face">
                <span class="button-label">{copy.save}</span>
              </span>
            </button>
          </div>
        </form>
      )}
    </ModalShell>
  );
}

function HistoryRow(props: {
  run: WakeupRun;
  lang: DashboardState["lang"];
  emailLabel: (id: string) => string;
  dateLabel: (at?: number) => string;
}) {
  const copy = getWakeupCopy(props.lang);
  const run = props.run;
  const success = run.results.filter((item) => item.status === "success").length;
  const failed = run.results.filter((item) => item.status === "failed").length;
  return (
    <article class="wakeup-history-row">
      <div class="wakeup-task-header">
        <strong>{run.taskName}</strong>
        <span class="wakeup-status" data-status={run.status}>
          {copy.statuses[run.status]}
        </span>
      </div>
      <div class="wakeup-task-meta">
        <span>
          {props.dateLabel(run.startedAt)} · {run.trigger === "manual" ? copy.manual : copy.scheduled}
        </span>
        <span>{run.finishedAt ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s` : "—"}</span>
      </div>
      {run.results.length ? (
        <details>
          <summary>
            {copy.details}: {success} {copy.success} · {failed} {copy.failed}
          </summary>
          <div class="wakeup-results">
            {run.results.map((result) => (
              <div key={result.accountId}>
                <span title={props.emailLabel(result.accountId)}>{props.emailLabel(result.accountId)}</span>
                <span class="wakeup-status" data-status={result.status}>
                  {copy.statuses[result.status]}
                </span>
                {result.message ? <p>{result.message}</p> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

export function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
