"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

function command(args) {
  const windows = process.env.SystemRoot;
  if (!windows || !path.isAbsolute(windows)) {
    throw new Error("Windows PowerShell is unavailable");
  }
  const script = process.versions.electron
    ? path.join(process.resourcesPath, "legacy-install.ps1")
    : path.join(__dirname, "legacy-install.ps1");
  return {
    exe: path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned",
      "-File", script, "-Action", "CopyProfile", ...args],
  };
}

function copyClosedProfile({ sourcePath, stagePath, run = spawnSync }) {
  const { exe, args } = command([
    "-Source", sourcePath, "-Stage", stagePath, "-ParentId", String(process.pid),
  ]);
  const result = run(exe, args, {
    shell: false, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error("Folia settings could not be copied. Close Folia and retry.",
      { cause: new Error(result.stderr || `PowerShell exit ${result.status}`) });
    error.code = "ERR_LEGACY_PROFILE_COPY";
    throw error;
  }
}

module.exports = { copyClosedProfile };
