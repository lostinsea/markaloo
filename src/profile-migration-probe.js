"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PREFIX = "Storage.LocalStorage.";
const PROBE_PATH = path.join(__dirname, "profile-migration-probe.html");
const PROBE_URL = pathToFileURL(PROBE_PATH).href;
// Pinned Chromium distinguishes the CDP key from securityOrigin's "file://".
const STORAGE_KEY = "file:///";
const startedApps = new WeakSet();
// Chromium 150.0.7871.224: async_dom_storage_database.cc and db_status.cc.
const DATABASE_OPERATIONS = new Set([
  "OpenDatabase", "ReadMapKeyValues", "ReadAllMetadata", "PutMetadata",
  "CloneMap", "DeleteStorageKeysFromSession", "DeleteSessions",
  "PurgeOrigins", "CleanUpStaleData", "UpdateMaps",
]);
// Session creation can open the database and read metadata before page load.
// Neither operation reads the origin's map.
const INITIAL_HISTOGRAMS = new Set([
  "OpenDatabase.OnDisk", "Duration.OpenDatabase2.OnDisk",
  "ReadAllMetadata.OnDisk", "Duration.ReadAllMetadata.OnDisk",
]);
const FINAL_HISTOGRAMS = new Set([
  ...INITIAL_HISTOGRAMS,
  "ReadMapKeyValues.OnDisk", "Duration.ReadMapKeyValues.OnDisk",
]);
const SETTINGS_KEYS = new Set([
  "themeMode", "darkMode", "themeLightScheme", "themeDarkScheme",
  "readingZoom", "notesVisible", "editorSplitRatio", "readingSidePanel",
  "recentFiles", "openTabs", "activeTabPath",
]);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireCondition(condition, code, message) {
  if (!condition) throw failure(code, message);
}

function histogramSamples(response) {
  requireCondition(response && Array.isArray(response.histograms),
    "ERR_PROBE_HISTOGRAM_API", "Missing histogram response");
  const samples = new Map();
  for (const histogram of response.histograms) {
    requireCondition(histogram && typeof histogram.name === "string" &&
      histogram.name.startsWith(PREFIX) && !samples.has(histogram.name) &&
      Number.isSafeInteger(histogram.count) && histogram.count >= 0 &&
      Number.isSafeInteger(histogram.sum) && Array.isArray(histogram.buckets),
    "ERR_PROBE_HISTOGRAM_API", "Invalid or duplicate histogram");
    let count = 0;
    let previousHigh = -Infinity;
    let minimumSum = 0;
    let maximumSum = 0;
    for (const bucket of histogram.buckets) {
      requireCondition(bucket && Number.isSafeInteger(bucket.low) &&
        Number.isSafeInteger(bucket.high) && bucket.low < bucket.high &&
        bucket.low >= previousHigh &&
        Number.isSafeInteger(bucket.count) && bucket.count > 0,
      "ERR_PROBE_HISTOGRAM_API", "Invalid histogram bucket");
      count += bucket.count;
      minimumSum += bucket.low * bucket.count;
      maximumSum += (bucket.high - 1) * bucket.count;
      previousHigh = bucket.high;
    }
    requireCondition(Number.isSafeInteger(count) && count === histogram.count &&
      histogram.sum >= minimumSum && histogram.sum <= maximumSum,
    "ERR_PROBE_HISTOGRAM_API", "Inconsistent histogram counts or sum");
    samples.set(histogram.name, histogram);
  }
  return samples;
}

function validateHistogramOutcome(histogram) {
  const operation = histogram.name.slice(PREFIX.length);
  // Recovery outcome zero can mean that the database was destroyed/recreated.
  requireCondition(!operation.startsWith("Recovery.") &&
    !operation.startsWith("DestroyDatabase") &&
    !operation.startsWith("CommitErrorCountAtReset"),
  "ERR_PROBE_RECOVERY", "Local Storage reset or recovery was observed");
  requireCondition(!operation.endsWith(".InMemory"),
    "ERR_PROBE_IN_MEMORY", "In-memory Local Storage was observed");
  if (operation.startsWith("Duration.")) {
    requireCondition(histogram.sum >= 0 &&
      histogram.buckets.every(bucket => bucket.low >= 0),
    "ERR_PROBE_HISTOGRAM_API", "Invalid negative operation duration");
  } else {
    const match = /^([A-Za-z]+)\.OnDisk$/.exec(operation);
    requireCondition(match && DATABASE_OPERATIONS.has(match[1]),
      "ERR_PROBE_HISTOGRAM_API", "Unknown database operation");
    requireCondition(histogram.sum === 0 && histogram.buckets.every(bucket =>
      bucket.low === 0 && bucket.high === 1),
    "ERR_PROBE_DATABASE_STATUS", "A database operation did not succeed");
  }
  return operation;
}

function validateInitialLocalStorageHistograms(response) {
  const samples = histogramSamples(response);
  for (const histogram of samples.values()) {
    if (histogram.count === 0) continue;
    const operation = validateHistogramOutcome(histogram);
    requireCondition(INITIAL_HISTOGRAMS.has(operation) && histogram.count === 1,
      "ERR_PROBE_NOT_FRESH", "Unexpected or repeated Local Storage access before page load");
  }
  // CDP response objects must not rewrite the saved initial evidence.
  const normalized = [...samples.values()].map(histogram => Object.freeze({
    name: histogram.name, count: histogram.count, sum: histogram.sum,
    buckets: Object.freeze(histogram.buckets.map(bucket => Object.freeze({
      low: bucket.low, high: bucket.high, count: bucket.count,
    }))),
  })).sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({ histograms: Object.freeze(normalized) });
}

function validateLocalStorageHistograms(response, initial) {
  const baseline = validateInitialLocalStorageHistograms(initial);
  const samples = histogramSamples(response);
  for (const histogram of samples.values()) {
    if (histogram.count === 0) continue;
    const operation = validateHistogramOutcome(histogram);
    requireCondition(FINAL_HISTOGRAMS.has(operation),
      "ERR_PROBE_HISTOGRAM_API", "Unexpected Local Storage operation");
  }
  for (const operation of FINAL_HISTOGRAMS) {
    requireCondition(samples.get(PREFIX + operation)?.count === 1,
      "ERR_PROBE_MISSING_EVIDENCE", "Expected one sample for each on-disk open/metadata/map read");
  }
  for (const histogram of baseline.histograms) {
    if (histogram.count === 0) continue;
    const final = samples.get(histogram.name);
    requireCondition(final.count === histogram.count && final.sum === histogram.sum &&
      final.buckets.length === histogram.buckets.length &&
      final.buckets.every((bucket, index) => {
        const previous = histogram.buckets[index];
        return bucket.low === previous.low && bucket.high === previous.high &&
          bucket.count === previous.count;
      }),
    "ERR_PROBE_HISTOGRAM_API", "Cumulative Local Storage initialization evidence changed");
  }
  const openCount = samples.get(`${PREFIX}OpenDatabase.OnDisk`)?.count ?? 0;
  const readCount = samples.get(`${PREFIX}ReadMapKeyValues.OnDisk`)?.count ?? 0;
  return { openCount, readCount };
}

function validPath(value) {
  return typeof value === "string" && !value.includes("\0") &&
    path.win32.isAbsolute(value);
}

function validAnchor(anchor) {
  return anchor === null || (anchor && typeof anchor === "object" &&
    !Array.isArray(anchor) && Number.isFinite(anchor.scrollTop) &&
    anchor.scrollTop >= 0 &&
    (anchor.text === null || (typeof anchor.text === "string" &&
      anchor.text.length <= 1024 * 1024)) &&
    Number.isSafeInteger(anchor.ordinal) && anchor.ordinal >= 0 &&
    Number.isFinite(anchor.delta));
}

function parseSetting(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw failure("ERR_PROBE_SETTINGS", "A persisted settings value is not JSON");
  }
}

function validatePersistedSettings(entries) {
  requireCondition(Array.isArray(entries), "ERR_PROBE_SETTINGS",
    "Missing full settings map");
  const values = new Map();
  for (const entry of entries) {
    requireCondition(Array.isArray(entry) && entry.length === 2 &&
      typeof entry[0] === "string" && typeof entry[1] === "string" &&
      !values.has(entry[0]),
    "ERR_PROBE_SETTINGS", "Invalid or duplicate settings entry");
    values.set(entry[0], entry[1]);
  }
  requireCondition([...values.keys()].some(key => SETTINGS_KEYS.has(key)),
    "ERR_PROBE_EMPTY_SETTINGS", "No application settings were read");
  const allowed = {
    themeMode: ["light", "dark", "desktop"],
    darkMode: ["enabled", "disabled"],
    notesVisible: ["visible", "hidden"],
    readingSidePanel: ["closed", "toc", "notes"],
  };
  for (const [key, choices] of Object.entries(allowed)) {
    requireCondition(!values.has(key) || choices.includes(values.get(key)),
      "ERR_PROBE_SETTINGS", "An application preference has an invalid value");
  }
  // schemeFor() deliberately accepts withdrawn/unknown scheme IDs and falls
  // back to the mode's base scheme. Keep the saved choice intact.
  for (const key of ["themeLightScheme", "themeDarkScheme"]) {
    requireCondition(!values.has(key) || values.get(key).length > 0,
      "ERR_PROBE_SETTINGS", "An appearance scheme is empty");
  }
  if (values.has("readingZoom")) {
    const saved = values.get("readingZoom");
    const zoom = Number(saved);
    requireCondition(saved === String(zoom) && Number.isInteger(zoom) &&
      zoom >= 50 && zoom <= 400 && (zoom - 100) % 10 === 0,
    "ERR_PROBE_SETTINGS", "The reading zoom is invalid");
  }
  if (values.has("editorSplitRatio")) {
    const saved = values.get("editorSplitRatio");
    const ratio = Number.parseFloat(saved);
    // The existing restore deliberately clamps finite legacy ratios.
    requireCondition(Number.isFinite(ratio), "ERR_PROBE_SETTINGS",
      "The editor split ratio is invalid");
  }
  if (values.has("recentFiles")) {
    const recent = parseSetting(values.get("recentFiles"));
    requireCondition(Array.isArray(recent) && recent.length <= 100 &&
      recent.every(entry => entry && typeof entry === "object" &&
        !Array.isArray(entry) && validPath(entry.path) &&
        typeof entry.name === "string" &&
        Number.isFinite(entry.timestamp) && entry.timestamp >= 0),
    "ERR_PROBE_SETTINGS", "The recent-files list is invalid");
  }
  if (values.has("openTabs")) {
    const tabs = parseSetting(values.get("openTabs"));
    // Match Main's legacy import, including optional scroll/anchor fields.
    requireCondition(Array.isArray(tabs) && tabs.length <= 512 &&
      tabs.every(entry => entry && typeof entry === "object" &&
        validPath(entry.filePath) &&
        (entry.scrollPosition === undefined ||
          (Number.isFinite(entry.scrollPosition) && entry.scrollPosition >= 0)) &&
        validAnchor(entry.anchor == null ? null : entry.anchor)),
    "ERR_PROBE_SETTINGS", "The legacy tab list is invalid");
  }
  if (values.has("activeTabPath")) {
    requireCondition(values.get("activeTabPath") === "" ||
      validPath(values.get("activeTabPath")),
    "ERR_PROBE_SETTINGS", "The legacy active-tab path is invalid");
  }
  return entries.map(([key, value]) => [key, value]);
}

function verifyPhysicalDirectory(directory) {
  requireCondition(typeof directory === "string" && path.isAbsolute(directory) &&
    path.resolve(directory) === directory,
  "ERR_PROBE_DIRECTORY", "Expected an absolute normalized directory");
  let current = directory;
  for (;;) {
    const stat = fs.lstatSync(current);
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink(),
      "ERR_PROBE_DIRECTORY", "A storage directory is redirected");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  requireCondition(path.relative(directory, fs.realpathSync.native(directory)) === "",
    "ERR_PROBE_DIRECTORY", "The storage directory has a different physical path");
}

function verifyLevelDbPreconditions(directory) {
  verifyPhysicalDirectory(directory);
  const rebuild = `${directory}__tmp_for_rebuild`;
  requireCondition(!fs.lstatSync(rebuild, { throwIfNoEntry: false }),
    "ERR_PROBE_REBUILD", "A pending LevelDB rebuild exists");
  const currentPath = path.join(directory, "CURRENT");
  const currentStat = fs.lstatSync(currentPath);
  requireCondition(currentStat.isFile() && !currentStat.isSymbolicLink() &&
    currentStat.size > 0 && currentStat.size <= 1024,
  "ERR_PROBE_CURRENT", "LevelDB CURRENT is not a regular bounded file");
  const current = fs.readFileSync(currentPath, "utf8");
  requireCondition(/^MANIFEST-[0-9]+\n$/.test(current),
    "ERR_PROBE_CURRENT", "LevelDB CURRENT does not name one manifest");
  const manifestName = current.slice(0, -1);
  const manifest = fs.lstatSync(path.join(directory, manifestName));
  requireCondition(manifest.isFile() && !manifest.isSymbolicLink() &&
    manifest.size > 0,
  "ERR_PROBE_CURRENT", "The referenced LevelDB manifest is not a regular file");
  return { status: "preconditions-checked", backend: "leveldb", manifestName };
}

function verifySupportedLocalStorage(profilePath) {
  verifyPhysicalDirectory(profilePath);
  for (const name of ["LocalStorage", "LocalStorage-wal",
    "LocalStorage-shm", "LocalStorage-journal"]) {
    requireCondition(!fs.lstatSync(path.join(profilePath, name), { throwIfNoEntry: false }),
      "ERR_PROBE_UNSUPPORTED_SQLITE", "An unsupported SQLite Local Storage backend exists");
  }
  const storageDirectory = path.join(profilePath, "Local Storage");
  verifyPhysicalDirectory(storageDirectory);
  const entries = fs.readdirSync(storageDirectory);
  requireCondition(!entries.some(name =>
    /\.localstorage(?:-(?:journal|wal|shm))?$/i.test(name) ||
    /^storage\.sqlite(?:-(?:journal|wal|shm))?$/i.test(name)),
  "ERR_PROBE_UNSUPPORTED_SQLITE", "An unsupported legacy SQLite backend exists");
  return verifyLevelDbPreconditions(path.join(storageDirectory, "leveldb"));
}

// The caller owns the verified disposable copy. No result from this observer
// certifies staging bytes, migration completion or source corruption absence.
async function observeLocalStorageRead({
  probeWindow, expectedStoragePath, timeoutMs = 15000, signal,
}) {
  requireCondition(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 &&
    timeoutMs <= 60000, "ERR_PROBE_TIMEOUT", "Invalid probe timeout");
  verifySupportedLocalStorage(expectedStoragePath);
  if (signal?.aborted) throw signal.reason;
  const webContents = probeWindow.webContents;
  const debuggerApi = webContents.debugger;
  requireCondition(!webContents.isDestroyed() && !debuggerApi.isAttached(),
    "ERR_PROBE_NOT_FRESH", "The probe target is unavailable or already attached");
  requireCondition(["", "about:blank"].includes(webContents.getURL()),
    "ERR_PROBE_NOT_FRESH", "The probe target already loaded a document");
  const preferences = webContents.getLastWebPreferences();
  requireCondition(preferences && preferences.javascript === false &&
    preferences.nodeIntegration === false && preferences.contextIsolation === true &&
    preferences.sandbox === true && !preferences.preload,
  "ERR_PROBE_TARGET", "The probe must have scripts and preload disabled");
  let loaded = false;
  let loading = false;
  let navigationStarted = false;
  const checkTarget = () => {
    requireCondition(!webContents.isDestroyed() &&
      (!loaded || webContents.getURL() === PROBE_URL) &&
      webContents.session.getStoragePath() === expectedStoragePath,
    "ERR_PROBE_TARGET", "The probe document or storage path does not match");
  };
  checkTarget();
  let terminalError = null;
  let attached = false;
  let timer;
  let rejectInterrupted;
  const interrupted = new Promise((_resolve, reject) => { rejectInterrupted = reject; });
  const interrupt = error => {
    if (terminalError) return;
    terminalError = error;
    rejectInterrupted(error);
  };
  const onDetach = () => interrupt(failure("ERR_PROBE_DETACHED", "Probe debugger detached"));
  const onNavigation = (_event, url, isInPlace, isMainFrame) => {
    if (loading && !navigationStarted && url === PROBE_URL &&
        isInPlace === false && isMainFrame === true) {
      navigationStarted = true;
      return;
    }
    interrupt(failure("ERR_PROBE_NAVIGATION", "Probe target navigated"));
  };
  const onGone = () => interrupt(failure("ERR_PROBE_TARGET", "Probe target was lost"));
  const onAbort = () => interrupt(signal.reason);
  const check = () => {
    if (terminalError) throw terminalError;
    checkTarget();
    requireCondition(debuggerApi.isAttached(), "ERR_PROBE_DETACHED",
      "Probe debugger is not attached");
  };
  debuggerApi.on("detach", onDetach);
  webContents.on("did-start-navigation", onNavigation);
  webContents.on("render-process-gone", onGone);
  webContents.on("destroyed", onGone);
  signal?.addEventListener("abort", onAbort, { once: true });
  let result;
  let primaryError;
  try {
    timer = setTimeout(() => interrupt(failure("ERR_PROBE_TIMEOUT",
      "Local Storage probe timed out")), timeoutMs);
    const work = async () => {
      debuggerApi.attach("1.3");
      attached = true;
      check();
      const before = await debuggerApi.sendCommand("Browser.getHistograms", {
        query: PREFIX, delta: false,
      });
      check();
      const initial = validateInitialLocalStorageHistograms(before);
      loading = true;
      await probeWindow.loadFile(PROBE_PATH);
      loading = false;
      loaded = true;
      check();
      const frameTree = await debuggerApi.sendCommand("Page.getFrameTree");
      check();
      const frame = frameTree?.frameTree?.frame;
      requireCondition(frame && typeof frame.id === "string" && frame.id.length > 0 &&
        frame.url === PROBE_URL && frame.securityOrigin === "file://" &&
        (frame.unreachableUrl === undefined || frame.unreachableUrl === "") &&
        (frameTree.frameTree.childFrames === undefined ||
          (Array.isArray(frameTree.frameTree.childFrames) &&
            frameTree.frameTree.childFrames.length === 0)),
      "ERR_PROBE_ORIGIN", "The probe does not have one matching main frame");
      const checkStorageKey = async () => {
        const key = await debuggerApi.sendCommand("Storage.getStorageKey", {
          frameId: frame.id,
        });
        check();
        requireCondition(key && key.storageKey === STORAGE_KEY,
          "ERR_PROBE_ORIGIN", "The frame storage key does not match the admitted app key");
      };
      await checkStorageKey();
      check();
      const read = await debuggerApi.sendCommand("DOMStorage.getDOMStorageItems", {
        storageId: { storageKey: STORAGE_KEY, isLocalStorage: true },
      });
      check();
      const settings = validatePersistedSettings(read?.entries);
      await checkStorageKey();
      check();
      // AsyncDomStorageDatabase records status before its completion callback.
      // The completed full-map read orders this query; a delay would prove less.
      const after = await debuggerApi.sendCommand("Browser.getHistograms", {
        query: PREFIX, delta: false,
      });
      check();
      const counts = validateLocalStorageHistograms(after, initial);
      verifySupportedLocalStorage(expectedStoragePath);
      check();
      return { status: "observed", storageKey: STORAGE_KEY, settings, ...counts };
    };
    result = await Promise.race([work(), interrupted]);
  } catch (error) {
    primaryError = error;
  } finally {
    clearTimeout(timer);
    debuggerApi.removeListener("detach", onDetach);
    webContents.removeListener("did-start-navigation", onNavigation);
    webContents.removeListener("render-process-gone", onGone);
    webContents.removeListener("destroyed", onGone);
    signal?.removeEventListener("abort", onAbort);
    // Stop a late promise continuation from issuing another read/command.
    terminalError ||= failure("ERR_PROBE_CLOSED", "The probe observation has ended");
    if (attached && debuggerApi.isAttached()) {
      try {
        debuggerApi.detach();
      } catch (error) {
        primaryError = primaryError
          ? new AggregateError([primaryError, error], "Probe and debugger cleanup failed")
          : error;
      }
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

// Invoke only from a fresh migration-only Electron process, never normal Main.
// The migration owner verifies the closed copy inventory before this call and
// rehashes untouched staging afterward. This function never publishes a profile.
async function probeDisposableLocalStorage({
  electron, profilePath, timeoutMs = 15000, runtimeVersions = process.versions,
}) {
  requireCondition(runtimeVersions.electron === "43.4.1" &&
    runtimeVersions.chrome === "150.0.7871.224",
  "ERR_PROBE_RUNTIME", "The storage probe requires its reviewed Electron/Chromium pin");
  const { app, BrowserWindow, session } = electron;
  requireCondition(app.isReady() && BrowserWindow.getAllWindows().length === 0 &&
    !startedApps.has(app), "ERR_PROBE_NOT_FRESH",
  "The probe requires a fresh ready migration-only process");
  verifySupportedLocalStorage(profilePath);
  startedApps.add(app);
  const controller = new AbortController();
  const createdSessions = [];
  const onSession = created => {
    createdSessions.push(created);
    if (createdSessions.length > 1) {
      controller.abort(failure("ERR_PROBE_NOT_FRESH", "An extra probe session was created"));
    }
  };
  app.on("session-created", onSession);
  let probeWindow;
  let result;
  let primaryError;
  try {
    const probeSession = session.fromPath(profilePath, { cache: false });
    requireCondition(createdSessions.length === 1 && createdSessions[0] === probeSession &&
      probeSession.getStoragePath() === profilePath,
    "ERR_PROBE_NOT_FRESH", "The disposable session was reused or has a different storage path");
    const preloads = probeSession.getPreloadScripts();
    requireCondition(Array.isArray(preloads) && preloads.length === 0 &&
      probeSession.getPreloads().length === 0,
    "ERR_PROBE_TARGET", "The probe session has preload scripts");
    probeWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        session: probeSession, javascript: false, nodeIntegration: false,
        contextIsolation: true, sandbox: true,
      },
    });
    probeWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    result = await observeLocalStorageRead({
      probeWindow, expectedStoragePath: profilePath, timeoutMs, signal: controller.signal,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (probeWindow && !probeWindow.isDestroyed()) {
      try {
        probeWindow.destroy();
      } catch (error) {
        primaryError = primaryError
          ? new AggregateError([primaryError, error], "Probe and window cleanup failed")
          : error;
      }
    }
    app.removeListener("session-created", onSession);
  }
  if (primaryError) throw primaryError;
  if (controller.signal.aborted) throw controller.signal.reason;
  return result;
}

module.exports = {
  observeLocalStorageRead,
  probeDisposableLocalStorage,
  validateInitialLocalStorageHistograms,
  validateLocalStorageHistograms,
  validatePersistedSettings,
  verifyLevelDbPreconditions,
  verifySupportedLocalStorage,
};
