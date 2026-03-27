import { vi } from "vitest";

vi.mock("vscode", () => ({
  env: {
    language: "en"
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: vi.fn()
    }),
    onDidChangeConfiguration: vi.fn()
  },
  window: {
    showOpenDialog: vi.fn()
  },
  ConfigurationTarget: {
    Global: 1
  }
}));
