// Test-only TS loader: the worker exercises current production sources in a separate process.
const fs = require("fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  });
  module._compile(output.outputText, filename);
};
const { WakeupStore } = require("../../src/storage/wakeupStore.ts");
const { WakeupService } = require("../../src/application/wakeup/service.ts");
process.on("message", async ({ directory, now, endpoint, crash }) => {
  const service = new WakeupService(
    new WakeupStore(directory),
    {
      getAccount: async (id) => ({ id })
    },
    async (id) => {
      await fetch(endpoint, { method: "POST", body: id });
      if (crash) {
        process.exit(17);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
    () => {},
    () => now
  );
  try {
    await service.poll();
    service.dispose();
    process.send({ done: true });
  } catch (error) {
    process.send({ error: error.message });
  } finally {
    process.disconnect();
  }
});
process.send({ ready: true });
