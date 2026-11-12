import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron");
const startup = require("./profile-startup.js");
try {
  const prepared = startup.prepareApplicationStartup(electron);
  if (prepared.role === "validation-child") {
    // Electron emits ready after entry evaluation. Do not await it here.
    void prepared.completion.catch(error => startup.reportStartupFailure(electron, error));
  } else {
    await prepared.completion;
  }
} catch (error) {
  startup.reportStartupFailure(electron, error);
}
