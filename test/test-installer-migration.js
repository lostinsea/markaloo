"use strict";

// Source-only stock installer contract. No NSIS compiler, registry or uninstaller runs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

if (process.argv.includes("--integration")) {
  throw new Error("These checks are source-only; installed-upgrade qualification is separate.");
}
const root = path.resolve(__dirname, "..");
const templates = process.env.MARKALOO_NSIS_TEMPLATES ||
  path.join(root, "node_modules", "app-builder-lib", "templates", "nsis");
const read = file => fs.readFileSync(path.join(templates, file), "utf8");
const include = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf8");

test("installer keeps the stock non-killing check and warns on the unsupported inner path", () => {
  assert.match(include, /!macro customCheckAppRunning/);
  assert.equal((include.match(/^!macro /gm) || []).length, 2);
  assert.match(include, /\$\{nsProcess::FindProcess\} "\$\{APP_EXECUTABLE_FILENAME\}" \$R0/);
  assert.match(include, /\$\{nsProcess::FindProcess\} "Folia\.exe" \$R0/);
  assert.equal((include.match(/\$\{If\} \$R0 != 603/g) || []).length, 2);
  assert.equal((include.match(/SetErrorLevel 2/g) || []).length, 2);
  assert.equal((include.match(/^\s+Quit$/gm) || []).length, 2);
  assert.doesNotMatch(include,
    /KILL_PROCESS|KillProcess|taskkill|Stop-Process|legacy-install\.nsh|InstallBridge|customInstall|customFinish/);
  const init = /!macro customInit\b([\s\S]*?)!macroend/.exec(include)?.[1];
  assert(init);
  assert.match(init, /\$\{If\} \$\{UAC_IsInnerInstance\}/);
  assert.match(init, /MessageBox MB_OK\|MB_ICONEXCLAMATION "Folia removal was skipped/);
  assert.doesNotMatch(init, /Exec|BeforeInstallCleanup/);
});

test("supported public hook attempts cleanup before new installation writes", () => {
  assert.equal(require("app-builder-lib/package.json").version, "26.15.3");
  const shared = read(path.join("include", "allowOnlyOneInstallerInstance.nsh"));
  assert.match(shared, /!ifmacrodef customCheckAppRunning\s+!insertmacro customCheckAppRunning/);
  assert.match(read("uninstaller.nsh"), /call un\.checkAppRunning/);
  const install = read("installSection.nsh");
  const checkAt = install.indexOf("!insertmacro CHECK_APP_RUNNING");
  assert(checkAt >= 0);
  for (const token of ["!insertmacro uninstallOldVersion", "!insertmacro installApplicationFiles",
    "!insertmacro registryAddInstallInfo", "!insertmacro addStartMenuLink",
    "!insertmacro addDesktopLink", "!insertmacro registerFileAssociations"]) {
    assert(install.indexOf(token) > checkAt, token);
  }
  const check = /!macro customCheckAppRunning\b([\s\S]*?)!macroend/.exec(include)[1];
  assert.match(check, /!ifndef BUILD_UNINSTALLER[\s\S]+BeforeInstallCleanup[\s\S]+!endif/);
  assert.match(check, /File \/oname=\$PLUGINSDIR\\legacy-install\.ps1 "\$\{PROJECT_DIR\}\\src\\legacy-install\.ps1"/);
  assert.match(check, /nsExec::ExecToStack.*-ExecutionPolicy RemoteSigned.*-Action BeforeInstallCleanup/);
  assert(check.indexOf("BeforeInstallCleanup") > check.lastIndexOf("${nsProcess::FindProcess}"));
  assert.match(check, /Pop \$R0\s+Pop \$R1\s+\$\{If\} \$R0 != 0/);
  assert.match(check, /MessageBox MB_OK\|MB_ICONEXCLAMATION "Folia removal could not be completed/);
  assert.doesNotMatch(check.slice(check.indexOf("BeforeInstallCleanup")), /SetErrorLevel|Quit/);
});

test("ordinary assisted elevation misses the hook, but always reaches the visible skip warning", () => {
  const assisted = read("assistedInstaller.nsh");
  assert.match(assisted, /!insertmacro PAGE_INSTALL_MODE[\s\S]+!insertmacro MUI_PAGE_INSTFILES/);
  const mode = read("multiUserUi.nsh");
  assert.match(mode, /Function "\$\{UNINSTALLER_FUNCPREFIX\}\$\{LEAVE\}"[\s\S]+!insertmacro UAC_RunElevated[\s\S]+\$\{If\} \$1 = 1\s+Quit/);
  assert.match(read("installSection.nsh"),
    /\$\{ifNot\} \$\{UAC_IsInnerInstance\}\s+!insertmacro CHECK_APP_RUNNING/);
  const installer = read("installer.nsi");
  assert.match(installer, /Function \.onInit[\s\S]+!insertmacro initMultiUser[\s\S]+!insertmacro customInit[\s\S]+FunctionEnd/);
  assert(installer.indexOf("!insertmacro customInit") < installer.indexOf('Section "install"'));
  const init = /!macro customInit\b([\s\S]*?)!macroend/.exec(include)?.[1];
  assert.match(init || "", /UAC_IsInnerInstance[\s\S]+MessageBox/);
});

test("data preservation flags and synchronous old-uninstaller invocation match pinned stock source", () => {
  const utility = read(path.join("include", "installUtil.nsh"));
  assert.match(utility, /StrCpy \$0 "\$0 --updated"/);
  assert.match(utility, /\/S \/KEEP_APP_DATA \$0/);
  assert.match(utility, /copyFile "\$uninstallerFileName" "\$uninstallerFileNameTemp"/);
  assert.match(utility, /ExecWait[^\r\n]+_\?=/);
  const uninstall = read("uninstaller.nsh");
  assert.match(uninstall, /\$\{ifNot\} \$\{isUpdated\}\s+StrCpy \$isDeleteAppData "1"/);
  const script = fs.readFileSync(path.join(root, "src", "legacy-install.ps1"), "utf8");
  assert.match(script, /\[IO\.File\]::Copy\(\$uninstaller, \$temporary, \$false\)/);
  assert.match(script, /Start-Process -FilePath \$temporary[\s\S]+-ArgumentList "\/S \$scope --updated \/KEEP_APP_DATA _\?=\$directory" -Wait -PassThru/);
  assert.doesNotMatch(script, /Stop-Process|taskkill|--delete-app-data|WaitForExit|--keep-shortcuts/);
  assert.match(script, /Uninstall\\\$guid/);
  assert.match(script, /WindowsBuiltInRole\]::Administrator/);
  assert.match(script, /Assert-AppsClosed\s+# [^\r\n]+\r?\n\s+\$result = Start-Process/);
});

test("cleanup applies scope and retained-profile guards before copying the registered uninstaller", () => {
  const script = fs.readFileSync(path.join(root, "src", "legacy-install.ps1"), "utf8");
  const cleanup = script.slice(script.indexOf("function Remove-LegacyInstall"));
  const guard = "Assert-CleanupAllowed $elevated " +
    "($hive -eq [Microsoft.Win32.RegistryHive]::CurrentUser) $directory $profilePaths";
  assert(cleanup.includes(guard));
  assert(cleanup.indexOf(guard) < cleanup.indexOf("[IO.File]::Copy($uninstaller"));
  assert.match(cleanup, /\$elevated = \$principal\.IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
  assert.match(cleanup, /GetFolderPath\('ApplicationData'\)/);
  assert.match(cleanup, /'Folia', 'Markaloo', 'Folia-dev', 'Markaloo-dev'/);
});

test("production cleanup guard refuses unsafe scope and profile overlap in Windows PowerShell", {
  skip: process.platform !== "win32",
}, t => {
  const script = fs.readFileSync(path.join(root, "src", "legacy-install.ps1"), "utf8");
  const guard = /^function Assert-CleanupAllowed\b[\s\S]*?^}/m.exec(script)?.[0];
  assert(guard, "The production guard must be present");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "markaloo-cleanup-paths-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const roaming = path.join(temporary, "roaming");
  const profiles = ["Folia", "Markaloo", "Folia-dev", "Markaloo-dev"]
    .map(name => path.join(roaming, name));
  const sibling = path.join(temporary, "apps", "Folia");
  const cases = [
    { name: "elevated HKCU", elevated: true, currentUser: true, directory: sibling, refused: true },
    { name: "unelevated HKLM", elevated: false, currentUser: false, directory: sibling, refused: true },
    { name: "ordinary HKCU sibling", elevated: false, currentUser: true, directory: sibling, refused: false },
    { name: "elevated HKLM sibling", elevated: true, currentUser: false, directory: sibling, refused: false },
    ...profiles.map(directory => ({ name: "equal " + path.basename(directory), directory, refused: true })),
    { name: "install contains profiles", directory: roaming, refused: true },
    { name: "install inside Markaloo profile", directory: path.join(profiles[1], "app"), refused: true },
    { name: "case and trailing separator", directory: profiles[0].toUpperCase() + "\\", refused: true },
    { name: "canonical dot segments", directory: profiles[0] + "\\..\\Folia", refused: true },
    { name: "prefix sibling is unrelated", directory: profiles[0] + "-old", refused: false },
  ].map(item => ({
    elevated: false, currentUser: true, ...item,
    error: item.name === "elevated HKCU"
      ? "Per-user Folia removal is skipped while setup runs as administrator."
      : item.name === "unelevated HKLM"
        ? "Removing the old all-users installation requires an already elevated setup."
        : "The old installation overlaps retained profile data.",
  }));
  const input = JSON.stringify(cases).replaceAll("'", "''");
  const paths = JSON.stringify(profiles).replaceAll("'", "''");
  const command = `$ErrorActionPreference = 'Stop'
${guard}
$profiles = ConvertFrom-Json '${paths}'
foreach ($case in (ConvertFrom-Json '${input}')) {
  $refused = $false
  try { Assert-CleanupAllowed $case.elevated $case.currentUser $case.directory $profiles }
  catch {
    if ($_.Exception.Message -ne $case.error) { throw }
    $refused = $true
  }
  if ($refused -ne $case.refused) { throw "Unexpected cleanup decision: $($case.name)" }
  Write-Output ("PASS " + $case.name)
}`;
  const result = spawnSync(path.join(process.env.SystemRoot, "System32",
    "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(command, "utf16le").toString("base64"),
  ], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), cases.map(item => "PASS " + item.name));
  t.diagnostic(result.stdout.trim());
});

test("actual manifest uses the independent Markaloo identity and ordinary installer policy", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.name, "markaloo");
  assert.equal(pkg.build.appId, "io.github.lostinsea.markaloo");
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.selectPerMachineByDefault, true);
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(pkg.build.nsis.include, "build/installer.nsh");
  assert(pkg.build.files.includes("src/legacy-install.js"));
  assert(pkg.build.extraResources.some(resource =>
    resource.from === "src/legacy-install.ps1" && resource.to === "legacy-install.ps1"));
  assert(!pkg.build.files.includes("src/install-migration-helper.js"));
  assert(!pkg.build.files.includes("src/install-transaction.js"));
});
