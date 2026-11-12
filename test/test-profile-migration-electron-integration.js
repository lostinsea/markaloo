"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { migrateWindowsProfile, RECEIPT_NAME } = require("../src/profile-migration");
const { createLocalStorageValidator } = require("../src/profile-migration-validation");
const { verifySupportedLocalStorage } = require("../src/profile-migration-probe");

const fixturePath = path.join(__dirname, "fixtures", "profile-migration-electron-child.cjs");
const storage = path.join("Local Storage", "leveldb");
const runtimeVersions = { electron: "43.4.1", chrome: "150.0.7871.224", node: "24.18.1" };
const positiveHistograms = [
  "Storage.LocalStorage.OpenDatabase.OnDisk",
  "Storage.LocalStorage.Duration.OpenDatabase2.OnDisk",
  "Storage.LocalStorage.ReadAllMetadata.OnDisk",
  "Storage.LocalStorage.Duration.ReadAllMetadata.OnDisk",
  "Storage.LocalStorage.ReadMapKeyValues.OnDisk",
  "Storage.LocalStorage.Duration.ReadMapKeyValues.OnDisk",
].sort();

function inventory(directory) {
  if (!fs.existsSync(directory)) return null;
  const result = {};
  function visit(base, prefix = "") {
    for (const name of fs.readdirSync(base).sort()) {
      const relative = path.join(prefix, name);
      const file = path.join(base, name);
      const stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) {
        result[`${relative}${path.sep}`] = { directory: true };
        visit(file, relative);
      } else {
        assert.ok(stat.isFile());
        const bytes = fs.readFileSync(file);
        result[relative] = {
          bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        };
      }
    }
  }
  visit(directory);
  return result;
}

function errorReport(error) {
  return {
    name: error.name, code: error.code, message: error.message, stack: error.stack,
    ...(error.cause ? { cause: errorReport(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map(errorReport) } : {}),
  };
}

function codes(error) {
  return [
    error.code, ...(error.cause ? codes(error.cause) : []),
    ...(error instanceof AggregateError ? error.errors.flatMap(codes) : []),
  ].filter(Boolean);
}

function waitForFixtureClose(child, state, { timeoutMs = 30000, closeTimeoutMs = 5000 } = {}) {
  const started = performance.now();
  const deadline = started + timeoutMs;
  Object.assign(state, { exited: false, closed: false, events: [] });
  const stop = child.kill;
  let stopFailure;
  const requestStop = (signal, owner) => {
    if (state.stopAttempt) {
      state.stopAttempt.blockedRequests ??= [];
      state.stopAttempt.blockedRequests.push({ owner, signal });
      throw Object.assign(new Error("A stop was already attempted for this exact disposable child", {
        cause: stopFailure,
      }), { code: "ERR_FIXTURE_STOP_ALREADY_ATTEMPTED" });
    }
    state.stopAttempt = { owner, signal };
    try {
      const returned = stop.call(child, signal);
      state.stopAttempt.returned = returned;
      if (!returned) {
        stopFailure = Object.assign(new Error("The exact disposable child refused termination"), {
          code: "ERR_FIXTURE_STOP_FAILED",
        });
        state.stopAttempt.failure = errorReport(stopFailure);
      }
      return returned;
    } catch (error) {
      stopFailure = error;
      state.stopAttempt.failure = errorReport(error);
      throw error;
    }
  };
  // The adapter can outlive this waiter, so its kill method keeps the same latch.
  child.kill = signal => requestStop(signal, "adapter");
  return new Promise((resolve, reject) => {
    let timer;
    let closeTimer;
    let settled = false;
    let primary;
    const remember = error => {
      if (!primary) {
        primary = error;
        state.waitFailure = errorReport(error);
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      state.elapsedMs = performance.now() - started;
      state.unprovenExit = !state.exited;
      state.unprovenClose = !state.closed;
      if (primary) reject(primary);
      else resolve();
    };
    const boundClose = () => {
      if (closeTimer) return;
      closeTimer = setTimeout(() => {
        // Release only parent handles; this is not evidence that the child stopped.
        try {
          child.unref();
          for (const stream of child.stdio || []) stream?.unref?.();
          state.parentHandlesUnreferenced = true;
        } catch (error) {
          state.unrefFailure = errorReport(error);
        }
        finish();
      }, closeTimeoutMs);
    };
    const expire = () => {
      if (settled || state.timedOut) return;
      state.timedOut = true;
      remember(Object.assign(new Error("Disposable fixture exceeded its parent startup/close deadline"), {
        code: "ERR_FIXTURE_PARENT_TIMEOUT",
      }));
      boundClose();
      if (state.exited || state.closed) return;
      if (state.stopAttempt) {
        state.terminationSkipped = "A stop was already attempted for this exact disposable child";
        return;
      }
      state.terminationAttempted = true;
      try {
        state.terminationReturned = requestStop("SIGTERM", "parent");
        if (!state.terminationReturned) {
          state.terminationFailure = {
            code: "ERR_FIXTURE_PARENT_STOP", message: "The exact disposable child refused termination",
          };
        }
      } catch (error) {
        state.terminationFailure = errorReport(error);
      }
    };
    const checkDeadline = () => {
      // Event delivery can reach close before an overdue timer callback.
      if (performance.now() >= deadline) expire();
    };
    const onSpawn = () => {
      state.spawned = true;
      state.events.push("spawn");
      checkDeadline();
    };
    const onError = error => {
      checkDeadline();
      remember(error);
      state.childErrors ??= [];
      state.childErrors.push(errorReport(error));
      if (!child.pid) boundClose();
    };
    const onExit = (code, signal) => {
      state.exited = true;
      state.code = code;
      state.signal = signal;
      state.events.push("exit");
      checkDeadline();
    };
    const onClose = (code, signal) => {
      state.closed = true;
      state.closeCode = code;
      state.closeSignal = signal;
      state.events.push("close");
      checkDeadline();
      if (!state.exited && !primary) {
        remember(Object.assign(new Error("Child close was observed without an exit event"), {
          code: "ERR_FIXTURE_PARENT_UNPROVEN_EXIT",
        }));
      }
      finish();
    };
    child.once("spawn", onSpawn);
    child.on("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    timer = setTimeout(expire, timeoutMs);
  });
}

function decodePacket(chunks) {
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk, "base64")));
  assert.ok(bytes.length >= 4);
  assert.equal(bytes.readUInt32BE(0), bytes.length - 4);
  assert.equal(bytes.includes(Buffer.from("retain this owned test value")), false);
  return JSON.parse(bytes.subarray(4));
}

function assertProbeRun(f, role, expectedExit) {
  const run = f.evidence.runs.find(item => item.role === role);
  const child = f.evidence.children.find(item => item.role === role);
  assert.ok(child.exited && child.closed && child.eof);
  assert.equal(child.signal, null);
  assert.equal(child.code, expectedExit);
  assert.equal(child.waitFailure, undefined, "A parent deadline failure cannot qualify a control");
  assert.ok(child.events.indexOf("close") > child.events.indexOf("exit"));
  assert.ok(child.events.indexOf("close") > child.events.indexOf("eof"));
  assert.equal(run.requests.length, 1);
  const request = decodePacket(run.requests);
  const response = decodePacket(run.packets);
  assert.equal(request.version, 1);
  assert.match(request.requestId, /^[a-f0-9]{64}$/);
  assert.equal(response.version, 1);
  assert.equal(response.requestId, request.requestId);
  assert.equal(path.dirname(request.workPath), run.workRoot);
  assert.equal(run.report.probeProfile, path.join(request.workPath, "profile"));
  assert.notEqual(path.join(run.report.probeProfile, storage), run.input.directory);
  assert.equal(run.report.preparedUserData, path.join(request.workPath, "bootstrap-user-data"));
  assert.equal(run.report.preparedSessionData, path.join(request.workPath, "bootstrap-session-data"));
  assert.equal(run.report.readyOnEntry, false);
  assert.equal(run.report.preparedBeforeReady, true);
  assert.equal(run.report.visibleWindows, 0);
  assert.equal(run.inputUnchanged, true);
  for (const [name, version] of Object.entries(runtimeVersions)) {
    assert.equal(run.report.versions[name], version);
  }
  const events = run.report.events;
  assert.ok(events.find(item => item.event === "app.ready").order <
    events.find(item => item.event === "BrowserWindow.created").order);
  const queries = events.filter(item =>
    item.event === "CDP.command" && item.method === "Browser.getHistograms");
  const replies = events.filter(item => item.event === "CDP.histograms-result");
  const stale = role === "probe-stale-origin";
  assert.equal(queries.length, stale ? 1 : 2);
  assert.equal(replies.length, queries.length);
  assert.equal(run.report.histogramResponses.length, queries.length);
  queries.forEach((query, index) => {
    assert.deepEqual(query.parameters, [{ query: "Storage.LocalStorage.", delta: false }]);
    assert.deepEqual(run.report.histogramResponses[index].parameters, query.parameters);
    assert.ok(query.order < replies[index].order);
  });
  const loads = events.filter(item => item.event === "BrowserWindow.loadFile");
  if (stale) {
    assert.deepEqual(loads, []);
  } else {
    assert.equal(loads.length, 1);
    assert.ok(replies[0].order < loads[0].order && loads[0].order < queries[1].order);
    const read = events.find(item =>
      item.event === "CDP.command" && item.method === "DOMStorage.getDOMStorageItems");
    assert.ok(loads[0].order < read.order && read.order < queries[1].order);
    const positive = run.report.histogramResponses[1].response.histograms.filter(item => item.count > 0);
    assert.deepEqual(positive.map(item => item.name).sort(), positiveHistograms);
    assert.ok(positive.every(item => item.count === 1));
    assert.deepEqual(Object.keys(response).sort(), [
      "backend", "openCount", "readCount", "requestId", "status", "storageKey", "version",
    ]);
    assert.equal(response.status, "observed");
    assert.equal(response.storageKey, "file:///");
    assert.equal(response.backend, "leveldb");
    assert.equal(response.openCount, 1);
    assert.equal(response.readCount, 1);
  }
  return { run, response };
}

function setup(t, executablePath) {
  const binarySha256 = crypto.createHash("sha256").update(fs.readFileSync(executablePath)).digest("hex");
  assert.equal(binarySha256, "e885ffc2a09dab4c14de706e3662a5929d1e65ea4ea347c56fd0964640eb923b");
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),
    "markaloo-electron-profile-"));
  const evidence = {
    root, executablePath, binarySha256, binaryBytes: fs.statSync(executablePath).size,
    node: process.version, children: [], runs: [],
    qualification: "Real disposable Electron storage/pipe protocol only; no Main/installer/legacy ownership claim",
  };
  const output = process.env.MARKALOO_TEST_ELECTRON_REPORT || `${root}.report.json`;
  const reportRelative = path.relative(root, output);
  assert.ok(path.isAbsolute(output) && (reportRelative === ".." ||
    reportRelative.startsWith(`..${path.sep}`) || path.isAbsolute(reportRelative)),
  "The report must be outside the owned cleanup root");
  evidence.reportPath = output;
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2), { flag: "wx" });
  const env = { ...process.env };
  for (const [name, relative] of Object.entries({
    APPDATA: "env-appdata", LOCALAPPDATA: "env-localappdata", USERPROFILE: "home",
    HOME: "home", TEMP: "temp", TMP: "temp",
  })) {
    env[name] = path.join(root, relative);
    fs.mkdirSync(env[name], { recursive: true });
  }
  for (const name of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"]) delete env[name];
  const seedProfile = path.join(root, "seed", "profile");
  const appData = path.join(root, "fresh", "app-data");
  const workRoot = path.join(root, "fresh", "probe-work");
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(path.dirname(seedProfile));
  evidence.roots = { seedProfile, appData, workRoot };
  const settingsPath = path.join(root, "settings.json");
  const document = path.join(root, "synthetic-document.md");
  fs.writeFileSync(document, "# Synthetic document\n");
  const anchor = { scrollTop: 40, text: "Synthetic document", ordinal: 0, delta: -2 };
  const settings = [
    ["themeMode", "dark"], ["darkMode", "enabled"],
    ["themeLightScheme", "base-light"], ["themeDarkScheme", "base-dark"],
    ["readingZoom", "130"], ["notesVisible", "visible"], ["editorSplitRatio", "0.65"],
    ["readingSidePanel", "toc"],
    ["recentFiles", JSON.stringify([{ path: document, name: "Synthetic", timestamp: 123 }])],
    ["openTabs", JSON.stringify([{ filePath: document, scrollPosition: 42, anchor }])],
    ["activeTabPath", document], ["synthetic-future-key", "retain this owned test value"],
  ];
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  let success = false;
  const waits = new WeakMap();
  t.after(() => {
    evidence.cleanupEligible = evidence.children.every(child =>
      child.exited && child.closed && !child.waitFailure);
    evidence.success = success;
    const bytes = JSON.stringify(evidence, null, 2);
    fs.writeFileSync(path.join(root, "runtime-evidence.json"), bytes);
    fs.writeFileSync(output, bytes);
    t.diagnostic(`External runtime evidence: ${output}`);
    if (success && evidence.cleanupEligible) {
      fs.rmSync(root, { recursive: true, maxRetries: 10, retryDelay: 100 });
    } else {
      t.diagnostic(`Preserved owned runtime evidence at ${root}`);
    }
  });
  function args(role, profilePath = "-", reportName = role) {
    const bootstrap = path.join(root, "bootstrap", `${reportName}-${crypto.randomUUID()}`, "user-data");
    fs.mkdirSync(bootstrap, { recursive: true });
    return [
      `--user-data-dir=${bootstrap}`, fixturePath, role, root, profilePath,
      ["seed", "readback", "probe-stale-origin"].includes(role) ? settingsPath : "-",
      path.join(root, `${reportName}.json`),
    ];
  }
  function observeChild(child, role) {
    const state = { role, pid: child.pid };
    evidence.children.push(state);
    const completion = waitForFixtureClose(child, state);
    waits.set(child, completion);
    // The adapter may still be awaiting its own protocol; keep the original rejection.
    completion.catch(error => {
      state.waitFailure = errorReport(error);
    });
    return state;
  }
  async function runElectron(role, profilePath) {
    const child = spawn(executablePath, args(role, profilePath), {
      cwd: root, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    const state = observeChild(child, role);
    const stdout = [];
    const stderr = [];
    const onStdout = bytes => stdout.push(bytes);
    const onStderr = bytes => stderr.push(bytes);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    let primary;
    try { await waits.get(child); } catch (error) { primary = error; }
    child.stdout.removeListener("data", onStdout);
    child.stderr.removeListener("data", onStderr);
    state.stdout = Buffer.concat(stdout).toString("utf8");
    state.stderr = Buffer.concat(stderr).toString("utf8");
    const report = path.join(root, `${role}.json`);
    try {
      if (fs.existsSync(report)) state.report = JSON.parse(fs.readFileSync(report, "utf8"));
    } catch (error) {
      state.reportFailure = errorReport(error);
      primary ||= error;
    }
    if (primary) throw primary;
    assert.equal(state.exited && state.closed, true);
    assert.equal(state.signal, null);
    assert.equal(state.code, 0, `${role} failed: ${state.stderr}`);
    for (const [name, version] of Object.entries(runtimeVersions)) {
      assert.equal(state.report.versions[name], version);
    }
    assert.equal(state.report.readyOnEntry, false);
    assert.equal(state.report.visibleWindows, 0);
    return state.report;
  }
  async function migrate(selectedAppData, role, selectedWorkRoot = workRoot) {
    const run = {
      role, workRoot: selectedWorkRoot, requests: [], packets: [], callbackResults: [],
    };
    evidence.runs.push(run);
    const childWaits = [];
    const detachCollectors = [];
    let held = false;
    const validate = createLocalStorageValidator({
      executablePath, args: args(role), workRoot: selectedWorkRoot,
      spawnChild: (executable, childArgs, options) => {
        assert.equal(held, true);
        assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
        const child = spawn(executable, childArgs, { ...options, env });
        const state = observeChild(child, role);
        childWaits.push(waits.get(child));
        if (child.stdio?.[3]) {
          const end = child.stdio[3].end;
          child.stdio[3].end = function (data, ...rest) {
            run.requests.push(Buffer.from(data).toString("base64"));
            return end.call(this, data, ...rest);
          };
          detachCollectors.push(() => { child.stdio[3].end = end; });
        }
        const onData = data => run.packets.push(Buffer.from(data).toString("base64"));
        const onEnd = () => {
          state.eof = true;
          state.events.push("eof");
        };
        child.stdio?.[4]?.on("data", onData);
        child.stdio?.[4]?.once("end", onEnd);
        detachCollectors.push(() => {
          child.stdio?.[4]?.removeListener("data", onData);
          child.stdio?.[4]?.removeListener("end", onEnd);
        });
        return child;
      },
    });
    try {
      const result = await migrateWindowsProfile({
        appDataPath: selectedAppData,
        withProfileOwnership: async (_paths, body) => {
          // A fixture boundary, not a real legacy application singleton.
          held = true;
          try { return await body(); } finally { held = false; }
        },
        validateLocalStorage: async input => {
          run.input = input;
          const before = inventory(input.directory);
          run.inputBefore = before;
          try {
            let result;
            let primary;
            try { result = await validate(input); } catch (error) { primary = error; }
            for (const observed of await Promise.allSettled(childWaits)) {
              if (observed.status === "rejected") {
                primary = primary
                  ? new AggregateError([primary, observed.reason], "Probe and parent close proof failed")
                  : observed.reason;
              }
            }
            if (primary) throw primary;
            run.callbackResults.push(result);
            return result;
          } catch (error) {
            run.validationFailure = errorReport(error);
            throw error;
          } finally {
            run.inputAfter = inventory(input.directory);
            assert.deepEqual(run.inputAfter, before);
            run.inputUnchanged = true;
          }
        },
      });
      run.result = result;
      return result;
    } catch (error) {
      run.failure = errorReport(error);
      throw error;
    } finally {
      for (const detach of detachCollectors) detach();
      const report = path.join(root, `${role}.json`);
      try {
        if (fs.existsSync(report)) run.report = JSON.parse(fs.readFileSync(report, "utf8"));
      } catch (error) {
        run.reportFailure = errorReport(error);
        if (!run.failure) throw error;
      }
    }
  }
  return {
    root, seedProfile, appData,
    source: path.join(appData, "Folia"), target: path.join(appData, "Markaloo"),
    workRoot, document, settings, anchor, evidence, runElectron, migrate,
    finish: () => {
      assert.ok(evidence.children.every(child => child.exited && child.closed && !child.waitFailure));
      success = true;
    },
  };
}

test("real Electron qualifies one fresh migration, a completed stale read and an unsuccessful exit", {
  skip: process.platform !== "win32" ? "Windows qualification only" :
    !process.env.MARKALOO_TEST_ELECTRON ? "An explicitly allocated pinned Electron binary is required" : false,
}, async t => {
  const executablePath = process.env.MARKALOO_TEST_ELECTRON;
  assert.ok(path.isAbsolute(executablePath));
  const f = setup(t, executablePath);
  const originals = [];
  f.evidence.originals = originals;
  const preserve = (label, directory) => {
    const before = inventory(directory);
    originals.push({ label, directory, before });
    return before;
  };
  function control(label) {
    const appData = path.join(f.root, label, "app-data");
    const workRoot = path.join(f.root, label, "probe-work");
    const source = path.join(appData, "Folia");
    fs.mkdirSync(appData, { recursive: true });
    fs.mkdirSync(workRoot, { recursive: true });
    fs.cpSync(f.source, source, { recursive: true, errorOnExist: true, force: false });
    preserve(label, source);
    return { appData, workRoot, source };
  }
  try {
    // Each phase runs once. Any unexpected result stops all later native work.
    const seeded = await f.runElectron("seed", f.seedProfile);
    assert.equal(seeded.storageKey, "file:///");
    assert.equal(seeded.storagePath, f.seedProfile);
    preserve("seed", f.seedProfile);
    fs.cpSync(f.seedProfile, f.source, { recursive: true, errorOnExist: true, force: false });
    assert.equal(verifySupportedLocalStorage(f.source).status, "preconditions-checked");
    const entry = {
      id: "a".repeat(32), filePath: f.document, provenance: "native-dialog",
      scrollPosition: 42, anchor: f.anchor,
    };
    fs.writeFileSync(path.join(f.source, "window-state.json"),
      '{"width":900,"height":700,"updateSchedule":{"lastAttemptAt":122}}');
    fs.writeFileSync(path.join(f.source, "document-session.json"), JSON.stringify({
      version: 1, importStatus: "completed", entries: [entry],
      approvedEntries: [entry], activeEntryId: entry.id,
    }));
    fs.writeFileSync(path.join(f.source, "document-session-import.json"),
      '{"version":1,"status":"completed"}');
    const sourceBefore = preserve("fresh-source", f.source);
    f.evidence.sourceBefore = sourceBefore;
    assert.deepEqual(await f.migrate(f.appData, "probe"), { status: "migrated", targetPath: f.target });
    const { run } = assertProbeRun(f, "probe", 0);
    assert.deepEqual(run.callbackResults, [{ status: "validated", backend: "leveldb" }]);
    assert.equal(fs.existsSync(path.join(f.target, RECEIPT_NAME)), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME))).status, "completed");
    assert.deepEqual(inventory(f.source), sourceBefore);
    const copied = Object.entries(sourceBefore).filter(([relative, file]) =>
      !file.directory && (relative.startsWith(`${storage}${path.sep}`) &&
        /^(?:CURRENT|MANIFEST-\d+|\d+\.(?:log|ldb|sst))$/.test(path.basename(relative)) ||
        ["window-state.json", "document-session.json", "document-session-import.json"].includes(relative)));
    const targetBeforeRead = inventory(f.target);
    for (const [relative, bytes] of copied) assert.deepEqual(targetBeforeRead[relative], bytes);
    f.evidence.targetBeforeReadback = targetBeforeRead;
    const readback = await f.runElectron("readback", f.target);
    assert.equal(readback.storagePath, f.target);
    assert.deepEqual(new Map(readback.settings), new Map(f.settings));
    for (const [name, value] of Object.entries(readback.diskState)) {
      assert.deepEqual(value, JSON.parse(fs.readFileSync(path.join(f.source, name), "utf8")));
    }
    assert.equal(Object.keys(readback.diskState).length, 3);
    assert.deepEqual(inventory(f.source), sourceBefore);
    assert.deepEqual(fs.readdirSync(f.workRoot), []);

    const stale = control("stale-origin-control");
    await assert.rejects(f.migrate(stale.appData, "probe-stale-origin", stale.workRoot), error => {
      assert.ok(codes(error).includes("ERR_PROBE_NOT_FRESH"));
      return true;
    });
    const { run: staleRun, response: staleResponse } = assertProbeRun(f, "probe-stale-origin", 1);
    assert.deepEqual(staleRun.callbackResults, []);
    assert.deepEqual(Object.keys(staleResponse).sort(), ["code", "requestId", "status", "version"]);
    assert.equal(staleResponse.status, "error");
    assert.equal(staleResponse.code, "ERR_PROBE_NOT_FRESH");
    assert.equal(staleRun.report.probeError.code, "ERR_PROBE_NOT_FRESH");
    assert.equal(staleRun.report.staleRead.storagePath, staleRun.report.probeProfile);
    assert.equal(staleRun.report.staleRead.storageKey, "file:///");
    assert.equal(staleRun.report.staleRead.securityOrigin, "file://");
    assert.equal(staleRun.report.staleRead.documentURL,
      pathToFileURL(path.join(__dirname, "..", "src", "profile-migration-probe.html")).href);
    assert.deepEqual(new Map(staleRun.report.staleRead.settings), new Map(f.settings));
    const staleEvents = staleRun.report.events;
    const initialQuery = staleEvents.find(item => item.method === "Browser.getHistograms").order;
    const completedRead = staleEvents.find(item => item.event === "storage.map-read-completed").order;
    const destroyed = staleEvents.find(item => item.event === "storage.window-destroyed");
    assert.equal(destroyed.destroyed, true);
    assert.ok(completedRead < destroyed.order && destroyed.order < initialQuery);
    const staleHistograms = staleRun.report.histogramResponses[0].response.histograms;
    for (const name of ["Storage.LocalStorage.ReadMapKeyValues.OnDisk",
      "Storage.LocalStorage.Duration.ReadMapKeyValues.OnDisk"]) {
      assert.ok(staleHistograms.some(item => item.name === name && item.count > 0), name);
    }
    assert.deepEqual(fs.readdirSync(stale.appData), ["Folia"]);
    assert.equal(fs.readdirSync(stale.workRoot).length, 1, "stale-read probe work is preserved");
    f.evidence.staleWorkBeforeExitControl = inventory(stale.workRoot);

    // Same real successful probe/packet, but the actual exit remains unsuccessful.
    const refused = control("negative-exit-control");
    await assert.rejects(f.migrate(refused.appData, "probe-exit-failure", refused.workRoot), error => {
      assert.ok(codes(error).includes("ERR_VALIDATION_CHILD_EXIT"));
      return true;
    });
    const { run: refusedRun } = assertProbeRun(f, "probe-exit-failure", 7);
    assert.deepEqual(refusedRun.callbackResults, []);
    assert.equal(refusedRun.report.requestedExit, 0);
    assert.equal(refusedRun.report.actualExit, 7);
    assert.deepEqual(fs.readdirSync(refused.appData), ["Folia"], "failed stage was cleaned after closure");
    assert.equal(fs.readdirSync(refused.workRoot).length, 1, "failed real child work is preserved");
    assert.deepEqual(inventory(stale.workRoot), f.evidence.staleWorkBeforeExitControl);
    f.evidence.sourceAfter = inventory(f.source);
    assert.deepEqual(f.evidence.sourceAfter, sourceBefore);
    assert.ok(f.evidence.children.every(child => child.exited && child.closed));
  } catch (error) {
    f.evidence.failure = errorReport(error);
    throw error;
  } finally {
    for (const original of originals) {
      original.after = inventory(original.directory);
      if (original.label !== "seed") {
        original.targetAfter = inventory(path.join(path.dirname(original.directory), "Markaloo"));
      }
    }
    for (const original of originals) {
      assert.deepEqual(original.after, original.before, `${original.label} changed`);
    }
  }
  f.finish();
});

function assertWaitListenersCleared(child) {
  for (const event of ["spawn", "error", "exit", "close"]) {
    assert.equal(child.listenerCount(event), 0, `${event} observer was not removed`);
  }
}

function nodeDeadlineControl(t, script, options, { refuseStop = false, missing = false } = {}) {
  assert.equal(process.versions.electron, undefined, "Deadline controls must use Node, not Electron");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "markaloo-parent-deadline-"));
  const env = { ...process.env };
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"]) delete env[name];
  const child = spawn(missing ? path.join(root, "missing-node.exe") : process.execPath,
    ["-e", `setTimeout(() => process.exit(99), 2000).unref(); ${script}`], {
      cwd: root, env, windowsHide: true, shell: false, stdio: "ignore",
    });
  const state = { role: "Node-only parent deadline control", pid: child.pid };
  let stopCalls = 0;
  const stop = child.kill.bind(child);
  child.kill = signal => {
    stopCalls++;
    return refuseStop ? false : stop(signal);
  };
  const completion = waitForFixtureClose(child, state, options);
  t.after(() => t.diagnostic(JSON.stringify({ root, stopCalls, state })));
  return {
    child, root, state, completion, stopCalls: () => stopCalls,
    cleanup: () => {
      assert.equal(state.closed, true, "Unproven child resources must be preserved");
      assertWaitListenersCleared(child);
      fs.rmSync(root, { recursive: true });
    },
  };
}

function deadlineChildDouble() {
  // No OS process exists; kill/unref only record calls on this emitter.
  const child = new EventEmitter();
  child.stopCalls = 0;
  child.unrefCalls = 0;
  child.pipeUnrefCalls = 0;
  child.kill = () => { child.stopCalls++; return true; };
  child.unref = () => { child.unrefCalls++; };
  child.stdio = [{ unref: () => { child.pipeUnrefCalls++; } }];
  return child;
}

test("parent close deadline observes a natural Node exit and close without termination", {
  timeout: 5000,
}, async t => {
  const f = nodeDeadlineControl(t, "", { timeoutMs: 2000, closeTimeoutMs: 500 });
  await f.completion;
  assert.equal(f.state.spawned, true);
  assert.equal(f.state.code, 0);
  assert.equal(f.state.closeCode, 0);
  assert.equal(f.state.exited && f.state.closed, true);
  assert.equal(f.state.waitFailure, undefined);
  assert.equal(f.stopCalls(), 0);
  f.cleanup();
});

test("parent close deadline stops Node bootstrap before the delayed fixture payload", {
  timeout: 5000,
}, async t => {
  const f = nodeDeadlineControl(t,
    "setTimeout(() => require('node:fs').writeFileSync('fixture-started', 'yes'), 60000);",
    { timeoutMs: 30, closeTimeoutMs: 2000 });
  await assert.rejects(f.completion, { code: "ERR_FIXTURE_PARENT_TIMEOUT" });
  assert.equal(f.state.timedOut, true);
  assert.equal(f.stopCalls(), 1);
  assert.equal(f.state.exited && f.state.closed, true);
  assert.equal(f.state.unprovenExit || f.state.unprovenClose, false);
  assert.equal(fs.existsSync(path.join(f.root, "fixture-started")), false);
  f.cleanup();
});

test("parent close deadline rejects a late successful Node result and actual exit zero", {
  timeout: 5000,
}, async t => {
  const f = nodeDeadlineControl(t,
    "setTimeout(() => require('node:fs').writeFileSync('late-result', 'observed'), 160);",
    { timeoutMs: 30, closeTimeoutMs: 3000 }, { refuseStop: true });
  await assert.rejects(f.completion, { code: "ERR_FIXTURE_PARENT_TIMEOUT" });
  assert.equal(f.state.waitFailure.code, "ERR_FIXTURE_PARENT_TIMEOUT");
  assert.equal(f.state.terminationFailure.code, "ERR_FIXTURE_PARENT_STOP");
  assert.equal(f.stopCalls(), 1);
  assert.equal(f.state.exited && f.state.closed, true);
  assert.equal(f.state.code, 0);
  assert.equal(f.state.closeCode, 0);
  assert.equal(fs.readFileSync(path.join(f.root, "late-result"), "utf8"), "observed");
  f.cleanup();
});

test("parent close deadline preserves a real spawn failure without inventing an exit", {
  timeout: 5000,
}, async t => {
  const f = nodeDeadlineControl(t, "", { timeoutMs: 2000, closeTimeoutMs: 500 }, { missing: true });
  await assert.rejects(f.completion, { code: "ENOENT" });
  assert.equal(f.state.waitFailure.code, "ENOENT");
  assert.equal(f.state.exited, false);
  assert.equal(f.state.closed, true);
  assert.equal(f.state.unprovenExit, true);
  assert.equal(f.stopCalls(), 0);
  f.cleanup();
});

test("parent close deadline retains timeout when termination throws and closure is unproven", async t => {
  const child = deadlineChildDouble();
  const state = {};
  child.kill = () => {
    child.stopCalls++;
    throw Object.assign(new Error("Owned control denies termination"), { code: "EPERM" });
  };
  await assert.rejects(waitForFixtureClose(child, state, {
    timeoutMs: 15, closeTimeoutMs: 20,
  }), { code: "ERR_FIXTURE_PARENT_TIMEOUT" });
  assert.equal(state.terminationFailure.code, "EPERM");
  assert.equal(state.exited || state.closed, false);
  assert.equal(state.unprovenExit && state.unprovenClose, true);
  assert.equal(child.stopCalls, 1);
  assert.equal(child.unrefCalls, 1);
  assert.equal(child.pipeUnrefCalls, 1);
  assertWaitListenersCleared(child);
  t.diagnostic(JSON.stringify(state));
});

test("parent close deadline never treats an accepted termination as observed closure", async t => {
  const child = deadlineChildDouble();
  const state = {};
  await assert.rejects(waitForFixtureClose(child, state, {
    timeoutMs: 15, closeTimeoutMs: 20,
  }), { code: "ERR_FIXTURE_PARENT_TIMEOUT" });
  assert.equal(state.terminationReturned, true);
  assert.equal(state.unprovenExit && state.unprovenClose, true);
  assert.equal(child.stopCalls, 1);
  assertWaitListenersCleared(child);
  t.diagnostic(JSON.stringify(state));
});

test("parent close deadline preserves an earlier child error through timeout and failed termination", async () => {
  const child = deadlineChildDouble();
  const state = {};
  const original = Object.assign(new Error("Original owned-child failure"), { code: "EIO" });
  child.kill = () => {
    child.stopCalls++;
    throw Object.assign(new Error("Secondary stop failure"), { code: "EPERM" });
  };
  const completion = waitForFixtureClose(child, state, { timeoutMs: 15, closeTimeoutMs: 40 });
  child.emit("error", original);
  await assert.rejects(completion, error => error === original);
  assert.equal(state.waitFailure.code, "EIO");
  assert.equal(state.timedOut, true);
  assert.equal(state.terminationFailure.code, "EPERM");
  assert.equal(child.stopCalls, 1);
  assert.equal(state.unprovenExit && state.unprovenClose, true);
  assertWaitListenersCleared(child);
});

test("parent close deadline waits for close after exit without signaling an exited child", async () => {
  const child = deadlineChildDouble();
  const state = {};
  const completion = waitForFixtureClose(child, state, { timeoutMs: 15, closeTimeoutMs: 20 });
  child.emit("exit", 0, null);
  await assert.rejects(completion, { code: "ERR_FIXTURE_PARENT_TIMEOUT" });
  assert.equal(state.exited, true);
  assert.equal(state.closed, false);
  assert.equal(state.unprovenClose, true);
  assert.equal(child.stopCalls, 0);
  assert.equal(child.pipeUnrefCalls, 1);
  assertWaitListenersCleared(child);
});

test("parent close deadline rejects an overdue exit before its timer callback can run", async () => {
  const child = deadlineChildDouble();
  const state = {};
  const completion = waitForFixtureClose(child, state, { timeoutMs: 15, closeTimeoutMs: 20 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  await assert.rejects(completion, { code: "ERR_FIXTURE_PARENT_TIMEOUT" });
  assert.equal(state.exited && state.closed && state.timedOut, true);
  assert.equal(child.stopCalls, 0);
  assertWaitListenersCleared(child);
});

test("parent close deadline retains timeout through synchronous termination/close delivery", async () => {
  const child = deadlineChildDouble();
  const state = {};
  child.kill = () => {
    child.stopCalls++;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    return true;
  };
  await assert.rejects(waitForFixtureClose(child, state, {
    timeoutMs: 15, closeTimeoutMs: 20,
  }), { code: "ERR_FIXTURE_PARENT_TIMEOUT" });
  assert.equal(state.exited && state.closed, true);
  assert.equal(state.terminationReturned, true);
  assert.equal(child.stopCalls, 1);
  assertWaitListenersCleared(child);
});

test("parent close deadline refuses close without exit and removes every observer", async () => {
  const child = deadlineChildDouble();
  const state = {};
  const completion = waitForFixtureClose(child, state, { timeoutMs: 1000, closeTimeoutMs: 20 });
  child.emit("close", 0, null);
  await assert.rejects(completion, { code: "ERR_FIXTURE_PARENT_UNPROVEN_EXIT" });
  assert.equal(state.exited, false);
  assert.equal(state.closed, true);
  assert.equal(child.stopCalls, 0);
  assertWaitListenersCleared(child);
});

async function composedStopControl(t, { first = "adapter", stop = "false", close = false,
  exitOnly = false, childError = false } = {}) {
  assert.equal(process.versions.electron, undefined);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "markaloo-shared-stop-"));
  const directory = path.join(root, "input", storage);
  const workRoot = path.join(root, "probe-work");
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(workRoot);
  fs.writeFileSync(path.join(directory, "CURRENT"), "MANIFEST-000001\n");
  fs.writeFileSync(path.join(directory, "MANIFEST-000001"), "owned synthetic manifest");
  const before = inventory(path.join(root, "input"));
  const child = new EventEmitter();
  // This emitter has no OS process. Both real owners call the same recording method.
  child.pid = 1;
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  child.unref = () => {};
  const stops = [];
  child.kill = signal => {
    stops.push(signal);
    assert.equal(state.stopAttempt.signal, signal, "The attempt must be latched before calling kill");
    if (stop === "throw") {
      throw Object.assign(new Error("Owned composed control denies termination"), { code: "EPERM" });
    }
    return false;
  };
  const state = {};
  let parentWait;
  let parentListeners;
  let request;
  const validator = createLocalStorageValidator({
    executablePath: process.execPath, workRoot,
    timeoutMs: first === "adapter" ? 15 : 100, shutdownTimeoutMs: 20,
    spawnChild: (_executable, _args, options) => {
      assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
      parentWait = waitForFixtureClose(child, state, {
        timeoutMs: first === "parent" ? 15 : 100, closeTimeoutMs: 20,
      });
      parentListeners = ["spawn", "error", "exit", "close"].flatMap(event =>
        child.listeners(event).map(listener => ({ event, listener })));
      const requestChunks = [];
      child.stdio[3].on("data", bytes => requestChunks.push(bytes));
      child.stdio[3].once("finish", () => {
        request = decodePacket(requestChunks.map(bytes => bytes.toString("base64")));
        assert.equal(path.dirname(request.workPath), workRoot);
        assert.notEqual(path.join(request.workPath, "profile", storage), directory);
        child.emit("spawn");
        if (childError) {
          child.emit("error", Object.assign(new Error("Original owned-child failure"), { code: "EIO" }));
        }
        if (close) {
          const body = Buffer.from(JSON.stringify({
            version: 1, requestId: request.requestId, status: "observed",
            backend: "leveldb", storageKey: "file:///", openCount: 1, readCount: 1,
          }));
          const header = Buffer.alloc(4);
          header.writeUInt32BE(body.length);
          child.stdio[4].end(Buffer.concat([header, body]));
        }
        if (close || exitOnly) {
          setImmediate(() => {
            child.emit("exit", 0, null);
            if (close) child.emit("close", 0, null);
          });
        }
      });
      return child;
    },
  });
  const validation = validator({ directory, backend: "leveldb" });
  assert.ok(parentWait, "The real adapter must reach the real parent waiter");
  const [adapterResult, parentResult] = await Promise.allSettled([validation, parentWait]);
  assert.deepEqual(inventory(path.join(root, "input")), before);
  for (const { event, listener } of parentListeners) {
    assert.equal(child.listeners(event).includes(listener), false, "Parent observer must be detached");
  }
  const evidence = {
    root, first, stop, close, exitOnly, childError, stops, state, request,
    adapter: adapterResult.status === "rejected"
      ? errorReport(adapterResult.reason) : adapterResult.value,
    parent: parentResult.status === "rejected" ? errorReport(parentResult.reason) : "closed",
    inputUnchanged: true, workPreserved: fs.existsSync(request.workPath),
    childKind: "Controlled emitter only; no OS process or native storage",
  };
  fs.writeFileSync(path.join(root, "composed-stop-evidence.json"), JSON.stringify(evidence, null, 2));
  t.diagnostic(JSON.stringify(evidence));
  return {
    state, stops, adapterResult, parentResult, evidence,
    cleanup: () => fs.rmSync(root, { recursive: true }),
  };
}

for (const first of ["adapter", "parent"]) {
  for (const stop of ["false", "throw"]) {
    test(`composed stop ownership permits one attempt when ${first} is first and stop ${stop}`, async t => {
      const f = await composedStopControl(t, { first, stop });
      assert.equal(f.adapterResult.status, "rejected");
      assert.ok(codes(f.adapterResult.reason).includes("ERR_VALIDATION_TIMEOUT"));
      assert.ok(codes(f.adapterResult.reason).includes("ERR_VALIDATION_CHILD_STILL_RUNNING"));
      assert.ok(codes(f.adapterResult.reason).includes("ERR_VALIDATION_WORK_PRESERVED"));
      assert.equal(f.parentResult.status, "rejected");
      assert.equal(f.parentResult.reason.code, "ERR_FIXTURE_PARENT_TIMEOUT");
      assert.equal(f.state.timedOut, true);
      assert.equal(f.state.unprovenExit && f.state.unprovenClose, true);
      assert.equal(f.evidence.workPreserved, true);
      assert.deepEqual(f.stops, [first === "adapter" ? "SIGKILL" : "SIGTERM"],
        "Count underlying termination calls from BOTH owners, including thrown or false attempts");
      assert.equal(f.state.stopAttempt.owner, first);
      assert.equal(f.state.stopAttempt.failure.code, stop === "throw" ? "EPERM" : "ERR_FIXTURE_STOP_FAILED");
      if (first === "adapter") {
        assert.ok(f.state.terminationSkipped);
        assert.equal(f.state.terminationAttempted, undefined);
        assert.equal(f.state.stopAttempt.blockedRequests, undefined);
        assert.ok(codes(f.adapterResult.reason).includes(
          stop === "throw" ? "EPERM" : "ERR_VALIDATION_CHILD_STOP"));
      } else {
        assert.deepEqual(f.state.stopAttempt.blockedRequests, [{ owner: "adapter", signal: "SIGKILL" }]);
        assert.ok(codes(f.adapterResult.reason).includes("ERR_FIXTURE_STOP_ALREADY_ATTEMPTED"));
        assert.ok(codes(f.adapterResult.reason).includes(
          stop === "throw" ? "EPERM" : "ERR_FIXTURE_STOP_FAILED"));
      }
      f.cleanup();
    });
  }
}

test("composed stop ownership leaves valid natural exit and close untouched", async t => {
  const f = await composedStopControl(t, { close: true });
  assert.equal(f.adapterResult.status, "fulfilled");
  assert.deepEqual(f.adapterResult.value, { status: "validated", backend: "leveldb" });
  assert.equal(f.parentResult.status, "fulfilled");
  assert.equal(f.state.exited && f.state.closed, true);
  assert.equal(f.evidence.workPreserved, false);
  assert.deepEqual(f.stops, []);
  f.cleanup();
});

test("composed stop ownership never signals an observed exit with missing close", async t => {
  const f = await composedStopControl(t, { exitOnly: true });
  assert.equal(f.adapterResult.status, "rejected");
  assert.ok(codes(f.adapterResult.reason).includes("ERR_VALIDATION_CHILD_STILL_RUNNING"));
  assert.equal(f.parentResult.status, "rejected");
  assert.equal(f.parentResult.reason.code, "ERR_FIXTURE_PARENT_TIMEOUT");
  assert.equal(f.state.exited, true);
  assert.equal(f.state.unprovenClose, true);
  assert.deepEqual(f.stops, []);
  f.cleanup();
});

test("composed stop ownership retains the first child error separately from failed stop and timeout", async t => {
  const f = await composedStopControl(t, { childError: true, stop: "throw" });
  assert.equal(f.adapterResult.status, "rejected");
  assert.ok(codes(f.adapterResult.reason).includes("ERR_VALIDATION_SPAWN"));
  assert.ok(codes(f.adapterResult.reason).includes("EIO"));
  assert.ok(codes(f.adapterResult.reason).includes("EPERM"));
  assert.ok(codes(f.adapterResult.reason).includes("ERR_VALIDATION_CHILD_STILL_RUNNING"));
  assert.equal(f.parentResult.status, "rejected");
  assert.equal(f.parentResult.reason.code, "EIO");
  assert.equal(f.state.waitFailure.code, "EIO");
  assert.equal(f.state.timedOut, true);
  assert.equal(f.state.stopAttempt.owner, "adapter");
  assert.equal(f.state.stopAttempt.failure.code, "EPERM");
  assert.ok(f.state.terminationSkipped);
  assert.equal(f.state.unprovenExit && f.state.unprovenClose, true);
  assert.deepEqual(f.stops, ["SIGKILL"]);
  f.cleanup();
});
