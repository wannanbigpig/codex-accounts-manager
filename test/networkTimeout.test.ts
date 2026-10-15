import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "http";
import { once } from "events";
import { fetchWithTimeout } from "../src/utils/network";

vi.mock("../src/infrastructure/config/proxyEnvironment", () => ({ getCodexProxyDispatcher: () => undefined }));
let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});
async function endpoint(stall: boolean): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "X-Fixture": "yes" });
    response.flushHeaders();
    if (!stall) {
      response.end('{"ok":true}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
describe("request lifetime", () => {
  it("times out an unfinished body after response headers arrive", async () => {
    const url = await endpoint(true);
    const request = fetchWithTimeout(url, {}, 60, "Fixture request").then((response) => response.text());
    const outcome = await Promise.race([
      request.then(
        () => "completed",
        (error: Error) => error.message
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 350))
    ]);
    expect(outcome).toContain("timed out");
  });
  it("honors caller cancellation during body consumption", async () => {
    const url = await endpoint(true);
    const controller = new AbortController();
    const request = fetchWithTimeout(url, { signal: controller.signal }, 1_000).then((response) => response.text());
    setTimeout(() => controller.abort(), 40);
    const outcome = await Promise.race([
      request.then(
        () => "completed",
        (error: Error) => error.name
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 350))
    ]);
    expect(outcome).toBe("AbortError");
  });
  it("preserves response metadata and lets callers consume JSON normally", async () => {
    const url = await endpoint(false);
    const response = await fetchWithTimeout(url, {}, 1_000);
    expect(response.url).toBe(`${url}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Fixture")).toBe("yes");
    expect(await response.json()).toEqual({ ok: true });
  });
});
