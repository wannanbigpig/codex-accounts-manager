import { vi } from "vitest";

vi.mock("vscode", () => ({
  env: {
    language: "en"
  },
  commands: {
    executeCommand: vi.fn()
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: vi.fn()
    }),
    onDidChangeConfiguration: vi.fn()
  },
  window: {
    showOpenDialog: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn()
  },
  ConfigurationTarget: {
    Global: 1
  }
}));
