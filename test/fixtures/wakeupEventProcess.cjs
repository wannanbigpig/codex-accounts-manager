// Exercises the production startup membership and scheduler across independent hosts.
const fs = require("fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText, filename);
};
const { WakeupStore } = require("../../src/storage/wakeupStore.ts");
const { WakeupService } = require("../../src/application/wakeup/service.ts");
let membership, service;
process.on("message", async ({ directory, now, endpoint, stop }) => {
  try {
    if (stop) {
      service?.dispose();
      await membership?.release();
      process.send({ stopped: true });
      process.disconnect();
      return;
    }
    const store = new WakeupStore(directory);
    service = new WakeupService(store, { getAccount: async id => ({ id }) }, async id => {
      const response = await fetch(endpoint, { method: "POST", body: id });
      await response.text();
      await new Promise(resolve => setTimeout(resolve, 80));
    }, () => {}, () => now);
    membership = await store.joinSchedulerSession(now, () => service.dispose());
    await service.poll();
    process.send({ done: true, sessionId: membership.session.id });
  } catch (error) {
    process.send({ error: error.message });
  }
});
process.send({ ready: true });
