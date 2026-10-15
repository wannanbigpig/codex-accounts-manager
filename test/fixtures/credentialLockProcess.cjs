// Test-only loader exercises the production file lease across independent hosts.
const fs = require("fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText, filename);
};
const { withCredentialLock } = require("../../src/storage/credentialLocks.ts");
process.on("message", async ({ directory, statePath }) => {
  try {
    await withCredentialLock(directory, "refresh:fixture", async () => {
      const count = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 80));
      await fs.promises.writeFile(statePath, JSON.stringify(count + 1));
    });
    process.send({ done: true });
  } catch (error) {
    process.send({ error: error.message });
  } finally {
    process.disconnect();
  }
});
process.send({ ready: true });
