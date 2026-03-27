import { describe, expect, it } from "vitest";
import { resolveDashboardLanguage } from "../src/localization/languages";
import { interpolate } from "../src/utils/i18n";

describe("resolveDashboardLanguage", () => {
  it("maps VS Code locale prefixes to supported dashboard locales", () => {
    expect(resolveDashboardLanguage("auto", "zh-TW")).toBe("zh-hant");
    expect(resolveDashboardLanguage("auto", "pt")).toBe("pt-br");
    expect(resolveDashboardLanguage("auto", "en-US")).toBe("en");
  });
});

describe("interpolate", () => {
  it("replaces repeated placeholders", () => {
    expect(interpolate("{name} has {count} item(s). {name} can retry.", { name: "Alice", count: 3 })).toBe(
      "Alice has 3 item(s). Alice can retry."
    );
  });
});
