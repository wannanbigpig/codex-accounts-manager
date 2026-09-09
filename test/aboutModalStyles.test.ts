import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dashboardStyles = fs.readFileSync(path.join(process.cwd(), "media", "webview", "quotaSummary.css"), "utf8");

function cssRule(selector: string): string {
  const start = dashboardStyles.indexOf(`${selector} {`);
  expect(start, `missing CSS rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const end = dashboardStyles.indexOf("}", start);
  expect(end, `unterminated CSS rule for ${selector}`).toBeGreaterThan(start);
  return dashboardStyles.slice(start, end + 1);
}

describe("about modal styles", () => {
  it("keeps the about content in a dedicated bounded scroll container", () => {
    const bodyRule = cssRule(".about-modal .dashboard-modal-body");

    expect(bodyRule).toContain("display: block;");
    expect(bodyRule).toContain("flex: 1 1 auto;");
    expect(bodyRule).toContain("min-height: 0;");
    expect(bodyRule).toContain("max-height: none;");
    expect(bodyRule).toContain("overflow-y: auto;");
  });
});
