import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { once } from "events";
import { sendWakeupRequest } from "../src/services/wakeupClient";
import { APIError } from "../src/core/errors";

vi.mock("../src/infrastructure/config/proxyEnvironment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/infrastructure/config/proxyEnvironment")>()),
  getCodexProxyDispatcher: () => undefined
}));
const task = { model: "gpt-5.6-luna", effort: "low" as const, prompt: "Reply with OK." };
const tokens = { accessToken: "fixture-access-token", idToken: "fixture-id-token", accountId: "fixture-workspace" };
let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});
async function endpoint(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/responses`;
}
const completed =
  'data: {"type":"response.completed","response":{"status":"completed","output":[{"content":[{"type":"output_text","text":"OK"}]}]}}\n\n';

describe("direct Codex wakeup request", () => {
  it("sends only the selected account and minimal prompt, and accepts fragmented CRLF SSE", async () => {
    let received: Record<string, unknown> | undefined;
    let headers: IncomingMessage["headers"] | undefined;
    const url = await endpoint((req, res) => {
      headers = req.headers;
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        received = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","del');
        setTimeout(() => res.end('ta":"OK"}\r\n\r\n' + completed.replace(/\n/g, "\r\n")), 5);
      });
    });
    const result = await sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url });
    expect(result.reply).toBe("OK");
    expect(headers?.authorization).toBe("Bearer fixture-access-token");
    expect(headers?.["chatgpt-account-id"]).toBe("fixture-workspace");
    expect(received).toMatchObject({ model: task.model, reasoning: { effort: "low" }, store: false, stream: true });
    expect(received?.["input"]).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with OK." }] }
    ]);
    expect(received?.["tools"]).toBeUndefined();
  });
  it("prefers the completed reply over deltas and bounds/redacts persisted diagnostics", async () => {
    const finalText = "Bearer fixture-secret sk-fixturekey " + "x".repeat(700);
    const url = await endpoint((_req, res) =>
      res.end(
        'data: {"type":"response.output_text.delta","delta":"draft"}\n\n' +
          `data: ${JSON.stringify({ type: "response.completed", response: { model: "fixture-model", status: "completed", output: [{ content: [{ type: "output_text", text: finalText }] }] } })}\n\n`
      )
    );
    const result = await sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url });
    expect(result.model).toBe("fixture-model");
    expect(result.reply).toHaveLength(500);
    expect(result.reply).toContain("[redacted]");
    expect(result.reply).not.toMatch(/fixture-secret|sk-fixturekey|draft/);
  });
  it("uses SSE event names when JSON type is omitted and accepts response.done with completed status", async () => {
    const url = await endpoint((_req, res) =>
      res.end(
        'event: response.output_text.delta\ndata: {"delta":"O"}\n\n' +
          'event: response.output_text.delta\ndata: {"delta":"K"}\n\n' +
          'event: response.done\ndata: {"response":{"status":"completed","model":"fixture-model"}}\n\n'
      )
    );
    await expect(sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url })).resolves.toEqual({
      reply: "OK",
      model: "fixture-model"
    });
  });
  it.each([
    'data: {"type":"response.output_text.done","text":"OK"}\n\n',
    'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}}\n\n'
  ])("uses finalized text when the completed response omits output", async (frame) => {
    const url = await endpoint((_req, res) =>
      res.end(frame + 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n')
    );
    await expect(sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url })).resolves.toMatchObject({
      reply: "OK"
    });
  });
  it.each(["\n", ""])("does not mistake a declared failure for a completed response (%j separator)", async (separator) => {
    const url = await endpoint((_req, res) => res.end(`event: response.incomplete\n${separator}${completed}`));
    await expect(sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url })).rejects.toMatchObject({
      stage: "stream",
      message: "Codex wakeup response failed or was incomplete"
    });
  });
  it.each(["failed", "incomplete", "cancelled", undefined])("rejects response.done without success status (%s)", async (status) => {
    const url = await endpoint((_req, res) =>
      res.end(
        'data: {"type":"response.output_text.done","text":"OK"}\n\n' +
          `data: ${JSON.stringify({ type: "response.done", response: { status } })}\n\n`
      )
    );
    await expect(sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url })).rejects.toThrow(
      "failed or was incomplete"
    );
  });
  it("does not echo malformed upstream payloads in its stream error", async () => {
    const url = await endpoint((_req, res) => res.end("data: fixture-private-value\n\n"));
    await expect(sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url })).rejects.toMatchObject({
      stage: "stream",
      message: "Codex wakeup returned an invalid stream event"
    });
  });
  it.each(["response.failed", "response.incomplete", "error"])("rejects an error event %s", async (type) => {
    const url = await endpoint((_req, res) => res.end(`data: ${JSON.stringify({ type })}\n\n`));
    await expect(sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url })).rejects.toThrow(
      "failed or was incomplete"
    );
  });
  it("rejects a completion event whose response status is failed", async () => {
    const url = await endpoint((_req, res) => res.end(completed.replace('"status":"completed"', '"status":"failed"')));
    await expect(sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url })).rejects.toThrow(
      "failed or was incomplete"
    );
  });
  it.each([
    'data: {"type":"response.completed","response":{"output":[]}}\n\n',
    'data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
    'data: {"type":"response.output_text.done","text":"OK"}\n\ndata: [DONE]\n\n',
    "data: [DONE]\n\n"
  ])("does not count an incomplete/empty stream as a successful wakeup", async (body) => {
    const url = await endpoint((_req, res) => res.end(body));
    await expect(sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url })).rejects.toThrow(
      "completed text reply"
    );
  });
  it("rejects disconnection after a partial text delta", async () => {
    const url = await endpoint((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"type":"response.output_text.delta","delta":"OK"}\n\n', () => {
        setTimeout(() => res.destroy(), 10);
      });
    });
    await expect(sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url })).rejects.toMatchObject({
      stage: "stream"
    });
  });
  it("keeps the timeout active after headers arrive and never retries uncertain requests", async () => {
    let requests = 0;
    const url = await endpoint((_req, res) => {
      requests += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
    });
    await expect(
      sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url, timeoutMs: 100 })
    ).rejects.toMatchObject({ stage: "timeout" });
    expect(requests).toBe(1);
  });
  it("supports cancellation while reading the stream", async () => {
    const controller = new AbortController();
    const url = await endpoint((_req, res) => {
      res.writeHead(200);
      res.flushHeaders();
      controller.abort();
    });
    await expect(sendWakeupRequest(tokens, task, controller.signal, { endpoint: url })).rejects.toThrow();
  });
  it("preserves HTTP status so only authorization failures can use the existing token refresh path", async () => {
    const url = await endpoint((_req, res) => {
      res.writeHead(401);
      res.end("not authorized");
    });
    await expect(
      sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url })
    ).rejects.toMatchObject({ statusCode: 401 });
    const error = await sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url }).catch(
      (value: unknown) => value
    );
    expect(error).toBeInstanceOf(APIError);
  });
});
