"use strict";

// Source/VM controls only. No installer, Electron process or installed profile runs.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
const start = source.indexOf("function isExistingRegularFile(");
const end = source.indexOf("\n/**", source.indexOf("function performWindowsInstalledUpdate(", start));
assert(start >= 0 && end > start, "The real Windows launch functions must be present");
const launchSource = source.slice(start, end);
const installerSource = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf8");
const results = [];
function check(name, run) {
  try {
    run();
    results.push(true);
    console.log("PASS " + name);
  } catch (error) {
    results.push(false);
    console.log("FAIL " + name + "  -> " + error.stack);
  }
}

function fixture({ autoRun = true, throwOnSpawn = false, current = true, pending = false } = {}) {
  const child = new EventEmitter();
  child.pid = 1234;
  child.unrefs = 0;
  child.unref = () => { child.unrefs++; };
  const calls = { spawn: [], quits: 0, authorized: 0, revoked: 0, thaw: 0, errors: [] };
  const updater = {
    quitAndInstallCalled: false, installerPath: __filename,
    downloadedUpdateHelper: { downloadedFileInfo: { isAdminRightsRequired: false } },
    autoRunAppAfterInstall: autoRun,
  };
  const pause = {};
  const pendingResult = Symbol("pending");
  const context = vm.createContext({
    fs, path, log() {}, SHUTDOWN_CONTINUATION_PENDING: pendingResult,
    activeUpdaterInstallAttempt: null, pendingUpdaterInstallCommit: null,
    updateInstallStarted: false,
    startupContext: {
      isUpdatePauseCurrent: value => current && value === pause,
      hasPendingRequests: () => pending,
    },
    require: name => {
      assert.equal(name, "child_process");
      return { spawn(command, args, options) {
        calls.spawn.push({ command, args: Array.from(args), options: { ...options } });
        if (throwOnSpawn) throw new Error("controlled spawn throw");
        return child;
      } };
    },
    updateState: { fail: error => calls.errors.push(error.message) },
    recordUpdaterInstallAttemptState() {},
    watchUpdaterInstallCommit(value) {
      const attempt = { updater: value };
      context.activeUpdaterInstallAttempt = attempt;
      return attempt;
    },
    finishFailedUpdaterInstallAttempt(attempt) {
      attempt.retired = true;
      updater.quitAndInstallCalled = false;
      context.activeUpdaterInstallAttempt = null;
      context.updateInstallStarted = false;
    },
    replayAbsorbedUserShutdownAfterUpdaterCancel() {},
    cancelUpdateOriginShutdownState() {},
    holdStartupClosing() {},
    releaseShutdownFreeze: () => { calls.thaw++; },
    revokeShutdownAuthorization: () => { calls.revoked++; },
    grantShutdownAuthorization: () => { calls.authorized++; },
    quitApprovedUpdateApp: () => { calls.quits++; },
  });
  vm.runInContext(launchSource, context, { filename: "main-windows-launch.vm.js" });
  return { calls, child, updater, context, pause, pendingResult,
    launch: () => context.performWindowsInstalledUpdate(updater, pause) };
}

check("Windows launch controls use a real existing file and never execute it", () => {
  const h = fixture();
  assert.equal(fs.statSync(h.updater.installerPath).isFile(), true);
  assert.equal(h.calls.spawn.length, 0);
  assert.equal(h.calls.quits, 0);
});
check("interactive Windows updater permits a visible wizard without silent arguments", () => {
  for (const autoRun of [false, true]) {
    const h = fixture({ autoRun });
    assert.equal(h.launch(), h.pendingResult);
    assert.equal(h.calls.spawn.length, 1);
    assert.deepEqual(h.calls.spawn[0], {
      command: __filename,
      args: autoRun ? ["--updated", "--force-run"] : ["--updated"],
      options: { detached: true, stdio: "ignore", windowsHide: false },
    });
  }
});
check("Windows launcher retains final approval and waits for spawn before quitting", () => {
  const h = fixture();
  h.launch();
  assert.equal(h.context.activeUpdaterInstallAttempt.finalApprovalCommitted, true);
  assert.equal(h.updater.quitAndInstallCalled, true);
  assert.equal(h.calls.authorized, 0);
  assert.equal(h.calls.quits, 0);
  assert.equal(h.child.unrefs, 1);
  for (const event of ["spawn", "error", "close"]) assert.equal(h.child.listenerCount(event), 1);
  h.child.emit("spawn");
  assert.equal(h.calls.quits, 1);
  assert.equal(h.calls.authorized, 1);
  assert.equal(h.context.activeUpdaterInstallAttempt.positiveLaunchObserved, true);
});
check("Windows launcher blocks duplicates and ignores late child events after spawn", () => {
  const h = fixture();
  h.launch();
  h.child.emit("spawn");
  h.child.emit("error", new Error("controlled late error"));
  h.child.emit("close", 1, null);
  assert.equal(h.launch(), false);
  assert.equal(h.calls.spawn.length, 1);
  assert.equal(h.calls.quits, 1);
  assert.equal(h.updater.quitAndInstallCalled, true);
  assert.equal(h.calls.thaw, 0);
  assert.deepEqual(h.calls.errors, []);
});
check("Windows synchronous and pre-spawn errors remain visible and retry-safe without elevation", () => {
  for (const throwOnSpawn of [false, true]) {
    const h = fixture({ throwOnSpawn });
    h.launch();
    if (!throwOnSpawn) h.child.emit("error", Object.assign(new Error("controlled access denied"), { code: "EACCES" }));
    assert.equal(h.calls.spawn.length, 1);
    assert.equal(h.calls.quits, 0);
    assert.equal(h.updater.quitAndInstallCalled, false);
    assert.equal(h.calls.thaw, 1);
    assert.deepEqual(h.calls.errors, ["The update installer could not be started. You can try again."]);
  }
});
check("Windows ambiguous pre-spawn close keeps the freeze and duplicate latch", () => {
  const h = fixture();
  h.launch();
  h.child.emit("close", 1, null);
  assert.equal(h.launch(), false);
  assert.equal(h.calls.spawn.length, 1);
  assert.equal(h.calls.quits, 0);
  assert.equal(h.calls.thaw, 0);
  assert.equal(h.updater.quitAndInstallCalled, true);
  assert.deepEqual(h.calls.errors, [
    "Markaloo could not verify whether the update installer started. Restart Markaloo before trying again.",
  ]);
});
check("Windows stale or pending startup admission cannot launch the installer", () => {
  for (const options of [{ current: false }, { pending: true }]) {
    const h = fixture(options);
    assert.equal(h.launch(), false);
    assert.equal(h.calls.spawn.length, 0);
    assert.equal(h.calls.quits, 0);
    assert.equal(h.updater.quitAndInstallCalled, false);
    assert.deepEqual(h.calls.errors, [
      "The update could not start: Startup admission changed or accepted file opens are still pending",
    ]);
  }
});
check("setup does not invent a Folia removal result or promise a settings copy", () => {
  assert.doesNotMatch(installerSource, /Folia removal was skipped|will still copy retained settings/);
  const init = /!macro customInit\b([\s\S]*?)!macroend/.exec(installerSource)?.[1] || "";
  assert.doesNotMatch(init, /MessageBox/);
});
check("setup retains both busy-process refusals and the real cleanup failure warning", () => {
  const include = /!macro customCheckAppRunning\b([\s\S]*?)!macroend/.exec(installerSource)?.[1];
  assert(include, "The existing running-app and cleanup hook must remain");
  assert.match(include, /\$\{nsProcess::FindProcess\} "\$\{APP_EXECUTABLE_FILENAME\}" \$R0/);
  assert.match(include, /\$\{nsProcess::FindProcess\} "Folia\.exe" \$R0/);
  assert.equal((include.match(/SetErrorLevel 2\s+Quit/g) || []).length, 2);
  assert.match(include, /nsExec::ExecToStack.*-Action BeforeInstallCleanup/);
  assert.match(include, /Pop \$R0\s+Pop \$R1\s+\$\{If\} \$R0 != 0\s+DetailPrint "Folia removal could not be completed/);
  assert.match(include, /MessageBox MB_OK\|MB_ICONEXCLAMATION "Folia removal could not be completed/);
});
check("interactive setup queues one pointer-safe restore from its installer-only GUI callback", () => {
  const guard = /!ifndef BUILD_UNINSTALLER\s+!define MUI_CUSTOMFUNCTION_GUIINIT MarkalooRestoreInteractiveSetup\s+Function MarkalooRestoreInteractiveSetup\b([\s\S]*?)FunctionEnd\s+!endif/.exec(installerSource);
  assert(guard, "The installer-only MUI callback must be wired before the stock template");
  const callback = guard[1];
  assert.match(callback, /IfSilent done\s+Push \$0/);
  assert.match(callback, /System::Call 'user32::PostMessageW\(p \$HWNDPARENT, i 0x0112, p 0xF120, p 0\) i\.r0'/);
  assert.equal((callback.match(/System::Call/g) || []).length, 1);
  assert.doesNotMatch(callback, /ShowWindow|BringToFront|Sleep|Timer|Exec/);
});
check("setup restore queue failure reports an error and exits with its scratch register restored", () => {
  const callback = /Function MarkalooRestoreInteractiveSetup\b([\s\S]*?)FunctionEnd/.exec(installerSource)?.[1];
  assert(callback);
  assert.match(callback, /StrCmp \$0 0 failed\s+Pop \$0\s+Return\s+failed:\s+Pop \$0/);
  assert.match(callback, /MessageBox MB_OK\|MB_ICONSTOP "Markaloo setup could not show its window\. Run setup again\."\s+SetErrorLevel 2\s+Quit\s+done:/);
});

console.log("Source/VM only; native wizard visibility and installed upgrade NOT RUN.");
console.log(`=== ${results.filter(Boolean).length}/${results.length} passed ===`);
process.exitCode = results.every(Boolean) ? 0 : 1;
