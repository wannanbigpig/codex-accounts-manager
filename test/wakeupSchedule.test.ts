import { describe, expect, it } from "vitest";
import { nextWakeupAt, validateWakeupTask } from "../src/domain/wakeup/schedule";
import type { WakeupTaskInput } from "../src/domain/wakeup/types";

export const wakeupInput: WakeupTaskInput = {
  name: "Morning",
  enabled: true,
  accountIds: ["account-a", "account-b"],
  time: "06:15",
  days: [0, 1, 2, 3, 4, 5, 6],
  model: "gpt-5.6-luna",
  effort: "low",
  prompt: "Reply with OK."
};

describe("wakeup calendar", () => {
  it("chooses today's future time and moves past an already claimed time", () => {
    const before = new Date(2026, 9, 8, 6, 14).getTime();
    const due = new Date(2026, 9, 8, 6, 15).getTime();
    expect(nextWakeupAt(wakeupInput, before)).toBe(due);
    expect(nextWakeupAt(wakeupInput, due)).toBe(new Date(2026, 9, 9, 6, 15).getTime());
  });
  it("skips weekends and crosses month/year boundaries using local dates", () => {
    expect(nextWakeupAt({ time: "06:15", days: [1, 2, 3, 4, 5] }, new Date(2026, 9, 9, 7).getTime())).toBe(
      new Date(2026, 9, 12, 6, 15).getTime()
    );
    expect(nextWakeupAt({ time: "00:05", days: wakeupInput.days }, new Date(2026, 11, 31, 23, 59).getTime())).toBe(
      new Date(2027, 0, 1, 0, 5).getTime()
    );
  });
  it("waits a whole week after the selected weekday's time", () => {
    expect(nextWakeupAt({ time: "06:15", days: [4] }, new Date(2026, 9, 8, 7).getTime())).toBe(
      new Date(2026, 9, 15, 6, 15).getTime()
    );
  });
  it("normalizes inputs without retaining unexpected fields", () => {
    const task = validateWakeupTask({ ...wakeupInput, name: " Morning ", days: [5, 1, 1], accountIds: ["a", "a"] });
    expect(task.days).toEqual([1, 5]);
    expect(task.accountIds).toEqual(["a"]);
    expect(task.name).toBe("Morning");
    expect(task.scheduleMode).toBe("calendar");
    expect(task.intervalMinutes).toBeUndefined();
  });
  it("starts an interval after saving and preserves its cadence across late polls and sleep", () => {
    const savedAt = new Date(2026, 9, 9, 6, 15).getTime();
    const step = 5 * 60 * 60_000;
    const interval = { ...wakeupInput, scheduleMode: "interval" as const, intervalMinutes: 300 };
    expect(nextWakeupAt(interval, savedAt)).toBe(savedAt + step);
    const scheduled = { ...interval, nextRunAt: savedAt + step };
    expect(nextWakeupAt(scheduled, savedAt + step - 1)).toBe(savedAt + step);
    expect(nextWakeupAt(scheduled, savedAt + step)).toBe(savedAt + step * 2);
    expect(nextWakeupAt(scheduled, savedAt + step + 45_000)).toBe(savedAt + step * 2);
    expect(nextWakeupAt(scheduled, savedAt + step * 4 + 300_001)).toBe(savedAt + step * 5);
  });
  it("supports minute intervals independently of calendar fields", () => {
    const task = validateWakeupTask({
      ...wakeupInput,
      scheduleMode: "interval",
      intervalMinutes: 90,
      days: [],
      time: ""
    });
    expect(nextWakeupAt(task, 1_000)).toBe(1_000 + 90 * 60_000);
    expect(task.intervalMinutes).toBe(90);
  });
  it.each([
    { time: "24:00" },
    { time: "6:15" },
    { days: [] },
    { days: [7] },
    { accountIds: [] },
    { model: "../bad" },
    { prompt: " " },
    { enabled: "yes" },
    { effort: "unsupported" },
    { id: "../../bad" },
    { scheduleMode: "unknown" },
    { scheduleMode: null },
    { scheduleMode: "interval" },
    { scheduleMode: "interval", intervalMinutes: 0 },
    { scheduleMode: "interval", intervalMinutes: -1 },
    { scheduleMode: "interval", intervalMinutes: 1.5 },
    { scheduleMode: "interval", intervalMinutes: 10_081 },
    { scheduleMode: "interval", intervalMinutes: "300" }
  ])("rejects malformed task %j", (invalid) => {
    expect(() => validateWakeupTask({ ...wakeupInput, ...invalid } as WakeupTaskInput)).toThrow();
  });
});
