"use strict";

// Source/VM controls only. No installer, Electron app or installed profile runs.
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

function scopeHook() {
  const hook = /!ifndef BUILD_UNINSTALLER\s+!ifdef allowToChangeInstallationDirectory\s+!macro customInstallMode\b([\s\S]*?)!macroend\s+!endif\s+!endif/.exec(installerSource);
  assert(hook, "The assisted scope hook must be guarded out of the uninstaller");
  return hook[1].split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith(";")).join("\n");
}

check("update scope hook leaves silent launches and explicit options to stock setup", () => {
  const hook = scopeHook();
  assert.deepEqual(hook.split("\n").slice(0, 27), [
    "IfSilent markalooUpdateScopeDone", "Push $0", "Push $1", "Push $R9",
    "${IfNot} ${isUpdated}", "${OrIf} ${isForAllUsers}", "${OrIf} ${isForCurrentUser}",
    "Goto markalooUpdateScopeRestore", "${EndIf}",
    "${GetParameters} $0",
    '${GetOptions} $0 "/allusers" $1', "IfErrors +2", "Goto markalooUpdateScopeRestore",
    '${GetOptions} $0 "/currentuser" $1', "IfErrors +2", "Goto markalooUpdateScopeRestore",
    '${StdUtils.GetAllParameters} $0 "0"', "Push $0", 'Push "/D="', "Call StrContains", "Pop $1",
    'StrCmp $1 "" 0 markalooUpdateScopeRestore',
    "Push $0", 'Push "/d="', "Call StrContains", "Pop $1",
    'StrCmp $1 "" 0 markalooUpdateScopeRestore',
  ], "Reject silent, non-update and explicit options before considering registrations");
  const destinationOptions = [...hook.matchAll(/^Push "(\/[Dd]=)"$/gm)].map(match => match[1]);
  for (const [argumentsText, explicit] of [
    ["--updated", false],
    ["/D=C:\\Test User\\Markaloo", true],
    ["/d=C:\\Test User\\Markaloo", true],
    ["/D=", true],
    ["/d=", true],
  ]) {
    assert.equal(destinationOptions.some(option => argumentsText.includes(option)), explicit, argumentsText);
  }
});

check("update scope registration gate requires exactly one matching scope and directory", () => {
  const hook = scopeHook();
  const gate = /^StrCmp \$INSTDIR "" markalooUpdateScopeRestore\n\$\{If\} \$installMode == "([^"]+)"\n([\s\S]+?)\n\$\{ElseIf\} \$installMode == "([^"]+)"\n([\s\S]+?)\n\$\{Else\}\nGoto markalooUpdateScopeRestore\n\$\{EndIf\}$/m.exec(hook);
  assert(gate, "Missing empty-target, scope or unknown-mode guard");
  // Apply the source's comparisons to synthetic initMultiUser snapshots, not to the registry.
  const arms = new Map([[gate[1], gate[2]], [gate[3], gate[4]]].map(([mode, body]) => [
    mode, body.split("\n").map(line => {
      const rule = /^StrCmp (\$\w+) (""|\$\w+) 0 markalooUpdateScopeRestore$/.exec(line);
      assert(rule, `Unrecognized scope gate: ${line}`);
      return rule.slice(1);
    }),
  ]));
  assert.deepEqual([...arms.keys()].sort(), ["CurrentUser", "all"]);
  const user = "C:\\Test User\\Markaloo";
  const machine = "C:\\Test Programs\\Markaloo";
  for (const [label, mode, hkcu, hklm, target, registrations, expected] of [
    ["per-user control", "CurrentUser", user, "", user, 1, true],
    ["per-machine control", "all", "", machine, machine, 1, true],
    ["fresh machine default", "all", "", "", machine, 0, false],
    ["same folder in both hives", "all", machine, machine, machine, 2, false],
    ["stale HKLM must not disambiguate HKCU", "CurrentUser", user, "C:\\Removed Markaloo", user, 2, false],
    ["stale HKCU must not disambiguate HKLM", "all", "C:\\Removed Markaloo", machine, machine, 2, false],
    ["unexpected effective path", "CurrentUser", user, "", `${user}\\Elsewhere`, 1, false],
    ["unexpected scope", "all", user, "", user, 1, false],
    ["unrecognized scope", "unknown", user, "", user, 1, false],
    ["empty effective path", "CurrentUser", user, "", "", 1, false],
  ]) {
    assert.equal([hkcu, hklm].filter(Boolean).length, registrations, `${label}: fixture registration count`);
    const values = { $perUserInstallationFolder: hkcu, $perMachineInstallationFolder: hklm, $INSTDIR: target, '""': "" };
    const rules = arms.get(mode);
    const passes = Boolean(target && rules && rules.every(([left, right]) => {
      assert(Object.hasOwn(values, left) && Object.hasOwn(values, right), `Unknown scope operands: ${left} ${right}`);
      return values[left].toLowerCase() === values[right].toLowerCase();
    }));
    assert.equal(passes, expected, label);
  }
});

check("update scope requires an unmodified destination and both installed files", () => {
  const hook = scopeHook();
  const files = /^Push \$INSTDIR\nPush "\$\{APP_FILENAME\}"\nCall StrContains\nPop \$1\nStrCmp \$1 "" markalooUpdateScopeRestore\n([\s\S]+?)\n\$\{If\} \$installMode == "all"$/m.exec(hook);
  assert(files, "The directory rewrite guard must precede the installed-file checks and force flag");
  const masks = files[1].split(/(?=^System::Call)/m).map(block => {
    const check = /^System::Call 'kernel32::GetFileAttributesW\(w "\$INSTDIR\\\$\{(\w+)\}"\) i\.r1'\nIntOp \$1 \$1 & (0x[\da-f]+)\nStrCmp \$1 0 0 markalooUpdateScopeRestore$/i.exec(block.trim());
    assert(check, `Unrecognized installed-file check: ${block}`);
    return [check[1], Number(check[2])];
  });
  assert.deepEqual(masks.map(([file]) => file), ["APP_EXECUTABLE_FILENAME", "UNINSTALL_FILENAME"]);
  // Model only the attribute values returned by the two real source lookups.
  for (const [label, app, uninstaller, expected] of [
    ["two files", 0x20, 0x20, true],
    ["missing app", -1, 0x20, false],
    ["missing uninstaller", 0x20, -1, false],
    ["directory named like an executable", 0x10, 0x20, false],
    ["reparse entry named like an uninstaller", 0x20, 0x400, false],
  ]) {
    assert.equal(masks.every(([, mask], index) => ([app, uninstaller][index] & mask) === 0), expected, label);
  }
});

check("eligible interactive update sets only the matching stock force flag", () => {
  const hook = scopeHook();
  assert.match(hook, /\$\{If\} \$installMode == "all"\nStrCpy \$isForceMachineInstall "1"\n\$\{Else\}\nStrCpy \$isForceCurrentInstall "1"\n\$\{EndIf\}\nmarkalooUpdateScopeRestore:\nPop \$R9\nPop \$1\nPop \$0\nmarkalooUpdateScopeDone:$/);
  assert.doesNotMatch(hook, /\b(?:Abort|Quit|Exec|UAC_RunElevated|SetShellVarContext|WriteRegStr)\b|StrCpy \$INSTDIR\b/);
});

check("stock install-mode page owns the skip and quits the outer forced-machine attempt after UAC", () => {
  const stock = name => fs.readFileSync(path.join(root, "node_modules", "app-builder-lib", "templates", "nsis", name), "utf8");
  const init = stock("installer.nsi");
  const assisted = stock("assistedInstaller.nsh");
  const page = stock("multiUserUi.nsh");
  assert.match(init, /!insertmacro check64BitAndSetRegView[\s\S]+?!insertmacro initMultiUser/);
  assert.match(assisted, /ReadRegStr \$perMachineInstallationFolder HKLM "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation[\s\S]+?ReadRegStr \$perUserInstallationFolder HKCU "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/);
  assert.match(assisted, /!insertmacro skipPageIfUpdated\s+!insertmacro MUI_PAGE_DIRECTORY[\s\S]+?\$\{StrContains\} \$0 "\$\{APP_FILENAME\}" \$INSTDIR\s+\$\{If\} \$0 == ""\s+StrCpy \$INSTDIR "\$INSTDIR\\\$\{APP_FILENAME\}"/);
  const contains = stock(path.join("include", "StrContains.nsh"));
  assert.match(stock("multiUser.nsh"), /\$\{If\} \$R5 == "\/D="\s+\$\{OrIf\} \$R5 == "\/d="/);
  assert.match(contains, /StrCmp \$STR_CONTAINS_VAR_3 \$STR_NEEDLE found/);
  assert.match(contains, /Push `\$\{HAYSTACK\}`\s+Push `\$\{NEEDLE\}`\s+Call StrContains\s+Pop `\$\{OUT\}`/);
  assert.match(page, /setInstallModePerAllUsers\s+Abort\s+\$\{endIf\}\s+StrCpy \$isForceMachineInstall "0"\s+StrCpy \$isForceCurrentInstall "0"\s+!ifmacrodef customInstallmode\s+!insertmacro customInstallMode\s+!endif\s+\$\{if\} \$isForceMachineInstall == "1"/);
  assert.match(page, /\$\{OrIf\} \$\{isForAllUsers\}[\s\S]+?!insertmacro UAC_RunElevated\s+Quit\s+\$\{endIf\}\s+!insertmacro setInstallModePerAllUsers\s+Abort/);
  assert.match(page, /\$\{if\} \$isForceCurrentInstall == "1"\s+\$\{OrIf\} \$\{isForCurrentUser\}[\s\S]+?!insertmacro setInstallModePerUser\s+Abort[\s\S]+?nsDialogs::Create/);
});

console.log("Source/VM only; NSIS compilation, native wizard/UAC and installed upgrade NOT RUN.");
console.log(`=== ${results.filter(Boolean).length}/${results.length} passed ===`);
process.exitCode = results.every(Boolean) ? 0 : 1;
