import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureCodexProxyEnvironment,
  disposeCodexProxyEnvironment,
  getCodexProxyConfigurationError,
  getCodexProxyDispatcher,
  parseDotEnv,
  resolveProxySettings
} from "../src/infrastructure/config/proxyEnvironment";
import { fetchWithTimeout } from "../src/utils/network";

afterEach(() => {
  disposeCodexProxyEnvironment();
  vi.restoreAllMocks();
});

describe("Codex proxy environment", () => {
  it("loads supported proxy variables and ignores unrelated secrets", () => {
    expect(
      parseDotEnv(`
        OPENAI_API_KEY=secret
        export HTTPS_PROXY="http://127.0.0.1:7890"
        http_proxy=http://127.0.0.1:7891 # local proxy
        NO_PROXY='localhost,127.0.0.1'
      `)
    ).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:7891",
      NO_PROXY: "localhost,127.0.0.1"
    });
  });

  it("prefers the process environment over the Codex .env file", () => {
    expect(
      resolveProxySettings(
        { HTTPS_PROXY: "http://process-proxy:8080", NO_PROXY: "localhost" },
        { HTTPS_PROXY: "http://file-proxy:8080", HTTP_PROXY: "http://file-http-proxy:8080" }
      )
    ).toEqual({
      httpProxy: "http://file-http-proxy:8080",
      httpsProxy: "http://process-proxy:8080",
      noProxy: "localhost"
    });
  });

  it("uses ALL_PROXY as a fallback for HTTP and HTTPS", () => {
    expect(resolveProxySettings({}, { ALL_PROXY: "http://shared-proxy:7890" })).toEqual({
      httpProxy: "http://shared-proxy:7890",
      httpsProxy: "http://shared-proxy:7890",
      noProxy: undefined
    });
  });

  it("treats empty process variables as explicit overrides", () => {
    expect(
      resolveProxySettings(
        { HTTPS_PROXY: "", NO_PROXY: "" },
        {
          HTTPS_PROXY: "http://file-proxy:8080",
          NO_PROXY: "localhost"
        }
      )
    ).toEqual({
      httpProxy: undefined,
      httpsProxy: undefined,
      noProxy: undefined
    });
  });

  it("blocks direct requests when the configured proxy protocol is unsupported", async () => {
    const directFetch = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      configureCodexProxyEnvironment({
        httpProxy: "socks5://127.0.0.1:7890",
        httpsProxy: "socks5://127.0.0.1:7890"
      })
    ).toBe(false);
    expect(getCodexProxyConfigurationError()?.message).toContain("unsupported socks5: protocol");
    expect(() => getCodexProxyDispatcher()).toThrow("unsupported socks5: protocol");

    await expect(fetchWithTimeout("https://example.com")).rejects.toThrow("unsupported socks5: protocol");
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("routes requests through the configured dispatcher", async () => {
    const proxyServer = http.createServer();
    let proxyConnections = 0;
    proxyServer.on("connect", (_request, socket) => {
      proxyConnections += 1;
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    await listen(proxyServer);
    const address = proxyServer.address() as AddressInfo;
    const directFetch = vi.spyOn(globalThis, "fetch");
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    try {
      expect(
        configureCodexProxyEnvironment({
          httpProxy: `http://127.0.0.1:${address.port}`
        })
      ).toBe(true);

      await expect(fetchWithTimeout("http://proxy-target.invalid", {}, 1_000)).rejects.toThrow();
      expect(proxyConnections).toBe(1);
      expect(directFetch).not.toHaveBeenCalled();
    } finally {
      disposeCodexProxyEnvironment();
      await close(proxyServer);
    }
  });
});

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
