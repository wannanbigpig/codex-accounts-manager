import { describe, expect, it } from "vitest";
import { buildThinBar, renderMetricRow } from "../src/ui/statusBar";

describe("buildThinBar", () => {
  it("renders an empty bar for zero percent", () => {
    expect(buildThinBar(0, 5)).toBe("▱▱▱▱▱");
  });

  it("renders a full bar for one hundred percent", () => {
    expect(buildThinBar(100, 5)).toBe("▰▰▰▰▰");
  });

  it("renders a neutral bar when percentage is unavailable", () => {
    expect(buildThinBar(undefined, 5)).toBe("╌╌╌╌╌");
  });
});

describe("renderMetricRow", () => {
  it("does not force inline code styling in the native tooltip", () => {
    const row = renderMetricRow("5 小时", 79);

    expect(row).toContain("5 小时");
    expect(row).toContain("79%");
    expect(row).not.toContain("`");
  });
});
