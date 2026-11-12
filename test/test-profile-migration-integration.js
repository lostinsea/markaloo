"use strict";

// Compose the real migration/clone/protocol modules with owned Node children.
// Database bytes, probe telemetry and application ownership remain fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const { migrateWindowsProfile, RECEIPT_NAME } = require("../src/profile-migration");
const {
  createLocalStorageValidator, CHILD_ARGUMENT, WORK_PREFIX,
} = require("../src/profile-migration-validation");

const childPath = path.join(__dirname, "fixtures", "profile-migration-integration-child.js");
const storage = path.join("Local Storage", "leveldb");
const windowsOnly = { skip: process.platform !== "win32" };

function tree(directory) {
  if (!fs.existsSync(directory)) return null;
  const result = {};
  function visit(base, prefix = "") {
    for (const name of fs.readdirSync(base).sort()) {
      const relative = path.join(prefix, name);
      const file = path.join(base, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        result[`${relative}${path.sep}`] = "directory";
        visit(file, relative);
      } else {
        assert.ok(stat.isFile() && !stat.isSymbolicLink());
        result[relative] = fs.readFileSync(file).toString("base64");
      }
    }
  }
  visit(directory);
  return result;
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "markaloo-profile-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, "app-data");
  const source = path.join(appData, "Folia");
  const target = path.join(appData, "Markaloo");
  const workRoot = path.join(root, "probe-work");
  const reportPath = path.join(root, "child-report.json");
  const document = path.join(root, "original-document.md");
  fs.mkdirSync(path.join(source, storage), { recursive: true });
  fs.mkdirSync(workRoot);
  fs.writeFileSync(document, "# Original document\n");
  const anchor = { scrollTop: 40, text: "Heading", ordinal: 1, delta: -2 };
  const entry = {
    id: "a".repeat(32), filePath: document, provenance: "native-dialog",
    scrollPosition: 42, anchor,
  };
  const settings = [
    ["themeMode", "dark"], ["darkMode", "enabled"],
    ["themeLightScheme", "withdrawn-light-scheme"], ["themeDarkScheme", "base-dark"],
    ["readingZoom", "130"], ["notesVisible", "visible"],
    ["editorSplitRatio", "0.65"], ["readingSidePanel", "toc"],
    ["recentFiles", JSON.stringify([{ path: document, name: "Original", timestamp: 123 }])],
    ["openTabs", JSON.stringify([{ filePath: document, scrollPosition: 42, anchor }])],
    ["activeTabPath", document], ["future-setting", "keep this fixture value"],
  ];
  const files = {
    "window-state.json": JSON.stringify({
      width: 900, height: 700, maximized: true,
      updateSchedule: { lastAttemptAt: 122 }, updateAvailability: { availableVersion: "0.13.0" },
      futureSetting: { retained: true },
    }),
    "document-session.json": JSON.stringify({
      version: 1, importStatus: "completed", entries: [entry],
      approvedEntries: [entry], activeEntryId: entry.id,
    }),
    "document-session-import.json": '{"version":1,"status":"completed"}',
    [path.join(storage, "CURRENT")]: "MANIFEST-000001\n",
    [path.join(storage, "MANIFEST-000001")]: "owned synthetic manifest, not a LevelDB database",
    [path.join(storage, "000002.ldb")]: Buffer.from([0, 1, 255, 13, 10]),
    [path.join(storage, "000003.log")]: JSON.stringify({ settings }),
  };
  for (const [relative, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(source, relative), bytes);
  }
  fs.writeFileSync(path.join(source, storage, "LOCK"), "not copied");
  fs.writeFileSync(path.join(source, storage, "LOG"), "diagnostic, not copied");
  fs.writeFileSync(path.join(source, "Cookies"), "not copied");
  fs.writeFileSync(path.join(source, ".updaterId"), "not copied");
  return { root, appData, source, target, workRoot, reportPath, document, files, settings };
}

function allCodes(error) {
  return [
    error.code,
    ...(error.cause ? allCodes(error.cause) : []),
    ...(error instanceof AggregateError ? error.errors.flatMap(allCodes) : []),
  ].filter(Boolean);
}

function hasCode(expected) {
  return error => {
    assert.ok(allCodes(error).includes(expected),
      `Expected ${expected}; got ${allCodes(error).join(", ")}`);
    return true;
  };
}

function stages(f) {
  return fs.readdirSync(f.appData).filter(name => name.startsWith(".markaloo-migration-"));
}

function receipt(f) {
  return JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8"));
}

function compose(f, mode = "mutate-clone", spawnOverride) {
  const calls = { held: false, inputs: [], results: [], children: [], requests: [], packets: [] };
  const validator = createLocalStorageValidator({
    executablePath: process.execPath,
    args: [childPath, "probe", mode, f.reportPath],
    workRoot: f.workRoot, timeoutMs: 5000, shutdownTimeoutMs: 1000,
    spawnChild: (executable, args, options) => {
      assert.equal(calls.held, true);
      assert.equal(args.at(-1), CHILD_ARGUMENT);
      assert.equal(args.includes(f.source), false);
      assert.equal(args.includes(f.target), false);
      assert.equal(path.dirname(options.cwd), f.workRoot);
      assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
      assert.equal(options.shell, false);
      const child = spawnOverride
        ? spawnOverride(executable, args, options) : spawn(executable, args, options);
      const observed = { pid: child.pid, exited: false, ended: false, closed: false };
      calls.children.push(observed);
      const endRequest = child.stdio[3].end;
      child.stdio[3].end = function (data, ...rest) {
        calls.requests.push(Buffer.from(data));
        return endRequest.call(this, data, ...rest);
      };
      child.stdio[4].on("data", data => calls.packets.push(Buffer.from(data)));
      child.stdio[4].once("end", () => { observed.ended = true; });
      child.once("exit", (code, signal) => {
        observed.exited = true;
        observed.code = code;
        observed.signal = signal;
      });
      child.once("close", () => {
        assert.equal(calls.held, true, "ownership spans actual child close");
        observed.closed = true;
      });
      return child;
    },
  });
  return {
    calls,
    options: {
      appDataPath: f.appData,
      withProfileOwnership: async (profiles, run) => {
        assert.deepEqual(profiles, { sourcePath: f.source, targetPath: f.target });
        assert.equal(calls.held, false);
        calls.held = true;
        try {
          return await run();
        } finally {
          calls.held = false;
        }
      },
      validateLocalStorage: async input => {
        assert.equal(calls.held, true);
        assert.equal(input.backend, "leveldb");
        assert.notEqual(input.directory, path.join(f.source, storage));
        const before = tree(input.directory);
        calls.inputs.push(input.directory);
        const result = await validator(input);
        assert.deepEqual(result, { status: "validated", backend: "leveldb" });
        assert.deepEqual(tree(input.directory), before, "the adapter never probes its input");
        assert.ok(calls.children.at(-1).exited && calls.children.at(-1).ended &&
          calls.children.at(-1).closed, "validation awaits exit, EOF and close");
        calls.results.push(result);
        return result;
      },
    },
  };
}

function assertUnpublished(f, before) {
  assert.equal(fs.existsSync(f.target), false);
  assert.deepEqual(tree(f.source), before);
  assert.deepEqual(stages(f), []);
}

function interruptPublication(f) {
  const before = tree(f.source);
  const child = spawnSync(process.execPath, [
    childPath, "interrupt-migration", "after-publish", f.reportPath, f.appData, f.workRoot,
  ], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 23, child.stderr);
  assert.equal(receipt(f).status, "pending");
  assert.deepEqual(tree(f.source), before);
  assert.deepEqual(stages(f), []);
  assert.deepEqual(fs.readdirSync(f.workRoot), []);
}

test("composed migration preserves settings/window/tabs and probes only a disposable clone", windowsOnly, async t => {
  const f = setup(t);
  const sourceBefore = tree(f.source);
  const documentBefore = fs.readFileSync(f.document);
  const { options, calls } = compose(f);
  assert.deepEqual(await migrateWindowsProfile(options), { status: "migrated", targetPath: f.target });
  assert.equal(receipt(f).status, "completed");
  assert.deepEqual(Object.keys(receipt(f).files).sort(), Object.keys(f.files).sort());
  for (const [relative, bytes] of Object.entries(f.files)) {
    assert.deepEqual(fs.readFileSync(path.join(f.target, relative)), Buffer.from(bytes));
  }
  assert.equal(fs.existsSync(path.join(f.target, "Cookies")), false);
  assert.equal(fs.existsSync(path.join(f.target, ".updaterId")), false);
  assert.equal(fs.existsSync(path.join(f.target, storage, "LOCK")), false);
  assert.equal(fs.existsSync(path.join(f.target, storage, "LOG")), false);
  assert.deepEqual(tree(f.source), sourceBefore);
  assert.deepEqual(fs.readFileSync(f.document), documentBefore);
  assert.equal(calls.inputs.length, 1);
  assert.ok(path.basename(path.dirname(path.dirname(calls.inputs[0]))).startsWith(".markaloo-migration-"));
  const report = JSON.parse(fs.readFileSync(f.reportPath, "utf8"));
  assert.ok(report.setBeforeReady && report.returnedBeforeReady && report.probeAfterReady);
  assert.equal(report.cloneChanged, true, "the probe actually wrote to its disposable WAL");
  assert.equal(report.walHash, crypto.createHash("sha256")
    .update(f.files[path.join(storage, "000003.log")]).digest("hex"));
  assert.deepEqual(report.files, ["000002.ldb", "000003.log", "CURRENT", "MANIFEST-000001"]);
  const work = path.dirname(report.profilePath);
  assert.equal(path.dirname(work), f.workRoot);
  assert.ok(path.basename(work).startsWith(WORK_PREFIX));
  assert.deepEqual(new Set([report.profilePath, report.userDataPath, report.sessionDataPath]).size, 3);
  for (const location of [report.profilePath, report.userDataPath, report.sessionDataPath]) {
    assert.equal(path.dirname(location), work);
    assert.equal(fs.existsSync(location), false, "successful child work is cleaned only after close");
  }
  const request = JSON.parse(calls.requests[0].subarray(4).toString("utf8"));
  assert.deepEqual(Object.keys(request).sort(),
    ["files", "requestId", "timeoutMs", "version", "workIdentity", "workPath"]);
  assert.equal(request.workPath, work);
  assert.deepEqual(request.files.map(file => file.name), report.files);
  const response = JSON.parse(Buffer.concat(calls.packets).subarray(4).toString("utf8"));
  assert.deepEqual(response, {
    version: 1, requestId: request.requestId, status: "observed",
    backend: "leveldb", storageKey: "file:///", openCount: 1, readCount: 1,
  });
  assert.equal(JSON.stringify(response).includes("settings"), false);
  assert.equal(calls.held, false);
  assert.deepEqual(stages(f), []);
  assert.deepEqual(fs.readdirSync(f.workRoot), []);
});

test("established target is validated without importing corrupt legacy data or reclaiming a leftover", windowsOnly, async t => {
  const f = setup(t);
  fs.renameSync(f.source, f.target);
  fs.mkdirSync(f.source);
  fs.writeFileSync(path.join(f.source, "window-state.json"), "{bad legacy");
  const leftover = path.join(f.appData, ".markaloo-migration-unknown");
  fs.writeFileSync(leftover, "not owned");
  const sourceBefore = tree(f.source);
  const targetBefore = tree(f.target);
  const { options, calls } = compose(f);
  assert.deepEqual(await migrateWindowsProfile(options), { status: "existing", targetPath: f.target });
  assert.deepEqual(calls.inputs, [path.join(f.target, storage)]);
  assert.deepEqual(tree(f.target), targetBefore);
  assert.deepEqual(tree(f.source), sourceBefore);
  assert.equal(fs.existsSync(path.join(f.target, RECEIPT_NAME)), false);
  assert.equal(fs.readFileSync(leftover, "utf8"), "not owned");
  assert.deepEqual(fs.readdirSync(f.workRoot), []);
});

test("completed target can evolve and rotate its database without reimport or historical hash equality", windowsOnly, async t => {
  const f = setup(t);
  await migrateWindowsProfile(compose(f).options);
  const completed = fs.readFileSync(path.join(f.target, RECEIPT_NAME));
  fs.writeFileSync(path.join(f.target, "window-state.json"), '{"width":1100,"height":800}');
  fs.renameSync(path.join(f.target, storage, "MANIFEST-000001"),
    path.join(f.target, storage, "MANIFEST-000004"));
  fs.writeFileSync(path.join(f.target, storage, "CURRENT"), "MANIFEST-000004\n");
  fs.writeFileSync(path.join(f.target, storage, "000003.log"),
    JSON.stringify({ settings: [["themeMode", "light"]] }));
  fs.writeFileSync(path.join(f.source, "window-state.json"), "{bad legacy");
  const sourceBefore = tree(f.source);
  const targetBefore = tree(f.target);
  const { options, calls } = compose(f);
  assert.equal((await migrateWindowsProfile(options)).status, "existing");
  assert.deepEqual(calls.inputs, [path.join(f.target, storage)]);
  assert.deepEqual(tree(f.target), targetBefore);
  assert.deepEqual(tree(f.source), sourceBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.target, RECEIPT_NAME)), completed);
});

test("actual post-publication process exit leaves pending data that composed retry validates and completes", windowsOnly, async t => {
  const f = setup(t);
  interruptPublication(f);
  fs.writeFileSync(path.join(f.source, "window-state.json"), "{do not reimport");
  const sourceBefore = tree(f.source);
  const targetBefore = tree(f.target);
  const { options, calls } = compose(f);
  assert.equal((await migrateWindowsProfile(options)).status, "existing");
  assert.equal(receipt(f).status, "completed");
  assert.deepEqual(calls.inputs, [path.join(f.target, storage)]);
  const after = tree(f.target);
  delete targetBefore[RECEIPT_NAME];
  delete after[RECEIPT_NAME];
  assert.deepEqual(after, targetBefore, "completion changes only the receipt");
  assert.deepEqual(tree(f.source), sourceBefore);
  assert.deepEqual(stages(f), []);
  assert.deepEqual(fs.readdirSync(f.workRoot), []);
});

test("changed pending publication refuses repeated composed retries before any probe or completion", windowsOnly, async t => {
  const f = setup(t);
  interruptPublication(f);
  fs.writeFileSync(path.join(f.target, "window-state.json"), '{"width":1000,"height":800}');
  const sourceBefore = tree(f.source);
  const targetBefore = tree(f.target);
  const { options, calls } = compose(f);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(migrateWindowsProfile(options), hasCode("PROFILE_PENDING_CHANGED"));
    assert.equal(receipt(f).status, "pending");
    assert.deepEqual(tree(f.target), targetBefore);
    assert.deepEqual(tree(f.source), sourceBefore);
    assert.deepEqual(fs.readdirSync(f.workRoot), []);
    assert.deepEqual(stages(f), []);
  }
  assert.equal(calls.inputs.length, 0);
  assert.equal(calls.children.length, 0);
});

test("pending validation failure preserves the exact publication and cannot mark it completed", windowsOnly, async t => {
  const f = setup(t);
  interruptPublication(f);
  const sourceBefore = tree(f.source);
  const targetBefore = tree(f.target);
  const { options, calls } = compose(f, "result-then-fail");
  await assert.rejects(migrateWindowsProfile(options), hasCode("ERR_VALIDATION_CHILD_EXIT"));
  assert.equal(receipt(f).status, "pending");
  assert.deepEqual(calls.inputs, [path.join(f.target, storage)]);
  assert.deepEqual(tree(f.target), targetBefore);
  assert.deepEqual(tree(f.source), sourceBefore);
  const preserved = tree(f.workRoot);
  assert.equal(fs.readdirSync(f.workRoot).length, 1);
  await assert.rejects(migrateWindowsProfile(options), hasCode("ERR_VALIDATION_WORK_LEFTOVER"));
  assert.deepEqual(tree(f.target), targetBefore);
  assert.deepEqual(tree(f.source), sourceBefore);
  assert.deepEqual(tree(f.workRoot), preserved);
  assert.equal(calls.children.length, 1);
  assert.deepEqual(stages(f), []);
});

for (const [mode, expected] of [
  ["invalid-settings", "ERR_PROBE_SETTINGS"],
  ["result-then-fail", "ERR_VALIDATION_CHILD_EXIT"],
  ["no-result", "ERR_VALIDATION_PROTOCOL"],
]) {
  test(`composed ${mode} refuses publication and preserves failed probe work across retry`, windowsOnly, async t => {
    const f = setup(t);
    if (mode === "invalid-settings") {
      fs.writeFileSync(path.join(f.source, storage, "000003.log"),
        JSON.stringify({ settings: [["themeMode", "not-a-supported-mode"]] }));
    }
    const before = tree(f.source);
    const { options, calls } = compose(f, mode);
    await assert.rejects(migrateWindowsProfile(options), hasCode(expected));
    assertUnpublished(f, before);
    assert.equal(calls.children.length, 1);
    assert.ok(calls.children[0].exited && calls.children[0].closed);
    if (mode === "no-result") assert.equal(calls.children[0].code, 0);
    if (mode === "result-then-fail") {
      assert.equal(calls.children[0].code, 9);
      assert.equal(calls.children[0].ended, true);
      assert.equal(JSON.parse(Buffer.concat(calls.packets).subarray(4)).status, "observed");
    }
    const names = fs.readdirSync(f.workRoot);
    assert.equal(names.length, 1);
    assert.ok(names[0].startsWith(WORK_PREFIX));
    const preserved = tree(f.workRoot);
    await assert.rejects(migrateWindowsProfile(options), hasCode("ERR_VALIDATION_WORK_LEFTOVER"));
    assertUnpublished(f, before);
    assert.deepEqual(tree(f.workRoot), preserved);
    assert.equal(calls.children.length, 1, "retry cannot launch over unreviewed work");
    assert.equal(calls.held, false);
  });
}

test("valid observation plus EOF cannot publish while the real child is still running", windowsOnly, async t => {
  const f = setup(t);
  const before = tree(f.source);
  let eof;
  const ended = new Promise(resolve => { eof = resolve; });
  let child;
  const { options, calls } = compose(f, "result-then-wait", (...args) => {
    child = spawn(...args);
    child.stdio[4].once("end", eof);
    return child;
  });
  let settled = false;
  const outcome = migrateWindowsProfile(options).then(
    result => { settled = true; return { result }; },
    error => { settled = true; return { error }; },
  );
  let result;
  try {
    const eofBeforeSettlement = await Promise.race([
      ended.then(() => true), outcome.then(() => false),
    ]);
    assert.equal(eofBeforeSettlement, true, "the real result EOF must be observed");
    assert.equal(JSON.parse(Buffer.concat(calls.packets).subarray(4)).status, "observed");
    assert.equal(settled, false);
    assert.equal(child.exitCode, null, "EOF precedes actual fixture exit");
    assert.equal(calls.held, true);
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(stages(f).length, 1);
  } finally {
    result = await outcome;
  }
  assert.ok(result.error);
  hasCode("ERR_VALIDATION_TIMEOUT")(result.error);
  assert.ok(calls.children[0].exited && calls.children[0].closed);
  assertUnpublished(f, before);
  assert.equal(fs.readdirSync(f.workRoot).length, 1);
});

// Keep the real packet and process exit; delay only the exposed result EOF.
function delayedEof(executable, args, options, afterActualClose, tail, closeObservable = true) {
  const child = spawn(executable, args, options);
  const relay = new EventEmitter();
  const result = new PassThrough();
  relay.pid = child.pid;
  relay.kill = (...values) => child.kill(...values);
  relay.stdio = [...child.stdio];
  relay.stdio[4] = result;
  child.stdio[4].on("data", data => result.write(data));
  child.stdio[4].on("error", error => result.destroy(error));
  for (const event of ["spawn", "error", "exit"]) {
    child.on(event, (...values) => relay.emit(event, ...values));
  }
  child.once("close", (code, signal) => {
    afterActualClose(code, signal);
    setImmediate(() => {
      if (closeObservable) {
        result.once("end", () => queueMicrotask(() => relay.emit("close", code, signal)));
      }
      result.end(tail);
    });
  });
  return relay;
}

test("unproven child close preserves probe work and refuses publication despite a real successful exit", windowsOnly, async t => {
  const f = setup(t);
  const before = tree(f.source);
  let actualClosed = false;
  const { options, calls } = compose(f, "mutate-clone", (executable, args, spawnOptions) =>
    delayedEof(executable, args, spawnOptions, (code, signal) => {
      assert.equal(code, 0);
      assert.equal(signal, null);
      actualClosed = true;
    }, "", false));
  await assert.rejects(migrateWindowsProfile(options), error => {
    hasCode("ERR_VALIDATION_CHILD_STILL_RUNNING")(error);
    hasCode("ERR_VALIDATION_WORK_PRESERVED")(error);
    return true;
  });
  assert.equal(actualClosed, true, "the owned Node process really finished; only close delivery was withheld");
  assert.equal(calls.children[0].exited, true);
  assert.equal(calls.children[0].ended, true);
  assert.equal(calls.children[0].closed, false, "the adapter never received close evidence");
  assert.equal(calls.held, false);
  assertUnpublished(f, before);
  assert.equal(fs.readdirSync(f.workRoot).length, 1);
  const preserved = tree(f.workRoot);
  await assert.rejects(migrateWindowsProfile(options), hasCode("ERR_VALIDATION_WORK_LEFTOVER"));
  assert.deepEqual(tree(f.workRoot), preserved);
  assert.equal(calls.children.length, 1);
});

for (const tail of ["", "late trailing bytes"]) {
  test(`actual child exit waits for result EOF${tail ? " and rejects a late tail" : " before publishing"}`, windowsOnly, async t => {
    const f = setup(t);
    const before = tree(f.source);
    let sawExitBeforeEof = false;
    let settled = false;
    const { options, calls } = compose(f, "mutate-clone", (executable, args, spawnOptions) =>
      delayedEof(executable, args, spawnOptions, (code, signal) => {
        assert.equal(code, 0);
        assert.equal(signal, null);
        assert.equal(calls.children[0].exited, true);
        assert.equal(calls.children[0].ended, false);
        assert.equal(calls.held, true);
        assert.equal(settled, false);
        assert.equal(fs.existsSync(f.target), false);
        assert.equal(stages(f).length, 1);
        sawExitBeforeEof = true;
      }, tail));
    const outcome = migrateWindowsProfile(options).finally(() => { settled = true; });
    if (tail) {
      await assert.rejects(outcome, hasCode("ERR_VALIDATION_PROTOCOL"));
      assertUnpublished(f, before);
      assert.equal(fs.readdirSync(f.workRoot).length, 1);
    } else {
      assert.equal((await outcome).status, "migrated");
      assert.equal(receipt(f).status, "completed");
      assert.deepEqual(fs.readdirSync(f.workRoot), []);
      assert.deepEqual(tree(f.source), before);
    }
    assert.equal(sawExitBeforeEof, true, "the actual successful child exited before controlled EOF");
  });
}

test("real adapter refuses workRoot inside the input profile without launching or changing either profile", windowsOnly, async t => {
  const f = setup(t);
  const before = tree(f.source);
  const { options, calls } = compose(f);
  options.validateLocalStorage = input => createLocalStorageValidator({
    executablePath: process.execPath,
    args: [childPath, "probe", "mutate-clone", f.reportPath],
    workRoot: path.dirname(path.dirname(input.directory)),
    spawnChild: () => assert.fail("invalid workRoot must refuse before launch"),
  })(input);
  await assert.rejects(migrateWindowsProfile(options), hasCode("ERR_VALIDATION_PATH"));
  assertUnpublished(f, before);
  assert.equal(calls.children.length, 0);
  assert.deepEqual(fs.readdirSync(f.workRoot), []);
});

test("SQLite backends and reserved stage leftovers refuse through composition before cloning", windowsOnly, async t => {
  for (const variant of ["sqlite-only", "sqlite-with-leveldb", "sqlite-sidecar", "orphan"]) {
    await t.test(variant, async t => {
      const f = setup(t);
      let expected;
      if (variant === "orphan") {
        fs.mkdirSync(path.join(f.appData, ".markaloo-migration-unowned"));
        fs.writeFileSync(path.join(f.appData, ".markaloo-migration-unowned", "keep"), "unknown bytes");
        expected = "PROFILE_STAGE_LEFTOVER";
      } else {
        if (variant === "sqlite-only") fs.rmSync(path.join(f.source, "Local Storage"), { recursive: true });
        const name = variant === "sqlite-sidecar" ? "LocalStorage-wal" : "LocalStorage";
        fs.writeFileSync(path.join(f.source, name), "unsupported owned SQLite fixture");
        expected = "PROFILE_UNSUPPORTED_SQLITE";
      }
      const before = tree(f.appData);
      const { options, calls } = compose(f);
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(migrateWindowsProfile(options), hasCode(expected));
        assert.deepEqual(tree(f.appData), before);
        assert.deepEqual(fs.readdirSync(f.workRoot), []);
      }
      assert.equal(calls.inputs.length, 0);
      assert.equal(calls.children.length, 0);
    });
  }
});
