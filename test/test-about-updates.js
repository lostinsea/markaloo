"use strict";
require("./test-userdata-isolation");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID, createHash } = require("crypto");
const electron = require("electron");
const root = path.resolve(__dirname, "..");
const batch = path.resolve(process.env.MARKALOO_UPDATE_BATCH ||
  path.join(root, "tmp", "about-updates", randomUUID()));
if (!batch.startsWith(path.join(root, "tmp", "about-updates") + path.sep)) {
  throw new Error("A disposable project-local update batch is required");
}
fs.mkdirSync(batch, { recursive: true });

const combinedRequired = [
  "combined fixture admits two real documents with independent dirty editors selection and history",
  "combined actual TOC toolbar and reading zoom change geometry without changing either editor",
  "combined About opening and reopening do not check download or launch",
  "combined About traps native keyboard focus and blocks background editor shortcuts",
  "combined Escape restores visible toolbar focus and the owning draft",
  "combined pending manual check survives About close tab switch TOC toggle and reading zoom",
  "combined manual result remains shared after reopening on the other dirty document",
  "combined restored histories perform real Undo and Redo without crossing documents",
  "combined dialogs preserve both owning drafts selections histories and untouched disk",
  "combined scenarios introduce no unexpected renderer errors or stalls",
  "About sentinel proves both error channels alive",
  "About uses frozen production preload without Node or raw IPC",
  ...["clarity", "abyss"].flatMap(theme => ["normal", "narrow web zoom"].map(size =>
    `combined themed About ${theme} ${size} keeps actions and document context visible`)),
];
const dailyRequired = [
  "daily cached offer reserves once before the ordinary reader toast",
  "daily dismissal persists through production preload renderer reload and stale dismissal",
  "daily real Main claims before joining the held manual provider check",
  "daily manual overlap completes with one explicit presentation and no automatic duplicate",
  "daily application dialog defers reminder permission while About remains current",
  "daily dialog closure grants a fresh same-version presentation without focus stealing",
  "daily same-day provider errors do not reopen the dismissed presentation",
  "daily canceled quit retains scheduler ownership and grants deferred reminder",
  "daily popup-only lifetime parks the single ordinary-reader schedule",
  "daily actual teardown removes timer and resume listener ownership",
  "daily fixture never downloads installs launches or opens an external application",
  "daily scenarios introduce no unexpected renderer errors or stalls",
  "daily missing-frame dismissal cannot spend the current presentation",
];
const downloadFailureRequired = [
  "download failure setup proves a dismissed automatic notice without provider traffic",
  "accepted Main download failure creates fresh visible manual feedback after dismissal",
  "controlled transfer failure preserves document disk and never installs or opens externally",
  "download failure scenarios introduce no unexpected renderer errors or stalls",
  "download failure setup proves pre-existing controlled artifact bytes",
];
const notesRequired = [
  "notes checks and popup creation make no additional content request",
  "notes actual expansion uses the fixed exact offered tag through Main and preload",
  "notes collapse and re-expansion share the held request without disabling actions",
  "notes actual Markdown renderer isolates document hooks and removes active content",
  "notes loaded result is reused across collapse and temporary About hiding",
  process.platform === "darwin"
    ? "notes manual-only platform retains its release action without native download authority"
    : "notes live download progress preserves the same expanded request and install action",
  "notes fresh presentation starts collapsed without carrying the prior cache",
  "notes same-presentation target change aborts old ownership and resets disclosure",
  "notes intentional mismatch is visibly reported and the live error sentinel records it",
  "notes explicit retry loads the exact target and caches an honest empty result",
  "notes a lower live offer cannot redirect higher remembered target notes",
  "notes close dismisses and aborts its owned request without reopening",
  "notes fixture preserves protected disk and never installs or opens externally",
  "notes scenarios introduce no unexpected renderer errors or stalls",
  "notes first expansion survives hiding before actual Main admission",
  "notes hidden completion and restore reuse the same expanded owner",
  "notes collapsed hide and restore never fetch content",
  "notes active failure while hidden restores Retry without a stuck loading state",
  ...["normal", "narrow enlarged", "short enlarged"].map(value =>
    `notes ${value} layout keeps main actions reachable and notes independently scrollable`),
];

function popupFrameMatches(image, witness, background = null) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  if (image.isEmpty() || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || bitmap.length !== width * height * 4 ||
      !Number.isFinite(witness.width) || witness.width <= 0 ||
      !Number.isFinite(witness.height) || witness.height <= 0) {
    throw new Error("Invalid popup presentation image or viewport");
  }
  const sx = width / witness.width, sy = height / witness.height;
  if (Math.abs(sx - sy) > 2 / Math.min(witness.width, witness.height)) {
    throw new Error("Popup presentation image has inconsistent scaling");
  }
  for (const kind of ["panel", "button", ...(witness.backdrop ? ["backdrop"] : [])]) {
    if (witness.patches.filter(patch => patch.kind === kind).length < 3) {
      throw new Error("Insufficient popup presentation witnesses");
    }
  }
  let base = null;
  if (witness.backdrop) {
    const size = background?.getSize();
    if (!size || size.width !== width || size.height !== height || background.isEmpty()) {
      throw new Error("Invalid pre-open presentation image");
    }
    base = background.toBitmap();
    if (base.length !== bitmap.length) throw new Error("Invalid pre-open bitmap");
  }
  const patches = witness.patches.map(patch => {
    const x = Math.floor(patch.x * sx), y = Math.floor(patch.y * sy);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 1 || y < 1 ||
        x >= width - 1 || y >= height - 1 || patch.color.length !== 4 ||
        !patch.color.every(Number.isFinite) || patch.color.slice(0, 3).some(c => c < 0 || c > 255) ||
        (patch.kind === "backdrop" ? !(patch.color[3] > 0 && patch.color[3] < 1) : patch.color[3] !== 1)) {
      throw new Error("Invalid popup presentation patch");
    }
    return { ...patch, x, y };
  });
  return patches.every(patch => {
    const { x, y } = patch;
    let matches = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const offset = ((y + dy) * width + x + dx) * 4;
      const expected = patch.color.slice(0, 3).map((value, channel) =>
        patch.kind === "backdrop"
          ? value * patch.color[3] + base[offset + 2 - channel] * (1 - patch.color[3]) : value);
      // Interior BGRA patches avoid text; allow only small color quantization.
      if (bitmap[offset + 3] === 255 &&
          expected.every((value, channel) => Math.abs(bitmap[offset + 2 - channel] - value) <= 4)) matches++;
    }
    return matches >= 8;
  });
}

function popupObservationEpoch(win, state, schedule, lifecycle, expectsSchedule) {
  const contents = win.webContents;
  if (!state || !!schedule !== expectsSchedule ||
      win.isDestroyed() || contents.isDestroyed() || !win.isVisible() || win.isMinimized()) {
    throw new Error("Popup observation lost its actual window or updater owner");
  }
  return JSON.stringify({
    window: win.id, contents: contents.id, renderer: contents.getOSProcessId(),
    lifecycle, url: contents.getURL(), size: win.getContentSize(),
    zoom: contents.getZoomFactor(), visible: win.isVisible(), minimized: win.isMinimized(),
    updateState: state.snapshot(), scheduleState: schedule ? schedule.snapshot() : null,
  });
}

function createPopupFrameAdmission({ currentEpoch, matches, now }) {
  let latest = null, readiness = null, ended = false, resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  function stop(error) {
    if (ended) return;
    ended = true;
    latest = null;
    readiness = null;
    if (error) reject(error);
  }
  function verify() {
    if (ended || !readiness || !latest) return;
    try {
      const epoch = currentEpoch();
      if (epoch !== readiness.epoch) throw new Error("Popup observation changed after witness preparation");
      if (epoch !== latest.epoch) {
        latest = null;
        return;
      }
      if (!matches(latest.image, readiness.witness, readiness.background)) return;
      if (currentEpoch() !== epoch) throw new Error("Popup observation changed during pixel verification");
      const verifiedAt = now();
      if (!Number.isFinite(verifiedAt) ||
          verifiedAt < readiness.at || verifiedAt < latest.at) {
        throw new Error("Popup verification clock is inconsistent");
      }
      const result = { image: latest.image, frameReceivedAt: latest.at,
        prerequisitesReadyAt: readiness.at, verifiedAt, witness: readiness.witness };
      stop();
      resolve(result);
    } catch (error) { stop(error); }
  }
  return {
    promise,
    frame(image, at) {
      if (ended) return;
      try {
        if (!Number.isFinite(at)) throw new Error("Invalid popup frame timestamp");
        latest = { image, at, epoch: currentEpoch() };
        verify();
      } catch (error) { stop(error); }
    },
    ready(witness, background, epoch) {
      if (ended) return;
      try {
        if (currentEpoch() !== epoch) throw new Error("Popup observation changed during witness preparation");
        const at = now();
        if (!Number.isFinite(at)) throw new Error("Invalid popup readiness timestamp");
        readiness = { witness, background, epoch, at };
        // The last real frame may precede the final RAF/witness IPC return.
        verify();
      } catch (error) { stop(error); }
    },
    stop,
  };
}

if (typeof electron === "string") {
  const { spawnSync } = require("child_process");
  const perfUi = process.argv.includes("--perf-ui");
  const perf = process.argv.includes("--perf") || perfUi;
  const portablePhases = process.platform === "win32" ? ["portable-failure", "portable-throw",
    "portable-cancel", "portable-ambiguous"] : [];
  const nativeDownloadPhases = process.platform === "darwin" ? [] : ["download-failure"];
  if (process.argv.includes("--portable") && portablePhases.length === 0) {
    throw new Error("Portable updater fixtures require Windows");
  }
  if (process.argv.includes("--download-failure") && nativeDownloadPhases.length === 0) {
    throw new Error("Native download fixtures are unavailable on macOS");
  }
  const phases = perf ? Array.from({ length: 5 }, (_, i) => (perfUi ? "perf-ui-" : "perf-") + i)
    : process.argv.includes("--ui") ? ["discover"]
    : process.argv.includes("--portable") ? portablePhases
    : process.argv.includes("--combined") ? ["combined"]
    : process.argv.includes("--daily") ? ["daily"]
    : process.argv.includes("--download-failure") ? ["download-failure"]
    : process.argv.includes("--notes") ? ["notes"]
    : ["combined", "discover", "offline", "equal", "newer", "malformed", "current",
      "daily", "notes", ...nativeDownloadPhases, ...portablePhases];
  console.log("About update evidence: " + batch);
  let passed = 0, total = 0;
  for (const phase of phases) {
    let entry = __filename;
    if (phase === "equal") {
      entry = path.join(batch, "runtime-app");
      fs.mkdirSync(entry, { recursive: true });
      fs.writeFileSync(path.join(entry, "package.json"), JSON.stringify({
        name: "markaloo-runtime-fixture", version: require("../package.json").version,
        main: __filename,
      }));
    }
    const result = spawnSync(electron, [entry, phase], {
      cwd: root, encoding: "utf8", timeout: 120000,
      env: { ...process.env, MARKALOO_UPDATE_BATCH: batch },
    });
    fs.writeFileSync(path.join(batch, phase + ".stdout.log"), result.stdout || "");
    fs.writeFileSync(path.join(batch, phase + ".stderr.log"), result.stderr || "");
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    const footers = [...(result.stdout || "").matchAll(/^=== updates ([\w-]+): (\d+)\/(\d+) passed ===$/gm)];
    const footer = footers[0];
    const assertions = (result.stdout || "").split(/\r?\n/).filter(line => /^(PASS|FAIL) /.test(line));
    const assertionNames = assertions.map(line => line.slice(5).split("  ->")[0]);
    const failures = assertions.filter(line => line.startsWith("FAIL ")).length;
    const good = Number(footer?.[2]), count = Number(footer?.[3]);
    const required = phase === "combined" ? combinedRequired : phase === "daily" ? dailyRequired
      : phase === "download-failure" ? downloadFailureRequired : phase === "notes" ? notesRequired : [];
    const complete = required.every(name =>
      assertionNames.filter(actual => actual === name).length === 1);
    if (result.error || footers.length !== 1 || footer[1] !== phase || count < 3 ||
        assertions.length !== count || failures !== count - good || !complete ||
        result.status !== (failures ? 1 : 0)) {
      console.error("FAIL update child completed  -> " + (result.error || result.status));
      process.exit(2);
    }
    passed += good;
    total += count;
  }
  console.log(`=== ${passed}/${total} passed ===`);
  if (perf) {
    const measurements = phases.map(phase => JSON.parse(fs.readFileSync(path.join(batch, phase + ".json"), "utf8")).measurement);
    const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    const summary = {};
    for (const name of ["startup", "open", ...(perfUi ? ["cachedNoticeReady", "aboutOpen"] : [])]) {
      const values = measurements.map(row => row[name]);
      summary[name] = { samples: values, p50: quantile(values, 0.5), p95: quantile(values, 0.95) };
    }
    const sourceRoot = path.resolve(process.env.MARKALOO_UPDATE_SOURCE_ROOT || root);
    const sourceHashes = Object.fromEntries(["main.js", "main-preload.js", "app-updates.js", "update-state.js",
      "update-schedule.js", "update-release-notes.js", "index.html", "styles.css", "custom-styles.css"].map(name => {
      const file = path.join(sourceRoot, "src", name);
      return [name, fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null];
    }));
    fs.writeFileSync(path.join(batch, "performance.json"), JSON.stringify({
      runtime: { node: process.version, electron: require("electron/package.json").version,
        cpu: os.cpus()[0]?.model, platform: process.platform },
      source: sourceRoot, sourceHashes,
      driverSha256: createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
      workload: perfUi ? "packaged-policy cached notice, 64 KiB prose, first About open" : "development-policy startup and 64 KiB prose",
      summary,
    }, null, 2));
    console.log("UPDATE_PERF " + JSON.stringify(summary));
  }
  process.exit(passed === total ? 0 : 1);
} else {
  const { app, BrowserWindow, dialog, ipcMain, shell, powerMonitor } = electron;
  const { EventEmitter } = require("events");
  const Module = require("module");
  const phase = process.argv[2];
  if (!["combined", "discover", "offline", "equal", "newer", "malformed", "current", "daily", "notes", "download-failure",
    "portable-failure", "portable-throw", "portable-cancel", "portable-ambiguous",
    ...Array.from({ length: 5 }, (_, i) => "perf-" + i),
    ...Array.from({ length: 5 }, (_, i) => "perf-ui-" + i)].includes(phase)) {
    console.error("Unsupported update fixture phase: " + phase);
    app.exit(2);
  }
  const perf = phase.startsWith("perf-");
  const perfUi = phase.startsWith("perf-ui-");
  const portable = phase.startsWith("portable-");
  if (portable) {
    process.env.PORTABLE_EXECUTABLE_DIR = path.join(batch, "portable-fixture");
    const temp = path.join(batch, "portable-temp");
    fs.mkdirSync(temp, { recursive: true });
    os.tmpdir = () => temp;
  } else {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  }
  const started = performance.now();
  const measurement = {};
  if (perf) {
    measurement.stages = {};
    measurement.modules = [];
    app.once("ready", () => { measurement.stages.appReady = performance.now() - started; });
    app.on("browser-window-created", (_event, target) => {
      measurement.stages.windowCreated = performance.now() - started;
      target.once("ready-to-show", () => { measurement.stages.readyToShow = performance.now() - started; });
      for (const [event, name] of [["dom-ready", "domReady"], ["did-finish-load", "didFinishLoad"]]) {
        target.webContents.once(event, () => { measurement.stages[name] = performance.now() - started; });
      }
    });
  }
  const profile = path.join(batch, ["discover", "offline"].includes(phase) ? "persistent-profile" : phase + "-profile");
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  fs.mkdirSync(path.join(batch, "crash-dumps"), { recursive: true });
  app.setPath("crashDumps", path.join(batch, "crash-dumps"));
  app.setAppLogsPath(path.join(batch, "logs"));
  const settingsFile = path.join(profile, "window-state.json");
  let dailyClock = new Date(2026, 10, 3, 10).getTime(), dailyElapsed = 0;
  let dailyOwner = null, dailyState = null, notesState = null, dailyTimerId = 0;
  let perfState = null, perfSchedule = null;
  const perfExpectsSchedule = perfUi && fs.existsSync(path.join(
    process.env.MARKALOO_UPDATE_SOURCE_ROOT || root, "src", "update-schedule.js"));
  const dailyTimers = new Map();
  if (phase === "daily" || phase === "download-failure" || phase === "notes" || perfUi) {
    fs.writeFileSync(settingsFile, JSON.stringify({ width: 1100, height: 780,
      updateAvailability: { schema: 1, version: "0.10.0" } }));
  }
  const runtimeVersion = phase === "equal" ? app.getVersion() : phase === "newer" ? "0.11.0" : "0.9.0";
  if (["equal", "newer", "malformed"].includes(phase)) {
    fs.writeFileSync(settingsFile, JSON.stringify({ width: 1100, height: 780,
      updateAvailability: phase === "malformed"
        ? { schema: 1, version: "<img onerror=alert(1)>", ready: true, path: "untrusted.exe" }
        : { schema: 1, version: phase === "equal" ? runtimeVersion : "0.10.0" } }));
  }
  if (phase !== "equal") app.getVersion = () => runtimeVersion;
  const provider = new EventEmitter();
  const counts = { checks: 0, downloads: 0, launches: 0, installs: 0, kills: 0, external: [] };
  const notesRequests = [];
  let notesAdmissionGate = null, notesAdmissions = 0;
  let stopPerfFrames = null;
  if (phase === "notes") counts.notesRequests = [];
  const notesElectron = Object.create(electron);
  Object.defineProperty(notesElectron, "net", { value: {
    fetch(url, options) {
      counts.notesRequests.push({ url, credentials: options.credentials, redirect: options.redirect });
      return new Promise((resolve, reject) => {
        const request = { url, signal: options.signal, resolve, reject, aborted: false };
        notesRequests.push(request);
        options.signal.addEventListener("abort", () => {
          request.aborted = true;
          reject(new Error("Fixture notes request aborted"));
        }, { once: true });
      });
    },
  } });
  let releaseHeldLaunch;
  const installAttempts = () => counts.launches + counts.installs;
  let checkGate = null, checkMode = phase === "offline" ? "error" : "available";
  let offerVersion = "0.10.0";
  let downloadGate = null;
  const artifact = path.join(batch, "fixture-installer.exe");
  provider.quitAndInstallCalled = false;
  provider.installerPath = artifact;
  provider.autoRunAppAfterInstall = true;
  provider.checkForUpdates = async () => {
    counts.checks++;
    if (checkGate) await checkGate;
    if (checkMode === "error") throw new Error("Fixture is offline");
    const version = checkMode === "current" ? runtimeVersion : offerVersion;
    provider.emit(checkMode === "current" ? "update-not-available" : "update-available", { version });
    return { updateInfo: { version } };
  };
  provider.downloadUpdate = async () => {
    counts.downloads++;
    provider.emit("download-progress", { percent: 42 });
    if (phase === "download-failure") throw new Error("Fixture transfer refused");
    if (downloadGate) await downloadGate;
    fs.writeFileSync(artifact, "Not an executable. Controlled update fixture only.");
    provider.downloadedUpdateHelper = { file: artifact, versionInfo: { version: "0.10.0" },
      downloadedFileInfo: { sha512: "fixture-only", isAdminRightsRequired: false } };
    provider.emit("update-downloaded", { version: "0.10.0", downloadedFile: artifact });
    await new Promise(resolve => setTimeout(resolve, 150));
    return [artifact];
  };
  provider.quitAndInstall = () => {
    if (process.platform !== "linux") throw new Error("Unexpected updater installation route");
    counts.installs++;
    provider.emit("error", new Error("Fixture launch refused"));
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (phase === "notes" && request === "electron" && path.basename(parent.filename) === "main.js") {
      return notesElectron;
    }
    if (request === "electron-updater") return { autoUpdater: provider };
    if ((["daily", "notes"].includes(phase) || perfUi) && request === "./update-state" &&
        path.basename(parent.filename) === "main.js") {
      const actual = originalLoad.call(this, request, parent, isMain);
      return { ...actual, createUpdateState(options) {
        const state = actual.createUpdateState(options);
        if (phase === "daily") dailyState = state;
        else if (phase === "notes") notesState = state;
        else perfState = state;
        return state;
      } };
    }
    if (perfUi && request === "./update-schedule" &&
        path.basename(parent.filename) === "main.js") {
      const actual = originalLoad.call(this, request, parent, isMain);
      return { ...actual, createUpdateSchedule(options) {
        perfSchedule = actual.createUpdateSchedule(options);
        return perfSchedule;
      } };
    }
    if (phase === "daily" && request === "./update-schedule" &&
        path.basename(parent.filename) === "main.js") {
      const actual = originalLoad.call(this, request, parent, isMain);
      return { ...actual, createUpdateSchedule(options) {
        dailyOwner = actual.createUpdateSchedule({
          ...options, now: () => dailyClock, monotonicNow: () => dailyElapsed, random: () => 0.5,
          setTimer(callback, delay) {
            const id = ++dailyTimerId;
            dailyTimers.set(id, { callback, due: dailyClock + delay });
            return id;
          },
          clearTimer: id => dailyTimers.delete(id),
        });
        return dailyOwner;
      } };
    }
    if (perf) {
      const start = performance.now();
      try { return originalLoad.call(this, request, parent, isMain); }
      finally {
        const elapsed = performance.now() - start;
        if (elapsed >= 1) measurement.modules.push({ request, ms: elapsed });
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const childProcess = require("child_process");
  childProcess.spawn = (command, args) => {
    if (command !== artifact && !(portable && command === "cmd.exe")) {
      throw new Error("Unexpected child launch: " + command);
    }
    counts.launches++;
    if (phase === "portable-throw") throw new Error("Fixture synchronous launch refused");
    const child = new EventEmitter();
    child.unref = () => {};
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      counts.kills++;
      if (portable) counts.releasedAtCancel =
        fs.existsSync(path.join(path.dirname(args[1]), "release"));
      child.exitCode = 1;
      setImmediate(() => { child.emit("exit", 1); child.emit("close", 1); });
      return true;
    };
    if (portable) {
      counts.batchPath = args[1];
      process.nextTick(() => {
        if (phase === "portable-failure") {
          const fail = () => child.emit("error",
            Object.assign(new Error("Fixture portable launch refused"), { code: "ENOENT" }));
          if (counts.launches === 1) fail();
          else releaseHeldLaunch = fail;
        } else child.emit("spawn");
      });
    } else {
      process.nextTick(() => child.emit("error", Object.assign(new Error("Fixture launch refused"), { code: "ENOENT" })));
    }
    return child;
  };
  shell.openExternal = async url => { counts.external.push(url); };
  shell.openPath = async () => { throw new Error("No external app may run"); };
  const fixture = path.join(batch, "protected-document.md");
  const originalBody = "# Protected update fixture\n\nThis is a disposable document.\n";
  fs.writeFileSync(fixture, originalBody);
  let chosen = fixture;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  dialog.showMessageBoxSync = () => { throw new Error("Unexpected native modal"); };
  const originalHandle = ipcMain.handle;
  if (phase === "notes") ipcMain.handle = function (channel, handler) {
    return originalHandle.call(this, channel, channel !== "get-update-release-notes" ? handler
      : async (...args) => {
        notesAdmissions++;
        if (notesAdmissionGate) await notesAdmissionGate;
        return handler(...args);
      });
  };
  if (perf) measurement.stages.beforeMainRequire = performance.now() - started;
  const main = require(path.join(process.env.MARKALOO_UPDATE_SOURCE_ROOT || root, "src", "main.js"));
  ipcMain.handle = originalHandle;
  if (perf) measurement.stages.afterMainRequire = performance.now() - started;
  if (!perf || perfUi) Object.defineProperty(app, "isPackaged", { get: () => true });
  const { startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");
  const results = [];
  let win, sentinel;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const exec = code => win.webContents.executeJavaScript(code, true);
  const check = (name, ok, detail) => {
    results.push(!!ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
  };
  async function wait(label, predicate) {
    for (let i = 0; i < 300; i++) {
      if (await predicate()) return;
      await sleep(30);
    }
    throw new Error("Timed out: " + label);
  }
  const pageWait = (label, code) => wait(label, () => exec(code));
  const snapshot = () => exec("window.folia.getUpdateState()");
  const click = id => exec(`document.getElementById(${JSON.stringify(id)}).click();true`);
  async function openAbout() {
    await click("menuBtn");
    await click("fileBtn");
    await click("aboutMenuItem");
    await pageWait("About is open", "document.querySelector('body > #aboutDialog')?.open");
  }
  async function closeAbout() {
    await exec("window.MarkalooDialogs.closeAbout();true");
    await sleep(30);
  }
  async function menuPlacement() {
    await closeAbout();
    await click("laterUpdateBtn");
    await pageWait("fixture notice dismissed", "!document.getElementById('appUpdateToast').classList.contains('show')");
    const samples = [], before = { ...counts };
    const key = async keyCode => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode });
      if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode });
      await sleep(50);
    };
    for (const theme of ["clarity", "abyss"]) for (const [width, zoom] of [[1280, 1], [480, 1], [620, 1.5]]) {
      win.setContentSize(width, 800);
      win.webContents.setZoomFactor(zoom);
      await exec(`window.foliaThemes.setScheme(${JSON.stringify(theme)});menuBtn.focus();true`);
      await sleep(100);
      await key("Enter");
      await key("Tab");
      const fileFocused = await exec("document.activeElement===fileBtn&&mainMenu.classList.contains('visible')");
      await key("Enter");
      await key("Tab");
      const tocFocused = await exec("document.activeElement===toggleIndexBtn&&fileMenu.classList.contains('visible')");
      await key("Tab");
      const aboutFocused = await exec("document.activeElement===document.getElementById('aboutMenuItem')");
      const geometry = await exec(`(() => {
        const about=document.getElementById('aboutMenuItem'),above=about.previousElementSibling,
          below=about.nextElementSibling,history=below?.nextElementSibling,
          menu=document.getElementById('fileMenu').getBoundingClientRect(),r=about.getBoundingClientRect();
        const separators=[above,below].every(s=>{
          const b=s.getBoundingClientRect();
          return s.classList.contains('tools-menu-separator')&&s.getAttribute('aria-hidden')==='true'&&
            s.tabIndex<0&&!s.matches('button,a,input,select,textarea,[contenteditable="true"]')&&
            b.width>0&&b.height>=1&&b.left>=menu.left&&b.right<=menu.right;
        });
        const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        return {separators,inside:menu.left>=0&&menu.top>=0&&menu.right<=innerWidth+1&&menu.bottom<=innerHeight+1,
          ordered:above.getBoundingClientRect().bottom<=r.top&&r.bottom<=below.getBoundingClientRect().top&&
            history?.dataset.i18n==='history'&&below.getBoundingClientRect().bottom<=history.getBoundingClientRect().top,
          reachable:about.contains(hit)};
      })()`);
      fs.writeFileSync(path.join(batch, `menu-${theme}-${width}-${zoom}.png`),
        (await win.webContents.capturePage()).toPNG());
      await key("Enter");
      await pageWait("native About activation", "document.getElementById('aboutDialog').open");
      await key("Escape");
      await pageWait("native About dismissal", "!document.getElementById('aboutDialog').open");
      samples.push({ theme, width, zoom, geometry, fileFocused, tocFocused, aboutFocused,
        restored: await exec("document.activeElement===menuBtn&&!mainMenu.classList.contains('visible')&&!fileMenu.classList.contains('visible')") });
    }
    check("About boundaries stay visible above History in light dark normal narrow and high web zoom menus",
      samples.every(s => s.geometry.separators && s.geometry.inside && s.geometry.ordered && s.geometry.reachable), samples);
    check("native keyboard reaches and activates About across both menu separators and restores menu focus",
      samples.every(s => s.fileFocused && s.tocFocused && s.aboutFocused && s.restored), samples);
    check("menu placement checks do not check download or install updates",
      counts.checks === before.checks && counts.downloads === before.downloads && counts.launches === before.launches);
    fs.writeFileSync(path.join(batch, "menu-placement.json"), JSON.stringify(samples, null, 2));
    win.webContents.setZoomFactor(1);
    win.setContentSize(1100, 780);
  }
  async function question() {
    let target;
    await wait("Main-owned shutdown question", async () => {
      target = BrowserWindow.getAllWindows().find(candidate =>
        !candidate.isDestroyed() && candidate.webContents.getURL().includes("owned-dialog.html"));
      return target && target.webContents.executeJavaScript("document.querySelector('dialog')?.open===true");
    });
    return target;
  }
  async function choose(target, choice) {
    await target.webContents.executeJavaScript(
      `document.querySelector('[data-dialog-choice="${choice}"]').click();true`);
  }
  async function daily() {
    const settings = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const today = () => require("../src/update-schedule").localCalendar(dailyClock).day;
    const advance = async day => {
      const next = new Date(2026, 10, day, 10).getTime();
      dailyElapsed += Math.max(0, next - dailyClock);
      dailyClock = next;
      powerMonitor.emit("resume");
      await sleep(60);
    };
    await closeAbout();
    await pageWait("daily cached toast", "window.folia.getUpdateState().then(s=>s.canShowUpdate)");
    const first = await snapshot();
    check(dailyRequired[0], counts.checks === 0 && first.presentationOrigin === "automatic" &&
      settings().updateReminder.lastReservedLocalDay === today() &&
      JSON.stringify(settings().updateAvailability) === '{"schema":1,"version":"0.10.0"}' &&
      await exec("document.getElementById('appUpdateToast').classList.contains('show')"));
    ipcMain.emit("dismiss-update-notice", { sender: win.webContents, senderFrame: null }, first.presentationId);
    check(dailyRequired[12], !(await snapshot()).presentationDismissed && (await snapshot()).canShowUpdate);
    await click("laterUpdateBtn");
    await pageWait("Main dismissal retained", "window.folia.getUpdateState().then(s=>s.presentationDismissed)");
    const reloaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
    win.webContents.reload();
    await reloaded;
    await pageWait("daily reloaded production bridge", "!!window.MarkalooUpdates&&typeof window.CustomTabs?.getTabs==='function'");
    const afterReload = await snapshot();
    await exec("window.folia.dismissUpdateNotice('stale-presentation');true");
    check(dailyRequired[1], afterReload.presentationId === first.presentationId &&
      afterReload.presentationDismissed && !afterReload.canShowUpdate &&
      await exec("!document.getElementById('appUpdateToast').classList.contains('show')"));
    await openAbout();
    let releaseCheck;
    checkGate = new Promise(resolve => { releaseCheck = resolve; });
    await click("aboutCheckUpdates");
    await wait("daily held manual provider", () => counts.checks === 1);
    await advance(4);
    check(dailyRequired[2], settings().updateSchedule.localDay === today() &&
      settings().updateSchedule.state === "claimed" && counts.checks === 1 &&
      settings().updateReminder.lastReservedLocalDay < today());
    releaseCheck(); checkGate = null;
    await pageWait("daily manual overlap completed", "window.folia.getUpdateState().then(s=>s.canCheck)");
    const manual = await snapshot();
    await closeAbout();
    await click("laterUpdateBtn");
    await sleep(80);
    const dismissedManual = await snapshot();
    check(dailyRequired[3], counts.checks === 1 && manual.presentationOrigin === "manual" &&
      manual.presentationId !== first.presentationId &&
      dismissedManual.presentationId === manual.presentationId && dismissedManual.presentationDismissed &&
      settings().updateReminder.lastReservedLocalDay < today());
    await openAbout();
    await advance(5);
    await pageWait("daily automatic check settled behind About", "window.folia.getUpdateState().then(s=>s.canCheck)");
    check(dailyRequired[4], counts.checks === 2 && settings().updateReminder.lastReservedLocalDay < today() &&
      !(await snapshot()).canShowUpdate &&
      await exec("document.getElementById('aboutUpdateStatus').textContent.includes('0.10.0')"));
    const wasFocused = win.isFocused();
    await closeAbout();
    await pageWait("daily next-day same-version toast", "window.folia.getUpdateState().then(s=>s.canShowUpdate&&s.presentationOrigin==='automatic')");
    const laterDay = await snapshot();
    check(dailyRequired[5], laterDay.presentationId !== manual.presentationId &&
      laterDay.presentationVersion === first.presentationVersion &&
      settings().updateReminder.lastReservedLocalDay === today() && win.isFocused() === wasFocused);
    await click("laterUpdateBtn");
    // The real Main/provider error channel and snapshots revise the status;
    // they do not get to manufacture a second presentation.
    checkMode = "error";
    await dailyState.check();
    await sleep(60);
    check(dailyRequired[6], (await snapshot()).presentationId === laterDay.presentationId &&
      (await snapshot()).presentationDismissed && !(await snapshot()).canShowUpdate &&
      (await snapshot()).status === "error" && (await snapshot()).error.includes("Fixture is offline"));
    checkMode = "available";
    await click("openFile");
    await pageWait("daily real document painted", "viewer.querySelector('h1')?.textContent==='Protected update fixture'");
    await click("toggleEdit");
    await exec("markdownEditor.value='# Daily protected draft\\n\\nKeep this unsaved text.\\n';markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true");
    await pageWait("daily genuine unsaved document", "hasUnsavedChanges===true");
    let quitHeld = false;
    app.emit("before-quit", { preventDefault() { quitHeld = true; } });
    const pending = await question();
    await advance(6);
    const beforeCancel = settings().updateReminder.lastReservedLocalDay;
    await choose(pending, "1");
    await pageWait("daily cancellation leaves scheduler live", "window.folia.getUpdateState().then(s=>s.canShowUpdate&&s.presentationOrigin==='automatic')");
    check(dailyRequired[7], quitHeld && beforeCancel < today() &&
      settings().updateReminder.lastReservedLocalDay === today() && dailyTimers.size === 1 &&
      !main.__shutdown.state().authorized &&
      await exec("hasUnsavedChanges&&currentReloadSnapshot().includes('Keep this unsaved text.')") &&
      fs.readFileSync(fixture, "utf8") === originalBody);
    const observation = await sentinel.stop();
    check(dailyRequired[11], observation.hits.length === 0 && observation.stalls.length === 0, observation);
    const closedHandlers = app.listeners("window-all-closed");
    closedHandlers.forEach(listener => app.off("window-all-closed", listener));
    win.destroy();
    closedHandlers.forEach(listener => app.on("window-all-closed", listener));
    const popup = new BrowserWindow({ show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    const beforePark = counts.checks;
    await advance(7);
    check(dailyRequired[8], BrowserWindow.getAllWindows().length === 1 &&
      dailyTimers.size === 0 && counts.checks === beforePark &&
      settings().updateReminder.lastReservedLocalDay < today());
    const listeners = powerMonitor.listenerCount("resume");
    app.emit("will-quit", { preventDefault() {} });
    await advance(8);
    check(dailyRequired[9], dailyTimers.size === 0 &&
      powerMonitor.listenerCount("resume") === listeners - 1 && counts.checks === beforePark);
    check(dailyRequired[10], counts.downloads === 0 && installAttempts() === 0 && counts.external.length === 0);
    closedHandlers.forEach(listener => app.off("window-all-closed", listener));
    popup.destroy();
    closedHandlers.forEach(listener => app.on("window-all-closed", listener));
  }
  async function combined() {
    await closeAbout();
    await openAbout();
    await closeAbout();
    await openAbout();
    check(combinedRequired[2], counts.checks === 0 && counts.downloads === 0 && installAttempts() === 0);
    // Start the manual check before the packaged startup timer; keeping it held
    // proves that scheduled startup coalesces without a timing-sensitive count.
    let releaseCheck;
    checkGate = new Promise(resolve => { releaseCheck = resolve; });
    await click("aboutCheckUpdates");
    await wait("combined one held manual check", () => counts.checks === 1);
    await closeAbout();
    win.setSize(1280, 850);
    const files = ["alpha", "beta"].map(name => path.join(batch, "combined-" + name + ".md"));
    const bodies = ["Alpha", "Beta"].map(name => "# Combined " + name + "\n\n" +
      Array.from({ length: 18 }, (_, i) =>
        (i % 6 === 0 ? "## " + name + " section " + i + "\n\n" : "") +
        name + " paragraph " + i + ". " + "Independent editor and outline witness. ".repeat(5)).join("\n\n"));
    files.forEach((file, i) => fs.writeFileSync(file, bodies[i]));
    const tabs = [], drafts = [], undoTargets = [];
    const state = () => exec(`({
      edit:isEditMode,value:markdownEditor.value,start:markdownEditor.selectionStart,
      end:markdownEditor.selectionEnd,direction:markdownEditor.selectionDirection,
      history:JSON.stringify(historySnapshot()),dirty:hasUnsavedChanges
    })`);
    const panel = () => exec(`({
      toc:indexPanel.classList.contains('visible'),notes:notesPanel.classList.contains('visible'),
      pressed:toggleTocBtn.getAttribute('aria-pressed'),expanded:toggleTocBtn.getAttribute('aria-expanded'),
      saved:localStorage.getItem('readingSidePanel'),zoom:zoomLevel,
      label:zoomResetBtn.textContent,scale:Number(getComputedStyle(viewer).zoom)
    })`);
    async function settle() {
      await sleep(180);
      await exec("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
    }
    async function select(index) {
      await exec(`window.CustomTabs.switchToTab(${tabs[index]})`);
      await pageWait("combined selected document " + index, `window.CustomTabs.getActiveTabId()===${tabs[index]}&&
        viewer.querySelector('h1')?.textContent===${JSON.stringify("Combined " + (index ? "Beta" : "Alpha"))}&&
        !loadingScreen.classList.contains('active')`);
      await settle();
    }
    async function key(keyCode, modifiers = []) {
      win.focus();
      win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await sleep(40);
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (let i = 0; i < files.length; i++) {
      chosen = files[i];
      await click("openFile");
      await pageWait("combined admitted document " + i, `currentFilePath===${JSON.stringify(chosen)}&&
        viewer.querySelector('h1')?.textContent===${JSON.stringify("Combined " + (i ? "Beta" : "Alpha"))}&&
        !loadingScreen.classList.contains('active')`);
      tabs.push(await exec("window.CustomTabs.getActiveTabId()"));
    }
    // Admit both clean files through the real dialog before dirtying either.
    // Opening over unsaved work correctly asks for consent; bypassing that
    // question here would test the wrong admission lifecycle.
    for (let i = 0; i < files.length; i++) {
      await select(i);
      await click("openEditorBtn");
      await pageWait("combined split editor", "isEditMode&&contentWrapper.classList.contains('split-view')");
      const text = bodies[i] + "\n\nUnsaved combined " + (i ? "Beta" : "Alpha") + " witness.\n";
      undoTargets.push(text);
      await exec(`markdownEditor.value=${JSON.stringify(text)};
        markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true`);
      await sleep(900);
      const second = text + "\nSecond independent revision.\n";
      await exec(`markdownEditor.value=${JSON.stringify(second)};
        markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));
        markdownEditor.setSelectionRange(${12 + i},${28 + i},'backward');true`);
      await pageWait("combined edited preview", `viewer.textContent.includes(${JSON.stringify("Unsaved combined " + (i ? "Beta" : "Alpha") + " witness.")})&&
        viewer.textContent.includes('Second independent revision.')&&currentReloadSnapshot()===${JSON.stringify(second)}&&
        !loadingScreen.classList.contains('active')`);
      await sleep(900);
      drafts.push(await state());
    }
    // Switching captures the active draft into its tab before the cache oracle.
    await select(0);
    check(combinedRequired[0], tabs[0] !== tabs[1] && drafts[0].value !== drafts[1].value &&
      drafts.every((draft, i) => {
        const history = JSON.parse(draft.history);
        return draft.edit && draft.dirty &&
          draft.value === undoTargets[i] + "\nSecond independent revision.\n" &&
          draft.start === 12 + i && draft.end === 28 + i && draft.direction === "backward" &&
          same(history.undo, [{ source: bodies[i] }, { source: undoTargets[i] }]) &&
          same(history.redo, []) && history.exactTypingSource === draft.value;
      }) &&
      await exec(`window.CustomTabs.getTabs().filter(t=>${JSON.stringify(tabs)}.includes(t.id)).length===2&&
        window.CustomTabs.getTabs().filter(t=>${JSON.stringify(tabs)}.includes(t.id)).every(t=>t.hasUnsavedChanges)`), drafts);
    if (!(await panel()).toc) await click("toggleTocBtn");
    await click("zoomReset");
    const before = await exec("getViewerScroller().getBoundingClientRect().width");
    await click("toggleTocBtn");
    await settle();
    const closed = await panel();
    const wider = await exec("getViewerScroller().getBoundingClientRect().width");
    await click("toggleTocBtn");
    for (let i = 0; i < 5; i++) await click("zoomIn");
    await settle();
    const opened = await panel();
    check(combinedRequired[1], !closed.toc && closed.pressed === "false" && wider > before + 10 &&
      opened.toc && !opened.notes && opened.pressed === "true" && opened.expanded === "true" &&
      opened.saved === "toc" && opened.zoom === 150 && opened.scale === 1.5 && opened.label.includes("150") &&
      same(await state(), drafts[0]) &&
      await exec("indexList.querySelector('.index-item')?.textContent==='Combined Alpha'"), { before, wider, closed, opened });
    await openAbout();
    await closeAbout();
    await openAbout();
    const keyboardBefore = await state();
    const backgroundBefore = await panel();
    let trapped = true, traversed = new Set();
    for (let i = 0; i < 9; i++) {
      await key("Tab", i > 5 ? ["shift"] : []);
      const focus = await exec(`({inside:aboutDialog.contains(document.activeElement),id:document.activeElement.id,
        choice:document.activeElement.dataset.dialogChoice})`);
      trapped = trapped && focus.inside;
      traversed.add(focus.id || focus.choice);
    }
    await key("z", ["control"]);
    await key("e", ["control"]);
    await key("=", ["control"]);
    check(combinedRequired[3], trapped && traversed.size > 1 &&
      await exec("aboutDialog.open&&aboutDialog.contains(document.activeElement)") &&
      same(await state(), keyboardBefore) && same(await panel(), backgroundBefore), [...traversed]);
    await key("Escape");
    await pageWait("combined Escape dismisses About", "!document.getElementById('aboutDialog').open");
    check(combinedRequired[4], await exec("document.activeElement.id==='menuBtn'") &&
      same(await state(), drafts[0]));
    await openAbout();
    await click("aboutCheckUpdates");
    await wait("combined one held manual check", () => counts.checks === 1);
    await pageWait("combined checking button", "aboutCheckUpdates.disabled&&window.folia.getUpdateState().then(s=>s.status==='checking')");
    await closeAbout();
    await select(1);
    await click("toggleTocBtn");
    await click("zoomOut");
    await settle();
    const pendingPanel = await panel();
    await openAbout();
    check(combinedRequired[5], counts.checks === 1 && counts.downloads === 0 &&
      (await snapshot()).status === "checking" &&
      await exec("aboutDialog.open&&aboutCheckUpdates.disabled") &&
      !pendingPanel.toc && pendingPanel.pressed === "false" && pendingPanel.zoom === 140 &&
      same(await state(), drafts[1]), pendingPanel);
    releaseCheck();
    checkGate = null;
    await pageWait("combined manual result", "aboutUpdateStatus.textContent.includes('0.10.0')&&!aboutCheckUpdates.disabled");
    await closeAbout();
    await select(0);
    await click("toggleTocBtn");
    await click("zoomIn");
    await openAbout();
    check(combinedRequired[6], counts.checks === 1 && counts.downloads === 0 && installAttempts() === 0 &&
      await exec("aboutUpdateStatus.textContent===updateMessage.textContent&&aboutUpdateStatus.textContent.includes('0.10.0')&&aboutInstallUpdate.hidden") &&
      same(await state(), drafts[0]) && (await panel()).toc);
    for (const theme of ["clarity", "abyss"]) {
      await exec(`window.foliaThemes.setScheme(${JSON.stringify(theme)});true`);
      for (const narrow of [false, true]) {
        win.setMinimumSize(400, 400);
        win.setSize(narrow ? 680 : 1280, narrow ? 720 : 850);
        win.webContents.setZoomFactor(narrow ? 1.25 : 1);
        await settle();
        const layout = await exec(`(()=>{
          const d=document.getElementById('aboutDialog'),r=d.getBoundingClientRect();
          const body=d.querySelector('.note-dialog-body').getBoundingClientRect();
          return {width:innerWidth,theme:document.body.dataset.theme,open:d.open,
            inside:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,
            actions:['aboutCheckUpdates','aboutUpdateStatus','aboutDownloadUpdate'].every(id=>{
              const a=document.getElementById(id).getBoundingClientRect();
              return a.width>0&&a.top>=body.top&&a.bottom<=body.bottom+1;
            }),close:[...d.querySelectorAll('.note-dialog-footer button')].every(b=>{
              const a=b.getBoundingClientRect();return a.width>0&&a.bottom<=innerHeight+1;
            }),editor:isEditMode&&contentWrapper.classList.contains('split-view'),
            toc:indexPanel.classList.contains('visible'),zoom:zoomLevel};
        })()`);
        check(`combined themed About ${theme} ${narrow ? "narrow web zoom" : "normal"} keeps actions and document context visible`,
          layout.theme === theme && layout.open && layout.inside && layout.actions && layout.close &&
          layout.editor && layout.toc && layout.zoom === 150 && (!narrow || layout.width < 600), layout);
        fs.writeFileSync(path.join(batch, `combined-about-${theme}-${narrow ? "narrow-125" : "normal"}.png`),
          (await win.webContents.capturePage()).toPNG());
      }
    }
    win.webContents.setZoomFactor(1);
    win.setSize(1280, 850);
    await closeAbout();
    let historyWorks = true;
    for (let i = 0; i < 2; i++) {
      await select(i);
      await exec("historyUndo();true");
      await pageWait("combined real Undo " + i, `markdownEditor.value===${JSON.stringify(undoTargets[i])}&&
        viewer.textContent.includes(${JSON.stringify("Unsaved combined " + (i ? "Beta" : "Alpha") + " witness.")})&&
        !viewer.textContent.includes('Second independent revision.')`);
      const undoState = await state();
      const undoSnapshot = JSON.parse(undoState.history);
      await exec("historyRedo();true");
      await pageWait("combined real Redo " + i, `markdownEditor.value===${JSON.stringify(drafts[i].value)}&&
        viewer.textContent.includes('Second independent revision.')`);
      const independentDirty = await exec(`hasUnsavedChanges&&
        !markdownEditor.value.includes(${JSON.stringify("Unsaved combined " + (i ? "Alpha" : "Beta") + " witness.")})`);
      historyWorks = historyWorks && undoState.dirty &&
        same(undoSnapshot.undo, [{ source: bodies[i] }]) &&
        same(undoSnapshot.redo, [{ source: drafts[i].value }]) &&
        undoSnapshot.exactTypingSource === undoTargets[i] && independentDirty;
      // Undo/Redo moves the caret by design; restore the original witness before
      // comparing the independently owned selection and history snapshots.
      await exec(`markdownEditor.setSelectionRange(${drafts[i].start},${drafts[i].end},${JSON.stringify(drafts[i].direction)});true`);
    }
    check(combinedRequired[7], historyWorks);
    const restored = [];
    for (let i = 0; i < 2; i++) {
      await select(i);
      restored.push(await state());
    }
    check(combinedRequired[8], restored.every((value, i) => same(value, drafts[i])) &&
      files.every((file, i) => fs.readFileSync(file, "utf8") === bodies[i]) &&
      !main.__shutdown.state().authorized && counts.downloads === 0 && counts.external.length === 0, restored);
    const observation = await sentinel.stop();
    check(combinedRequired[9], observation.hits.length === 0 && observation.stalls.length === 0, observation);
  }
  async function releaseNotes() {
    const initialPresentation = (await snapshot()).presentationId;
    await click("aboutCheckUpdates");
    await pageWait("notes manual check completed",
      `window.folia.getUpdateState().then(s=>s.canCheck&&s.availableVersion==='0.10.0'&&` +
      `s.presentationOrigin==='manual'&&s.presentationId!==${JSON.stringify(initialPresentation)})`);
    await closeAbout();
    await pageWait("notes offered popup", "appUpdateToast.classList.contains('show')&&!appUpdateToast.inert");
    check(notesRequired[0], notesRequests.length === 0 && counts.checks >= 1 &&
      await exec("updateNotesToggle.getAttribute('aria-expanded')==='false'&&updateNotesPanel.hidden"));
    win.hide();
    await wait("collapsed notes hidden", async () => !(await snapshot()).canShowUpdate);
    win.show();
    await pageWait("collapsed notes restored", "appUpdateToast.classList.contains('show')");
    check(notesRequired[16], notesRequests.length === 0 &&
      await exec("updateNotesToggle.getAttribute('aria-expanded')==='false'"));
    const resolveNotes = (index, body, tag = decodeURIComponent(new URL(notesRequests[index].url).pathname.split("/").pop())) =>
      notesRequests[index].resolve(new Response(JSON.stringify({ tag_name: tag, body })));
    let admitNotes;
    notesAdmissionGate = new Promise(resolve => { admitNotes = resolve; });
    await click("updateNotesToggle");
    await wait("held first notes admission", () => notesAdmissions === 1);
    win.hide();
    await wait("expanded notes hidden before admission", async () => !(await snapshot()).canShowUpdate);
    check(notesRequired[14], notesRequests.length === 0 &&
      await exec("updateNotesToggle.getAttribute('aria-expanded')==='true'&&updateNotesStatus.textContent.includes('Loading')"));
    admitNotes();
    notesAdmissionGate = null;
    await wait("first notes request", () => notesRequests.length === 1);
    check(notesRequired[1],
      notesRequests[0].url === "https://api.github.com/repos/lostinsea/markaloo/releases/tags/v0.10.0" &&
      counts.notesRequests[0].credentials === "omit" && counts.notesRequests[0].redirect === "error" &&
      await exec("!updateNotesPanel.hidden&&updateNotesStatus.textContent.includes('Loading')"));
    await click("updateNotesToggle"); await click("updateNotesToggle");
    check(notesRequired[2], notesRequests.length === 1 &&
      await exec("!downloadUpdateBtn.disabled&&!laterUpdateBtn.disabled&&!closeUpdateToast.disabled"));
    await exec(`window.__notesHookHits=0;
      window.__notesHook=()=>{window.__notesHookHits++};
      DOMPurify.addHook('afterSanitizeAttributes',window.__notesHook);
      window.__notesResourceStart=performance.getEntriesByType('resource').length;true`);
    const markdown = ("## Offered 0.10.0\n\n**Safe notes** and [inert label](https://example.invalid/notes).\n\n" +
      "![Inert image label](https://example.invalid/image.png)\n\n" +
      '<img src="https://example.invalid/html.png" onerror="window.__notesExecuted=true">\n' +
      '<iframe src="https://example.invalid/frame"></iframe>\n' +
      '<script>window.__notesExecuted=true</script>\n' +
      '<svg onload="window.__notesExecuted=true"></svg>\n' +
      '<form><input autofocus><button>Do not run</button></form>\n\n' +
      Array.from({ length: 70 }, (_, index) => `- Bounded readable item ${index}`).join("\n")).padEnd(65536, "x");
    resolveNotes(0, markdown);
    await pageWait("actual notes body", "!updateNotesBody.hidden&&!!updateNotesBody.querySelector('h2')");
    const safety = await exec(`(()=>{
      const body=updateNotesBody,forbidden=body.querySelectorAll(
        'a,img,script,style,iframe,svg,math,form,input,button,object,embed,audio,video,'+
        '[id],[class],[style],[href],[src],[data-x],[onclick],[onerror]');
      const removed=DOMPurify.removeHook('afterSanitizeAttributes');
      return {text:body.textContent.includes('Safe notes')&&body.textContent.includes('inert label')&&
          body.textContent.length>60000,
        basic:!!body.querySelector('strong')&&!!body.querySelector('li'),forbidden:forbidden.length,
        hooks:window.__notesHookHits,ownHook:removed===window.__notesHook,
        executed:window.__notesExecuted===true,
        requests:performance.getEntriesByType('resource').slice(window.__notesResourceStart)
          .filter(entry=>/^https?:/.test(entry.name)).map(entry=>entry.name)};
    })()`);
    check(notesRequired[3], safety.text && safety.basic && safety.forbidden === 0 &&
      safety.hooks === 0 && safety.ownHook && !safety.executed && safety.requests.length === 0, safety);
    win.show();
    await pageWait("completed notes restored", "appUpdateToast.classList.contains('show')&&!updateNotesBody.hidden");
    check(notesRequired[15], notesRequests.length === 1 &&
      await exec("updateNotesToggle.getAttribute('aria-expanded')==='true'&&updateNotesRetry.hidden"));
    for (const [label, width, height, zoom, theme] of [
      ["normal", 1100, 780, 1, "clarity"],
      ["narrow enlarged", 480, 700, 1.5, "abyss"],
      ["short enlarged", 700, 380, 1.25, "clarity"],
    ]) {
      win.setContentSize(width, height); win.webContents.setZoomFactor(zoom);
      await exec(`window.foliaThemes.setScheme(${JSON.stringify(theme)});appUpdateToast.scrollTop=0;true`);
      await exec("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
      const geometry = await exec(`(()=>{
        const toast=appUpdateToast.getBoundingClientRect(),body=updateNotesBody;
        const actions=[downloadUpdateBtn,laterUpdateBtn,closeUpdateToast].every(button=>{
          const r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          return !button.hidden&&!button.disabled&&r.width>0&&r.height>0&&button.contains(hit)&&
            r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;
        });
        const before=body.scrollTop;body.scrollTop+=40;
        return {inside:toast.left>=0&&toast.top>=0&&toast.right<=innerWidth+1&&toast.bottom<=innerHeight+1,
          actions,scrollable:body.clientHeight>0&&body.scrollHeight>body.clientHeight&&body.scrollTop>before,
          keyboard:body.tabIndex===0&&!body.hidden,width:innerWidth,height:innerHeight,
          dpr:devicePixelRatio,zoom:${zoom}};
      })()`);
      fs.writeFileSync(path.join(batch, `notes-${label.replace(/ /g, "-")}.png`),
        (await win.webContents.capturePage()).toPNG());
      check(`notes ${label} layout keeps main actions reachable and notes independently scrollable`,
        geometry.inside && geometry.actions && geometry.scrollable && geometry.keyboard, geometry);
    }
    win.setContentSize(1100, 780); win.webContents.setZoomFactor(1);
    await click("updateNotesToggle"); await click("updateNotesToggle");
    await openAbout(); await closeAbout();
    check(notesRequired[4], notesRequests.length === 1 &&
      await exec("updateNotesToggle.getAttribute('aria-expanded')==='true'&&!updateNotesBody.hidden"));

    if (process.platform === "darwin") {
      const manual = await snapshot();
      check(notesRequired[5], manual.manualOnly && !manual.canInstall && counts.downloads === 0 &&
        await exec("!downloadUpdateBtn.hidden&&!downloadUpdateBtn.disabled&&" +
          "downloadUpdateBtn.textContent==='Open release downloads'&&installUpdateBtn.hidden"));
    } else {
      let releaseDownload;
      downloadGate = new Promise(resolve => { releaseDownload = resolve; });
      await click("downloadUpdateBtn");
      await wait("notes actual held download", () => counts.downloads === 1);
      await pageWait("download presentation reset", "updateNotesToggle.getAttribute('aria-expanded')==='false'");
      await click("updateNotesToggle");
      await wait("notes during download", () => notesRequests.length === 2);
      const downloading = await snapshot();
      releaseDownload();
      await pageWait("notes actual ready install", "window.folia.getUpdateState().then(s=>s.canInstall)");
      const ready = await snapshot();
      check(notesRequired[5], ready.presentationId === downloading.presentationId &&
        notesRequests.length === 2 && !notesRequests[1].aborted &&
        await exec("updateNotesToggle.getAttribute('aria-expanded')==='true'&&" +
          "!installUpdateBtn.hidden&&!installUpdateBtn.disabled&&updateNotesStatus.textContent.includes('Loading')"));
      resolveNotes(1, "");
      await pageWait("empty notes after download", "updateNotesStatus.textContent.includes('No release notes')");
    }
    const cachedRequestCount = notesRequests.length;
    await click("laterUpdateBtn");
    const previousPresentation = (await snapshot()).presentationId;
    await openAbout(); await click("aboutCheckUpdates");
    await pageWait("notes fresh manual presentation",
      `window.folia.getUpdateState().then(s=>s.canCheck&&s.presentationId!==${JSON.stringify(previousPresentation)})`);
    await closeAbout();
    check(notesRequired[6], notesRequests.length === cachedRequestCount &&
      await exec("updateNotesToggle.getAttribute('aria-expanded')==='false'&&updateNotesPanel.hidden"));
    await click("updateNotesToggle");
    await wait("old target request before replacement", () => notesRequests.length === cachedRequestCount + 1);
    const before = await snapshot();
    offerVersion = "0.11.0";
    await notesState.check();
    await pageWait("higher target on same presentation", "window.folia.getUpdateState().then(s=>s.presentationVersion==='0.11.0')");
    const changed = await snapshot();
    check(notesRequired[7], before.presentationId === changed.presentationId &&
      notesRequests[cachedRequestCount].aborted &&
      await exec("updateNotesToggle.getAttribute('aria-expanded')==='false'&&updateNotesBody.hidden"));
    resolveNotes(cachedRequestCount, "Retired target");
    await click("updateNotesToggle");
    await wait("replacement target request", () => notesRequests.length === cachedRequestCount + 2);
    await sentinel.mute("intentional exact-target mismatch");
    win.hide();
    await wait("notes failure owner hidden", async () => !(await snapshot()).canShowUpdate);
    resolveNotes(cachedRequestCount + 1, "Wrong release", "v0.10.0");
    await pageWait("notes visible mismatch error", "!updateNotesRetry.hidden&&updateNotesStatus.textContent.includes('could not')");
    win.show();
    await pageWait("failed notes restored", "appUpdateToast.classList.contains('show')&&!updateNotesRetry.hidden");
    check(notesRequired[17], notesRequests.length === cachedRequestCount + 2 &&
      await exec("updateNotesToggle.getAttribute('aria-expanded')==='true'&&!updateNotesStatus.textContent.includes('Loading')"));
    await sentinel.drain();
    const negative = sentinel.currentMute().suppressed;
    check(notesRequired[8], negative.length === 1 && negative[0].kind === "console-error" &&
      negative[0].detail.startsWith("Could not show release notes:") &&
      negative[0].detail.includes("did not match") && (await snapshot()).status !== "error", negative);
    await sentinel.unmute();
    await click("updateNotesToggle"); await click("updateNotesToggle");
    const beforeRetry = notesRequests.length;
    await click("updateNotesRetry");
    await wait("explicit notes retry", () => notesRequests.length === cachedRequestCount + 3);
    resolveNotes(cachedRequestCount + 2, "");
    await pageWait("retry empty notes", "updateNotesStatus.textContent.includes('No release notes')");
    await click("updateNotesToggle"); await click("updateNotesToggle");
    check(notesRequired[9], beforeRetry === cachedRequestCount + 2 &&
      notesRequests.length === cachedRequestCount + 3 &&
      notesRequests[cachedRequestCount + 2].url.endsWith("/v0.11.0") &&
      await exec("updateNotesRetry.hidden"));
    const retryPresentation = (await snapshot()).presentationId;
    offerVersion = "0.10.0";
    await openAbout(); await click("aboutCheckUpdates");
    await pageWait("lower live offer",
      `window.folia.getUpdateState().then(s=>s.canCheck&&s.lastCheck==='not-available'&&` +
      `s.presentationId!==${JSON.stringify(retryPresentation)})`);
    await closeAbout(); await click("updateNotesToggle");
    await wait("higher remembered target notes", () => notesRequests.length === cachedRequestCount + 4);
    check(notesRequired[10], (await snapshot()).availableVersion === "0.11.0" &&
      notesRequests[cachedRequestCount + 3].url.endsWith("/v0.11.0"));
    await click("closeUpdateToast");
    await wait("notes close abort", () => notesRequests[cachedRequestCount + 3].aborted);
    resolveNotes(cachedRequestCount + 3, "Dismissed late result");
    await sentinel.drain();
    check(notesRequired[11], await exec("appUpdateToast.inert&&!appUpdateToast.classList.contains('show')&&updateNotes.hidden"));
    check(notesRequired[12], counts.downloads === (process.platform === "darwin" ? 0 : 1) &&
      installAttempts() === 0 &&
      counts.external.length === 0 && fs.readFileSync(fixture, "utf8") === originalBody);
    const observation = await sentinel.stop();
    check(notesRequired[13], observation.hits.length === 0 && observation.stalls.length === 0, observation);
  }

  async function finish(error) {
    stopPerfFrames?.();
    if (error) check("About update harness completed", false, error.stack);
    clearTimeout(watchdog);
    const passed = results.filter(Boolean).length;
    const receipt = { phase, runtimeVersion, counts, results, profile, measurement };
    fs.writeFileSync(path.join(batch, phase + ".json"), JSON.stringify(receipt, null, 2));
    const text = `=== updates ${phase}: ${passed}/${results.length} passed ===\n`;
    fs.writeSync(1, text);
    app.exit(error || passed !== results.length ? 1 : 0);
  }
  const watchdog = setTimeout(() => finish(new Error("Watchdog")), 105000);
  app.whenReady().then(async () => {
    await wait("reader window", () => {
      win = BrowserWindow.getAllWindows().find(candidate =>
        candidate.webContents.getURL().endsWith("index.html"));
      return !!win;
    });
    if (perf) {
      const paintedSurface = id => exec(`(async()=>{
        const element=document.getElementById(${JSON.stringify(id)});
        await Promise.all(element.getAnimations({subtree:true})
          .filter(animation=>animation.effect.getTiming().iterations!==Infinity)
          .map(animation=>animation.finished));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const rect=element.getBoundingClientRect();
        return {opacity:getComputedStyle(element).opacity,width:rect.width,height:rect.height,
          inside:rect.left>=0&&rect.top>=0&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1};
      })()`);
      async function presentedPopup(id, buttonId, trigger = async () => {}) {
        const contents = win.webContents;
        let lifecycle = 0, layout, triggeredAt, background = null;
        const admission = createPopupFrameAdmission({
          currentEpoch: () => popupObservationEpoch(win, perfState, perfSchedule, lifecycle, perfExpectsSchedule),
          matches: popupFrameMatches, now: () => performance.now(),
        });
        const changed = () => {
          lifecycle++;
          admission.stop(new Error("Popup window or renderer changed during observation"));
        };
        const listeners = [
          [contents, "did-navigate"], [contents, "render-process-gone"], [contents, "destroyed"],
          [contents, "zoom-changed"], [win, "closed"], [win, "resize"], [win, "hide"], [win, "minimize"],
        ];
        for (const [target, event] of listeners) target.on(event, changed);
        let timer = null, stopped = false;
        stopPerfFrames = () => {
          if (stopped) return;
          stopped = true;
          clearTimeout(timer);
          for (const [target, event] of listeners) target.removeListener(event, changed);
          admission.stop();
          if (!contents.isDestroyed()) contents.endFrameSubscription();
        };
        try {
          const prepare = (async () => {
            const active = () => {
              if (stopped) throw new Error("Popup observation was canceled during preparation");
            };
            background = id === "aboutDialog" ? await contents.capturePage() : null;
            active();
            timer = setTimeout(() => admission.stop(new Error("No verified popup presentation frame")), 9000);
            contents.beginFrameSubscription(false, image => admission.frame(image, performance.now()));
            triggeredAt = performance.now();
            await trigger();
            active();
            layout = await paintedSurface(id);
            active();
            const epoch = popupObservationEpoch(win, perfState, perfSchedule, lifecycle, perfExpectsSchedule);
            const witness = await exec(`(()=>{
            const root=document.getElementById(${JSON.stringify(id)});
            const button=document.getElementById(${JSON.stringify(buttonId)});
            const r=root.getBoundingClientRect(),b=button.getBoundingClientRect();
            const color=value=>{
              if(!/^rgba?\\(/.test(value))throw Error('Unsupported popup color');
              const parts=value.match(/[\\d.]+/g).map(Number);
              return parts.length===3?[...parts,1]:parts;
            };
            const panel=color(getComputedStyle(root).backgroundColor);
            const fill=color(getComputedStyle(button).backgroundColor);
            const patches=[
              {kind:'panel',x:r.left+8,y:r.top+32,color:panel},
              {kind:'panel',x:r.right-8,y:r.top+r.height/2,color:panel},
              {kind:'panel',x:r.left+8,y:r.bottom-24,color:panel},
              ...[[.1,.3],[.9,.3],[.1,.7]].map(([x,y])=>({
                kind:'button',x:b.left+b.width*x,y:b.top+b.height*y,color:fill}))
            ];
            const backdrop=root.tagName==='DIALOG';
            if(backdrop){
              const tint=color(getComputedStyle(root,'::backdrop').backgroundColor);
              for(const y of [.2,.5,.8]){
                const point={kind:'backdrop',x:8,y:innerHeight*y,color:tint};
                if(point.x>=r.left&&point.x<=r.right&&point.y>=r.top&&point.y<=r.bottom)
                  throw Error('Backdrop witness is covered by its panel');
                patches.push(point);
              }
            }
            return {width:innerWidth,height:innerHeight,patches,backdrop};
            })()`);
            active();
            if (background && popupFrameMatches(background, witness, background)) {
              throw new Error("Document-only image passed the popup presentation predicate");
            }
            admission.ready(witness, background, epoch);
            contents.invalidate();
          })();
          const [, frame] = await Promise.all([prepare, admission.promise]);
          return { ...frame, at: frame.verifiedAt, png: frame.image.toPNG(),
            layout, background, triggeredAt };
        } finally {
          stopPerfFrames();
          stopPerfFrames = null;
        }
      }
      await pageWait("painted reader", "!!document.getElementById('viewer')&&typeof window.CustomTabs?.getTabs==='function'");
      measurement.stages.readerObserved = performance.now() - started;
      measurement.frames = await exec(`new Promise(resolve=>{
        const start=performance.now();
        requestAnimationFrame(first=>requestAnimationFrame(second=>resolve({
          start,first,second,visibility:document.visibilityState,focused:document.hasFocus(),
          navigation:performance.getEntriesByType('navigation').map(entry=>({
            responseEnd:entry.responseEnd,domInteractive:entry.domInteractive,
            domContentLoaded:entry.domContentLoadedEventEnd,load:entry.loadEventEnd
          }))
        })));
      })`);
      measurement.startup = performance.now() - started;
      measurement.window = { visible: win.isVisible(), focused: win.isFocused(),
        backgroundThrottling: win.webContents.getBackgroundThrottling() };
      if (perfUi) {
        await pageWait("cached update notice visible",
          "document.getElementById('appUpdateToast').classList.contains('show')&&" +
          "document.getElementById('updateMessage').textContent.includes('0.10.0')");
        const notice = await presentedPopup("appUpdateToast", "downloadUpdateBtn");
        measurement.noticePaint = notice.layout;
        measurement.noticeWitness = notice.witness;
        measurement.noticeFrameTiming = {
          received: notice.frameReceivedAt - started,
          prerequisitesReady: notice.prerequisitesReadyAt - started,
          verified: notice.verifiedAt - started,
        };
        measurement.cachedNoticeReady = notice.at - started;
        check("popup performance proves an offered cached version in the painted ordinary notice",
          measurement.noticePaint.opacity === "1" && measurement.noticePaint.height > 0 &&
          measurement.noticePaint.inside &&
          (await snapshot()).availableVersion === "0.10.0");
        fs.writeFileSync(path.join(batch, phase + "-notice.png"), notice.png);
        await click("laterUpdateBtn");
      }
      const { generate } = require("../bench/corpus");
      const body = "# Update performance fixture\n\n" + generate("prose", 64 * 1024);
      fs.writeFileSync(fixture, body);
      const openStarted = performance.now();
      await click("openFile");
      await pageWait("representative prose painted", "viewer.querySelector('h1')?.textContent==='Update performance fixture'&&!loadingScreen.classList.contains('active')");
      await exec("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
      measurement.open = performance.now() - openStarted;
      if (perfUi) {
        const about = await presentedPopup("aboutDialog", "aboutCheckUpdates", openAbout);
        measurement.aboutPaint = about.layout;
        measurement.aboutWitness = about.witness;
        measurement.aboutFrameTiming = {
          received: about.frameReceivedAt - about.triggeredAt,
          prerequisitesReady: about.prerequisitesReadyAt - about.triggeredAt,
          verified: about.verifiedAt - about.triggeredAt,
        };
        measurement.aboutOpen = about.at - about.triggeredAt;
        check("popup performance measures the first genuinely open About above the representative document",
          measurement.aboutPaint.opacity === "1" && measurement.aboutPaint.height > 0 &&
          measurement.aboutPaint.inside &&
          await exec("document.getElementById('aboutDialog').open&&" +
            "viewer.querySelector('h1')?.textContent==='Update performance fixture'"));
        check("popup compositor predicate rejects the pre-About document for both surfaces",
          !popupFrameMatches(about.background, measurement.noticeWitness) &&
          !popupFrameMatches(about.background, measurement.aboutWitness, about.background));
        fs.writeFileSync(path.join(batch, phase + "-about.png"), about.png);
      }
      check("performance sample uses a real representative prose document", await exec("originalMarkdown.length>65536&&viewer.querySelectorAll('p').length>150"));
      check("performance sample runs without updater network calls", counts.checks === 0 && counts.downloads === 0);
      check("performance sample records startup and painted document", measurement.startup > 0 && measurement.open > 0);
      await finish();
      return;
    }
    await pageWait("production updater bridge", "!!window.MarkalooUpdates&&!!window.folia?.getUpdateState");
    await pageWait("shutdown renderer registered", "typeof window.CustomTabs?.getTabs==='function'");
    sentinel = startErrorSentinel(win, { label: "about-updates", trapExternal: false });
    const alive = await proveSentinelAlive(win, sentinel);
    check("About sentinel proves both error channels alive", alive.console && alive.dom, alive);
    check("About uses frozen production preload without Node or raw IPC",
      await exec("Object.isFrozen(window.folia)&&typeof require==='undefined'&&typeof window.folia.invoke==='undefined'"));
    await openAbout();
    check("About is isolated immediately above History after All Notes and Export",
      await exec(`(() => {
        const menu=document.getElementById('fileMenu'),children=[...menu.children],
          ids=children.map(e=>e.id||(e.classList.contains('tools-menu-separator')?'separator':e.dataset.i18n));
        return ids.join('|')==='openFile|toggleIndex|toggleEdit|toggleNotes|separator|export|exportPdf|separator|aboutMenuItem|separator|history|fileMenuRecent'&&
          document.querySelectorAll('#aboutMenuItem').length===1;
      })()`));
    check("About displays Main runtime version rather than package version",
      await exec(`document.getElementById('aboutVersion').textContent===${JSON.stringify("Version " + runtimeVersion)}`));
    check("About status and update actions follow Check for updates",
      await exec(`(()=>{
        const check=document.getElementById('aboutCheckUpdates');
        return ['aboutUpdateStatus','aboutDownloadUpdate','aboutInstallUpdate'].every(id=>
          !!(check.compareDocumentPosition(document.getElementById(id))&Node.DOCUMENT_POSITION_FOLLOWING));
      })()`));
    check("opening About performs no provider check or download", counts.checks === 0 && counts.downloads === 0);
    if (phase === "daily") {
      await daily();
    } else if (phase === "notes") {
      await releaseNotes();
    } else if (phase === "download-failure") {
      await closeAbout();
      await pageWait("download failure cached notice",
        "window.folia.getUpdateState().then(s=>s.canShowUpdate)");
      const prior = await snapshot();
      await click("laterUpdateBtn");
      await pageWait("download failure prior notice dismissed",
        "window.folia.getUpdateState().then(s=>s.presentationDismissed)");
      check(downloadFailureRequired[0],
        prior.presentationOrigin === "automatic" && counts.checks === 0 && counts.downloads === 0 &&
        !(await snapshot()).canShowUpdate);
      await openAbout();
      if (!fs.existsSync(artifact)) fs.writeFileSync(artifact, "Protected controlled prior artifact.");
      const artifactBefore = fs.existsSync(artifact)
        ? createHash("sha256").update(fs.readFileSync(artifact)).digest("hex") : null;
      check(downloadFailureRequired[4], artifactBefore !== null && counts.downloads === 0);
      await click("aboutDownloadUpdate");
      await pageWait("actual Main download transfer failed",
        "window.folia.getUpdateState().then(s=>s.status==='error'&&s.canDownload)");
      await closeAbout();
      const failed = await snapshot();
      check(downloadFailureRequired[1],
        counts.checks === 1 && counts.downloads === 1 && failed.presentationId !== prior.presentationId &&
        failed.presentationOrigin === "manual" && failed.canShowUpdate &&
        failed.error === "Fixture transfer refused" &&
        await exec("document.getElementById('appUpdateToast').classList.contains('show')&&" +
          "document.getElementById('updateMessage').textContent.includes('Fixture transfer refused')"));
      const artifactAfter = fs.existsSync(artifact)
        ? createHash("sha256").update(fs.readFileSync(artifact)).digest("hex") : null;
      counts.transferArtifact = { before: artifactBefore, after: artifactAfter };
      check(downloadFailureRequired[2],
        installAttempts() === 0 && counts.external.length === 0 &&
        artifactAfter === artifactBefore && fs.readFileSync(fixture, "utf8") === originalBody,
        counts.transferArtifact);
      const observation = await sentinel.stop();
      check(downloadFailureRequired[3],
        observation.hits.length === 0 && observation.stalls.length === 0, observation);
    } else if (phase === "combined") {
      await combined();
    } else if (portable) {
      await click("aboutCheckUpdates");
      await pageWait("portable available", "document.getElementById('aboutDownloadUpdate').hidden===false");
      await click("aboutDownloadUpdate");
      await pageWait("portable verified ready", "window.folia.getUpdateState().then(s=>s.canInstall)");
      check("portable fixture uses a verified download without any process launch", counts.downloads === 1 && counts.launches === 0);
      if (phase === "portable-cancel") {
        await closeAbout();
        await click("openFile");
        await pageWait("portable fixture painted", "viewer.querySelector('h1')?.textContent==='Protected update fixture'");
        await click("toggleEdit");
        await exec("markdownEditor.value='# Portable fixture\\n\\nKeep these unsaved edits.\\n';markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true");
        await pageWait("portable dirty", "hasUnsavedChanges===true");
        await openAbout();
      }
      if (phase === "portable-failure" || phase === "portable-throw") {
        await closeAbout();
        await click("laterUpdateBtn");
        await pageWait("portable prior presentation dismissed",
          "window.folia.getUpdateState().then(s=>s.presentationDismissed&&!s.canShowUpdate)");
        check("portable explicit-install setup proves the prior presentation is dismissed",
          (await snapshot()).presentationDismissed &&
          await exec("!document.getElementById('appUpdateToast').classList.contains('show')"));
        await openAbout();
      }
      await click("aboutInstallUpdate");
      if (phase === "portable-cancel") {
        await choose(await question(), "0");
        await wait("portable child intercepted", () => counts.launches === 1);
        await choose(await question(), "1");
        await pageWait("portable safe cancellation", "window.folia.getUpdateState().then(s=>s.canInstall)");
        check("portable commit cancellation is not reported as failure",
          (await snapshot()).status === "ready" && !(await snapshot()).error);
        check("portable commit cancellation preserves genuine unsaved edits and disk",
          await exec("hasUnsavedChanges&&currentReloadSnapshot().includes('Keep these unsaved edits.')") &&
          fs.readFileSync(fixture, "utf8") === originalBody && !main.__shutdown.state().authorized);
      } else {
        await wait("portable child intercepted", () => counts.launches === 1);
        if (phase === "portable-throw") {
          await pageWait("portable synchronous failure safe retry", "window.folia.getUpdateState().then(s=>s.canInstall)");
        } else {
          await wait("portable cancellation reached the intercepted child", () => counts.kills === 1);
          await sleep(60);
          check("portable fixture proves the release boundary before cancellation",
            counts.releasedAtCancel === (phase === "portable-ambiguous"));
        }
        const state = await snapshot();
        if (phase === "portable-failure" || phase === "portable-throw") {
          await pageWait("portable failure safe retry", "window.folia.getUpdateState().then(s=>s.canInstall)");
          check(`portable ${phase === "portable-throw" ? "synchronous " : ""}launch failure is visible and safely retryable`,
            state.status === "error" && state.error?.includes("could not be started") && state.canInstall);
          await exec("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
          check("portable explicit install failure remains visible after dismissing the previous notice",
            (await snapshot()).canShowUpdate && (await snapshot()).presentationOrigin === "manual" &&
            await exec("document.getElementById('appUpdateToast').classList.contains('show')&&" +
              "document.getElementById('updateMessage').textContent.includes('could not be started')"));
        } else {
          check("portable ambiguous handoff requires restart and forbids retry",
            state.status === "error" && state.error?.includes("Restart Markaloo") && !state.canInstall && !state.canCheck);
          await exec("window.folia.installUpdate();true");
          check("portable ambiguous handoff cannot launch a second child", counts.launches === 1);
        }
        check("portable failures retain availability and revoke shutdown approval",
          state.availableVersion === "0.10.0" && !main.__shutdown.state().authorized);
        if (phase === "portable-failure") {
          await openAbout();
          await click("aboutInstallUpdate");
          await wait("portable retry launch held", () => counts.launches === 2 && !!releaseHeldLaunch);
          const retryState = await snapshot();
          check("portable accepted retry clears the previous failure while pending",
            retryState.status === "installing" && !retryState.error && !retryState.canInstall);
          releaseHeldLaunch();
          await wait("portable retry child stopped", () => counts.kills === 2);
          await pageWait("portable retry safely refused", "window.folia.getUpdateState().then(s=>s.canInstall)");
        }
      }
      check("portable fixtures never ran a real installer or external application", counts.external.length === 0);
    } else if (phase === "discover") {
      let releaseCheck;
      checkGate = new Promise(resolve => { releaseCheck = resolve; });
      await click("aboutCheckUpdates");
      await wait("one pending check", () => counts.checks === 1);
      await pageWait("checking UI", "document.getElementById('aboutCheckUpdates').disabled");
      await exec("window.folia.checkForUpdates();window.folia.checkForUpdates();true");
      check("checking disables the button and coalesces duplicate commands",
        counts.checks === 1 && (await snapshot()).status === "checking");
      releaseCheck();
      checkGate = null;
      await pageWait("available update", "document.getElementById('aboutUpdateStatus').textContent.includes('0.10.0')");
      check("About and startup notice show the same available version",
        await exec("document.getElementById('updateMessage').textContent===document.getElementById('aboutUpdateStatus').textContent&&document.getElementById('appUpdateToast').classList.contains('show')"));
      check("checking availability never downloads automatically", counts.downloads === 0);
      check("profile stores only validated version metadata",
        JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, "utf8")).updateAvailability) ===
        '{"schema":1,"version":"0.10.0"}');
      await closeAbout();
      await openAbout();
      check("reopening About preserves status without another check", counts.checks === 1 &&
        await exec("document.getElementById('aboutUpdateStatus').textContent.includes('0.10.0')"));
      await sleep(5200);
      check("scheduled startup coalesces with the earlier manual check", counts.checks === 1);
      const beforeForged = counts.checks;
      ipcMain.emit("check-for-updates", { sender: win.webContents, senderFrame: null });
      check("missing-frame updater command is refused", counts.checks === beforeForged);
      check("updater has one event handler per live download event",
        provider.listenerCount("download-progress") === 1 && provider.listenerCount("update-downloaded") === 1);
      check("Download and Later cannot enable ordinary-quit installation",
        provider.autoDownload === false && provider.autoInstallOnAppQuit === false);
      checkMode = "error";
      await click("aboutCheckUpdates");
      await pageWait("check error", "document.getElementById('aboutUpdateStatus').textContent.includes('Fixture is offline')&&!document.getElementById('aboutCheckUpdates').disabled");
      check("failed manual check keeps availability and enables retry",
        (await snapshot()).availableVersion === "0.10.0" && (await snapshot()).status === "error");
      checkMode = "current";
      await click("aboutCheckUpdates");
      await pageWait("no-update retains knowledge", "document.getElementById('aboutUpdateStatus').textContent.includes('did not confirm')");
      check("later no-update cannot erase remembered newer availability", (await snapshot()).availableVersion === "0.10.0");
      checkMode = "available";
      await click("aboutCheckUpdates");
      await pageWait("retry successful", "document.getElementById('aboutCheckUpdates').disabled===false&&document.getElementById('aboutDownloadUpdate').hidden===false");
      await menuPlacement();
      await openAbout();
      for (const theme of ["clarity", "abyss"]) {
        await exec(`window.foliaThemes.setScheme(${JSON.stringify(theme)});true`);
        await sleep(150);
        fs.writeFileSync(path.join(batch, `about-${theme}.png`), (await win.webContents.capturePage()).toPNG());
        win.setMinimumSize(400, 400);
        win.setSize(520, 650);
        win.webContents.setZoomFactor(1.5);
        await sleep(180);
        const layout = await exec(`(()=>{
          const d=document.getElementById('aboutDialog'),r=d.getBoundingClientRect();
          return {inside:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,
            scroll:d.querySelector('.note-dialog-body').scrollHeight>d.querySelector('.note-dialog-body').clientHeight,
            font:getComputedStyle(d).fontFamily,
            close:[...d.querySelectorAll('.note-dialog-footer button')].every(b=>b.getBoundingClientRect().bottom<=innerHeight),
            actions:['aboutCheckUpdates','aboutUpdateStatus','aboutDownloadUpdate'].every(id=>{
              const b=document.getElementById(id).getBoundingClientRect();
              const body=d.querySelector('.note-dialog-body').getBoundingClientRect();
              return b.top>=body.top&&b.bottom<=body.bottom+1;
            })};
        })()`);
        check(`About ${theme} fits narrow high zoom with reachable actions`,
          layout.inside && layout.close && layout.actions && layout.font.includes("Fira"), layout);
        fs.writeFileSync(path.join(batch, `about-${theme}-narrow-150.png`), (await win.webContents.capturePage()).toPNG());
        win.webContents.setZoomFactor(1);
        win.setSize(1100, 780);
      }
      await exec("document.getElementById('aboutCheckUpdates').focus();true");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await pageWait("Escape closes About", "!document.getElementById('aboutDialog').open");
      check("About keyboard dismissal restores a visible toolbar control",
        await exec("document.activeElement.id==='menuBtn'"), await exec("document.activeElement.id"));
      await openAbout();
      if (process.platform === "darwin") {
        await click("aboutDownloadUpdate");
        await wait("fixed manual release fallback", () => counts.external.length === 1);
        check("macOS opens only the official release page without downloading or installing",
          counts.external[0] === "https://github.com/lostinsea/markaloo/releases/latest" &&
          counts.downloads === 0 && installAttempts() === 0 &&
          !(await snapshot()).canInstall &&
          await exec("document.getElementById('aboutInstallUpdate').hidden"));
      } else {
        let releaseDownload;
        downloadGate = new Promise(resolve => { releaseDownload = resolve; });
        await click("aboutDownloadUpdate");
        await wait("download entered", () => counts.downloads === 1);
        await exec("window.folia.downloadUpdate();true");
        await pageWait("progress shared", "document.getElementById('aboutUpdateStatus').textContent.includes('42%')&&document.getElementById('updateMessage').textContent.includes('42%')");
        check("download progress is shared and duplicate downloads coalesce",
          counts.downloads === 1 && !(await snapshot()).canInstall);
        releaseDownload();
        await pageWait("finalizing", "document.getElementById('aboutUpdateStatus').textContent.includes('Verifying')");
        check("downloaded event does not grant early install authority", !(await snapshot()).canInstall);
        await pageWait("real artifact ready", "!document.getElementById('aboutInstallUpdate').hidden");
        check("only completed provider download grants ready status", (await snapshot()).readyVersion === "0.10.0");
        await closeAbout();
        await click("openFile");
        await pageWait("protected fixture painted", "viewer.querySelector('h1')?.textContent==='Protected update fixture'");
        await click("toggleEdit");
        const edited = "# Protected update fixture\n\nUnsaved changes must survive Cancel.\n";
        await exec(`markdownEditor.value=${JSON.stringify(edited)};markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true`);
        await pageWait("genuine unsaved changes", "hasUnsavedChanges===true");
        check("install fixture has genuine dirty document content",
          await exec(`hasUnsavedChanges&&currentReloadSnapshot()===${JSON.stringify(edited)}`));
        await openAbout();
        await click("aboutInstallUpdate");
        const firstQuestion = await question();
        await exec("window.folia.installUpdate();window.folia.installUpdate();true");
        check("duplicate Install keeps one Main question and no launch",
          BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes("owned-dialog.html")).length === 1 &&
          installAttempts() === 0);
        await choose(firstQuestion, "1");
        await pageWait("install cancellation releases UI", "window.folia.getUpdateState().then(s=>s.canInstall)");
        check("canceling install preserves dirty content disk and shutdown protection",
          installAttempts() === 0 && await exec(`hasUnsavedChanges&&currentReloadSnapshot()===${JSON.stringify(edited)}`) &&
          fs.readFileSync(fixture, "utf8") === originalBody && !main.__shutdown.state().authorized);
        await openAbout();
        await click("aboutInstallUpdate");
        const secondQuestion = await question();
        const choices = await secondQuestion.webContents.executeJavaScript(
          "[...document.querySelectorAll('[data-dialog-choice]')].map(b=>({id:b.dataset.dialogChoice,label:b.textContent}))");
        const discard = choices.find(item => /discard/i.test(item.label));
        if (!discard) throw new Error("No genuine discard action: " + JSON.stringify(choices));
        await choose(secondQuestion, discard.id);
        await wait("controlled launch refusal", () => installAttempts() === 1);
        await pageWait("failed installer retry honest", "window.folia.getUpdateState().then(s=>s.status==='error'&&s.canInstall)");
        check("discard delegates only to Main launcher and failed launch restores protection",
          installAttempts() === 1 && !main.__shutdown.state().authorized &&
          fs.readFileSync(fixture, "utf8") === originalBody);
        await exec("saveMarkdownFile();true");
        await pageWait("genuine save completed", "!hasUnsavedChanges");
        check("saving after canceled or failed installation still uses genuine document authority",
          fs.readFileSync(fixture, "utf8") === edited && installAttempts() === 1);
        check("no real browser or external application was opened", counts.external.length === 0);
      }
      const observation = await sentinel.stop();
      check("About interaction produces no unexpected renderer errors",
        observation.hits.length === 0 && observation.stalls.length === 0, observation);
    } else if (phase === "offline") {
      await pageWait("cached notice defers behind actual About modal",
        "window.folia.getUpdateState().then(s=>!s.canShowUpdate&&!document.getElementById('appUpdateToast').classList.contains('show'))");
      check("full restart restores availability before any check and defers the automatic toast behind About",
        (await snapshot()).availableVersion === "0.10.0" && counts.checks === 0 &&
        await exec("!document.getElementById('appUpdateToast').classList.contains('show')"));
      check("restart cache is never trusted as a downloaded installer",
        !(await snapshot()).canInstall && (await snapshot()).readyVersion === null && counts.downloads === 0);
      await closeAbout();
      win.webContents.reload();
      await pageWait("new renderer bridge", "!!window.MarkalooUpdates");
      await openAbout();
      check("new reader renderer restores shared Main state without checking",
        counts.checks === 0 && await exec("document.getElementById('aboutUpdateStatus').textContent.includes('0.10.0')"));
      await closeAbout();
      const closedHandlers = app.listeners("window-all-closed");
      closedHandlers.forEach(listener => app.off("window-all-closed", listener));
      win.destroy();
      app.emit("activate");
      closedHandlers.forEach(listener => app.on("window-all-closed", listener));
      await wait("recreated reader window", () => {
        win = BrowserWindow.getAllWindows().find(candidate =>
          candidate.webContents.getURL().endsWith("index.html"));
        return !!win;
      });
      await pageWait("recreated reader updater", "!!window.MarkalooUpdates");
      await openAbout();
      check("new reader window receives the same Main availability without checking",
        counts.checks === 0 && (await snapshot()).availableVersion === "0.10.0");
      await click("aboutCheckUpdates");
      await pageWait("offline failure after restart", "document.getElementById('aboutUpdateStatus').textContent.includes('Fixture is offline')");
      check("offline check cannot hide restored availability", (await snapshot()).availableVersion === "0.10.0");
      await click("aboutDownloadUpdate");
      await wait("cached Download rechecks metadata", () => counts.checks === 2);
      check("offline cached Download cannot use old installer bytes", counts.downloads === 0 && !(await snapshot()).canInstall);
    } else {
      if (phase === "equal") {
        check("equal fixture exercises the actual package runtime version",
          runtimeVersion === require("../package.json").version);
      }
      if (phase === "current") {
        checkMode = "current";
        await click("aboutCheckUpdates");
        await pageWait("up to date", "document.getElementById('aboutUpdateStatus').textContent.includes('up to date')");
        check("current version check reports success below the button", (await snapshot()).status === "up-to-date");
      }
      check(`${phase} profile cannot restore obsolete or malformed availability`,
        !(await snapshot()).availableVersion && !(await snapshot()).canInstall);
      check(`${phase} profile ${phase === "current" ? "shows explicit manual success" : "hides the startup availability notice"}`,
        await exec(`document.getElementById('appUpdateToast').classList.contains('show')===${phase === "current"}`));
    }
    await finish();
  }).catch(finish);
}
