"use strict";

// Only this fixture creates storage. The production probe keeps its original
// read-only clone contract, runtime pins, admission checks and private pipes.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const probeHtml = path.join(__dirname, "..", "..", "src", "profile-migration-probe.html");
let electron;
let reportPath;
let report = {};

function save() {
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function fatal(error) {
  report.failure = { code: error.code, message: error.message, stack: error.stack };
  save();
  fs.writeSync(2, `${error.stack || error.message}\n`);
  if (electron?.app) electron.app.exit(1);
  else process.exit(1);
}

process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

try {
  electron = require("electron");
  const { app, BrowserWindow, session } = electron;
  const entryIndex = process.argv.findIndex(value => value === __filename);
  assert.ok(entryIndex >= 1, "The fixture entry must be present in Electron argv");
  const [role, root, profilePath, settingsPath, output] = process.argv.slice(entryIndex + 1);
  function owned(file) {
    assert.ok(path.isAbsolute(file));
    const relative = path.relative(root, file);
    assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative), `Fixture path is not owned: ${file}`);
    return file;
  }
  assert.ok(path.isAbsolute(root));
  assert.ok(path.basename(root).startsWith("markaloo-electron-profile-"));
  reportPath = owned(output);
  assert.equal(app.isReady(), false);
  const userData = owned(app.commandLine.getSwitchValue("user-data-dir"));
  const sessionData = owned(path.join(path.dirname(userData), "session-data"));
  for (const directory of [userData, sessionData, path.join(root, "env-appdata"),
    path.join(root, "crashes"), path.join(root, "logs")]) {
    fs.mkdirSync(owned(directory), { recursive: true });
  }
  app.setPath("appData", path.join(root, "env-appdata"));
  app.setPath("userData", userData);
  app.setPath("sessionData", sessionData);
  app.setPath("crashDumps", path.join(root, "crashes"));
  app.setAppLogsPath(path.join(root, "logs"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.on("window-all-closed", () => {});
  report = {
    role, pid: process.pid, execPath: process.execPath, versions: process.versions,
    argv: process.argv,
    readyOnEntry: app.isReady(), initialUserData: app.getPath("userData"),
    initialSessionData: app.getPath("sessionData"), appData: app.getPath("appData"),
  };
  const trace = (event, details = {}) => {
    report.events ??= [];
    report.events.push({
      order: report.events.length + 1, event, ready: app.isReady(), ...details,
    });
  };
  trace("fixture.pre-ready-bound");
  save();
  const realExit = app.exit.bind(app);
  app.exit = code => {
    report.requestedExit = code;
    report.actualExit = role === "probe-exit-failure" && code === 0 ? 7 : code;
    report.finalUserData = app.getPath("userData");
    report.finalSessionData = app.getPath("sessionData");
    report.visibleWindows = BrowserWindow.getAllWindows().filter(win => win.isVisible()).length;
    trace("app.exit", { requestedCode: code, actualCode: report.actualExit });
    save();
    realExit(report.actualExit);
  };
  const watchdog = setTimeout(() => {
    const error = new Error("Owned Electron fixture watchdog expired");
    error.code = "ERR_FIXTURE_TIMEOUT";
    fatal(error);
  }, 20000);
  app.once("will-quit", () => clearTimeout(watchdog));

  async function readFixtureStorage(storageSession, seed) {
    const expected = JSON.parse(fs.readFileSync(owned(settingsPath), "utf8"));
    const storagePath = owned(storageSession.getStoragePath());
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: storageSession, javascript: false, nodeIntegration: false,
        contextIsolation: true, sandbox: true,
      },
    });
    trace("storage.window-created", { storagePath, visible: win.isVisible() });
    assert.equal(win.isVisible(), false);
    const contents = win.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const debuggerApi = contents.debugger;
    try {
      debuggerApi.attach("1.3");
      trace("storage.loadFile");
      await win.loadFile(probeHtml);
      const frames = await debuggerApi.sendCommand("Page.getFrameTree");
      assert.equal(frames.frameTree.frame.url, pathToFileURL(probeHtml).href);
      assert.equal(frames.frameTree.frame.securityOrigin, "file://");
      const key = await debuggerApi.sendCommand("Storage.getStorageKey", {
        frameId: frames.frameTree.frame.id,
      });
      assert.equal(key.storageKey, "file:///");
      const storageId = { storageKey: key.storageKey, isLocalStorage: true };
      if (seed) {
        for (const [name, value] of expected) {
          await debuggerApi.sendCommand("DOMStorage.setDOMStorageItem", {
            storageId, key: name, value,
          });
        }
      }
      trace("storage.map-read-started", { storagePath, storageKey: key.storageKey });
      const actual = await debuggerApi.sendCommand("DOMStorage.getDOMStorageItems", { storageId });
      trace("storage.map-read-completed", { entries: actual.entries.length });
      const sort = entries => [...entries].sort(([left], [right]) => left.localeCompare(right));
      assert.deepEqual(sort(actual.entries), sort(expected));
      trace("storage.settings-matched");
      return {
        storagePath, storageKey: key.storageKey, settings: actual.entries,
        documentURL: frames.frameTree.frame.url,
        securityOrigin: frames.frameTree.frame.securityOrigin,
      };
    } finally {
      try {
        if (debuggerApi.isAttached()) debuggerApi.detach();
      } finally {
        if (!win.isDestroyed()) win.destroy();
        trace("storage.window-destroyed", { destroyed: win.isDestroyed() });
        save();
      }
    }
  }

  if (["probe", "probe-stale-origin", "probe-exit-failure"].includes(role)) {
    assert.equal(profilePath, "-");
    if (role === "probe-stale-origin") owned(settingsPath);
    else assert.equal(settingsPath, "-");
    app.once("ready", () => trace("app.ready"));
    app.once("browser-window-created", (_event, win) => {
      trace("BrowserWindow.created", { visible: win.isVisible() });
      const loadFile = win.loadFile.bind(win);
      win.loadFile = (...parameters) => {
        trace("BrowserWindow.loadFile", { parameters });
        return loadFile(...parameters);
      };
      const debuggerApi = win.webContents.debugger;
      const sendCommand = debuggerApi.sendCommand.bind(debuggerApi);
      let histogramCalls = 0;
      debuggerApi.sendCommand = (method, ...parameters) => {
        const forward = () => {
          trace("CDP.command", { method, parameters });
          const response = sendCommand(method, ...parameters);
          if (method !== "Browser.getHistograms") return response;
          return response.then(observed => {
            report.histogramResponses ??= [];
            report.histogramResponses.push({ parameters, response: observed });
            trace("CDP.histograms-result", { responseIndex: report.histogramResponses.length - 1 });
            save();
            return observed;
          });
        };
        if (method === "Browser.getHistograms" && ++histogramCalls === 1 &&
            role === "probe-stale-origin") {
          // Finish a real same-session read; do not alter the guarded target or telemetry.
          return readFixtureStorage(win.webContents.session, false).then(observed => {
            const probeUrl = win.webContents.getURL();
            assert.ok(["", "about:blank"].includes(probeUrl));
            assert.deepEqual(BrowserWindow.getAllWindows(), [win]);
            report.staleRead = { ...observed, probeUrlBeforeHistogram: probeUrl };
            trace("stale.read-finished-before-initial-histogram");
            save();
            return forward();
          });
        }
        return forward();
      };
    });
    const { prepareProfileValidationChild } = require("../../src/profile-migration-validation");
    const { probeDisposableLocalStorage } = require("../../src/profile-migration-probe");
    const prepared = prepareProfileValidationChild({
      electron,
      probe: async options => {
        report.probeProfile = owned(options.profilePath);
        try {
          return await probeDisposableLocalStorage(options);
        } catch (error) {
          trace("probe.error", { code: error.code });
          report.probeError = { code: error.code, message: error.message, stack: error.stack };
          save();
          throw error;
        }
      },
    });
    report.preparedBeforeReady = !app.isReady();
    report.preparedUserData = owned(app.getPath("userData"));
    report.preparedSessionData = owned(app.getPath("sessionData"));
    save();
    prepared.completion.catch(error => {
      report.completionError = { code: error.code, message: error.message };
      save();
    });
  } else {
    assert.ok(role === "seed" || role === "readback");
    owned(profilePath);
    owned(settingsPath);
    app.whenReady().then(async () => {
      assert.equal(process.versions.electron, "43.4.1");
      assert.equal(process.versions.chrome, "150.0.7871.224");
      const storageSession = session.fromPath(profilePath, { cache: false });
      assert.equal(storageSession.getStoragePath(), profilePath);
      Object.assign(report, await readFixtureStorage(storageSession, role === "seed"));
      if (role === "readback") {
        report.diskState = {};
        for (const name of ["window-state.json", "document-session.json",
          "document-session-import.json"]) {
          report.diskState[name] = JSON.parse(fs.readFileSync(path.join(profilePath, name), "utf8"));
        }
      }
      report.visibleWindows = BrowserWindow.getAllWindows().filter(window => window.isVisible()).length;
      storageSession.flushStorageData();
      save();
      app.quit();
    }).catch(fatal);
  }
} catch (error) {
  fatal(error);
}
