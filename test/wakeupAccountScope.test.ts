import { describe, expect, it } from "vitest";
import { getSingleAccountWakeupTasks } from "../src/domain/wakeup/accountScope";
import type { WakeupTask } from "../src/domain/wakeup/types";
const task = (id: string, accountIds: string[]): WakeupTask => ({
  id,
  name: id,
  accountIds,
  enabled: true,
  time: "06:15",
  days: [1, 2, 3, 4, 5],
  model: "gpt-5.6-luna",
  effort: "low",
  prompt: "Reply with OK.",
  createdAt: 1,
  updatedAt: 1,
  nextRunAt: 2
});
describe("account-card wakeup configuration", () => {
  it("keeps shared task membership intact when opening one account's configuration", () => {
    const tasks = [task("shared", ["a", "b"]), task("dedicated", ["a"]), task("other", ["b"])];
    expect(getSingleAccountWakeupTasks(tasks, "a").map((item) => item.id)).toEqual(["dedicated"]);
    expect(tasks[0]!.accountIds).toEqual(["a", "b"]);
    expect(getSingleAccountWakeupTasks(tasks, "missing")).toEqual([]);
  });
  it("retains all independent schedules for the account instead of silently selecting one", () => {
    const tasks = [task("morning", ["a"]), task("evening", ["a"]), task("other", ["b"])];
    expect(getSingleAccountWakeupTasks(tasks, "a").map((item) => item.id)).toEqual(["morning", "evening"]);
  });
});
