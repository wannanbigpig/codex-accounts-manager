import { fetch as undiciFetch } from "undici";
import type { CodexTokens } from "../core/types";
import type { WakeupTaskInput, WakeupExecutionResult } from "../domain/wakeup/types";
import { sanitizeWakeupText, WakeupRequestError } from "../domain/wakeup/diagnostics";
import { CODEX_API_BASE } from "../infrastructure/config/apiEndpoints";
import { CodexProxyConfigurationError, getCodexProxyDispatcher } from "../infrastructure/config/proxyEnvironment";

const RESPONSE_FAILURE_EVENTS = new Set([
  "error", "response.error", "response.failed", "response.incomplete", "response.cancelled", "response.canceled"
]);
const RESPONSE_FAILURE_STATUSES = new Set(["failed", "incomplete", "cancelled", "canceled"]);
const MAX_REPLY_LENGTH = 4096;

/** A single short conversation, following Cockpit's direct OAuth wakeup request. No tools or auth.json switching. */
export async function sendWakeupRequest(
  tokens: CodexTokens,
  task: Pick<WakeupTaskInput, "model" | "effort" | "prompt">,
  signal: AbortSignal,
  options: { endpoint?: string; timeoutMs?: number } = {}
): Promise<WakeupExecutionResult> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000);
  let stage: "request" | "stream" = "request";
  try {
    const endpoint = options.endpoint ?? `${CODEX_API_BASE}/backend-api/codex/responses`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokens.accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: "codex_vscode"
    };
    if (tokens.accountId) {
      headers["ChatGPT-Account-Id"] = tokens.accountId;
    }
    const init = {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: task.model,
        instructions: "",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: task.prompt }] }],
        reasoning: { effort: task.effort, summary: "auto" },
        include: ["reasoning.encrypted_content"],
        store: false,
        stream: true
      })
    };
    const dispatcher = getCodexProxyDispatcher();
    const response = dispatcher ? await undiciFetch(endpoint, { ...init, dispatcher }) : await fetch(endpoint, init);
    if (!response.ok) {
      await response.body?.cancel();
      throw new WakeupRequestError(`Codex wakeup request failed (HTTP ${response.status})`, "request", response.status);
    }
    if (!response.body) {
      throw new WakeupRequestError("Codex wakeup returned an empty response", "request");
    }
    const reader = response.body.getReader();
    stage = "stream";
    const decoder = new TextDecoder();
    let pending = "";
    let bytes = 0;
    let streamedText = "";
    let finalizedText = "";
    let finalizedItemText = "";
    let completion: WakeupExecutionResult | undefined;
    const processFrame = (frame: string): void => {
      const lines: string[] = [];
      let declaredType: string | undefined;
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("data:")) {
          lines.push(line.slice(5).trimStart());
        } else if (line.startsWith("event:")) {
          declaredType = line.slice(6).trim();
        }
      }
      if (RESPONSE_FAILURE_EVENTS.has(declaredType ?? "")) {
        throw streamFailure();
      }
      const data = lines.join("\n").trim();
      if (!data || data === "[DONE]") {
        return;
      }
      const event = parseStreamEvent(data);
      const payloadType = readString(event["type"])?.trim();
      const type = payloadType === "" ? declaredType : payloadType ?? declaredType;
      const result = readRecord(event["response"]) ?? event;
      const { status: rawStatus, error: resultError, output, model } = result;
      const status = readString(rawStatus);
      if (
        RESPONSE_FAILURE_EVENTS.has(type ?? "") ||
        RESPONSE_FAILURE_STATUSES.has(status ?? "") ||
        RESPONSE_FAILURE_STATUSES.has(readString(event["status"]) ?? "") ||
        event["error"] != null ||
        resultError != null
      ) {
        throw streamFailure();
      }

      switch (type) {
        case "response.output_text.delta":
          streamedText = appendReply(streamedText, readString(event["delta"]));
          break;
        case "response.output_text.done":
          finalizedText = appendReply(finalizedText, readString(event["text"]), "\n");
          break;
        case "response.output_item.done":
          finalizedItemText = appendReply(finalizedItemText, readItemText(event["item"]), "\n");
          break;
        case "response.completed":
        case "response.done": {
          if ((type === "response.done" || rawStatus !== undefined) && status !== "completed") {
            throw streamFailure();
          }
          const explicitText = Array.isArray(output) ? output.map(readItemText).join("\n").trim() : "";
          const reply = explicitText || finalizedItemText.trim() || finalizedText.trim() || streamedText.trim();
          if (!reply) {
            throw new WakeupRequestError("Codex wakeup did not return a completed text reply", "stream");
          }
          completion = { reply: sanitizeWakeupText(reply.slice(0, MAX_REPLY_LENGTH)), model: readString(model) };
          break;
        }
      }
    };
    try {
      while (!completion) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) {
          throw new WakeupRequestError("Codex wakeup returned an invalid stream", "stream");
        }
        bytes += value.byteLength;
        if (bytes > 1_048_576) {
          throw new WakeupRequestError("Codex wakeup response exceeded the size limit", "stream");
        }
        pending += decoder.decode(value, { stream: true });
        const frames = pending.split(/\r?\n\r?\n/);
        pending = frames.pop() ?? "";
        for (const frame of frames) {
          processFrame(frame);
        }
      }
      if (!completion && pending.trim()) {
        processFrame(pending + decoder.decode());
      }
      if (!completion) {
        throw new WakeupRequestError("Codex wakeup did not return a completed text reply", "stream");
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return completion;
  } catch (error) {
    if (signal.aborted) {
      throw new WakeupRequestError("Codex wakeup was cancelled", "cancelled");
    }
    if (controller.signal.aborted && !signal.aborted) {
      throw new WakeupRequestError("Codex wakeup timed out; it will not be retried automatically", "timeout");
    }
    if (error instanceof WakeupRequestError) {
      throw error;
    }
    if (error instanceof CodexProxyConfigurationError) {
      throw new WakeupRequestError(sanitizeWakeupText(error.message), stage);
    }
    throw new WakeupRequestError(
      stage === "stream" ? "Codex wakeup stream ended unexpectedly" : "Codex wakeup request failed",
      stage
    );
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}

function parseStreamEvent(data: string): Record<string, unknown> {
  try {
    const event = readRecord(JSON.parse(data) as unknown);
    if (event) {
      return event;
    }
  } catch {
    // JSON parser errors can contain text from the upstream payload.
  }
  throw new WakeupRequestError("Codex wakeup returned an invalid stream event", "stream");
}

function streamFailure(): WakeupRequestError {
  return new WakeupRequestError("Codex wakeup response failed or was incomplete", "stream");
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readItemText(value: unknown): string | undefined {
  const content = readRecord(value)?.["content"];
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = (content as unknown[]).flatMap((value) => {
    const part = readRecord(value);
    const text = readString(part?.["text"]);
    return part?.["type"] === "output_text" && text !== undefined ? [text] : [];
  });
  return parts.join("\n");
}

function appendReply(previous: string, text: string | undefined, separator = ""): string {
  if (!text) {
    return previous;
  }
  return `${previous}${separator}${text}`.trimStart().slice(0, MAX_REPLY_LENGTH);
}
