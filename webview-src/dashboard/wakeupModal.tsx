import { useEffect, useState } from "preact/hooks";
import type { DashboardAccountViewModel, DashboardHostMessage, DashboardState } from "../../src/domain/dashboard/types";
import type { WakeupRun, WakeupSnapshot, WakeupTask, WakeupTaskInput } from "../../src/domain/wakeup/types";
import { resolveWakeupScheduleMode } from "../../src/domain/wakeup/schedule";
import { DEFAULT_WAKEUP_MODEL, DEFAULT_WAKEUP_PROMPT } from "../../src/domain/wakeup/types";
import { getSingleAccountWakeupTasks } from "../../src/domain/wakeup/accountScope";
import { getWakeupCopy } from "../../src/domain/wakeup/copy";
import { getSensitiveDisplayValue } from "./helpers";
import { ModalShell, ActionButton } from "./primitives";
import type { SendAction } from "./hookTypes";
import { EditIcon, renderRemoveIcon } from "./icons";

type ActionResult = Extract<DashboardHostMessage, { type: "dashboard:action-result" }>;
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
    scheduleMode: "daily",
    quotaResetWindow: "either",
    startupDelayMinutes: 0,
    intervalMinutes: 300,
    model: DEFAULT_WAKEUP_MODEL,
    effort: "low",
    prompt: DEFAULT_WAKEUP_PROMPT
  };
}

export function WakeupModal(props: {
  lang: DashboardState["lang"];
  accountId?: string;
  wakeup?: WakeupSnapshot;
  accounts: DashboardAccountViewModel[];
  privacyMode: boolean;
  onClose: () => void;
  sendAction: SendAction;
  pending: boolean;
  result?: ActionResult;
}) {
  const copy = getWakeupCopy(props.lang);
  const tasks = props.accountId
    ? getSingleAccountWakeupTasks(props.wakeup?.tasks ?? [], props.accountId)
    : (props.wakeup?.tasks ?? []);
  const initialTask = props.accountId && tasks.length === 1 ? tasks[0] : undefined;
  const createDraft = (): WakeupTaskInput => ({
    ...newDraft(),
    ...(props.accountId ? { accountIds: [props.accountId], name: copy.accountWakeup } : {})
  });
  const [view, setView] = useState<"tasks" | "edit" | "history">(
    props.accountId && tasks.length < 2 ? "edit" : "tasks"
  );
  const [draft, setDraft] = useState<WakeupTaskInput>(() =>
    initialTask
      ? {
          ...initialTask,
          scheduleMode: resolveWakeupScheduleMode(initialTask),
          accountIds: [...initialTask.accountIds],
          days: [...initialTask.days]
        }
      : createDraft()
  );
  const [customModelMode, setCustomModelMode] = useState(
    Boolean(initialTask && !MODEL_PRESETS.includes(initialTask.model))
  );
  const [customModelId, setCustomModelId] = useState(
    initialTask && !MODEL_PRESETS.includes(initialTask.model) ? initialTask.model : ""
  );
  const [intervalUnit, setIntervalUnit] = useState<"hours" | "minutes">(
    (initialTask?.intervalMinutes ?? 300) % 30 === 0 ? "hours" : "minutes"
  );
  const [search, setSearch] = useState("");
  const [formError, setFormError] = useState("");
  const [removeConfirm, setRemoveConfirm] = useState<string>();
  const [feedback, setFeedback] = useState<{ message: string; error: boolean }>();
  const state = props.wakeup;
  const history = (state?.history ?? []).filter(
    (run) =>
      !props.accountId ||
      tasks.some((task) => task.id === run.taskId) ||
      (run.results.length === 1 && run.results[0]?.accountId === props.accountId)
  );
  const currentTask = tasks.find((task) => task.id === draft.id);
  const lastRun = history.find((run) => run.taskId === draft.id);
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
    const value = task
      ? {
          ...task,
          scheduleMode: resolveWakeupScheduleMode(task),
          accountIds: [...task.accountIds],
          days: [...task.days]
        }
      : createDraft();
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
  const repeatLabel = (task: WakeupTask): string => {
    const mode = resolveWakeupScheduleMode(task);
    if (mode === "quota_reset") {
      return copy.quotaWindows[task.quotaResetWindow ?? "either"];
    }
    if (mode === "startup") {
      return copy.startup;
    }
    if (mode === "interval") {
      return copy.intervalSummary
        .replace(
          "{value}",
          String(task.intervalMinutes! % 60 === 0 ? task.intervalMinutes! / 60 : task.intervalMinutes)
        )
        .replace("{unit}", task.intervalMinutes! % 60 === 0 ? copy.hours : copy.minutes);
    }
    if (mode === "daily") {
      return copy.daily;
    }
    return task.days.length === 5 && [1, 2, 3, 4, 5].every((day) => task.days.includes(day))
      ? copy.weekdays
      : [1, 2, 3, 4, 5, 6, 0]
          .filter((day) => task.days.includes(day))
          .map((day) => copy.dayLabels[day])
          .join(" · ");
  };
  const nextLabel = (task: WakeupTask): string =>
    !task.enabled
      ? copy.taskPaused
      : task.nextRunAt > 0
        ? dateLabel(task.nextRunAt)
        : task.scheduleMode === "quota_reset"
          ? copy.waitingForQuota
          : task.scheduleMode === "startup"
            ? copy.waitingForStartup
            : copy.never;

  return (
    <ModalShell
      open
      title={view === "edit" ? (draft.id ? copy.edit : copy.create) : copy.title}
      closeLabel={copy.close}
      className={`wakeup-modal ${view === "tasks" ? "" : "wakeup-modal-compact"} ${view === "edit" ? "wakeup-modal-editor" : ""}`}
      onClose={props.onClose}
      footer={
        view === "edit" ? (
          <div class="wakeup-form-actions">
            <ActionButton
              class="modal-secondary-btn"
              onClick={() => (props.accountId ? props.onClose() : setView("tasks"))}
            >
              {copy.cancel}
            </ActionButton>
            <button type="submit" form="wakeup-task-form" class="modal-primary-btn" disabled={busy}>
              <span class="button-face">
                <span class="button-label">{copy.save}</span>
              </span>
            </button>
          </div>
        ) : undefined
      }
    >
      {view !== "edit" ? (
        <div class="wakeup-intro">
          <p>{copy.description}</p>
          <p class="wakeup-muted">{copy.note}</p>
          <span class="wakeup-timezone">
            {copy.localTime} · {state?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
          </span>
        </div>
      ) : null}
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
            <div class="modal-tabs wakeup-tabs" role="tablist" aria-label={copy.title}>
              <button
                type="button"
                role="tab"
                aria-selected={view === "tasks"}
                class={`modal-tab ${view === "tasks" ? "active" : ""}`}
                onClick={() => setView("tasks")}
              >
                {copy.tasks} <span>{tasks.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "history"}
                class={`modal-tab ${view === "history" ? "active" : ""}`}
                onClick={() => setView("history")}
              >
                {copy.history} <span>{history.length}</span>
              </button>
            </div>
            <div class="wakeup-toolbar-actions">
              <ActionButton class="modal-primary-btn" disabled={busy} onClick={() => edit()}>
                {copy.add}
              </ActionButton>
            </div>
          </div>
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
                          data-status={running ? "running" : task.enabled ? "success" : "cancelled"}
                        >
                          {running
                            ? copy.running
                            : !task.enabled
                              ? copy.taskPaused
                              : task.nextRunAt > 0
                                ? copy.waitingForRun
                                : nextLabel(task)}
                        </span>
                      </div>
                      <div class="wakeup-schedule">
                        <span class="wakeup-time">
                          {task.scheduleMode === "interval"
                            ? task.intervalMinutes! % 60 === 0
                              ? `${task.intervalMinutes! / 60}h`
                              : `${task.intervalMinutes}m`
                            : task.scheduleMode === "quota_reset"
                              ? copy.quotaReset
                              : task.scheduleMode === "startup"
                                ? `${task.startupDelayMinutes ?? 0}m`
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
                          {copy.next}: {nextLabel(task)}
                        </div>
                      </div>
                      <div class="wakeup-task-actions">
                        {removeConfirm === task.id ? (
                          <>
                            <ActionButton
                              class="modal-secondary-btn danger-btn"
                              disabled={busy}
                              onClick={() => props.sendAction("removeWakeupTask", undefined, { wakeupTaskId: task.id })}
                            >
                              {copy.confirmRemove}
                            </ActionButton>
                            <ActionButton class="modal-secondary-btn" onClick={() => setRemoveConfirm(undefined)}>
                              {copy.cancel}
                            </ActionButton>
                          </>
                        ) : (
                          <>
                            <ActionButton
                              class="modal-secondary-btn wakeup-run-btn"
                              disabled={busy || running}
                              pending={running}
                              onClick={() => props.sendAction("runWakeupTask", undefined, { wakeupTaskId: task.id })}
                            >
                              {running ? copy.running : copy.run}
                            </ActionButton>
                            <ActionButton
                              class="modal-mini-btn modal-icon-btn"
                              iconOnly
                              icon={<EditIcon />}
                              label={copy.edit}
                              disabled={busy}
                              onClick={() => edit(task)}
                            />
                            <ActionButton
                              class="modal-secondary-btn"
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
                              class="modal-mini-btn modal-icon-btn"
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
                <ActionButton class="modal-primary-btn" disabled={busy} onClick={() => edit()}>
                  {copy.add}
                </ActionButton>
              </div>
            )
          ) : history.length ? (
            <div class="wakeup-history-list">
              {history.map((run) => (
                <HistoryRow
                  key={run.id}
                  run={run}
                  lang={props.lang}
                  privacyMode={props.privacyMode}
                  emailLabel={emailLabel}
                  dateLabel={dateLabel}
                />
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
          id="wakeup-task-form"
          class="wakeup-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.accountIds.length) {
              setFormError(copy.accountSelectError);
              return;
            }
            if ((draft.scheduleMode === "weekly" || draft.scheduleMode === "calendar") && !draft.days.length) {
              setFormError(copy.selectError);
              return;
            }
            setFormError("");
            props.sendAction("saveWakeupTask", undefined, {
              wakeupTask: { ...draft, accountIds: props.accountId ? [props.accountId] : draft.accountIds }
            });
          }}
        >
          <div class="wakeup-target">
            <div class="wakeup-target-info">
              <div class="wakeup-target-label">{copy.target}</div>
              <div class="wakeup-target-title">
                {props.accountId
                  ? emailLabel(props.accountId)
                  : draft.accountIds.length
                    ? draft.accountIds.map(emailLabel).join(" · ")
                    : copy.accountSelectError}
              </div>
            </div>
            <div class="wakeup-segmented" role="group" aria-label={copy.automation}>
              <button
                type="button"
                class={`modal-secondary-btn ${draft.enabled ? "active" : ""}`}
                aria-pressed={draft.enabled}
                disabled={busy}
                onClick={() => patch({ enabled: true })}
              >
                {copy.enableTask}
              </button>
              <button
                type="button"
                class={`modal-secondary-btn ${!draft.enabled ? "active" : ""}`}
                aria-pressed={!draft.enabled}
                disabled={busy}
                onClick={() => patch({ enabled: false })}
              >
                {copy.disableTask}
              </button>
            </div>
          </div>
          <label class="modal-field">
            <span class="modal-label">{copy.name}</span>
            <input
              class="modal-input"
              required
              maxLength={80}
              placeholder={copy.namePlaceholder}
              value={draft.name}
              onInput={(event) => patch({ name: event.currentTarget.value })}
            />
          </label>
          <div class="modal-field">
            <span class="modal-label">{copy.schedule}</span>
            <div class="wakeup-segmented" role="group" aria-label={copy.schedule}>
              {(
                [
                  ["daily", copy.dailyMode],
                  ["weekly", copy.weeklyMode],
                  ["interval", copy.intervalMode],
                  ["quota_reset", copy.quotaReset],
                  ["startup", copy.startup]
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={draft.scheduleMode === mode}
                  class={`modal-secondary-btn ${draft.scheduleMode === mode ? "active" : ""}`}
                  onClick={() =>
                    patch({
                      scheduleMode: mode,
                      ...(mode === "weekly" && draft.days.length === 7 ? { days: [1, 2, 3, 4, 5] } : {}),
                      ...(mode === "quota_reset" ? { quotaResetWindow: draft.quotaResetWindow ?? "either" } : {}),
                      ...(mode === "startup" ? { startupDelayMinutes: draft.startupDelayMinutes ?? 0 } : {})
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {draft.scheduleMode === "quota_reset" ? (
            <>
              <label class="modal-field">
                <span class="modal-label">{copy.quotaResetWindow}</span>
                <select
                  class="modal-input"
                  aria-label={copy.quotaResetWindow}
                  value={draft.quotaResetWindow ?? "either"}
                  onChange={(event) =>
                    patch({ quotaResetWindow: event.currentTarget.value as WakeupTaskInput["quotaResetWindow"] })
                  }
                >
                  {(["either", "hourly", "weekly"] as const).map((window) => (
                    <option key={window} value={window}>
                      {copy.quotaWindows[window]}
                    </option>
                  ))}
                </select>
              </label>
              <p class="wakeup-muted">{copy.quotaResetHint}</p>
            </>
          ) : draft.scheduleMode === "startup" ? (
            <>
              <label class="modal-field">
                <span class="modal-label">{copy.startupDelay}</span>
                <input
                  class="modal-input"
                  type="number"
                  required
                  min={0}
                  max={1440}
                  step={1}
                  value={draft.startupDelayMinutes ?? 0}
                  onInput={(event) => patch({ startupDelayMinutes: Number(event.currentTarget.value) })}
                />
              </label>
              <p class="wakeup-muted">{copy.startupHint}</p>
            </>
          ) : null}
          {draft.scheduleMode === "interval" ? (
            <>
              <label class="modal-field">
                <span class="modal-label">{copy.intervalValue}</span>
                <div class="wakeup-interval-input">
                  <input
                    class="modal-input"
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
                    class="modal-input"
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
          ) : draft.scheduleMode === "daily" || draft.scheduleMode === "weekly" || draft.scheduleMode === "calendar" ? (
            <div class={`wakeup-calendar-grid ${draft.scheduleMode === "daily" ? "wakeup-daily-time" : ""}`}>
              <label class="modal-field">
                <span class="modal-label">{copy.time}</span>
                <input
                  class="modal-input"
                  type="time"
                  required
                  value={draft.time}
                  onInput={(event) => patch({ time: event.currentTarget.value })}
                />
              </label>
              {draft.scheduleMode !== "daily" ? (
                <div class="modal-field">
                  <span class="modal-label">{copy.days}</span>
                  <div class="wakeup-days">
                    <button
                      type="button"
                      class={`modal-secondary-btn ${draft.days.length === 7 ? "active" : ""}`}
                      onClick={() => patch({ days: [0, 1, 2, 3, 4, 5, 6] })}
                    >
                      {copy.daily}
                    </button>
                    <button
                      type="button"
                      class={`modal-secondary-btn ${
                        draft.days.length === 5 && [1, 2, 3, 4, 5].every((day) => draft.days.includes(day))
                          ? "active"
                          : ""
                      }`}
                      onClick={() => patch({ days: [1, 2, 3, 4, 5] })}
                    >
                      {copy.weekdays}
                    </button>
                    {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={draft.days.includes(day)}
                        class={`modal-secondary-btn ${draft.days.includes(day) ? "active" : ""}`}
                        onClick={() =>
                          patch({
                            days: draft.days.includes(day)
                              ? draft.days.filter((item) => item !== day)
                              : [...draft.days, day]
                          })
                        }
                      >
                        {copy.dayLabels[day]}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {!props.accountId ? (
            <div class="modal-field">
              <div class="wakeup-account-heading">
                <span>
                  {copy.accounts} · {draft.accountIds.length}
                </span>
                <div>
                  <button
                    class="modal-secondary-btn"
                    type="button"
                    onClick={() =>
                      patch({
                        accountIds: [
                          ...new Set([...draft.accountIds, ...filteredAccounts.map((account) => account.id)])
                        ]
                      })
                    }
                  >
                    {copy.selectAll}
                  </button>
                  <button class="modal-secondary-btn" type="button" onClick={() => patch({ accountIds: [] })}>
                    {copy.clear}
                  </button>
                </div>
              </div>
              <input
                class="modal-input"
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
          ) : null}
          <div class="wakeup-form-row">
            <label class="modal-field">
              <span class="modal-label">{copy.model}</span>
              <select
                class="modal-input"
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
              <span class="modal-label">{copy.effort}</span>
              <select
                class="modal-input"
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
              <span class="modal-label">{copy.modelId}</span>
              <input
                class="modal-input"
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
            <span class="modal-label">{copy.prompt}</span>
            <textarea
              class="modal-textarea"
              required
              maxLength={500}
              rows={2}
              value={draft.prompt}
              onInput={(event) => patch({ prompt: event.currentTarget.value })}
            />
          </label>
          {currentTask ? (
            <div class="wakeup-form-overview">
              <div>
                <span>{copy.last}</span>
                <strong>{dateLabel(lastRun?.startedAt)}</strong>
              </div>
              <div>
                <span>{copy.next}</span>
                <strong>{nextLabel(currentTask)}</strong>
              </div>
              {lastRun ? (
                <div>
                  <span>{copy.history}</span>
                  <strong>{copy.statuses[lastRun.status]}</strong>
                </div>
              ) : null}
            </div>
          ) : null}
          <p class="wakeup-muted">
            {copy.note} {copy.localTime} · {state?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
          </p>
          {formError ? (
            <div class="modal-error" role="alert">
              {formError}
            </div>
          ) : null}
        </form>
      )}
    </ModalShell>
  );
}

function HistoryRow(props: {
  run: WakeupRun;
  privacyMode: boolean;
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
        {run.model ? (
          <span>
            {run.model} · {run.effort ?? "—"}
          </span>
        ) : null}
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
                <div class="wakeup-result-meta">
                  {result.durationMs !== undefined ? (
                    <span>
                      {copy.duration} · {(result.durationMs / 1000).toFixed(1)}s
                    </span>
                  ) : null}
                  {result.model && result.model !== run.model ? <span>{result.model}</span> : null}
                  {result.errorStage ? (
                    <span>
                      {copy.stages[result.errorStage]}
                      {result.httpStatus ? ` · HTTP ${result.httpStatus}` : ""}
                    </span>
                  ) : null}
                </div>
                {result.reply ? (
                  <p class="wakeup-reply">
                    <span>{copy.reply}</span> {props.privacyMode ? "•••" : result.reply}
                  </p>
                ) : null}
                {result.message ? <p>{result.message}</p> : null}
                {result.quotaWarning ? (
                  <p class="wakeup-quota-warning">
                    {copy.quotaWarning}: {result.quotaWarning}
                  </p>
                ) : null}
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
