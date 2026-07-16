import { describe, expect, it } from "vitest";
import { parseDotEnv, resolveProxySettings } from "../src/infrastructure/config/proxyEnvironment";

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
});
