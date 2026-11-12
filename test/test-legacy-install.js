"use strict";

// Windows copy checks are opt-in and use only disposable profiles. Cleanup is mocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const migration = require("../src/profile-migration");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "markaloo-simple-copy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "Folia");
  const target = path.join(root, "Markaloo");
  const database = path.join("Local Storage", "leveldb");
  const files = {
    "window-state.json": '{"width":900,"theme":"dark"}',
    "document-session.json": '{"version":1,"importStatus":"completed","entries":[],"approvedEntries":[],"activeEntryId":null}',
    "document-session-import.json": '{"version":1,"status":"completed"}',
    [path.join(database, "CURRENT")]: "MANIFEST-000001\n",
    [path.join(database, "MANIFEST-000001")]: "synthetic manifest",
    [path.join(database, "000002.log")]: "synthetic numeric WAL",
    [path.join(database, "000003.ldb")]: "synthetic database",
    [path.join(database, "LOCK")]: "",
    [path.join(database, "LOG")]: "diagnostic",
    "Cookies": "not settings",
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), text);
  }
  const before = Object.fromEntries(Object.keys(files).map(file =>
    [file, fs.readFileSync(path.join(source, file), "utf8")]));
  return { root, source, target, database, files, before };
}

function copyFixture({ sourcePath, stagePath }) {
  // This is a closed-source adapter stand-in, not evidence of a real Windows lock.
  for (const name of ["window-state.json", "document-session.json", "document-session-import.json"]) {
    if (fs.existsSync(path.join(sourcePath, name))) {
      fs.copyFileSync(path.join(sourcePath, name), path.join(stagePath, name), fs.constants.COPYFILE_EXCL);
    }
  }
  const relative = path.join("Local Storage", "leveldb");
  const database = path.join(sourcePath, relative);
  if (!fs.existsSync(database)) return;
  fs.mkdirSync(path.join(stagePath, relative), { recursive: true });
  for (const name of fs.readdirSync(database)) {
    if (/^(CURRENT|MANIFEST-\d+|\d+\.(log|ldb|sst))$/.test(name)) {
      fs.copyFileSync(path.join(database, name), path.join(stagePath, relative, name),
        fs.constants.COPYFILE_EXCL);
    }
  }
}

test("first startup copies actual settings and numeric WAL, without copying locks/cache or changing Folia", async t => {
  const f = fixture(t);
  const result = await migration.importLegacyProfile({
    appDataPath: f.root, copyClosedProfile: copyFixture,
  });
  assert.equal(result.status, "copied");
  for (const [name, text] of Object.entries(f.before)) {
    assert.equal(fs.readFileSync(path.join(f.source, name), "utf8"), text, name);
    if (name === "Cookies" || ["LOCK", "LOG"].includes(path.basename(name))) {
      assert(!fs.existsSync(path.join(f.target, name)), name);
    } else assert.equal(fs.readFileSync(path.join(f.target, name), "utf8"), text, name);
  }
  assert(!fs.existsSync(path.join(f.target, migration.RECEIPT_NAME)));
  assert(!fs.readdirSync(f.root).some(name => name.startsWith(".markaloo-migration-")));
});

for (const existing of [false, true]) {
  test("missing source/existing Markaloo never invokes the copy adapter, existing=" + existing, async t => {
    const f = fixture(t);
    if (existing) {
      fs.mkdirSync(f.target);
      fs.writeFileSync(path.join(f.target, "settings.txt"), "keep me");
    } else fs.rmSync(f.source, { recursive: true });
    const result = await migration.importLegacyProfile({
      appDataPath: f.root, copyClosedProfile() { assert.fail("unexpected copy"); },
    });
    assert.equal(result.status, existing ? "existing" : "fresh");
    if (existing) assert.equal(fs.readFileSync(path.join(f.target, "settings.txt"), "utf8"), "keep me");
    else assert(!fs.existsSync(f.target));
  });
}

for (const partial of [false, true]) {
  test("busy/partial-copy error keeps original state and never publishes, partial=" + partial, async t => {
    const f = fixture(t);
    const error = Object.assign(new Error(partial ? "copy failed" : "source busy"), {
      code: partial ? "EIO" : "ERR_LEGACY_PROFILE_BUSY",
    });
    await assert.rejects(migration.importLegacyProfile({
      appDataPath: f.root,
      copyClosedProfile(options) {
        if (partial) fs.writeFileSync(path.join(options.stagePath, "window-state.json"), "{}");
        throw error;
      },
    }), actual => actual === error);
    assert(!fs.existsSync(f.target));
    assert.equal(fs.readFileSync(path.join(f.source, "window-state.json"), "utf8"),
      f.before["window-state.json"]);
    assert(!fs.readdirSync(f.root).some(name => name.startsWith(".markaloo-migration-")));
  });
}

test("malformed saved settings refuse before any copy", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "window-state.json"), "not JSON");
  await assert.rejects(migration.importLegacyProfile({
    appDataPath: f.root, copyClosedProfile() { assert.fail("unexpected copy"); },
  }));
  assert(!fs.existsSync(f.target));
});

test("copy and staging-cleanup failures both retain their original errors", async t => {
  const f = fixture(t);
  const copyError = new Error("copy failed");
  const cleanupError = new Error("staging removal failed");
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(
    path.join(__dirname, "..", "src", "profile-migration.js"), "utf8"), {
    module, Buffer, AggregateError,
    require(name) {
      if (name === "node:fs") return { ...fs, rmSync() { throw cleanupError; } };
      return require(name);
    },
  });
  await assert.rejects(module.exports.importLegacyProfile({
    appDataPath: f.root, copyClosedProfile() { throw copyError; },
  }), error => {
    assert.equal(error.errors[0], copyError);
    assert.equal(error.errors[1], cleanupError);
    return true;
  });
  assert(!fs.existsSync(f.target));
  assert.equal(fs.readFileSync(path.join(f.source, "window-state.json"), "utf8"),
    f.before["window-state.json"]);
});

test("changed source or incomplete copy cannot publish success", async t => {
  const f = fixture(t);
  await assert.rejects(migration.importLegacyProfile({
    appDataPath: f.root,
    copyClosedProfile(options) {
      copyFixture(options);
      fs.writeFileSync(path.join(f.source, "window-state.json"), '{"width":1000}');
    },
  }), { code: "PROFILE_CHANGED" });
  assert(!fs.existsSync(f.target));
});

test("an empty default target can receive a completed copy", async t => {
  const f = fixture(t);
  fs.mkdirSync(f.target);
  assert.equal((await migration.importLegacyProfile({
    appDataPath: f.root, copyClosedProfile: copyFixture,
  })).status, "copied");
  assert(fs.existsSync(path.join(f.target, f.database, "000002.log")));
});

test("a target appearing during copy is preserved, not merged or overwritten", async t => {
  const f = fixture(t);
  await assert.rejects(migration.importLegacyProfile({
    appDataPath: f.root,
    copyClosedProfile(options) {
      copyFixture(options);
      fs.mkdirSync(f.target);
      fs.writeFileSync(path.join(f.target, "new-settings"), "concurrent");
    },
  }));
  assert.deepEqual(fs.readdirSync(f.target), ["new-settings"]);
});

function adapter() {
  return require("../src/legacy-install");
}

test("copy adapter uses fixed PowerShell/script arguments and reports all failures", () => {
  const { copyClosedProfile } = adapter();
  for (const outcome of [
    { status: 0 }, { status: 1, stderr: "closed-source check failed" },
    { status: null, error: Object.assign(new Error("not available"), { code: "ENOENT" }) },
  ]) {
    let calls = 0;
    const run = (exe, args, options) => {
      calls++;
      assert.equal(path.basename(exe).toLowerCase(), "powershell.exe");
      assert(args.includes("CopyProfile"));
      assert(args.includes("C:\\synthetic\\Folia"));
      assert(args.includes("C:\\synthetic\\stage"));
      assert.equal(args[args.indexOf("-ExecutionPolicy") + 1], "RemoteSigned");
      assert.equal(options.shell, false);
      return outcome;
    };
    const operation = () => copyClosedProfile({
      sourcePath: "C:\\synthetic\\Folia", stagePath: "C:\\synthetic\\stage", run,
    });
    if (outcome.status === 0) operation();
    else assert.throws(operation);
    assert.equal(calls, 1);
  }
});

test("startup copy adapter cannot attach cleanup or launch an old uninstaller after install", t => {
  const f = fixture(t);
  const app = new EventEmitter();
  assert.deepEqual(Object.keys(adapter()), ["copyClosedProfile"]);
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "legacy-install.js"), "utf8");
  assert.doesNotMatch(source, /\bspawn\b|\.once\(|Cleanup|unref|folia-cleanup/);
  assert.equal(app.listenerCount("quit"), 0);
  assert(!fs.existsSync(f.target));
});

test("stock installer overrides both install/uninstall running checks without any killing or native bridge", () => {
  const root = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf8");
  assert.match(source, /!macro customCheckAppRunning/);
  assert.match(source, /603/);
  assert.match(source, /SetErrorLevel/);
  assert.match(source, /Quit/);
  assert.doesNotMatch(source, /KILL_PROCESS|taskkill|Stop-Process|MarkalooInstallBridge|legacy-install\.nsh/);
  const pkg = require("../package.json");
  assert.equal(pkg.name, "markaloo");
  assert.equal(pkg.build.appId, "io.github.lostinsea.markaloo");
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.selectPerMachineByDefault, true);
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert(pkg.build.files.includes("src/legacy-install.js"));
  assert(pkg.build.extraResources.some(item =>
    item.from === "src/legacy-install.ps1" && item.to === "legacy-install.ps1"));
});

test("Windows adapter holds the source LOCK during copy and limits uninstall to pre-install action", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "legacy-install.ps1"), "utf8");
  const copy = source.slice(source.indexOf("if ($Action -eq 'CopyProfile')"));
  for (const token of ["[IO.FileShare]::None", "[IO.File]::Copy", "$lock.Dispose()"]) {
    assert(copy.includes(token), token);
  }
  assert(copy.indexOf("[IO.FileShare]::None") < copy.indexOf("[IO.File]::Copy"));
  assert(copy.indexOf("[IO.File]::Copy") < copy.indexOf("$lock.Dispose()"));
  assert.match(copy, /CURRENT\|MANIFEST-/);
  assert.match(copy, /log\|ldb\|sst/);
  const cleanup = source.slice(source.indexOf("function Remove-LegacyInstall"));
  for (const token of ["Assert-AppsClosed", "Start-Process"]) {
    assert(cleanup.includes(token), token);
  }
  assert(cleanup.indexOf("Assert-AppsClosed") < cleanup.indexOf("Start-Process"));
  assert.match(cleanup, /243b513d-dcaf-54c6-b3f2-3d91dcfd5689/);
  assert.match(cleanup, /--updated/);
  assert.match(cleanup, /KEEP_APP_DATA/);
  assert.match(source, /ValidateSet\('CopyProfile','BeforeInstallCleanup'\)/);
  assert.doesNotMatch(source, /Stop-Process|taskkill|--delete-app-data|WaitForExit|--keep-shortcuts/);
  assert.doesNotMatch(copy, /OpenBaseKey|Start-Process/);
});

function startupFixture(t, options = {}) {
  const f = fixture(t);
  const events = [];
  const selected = options.relocated ? path.join(f.root, "selected") : f.target;
  if (options.relocated) fs.mkdirSync(selected);
  let userData = selected;
  const app = Object.assign(new EventEmitter(), {
    isPackaged: options.packaged !== false,
    isReady: () => false,
    getName: () => "Markaloo",
    getPath: key => key === "appData" ? f.root : userData,
    setPath(key, value) { assert.equal(key, "userData"); userData = value; events.push("setPath"); },
    requestSingleInstanceLock() { events.push("singleton"); return true; },
    exit(code) { events.push("exit:" + code); },
  });
  const electron = { app, dialog: {
    showErrorBox(title, message) {
      events.push("warning");
      assert.match(message, /still available/);
      if (options.warningFailure) throw new Error("warning unavailable");
    },
  } };
  const owner = Object.assign(new EventEmitter(), {
    pendingCount: () => 0, takeQueued: () => [], enqueue() {},
    setPhase() {}, async close() {
      events.push("admission-closed");
      if (options.closeFailure) throw new Error("admission close failed");
    },
  });
  const admission = {
    MAX_QUEUE: 64,
    createStartupRequest: value => value,
    async admitStartup() { events.push("admission"); return { role: "owner", owner }; },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "profile-startup.js"), "utf8");
  vm.runInNewContext(source, {
    module, exports: module.exports, Buffer, AggregateError,
    process: {
      platform: options.platform || "win32", argv: ["C:\\synthetic\\Markaloo.exe"],
      cwd: () => f.root, execPath: "C:\\synthetic\\Markaloo\\Markaloo.exe",
    },
    console: { error() {} },
    require(name) {
      if (["node:fs", "node:path", "node:crypto", "node:events"].includes(name)) return require(name);
      if (name === "./profile-startup-admission") return admission;
      if (name === "./profile-migration-validation") return {
        CHILD_ARGUMENT: "--markaloo-profile-validation-child",
      };
      if (name === "./profile-migration") return migration;
      if (name === "./legacy-install") return {
        copyClosedProfile(value) {
          events.push("copy");
          if (options.busy) throw new Error("busy source");
          copyFixture(value);
        },
      };
      if (name === "./main") {
        events.push("main");
        if (options.packaged !== false && !options.relocated &&
            (!options.platform || options.platform === "win32")) {
          assert(fs.existsSync(path.join(f.target, "window-state.json")));
        }
        return {};
      }
      assert.fail("Unexpected startup load: " + name);
    },
  });
  return { ...f, events, electron, startup: module.exports, userData: () => userData };
}

test("actual packaged startup imports before singleton/Main and never schedules uninstall", async t => {
  const f = startupFixture(t);
  await f.startup.prepareApplicationStartup(f.electron).completion;
  assert.deepEqual(f.events, ["admission", "copy", "singleton", "main"]);
  assert.equal(f.userData(), f.target);
  assert.equal(f.electron.app.listenerCount("quit"), 0);
  assert.equal(f.electron.app.listenerCount("will-quit"), 1, "The existing admission owner still closes");
  assert.equal(f.electron.app.listenerCount("before-quit"), 0);
  f.electron.app.emit("before-quit");
  f.electron.app.emit("will-quit", { defaultPrevented: false });
  f.electron.app.emit("quit");
  await Promise.resolve();
  assert.deepEqual(f.events, ["admission", "copy", "singleton", "main", "admission-closed"]);
});

test("actual startup failure warns and never creates empty Markaloo state or schedules cleanup", async t => {
  const f = startupFixture(t, { busy: true });
  const prepared = f.startup.prepareApplicationStartup(f.electron);
  await assert.rejects(prepared.completion, error => {
    assert.equal(error.code, "ERR_LEGACY_PROFILE_IMPORT");
    f.startup.reportStartupFailure(f.electron, error);
    return true;
  });
  assert.deepEqual(f.events, ["admission", "copy", "admission-closed", "warning", "exit:1"]);
  assert(!fs.existsSync(f.target));
});

test("import failure remains visible when admission cleanup or the warning also fails", async t => {
  const f = startupFixture(t, { busy: true, closeFailure: true, warningFailure: true });
  const prepared = f.startup.prepareApplicationStartup(f.electron);
  await assert.rejects(prepared.completion, error => {
    assert.equal(error.code, "ERR_LEGACY_PROFILE_IMPORT");
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].cause.message, "busy source");
    assert.equal(error.errors[1].message, "admission close failed");
    f.startup.reportStartupFailure(f.electron, error);
    return true;
  });
  assert.deepEqual(f.events, ["admission", "copy", "admission-closed", "warning", "exit:1"]);
  assert(!fs.existsSync(f.target));
});

for (const lockState of ["closed", "held", "missing"]) {
  test("production Windows copy on disposable bytes, LOCK=" + lockState, {
    skip: process.env.MARKALOO_TEST_WINDOWS_COPY !== "1" || process.platform !== "win32",
  }, async t => {
    const f = fixture(t);
    const lockPath = path.join(f.source, f.database, "LOCK");
    const handle = lockState === "held" ? fs.openSync(lockPath, "r+") : null;
    if (lockState === "missing") fs.unlinkSync(lockPath);
    const operation = migration.importLegacyProfile({
      appDataPath: f.root, copyClosedProfile: adapter().copyClosedProfile,
    });
    if (lockState === "closed") {
      try {
        assert.equal((await operation).status, "copied");
      } catch (error) {
        t.diagnostic(error.cause?.stack || error.stack);
        throw error;
      }
      for (const name of ["window-state.json", "document-session.json",
        "document-session-import.json", path.join(f.database, "CURRENT"),
        path.join(f.database, "MANIFEST-000001"), path.join(f.database, "000002.log"),
        path.join(f.database, "000003.ldb")]) {
        assert.deepEqual(fs.readFileSync(path.join(f.target, name)),
          fs.readFileSync(path.join(f.source, name)), name);
      }
      assert(!fs.existsSync(path.join(f.target, f.database, "LOCK")));
      assert(!fs.existsSync(path.join(f.target, f.database, "LOG")));
    } else {
      try {
        await assert.rejects(operation, error => {
          assert.equal(error.code, "ERR_LEGACY_PROFILE_COPY");
          assert(error.cause.message.includes(lockPath),
            "The intended LOCK check was not reached: " + error.cause.message);
          return true;
        });
      } finally {
        if (handle !== null) fs.closeSync(handle);
      }
      assert(!fs.existsSync(f.target));
    }
    for (const [name, text] of Object.entries(f.before)) {
      if (lockState === "missing" && path.basename(name) === "LOCK") continue;
      assert.equal(fs.readFileSync(path.join(f.source, name), "utf8"), text, name);
    }
    assert(!fs.readdirSync(f.root).some(name => name.startsWith(".markaloo-migration-")));
  });
}

for (const options of [{ packaged: false }, { relocated: true }, { platform: "darwin" }, { platform: "linux" }]) {
  test("development/relocation/non-Windows does not import production Folia: " + JSON.stringify(options), async t => {
    const f = startupFixture(t, options);
    await f.startup.prepareApplicationStartup(f.electron).completion;
    assert(f.events.includes("main"));
    assert(!f.events.includes("copy"));
    assert(!f.events.includes("cleanup-scheduled"));
    if (options.packaged === false) assert.equal(f.userData(), path.join(f.root, "Markaloo-dev"));
    if (options.relocated) assert.equal(f.userData(), path.join(f.root, "selected"));
  });
}
