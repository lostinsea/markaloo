"use strict";
const { EventEmitter } = require("events");
const { createUpdateState } = require("../src/update-state");
const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  const updater = new EventEmitter();
  const evidence = { checks: 0, downloads: 0, writes: [], snapshots: [], paths: [], available: true };
  updater.checkForUpdates = async () => {
    evidence.checks++;
    if (evidence.checkGate) await evidence.checkGate.promise;
    if (evidence.checkError) throw evidence.checkError;
    const version = evidence.version || "0.10.0";
    updater.emit(evidence.available ? "update-available" : "update-not-available", { version });
    return { updateInfo: { version } };
  };
  updater.downloadUpdate = async () => {
    evidence.downloads++;
    updater.emit("download-progress", { percent: 41 });
    const artifact = { version: evidence.version || "0.10.0", path: "verified-test-artifact" };
    evidence.paths.push(artifact.path);
    updater.emit("update-downloaded", { version: artifact.version, downloadedFile: artifact.path });
    if (evidence.downloadGate) await evidence.downloadGate.promise;
    return [artifact.path];
  };
  const options = {
    installedVersion: "0.9.0", platform: "win32",
    enabled: () => true, log() {},
    readAvailability: () => undefined,
    writeAvailability: value => evidence.writes.push(value),
    publish: value => evidence.snapshots.push(value),
    isInstalling: () => false, canInstall: () => true,
    validateReady: value => evidence.paths.includes(value.path),
    onDownloadStart() {}, onDownloadReady() {}, onDownloadEnd() {},
    ...overrides,
    getUpdater: () => updater,
  };
  const state = createUpdateState(options);
  state.attach(updater);
  updater.on("update-available", state.observeAvailable);
  return { state, updater, evidence };
}
async function run() {
  const base = fixture();
  check("update fixture starts with no provider calls or ready artifact",
    base.evidence.checks === 0 && base.evidence.downloads === 0 && base.state.snapshot().readyVersion === null);
  await base.state.check();
  check("semantic 0.10 availability is newer than installed 0.9",
    base.state.snapshot().availableVersion === "0.10.0");
  check("availability persists only schema and version",
    JSON.stringify(base.evidence.writes) === '[{"schema":1,"version":"0.10.0"}]');
  base.evidence.checkError = new Error("Offline");
  await base.state.check();
  check("failed check retains known availability and exposes retry",
    base.state.snapshot().availableVersion === "0.10.0" &&
    base.state.snapshot().status === "error" && base.state.snapshot().canCheck);
  base.evidence.checkError = null;
  base.evidence.available = false;
  base.evidence.version = "0.9.0";
  await base.state.check();
  check("no-update result retains the newer known version honestly",
    base.state.snapshot().availableVersion === "0.10.0" &&
    base.state.snapshot().lastCheck === "not-available");
  const lower = fixture({ readAvailability: () => ({ schema: 1, version: "0.12.0" }) });
  lower.evidence.version = "0.11.0";
  await lower.state.check();
  check("a lower live offer does not confirm newer remembered availability",
    lower.state.snapshot().availableVersion === "0.12.0" &&
    lower.state.snapshot().lastCheck === "not-available");
  await lower.state.download();
  check("a lower live offer cannot download as the newer remembered version",
    lower.evidence.downloads === 0 && !lower.state.snapshot().canInstall);

  const cache = fixture({ readAvailability: () => ({ schema: 1, version: "0.10.0" }) });
  check("restored availability is immediate without check download or install authority",
    cache.state.snapshot().availableVersion === "0.10.0" &&
    !cache.state.snapshot().canInstall && cache.state.ready() === null &&
    cache.evidence.checks === 0 && cache.evidence.downloads === 0);
  cache.evidence.checkError = new Error("Offline");
  await cache.state.download();
  check("cached Download requires live provider metadata and fails offline",
    cache.evidence.checks === 1 && cache.evidence.downloads === 0 &&
    cache.state.snapshot().availableVersion === "0.10.0" && cache.state.snapshot().status === "error");

  for (const installed of ["0.10.0", "0.11.0", "0.10.0+build"]) {
    const equal = fixture({ installedVersion: installed,
      readAvailability: () => ({ schema: 1, version: "0.10.0" }) });
    check(`installed ${installed} removes obsolete availability`,
      equal.state.snapshot().availableVersion === null && equal.evidence.writes[0] === null);
  }
  const pre = fixture({ installedVersion: "1.0.0-beta.2",
    readAvailability: () => ({ schema: 1, version: "1.0.0-beta.10" }) });
  check("prerelease ordering uses semantic precedence",
    pre.state.snapshot().availableVersion === "1.0.0-beta.10");
  const build = fixture({ installedVersion: "1.0.0",
    readAvailability: () => ({ schema: 1, version: "1.0.0+build.2" }) });
  check("build metadata alone does not create an update", !build.state.snapshot().availableVersion);
  for (const [i, bad] of [[], {}, { schema: 1, version: "v2.0.0" },
    { schema: 1, version: "<img src=x>" }, { schema: 1, version: "2.0.0", ready: true },
    { schema: 1, version: "9".repeat(512) }, { schema: 2, version: "2.0.0" }].entries()) {
    const invalid = fixture({ readAvailability: () => bad });
    check(`malformed availability ${i} is cleared without readiness`,
      !invalid.state.snapshot().availableVersion && !invalid.state.snapshot().canInstall &&
      invalid.evidence.writes[0] === null);
  }

  const parallel = fixture();
  parallel.evidence.checkGate = deferred();
  const first = parallel.state.check();
  const second = parallel.state.startup();
  const third = parallel.state.check();
  await Promise.resolve();
  check("startup and concurrent manual checks coalesce while disabled",
    first === third && parallel.evidence.checks === 1 && !parallel.state.snapshot().canCheck);
  parallel.evidence.checkGate.resolve();
  await Promise.all([first, second, third]);
  await parallel.state.startup();
  check("scheduled startup does not repeat a completed manual check", parallel.evidence.checks === 1);
  parallel.evidence.downloadGate = deferred();
  const d1 = parallel.state.download();
  const d2 = parallel.state.download();
  await Promise.resolve();
  check("duplicate Downloads share one real download", d1 === d2 && parallel.evidence.downloads === 1);
  check("download event is finalizing not ready until promise completion",
    parallel.state.snapshot().status === "finalizing" && !parallel.state.snapshot().canInstall);
  parallel.evidence.downloadGate.resolve();
  await d1;
  check("successful completion with validated artifact permits install",
    parallel.state.snapshot().readyVersion === "0.10.0" && parallel.state.snapshot().canInstall);
  await parallel.state.download();
  check("repeated Download after ready cannot download twice", parallel.evidence.downloads === 1);
  parallel.evidence.paths.length = 0;
  check("missing artifact revokes install readiness", !parallel.state.snapshot().canInstall && !parallel.state.ready());

  const rejected = fixture();
  await rejected.state.check();
  rejected.evidence.downloadGate = deferred();
  const tail = rejected.state.download();
  await Promise.resolve();
  rejected.evidence.downloadGate.reject(new Error("Cache finalization failed"));
  await tail;
  check("rejected download tail cannot become install ready",
    rejected.state.snapshot().status === "error" && !rejected.state.snapshot().canInstall &&
    rejected.state.snapshot().availableVersion === "0.10.0");

  const preflight = fixture({ readAvailability: () => ({ schema: 1, version: "0.10.0" }) });
  preflight.evidence.checkGate = deferred();
  const p1 = preflight.state.download();
  await Promise.resolve();
  const p2 = preflight.state.download();
  await Promise.resolve();
  check("cache-resolution preflight retains the single-download latch",
    p1 === p2 && preflight.evidence.checks === 1 && preflight.evidence.downloads === 0);
  preflight.evidence.checkGate.resolve();
  await p1;
  check("explicit cached Download resolves offer then downloads once",
    preflight.evidence.checks === 1 && preflight.evidence.downloads === 1 && preflight.state.snapshot().canInstall);

  let storageWritable = false;
  const storage = fixture({ writeAvailability() {
    if (!storageWritable) throw new Error("read-only");
  } });
  await storage.state.check();
  check("storage failure retains live availability but reports missing durability",
    storage.state.snapshot().availableVersion === "0.10.0" && !!storage.state.snapshot().storageError);
  storageWritable = true;
  await storage.state.check();
  check("checking again retries failed availability persistence",
    storage.state.snapshot().availableVersion === "0.10.0" && !storage.state.snapshot().storageError);
  const mac = fixture({ platform: "darwin" });
  await mac.state.check();
  await mac.state.download();
  check("macOS exposes manual fallback without automatic download or install",
    mac.state.snapshot().manualOnly && !mac.state.snapshot().canDownload &&
    !mac.state.snapshot().canInstall && mac.evidence.downloads === 0);
  const noUpdate = fixture();
  noUpdate.evidence.available = false;
  noUpdate.evidence.version = "0.9.0";
  await noUpdate.state.check();
  check("a successful current-version check reports up to date", noUpdate.state.snapshot().status === "up-to-date");
  const gated = fixture();
  gated.evidence.available = false;
  await gated.state.check();
  check("ineligible provider offer is not promoted to live availability",
    !gated.state.snapshot().availableVersion && gated.evidence.writes.length === 0);
  const sync = fixture();
  sync.updater.checkForUpdates = () => { throw new Error("Synchronous failure"); };
  await sync.state.check();
  check("synchronous provider failures are visible and retryable",
    sync.state.snapshot().status === "error" && sync.state.snapshot().canCheck);

  let installing = false;
  const retry = fixture({ isInstalling: () => installing });
  await retry.state.check();
  await retry.state.download();
  retry.state.fail(new Error("Previous install failed"));
  installing = true;
  retry.state.beginInstall();
  check("accepted install retry clears the previous error while pending",
    retry.state.snapshot().status === "installing" && !retry.state.snapshot().error &&
    !retry.state.snapshot().canInstall);
  installing = false;
  retry.state.publish();
  check("declining a fresh install retry returns to verified ready state",
    retry.state.snapshot().status === "ready" && retry.state.snapshot().canInstall);
  installing = true;
  retry.state.fail(new Error("New attempt failed"));
  check("a new install failure remains visible while its latch is held",
    retry.state.snapshot().status === "error" && retry.state.snapshot().error === "New attempt failed");

  const fs = require("fs"), path = require("path"), vm = require("vm");
  const controller = path.join(__dirname, "test-about-updates.js");
  function controllerPhases(platform) {
    const phases = [], exited = {};
    try {
      vm.runInNewContext(fs.readFileSync(controller, "utf8"), {
        __dirname, __filename: controller, console: { log() {}, error() {} },
        process: { platform, argv: ["node", controller], env: {},
          stdout: { write() {} }, stderr: { write() {} }, exit() { throw exited; } },
        require(name) {
          if (name === "./test-userdata-isolation") return {};
          if (name === "fs") return { mkdirSync() {}, writeFileSync() {} };
          if (name === "electron") return "controlled-electron";
          if (name === "child_process") return { spawnSync(_exe, args) {
            phases.push(args[1]);
            return { status: 0, stdout: `=== updates ${args[1]}: 3/3 passed ===\n` };
          } };
          return require(name);
        },
      });
    } catch (error) { if (error !== exited) throw error; }
    return phases;
  }
  check("update controller keeps Windows portable fixtures on Windows",
    controllerPhases("win32").filter(phase => phase.startsWith("portable-")).length === 4);
  check("update controller excludes Windows portable fixtures on Linux and macOS",
    ["linux", "darwin"].every(platform => {
      const phases = controllerPhases(platform);
      return phases.length === 6 && phases.includes("discover") &&
        !phases.some(phase => phase.startsWith("portable-"));
    }));
}
run().then(() => {
  const passed = results.filter(Boolean).length;
  console.log(`=== ${passed}/${results.length} passed ===`);
  process.exitCode = passed === results.length ? 0 : 1;
}, error => {
  console.error("FAIL update state harness completed  -> " + error.stack);
  process.exitCode = 1;
});
