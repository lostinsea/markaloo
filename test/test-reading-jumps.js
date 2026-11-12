"use strict";

// Parent owns the fresh TEMP/TMP, process preflight and outer CLI/exit capture.
// Run with the repository's Electron binary, not plain Node. No shipping gate.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID, createHash } = require("crypto");
const { pathToFileURL } = require("url");
const { isDeepStrictEqual } = require("util");
let app, BrowserWindow, dialog, session, main, visual, isolation;
let win = null, contents = null, sentinel = null, fixtureDirectory = null;
let ending = false, tearingDown = false, exiting = false, reported = false;
let failure = null, payloadCompleted = false, destroyed = false, closed = false;
let chooserAllowance = null, chooserCalls = 0, loadCalls = 0, navigationCalls = 0;
let evidence = null, guardCommands = null, storageRoot = null, owner = null;
let shellGuards = null;
const windows = new Set();
const assertions = [];
const token = randomUUID();
const root = path.resolve(__dirname, "..");
const indexPath = path.join(root, "src", "index.html");
const indexURL = pathToFileURL(indexPath).href;
const guardKey = "__readingJumpExecutorGuard";
const guardMarker = "READING_JUMPS_UNEXPECTED_DIALOG:" + token;
const receipt = {
  token, startedAt: new Date().toISOString(), versions: process.versions,
  diagnosticOnly: true, qualification: false, purpose: "diagnostic-only; never a qualification receipt",
  environment: "INSTRUMENTED/DIAGNOSTIC-ONLY",
  instrumentationLimit: "Original-registration publisher wrapper proves same-observed-Event attribution, not native packet identity or unchanged production qualification.",
  assertions, screenshots: [], payload: null, trustedInputs: [], lifecycle: [], completed: false,
};
const json = value => JSON.stringify(value, (_key, item) =>
  item === undefined ? { type: "undefined" } : item, 2);
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = value => process.platform === "win32" ? value.toLowerCase() : value;

process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
const watchdog = setTimeout(() => emergency(new Error("reading jumps exceeded its startup-inclusive 180s watchdog")), 180000);
process.once("exit", () => {
  if (!reported || !exiting || failure || assertions.some(row => !row.ok)) process.exitCode = 1;
});

function persist() {
  if (evidence) fs.writeFileSync(path.join(evidence, "reading-jumps-receipt.json"), json(receipt) + "\n");
}

function check(name, ok, detail) {
  if (reported) return emergency(new Error("assertion after the definitive footer: " + name));
  assertions.push({ name, ok: ok === true, detail });
  fs.writeSync(1, `${ok === true ? "PASS" : "FAIL"} ${name}${ok === true ? "" : "  -> " + JSON.stringify(detail)}\n`);
  persist();
}

function requireCheck(name, ok, detail) {
  check(name, ok, detail);
  if (ok !== true) throw new Error(name);
}

function fatal(error) {
  failure ||= error instanceof Error ? error : new Error(String(error));
  try { fs.writeSync(2, "READING_JUMPS_FATAL " + String(failure.stack || failure) + "\n"); } catch {}
  if (!ending) void finish(failure).catch(emergency);
}

function emergency(error) {
  failure ||= error instanceof Error ? error : new Error(String(error));
  tearingDown = true;
  for (const target of windows) {
    try { if (!target.isDestroyed()) target.destroy(); } catch {}
  }
  receipt.emergency = String(failure.stack || failure);
  receipt.retainedFixture = fixtureDirectory;
  try { persist(); fs.writeSync(2, "FAIL reading jumps emergency termination  -> " + receipt.emergency + "\n"); } catch {}
  exiting = true;
  if (app) app.exit(2);
  process.exit(2);
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + " exceeded its owned 9s await bound")), 9000);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 9000;
  do {
    if (await predicate()) return;
    await sleep(30);
  } while (Date.now() < deadline);
  throw new Error("Timed out after 9s: " + label);
}

const electron = require("electron");
if (!process.versions.electron || !electron.app) {
  fs.writeSync(2, "Run test-reading-jumps.js with the repository Electron binary; Node is syntax-check only.\n");
  process.exit(2);
}
({ app, BrowserWindow, dialog, session } = electron);
try {
  const temporary = fs.realpathSync.native(os.tmpdir());
  if (!process.env.TEMP || !process.env.TMP ||
      key(fs.realpathSync.native(process.env.TEMP)) !== key(temporary) ||
      key(fs.realpathSync.native(process.env.TMP)) !== key(temporary)) {
    throw new Error("Parent must supply matching fresh TEMP/TMP before launch");
  }
  if (app.isReady() || BrowserWindow.getAllWindows().length) {
    throw new Error("Reading jumps must start before ready, without preexisting windows");
  }
  receipt.temporaryRoot = temporary;
} catch (error) { emergency(error); }

require("./test-userdata-isolation");

try {
  isolation = require("./test-userdata-isolation");
  storageRoot = fs.realpathSync.native(isolation.USER_DATA_DIR);
  if (key(storageRoot) !== key(path.resolve(isolation.USER_DATA_DIR)) ||
      key(storageRoot) === key(path.resolve(isolation.REAL_USER_DATA))) {
    throw new Error("Canonical isolated storage must differ from the installed profile");
  }
  app.setPath("userData", storageRoot);
  app.setPath("sessionData", storageRoot);
  visual = require("./test-visual-utils");
  evidence = path.resolve(process.env.MARKALOO_READING_JUMPS_EVIDENCE ||
    path.join(root, "screenshots", "reading-jumps-" + token));
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.mkdirSync(evidence); // Existing evidence is not an invocation-local result.
  fixtureDirectory = visual.tempDir("mdv-reading-jumps-");
  // Neither shared exit sweep may delete a watched file before Main teardown.
  visual.REGISTERED_TEMP_DIRS.delete(fixtureDirectory);
  receipt.evidence = evidence;
  receipt.profile = storageRoot;
  receipt.fixtureDirectory = fixtureDirectory;
  persist();
} catch (error) { emergency(error); }

const { OwnedDialogs } = require("../src/owned-dialogs");
const { SUPPORTED_EXTENSIONS, isLargeDocument, LARGE_DOC_BUDGET_MS } = require("../src/file-helpers");
const payload = require("./reading-jump-native-controls");
const fixture = path.join(fixtureDirectory, "instant-requests.md");
const expectedChooser = {
  properties: ["openFile", "multiSelections"],
  filters: [
    { name: "Markdown Files", extensions: SUPPORTED_EXTENSIONS.markdown.map(ext => ext.slice(1)) },
    { name: "Mermaid Files", extensions: SUPPORTED_EXTENSIONS.mermaid.map(ext => ext.slice(1)) },
    { name: "All Files", extensions: ["*"] },
  ],
};
const nativeGuards = {};
for (const method of ["showOpenDialog", "showOpenDialogSync", "showSaveDialog", "showSaveDialogSync",
  "showMessageBox", "showMessageBoxSync", "showErrorBox"]) {
  const guard = method === "showOpenDialog" ? (...args) => {
    const allowance = chooserAllowance;
    chooserAllowance = null;
    if (!allowance || ending || allowance.window !== win || args.length !== 2 ||
        args[0] !== win || !isDeepStrictEqual(args[1], expectedChooser)) {
      emergency(new Error("Unexpected native Open chooser or changed chooser owner/options"));
    }
    chooserCalls++;
    allowance.consumed = true;
    return Promise.resolve({ canceled: false, filePaths: [fixture] });
  } : () => emergency(new Error("Unexpected native dialog: " + method));
  Object.defineProperty(dialog, method, { value: guard, writable: false, configurable: false });
  nativeGuards[method] = guard;
}
const ownedDialogGuard = () => emergency(new Error("Unexpected Main-owned dialog"));
Object.defineProperty(OwnedDialogs.prototype, "show", {
  value: ownedDialogGuard, writable: false, configurable: false,
});
const guardedExit = app.exit.bind(app);
Object.defineProperty(app, "exit", {
  value(code) {
    if (!exiting) return fatal(new Error("Unexpected app.exit before the owned terminal path"));
    return guardedExit(failure || assertions.some(row => !row.ok) ? 1 : code);
  },
  writable: false, configurable: false,
});
app.on("before-quit", event => {
  if (!exiting) {
    event.preventDefault();
    if (!tearingDown) fatal(new Error("Unexpected app.quit before owned teardown"));
  }
});

function assertStorage(includeSession) {
  const paths = [app.getPath("userData"), app.getPath("sessionData")];
  if (includeSession) paths.push(session.defaultSession.getStoragePath());
  if (paths.some(value => typeof value !== "string" ||
      key(path.resolve(value)) !== key(storageRoot) ||
      key(fs.realpathSync.native(value)) !== key(storageRoot))) {
    throw new Error("Main Chromium storage escaped the canonical isolated profile");
  }
}
app.once("ready", () => {
  try { assertStorage(true); } catch (error) { fatal(error); }
});

function installReadingWheelPublisherBoundary() {
  const owned = window, property = "__readingJumpPublisherBoundary";
  if (Object.hasOwn(owned, property)) throw Error("Preexisting reading publisher instrumentation");
  const nativeAdd = owned.addEventListener, nativeRemove = owned.removeEventListener;
  let original = null, wrapper = null, observer = null, registrations = 0, installed = false, fault = null;
  const capture = options => typeof options === "boolean" ? options : !!options?.capture;
  const observeError = (current, error, phase) => {
    try { current?.error(error, phase); } catch { /* Observation must not replace publisher behavior. */ }
  };
  const read = () => ({
    ok: registrations === 1 && installed && !fault && original === owned.publishReadingViewportInput &&
      owned.addEventListener === add && owned.removeEventListener === remove,
    registrations, installed, fault, exactFunction: original === owned.publishReadingViewportInput,
    capture: true, passive: true, originalPosition: true,
  });
  function add(...args) {
    const [type, callback, options] = args;
    if (this !== owned || type !== "wheel" || typeof callback !== "function" ||
        (callback !== original && callback !== owned.publishReadingViewportInput)) {
      return Reflect.apply(nativeAdd, this, args);
    }
    registrations++;
    const expected = options && typeof options === "object" &&
      options.capture === true && options.passive === true && !options.once && !options.signal;
    if (registrations !== 1 || !expected) {
      fault ||= "Missing, duplicate or unexpected publisher registration";
      observeError(observer, Error(fault), "registration");
    }
    if (!original && expected) {
      original = callback;
      wrapper = function (...publisherArgs) {
        const current = observer, event = publisherArgs[0];
        let scope = null, threw = false, error;
        try { scope = current?.before(event); }
        catch (caught) { observeError(current, caught, "before"); }
        try { return Reflect.apply(original, this, publisherArgs); }
        catch (caught) { threw = true; error = caught; throw caught; }
        finally {
          try { current?.after(event, scope, threw, error); }
          catch (caught) { observeError(current, caught, "after"); }
        }
      };
    }
    const forwarded = [...args], mapped = callback === original && capture(options);
    if (mapped) forwarded[1] = wrapper;
    try {
      const result = Reflect.apply(nativeAdd, this, forwarded);
      if (mapped) installed = true;
      return result;
    } catch (error) {
      fault ||= "Publisher registration threw";
      observeError(observer, error, "registration"); throw error;
    }
  }
  function remove(...args) {
    const mapped = this === owned && args[0] === "wheel" && args[1] === original && capture(args[2]);
    const forwarded = [...args];
    if (mapped) forwarded[1] = wrapper;
    const result = Reflect.apply(nativeRemove, this, forwarded);
    if (mapped) {
      installed = false;
      observeError(observer, Error("Publisher registration removed"), "registration");
    }
    return result;
  }
  owned.addEventListener = add;
  owned.removeEventListener = remove;
  Object.defineProperty(owned, property, { value: Object.freeze({
    registration: read,
    bind(current) {
      if (!read().ok || observer || !current || ["before", "after", "error"].some(name => typeof current[name] !== "function")) {
        throw Error("Exact original publisher registration/observer is unavailable");
      }
      observer = current;
    },
    owns: current => observer === current,
    release(current) {
      if (observer !== current) return false;
      observer = null; return true;
    },
  }), configurable: false, writable: false });
}

function installDialogGuard(guardToken, marker) {
  if (window !== window.top) return;
  const property = "__readingJumpExecutorGuard";
  const locked = (object, name, value) => {
    const entry = Object.getOwnPropertyDescriptor(object, name);
    return entry?.value === value && entry.writable === false && entry.configurable === false;
  };
  if (Object.hasOwn(window, property)) {
    const existing = window[property]();
    if (existing.token !== guardToken || !existing.intact) throw Error("Conflicting dialog guard");
    return;
  }
  const fail = kind => { console.error(marker + kind); throw Error("Unexpected dialog: " + kind); };
  const guards = [];
  for (const [object, names] of [[window, ["alert", "confirm", "prompt"]],
    [HTMLDialogElement.prototype, ["show", "showModal"]]]) {
    for (const name of names) {
      const guard = () => fail(name);
      Object.defineProperty(object, name, { value: guard, writable: false, configurable: false });
      guards.push([object, name, guard]);
    }
  }
  const openDialogs = () => [...document.querySelectorAll(
    'dialog[open], .note-dialog-overlay.visible, [aria-modal="true"].visible')].map(node => node.id);
  const observer = new MutationObserver(() => {
    if (openDialogs().length) fail("unexpected open DOM dialog");
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["open", "class", "aria-modal"] });
  const read = () => ({
    token: guardToken, url: location.href,
    intact: guards.every(([object, name, guard]) => locked(object, name, guard)) &&
      locked(window, property, read), open: openDialogs(),
  });
  Object.defineProperty(window, property, { value: read, writable: false, configurable: false });
}

async function readRenderer() {
  if (document.readyState !== "complete" || typeof window.markaloo?.getQuitApprovalGeneration !== "function" ||
      typeof window.getReloadRequestSession !== "function" || !window.CustomTabs ||
      typeof scrollElementIntoView !== "function" || !document.getElementById("openFile")) return null;
  return {
    guard: window.__readingJumpExecutorGuard?.(),
    generation: await window.markaloo.getQuitApprovalGeneration(),
    pageSession: window.getReloadRequestSession(),
    clean: !hasUnsavedWork(),
  };
}

app.on("browser-window-created", (_event, target) => {
  windows.add(target);
  if (win) return fatal(new Error("Additional or replacement BrowserWindow"));
  win = target;
  contents = target.webContents;
  receipt.windowId = win.id;
  receipt.webContentsId = contents.id;
  sentinel = visual.startErrorSentinel(win, { label: "reading-jumps-" + token, trapExternal: false });
  win.on("closed", () => {
    closed = true; receipt.lifecycle.push("window-closed");
    if (!tearingDown) fatal(new Error("Owned Main window closed during the payload"));
  });
  contents.on("destroyed", () => {
    destroyed = true; receipt.lifecycle.push("webContents-destroyed");
    if (!tearingDown) fatal(new Error("Owned webContents destroyed during the payload"));
  });
  contents.on("render-process-gone", (_event, details) => {
    if (!tearingDown) fatal(new Error("Owned renderer exited: " + details.reason));
  });
  contents.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace && (url !== indexURL || ++navigationCalls !== 1)) {
      fatal(new Error("Unexpected Main document navigation"));
    }
  });
  contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && !tearingDown) fatal(new Error("Main load failed: " + code + " " + description));
  });
  contents.on("console-message", details => {
    if (details?.message?.startsWith(guardMarker)) fatal(new Error(details.message));
  });
  contents.debugger.attach("1.3");
  contents.debugger.on("detach", () => {
    if (!tearingDown) fatal(new Error("Owned pre-document dialog guard lost its debugger"));
  });
  contents.debugger.on("message", (_event, method) => {
    if (method === "Page.javascriptDialogOpening") fatal(new Error("Unexpected JavaScript dialog"));
  });
  // Queue both commands before Main loads; do not wait for an ACK that may
  // itself need navigation. Return Main's exact original load Promise.
  guardCommands = Promise.all([
    bounded(contents.debugger.sendCommand("Page.enable"), "dialog Page.enable"),
    bounded(contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${installReadingWheelPublisherBoundary.toString()})();(${installDialogGuard.toString()})(${JSON.stringify(token)},${JSON.stringify(guardMarker)})`,
      runImmediately: true,
    }), "pre-document dialog guard"),
  ]);
  guardCommands.catch(fatal);
  const loadFile = win.loadFile;
  Object.defineProperty(win, "loadFile", {
    value(...args) {
      if (this !== win || ++loadCalls !== 1 || args.length !== 1 || args[0] !== indexPath) {
        emergency(new Error("Unexpected Main loadFile owner/path"));
      }
      const loading = Reflect.apply(loadFile, win, args);
      loading.then(() => { receipt.mainLoadCompleted = true; }, fatal);
      return loading;
    },
    writable: false, configurable: false,
  });
});

function assertOwner() {
  assertStorage(true);
  const all = BrowserWindow.getAllWindows();
  const state = main.__shutdown.state();
  if (failure || ending || !win || win.isDestroyed() || contents.isDestroyed() ||
      win.webContents !== contents || all.length !== 1 || all[0] !== win ||
      BrowserWindow.fromWebContents(contents) !== win || contents.getURL() !== indexURL ||
      navigationCalls !== 1 || state.renderer !== "ready" ||
      (owner && (state.rendererGeneration !== owner.generation || state.rendererPageSession !== owner.pageSession)) ||
      Object.entries(nativeGuards).some(([name, guard]) => dialog[name] !== guard) ||
      !shellGuards || Object.entries(shellGuards).some(([name, guard]) => electron.shell[name] !== guard) ||
      OwnedDialogs.prototype.show !== ownedDialogGuard) throw new Error("Main/window/page/guard ownership changed");
}

async function execute(code) {
  assertOwner();
  const guard = await bounded(contents.executeJavaScript(`window[${JSON.stringify(guardKey)}]()`, true), "guard acknowledgement");
  if (guard.token !== token || guard.url !== indexURL || guard.intact !== true || guard.open.length) {
    throw new Error("Embedded dialog guard missing, replaced or open");
  }
  const result = await bounded(contents.executeJavaScript(code, true), "owned renderer request");
  assertOwner();
  return result;
}

async function capture(name) {
  assertOwner();
  const shared = await bounded(visual.captureScreenshot(win, "reading-jumps-" + token + "-" + name), "owned screenshot");
  if (!shared || !fs.existsSync(shared)) throw new Error("Missing fresh shared screenshot: " + name);
  const file = path.join(evidence, path.basename(shared));
  fs.copyFileSync(shared, file);
  receipt.screenshots.push({ name, path: file, sharedPath: shared, sha256: digest(file) });
  persist();
}

function prepareTrustedInput(kind, controlToken) {
  if (Object.hasOwn(window, "__readingJumpInputControl")) throw Error("Preexisting trusted-input control");
  const host = document.createElement("div"), previousFocus = document.activeElement;
  host.tabIndex = -1;
  host.dataset.readingJumpInput = controlToken;
  host.style.cssText = "width:240px;height:80px;overflow:auto;overscroll-behavior:contain";
  const child = document.createElement("div");
  child.style.cssText = "width:1200px;height:40px";
  child.textContent = "Owned horizontal input witness";
  host.appendChild(child);
  viewer.insertBefore(host, viewer.firstElementChild.nextElementSibling);
  const scroller = getViewerScroller();
  host.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
  if (kind === "home") scroller.scrollTop = 0;
  else host.scrollLeft = 200;
  host.focus({ preventScroll: true });
  const visual = window.visualViewport;
  const offsets = () => [scrollX, scrollY, visual.offsetLeft, visual.offsetTop, visual.pageLeft, visual.pageTop,
    contentWrapper.scrollLeft, contentWrapper.scrollTop, viewer.scrollLeft, viewer.scrollTop];
  const rect = host.getBoundingClientRect();
  const point = { x: Math.round(rect.left + 20), y: Math.round(rect.top + 20) };
  const permit = readingViewport.capturePermit();
  const state = { kind, token: controlToken, host, permit, offsets, before: offsets(),
    innerBefore: host.scrollLeft, events: [], point, scroller,
    boundary: scroller.scrollTop === 0 && offsets().every(value => value === 0) };
  const inputWindow = window, inputDocument = document, inputViewport = readingViewport;
  const inputTabs = window.CustomTabs, inputTab = inputTabs?.getActiveTab?.();
  const originalVisibility = document.visibilityState, originalHidden = document.hidden;
  const originalBefore = state.before, originalOffsets = [...state.before];
  const originalInner = [host.scrollLeft, host.scrollTop], originalPoint = [point.x, point.y];
  state.prepareFrames = () => {
    if (kind !== "wheel" || state.framePreparation) throw Error("Unexpected or repeated wheel frame preparation");
    const record = state.framePreparation = { status: "pending", requestedAt: performance.now(),
      scope: "two nested rAF scheduling callbacks only; not compositor readiness or settlement",
      frames: [], validations: [], cancelledHandles: [] };
    return new Promise((resolve, reject) => {
      const handles = new Set(), boundary = inputWindow.__readingJumpPublisherBoundary;
      const inputTypes = ["wheel", "pointerdown", "touchstart", "keydown", "beforeinput", "compositionstart"];
      let settled = false, timer = null, guardsLive = false, phase = "preparing", failure = null;
      let candidate = null, inPublisher = null, observedEvent = null, observations = 0;
      const poison = reason => { failure ||= String(reason?.stack || reason); };
      const releaseGuards = () => {
        if (!guardsLive) return;
        inputWindow.removeEventListener("reading-viewport-invalidated", retired);
        inputWindow.removeEventListener("pagehide", pagehide);
        inputWindow.removeEventListener("error", observationError);
        inputWindow.removeEventListener("unhandledrejection", observationError);
        for (const type of inputTypes) inputWindow.removeEventListener(type, inputGuard, true);
        if (!boundary.release(publisherObserver)) poison("Publisher observer ownership changed at release");
        guardsLive = false;
      };
      const finish = error => {
        if (settled) return false;
        settled = true;
        for (const handle of handles) { cancelAnimationFrame(handle); record.cancelledHandles.push(handle); }
        handles.clear();
        if (timer !== null) clearTimeout(timer);
        record.status = error ? "failed" : "completed";
        record.finishedAt = performance.now();
        if (error) {
          poison(error); phase = "failed"; releaseGuards();
          record.error = String(error.stack || error); reject(error);
        } else { phase = "prepared"; resolve({ ok: true, ...record }); }
        return true;
      };
      const retired = () => {
        if (inPublisher && candidate === inPublisher) {
          inPublisher.retirements++;
          if (inPublisher.retirements !== 1) poison("Extra retirement inside publisher invocation");
        } else poison("Retirement outside admitted publisher invocation");
        if (!settled) finish(Error("Wheel frame preparation retired"));
      };
      const pagehide = () => {
        poison("Page retired");
        if (!settled) finish(Error("Wheel frame preparation retired"));
      };
      const observationError = () => {
        poison("Window error during wheel ownership fence");
        if (!settled) finish(Error("Wheel frame preparation observed an error"));
      };
      const inputGuard = event => {
        if (!event.isTrusted) return;
        if (event.type !== "wheel" || event !== candidate?.event || !candidate.completed ||
            event !== observedEvent || observations !== 1) poison("Competing or unassociated input");
      };
      const validate = (stage, afterPublisher = false) => {
        const now = offsets(), rect = host.getBoundingClientRect();
        const checks = {
          window: window === inputWindow && document === inputDocument,
          owner: window.CustomTabs === inputTabs && !!inputTab && inputTabs.getActiveTab() === inputTab,
          state: window.__readingJumpInputControl === state && state.token === controlToken &&
            state.kind === kind && state.offsets === offsets,
          host: state.host === host && host.isConnected && host.ownerDocument === inputDocument &&
            host.dataset.readingJumpInput === controlToken && getViewerScroller() === scroller && state.scroller === scroller,
          permit: readingViewport === inputViewport && state.permit === permit &&
            inputViewport.isPermitCurrent(permit) === !afterPublisher,
          registration: inputWindow.__readingJumpPublisherBoundary === boundary &&
            boundary?.registration().ok === true && boundary.owns(publisherObserver),
          point: state.point === point && point.x === originalPoint[0] && point.y === originalPoint[1] &&
            Math.round(rect.left + 20) === originalPoint[0] && Math.round(rect.top + 20) === originalPoint[1] &&
            host.contains(document.elementFromPoint(point.x, point.y)),
          focus: document.activeElement === host && document.hasFocus() &&
            document.visibilityState === originalVisibility && document.hidden === originalHidden,
          inner: state.innerBefore === originalInner[0] && (afterPublisher ||
            (host.scrollLeft === originalInner[0] && host.scrollTop === originalInner[1])),
          outer: state.before === originalBefore && state.before.length === originalOffsets.length &&
            state.before.every((value, i) => value === originalOffsets[i]) &&
            now.length === originalOffsets.length && now.every((value, i) => value === originalOffsets[i]),
          noInput: afterPublisher || state.events.length === 0,
        };
        record.validations.push({ phase: stage, at: performance.now(), checks,
          inner: [host.scrollLeft, host.scrollTop], outer: now, point: { x: point.x, y: point.y } });
        const failed = Object.keys(checks).filter(key => !checks[key]);
        if (failed.length) throw Error("Wheel frame preparation changed setup: " + failed.join(","));
      };
      const publisherObserver = {
        before(event) {
          try {
            if (!guardsLive || failure || phase !== "armed" || candidate || inPublisher) {
              throw Error("Unarmed, poisoned, duplicate or nested publisher candidate");
            }
            validate("before-publisher");
            if (event.type !== "wheel" || event.isTrusted !== true || !host.contains(event.target) ||
                !event.composedPath().includes(host) || event.clientX !== point.x || event.clientY !== point.y ||
                !event.deltaX || event.deltaY !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
              throw Error("Delivered wheel does not match the owned event conditions");
            }
            candidate = { event, beforeCurrent: true, retirements: 0, completed: false, threw: false };
            inPublisher = candidate;
            return candidate;
          } catch (error) { poison(error); return null; }
        },
        after(event, scope, threw, error) {
          if (!scope) { if (threw) poison(error); return; }
          try {
            if (scope !== candidate || scope !== inPublisher || event !== scope.event) {
              throw Error("Publisher invocation identity changed");
            }
            scope.threw = threw;
            if (threw) throw error;
            if (scope.retirements !== 1) throw Error("Publisher did not retire exactly once");
            validate("after-publisher", true);
            scope.completed = true;
          } catch (caught) { poison(caught); }
          finally { if (inPublisher === scope) inPublisher = null; }
        },
        error(error, stage) { poison("Publisher observation " + stage + ": " + String(error?.stack || error)); },
      };
      state.armWheel = () => {
        try {
          if (phase !== "prepared" || failure || !guardsLive) throw Error("Wheel preparation cannot arm");
          validate("arm");
          phase = "armed";
          return { ok: true, phase, registration: boundary.registration(),
            environment: "INSTRUMENTED/DIAGNOSTIC-ONLY", atomicSend: false };
        } catch (error) { poison(error); throw error; }
      };
      state.observePublisherEvent = event => {
        observations++;
        if (observations !== 1 || candidate?.event !== event || !candidate.completed || inPublisher) {
          poison("Observer did not match the exact completed publisher Event");
        } else { observedEvent = event; phase = "observed"; }
      };
      state.fenceSnapshot = () => {
        // Polls may precede delivery; only an associated in-call retirement changes the required authority.
        const transitioned = (candidate?.retirements || 0) > 0;
        try { validate("live-snapshot", transitioned); } catch (error) { poison(error); }
        return {
          ok: guardsLive && phase === "observed" && !failure && observations === 1 &&
            candidate?.event === observedEvent && candidate?.completed === true &&
            candidate.beforeCurrent === true && candidate.retirements === 1 && !candidate.threw && !inPublisher,
          live: guardsLive, phase, failure, observations,
          beforeCurrent: candidate?.beforeCurrent === true, sameEvent: !!candidate && candidate.event === observedEvent,
          retirements: candidate?.retirements || 0, completed: candidate?.completed === true,
          environment: "INSTRUMENTED/DIAGNOSTIC-ONLY",
        };
      };
      state.closeFence = () => {
        if (!settled) finish(Error("Wheel frame preparation cancelled: owned-input-cleanup"));
        releaseGuards(); phase = "closed";
      };
      state.cancelPreparation = reason => {
        const error = Error("Wheel frame preparation cancelled: " + reason);
        poison(error);
        if (!settled) return finish(error);
        const wasLive = guardsLive;
        releaseGuards(); phase = "closed"; return wasLive;
      };
      const queueFrame = number => {
        const handle = requestAnimationFrame(timestamp => {
          if (settled || !handles.delete(handle)) return;
          try {
            if (!Number.isFinite(timestamp)) throw Error("Wheel frame callback lacks its native timestamp");
            validate("frame-" + number);
            record.frames.push({ number, timestamp, observedAt: performance.now() });
            if (number === 1) queueFrame(2);
            else finish();
          } catch (error) { finish(error); }
        });
        handles.add(handle);
      };
      try {
        boundary?.bind(publisherObserver);
        if (!boundary?.owns(publisherObserver)) throw Error("Missing exact publisher registration witness");
        guardsLive = true;
        inputWindow.addEventListener("reading-viewport-invalidated", retired);
        inputWindow.addEventListener("pagehide", pagehide);
        inputWindow.addEventListener("error", observationError);
        inputWindow.addEventListener("unhandledrejection", observationError);
        for (const type of inputTypes) inputWindow.addEventListener(type, inputGuard, { capture: true, passive: true });
        timer = setTimeout(() => finish(Error("Wheel frame preparation exceeded its owned 9s await bound")), 9000);
        validate("requested");
        queueFrame(1);
      } catch (error) { finish(error); }
    });
  };
  const describe = node => node && ({ name: node.nodeName, id: node.id, className: String(node.className) });
  const surface = () => {
    const style = getComputedStyle(host), hit = document.elementFromPoint(point.x, point.y);
    return {
      at: performance.now(), connected: host.isConnected, documentMatches: host.ownerDocument === document,
      activeElement: describe(document.activeElement), focused: document.activeElement === host,
      documentHasFocus: document.hasFocus(), visibility: document.visibilityState, hidden: document.hidden,
      hitTest: { point, target: describe(hit), withinHost: host.contains(hit) },
      dimensions: { clientWidth: host.clientWidth, clientHeight: host.clientHeight,
        offsetWidth: host.offsetWidth, offsetHeight: host.offsetHeight,
        scrollWidth: host.scrollWidth, scrollHeight: host.scrollHeight },
      style: { overflowX: style.overflowX, overflowY: style.overflowY,
        direction: style.direction, writingMode: style.writingMode,
        scrollSnapType: style.scrollSnapType, scrollSnapAlign: style.scrollSnapAlign,
        scrollSnapStop: style.scrollSnapStop },
    };
  };
  const scrollObservation = { limit: 64, seen: 0, dropped: 0, truncated: false, samples: [] };
  const scrollListener = event => {
    scrollObservation.seen++;
    if (scrollObservation.samples.length === scrollObservation.limit) {
      scrollObservation.dropped++; scrollObservation.truncated = true; return;
    }
    scrollObservation.samples.push({ at: performance.now(), timeStamp: event.timeStamp,
      trusted: event.isTrusted, eventPhase: event.eventPhase,
      inner: [host.scrollLeft, host.scrollTop], outer: offsets() });
  };
  host.addEventListener("scroll", scrollListener, { passive: true });
  let heldEvent = null;
  const listener = event => {
    if (kind === "wheel") state.observePublisherEvent?.(event);
    heldEvent ||= event;
    state.events.push({
      type: event.type, trusted: event.isTrusted, owned: host.contains(event.target),
      path: event.composedPath().includes(host), key: event.key, ctrl: event.ctrlKey,
      alt: event.altKey, meta: event.metaKey, shift: event.shiftKey,
      cancelable: event.cancelable, defaultPreventedInCapture: event.defaultPrevented,
      deltaMode: event.deltaMode, eventPhaseInCapture: event.eventPhase, capturedAt: performance.now(),
      x: event.clientX, y: event.clientY, deltaX: event.deltaX, deltaY: event.deltaY,
      retiredInCapture: !readingViewport.isPermitCurrent(permit),
    });
  };
  state.beforeSurface = surface();
  state.observe = () => ({
    before: state.beforeSurface, after: surface(), scroll: { ...scrollObservation, samples: [...scrollObservation.samples] },
    // Called only by the executor's existing executeJavaScript reads, never a
    // capture microtask. Retain the actual event phase rather than assume it.
    postDispatch: heldEvent ? {
      observedBy: "owned executor executeJavaScript", at: performance.now(),
      eventPhase: heldEvent.eventPhase, defaultPrevented: heldEvent.defaultPrevented,
      cancelable: heldEvent.cancelable, type: heldEvent.type,
    } : { observedBy: "owned executor executeJavaScript", eventNotYetCaptured: true },
  });
  const type = kind === "wheel" ? "wheel" : "keydown";
  window.addEventListener(type, listener, { capture: true, passive: true });
  state.cleanup = () => {
    const ownsState = window.__readingJumpInputControl === state;
    state.finalFence = state.fenceSnapshot?.();
    state.closeFence?.();
    if (!state.closeFence) state.cancelPreparation?.("owned-input-cleanup");
    const observed = state.events.length;
    window.removeEventListener(type, listener, true);
    host.removeEventListener("scroll", scrollListener, false);
    state.scrollListenerRemoval = { requested: true, type: "scroll", capture: false,
      ownedHost: host.dataset.readingJumpInput === controlToken, at: performance.now() };
    // An untrusted cleanup-only probe cannot create reading intent. It proves
    // our listener is gone rather than treating removeEventListener as proof.
    window.dispatchEvent(new Event(type));
    if (ownsState || window.__readingJumpInputControl?.host !== host) host.remove();
    if (ownsState && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    if (ownsState) delete window.__readingJumpInputControl;
    return { listenerRemoved: state.events.length === observed, fixtureRemoved: !host.isConnected,
      stateRemoved: window.__readingJumpInputControl !== state };
  };
  window.__readingJumpInputControl = state;
  return { ok: document.activeElement === host && readingViewport.isPermitCurrent(permit) &&
      state.before.every(Number.isFinite) &&
      (kind === "wheel" ? host.scrollWidth > host.clientWidth &&
        host.scrollLeft > 0 && host.scrollLeft < host.scrollWidth - host.clientWidth &&
        point.x >= 0 && point.x < innerWidth && point.y >= 0 && point.y < innerHeight &&
        host.contains(document.elementFromPoint(point.x, point.y)) : state.boundary),
    kind, point, before: state.before, innerBefore: state.innerBefore,
    scrollWidth: host.scrollWidth, clientWidth: host.clientWidth, boundary: state.boundary,
    diagnosticOnly: true, surface: state.beforeSurface };
}

function readTrustedInput(controlToken) {
  const state = window.__readingJumpInputControl;
  if (!state || state.token !== controlToken) throw Error("Trusted-input owner changed");
  const after = state.offsets(), event = state.events[0];
  const common = state.events.length === 1 && event.trusted === true && event.owned && event.path &&
    event.retiredInCapture && !readingViewport.isPermitCurrent(state.permit) &&
    after.every((value, index) => value === state.before[index]);
  const movement = common && (state.kind === "wheel" ?
      event.type === "wheel" && event.x === state.point.x && event.y === state.point.y &&
        event.deltaX !== 0 && event.deltaY === 0 && state.host.scrollLeft !== state.innerBefore :
      event.type === "keydown" && event.key === "Home" && event.ctrl === true &&
        state.boundary && state.scroller.scrollTop === 0);
  const fence = state.kind === "wheel" ? state.fenceSnapshot?.() : null;
  return { ok: movement && (state.kind !== "wheel" || fence?.ok === true), fence,
    kind: state.kind, before: state.before, after, innerBefore: state.innerBefore,
    innerAfter: state.host.scrollLeft, events: state.events,
    diagnosticOnly: true, observation: state.observe() };
}

async function trustedInputs() {
  const input = (event, detail) => {
    assertOwner();
    const sent = { event, issuedAt: Date.now(), returned: false };
    (detail.sent ||= []).push(sent);
    contents.sendInputEvent(event);
    sent.returned = true;
  };
  for (const kind of ["wheel", "home"]) {
    const controlToken = token + "-" + kind, detail = { kind };
    try {
      win.focus(); contents.focus();
      detail.setup = await execute(`(${prepareTrustedInput.toString()})(${JSON.stringify(kind)},${JSON.stringify(controlToken)})`);
      if (detail.setup.ok !== true) throw new Error("Trusted-input setup did not establish its exact owned focus/scroll surface");
      if (kind === "wheel") {
        detail.preparation = await execute(`(() => {
          const state=window.__readingJumpInputControl;
          if(!state || state.token!==${JSON.stringify(controlToken)}) throw Error('Wheel preparation owner changed');
          return state.prepareFrames();
        })()`);
        if (detail.preparation.ok !== true) throw new Error("Wheel frame preparation did not complete");
        detail.arm = await execute(`(() => {
          const state=window.__readingJumpInputControl;
          if(!state || state.token!==${JSON.stringify(controlToken)}) throw Error('Wheel arm owner changed');
          return state.armWheel();
        })()`);
        if (detail.arm.ok !== true) throw new Error("Wheel original authority did not arm");
        // This is not atomic with delivery. The original-registration wrapper
        // must still prove authority immediately before production sees Event.
        input({ type: "mouseWheel", ...detail.setup.point, deltaX: -80, deltaY: 0 }, detail);
      } else {
        try { input({ type: "keyDown", keyCode: "Home", modifiers: ["control"] }, detail); }
        finally { input({ type: "keyUp", keyCode: "Home", modifiers: ["control"] }, detail); }
      }
      await bounded(waitFor(async () => {
        detail.witness = await execute(`(${readTrustedInput.toString()})(${JSON.stringify(controlToken)})`);
        return detail.witness.ok === true;
      }, "trusted " + kind + " delivery and synchronous retirement"), "trusted input observation");
    } catch (error) {
      detail.error = String(error.stack || error);
    } finally {
      try {
        const cleaned = await execute(`(() => {
          const state=window.__readingJumpInputControl;
          if(!state || state.token!==${JSON.stringify(controlToken)}) throw Error('Missing owned input cleanup');
          const observation=state.observe(), cleanup=state.cleanup();
          return {cleanup,observation,scrollListenerRemoval:state.scrollListenerRemoval,
            framePreparation:state.framePreparation,finalFence:state.finalFence};
        })()`);
        detail.cleanup = cleaned.cleanup;
        detail.cleanupObservation = cleaned.observation;
        detail.scrollListenerRemoval = cleaned.scrollListenerRemoval;
        detail.framePreparation = cleaned.framePreparation;
        detail.finalFence = cleaned.finalFence;
      } catch (error) { detail.cleanupError = String(error.stack || error); }
    }
    receipt.trustedInputs.push(detail);
    check(kind === "wheel" ? "trusted nested horizontal wheel retires its prior permit without outer travel" :
      "trusted Ctrl Home retires its prior permit at the no-travel reading boundary",
    detail.setup?.ok === true && detail.witness?.ok === true && !detail.error && !detail.cleanupError &&
      (kind !== "wheel" || detail.arm?.ok === true && detail.finalFence?.ok === true && detail.finalFence.live === true) &&
      Object.values(detail.cleanup).every(value => value === true), detail);
  }
}

async function run() {
  await bounded(waitFor(async () => {
    if (!win || !guardCommands || !receipt.mainLoadCompleted || !win.isVisible() ||
        main.__shutdown.state().renderer !== "ready") return false;
    await guardCommands;
    assertOwner();
    const state = await bounded(contents.executeJavaScript(`(${readRenderer.toString()})()`, true), "Main bridge admission");
    if (!state || state.guard?.token !== token || state.guard.intact !== true ||
        state.guard.url !== indexURL || state.guard.open.length || !state.clean) return false;
    const host = main.__shutdown.state();
    if (!Number.isSafeInteger(state.generation) || state.generation <= 0 ||
        state.generation !== host.rendererGeneration || !state.pageSession ||
        state.pageSession !== host.rendererPageSession) return false;
    owner = { generation: state.generation, pageSession: state.pageSession };
    return true;
  }, "sole observed production Main and bridge"), "Main startup");
  const preferences = contents.getLastWebPreferences();
  requireCheck("actual Main window uses its production isolated renderer",
    preferences.nodeIntegration === false && preferences.contextIsolation === true && preferences.sandbox === true &&
    loadCalls === 1 && navigationCalls === 1, { owner, preferences });
  requireCheck("isolated userdata starts without inherited session files", isolation.POST_WIPE_ENTRIES === 0);
  if (!(await visual.waitForExternalTrap(win))) throw new Error("Main external-open guards are not ready");
  const alive = await bounded(visual.proveSentinelAlive(win, sentinel), "live error sentinel");
  requireCheck("error sentinel proves both console and DOM channels", alive.console === true && alive.dom === true, alive);
  const cost = isLargeDocument(payload.fixtureMarkdown);
  requireCheck("owned payload fixture does not require large-document consent",
    cost.large === false && Number.isFinite(cost.estimatedMs) && cost.estimatedMs >= 0 &&
    cost.estimatedMs <= LARGE_DOC_BUDGET_MS, cost);
  const allowance = { window: win, consumed: false };
  chooserAllowance = allowance;
  try {
    await bounded(visual.admitTestDocument(win, fixture, payload.fixtureMarkdown,
      { externallyManagedChooser: true }), "production file admission and painted DOM");
  } finally { chooserAllowance = null; }
  requireCheck("production file-open consumes exactly its owned chooser", allowance.consumed === true && chooserCalls === 1);
  const admission = await execute(`(() => ({
    path: currentFilePath, heading: viewer.querySelector('h1')?.textContent,
    target: !!viewer.querySelector('#instant-focus-target'),
    note: !!viewer.querySelector('.noted-text[data-note-id="1"]'),
    clean: !hasUnsavedWork(), descriptor: window.CustomTabs.getDocumentDescriptor(),
    instrumentationAbsent: !Object.hasOwn(window, '__readingInstantControl')
  }))()`);
  requireCheck("production admission really paints the exact clean fixture and its targets",
    admission.path === fixture && admission.heading === "Instant request fixture" && admission.target && admission.note &&
    admission.clean && admission.instrumentationAbsent &&
    main.__shutdown.documentAdmissionIsCurrent(admission.descriptor?.ref), admission);
  await execute("window.__readingJumpOriginals={helper:scrollElementIntoView,native:Element.prototype.scrollIntoView,record:readingJumpRecord};true");
  const first = assertions.length;
  receipt.payload = await payload.run({ execute, capture, check });
  const expected = [
    "owned fixture really overflows and its target begins outside the reading viewport",
    "actual TOC route uses an exact instant native completion",
    "actual fragment route preserves its native destination",
    "actual Search Enter retains both request origins and only the final owner",
    "actual Notes document-target route remains active",
    "actual Find Note document-target route remains active",
    "real nested instant request moves both axes without a root-stop claim",
    "a real clipping-only ancestor refuses the record but does not suppress the jump",
    "old native Promise cleanup cannot affect a synchronous successor",
    "real current instant no-travel still has a completed native request",
    "request-local behavior did not change the app scroll style",
    "owned native instrumentation restores originals and retains raw request results",
  ];
  check("payload executes every declared case once and retains every raw callback receipt",
    isDeepStrictEqual(receipt.payload.map(row => row.name), expected) &&
    isDeepStrictEqual(assertions.slice(first).map(row => row.name), expected) &&
    receipt.payload.every(row => row.result?.ok === true), receipt.payload);
  const cleaned = await execute(`(() => {
    const originals=window.__readingJumpOriginals;
    const result={owned:!!originals,helper:scrollElementIntoView===originals?.helper,
      native:Element.prototype.scrollIntoView===originals?.native,
      record:readingJumpRecord===originals?.record,
      stateGone:!Object.hasOwn(window,'__readingInstantControl'),
      fixtureGone:!viewer.querySelector('[data-instant-control="nested"]')};
    delete window.__readingJumpOriginals;return result;
  })()`);
  check("payload really restores both originals and removes only its owned instrumentation",
    Object.values(cleaned).every(value => value === true), cleaned);
  check("all requested actual-app screenshots were captured",
    isDeepStrictEqual(receipt.screenshots.map(row => row.name), ["instant-toc", "instant-search", "instant-nested"]));
  await trustedInputs();
  payloadCompleted = true;
}

async function finish(error) {
  if (ending) { failure ||= error; return; }
  ending = true;
  if (error) {
    failure ||= error;
    check("standalone executor reaches its complete payload boundary", false, String(error.stack || error));
  }
  try {
    if (!sentinel) throw new Error("No observed Main error sentinel");
    receipt.sentinel = await bounded(sentinel.stop(), "final live-sentinel drain");
    check("no renderer/document errors, stalled sentinel or undeclared mute occurred",
      receipt.sentinel.hits.length === 0 && receipt.sentinel.stalls.length === 0 &&
      receipt.sentinel.mutes.length === 1 &&
      receipt.sentinel.mutes[0].reason === visual.LIVENESS_MUTE_REASON, receipt.sentinel);
  } catch (caught) {
    failure ||= caught;
    check("error sentinel completed its final drain", false, String(caught.stack || caught));
  }
  tearingDown = true;
  try {
    if (contents && !contents.isDestroyed()) {
      receipt.framePreparationTeardown = await bounded(contents.executeJavaScript(`(() => {
        const state=window.__readingJumpInputControl;
        if(!state || state.token!==${JSON.stringify(token + "-wheel")}) return {owned:false};
        const cancelled=state.cancelPreparation?.('executor-teardown') || false;
        return {owned:true,cancelled,status:state.framePreparation?.status};
      })()`, true), "owned frame preparation teardown");
    }
  } catch (caught) {
    failure ||= caught;
    check("owned pending frame preparation cleanup completes before teardown", false, String(caught.stack || caught));
  }
  receipt.beforeTeardown = main?.__shutdown?.state();
  for (const target of windows) if (!target.isDestroyed()) target.destroy();
  let teardownVerified = false;
  try {
    await bounded(waitFor(() => {
      const state = main?.__shutdown?.state();
      return !!win && closed && destroyed && win.isDestroyed() && contents.isDestroyed() &&
        state?.renderer === "unusable" && state.rendererUnusableReason === "webContents destroyed";
    }, "actual window, webContents and Main teardown"), "owned teardown");
    teardownVerified = true;
    receipt.afterTeardown = main.__shutdown.state();
    check("actual observed window and webContents destruction settle Main before fixture release",
      BrowserWindow.getAllWindows().length === 0 && [...windows].every(target => target.isDestroyed()),
      { lifecycle: receipt.lifecycle, main: receipt.afterTeardown });
  } catch (caught) {
    failure ||= caught;
    check("actual Main teardown is observed before releasing its watched fixture", false, String(caught.stack || caught));
  }
  if (teardownVerified) {
    const released = visual.releaseTempDir(fixtureDirectory);
    check("owned watched fixture is verifiably removed after Main teardown", released === true, fixtureDirectory);
    if (released) fixtureDirectory = null;
  }
  receipt.retainedFixture = fixtureDirectory;
  const external = visual ? await visual.readExternalOpens() : ["missing trap"];
  const shell = visual ? await visual.readShellOpens() : ["missing trap"];
  check("no actual Main external application route was called and its guards remain installed",
    external.length === 0 && shell.length === 0 && !!shellGuards &&
    Object.entries(shellGuards).every(([name, guard]) => electron.shell[name] === guard), { external, shell });
  check("payload and frozen product/executor bytes reach the terminal gate",
    payloadCompleted && Object.entries(receipt.sources).every(([file, sha]) => digest(path.join(root, file)) === sha));
  receipt.completed = payloadCompleted && teardownVerified && !fixtureDirectory && !failure &&
    assertions.length > 0 && assertions.every(row => row.ok);
  receipt.finishedAt = new Date().toISOString();
  persist();
  const passed = assertions.filter(row => row.ok).length;
  const footer = `=== reading jumps: ${passed}/${assertions.length} passed ===`;
  fs.writeSync(1, "READING_JUMPS_RECEIPT " + path.join(evidence, "reading-jumps-receipt.json") + "\n" + footer + "\n");
  reported = true;
  exiting = true;
  clearTimeout(watchdog);
  app.exit(receipt.completed ? 0 : 1);
}

try {
  receipt.sources = Object.fromEntries([
    ["src", "main.js"], ["src", "main-preload.js"], ["src", "renderer.js"],
    ["src", "custom-tabs.js"], ["src", "reading-viewport.js"],
    ["test", "test-visual-utils.js"], ["test", "test-userdata-isolation.js"],
    ["test", "reading-jump-native-controls.js"], ["test", "test-reading-jumps.js"],
  ].map(parts => [path.join(...parts), digest(path.join(root, ...parts))]));
  // Install the shared Main shell traps before production can create a host.
  visual.trapExternalOpens().then(ready => {
    if (ready !== true) fatal(new Error("Main external-open trap did not install"));
  }, fatal);
  shellGuards = { openExternal: electron.shell.openExternal, openPath: electron.shell.openPath };
  for (const [name, guard] of Object.entries(shellGuards)) {
    Object.defineProperty(electron.shell, name, { value: guard, writable: false, configurable: false });
  }
  requireCheck("entrypoint starts with no seed or unrelated BrowserWindow", BrowserWindow.getAllWindows().length === 0);
  main = require("../src/main.js");
  app.whenReady().then(async () => {
    try { await run(); await finish(); } catch (error) { await finish(error); }
  }).catch(emergency);
} catch (error) { fatal(error); }
