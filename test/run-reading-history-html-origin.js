"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const electron = require("electron");

const root = fs.realpathSync.native(path.join(__dirname, ".."));
const tmp = path.join(root, "tmp");
fs.mkdirSync(tmp, { recursive: true });
if (fs.realpathSync.native(tmp) !== tmp) {
  throw new Error("Reading-history proof storage must be a physical directory inside the worktree");
}
const storage = fs.mkdtempSync(path.join(tmp, "reading-html-origin-"));
const evidence = path.join(storage, "evidence");
fs.mkdirSync(evidence);
console.log("Reading-history proof evidence: " + evidence);

const run = spawnSync(electron, [path.join(root, "test", "test-reading-history-native.js"), "--html-origin"], {
  cwd: root,
  env: { ...process.env, TEMP: storage, TMP: storage, TMPDIR: storage, MARKALOO_READING_HISTORY_EVIDENCE: evidence },
  stdio: "inherit",
  timeout: 200_000,
});
if (run.error) throw run.error;
if (run.signal) throw new Error("Reading-history proof terminated by " + run.signal);
process.exitCode = run.status ?? 2;
