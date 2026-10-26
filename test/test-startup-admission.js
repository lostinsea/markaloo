"use strict";

const fs = require("fs");
let electron;
let exiting = false;
function fatal(error) {
  try {
    fs.writeSync(2, "FAIL  startup admission  -> " + String(error?.stack || error) + "\n");
  } finally {
    try { electron?.app?.exit(2); } finally { process.exit(2); }
  }
}
process.prependListener("uncaughtException", fatal);
process.prependListener("unhandledRejection", fatal);
// Isolation, startup, the wire journey and awaited teardown share this deadline.
const watchdog = setTimeout(() => fatal(new Error("Startup attempt exceeded 120s")), 120000);
const path = require("path");
const root = path.resolve(__dirname, "..");
const key = value => process.platform === "win32" ? value.toLowerCase() : value;
// Invalidate a safely owned legacy report before any other admission refusal.
// An unsafe path is never cleared; that refusal must remain a nonzero exit.
const mirror = reserveReport(path.join(__dirname, "test-startup-perf-results.txt"));
if (!process.versions.electron) fatal(new Error("Startup requires the real Electron entry"));
electron = require("electron");
const { app, BrowserWindow, dialog, shell, session } = electron;
if (!app || app.isReady()) fatal(new Error("Startup admission must precede app readiness"));

const guardedMethods = [];
function refuse(object, name) {
  const guard = () => fatal(new Error("Unexpected startup interaction: " + name));
  Object.defineProperty(object, name, { value: guard, writable: false, configurable: false });
  guardedMethods.push([object, name, guard]);
}
for (const name of ["showErrorBox", "showMessageBox", "showMessageBoxSync",
  "showOpenDialog", "showOpenDialogSync", "showSaveDialog", "showSaveDialogSync"]) {
  refuse(dialog, name);
}
for (const name of ["openExternal", "openPath", "showItemInFolder"]) refuse(shell, name);
const { OwnedDialogs } = require("../src/owned-dialogs");
refuse(OwnedDialogs.prototype, "show");

const os = require("os");
const { randomBytes } = require("crypto");
const { pathToFileURL } = require("url");
const { prepareOwnedRestartDirectory } = require("./test-restart-directory");
if (process.env.FOLIA_DIAGNOSTIC_LOG === "1" || process.env.PORTABLE_EXECUTABLE_DIR) {
  fatal(new Error("Startup does not admit raw diagnostics or a portable-install override"));
}
const token = randomBytes(32).toString("hex");
const container = path.join(root, "files", "startup-tests");
const runs = prepareOwnedRestartDirectory(root, "files", container, "runs");
const batch = path.join(runs, "run-" + token);
fs.mkdirSync(batch);
const temp = prepareOwnedRestartDirectory(root, "files", batch, "temp");
const profile = prepareOwnedRestartDirectory(root, "files", batch,
  path.join("temp", "folia-test-userdata", "test-startup-perf"));
const beforeIsolation = prepareOwnedRestartDirectory(root, "files", batch, "before-isolation");
const appData = prepareOwnedRestartDirectory(root, "files", batch, "app-data");
// Exercise the real legacy dev redirect safely if it regresses. The original
// path assertions must see that move, not a fabricated failure after refusal.
const devProfile = prepareOwnedRestartDirectory(root, "files", batch, path.join("app-data", "Folia-dev"));
const ownerPath = path.join(batch, ".startup-owner");
fs.writeFileSync(ownerPath, token, { flag: "wx" });
const ownerIdentity = fs.lstatSync(ownerPath);
const witness = path.join(profile, "pre-wipe-witness.txt");
fs.writeFileSync(witness, token, { flag: "wx" });
if (fs.readFileSync(witness, "utf8") !== token || fs.readdirSync(profile).length !== 1) {
  fatal(new Error("Startup pre-wipe witness was not established"));
}
const originalUserData = app.getPath("userData");
const originalAppData = app.getPath("appData");
const originalTmpdir = os.tmpdir;
let isolationAccepted = false;
const mainProfileRedirects = [];
const setPath = app.setPath;
const selectPath = (name, value) => {
  const allowed = name === "appData" ? [appData] :
    name === "userData" ? isolationAccepted ? [profile, devProfile] : [beforeIsolation, profile] :
      name === "sessionData" ? isolationAccepted ? [profile] : [beforeIsolation, profile] : null;
  if (allowed) {
    if (typeof value !== "string" || !path.isAbsolute(value) ||
        !allowed.some(owned => key(value) === key(owned))) {
      fatal(new Error("Startup refused a storage redirect outside its owned profiles"));
    }
    ownedDirectory(value);
    if (isolationAccepted && name === "userData") mainProfileRedirects.push(value);
  }
  return setPath.call(app, name, value);
};
Object.defineProperty(app, "setPath", { value: selectPath, writable: false, configurable: false });
guardedMethods.push([app, "setPath", selectPath]);
app.setPath("appData", appData);
app.setPath("userData", beforeIsolation);
app.setPath("sessionData", beforeIsolation);
os.tmpdir = () => temp;

function sameFile(left, right) {
  return left.isFile() && !left.isSymbolicLink() && left.nlink === 1 &&
    left.dev === right.dev && left.ino === right.ino;
}
function ownedDirectory(directory) {
  if (fs.lstatSync(root).isSymbolicLink() || key(fs.realpathSync.native(root)) !== key(root)) {
    throw new Error("Startup worktree root is redirected");
  }
  const relative = path.relative(root, directory);
  if (!relative || path.isAbsolute(relative) || relative === ".." ||
      relative.startsWith(".." + path.sep)) throw new Error("Startup directory escaped its worktree");
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const entry = fs.lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink() ||
        key(fs.realpathSync.native(current)) !== key(current)) {
      throw new Error("Startup directory was redirected: " + current);
    }
  }
}
function ownership() {
  ownedDirectory(batch);
  const current = fs.lstatSync(ownerPath);
  if (!sameFile(current, ownerIdentity) || current.size !== token.length ||
      fs.readFileSync(ownerPath, "utf8") !== token) {
    throw new Error("Startup batch owner changed");
  }
}
function reserveReport(file) {
  ownedDirectory(path.dirname(file));
  const previous = fs.lstatSync(file, { throwIfNoEntry: false });
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)) {
    throw new Error("Startup report is not an unshared regular file");
  }
  const fd = fs.openSync(file, previous ? "r+" : "wx+");
  const identity = fs.fstatSync(fd);
  const verify = () => {
    ownedDirectory(path.dirname(file));
    if (!sameFile(fs.lstatSync(file), identity) || !sameFile(fs.fstatSync(fd), identity)) {
      throw new Error("Startup report custody changed");
    }
  };
  verify();
  if (previous && !sameFile(previous, identity)) throw new Error("Startup report changed during open");
  fs.ftruncateSync(fd, 0);
  return { file, fd, verify };
}
// The unique report is authoritative. Keep the traditional mirror for the
// existing suite/proof reader, but retain and validate both open file identities.
const report = reserveReport(path.join(batch, "results.txt"));
fs.writeSync(1, "STARTUP_REPORT " + JSON.stringify({ token, batch, report: report.file }) + "\n");

let defaultSession = null;
const guardedSessions = new Set();
let feedOrigin = null;
let feedServer = null;
let preWipeWitnessRemoved = false;
let postWipeEntries = null;
app.on("session-created", target => {
  guardedSessions.add(target);
  target.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const url = new URL(details.url);
    if (["http:", "https:", "ws:", "wss:", "ftp:"].includes(url.protocol) &&
        !(feedOrigin && url.origin === feedOrigin && details.method === "GET" &&
          /^\/[^/]+\.yml$/.test(url.pathname))) {
      callback({ cancel: true });
      fatal(new Error("Startup refused a request outside its owned YAML feed"));
      return;
    }
    callback({});
  });
});
function storageBoundary() {
  ownership();
  ownedDirectory(profile);
  for (const [name, allowed] of [
    ["appData", [appData]], ["userData", [profile, devProfile]], ["sessionData", [profile]],
  ]) {
    const actual = app.getPath(name);
    if (!allowed.some(directory => key(actual) === key(directory))) {
      throw new Error("Startup " + name + " left its admitted directories");
    }
    ownedDirectory(actual);
  }
  if (defaultSession &&
      (key(defaultSession.getStoragePath() || "") !== key(profile) ||
        !guardedSessions.has(defaultSession))) {
    throw new Error("Startup Chromium storage does not match its owned profile");
  }
}
function acceptIsolation(isolation) {
  os.tmpdir = originalTmpdir;
  if (app.isReady() || key(isolation.USER_DATA_DIR || "") !== key(profile) ||
      key(isolation.REAL_USER_DATA || "") !== key(beforeIsolation) ||
      key(originalUserData) === key(profile)) {
    throw new Error("Startup isolation did not select its owned wipe target");
  }
  app.setPath("sessionData", profile);
  isolationAccepted = true;
  preWipeWitnessRemoved = !fs.existsSync(witness);
  postWipeEntries = isolation.POST_WIPE_ENTRIES;
  storageBoundary();
}

const indexURL = pathToFileURL(path.join(root, "src", "index.html")).href;
const marker = "STARTUP_UNEXPECTED_DIALOG:" + token;
const expectedDestroyed = new WeakSet();
let mainWindow = null;
let mainContents = null;
let keepalive = null;
let creatingKeepalive = false;
let tearingDown = false;
let page = null;
let shutdown = null;
let admittedOwner = null;
function guardsIntact() {
  if (!guardedMethods.every(([object, name, guard]) => object[name] === guard) ||
      !process.listeners("uncaughtException").includes(fatal) ||
      !process.listeners("unhandledRejection").includes(fatal)) {
    throw new Error("Startup lost an early refusal guard");
  }
  storageBoundary();
}
app.on("child-process-gone", (_event, details) => {
  if (!exiting && details.reason !== "clean-exit") fatal(new Error("Startup child process crashed"));
});
app.on("web-contents-created", (_event, contents) => {
  contents.on("render-process-gone", () => {
    if (!exiting && !expectedDestroyed.has(contents)) fatal(new Error("Startup renderer crashed"));
  });
  contents.on("destroyed", () => {
    if (!exiting && !expectedDestroyed.has(contents)) fatal(new Error("Startup contents disappeared"));
  });
  if (creatingKeepalive) return;
  if (mainContents || tearingDown) fatal(new Error("Unexpected startup web contents"));
  mainContents = contents;
  page = { epoch: 0, frame: null, acknowledged: false, loaded: false };
  const source = `(() => {
    if (window !== top || location.href !== ${JSON.stringify(indexURL)}) return;
    const refuse = () => {
      console.error(${JSON.stringify(marker)});
      throw new Error("Startup refused an unexpected renderer dialog");
    };
    const guards = [];
    for (const [object, names] of [[window, ["alert", "confirm", "prompt"]],
      [HTMLDialogElement.prototype, ["show", "showModal"]]]) {
      for (const name of names) {
        Object.defineProperty(object, name, { value: refuse, writable: false, configurable: false });
        guards.push([object, name]);
      }
    }
    const selectors = "dialog[open],#noteDialogOverlay.visible,#findNoteOverlay.visible," +
      "#editTextOverlay.visible,#mermaidTemplateOverlay.visible,#tableInsertOverlay.visible";
    const clear = () => !document.querySelector(selectors);
    const inspect = () => ({
      token: ${JSON.stringify(token)}, contentsId: ${contents.id}, url: location.href,
      topFrame: window === top, guarded: guards.every(([object, name]) => object[name] === refuse),
      clear: clear()
    });
    new MutationObserver(() => { if (!clear()) refuse(); }).observe(document, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["open", "class"]
    });
    Object.defineProperty(window, "__foliaStartupGuard", { value: Object.freeze({ inspect }) });
    if (!clear()) refuse();
  })()`;
  contents.on("console-message", details => {
    if (details.message === marker) fatal(new Error("Startup renderer refused a dialog"));
  });
  contents.on("did-start-navigation", details => {
    if (!details.isMainFrame || details.isSameDocument) return;
    if (page.loaded) fatal(new Error("Startup document navigated after admission"));
    page.epoch++;
    page.acknowledged = false;
  });
  contents.on("will-navigate", event => {
    event.preventDefault();
    fatal(new Error("Unexpected startup navigation"));
  });
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && !expectedDestroyed.has(contents)) {
      fatal(new Error("Startup document failed to load: " + code));
    }
  });
  contents.debugger.on("detach", () => {
    if (!exiting && !expectedDestroyed.has(contents)) fatal(new Error("Startup dialog guard detached"));
  });
  contents.debugger.on("message", (_event, method) => {
    if (method === "Page.javascriptDialogOpening") fatal(new Error("Unexpected startup JavaScript dialog"));
  });
  contents.debugger.attach("1.3");
  // Queue both commands before Main dispatches loadFile; awaiting their
  // renderer replies here would deadlock window construction.
  const commands = Promise.all([
    contents.debugger.sendCommand("Page.enable"),
    contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument",
      { source, runImmediately: true }),
  ]).then(([, installed]) => {
    if (typeof installed?.identifier !== "string" || !installed.identifier) {
      throw new Error("Startup dialog guard has no script acknowledgement");
    }
  });
  commands.catch(fatal);
  contents.on("dom-ready", () => {
    const epoch = page.epoch;
    const frame = contents.mainFrame;
    (async () => {
      await commands;
      if (contents.getURL() !== indexURL) throw new Error("Startup loaded an unexpected document");
      await inspectPage();
      if (page.epoch !== epoch || contents.mainFrame !== frame || frame.isDestroyed()) {
        throw new Error("Startup guard acknowledged a replaced document");
      }
      page.frame = frame;
      page.acknowledged = true;
      page.loaded = true;
    })().catch(fatal);
  });
});
app.on("browser-window-created", (_event, win) => {
  if (creatingKeepalive && tearingDown && !keepalive && !win.isVisible()) {
    keepalive = win;
    return;
  }
  if (mainWindow || win.webContents !== mainContents || tearingDown) {
    fatal(new Error("Unexpected startup window"));
  }
  mainWindow = win;
  const contents = win.webContents;
  win.on("unresponsive", () => fatal(new Error("Startup window became unresponsive")));
  win.on("closed", () => {
    if (!exiting && !expectedDestroyed.has(contents)) fatal(new Error("Startup window disappeared"));
  });
});
async function inspectPage() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainContents || mainContents.isDestroyed() ||
      mainWindow.webContents !== mainContents || mainContents.getURL() !== indexURL) {
    throw new Error("Startup no longer owns its Main document");
  }
  const frame = mainContents.mainFrame;
  const result = await mainContents.executeJavaScript("window.__foliaStartupGuard?.inspect()");
  if (!result || result.token !== token || result.contentsId !== mainContents.id ||
      result.url !== indexURL || result.topFrame !== true || result.guarded !== true ||
      result.clear !== true || mainContents.mainFrame !== frame || frame.isDestroyed()) {
    throw new Error("Startup actual-page dialog guard was not established");
  }
}
async function execute(code) {
  guardsIntact();
  const epoch = page?.epoch;
  const owner = shutdown.state();
  if (!page?.acknowledged || page.frame !== mainContents.mainFrame ||
      owner.renderer !== "ready" || !Number.isSafeInteger(owner.rendererGeneration) ||
      owner.rendererGeneration <= 0) throw new Error("Startup owner is not ready");
  await inspectPage();
  const generation = await mainContents.executeJavaScript("window.folia.getQuitApprovalGeneration()");
  const sameOwner = () => {
    const current = shutdown.state();
    if (!page.acknowledged || page.epoch !== epoch || page.frame !== mainContents.mainFrame ||
        current.renderer !== "ready" || current.rendererGeneration !== owner.rendererGeneration ||
        generation !== owner.rendererGeneration) throw new Error("Startup document owner changed");
  };
  sameOwner();
  const result = await mainContents.executeJavaScript(code);
  sameOwner();
  await inspectPage();
  return result;
}
async function ready(main) {
  shutdown = main;
  defaultSession = session.defaultSession;
  guardsIntact();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (mainWindow && page?.acknowledged && shutdown.state().renderer === "ready") {
      await execute("true");
      admittedOwner = {
        windowId: mainWindow.id, contentsId: mainContents.id, documentURL: indexURL,
        epoch: page.epoch, rendererGeneration: shutdown.state().rendererGeneration,
        actualPageGuardAcknowledged: true,
      };
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Startup actual Main/page/owner acknowledgement exceeded 10s");
}
function allowFeed(server) {
  const address = server.address();
  if (feedServer || !server.listening || !address || address.address !== "127.0.0.1" ||
      !Number.isSafeInteger(address.port) || address.port <= 0) {
    throw new Error("Startup feed is not the owned loopback listener");
  }
  feedServer = server;
  feedOrigin = "http://127.0.0.1:" + address.port;
  return feedOrigin + "/";
}
function closedFeed(server) {
  if (server !== feedServer || server.listening) throw new Error("Startup feed was not closed");
  feedOrigin = null;
  feedServer = null;
}
async function destroyWindows() {
  guardsIntact();
  if (feedServer) throw new Error("Startup feed must close before window teardown");
  tearingDown = true;
  creatingKeepalive = true;
  let retained;
  try {
    retained = new BrowserWindow({ show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  } finally {
    creatingKeepalive = false;
  }
  if (retained !== keepalive) throw new Error("Startup cleanup keepalive identity changed");
  const windows = BrowserWindow.getAllWindows().filter(win => win !== keepalive);
  if (windows.length > 1 || windows.some(win => win !== mainWindow)) {
    throw new Error("Startup teardown found an unowned window");
  }
  await Promise.all(windows.map(win => {
    const contents = win.webContents;
    expectedDestroyed.add(contents);
    const destroyed = contents.isDestroyed() ? Promise.resolve() :
      new Promise(resolve => contents.once("destroyed", resolve));
    const closed = new Promise(resolve => win.once("closed", resolve));
    win.destroy();
    return Promise.all([destroyed, closed]);
  }));
  await new Promise(resolve => setImmediate(resolve));
  if (keepalive.isDestroyed() || BrowserWindow.getAllWindows().some(win => win !== keepalive)) {
    throw new Error("Startup teardown did not leave only its keepalive");
  }
  guardsIntact();
}
function writeReport(text) {
  guardsIntact();
  for (const target of [report, mirror]) {
    target.verify();
    fs.writeFileSync(target.fd, text);
    fs.fsyncSync(target.fd);
    target.verify();
  }
  fs.writeFileSync(path.join(batch, "admission.json"), JSON.stringify({
    token, report: report.file, originalUserData, originalAppData, appData, profile,
    userData: app.getPath("userData"), sessionData: app.getPath("sessionData"),
    chromiumStorage: defaultSession?.getStoragePath(), preWipeWitnessEstablished: true,
    preWipeWitnessRemoved, postWipeEntries, admittedOwner, mainProfileRedirects,
    feedClosed: feedServer === null, mainDestroyed: !!mainContents?.isDestroyed(),
    remainingKeepaliveId: keepalive.id, guardsRetained: true,
  }, null, 2) + "\n", { flag: "wx" });
}
function exit(code) {
  guardsIntact();
  report.verify();
  mirror.verify();
  exiting = true;
  clearTimeout(watchdog);
  app.exit(code);
}

module.exports = {
  acceptIsolation, ready, execute, allowFeed, closedFeed, destroyWindows, writeReport, exit, fatal,
  originalUserData, profile, witness, mainProfileRedirects: () => [...mainProfileRedirects],
};
