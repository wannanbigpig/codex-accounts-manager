import { expect, it, vi } from "vitest";
import { getAuthJsonPath, writeAuthFile } from "../src/codex/authFile";

const { open, rename } = vi.hoisted(() => ({
  open: vi.fn(async (_filePath: string) => ({ writeFile: vi.fn(), close: vi.fn() })),
  rename: vi.fn()
}));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(),
  open,
  rename,
  realpath: vi.fn(async (directory: string) => directory)
}));
vi.mock("child_process", () => ({ execFile: vi.fn((_command, _args, callback) => callback(null)) }));

it("creates the replacement auth file with owner-only permissions before moving it into place", async () => {
  await writeAuthFile({ idToken: "fixture-id", accessToken: "fixture-access" });

  expect(open).toHaveBeenCalledExactlyOnceWith(expect.any(String), "wx", 0o600);
  expect(rename).toHaveBeenCalledExactlyOnceWith(open.mock.calls[0]![0], getAuthJsonPath());
});
