"use strict";

// First real-app history milestone. This is not a native-motion/arrival oracle.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createHash } = require("crypto");
const { isDeepStrictEqual } = require("util");
const { ReaderInspection } = require("./reading-history-inspection");
let app, BrowserWindow, dialog, shell;
let observedMain = null, observedContents = null, sentinel = null, evidence = null;
let chooserAllowance = null, chooserCalls = 0;
let completed = false, finishing = false, fatalExiting = false, ordinaryExiting = false, cleanExit = false;
const results = [], captures = [], keyboardObservations = [], noOpObservations = [];
const branchReplacementObservations = [];
const releaseHistoryObservations = [], releaseFailureObservations = [];
const producerObservations = [];
const root = path.resolve(__dirname, "..");
const digest = value => createHash("sha256").update(value).digest("hex");

function fatal(error) {
  if (fatalExiting) process.exit(2);
  fatalExiting = true;
  chooserAllowance = null;
  try { fs.writeSync(2, "FAIL reading-history fatal:  -> " + String(error?.stack || error) + "\n"); } catch (_) {}
  try { if (observedMain && !observedMain.isDestroyed()) observedMain.destroy(); } catch (_) {}
  try { if (app) app.exit(2); } finally { process.exit(2); }
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
process.once("exit", () => {
  if ((!ordinaryExiting || !cleanExit) && !process.exitCode) process.exitCode = 1;
});
const watchdog = setTimeout(() => fatal(new Error("reading-history startup-inclusive watchdog expired")), 180000);
function readerBranchReplacementEnabled(argv, windowsKeys, noOp) {
  const options = argv.filter(value => value.startsWith("--reader-branch"));
  if (options.length && (options.length !== 1 || options[0] !== "--reader-branch-replacement" || windowsKeys || noOp)) {
    throw new Error("Reader branch replacement requires exactly --reader-branch-replacement without another scenario");
  }
  return options.length === 1;
}
function readingHistoryNoopEnabled(argv, windowsKeys) {
  const options = argv.filter(value => value.startsWith("--reading-history"));
  if (options.length && (options.length !== 1 || options[0] !== "--reading-history-noop" || windowsKeys)) {
    throw new Error("Reading history no-op requires exactly --reading-history-noop without Windows keys");
  }
  return options.length === 1;
}
function windowsHistoryKeysEnabled(argv, platform) {
  const options = argv.filter(value => value.startsWith("--windows-history"));
  if (options.length && (options.length !== 1 || options[0] !== "--windows-history-keys" || platform !== "win32")) {
    throw new Error("Windows history keys require exactly --windows-history-keys on win32");
  }
  return options.length === 1;
}
let inspection, windowsHistoryKeys;
let readingHistoryNoop;
let readerBranchReplacement, releaseHistoryBatch, publicationProducers;
function releaseHistoryBatchEnabled(argv, otherScenario, holds) {
  const options = argv.filter(value => value.startsWith("--release-history"));
  if (options.length && (options.length !== 1 || options[0] !== "--release-history-batch" || otherScenario || holds)) {
    throw new Error("Release history requires exactly --release-history-batch without another scenario or inspection holds");
  }
  return options.length === 1;
}
function publicationProducersEnabled(argv, otherScenario, holds) {
  const options = argv.filter(value => value.startsWith("--publication"));
  if (options.length && (options.length !== 1 || options[0] !== "--publication-producers" ||
      otherScenario || holds || argv.some(value => /^--(?:reading-mode|mode-)/.test(value)))) {
    throw new Error("Publication producers require exactly --publication-producers without another scenario or inspection holds");
  }
  return options.length === 1;
}
try {
  inspection = new ReaderInspection(process.argv);
  windowsHistoryKeys = windowsHistoryKeysEnabled(process.argv, process.platform);
  readingHistoryNoop = readingHistoryNoopEnabled(process.argv, windowsHistoryKeys);
  readerBranchReplacement = readerBranchReplacementEnabled(process.argv, windowsHistoryKeys, readingHistoryNoop);
  releaseHistoryBatch = releaseHistoryBatchEnabled(process.argv,
    windowsHistoryKeys || readingHistoryNoop || readerBranchReplacement, inspection.enabled);
  publicationProducers = publicationProducersEnabled(process.argv,
    windowsHistoryKeys || readingHistoryNoop || readerBranchReplacement || releaseHistoryBatch, inspection.enabled);
} catch (error) { fatal(error); }
({ app, BrowserWindow, dialog, shell } = require("electron"));
if (!app) fatal(new Error("Use the separately authorized Electron entry, not plain Node"));

let profileRoot, originalTmpdir;
try {
  const requested = process.env.MARKALOO_READING_HISTORY_EVIDENCE;
  if (!requested || !path.isAbsolute(requested)) throw new Error("An absolute fresh evidence directory is required");
  evidence = fs.realpathSync.native(requested);
  const physicalRoot = fs.realpathSync.native(root), relative = path.relative(physicalRoot, evidence);
  const entry = fs.lstatSync(requested);
  const key = value => process.platform === "win32" ? value.toLowerCase() : value;
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
      key(evidence) !== key(path.resolve(requested)) || !entry.isDirectory() ||
      entry.isSymbolicLink() || fs.readdirSync(evidence).length !== 0) {
    throw new Error("Evidence must be a new empty physical directory inside this worktree");
  }
  const storage = path.resolve(os.tmpdir()), storageRelative = path.relative(physicalRoot, storage);
  if (!storageRelative || storageRelative.startsWith("..") || path.isAbsolute(storageRelative) ||
      key(fs.realpathSync.native(storage)) !== key(storage)) {
    throw new Error("Parent must scope native storage/TEMP/TMP to a physical directory inside this worktree");
  }
  profileRoot = path.join(evidence, "isolation");
  fs.mkdirSync(profileRoot);
  originalTmpdir = os.tmpdir;
  // Reuse the repository's pre-ready isolation, but keep all run files in this worktree.
  os.tmpdir = () => profileRoot;
} catch (error) { fatal(error); }
require("./test-userdata-isolation");
os.tmpdir = originalTmpdir;
const isolation = require("./test-userdata-isolation");
app.setPath("sessionData", isolation.USER_DATA_DIR);
const {
  startErrorSentinel, proveSentinelAlive, LIVENESS_MUTE_REASON,
} = require("./test-visual-utils");
const { OwnedDialogs } = require("../src/owned-dialogs");
const { SUPPORTED_EXTENSIONS, isLargeDocument } = require("../src/file-helpers");

const sourceNames = ["main.js", "main-preload.js", "renderer.js", "custom-tabs.js",
  "reading-history.js", "reading-viewport.js", "editor-scroll.js", "file-helpers.js",
  "index.html", "styles.css", "custom-styles.css", ...(publicationProducers ? ["custom-collapse.js"] : [])];
const sourceHashes = () => Object.fromEntries(sourceNames.map(name =>
  [name, digest(fs.readFileSync(path.join(root, "src", name)))]));
const initialSources = sourceHashes();
const paragraph = (label, count) => Array.from({ length: count }, (_, index) =>
  `${label} paragraph ${index}. ` + "Stable admitted source text keeps each reading point identifiable. ".repeat(8)).join("\n\n");
const markdown = [
  "# Native history Alpha", paragraph("Alpha", 8),
  ...(publicationProducers ? ["# Native history Mid", paragraph("Mid", 8)] : []),
  "## Native history Beta", paragraph("Beta", 12),
  "## Native history Gamma", "The unique nativehistoryneedle appears here.", paragraph("Gamma", 8),
  "## Native history Tail", paragraph("Tail", 8),
  ...(publicationProducers ? ["Before ![producer logo](data:image/png;base64," +
    fs.readFileSync(path.join(root, "assets", "app-icon.png")).toString("base64") + ") after."] : []),
].join("\n\n") + "\n";
const fixture = path.join(evidence, "history.md");
fs.writeFileSync(fixture, markdown);
const secondFixture = path.join(evidence, "history-second.md");
const secondMarkdown = publicationProducers ?
  markdown.replace("# Native history Mid", "| Alpha value | Description |\n| --- | --- |\n| 1 | Visible table |\n\n# Native history Mid")
    .replace("## Native history Tail", "| Gamma value | Description |\n| --- | --- |\n| 2 | Collapsible table |\n\n## Native history Tail") :
  markdown.replace(/Native history/g, "Other history");
if (releaseHistoryBatch || publicationProducers) fs.writeFileSync(secondFixture, secondMarkdown);
const chooserSequence = releaseHistoryBatch ? [fixture, secondFixture, fixture] :
  publicationProducers ? [fixture, secondFixture] : [fixture];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: ok ? undefined : detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}
function demand(name, ok, detail) {
  check(name, ok, detail);
  if (!ok) throw new Error(name + ": " + JSON.stringify(detail));
}
function liveMain() {
  return !!observedMain && !!observedContents && !observedMain.isDestroyed() &&
    !observedContents.isDestroyed() && observedMain.webContents === observedContents;
}
const chooserOptions = {
  properties: ["openFile", "multiSelections"],
  filters: [
    { name: "Markdown Files", extensions: SUPPORTED_EXTENSIONS.markdown.map(ext => ext.slice(1)) },
    { name: "Mermaid Files", extensions: SUPPORTED_EXTENSIONS.mermaid.map(ext => ext.slice(1)) },
    { name: "All Files", extensions: ["*"] },
  ],
};
const guards = {};
for (const method of ["showOpenDialog", "showOpenDialogSync", "showSaveDialog", "showSaveDialogSync",
  "showMessageBox", "showMessageBoxSync", "showErrorBox"]) {
  const guard = method === "showOpenDialog" ? (...args) => {
    const allowance = chooserAllowance;
    chooserAllowance = null;
    if (!allowance || allowance.consumed || !liveMain() || !guardsIntact() ||
        args.length !== 2 || args[0] !== observedMain || allowance.window !== observedMain ||
        chooserCalls >= chooserSequence.length || allowance.fixture !== chooserSequence[chooserCalls] ||
        !isDeepStrictEqual(args[1], chooserOptions)) {
      return fatal(new Error("Unexpected native chooser or changed actual Open contract"));
    }
    allowance.consumed = true;
    chooserCalls++;
    return Promise.resolve({ canceled: false, filePaths: [allowance.fixture] });
  } : () => fatal(new Error("Unexpected native dialog: " + method));
  guards[method] = guard;
  Object.defineProperty(dialog, method, { value: guard, writable: false, configurable: false });
}
const blockOwned = () => fatal(new Error("Unexpected Main-owned dialog"));
Object.defineProperty(OwnedDialogs.prototype, "show", { value: blockOwned, writable: false, configurable: false });
const blockExternal = () => fatal(new Error("History milestone must not open another application"));
for (const method of ["openExternal", "openPath"]) {
  Object.defineProperty(shell, method, { value: blockExternal, writable: false, configurable: false });
}
const originalExit = app.exit.bind(app);
const guardedExit = code => {
  if (!ordinaryExiting && !fatalExiting) return fatal(new Error("Unexpected app.exit before terminal accounting"));
  return originalExit(fatalExiting ? 2 : cleanExit && code === 0 ? 0 : 1);
};
Object.defineProperty(app, "exit", { value: guardedExit, writable: false, configurable: false });
app.on("before-quit", event => {
  event.preventDefault();
  if (!fatalExiting) fatal(new Error("Unexpected app.quit before terminal accounting"));
});
function guardsIntact() {
  return Object.entries(guards).every(([method, guard]) => dialog[method] === guard) &&
    OwnedDialogs.prototype.show === blockOwned && shell.openExternal === blockExternal &&
    shell.openPath === blockExternal && app.exit === guardedExit;
}
if (BrowserWindow.getAllWindows().length !== 0) fatal(new Error("A window existed before owned Main observation"));
app.once("browser-window-created", (_event, window) => {
  observedMain = window;
  observedContents = window.webContents;
  sentinel = startErrorSentinel(window, {
    label: "reading-history-first-" + path.basename(evidence), trapExternal: false,
    screenshotDirectory: evidence,
  });
});
require("../src/main.js");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(action, label, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out")), milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
function exec(code) {
  if (!liveMain() || !guardsIntact()) throw new Error("Lost the actual Main owner or unattended guards");
  return bounded(() => observedContents.executeJavaScript(code, true), "renderer action");
}
async function waitReady(label, expression) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await exec(expression)) return;
    await sleep(50);
  }
  throw new Error("Timed out waiting for prerequisite: " + label);
}
async function capture(name, logical = true) {
  const image = await bounded(() => observedContents.capturePage(), "capture " + name);
  const file = path.join(evidence, name + ".png");
  fs.writeFileSync(file, image.toPNG());
  if (logical) demand("capture exists: " + name, fs.statSync(file).size > 0);
  else if (fs.statSync(file).size === 0) throw new Error("Empty inspection capture: " + name);
  const record = { path: file, sha256: digest(fs.readFileSync(file)), viewed: false };
  captures.push(record);
  return record;
}

async function waitForPresentedCapture(label, ready) {
  return bounded(async () => {
    await waitReady(label, ready);
    await exec("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    if (!await exec(ready)) throw new Error(label + " readiness changed before acquisition");
  }, label);
}

async function waitForBranchCapture(point, heading, expectedFile = fixture, expectedSource = markdown) {
  // History completes at observed offsets, before TOC transitions or a presented frame.
    const ready = "(" + function branchFrameReady(point, heading, expectedFile, expectedSource) {
      if (currentFilePath !== expectedFile || originalMarkdown !== expectedSource) {
        throw new Error("Branch capture Source owner changed");
      }
      if (readingRenderCompletion !== null || loadingScreen.classList.contains("active") ||
          !window.readingLocationAdapter.available()) return false;
      if (readingDisplay?.source?.source !== expectedSource) throw new Error("Branch capture displayed Source changed");
      window.__readingHistoryNative.position(point);
      const headings = [...viewer.querySelectorAll("h1,h2,h3,h4,h5,h6")]
        .filter(node => node.isConnected && node.textContent.trim() === heading);
      const buttons = [...indexList.querySelectorAll("button.index-item")];
      const expected = buttons.filter(node => node.isConnected && node.textContent.trim() === heading);
      const active = buttons.filter(node => node.classList.contains("active"));
      const current = buttons.filter(node => node.getAttribute("aria-current") === "location");
      return indexPanel.classList.contains("visible") && headings.length === 1 && expected.length === 1 &&
        active.length === 1 && active[0] === expected[0] && current.length === 1 && current[0] === expected[0] &&
        !indexPanel.getAnimations({ subtree: true }).some(animation => animation.pending ||
          animation.playState === "running" || animation.playState === "paused");
    }.toString() + ")(" + [point, heading, expectedFile, expectedSource].map(value => JSON.stringify(value)).join(",") + ")";
  return waitForPresentedCapture("branch capture " + point, ready);
}

async function waitForReleaseCapture(name, closeState = null, oldPage = null) {
  const endpoints = {
    "release01-coalesced-tail": ["search-tail"],
    "release02-explicit-return": ["explicit-next"],
    "release03-issued-back": ["explicit-next"],
    "release04-failed-branch-retained": ["explicit-next"],
    "release05-stale-highlight-repair": ["repair-capture"],
    "release06-second-tab-gamma": ["second-gamma", "Other history Gamma"],
    "release07-independent-tabs": ["second-gamma", "Other history Gamma"],
    "release07b-cancel-close-question": null,
    "release07c-canceled-close-retained": null,
    "release08-reopened-empty": [],
    "release09-ten-location-cap": ["cap12", "Native history Tail"],
    "release10-renderer-lifetime-reset": [],
  };
  if (!Object.hasOwn(endpoints, name)) throw new Error("Unknown release capture: " + name);
  const second = name.startsWith("release06-") || name.startsWith("release07");
  const ready = "(" + function releaseFrameReady(name, file, source, endpoint, closeState, oldPage) {
    if (currentFilePath !== file || originalMarkdown !== source) throw new Error("Release capture Source owner changed");
    if (readingRenderCompletion !== null || loadingScreen.classList.contains("active") ||
        !window.readingLocationAdapter.available()) return false;
    const dirty = endpoint === null;
    const displayed = dirty ? closeState?.editor : source;
    if (readingDisplay?.source?.source !== displayed) throw new Error("Release capture displayed Source changed");
    if (dirty) {
      if (!closeState || !isEditMode) throw new Error("Release capture lost dirty Split ownership");
      const question = name === "release07b-cancel-close-question";
      const current = { tab: window.CustomTabs.getActiveTab().id, source: originalMarkdown,
        editor: markdownEditor.value, selection: [markdownEditor.selectionStart, markdownEditor.selectionEnd,
          markdownEditor.selectionDirection], dirty: hasUnsavedChanges, undo: structuredClone(undoHistory),
        redo: structuredClone(redoHistory), availability: window.readingHistoryControls.availability() };
      // The real modal disables history controls; Cancel must restore the exact original availability.
      const expected = question ? { ...closeState, availability: { back: false, forward: false } } : closeState;
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Release capture close state changed");
      const dialog = document.getElementById("appMessageDialog");
      if (!dialog || dialog.open !== question) return false;
      if (question && (document.getElementById("appMessageTitle")?.textContent !== "Close without saving?" ||
          document.querySelector('#appMessageButtons [data-dialog-choice="cancel"]')?.textContent !== "Cancel")) return false;
      if (dialog.getAnimations({ subtree: true }).some(a => a.pending || a.playState === "running" ||
          a.playState === "paused")) return false;
    } else {
      const state = window.__readingHistoryNative.documentState();
      if (state.edit || state.dirty) throw new Error("Release capture lost clean Reader ownership");
      if (endpoint.length) window.__readingHistoryNative.position(endpoint[0]);
      if (name === "release10-renderer-lifetime-reset" &&
          (typeof oldPage !== "string" || window.getReloadRequestSession() === oldPage)) {
        throw new Error("Release capture old renderer lifetime");
      }
      const visible = indexPanel.classList.contains("visible");
      if (!visible && name !== "release10-renderer-lifetime-reset") return false;
      if (visible) {
        const buttons = [...indexList.querySelectorAll("button.index-item")];
        const active = buttons.filter(node => node.classList.contains("active"));
        const current = buttons.filter(node => node.getAttribute("aria-current") === "location");
        if (active.length !== 1 || current.length !== 1 || active[0] !== current[0] || !active[0].isConnected) return false;
        // Search is centered; its query does not identify the TOC's top-of-viewport heading.
        const heading = endpoint[1] || active[0].textContent.trim();
        const headings = [...viewer.querySelectorAll("h1,h2,h3,h4,h5,h6")]
          .filter(node => node.isConnected && node.textContent.trim() === heading);
        const expected = buttons.filter(node => node.isConnected && node.textContent.trim() === heading);
        if (headings.length !== 1 || expected.length !== 1 || active[0] !== expected[0]) return false;
      }
    }
    return !indexPanel.getAnimations({ subtree: true }).some(a => a.pending ||
      a.playState === "running" || a.playState === "paused");
  }.toString() + ")(" + [name, second ? secondFixture : fixture, second ? secondMarkdown : markdown,
    endpoints[name], closeState, oldPage].map(value => JSON.stringify(value)).join(",") + ")";
  return waitForPresentedCapture("release capture " + name, ready);
}

async function inspectCheckpoint(checkpoint, point, imageName, logical, action) {
  const snapshot = () => exec("({ document: window.__readingHistoryNative.documentState()," +
    " position: window.__readingHistoryNative.position(" + JSON.stringify(point) + ")," +
    " focus: { id: document.activeElement?.id, tag: document.activeElement?.tagName } })");
  const before = await snapshot();
  let failure = null;
  try { await inspection.hold(observedMain, checkpoint); } catch (error) { failure = error; }
  const record = inspection.checkpoints.at(-1);
  record.action = action;
  record.before = { position: before.position, focus: before.focus };
  try {
    const after = await snapshot();
    record.after = { position: after.position, focus: after.focus };
    if (!isDeepStrictEqual(before.document, after.document) ||
        !isDeepStrictEqual(before.focus, after.focus) ||
        !isDeepStrictEqual(before.position.availability, after.position.availability)) {
      throw new Error("Reader inspection changed document, focus or history state");
    }
  } catch (error) {
    record.stateError = String(error.stack || error);
    failure = failure ? new AggregateError([failure, error], "Reader inspection state check failed") : error;
  }
  try {
    if (liveMain()) record.capture = await capture(imageName, logical && !failure);
    else throw new Error("Reader inspection owner was lost before checkpoint capture");
  } catch (error) {
    record.captureError = String(error.stack || error);
    failure = failure ? new AggregateError([failure, error], "Reader inspection capture failed") : error;
  }
  if (failure) {
    record.error = String(failure.stack || failure);
    throw failure;
  }
}

// This function is serialized into the real renderer; Node --check parses its body too.
function installHistoryProbe(releaseHistoryBatch = false) {
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const realControls = window.readingHistoryControls, adapter = window.readingLocationAdapter;
  const controlsState = readingHistoryControlState, realJump = scrollElementIntoView;
  const nativeIntoView = Element.prototype.scrollIntoView, nativeTo = Element.prototype.scrollTo;
  const tab = window.CustomTabs.getActiveTab(), jumps = [], traversals = [], saved = {};
  const input = { down: [], up: [], genuine: 0 };
  let pending = null, pendingListener = null;
  let issueHook = null, issuedBack = null, canceledRequest = null;
  ensure(controlsState?.core === realControls, "The installed toolbar must own the real history core");
  ensure(Object.isFrozen(adapter) && adapter.capture === captureReadingLocation &&
    typeof adapter.restore === "function" && adapter.available(),
    "The production location adapter must be installed, not a substitute");
  function intact() {
    ensure(window.readingHistoryControls === realControls && window.readingLocationAdapter === adapter &&
      Element.prototype.scrollIntoView === nativeIntoView && Element.prototype.scrollTo === nativeTo &&
      window.CustomTabs.getActiveTab() === tab, "A real production port or tab lifetime changed");
  }
  function location() {
    intact();
    const result = adapter.capture();
    ensure(result.status === "captured", "Real Source location unavailable: " + result.reason);
    return result.location;
  }
  function documentState() {
    intact();
    return { path: currentFilePath, source: originalMarkdown, displayed: readingDisplay.source.source,
      editor: markdownEditor.value, selection: [markdownEditor.selectionStart, markdownEditor.selectionEnd,
        markdownEditor.selectionDirection], dirty: hasUnsavedChanges, undo: undoHistory.length,
      redo: redoHistory.length, editorLeft: markdownEditor.scrollLeft, edit: isEditMode };
  }
  function position(name) {
    intact();
    const target = saved[name], scroller = getViewerScroller();
    ensure(target && target.text.alignment.nested.length === 0, "This first milestone requires a saved plain Reader point");
    const resolved = editorScroll.resolveVisibleText(target.text, scroller, readingPresentationContext());
    ensure(resolved.status === "resolved", "Real Source resolution failed: " + resolved.reason);
    const receipt = resolved.receipt, rects = [...receipt.range.getClientRects()];
    ensure(rects.length === 1 && editorScroll.isTextLocationCurrent(receipt), "Saved Source atom is not current and single-fragment");
    const bounds = scroller.getBoundingClientRect(), scale = scrollerScale(scroller);
    const top = (rects[0].top - bounds.top) / scale - scroller.clientTop;
    const result = { name, sourceKey: target.text.sourceKey, start: target.text.start, end: target.text.end,
      text: receipt.range.toString(), expectedText: target.text.display, top, expectedTop: target.text.alignment.top,
      left: scroller.scrollLeft, expectedLeft: target.horizontal.outer,
      visible: rects[0].bottom > bounds.top && rects[0].top < bounds.bottom,
      availability: realControls.availability(), scrollTop: scroller.scrollTop };
    ensure(result.text === result.expectedText && result.visible && Math.abs(top - result.expectedTop) <= 1 &&
      Math.abs(result.left - result.expectedLeft) <= 1, "Restored Source atom/alignment differs: " + JSON.stringify(result));
    return result;
  }
  function noOpState() {
    return structuredClone({
      document: { ...documentState(), undoValues: undoHistory, redoValues: redoHistory },
      source: location(),
      viewport: { top: getViewerScroller().scrollTop, left: getViewerScroller().scrollLeft,
        zoom: zoomLevel, cssZoom: getComputedStyle(viewer).zoom },
      availability: realControls.availability(),
      search: { value: searchInput.value, matches: searchMatches.length, index: currentMatchIndex,
        current: currentMatchEl !== null, term: pendingSearchTerm,
        request: pendingSearchRequest?.term ?? null, timer: searchDebounceTimer !== null },
      focus: { id: document.activeElement?.id, tag: document.activeElement?.tagName },
    });
  }
  // Observe genuine production results, returning the identical handle/Promise.
  // Neither adapter nor native scrolling methods are wrapped or replaced.
  const observedJump = function (...args) {
    const handle = Reflect.apply(realJump, this, args);
    jumps.push({ target: args[0], block: args[1], handle });
    if (issueHook) {
      const hook = issueHook;
      issueHook = null;
      hook(handle);
    }
    return handle;
  };
  const observedCore = Object.freeze({
    availability: realControls.availability, subscribe: realControls.subscribe,
    navigate(direction) {
      const before = location();
      const promise = realControls.navigate(direction);
      traversals.push({ direction, before, promise });
      return promise;
    },
  });
  scrollElementIntoView = observedJump;
  controlsState.core = observedCore;
  const onDown = event => input.down.push({ trusted: event.isTrusted, x: event.clientX, y: event.clientY,
    inScroller: event.composedPath().includes(getViewerScroller()) });
  const onUp = event => input.up.push({ trusted: event.isTrusted, x: event.clientX, y: event.clientY,
    inScroller: event.composedPath().includes(getViewerScroller()) });
  const onGenuine = () => { input.genuine++; };
  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("reading-history-input", onGenuine);
  window.__readingHistoryNative = {
    documentState, position, input,
    noOpState, noOpObservation: null, failedClippedObservation: null,
    save(name) { saved[name] = location(); return saved[name]; },
    remember(name, point) {
      intact();
      ensure(releaseHistoryBatch && point?.version === 1, "Only the release route may import a captured Source point");
      saved[name] = point;
      return true;
    },
    releaseCounts() { intact(); return { jumps: jumps.length, traversals: traversals.length }; },
    async releaseJump(index) {
      intact();
      const issued = jumps[index];
      ensure(issued?.handle?.request && issued.handle.completion, "An actual native request and its original completion are required");
      const record = await issued.handle.completion;
      intact();
      return { record, availability: realControls.availability(), position: location() };
    },
    armIssuedBack() {
      intact();
      ensure(releaseHistoryBatch && !issueHook && !issuedBack, "Only one release request-issued Back may be armed");
      issueHook = handle => {
        intact();
        const before = traversals.length;
        const button = document.getElementById("readingBackBtn");
        ensure(handle?.request && handle.completion && !button.disabled,
          "The first preview must issue its real native request before recovery");
        issuedBack = { jump: jumps.length - 1, before, requestIssued: true, consumerContinuationNotYetReached: true };
        button.click();
        ensure(traversals.length === before + 1, "Request-issued Back must dispatch exactly one real traversal");
      };
      return true;
    },
    async issuedBackResult() {
      intact();
      ensure(issuedBack && !issueHook, "The request-issued recovery hook must really have run");
      const record = await jumps[issuedBack.jump].handle.completion;
      const recovered = await traversals[issuedBack.before].promise;
      intact();
      ensure(recovered === true && record.status === "unrecordable" && record.reason === "superseded",
        "Recovery must supersede the actual preview completion, not commit an arrived destination");
      const result = { ...issuedBack, record, recovered, availability: realControls.availability() };
      issuedBack = null;
      return result;
    },
    armCanceledRequest() {
      intact();
      ensure(releaseHistoryBatch && !pendingListener, "The release cancel listener must not overlap another input observer");
      pendingListener = event => {
        intact();
        ensure(event.isTrusted && event.target === searchInput && pendingSearchRequest?.term === searchInput.value &&
          searchDebounceTimer !== null && pendingSearchRequest?.segment?.previewed === false,
          "Cancellation requires a genuine first input and its actual pending segment");
        canceledRequest = pendingSearchRequest;
        searchCloseBtn.click();
      };
      searchInput.addEventListener("input", pendingListener, { once: true });
      return true;
    },
    repairAndReplayCanceled() {
      intact();
      ensure(canceledRequest && pendingSearchRequest === null && pendingSearchTerm === null &&
        searchInput.value && searchMatches.length > 0, "A canceled old request and a different arrived search are required");
      const before = { jumps: jumps.length, location: location(), availability: realControls.availability() };
      flushPendingSearch(null, canceledRequest);
      resyncSearchAfterRender(readingViewport.capturePermit());
      ensure(pendingSearchRequest?.intent === null && pendingSearchRequest?.segment === null,
        "Highlight repair must not borrow the canceled navigation intent or segment");
      return before;
    },
    async failedClippedJump() {
      intact();
      const target = viewer, scroller = getViewerScroller();
      const geometry = () => {
        const sample = captureReadingJump(target), bounds = scroller.getBoundingClientRect();
        const scale = scrollerScale(scroller);
        return { connected: target.isConnected, owned: viewer.contains(target), separateScroller: target !== scroller,
          fragments: sample.witness, scrollport: [bounds.left + scroller.clientLeft * scale,
            bounds.top + scroller.clientTop * scale,
            bounds.left + (scroller.clientLeft + scroller.clientWidth) * scale,
            bounds.top + (scroller.clientTop + scroller.clientHeight) * scale],
          chain: sample.elements.map(item => ({ layout: item.layout, offset: item.offset,
            shape: item.shape, clip: item.clip })), root: sample.root, rootLayout: sample.rootLayout };
      };
      const observation = this.failedClippedObservation = {
        scenario: "connected-oversize-nearest", before: noOpState(), geometryBefore: null,
        calls: 0, requestPresent: false, completionPresent: false, committed: null, record: null,
        requestResult: null, after: null, geometryAfter: null, error: null,
      };
      const count = jumps.length;
      let failure = null;
      try {
        const g = observation.geometryBefore = geometry(), box = g.fragments[0], port = g.scrollport;
        ensure(g.connected && g.owned && g.separateScroller && g.fragments.length === 1 &&
          g.scrollport.every(Number.isFinite) && box.every(Number.isFinite) &&
          box[1] < port[1] && box[3] > port[3] && box[0] >= port[0] && box[2] <= port[2] &&
          observation.before.availability.forward,
          "The connected target must span both vertical scrollport edges without horizontal travel and retain Forward");
        const pending = readingHistory.jump(target, "nearest", readingViewport.beginIntent());
        const issued = jumps[count], handle = issued?.handle;
        observation.calls = jumps.length - count;
        observation.requestPresent = !!handle?.request;
        observation.completionPresent = !!handle?.completion;
        observation.reason = handle?.reason ?? null;
        ensure(observation.calls === 1 && issued.target === target && issued.block === "nearest" &&
          observation.requestPresent && observation.completionPresent,
          "The negative case must issue its real connected-target request and original completion exactly once");
        const settled = await Promise.allSettled([handle.request, pending, handle.completion]);
        observation.settlements = settled.map(result => result.status === "fulfilled" ?
          { status: result.status, value: result.value } : { status: result.status, error: String(result.reason) });
        observation.requestResult = settled[0].status === "fulfilled" ? settled[0].value : null;
        observation.committed = settled[1].status === "fulfilled" ? settled[1].value : null;
        observation.record = settled[2].status === "fulfilled" ? settled[2].value : null;
        intact();
        ensure(settled.every(result => result.status === "fulfilled") &&
          observation.requestResult?.interrupted === false && observation.committed === false &&
          observation.record?.status === "unrecordable" && observation.record.reason === "target-clipped",
          "The connected real request must complete natively but fail recording because its target is clipped");
      } catch (error) {
        observation.error = String(error.stack || error);
        failure = error;
      }
      try {
        observation.after = noOpState();
        observation.availability = observation.after.availability;
        observation.geometryAfter = geometry();
        if (!failure) ensure(JSON.stringify(observation.before) === JSON.stringify(observation.after) &&
          JSON.stringify(observation.geometryBefore) === JSON.stringify(observation.geometryAfter),
          "The clipped request must preserve exact Source viewport document selection history zoom and ancestor geometry");
      } catch (error) {
        if (!failure) observation.error = String(error.stack || error);
        observation.readbackError = String(error.stack || error);
        failure = failure ? new AggregateError([failure, error], "Clipped request and readback failed") : error;
      }
      if (failure) throw failure;
      return observation;
    },
    async jump(headingText) {
      intact();
      const targets = [...viewer.querySelectorAll("h1,h2")].filter(node => node.textContent === headingText);
      ensure(targets.length === 1, "The admitted heading must be unique");
      const buttons = [...indexList.querySelectorAll("button.index-item")]
        .filter(button => button.dataset.headerId === targets[0].id);
      ensure(buttons.length === 1 && indexPanel.classList.contains("visible"), "The real TOC button must exist in the open drawer");
      const count = jumps.length;
      buttons[0].click();
      ensure(jumps.length === count + 1, "The real TOC must issue exactly one document jump");
      const issued = jumps[count];
      ensure(issued.target === targets[0] && issued.block === "start" && issued.handle?.completion,
        "The real helper must retain the actual TOC target and completion");
      // The core registered its continuation before this post-click await.
      const record = await issued.handle.completion;
      ensure(record.status === "completed" && record.scope === "request-offsets" &&
        record.travel === "observed-travel", "The real request did not complete recordable travel: " + JSON.stringify(record));
      intact();
      return { target: targets[0].id, record, availability: realControls.availability() };
    },
    // Keep no-travel admission separate from the accepted travel-only probe.
    async samePositionJump(headingText) {
      intact();
      const targets = [...viewer.querySelectorAll("h1,h2")].filter(node => node.textContent === headingText);
      ensure(targets.length === 1 && targets[0].isConnected && viewer.contains(targets[0]),
        "The same-position heading must be unique, connected and owned");
      const buttons = [...indexList.querySelectorAll("button.index-item")]
        .filter(button => button.dataset.headerId === targets[0].id);
      ensure(buttons.length === 1 && indexPanel.classList.contains("visible"),
        "The same-position request requires the actual open-drawer TOC button");
      const observation = { target: targets[0].id, before: noOpState(), calls: 0, record: null, after: null };
      this.noOpObservation = observation;
      const before = observation.before;
      ensure(before.document.edit === false && !before.document.dirty &&
        before.viewport.zoom === 100 && Number(before.viewport.cssZoom) === 1 &&
        before.availability.back && before.availability.forward &&
        before.search.value === "" && before.search.matches === 0 && before.search.index === -1 &&
        !before.search.current && before.search.term === null && before.search.request === null && !before.search.timer,
      "The no-op requires a clean 100% Reader, empty Search and both history directions");
      const count = jumps.length;
      buttons[0].click();
      observation.calls = jumps.length - count;
      ensure(observation.calls === 1, "The same-position TOC must issue exactly one real jump");
      const issued = jumps[count], completion = issued.handle?.completion;
      ensure(issued.target === targets[0] && issued.block === "start" && completion,
        "The same-position request lost its actual target or completion");
      observation.record = await completion;
      ensure(observation.record?.status === "completed" && observation.record.scope === "request-offsets" &&
        observation.record.travel === "no-observed-travel",
      "The same-position request was not a genuine no-travel completion: " + JSON.stringify(observation.record));
      intact();
      ensure(jumps.length === count + 1, "An extra jump appeared during the same-position completion");
      observation.after = noOpState();
      ensure(JSON.stringify(before) === JSON.stringify(observation.after),
        "The no-op changed Source, viewport, document, exact Undo/Redo, Search, focus or history: " +
        JSON.stringify(observation));
      return observation;
    },
    async history(direction, departingName = null) {
      intact();
      const button = document.getElementById(direction === -1 ? "readingBackBtn" : "readingForwardBtn");
      ensure(!button.disabled, "The actual toolbar action must already be enabled");
      const count = traversals.length;
      button.click();
      ensure(traversals.length === count + 1 && traversals[count].direction === direction,
        "The actual toolbar must dispatch one exact scalar direction");
      const issued = traversals[count];
      if (departingName) saved[departingName] = issued.before;
      const result = await issued.promise;
      ensure(result === true, "The actual history consumer refused or failed the traversal");
      intact();
      return { result, availability: realControls.availability() };
    },
    dragSetup() {
      const scroller = getViewerScroller(), bounds = scroller.getBoundingClientRect(), scale = scrollerScale(scroller);
      const track = scroller.clientHeight, max = scroller.scrollHeight - track;
      const contentRight = bounds.left + (scroller.clientLeft + scroller.clientWidth) * scale;
      const gutterRight = bounds.right - parseFloat(getComputedStyle(scroller).borderRightWidth);
      const gutter = gutterRight - contentRight;
      const minimum = parseFloat(getComputedStyle(scroller, "::-webkit-scrollbar-thumb").minHeight) || 20;
      const height = Math.max(minimum, track * track / scroller.scrollHeight);
      const x = Math.round((contentRight + gutterRight) / 2);
      const y = Math.round(bounds.top + scroller.clientTop * scale +
        ((track - height) * scroller.scrollTop / max + height / 2) * scale);
      const hit = document.elementFromPoint(x, y);
      ensure(max > track && gutter >= 4 && height > 30 && hit && (hit === scroller || scroller.contains(hit)),
        "A real measurable scrollbar gutter/thumb is required; do not guess an input target");
      return { x, y, dy: 12, top: scroller.scrollTop, genuine: input.genuine,
        downs: input.down.length, ups: input.up.length, selected: window.getSelection().toString(),
        gutter: [contentRight, gutterRight], thumbHeight: height };
    },
    dragWitness(setup) {
      const scroller = getViewerScroller(), down = input.down[setup.downs], up = input.up[setup.ups];
      const current = location();
      const result = { top: scroller.scrollTop, before: setup.top, down, up, genuine: input.genuine,
        sourceChanged: current.text.start !== saved.B.text.start, selection: window.getSelection().toString() };
      ensure(result.top > setup.top + 30 && down?.trusted && down.inScroller && up?.trusted && up.inScroller &&
        down.x >= setup.gutter[0] && down.x <= setup.gutter[1] && input.genuine > setup.genuine &&
        result.sourceChanged && result.selection === setup.selected, "Manual scrollbar input/travel was not established: " + JSON.stringify(result));
      return result;
    },
    armPendingCancellation(term) {
      ensure(document.activeElement === searchInput && searchInput.value === "" && searchMatches.length === 0 &&
        pendingSearchTerm === null && searchDebounceTimer === null && realControls.availability().forward,
      "The first Search input must start empty at B-prime with Forward available");
      pendingListener = event => {
        pending = { trusted: event.isTrusted, owned: event.target === searchInput, term: searchInput.value,
          request: pendingSearchRequest?.term, timer: searchDebounceTimer !== null,
          first: pendingSearchRequest?.segment?.previewed === false,
          jumpCount: jumps.length, traversal: traversals.length, at: performance.now(),
          deadline: performance.now() + TIMING.searchDebounceDelay };
        try {
          ensure(pending.trusted && pending.owned && pending.term === term && pending.request === term &&
            pending.timer && pending.first && !document.getElementById("readingBackBtn").disabled,
          "Trusted input did not establish the first-debounce Back interval");
          // Stay in this real input dispatch, before any debounce task can run.
          document.getElementById("readingBackBtn").click();
          ensure(pendingSearchTerm === null && pendingSearchRequest === null && searchDebounceTimer === null,
            "The actual toolbar did not synchronously retire the exact pending request");
        } catch (error) { pending.error = String(error.stack || error); }
      };
      searchInput.addEventListener("input", pendingListener, { once: true });
    },
    async pendingResult() {
      ensure(pending && !pending.error, "Pending cancellation setup failed: " + JSON.stringify(pending));
      ensure(traversals.length === pending.traversal + 1, "Pending Back must call the actual history consumer once");
      const result = await traversals[pending.traversal].promise;
      ensure(result === true && jumps.length === pending.jumpCount && realControls.availability().forward,
        "Pending cancellation consumed Forward or issued a Search preview");
      return { ...pending, result, availability: realControls.availability(), position: position("Bprime") };
    },
    async pastDebounce() {
      // Negative stale-callback check only; never used to certify scroll completion.
      const remaining = Math.max(0, pending.deadline - performance.now());
      await new Promise(resolve => setTimeout(resolve, remaining + TIMING.searchDebounceDelay));
      ensure(performance.now() >= pending.deadline && pendingSearchTerm === null &&
        pendingSearchRequest === null && searchDebounceTimer === null && jumps.length === pending.jumpCount,
      "The canceled first debounce issued late work");
      return { deadline: pending.deadline, checkedAt: performance.now(), jumps: jumps.length,
        position: position("Bprime"), availability: realControls.availability() };
    },
    dispose() {
      intact();
      ensure(scrollElementIntoView === observedJump && controlsState.core === observedCore, "An observational port was replaced");
      scrollElementIntoView = realJump;
      controlsState.core = realControls;
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("reading-history-input", onGenuine);
      if (pendingListener) searchInput.removeEventListener("input", pendingListener);
      return true;
    },
  };
  return { availability: realControls.availability(), adapter: adapter.available(), tab: tab.id };
}

async function run() {
  await waitReady("production renderer", "typeof window.CustomTabs?.getActiveTab==='function' && typeof window.readingHistoryControls?.navigate==='function'");
  observedMain.setSize(1280, 850);
  observedMain.show(); observedMain.focus(); observedContents.focus();
  await exec("document.fonts.ready.then(() => true)");
  demand("the run uses only its workspace-contained isolated Chromium profile",
    app.getPath("userData") === isolation.USER_DATA_DIR &&
      app.getPath("sessionData") === isolation.USER_DATA_DIR &&
      isolation.USER_DATA_DIR !== isolation.REAL_USER_DATA && isolation.POST_WIPE_ENTRIES === 0);
  const fixtureCost = isLargeDocument(markdown);
  demand("the first fixture cannot invoke the large-document confirmation", fixtureCost.large === false, fixtureCost);
  const allowance = { window: observedMain, fixture, consumed: false };
  chooserAllowance = allowance;
  await exec("document.getElementById('openFile').click();true");
  await waitReady("actual admitted Source and final DOM", `currentFilePath===${JSON.stringify(fixture)} &&
    originalMarkdown===${JSON.stringify(markdown)} && readingDisplay?.source?.source===originalMarkdown &&
    viewer.querySelector('h1')?.textContent==='Native history Alpha' &&
    !loadingScreen.classList.contains('active') && readingRenderCompletion===null &&
    window.readingLocationAdapter.available()`);
  demand("actual Main Open consumed its single exact fixture chooser", allowance.consumed && chooserCalls === 1 && chooserAllowance === null);
  await exec("if(!indexPanel.classList.contains('visible'))document.getElementById('toggleTocBtn').click();true");
  await waitReady("actual TOC and admitted Source after drawer layout",
    "indexPanel.classList.contains('visible') && indexList.querySelectorAll('button.index-item').length===" +
    (publicationProducers ? 5 : 4) + " && window.readingLocationAdapter.available()");
  const setup = await exec("(" + installHistoryProbe.toString() + ")(" + JSON.stringify(releaseHistoryBatch) + ")");
  demand("fresh actual-tab history starts empty with the production adapter", setup.adapter && !setup.availability.back && !setup.availability.forward, setup);
  const baselineDocument = await exec("window.__readingHistoryNative.documentState()");
  demand("the first milestone is Reader, not an implicit mode transition", baselineDocument.edit === false);
  const sameDocument = async label => demand(label, isDeepStrictEqual(
    await exec("window.__readingHistoryNative.documentState()"), baselineDocument));
  await exec("window.__readingHistoryNative.save('A')");
  if (releaseHistoryBatch) return runReleaseHistoryBatch();
  if (readerBranchReplacement) return runReaderBranchReplacement();
  if (readingHistoryNoop) return runReadingHistoryNoop();
  if (windowsHistoryKeys) return runWindowsHistoryKeys();
  if (publicationProducers) return runPublicationProducers();
  if (inspection.enabled) await inspectCheckpoint("initial", "A", "00-alpha-initial", false,
    { kind: "admitted-initial-document", tab: setup.tab });
  const first = await exec("window.__readingHistoryNative.jump('Native history Beta')");
  demand("actual TOC jump records the reached Beta with enabled Back", first.availability.back && !first.availability.forward, first);
  await exec("window.__readingHistoryNative.save('B')");
  if (inspection.enabled) await inspectCheckpoint("toc-beta", "B", "01-beta-recorded", true,
    { kind: "actual-toc-dom-click", completion: first });
  else await capture("01-beta-recorded");
  await exec("window.__readingHistoryNative.history(-1)");
  const back = await exec("window.__readingHistoryNative.position('A')");
  demand("actual toolbar Back restores the admitted Alpha Source point", !back.availability.back && back.availability.forward, back);
  if (inspection.enabled) await inspectCheckpoint("back-alpha", "A", "02-alpha-back", true,
    { kind: "actual-document-back-dom-click", sourcePosition: back });
  else await capture("02-alpha-back");
  await exec("window.__readingHistoryNative.history(1)");
  const forward = await exec("window.__readingHistoryNative.position('B')");
  demand("actual toolbar Forward restores the reached Beta Source point", forward.availability.back && !forward.availability.forward, forward);
  await sameDocument("first real toolbar roundtrip preserves source editor selection dirty state and Undo/Redo");

  const drag = await exec("window.__readingHistoryNative.dragSetup()");
  observedContents.sendInputEvent({ type: "mouseMove", x: drag.x, y: drag.y });
  observedContents.sendInputEvent({ type: "mouseDown", x: drag.x, y: drag.y, button: "left", clickCount: 1 });
  observedContents.sendInputEvent({ type: "mouseMove", x: drag.x, y: drag.y + drag.dy, movementY: drag.dy });
  observedContents.sendInputEvent({ type: "mouseUp", x: drag.x, y: drag.y + drag.dy, button: "left", clickCount: 1 });
  await waitReady("observed manual scrollbar travel, not settlement",
    "getViewerScroller().scrollTop>" + JSON.stringify(drag.top + 30));
  const manual = await exec("window.__readingHistoryNative.dragWitness(" + JSON.stringify(drag) + ")");
  demand("native manual B-prime changes the actual Source reading point", manual.sourceChanged, manual);
  await exec("window.__readingHistoryNative.history(-1,'Bprime')");
  await exec("window.__readingHistoryNative.position('A')");
  await exec("window.__readingHistoryNative.history(1)");
  const refreshed = await exec("window.__readingHistoryNative.position('Bprime')");
  demand("Forward restores the actual manual departure B-prime rather than cached Beta", refreshed.availability.back && !refreshed.availability.forward, refreshed);
  await capture("03-manual-b-prime-forward");
  await sameDocument("manual departure refresh preserves source editor selection dirty state and Undo/Redo");

  await exec("window.__readingHistoryNative.jump('Native history Gamma')");
  await exec("window.__readingHistoryNative.save('C')");
  await exec("window.__readingHistoryNative.history(-1)");
  const branch = await exec("window.__readingHistoryNative.position('Bprime')");
  demand("B-prime has both older Alpha and the real Forward Gamma before Search", branch.availability.back && branch.availability.forward, branch);
  observedContents.sendInputEvent({ type: "keyDown", keyCode: "F", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
  observedContents.sendInputEvent({ type: "keyUp", keyCode: "F", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
  await waitReady("actual Find shortcut focuses the empty Search input", "searchPanel.classList.contains('visible') && document.activeElement===searchInput && searchInput.value===''");
  await exec("window.__readingHistoryNative.armPendingCancellation('nativehistoryneedle')");
  await bounded(() => observedContents.insertText("nativehistoryneedle"), "trusted native Search insertion");
  const pending = await exec("window.__readingHistoryNative.pendingResult()");
  demand("actual input then toolbar Back cancels before the first Search preview and retains B-prime/Forward", pending.trusted && pending.first && pending.result && pending.availability.forward, pending);
  const late = await exec("window.__readingHistoryNative.pastDebounce()");
  demand("the retired original debounce cannot issue a late Search jump", late.availability.forward, late);
  await capture("04-first-debounce-canceled");
  await exec("window.__readingHistoryNative.history(-1)");
  const noFakeReturn = await exec("window.__readingHistoryNative.position('A')");
  demand("the next Back reaches Alpha without a fake provisional or duplicate B-prime step",
    !noFakeReturn.availability.back && noFakeReturn.availability.forward, noFakeReturn);
  await exec("window.__readingHistoryNative.history(1)");
  const preservedMiddle = await exec("window.__readingHistoryNative.position('Bprime')");
  demand("Forward still restores B-prime with Gamma beyond it",
    preservedMiddle.availability.back && preservedMiddle.availability.forward, preservedMiddle);
  await exec("window.__readingHistoryNative.history(1)");
  const preserved = await exec("window.__readingHistoryNative.position('C')");
  demand("actual toolbar Forward still reaches Gamma after first-debounce cancellation", preserved.availability.back && !preserved.availability.forward, preserved);
  if (inspection.enabled) await inspectCheckpoint("forward-gamma", "C", "05-forward-gamma-preserved", true,
    { kind: "actual-document-forward-dom-click", sourcePosition: preserved });
  else await capture("05-forward-gamma-preserved");
  await sameDocument("pending Search recovery preserves source editor selection dirty state and Undo/Redo");
  const alive = await proveSentinelAlive(observedMain, sentinel);
  demand("the error sentinel detects both deliberately provoked channels", alive.console && alive.dom, alive);
  demand("observational wrappers restore the exact original production ports", await exec("window.__readingHistoryNative.dispose()"));
}

async function runReadingHistoryNoop() {
  const initial = await exec("window.__readingHistoryNative.noOpState()");
  demand("same-position scenario owns a clean 100% Reader with empty history and Search",
    initial.document.edit === false && initial.document.dirty === false &&
    initial.viewport.zoom === 100 && Number(initial.viewport.cssZoom) === 1 &&
    observedContents.getZoomFactor() === 1 && !initial.availability.back && !initial.availability.forward &&
    initial.search.value === "" && initial.search.matches === 0 && initial.search.index === -1 &&
    !initial.search.current && initial.search.term === null && initial.search.request === null && !initial.search.timer, initial);
  if (inspection.enabled) await inspectCheckpoint("initial", "A", "noop00-alpha-initial", false,
    { kind: "admitted-initial-document-before-no-op" });
  const beta = await exec("window.__readingHistoryNative.jump('Native history Beta')");
  demand("no-op setup records actual Beta with Back and no Forward", beta.availability.back && !beta.availability.forward, beta);
  await exec("window.__readingHistoryNative.save('B')");
  const gamma = await exec("window.__readingHistoryNative.jump('Native history Gamma')");
  demand("no-op setup records actual Gamma beyond Beta", gamma.availability.back && !gamma.availability.forward, gamma);
  await exec("window.__readingHistoryNative.save('C')");
  await exec("window.__readingHistoryNative.history(-1)");
  const middle = await exec("window.__readingHistoryNative.position('B')");
  demand("no-op setup returns to saved Beta with Alpha and Gamma available",
    middle.availability.back && middle.availability.forward, middle);
  const attempt = { heading: "Native history Beta" };
  noOpObservations.push(attempt);
  try { attempt.result = await exec("window.__readingHistoryNative.samePositionJump('Native history Beta')"); }
  catch (error) {
    attempt.error = String(error.stack || error);
    try { attempt.partial = await exec("window.__readingHistoryNative.noOpObservation"); }
    catch (readError) { attempt.partialError = String(readError.stack || readError); }
    throw error;
  }
  demand("actual same-position Beta TOC request completes without Source travel or state mutation",
    attempt.result.calls === 1 && attempt.result.record.status === "completed" &&
    attempt.result.record.scope === "request-offsets" && attempt.result.record.travel === "no-observed-travel" &&
    isDeepStrictEqual(attempt.result.before, attempt.result.after), attempt);
  const preserved = await exec("window.__readingHistoryNative.position('B')");
  demand("same-position Beta retains both older Alpha and Forward Gamma",
    preserved.availability.back && preserved.availability.forward, preserved);
  if (inspection.enabled) await inspectCheckpoint("toc-beta", "B", "noop01-beta-noop-preserved", true,
    { kind: "actual-same-position-toc-dom-click", completion: attempt.result });
  else await capture("noop01-beta-noop-preserved");
  await exec("window.__readingHistoryNative.history(-1)");
  const back = await exec("window.__readingHistoryNative.position('A')");
  demand("one Back after the no-op reaches original Alpha without a duplicate Beta stop",
    !back.availability.back && back.availability.forward, back);
  if (inspection.enabled) await inspectCheckpoint("back-alpha", "A", "noop02-alpha-back", true,
    { kind: "actual-document-back-after-no-op", sourcePosition: back });
  else await capture("noop02-alpha-back");
  await exec("window.__readingHistoryNative.history(1)");
  const forwardBeta = await exec("window.__readingHistoryNative.position('B')");
  demand("Forward after the no-op restores saved Beta with Gamma still beyond it",
    forwardBeta.availability.back && forwardBeta.availability.forward, forwardBeta);
  await exec("window.__readingHistoryNative.history(1)");
  const forwardGamma = await exec("window.__readingHistoryNative.position('C')");
  demand("Forward after the no-op reaches saved Gamma and exhausts the original branch",
    forwardGamma.availability.back && !forwardGamma.availability.forward, forwardGamma);
  if (inspection.enabled) await inspectCheckpoint("forward-gamma", "C", "noop03-gamma-forward", true,
    { kind: "actual-document-forward-after-no-op", sourcePosition: forwardGamma });
  else await capture("noop03-gamma-forward");
  const final = await exec("window.__readingHistoryNative.noOpState()");
  demand("same-position journey preserves exact document selection Undo/Redo Search and zoom",
    isDeepStrictEqual(initial.document, final.document) && isDeepStrictEqual(initial.search, final.search) &&
    initial.viewport.zoom === final.viewport.zoom && initial.viewport.cssZoom === final.viewport.cssZoom &&
    observedContents.getZoomFactor() === 1, { before: initial, after: final });
  const alive = await proveSentinelAlive(observedMain, sentinel);
  demand("the error sentinel detects both deliberately provoked channels", alive.console && alive.dom, alive);
  demand("observational wrappers restore the exact original production ports", await exec("window.__readingHistoryNative.dispose()"));
}

function installHistoryKeyProbe() {
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const history = window.__readingHistoryNative, controlState = readingHistoryControlState;
  const core = controlState.core, calls = [], records = [];
  let active = null;
  function state() {
    return structuredClone({
      document: { ...history.documentState(), undoValues: undoHistory, redoValues: redoHistory },
      viewport: { top: getViewerScroller().scrollTop, left: getViewerScroller().scrollLeft,
        zoom: zoomLevel, cssZoom: getComputedStyle(viewer).zoom },
      availability: core.availability(),
      search: { value: searchInput.value, matches: searchMatches.length,
        term: pendingSearchTerm, request: pendingSearchRequest?.term ?? null,
        timer: searchDebounceTimer !== null },
    });
  }
  const observedCore = Object.freeze({
    availability: core.availability, subscribe: core.subscribe,
    navigate(direction) {
      const call = { direction, attempt: active?.index ?? null, promise: null };
      calls.push(call);
      call.promise = core.navigate(direction);
      return call.promise;
    },
  });
  const observe = event => {
    if (!active) return;
    active.events.push({ type: event.type, key: event.key, trusted: event.isTrusted,
      alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey,
      repeat: event.repeat, composing: event.isComposing,
      altGraph: event.getModifierState("AltGraph"), targetMatches: event.target === active.target });
    if (event.type === "keyup") active.delivered();
  };
  controlState.core = observedCore;
  window.addEventListener("keydown", observe, true);
  window.addEventListener("keyup", observe, true);
  window.__readingHistoryKeys = {
    state,
    arm(direction, expected, targetKind) {
      ensure(!active && controlState.core === observedCore, "A keyboard attempt or production owner changed");
      ensure((direction === -1 || direction === 1) && (expected === 0 || expected === 1),
        "Invalid keyboard traversal contract");
      const target = document.activeElement;
      const editable = target?.isContentEditable || target?.closest("input, textarea, select, [role='textbox']");
      ensure(targetKind === "search" ? target === searchInput && editable :
        targetKind === "reader" && target && !editable, "The intended owned keyboard target is not focused");
      const before = state();
      ensure(before.search.value === "" && before.search.matches === 0 && before.search.term === null &&
        before.search.request === null && !before.search.timer, "Keyboard fixture must not start Search work");
      ensure(before.viewport.zoom === 100 && Number(before.viewport.cssZoom) === 1,
        "Keyboard fixture requires unchanged 100% reading zoom");
      const record = { index: records.length, direction, expected, targetKind, target,
        events: [], start: calls.length, before, finished: false };
      record.delivery = new Promise(resolve => { record.delivered = resolve; });
      records.push(record);
      active = record;
      return { index: record.index, direction, expected, targetKind,
        target: { id: target.id, tag: target.tagName } };
    },
    async finish(index) {
      const record = active;
      ensure(record && record.index === index, "Keyboard reply belongs to another attempt");
      // The existing Main execute deadline bounds missing key delivery or completion.
      await record.delivery;
      const key = record.direction === -1 ? "ArrowLeft" : "ArrowRight";
      ensure(record.events.length === 2 && record.events.every((event, index) =>
        event.type === (index === 0 ? "keydown" : "keyup") && event.key === key &&
        event.trusted && event.alt && !event.ctrl && !event.meta && !event.shift &&
        !event.repeat && !event.composing && !event.altGraph && event.targetMatches),
      "Missing, duplicate, untrusted or mismatched Windows key delivery");
      let issued = calls.slice(record.start);
      ensure(issued.length === record.expected && issued.every(call =>
        call.direction === record.direction && call.attempt === record.index),
      "Windows chord dispatched the wrong number or direction of real traversals");
      const outcomes = await Promise.all(issued.map(call => call.promise));
      ensure(outcomes.every(value => value === true), "The actual Windows history traversal failed");
      issued = calls.slice(record.start);
      ensure(issued.length === record.expected && controlState.core === observedCore,
        "A late traversal or changed keyboard owner appeared");
      const after = state(), same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
      ensure(same(record.before.document, after.document) && same(record.before.search, after.search) &&
        record.before.viewport.zoom === after.viewport.zoom && record.before.viewport.cssZoom === after.viewport.cssZoom,
      "Windows keyboard history changed source, exact editor history, Search or zoom");
      if (record.expected === 0) ensure(same(record.before.viewport, after.viewport) &&
        same(record.before.availability, after.availability), "A blocked or exhausted chord changed the viewport or history");
      record.finished = true;
      active = null;
      return { index: record.index, events: record.events, directions: issued.map(call => call.direction),
        outcomes, before: record.before, after, finished: true };
    },
    dispose() {
      window.removeEventListener("keydown", observe, true);
      window.removeEventListener("keyup", observe, true);
      ensure(controlState.core === observedCore, "Keyboard observation port was replaced");
      controlState.core = core;
      delete window.__readingHistoryKeys;
      return { attempts: records.length, finished: records.filter(record => record.finished).length,
        unarmedCalls: calls.filter(call => call.attempt === null).length };
    },
  };
  return state();
}

async function sendWindowsHistoryKey(label, direction, expected, point, targetKind, availability) {
  const attempt = { label, armed: await exec("window.__readingHistoryKeys.arm(" +
    [direction, expected, targetKind].map(value => JSON.stringify(value)).join(",") + ")") };
  keyboardObservations.push(attempt);
  try {
    const keyCode = direction === -1 ? "Left" : "Right";
    observedContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: ["alt"] });
    observedContents.sendInputEvent({ type: "keyUp", keyCode, modifiers: ["alt"] });
    attempt.result = await exec("window.__readingHistoryKeys.finish(" + attempt.armed.index + ")");
    attempt.position = await exec("window.__readingHistoryNative.position(" + JSON.stringify(point) + ")");
    demand(label, attempt.result.finished && isDeepStrictEqual(attempt.position.availability, availability) &&
      observedContents.getZoomFactor() === 1, attempt);
  } catch (error) {
    attempt.error = String(error.stack || error);
    throw error;
  }
}

async function runWindowsHistoryKeys() {
  const initial = await exec("(" + installHistoryKeyProbe.toString() + ")()");
  demand("Windows keyboard scenario owns a clean 100% Reader with empty Search",
    process.platform === "win32" && observedContents.getZoomFactor() === 1 &&
    initial.document.edit === false && initial.document.dirty === false &&
    initial.viewport.zoom === 100 && Number(initial.viewport.cssZoom) === 1 &&
    !initial.availability.back && !initial.availability.forward, initial);
  let failure = null;
  try {
    await exec("document.activeElement?.blur();true");
    if (inspection.enabled) await inspectCheckpoint("initial", "A", "keys00-alpha-initial", false,
      { kind: "windows-keyboard-empty-history" });
    await sendWindowsHistoryKey("trusted Alt+Left cannot traverse empty history", -1, 0, "A", "reader",
      { back: false, forward: false });
    await sendWindowsHistoryKey("trusted Alt+Right cannot traverse empty history", 1, 0, "A", "reader",
      { back: false, forward: false });
    await exec("window.__readingHistoryNative.jump('Native history Beta')");
    await exec("window.__readingHistoryNative.save('B')");
    if (inspection.enabled) await inspectCheckpoint("toc-beta", "B", "keys01-beta-recorded", true,
      { kind: "actual-toc-dom-click-before-windows-keys" });
    else await capture("keys01-beta-recorded");
    await exec("window.__readingHistoryNative.jump('Native history Gamma')");
    await exec("window.__readingHistoryNative.save('C')");
    await sendWindowsHistoryKey("trusted Alt+Left restores Beta with Alpha and Gamma available", -1, 1, "B", "reader",
      { back: true, forward: true });
    observedContents.sendInputEvent({ type: "keyDown", keyCode: "F", modifiers: ["control"] });
    observedContents.sendInputEvent({ type: "keyUp", keyCode: "F", modifiers: ["control"] });
    await waitReady("empty owned Search input before guarded history keys",
      "searchPanel.classList.contains('visible') && document.activeElement===searchInput && searchInput.value===''");
    await sendWindowsHistoryKey("trusted Alt+Left in empty Search does not traverse or start Search", -1, 0, "B", "search",
      { back: true, forward: true });
    await sendWindowsHistoryKey("trusted Alt+Right in empty Search does not traverse or start Search", 1, 0, "B", "search",
      { back: true, forward: true });
    await exec("searchInput.blur();true");
    await sendWindowsHistoryKey("trusted Alt+Left restores Alpha after leaving editable focus", -1, 1, "A", "reader",
      { back: false, forward: true });
    if (inspection.enabled) await inspectCheckpoint("back-alpha", "A", "keys02-alpha-back", true,
      { kind: "trusted-windows-alt-left" });
    else await capture("keys02-alpha-back");
    await sendWindowsHistoryKey("trusted Alt+Left at Alpha is exhausted without mutation", -1, 0, "A", "reader",
      { back: false, forward: true });
    await sendWindowsHistoryKey("trusted Alt+Right restores Beta", 1, 1, "B", "reader",
      { back: true, forward: true });
    await sendWindowsHistoryKey("trusted Alt+Right restores Gamma", 1, 1, "C", "reader",
      { back: true, forward: false });
    if (inspection.enabled) await inspectCheckpoint("forward-gamma", "C", "keys03-gamma-forward", true,
      { kind: "trusted-windows-alt-right" });
    else await capture("keys03-gamma-forward");
    await sendWindowsHistoryKey("trusted Alt+Right at Gamma is exhausted without mutation", 1, 0, "C", "reader",
      { back: true, forward: false });
    const final = await exec("window.__readingHistoryKeys.state()");
    demand("Windows keyboard journey preserves exact document selection and Undo/Redo values",
      isDeepStrictEqual(initial.document, final.document), { before: initial.document, after: final.document });
  } catch (error) { failure = error; }
  try {
    const cleanup = await exec("window.__readingHistoryKeys.dispose()");
    demand("keyboard observation retires every attempt and restores its exact production port",
      cleanup.attempts === 10 && cleanup.finished === 10 && cleanup.unarmedCalls === 0, cleanup);
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "Keyboard scenario and cleanup failed") : error;
  }
  if (failure) throw failure;
  const alive = await proveSentinelAlive(observedMain, sentinel);
  demand("the error sentinel detects both deliberately provoked channels", alive.console && alive.dom, alive);
  demand("observational wrappers restore the exact original production ports", await exec("window.__readingHistoryNative.dispose()"));
}

async function finish(error) {
  if (finishing) return fatal(new Error("Ordinary finish entered twice"));
  finishing = true;
  let keepalive = null, destroyed = false, reported = false;
  check(publicationProducers ? "all publication producer scenarios reach their exact terminal boundary" :
    releaseHistoryBatch ? "all finite release history scenarios reach their terminal boundary" :
    readerBranchReplacement ? "all successful Forward-branch replacement scenarios reach their terminal boundary" :
    readingHistoryNoop ? "all same-position TOC scenarios reach their terminal boundary" :
    windowsHistoryKeys ? "all Windows keyboard scenarios reach their terminal boundary" :
    "all first-milestone scenarios reach their terminal boundary",
    completed && !error && (!publicationProducers || results.length === 36),
    publicationProducers ? { error: String(error?.stack || error || ""), assertionsBeforeTerminal: results.length } :
      String(error?.stack || error || ""));
  if (error && liveMain()) {
    try { await capture("FAILED"); } catch (captureError) { check("failure capture completes", false, String(captureError)); }
  }
  try { await bounded(() => sentinel.drain(), "live sentinel drain", 12000); }
  catch (drainError) { check("live sentinel drain completes", false, String(drainError)); }
  try {
    keepalive = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    const gone = observedMain.isDestroyed() ? Promise.resolve() : new Promise(resolve => observedMain.once("closed", resolve));
    const contentsGone = observedContents.isDestroyed() ? Promise.resolve() : new Promise(resolve => observedContents.once("destroyed", resolve));
    if (!observedMain.isDestroyed()) observedMain.destroy();
    await bounded(() => Promise.all([gone, contentsGone]), "owned Main destruction", 5000);
    await bounded(() => new Promise(resolve => setImmediate(resolve)), "queued teardown diagnostics", 1500);
    destroyed = observedMain.isDestroyed() && observedContents.isDestroyed() && !keepalive.isDestroyed();
  } catch (destroyError) { check("owned Main teardown completes", false, String(destroyError)); }
  check("observed Main and webContents are destroyed before terminal accounting", destroyed);
  try {
    if (!destroyed || !sentinel) throw new Error("Cannot report a sentinel after unconfirmed destruction");
    const errors = await bounded(() => sentinel.stop(), "sentinel stop after destruction", 12000);
    check("scenarios and teardown introduce no renderer or visible document errors", errors.hits.length === 0, errors.hits);
    check("the error sentinel has no observation stalls", errors.stalls.length === 0, errors.stalls);
    const mute = errors.mutes[0];
    check("only the exact liveness probe is muted", errors.mutes.length === 1 &&
      mute.reason === LIVENESS_MUTE_REASON && mute.suppressed.length === 2 &&
      mute.suppressed.some(hit => hit.kind === "console-error" && /^sentinel-liveness-probe-\d+ @ /.test(hit.detail)) &&
      mute.suppressed.some(hit => hit.kind === "error-text-on-screen" && hit.detail === "top: Syntax error in text") &&
      sentinel.currentMute() === null, errors.mutes);
    reported = true;
  } catch (sentinelError) { check("sentinel reports through owned destruction", false, String(sentinelError)); }
  const finalSources = sourceHashes();
  check("product source hashes are unchanged through the entire native invocation", isDeepStrictEqual(initialSources, finalSources));
  check("dialog and external-application guards survive teardown", guardsIntact());
  check(releaseHistoryBatch || publicationProducers ? "only the exact fixture chooser sequence was consumed and none remains armed" :
    "only one exact fixture chooser was consumed and none remains armed",
    chooserCalls === chooserSequence.length && chooserAllowance === null);
  cleanExit = completed && !error && destroyed && reported && !!keepalive && results.length > 0 && results.every(result => result.ok);
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify({
    scope: publicationProducers ? "inline-image-and-bulk-publication-producers" :
      releaseHistoryBatch ? "finite-release-search-and-timeline-batch" :
      readerBranchReplacement ? "successful-forward-branch-replacement-milestone" :
      readingHistoryNoop ? "same-position-toc-history-milestone" :
      windowsHistoryKeys ? "windows-history-keyboard-milestone" : "first-real-app-history-milestone",
    completed, cleanExit, destroyed,
    runtime: { node: process.version, electron: process.versions.electron, platform: process.platform },
    sourceBefore: initialSources, sourceAfter: finalSources, testSha256: digest(fs.readFileSync(__filename)),
    fixture: { path: fixture, bytes: Buffer.byteLength(markdown), sha256: digest(markdown) },
    profile: { userData: isolation.USER_DATA_DIR, originalUserData: isolation.REAL_USER_DATA },
    assertions: results, captures, error: error ? String(error.stack || error) : null,
    ...(windowsHistoryKeys ? { keyboardObservations } : {}),
    ...(readingHistoryNoop ? { noOpObservations } : {}),
    ...(readerBranchReplacement ? { branchReplacementObservations } : {}),
    ...(releaseHistoryBatch ? { releaseHistoryObservations, releaseFailureObservations } : {}),
    ...(publicationProducers ? { producerObservations,
      contract: { assertions: 44, originals: 6, cases: ["prose", "tables"] },
      secondFixture: { path: secondFixture, bytes: Buffer.byteLength(secondMarkdown), sha256: digest(secondMarkdown) } } : {}),
    inspection: { enabled: inspection.enabled, visualAcceptance: null, checkpoints: inspection.checkpoints,
      helperSha256: digest(fs.readFileSync(path.join(__dirname, "reading-history-inspection.js"))) },
    boundaries: publicationProducers ? [
      "Actual inline-image, Collapse All and Expand All producers; two surviving H1 destinations in prose then tables",
      "Actual TOC and toolbar handlers with real Source/alignment checks; default-zoom Reader only",
      "Capture/restore/navigation performance investigation is deferred; no timing result or budget is claimed",
      "Six original endpoint images require separate viewing; no visual acceptance is prefilled",
    ] : releaseHistoryBatch ? [
      "Real Main Open, TOC, toolbar, trusted Search insertion and production tab/dialog routes",
      "Request-issued recovery precedes the consumer continuation; it is not a continuous-motion or global-arrival oracle",
      "A real renderer reload proves renderer-lifetime reset; an operating-system process restart is not claimed",
      "Default-zoom plain Reader only; mode and performance qualification remain separate",
      "Original captures require actual separate viewing; no visual acceptance is prefilled",
    ] : readerBranchReplacement ? [
      "One actual successful TOC Gamma jump from restored Alpha must replace the obsolete Beta Forward branch",
      "Actual Back then Forward must expose exactly Alpha/Gamma, without Beta or a duplicate Alpha stop",
      "Default-zoom plain Reader only; failed jumps, timelines/lifetime, Search, modes and performance remain unqualified",
      "Request-local completion and Source checks are not displayed pixels; four controlled endpoints and original images need separate viewing",
    ] : readingHistoryNoop ? [
      "One actual same-position TOC request must complete with no-observed-travel; moved or unrecordable setup fails without repositioning",
      "Actual Back/Forward must preserve Alpha/Beta/Gamma without a duplicate entry or discarded Forward branch",
      "Default-zoom plain Reader only; failed jumps, other timeline/lifetime cases, Search, modes and performance remain unqualified",
      "Request-local completion and Source checks are not displayed pixels; four controlled endpoints and original images need separate viewing",
    ] : windowsHistoryKeys ? [
      "Windows-only trusted webContents Alt+Arrow routing; physical keyboard devices and OS-global shortcuts are not qualified",
      "Default-zoom plain Reader and empty Search-focus/exhaustion guards only; no in-flight Search or wider matrix proof",
      "Real Source endpoints and exact editor history are checked separately from observed pixels",
      "Four bounded inspection checkpoints and original images require separate viewing; no continuous-motion claim",
    ] : ["Request-local production completion only, not arrival or global animation drain",
      "Plain Reader Source fixture only; nested/both-axis, mode, lifetime and performance gates remain later",
      "TOC and toolbar use real DOM click handlers; physical toolbar/mouse-command/shortcut delivery is not qualified",
      "Search text is trusted native insertion; synchronous input listener clicks the actual toolbar before debounce",
      "Captures are retained but must be viewed separately before acceptance"],
  }, null, 2) + "\n");
  const footer = publicationProducers ? "reading-history-publication-producers" :
    releaseHistoryBatch ? "reading-history-release-batch" :
    readerBranchReplacement ? "reading-history-branch-replacement" :
    readingHistoryNoop ? "reading-history-noop" :
    windowsHistoryKeys ? "reading-history-windows-keys" : "reading-history-native";
  console.log(`=== ${footer}: ${results.filter(result => result.ok).length}/${results.length} passed ===`);
  ordinaryExiting = true;
  clearTimeout(watchdog);
  app.exit(cleanExit ? 0 : 1);
}
app.whenReady().then(async () => {
  let error = null;
  try {
    await bounded(async () => {
      while (!liveMain()) await sleep(25);
    }, "actual Main creation");
    if (!liveMain() || !sentinel) throw new Error("The actual Main window was not observed from creation");
    await run();
    completed = true;
  } catch (caught) { error = caught; }
  await finish(error);
}).catch(fatal);

// Keep this opt-in itinerary outside the accepted source-extraction boundaries.
async function runReaderBranchReplacement() {
  const initial = await exec("window.__readingHistoryNative.noOpState()");
  const sameState = value => isDeepStrictEqual(initial.document, value.document) &&
    isDeepStrictEqual(initial.search, value.search) && isDeepStrictEqual(initial.focus, value.focus) &&
    initial.viewport.zoom === value.viewport.zoom && initial.viewport.cssZoom === value.viewport.cssZoom &&
    observedContents.getZoomFactor() === 1;
  demand("branch replacement starts in a clean 100% Reader with empty history and Search",
    initial.document.edit === false && initial.document.dirty === false &&
    initial.viewport.zoom === 100 && Number(initial.viewport.cssZoom) === 1 &&
    observedContents.getZoomFactor() === 1 && !initial.availability.back && !initial.availability.forward &&
    initial.search.value === "" && initial.search.matches === 0 && initial.search.index === -1 &&
    !initial.search.current && initial.search.term === null && initial.search.request === null && !initial.search.timer, initial);
  await waitForBranchCapture("A", "Native history Alpha");
  if (inspection.enabled) await inspectCheckpoint("initial", "A", "branch00-alpha-initial", false,
    { kind: "admitted-initial-document-before-branch-replacement" });
  else await capture("branch00-alpha-initial", false);
  const beta = await exec("window.__readingHistoryNative.jump('Native history Beta')");
  demand("branch setup records actual observed-travel Beta with Back and no Forward",
    beta.record.status === "completed" && beta.record.scope === "request-offsets" &&
    beta.record.travel === "observed-travel" && beta.availability.back && !beta.availability.forward, beta);
  await exec("window.__readingHistoryNative.save('B')");
  const betaPosition = await exec("window.__readingHistoryNative.position('B')");
  const betaState = await exec("window.__readingHistoryNative.noOpState()");
  demand("branch setup reaches distinct saved Beta without changing document Search focus or zoom",
    betaPosition.start !== initial.source.text.start && sameState(betaState), { betaPosition, betaState });
  await waitForBranchCapture("B", "Native history Beta");
  if (inspection.enabled) await inspectCheckpoint("toc-beta", "B", "branch01-beta-recorded", true,
    { kind: "actual-toc-dom-click-before-branch-replacement", completion: beta });
  else await capture("branch01-beta-recorded");
  await exec("window.__readingHistoryNative.history(-1)");
  const origin = await exec("window.__readingHistoryNative.position('A')");
  const replacement = { heading: "Native history Gamma", obsoleteBeta: { completion: beta, position: betaPosition },
    before: await exec("window.__readingHistoryNative.noOpState()"), jump: null, after: null };
  branchReplacementObservations.push(replacement);
  demand("branch setup restores original Alpha with obsolete Beta available Forward",
    !origin.availability.back && origin.availability.forward && sameState(replacement.before), { origin, replacement });
  await waitForBranchCapture("A", "Native history Alpha");
  if (inspection.enabled) await inspectCheckpoint("back-alpha", "A", "branch02-alpha-back", true,
    { kind: "actual-document-back-before-branch-replacement", sourcePosition: origin });
  else await capture("branch02-alpha-back");
  try { replacement.jump = await exec("window.__readingHistoryNative.jump('Native history Gamma')"); }
  catch (error) { replacement.error = String(error.stack || error); throw error; }
  await exec("window.__readingHistoryNative.save('C')");
  replacement.gammaPosition = await exec("window.__readingHistoryNative.position('C')");
  replacement.after = await exec("window.__readingHistoryNative.noOpState()");
  demand("successful Gamma jump replaces the obsolete Beta Forward branch",
    replacement.jump.record.status === "completed" && replacement.jump.record.scope === "request-offsets" &&
    replacement.jump.record.travel === "observed-travel" &&
    replacement.jump.availability.back && !replacement.jump.availability.forward &&
    replacement.gammaPosition.start !== betaPosition.start &&
    replacement.gammaPosition.start !== initial.source.text.start, replacement);
  demand("branch replacement commit preserves exact document selection Undo/Redo Search focus and zoom",
    sameState(replacement.before) && sameState(replacement.after), replacement);
  await exec("window.__readingHistoryNative.history(-1)");
  replacement.backAlpha = await exec("window.__readingHistoryNative.position('A')");
  replacement.afterBack = await exec("window.__readingHistoryNative.noOpState()");
  demand("one Back after replacement reaches original Alpha without Beta or a duplicate stop",
    !replacement.backAlpha.availability.back && replacement.backAlpha.availability.forward &&
    sameState(replacement.afterBack), replacement);
  await exec("window.__readingHistoryNative.history(1)");
  replacement.forwardGamma = await exec("window.__readingHistoryNative.position('C')");
  demand("one Forward after replacement reaches saved Gamma instead of obsolete Beta",
    replacement.forwardGamma.availability.back && !replacement.forwardGamma.availability.forward, replacement);
  await waitForBranchCapture("C", "Native history Gamma");
  if (inspection.enabled) await inspectCheckpoint("forward-gamma", "C", "branch03-gamma-forward", true,
    { kind: "actual-document-forward-after-branch-replacement", sourcePosition: replacement.forwardGamma });
  else await capture("branch03-gamma-forward");
  replacement.final = await exec("window.__readingHistoryNative.noOpState()");
  demand("branch replacement journey preserves exact document selection Undo/Redo Search focus and zoom",
    sameState(replacement.final), { initial, final: replacement.final });
  const alive = await proveSentinelAlive(observedMain, sentinel);
  demand("the error sentinel detects both deliberately provoked channels", alive.console && alive.dom, alive);
  demand("observational wrappers restore the exact original production ports", await exec("window.__readingHistoryNative.dispose()"));
}

async function runReleaseHistoryBatch() {
  const api = expression => exec("window.__readingHistoryNative." + expression);
  const readState = () => api("noOpState()");
  const original = await readState();
  const unchangedDocument = async label => {
    const now = await readState();
    demand(label, isDeepStrictEqual(now.document, original.document) &&
      isDeepStrictEqual(now.viewport.zoom, original.viewport.zoom) &&
      isDeepStrictEqual(now.viewport.cssZoom, original.viewport.cssZoom), now);
  };
  const search = async term => {
    await exec("if(!searchPanel.classList.contains('visible'))toggleSearchPanel();searchInput.focus();searchInput.select();true");
    const before = await api("releaseCounts()");
    await bounded(() => observedContents.insertText(term), "trusted Search insertion");
    await waitReady("one actual Search preview",
      "window.__readingHistoryNative.releaseCounts().jumps===" + (before.jumps + 1) +
      " && pendingSearchRequest===null && searchDebounceTimer===null");
    const result = await api("releaseJump(" + before.jumps + ")");
    demand("trusted arrived Search preview: " + term,
      result.record.status === "completed" && result.record.scope === "request-offsets" &&
      result.record.travel === "observed-travel", result);
    return result;
  };
  const closeSearch = () => exec("if(searchPanel.classList.contains('visible'))searchCloseBtn.click();true");
  const points = {};
  const save = async name => { points[name] = await api("save(" + JSON.stringify(name) + ")"); };
  await save("search-origin");
  const gamma = await search("nativehistoryneedle");
  const tail = await search("Tail paragraph");
  demand("two arrived previews in one typing segment reach different real Source points",
    gamma.position.text.start !== tail.position.text.start, { gamma, tail });
  await save("search-tail");
  await api("history(-1)");
  demand("one Back returns through coalesced arrived previews to the first pre-typing origin",
    !(await api("position('search-origin')")).availability.back);
  await api("history(1)");
  demand("one Forward returns to the last coalesced preview without an intermediate Gamma stop",
    !(await api("position('search-tail')")).availability.forward);
  await waitForReleaseCapture("release01-coalesced-tail");
  await capture("release01-coalesced-tail");
  await unchangedDocument("arrived Search roundtrip preserves exact document selection Undo/Redo and zoom");

  const beforeExplicit = await api("releaseCounts()");
  await exec("searchNextBtn.click();true");
  const explicit = await api("releaseJump(" + beforeExplicit.jumps + ")");
  demand("actual Next creates a separate reached destination",
    explicit.record.travel === "observed-travel" &&
    explicit.position.text.start !== tail.position.text.start, explicit);
  await save("explicit-next");
  await search("nativehistoryneedle");
  await api("history(-1)");
  const beforeRecovery = await api("position('explicit-next')");
  demand("typing after explicit Next starts a new segment at that explicit destination",
    beforeRecovery.availability.back && beforeRecovery.availability.forward, beforeRecovery);
  await waitForReleaseCapture("release02-explicit-return");
  await capture("release02-explicit-return");
  await api("armIssuedBack()");
  await exec("searchInput.focus();searchInput.select();true");
  const recoveryStart = await api("releaseCounts()");
  await bounded(() => observedContents.insertText("Native history Beta"), "trusted request-issued Search");
  await waitReady("request-issued Search recovery",
    "pendingSearchRequest===null && searchDebounceTimer===null && window.__readingHistoryNative.releaseCounts().jumps===" +
    (recoveryStart.jumps + 1));
  const recovered = await api("issuedBackResult()");
  demand("Back before the preview consumer continuation returns to the segment origin and retains Forward",
    recovered.recovered && recovered.availability.back && recovered.availability.forward, recovered);
  await api("position('explicit-next')");
  await api("history(1)");
  const gammaForward = await readState();
  demand("preserved Forward really reaches the earlier Gamma Source point",
    gammaForward.source.text.start === gamma.position.text.start, { gammaForward, gamma });
  await api("history(-1)");
  await api("position('explicit-next')");
  await waitForReleaseCapture("release03-issued-back");
  await capture("release03-issued-back");
  await closeSearch();

  const beforeFailure = await readState();
  const failureAttempt = { before: beforeFailure };
  releaseFailureObservations.push(failureAttempt);
  let failed, failure = null;
  try { failed = await api("failedClippedJump()"); }
  catch (error) { failureAttempt.error = String(error.stack || error); failure = error; }
  try {
    failureAttempt.observation = await api("failedClippedObservation");
    failureAttempt.after = await readState();
  } catch (error) {
    failureAttempt.readbackError = String(error.stack || error);
    failure = failure ? new AggregateError([failure, error], "Clipped request and retained readback failed") : error;
  }
  if (failure) throw failure;
  const afterFailure = failureAttempt.after;
  demand("a genuinely unrecordable native jump preserves Source viewport and the existing Forward branch",
    failed.committed === false && isDeepStrictEqual(beforeFailure.source, afterFailure.source) &&
    isDeepStrictEqual(beforeFailure.viewport, afterFailure.viewport) &&
    isDeepStrictEqual(beforeFailure.availability, afterFailure.availability) &&
    afterFailure.availability.forward, { failed, beforeFailure, afterFailure });
  await api("history(1)");
  demand("Forward after failed recording still reaches Gamma",
    (await readState()).source.text.start === gamma.position.text.start);
  await api("history(-1)");
  await api("position('explicit-next')");
  await waitForReleaseCapture("release04-failed-branch-retained");
  await capture("release04-failed-branch-retained");

  await exec("toggleSearchPanel();searchInput.focus();true");
  await api("armCanceledRequest()");
  const cancelStart = await api("releaseCounts()");
  await bounded(() => observedContents.insertText("nativehistoryneedle"), "trusted canceled Search");
  demand("closing the actual Search panel cancels its first pending segment before preview",
    await exec("!searchPanel.classList.contains('visible') && pendingSearchRequest===null && searchDebounceTimer===null") &&
    (await api("releaseCounts()")).jumps === cancelStart.jumps);
  await search("Tail paragraph");
  const repair = await api("repairAndReplayCanceled()");
  await waitReady("highlight-only repair finishes", "pendingSearchRequest===null && searchDebounceTimer===null && searchMatches.length===8");
  const repaired = await readState();
  demand("stale canceled work and render-highlight repair cannot replay navigation or add history",
    (await api("releaseCounts()")).jumps === repair.jumps &&
    isDeepStrictEqual(repaired.source, repair.location) &&
    isDeepStrictEqual(repaired.availability, repair.availability), { repair, repaired });
  await unchangedDocument("all Search and failed-branch cases preserve source editor selection exact history and zoom");
  await api("remember('repair-capture'," + JSON.stringify(repair.location) + ")");
  await waitForReleaseCapture("release05-stale-highlight-repair");
  await capture("release05-stale-highlight-repair");
  await closeSearch();
  const firstTab = await exec("window.CustomTabs.getActiveTab().id");
  const firstAvailability = await exec("window.readingHistoryControls.availability()");
  const firstPoint = await api("save('first-tab')");
  await api("dispose()");

  demand("the second fixture also stays below the large-document guard", !isLargeDocument(secondMarkdown).large);
  const secondAllowance = { window: observedMain, fixture: secondFixture, consumed: false };
  chooserAllowance = secondAllowance;
  await exec("document.getElementById('openFile').click();true");
  await waitReady("second actual Main Open and final DOM", `currentFilePath===${JSON.stringify(secondFixture)} &&
    originalMarkdown===${JSON.stringify(secondMarkdown)} && viewer.querySelector('h1')?.textContent==='Other history Alpha' &&
    !loadingScreen.classList.contains('active') && readingRenderCompletion===null && window.readingLocationAdapter.available()`);
  demand("second Main Open consumes only its exact finite chooser", secondAllowance.consumed && chooserCalls === 2);
  await exec("if(!indexPanel.classList.contains('visible'))document.getElementById('toggleTocBtn').click();true");
  await waitReady("second actual TOC", "indexList.querySelectorAll('button.index-item').length===4 && window.readingLocationAdapter.available()");
  const secondSetup = await exec("(" + installHistoryProbe.toString() + ")(" + JSON.stringify(releaseHistoryBatch) + ")");
  const secondTab = secondSetup.tab;
  demand("a different real tab starts with independent empty history",
    secondTab !== firstTab && !secondSetup.availability.back && !secondSetup.availability.forward, secondSetup);
  await api("save('second-alpha')");
  await api("jump('Other history Gamma')");
  const secondPoint = await api("save('second-gamma')");
  await waitForReleaseCapture("release06-second-tab-gamma");
  await capture("release06-second-tab-gamma");
  await api("dispose()");
  await exec("window.CustomTabs.switchToTab(" + firstTab + ")");
  await waitReady("first tab final DOM", `currentFilePath===${JSON.stringify(fixture)} &&
    viewer.querySelector('h1')?.textContent==='Native history Alpha' && readingRenderCompletion===null && window.readingLocationAdapter.available()`);
  await exec("(" + installHistoryProbe.toString() + ")(" + JSON.stringify(releaseHistoryBatch) + ")");
  await api("remember('first-tab'," + JSON.stringify(firstPoint) + ")");
  demand("switching tabs restores the first tab's own history availability",
    isDeepStrictEqual(await exec("window.readingHistoryControls.availability()"), firstAvailability));
  await api("position('first-tab')");
  await api("history(-1)");
  demand("first-tab Back changes only its own timeline", (await readState()).source.text.sourceKey === firstPoint.text.sourceKey);
  await api("dispose()");
  await exec("window.CustomTabs.switchToTab(" + secondTab + ")");
  await waitReady("second tab final DOM after switch", `currentFilePath===${JSON.stringify(secondFixture)} &&
    viewer.querySelector('h1')?.textContent==='Other history Alpha' && readingRenderCompletion===null && window.readingLocationAdapter.available()`);
  await exec("(" + installHistoryProbe.toString() + ")(" + JSON.stringify(releaseHistoryBatch) + ")");
  await api("remember('second-gamma'," + JSON.stringify(secondPoint) + ")");
  const secondReturn = await api("position('second-gamma')");
  demand("the second tab keeps Gamma and its independent Back boundary after first-tab travel",
    secondReturn.availability.back && !secondReturn.availability.forward, secondReturn);
  await waitForReleaseCapture("release07-independent-tabs");
  await capture("release07-independent-tabs");

  await api("dispose()");
  await exec("window.changeCurrentDocumentEditor(true)");
  await waitReady("owned Split editor", "isEditMode && !readingRenderCompletion && window.readingLocationAdapter.available()");
  await exec("markdownEditor.focus();markdownEditor.setSelectionRange(markdownEditor.value.length,markdownEditor.value.length);true");
  await bounded(() => observedContents.insertText("\nOwned canceled-close fixture edit.\n"), "trusted owned editor insertion");
  await waitReady("real dirty editor and affected preview", "hasUnsavedChanges && undoHistory.length>0 && " +
    "readingDisplay?.source?.source===markdownEditor.value && readingRenderCompletion===null && window.readingLocationAdapter.available()");
  const closeStateExpression = `({ tab: window.CustomTabs.getActiveTab().id, source: originalMarkdown,
    editor: markdownEditor.value, selection: [markdownEditor.selectionStart,markdownEditor.selectionEnd,markdownEditor.selectionDirection],
    dirty: hasUnsavedChanges, undo: structuredClone(undoHistory), redo: structuredClone(redoHistory),
    availability: window.readingHistoryControls.availability() })`;
  const beforeCancel = await exec(closeStateExpression);
  demand("the canceled-close setup has real unsaved text, Undo and a populated reading timeline",
    beforeCancel.editor !== beforeCancel.source && beforeCancel.dirty &&
    beforeCancel.undo.length > 0 && beforeCancel.availability.back, beforeCancel);
  await exec("window.__releaseClose=window.CustomTabs.closeTab(" + secondTab + ");true");
  await waitReady("the actual dirty-close question",
    "document.getElementById('appMessageDialog')?.open && document.getElementById('appMessageTitle').textContent==='Close without saving?' && " +
    "document.querySelector('#appMessageButtons [data-dialog-choice=\"cancel\"]')?.textContent==='Cancel'");
  await waitForReleaseCapture("release07b-cancel-close-question", beforeCancel);
  await capture("release07b-cancel-close-question");
  await exec("document.querySelector('#appMessageButtons [data-dialog-choice=\"cancel\"]').click();window.__releaseClose");
  const afterCancel = await exec(closeStateExpression);
  demand("Cancel preserves the same live tab, unsaved text, selection, exact Undo/Redo and timeline",
    isDeepStrictEqual(beforeCancel, afterCancel) &&
    await exec("window.CustomTabs.getTabs().some(tab=>tab.id===" + secondTab + ")"), { beforeCancel, afterCancel });
  await waitForReleaseCapture("release07c-canceled-close-retained", beforeCancel);
  await capture("release07c-canceled-close-retained");
  await exec("undoButton.click();true");
  await waitReady("one actual Undo restores the fixture without saving", "markdownEditor.value===originalMarkdown && !hasUnsavedChanges && " +
    "readingDisplay?.source?.source===markdownEditor.value && readingRenderCompletion===null");
  demand("the canceled-close scenario never writes the owned fixture to disk",
    fs.readFileSync(secondFixture, "utf8") === secondMarkdown);
  await exec("window.changeCurrentDocumentEditor(false)");
  await waitReady("Reader after clean Undo", "!isEditMode && readingRenderCompletion===null && window.readingLocationAdapter.available()");
  await exec("window.CustomTabs.closeTab(" + secondTab + ")");
  demand("actual clean close retires only the second tab",
    await exec("!window.CustomTabs.getTabs().some(tab=>tab.id===" + secondTab + ") && window.CustomTabs.getActiveTab().id===" + firstTab));
  await waitReady("surviving first tab final DOM after close", `window.CustomTabs.getActiveTab()?.id===${firstTab} &&
    currentFilePath===${JSON.stringify(fixture)} && originalMarkdown===${JSON.stringify(markdown)} &&
    readingDisplay?.source?.source===${JSON.stringify(markdown)} &&
    viewer.querySelector('h1')?.textContent==='Native history Alpha' &&
    !loadingScreen.classList.contains('active') && readingRenderCompletion===null && window.readingLocationAdapter.available()`);
  await exec("(" + installHistoryProbe.toString() + ")(" + JSON.stringify(releaseHistoryBatch) + ")");
  demand("closing the other tab preserves the surviving timeline", (await readState()).availability.forward);
  await api("dispose()");
  await exec("window.CustomTabs.closeTab(" + firstTab + ")");
  demand("actual last-tab close reaches the welcome document", await exec("window.CustomTabs.getTabs().length===0 && currentFilePath===null"));
  const reopenAllowance = { window: observedMain, fixture, consumed: false };
  chooserAllowance = reopenAllowance;
  await exec("document.getElementById('openFile').click();true");
  await waitReady("same path reopened as a new admitted lifetime", `currentFilePath===${JSON.stringify(fixture)} &&
    viewer.querySelector('h1')?.textContent==='Native history Alpha' && readingRenderCompletion===null &&
    !loadingScreen.classList.contains('active') && window.readingLocationAdapter.available()`);
  await exec("if(!indexPanel.classList.contains('visible'))document.getElementById('toggleTocBtn').click();true");
  await waitReady("reopened TOC", "indexList.querySelectorAll('button.index-item').length===4 && window.readingLocationAdapter.available()");
  const reopened = await exec("(" + installHistoryProbe.toString() + ")(" + JSON.stringify(releaseHistoryBatch) + ")");
  demand("reopening the same physical file does not resurrect the closed lifetime's timeline",
    reopenAllowance.consumed && chooserCalls === 3 && reopened.tab !== firstTab &&
    !reopened.availability.back && !reopened.availability.forward, reopened);
  await waitForReleaseCapture("release08-reopened-empty");
  await capture("release08-reopened-empty");

  const capPoints = [];
  capPoints.push(await api("save('cap0')"));
  for (let index = 1; index <= 12; index++) {
    const heading = ["Native history Beta", "Native history Gamma", "Native history Tail"][(index - 1) % 3];
    await api("jump(" + JSON.stringify(heading) + ")");
    capPoints.push(await api("save('cap" + index + "')"));
  }
  demand("the cap setup really reaches thirteen separately captured locations",
    capPoints.length === 13 && capPoints.every((point, index) => !index ||
      point.text.start !== capPoints[index - 1].text.start));
  for (let step = 1; step <= 9; step++) {
    await api("history(-1)");
    await api("position('cap" + (12 - step) + "')");
  }
  const capOldest = await readState();
  demand("the retained timeline has exactly nine Back neighbors and drops the oldest entries at ten",
    !capOldest.availability.back && capOldest.availability.forward, capOldest);
  for (let step = 1; step <= 9; step++) {
    await api("history(1)");
    await api("position('cap" + (3 + step) + "')");
  }
  demand("the ten-location cap retains ordered Forward neighbors without an extra stop",
    !(await readState()).availability.forward);
  await waitForReleaseCapture("release09-ten-location-cap");
  await capture("release09-ten-location-cap");
  await api("dispose()");
  const oldPage = await exec("window.getReloadRequestSession()");
  await exec("window.CustomTabs.settleSessionLayout().then(()=>true)");
  let loaded;
  const reloadFinished = new Promise(resolve => { loaded = resolve; observedContents.once("did-finish-load", loaded); });
  try {
    observedContents.reload();
    await bounded(() => reloadFinished, "owned renderer reload");
  } finally { observedContents.removeListener("did-finish-load", loaded); }
  await waitReady("fresh renderer restores the durable active file and final DOM", `
    typeof window.getReloadRequestSession==='function' && window.getReloadRequestSession()!==${JSON.stringify(oldPage)} &&
    currentFilePath===${JSON.stringify(fixture)} && originalMarkdown===${JSON.stringify(markdown)} &&
    viewer.querySelector('h1')?.textContent==='Native history Alpha' && readingRenderCompletion===null &&
    !loadingScreen.classList.contains('active') && window.readingLocationAdapter.available()`);
  const restarted = await exec("(" + installHistoryProbe.toString() + ")(" + JSON.stringify(releaseHistoryBatch) + ")");
  demand("a fresh renderer restores the persisted tab but not the former renderer's populated timeline",
    await exec("window.CustomTabs.getTabs().length===1") &&
    !restarted.availability.back && !restarted.availability.forward, restarted);
  await waitForReleaseCapture("release10-renderer-lifetime-reset", null, oldPage);
  await capture("release10-renderer-lifetime-reset");
  releaseHistoryObservations.push({ gamma, tail, explicit, recovered, failed, repair,
    firstTab, secondTab, beforeCancel, afterCancel, reopened, restarted,
    cap: { reached: capPoints.length, retained: 10, traversedEachDirection: 9 } });
  const alive = await proveSentinelAlive(observedMain, sentinel);
  demand("the error sentinel detects both deliberately provoked channels", alive.console && alive.dom, alive);
  demand("release observations restore the exact original production ports", await api("dispose()"));
}

async function runPublicationProducers() {
  const api = expression => exec("window.__readingHistoryNative." + expression);
  const cases = [
    { name: "prose", file: fixture, source: markdown, tables: false },
    { name: "tables", file: secondFixture, source: secondMarkdown, tables: true },
  ];
  for (const [index, scenario] of cases.entries()) {
    const prefix = "producer " + scenario.name;
    if (index) {
      const cost = isLargeDocument(scenario.source);
      demand(prefix + " fixture cannot invoke the large-document confirmation", cost.large === false, cost);
      const allowance = { window: observedMain, fixture: scenario.file, consumed: false };
      chooserAllowance = allowance;
      await exec("document.getElementById('openFile').click();true");
      await waitReady(prefix + " actual new Source and final DOM", `
        currentFilePath===${JSON.stringify(scenario.file)} && originalMarkdown===${JSON.stringify(scenario.source)} &&
        readingDisplay?.source?.source===originalMarkdown && readingRenderCompletion===null &&
        !loadingScreen.classList.contains('active') && window.readingLocationAdapter.available() &&
        viewer.querySelector('h1')?.textContent==='Native history Alpha'`);
      demand(prefix + " Open consumes only its exact second chooser",
        allowance.consumed && chooserCalls === 2 && chooserAllowance === null);
      await exec("if(!indexPanel.classList.contains('visible'))document.getElementById('toggleTocBtn').click();true");
      await waitReady(prefix + " actual TOC", "indexPanel.classList.contains('visible') && " +
        "indexList.querySelectorAll('button.index-item').length===5 && window.readingLocationAdapter.available()");
      const setup = await exec("(" + installHistoryProbe.toString() + ")(" + JSON.stringify(releaseHistoryBatch) + ")");
      demand(prefix + " newly opened fixture starts with empty history",
        setup.adapter && !setup.availability.back && !setup.availability.forward, setup);
      await api("save('A')");
    }
    await waitReady(prefix + " loaded inline image and actual bulk producers",
      "document.getElementById('collapseAllBtn') && document.getElementById('expandAllBtn') && " +
      "viewer.querySelector('img[alt=\"producer logo\"]')?.complete && " +
      "viewer.querySelector('img[alt=\"producer logo\"]')?.naturalWidth>0");
    const initial = await api("noOpState()");
    const image = await exec(`(() => {
      const img = viewer.querySelector('img[alt="producer logo"]'), wrapper = img.parentElement;
      const bounds = getViewerScroller().getBoundingClientRect(), paragraph = wrapper.parentElement;
      return { before: paragraph.firstChild?.textContent, after: paragraph.lastChild?.textContent,
        offscreen: paragraph.getBoundingClientRect().top>bounds.bottom,
        owned: readingGeneratedContainers.get(img)?.wrapper===wrapper &&
          readingGeneratedContainers.get(img)?.control===wrapper.querySelector('button'),
        tables: viewer.querySelectorAll('table').length,
        visibleTables: [...viewer.querySelectorAll('table')].filter(table => table.getBoundingClientRect().height>0).length,
        headings: viewer.querySelectorAll('h1').length, children: viewer.querySelectorAll('h2').length };
    })()`);
    demand(prefix + " real producer owns an offscreen text-bearing inline image with the intended table setup",
      image.before === "Before " && image.after === " after." && image.offscreen && image.owned &&
      image.headings === 2 && image.children === 3 && image.tables === (scenario.tables ? 2 : 0) &&
      (!scenario.tables || image.visibleTables === 2) && initial.document.edit === false &&
      initial.document.dirty === false && initial.viewport.zoom === 100 &&
      Number(initial.viewport.cssZoom) === 1 && observedContents.getZoomFactor() === 1, image);
    await waitForBranchCapture("A", "Native history Alpha", scenario.file, scenario.source);
    await capture("producer-" + scenario.name + "-01-image-alpha");
    const jump = await api("jump('Native history Mid')");
    const point = await api("save('B')");
    demand(prefix + " actual TOC reaches a distinct surviving H1 with one Back stop",
      jump.record.status === "completed" && jump.record.scope === "request-offsets" &&
      jump.record.travel === "observed-travel" && jump.availability.back && !jump.availability.forward &&
      point.text.start !== initial.source.text.start, { jump, point });
    await api("history(-1)");
    const alpha = await api("position('A')");
    demand(prefix + " actual Back restores exact original Alpha before bulk collapse",
      !alpha.availability.back && alpha.availability.forward, alpha);
    await exec("document.getElementById('collapseAllBtn').click();true");
    await waitReady(prefix + " final collapsed publication", "readingRenderCompletion===null && window.readingLocationAdapter.available()");
    const collapsed = await exec("({ children: [...viewer.querySelectorAll('h2')].every(h => h.classList.contains('collapsed'))," +
      " parents: [...viewer.querySelectorAll('h1')].every(h => !h.classList.contains('collapsed')) })");
    demand(prefix + " actual Collapse All publishes while both H1 destinations survive",
      collapsed.children && collapsed.parents, collapsed);
    await api("history(1)");
    const collapsedMid = await api("position('B')");
    demand(prefix + " Forward restores exact saved visible Mid after Collapse All",
      collapsedMid.availability.back && !collapsedMid.availability.forward, collapsedMid);
    await waitForBranchCapture("B", "Native history Mid", scenario.file, scenario.source);
    await capture("producer-" + scenario.name + "-02-collapsed-mid");
    await api("history(-1)");
    const expandedAlpha = await api("position('A')");
    demand(prefix + " Back again restores exact visible Alpha before Expand All",
      !expandedAlpha.availability.back && expandedAlpha.availability.forward, expandedAlpha);
    await exec("document.getElementById('expandAllBtn').click();true");
    await waitReady(prefix + " final expanded publication", "readingRenderCompletion===null && window.readingLocationAdapter.available()");
    demand(prefix + " actual Expand All publishes every actual heading expanded",
      await exec("[...viewer.querySelectorAll('h1,h2')].every(h => !h.classList.contains('collapsed'))"));
    await api("history(1)");
    const expandedMid = await api("position('B')");
    demand(prefix + " Forward restores exact saved visible Mid after Expand All",
      expandedMid.availability.back && !expandedMid.availability.forward, expandedMid);
    await waitForBranchCapture("B", "Native history Mid", scenario.file, scenario.source);
    await capture("producer-" + scenario.name + "-03-expanded-mid");
    const final = await api("noOpState()");
    demand(prefix + " producer journey preserves exact Source editor selection dirty state Undo/Redo and zoom",
      isDeepStrictEqual(final.document, initial.document) && final.source.text.sourceKey === initial.source.text.sourceKey &&
      final.viewport.zoom === initial.viewport.zoom && final.viewport.cssZoom === initial.viewport.cssZoom &&
      observedContents.getZoomFactor() === 1, { initial, final });
    producerObservations.push({ case: scenario.name, file: scenario.file, sourceSha256: digest(scenario.source),
      initial, image, jump, alpha, collapsed, collapsedMid, expandedAlpha, expandedMid, final });
    demand(prefix + " observational wrappers restore the exact original production ports", await api("dispose()"));
  }
  const expectedCaptures = cases.flatMap(scenario => ["01-image-alpha", "02-collapsed-mid", "03-expanded-mid"]
    .map(name => "producer-" + scenario.name + "-" + name + ".png"));
  demand("producer companion completes both ordered cases and exactly six original endpoint captures",
    producerObservations.length === 2 &&
    isDeepStrictEqual(captures.map(record => path.basename(record.path)), expectedCaptures), { expectedCaptures });
  const alive = await proveSentinelAlive(observedMain, sentinel);
  demand("the error sentinel detects both deliberately provoked channels", alive.console && alive.dom, alive);
}
