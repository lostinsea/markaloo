"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8").replace(/\r\n/g, "\n");
const renderer = read("renderer.js");
function section(source, first, last) {
  const start = source.indexOf(first), end = source.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, "Actual source section exists: " + first);
  return source.slice(start, end);
}
const body = (first, last) => section(renderer, first, last);
const lifecycleFixture = fs.readFileSync(path.join(__dirname, "reading-viewport-lifecycle-controls.js"), "utf8").replace(/\r\n/g, "\n");
// Reuse existing explicit DOM/geometry/native-request ports. This executes the
// actual lifetime model and shared instant helper, not a browser or A's mapper.
const makeInstant = new Function("read", "body", "vm", "assert",
  section(lifecycleFixture, "  function node(", "\n  function fixture(") +
  section(lifecycleFixture, "  function fixture(", "\n  function loadInput(") +
  section(lifecycleFixture, "  function instantFixture(", '\n  await test("instant completion') +
  "\nreturn instantFixture;")(read, body, vm, assert);

function fixture({ split = false } = {}) {
  const f = makeInstant(), models = [], errors = [], nativeCalls = [], restores = [], restoreIntents = [], subscribers = [];
  const readingBox = split ? f.viewer : f.nested;
  if (split) {
    f.viewer.computed.overflowY = "auto";
    f.nested.computed.overflowX = f.nested.computed.overflowY = "visible";
    f.viewer.scrollHeight = 1500;
    Object.assign(f.editor, { scrollTop: 0, scrollHeight: 1500, clientHeight: 600, value: "# fixture" });
    f.c.isEditMode = true;
  }
  const state = { available: true, hold: false, holdRestore: false, desired: { left: 0, top: 0 },
    raw: { interrupted: false }, captureRefused: false, captureReason: "controlled-refusal", inputWitnesses: [] };
  vm.runInContext(read("reading-history.js"), f.c);
  const actualCreate = f.window.MarkalooReadingHistory.createReadingHistory;
  f.window.MarkalooReadingHistory = { createReadingHistory() {
    const model = actualCreate(); models.push(model); return model;
  } };
  const originalNative = f.target.scrollIntoView;
  f.target.scrollIntoView = options => {
    f.state.request = state.hold ? new Promise(resolve => { state.release = resolve; }) : Promise.resolve(state.raw);
    nativeCalls.push({ target: f.target, options, request: f.state.request });
    return originalNative(options);
  };
  f.state.move = () => {
    readingBox.scrollLeft = state.desired.left; readingBox.scrollTop = state.desired.top;
    f.target.shape = [20, 120, 60, 140];
  };
  const value = () => f.run("JSON.parse(" + JSON.stringify(JSON.stringify({
    left: readingBox.scrollLeft, top: readingBox.scrollTop,
    heading: { id: "target-source", text: "exact target", occurrence: 0 },
  })) + ")");
  const adapter = {
    available: () => state.available,
    capture: () => state.captureRefused ? { status: "unavailable", reason: state.captureReason } :
      { status: "captured", location: value() },
    restore(location, intent) {
      restores.push(location); restoreIntents.push(intent);
      state.desired = { left: location.left, top: location.top };
      return f.c.scrollElementIntoView(f.target, "nearest", intent).completion;
    },
  };
  f.window.readingLocationAdapter = adapter;
  Object.assign(f.c, { pendingSearchRequest: null, pendingSearchTerm: null, searchDebounceTimer: null,
    target: f.target, fileOpenSequence: 1, renderGeneration: 1, readingPresentationRevision: 1,
    readingDisplay: { tab: f.first, key: {}, selection: 1, generation: 1, source: "# fixture" },
    console: { log: console.log, error: (...args) => errors.push(args) } });
  vm.runInContext(body("function readingPresentationContext(", "\nfunction readingSourceIdentity(") +
    body("function getViewerScroller()", "\n// Returns `scroller`"), f.c);
  vm.runInContext(body("const readingZoomWheelIntents =", "\n// Which element actually scrolls"), f.c);
  if (split) {
    const capture = f.c.captureReadingInputWitness;
    f.c.captureReadingInputWitness = target => {
      const witness = capture(target); state.inputWitnesses.push(witness); return witness;
    };
  }
  vm.runInContext(body("function flushPendingSearch(", "\nfunction cancelPendingSearch(") +
    body("function createReadingHistoryConsumer(", "\n// ============================================\n// UNDO / REDO HISTORY"), f.c);
  let scrollCallback;
  f.document.addEventListener = (type, callback, capture) => {
    assert.equal(type, "scroll"); assert.equal(capture, true); scrollCallback = callback;
  };
  state.contextMenuHides = 0;
  f.c.hideContextMenu = () => { state.contextMenuHides++; };
  vm.runInContext(body("function observeReadingDocumentScroll(", "\nwindow.addEventListener('resize', hideContextMenu)"), f.c);
  const scroll = target => scrollCallback({ type: "scroll", target, isTrusted: false });
  const tracking = body("const tableHeaderTracking = (() => {", "\n  function resetActive() {");
  vm.runInContext("var dirty = false; function schedule() {}\n" +
    tracking.slice(tracking.indexOf("  function invalidate() {")), f.c);
  const layout = () => f.c.invalidate();
  const controls = f.window.readingHistoryControls;
  controls.subscribe(() => subscribers.push({ ...controls.availability() }));
  const jump = (top, left = 0, segment = null, before = null) => {
    state.desired = { left, top }; Object.assign(f.c, { segment, before });
    return f.run("readingHistory.jump(target, 'start', readingViewport.beginIntent(), {segment, before})");
  };
  const beginTyping = () => f.run("readingHistory.beginTyping(readingViewport.beginIntent())");
  const manual = () => f.input("wheel", readingBox, { deltaX: 1 });
  const switchTo = tab => {
    f.state.active = tab;
    f.c.readingDisplay = { ...f.c.readingDisplay, tab, key: {} };
    f.window.dispatchEvent(new Event("reading-history-owner-changed"));
  };
  return { ...f, state, models, errors, nativeCalls, restores, restoreIntents, subscribers, controls, adapter, value, readingBox,
    jump, beginTyping, manual, scroll, layout, switchTo, snapshot: () => models[0].snapshot() };
}

function splitFollowing(f) {
  const source = read("editor-scroll.js"), frames = new Map(), paneListeners = new Map();
  let frameId = 0, admission;
  for (const pane of [f.editor, f.viewer]) {
    const listeners = new Map(); paneListeners.set(pane, listeners);
    pane.addEventListener = (type, callback) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    };
  }
  Object.assign(f.c, {
    Element: class { static [Symbol.hasInstance](element) { return element?.nodeType === 1; } },
    performance: { now: () => 0 },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  vm.runInContext(section(source, "window.createEditorScroll = function (", "\n  function clearGeometry() {") +
    section(source, "  function upperBound(", "\n  function sliceView(") +
    section(source, "  function usable()", "\n  // Reading publication") +
    section(source, "  function schedule()", "\n  function invalidate()") +
    "\nfunction rebuild() { throw new Error('Stable split fixture unexpectedly rebuilt its mapping'); }\n" +
    section(source, "  let editorMax = 0, previewMax = 0;", "\n  document.fonts?.addEventListener") +
    "\ncommitted = { source: editor.value, selection: identity() };" +
    "\neditorMax = editor.scrollHeight - editor.clientHeight; previewMax = preview.scrollHeight - preview.clientHeight;" +
    "\nanchors = [{ editor: 0, preview: 0 }, { editor: editorMax, preview: previewMax }];" +
    "\nscrollPoints.editor = scrollPoints.preview = anchors;\nreturn {\n" +
    section(source, "    previewNavigation() {", "\n    isCurrentSource(") +
    "\nstate() { return { owner, frame, writes: stats.writes, ready: !!usable() && anchors.length > 0," +
    " matchesSource: committed.source === editor.value }; }\n};\n};", f.c);
  const controller = f.window.createEditorScroll({
    editor: f.editor, preview: f.viewer, active: () => f.c.isEditMode,
    frozen: f.c.frozenForShutdown, identity: () => f.c.fileOpenSequence, scale: () => 1,
  });
  f.c.editorScroll = controller;
  f.window.addEventListener("reading-history-input-admitted", event => { admission = event; });
  const emit = (pane, type, event = { type, target: pane }) => {
    for (const callback of paneListeners.get(pane).get(type) || []) callback(event);
  };
  return {
    controller, emit, pending: () => frames.size, admission: () => admission,
    input(type, pane, fields) { const event = f.input(type, pane, fields); emit(pane, type, event); },
    drain() {
      const next = frames.entries().next();
      if (next.done) return false;
      const [id, callback] = next.value; frames.delete(id); callback(); return true;
    },
  };
}

// Compose A's production Source/producer/adapter actor with the real lifetime,
// history and UI consumers. Only DOM geometry and native requests are ports.
const modeFixtureSource = fs.readFileSync(path.join(__dirname, "test-reading-mode-integration.js"), "utf8");
const makeLocation = new Function("require", "__dirname",
  section(modeFixtureSource, '"use strict";', "const cases = [];") + "\nreturn integration;")(require, __dirname);
function assembledFixture(text = "# Alpha\n\n# Beta") {
  const a = makeLocation(text), { s: c, f } = a, window = c.window, document = f.doc;
  const models = [], errors = [], nativeCalls = [], listeners = new Map(), subscribers = [];
  window.addEventListener = (name, callback) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
  };
  window.removeEventListener = (name, callback) => listeners.get(name)?.delete(callback);
  window.dispatchEvent = event => {
    a.events.push(event.type);
    for (const callback of listeners.get(event.type) || []) callback(event);
    return true;
  };
  const html = new f.preview.constructor("HTML");
  html.root = true; html.doc = document; html.append(f.body);
  Object.assign(document, { documentElement: html, body: f.body, scrollingElement: html,
    querySelector: () => null, activeElement: f.body });
  Object.assign(window, { innerWidth: 200, innerHeight: 200, scrollX: 0, scrollY: 0,
    visualViewport: { width: 200, height: 200, offsetLeft: 0, offsetTop: 0,
      pageLeft: 0, pageTop: 0, scale: 1 } });
  const computed = c.getComputedStyle;
  c.getComputedStyle = (node, pseudo) => pseudo ? computed(node, pseudo) :
    ({ rotate: "none", scale: "none", translate: "none", filter: "none",
      zoom: "1", direction: "ltr", scrollSnapType: "none", ...computed(node) });
  f.body.scrollWidth = 400; f.body.style.overflowX = "auto";
  const blocks = f.preview.childNodes.filter(node => node.nodeType === 1);
  for (const node of [html, f.body, f.preview, ...f.preview.querySelectorAll("*")]) {
    node.getRootNode = () => document;
    node.getClientRects = () => [node.getBoundingClientRect()];
  }
  for (const [index, block] of blocks.entries()) {
    const rawTop = block.tagName === "PRE" ? 0 : 20 + index * 180;
    block.getBoundingClientRect = () => f.rect(20 - f.body.scrollLeft,
      rawTop - f.body.scrollTop, 40, 20);
    for (const node of f.preview.querySelectorAll("*").filter(node => block.contains(node))) {
      if (node !== block) node.getBoundingClientRect = block.getBoundingClientRect;
    }
    const texts = document.createTreeWalker(block, 4);
    for (let node = texts.nextNode(); node; node = texts.nextNode()) {
      node.geometry = from => f.rect(20 + from * 8 - f.body.scrollLeft -
        (block.tagName === "PRE" ? block.scrollLeft : 0),
      (block.tagName === "PRE" ? 50 : rawTop) - f.body.scrollTop -
        (block.tagName === "PRE" ? block.scrollTop : 0));
      const rect = node.geometry;
      node.geometry = from => [rect(from)];
    }
    if (block.tagName === "PRE") {
      block.scrollWidth = 400;
      block.getBoundingClientRect = () => f.rect(-f.body.scrollLeft, -f.body.scrollTop, 100, 100);
    } else {
      Object.defineProperty(block, "id", { get: () => block.getAttribute("id"),
        set: value => block.setAttribute("id", value) });
      block.scrollIntoView = options => {
        nativeCalls.push({ target: block, options });
        f.body.scrollTop = rawTop - 20;
        return Promise.resolve({ interrupted: false });
      };
    }
  }
  Object.assign(c, { contentWrapper: f.body, markdownEditor: f.editor, originalMarkdown: text,
    hasUnsavedChanges: false, pendingSearchRequest: null, pendingSearchTerm: null, searchDebounceTimer: null,
    mayMutateRendererDocument: () => true,
    console: { log: console.log, error: (...args) => errors.push(args) },
    MutationObserver: class {
      observe(node, options) { assert.equal(node, f.preview); assert(options.childList && options.subtree); }
      takeRecords() { return []; }
      disconnect() {}
    } });
  f.editor.value = text;
  vm.runInContext(read("reading-viewport.js") + "\n" + read("reading-history.js"), c);
  const create = window.MarkalooReadingHistory.createReadingHistory;
  window.MarkalooReadingHistory = { createReadingHistory() {
    const model = create(); models.push(model); return model;
  } };
  vm.runInContext(body("function createReadingViewportLifecycle(", "\nconst readingZoomWheelIntents =") +
    body("function readingInputContext(", "\n// Which element actually scrolls") +
    body("function captureReadingJump(", "\n// Current file tracking") +
    body("function flushPendingSearch(", "\nfunction cancelPendingSearch(") +
    body("function createReadingHistoryConsumer(", "\n// ============================================\n// UNDO / REDO HISTORY"), c);
  const controls = window.readingHistoryControls;
  controls.subscribe(() => subscribers.push({ ...controls.availability() }));
  return { ...a, c, window, document, viewer: f.preview, models, errors, nativeCalls, subscribers, controls,
    api: window.readingViewport, run: source => vm.runInContext(source, c),
    snapshot: () => models[0].snapshot() };
}
function installTOC(f) {
  const buttons = [], lookup = f.document.getElementById, create = f.document.createElement;
  f.document.getElementById = id => f.viewer.querySelectorAll("*").find(node => node.id === id) || lookup(id);
  f.document.createElement = tag => {
    if (tag !== "button") return create(tag);
    const callbacks = {};
    return { dataset: {}, addEventListener(type, cb) { callbacks[type] = cb; }, click() { callbacks.click(); } };
  };
  Object.assign(f.c, { tocEntries: [], indexList: { innerHTML: "", appendChild: button => buttons.push(button) },
    tocTracking: { invalidate() {} } });
  vm.runInContext(body("function slugifyHeading(", "\nlet tocEntries =") +
    body("function buildTableOfContents(", "\nconst tocTracking =") +
    body("function expandToHeader(", "\n// Store the final user choice"), f.c);
  f.c.headers = f.viewer.querySelectorAll("h1");
  f.run("buildTableOfContents(headers)");
  // Rendering publishes only after the actual heading-ID producer has run.
  f.c.refreshReadingPresentation();
  return buttons;
}

function installControls(f) {
  const callbacks = new Map(), buttons = {};
  const element = () => ({
    nodeType: 1, disabled: true, closest: () => null, setAttribute() {},
    addEventListener(type, callback) { this[type] = callback; },
    removeEventListener(type) { delete this[type]; },
    click() {
      assert.equal(this.disabled, false, "The actual UI enabled this control");
      this.clickHandler({ target: this });
    },
  });
  for (const id of ["readingBackBtn", "readingForwardBtn"]) {
    const button = element();
    button.addEventListener = (type, callback) => { button[type + "Handler"] = callback; };
    button.removeEventListener = (type, callback) => {
      if (button[type + "Handler"] === callback) delete button[type + "Handler"];
    };
    buttons[id] = button;
  }
  f.document.getElementById = id => buttons[id] || null;
  f.document.querySelectorAll = () => [];
  f.document.addEventListener = (type, callback) => callbacks.set(type, callback);
  f.document.removeEventListener = type => callbacks.delete(type);
  f.window.markaloo = {
    platform: "win32",
    onReadingHistoryCommand(callback) { callbacks.set("command", callback); return () => callbacks.delete("command"); },
    onMainDialogVisibility(callback) { callbacks.set("dialog", callback); return () => callbacks.delete("dialog"); },
  };
  const NativeObserver = f.c.MutationObserver;
  Object.assign(f.c, { editorHistoryComposing: () => false, i18n: key => key,
    MutationObserver: class {
      observe(node, options) { assert.equal(node, f.document.body); assert(options.childList); }
      disconnect() {}
    } });
  vm.runInContext(body("let readingHistoryControlState = null;",
    "\n// ============================================\n// KEYBOARD SHORTCUTS") + "\ninstallReadingHistoryControls();", f.c);
  f.c.MutationObserver = NativeObserver;
  return { back: buttons.readingBackBtn, forward: buttons.readingForwardBtn, callbacks };
}

function installSearch(f) {
  const callbacks = new Map(), highlights = [];
  const control = name => ({
    value: "", disabled: false, addEventListener: (type, cb) => callbacks.set(name + ":" + type, cb),
    focus() {}, select() {},
  });
  const input = control("input");
  const second = { ...f.target, textContent: "second exact target", shape: [20, 700, 60, 720] };
  second.getBoundingClientRect = () => ({ left: second.shape[0], top: second.shape[1],
    right: second.shape[2], bottom: second.shape[3] });
  second.getClientRects = () => [second.getBoundingClientRect()];
  second.scrollIntoView = options => {
    const request = Promise.resolve({ interrupted: false });
    f.nativeCalls.push({ target: second, options, request });
    f.nested.scrollTop = 300; f.nested.scrollLeft = 47; second.shape = [20, 120, 60, 140];
    return request;
  };
  for (const match of [f.target, second]) match.classList = { add() {}, remove() {} };
  let visible = true;
  Object.assign(f.c, {
    searchInput: input, searchPrevBtn: control("previous"), searchNextBtn: control("next"),
    searchCloseBtn: control("close"), searchCounter: {}, searchMatches: [], currentMatchIndex: -1,
    currentMatchEl: null, searchPanel: { classList: { toggle: () => visible = !visible } },
    TIMING: { searchDebounceDelay: 160 }, i18n: key => key,
    clearSearchHighlights() { f.c.searchMatches = []; f.c.currentMatchEl = null; f.c.currentMatchIndex = -1; },
    highlightSearchTerm(term, request) {
      highlights.push({ term, request });
      f.c.searchMatches = [f.target, second]; f.c.currentMatchIndex = 0;
      f.c.highlightCurrentMatch(request); f.c.updateSearchCounter();
    },
  });
  vm.runInContext(body("function highlightCurrentMatch(", "\n// A disabled button") +
    body("function syncSearchNavDisabled(", "\n// Index/TOC functionality"), f.c);
  return {
    highlights,
    type(term) { input.value = term; callbacks.get("input:input")({ target: input }); },
    fire() {
      const callback = Array.from(f.timers.values()).at(-1);
      assert.equal(typeof callback, "function", "The actual input handler scheduled its debounce");
      callback();
    },
    next() { callbacks.get("next:click")(); },
    close() { callbacks.get("close:click")(); },
  };
}
let total = 0, passed = 0;
async function test(name, action) {
  total++;
  try { await action(); passed++; console.log("PASS " + name); }
  catch (error) { console.log("FAIL " + name + "  -> " + error.stack); }
}
const positions = f => Array.from(f.snapshot().entries, entry => entry.location.top);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function seed(f) { assert.equal(await f.jump(80, 7), true); assert.equal(await f.jump(160, 19), true); }

const nativeHistorySource = fs.readFileSync(path.join(__dirname, "test-reading-history-native.js"), "utf8").replace(/\r\n/g, "\n");
const actualProbe = section(nativeHistorySource, "function installHistoryProbe(", "\nasync function run(");
const actualInjection = nativeHistorySource.split("\n").find(line => line.includes('await exec("(" + installHistoryProbe.toString()'));
const actualFailureReadback = section(nativeHistorySource, "  const beforeFailure = await readState();",
  '  demand("a genuinely unrecordable native jump preserves Source viewport and the existing Forward branch"');
async function clippedProbeFixture({ source = actualProbe, small = false, move = false, hold = false } = {}) {
  const f = fixture();
  await seed(f); assert.equal(await f.controls.navigate(-1), true);
  const original = "# Source remains unchanged";
  Object.assign(f.editor, { value: original, selectionStart: 2, selectionEnd: 8,
    selectionDirection: "forward", scrollLeft: 0 });
  Object.assign(f.viewer, { shape: small ? [20, 20, 100, 100] : [20, -100, 560, 900],
    clientWidth: 540, clientHeight: 1000, offsetWidth: 540, offsetHeight: 1000 });
  f.wrapper.computed.overflowY = "auto";
  f.wrapper.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 600, height: 600, width: 600 });
  const raw = { interrupted: false };
  f.viewer.scrollIntoView = options => {
    if (move) f.wrapper.scrollTop += 3;
    const request = hold ? new Promise(resolve => { f.release = () => resolve(raw); }) : Promise.resolve(raw);
    f.nativeCalls.push({ target: f.viewer, options, request }); return request;
  };
  Object.freeze(f.adapter);
  Object.assign(f.c, { structuredClone, Element: class { scrollIntoView() {} scrollTo() {} },
    readingHistoryControlState: { core: f.controls }, captureReadingLocation: f.adapter.capture,
    currentFilePath: "same.md", originalMarkdown: original, readingDisplay: { source: { source: original } },
    hasUnsavedChanges: false, undoHistory: [original], redoHistory: [], isEditMode: false, zoomLevel: 100,
    searchInput: { value: "" }, searchMatches: [], currentMatchIndex: -1, currentMatchEl: null });
  vm.runInContext(body("function getViewerScroller(", "\nfunction captureReadingJump("), f.c);
  const inject = new Function("exec", "releaseHistoryBatch", source +
    "\nreturn (async () => {" + actualInjection + "\n})();");
  await inject(script => f.run(script), true);
  const probe = f.window.__readingHistoryNative, observations = [];
  const retain = new Function("api", "releaseFailureObservations", "readState",
    "return (async () => {" + actualFailureReadback + "\nreturn {failed, afterFailure};})();");
  return { ...f, probe, raw, observations, release: () => f.release(), retain: () => retain(expression =>
    f.run("window.__readingHistoryNative." + expression), observations, () => probe.noOpState()) };
}

(async () => {
  await test("actual injected clipped callback awaits the original native request through the real helper and history consumer", async () => {
    const f = await clippedProbeFixture({ hold: true }), before = f.snapshot(), calls = f.nativeCalls.length;
    let completed = false;
    const pending = f.retain().finally(() => { completed = true; });
    await tick();
    assert.equal(completed, false); assert.equal(f.nativeCalls.length, calls + 1);
    const native = f.nativeCalls.at(-1);
    assert.equal(native.target, f.viewer);
    assert.deepEqual({ ...native.options }, { behavior: "instant", block: "nearest", inline: "nearest" });
    f.release();
    const { failed } = await pending;
    assert.equal(failed.requestResult, f.raw);
    assert.equal(failed.calls, 1); assert.equal(failed.requestPresent, true); assert.equal(failed.completionPresent, true);
    assert.equal(failed.committed, false); assert.equal(failed.record.status, "unrecordable");
    assert.equal(failed.record.reason, "target-clipped");
    assert.deepEqual(f.snapshot(), before); assert.equal(failed.availability.forward, true);
    assert.equal(JSON.stringify(failed.before), JSON.stringify(failed.after));
    assert.equal(JSON.stringify(failed.geometryBefore), JSON.stringify(failed.geometryAfter));
    assert.equal(f.observations[0].observation, failed);
  });
  await test("invalid clipping geometry refuses before issuance and retains the actual callback failure and state", async () => {
    const f = await clippedProbeFixture({ small: true }), calls = f.nativeCalls.length;
    await assert.rejects(f.retain(), /span both vertical scrollport edges/);
    assert.equal(f.nativeCalls.length, calls);
    const kept = f.observations[0];
    assert.match(kept.error, /span both vertical scrollport edges/);
    assert.match(kept.observation.error, /span both vertical scrollport edges/);
    assert.equal(kept.observation.calls, 0); assert.equal(kept.observation.requestPresent, false);
    assert(kept.observation.geometryBefore && kept.observation.after && kept.after);
  });
  await test("actual helper early refusal is not an issued-unrecordable request despite one observing-wrapper call", async () => {
    const boundary = 'const pending = readingHistory.jump(target, "nearest", readingViewport.beginIntent());';
    assert.equal(actualProbe.split(boundary).length, 2);
    const f = await clippedProbeFixture({ source: actualProbe.replace(boundary,
      "target.isConnected = false;\n        " + boundary) }), calls = f.nativeCalls.length;
    await assert.rejects(f.retain(), /Clipped request and readback failed/);
    assert.equal(f.nativeCalls.length, calls);
    const kept = f.observations[0].observation;
    assert.equal(kept.calls, 1); assert.equal(kept.requestPresent, false); assert.equal(kept.completionPresent, false);
    assert.match(kept.error, /original completion exactly once/);
    assert.match(kept.readbackError, /unsupported-chain/);
  });
  await test("actual completed-no-travel receipt cannot substitute for target-clipped recording failure", async () => {
    const guard = "ensure(g.connected && g.owned";
    assert.equal(actualProbe.split(guard).length, 2);
    const f = await clippedProbeFixture({ small: true,
      source: actualProbe.replace(guard, "ensure(true || g.connected && g.owned") });
    await assert.rejects(f.retain(), /fail recording because its target is clipped/);
    const kept = f.observations[0].observation;
    assert.equal(kept.requestResult.interrupted, false); assert.equal(kept.committed, false);
    assert.equal(kept.record.status, "completed"); assert.equal(kept.record.travel, "no-observed-travel");
    assert.equal(kept.availability.forward, true);
    assert.match(kept.error, /target is clipped/);
  });
  await test("genuine target-clipped failure does not undo native movement and the callback rejects changed viewport", async () => {
    const f = await clippedProbeFixture({ move: true }), before = f.snapshot();
    await assert.rejects(f.retain(), /preserve exact Source viewport document selection history zoom and ancestor geometry/);
    const kept = f.observations[0];
    assert.equal(kept.observation.record.status, "unrecordable");
    assert.equal(kept.observation.record.reason, "target-clipped"); assert.equal(kept.observation.committed, false);
    assert.equal(kept.observation.after.viewport.top, kept.observation.before.viewport.top + 3);
    assert.equal(kept.after.viewport.top, 3); assert.equal(f.wrapper.scrollTop, 3);
    assert.deepEqual(f.snapshot(), before); assert.equal(kept.after.availability.forward, true);
    assert.match(kept.error, /preserve exact Source viewport/);
  });
  await test("actual consumer records an instant jump then Back and Forward through the shared request path", async () => {
    const f = fixture();
    assert.deepEqual({ ...f.controls.availability() }, { back: false, forward: false });
    assert.equal(await f.jump(80, 7), true);
    assert.deepEqual(positions(f), [0, 80]);
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 0); assert.equal(f.nested.scrollLeft, 0);
    assert.equal(await f.controls.navigate(1), true);
    assert.equal(f.nested.scrollTop, 80); assert.equal(f.nested.scrollLeft, 7);
    assert.equal(f.nativeCalls.length, 3);
    assert(f.nativeCalls.every(call => call.target === f.target && call.options.behavior === "instant" &&
      call.options.inline === "nearest"));
    assert.equal(f.snapshot().index, 1); assert.equal(f.errors.length, 0);
  });
  await test("actual TOC jump and toolbar Back/Forward share live history, availability and instant requests", async () => {
    const f = assembledFixture(), ui = installControls(f), buttons = installTOC(f);
    assert.equal(buttons.length, 2); assert.equal(buttons[1].dataset.headerId, "beta");
    const before = f.capture();
    assert.equal(before.status, "captured", "real displayed Source supplies the departure");
    const editor = [f.f.editor.value, f.f.editor.scrollLeft, f.c.originalMarkdown, f.c.hasUnsavedChanges];
    buttons[1].click(); await tick();
    assert.equal(f.snapshot().entries.length, 2); assert.equal(f.snapshot().index, 1);
    assert.equal(f.f.body.scrollTop, 180);
    assert.equal(f.subscribers.at(-1).back, true);
    ui.back.click(); await tick(); assert.equal(f.f.body.scrollTop, 0);
    assert.equal(JSON.stringify(f.capture().location), JSON.stringify(before.location));
    assert.equal(f.subscribers.at(-1).forward, true);
    ui.forward.click(); await tick(); assert.equal(f.f.body.scrollTop, 180);
    assert.equal(f.nativeCalls.length, 1, "only TOC uses the element jump; traversal uses the actual location adapter");
    assert.equal(f.writes.length, 2); assert(f.writes.every(write => write.request.behavior === "instant"));
    assert.deepEqual([f.f.editor.value, f.f.editor.scrollLeft, f.c.originalMarkdown, f.c.hasUnsavedChanges], editor);
    assert.equal(f.f.effects.selections, 0); assert.equal(f.errors.length, 0);
  });
  await test("assembled history restores a source-backed nested origin on both axes with one permit", async () => {
    const f = assembledFixture("```\n0123456789012345678901234567890123456789\n```\n\n# Beta");
    const ui = installControls(f), buttons = installTOC(f), pre = f.viewer.querySelector("pre");
    assert(pre.scrollHeight > pre.clientHeight && pre.scrollWidth > pre.clientWidth);
    assert(f.f.body.scrollWidth > f.f.body.clientWidth);
    pre.scrollTop = 30; pre.scrollLeft = 8; f.f.body.scrollLeft = 9;
    const origin = f.capture();
    assert.equal(origin.status, "captured"); assert.equal(origin.location.text.alignment.nested.length, 1);
    buttons[0].click(); await tick();
    assert.equal(f.snapshot().entries.length, 2); assert.equal(f.snapshot().index, 1);
    pre.scrollTop = pre.scrollLeft = f.f.body.scrollLeft = 0;
    ui.back.click(); await tick();
    assert.equal(f.snapshot().index, 0);
    assert.deepEqual([pre.scrollTop, pre.scrollLeft, f.f.body.scrollTop, f.f.body.scrollLeft], [30, 8, 0, 9]);
    assert.equal(JSON.stringify(f.capture().location), JSON.stringify(origin.location));
    assert.equal(f.writes.length, 2, "one actual inner request and one actual outer request settle before commit");
    ui.forward.click(); await tick();
    assert.equal(f.snapshot().index, 1); assert.equal(f.f.body.scrollTop, 180);
    assert.equal(f.f.body.scrollLeft, 0, "Forward returns to the departure actually refreshed before Back");
    assert.equal(f.errors.length, 0);
  });
  await test("actual fragment handler records its resolved document target then toolbar Back and Forward restore it", async () => {
    const f = fixture(), ui = installControls(f), lookup = f.document.getElementById;
    f.target.id = "target-source";
    f.document.getElementById = id => id === f.target.id ? f.target : lookup(id);
    let click;
    f.viewer.addEventListener = (type, callback) => { assert.equal(type, "click"); click = callback; };
    vm.runInContext(body("const URL_BLANK =", "\n// The page owns the drag overlay"), f.c);
    const link = { href: "#target-source", getAttribute: () => "#target-source" };
    let prevented = false;
    f.state.desired = { top: 170, left: 29 };
    click({ target: { closest: () => link }, preventDefault() { prevented = true; } });
    await tick(); assert(prevented); assert.deepEqual(positions(f), [0, 170]);
    ui.back.click(); await tick(); assert.equal(f.nested.scrollTop, 0);
    ui.forward.click(); await tick(); assert.equal(f.nested.scrollTop, 170);
    assert.equal(f.nested.scrollLeft, 29); assert.equal(f.errors.length, 0);
  });
  await test("manual departure after 1 2 4 3 and Back 4 restores checkpoint 4 before consuming older history", async () => {
    const f = fixture();
    for (const top of [100, 200, 400, 300]) assert.equal(await f.jump(top), true);
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 400);
    const checkpoint = f.snapshot();
    f.manual(); f.nested.scrollTop = 450; f.nested.scrollLeft = 27; f.scroll(f.nested);
    assert.deepEqual(f.snapshot(), checkpoint, "ordinary scrolling does not add history");
    assert.equal(await f.controls.navigate(-1), true);
    assert.deepEqual([f.nested.scrollTop, f.nested.scrollLeft], [400, 0]);
    assert.deepEqual(f.snapshot(), checkpoint, "checkpoint return preserves every entry, ID, index and revision");
    assert.equal(f.controls.availability().forward, true);
    assert.equal(checkpoint.entries[checkpoint.index + 1].location.top, 300);
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 200);
    assert.equal(f.snapshot().index, checkpoint.index - 1);
    assert.equal(f.errors.length, 0);
  });
  await test("manual departure after a new jump restores its saved destination on both axes before Back", async () => {
    const f = fixture(); await f.jump(80, 7);
    const checkpoint = f.snapshot();
    f.manual(); f.nested.scrollTop = 117; f.nested.scrollLeft = 31; f.scroll(f.nested);
    assert.deepEqual(positions(f), [0, 80]);
    assert.equal(await f.controls.navigate(-1), true);
    assert.deepEqual([f.nested.scrollTop, f.nested.scrollLeft], [80, 7]);
    assert.deepEqual(f.snapshot(), checkpoint);
    assert.equal(await f.controls.navigate(-1), true);
    assert.deepEqual([f.nested.scrollTop, f.nested.scrollLeft], [0, 0]);
    assert.equal(await f.controls.navigate(1), true);
    assert.deepEqual([f.nested.scrollTop, f.nested.scrollLeft], [80, 7]);
    assert.equal(f.errors.length, 0);
  });
  await test("confirmed checkpoint returns from no-visible-text without a departure receipt or Forward mutation", async () => {
    const f = fixture();
    for (const top of [100, 200, 400, 300]) assert.equal(await f.jump(top), true);
    assert.equal(await f.controls.navigate(-1), true);
    const checkpoint = f.snapshot(), calls = f.restores.length;
    f.manual(); f.nested.scrollTop = 450; f.nested.scrollLeft = 27; f.scroll(f.nested);
    f.state.captureRefused = true; f.state.captureReason = "no-visible-text";
    assert.deepEqual(f.adapter.capture(), { status: "unavailable", reason: "no-visible-text" });
    assert.equal(f.adapter.available(), true, "capture refusal does not retire the published adapter");
    assert.deepEqual({ ...f.controls.availability() }, { back: true, forward: true });
    assert.equal(await f.controls.navigate(1), false, "ordinary Forward still requires a capturable departure");
    assert.equal(f.restores.length, calls); assert.deepEqual(f.snapshot(), checkpoint);
    assert.equal(await f.controls.navigate(-1), true);
    assert.deepEqual([f.nested.scrollTop, f.nested.scrollLeft], [400, 0]);
    assert.equal(f.restores[calls], checkpoint.entries[checkpoint.index].location);
    assert.deepEqual(f.snapshot(), checkpoint, "checkpoint-only restoration leaves the whole model unchanged");
    assert.equal(f.controls.availability().forward, true);
    assert.equal(checkpoint.entries[checkpoint.index + 1].location.top, 300);
    f.state.captureRefused = false;
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 200); assert.equal(f.snapshot().index, checkpoint.index - 1);
    assert.equal(f.errors.length, 0);
  });
  await test("no-motion checkpoint with refused fresh departure cannot traverse or mutate history", async () => {
    const f = fixture(); await seed(f); await f.controls.navigate(-1);
    const checkpoint = f.snapshot(), calls = f.restores.length, restore = f.adapter.restore;
    const completions = [];
    f.adapter.restore = (location, intent) => restore(location, intent).then(record => {
      completions.push(record); return record;
    });
    f.manual(); f.nested.scrollTop = 117; f.scroll(f.nested);
    f.manual(); f.nested.scrollTop = 80; f.scroll(f.nested);
    f.state.captureRefused = true; f.state.captureReason = "no-visible-text";
    assert.deepEqual(f.adapter.capture(), { status: "unavailable", reason: "no-visible-text" });
    assert.equal(f.adapter.available(), true);
    assert.deepEqual({ ...f.controls.availability() }, { back: true, forward: true });
    assert.equal(await f.controls.navigate(-1), false);
    assert.equal(f.restores.length, calls + 1, "only the saved checkpoint is restored");
    assert.equal(completions.length, 1);
    assert.equal(completions[0].travel, "no-observed-travel", "the saved-target request actually completed without travel");
    assert.equal(f.nested.scrollTop, 80); assert.deepEqual(f.snapshot(), checkpoint);
    assert.deepEqual({ ...f.controls.availability() }, { back: true, forward: true });
    f.state.captureRefused = false;
    assert.equal(await f.controls.navigate(-1), true, "a failed departure capture retains the checkpoint for retry");
    assert.equal(f.restores.length, calls + 3);
    assert.equal(f.restoreIntents[calls + 1], f.restoreIntents[calls + 2]);
    assert.equal(f.nested.scrollTop, 0); assert.equal(f.snapshot().index, checkpoint.index - 1);
    assert.equal(f.errors.length, 0);
  });
  await test("a no-motion editor owner handoff cannot retarget a queued preview follower or confirm departure", async () => {
    const f = fixture({ split: true }); assert.equal(await f.jump(400), true);
    const checkpoint = f.snapshot(), p = splitFollowing(f);
    assert.equal(p.controller.state().ready, true); assert.equal(p.controller.state().matchesSource, true);
    assert.deepEqual([f.editor.scrollTop, f.viewer.scrollTop], [0, 400]);
    p.controller.previewNavigation(); assert.equal(p.pending(), 1);
    p.input("pointerdown", f.editor, { button: 0 });
    const admission = p.admission(), witness = f.state.inputWitnesses.at(-1);
    assert(witness, "production editor-pointer admission really captured a pending reading witness");
    assert.equal(witness.context.tab, f.first); assert.equal(witness.context.scroller, f.viewer);
    assert(f.api.isIntentCurrent(admission.intent) && f.api.isPermitCurrent(admission.permit));
    assert.deepEqual(f.snapshot(), checkpoint);
    assert.deepEqual([f.editor.scrollTop, f.viewer.scrollTop], [0, 400], "the admitted editor input caused no movement");
    assert.equal(p.controller.state().owner, "editor");
    p.drain();
    assert(f.api.isIntentCurrent(admission.intent) && f.api.isPermitCurrent(admission.permit));
    f.scroll(f.viewer);
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.snapshot().index, checkpoint.index - 1, "no confirmed manual departure can consume Back");
    assert.equal(f.viewer.scrollTop, 0);
    assert.equal(p.controller.state().writes, 0, "the old preview-following frame never writes through its new owner");
    assert.equal(f.errors.length, 0);
  });
  for (const type of ["wheel", "keydown"]) {
    await test("real editor " + type + " travel schedules fresh following after an owner handoff", async () => {
      const f = fixture({ split: true }); assert.equal(await f.jump(400), true);
      const checkpoint = f.snapshot(), p = splitFollowing(f);
      p.controller.previewNavigation(); assert.equal(p.pending(), 1);
      p.input("pointerdown", f.editor, { button: 0 });
      assert.equal(p.pending(), 0, "the old owner's queued frame was retired");
      p.input(type, f.editor, type === "wheel" ? { deltaY: 50 } : { key: "PageDown" });
      f.editor.scrollTop = 550; p.emit(f.editor, "scroll");
      assert.equal(p.pending(), 1); assert.equal(p.drain(), true);
      assert.equal(f.viewer.scrollTop, 550); assert.equal(p.controller.state().writes, 1);
      f.scroll(f.viewer);
      assert.deepEqual(f.snapshot(), checkpoint, "genuine following does not append history");
      assert.equal(await f.controls.navigate(-1), true);
      assert.equal(f.viewer.scrollTop, 400); assert.deepEqual(f.snapshot(), checkpoint);
      assert.equal(f.errors.length, 0);
    });
  }
  await test("explicit preview navigation queues fresh following and keeps an already preview-owned frame", async () => {
    const f = fixture({ split: true }); assert.equal(await f.jump(400), true);
    const p = splitFollowing(f);
    p.input("pointerdown", f.editor, { button: 0 });
    p.input("wheel", f.editor, { deltaY: 50 });
    f.editor.scrollTop = 550; p.emit(f.editor, "scroll"); assert.equal(p.pending(), 1);
    assert.equal(await f.jump(600), true, "the actual shared jump claims and schedules preview navigation");
    const frame = p.controller.state().frame;
    assert.equal(p.controller.state().owner, "preview"); assert.equal(p.pending(), 1);
    p.controller.previewNavigation();
    assert.equal(p.controller.state().frame, frame, "same-owner navigation retains its queued callback");
    assert.equal(p.drain(), true);
    assert.deepEqual([f.editor.scrollTop, f.viewer.scrollTop], [600, 600]);
    assert.equal(p.controller.state().writes, 1); assert.equal(f.errors.length, 0);
  });
  await test("oldest committed checkpoint enables manual return without creating empty-tab history", async () => {
    const empty = fixture();
    empty.nested.scrollTop = 39; empty.manual();
    assert.equal(empty.snapshot().index, -1);
    assert.equal(empty.controls.availability().back, false);
    assert.equal(await empty.controls.navigate(-1), false);
    assert.equal(empty.restores.length, 0);
    const f = fixture(); await f.jump(80);
    assert.equal(await f.controls.navigate(-1), true);
    const checkpoint = f.snapshot();
    assert.equal(checkpoint.index, 0); assert.equal(checkpoint.canBack, false);
    f.manual(); f.nested.scrollTop = 39; f.scroll(f.nested);
    assert.equal(f.controls.availability().back, true);
    f.state.available = false;
    assert.equal(f.controls.availability().back, false);
    assert.equal(await f.controls.navigate(-1), false);
    f.state.available = true;
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 0); assert.deepEqual(f.snapshot(), checkpoint);
    assert.equal(f.controls.availability().back, false);
    assert.equal(await f.controls.navigate(-1), false);
  });
  await test("no-motion user input does not consume Back as a checkpoint return", async () => {
    const f = fixture(); await seed(f);
    const before = f.snapshot(), calls = f.restores.length;
    f.manual();
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 80);
    assert.equal(f.snapshot().index, before.index - 1);
    assert.equal(f.restores.length, calls + 1, "input alone does not create a confirmed checkpoint return");
    assert.equal(f.errors.length, 0);
  });
  await test("confirmed departure already back at its checkpoint continues ordinary traversal in the same Back", async () => {
    const f = fixture(); await seed(f);
    const before = f.snapshot(), calls = f.restores.length;
    f.manual(); f.nested.scrollTop = 177; f.scroll(f.nested);
    f.manual(); f.nested.scrollTop = 160; f.scroll(f.nested);
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 80); assert.equal(f.snapshot().index, before.index - 1);
    assert.equal(f.restores.length, calls + 2);
    assert.equal(f.restoreIntents[calls], f.restoreIntents[calls + 1], "both restorations keep the same owned input intent");
    assert.equal(f.errors.length, 0);
  });
  await test("programmatic movement and layout invalidation alone do not arm manual checkpoint return", async () => {
    const f = fixture(); await seed(f);
    f.nested.scrollTop = 177; f.api.invalidate();
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 80);
    assert.deepEqual(positions(f), [0, 80, 177]);
    assert.equal(f.restores.length, 1);
  });
  await test("movement before admission and synthetic scroll alone do not prove a manual departure", async () => {
    for (const admit of [false, true]) {
      const f = fixture(); await seed(f);
      f.nested.scrollTop = 177;
      if (admit) f.manual();
      const permit = f.api.capturePermit();
      f.scroll(f.nested);
      assert(f.api.isPermitCurrent(permit), "scroll observation does not mint or retire authority");
      assert.equal(f.state.contextMenuHides, 1, "the existing capture-scroll callback still hides the menu");
      assert.equal(await f.controls.navigate(-1), true);
      assert.equal(f.nested.scrollTop, 80);
      assert.deepEqual(positions(f), [0, 80, 177]);
      assert.equal(f.restores.length, 1);
    }
  });
  await test("confirmed movement survives later layout and no-motion input without losing the saved checkpoint", async () => {
    const f = fixture(); await seed(f);
    const checkpoint = f.snapshot();
    f.manual(); f.nested.scrollTop = 177; f.scroll(f.nested);
    f.manual(); f.layout(); f.api.invalidate();
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 160); assert.deepEqual(f.snapshot(), checkpoint);
  });
  await test("unproved input retired by layout source or mode cannot borrow later scroll movement", async () => {
    for (const change of ["layout", "source", "publication", "presentation", "mode", "extent", "admission", "adoption", "nonfinite", "tab"]) {
      const f = fixture(); await seed(f);
      f.manual();
      if (change === "layout") f.layout();
      if (change === "source") f.api.invalidate();
      if (change === "publication") f.window.dispatchEvent(new Event("reading-location-availability-changed"));
      if (change === "presentation") f.c.readingPresentationRevision++;
      if (change === "mode") f.viewer.computed.overflowY = "auto";
      if (change === "extent") f.nested.clientWidth++;
      if (change === "admission") f.c.readingDisplay = { ...f.c.readingDisplay, key: {} };
      if (change === "adoption") f.nested.ownerDocument = {};
      if (change === "tab") { f.switchTo(f.second); f.switchTo(f.first); }
      f.nested.scrollTop = change === "nonfinite" ? NaN : 177;
      f.scroll(f.nested);
      if (change === "adoption") f.nested.ownerDocument = f.document;
      if (change === "nonfinite") f.nested.scrollTop = 177;
      assert.equal(await f.controls.navigate(-1), true, change);
      assert.equal(f.nested.scrollTop, 80, change);
      assert.deepEqual(positions(f), [0, 80, 177], change);
      assert.equal(f.restores.length, 1, change);
    }
  });
  await test("a queued programmatic restore cannot promote an input witness retired by its request", async () => {
    const f = fixture(); await seed(f);
    f.manual();
    const permit = f.api.beginRequest();
    assert(f.api.isPermitCurrent(permit), "the programmatic request actually owns a new permit");
    f.nested.scrollTop = 177; f.scroll(f.nested);
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 80); assert.equal(f.restores.length, 1);
  });
  await test("nested horizontal movement promotes once and later scroll events do not resample", async () => {
    const f = fixture(); await seed(f);
    const checkpoint = f.snapshot(), capture = f.adapter.capture;
    const savedLeft = checkpoint.entries[checkpoint.index].location.left;
    assert.notEqual(savedLeft, 31, "the controlled horizontal departure differs from its saved checkpoint");
    let semanticCaptures = 0, reads = 0, top = f.nested.scrollTop;
    f.adapter.capture = () => { semanticCaptures++; return capture(); };
    Object.defineProperty(f.nested, "scrollTop", {
      configurable: true, get() { reads++; return top; }, set(value) { top = value; },
    });
    f.manual(); f.nested.scrollLeft = 31; f.scroll(f.nested);
    assert(reads > 0, "the bounded offset witness really sampled the reading box");
    const observed = reads;
    f.scroll(f.nested); f.scroll(f.nested);
    assert.equal(reads, observed, "confirmed input leaves no live geometry witness");
    assert.equal(semanticCaptures, 0, "input and scroll never call the semantic location adapter");
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollLeft, savedLeft); assert.deepEqual(f.snapshot(), checkpoint);
  });
  await test("same-ID replacement retires the exact prior entry witness even when its input permit survives", async () => {
    const f = fixture(), segment = f.beginTyping();
    await f.jump(80, 7, segment);
    const prior = f.snapshot().entries[f.snapshot().index];
    let admission;
    f.window.addEventListener("reading-history-input-admitted", event => { admission = event; });
    f.manual();
    f.nested.scrollTop = 160;
    const receipt = f.models[0].stageReplace(prior.id);
    assert.equal(f.models[0].commit(receipt, f.value(), true).committed, true);
    const replacement = f.snapshot().entries[f.snapshot().index];
    assert.equal(replacement.id, prior.id); assert.notEqual(replacement, prior);
    assert(f.api.isIntentCurrent(admission.intent) && f.api.isPermitCurrent(admission.permit));
    f.scroll(f.nested);
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 0); assert.equal(f.restores.length, 1);
  });
  await test("a settled committed Search replacement supports manual checkpoint return like any destination", async () => {
    const f = fixture(), segment = f.beginTyping();
    await f.jump(80, 7, segment);
    const prior = f.snapshot().entries[f.snapshot().index];
    assert.equal(await f.jump(160, 19, segment), true);
    const checkpoint = f.snapshot(), replacement = checkpoint.entries[checkpoint.index];
    assert.equal(replacement.id, prior.id); assert.notEqual(replacement, prior);
    f.manual(); f.nested.scrollTop = 177; f.nested.scrollLeft = 31; f.scroll(f.nested);
    assert.equal(await f.controls.navigate(-1), true);
    assert.deepEqual([f.nested.scrollTop, f.nested.scrollLeft], [160, 19]);
    assert.deepEqual(f.snapshot(), checkpoint);
    assert.equal(await f.controls.navigate(-1), true); assert.equal(f.nested.scrollTop, 0);
  });
  await test("source reentry during input witness capture cannot promote using the still-current intent", async () => {
    const f = fixture(); await seed(f);
    const context = f.c.readingPresentationContext;
    let captures = 0, admission;
    f.c.readingPresentationContext = () => {
      if (++captures === 1) f.api.invalidate();
      return context();
    };
    f.window.addEventListener("reading-history-input-admitted", event => { admission = event; });
    f.manual();
    assert(captures > 0, "the real witness context port executed its source-only reentry");
    assert(f.api.isIntentCurrent(admission.intent)); assert(!f.api.isPermitCurrent(admission.permit));
    f.nested.scrollTop = 177; f.scroll(f.nested);
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 80); assert.equal(f.restores.length, 1);
  });
  await test("same-ID replacement after checkpoint completion refuses same-Back fallback under obsolete model authority", async () => {
    const f = fixture(); await seed(f);
    f.manual(); f.nested.scrollTop = 177; f.scroll(f.nested);
    f.manual(); f.nested.scrollTop = 160; f.scroll(f.nested);
    const restore = f.adapter.restore;
    let replacement = null, completions = 0;
    f.adapter.restore = (location, intent) => restore(location, intent).then(record => {
      if (++completions === 1) {
        assert.equal(record.travel, "no-observed-travel", "the first completion confirms the current checkpoint");
        const before = f.snapshot(), entry = before.entries[before.index];
        f.nested.scrollTop = 165;
        const receipt = f.models[0].stageReplace(entry.id);
        assert.equal(f.models[0].commit(receipt, f.value(), true).committed, true);
        replacement = f.snapshot();
        assert.equal(replacement.entries[replacement.index].id, entry.id);
        assert.notEqual(replacement.entries[replacement.index], entry);
      }
      return record;
    });
    assert.equal(await f.controls.navigate(-1), false);
    assert.equal(completions, 1, "the intervening replacement arrived after the exact first completion");
    assert.equal(f.restores.length, 1, "obsolete history authority never writes the older destination");
    assert.equal(f.nested.scrollTop, 165); assert.deepEqual(f.snapshot(), replacement);
  });
  await test("malformed checkpoint travel never consumes an older history entry", async () => {
    const f = fixture(); await seed(f);
    const checkpoint = f.snapshot(), restore = f.adapter.restore;
    let completions = 0;
    f.adapter.restore = (location, intent) => restore(location, intent).then(record => {
      completions++;
      return { ...record, travel: "controlled-invalid-travel" };
    });
    f.manual(); f.nested.scrollTop = 177; f.scroll(f.nested);
    assert.equal(await f.controls.navigate(-1), false);
    assert.equal(completions, 1, "the invalid classification came from one completed actual request");
    assert.equal(f.nested.scrollTop, 160, "the request reached the checkpoint, not older history");
    assert.deepEqual(f.snapshot(), checkpoint);
  });
  await test("interrupted checkpoint return retains its target and an old completion cannot clear the successor", async () => {
    const f = fixture(); await seed(f); await f.controls.navigate(-1);
    const checkpoint = f.snapshot();
    f.manual(); f.nested.scrollTop = 117; f.scroll(f.nested); f.state.hold = true;
    const old = f.controls.navigate(-1), releaseOld = f.state.release;
    assert.deepEqual({ ...f.controls.availability() }, { back: false, forward: false });
    assert.equal(await f.controls.navigate(-1), false);
    assert.equal(await f.controls.navigate(1), false);
    f.manual(); f.nested.scrollTop = 139; f.scroll(f.nested);
    const next = f.controls.navigate(-1), releaseNext = f.state.release;
    releaseOld({ interrupted: false }); assert.equal(await old, false);
    assert.deepEqual(f.snapshot(), checkpoint);
    assert.deepEqual({ ...f.controls.availability() }, { back: false, forward: false });
    releaseNext({ interrupted: false }); assert.equal(await next, true);
    assert.equal(f.nested.scrollTop, 80); assert.deepEqual(f.snapshot(), checkpoint);
    f.state.hold = false;
    assert.equal(await f.controls.navigate(-1), true); assert.equal(f.nested.scrollTop, 0);
  });
  await test("checkpoint completion respects source invalidation, tab switches and lifetime retirement", async () => {
    for (const change of ["source", "tab", "retire"]) {
      const f = fixture(); await seed(f); await f.controls.navigate(-1);
      const checkpoint = f.snapshot();
      f.manual(); f.nested.scrollTop = 117; f.scroll(f.nested); f.state.hold = true;
      const pending = f.controls.navigate(-1), release = f.state.release;
      if (change === "source") f.api.invalidate();
      if (change === "tab") f.switchTo(f.second);
      if (change === "retire") f.api.retireTab(f.first);
      release({ interrupted: false }); assert.equal(await pending, false);
      if (change === "retire") {
        assert.equal(f.snapshot().entries.length, 0);
        assert.equal(f.controls.availability().back, false);
      } else {
        assert.deepEqual(f.snapshot(), checkpoint);
        if (change === "tab") f.switchTo(f.first);
        f.state.hold = false;
        f.manual(); f.nested.scrollTop = 139; f.scroll(f.nested);
        assert.equal(f.nested.scrollTop, 139, "the retry starts after a real new manual departure");
        assert.equal(await f.controls.navigate(-1), true);
        assert.equal(f.nested.scrollTop, 80); assert.deepEqual(f.snapshot(), checkpoint);
      }
    }
  });
  await test("deliberate new jumps still sample the manual departure and truncate Forward only on success", async () => {
    const f = fixture(); await seed(f); await f.controls.navigate(-1);
    const checkpoint = f.snapshot();
    f.manual(); f.nested.scrollTop = 117; f.nested.scrollLeft = 31; f.scroll(f.nested);
    f.state.raw = { interrupted: true };
    assert.equal(await f.jump(150), false);
    assert.deepEqual(f.snapshot(), checkpoint);
    assert.equal(f.controls.availability().forward, true);
    f.manual(); f.nested.scrollTop = 117; f.nested.scrollLeft = 31; f.scroll(f.nested);
    f.state.raw = { interrupted: false };
    assert.equal(await f.jump(190, 43), true);
    assert.deepEqual(positions(f), [0, 117, 190]);
    assert.equal(f.snapshot().entries[1].location.left, 31);
    assert.equal(f.controls.availability().forward, false);
    assert.equal(await f.controls.navigate(-1), true); assert.equal(f.nested.scrollTop, 117);
  });
  await test("Forward remains ordinary traversal from the actual manually scrolled departure", async () => {
    const f = fixture(); await seed(f); await f.controls.navigate(-1);
    f.manual(); f.nested.scrollTop = 117; f.nested.scrollLeft = 31; f.scroll(f.nested);
    assert.equal(await f.controls.navigate(1), true);
    assert.equal(f.nested.scrollTop, 160);
    assert.deepEqual(positions(f), [0, 117, 160]);
    assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 117); assert.equal(f.nested.scrollLeft, 31);
  });
  await test("inner-only horizontal travel is recorded without requiring outer movement", async () => {
    const f = fixture(); f.target.shape = [20, 120, 60, 140];
    assert.equal(await f.jump(0, 89), true); assert.equal(f.wrapper.scrollTop, 0);
    assert.equal(await f.controls.navigate(-1), true); assert.equal(f.nested.scrollLeft, 0);
    assert.equal(await f.controls.navigate(1), true); assert.equal(f.nested.scrollLeft, 89);
  });
  await test("failed and no-travel jumps retain index and Forward until a successful branch", async () => {
    const f = fixture(); await seed(f); await f.controls.navigate(-1);
    const revision = f.snapshot().revision;
    assert.equal(await f.jump(80, 7), false); assert.equal(f.snapshot().revision, revision);
    f.state.raw = { interrupted: true }; assert.equal(await f.jump(120), false);
    assert.equal(f.snapshot().revision, revision); assert.equal(f.controls.availability().forward, true);
    f.state.raw = { interrupted: false }; assert.equal(await f.jump(135), true);
    assert.deepEqual(positions(f), [0, 120, 135]); assert.equal(f.controls.availability().forward, false);
  });
  await test("ten total locations including current are enforced by the actual registered model", async () => {
    const f = fixture(); for (let i = 1; i <= 14; i++) await f.jump(i * 30, i);
    assert.equal(f.snapshot().entries.length, 10); assert.equal(f.snapshot().index, 9);
    assert.equal(f.snapshot().entries[0].location.top, 150);
  });
  await test("a held exact native Promise cannot commit before its result", async () => {
    const f = fixture(); f.state.hold = true;
    const pending = f.jump(80); assert.equal(f.nested.scrollTop, 80); assert.equal(f.snapshot().entries.length, 0);
    f.state.release({ interrupted: false }); assert.equal(await pending, true);
  });
  await test("held traversal refuses overlapping Back or Forward without superseding its own pending receipt", async () => {
    const f = fixture(); await seed(f); f.state.hold = true;
    const returning = f.controls.navigate(-1), release = f.state.release;
    assert.equal(f.snapshot().index, 2); assert.equal(f.restores.length, 1);
    assert.deepEqual({ ...f.controls.availability() }, { back: false, forward: false });
    assert.equal(await f.controls.navigate(-1), false); assert.equal(await f.controls.navigate(1), false);
    assert.equal(f.restores.length, 1); release({ interrupted: false });
    assert.equal(await returning, true); assert.equal(f.snapshot().index, 1);
    f.state.hold = false; assert.equal(await f.controls.navigate(1), true);
    assert.equal(f.nested.scrollTop, 160);
  });
  await test("an old request finishing cannot clear its successor operation or staged history", async () => {
    const f = fixture(); f.state.hold = true;
    const old = f.jump(80), releaseOld = f.state.release;
    const next = f.jump(170), releaseNext = f.state.release;
    releaseOld({ interrupted: false }); assert.equal(await old, false);
    assert.equal(f.snapshot().entries.length, 0); releaseNext({ interrupted: false });
    assert.equal(await next, true); assert.deepEqual(positions(f), [80, 170]);
  });
  await test("late source invalidation between record and consumer commit cannot borrow a fresh permit", async () => {
    for (const traversal of [false, true]) {
      const f = fixture();
      if (traversal) await seed(f);
      f.controls.availability();
      const before = f.snapshot();
      f.state.hold = true; const pending = traversal ? f.controls.navigate(-1) : f.jump(80);
      f.state.release({ interrupted: false });
      queueMicrotask(() => f.api.invalidate());
      assert.equal(await pending, false); assert.equal(f.snapshot().revision, before.revision);
    }
    const f = fixture(), capture = f.adapter.capture;
    let captures = 0;
    f.adapter.capture = () => {
      const result = capture();
      if (++captures === 2) f.api.invalidate();
      return result;
    };
    assert.equal(await f.jump(80), false); assert.equal(captures, 2);
    assert.equal(f.snapshot().entries.length, 0);
  });
  await test("manual supersession preserves Forward and prevents an old completion from committing", async () => {
    const f = fixture(); await seed(f); await f.controls.navigate(-1); const before = f.snapshot();
    f.state.hold = true; const pending = f.jump(230);
    f.manual(); f.state.release({ interrupted: false });
    assert.equal(await pending, false); assert.equal(f.snapshot().revision, before.revision);
    assert.equal(f.controls.availability().forward, true);
  });
  await test("unavailable optional capture leaves the actual document jump usable", async () => {
    const f = fixture(); f.state.captureRefused = true;
    assert.equal(await f.jump(80), false); assert.equal(f.nativeCalls.length, 1);
    assert.equal(f.nested.scrollTop, 80); assert.equal(f.snapshot().entries.length, 0);
  });
  await test("forced jumps and synchronous guard reentry cannot move a modal or frozen document", async () => {
    const f = fixture();
    f.c.mayMutateRendererDocument = () => false;
    assert.equal(await f.jump(80), false); assert.equal(f.nativeCalls.length, 0);
    f.c.mayMutateRendererDocument = () => true;
    const off = f.controls.subscribe(() => { f.c.mayMutateRendererDocument = () => false; });
    assert.equal(await f.jump(90), false); assert.equal(f.nativeCalls.length, 0); off();
    f.c.mayMutateRendererDocument = () => true; f.state.captureRefused = true;
    assert.equal(await f.jump(100), false); assert.equal(f.nativeCalls.length, 1);
  });
  await test("adapter is read dynamically; blocked and exhausted actions do not mint intent", async () => {
    const f = fixture(), ticket = f.api.beginIntent();
    assert.equal(await f.controls.navigate(-1), false); assert(f.api.isIntentCurrent(ticket));
    await f.jump(80); const owned = f.api.beginIntent();
    f.window.readingLocationAdapter = { available: () => false };
    assert.equal(f.controls.availability().back, false); assert.equal(await f.controls.navigate(-1), false);
    assert(f.api.isIntentCurrent(owned)); f.window.readingLocationAdapter = f.adapter;
    assert.equal(await f.controls.navigate(-1), true);
  });
  await test("invalid directions reject; subscriber cleanup is real and idempotent", async () => {
    const f = fixture(); for (const bad of [0, 2, "-1", null, NaN]) await assert.rejects(f.controls.navigate(bad), /exactly/);
    let calls = 0; const off = f.controls.subscribe(() => calls++);
    await f.jump(80); assert(calls > 0); off(); off(); const before = calls;
    await f.controls.navigate(-1); assert.equal(calls, before);
    assert.throws(() => f.controls.subscribe(null), /subscriber/);
  });
  await test("modal and frozen guards refuse traversal without changing timeline", async () => {
    const f = fixture(); await f.jump(80); const before = f.snapshot();
    for (const guard of ["modal", "frozen"]) {
      f.state[guard] = true; f.state.allowed = guard !== "frozen";
      f.state.modal = guard === "modal";
      // The DOM modal port is owned by the original lifetime fixture.
      f.document.querySelector = () => guard === "modal" ? {} : null;
      f.c.mayMutateRendererDocument = () => guard !== "frozen";
      assert.equal(await f.controls.navigate(-1), false); assert.equal(f.snapshot().revision, before.revision);
    }
  });
  await test("actual tab objects with equal paths retain separate histories across switch", async () => {
    const f = fixture(); await f.jump(80);
    assert.equal(f.first.filePath, f.second.filePath);
    f.switchTo(f.second); assert.equal(f.controls.availability().back, false);
    await f.jump(140); assert.equal(f.models.length, 2);
    f.switchTo(f.first); assert.equal(f.controls.availability().back, true);
    await f.controls.navigate(-1); assert.equal(f.nested.scrollTop, 0);
  });
  await test("real lifetime retirement clears only the retired tab; canceled close has no retirement", async () => {
    const f = fixture(); await f.jump(80); const before = f.snapshot();
    f.api.invalidate(); assert.equal(f.snapshot().revision, before.revision, "same-tab rebuild is not a close");
    assert.equal(f.controls.availability().back, true, "not retiring a canceled close keeps values");
    f.api.retireTab(f.first); assert.equal(f.models[0].snapshot().entries.length, 0);
    assert.equal(f.controls.availability().back, false);
    f.switchTo(f.second); await f.jump(140); assert.equal(f.models[1].snapshot().entries.length, 2);
  });
  await test("typing keeps one owned destination and its first pre-preview origin", async () => {
    const f = fixture(), segment = f.beginTyping();
    await f.jump(80, 7, segment); await f.jump(140, 21, segment); await f.jump(210, 43, segment);
    assert.deepEqual(positions(f), [0, 210]);
    assert.equal(await f.controls.navigate(-1), true); assert.equal(f.nested.scrollTop, 0);
    assert.equal(await f.controls.navigate(1), true); assert.equal(f.nested.scrollTop, 210);
  });
  await test("actual Search input captures origin before debounce, coalesces typing and makes Next one explicit jump", async () => {
    const f = fixture(), search = installSearch(f);
    search.type("alpha");
    // Controlled pending old motion, not new user input: origin was sampled by input already.
    f.nested.scrollTop = 13; f.nested.scrollLeft = 3;
    f.state.desired = { top: 80, left: 7 }; search.fire(); await tick();
    search.type("alphabet"); f.state.desired = { top: 140, left: 23 }; search.fire(); await tick();
    assert.deepEqual(positions(f), [0, 140]); assert.equal(f.nativeCalls.length, 2);
    search.type("changed"); search.next(); await tick();
    assert.deepEqual(positions(f), [0, 140, 300]); assert.equal(f.nativeCalls.length, 3);
    assert.equal(search.highlights.at(-1).request.navigate, false);
    assert.equal(await f.controls.navigate(-1), true); assert.equal(f.nested.scrollTop, 140);
    assert.equal(await f.controls.navigate(1), true); assert.equal(f.nested.scrollLeft, 47);
    assert.equal(f.errors.length, 0);
  });
  await test("actual Search pending preview and close retain recoverable Back without a fake committed entry", async () => {
    const f = fixture(), search = installSearch(f);
    search.type("alpha"); f.state.hold = true; f.state.desired = { top: 190, left: 13 };
    search.fire(); const release = f.state.release;
    assert.equal(f.snapshot().entries.length, 0); assert.equal(f.controls.availability().back, true);
    search.close(); f.state.hold = false;
    assert.equal(await f.controls.navigate(-1), true); assert.equal(f.nested.scrollTop, 0);
    release({ interrupted: false }); await tick();
    assert.equal(f.snapshot().entries.length, 0); assert.equal(f.errors.length, 0);
  });
  await test("first-debounce toolbar Back cancels Search without consuming older history or Forward", async () => {
    const f = fixture(), ui = installControls(f);
    await seed(f); await f.controls.navigate(-1);
    const before = f.snapshot(), viewport = [f.nested.scrollTop, f.nested.scrollLeft];
    assert.equal(before.index, 1); assert.equal(before.revision, 3); assert(before.canForward);
    const search = installSearch(f);
    search.type("pending-query");
    const queued = Array.from(f.timers.values()).at(-1);
    assert.equal(search.highlights.length, 0, "Back precedes the very first preview");
    assert.equal(f.c.pendingSearchTerm, "pending-query"); assert.notEqual(f.c.searchDebounceTimer, null);
    assert.equal(ui.back.disabled, false);
    ui.back.click(); await tick();
    assert.deepEqual(f.snapshot(), before, "cancellation cannot traverse, replace or truncate committed values");
    assert.deepEqual([f.nested.scrollTop, f.nested.scrollLeft], viewport);
    assert.equal(f.c.pendingSearchTerm, null); assert.equal(f.c.pendingSearchRequest, null);
    assert.equal(f.c.searchDebounceTimer, null);
    const calls = f.nativeCalls.length, passes = search.highlights.length;
    queued(); await tick();
    assert.equal(f.nativeCalls.length, calls); assert.equal(search.highlights.length, passes);
    assert.deepEqual(f.snapshot(), before);
    ui.forward.click(); await tick(); assert.equal(f.nested.scrollTop, 160);
  });
  await test("first-debounce Back is available without older history and no-travel recovery creates no entry", async () => {
    for (const forwardBranch of [true, false]) {
      const f = fixture(), ui = installControls(f), records = [], restore = f.adapter.restore;
      f.controls.availability();
      if (forwardBranch) { await f.jump(80, 7); await f.controls.navigate(-1); }
      const before = f.snapshot();
      assert.equal(before.canBack, false); assert.equal(before.canForward, forwardBranch);
      assert.equal(ui.back.disabled, true);
      f.target.shape = [20, 120, 60, 140];
      f.adapter.restore = (...args) => {
        const completion = restore(...args);
        completion.then(record => records.push(record));
        return completion;
      };
      const search = installSearch(f);
      search.type("pending-query");
      assert.equal(search.highlights.length, 0); assert.notEqual(f.c.searchDebounceTimer, null);
      assert.equal(f.controls.availability().back, true);
      assert.equal(ui.back.disabled, false, "the input producer publishes availability before debounce");
      ui.back.click(); await tick();
      assert.equal(records.length, 1); assert.equal(records[0].status, "completed");
      assert.equal(records[0].travel, "no-observed-travel", "this really exercises the no-travel recovery branch");
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.c.pendingSearchTerm, null); assert.equal(f.c.searchDebounceTimer, null);
      assert.equal(ui.back.disabled, true); assert.equal(ui.forward.disabled, !forwardBranch);
      assert.equal(await f.controls.navigate(-1), false, "cancellation does not leave a fake recovery step");
      assert.deepEqual(f.snapshot(), before);
    }
  });
  await test("blocked first-debounce Back keeps its query and cancels only after modal or freeze guards clear", async () => {
    for (const modal of [true, false]) {
      const f = fixture(), ui = installControls(f);
      await seed(f); await f.controls.navigate(-1);
      const search = installSearch(f), before = f.snapshot();
      search.type("pending-query");
      const request = f.c.pendingSearchRequest, timer = f.c.searchDebounceTimer;
      const calls = f.nativeCalls.length;
      if (modal) f.document.querySelector = () => ({});
      else f.c.mayMutateRendererDocument = () => false;
      f.run("readingHistory.sync()");
      assert.equal(ui.back.disabled, true); assert.equal(await f.controls.navigate(-1), false);
      assert.equal(f.c.pendingSearchRequest, request); assert.equal(f.c.searchDebounceTimer, timer);
      assert.deepEqual(f.snapshot(), before); assert.equal(f.nativeCalls.length, calls);
      f.document.querySelector = () => null; f.c.mayMutateRendererDocument = () => true;
      f.run("readingHistory.sync()");
      assert.equal(ui.back.disabled, false);
      ui.back.click(); await tick();
      assert.deepEqual(f.snapshot(), before); assert.equal(f.c.pendingSearchTerm, null);
    }
  });
  await test("synchronous first-debounce availability subscriber cancels the exact admitted query", async () => {
    const f = fixture(), ui = installControls(f), search = installSearch(f);
    f.controls.availability();
    const before = f.snapshot();
    let admitted = null;
    const unsubscribe = f.controls.subscribe(() => {
      if (admitted || !f.c.pendingSearchRequest) return;
      admitted = f.c.pendingSearchRequest;
      assert.equal(admitted.term, "pending-query"); assert.equal(ui.back.disabled, false);
      ui.back.click();
    });
    search.type("pending-query");
    assert(admitted, "availability is published synchronously after request admission");
    assert.equal(f.c.pendingSearchRequest, null, "reentrant Back retires that request before input returns");
    await tick(); unsubscribe();
    assert.deepEqual(f.snapshot(), before); assert.equal(ui.back.disabled, true);
    assert.equal(f.errors.length, 0);
  });
  await test("superseding pending typing retains the first origin rather than the earlier uncommitted preview", async () => {
    const f = fixture(), segment = f.beginTyping(); f.state.hold = true;
    const first = f.jump(80, 7, segment), releaseFirst = f.state.release;
    const second = f.jump(190, 31, segment), releaseSecond = f.state.release;
    f.state.hold = false; assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 0);
    releaseFirst({ interrupted: false }); releaseSecond({ interrupted: false });
    assert.equal(await first, false); assert.equal(await second, false); assert.equal(f.snapshot().entries.length, 0);
  });
  await test("tab changes end coalescing even when the returning tab owns the same current entry", async () => {
    const f = fixture(), first = f.beginTyping(); await f.jump(80, 7, first);
    f.switchTo(f.second); f.switchTo(f.first);
    const next = f.beginTyping(); assert.notEqual(next, first); await f.jump(170, 23, next);
    assert.deepEqual(positions(f), [0, 80, 170]);
  });
  await test("first pending preview provides recoverable Back without committing or truncating Forward", async () => {
    const f = fixture(); await seed(f); await f.controls.navigate(-1); const before = f.snapshot();
    const segment = f.beginTyping(); f.state.hold = true; const preview = f.jump(250, 19, segment);
    const releasePreview = f.state.release; assert.equal(f.controls.availability().back, true);
    f.state.hold = false; assert.equal(await f.controls.navigate(-1), true);
    assert.equal(f.nested.scrollTop, 80); assert.equal(f.snapshot().revision, before.revision);
    assert.equal(f.controls.availability().forward, true);
    releasePreview({ interrupted: false }); assert.equal(await preview, false);
    assert.equal(await f.controls.navigate(1), true); assert.equal(f.nested.scrollTop, 160);
  });
  await test("repeated recovery Back cannot accidentally traverse older committed history", async () => {
    const f = fixture(); await seed(f); const segment = f.beginTyping();
    f.state.hold = true; const preview = f.jump(250, 19, segment); const releasePreview = f.state.release;
    const returning = f.controls.navigate(-1), releaseReturn = f.state.release;
    assert.equal(await f.controls.navigate(-1), false); assert.equal(f.restores.length, 1);
    releaseReturn({ interrupted: false }); assert.equal(await returning, true);
    assert.equal(f.snapshot().index, 2); releasePreview({ interrupted: false }); await preview;
  });
  await test("interrupted provisional return remains recoverable through manual input and tab return", async () => {
    const f = fixture(), segment = f.beginTyping();
    f.state.hold = true; const preview = f.jump(80, 7, segment), releasePreview = f.state.release;
    const returning = f.controls.navigate(-1), releaseReturn = f.state.release;
    f.manual(); releaseReturn({ interrupted: false }); assert.equal(await returning, false);
    f.switchTo(f.second); f.switchTo(f.first); assert.equal(f.controls.availability().back, true);
    f.state.hold = false; assert.equal(await f.controls.navigate(-1), true);
    releasePreview({ interrupted: false }); assert.equal(await preview, false);
    assert.equal(f.snapshot().entries.length, 0);
  });
  await test("interrupted later preview preserves last reached destination for Forward, not its excursion", async () => {
    const f = fixture(), segment = f.beginTyping(); await f.jump(80, 7, segment);
    f.state.hold = true; const preview = f.jump(210, 43, segment), release = f.state.release;
    f.manual(); f.state.hold = false;
    assert.equal(await f.controls.navigate(-1), true); assert.equal(f.nested.scrollTop, 0);
    assert.equal(await f.controls.navigate(1), true); assert.equal(f.nested.scrollTop, 80);
    assert.equal(f.nested.scrollLeft, 7); release({ interrupted: false }); await preview;
  });
  await test("explicit navigation and closing/clearing end a segment without erasing pending recovery", async () => {
    const f = fixture(), first = f.beginTyping(); await f.jump(80, 7, first); await f.jump(140);
    const next = f.beginTyping(); await f.jump(210, 23, next); await f.jump(250, 31, next);
    assert.deepEqual(positions(f), [0, 80, 140, 250]);
    f.state.hold = true; const pending = f.jump(310, 39, next), release = f.state.release;
    f.run("readingHistory.endSearch()"); assert.equal(first.active, false);
    f.state.hold = false; await f.controls.navigate(-1); await f.controls.navigate(1);
    assert.equal(f.nested.scrollTop, 250); release({ interrupted: false }); await pending;
  });
  await test("no-travel first preview does not leave a fake provisional Back action", async () => {
    const f = fixture(); f.target.shape = [20, 120, 60, 140]; const segment = f.beginTyping();
    assert.equal(await f.jump(0, 0, segment), false);
    assert.equal(f.controls.availability().back, false); assert.equal(f.snapshot().entries.length, 0);
  });
  await test("page retirement removes subscribers and fences pending operations", async () => {
    const f = fixture(); f.state.hold = true; const pending = f.jump(80), release = f.state.release;
    f.window.dispatchEvent(new Event("pagehide"));
    const callbacks = f.subscribers.length; release({ interrupted: false });
    assert.equal(await pending, false); assert.equal(f.subscribers.length, callbacks);
    assert.deepEqual({ ...f.controls.availability() }, { back: false, forward: false });
  });
  console.log("Actual source/controller/mapper with controlled DOM geometry/native-request ports; real-app qualification NOT claimed.");
  console.log(`=== ${passed}/${total} passed ===`);
  process.exitCode = passed === total ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
