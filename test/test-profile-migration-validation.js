"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const {
  CHILD_ARGUMENT, WORK_PREFIX, createLocalStorageValidator,
} = require("../src/profile-migration-validation");

const modulePath = path.resolve(__dirname, "..", "src", "profile-migration-validation.js");

function fixtureMain() {
  const fs = require("node:fs");
  const path = require("node:path");
  const { EventEmitter } = require("node:events");
  const [mode, modulePath, inputDirectory, workRoot, reportPath] = process.argv.slice(2);
  if (mode === "import-only") {
    const originals = new Map();
    const mutations = ["mkdtempSync", "mkdirSync", "writeFileSync", "rmSync", "copyFileSync"];
    let writes = 0;
    for (const name of mutations) {
      originals.set(name, fs[name]);
      fs[name] = () => { writes++; throw new Error("Import performed a filesystem write"); };
    }
    const cp = require("node:child_process");
    const originalSpawn = cp.spawn;
    cp.spawn = () => { throw new Error("Import launched a process"); };
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function (request, ...rest) {
      if (request === "electron") throw new Error("Import loaded Electron");
      return originalLoad.call(this, request, ...rest);
    };
    require(modulePath);
    for (const [name, original] of originals) fs[name] = original;
    cp.spawn = originalSpawn;
    Module._load = originalLoad;
    fs.writeFileSync(reportPath, JSON.stringify({ writes }));
    return;
  }
  const adapter = require(modulePath);
  if (mode === "absent-stdio-EMFILE" || mode === "absent-stdio-ENFILE") {
    const report = { rejected: false, uncaught: false, kills: 0 };
    const spawnError = new Error("Owned fixture spawn failed before private stdio setup");
    spawnError.code = mode.slice("absent-stdio-".length);
    const allErrors = error => [
      error, ...(error.cause ? allErrors(error.cause) : []),
      ...(error instanceof AggregateError ? error.errors.flatMap(allErrors) : []),
    ];
    process.once("uncaughtExceptionMonitor", error => {
      report.uncaught = true;
      report.uncaughtCode = error.code;
      fs.writeFileSync(reportPath, JSON.stringify(report));
    });
    const validate = adapter.createLocalStorageValidator({
      executablePath: process.execPath, workRoot,
      timeoutMs: 1000, shutdownTimeoutMs: 1000,
      spawnChild: () => {
        const child = new EventEmitter();
        report.noStdio = child.stdio === undefined;
        report.noPid = child.pid === undefined;
        child.kill = () => {
          report.kills++;
          throw new Error("A never-started fixture must not be killed");
        };
        process.nextTick(() => {
          report.errorListenerBeforeTick = child.listenerCount("error") > 0;
          report.exitListenerBeforeTick = child.listenerCount("exit") > 0;
          report.closeListenerBeforeTick = child.listenerCount("close") > 0;
          child.emit("error", spawnError);
          setImmediate(() => {
            report.workPresentBeforeClose = fs.readdirSync(workRoot).length === 1;
            report.closed = true;
            child.emit("close", -24, null);
          });
        });
        return child;
      },
    });
    void validate({ directory: inputDirectory, backend: "leveldb" }).then(() => {
      report.accepted = true;
      fs.writeFileSync(reportPath, JSON.stringify(report));
      process.exitCode = 1;
    }, error => {
      report.rejected = true;
      report.errorCode = error.code;
      report.errorCodes = allErrors(error).map(item => item.code).filter(Boolean);
      report.originalErrorRetained = allErrors(error).includes(spawnError);
      report.cleanupAfterClose = report.closed === true && fs.readdirSync(workRoot).length === 0;
      fs.writeFileSync(reportPath, JSON.stringify(report));
    });
    return;
  }
  if (mode === "crash-parent") {
    const validate = adapter.createLocalStorageValidator({
      executablePath: process.execPath, workRoot,
      spawnChild: () => process.exit(19),
    });
    void validate({ directory: inputDirectory, backend: "leveldb" });
    return;
  }
  const rawModes = new Set([
    "no-result", "malformed", "duplicate", "wrong-binding", "extra-settings",
    "wrong-backend", "wrong-count", "result-then-fail", "result-then-wait",
    "truncated", "oversized", "invalid-utf8", "wait",
  ]);
  if (rawModes.has(mode)) {
    const requestBytes = fs.readFileSync(3);
    fs.closeSync(3);
    const request = JSON.parse(requestBytes.subarray(4).toString("utf8"));
    if (mode === "wait") {
      fs.writeFileSync(reportPath, JSON.stringify({ requestRead: true }));
      setInterval(() => {}, 1000);
      return;
    }
    if (mode === "no-result") process.exit(0);
    const result = {
      version: 1, requestId: request.requestId, status: "observed",
      backend: "leveldb", storageKey: "file:///", openCount: 1, readCount: 2,
    };
    if (mode === "wrong-binding") result.requestId = "0".repeat(64);
    if (mode === "extra-settings") result.settings = [["themeMode", "dark"]];
    if (mode === "wrong-backend") result.backend = "sqlite";
    if (mode === "wrong-count") result.openCount = 0;
    let body = Buffer.from(mode === "malformed" ? "{not JSON" : JSON.stringify(result));
    if (mode === "invalid-utf8") body = Buffer.from([0xff, 0xfe]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(mode === "oversized" ? 3 * 1024 * 1024 : body.length);
    const packet = Buffer.concat([header, body]);
    fs.writeSync(4, mode === "truncated" ? packet.subarray(0, 7) : packet);
    if (mode === "duplicate") fs.writeSync(4, packet);
    fs.closeSync(4);
    if (mode === "result-then-wait") {
      fs.writeFileSync(reportPath, JSON.stringify({ requestRead: true, responseWritten: true }));
      setInterval(() => {}, 1000);
      return;
    }
    process.exit(mode === "result-then-fail" ? 7 : 0);
  }
  const app = new EventEmitter();
  const paths = new Map();
  let ready = false;
  const report = { setBeforeReady: true, probeCalls: 0 };
  app.isReady = () => ready;
  app.whenReady = () => { throw new Error("whenReady must not be awaited"); };
  app.setPath = (name, value) => {
    report.setBeforeReady &&= !ready;
    paths.set(name, value);
    fs.writeFileSync(path.join(value, "owned-bootstrap-data"), name);
  };
  app.getPath = name => paths.get(name);
  app.exit = code => {
    report.exitCode = code;
    fs.writeFileSync(reportPath, JSON.stringify(report));
    process.exit(code);
  };
  const probe = async ({ profilePath }) => {
    report.probeCalls++;
    report.probeAfterReady = ready;
    report.profilePath = profilePath;
    report.userDataPath = paths.get("userData");
    report.sessionDataPath = paths.get("sessionData");
    const database = path.join(profilePath, "Local Storage", "leveldb");
    report.files = fs.readdirSync(database).sort();
    report.walHash = require("node:crypto").createHash("sha256")
      .update(fs.readFileSync(path.join(database, "000003.log"))).digest("hex");
    if (mode === "detach") {
      const error = new Error("Synthetic debugger detach");
      error.code = "ERR_PROBE_DETACHED";
      throw error;
    }
    if (mode === "mutate-copy") {
      fs.appendFileSync(path.join(database, "000003.log"), "probe-only write");
    }
    if (mode === "change-input") {
      fs.appendFileSync(path.join(inputDirectory, "000003.log"), "external write");
    }
    return {
      status: "observed", storageKey: "file:///", openCount: 1, readCount: 2,
      settings: mode === "empty-settings" ? [] :
        [["themeMode", "dark"], ["unknown-key", "synthetic-private-value"]],
    };
  };
  try {
    const prepared = adapter.prepareProfileValidationChild({ electron: { app }, probe });
    report.returnedBeforeReady = !ready;
    prepared.completion.catch(error => { report.errorCode = error.code; });
    setImmediate(() => {
      if (mode === "bootstrap-drift") paths.set("sessionData", "unbound session path");
      ready = true;
      app.emit("ready");
    });
  } catch (error) {
    report.errorCode = error.code;
    app.exit(1);
  }
}

function setup(t, profileName = "stage") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "markaloo-validation-test-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const profile = path.join(root, profileName);
  const directory = path.join(profile, "Local Storage", "leveldb");
  const workRoot = path.join(root, "work");
  const fixture = path.join(root, "child.js");
  const report = path.join(root, "report.json");
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(workRoot);
  fs.writeFileSync(path.join(directory, "CURRENT"), "MANIFEST-000001\n");
  fs.writeFileSync(path.join(directory, "MANIFEST-000001"), "owned fixture manifest");
  fs.writeFileSync(path.join(directory, "000002.ldb"), Buffer.from([0, 1, 255, 0, 13, 10]));
  fs.writeFileSync(path.join(directory, "000003.log"), Buffer.from([255, 0, 23, 10, 0]));
  fs.writeFileSync(path.join(directory, "LOCK"), "");
  fs.writeFileSync(path.join(directory, "LOG"), "diagnostic, not WAL");
  fs.writeFileSync(fixture, `(${fixtureMain.toString()})();`);
  const owned = { root, profile, directory, workRoot, fixture, report };
  owned.validator = (mode = "success", options = {}) => createLocalStorageValidator({
    executablePath: process.execPath,
    args: [fixture, mode, modulePath, directory, workRoot, report],
    workRoot, timeoutMs: 3000, shutdownTimeoutMs: 1000, ...options,
  });
  return owned;
}

function hashes(directory) {
  return fs.readdirSync(directory).sort().map(name => ({
    name,
    hash: crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, name)))
      .digest("hex"),
  }));
}

function codes(error) {
  return [
    error.code,
    ...(error.cause ? codes(error.cause) : []),
    ...(error instanceof AggregateError ? error.errors.flatMap(codes) : []),
  ].filter(Boolean);
}

function hasCode(expected) {
  return error => {
    assert.ok(codes(error).includes(expected), `Expected error code ${expected}`);
    return true;
  };
}

test("import prepares no process, Electron session, bootstrap or work directory", t => {
  const owned = setup(t);
  const result = spawnSync(process.execPath, [
    owned.fixture, "import-only", modulePath, owned.directory, owned.workRoot, owned.report,
  ], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(owned.report, "utf8")), { writes: 0 });
  assert.deepEqual(fs.readdirSync(owned.workRoot), []);
  assert.equal(typeof createLocalStorageValidator, "function");
  assert.equal(CHILD_ARGUMENT, "--markaloo-profile-validation-child");
});

test("successful process exit is not acceptance before result pipe EOF/close", async t => {
  const owned = setup(t);
  let actualExit = false;
  let workBeforeEof = false;
  const validate = owned.validator("success", {
    spawnChild: (...args) => lateResultPipe(args, () => {
      actualExit = true;
      workBeforeEof = fs.readdirSync(owned.workRoot).length === 1;
      return "";
    }),
  });
  await validate({ directory: owned.directory, backend: "leveldb" });
  assert.ok(actualExit);
  assert.ok(workBeforeEof, "cleanup waited for result EOF after the real child exited");
  assert.deepEqual(fs.readdirSync(owned.workRoot), []);
});

test("trailing response after successful process exit is rejected", async t => {
  const owned = setup(t);
  let actualExit = false;
  const validate = owned.validator("success", {
    spawnChild: (...args) => lateResultPipe(args, () => {
      actualExit = true;
      return "trailing bytes after actual child exit";
    }),
  });
  await assert.rejects(
    validate({ directory: owned.directory, backend: "leveldb" }),
    hasCode("ERR_VALIDATION_PROTOCOL"));
  assert.ok(actualExit, "the controlled late tail followed actual fixture process exit");
  assert.equal(fs.readdirSync(owned.workRoot).length, 1);
});

// A real fixture child supplies the packet/exit. Delay only the exposed readable
// EOF to model queued output after exit without relying on OS pipe timing.
function lateResultPipe(args, afterExit) {
  const child = spawn(...args);
  const relay = new EventEmitter();
  const result = new PassThrough();
  relay.pid = child.pid;
  relay.kill = (...args) => child.kill(...args);
  relay.stdio = [...child.stdio];
  relay.stdio[4] = result;
  child.stdio[4].on("data", chunk => result.write(chunk));
  child.stdio[4].on("error", error => result.destroy(error));
  for (const event of ["spawn", "error", "exit"]) {
    child.on(event, (...values) => relay.emit(event, ...values));
  }
  child.once("close", (code, signal) => {
    setImmediate(() => {
      const tail = afterExit();
      result.once("end", () => queueMicrotask(() => relay.emit("close", code, signal)));
      result.end(tail);
    });
  });
  return relay;
}

for (const profileName of ["untouched-stage", "Markaloo"]) {
  test(`real Node pipe child validates a disposable copy of ${profileName}`, async t => {
    const owned = setup(t, profileName);
    const before = hashes(owned.directory);
    const packets = [];
    const requests = [];
    let childClosed = false;
    const validate = owned.validator("success", {
      spawnChild: (executable, args, options) => {
        assert.equal(executable, process.execPath);
        assert.equal(args.at(-1), CHILD_ARGUMENT);
        assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
        assert.equal(options.shell, false);
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
        assert.equal(options.env.NODE_OPTIONS, undefined);
        assert.equal(options.env.NODE_PATH, undefined);
        const child = spawn(executable, args, options);
        const endRequest = child.stdio[3].end;
        child.stdio[3].end = function (data, ...rest) {
          requests.push(Buffer.from(data));
          return endRequest.call(this, data, ...rest);
        };
        child.stdio[4].on("data", chunk => packets.push(chunk));
        child.once("close", () => { childClosed = true; });
        return child;
      },
    });
    assert.deepEqual(await validate({ directory: owned.directory, backend: "leveldb" }),
      { status: "validated", backend: "leveldb" });
    assert.ok(childClosed, "actual child close precedes success and cleanup");
    const report = JSON.parse(fs.readFileSync(owned.report, "utf8"));
    assert.equal(report.probeCalls, 1);
    assert.ok(report.setBeforeReady && report.returnedBeforeReady && report.probeAfterReady);
    assert.notEqual(report.profilePath, owned.profile);
    assert.notEqual(report.userDataPath, report.profilePath);
    assert.notEqual(report.sessionDataPath, report.profilePath);
    assert.notEqual(report.sessionDataPath, report.userDataPath);
    assert.deepEqual(report.files, ["000002.ldb", "000003.log", "CURRENT", "MANIFEST-000001"]);
    assert.equal(report.walHash, before.find(file => file.name === "000003.log").hash);
    assert.deepEqual(hashes(owned.directory), before);
    assert.deepEqual(fs.readdirSync(owned.workRoot), []);
    const result = JSON.parse(Buffer.concat(packets).subarray(4).toString("utf8"));
    assert.deepEqual(Object.keys(result).sort(), [
      "backend", "openCount", "readCount", "requestId", "status", "storageKey", "version",
    ]);
    assert.ok(!JSON.stringify(result).includes("synthetic-private-value"));
    const request = JSON.parse(Buffer.concat(requests).subarray(4).toString("utf8"));
    assert.deepEqual(Object.keys(request).sort(), [
      "files", "requestId", "timeoutMs", "version", "workIdentity", "workPath",
    ]);
    assert.ok(!JSON.stringify(request).includes(JSON.stringify(owned.directory).slice(1, -1)));
    assert.ok(!JSON.stringify(request).includes("synthetic-private-value"));
    for (const file of request.files) {
      assert.deepEqual(Object.keys(file).sort(), ["bytes", "name", "sha256"]);
    }
  });
}

test("probe-written disposable WAL is discarded and original bytes remain unchanged", async t => {
  const owned = setup(t);
  const before = hashes(owned.directory);
  await owned.validator("mutate-copy")({ directory: owned.directory, backend: "leveldb" });
  assert.deepEqual(hashes(owned.directory), before);
  assert.deepEqual(fs.readdirSync(owned.workRoot), []);
});

test("input change during child observation refuses success after real child exit", async t => {
  const owned = setup(t);
  const before = hashes(owned.directory);
  await assert.rejects(
    owned.validator("change-input")({ directory: owned.directory, backend: "leveldb" }),
    hasCode("ERR_VALIDATION_INPUT_CHANGED"));
  assert.notDeepEqual(hashes(owned.directory), before, "the injected input mutation happened");
  assert.deepEqual(fs.readdirSync(owned.workRoot), []);
});

for (const [mode, code] of [
  ["detach", "ERR_PROBE_DETACHED"],
  ["empty-settings", "ERR_PROBE_EMPTY_SETTINGS"],
  ["bootstrap-drift", "ERR_VALIDATION_BOOTSTRAP"],
  ["no-result", "ERR_VALIDATION_PROTOCOL"],
  ["malformed", "ERR_VALIDATION_PROTOCOL"],
  ["duplicate", "ERR_VALIDATION_PROTOCOL"],
  ["wrong-binding", "ERR_VALIDATION_PROTOCOL"],
  ["extra-settings", "ERR_VALIDATION_PROTOCOL"],
  ["wrong-backend", "ERR_VALIDATION_PROTOCOL"],
  ["wrong-count", "ERR_VALIDATION_PROTOCOL"],
  ["result-then-fail", "ERR_VALIDATION_CHILD_EXIT"],
  ["truncated", "ERR_VALIDATION_PROTOCOL"],
  ["oversized", "ERR_VALIDATION_PROTOCOL"],
  ["invalid-utf8", "ERR_VALIDATION_PROTOCOL"],
]) {
  test(`child ${mode} fails closed and preserves owned work after actual exit`, async t => {
    const owned = setup(t);
    const before = hashes(owned.directory);
    let closed = false;
    const validate = owned.validator(mode, {
      spawnChild: (...args) => {
        const child = spawn(...args);
        child.once("close", () => { closed = true; });
        return child;
      },
    });
    let preserved;
    await assert.rejects(validate({ directory: owned.directory, backend: "leveldb" }), error => {
      hasCode(code)(error);
      preserved = error.workPath;
      return true;
    });
    assert.ok(closed, "the fixture child really exited before failure returned");
    assert.ok(preserved && fs.existsSync(preserved));
    assert.deepEqual(hashes(owned.directory), before);
    await assert.rejects(validate({ directory: owned.directory, backend: "leveldb" }),
      hasCode("ERR_VALIDATION_WORK_LEFTOVER"));
    assert.equal(fs.readdirSync(owned.workRoot).length, 1);
  });
}

for (const mode of ["wait", "result-then-wait"]) {
  test(`${mode} cannot succeed without bounded successful child exit`, async t => {
    const owned = setup(t);
    let closed = false;
    const started = Date.now();
    const validate = owned.validator(mode, {
      timeoutMs: 1500,
      spawnChild: (...args) => {
        const child = spawn(...args);
        child.once("close", () => { closed = true; });
        return child;
      },
    });
    await assert.rejects(validate({ directory: owned.directory, backend: "leveldb" }),
      hasCode("ERR_VALIDATION_TIMEOUT"));
    assert.ok(closed, "timeout killed and awaited the actual fixture child");
    assert.ok(Date.now() - started < 3500);
    const report = JSON.parse(fs.readFileSync(owned.report, "utf8"));
    assert.equal(report.requestRead, true, "the request was admitted before timeout");
    if (mode === "result-then-wait") assert.equal(report.responseWritten, true);
    assert.equal(fs.readdirSync(owned.workRoot).length, 1);
  });
}

test("spawn failure is explicit and cleans only never-opened owned work", async t => {
  const owned = setup(t);
  const validate = owned.validator("success", {
    executablePath: path.join(owned.root, "missing-program.exe"),
  });
  await assert.rejects(validate({ directory: owned.directory, backend: "leveldb" }),
    hasCode("ERR_VALIDATION_SPAWN"));
  assert.deepEqual(fs.readdirSync(owned.workRoot), []);
});

for (const code of ["EMFILE", "ENFILE"]) {
  test(`absent stdio with next-tick ${code} rejects without an uncaught parent error`, t => {
    const owned = setup(t);
    const before = hashes(owned.directory);
    const result = spawnSync(process.execPath, [
      owned.fixture, `absent-stdio-${code}`, modulePath,
      owned.directory, owned.workRoot, owned.report,
    ], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "", "the fixture parent did not emit an uncaught error");
    const report = JSON.parse(fs.readFileSync(owned.report, "utf8"));
    assert.ok(report.noStdio && report.noPid, "the failed spawn returned no private stdio or PID");
    assert.ok(report.errorListenerBeforeTick && report.exitListenerBeforeTick &&
      report.closeListenerBeforeTick, "child error and lifetime handling preceded stream admission");
    assert.ok(report.rejected && !report.accepted && !report.uncaught);
    assert.equal(report.errorCode, "ERR_VALIDATION_SPAWN");
    assert.ok(report.errorCodes.includes(code) && report.originalErrorRetained);
    assert.equal(report.kills, 0);
    assert.ok(report.workPresentBeforeClose && report.cleanupAfterClose,
      "the never-started disposable copy stayed owned until controlled child closure");
    assert.deepEqual(fs.readdirSync(owned.workRoot), []);
    assert.deepEqual(hashes(owned.directory), before);
  });
}

test("unproven process shutdown preserves work and reports stop/exit uncertainty", async t => {
  const owned = setup(t);
  let actualClosed;
  const actualExit = new Promise(resolve => { actualClosed = resolve; });
  const validate = owned.validator("wait", {
    timeoutMs: 1000, shutdownTimeoutMs: 100,
    spawnChild: (...args) => {
      const child = spawn(...args);
      const relay = new EventEmitter();
      relay.pid = child.pid;
      relay.stdio = child.stdio;
      relay.kill = signal => {
        child.kill(signal);
        return false;
      };
      child.once("spawn", () => relay.emit("spawn"));
      child.once("error", error => relay.emit("error", error));
      child.once("close", actualClosed);
      return relay;
    },
  });
  await assert.rejects(validate({ directory: owned.directory, backend: "leveldb" }), error => {
    hasCode("ERR_VALIDATION_TIMEOUT")(error);
    hasCode("ERR_VALIDATION_CHILD_STOP")(error);
    hasCode("ERR_VALIDATION_CHILD_STILL_RUNNING")(error);
    assert.ok(error.workPath && fs.existsSync(error.workPath));
    return true;
  });
  await actualExit;
  assert.equal(fs.readdirSync(owned.workRoot).length, 1);
});

for (const [kind, expected] of [
  ["changed-wal", "ERR_VALIDATION_COPY_MISMATCH"],
  ["prior-open", "ERR_VALIDATION_COPY_MISMATCH"],
  ["sqlite", "ERR_PROBE_UNSUPPORTED_SQLITE"],
]) {
  test(`child independently rejects ${kind} before observation`, async t => {
    const owned = setup(t);
    const before = hashes(owned.directory);
    const validate = owned.validator("success", {
      spawnChild: (executable, args, options) => {
        const profile = path.join(options.cwd, "profile");
        const database = path.join(profile, "Local Storage", "leveldb");
        if (kind === "changed-wal") fs.appendFileSync(path.join(database, "000003.log"), "changed");
        if (kind === "prior-open") fs.writeFileSync(path.join(database, "LOCK"), "");
        if (kind === "sqlite") fs.writeFileSync(path.join(profile, "LocalStorage"), "");
        return spawn(executable, args, options);
      },
    });
    await assert.rejects(validate({ directory: owned.directory, backend: "leveldb" }),
      hasCode(expected));
    const report = JSON.parse(fs.readFileSync(owned.report, "utf8"));
    assert.equal(report.probeCalls, 0, `child ${kind} refused before storage access`);
    assert.deepEqual(hashes(owned.directory), before);
    assert.equal(fs.readdirSync(owned.workRoot).length, 1);
  });
}

test("all reserved leftovers are reported and preserved without ownership guessing", async t => {
  const owned = setup(t);
  const leftovers = [path.join(owned.workRoot, `${WORK_PREFIX}unknown`),
    path.join(owned.workRoot, ".MARKALOO-PROBE-stale")];
  fs.mkdirSync(leftovers[0]);
  fs.writeFileSync(path.join(leftovers[0], "keep"), "unchanged");
  fs.writeFileSync(leftovers[1], "also keep");
  const validate = owned.validator();
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(validate({ directory: owned.directory, backend: "leveldb" }), error => {
      hasCode("ERR_VALIDATION_WORK_LEFTOVER")(error);
      assert.deepEqual(error.preservedPaths.sort(), [...leftovers].sort());
      assert.ok(leftovers.every(file => error.message.includes(file)));
      return true;
    });
    assert.equal(fs.readdirSync(owned.workRoot).length, 2);
    assert.equal(fs.readFileSync(path.join(leftovers[0], "keep"), "utf8"), "unchanged");
    assert.equal(fs.readFileSync(leftovers[1], "utf8"), "also keep");
  }
});

test("genuine parent exit after clone allocation leaves reported unchanged work on retry", async t => {
  const owned = setup(t);
  const before = hashes(owned.directory);
  const result = spawnSync(process.execPath, [
    owned.fixture, "crash-parent", modulePath, owned.directory, owned.workRoot, owned.report,
  ], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 19, "fixture parent actually terminated during its spawn boundary");
  const entries = fs.readdirSync(owned.workRoot);
  assert.equal(entries.length, 1);
  const preserved = path.join(owned.workRoot, entries[0]);
  const clone = path.join(preserved, "profile", "Local Storage", "leveldb");
  const copyBefore = hashes(clone);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      owned.validator()({ directory: owned.directory, backend: "leveldb" }),
      hasCode("ERR_VALIDATION_WORK_LEFTOVER"));
    assert.deepEqual(hashes(clone), copyBefore);
    assert.deepEqual(hashes(owned.directory), before);
    assert.deepEqual(fs.readdirSync(owned.workRoot), entries);
  }
});

test("cleanup refuses a replaced owner marker and never deletes unproven work", async t => {
  const owned = setup(t);
  let preserved;
  const validate = owned.validator("success", {
    spawnChild: (...args) => {
      const child = spawn(...args);
      child.once("close", () => {
        preserved = path.join(owned.workRoot, fs.readdirSync(owned.workRoot)[0]);
        fs.writeFileSync(path.join(preserved, "probe-owner.json"), "replaced");
      });
      return child;
    },
  });
  await assert.rejects(validate({ directory: owned.directory, backend: "leveldb" }),
    hasCode("ERR_VALIDATION_CLEANUP"));
  assert.equal(fs.readFileSync(path.join(preserved, "probe-owner.json"), "utf8"), "replaced");
  assert.ok(fs.existsSync(path.join(preserved, "profile")));
});

test("copy verification detects changed destination bytes before spawning", async t => {
  const owned = setup(t);
  const before = hashes(owned.directory);
  const originalCopy = fs.copyFileSync;
  let spawns = 0;
  fs.copyFileSync = (source, destination, flags) => {
    originalCopy(source, destination, flags);
    if (path.basename(destination) === "000003.log") fs.appendFileSync(destination, "bad copy");
  };
  try {
    await assert.rejects(owned.validator("success", {
      spawnChild: () => { spawns++; throw new Error("Must not spawn after a bad copy"); },
    })({ directory: owned.directory, backend: "leveldb" }),
    hasCode("ERR_VALIDATION_COPY_MISMATCH"));
  } finally {
    fs.copyFileSync = originalCopy;
  }
  assert.equal(spawns, 0);
  assert.deepEqual(hashes(owned.directory), before);
  assert.deepEqual(fs.readdirSync(owned.workRoot), []);
});

test("input changed during copy refuses observation before spawning", async t => {
  const owned = setup(t);
  const originalCopy = fs.copyFileSync;
  let injected = false;
  let spawns = 0;
  fs.copyFileSync = (source, destination, flags) => {
    originalCopy(source, destination, flags);
    if (path.basename(source) === "000003.log") {
      fs.appendFileSync(source, "external change");
      injected = true;
    }
  };
  try {
    await assert.rejects(owned.validator("success", {
      spawnChild: () => { spawns++; throw new Error("Must not spawn after input mutation"); },
    })({ directory: owned.directory, backend: "leveldb" }),
    hasCode("ERR_VALIDATION_INPUT_CHANGED"));
  } finally {
    fs.copyFileSync = originalCopy;
  }
  assert.ok(injected);
  assert.equal(spawns, 0);
  assert.deepEqual(fs.readdirSync(owned.workRoot), []);
});

test("database read and descriptor cleanup errors are both retained", async t => {
  const owned = setup(t);
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  let targetFd;
  let injected = false;
  fs.readSync = function (fd, ...args) {
    if (!injected) {
      injected = true;
      targetFd = fd;
      const error = new Error("Owned fixture database read failure");
      error.code = "ERR_FIXTURE_READ";
      throw error;
    }
    return originalRead.call(this, fd, ...args);
  };
  fs.closeSync = function (fd) {
    originalClose.call(this, fd);
    if (fd === targetFd) {
      targetFd = undefined;
      const error = new Error("Owned fixture descriptor cleanup failure");
      error.code = "ERR_FIXTURE_CLOSE";
      throw error;
    }
  };
  try {
    await assert.rejects(owned.validator()({ directory: owned.directory, backend: "leveldb" }),
      error => {
        hasCode("ERR_FIXTURE_READ")(error);
        hasCode("ERR_FIXTURE_CLOSE")(error);
        return true;
      });
  } finally {
    fs.readSync = originalRead;
    fs.closeSync = originalClose;
  }
  assert.ok(injected);
  assert.deepEqual(fs.readdirSync(owned.workRoot), []);
});

test("unchanged-input verification also covers disposable cleanup", async t => {
  const owned = setup(t);
  const originalRemove = fs.rmSync;
  let injected = false;
  fs.rmSync = function (directory, options) {
    originalRemove.call(this, directory, options);
    if (path.dirname(directory) === owned.workRoot) {
      fs.appendFileSync(path.join(owned.directory, "000003.log"), "external cleanup-time change");
      injected = true;
    }
  };
  try {
    await assert.rejects(owned.validator()({ directory: owned.directory, backend: "leveldb" }),
      hasCode("ERR_VALIDATION_INPUT_CHANGED"));
  } finally {
    fs.rmSync = originalRemove;
  }
  assert.ok(injected);
  assert.deepEqual(fs.readdirSync(owned.workRoot), []);
});

test("cleanup refuses a redirected nested entry without touching its target", async t => {
  const owned = setup(t);
  const other = path.join(owned.root, "not-disposable");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "keep"), "original data");
  const validate = owned.validator("success", {
    spawnChild: (...args) => {
      const child = spawn(...args);
      child.once("close", () => {
        const work = path.join(owned.workRoot, fs.readdirSync(owned.workRoot)[0]);
        fs.symlinkSync(other, path.join(work, "redirect"), "junction");
      });
      return child;
    },
  });
  await assert.rejects(validate({ directory: owned.directory, backend: "leveldb" }),
    hasCode("ERR_VALIDATION_CLEANUP"));
  assert.equal(fs.readFileSync(path.join(other, "keep"), "utf8"), "original data");
  assert.equal(fs.readdirSync(owned.workRoot).length, 1);
});

test("input and cleanup failures are both retained", async t => {
  const owned = setup(t);
  const validate = owned.validator("change-input", {
    spawnChild: (...args) => {
      const child = spawn(...args);
      child.once("close", () => {
        const work = path.join(owned.workRoot, fs.readdirSync(owned.workRoot)[0]);
        fs.writeFileSync(path.join(work, "probe-owner.json"), "changed");
      });
      return child;
    },
  });
  await assert.rejects(validate({ directory: owned.directory, backend: "leveldb" }), error => {
    hasCode("ERR_VALIDATION_INPUT_CHANGED")(error);
    hasCode("ERR_VALIDATION_CLEANUP")(error);
    return true;
  });
});

for (const [bad, expected] of [
  ["root-sqlite", "ERR_PROBE_UNSUPPORTED_SQLITE"],
  ["sidecar", "ERR_PROBE_UNSUPPORTED_SQLITE"],
  ["rebuild", "ERR_PROBE_REBUILD"],
  ["unknown", "ERR_VALIDATION_INVENTORY"],
  ["bad-current", "ERR_PROBE_CURRENT"],
]) {
  test(`unsupported ${bad} refuses before work allocation`, async t => {
    const owned = setup(t);
    if (bad === "root-sqlite") fs.writeFileSync(path.join(owned.profile, "LocalStorage"), "");
    if (bad === "sidecar") fs.writeFileSync(path.join(owned.profile, "LocalStorage-wal"), "");
    if (bad === "rebuild") fs.mkdirSync(`${owned.directory}__tmp_for_rebuild`);
    if (bad === "unknown") fs.writeFileSync(path.join(owned.directory, "mystery.db"), "");
    if (bad === "bad-current") fs.writeFileSync(path.join(owned.directory, "CURRENT"), "../outside\n");
    await assert.rejects(owned.validator()({ directory: owned.directory, backend: "leveldb" }),
      hasCode(expected));
    assert.deepEqual(fs.readdirSync(owned.workRoot), [], `no copy allocated for ${bad}`);
  });
}

test("callback backend and work-inside-profile are rejected", async t => {
  const owned = setup(t);
  await assert.rejects(owned.validator()({ directory: owned.directory, backend: "sqlite" }),
    hasCode("ERR_VALIDATION_BACKEND"));
  const validate = owned.validator("success", { workRoot: owned.profile });
  await assert.rejects(validate({ directory: owned.directory, backend: "leveldb" }),
    hasCode("ERR_VALIDATION_PATH"));
});

test("one validator refuses concurrent callbacks without allocating another clone", async t => {
  const owned = setup(t);
  const validate = owned.validator("wait", { timeoutMs: 500 });
  const first = validate({ directory: owned.directory, backend: "leveldb" });
  const expectedFailure = assert.rejects(first, hasCode("ERR_VALIDATION_TIMEOUT"));
  await assert.rejects(validate({ directory: owned.directory, backend: "leveldb" }),
    hasCode("ERR_VALIDATION_BUSY"));
  await expectedFailure;
  assert.equal(fs.readdirSync(owned.workRoot).length, 1);
});
