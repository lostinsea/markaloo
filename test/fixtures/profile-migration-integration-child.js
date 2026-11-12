"use strict";

// Node-only protocol fixture. WAL contents and telemetry are synthetic; this
// does not open Chromium storage or acquire real application ownership.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const adapter = require("../../src/profile-migration-validation");
const {
  validateInitialLocalStorageHistograms, validateLocalStorageHistograms,
  verifySupportedLocalStorage,
} = require("../../src/profile-migration-probe");

const [role, mode, reportPath, appDataPath, workRoot] = process.argv.slice(2);
const save = report => fs.writeFileSync(reportPath, JSON.stringify(report));

async function main() {
  if (role === "interrupt-migration") {
    const target = path.join(appDataPath, "Markaloo");
    const rename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      rename(source, destination);
      if (destination === target) process.exit(23);
    };
    const { migrateWindowsProfile } = require("../../src/profile-migration");
    await migrateWindowsProfile({
      appDataPath,
      withProfileOwnership: async (_paths, run) => run(),
      validateLocalStorage: adapter.createLocalStorageValidator({
        executablePath: process.execPath,
        args: [__filename, "probe", "mutate-clone", reportPath],
        workRoot, timeoutMs: 5000, shutdownTimeoutMs: 1000,
      }),
    });
    throw new Error("The publication interruption did not happen");
  }

  assert.equal(role, "probe");
  assert.equal(process.argv.at(-1), adapter.CHILD_ARGUMENT);
  if (mode === "no-result") {
    fs.readFileSync(3);
    fs.closeSync(3);
    save({ requestRead: true, noResult: true });
    process.exit(0);
  }

  const app = new EventEmitter();
  const paths = new Map();
  let ready = false;
  const report = { pid: process.pid, setBeforeReady: true };
  app.isReady = () => ready;
  app.whenReady = () => assert.fail("Preparation must not wait for ready");
  app.getPath = name => paths.get(name);
  app.setPath = (name, value) => {
    report.setBeforeReady &&= !ready;
    paths.set(name, value);
    fs.writeFileSync(path.join(value, "owned-bootstrap-data"), name);
  };
  app.exit = code => {
    report.requestedExit = code;
    save(report);
    if (mode === "result-then-wait") {
      setInterval(() => {}, 1000);
      return;
    }
    process.exit(mode === "result-then-fail" ? 9 : code);
  };
  const prepared = adapter.prepareProfileValidationChild({
    electron: { app },
    probe: async ({ profilePath }) => {
      report.probeAfterReady = ready;
      report.profilePath = profilePath;
      report.userDataPath = paths.get("userData");
      report.sessionDataPath = paths.get("sessionData");
      verifySupportedLocalStorage(profilePath);
      const database = path.join(profilePath, "Local Storage", "leveldb");
      const wal = path.join(database, "000003.log");
      const bytes = fs.readFileSync(wal);
      report.files = fs.readdirSync(database).sort();
      report.walHash = crypto.createHash("sha256").update(bytes).digest("hex");
      const settings = JSON.parse(bytes.toString("utf8")).settings;
      if (mode === "mutate-clone") {
        fs.appendFileSync(wal, "\nowned disposable probe write");
        report.cloneChanged = !fs.readFileSync(wal).equals(bytes);
      }
      const sample = name => ({
        name: `Storage.LocalStorage.${name}.OnDisk`,
        count: 1, sum: 0, buckets: [{ low: 0, high: 1, count: 1 }],
      });
      const counts = validateLocalStorageHistograms({
        histograms: [
          sample("OpenDatabase"), sample("ReadAllMetadata"), sample("ReadMapKeyValues"),
          sample("Duration.OpenDatabase2"), sample("Duration.ReadAllMetadata"),
          sample("Duration.ReadMapKeyValues"),
        ],
      }, validateInitialLocalStorageHistograms({ histograms: [] }));
      save(report);
      return { status: "observed", storageKey: "file:///", ...counts, settings };
    },
  });
  report.returnedBeforeReady = !ready;
  prepared.completion.catch(error => {
    report.errorCode = error.code;
    save(report);
  });
  setImmediate(() => {
    ready = true;
    app.emit("ready");
  });
}

void main().catch(error => {
  save({ errorCode: error.code, message: error.message });
  process.exitCode = 1;
});
