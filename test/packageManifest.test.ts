import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

describe("extension manifest configuration", () => {
  it("passes the Marketplace icon check before VSIX packaging", () => {
    const root = path.resolve(__dirname, "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.scripts["vscode:prepublish"]).toBe("npm run check:package-icon");
    const result = spawnSync(process.execPath, ["scripts/check-package-icon.cjs"], { cwd: root, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Extension icon OK:");
  });

  it("declares the auto switch reload window setting", () => {
    const manifestPath = path.resolve(__dirname, "../package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { type?: string; default?: unknown; markdownDescription?: string }>;
        };
      };
    };

    const property = manifest.contributes?.configuration?.properties?.["codexAccounts.autoSwitchReloadWindowEnabled"];

    expect(property).toBeTruthy();
    expect(property).toMatchObject({
      type: "boolean",
      default: false
    });
    expect(property?.markdownDescription).toContain("Automatically reload");
  });
});
