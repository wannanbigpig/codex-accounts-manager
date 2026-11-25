import { vi } from "vitest";

vi.mock("vscode", () => ({
  env: {
    language: "en",
    openExternal: vi.fn()
  },
  Uri: { parse: (value: string) => new URL(value) },
  CancellationTokenSource: class {
    private cancelled = false;
    private listeners = new Set<() => void>();
    readonly token = {
      get isCancellationRequested() { return this.source.cancelled; },
      source: this,
      onCancellationRequested: (listener: () => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      }
    };
    cancel() {
      this.cancelled = true;
      for (const listener of this.listeners) listener();
    }
    dispose() { this.listeners.clear(); }
  },
  commands: {
    executeCommand: vi.fn()
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: vi.fn(),
      inspect: vi.fn()
    })),
    onDidChangeConfiguration: vi.fn()
  },
  window: {
    withProgress: vi.fn((_options, task) => task({ report: vi.fn() })),
    showOpenDialog: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn()
  },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
  }
}));
