// Regression harness for in-document search (PERF-02 and its correctness risk).
// Run with: npm run test:search
//
// docs/PERF-AUDIT.md measured highlightSearchTerm() at 316ms on a 2MB / 2001-heading
// document, paid on every keystroke, because it walks the entire rendered tree
// and replaces text nodes with fragments. The fix is a 150ms debounce plus two
// algorithmic repairs (normalize() once per parent instead of once per match,
// and O(1) instead of O(matches) current-match tracking).
//
// A debounce is a correctness hazard, not just a speed knob: if the user types
// and immediately presses Enter, or hits the next/prev buttons, or closes the
// panel, a naive implementation navigates the PREVIOUS term's matches or
// repopulates highlights into a closed panel. Most of the assertions below are
// about that, not about speed. The speed assertion is deliberately expressed as
// "one pass per burst", which is deterministic, rather than a millisecond
// threshold, which would be flaky on shared CI hardware.

// Electron turns an unhandled Main error into a native dialog. Arm the exit-only
// backstop and the startup-inclusive deadline before even importing isolation.
let app, BrowserWindow, fs, path, releaseTempDir, registeredTempDirs;
let dir = null;
let retainedFixture = false;
let ownedWindow = null;
let ownedContents = null;
let sentinel = null;
let terminal = false;
let tearingDown = false;
let terminalOwner = null;
let terminalFailed = false;
let reportWritten = false;
let secondaryCount = 0;
let stageCount = 0;
let snapshotCount = 0;
let main = null;
let indexURL = null;
let documentEpoch = 0;
let guardAck = null;
let loadRequested = false;
let documentLoaded = false;
const startedAt = Date.now();
const stages = {
  windowId: null, contentsId: null, enable: "not-issued", install: "not-issued",
  originalLoad: "not-dispatched", loadReturnObserved: false,
  guardEntered: 0, guardInstalled: 0, guardReused: 0,
};
const ownedWindows = new Set();
const results = [];
process.on("uncaughtException", fatalExit);
process.on("unhandledRejection", fatalExit);
const overallDeadline = setTimeout(() => {
  stageSnapshot("overall-deadline");
  return fatalExit(new Error("search harness exceeded its startup-inclusive 90s deadline"));
}, 90000);
process.once("exit", () => {
  const owner = terminalOwner || claimTerminal("exit");
  const destruction = cleanupOwner(owner);
  let released = false;
  try {
    released = releaseOwnedFixture(destruction);
  } catch (_) {
    terminalFailed = true;
  }
  if (!terminal || !destruction.destroyed || destruction.errors.length > 0 ||
      !released || terminalFailed || retainedFixture || results.some(result => !result.ok)) {
    process.exitCode = 1;
    try {
      fs?.writeSync(2, "search exit sweep: " + JSON.stringify(destruction) + "\n");
    } catch (_) { /* Exit diagnostics cannot become a modal exception. */ }
  }
});

const electron = require("electron");
app = electron.app;
BrowserWindow = electron.BrowserWindow;
const { dialog, session } = electron;
fs = require("fs");
path = require("path");
const { pathToFileURL } = require("url");
const { inspectVisual, captureScreenshot, startErrorSentinel, proveSentinelAlive,
  trapExternalOpens, waitForExternalTrap, tempDir, releaseTempDir: releaseFixture,
  REGISTERED_TEMP_DIRS } =
  require("./test-visual-utils");
releaseTempDir = releaseFixture;
registeredTempDirs = REGISTERED_TEMP_DIRS;

// The shared app.exit wrapper sweeps BEFORE process's exit hooks. Put owner
// destruction ahead of that wrapper too, not just ahead of the process sweep.
const exitWithSharedSweep = app.exit.bind(app);
Object.defineProperty(app, "exit", {
  value: function (code) {
    if (!terminal || !terminalOwner?.exiting) {
      return fatalExit(new Error("unexpected app.exit before the search terminal path"));
    }
    const destruction = terminalOwner.destruction;
    const failed = terminalFailed || !destruction?.destroyed || destruction.errors.length > 0 ||
      retainedFixture || results.some(result => !result.ok);
    return exitWithSharedSweep(failed ? 1 : code);
  },
  writable: false, configurable: false,
});

app.on("before-quit", event => {
  if (terminalOwner?.cleanupStarted && !terminalOwner.exiting) {
    // Destroying the last window can synchronously quit before verification.
    event.preventDefault();
    stage("implicit-quit-held-for-owned-cleanup");
  }
});

// Isolate this suite's userData profile before main.js exists and before the
// app is ready. See test-userdata-isolation.js.
require("./test-userdata-isolation");

const isolation = require("./test-userdata-isolation");
if (app.isReady()) fatalExit(new Error("private Chromium storage must be selected before ready"));
const privateStoragePath = fs.realpathSync.native(isolation.USER_DATA_DIR);
const storageKey = value => process.platform === "win32" ? value.toLowerCase() : value;
if (storageKey(privateStoragePath) !== storageKey(path.resolve(isolation.USER_DATA_DIR)) ||
    fs.lstatSync(privateStoragePath).isSymbolicLink() ||
    !fs.statSync(privateStoragePath).isDirectory() ||
    storageKey(privateStoragePath) === storageKey(path.resolve(isolation.REAL_USER_DATA))) {
  fatalExit(new Error("the private storage root is not the isolated physical directory"));
}
app.setPath("userData", privateStoragePath);
app.setPath("sessionData", privateStoragePath);
let storageReady = false;
assertPrivateStorage(false);
// Registered before Main's ready handlers: defaultSession is examined before
// any production BrowserWindow can bind Chromium storage to a different root.
app.once("ready", () => {
  storageReady = assertPrivateStorage(true) === true;
  check("canonical userData, sessionData and defaultSession storage agree before Main creation",
    storageReady, "private storage verification did not complete");
});
const { OwnedDialogs } = require("../src/owned-dialogs");
const { SUPPORTED_EXTENSIONS, isLargeDocument, LARGE_DOC_BUDGET_MS } =
  require("../src/file-helpers");
const indexPath = path.join(__dirname, "..", "src", "index.html");
indexURL = pathToFileURL(indexPath).href;
const guardKey = "__searchDialogGuard";
const guardToken = require("crypto").randomBytes(24).toString("hex");
const dialogFailure = "search-unexpected-dialog-" + guardToken;
const dialogStage = "SEARCH_DIALOG_GUARD_STAGE:";
let chooserAllowance = null;
let chooserCalls = 0;
const nativeGuards = new Map();
const expectedChooserOptions = {
  properties: ["openFile", "multiSelections"],
  filters: [
    { name: "Markdown Files", extensions: SUPPORTED_EXTENSIONS.markdown.map(ext => ext.slice(1)) },
    { name: "Mermaid Files", extensions: SUPPORTED_EXTENSIONS.mermaid.map(ext => ext.slice(1)) },
    { name: "All Files", extensions: ["*"] },
  ],
};

// There is no consent scenario in this suite. Never call an original dialog,
// including a native fallback on the failure path.
for (const method of ["showOpenDialog", "showOpenDialogSync", "showSaveDialog",
  "showSaveDialogSync", "showMessageBox", "showMessageBoxSync", "showErrorBox"]) {
  const guard = method === "showOpenDialog" ? function (...args) {
    chooserCalls++;
    assertOwner();
    if (!chooserAllowance || chooserAllowance.window !== ownedWindow ||
        chooserAllowance.epoch !== documentEpoch || args.length !== 2 ||
        args[0] !== ownedWindow ||
        JSON.stringify(args[1]) !== JSON.stringify(expectedChooserOptions)) {
      return fatalExit(new Error("unexpected native Open chooser or changed exact chooser contract"));
    }
    chooserAllowance = null; // Consume before any result can start admission.
    return Promise.resolve({ canceled: false, filePaths: [file] });
  } : function () {
    return fatalExit(new Error("unexpected native dialog: " + method));
  };
  Object.defineProperty(dialog, method, { value: guard, writable: false, configurable: false });
  nativeGuards.set(method, guard);
}
const ownedDialogGuard = function () {
  return fatalExit(new Error("unexpected Main-owned dialog"));
};
Object.defineProperty(OwnedDialogs.prototype, "show", {
  value: ownedDialogGuard, writable: false, configurable: false,
});

// The shared trap owns both actual Main shell functions, also through sentinel
// teardown. Native dialog ownership is not a reason to opt out of this trap.
trapExternalOpens().then(ready => {
  if (ready !== true) return fatalExit(new Error("Main external-open trap did not become ready"));
}, fatalExit);

if (BrowserWindow.getAllWindows().length !== 0) {
  fatalExit(new Error("search must start without any seed BrowserWindow"));
}
app.on("browser-window-created", (_event, win) => {
  ownedWindows.add(win);
  if (!storageReady) return fatalExit(new Error("production window preceded private session storage verification"));
  assertPrivateStorage(true);
  if (ownedWindow) return fatalExit(new Error("additional or replacement BrowserWindow"));
  ownedWindow = win;
  ownedContents = win.webContents;
  const wc = ownedContents;
  stages.windowId = win.id;
  stages.contentsId = wc.id;
  stage("window-created");
  sentinel = startErrorSentinel(win, { label: "search", drainTimeoutMs: 1500 });
  win.on("closed", () => {
    if (!tearingDown) return fatalExit(new Error("the owned Main window closed during search"));
  });
  wc.on("render-process-gone", (_event, details) => {
    if (!tearingDown) return fatalExit(new Error("owned Main renderer exited: " + details.reason));
  });
  wc.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
    if (!isMainFrame || inPlace) return;
    guardAck = null;
    documentLoaded = false;
    documentEpoch++;
    stage("main-navigation-started", { epoch: documentEpoch, currentURL: safeStageURL(url) });
    if (documentEpoch !== 1) return fatalExit(new Error("unexpected new Main document epoch"));
  });
  wc.on("did-navigate", (_event, url) => {
    stage("main-navigation-committed", { currentURL: safeStageURL(url) });
    if (url !== indexURL) return fatalExit(new Error("owned Main navigated away from its exact index URL"));
  });
  wc.on("dom-ready", () => stage("main-dom-ready"));
  wc.on("did-finish-load", () => {
    documentLoaded = true;
    stage("main-load-finished", { currentURL: safeStageURL(wc.getURL()) });
  });
  wc.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (!isMainFrame) return;
    stage("main-load-failed", { code, currentURL: safeStageURL(url) });
    return fatalExit(new Error("owned Main document failed to load: " + code));
  });
  wc.on("console-message", details => {
    if (details?.message?.startsWith(dialogFailure)) {
      return fatalExit(new Error(details.message));
    }
    if (details?.message?.startsWith(dialogStage)) {
      try {
        const metadata = JSON.parse(details.message.slice(dialogStage.length));
        if (metadata.contentsId !== stages.contentsId ||
            !["entered", "installed", "reused"].includes(metadata.phase)) {
          return fatalExit(new Error("unexpected HTML-dialog guard stage identity"));
        }
        const counter = { entered: "guardEntered", installed: "guardInstalled", reused: "guardReused" };
        stages[counter[metadata.phase]]++;
        stage("guard-" + metadata.phase, {
          topFrame: metadata.topFrame === true, exactIndex: metadata.exactIndex === true,
          initialContext: metadata.initialContext === true,
          readyState: ["loading", "interactive", "complete"].includes(metadata.readyState)
            ? metadata.readyState : "<unexpected>",
        });
      } catch (error) {
        return fatalExit(new Error("HTML-dialog guard stage could not be read: " + error.name));
      }
    }
  });

  // Issue both browser-side commands before navigation, without waiting for
  // renderer ACKs that may themselves require that navigation. Admission still
  // requires both ACKs AND the actual exact-index document's locked guard.
  stage("debugger-attach-issued");
  wc.debugger.attach("1.3");
  stage("debugger-attached", { attached: wc.debugger.isAttached() });
  wc.debugger.on("detach", () => {
    if (!tearingDown) return fatalExit(new Error("the HTML-dialog guard lost its debugger owner"));
  });
  const source = `(() => {
    const report = phase => console.info(${JSON.stringify(dialogStage)} + JSON.stringify({
      phase, contentsId: ${wc.id}, topFrame: window === window.top,
      exactIndex: location.href === ${JSON.stringify(indexURL)},
      initialContext: location.href === 'about:blank', readyState: document.readyState
    }));
    const fail = why => {
      console.error(${JSON.stringify(dialogFailure)} + ': ' + why);
      throw new Error('unexpected embedded HTML dialog: ' + why);
    };
    try {
    report('entered');
    if (window !== window.top) return;
    const prototype = HTMLDialogElement.prototype;
    const locked = (object, key, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return !!descriptor && descriptor.value === value &&
        descriptor.writable === false && descriptor.configurable === false;
    };
    const existing = Object.getOwnPropertyDescriptor(window, ${JSON.stringify(guardKey)});
    if (existing) {
      const read = existing.value;
      const state = typeof read === 'function' ? read() : null;
      if (!locked(window, ${JSON.stringify(guardKey)}, read) ||
          state?.token !== ${JSON.stringify(guardToken)} || state.url !== location.href ||
          state.intact !== true ||
          prototype.showModal.searchGuardToken !== ${JSON.stringify(guardToken)} ||
          prototype.show.searchGuardToken !== ${JSON.stringify(guardToken)} ||
          !locked(prototype, 'showModal', prototype.showModal) ||
          !locked(prototype, 'show', prototype.show)) {
        fail('conflicting or replaced guard');
      }
      report('reused');
      return;
    }
    if (typeof prototype.showModal !== 'function' || typeof prototype.show !== 'function') {
      fail('HTML dialog API unavailable');
    }
    const modal = function () { fail('showModal #' + this.id); };
    const nonmodal = function () { fail('show #' + this.id); };
    Object.defineProperty(modal, 'searchGuardToken', { value: ${JSON.stringify(guardToken)} });
    Object.defineProperty(nonmodal, 'searchGuardToken', { value: ${JSON.stringify(guardToken)} });
    Object.defineProperty(prototype, 'showModal', {
      value: modal, writable: false, configurable: false
    });
    Object.defineProperty(prototype, 'show', {
      value: nonmodal, writable: false, configurable: false
    });
    const read = () => ({
      token: ${JSON.stringify(guardToken)}, url: location.href,
      intact: locked(prototype, 'showModal', modal) && locked(prototype, 'show', nonmodal) &&
        locked(window, ${JSON.stringify(guardKey)}, read) &&
        Object.getPrototypeOf(document.createElement('dialog')) === prototype,
      open: [...document.querySelectorAll('dialog[open]')].map(node => node.id)
    });
    Object.defineProperty(window, ${JSON.stringify(guardKey)}, {
      value: read, writable: false, configurable: false
    });
    report('installed');
    } catch (error) {
      console.error(${JSON.stringify(dialogFailure)} + ': installation ' + error.name);
      throw error;
    }
  })()`;
  stages.enable = "issued";
  stage("cdp-enable-issued");
  try {
    observeStagePromise(wc.debugger.sendCommand("Page.enable"), "enable", "cdp-enable");
  } catch (error) {
    stages.enable = "rejected";
    stage("cdp-enable-rejected", { synchronous: true });
    return fatalExit(error);
  }
  stages.install = "issued";
  stage("cdp-install-issued");
  try {
    observeStagePromise(wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument",
      { source, runImmediately: true }), "install", "cdp-install");
  } catch (error) {
    stages.install = "rejected";
    stage("cdp-install-rejected", { synchronous: true });
    return fatalExit(error);
  }
  const originalLoadFile = win.loadFile;
  Object.defineProperty(win, "loadFile", {
    value: function (...args) {
      if (this !== ownedWindow || loadRequested ||
          args.length !== 1 || args[0] !== indexPath) {
        return fatalExit(new Error("unexpected Main loadFile request"));
      }
      loadRequested = true;
      stage("main-load-intercepted");
      stages.originalLoad = "dispatched";
      stage("main-original-load-dispatched");
      try {
        const loading = originalLoadFile.apply(win, args);
        // Return the SAME immediately observed promise: Main ignores it, so
        // creating an unobserved wrapper would reopen teardown rejections.
        observeStagePromise(loading, "originalLoad", "main-original-load");
        stages.loadReturnObserved = true;
        stage("main-load-return-observed");
        return loading;
      } catch (error) {
        stages.originalLoad = "rejected";
        stage("main-original-load-rejected", { synchronous: true });
        return fatalExit(error);
      }
    },
    writable: false, configurable: false,
  });
});

dir = tempDir("mdv-search-");
// Neither shared sweep may delete a fixture while owner destruction is pending.
registeredTempDirs.delete(dir);
const fixtureProtected = !registeredTempDirs.has(dir);
check("the watched fixture is protected from both shared exit sweeps",
  fixtureProtected, dir);
if (!fixtureProtected) throw new Error("the watched fixture remains exposed to shared exit sweeps");
const file = path.join(dir, "searchable.md");
const js = JSON.stringify(file);

// Large enough that a per-keystroke full walk is measurably worse than one
// pass, and with a term ("needle") that appears many times across many parents
// so the normalize()-per-parent and current-match assertions have something to
// bite on. "haystack" appears exactly once, for the unique-match cases.
function buildDoc() {
  const parts = ["# Searchable\n"];
  for (let i = 0; i < 300; i++) {
    parts.push(`## Section ${i}\n`);
    parts.push(`This paragraph mentions needle and needle again in one node.\n`);
    parts.push(`Another paragraph with a single needle here.\n`);
  }
  parts.push("\nThe unique word haystack appears exactly once.\n");
  return parts.join("\n");
}
const DOC = buildDoc();

function check(name, ok, detail) {
  if (reportWritten) return secondary("late check: " + name);
  if (!ok) terminalFailed = true;
  results.push({ name, ok, detail: ok ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

function writeReport(summary) {
  const lines = results.map(
    (r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  -> " + r.detail}`,
  );
  lines.push(summary);
  fs.writeFileSync(path.join(__dirname, "test-search-results.txt"), lines.join("\n") + "\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function secondary(detail) {
  if (secondaryCount++ >= 8) return;
  try {
    fs?.writeSync(2, "SECONDARY search " +
      String(detail?.message || detail).replace(/[\r\n]+/g, " ").slice(0, 240) + "\n");
  } catch (_) { /* Secondary evidence cannot reopen terminal reporting. */ }
}

function stage(name, detail = {}, reserved = false) {
  if (!reserved && stageCount++ >= 80) return;
  try {
    fs?.writeSync(2, "SEARCH_STAGE " + JSON.stringify({
      stage: name, elapsedMs: Date.now() - startedAt,
      windowId: stages.windowId, contentsId: stages.contentsId, ...detail,
    }) + "\n");
  } catch (_) { /* Metadata must not depend on a working diagnostic pipe. */ }
}

function safeStageURL(value) {
  return value === indexURL || value === "about:blank" || value === "" ? value : "<unexpected-url>";
}

function stageSnapshot(name) {
  if (snapshotCount++ >= 4) return;
  const read = action => {
    try { return action(); } catch (_) { return "<unavailable>"; }
  };
  const state = read(() => main?.__shutdown?.state());
  stage(name, {
    commands: { enable: stages.enable, install: stages.install },
    originalLoad: stages.originalLoad, loadReturnObserved: stages.loadReturnObserved,
    loadRequested, documentLoaded, epoch: documentEpoch,
    debuggerAttached: read(() => ownedContents?.debugger.isAttached() ?? false),
    currentURL: read(() => safeStageURL(ownedContents?.getURL() ?? "")),
    loading: read(() => ownedContents?.isLoading() ?? false),
    visible: read(() => ownedWindow?.isVisible() ?? false),
    renderer: typeof state?.renderer === "string" ? state.renderer : null,
    rendererGeneration: Number.isSafeInteger(state?.rendererGeneration) ? state.rendererGeneration : null,
    pageSessionPresent: typeof state?.rendererPageSession === "string",
    pageSessionLength: typeof state?.rendererPageSession === "string" ? state.rendererPageSession.length : 0,
    guardEntered: stages.guardEntered, guardInstalled: stages.guardInstalled, guardReused: stages.guardReused,
  }, true);
}

function observeStagePromise(promise, key, label) {
  const observer = promise.then(() => {
    stages[key] = "resolved";
    stage(label + "-resolved");
  }, error => {
    stages[key] = "rejected";
    const targetClosed = /(?:target|session).*(?:closed|destroyed)/i.test(String(error?.message || error));
    stage(label + "-rejected", { targetClosed });
    const failure = new Error(label + " rejected");
    failure.targetClosed = targetClosed;
    return fatalExit(failure);
  });
  observer.catch(error => {
    try { return fatalExit(error); } catch (_) { return secondary(label + " observer failed"); }
  });
  return promise;
}

function claimTerminal(kind) {
  if (terminalOwner) {
    secondary("terminal path already owned; refused " + kind);
    return null;
  }
  let abort;
  const aborted = new Promise(resolve => { abort = resolve; });
  terminalOwner = { kind, aborted, abort, emergency: null, cleanupStarted: false,
    destruction: null, exiting: false };
  return terminalOwner;
}

function cleanupOwner(owner) {
  if (owner.destruction) return owner.destruction;
  if (owner.cleanupStarted) {
    terminalFailed = true;
    if (dir) {
      retainedFixture = true;
      registeredTempDirs?.delete(dir);
    }
    owner.destruction = { destroyed: false, errors: ["owner cleanup reentered"],
      retainedFixture: dir };
    return owner.destruction;
  }
  owner.cleanupStarted = true;
  const destruction = destroyOwnedWindows();
  // A synchronous reentry failure must survive the outer destruction return.
  owner.destruction ||= destruction;
  return owner.destruction;
}

function reportOwner(owner) {
  if (owner !== terminalOwner || reportWritten) return secondary("duplicate terminal report refused");
  let summary = `=== ${results.filter(r => r.ok).length}/${results.length} passed ===`;
  try {
    if (fs && path) writeReport(summary);
  } catch (error) {
    try { check("the terminal result report was persisted", false, error.message); }
    catch (_) { terminalFailed = true; }
    summary = `=== ${results.filter(r => r.ok).length}/${results.length} passed ===`;
    try { writeReport(summary); } catch (_) { secondary("terminal report persistence failed"); }
  }
  reportWritten = true;
  try { console.log(summary); } catch (_) { terminalFailed = true; }
}

function exitOwner(owner, code) {
  if (owner !== terminalOwner || owner.exiting) return secondary("duplicate terminal exit refused");
  terminal = true;
  owner.exiting = true;
  clearTimeout(overallDeadline);
  try {
    if (app) {
      app.exit(terminalFailed ? 1 : code);
      return;
    }
  } catch (_) { secondary("owned app.exit failed"); }
  process.exit(1);
  return;
}

function destroyOwnedWindows() {
  tearingDown = true;
  const errors = [];
  let destroyed = true;
  for (const win of ownedWindows) {
    try {
      if (!win.isDestroyed()) win.destroy(); // Never enter interactive close approval.
    } catch (error) {
      errors.push("destroy: " + String(error?.message || error));
    }
    try {
      if (!win.isDestroyed()) destroyed = false;
    } catch (error) {
      destroyed = false;
      errors.push("destruction verification: " + String(error?.message || error));
    }
  }
  try {
    if (BrowserWindow && BrowserWindow.getAllWindows().length !== 0) destroyed = false;
  } catch (error) {
    destroyed = false;
    errors.push("remaining-window verification: " + String(error?.message || error));
  }
  if (!destroyed && dir) {
    // An unconfirmed owner must not lose its watched file to EITHER shared
    // sweep. Retaining this one fixture is a reported failure, never a claim
    // of successful cleanup; a later process/maintainer must remove it.
    retainedFixture = true;
    registeredTempDirs?.delete(dir);
  }
  return { destroyed, errors, retainedFixture: retainedFixture ? dir : null };
}

function releaseOwnedFixture(destruction) {
  if (!dir) return true;
  if (!destruction.destroyed || retainedFixture) return false;
  registeredTempDirs.add(dir); // Safe sweep retries only after verified destruction.
  if (releaseTempDir(dir) !== true) return false;
  dir = null;
  return true;
}

function fatalExit(error) {
  if (terminalOwner) {
    if (!reportWritten && !terminalOwner.exiting && (!tearingDown || error?.targetClosed !== true)) {
      terminalFailed = true;
      terminalOwner.emergency ||= error instanceof Error ? error : new Error(String(error));
      terminalOwner.abort(terminalOwner.emergency);
    }
    return secondary(error);
  }
  const owner = claimTerminal("fatal");
  terminalFailed = true;
  stageSnapshot("terminal-veto");
  const detail = String(error?.stack || error);
  // Vetoes may have no trusted renderer or remaining time budget. Recoverable
  // failures capture in finish(); never wait for renderer evidence here.
  const destruction = cleanupOwner(owner);
  let released = false;
  try {
    released = releaseOwnedFixture(destruction);
  } catch (_) { /* The failure below stays nonzero; safe shared sweeps may retry. */ }
  try {
    check("harness ran to completion", false, detail);
    check("fatal cleanup verified owner destruction",
      destruction.destroyed && destruction.errors.length === 0, JSON.stringify(destruction));
    check("fatal cleanup confirmed fixture release after owner destruction",
      released, retainedFixture ? "retained unsafe fixture: " + dir : dir);
  } catch (_) { /* Reporting must never postpone the nonzero exit. */ }
  try {
    if (fs) fs.writeSync(2, detail + "\n");
  } catch (_) { /* A closed pipe cannot become a modal exception. */ }
  reportOwner(owner);
  return exitOwner(owner, 1);
}

function assertPrivateStorage(includeSession) {
  for (const name of ["userData", "sessionData"]) {
    const actual = app.getPath(name);
    if (storageKey(path.resolve(actual)) !== storageKey(privateStoragePath) ||
        storageKey(fs.realpathSync.native(actual)) !== storageKey(privateStoragePath)) {
      const error = new Error(name + " does not resolve to the canonical private storage root");
      fatalExit(error);
      throw error;
    }
  }
  if (includeSession) {
    const actual = session.defaultSession.getStoragePath();
    if (typeof actual !== "string" ||
        storageKey(path.resolve(actual)) !== storageKey(privateStoragePath) ||
        storageKey(fs.realpathSync.native(actual)) !== storageKey(privateStoragePath)) {
      const error = new Error("defaultSession is not physically backed by the private storage root");
      fatalExit(error);
      throw error;
    }
  }
  return true;
}

async function bounded(promise, label, milliseconds = 5000) {
  let timer;
  try {
    const waiting = [promise, new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(label + " exceeded its finite budget");
        error.isTimeout = true;
        reject(error);
      }, milliseconds);
    })];
    if (terminalOwner?.kind === "finish" && !tearingDown) {
      waiting.push(terminalOwner.aborted.then(error => { throw error; }));
    }
    return await Promise.race(waiting);
  } finally {
    clearTimeout(timer);
  }
}

function assertOwner() {
  if (terminalOwner?.emergency) throw terminalOwner.emergency;
  assertPrivateStorage(true);
  const all = BrowserWindow.getAllWindows();
  const state = main?.__shutdown?.state();
  if (terminal || !ownedWindow || ownedWindow.isDestroyed() ||
      ownedWindow.webContents !== ownedContents || ownedContents.isDestroyed() ||
      all.length !== 1 || all[0] !== ownedWindow ||
      ownedContents.getURL() !== indexURL || !guardAck ||
      guardAck.epoch !== documentEpoch || state?.renderer !== "ready" ||
      state.rendererGeneration !== guardAck.generation ||
      state.rendererPageSession !== guardAck.pageSession ||
      OwnedDialogs.prototype.show !== ownedDialogGuard ||
      [...nativeGuards].some(([name, guard]) => dialog[name] !== guard)) {
    const error = new Error("Main/window/renderer/guard ownership changed during search");
    fatalExit(error);
    throw error;
  }
}

const READ_GUARD = `(async () => ({
  guard: typeof window[${JSON.stringify(guardKey)}] === 'function'
    ? window[${JSON.stringify(guardKey)}]() : null,
  generation: typeof window.folia?.getQuitApprovalGeneration === 'function'
    ? await window.folia.getQuitApprovalGeneration() : null,
  pageSession: typeof window.getReloadRequestSession === 'function'
    ? window.getReloadRequestSession() : null
}))()`;

async function exec(code) {
  assertOwner();
  if (!(await waitForExternalTrap(ownedWindow, 1000))) {
    const error = new Error("Main external-open guards changed during search");
    fatalExit(error);
    throw error;
  }
  const state = await bounded(ownedContents.executeJavaScript(READ_GUARD, true), "guard acknowledgement");
  if (state.guard?.token !== guardToken || state.guard.url !== indexURL ||
      state.guard.intact !== true || state.guard.open.length !== 0 ||
      state.generation !== guardAck.generation || state.pageSession !== guardAck.pageSession) {
    const error = new Error("HTML-dialog guard or current production bridge lost its acknowledgement");
    fatalExit(error);
    throw error;
  }
  assertOwner();
  return bounded(ownedContents.executeJavaScript(code, true), "search renderer execution");
}

async function waitFor(exec, label, expression, timeoutMs = 30000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await exec(expression);
    if (last) return last;
    await sleep(100);
  }
  stageSnapshot("wait-deadline");
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${label} (last value: ${JSON.stringify(last)})`,
  );
}

// Type into the search box the way a user does: one input event per character,
// with no delay between them, so the debounce window covers the whole burst.
// Using dispatchEvent rather than calling the handler keeps the test honest
// about the wiring - if the listener were removed, this would stop working.
function typeScript(term) {
  return `
    (() => {
      const input = document.getElementById('searchInput');
      input.value = '';
      const chars = ${JSON.stringify(term)}.split('');
      for (let i = 0; i < chars.length; i++) {
        input.value += chars[i];
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return input.value;
    })()
  `;
}

function keyScript(key, shift) {
  return `
    (() => {
      const input = document.getElementById('searchInput');
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)},
        shiftKey: ${shift ? "true" : "false"},
        bubbles: true,
        cancelable: true,
      }));
      return true;
    })()
  `;
}

// Keep the pending-term witness and its user action in the same renderer task.
// A second executeJavaScript round trip would give the debounce a chance to win.
function pendingActionScript(term, action) {
  return `(() => {
    ${typeScript(term)};
    const before = {
      ...${COUNTS},
      pendingTerm: pendingSearchTerm,
      timerArmed: searchDebounceTimer !== null,
      currentIndex: currentMatchIndex
    };
    const pending = pendingSearchTerm === ${JSON.stringify(term)} &&
      searchDebounceTimer !== null;
    ${action};
    const after = ${COUNTS};
    const all = [...document.querySelectorAll('#viewer .search-highlight')];
    return {
      ...after, before, pending,
      pendingTerm: pendingSearchTerm,
      timerCleared: searchDebounceTimer === null,
      currentIndex: currentMatchIndex,
      domCurrentIndex: all.findIndex(match => match.classList.contains('current')),
      walkingPassDelta: after.walkingPasses - before.walkingPasses,
      input: document.getElementById('searchInput').value,
      panelVisible: document.getElementById('searchPanel').classList.contains('visible')
    };
  })()`;
}

function checkImmediateNavigation(name, state, matches, index) {
  check(name,
    state.pending === true && state.before.timerArmed === true &&
      state.before.pendingTerm === state.input && state.before.highlights === 0 &&
      state.before.current === 0 && state.before.currentIndex === -1 &&
      state.pendingTerm === null && state.timerCleared === true &&
      state.walkingPassDelta === 1 && state.highlights === matches &&
      state.current === 1 && state.currentIndex === index && state.domCurrentIndex === index,
    JSON.stringify(state));
}

const COUNTS = `
  (() => ({
    highlights: document.querySelectorAll('#viewer .search-highlight').length,
    current: document.querySelectorAll('#viewer .search-highlight.current').length,
    counter: (document.getElementById('searchCounter') || {}).textContent || '',
    passes: window.__searchProbe ? window.__searchProbe.passes : -1,
    // Only terms long enough to actually walk the document. The first
    // character of any burst is a 1-char term, which takes the immediate
    // "clear highlights" path by design - that is cheap and must not be
    // delayed, so counting it as a debounce failure would be wrong.
    walkingPasses: window.__searchProbe
      ? window.__searchProbe.terms.filter(t => t && t.length >= 2).length
      : -1,
  }))()
`;

async function run(win) {
  const startup = await exec(`(() => ({
    tabs: window.CustomTabs.getTabs().length,
    active: window.CustomTabs.getActiveTabId(),
    activeDocument: !!window.CustomTabs.getActiveTab(),
    descriptor: window.CustomTabs.getDocumentDescriptor(),
    dirty: window.CustomTabs.__dirtyTabNames(),
    unsaved: hasUnsavedWork(),
    path: currentFilePath,
    markdown: originalMarkdown,
    welcome: document.querySelectorAll('#viewer .welcome').length,
    sections: document.querySelectorAll('#viewer h2').length
  }))()`);
  const privateSession = main.__shutdown.documentSessionState();
  const cleanStartup = isolation.POST_WIPE_ENTRIES === 0 &&
    storageReady && storageKey(app.getPath("userData")) === storageKey(privateStoragePath) &&
    storageKey(app.getPath("sessionData")) === storageKey(privateStoragePath) &&
    isolation.USER_DATA_DIR !== isolation.REAL_USER_DATA &&
    startup.tabs === 0 && startup.active === null && !startup.activeDocument &&
    startup.descriptor === null && startup.dirty.length === 0 &&
    startup.unsaved === false && !startup.path && startup.markdown === "" &&
    startup.welcome === 1 && startup.sections === 0 && privateSession.admissions === 0 &&
    privateSession.entries.length === 0 && privateSession.history.length === 0 &&
    privateSession.owners.length === 0 && privateSession.activeEntryId === null;
  check("the private startup is actually empty and clean with no active document",
    cleanStartup, JSON.stringify({ startup, privateSession }));
  if (!cleanStartup) throw new Error("unexpected startup state; nothing was discarded");

  const cost = isLargeDocument(DOC);
  const cheap = cost.large === false && Number.isFinite(cost.estimatedMs) &&
    cost.estimatedMs >= 0 && cost.estimatedMs <= LARGE_DOC_BUDGET_MS;
  check("the unchanged fixture is cheap under the actual large-document contract",
    cheap, JSON.stringify({ ...cost, budgetMs: LARGE_DOC_BUDGET_MS }));
  if (!cheap) throw new Error("fixture needs a large-render decision; no approval is permitted");
  fs.writeFileSync(file, DOC, { encoding: "utf8", flag: "wx" });
  chooserAllowance = { window: win, epoch: documentEpoch };
  await exec(`document.getElementById('openFile').click(); true`);
  await waitFor(
    exec,
    "the exact chooser admission and its rendered document",
    `(() => {
      const tab = window.CustomTabs.getActiveTab();
      const descriptor = window.CustomTabs.getDocumentDescriptor();
      return window.CustomTabs.getTabs().length === 1 && tab?.filePath === ${js} &&
        tab.content === ${JSON.stringify(DOC)} &&
        tab.originalContent === ${JSON.stringify(DOC)} && !tab.hasUnsavedChanges &&
        currentFilePath === ${js} && originalMarkdown === ${JSON.stringify(DOC)} &&
        descriptor?.logicalPath === ${js} && /^[a-f0-9]{64}$/.test(descriptor.ref) &&
        document.querySelector('#viewer h1')?.textContent === 'Searchable' &&
        document.querySelectorAll('#viewer h2').length === 300 &&
        !document.getElementById('loadingScreen').classList.contains('active');
    })()`,
  );
  const admitted = await exec(`(() => ({
    descriptor: window.CustomTabs.getDocumentDescriptor(),
    identity: window.CustomTabs.getActiveDocumentIdentity(
      ${js}, window.getReloadRequestSession())
  }))()`);
  const realAdmission = chooserCalls === 1 && chooserAllowance === null &&
    admitted.identity?.documentRef === admitted.descriptor.ref &&
    admitted.identity.rendererGeneration === guardAck.generation &&
    admitted.identity.pageSession === guardAck.pageSession &&
    main.__shutdown.documentAdmissionIsCurrent(admitted.descriptor.ref);
  check("exactly one native chooser admitted the selected tab with a real descriptor",
    realAdmission, JSON.stringify({ chooserCalls, admitted }));
  if (!realAdmission) throw new Error("the selected fixture was not genuinely admitted");

  // Open the search panel through the real toggle so the panel state under
  // test is the one the app actually produces.
  await exec(`toggleSearchPanel(), true`);
  await waitFor(
    exec,
    "the search panel to open",
    `document.getElementById('searchPanel').classList.contains('visible')`,
  );

  // Count actual highlight passes. This is the measurement the debounce is for:
  // a millisecond threshold would be flaky, but "one pass per burst" is exact.
  const spyInstalled = await exec(`
    (() => {
      window.__searchProbe = { passes: 0, terms: [] };
      const original = window.highlightSearchTerm;
      if (typeof original !== 'function' || highlightSearchTerm !== original) return false;
      const wrapper = function (...args) {
        window.__searchProbe.passes++;
        window.__searchProbe.terms.push(args[0]);
        return original.apply(this, args);
      };
      window.highlightSearchTerm = wrapper;
      window.__searchProbeRestore = () => {
        const intact = window.highlightSearchTerm === wrapper && highlightSearchTerm === wrapper;
        window.highlightSearchTerm = original;
        return intact && highlightSearchTerm === original;
      };
      return window.highlightSearchTerm === wrapper && highlightSearchTerm === wrapper;
    })()
  `);
  check("the search probe genuinely wraps the production highlight function", spyInstalled === true, spyInstalled);
  if (!spyInstalled) throw new Error("search pass measurement has no live production spy");

  // --- 1. A burst of typing produces exactly one highlight pass ------------
  const during = await exec(`(() => {
    ${typeScript("needle")};
    return (${COUNTS});
  })()`);
  check(
    "typing does not highlight synchronously on every keystroke",
    during.passes <= 1,
    JSON.stringify(during),
  );

  await waitFor(exec, "the debounced document-walking pass to run",
    `window.__searchProbe.terms.some(term => term === 'needle' && term.length >= 2)`);
  await sleep(300); // let any further (unwanted) passes land before counting
  const after = await exec(COUNTS);
  check(
    "a six-character burst produces a single document-walking pass",
    after.walkingPasses === 1,
    JSON.stringify(after),
  );
  check(
    "the debounced pass highlights every match",
    after.highlights === 900,
    JSON.stringify(after),
  );
  check(
    "exactly one match is marked current",
    after.current === 1,
    JSON.stringify(after),
  );

  // --- 2. Navigation flushes a pending search -----------------------------
  // The dangerous case: type a NEW term and press Enter before the debounce
  // fires. Without a flush this navigates the old term's matches, so the user
  // is silently taken to the wrong place.
  await exec(`window.__searchProbe.passes = 0; window.__searchProbe.terms = []; true`);
  const afterEnter = await exec(pendingActionScript("haystack", keyScript("Enter", false)));
  check("Enter is exercised while the new term is genuinely pending",
    afterEnter.pending === true, JSON.stringify(afterEnter));
  checkImmediateNavigation("Enter immediately flushes and wraps the unique match exactly once",
    afterEnter, 1, 0);
  check(
    "Enter flushes a pending search instead of navigating stale matches",
    afterEnter.highlights === 1 && afterEnter.current === 1,
    JSON.stringify(afterEnter),
  );
  check(
    "the counter reflects the flushed term, not the previous one",
    /\b1\b/.test(afterEnter.counter) && !/900/.test(afterEnter.counter),
    JSON.stringify(afterEnter),
  );

  // The next/prev buttons need the same flush as Enter.
  const afterNextBtn = await exec(pendingActionScript("needle",
    `document.getElementById('searchNext').click()`));
  check("Next is exercised while the new term is genuinely pending",
    afterNextBtn.pending === true, JSON.stringify(afterNextBtn));
  checkImmediateNavigation("Next immediately flushes and advances the new multihit term exactly once",
    afterNextBtn, 900, 1);
  check(
    "the next button flushes a pending search",
    afterNextBtn.highlights === 900 && afterNextBtn.current === 1,
    JSON.stringify(afterNextBtn),
  );

  const afterPrevBtn = await exec(pendingActionScript("haystack",
    `document.getElementById('searchPrev').click()`));
  check("Previous is exercised while the new term is genuinely pending",
    afterPrevBtn.pending === true, JSON.stringify(afterPrevBtn));
  checkImmediateNavigation("Previous immediately flushes and wraps the unique match exactly once",
    afterPrevBtn, 1, 0);
  check(
    "the previous button flushes a pending search",
    afterPrevBtn.highlights === 1,
    JSON.stringify(afterPrevBtn),
  );

  // A unique match cannot distinguish a missing step from a double step.
  // Fresh pending multihit searches begin at zero only when actually flushed.
  for (const control of [
    { name: "Enter immediately advances a freshly flushed multihit term exactly once",
      action: keyScript("Enter", false), index: 1 },
    { name: "Previous immediately wraps a freshly flushed multihit term exactly once",
      action: `document.getElementById('searchPrev').click()`, index: 899 },
    { name: "Shift-Enter immediately wraps a freshly flushed multihit term exactly once",
      action: keyScript("Enter", true), index: 899 },
  ]) {
    const state = await exec(pendingActionScript("needle", control.action));
    checkImmediateNavigation(control.name, state, 900, control.index);
  }

  // The button checks above only pass because the buttons are still clickable while
  // a term is pending. Assert that directly so the reason is visible: the first
  // character of a burst is a 1-char term, which clears highlights to zero
  // matches, and a zero-match state used to disable both nav buttons - making
  // their flush-on-click handler unreachable for the whole debounce window.
  const pendingDisabled = await exec(`
    (() => {
      const i = document.getElementById('searchInput');
      i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
      const clearedState = document.getElementById('searchNext').disabled;
      i.value = 'needle'; i.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        clearedState,
        pendingTerm: pendingSearchTerm,
        timerArmed: searchDebounceTimer !== null,
        pendingState: document.getElementById('searchNext').disabled,
        prevPendingState: document.getElementById('searchPrev').disabled,
      };
    })()
  `);
  check(
    "nav buttons stay clickable while a debounced search is pending",
    pendingDisabled.clearedState === true &&
      pendingDisabled.pendingTerm === "needle" &&
      pendingDisabled.timerArmed === true &&
      pendingDisabled.pendingState === false &&
      pendingDisabled.prevPendingState === false,
    JSON.stringify(pendingDisabled),
  );
  await waitFor(exec, "the pending term to flush", `document.querySelectorAll('#viewer .search-highlight').length === 900`);

  // --- 3. Moving between matches is O(1), not O(matches) ------------------
  await exec(typeScript("needle"));
  await waitFor(exec, "matches to appear", `document.querySelectorAll('#viewer .search-highlight').length === 900`);

  const navProbe = await exec(`
    (() => {
      const before = [...document.querySelectorAll('#viewer .search-highlight')];
      const firstBefore = before.findIndex(el => el.classList.contains('current'));
      nextMatch();
      const after = [...document.querySelectorAll('#viewer .search-highlight')];
      const firstAfter = after.findIndex(el => el.classList.contains('current'));
      return {
        total: after.length,
        currentCount: after.filter(el => el.classList.contains('current')).length,
        firstBefore,
        firstAfter,
      };
    })()
  `);
  check(
    "next moves the current marker by exactly one match",
    navProbe.firstAfter === navProbe.firstBefore + 1,
    JSON.stringify(navProbe),
  );
  check(
    "only one match is ever marked current after navigating",
    navProbe.currentCount === 1,
    JSON.stringify(navProbe),
  );

  // Wrapping past the end must still leave exactly one current match - the
  // O(1) rewrite tracks the outgoing element by reference, so an off-by-one
  // here would strand a stale .current on the last match.
  const wrapProbe = await exec(`
    (() => {
      currentMatchIndex = searchMatches.length - 1;
      highlightCurrentMatch();
      nextMatch();
      const all = [...document.querySelectorAll('#viewer .search-highlight')];
      return {
        currentCount: all.filter(el => el.classList.contains('current')).length,
        currentIndex: all.findIndex(el => el.classList.contains('current')),
      };
    })()
  `);
  check(
    "wrapping from the last match back to the first leaves one current match",
    wrapProbe.currentCount === 1 && wrapProbe.currentIndex === 0,
    JSON.stringify(wrapProbe),
  );

  const prevWrapProbe = await exec(`
    (() => {
      previousMatch();
      const all = [...document.querySelectorAll('#viewer .search-highlight')];
      return {
        currentCount: all.filter(el => el.classList.contains('current')).length,
        currentIndex: all.findIndex(el => el.classList.contains('current')),
        total: all.length,
      };
    })()
  `);
  check(
    "wrapping backwards from the first match leaves one current match at the end",
    prevWrapProbe.currentCount === 1 &&
      prevWrapProbe.currentIndex === prevWrapProbe.total - 1,
    JSON.stringify(prevWrapProbe),
  );

  // --- 4. Clearing restores the DOM exactly ------------------------------
  // clearSearchHighlights() now normalizes each parent once rather than once
  // per match. Under-normalising would leave the tree split into many adjacent
  // text nodes, so the NEXT search would walk a fragmented tree and, worse,
  // could fail to match a term straddling the split.
  const clearProbe = await exec(`
    (() => {
      const target = document.querySelectorAll('#viewer p')[0];
      const before = target.textContent;
      const beforeHighlights = target.querySelectorAll('.search-highlight').length;
      clearSearchHighlights();
      const nodes = [...target.childNodes];
      return {
        text: target.textContent,
        before,
        beforeHighlights,
        childNodes: nodes.length,
        allText: nodes.every(n => n.nodeType === Node.TEXT_NODE),
        highlights: document.querySelectorAll('#viewer .search-highlight').length,
      };
    })()
  `);
  check("the normalization probe really starts with a multiply highlighted paragraph",
    clearProbe.beforeHighlights === 2, JSON.stringify(clearProbe));
  check(
    "clearing removes every highlight",
    clearProbe.highlights === 0,
    JSON.stringify(clearProbe),
  );
  check(
    "clearing collapses a previously highlighted paragraph back to one text node",
    clearProbe.childNodes === 1 && clearProbe.allText === true,
    JSON.stringify(clearProbe),
  );
  check(
    "clearing preserves the paragraph text exactly",
    clearProbe.text === clearProbe.before,
    JSON.stringify(clearProbe),
  );

  // A term that spans what used to be a highlight boundary only matches if the
  // tree was properly re-joined. This is the assertion that would catch a
  // regression to per-match normalize() being dropped entirely.
  await exec(typeScript("needle and needle"));
  await waitFor(
    exec,
    "the straddling term to match",
    `document.querySelectorAll('#viewer .search-highlight').length > 0`,
  );
  const straddle = await exec(COUNTS);
  check(
    "a term spanning a previous highlight boundary still matches after clearing",
    straddle.highlights === 300,
    JSON.stringify(straddle),
  );

  // --- 5. Closing the panel cancels a pending search ----------------------
  // Without cancellation the queued highlight fires after the clear and
  // repopulates highlights into a closed panel with an empty input.
  const immediateClose = await exec(pendingActionScript("needle", `toggleSearchPanel()`));
  check("close is exercised while the new term is genuinely pending",
    immediateClose.pending === true, JSON.stringify(immediateClose));
  check("close immediately cancels the actual timer and term without a walking pass",
    immediateClose.pendingTerm === null && immediateClose.timerCleared === true &&
      immediateClose.walkingPassDelta === 0 && immediateClose.highlights === 0 &&
      immediateClose.current === 0 && immediateClose.currentIndex === -1 &&
      immediateClose.input === "" && immediateClose.panelVisible === false,
    JSON.stringify(immediateClose));
  await sleep(400); // longer than the debounce window
  const afterClose = await exec(COUNTS);
  check(
    "closing the panel cancels a pending search",
    afterClose.highlights === 0,
    JSON.stringify(afterClose),
  );
  check(
    "closing the panel clears the input",
    (await exec(`document.getElementById('searchInput').value`)) === "",
    "input not cleared",
  );

  // --- 6. Short and empty terms clear immediately -------------------------
  // These are cheap, so they must not be delayed behind the debounce - a user
  // deleting their query expects the highlights to go at once.
  await exec(`toggleSearchPanel(), true`);
  await waitFor(exec, "the panel to reopen", `document.getElementById('searchPanel').classList.contains('visible')`);
  await exec(typeScript("needle"));
  await waitFor(exec, "matches to appear", `document.querySelectorAll('#viewer .search-highlight').length === 900`);
  const afterEmpty = await exec(`
    (() => {
      const input = document.getElementById('searchInput');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return (${COUNTS});
    })()
  `);
  check(
    "emptying the input clears highlights synchronously",
    afterEmpty.highlights === 0,
    JSON.stringify(afterEmpty),
  );

  // --- 7. Visual smoke ----------------------------------------------------
  await exec(typeScript("needle"));
  await waitFor(exec, "matches to appear", `document.querySelectorAll('#viewer .search-highlight').length === 900`);
  const panelVisual = await inspectVisual(win, "#searchPanel");
  check(
    "the search panel is actually visible on screen",
    panelVisual.count === 1 && panelVisual.soundCount === 1,
    JSON.stringify(panelVisual.unsound),
  );

  {
    const layout = await exec(`(() => {
      const nodes = [];
      const ids = new Map();
      const properties = [
        'display', 'visibility', 'opacity', 'position', 'z-index',
        'transform', 'transform-origin', 'translate', 'rotate', 'scale',
        'isolation', 'contain', 'will-change', 'filter', 'backdrop-filter',
        'perspective', 'mix-blend-mode', 'overflow', 'overflow-x', 'overflow-y',
        'overflow-clip-margin', 'clip', 'clip-path', 'mask-image', 'pointer-events',
        'content-visibility', 'box-sizing', 'width', 'max-width', 'height',
        'padding', 'border-width'
      ];
      const describe = element => {
        if (ids.has(element)) return ids.get(element);
        const id = nodes.length;
        ids.set(element, id);
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        nodes.push({
          tag: element.localName, id: element.id, class: element.getAttribute('class'),
          hidden: element.hasAttribute('hidden'), inert: element.hasAttribute('inert'),
          ariaHidden: element.getAttribute('aria-hidden'),
          disabled: 'disabled' in element ? element.disabled : null,
          rect: { x: rect.x, y: rect.y, left: rect.left, top: rect.top,
            right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          client: { left: element.clientLeft, top: element.clientTop,
            width: element.clientWidth, height: element.clientHeight },
          scroll: { left: element.scrollLeft, top: element.scrollTop,
            width: element.scrollWidth, height: element.scrollHeight },
          style: Object.fromEntries(properties.map(name => [name, style.getPropertyValue(name)]))
        });
        return id;
      };
      const ancestry = element => {
        const chain = [];
        for (let node = element; node; node = node.parentElement || node.getRootNode().host || null) {
          chain.push(describe(node));
        }
        return chain;
      };
      const observe = (selector, control) => {
        const matches = [...document.querySelectorAll(selector)].map(element => {
          const chain = ancestry(element);
          const rect = nodes[chain[0]].rect;
          if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) {
            throw new Error('search layout diagnostic: nonfinite rectangle for ' + selector);
          }
          const result = { node: chain[0], ancestry: chain, samples: [] };
          if (!control) return result;
          if (rect.width <= 0 || rect.height <= 0) {
            result.sampling = 'no-positive-area';
            return result;
          }
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const dx = Math.min(1, rect.width / 4);
          const dy = Math.min(1, rect.height / 4);
          result.sampling = 'center-and-inward-edge-midpoints';
          result.samples = [
            ['center', x, y],
            ['left-inward', rect.left + dx, y],
            ['right-inward', rect.left + rect.width - dx, y],
            ['top-inward', x, rect.top + dy],
            ['bottom-inward', x, rect.top + rect.height - dy]
          ].map(([point, clientX, clientY]) => ({
            point, clientX, clientY,
            inLayoutViewport: clientX >= 0 && clientX < innerWidth &&
              clientY >= 0 && clientY < innerHeight,
            stack: [...document.elementsFromPoint(clientX, clientY)].map(hit => ({
              node: describe(hit), ancestry: ancestry(hit)
            }))
          }));
          return result;
        });
        return { selector, count: matches.length, matches };
      };
      const viewport = {
        innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio, scrollX, scrollY,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        visual: window.visualViewport ? {
          width: visualViewport.width, height: visualViewport.height,
          offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop,
          pageLeft: visualViewport.pageLeft, pageTop: visualViewport.pageTop,
          scale: visualViewport.scale
        } : null
      };
      const targets = [
        '#searchPanel', '.search-anchor', '#searchPanel .search-container',
        '#indexPanel', '#indexPanel .index-header', '.container > .header',
        '.main-content', '.content-wrapper'
      ].map(selector => observe(selector, false));
      const controls = ['#searchInput', '#searchPrev', '#searchNext', '#searchClose']
        .map(selector => observe(selector, true));
      return { viewport, targets, controls, nodes };
    })()`);
    // Missing targets remain explicit; observer/logging errors reach normal failure cleanup.
    fs.writeSync(2, "SEARCH_LAYOUT_DIAGNOSTIC_R1 " + JSON.stringify({
      windowId: stages.windowId, contentsId: stages.contentsId, panelVisual, layout
    }) + "\n");
  }

  const panelScreenshot = await bounded(captureScreenshot(win, "search"),
    "search panel screenshot", 1500);
  check(
    "the search panel screenshot was captured during this run",
    typeof panelScreenshot === "string" && panelScreenshot.length > 0,
    panelScreenshot || "captureScreenshot returned no image",
  );

  // --- 8. A re-render must not leave the search UI describing the old tree --
  // Every render replaces viewer blocks, which detaches the highlight spans
  // inside them. Before the fix the search state kept pointing at those detached
  // nodes: the counter went on reporting the previous document's matches, the
  // nav buttons stayed enabled, and clicking next advanced the counter while
  // nothing moved on screen. Measured on the real app: 30 matches recorded, 0
  // still attached, on a document that no longer contained the term.
  //
  // This is the app's normal case, not an edge case - files are expected to
  // change underneath the reader.
  await exec(`
    (() => {
      window.__docWith = '# With\\n\\n' + Array.from({length: 12}, () => 'a needle here').join('\\n\\n');
      window.__docWithout = '# Without\\n\\n' + Array.from({length: 12}, () => 'nothing to find').join('\\n\\n');
      return true;
    })()
  `);

  // 8a. Re-render into a document that does NOT contain the term.
  await exec(`renderMarkdown(window.__docWith, 'full')`);
  await waitFor(exec, "the With document to finish rendering",
    `document.querySelector('#viewer h1')?.textContent === 'With' &&
      !document.getElementById('loadingScreen').classList.contains('active')`);
  await exec(typeScript("needle"));
  await waitFor(exec, "connected viewer matches in the first document",
    `document.querySelector('#viewer h1')?.textContent === 'With' &&
      !document.getElementById('loadingScreen').classList.contains('active') &&
      searchMatches.length === 12 && searchMatches.every(match => match.isConnected && viewer.contains(match)) &&
      document.querySelectorAll('#viewer .search-highlight').length === 12`);
  await exec(`renderMarkdown(window.__docWithout, 'full')`);
  await waitFor(
    exec,
    "the search state to resync and settle after the re-render",
    `document.querySelector('#viewer h1')?.textContent === 'Without' &&
      !document.getElementById('loadingScreen').classList.contains('active') &&
      document.querySelectorAll('#viewer .search-highlight').length === 0 &&
      searchMatches.length === 0 && pendingSearchTerm === null`,
  );
  const afterSwapAway = await exec(`
    ({ matches: searchMatches.length,
       detached: searchMatches.filter(m => !m.isConnected).length,
       counter: searchCounter.textContent,
       nextDisabled: searchNextBtn.disabled,
       currentEl: currentMatchEl === null })
  `);
  check(
    "a re-render drops search state that points at the old tree",
    afterSwapAway.matches === 0 &&
      afterSwapAway.detached === 0 &&
      afterSwapAway.currentEl === true,
    JSON.stringify(afterSwapAway),
  );
  check(
    "the counter and nav buttons stop advertising matches that no longer exist",
    /\b0\b/.test(afterSwapAway.counter) && afterSwapAway.nextDisabled === true,
    JSON.stringify(afterSwapAway),
  );

  // Clicking next must be inert rather than silently walking dead nodes.
  const afterDeadClick = await exec(`
    (() => {
      document.getElementById('searchNext').click();
      return { counter: searchCounter.textContent,
               visible: document.querySelectorAll('#viewer .search-highlight').length };
    })()
  `);
  check(
    "navigating after a re-render does not walk detached matches",
    /\b0\b/.test(afterDeadClick.counter) && afterDeadClick.visible === 0,
    JSON.stringify(afterDeadClick),
  );

  // 8b. Re-render into a document that DOES contain the term: the highlights
  // must come back, attached to the NEW tree - resyncing must not mean "give up".
  await exec(`renderMarkdown(window.__docWith, 'full')`);
  await waitFor(
    exec,
    "the search to re-apply against the new tree",
    `document.querySelector('#viewer h1')?.textContent === 'With' &&
      !document.getElementById('loadingScreen').classList.contains('active') &&
      document.querySelectorAll('#viewer .search-highlight').length === 12 &&
      searchMatches.length === 12 && pendingSearchTerm === null &&
      searchMatches.every(match => match.isConnected && viewer.contains(match))`,
  );
  const afterSwapBack = await exec(`
    ({ matches: searchMatches.length,
       live: searchMatches.filter(m => m.isConnected).length,
       inViewer: searchMatches.filter(m => viewer.contains(m)).length,
       counter: searchCounter.textContent })
  `);
  check(
    "the search re-applies against the new tree, with every match attached",
    afterSwapBack.matches === 12 &&
      afterSwapBack.live === 12 &&
      afterSwapBack.inViewer === 12,
    JSON.stringify(afterSwapBack),
  );
  await runSearchLayoutCases(win);
}

async function runSearchLayoutCases(win) {
  // The complete ordinary fixture/viewport sequence above precedes every resize.
  const bounds = win.getBounds();
  const contentBounds = win.getContentBounds();
  const minimum = win.getMinimumSize();
  const saved = await exec(`({
    toc: indexPanel.classList.contains('visible'), edit: isEditMode,
    zoom: zoomLevel, split: editorPanel.style.width,
    ref: window.CustomTabs.getDocumentDescriptor().ref,
    token: document.documentElement.style.getPropertyValue('--toc-width')
  })`);
  const states = [];
  const measure = `(() => {
    const rect = element => {
      const r = element.getBoundingClientRect();
      return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
    };
    const shell = document.querySelector('body > .container');
    const header = shell.querySelector(':scope > .header');
    const host = shell.querySelector(':scope > .search-anchor');
    const main = shell.querySelector(':scope > .main-content');
    const panel = document.getElementById('searchPanel');
    const p = rect(panel), m = rect(main), h = rect(header), t = rect(indexPanel);
    const visible = indexPanel.classList.contains('visible');
    const controls = ['searchInput','searchPrev','searchNext','searchClose'].map(id => {
      const element = document.getElementById(id), r = rect(element);
      const count = document.querySelectorAll('#'+id).length;
      const x = r.left+r.width/2, y = r.top+r.height/2;
      const dx = Math.min(1,r.width/4), dy = Math.min(1,r.height/4);
      const points = [[x,y],[r.left+dx,y],[r.right-dx,y],[x,r.top+dy],[x,r.bottom-dy]]
        .map(([x,y]) => {
          const hit = document.elementFromPoint(x,y);
          return {x,y,owned:x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&
            !!hit&&element.contains(hit),hit:hit&&{tag:hit.localName,id:hit.id}};
        });
      const icon = element.querySelector('svg'), ir = icon && rect(icon);
      return {id,count,rect:r,points,complete:count===1&&r.width>0&&r.height>0&&
        r.left>=p.left&&r.right<=p.right+0.5&&r.top>=p.top&&r.bottom<=p.bottom+0.5&&
        r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,
        iconComplete:id==='searchInput' ? !icon : element.querySelectorAll('svg').length===1&&
          ir.width>=16&&ir.height>=16&&ir.left>=r.left&&
          ir.right<=r.right&&ir.top>=r.top&&ir.bottom<=r.bottom};
    });
    const counter = document.getElementById('searchCounter'), range = document.createRange();
    range.selectNodeContents(counter);
    const fragments = [...range.getClientRects()].map(r=>({
      left:r.left,right:r.right,top:r.top,bottom:r.bottom
    }));
    const animation = indexPanel.getAnimations().find(a=>a.transitionProperty==='transform');
    const timing = animation && animation.effect.getComputedTiming();
    const drawerMotion = animation && {
      currentTime:animation.currentTime,duration:timing.activeDuration,
      fraction:animation.currentTime/timing.activeDuration,
      unfinished:animation.playState==='running'&&Number.isFinite(animation.currentTime)&&
        animation.currentTime>0&&animation.currentTime<timing.activeDuration
    };
    const drawerStyle = getComputedStyle(indexPanel);
    const token = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toc-width'));
    return {width:innerWidth,height:innerHeight,compact:document.body.classList.contains('compact-header'),
      panel:p,main:m,header:h,host:rect(host),content:rect(contentWrapper),toc:t,visible,
      drawerMotion,drawerDuration:drawerStyle.transitionDuration,drawerEase:drawerStyle.transitionTimingFunction,
      motionRunning:[indexPanel,panel].some(element=>element.getAnimations().some(a=>a.playState==='running')),
      reservedInset:parseFloat(getComputedStyle(shell).getPropertyValue('--workspace-toc-inset')),
      exposure:parseFloat(getComputedStyle(panel).getPropertyValue('--search-toc-exposure')),
      physicalWidth:Math.min(token,innerWidth*0.4),controls,fragments,
      counterText:counter.textContent,counterUnclipped:counter.scrollWidth<=counter.clientWidth+1&&
        getComputedStyle(counter).textOverflow!=='ellipsis',
      scrollHeight:panel.scrollHeight,clientHeight:panel.clientHeight,
      panelScrollTop:panel.scrollTop,split:isEditMode,
      ratio:editorPanel.getBoundingClientRect().width/contentWrapper.getBoundingClientRect().width};
  })()`;
  const settle = async () => {
    await exec(`(async () => {
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return true;
    })()`);
    await waitFor(exec, "layout transitions to finish", `['searchPanel','indexPanel'].every(id =>
      document.getElementById(id).getAnimations().every(a=>a.playState!=='running'))`, 4000);
  };
  const sample = async name => {
    await settle();
    const state = await exec(measure);
    states.push({name,state});
    return state;
  };
  const resize = async (width, height) => {
    win.setContentSize(width, height);
    await sleep(180);
    return sample("returned-size-"+width+"x"+height);
  };
  const side = async visible => {
    await exec(`setIndexVisible(${visible}); true`);
    return sample(visible ? "toc-restored" : "toc-closed");
  };
  const exposed = state => state.controls.every(control =>
    control.complete && control.iconComplete && control.points.every(point=>point.owned));
  const allocated = state => {
    const inset = state.visible ? state.physicalWidth : 0;
    return Math.abs(state.toc.width-state.physicalWidth)<1 &&
      Math.abs(state.panel.left-state.main.left-inset)<1 &&
      Math.abs(state.content.left-state.main.left-inset)<1 &&
      Math.abs(state.host.top-state.main.top)<1 &&
      Math.abs(state.main.top-state.header.bottom)<1 &&
      Math.abs(state.main.bottom-state.height)<1 &&
      state.panel.top>=state.header.bottom-1 && state.panel.bottom<=state.main.bottom+1 &&
      Math.abs(state.panel.right-state.main.right)<1;
  };
  const movingFrame = async (action, minimumFraction = 0, previousSize = null) => exec(`(async () => {
    ${action}
    const previousSize=${JSON.stringify(previousSize && {width:previousSize.width,drawerWidth:previousSize.toc.width})};
    const deadline=performance.now()+350;let state;
    do {
      await new Promise(resolve=>requestAnimationFrame(resolve));
      state=(${measure});
    } while(state.drawerMotion&&
      (!state.drawerMotion.unfinished||state.drawerMotion.fraction<${minimumFraction}||
        (previousSize&&!(state.width>previousSize.width+1&&state.toc.width>previousSize.drawerWidth+1)))&&
      state.drawerMotion.currentTime<state.drawerMotion.duration&&performance.now()<deadline);
    return state;
  })()`);
  const finishMotion = async () => exec(`(async () => {
    const frames=[],deadline=performance.now()+500;let state;
    do {
      await new Promise(resolve=>requestAnimationFrame(resolve));
      state=(${measure});frames.push(state);
    } while(state.motionRunning&&performance.now()<deadline);
    return {frames,final:state};
  })()`);
  const inFlight = state => !!state.drawerMotion&&state.drawerMotion.unfinished&&
    state.drawerMotion.duration>0&&state.drawerMotion.duration<=301&&
    state.drawerDuration==='0.3s'&&state.drawerEase==='ease'&&
    state.toc.right>state.main.left+1&&state.toc.right<state.main.left+state.toc.width-1;
  const beside = state => state.panel.left>=Math.max(state.main.left,state.toc.right)-1&&
    state.panel.right<=state.main.right+1&&state.panel.top>=state.header.bottom-1&&
    state.panel.bottom<=state.main.bottom+1&&exposed(state);
  const closedReservation = state => !state.visible&&!state.drawerMotion&&!state.motionRunning&&state.toc.width>0&&
    Math.abs(state.toc.width-state.physicalWidth)<1&&Math.abs(state.toc.right-state.main.left)<1&&
    state.reservedInset===0&&Math.abs(state.panel.left-state.main.left)<1&&
    Math.abs(state.content.left-state.main.left)<1;
  const pointerThrough = async open => {
    await exec(`if (searchPanel.classList.contains('visible')!==${open}) toggleSearchPanel(); true`);
    await settle();
    return exec(`(() => {
      const panel=searchPanel.getBoundingClientRect(), main=document.querySelector('body > .container > .main-content').getBoundingClientRect();
      const x=main.right-12,y=${open} ? (panel.bottom+main.bottom)/2 : main.top+Math.min(80,main.height/2);
      const hit=document.elementFromPoint(x,y), host=document.querySelector('body > .container > .search-anchor');
      return {x,y,usable:y>main.top&&y<main.bottom&&(!${open}||y>panel.bottom),
        through:!!hit&&hit!==host&&!host.contains(hit),hit:hit&&{tag:hit.localName,id:hit.id}};
    })()`);
  };
  try {
    const first = await sample("ordinary-viewport-after-complete-original-sequence");
    check("search layout starts after the original rendered With fixture and real admission",
      first.width>0&&first.height>0&&!saved.edit&&await exec(`document.querySelector('#viewer h1').textContent==='With' &&
        searchMatches.length===12 && window.CustomTabs.getDocumentDescriptor().ref===${JSON.stringify(saved.ref)}`)&&
      main.__shutdown.documentAdmissionIsCurrent(saved.ref),
      JSON.stringify(first));
    await side(true);
    await side(false);
    const scope = await exec(`(() => {
      const authored=document.createElement('div');authored.className='container';
      authored.innerHTML='<div class="main-content"><div class="content-wrapper"><div id="indexPanel" class="visible"></div></div></div>';
      viewer.appendChild(authored);
      try {
        return getComputedStyle(authored).display!=='grid'&&
          parseFloat(getComputedStyle(document.querySelector('body > .container')).getPropertyValue('--workspace-toc-inset'))===0;
      } finally { authored.remove(); }
    })()`);
    check("authored containers and TOC lookalikes do not become the application shell", scope===true, scope);
    await side(true);
    const transition = await exec(`(async () => {
      const events=[], sample=[], panel=searchPanel, drawer=indexPanel;
      const record=e=>{if(e.propertyName==='transform')events.push(e.type);};
      drawer.addEventListener('transitionrun',record);drawer.addEventListener('transitionend',record);
      try {
        for(let leg=0;leg<2;leg++){
          toggleTableOfContents();
          const end=performance.now()+800;
          do {
            await new Promise(resolve=>requestAnimationFrame(resolve));
            const d=drawer.getBoundingClientRect(),p=panel.getBoundingClientRect();
            sample.push({gap:p.left-d.right,width:d.width});
          } while(drawer.getAnimations().some(a=>a.playState==='running')&&performance.now()<end);
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
        return {events,sample,duration:getComputedStyle(drawer).transitionDuration,
          restored:drawer.classList.contains('visible')};
      } finally {drawer.removeEventListener('transitionrun',record);drawer.removeEventListener('transitionend',record);}
    })()`);
    check("TOC toggle transitions keep the whole search panel beside the moving drawer",
      transition.restored&&transition.sample.length>0&&transition.sample.every(value=>value.gap>=-1)&&
      parseFloat(transition.duration)===0.3&&
      transition.events.filter(value=>value==='transitionrun').length===2&&
      transition.events.filter(value=>value==='transitionend').length===2,
      JSON.stringify(transition));
    await sample("toc-toggled-open");
    win.setMinimumSize(0,0);
    const narrow = await resize(320,600);
    const below = await resize(760,600);
    const above = await resize(800,600);
    const wide = await resize(1188,700);
    check("search layout returned sizes cross narrow and both sides of compact mode",
      narrow.width<below.width&&below.width<780&&above.width>780&&wide.width>above.width&&
      below.compact===true&&above.compact===false, JSON.stringify({narrow,below,above,wide}));
    check("narrow search layout actually wraps without clipping icons or counter text",
      narrow.controls.some(control=>control.rect.top>=narrow.controls[0].rect.bottom-0.5)&&
      exposed(narrow)&&narrow.counterUnclipped,JSON.stringify(narrow));
    const cappedImmediate=await exec(`(() => {
      document.documentElement.style.setProperty('--toc-width','2600px');
      return (${measure});
    })()`);
    const capped = await sample("toc-token-capped");
    const changedImmediate=await exec(`(() => {
      document.documentElement.style.setProperty('--toc-width','180px');
      return (${measure});
    })()`);
    const changed = await sample("toc-token-changed");
    check("visible TOC width changes reserve search space in the same layout",
      [cappedImmediate,changedImmediate].every(state=>
        Math.abs(state.panel.left-state.toc.right)<1&&
        Math.abs(state.content.left-state.toc.right)<1),JSON.stringify({cappedImmediate,changedImmediate}));
    check("search layout uses the changed TOC token and its viewport cap",
      Math.abs(capped.toc.width-capped.width*0.4)<1&&Math.abs(changed.toc.width-180)<1,
      JSON.stringify({capped,changed}));

    // Only setup settles. Critical samples require the real transform to be
    // unfinished at the SAME observation as the actual physical width change.
    await exec(`document.documentElement.style.setProperty('--toc-width','2600px');true`);
    const resizeStart=await resize(760,600);
    const resizeClosing=await movingFrame(`document.getElementById('closeIndex').click();`,0.15);
    win.setContentSize(1188,600);
    const resizeCritical=await movingFrame('',0,resizeClosing);
    const resizeEnd=await finishMotion();
    const resizeWitness=!resizeClosing.visible&&!resizeCritical.visible&&inFlight(resizeClosing)&&inFlight(resizeCritical)&&
      resizeCritical.width>resizeClosing.width+1&&resizeCritical.toc.width>resizeClosing.toc.width+1&&
      Math.abs(resizeStart.toc.width-resizeClosing.toc.width)<1&&
      Math.abs(resizeCritical.toc.width-resizeCritical.width*0.4)<1;
    check("closing viewport enlargement has a physical width change during an unfinished real transition",
      resizeWitness,JSON.stringify({resizeStart,resizeClosing,resizeCritical}));
    check("closing viewport enlargement keeps the whole search panel and exposed controls beside the live drawer",
      resizeWitness&&[resizeClosing,resizeCritical,...resizeEnd.frames].every(beside),
      JSON.stringify({resizeClosing,resizeCritical,resizeEnd}));

    await exec(`document.documentElement.style.setProperty('--toc-width','180px');true`);
    await side(true);
    const tokenClosing=await movingFrame(`document.getElementById('closeIndex').click();`,0.15);
    const tokenCritical=await exec(`(() => {
      document.documentElement.style.setProperty('--toc-width','360px');
      return (${measure});
    })()`);
    const tokenEnd=await finishMotion();
    const tokenWitness=!tokenClosing.visible&&!tokenCritical.visible&&inFlight(tokenClosing)&&inFlight(tokenCritical)&&
      tokenCritical.width===tokenClosing.width&&Math.abs(tokenClosing.toc.width-180)<1&&
      Math.abs(tokenCritical.toc.width-360)<1&&tokenCritical.toc.width>tokenClosing.toc.width+1;
    check("closing token increase has a physical width change during an unfinished real transition",
      tokenWitness,JSON.stringify({tokenClosing,tokenCritical}));
    check("closing token increase keeps the whole search panel and exposed controls beside the live drawer",
      tokenWitness&&[tokenClosing,tokenCritical,...tokenEnd.frames].every(beside),
      JSON.stringify({tokenClosing,tokenCritical,tokenEnd}));

    await exec(`document.documentElement.style.setProperty('--toc-width','2600px');true`);
    await resize(760,600);
    await side(true);
    // Reverse before each real transition finishes; do not lengthen its CSS
    // duration to make the probe easier. A missed in-flight window fails setup.
    const rapidClosing=await movingFrame(`document.getElementById('closeIndex').click();`,0.3);
    win.setContentSize(1188,600);
    const rapidWide=await movingFrame('',0,rapidClosing);
    const rapidOpening=await exec(`(async () => {
      const before=(${measure});
      document.getElementById('toggleTocBtn').click();
      document.documentElement.style.setProperty('--toc-width','180px');
      const immediate=(${measure});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {before,immediate,moving:(${measure})};
    })()`);
    const rapidReclosing=await exec(`(async () => {
      const before=(${measure});
      document.getElementById('closeIndex').click();
      document.documentElement.style.setProperty('--toc-width','360px');
      const immediate=(${measure});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {before,immediate,moving:(${measure})};
    })()`);
    const rapidEnd=await finishMotion();
    const rapidWitness=!rapidClosing.visible&&!rapidWide.visible&&inFlight(rapidClosing)&&inFlight(rapidWide)&&
      rapidWide.width>rapidClosing.width+1&&rapidWide.toc.width>rapidClosing.toc.width+1&&
      !rapidOpening.before.visible&&inFlight(rapidOpening.before)&&rapidOpening.immediate.visible&&
      rapidOpening.moving.visible&&inFlight(rapidOpening.moving)&&
      Math.abs(rapidOpening.moving.toc.width-180)<1&&
      rapidOpening.moving.toc.width<rapidOpening.before.toc.width-1&&
      rapidReclosing.before.visible&&inFlight(rapidReclosing.before)&&!rapidReclosing.immediate.visible&&
      !rapidReclosing.moving.visible&&inFlight(rapidReclosing.moving)&&
      Math.abs(rapidReclosing.immediate.toc.width-360)<1&&
      Math.abs(rapidReclosing.moving.toc.width-360)<1&&
      rapidReclosing.immediate.toc.width>rapidReclosing.before.toc.width+1;
    check("rapid real TOC close open close reversals coexist with physical width changes and unfinished transitions",
      rapidWitness,JSON.stringify({rapidClosing,rapidWide,rapidOpening,rapidReclosing}));
    check("rapid TOC reversals under width changes keep the whole search panel and exposed controls beside the live drawer",
      rapidWitness&&[rapidClosing,rapidWide,rapidOpening.before,rapidOpening.immediate,rapidOpening.moving,
        rapidReclosing.before,rapidReclosing.immediate,rapidReclosing.moving,...rapidEnd.frames].every(beside),
      JSON.stringify({rapidClosing,rapidWide,rapidOpening,rapidReclosing,rapidEnd}));
    check("closed TOC releases all search reservation while retaining its physical transition width",
      [resizeEnd.final,tokenEnd.final,rapidEnd.final].every(closedReservation),
      JSON.stringify({resize:resizeEnd.final,token:tokenEnd.final,rapid:rapidEnd.final}));
    await side(true);

    await exec(`changeCurrentDocumentEditor(true)`);
    await waitFor(exec,"actual split mode and admitted source render",`isEditMode &&
      contentWrapper.classList.contains('split-view')&&document.querySelector('#viewer h1')?.textContent==='Searchable'&&
      document.querySelectorAll('#viewer h2').length===300&&!loadingScreen.classList.contains('active')`,4000);
    const splits=[];
    for (const ratio of [0.15,0.5,0.85]) {
      await exec(`applyEditorSplitRatio(${ratio}); true`);
      const state=await sample("split-"+ratio);
      splits.push({ratio,state});
    }
    check("search spans the workspace at actual 15 50 and 85 percent split ratios",
      splits.every(({ratio,state})=>state.split&&Math.abs(state.ratio-ratio)<0.015&&allocated(state)&&exposed(state)),
      JSON.stringify(splits));
    await exec(`changeCurrentDocumentEditor(false)`);
    await waitFor(exec,"preview after edit exit",`!isEditMode&&!contentWrapper.classList.contains('split-view')&&
      document.querySelector('#viewer h1')?.textContent==='Searchable'&&document.querySelectorAll('#viewer h2').length===300&&
      !loadingScreen.classList.contains('active')`,4000);
    const beforeZoom=await sample("preview-after-edit");
    await exec(`zoomLevel=150;updateZoom({persist:false});true`);
    const zoomed=await sample("reading-zoom");
    check("reading zoom leaves the search overlay in unzoomed workspace coordinates",
      Math.abs(zoomed.panel.left-beforeZoom.panel.left)<1&&
      Math.abs(zoomed.panel.width-beforeZoom.panel.width)<1&&
      await exec(`Number(getComputedStyle(viewer).zoom)===1.5`), JSON.stringify({beforeZoom,zoomed}));
    const closedPointer=await pointerThrough(false);
    const openPointer=await pointerThrough(true);
    check("closed search host leaves the workspace pointer-transparent",
      closedPointer.usable&&closedPointer.through,JSON.stringify(closedPointer));
    check("open search host leaves below-panel workspace pointer-transparent",
      openPointer.usable&&openPointer.through,JSON.stringify(openPointer));
    check("search layout shared allocation and control exposure",
      states.every(({state})=>allocated(state)&&exposed(state)),JSON.stringify(states));
    check("search panel right edge stays flush with the actual workspace",
      states.every(({state})=>Math.abs(state.panel.right-state.main.right)<1),JSON.stringify(states));
    check("search layout complete counter fragments remain inside the normal panel",
      states.every(({state})=>state.counterUnclipped&&state.counterText.length>0&&state.fragments.length>0&&
        state.fragments.every(r=>r.left>=state.panel.left&&r.right<=state.panel.right+1&&
          r.top>=state.panel.top&&r.bottom<=state.panel.bottom+1)),JSON.stringify(states));
    await resize(320,600);
    const tall=await exec(measure);
    await resize(320,Math.ceil(tall.header.height+Math.max(...tall.controls.map(c=>c.rect.height))+12));
    const short=await exec(measure);
    const usable=short.clientHeight>0&&short.scrollHeight>short.clientHeight&&
      short.clientHeight>=Math.max(...short.controls.map(control=>control.rect.height))+2;
    check("short search layout has real overflow and a usable complete-control scrollport",usable,JSON.stringify(short));
    const reached=[];
    for(const id of ['searchInput','searchPrev','searchNext','searchClose']) {
      const localOnly=await exec(`(() => {
        const owners=()=>[scrollX,scrollY,contentWrapper.scrollLeft,contentWrapper.scrollTop,viewer.scrollLeft,viewer.scrollTop];
        const before=owners();
        const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(),p=searchPanel.getBoundingClientRect();
        searchPanel.scrollTop+=r.top<p.top?r.top-p.top:r.bottom>p.bottom?r.bottom-p.bottom:0;
        return owners().every((value,index)=>value===before[index]);
      })()`);
      const state=await exec(measure);
      const control=state.controls.find(value=>value.id===id);
      reached.push({id,control,scrollTop:state.panelScrollTop,localOnly});
    }
    check("short search layout exposes each complete control after local vertical scrolling",
      usable&&reached.every(({control,localOnly})=>localOnly&&control.complete&&control.iconComplete&&control.points.every(point=>point.owned))&&
      reached.some(value=>value.scrollTop>0),JSON.stringify(reached));
    const counterReach=await exec(`(() => {
      const owners=()=>[scrollX,scrollY,contentWrapper.scrollLeft,contentWrapper.scrollTop,viewer.scrollLeft,viewer.scrollTop];
      const before=owners();
      const counter=document.getElementById('searchCounter'), walker=document.createTreeWalker(counter,NodeFilter.SHOW_TEXT);
      const readings=[];let text;
      while((text=walker.nextNode()))for(let i=0;i<text.length;i++){
        const range=document.createRange();range.setStart(text,i);range.setEnd(text,i+1);
        const r=range.getBoundingClientRect(),p=searchPanel.getBoundingClientRect();
        searchPanel.scrollTop+=r.top<p.top?r.top-p.top:r.bottom>p.bottom?r.bottom-p.bottom:0;
        const current=range.getBoundingClientRect(),box=searchPanel.getBoundingClientRect();
        readings.push(current.left>=box.left&&current.right<=box.right+1&&
          current.top>=box.top&&current.bottom<=box.bottom+1);
      }
      return {text:counter.textContent,readings,localOnly:owners().every((value,index)=>value===before[index])};
    })()`);
    check("short search layout makes every counter text fragment reachable",
      usable&&counterReach.localOnly&&counterReach.text.length>0&&counterReach.readings.length===counterReach.text.length&&
      counterReach.readings.every(Boolean),JSON.stringify(counterReach));
    await resize(1188,700);
    await bounded(ownedContents.debugger.sendCommand("Emulation.setEmulatedMedia",{media:"print"}),"print media",1500);
    const print=await exec(`({
      shell:getComputedStyle(document.querySelector('body > .container')).display,
      host:document.querySelector('body > .container > .search-anchor').getBoundingClientRect().height,
      panel:getComputedStyle(searchPanel).display,header:getComputedStyle(document.querySelector('body > .container > .header')).display,
      content:getComputedStyle(contentWrapper).display
    })`);
    check("print retains original non-grid shell and hidden search chrome",
      print.shell==='flex'&&print.host===0&&print.panel==='none'&&print.header==='none'&&print.content==='block',
      JSON.stringify(print));
    await bounded(ownedContents.debugger.sendCommand("Emulation.setEmulatedMedia",{media:""}),"screen media restore",1500);
    win.setBounds(bounds);
    await exec(`document.documentElement.style.setProperty('--toc-width',${JSON.stringify(saved.token)});
      setIndexVisible(true);zoomLevel=100;updateZoom({persist:false});searchPanel.scrollTop=0;true`);
    await exec(`renderMarkdown(window.__docWith,'full')`);
    await exec(typeScript("needle"));
    await waitFor(exec,"native case retains the real With fixture",`document.querySelector('#viewer h1').textContent==='With'&&
      !loadingScreen.classList.contains('active')&&searchMatches.length===12&&pendingSearchTerm===null&&
      searchMatches.every(match=>match.isConnected&&viewer.contains(match))`,4000);
    await settle();
    await runSearchNativePointerCases(win);
    check("all added search layout cases reached their terminal point",true);
  } finally {
    await bounded(ownedContents.debugger.sendCommand("Emulation.setEmulatedMedia",{media:""}),"terminal media restore",1500);
    await exec(`(async () => {
      if(window.__searchLayoutUnlisten)window.__searchLayoutUnlisten();
      if(window.__searchLayoutTextUnlisten)window.__searchLayoutTextUnlisten();
      await changeCurrentDocumentEditor(${saved.edit});
      editorPanel.style.width=${JSON.stringify(saved.split)};
      zoomLevel=${saved.zoom};updateZoom({persist:false});
      document.documentElement.style.setProperty('--toc-width',${JSON.stringify(saved.token)});
      setIndexVisible(${saved.toc});
      if(!searchPanel.classList.contains('visible'))toggleSearchPanel();
      searchPanel.scrollTop=0;
      return true;
    })()`);
    win.setMinimumSize(...minimum);
    win.setBounds(bounds);
    await exec(`renderMarkdown(window.__docWith,'full')`);
    await exec(typeScript("needle"));
    await waitFor(exec,"original With highlights after layout restoration",`document.querySelector('#viewer h1').textContent==='With'&&
      !loadingScreen.classList.contains('active')&&searchMatches.length===12&&pendingSearchTerm===null&&
      searchMatches.every(match=>match.isConnected&&viewer.contains(match))`,4000);
    const restoredBounds = win.getBounds();
    const restoredOwner = await exec(`(() => {
      const dirty = hasUnsavedWork();
      const descriptor = window.CustomTabs.getDocumentDescriptor();
      if (!descriptor) throw new Error("Search layout restoration has no active document descriptor");
      return {dirty,logicalPath:descriptor.logicalPath,ref:descriptor.ref};
    })()`);
    const admissionCurrent = main.__shutdown.documentAdmissionIsCurrent(saved.ref);
    check("search layout restores original window bounds and clean document ownership",
      JSON.stringify(restoredBounds)===JSON.stringify(bounds)&&!restoredOwner.dirty&&
        restoredOwner.logicalPath===file&&restoredOwner.ref===saved.ref&&admissionCurrent,
      JSON.stringify({expectedBounds:bounds,restoredBounds,originalContentBounds:contentBounds,
        originalMinimumSize:minimum,expectedLogicalPath:file,expectedRef:saved.ref,
        restoredOwner,admissionCurrent}));
  }
}

// Electron-injected browser input, not a physical operating-system pointer proof.
async function runSearchNativePointerCases(win) {
  const click = async (id, leftEdge = false, pending = null) => {
    const point=await exec(`(() => {
      const element=document.getElementById(${JSON.stringify(id)}),r=element.getBoundingClientRect();
      const x=${leftEdge} ? Math.ceil(r.left+1) : Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);
      const hit=document.elementFromPoint(x,y);
      const owned=x>r.left&&x<r.right&&y>r.top&&y<r.bottom&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&
        !!hit&&element.contains(hit);
      if(!owned)return {x,y,owned:false,hit:hit&&{tag:hit.localName,id:hit.id}};
      const events=[];
      const record=event=>events.push({type:event.type,trusted:event.isTrusted,x:event.clientX,y:event.clientY,
        owned:element.contains(event.target),path:event.composedPath().includes(element),
        pending:pendingSearchTerm,timer:searchDebounceTimer!==null});
      for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,record,true);
      window.__searchLayoutPointer=events;
      window.__searchLayoutUnlisten=()=>{for(const type of ['mousedown','mouseup','click'])document.removeEventListener(type,record,true);};
      return {x,y,owned:true};
    })()`);
    check("native search "+id+" preflight owns its "+(leftEdge?"inward-left":"center")+" point",
      point.owned,JSON.stringify(point));
    if(!point.owned)throw new Error("native search pointer preflight refused unsafe dispatch");
    win.focus();ownedContents.focus();
    ownedContents.sendInputEvent({type:"mouseDown",x:point.x,y:point.y,button:"left",clickCount:1});
    ownedContents.sendInputEvent({type:"mouseUp",x:point.x,y:point.y,button:"left",clickCount:1});
    const delivered=await exec(`(() => {
      window.__searchLayoutUnlisten();
      return {events:window.__searchLayoutPointer,focus:document.activeElement.id};
    })()`);
    const ownedDelivery=delivered.events.length===3&&delivered.events.every((event,index)=>
        event.type===["mousedown","mouseup","click"][index]&&event.trusted&&event.owned&&event.path&&
        event.x===point.x&&event.y===point.y)&&
      (pending===null||delivered.events[0].pending===pending&&delivered.events[0].timer);
    check("native search "+id+" receives trusted owned down up click at "+(leftEdge?"inward-left":"center"),
      ownedDelivery,
      JSON.stringify({point,delivered,pending}));
    if(!ownedDelivery)throw new Error("native search delivery did not satisfy its owned-input contract");
    return delivered;
  };
  const type = async term => {
    const focused=await exec(`(() => {
      if(document.activeElement!==searchInput)return false;
      window.__searchLayoutTyped=null;
      const record=event=>{window.__searchLayoutTyped={trusted:event.isTrusted,
        owned:event.target===searchInput,path:event.composedPath().includes(searchInput),value:searchInput.value};};
      searchInput.addEventListener('input',record,{once:true});
      window.__searchLayoutTextUnlisten=()=>searchInput.removeEventListener('input',record);
      return true;
    })()`);
    if(!focused)throw new Error("native text insertion refused without established search input focus");
    const modifier=process.platform==="darwin"?"meta":"control";
    ownedContents.sendInputEvent({type:"keyDown",keyCode:"A",modifiers:[modifier]});
    ownedContents.sendInputEvent({type:"keyUp",keyCode:"A",modifiers:[modifier]});
    await bounded(ownedContents.insertText(term),"native search text insertion",1500);
    const typed=await exec(`(() => {
      window.__searchLayoutTextUnlisten();return window.__searchLayoutTyped;
    })()`);
    check("native search text "+term+" is delivered to the focused input",
      typed&&typed.trusted&&typed.owned&&typed.path&&typed.value===term,JSON.stringify(typed));
    if(!(typed&&typed.trusted&&typed.owned&&typed.path&&typed.value===term)){
      throw new Error("native search text delivery failed");
    }
  };
  await click("searchNext");
  const differentFocus=await exec(`document.activeElement.id==='searchNext'`);
  check("native search input starts from a different established focus target",
    differentFocus);
  if(!differentFocus)throw new Error("native focus-transfer setup was not established");
  const focused=await click("searchInput",true);
  check("native inward-left input click really transfers focus",focused.focus==="searchInput",JSON.stringify(focused));
  if(focused.focus!=="searchInput")throw new Error("native input focus transfer failed");
  await type("With");
  await waitFor(exec,"native typed unique heading search",`searchInput.value==='With'&&searchMatches.length===1&&
    document.querySelectorAll('#viewer .search-highlight').length===1&&pendingSearchTerm===null`,4000);
  check("native input text changes the actual rendered search result to one match",true);
  await type("needle");
  await waitFor(exec,"native typed repeated search",`searchInput.value==='needle'&&searchMatches.length===12&&
    currentMatchIndex===0&&pendingSearchTerm===null`,4000);
  await click("searchNext");
  check("native next click changes the actual current match",await exec(`currentMatchIndex===1`));
  await click("searchPrev");
  check("native previous click changes the actual current match",await exec(`currentMatchIndex===0`));
  await click("searchInput");
  await type("With");
  await click("searchClose",false,"With");
  await sleep(220);
  check("native close click cancels a genuinely pending term without late highlights",
    await exec(`!searchPanel.classList.contains('visible')&&searchInput.value===''&&
      pendingSearchTerm===null&&searchDebounceTimer===null&&searchMatches.length===0&&
      document.querySelectorAll('#viewer .search-highlight').length===0`));
}

async function readyMain() {
  const ready = await waitFor(async () => {
    if (!ownedWindow || !documentLoaded ||
        stages.enable !== "resolved" || stages.install !== "resolved") return false;
    const all = BrowserWindow.getAllWindows();
    if (all.length !== 1 || all[0] !== ownedWindow ||
        ownedWindow.isDestroyed() || ownedWindow.webContents !== ownedContents ||
        ownedContents.getURL() !== indexURL) {
      throw new Error("the provisional owned candidate is not the sole exact Main document");
    }
    const state = main.__shutdown.state();
    if (state.renderer !== "ready") return false;
    const probe = await bounded(ownedContents.executeJavaScript(`(async () => {
      if (document.readyState !== 'complete' ||
          !window.CustomTabs || typeof window.folia?.getQuitApprovalGeneration !== 'function' ||
          !document.getElementById('openFile') || !document.getElementById('viewer') ||
          !document.getElementById('searchInput') || !document.getElementById('loadingScreen')) {
        return null;
      }
      return ${READ_GUARD};
    })()`, true), "initial Main DOM/bridge readiness");
    if (!probe) return false;
    const current = main.__shutdown.state();
    if (probe.guard?.token !== guardToken || probe.guard.url !== indexURL ||
        probe.guard.intact !== true || !Array.isArray(probe.guard.open) ||
        probe.guard.open.length !== 0) {
      throw new Error("initial embedded-dialog guard missing, replaced, or already open");
    }
    if (current.renderer !== "ready" || !Number.isSafeInteger(probe.generation) ||
        probe.generation <= 0 || probe.generation !== current.rendererGeneration ||
        !probe.pageSession || probe.pageSession !== current.rendererPageSession ||
        documentEpoch !== 1) return false;
    const preferences = ownedContents.getLastWebPreferences();
    if (preferences.nodeIntegration !== false || preferences.contextIsolation !== true ||
        preferences.sandbox !== true) {
      throw new Error("the owned candidate is not the production isolated sandboxed renderer");
    }
    if (!ownedWindow.isVisible()) return false;
    return probe;
  }, "the sole actual Main owner, current bridge and guarded DOM", null, 20000);
  guardAck = { epoch: documentEpoch, generation: ready.generation, pageSession: ready.pageSession };
  stage("exact-main-guard-acknowledged", { epoch: documentEpoch, generation: ready.generation });
  assertOwner();
  if (!(await waitForExternalTrap(ownedWindow, 1000))) {
    throw new Error("Main shell traps are not actually ready");
  }
}

async function finish(error, completed) {
  const owner = claimTerminal("finish");
  if (!owner) return;
  // Ownership precedes every await. Vetoes signal this owner's bounded waits;
  // they cannot start another cleanup/report/exit or wait on renderer evidence.
  try {
    if (error) {
      check("harness ran to completion", false, String(error.stack || error));
      stageSnapshot("finish-failure");
    }
    try {
      if (guardAck && !ownedWindow.isDestroyed()) {
        const restored = await exec(`typeof window.__searchProbeRestore === 'function'
          ? window.__searchProbeRestore() : ${completed ? "false" : "true"}`);
        check("the production search function is restored before terminal cleanup",
          restored === true, restored);
      }
    } catch (cleanupError) {
      if (owner.emergency) throw owner.emergency;
      check("the search spy cleanup completed", false, cleanupError.message);
    }

    if (completed) {
      try {
        assertOwner();
        const alive = await bounded(proveSentinelAlive(ownedWindow, sentinel),
          "both sentinel liveness channels", 6000);
        check(
          "the error sentinel was demonstrably watching both channels",
          alive.console === true && alive.dom === true,
          JSON.stringify(alive),
        );
      } catch (cleanupError) {
        if (owner.emergency) throw owner.emergency;
        check("the error sentinel was demonstrably watching both channels", false, cleanupError.message);
      }
    }

    if (sentinel) {
      try {
        await bounded(sentinel.drain(), "terminal sentinel drain");
        const sentinelReport = await bounded(sentinel.stop(), "terminal sentinel stop");
        check(
          "nothing rendered a visible error at any point during the suite",
          sentinelReport.hits.length === 0,
          JSON.stringify(sentinelReport.hits),
        );
        check("the error sentinel completed without a stalled observation",
          sentinelReport.stalls.length === 0, JSON.stringify(sentinelReport.stalls));
      } catch (cleanupError) {
        if (owner.emergency) throw owner.emergency;
        check("the error sentinel cleanup completed", false, cleanupError.message);
      }
    } else {
      check("the owned Main error sentinel was installed", false, "no owned window was created");
    }

    check("Main external-open traps remain active through terminal cleanup",
      await bounded(waitForExternalTrap(undefined, 1000), "terminal shell trap readiness", 1500),
      "actual Main shell guards were replaced");
    check("the native and Main-owned dialog guards remain locked through teardown",
      OwnedDialogs.prototype.show === ownedDialogGuard &&
        [...nativeGuards].every(([name, guard]) => dialog[name] === guard),
      "a dialog guard was replaced");
    if (completed) {
      assertOwner();
      check("the exact one-use native chooser was consumed without any later chooser",
        chooserCalls === 1 && chooserAllowance === null, chooserCalls);
    }
    check("the complete search scenario sequence reached its terminal path",
      completed === true && !error, error ? error.message : "scenario sequence did not complete");
    // Artifact existence alone is not evidence: report only this bounded
    // attempt's result. A timeout does not cancel capture or certify an old PNG.
    if (results.some(result => !result.ok) && ownedWindow && !ownedWindow.isDestroyed()) {
      stage("failure-capture-started", {}, true);
      try {
        const captured = await bounded(captureScreenshot(ownedWindow, "search-FAILED"),
          "failure screenshot", 1500);
        stage("failure-capture", { outcome: typeof captured === "string" && captured ? "success" : "false" }, true);
      } catch (captureError) {
        stage("failure-capture", { outcome: captureError?.isTimeout ? "timeout" : "rejected" }, true);
        if (owner.emergency) throw owner.emergency;
      }
    }
  } catch (cleanupError) {
    terminalFailed = true;
    try { check("the owned terminal path completed without a veto", false, cleanupError.message); }
    catch (_) { secondary("terminal failure could not be printed"); }
  } finally {
    const destruction = cleanupOwner(owner);
    try {
      check("owned-window destruction completed without an exception",
        destruction.errors.length === 0, JSON.stringify(destruction));
      check("the exact owned windows are destroyed before the watched fixture is released",
        destruction.destroyed, JSON.stringify(destruction));
      const released = releaseOwnedFixture(destruction);
      check("the watched fixture was verifiably released after destroying its owner",
        released, retainedFixture ? "retained unsafe fixture (excluded from shared sweeps): " + dir
          : "releaseTempDir returned false; the safe exit sweep may retry: " + dir);
    } catch (cleanupError) {
      terminalFailed = true;
      try { check("the watched fixture was released after destroying its owner", false, cleanupError.message); }
      catch (_) { secondary("fixture cleanup failure could not be printed"); }
    }
    if (owner.emergency &&
        !results.some(result => result.name === "the owned terminal path completed without a veto")) {
      try { check("the owned terminal path completed without a veto", false, owner.emergency.message); }
      catch (_) { terminalFailed = true; }
    }
    reportOwner(owner);
    exitOwner(owner, completed && !error && !terminalFailed ? 0 : 1);
  }
  return;
}

// Capture and all refusal surfaces above precede production host creation.
main = require("../src/main.js");
app.whenReady().then(async () => {
  let error = null;
  let completed = false;
  try {
    await readyMain();
    await run(ownedWindow);
    completed = true;
  } catch (caught) {
    error = caught;
  }
  await finish(error, completed);
}).catch(fatalExit);
