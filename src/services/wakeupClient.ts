import { fetch as undiciFetch } from "undici";
import type { CodexTokens } from "../core/types";
import { APIError } from "../core/errors";
import type { WakeupTaskInput } from "../domain/wakeup/types";
import { CODEX_API_BASE } from "../infrastructure/config/apiEndpoints";
import { getCodexProxyDispatcher } from "../infrastructure/config/proxyEnvironment";

/** A single short conversation, following Cockpit's direct OAuth wakeup request. No tools or auth.json switching. */
export async function sendWakeupRequest(
  tokens: CodexTokens,
  task: Pick<WakeupTaskInput, "model" | "effort" | "prompt">,
  signal: AbortSignal,
  options: { endpoint?: string; timeoutMs?: number } = {}
): Promise<void> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000);
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
      throw new APIError(`Codex wakeup request failed (HTTP ${response.status})`, { statusCode: response.status });
    }
    if (!response.body) {
      throw new Error("Codex wakeup returned an empty response");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let bytes = 0;
    let hasText = false;
    let completed = false;
    const processFrame = (frame: string): void => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") {
        return;
      }
      const event = JSON.parse(data) as {
        type?: string;
        delta?: string;
        response?: { status?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
      };
      if (["error", "response.failed", "response.incomplete"].includes(event.type ?? "")) {
        throw new Error("Codex wakeup response failed or was incomplete");
      }
      if (event.type === "response.output_text.delta" && event.delta?.trim()) {
        hasText = true;
      }
      if (event.type === "response.completed") {
        if (event.response?.status && event.response.status !== "completed") {
          throw new Error("Codex wakeup response failed or was incomplete");
        }
        completed = true;
        hasText ||= Boolean(
          event.response?.output?.some((item) =>
            item.content?.some((part) => part.type === "output_text" && part.text?.trim())
          )
        );
      }
    };
    try {
      while (!completed) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) {
          throw new Error("Codex wakeup returned an invalid stream");
        }
        bytes += value.byteLength;
        if (bytes > 1_048_576) {
          throw new Error("Codex wakeup response exceeded the size limit");
        }
        pending += decoder.decode(value, { stream: true });
        const frames = pending.split(/\r?\n\r?\n/);
        pending = frames.pop() ?? "";
        for (const frame of frames) {
          processFrame(frame);
        }
      }
      if (!completed && pending.trim()) {
        processFrame(pending + decoder.decode());
      }
      if (!completed || !hasText) {
        throw new Error("Codex wakeup did not return a completed text reply");
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) {
      throw new Error("Codex wakeup timed out; it will not be retried automatically");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}
