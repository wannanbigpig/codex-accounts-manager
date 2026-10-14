import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { once } from "events";
import { sendWakeupRequest } from "../src/services/wakeupClient";
import { APIError } from "../src/core/errors";

vi.mock("../src/infrastructure/config/proxyEnvironment", () => ({ getCodexProxyDispatcher: () => undefined }));
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
    await sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url });
    expect(headers?.authorization).toBe("Bearer fixture-access-token");
    expect(headers?.["chatgpt-account-id"]).toBe("fixture-workspace");
    expect(received).toMatchObject({ model: task.model, reasoning: { effort: "low" }, store: false, stream: true });
    expect(received?.["input"]).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with OK." }] }
    ]);
    expect(received?.["tools"]).toBeUndefined();
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
    "data: [DONE]\n\n"
  ])("does not count an incomplete/empty stream as a successful wakeup", async (body) => {
    const url = await endpoint((_req, res) => res.end(body));
    await expect(sendWakeupRequest(tokens, task, new AbortController().signal, { endpoint: url })).rejects.toThrow(
      "completed text reply"
    );
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
    ).rejects.toThrow("timed out");
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
