import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("extension manifest configuration", () => {
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
