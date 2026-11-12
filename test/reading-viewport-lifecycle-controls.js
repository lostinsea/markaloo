"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// These controls execute the production adapter and writer bodies. Only DOM,
// Markdown engines and asynchronous scheduling are supplied by the fixture.
module.exports = async function lifecycleControls(check) {
  const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8").replace(/\r\n/g, "\n");
  const renderer = read("renderer.js"), tabsSource = read("custom-tabs.js");
  function slice(source, first, last) {
    const from = source.indexOf(first), to = source.indexOf(last, from + first.length);
    assert(from >= 0 && to > from, "Production slice missing: " + first);
    assert.equal(source.indexOf(first, from + first.length), -1, "Ambiguous production slice: " + first);
    return source.slice(from, to);
  }
  const body = (first, last) => slice(renderer, first, last);
  const tabBody = (first, last) => slice(tabsSource, first, last);
  async function test(name, action) {
    try { await action(); check(name, true); }
    catch (error) { console.log("  lifecycle diagnostic: " + error.stack); check(name, false); }
  }
  function node(parent = null, control = false) {
    return {
      nodeType: 1, parentElement: parent, control, isConnected: true,
      contains(other) {
        for (let child = other; child; child = child.parentElement) if (child === this) return true;
        return false;
      },
      closest() {
        for (let child = this; child; child = child.parentElement) if (child.control) return child;
        return null;
      },
    };
  }
  function fixture() {
    const first = { id: 1, filePath: "same.md" }, second = { id: 2, filePath: "same.md" };
    const state = { active: first, frozen: false, allowed: true, modal: false };
    const listeners = new Map(), frames = [], timers = new Map(), observers = [];
    let timerId = 0, cancellation;
    const html = node(), docBody = node(html), container = node(docBody), main = node(container), wrapper = node(main);
    const viewer = node(wrapper), editor = node(wrapper);
    const document = { documentElement: html, body: docBody, activeElement: docBody,
      querySelector: () => state.modal ? {} : null, getElementById: () => viewer };
    const window = {
      CustomTabs: { getActiveTab: () => state.active },
      addEventListener(type, callback, options) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push({ callback, options });
      },
      removeEventListener(type, callback) {
        listeners.set(type, (listeners.get(type) || []).filter(entry => entry.callback !== callback));
      },
      dispatchEvent(event) { for (const { callback } of listeners.get(event.type) || []) callback(event); return true; },
    };
    const c = vm.createContext({
      window, document, viewer, markdownEditor: editor, contentWrapper: wrapper, Event,
      console, frozenForShutdown: () => state.frozen, mayMutateRendererDocument: () => state.allowed,
      requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
      setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
      clearTimeout: id => timers.delete(id),
      ResizeObserver: class {
        constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
        observe() {}
        disconnect() { this.disconnected = true; }
      },
    });
    vm.runInContext(read("reading-viewport.js"), c);
    const factory = window.MarkalooReadingViewport.createReadingViewport;
    window.MarkalooReadingViewport = { createReadingViewport(options) {
      cancellation = options.stopMotion;
      return factory(options);
    } };
    vm.runInContext(body("function createReadingViewportLifecycle(", "\nconst readingViewport =") +
      "\nvar readingViewport = createReadingViewportLifecycle();", c);
    const api = window.readingViewport = c.readingViewport;
    api.registerTab(first); api.registerTab(second);
    const run = script => vm.runInContext(script, c);
    const input = (type, target = viewer, fields = {}) => {
      const event = { type, target, isTrusted: true, deltaX: 0, deltaY: 0, button: 0, ...fields };
      for (const { callback } of listeners.get(type) || []) callback(event);
      return event;
    };
    return { c, api, state, first, second, run, window, document, viewer, editor, wrapper,
      timers, frames, observers, listeners, input, stop: () => cancellation() };
  }
  function loadInput(f) {
    vm.runInContext(body("const readingZoomWheelIntents =", "\n// Which element actually scrolls"), f.c);
  }
  function loadSharedJump(f) {
    vm.runInContext(body("function captureReadingJump(", "\n// Current file tracking"), f.c);
  }
  function loadRestore(f) {
    Object.assign(f.c, {
      getScroller: () => f.wrapper, resolveAnchorTop: anchor => anchor.scrollTop,
      mayMutateDocument: () => f.state.allowed,
    });
    vm.runInContext(tabBody("  let cancelActiveRestore = null;", "\n  function positionOf("), f.c);
  }
  function loadComplete(f) {
    Object.assign(f.c, {
      fileOpenSequence: 4, editorInteractionRevision: 0, pendingEditorScrollRestore: null,
      isEditMode: true, supersededFileOpenCompletionCount: 0, frozenFileOpenCompletionCount: 0,
      markReloadConflict() { f.state.conflicts = (f.state.conflicts || 0) + 1; },
      reportAdoptionTrackingConflict() {}, showNotification() {},
      diskVersionsEqual: (a, b) => a === b,
    });
    vm.runInContext(body("function cancelEditorScrollRestore(", "\nfunction cancelEditorDeferredWork(") +
      body("function completeFileOpen(", "\n// Upstream fallback"), f.c);
    return (type = "caller") => {
      const context = {
        sequence: f.c.fileOpenSequence, editorInteraction: f.c.editorInteractionRevision,
        viewport: { permit: f.api.capturePermit() },
        editorScroll: f.c.prepareEditorScrollRestore({ open: true, scrollTop: 31, scrollLeft: 17 }),
        postRenderScroll: { type, top: 73 },
      };
      return context;
    };
  }
  function loadRender(f) {
    let release, started;
    const held = new Promise(resolve => { release = resolve; });
    const begun = new Promise(resolve => { started = resolve; });
    const reset = body("    // Scroll to top (skip during undo/redo", "\n    // Empty or already-highlighted documents");
    Object.assign(f.c, {
      _lastRenderedContent: null, renderGeneration: 0, undoRedoRendering: false, tableCellSession: null,
      hideDocumentContextMenus() {}, tableColumnSizing: { reset() {} },
      editorScroll: { start() {
        f.state.startSawOldPermit = f.api.isPermitCurrent(f.state.oldPermit); started();
      } },
      detectRenderMode: () => "full", held,
      renderLightFormat() { throw new Error("Unexpected light render"); },
    });
    f.viewer.parentElement = f.wrapper;
    vm.runInContext("async function renderMarkdownFull(content, generation, viewportPermit, preservePosition = false) {\n" +
      "await held;\n" + reset + "\n}\n" +
      body("function renderMarkdown(", "\n// Full render pipeline"), f.c);
    release.started = begun;
    return release;
  }
  function loadOpen(f) {
    loadComplete(f);
    Object.assign(f.c, {
      currentFilePath: "same.md", originalMarkdown: "before", hasUnsavedChanges: false,
      historySnapshot: () => ({ undo: ["before"], redo: [] }), captureDocumentEditor: () => ({
        open: false, selection: { start: 0, end: 0, direction: "none" }, scrollTop: 0, scrollLeft: 0,
      }), currentDocumentActionOwner: () => f.state.active, fileTrackingPathKey: value => value,
      failedSaves: new Set(), reloadConflicts: new Set(), reloadPathAliases: new Map(),
      editSessionBaseline: null, isFileTrackingActive: true, fileTrackingPauseOwner: null,
      fileSelectionGeneration: 1, activeFileSelectionGeneration: 1, tableCellSession: null,
      editorModeRevision: 1, defaultSidePanelPending: false,
      historyClear() { f.state.cleared = true; }, updateFileInfo: path => { f.c.currentFilePath = path; },
      setEditorPresentation(open) { f.api.invalidate(); f.c.isEditMode = open; },
      withFileTrackingResumeHeld: run => run(), setDocumentDirtyState: dirty => { f.c.hasUnsavedChanges = dirty; },
      assertFileTrackingOwnership: () => ({ accepted: true, owner: { tabId: 1 } }),
      hideDocumentContextMenus() {}, cancelEditorDeferredWork() {}, applyTableBreakout() {},
      addToNavigationHistory: path => { f.state.navigation = path; },
      saveRecentFile: path => { f.state.recent = path; },
    });
    f.editor.value = "before";
    f.editor.setSelectionRange = () => {};
    f.c.editorScroll.reset = () => {};
    f.c.editorScroll.leave = () => {};
    f.window.CustomTabs.getDocumentEditorState = () => null;
    f.window.CustomTabs.getDocumentDescriptor = () => null;
    vm.runInContext(body("const startupDocumentReceipts = new Map();",
      "\nwindow.markaloo.onExternalFileOpenRequest("), f.c);
    vm.runInContext(body("function beginFileOpen(", "\nfunction completeFileOpen("), f.c);
    const begin = f.c.beginFileOpen;
    f.c.beginFileOpen = (...args) => { f.state.openContext = begin(...args); return f.state.openContext; };
    f.window.beginFileOpen = f.c.beginFileOpen;
    f.window.completeFileOpen = f.c.completeFileOpen;
  }

  await test("lifecycle controls execute the registered production model and real adapter", () => {
    const f = fixture();
    assert(Object.isFrozen(f.api));
    const ticket = f.api.beginIntent(), permit = f.api.capturePermit();
    assert(f.api.isIntentCurrent(ticket) && f.api.isPermitCurrent(permit));
    assert(!f.api.isPermitCurrent({}) && !f.api.isIntentCurrent({}));
  });
  await test("production native tracking stays unavailable and its unbound stop fails closed", () => {
    const f = fixture();
    assert(!("trackMotion" in f.api) && !("cancelMotion" in f.api));
    assert.throws(f.stop, /native cancellation is not bound/);
  });
  await test("same-tab source invalidation retains genuine intent but retires viewport permits", () => {
    const f = fixture(), ticket = f.api.beginIntent(), permit = f.api.capturePermit();
    f.api.invalidate();
    assert(f.api.isIntentCurrent(ticket) && !f.api.isPermitCurrent(permit));
  });
  await test("equal-path actual tab objects cannot share intent or viewport authority", () => {
    const f = fixture(), ticket = f.api.beginIntent(), permit = f.api.capturePermit();
    assert.equal(f.first.filePath, f.second.filePath);
    f.state.active = f.second;
    assert(!f.api.isIntentCurrent(ticket) && !f.api.isPermitCurrent(permit));
  });
  await test("background retirement leaves the active lifetime intact and cannot be re-registered", () => {
    const f = fixture(), permit = f.api.capturePermit();
    f.api.retireTab(f.second);
    assert(f.api.isPermitCurrent(permit));
    f.state.active = f.second; f.api.registerTab(f.second);
    assert.equal(f.api.capturePermit(), null);
    assert.equal(f.api.beginIntent(), null);
  });
  await test("committed active retirement and page lifetime fence every old permit", () => {
    const f = fixture(), ticket = f.api.beginIntent(), permit = f.api.capturePermit();
    f.api.retireTab(f.first);
    assert(!f.api.isIntentCurrent(ticket) && !f.api.isPermitCurrent(permit));
    assert.equal(f.api.capturePermit(), null);
    f.state.active = f.second;
    const successor = f.api.capturePermit();
    f.api.retireWindow();
    assert(!f.api.isPermitCurrent(successor) && f.api.beginIntent() === null);
  });
  await test("committed pagehide uses the actual production window retirement binding", () => {
    const f = fixture(), permit = f.api.capturePermit();
    vm.runInContext(body("window.readingViewport = readingViewport;", "\n\nconst readingZoomWheelIntents"), f.c);
    f.input("pagehide", f.document);
    assert(!f.api.isPermitCurrent(permit) && f.api.beginIntent() === null);
  });

  for (const [label, type, fields, target] of [
    ["horizontal nested wheel", "wheel", { deltaX: 1 }, "nested"],
    ["vertical contained wheel", "wheel", { deltaY: 1 }, "nested"],
    ["nested pointer", "pointerdown", {}, "nested"],
    ["nested touch", "touchstart", {}, "nested"],
    ["root scrollbar", "pointerdown", {}, "root"],
    ["reading background", "wheel", { deltaX: -1 }, "background"],
    ["workspace background", "wheel", { deltaY: 1 }, "workspace"],
    ["container background", "pointerdown", {}, "container"],
    ["horizontal reading key", "keydown", { key: "ArrowRight" }, "nested"],
    ["editor boundary key", "keydown", { key: "Home", ctrlKey: true }, "editor"],
    ["editor typing", "beforeinput", {}, "editor"],
    ["editor composition start", "compositionstart", {}, "editor"],
  ]) {
    await test(label + " retires delayed writes synchronously without outer travel", () => {
      const f = fixture(); loadInput(f);
      f.wrapper.scrollTop = 42; f.wrapper.scrollLeft = 13;
      const ticket = f.api.beginIntent(), permit = f.api.capturePermit();
      const targets = { nested: node(f.viewer), root: f.document.documentElement,
        background: f.wrapper, editor: f.editor, workspace: f.wrapper.parentElement,
        container: f.wrapper.parentElement.parentElement };
      f.input(type, targets[target], fields);
      assert(!f.api.isPermitCurrent(permit) && !f.api.isIntentCurrent(ticket));
      assert.equal(f.wrapper.scrollTop, 42); assert.equal(f.wrapper.scrollLeft, 13);
      assert(f.listeners.get(type).every(entry => entry.options.capture));
    });
  }
  for (const [label, type, fields, target] of [
    ["programmatic scroll", "scroll", {}, "viewer"],
    ["untrusted wheel", "wheel", { deltaY: 1, isTrusted: false }, "viewer"],
    ["empty wheel", "wheel", {}, "viewer"],
    ["Notes list wheel", "wheel", { deltaY: 1 }, "notes"],
    ["unrelated button", "pointerdown", {}, "button"],
    ["nested document control", "keydown", { key: "ArrowDown" }, "control"],
    ["unrelated focused key", "keydown", { key: "End" }, "root"],
    ["composition key", "keydown", { key: "Home", isComposing: true }, "editor"],
    ["dialog input", "wheel", { deltaY: 1 }, "modal"],
  ]) {
    await test(label + " does not fabricate document input authority", () => {
      const f = fixture(); loadInput(f);
      const other = node(f.document.body), control = node(f.viewer, true);
      const targets = { viewer: f.viewer, notes: other, button: node(f.document.body, true),
        control, root: f.document.documentElement, editor: f.editor, modal: f.viewer };
      if (target === "root") f.document.activeElement = other;
      if (target === "modal") f.state.modal = true;
      const ticket = f.api.beginIntent(), permit = f.api.capturePermit();
      f.input(type, targets[target], fields);
      assert(f.api.isIntentCurrent(ticket) && f.api.isPermitCurrent(permit));
    });
  }

  await test("reading input cancels before one owned typed admission without requiring movement", () => {
    const f = fixture(); loadInput(f);
    const before = f.api.capturePermit(), trace = [];
    f.window.addEventListener("reading-history-input", () => {
      assert(f.api.isPermitCurrent(before)); trace.push("cancel");
    });
    f.window.addEventListener("reading-history-input-admitted", event => {
      assert.equal(event.kind, "input"); assert.equal(event.inputType, "wheel");
      assert.equal(event.inputTarget, f.document.documentElement);
      assert(f.api.isIntentCurrent(event.intent) && f.api.isPermitCurrent(event.permit));
      assert(!f.api.isPermitCurrent(before)); trace.push("admit");
    });
    f.input("wheel", f.document, { deltaY: 1 });
    assert.deepEqual(trace, ["cancel", "admit"]);
  });
  await test("pre-cancel successor input cannot borrow a later admission", () => {
    const f = fixture(); loadInput(f);
    let successor, canceled = 0, admitted = 0;
    f.window.addEventListener("reading-history-input", () => { canceled++; successor = f.api.beginIntent(); });
    f.window.addEventListener("reading-history-input-admitted", () => admitted++);
    f.input("wheel", f.viewer, { deltaY: 1 });
    assert.equal(canceled, 1); assert.equal(admitted, 0);
    assert(f.api.isIntentCurrent(successor));
  });
  await test("source-only reentry during input admission cannot lend a fresh permit", () => {
    const f = fixture(); loadInput(f);
    let invalidations = 0, admitted = 0;
    f.window.addEventListener("reading-viewport-invalidated", () => {
      if (++invalidations === 1) f.api.invalidate();
    });
    f.window.addEventListener("reading-history-input-admitted", () => admitted++);
    f.input("wheel", f.viewer, { deltaY: 1 });
    assert.equal(invalidations, 2, "the source-only reentry actually occurred");
    assert.equal(admitted, 0);
  });
  await test("filtered synthetic and zoom input never publish a manual history admission", () => {
    const f = fixture(); loadInput(f);
    let admitted = 0, zoom = 0;
    f.window.addEventListener("reading-history-input-admitted", () => admitted++);
    f.input("scroll", f.viewer);
    f.input("wheel", f.viewer, { deltaY: 1, isTrusted: false });
    f.input("pointerdown", f.viewer, { button: 3 });
    f.input("wheel", node(f.viewer, true), { deltaY: 1 });
    Object.assign(f.c, { zoomLevel: 100, ZOOM_CONFIG: { min: 50, max: 200 },
      beginReadingZoomChange() { zoom++; return f.api.beginChange(true); } });
    f.input("wheel", f.viewer, { deltaY: -1, ctrlKey: true });
    assert.equal(zoom, 1, "zoom retained its separate existing admission");
    assert.equal(admitted, 0);
  });
  await test("restore setup runs the real initial frame and ResizeObserver writes", () => {
    const f = fixture(); loadRestore(f);
    f.c.restorePosition({ scrollTop: 71 }, f.api.capturePermit());
    assert.equal(f.wrapper.scrollTop, 71);
    assert.equal(f.frames.length, 1); assert.equal(f.observers.length, 1);
    f.wrapper.scrollTop = 9; f.frames.shift()(); assert.equal(f.wrapper.scrollTop, 71);
    f.wrapper.scrollTop = 11; f.observers[0].callback(); assert.equal(f.wrapper.scrollTop, 71);
  });
  await test("old restore and observer retry yield to new input even with unchanged geometry", () => {
    const f = fixture(); loadInput(f); loadRestore(f);
    const old = f.api.capturePermit();
    f.c.restorePosition({ scrollTop: 71 }, old);
    assert.equal(f.wrapper.scrollTop, 71);
    f.input("wheel", node(f.viewer), { deltaX: 1 });
    f.wrapper.scrollTop = 19;
    f.frames.shift()(); f.observers[0].callback();
    assert.equal(f.wrapper.scrollTop, 19);
    assert(f.observers[0].disconnected);
    f.c.restorePosition({ scrollTop: 83 }, f.api.capturePermit());
    const successor = f.observers[1];
    f.c.restorePosition({ scrollTop: 99 }, old);
    assert(!successor.disconnected);
    f.wrapper.scrollTop = 8; successor.callback(); assert.equal(f.wrapper.scrollTop, 83);
  });
  await test("unrelated Notes scrolling does not cancel a valid observer restore", () => {
    const f = fixture(); loadInput(f); loadRestore(f);
    f.c.restorePosition({ scrollTop: 71 }, f.api.capturePermit());
    f.input("wheel", node(f.document.body), { deltaY: 1 });
    f.wrapper.scrollTop = 19; f.observers[0].callback();
    assert.equal(f.wrapper.scrollTop, 71); assert(!f.observers[0].disconnected);
  });
  for (const [modifier, fields] of [["Ctrl", { ctrlKey: true }], ["Meta", { metaKey: true }]]) {
    for (const key of ["Home", "End"]) for (const surface of ["reading", "root"]) {
      await test("modified " + modifier + " " + key + " on " + surface +
        " cancels the real queued restore without travel", () => {
        const f = fixture(); loadInput(f); loadRestore(f);
        const ticket = f.api.beginIntent();
        f.c.restorePosition({ scrollTop: 71 }, f.api.capturePermit());
        assert.equal(f.wrapper.scrollTop, 71);
        assert.equal(f.frames.length, 1); assert.equal(f.observers.length, 1);
        const boundary = key === "Home" ? 0 : 100;
        f.wrapper.scrollTop = boundary;
        const before = f.api.capturePermit();
        f.input("keydown", surface === "reading" ? node(f.viewer) : f.document.documentElement, { key, ...fields });
        assert(!f.api.isPermitCurrent(before) && !f.api.isIntentCurrent(ticket));
        assert.equal(f.wrapper.scrollTop, boundary);
        f.frames.shift()(); f.observers[0].callback();
        assert.equal(f.wrapper.scrollTop, boundary);
        assert(f.observers[0].disconnected);
      });
    }
  }
  for (const surface of ["reading", "root"]) {
    await test("unrelated Ctrl PageUp on " + surface + " preserves the real queued restore", () => {
      const f = fixture(); loadInput(f); loadRestore(f);
      const permit = f.api.capturePermit();
      f.c.restorePosition({ scrollTop: 71 }, permit);
      assert.equal(f.wrapper.scrollTop, 71); assert.equal(f.frames.length, 1);
      f.wrapper.scrollTop = 0;
      f.input("keydown", surface === "reading" ? node(f.viewer) : f.document.documentElement,
        { key: "PageUp", ctrlKey: true });
      assert(f.api.isPermitCurrent(permit) && !f.observers[0].disconnected);
      f.frames.shift()(); f.observers[0].callback();
      assert.equal(f.wrapper.scrollTop, 71);
    });
  }
  await test("restore rechecks its permit after resolving geometry before the actual assignment", () => {
    const f = fixture(); loadRestore(f);
    const permit = f.api.capturePermit();
    f.wrapper.scrollTop = 61;
    f.c.resolveAnchorTop = () => { f.api.beginIntent(); return 71; };
    f.c.restorePosition({ scrollTop: 71 }, permit);
    assert.equal(f.wrapper.scrollTop, 61);
  });

  for (const type of ["top", "restore", "caller"]) {
    await test("file-open " + type + " completion suppresses stale scrolling but keeps completion cleanup", () => {
      const f = fixture(), context = loadComplete(f)(type);
      let visual = 0;
      assert(f.api.isPermitCurrent(context.viewport.permit));
      if (type !== "restore") f.api.beginIntent();
      assert(f.c.completeFileOpen(context, () => { visual++; }));
      if (type === "restore") {
        assert.equal(f.timers.size, 1); f.api.beginIntent();
        for (const callback of f.timers.values()) callback();
      }
      assert.equal(f.wrapper.scrollTop, undefined);
      assert.equal(f.editor.scrollTop, type === "restore" ? 31 : undefined);
      assert.equal(visual, 0);
      assert(context.editorScroll.cancelled && f.c.pendingEditorScrollRestore === null);
    });
  }
  await test("current file-open completion restores both axes and its caller exactly once per invocation", () => {
    const f = fixture(), context = loadComplete(f)("caller");
    let visual = 0;
    assert(f.c.completeFileOpen(context, () => { visual++; }));
    assert.equal(f.editor.scrollTop, 31); assert.equal(f.editor.scrollLeft, 17); assert.equal(visual, 1);
    assert(context.editorScroll.cancelled);
  });
  await test("file-open checks authority again between editor axes and before its caller", () => {
    const f = fixture(), context = loadComplete(f)("caller");
    let visual = 0, top = null;
    f.wrapper.scrollTop = 61;
    Object.defineProperty(f.editor, "scrollTop", { set(value) { top = value; f.api.beginIntent(); } });
    assert(f.c.completeFileOpen(context, () => { visual++; }));
    assert.equal(top, 31, "The first real restore assignment admitted the successor");
    assert(!f.api.isPermitCurrent(context.viewport.permit));
    assert.equal(f.editor.scrollLeft, undefined); assert.equal(visual, 0);
    assert.equal(f.wrapper.scrollTop, 61);
    assert(context.editorScroll.cancelled && f.c.pendingEditorScrollRestore === null);
  });
  await test("viewport refusal does not suppress post-render conflict reporting", () => {
    const f = fixture(), context = loadComplete(f)("top");
    Object.assign(context, { approvedPathKey: "key", approvedOwner: { pathKey: "key" } });
    f.window.markaloo = { checkOwnedTabDiskSnapshot: () => ({ matches: false }) };
    f.api.beginIntent();
    assert(!f.c.completeFileOpen(context));
    assert.equal(f.state.conflicts, 1);
    assert(context.editorScroll.cancelled);
  });
  await test("beginFileOpen invalidates after permission and before incoming reads or rollbackable sequence", () => {
    const f = fixture(), sentinel = new Error("past ownership boundary");
    vm.runInContext(body("function beginFileOpen(", "\nfunction completeFileOpen("), f.c);
    f.c.tableColumnSizing = { reset() { throw sentinel; } };
    f.c.fileOpenSequence = 8;
    const data = Object.defineProperty({}, "path", { get() { throw Error("incoming read too early"); } });
    const prior = f.api.capturePermit();
    f.state.allowed = false;
    assert.equal(f.c.beginFileOpen(data), null); assert(f.api.isPermitCurrent(prior));
    f.state.allowed = true;
    assert.throws(() => f.c.beginFileOpen(data), error => error === sentinel);
    assert(!f.api.isPermitCurrent(prior)); assert.equal(f.c.fileOpenSequence, 8);
    f.c.fileOpenSequence = 7; f.c.fileOpenSequence = 8;
    assert(!f.api.isPermitCurrent(prior));
  });
  await test("renderer fallback passes the actual open context through render and suppresses only stale completion scrolling", async () => {
    const f = fixture(), release = loadRender(f); loadOpen(f);
    f.c.preflightFileOpen = () => ({ accepted: true });
    vm.runInContext(body("async function handleFileOpened(", "\n// Handle file opened"), f.c);
    const opened = f.c.handleFileOpened({}, { path: "incoming.md", content: "incoming source" });
    assert(f.state.openContext && f.api.isPermitCurrent(f.state.openContext.viewport.permit));
    f.wrapper.scrollTop = 61; f.api.beginIntent(); release(); await opened;
    assert.equal(f.wrapper.scrollTop, 61);
    assert.equal(f.c.originalMarkdown, "incoming source"); assert.equal(f.c.currentFilePath, "incoming.md");
    assert.equal(f.state.navigation, "incoming.md"); assert.equal(f.state.recent, "incoming.md");
    assert(f.state.cleared && f.c.pendingEditorScrollRestore === null);
  });

  await test("render start invalidates before editor mapping and full reset yields across its held await", async () => {
    const f = fixture(), release = loadRender(f), viewport = {};
    f.wrapper.scrollTop = 45;
    const ticket = f.api.beginIntent();
    f.state.oldPermit = f.api.capturePermit();
    const rendered = f.c.renderMarkdown("new source", null, viewport);
    assert.equal(f.state.startSawOldPermit, false);
    assert(f.api.isIntentCurrent(ticket) && f.api.isPermitCurrent(viewport.permit));
    assert.equal(f.wrapper.scrollTop, 45);
    f.api.beginIntent(); release(); await rendered;
    assert.equal(f.wrapper.scrollTop, 45);
  });
  await test("full reset still writes for the current render without inventing intent", async () => {
    const f = fixture(), release = loadRender(f), viewport = {}, ticket = f.api.beginIntent();
    f.wrapper.scrollTop = 45;
    const rendered = f.c.renderMarkdown("new source", null, viewport);
    release(); await rendered;
    assert.equal(f.wrapper.scrollTop, 0); assert(f.api.isIntentCurrent(ticket));
  });
  await test("view edit and Notes delegation keep source dirty history and autosave when scrolling is superseded", async () => {
    const f = fixture(), release = loadRender(f);
    Object.assign(f.c, { originalMarkdown: "before", historyPush: value => { f.state.history = value; },
      setDocumentDirtyFromContent: value => { f.state.dirty = value; f.api.invalidate(); },
      autoSaveViewModeNote: () => { f.state.saved = true; return true; } });
    vm.runInContext(body("function commitViewModeEdit(", "\n// The same contract for the two note paths"), f.c);
    const render = f.c.renderMarkdown;
    f.c.renderMarkdown = (...args) => { f.state.rendered = render(...args); return f.state.rendered; };
    f.wrapper.scrollTop = 17;
    assert(f.c.commitViewModeNote("after", 17));
    assert.equal(f.c.originalMarkdown, "after"); assert.equal(f.state.history, "before");
    assert.equal(f.state.dirty, "after"); assert(f.state.saved);
    f.wrapper.scrollTop = 61; f.api.beginIntent(); release();
    await f.state.rendered;
    assert.equal(f.wrapper.scrollTop, 61);
  });
  await test("current view edit still restores its supplied position after the real render promise", async () => {
    const f = fixture(), release = loadRender(f);
    Object.assign(f.c, { originalMarkdown: "before", historyPush() {},
      setDocumentDirtyFromContent: () => f.api.invalidate() });
    vm.runInContext(body("function commitViewModeEdit(", "\n// Commit a view-mode NOTE change"), f.c);
    const render = f.c.renderMarkdown;
    f.c.renderMarkdown = (...args) => { f.state.rendered = render(...args); return f.state.rendered; };
    assert(f.c.commitViewModeEdit("after", 33)); release(); await f.state.rendered;
    assert.equal(f.wrapper.scrollTop, 33);
  });

  await test("validated switch retires old permits before calling large confirmation and accepted snapshot", async () => {
    const f = fixture();
    let accept;
    const consent = new Promise(resolve => { accept = resolve; });
    const sentinel = new Error("snapshot boundary");
    Object.assign(f.c, { tabs: [f.first, f.second], activeTabId: 1, latestTabSwitchIntent: 0,
      pendingConfirmedReload: null, pendingActivationTabs: new Set(), isDocumentFrozen: () => false,
      mayMutateDocument: () => true, notify() {},
      confirmLargeTab() { assert(!f.api.isPermitCurrent(f.state.oldPermit)); return consent; },
      snapshotActiveTab() { assert(!f.api.isPermitCurrent(f.state.consentPermit)); throw sentinel; } });
    vm.runInContext(tabBody("  async function switchToTab(", "\n  // Mirrors main's safeFileLabel"), f.c);
    f.state.oldPermit = f.api.capturePermit();
    const switching = f.c.switchToTab(2);
    f.state.consentPermit = f.api.capturePermit();
    assert(f.api.isPermitCurrent(f.state.consentPermit)); accept(true);
    await assert.rejects(switching, error => error === sentinel);
  });
  await test("declined and stale switches do not retire tab lifetimes or invalidate successor permits", async () => {
    const f = fixture(); let accept;
    Object.assign(f.c, { tabs: [f.first, f.second], activeTabId: 1, latestTabSwitchIntent: 0,
      pendingConfirmedReload: null, pendingActivationTabs: new Set(), isDocumentFrozen: () => false,
      mayMutateDocument: () => true, notify() {}, console: { log() {} },
      confirmLargeTab: () => new Promise(resolve => { accept = resolve; }),
      snapshotActiveTab() { throw new Error("declined switch must not snapshot"); } });
    vm.runInContext(tabBody("  async function switchToTab(", "\n  // Mirrors main's safeFileLabel"), f.c);
    const declined = f.c.switchToTab(2); accept(false); await declined;
    assert(f.api.capturePermit());
    f.state.active = f.second; assert(f.api.capturePermit()); f.state.active = f.first;
    const stale = f.c.switchToTab(2);
    f.c.latestTabSwitchIntent++;
    f.api.beginIntent(); const successor = f.api.capturePermit(); accept(true); await stale;
    assert(f.api.isPermitCurrent(successor));
  });
  await test("actual tab render continuation retains its pre-await permit instead of capturing fresh authority", async () => {
    for (const superseded of [false, true]) {
      const f = fixture(), release = loadRender(f);
      loadOpen(f);
      loadRestore(f);
      f.second.scrollPosition = 29; f.second.content = "incoming";
      Object.assign(f.c, { tabs: [f.first, f.second], activeTabId: 1, activeTabForMutations: f.first,
        latestTabSwitchIntent: 0, pendingConfirmedReload: null, pendingActivationTabs: new Set(),
        isDocumentFrozen: () => false, mayMutateDocument: () => true, confirmLargeTab: () => true,
        isDirty: () => false, documentState: new WeakMap(), dismissUpdatePrompt() {},
        renderTabs() {}, saveTabs() {}, inEditMode: () => false,
        queuePreHandshakeTrackingAssertion() {},
        positionOf: tab => ({ scrollTop: tab.scrollPosition }), console: { log() {}, error() {} } });
      f.window.CustomTabs.getActiveTab = () => f.c.tabs.find(tab => tab.id === f.c.activeTabId);
      f.window.renderMarkdown = (...args) => {
        f.state.rendered = f.c.renderMarkdown(...args); return f.state.rendered;
      };
      // The renderer and tab overlay really have separate generation counters.
      vm.runInContext("var switchForTest = (function () { let renderGeneration = 0;\n" +
        tabBody("  async function switchToTab(", "\n  // Mirrors main's safeFileLabel") +
        "\nreturn switchToTab; })();", f.c);
      assert(await f.c.switchForTest(2, { skipSnapshot: true, fileOpenData: {} }));
      assert.equal(f.c.activeTabId, 2);
      f.wrapper.scrollTop = 61;
      if (superseded) f.api.beginIntent();
      release(); await f.state.rendered;
      assert.equal(f.wrapper.scrollTop, superseded ? 61 : 29);
      assert.equal(f.observers.length, superseded ? 0 : 1);
    }
  });
  await test("actual reload continuation preserves non-viewport effects while its old restore yields", async () => {
    const f = fixture(); loadRestore(f);
    let release;
    const reloaded = new Promise(resolve => { release = resolve; });
    const documentState = new WeakMap([[f.first, { generation: 9 }]]);
    Object.assign(f.c, { reloadPromise: reloaded, completion: reloaded, generation: 4, renderGeneration: 4,
      activeTabId: 1, reloadTabId: 1, tabs: [f.first, f.second], targetTab: f.first,
      reloadReservation: { documentGeneration: 9 }, isDocumentFrozen: () => false, documentState,
      adoptionApproval: {}, data: { path: "same.md" }, trackingSelection: {},
      approvedReloadSnapshotMatches: () => true, baseline: "disk source", liveDocument: () => "disk source",
      viewport: { permit: f.api.capturePermit() }, anchor: { scrollTop: 79 },
      getActiveTab: () => f.first, notify: () => { f.state.notified = true; }, t: (_key, value) => value });
    f.window.setUnsavedState = dirty => { f.state.dirty = dirty; };
    const continuation = tabBody("      Promise.all([reloadPromise, completion])\n        .then(() => {", "\n        .catch((error) => {");
    const completed = vm.runInContext(continuation + ";", f.c);
    f.wrapper.scrollTop = 61; f.api.beginIntent(); release(); await completed;
    assert.equal(f.wrapper.scrollTop, 61);
    assert.equal(f.state.dirty, false); assert(f.state.notified);
    assert.equal(f.observers.length, 0);
  });
  await test("unactivated removal retires exactly the removed object and preserves the active permit", () => {
    const f = fixture();
    Object.assign(f.c, { tabs: [f.first, f.second], activeTabId: 1, largeConfirmed: new Set([2]),
      bumpDocumentRevision() {}, renderTabs() {}, saveTabs() {} });
    vm.runInContext(tabBody("  function removeUnactivatedTab(", "\n  async function verifyDiskAdoption("), f.c);
    const permit = f.api.capturePermit();
    assert(f.c.removeUnactivatedTab(f.second)); assert(!f.c.tabs.includes(f.second));
    assert(f.api.isPermitCurrent(permit));
    f.state.active = f.second; assert.equal(f.api.capturePermit(), null);
  });
  await test("committed close retires the active lifetime before actual removal and not on a missing object", () => {
    const f = fixture();
    const committed = tabBody('      console.log("[CustomTabs] Closing tab:", tab.filename);', "\n      bumpDocumentRevision();");
    Object.assign(f.c, { tab: f.first, tabs: [f.first, f.second], tabIndex: 0, activeTabId: 1,
      activeTabForMutations: f.first, dismissUpdatePrompt() {} });
    const permit = f.api.capturePermit();
    const splice = f.c.tabs.splice.bind(f.c.tabs);
    f.c.tabs.splice = (...args) => { assert(!f.api.isPermitCurrent(permit)); return splice(...args); };
    vm.runInContext("(function () {\n" + committed + "\n})()", f.c);
    assert(!f.c.tabs.includes(f.first));
    assert.equal(f.api.capturePermit(), null);
    f.state.active = f.second; assert(f.api.capturePermit());
  });
  for (const reason of ["declined", "unverifiable"]) {
    await test(reason + " close preserves its actual tab lifetime and viewport permit", async () => {
      const f = fixture();
      let asked = 0;
      f.first.filename = "same.md";
      Object.assign(f.c, { tabs: [f.first, f.second], activeTabId: 1, closingTabs: new Set(),
        pendingConfirmedReload: null, documentState: new WeakMap(), mayMutateDocument: () => true,
        snapshotActiveTab() {}, isDirty: () => true, documentIdentity: () => ({ tabId: 1 }),
        consultDocumentDeletionState: () => reason === "unverifiable" ? null : { revision: 1 },
        safeDocumentLabel: value => value, captureDialogContext: () => () => true, notify() {},
        showDocumentConfirmation: async () => { asked++; return false; } });
      vm.runInContext(tabBody("  async function closeTab(", "\n  function updateTabContent("), f.c);
      const ticket = f.api.beginIntent(), permit = f.api.capturePermit();
      await f.c.closeTab(1);
      assert.equal(asked, reason === "declined" ? 1 : 0);
      assert(f.api.isIntentCurrent(ticket) && f.api.isPermitCurrent(permit));
      assert(f.c.tabs.includes(f.first) && f.c.closingTabs.size === 0);
    });
  }
  await test("accepted reload invalidates before source adoption while disk refusal preserves prior authority", async () => {
    for (const approved of [false, true]) {
      const f = fixture(), permit = f.api.capturePermit();
      let adopted = null;
      Object.defineProperty(f.c, "originalMarkdown", { set(value) {
        assert(!f.api.isPermitCurrent(permit)); adopted = value;
      }, get: () => adopted, configurable: true });
      Object.assign(f.c, { approvedOwnedReloadSnapshotMatches: () => approved,
        acceptedOwnerPath: "same.md", acceptedSourcePath: "same.md", acceptedOwner: { tabId: 1 },
        approvedPathKey: "key", acceptedDiskVersion: {}, acceptedStateKey: "same.md",
        stillSelected: () => true, fileTrackingPathKey: value => value,
        reloadPathAliases: new Map(), reloadConflicts: new Set(), isEditMode: true,
        hideDocumentContextMenus() {}, markReloadConflict() {}, reportAdoptionTrackingConflict() {},
        showNotification() {}, cancelEditorDeferredWork() {}, historyClear() { f.state.cleared = true; },
        editorModeRevision: 0, tableCellSession: null, editSessionBaseline: {}, currentFilePath: "same.md",
        withFileTrackingResumeHeld: run => run(), failedSaves: new Set(["same.md"]),
        setDocumentDirtyState: value => { f.state.dirty = value; }, captureEditSessionBaseline() {},
        data: { content: "disk source", trackingSelection: { accepted: true } } });
      f.window.customTabsOwnsReloadResults = true;
      const accepted = body("    const approvedBeforeDisplay =", "\n    // Re-render the markdown");
      if (approved) {
        let release, supplied;
        const completion = new Promise(resolve => { release = resolve; });
        f.c.data.viewport = {};
        f.c.renderMarkdown = (_content, _force, viewport) => {
          supplied = viewport; viewport.permit = f.api.capturePermit();
          viewport.completion = completion;
          return Promise.resolve();
        };
        const rendering = body("    // Re-render the markdown", "\n    if (!stillSelected() ||");
        f.c.rendererReloadHandlers = [vm.runInContext("(async function (event, data) {\n" +
          accepted + rendering + "\n})", f.c)];
        vm.runInContext(tabBody("    const delegateReload = (event, data) => {",
          "\n    const validateReloadResult = (") + "\nthis.actualDelegateReload = delegateReload;", f.c);
        const pending = f.c.actualDelegateReload({}, f.c.data);
        assert.equal(adopted, "disk source"); assert(f.state.cleared);
        assert.equal(f.state.dirty, false); assert.equal(f.c.failedSaves.size, 0);
        assert.equal(f.c.markdownEditor.value, "disk source", "delegated admission updates the editor before the caller samples its baseline");
        assert.equal(supplied, f.c.data.viewport);
        let settled = false;
        pending.then(() => { settled = true; });
        await Promise.resolve();
        assert.equal(settled, false, "initial completion cannot finish delegated reload while its finalization is held");
        release(); await pending;
        f.c.rendererReloadHandlers = [];
        f.c.inEditMode = () => true;
        f.window.markdownEditor = f.c.markdownEditor;
        f.window.renderMarkdown = f.c.renderMarkdown;
        const fallbackViewport = {};
        const fallback = f.c.actualDelegateReload({}, { ...f.c.data, success: true, viewport: fallbackViewport });
        assert.equal(supplied, fallbackViewport, "compatibility reload forwards the supplied owned viewport synchronously");
        assert.equal(fallbackViewport.completion, completion);
        await fallback;
      } else {
        assert.throws(() => vm.runInContext("(function () {\n" + accepted + "\n})()", f.c),
          /Reload target or disk version moved before display/);
        assert(f.api.isPermitCurrent(permit)); assert.equal(adopted, null);
      }
    }
  });
  await test("Discard keeps baseline history dirty state and cleanup while its delayed restore yields", async () => {
    const f = fixture(), release = loadRender(f);
    let captureCalls = 0, restoreCalls = 0;
    Object.assign(f.c, { isEditMode: true, fileOpenSequence: 1, editorModeRevision: 1,
      readingRenderCompletion: null,
      captureReadingLocation() { captureCalls++; return { status: "captured", location: { fixture: true } }; },
      restoreReadingLocation() { restoreCalls++; throw new Error("Superseded discard must not restore"); },
      editorExitOperation: null, hasUnsavedChanges: true, currentFilePath: "same.md",
      editSessionBaseline: { document: "baseline", dirty: false, history: { saved: true } },
      fileMenu: { classList: { remove() {} } }, currentDocumentActionOwner: () => f.first,
      currentSaveDocumentIdentity: () => ({ documentGeneration: 3 }), pendingSaveFor: () => null,
      confirmUnsavedAction: async () => ({ approved: true, isCurrent: () => true }),
      i18n: value => value, hasPendingSaveFor: () => false,
      setEditorPresentation: open => { f.c.isEditMode = open; f.api.invalidate(); },
      applyTableBreakout() {}, previewDebounceTimer: null, cancelEditorDeferredWork() {},
      historyRestore: history => { f.state.history = history; },
      setDocumentDirtyState: dirty => { f.c.hasUnsavedChanges = dirty; },
      retainCurrentDocumentEditor: () => { f.state.retained = (f.state.retained || 0) + 1; },
      assertFileTrackingOwnership: () => { f.state.tracking = true; } });
    f.window.CustomTabs.updateTabContent = value => { f.state.cached = value; };
    f.c.editorScroll.leave = () => {};
    vm.runInContext(body("function createModeReadingHandoff(", "\nasync function restoreReadingLocation("), f.c);
    vm.runInContext(body("async function changeCurrentDocumentEditor(", "})();\nconst editorScroll = window.createEditorScroll("), f.c);
    f.wrapper.scrollTop = 17;
    const discarded = f.c.changeCurrentDocumentEditor(false);
    await Promise.race([release.started, discarded.then(() => {
      throw new Error("Discard finished without reaching its render");
    })]);
    assert.equal(captureCalls, 1, "the current mode path captured before its held render");
    assert.equal(f.c.originalMarkdown, "baseline");
    assert(f.state.history.saved && f.state.tracking); assert.equal(f.state.cached, "baseline");
    f.wrapper.scrollTop = 61; f.api.beginIntent(); release(); await discarded;
    assert.equal(f.wrapper.scrollTop, 61);
    assert.equal(f.c.editSessionBaseline, null); assert.equal(f.c.hasUnsavedChanges, false);
    assert(f.state.retained >= 2 && f.c.editorExitOperation === null);
    assert.equal(restoreCalls, 0, "a catch cannot hide a superseded restore attempt");
  });

  await test("presentation and splitter geometry invalidate before their writes without renewing genuine intent", () => {
    const f = fixture();
    const ticket = f.api.beginIntent();
    let permit = f.api.capturePermit(), writes = 0;
    const style = {};
    Object.defineProperty(style, "width", { set() { assert(!f.api.isPermitCurrent(permit)); writes++; } });
    Object.assign(f.c, { SPLITTER_MIN_RATIO: .15, SPLITTER_MAX_RATIO: .85, editorPanel: { style } });
    vm.runInContext(body("function applyEditorSplitRatio(", "\nfunction storeEditorSplitRatio("), f.c);
    assert.equal(f.c.applyEditorSplitRatio(.5), .5); assert.equal(writes, 1);
    permit = f.api.capturePermit();
    Object.assign(f.c, { tableColumnSizing: { cancel() { assert(!f.api.isPermitCurrent(permit)); } },
      tableCellSession: null, toggleEditBtn: { style: {}, setAttribute() {} },
      openEditorBtn: { setAttribute() {} }, refreshBtn: {}, updateEditorHistoryControls() {} });
    f.wrapper.classList = { toggle() {} };
    vm.runInContext(body("function setEditorPresentation(", "\nfunction captureDocumentEditor("), f.c);
    f.c.setEditorPresentation(true);
    assert(f.c.isEditMode); assert(f.api.isIntentCurrent(ticket));
  });
  await test("zoom correction yields to a no-travel successor without relying on scroll differences", () => {
    const f = fixture(), element = node(f.viewer);
    Object.assign(element, { isConnected: true, getBoundingClientRect: () => ({ top: 100, bottom: 120, height: 20 }) });
    Object.assign(f.wrapper, { isConnected: true, scrollTop: 20, scrollHeight: 500, clientHeight: 100,
      getBoundingClientRect: () => ({ top: 0, height: 100 }) });
    Object.assign(f.c, { pendingZoomAnchor: null, renderGeneration: 1, viewerMutationGen: 1,
      performance: { now: () => 10 }, ZOOM_ANCHOR_MAX_AGE_MS: 500, zoomAnchorSuperseded: () => false,
      getViewerScroller: () => f.wrapper, scrollerScale: () => 1 });
    vm.runInContext(body("function applyZoomAnchor(", "\nfunction scheduleZoomAnchorRestore("), f.c);
    const anchor = () => ({ scroller: f.wrapper, el: element, gen: 1, mut: 1, at: 10, frac: 0,
      permit: f.api.capturePermit() });
    f.c.pendingZoomAnchor = anchor(); f.c.applyZoomAnchor();
    assert.equal(f.wrapper.scrollTop, 70);
    f.c.pendingZoomAnchor = anchor(); f.api.beginIntent(); f.c.applyZoomAnchor();
    assert.equal(f.wrapper.scrollTop, 70); assert.equal(f.c.pendingZoomAnchor, null);
  });
  await test("zoom admission invalidates before writes and renews only its current burst", () => {
    const f = fixture(), ticket = f.api.beginIntent();
    const anchor = { permit: f.api.capturePermit() };
    let oldPermit = anchor.permit, writes = 0;
    f.viewer.style = {};
    Object.defineProperty(f.viewer.style, "zoom", { set() {
      assert(!f.api.isPermitCurrent(oldPermit)); writes++;
    } });
    Object.assign(f.c, { pendingZoomAnchor: anchor, zoomLevel: 120,
      ZOOM_CONFIG: { min: 50, max: 400 }, zoomResetBtn: {}, localStorage: { setItem() {} },
      tableColumnSizing: { cancel() { assert(!f.api.isPermitCurrent(oldPermit)); } },
      editorScroll: { previewNavigation() {}, invalidate() {} },
      captureZoomAnchor() {}, republishBreakoutBudgetForZoom() {}, scheduleTableBreakout() {} });
    vm.runInContext(body("function beginReadingZoomChange(", "\n// ============================================\n// ZOOM CONTROLS"), f.c);
    f.c.updateZoom({ persist: false });
    assert(f.api.isIntentCurrent(ticket) && f.api.isPermitCurrent(anchor.permit));
    oldPermit = anchor.permit;
    f.c.updateZoom();
    assert(!f.api.isIntentCurrent(ticket) && f.api.isPermitCurrent(anchor.permit));
    const retired = anchor.permit;
    f.api.beginIntent(); oldPermit = f.api.capturePermit();
    f.c.updateZoom({ persist: false });
    assert.equal(anchor.permit, retired);
    assert(!f.api.isPermitCurrent(retired)); assert.equal(writes, 3);
  });
  function zoomWheelFixture(atBoundary = false) {
    const f = fixture(), element = node(f.viewer);
    const geometry = { scale: 1, reads: 0, writes: 0 };
    const origin = atBoundary ? 0 : 200;
    element.children = [];
    element.getBoundingClientRect = () => ({
      top: origin * geometry.scale - f.wrapper.scrollTop,
      bottom: (origin + 100) * geometry.scale - f.wrapper.scrollTop,
      height: 100 * geometry.scale,
    });
    Object.assign(f.wrapper, { scrollTop: origin, scrollHeight: 2000, clientHeight: 100,
      getBoundingClientRect: () => ({ top: 0, left: 0, height: 100, width: 100 }) });
    f.document.elementFromPoint = () => { geometry.reads++; return element; };
    f.viewer.style = {};
    Object.defineProperty(f.viewer.style, "zoom", { set(value) { geometry.scale = Number(value); geometry.writes++; } });
    Object.assign(f.c, { pendingZoomAnchor: null, zoomAnchorFrame: 0, zoomLevel: 100,
      renderGeneration: 1, viewerMutationGen: 1, performance: { now: () => 10 },
      ZOOM_CONFIG: { min: 50, max: 400, step: 10 }, zoomResetBtn: {},
      getViewerScroller: () => f.wrapper, scrollerScale: () => 1,
      localStorage: { setItem() {} }, tableColumnSizing: { cancel() {} },
      editorScroll: { previewNavigation() {}, invalidate() {} },
      republishBreakoutBudgetForZoom() {}, scheduleTableBreakout() {} });
    loadInput(f);
    vm.runInContext(body("function firstChildReaching(", "\n// ============================================\n// ZOOM CONTROLS") +
      body("function handleReadingZoomWheel(", "\ndocument.addEventListener('wheel', handleReadingZoomWheel"), f.c);
    const capture = fields => f.input("wheel", element, { deltaY: -1,
      preventDefault() { this.defaultPrevented = true; }, ...fields });
    const handle = event => f.c.handleReadingZoomWheel(event);
    const point = () => element.getBoundingClientRect().top + 0.5 * element.getBoundingClientRect().height;
    return { ...f, geometry, capture, handle, point, anchor: () => f.c.pendingZoomAnchor };
  }
  for (const [modifier, fields] of [["Ctrl", { ctrlKey: true }], ["Meta", { metaKey: true }]]) {
    for (const deltaY of [-1, 1]) {
      await test(modifier + (deltaY < 0 ? " zoom" : " zoom-out") + " wheel capture and handler keep one owned burst before RAF", () => {
        const f = zoomWheelFixture(); let admissions = 0;
        f.window.addEventListener("reading-viewport-invalidated", () => { admissions++; });
        const first = f.capture({ ...fields, deltaY }); f.handle(first);
        const anchor = f.anchor(), intent = f.api.capturePermit();
        assert(anchor && f.geometry.scale === 1 - deltaY / 10 && f.frames.length === 1);
        const second = f.capture({ ...fields, deltaY }); f.handle(second);
        assert.equal(f.anchor(), anchor); assert.equal(anchor.frac, 0.5);
        assert.equal(f.geometry.reads, 1); assert.equal(f.geometry.writes, 2);
        assert.equal(admissions, 2); assert(!f.api.isPermitCurrent(intent));
        assert.equal(f.frames.length, 1); assert.notEqual(f.point(), 50);
        f.frames.shift()();
        assert.equal(f.point(), 50); assert.equal(f.c.pendingZoomAnchor, null);
      });
    }
  }
  await test("a new genuine action prevents a later zoom wheel from renewing the old burst anchor", () => {
    const f = zoomWheelFixture(), fields = { ctrlKey: true };
    f.handle(f.capture(fields));
    const old = f.anchor(), permit = old.permit;
    assert(old && f.geometry.reads === 1 && f.frames.length === 1);
    f.api.beginIntent(); f.wrapper.scrollTop = 250;
    f.handle(f.capture(fields));
    assert.notEqual(f.anchor(), old); assert.notEqual(f.anchor().frac, old.frac);
    assert(!f.api.isPermitCurrent(permit) && f.api.isPermitCurrent(f.anchor().permit));
    assert.equal(f.geometry.reads, 2); assert.equal(f.geometry.writes, 2);
  });
  for (const boundary of ["intent", "source"]) {
    await test("a zoom wheel whose captured " + boundary + " authority retired cannot change zoom", () => {
      const f = zoomWheelFixture(), event = f.capture({ ctrlKey: true });
      f.c.capturedWheel = event;
      const admission = vm.runInContext("readingZoomWheelIntents.get(capturedWheel)", f.c);
      assert(admission && f.api.isPermitCurrent(admission.permit) && f.api.isIntentCurrent(admission.intent));
      if (boundary === "intent") f.api.beginIntent(); else f.api.invalidate();
      const successor = f.api.capturePermit();
      f.handle(event);
      assert.equal(f.c.zoomLevel, 100); assert.equal(f.geometry.writes, 0);
      assert.equal(f.frames.length, 0); assert(f.api.isPermitCurrent(successor));
    });
  }
  for (const admission of ["genuine", "programmatic"]) {
    for (const boundary of ["source", "genuine"]) {
      await test(boundary + " reentry within " + admission + " zoom admission cannot renew or write the retired burst", () => {
        const f = zoomWheelFixture(), first = f.capture({ ctrlKey: true });
        f.c.capturedWheel = first;
        const firstAdmission = f.run("readingZoomWheelIntents.get(capturedWheel)");
        assert(firstAdmission && f.api.isIntentCurrent(firstAdmission.intent) &&
          f.api.isPermitCurrent(firstAdmission.permit), "The initial real wheel capture owns its admission");
        f.handle(first);
        const anchor = f.anchor(), oldPermit = anchor?.permit;
        assert(anchor && f.api.isPermitCurrent(oldPermit) && f.frames.length === 1);
        assert.equal(f.geometry.writes, 1); assert.equal(f.c.zoomLevel, 110);
        let notifications = 0, successor, successorIntent;
        f.window.addEventListener("reading-viewport-invalidated", () => {
          if (++notifications !== 1) return;
          assert(!f.api.isPermitCurrent(oldPermit), "Outer admission retired its old viewport before notification");
          if (boundary === "source") f.api.invalidate();
          else successorIntent = f.api.beginIntent();
          successor = f.api.capturePermit();
          f.wrapper.scrollTop = 20;
        });
        if (admission === "genuine") {
          const event = f.capture({ ctrlKey: true });
          f.c.capturedWheel = event;
          assert.equal(f.run("readingZoomWheelIntents.get(capturedWheel)"), null);
          f.handle(event);
        } else f.c.updateZoom({ persist: false });
        assert.equal(notifications, 2, "The exact outer notification really admitted an intervening transition");
        assert(f.api.isPermitCurrent(successor));
        if (successorIntent) assert(f.api.isIntentCurrent(successorIntent));
        if (admission === "programmatic" && boundary === "source") {
          assert(f.api.isIntentCurrent(firstAdmission.intent), "Source-only reentry retains genuine intent, not viewport authority");
        }
        assert.equal(anchor.permit, oldPermit, "Refused admission cannot renew the retired anchor");
        assert.equal(f.anchor(), anchor);
        assert.equal(f.geometry.writes, 1); assert.equal(f.c.zoomLevel, 110);
        assert.equal(f.frames.length, 1); assert.equal(f.wrapper.scrollTop, 20);
        f.frames.shift()();
        assert.equal(f.wrapper.scrollTop, 20); assert.equal(f.anchor(), null);
        assert(f.api.isPermitCurrent(successor));
      });
    }
  }
  for (const successor of ["ordinary", "bounded zoom"]) {
    await test(successor + " no-travel wheel retires a pending real zoom correction synchronously", () => {
      const f = zoomWheelFixture(true);
      f.handle(f.capture({ ctrlKey: true }));
      const anchor = f.anchor();
      assert(anchor && f.frames.length === 1);
      assert.equal(f.point(), 100 * f.geometry.scale / 2);
      assert.notEqual(f.point(), 50);
      if (successor === "bounded zoom") f.c.ZOOM_CONFIG.max = 110;
      const next = f.capture(successor === "ordinary" ? { deltaY: -1 } : { ctrlKey: true });
      assert(!f.api.isPermitCurrent(anchor.permit)); assert.equal(f.wrapper.scrollTop, 0);
      f.handle(next); f.frames.shift()();
      assert.equal(f.wrapper.scrollTop, 0); assert.equal(f.geometry.writes, 1);
    });
  }
  await test("side-panel layout invalidates before presentation writes without fabricating intent", () => {
    const f = fixture(), ticket = f.api.beginIntent(), permit = f.api.capturePermit();
    let writes = 0;
    const panel = () => ({ contains: () => false, classList: { toggle() {
      assert(!f.api.isPermitCurrent(permit)); writes++;
    } } });
    const control = () => ({ setAttribute() {} });
    f.wrapper.style = { overflowAnchor: "auto" };
    Object.assign(f.c, { indexPanel: panel(), notesPanel: panel(), toggleIndexBtn: control(),
      toggleTocBtn: control(), toggleNotesBtn: control(), tocTracking: { setEnabled() {} },
      getViewerScroller: () => f.wrapper, closeNotesPanel() {}, updateNotesList() {} });
    vm.runInContext(body("function setSidePanel(", "\nfunction setIndexVisible("), f.c);
    f.c.setSidePanel("notes", { restoring: true, persist: false });
    assert.equal(writes, 2); assert(f.api.isIntentCurrent(ticket));
    assert.equal(f.wrapper.style.overflowAnchor, "none");
  });
  await test("shared instant helper keeps its request options and programmatic calls cannot mint genuine intent", () => {
    const f = fixture(), calls = [];
    f.c.editorScroll = { previewNavigation() {} };
    vm.runInContext(body("function scrollElementIntoView(", "\n// Current file tracking"), f.c);
    const ticket = f.api.beginIntent(), permit = f.api.capturePermit();
    const target = Object.assign(node(f.viewer), { scrollIntoView: options => calls.push(options) });
    f.c.scrollElementIntoView(target, "center");
    assert(f.api.isIntentCurrent(ticket) && !f.api.isPermitCurrent(permit));
    assert.equal(JSON.stringify(calls), JSON.stringify([{ behavior: "instant", block: "center", inline: "nearest" }]));
    f.api.beginIntent(); const successor = f.api.capturePermit();
    f.c.scrollElementIntoView(target, "start", ticket);
    assert.equal(calls.length, 1); assert(f.api.isPermitCurrent(successor));
  });

  function instantFixture() {
    const f = fixture(), nested = node(f.viewer), target = node(nested);
    const style = {
      transform: "none", rotate: "none", scale: "none", translate: "none", perspective: "none", filter: "none",
      clipPath: "none", clip: "auto", maskImage: "none", contain: "none", opacity: "1",
      overflowX: "visible", overflowY: "visible", zoom: "1", direction: "ltr",
      writingMode: "horizontal-tb", scrollSnapType: "none", display: "block",
      visibility: "visible", contentVisibility: "visible",
      borderTopLeftRadius: "0px", borderTopRightRadius: "0px",
      borderBottomLeftRadius: "0px", borderBottomRightRadius: "0px",
    };
    const box = values => ({ left: values[0], top: values[1], right: values[2], bottom: values[3] });
    const nodes = [];
    for (let item = target; item; item = item.parentElement) nodes.push(item);
    for (const item of nodes) {
      Object.assign(item, { ownerDocument: f.document, getRootNode: () => f.document,
        computed: { ...style }, shape: [0, 0, 600, 600], clientLeft: 0, clientTop: 0,
        clientWidth: 600, clientHeight: 600, offsetWidth: 600, offsetHeight: 600,
        scrollWidth: 1200, scrollHeight: 1200, scrollLeft: 0, scrollTop: 0,
        textContent: item === target ? "exact target" : "" });
      item.getBoundingClientRect = () => box(item.shape);
      item.getClientRects = () => [box(item.shape)];
    }
    Object.assign(nested, { shape: [0, 0, 400, 400], clientWidth: 400, clientHeight: 400,
      offsetWidth: 400, offsetHeight: 400 });
    nested.computed.overflowX = nested.computed.overflowY = "auto";
    Object.assign(target, { shape: [20, 700, 60, 720], clientWidth: 40, clientHeight: 20,
      offsetWidth: 40, offsetHeight: 20 });
    Object.assign(f.window, { innerWidth: 600, innerHeight: 600, scrollX: 0, scrollY: 0,
      visualViewport: { width: 600, height: 600, offsetLeft: 0, offsetTop: 0,
        pageLeft: 0, pageTop: 0, scale: 1 } });
    f.document.scrollingElement = f.document.documentElement;
    f.document.createRange = () => ({ selectNodeContents() {}, getClientRects: target.getClientRects });
    Object.assign(f.c, { getComputedStyle: item => item.computed,
      editorScroll: { previewNavigation() {} },
      MutationObserver: class {
        constructor() { f.state.observer = this; }
        observe(element, options) { assert.equal(element, f.viewer); assert(options.childList && options.subtree); }
        takeRecords() { return f.state.records || []; }
        disconnect() { this.disconnected = true; }
      } });
    f.state.request = new Promise((resolve, reject) => {
      f.state.resolve = resolve; f.state.reject = reject;
    });
    f.state.move = () => { nested.scrollTop = 580; target.shape = [20, 120, 60, 140]; };
    target.scrollIntoView = options => {
      f.state.calls = (f.state.calls || 0) + 1; f.state.options = options;
      f.state.move(); return f.state.request;
    };
    vm.runInContext(body("function captureReadingJump(", "\n// Current file tracking"), f.c);
    const jump = () => f.c.scrollElementIntoView(target, "center", f.api.beginIntent());
    return { ...f, target, nested, jump };
  }
  await test("instant completion follows the exact held native Promise after its synchronous offset writes", async () => {
    const f = instantFixture(), receipt = f.jump();
    assert.equal(receipt.request, f.state.request);
    assert.equal(f.nested.scrollTop, 580);
    assert.equal(JSON.stringify(f.state.options), JSON.stringify({ behavior: "instant", block: "center", inline: "nearest" }));
    let done = false; receipt.completion.then(() => { done = true; });
    await Promise.resolve(); assert(!done, "An offset write alone is not native Promise completion");
    f.state.resolve({ interrupted: false });
    const result = await receipt.completion;
    assert.equal(result.status, "completed"); assert.equal(result.scope, "request-offsets");
    assert.equal(result.travel, "observed-travel"); assert(f.state.observer.disconnected);
    assert(!("trackMotion" in f.api), "A synchronous instant request does not activate unsupported cancellation");
  });
  for (const axis of ["inner-horizontal", "hidden-horizontal", "root-layout", "root-visual"]) {
    await test("instant request observes " + axis + " travel without inferring an aggregate stop", async () => {
      const f = instantFixture();
      if (axis.includes("horizontal")) {
        f.target.shape = [700, 120, 740, 140];
        if (axis === "hidden-horizontal") {
          f.nested.computed.overflowX = "hidden"; f.nested.computed.overflowY = "visible";
        }
        f.state.move = () => { f.nested.scrollLeft = 680; f.target.shape = [20, 120, 60, 140]; };
      } else {
        f.state.move = () => {
          f.target.shape = [20, 120, 60, 140];
          if (axis === "root-layout") {
            f.window.scrollY = 580; f.window.visualViewport.pageTop = 580;
            f.document.scrollingElement.scrollTop = 580;
          } else {
            f.window.visualViewport.offsetLeft = 10; f.window.visualViewport.pageLeft = 10;
          }
        };
      }
      const receipt = f.jump();
      assert.equal(f.state.calls, 1); assert.equal(f.nested.scrollTop, 0);
      f.state.resolve({ interrupted: false });
      assert.equal((await receipt.completion).travel, "observed-travel");
    });
  }
  await test("a genuine instant no-travel record still requires its exact native completion", async () => {
    const f = instantFixture(); f.target.shape = [20, 120, 60, 140]; f.state.move = () => {};
    const receipt = f.jump(); f.state.resolve({ interrupted: false });
    const result = await receipt.completion;
    assert.equal(result.status, "completed"); assert.equal(result.travel, "no-observed-travel");
    assert.equal(f.nested.scrollTop, 0); assert.equal(f.window.scrollY, 0);
  });
  for (const kind of ["undefined", "thenable"]) {
    await test("missing native " + kind + " completion refuses only the record and still jumps", () => {
      const f = instantFixture();
      let assimilated = false;
      f.state.request = kind === "undefined" ? undefined : { then() { assimilated = true; } };
      const receipt = f.jump();
      assert.equal(f.state.calls, 1); assert.equal(f.nested.scrollTop, 580);
      assert.equal(receipt.completion, null); assert.equal(receipt.reason, "native-promise-unavailable");
      assert(!assimilated && f.state.observer.disconnected);
    });
  }
  for (const [label, value] of [["interrupted", { interrupted: true }], ["missing", {}],
    ["nonboolean", { interrupted: 0 }], ["undefined", undefined]]) {
    await test("native " + label + " result cannot certify request completion", async () => {
      const f = instantFixture(), receipt = f.jump(); f.state.resolve(value);
      const result = await receipt.completion;
      assert.equal(result.status, "unrecordable"); assert.equal(result.reason, "native-interrupted-or-malformed");
      assert.equal(f.nested.scrollTop, 580); assert(f.state.observer.disconnected);
    });
  }
  await test("native rejection is consumed as an unrecordable request with no fake fallback", async () => {
    const f = instantFixture(), receipt = f.jump(); f.state.reject(new Error("native refusal"));
    assert.equal((await receipt.completion).reason, "native-rejected");
    assert.equal(f.state.calls, 1); assert(f.state.observer.disconnected);
  });
  for (const boundary of ["input", "source", "tab", "retirement"]) {
    await test("instant " + boundary + " supersession cannot record or clean up over its successor", async () => {
      const f = instantFixture(), receipt = f.jump();
      if (boundary === "input") f.api.beginIntent();
      if (boundary === "source") f.api.invalidate();
      if (boundary === "tab") f.state.active = f.second;
      if (boundary === "retirement") { f.api.retireTab(f.first); f.state.active = f.second; }
      const successor = f.api.capturePermit();
      if (boundary !== "tab") assert(f.state.observer.disconnected, "Retirement disposes observation before native completion");
      f.nested.scrollTop = 31; f.state.resolve({ interrupted: false });
      assert.equal((await receipt.completion).reason, "superseded");
      assert(f.api.isPermitCurrent(successor)); assert.equal(f.nested.scrollTop, 31);
      assert.equal(f.state.calls, 1); assert(f.state.observer.disconnected);
    });
  }
  for (const boundary of ["layout", "chain", "text", "mutation", "offset", "visual-offset", "detachment"]) {
    await test("instant completion refuses changed " + boundary + " despite an uninterrupted native result", async () => {
      const f = instantFixture(), receipt = f.jump();
      if (boundary === "layout") f.nested.clientWidth--;
      if (boundary === "chain") f.target.parentElement = f.viewer;
      if (boundary === "text") f.target.textContent = "replacement";
      if (boundary === "mutation") f.state.records = [{}];
      if (boundary === "offset") f.nested.scrollLeft++;
      if (boundary === "visual-offset") f.window.visualViewport.offsetLeft++;
      if (boundary === "detachment") f.target.isConnected = false;
      f.state.resolve({ interrupted: false });
      assert.equal((await receipt.completion).status, "unrecordable"); assert.equal(f.state.calls, 1);
    });
  }
  await test("a clipping-only ancestor refuses the instant record without disabling the native jump", async () => {
    const f = instantFixture();
    f.nested.computed.overflowY = "clip";
    f.state.move = () => { f.target.shape = [20, 420, 60, 440]; };
    const receipt = f.jump(); f.state.resolve({ interrupted: false });
    assert.equal((await receipt.completion).reason, "target-clipped");
    assert.equal(f.state.calls, 1); assert.equal(f.state.options.block, "center");
  });
  await test("paint containment remains a clipping ancestor even with visible overflow", async () => {
    const f = instantFixture();
    f.nested.computed.overflowX = f.nested.computed.overflowY = "visible";
    f.nested.computed.contain = "paint";
    f.state.move = () => { f.target.shape = [20, 420, 60, 440]; };
    const receipt = f.jump(); f.state.resolve({ interrupted: false });
    assert.equal((await receipt.completion).reason, "target-clipped"); assert.equal(f.state.calls, 1);
  });
  await test("a descendant Range cannot substitute for exposure of the exact target fragment", async () => {
    const f = instantFixture();
    f.document.createRange = () => ({ selectNodeContents() {}, getClientRects: () => [
      { left: 20, top: 120, right: 60, bottom: 140 },
    ] });
    f.state.move = () => { f.target.shape = [20, 420, 60, 440]; };
    const receipt = f.jump(); f.state.resolve({ interrupted: false });
    assert.equal((await receipt.completion).reason, "target-clipped"); assert.equal(f.state.calls, 1);
  });
  await test("unobservable clips and root capability never silently disable an instant jump class", async () => {
    for (const kind of ["transform", "root", "observer"]) {
      const f = instantFixture();
      if (kind === "transform") f.nested.computed.transform = "rotate(1deg)";
      if (kind === "root") delete f.window.visualViewport;
      if (kind === "observer") f.c.MutationObserver = undefined;
      const receipt = f.jump(); f.state.resolve({ interrupted: false });
      assert.equal((await receipt.completion).status, "unrecordable");
      assert.equal(f.state.calls, 1); assert.equal(f.nested.scrollTop, 580);
    }
  });
  await test("request collection cannot issue native movement after reentrant supersession", () => {
    const f = instantFixture(); let collected = false;
    f.c.getComputedStyle = element => {
      if (!collected) { collected = true; f.api.beginIntent(); }
      return element.computed;
    };
    assert.equal(f.jump(), undefined);
    assert(collected && !f.state.calls && f.state.observer.disconnected);
  });
  await test("programmatic jump cannot borrow an intent admitted by its invalidation listener", () => {
    const f = instantFixture(); let admitted = false, successor;
    f.window.addEventListener("reading-viewport-invalidated", () => {
      if (admitted) return;
      admitted = true; f.api.beginIntent(); successor = f.api.capturePermit();
    });
    assert.equal(f.c.scrollElementIntoView(f.target, "center"), undefined);
    assert(admitted && f.api.isPermitCurrent(successor)); assert(!f.state.calls);
  });
  await test("navigation notification cannot give an older jump its successor's follower claim", () => {
    const f = instantFixture(); let successor, claims = 0;
    f.c.editorScroll.previewNavigation = () => { claims++; };
    f.window.addEventListener("preview-navigation-intent", () => {
      f.api.beginIntent(); successor = f.api.capturePermit();
    });
    assert.equal(f.c.scrollElementIntoView(f.target, "center"), undefined);
    assert(f.api.isPermitCurrent(successor)); assert(!f.state.calls && claims === 0);
  });
  await test("a detached document target cannot issue or take over a current instant request", () => {
    const f = instantFixture(); f.target.isConnected = false;
    assert.equal(f.jump(), undefined); assert(!f.state.calls && !f.state.observer);
  });
  function nativeRouteFixture(target = {}) {
    const other = {}, request = {};
    const call = { target, request, nativePromise: true, rawResult: { interrupted: false },
      options: { behavior: "instant", block: "start", inline: "nearest" } };
    const jumps = [{ target, native: call, receipt: { request } }], calls = [call];
    const outcomes = [{ status: "completed" }];
    const expected = { targets: [target], block: "start", count: 1 };
    const qualify = require("./reading-jump-native-controls").qualifyNativeRoute;
    return { target, other, call, jumps, calls, outcomes, expected,
      accepts: () => qualify(jumps, calls, outcomes, expected) };
  }
  for (const [label, change] of [
    ["wrong native target", f => { f.call.target = f.other; }],
    ["wrong expected document target", f => { f.expected.targets[0] = f.other; }],
    ["wrong native block", f => { f.call.options.block = "center"; }],
    ["wrong declared block", f => { f.expected.block = "center"; }],
    ["missing declared request", f => { f.expected.count = 2; f.expected.targets.push(f.target); }],
    ["extra helper request", f => { f.jumps.push(f.jumps[0]); f.calls.push(f.call); f.outcomes.push(f.outcomes[0]); }],
    ["extra native request", f => { f.calls.push(f.call); }],
    ["wrong exact Promise", f => { f.jumps[0].receipt.request = {}; }],
    ["wrong inline", f => { f.call.options.inline = "start"; }],
    ["wrong behavior", f => { f.call.options.behavior = "smooth"; }],
    ["interrupted native result", f => { f.call.rawResult.interrupted = true; }],
  ]) {
    await test("actual native fixture predicate rejects " + label, () => {
      const f = nativeRouteFixture();
      assert.equal(f.accepts(), true, "The exact production fixture predicate first accepts its valid setup");
      change(f);
      assert.equal(f.accepts(), false);
    });
  }
  await test("actual native fixture predicate requires both Search requests and only the final completion", () => {
    const f = nativeRouteFixture(), request = {};
    f.call.options.block = "center"; f.expected.block = "center";
    f.expected.count = 2; f.expected.targets.push(f.target);
    f.call.rawResult.interrupted = true;
    f.outcomes[0] = { status: "unrecordable", reason: "superseded" };
    const final = { ...f.call, request, rawResult: { interrupted: false } };
    f.calls.push(final); f.jumps.push({ target: f.target, native: final, receipt: { request } });
    f.outcomes.push({ status: "completed" });
    assert.equal(f.accepts(), true);
    f.outcomes[0] = { status: "completed" };
    assert.equal(f.accepts(), false);
  });
  async function wrappedSearchFixture() {
    const payload = require("./reading-jump-native-controls");
    const { marked } = await import("marked");
    // The existing build-tool dependency provides tree/text mutation. Only the
    // browser ports used by these exact production passes are supplied here.
    const { DOMParser } = require("@xmldom/xmldom");
    const document = new DOMParser().parseFromString("<main>" + marked.parse(payload.fixtureMarkdown) + "</main>", "text/html");
    const jumpPort = {
      calls: [], previews: 0, observers: [], layoutReads: [],
      settle() { for (const call of this.calls) call.resolve({ interrupted: false }); },
    };
    function matches(element, selector) {
      return selector.split(",").some(part => {
        const pattern = /^([.#]?[\w-]+)(?:\[([\w-]+)\])?$/.exec(part.trim());
        assert(pattern, "Unsupported exact-fixture selector: " + part);
        const [ , name, attribute ] = pattern;
        const match = name[0] === "#" ? element.id === name.slice(1) :
          name[0] === "." ? element.classList.contains(name.slice(1)) : element.tagName === name.toUpperCase();
        return match && (!attribute || element.hasAttribute(attribute));
      });
    }
    function descendants(parent, accept) {
      const found = [];
      for (const child of Array.from(parent.childNodes || [])) {
        if (accept(child)) found.push(child);
        found.push(...descendants(child, accept));
      }
      return found;
    }
    function decorate(element) {
      element.tagName = element.tagName.toUpperCase();
      for (const [property, attribute] of [["id", "id"], ["className", "class"]]) {
        Object.defineProperty(element, property, {
          get: () => element.getAttribute(attribute) || "",
          set: value => element.setAttribute(attribute, value),
        });
      }
      element.classList = {
        contains: name => element.className.split(/\s+/).includes(name),
        toggle(name, enabled) {
          const classes = new Set(element.className.split(/\s+/).filter(Boolean));
          if (enabled === undefined) enabled = !classes.has(name);
          if (enabled) classes.add(name); else classes.delete(name);
          element.className = [...classes].join(" "); return enabled;
        },
        add(name) { this.toggle(name, true); },
        remove(name) { this.toggle(name, false); },
      };
      element.dataset = new Proxy({}, {
        get: (_target, key) => element.getAttribute("data-" + key.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase())),
        set(_target, key, value) {
          element.setAttribute("data-" + key.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()), value); return true;
        },
      });
      Object.defineProperty(element, "parentElement", { get: () => element.parentNode?.nodeType === 1 ? element.parentNode : null });
      element.getRootNode = () => {
        let root = element; while (root.parentNode) root = root.parentNode; return root;
      };
      Object.defineProperty(element, "isConnected", { get: () => element.getRootNode() === document });
      element.contains = other => {
        for (let child = other; child; child = child.parentNode) if (child === element) return true;
        return false;
      };
      element.scrollIntoView = options => {
        let resolve;
        const request = new Promise(done => { resolve = done; });
        jumpPort.calls.push({ target: element, options, request, resolve });
        return request;
      };
      Object.defineProperty(element, "nextElementSibling", { get() {
        let next = element.nextSibling; while (next && next.nodeType !== 1) next = next.nextSibling; return next;
      } });
      element.querySelectorAll = selector => descendants(element, item => item.nodeType === 1 && matches(item, selector));
      element.querySelector = selector => element.querySelectorAll(selector)[0] || null;
      element.closest = selector => matches(element, selector) ? element : element.parentElement?.closest(selector) || null;
      element.after = sibling => element.parentNode.insertBefore(sibling, element.nextSibling);
      element.replaceWith = (...siblings) => {
        const parent = element.parentNode;
        for (const sibling of siblings) parent.insertBefore(sibling, element);
        parent.removeChild(element);
      };
      return element;
    }
    const viewer = document.documentElement;
    for (const element of [viewer, ...descendants(viewer, item => item.nodeType === 1)]) decorate(element);
    const createElement = document.createElement.bind(document);
    document.createElement = name => decorate(createElement(name));
    document.createTreeWalker = (root, show, filter) => {
      assert.equal(show, 4, "Actual search asks for text nodes");
      const texts = descendants(root, item => item.nodeType === 3 && filter.acceptNode(item) === 1);
      let index = 0; return { nextNode: () => texts[index++] || null };
    };
    const f = fixture();
    const readingHeadings = new Set(viewer.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    Object.assign(f.c, { document, viewer, currentFilePath: "owned-instant-fixture.md", collapsedHeaders: new Map(),
      readingAttributeRecords: new WeakMap(), readingPseudoRecords: new WeakMap(), readingCollapsibleSections: new WeakMap(),
      refreshReadingPresentation() {}, // This fixture never admits a reading Source.
      searchMatches: [], currentMatchIndex: -1, currentMatchEl: null, pendingSearchTerm: null,
      searchPrevBtn: {}, searchNextBtn: {}, searchCounter: {}, i18n: key => key,
      editorScroll: { previewNavigation() { jumpPort.previews++; } },
      MutationObserver: class {
        constructor() { this.records = []; this.disconnected = false; jumpPort.observers.push(this); }
        observe(target, options) {
          assert.equal(target, viewer); this.target = target; this.options = options;
        }
        takeRecords() { return this.records.splice(0); }
        disconnect() { this.disconnected = true; }
      },
      getComputedStyle(element, pseudo) {
        jumpPort.layoutReads.push(element);
        if (pseudo === "::before" && readingHeadings.has(element)) return { content: '"\\25BC"' };
        // This tree has no browser layout. Exercise the real helper's native
        // invocation, never manufacture a geometry/completion certificate.
        throw new Error("wrapped-search-fixture-no-layout");
      },
      NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }, viewerMutationGen: 0 });
    vm.runInContext(read("utils.js"), f.c);
    f.c.escapeRegex = f.window.MarkalooUtils.escapeRegex;
    vm.runInContext(body("function noteReadingAttribute(", "\nfunction retireReadingPresentation(") +
      body("function noteViewerMutation()", "\n// Read-only accessor.") +
      body("function slugifyHeading(", "\nlet tocEntries =") +
      body("function _collapseKey(", "\n// One delegated listener") +
      body("function flattenCollapsibleSections(", "\n// Resolve an element") +
      body("function clearSearchHighlights(", "\nfunction nextMatch("), f.c);
    loadSharedJump(f);
    const headers = viewer.querySelectorAll("h1, h2, h3, h4, h5, h6");
    assert(headers.length === 2 && headers.every(header => !header.id), "Real Marked output starts with the exact two unslugged headings");
    f.c.assignHeadingIds(headers); f.c.makeHeadersCollapsible();
    f.c.highlightSearchTerm("instantuniquewitness");
    jumpPort.settle();
    return { ...f, document, viewer, payload, jumpPort };
  }
  await test("wrapped Search fixture binds the real shared jump and preserves successor ownership after its native invocation", async () => {
    const f = await wrappedSearchFixture();
    assert.equal(typeof f.c.scrollElementIntoView, "function", "The production shared jump helper is installed in this VM");
    const target = f.c.searchMatches[0], port = f.jumpPort;
    assert(target && target.isConnected && f.viewer.contains(target), "The production highlighter owns an attached target");
    const before = port.calls.length, ticket = f.api.beginIntent();
    let receipt, successor;
    try {
      receipt = f.c.scrollElementIntoView(target, "center", ticket);
      assert.equal(port.calls.length, before + 1, "The production helper reaches the observable native port");
      assert.equal(port.calls.at(-1).target, target);
      assert(receipt && receipt.completion, "The production helper retains the port's pending request");
      f.api.beginIntent(); successor = f.api.capturePermit();
      assert(f.api.isPermitCurrent(successor));
    } finally {
      port.settle();
      if (receipt) await receipt.completion;
    }
    assert(f.api.isPermitCurrent(successor), "The old request's continuation cannot retire the successor");
    assert.equal(port.calls.length, before + 1, "The old continuation cannot invoke the port again");
    assert(port.observers.every(observer => observer.disconnected), "Observed request resources were released");
  });
  await test("actual Search fixture resolves its exact unique target after production heading wrapping and highlighting", async () => {
    const f = await wrappedSearchFixture();
    assert.equal(f.c.viewerMutationGen, 1, "The actual wrapper mutation producer ran");
    const heading = f.viewer.querySelector("#instant-focus-target"), section = heading.nextElementSibling;
    assert.equal(section.tagName, "DIV"); assert(section.classList.contains("collapsible-section"));
    assert.equal(section.dataset.forHeader, heading.id); assert.equal(section.dataset.mvCollapsible, "1");
    assert.equal(section.querySelector("p").textContent, "instantuniquewitness");
    const target = f.payload.expectedSearchTarget(f.viewer);
    assert(target && target === f.c.searchMatches[0] && f.c.searchMatches.length === 1);
    const route = nativeRouteFixture(target);
    route.call.options.block = route.expected.block = "center";
    route.expected.count = 2; route.expected.targets.push(target);
    route.outcomes[0] = { status: "unrecordable", reason: "superseded" };
    const request = {}, final = { ...route.call, request };
    route.calls.push(final); route.jumps.push({ target, native: final, receipt: { request } });
    route.outcomes.push({ status: "completed" });
    assert.equal(route.accepts(), true);
  });
  for (const [label, change] of [
    ["wrong section association", f => { f.viewer.querySelector("#instant-focus-target").nextElementSibling.dataset.forHeader = "other"; }],
    ["missing production section marker", f => { f.viewer.querySelector("#instant-focus-target").nextElementSibling.removeAttribute("data-mv-collapsible"); }],
    ["wrong exact witness", f => { f.c.searchMatches[0].textContent = "another witness"; }],
    ["duplicate matching highlight", f => {
      const duplicate = f.document.createElement("span");
      duplicate.className = "search-highlight"; duplicate.textContent = "instantuniquewitness";
      f.c.searchMatches[0].parentNode.appendChild(duplicate);
    }],
  ]) {
    await test("actual wrapped Search target resolver rejects " + label, async () => {
      const f = await wrappedSearchFixture();
      assert(f.payload.expectedSearchTarget(f.viewer), "The production-wrapped positive setup must resolve first");
      change(f);
      assert.equal(f.payload.expectedSearchTarget(f.viewer), null);
    });
  }
  for (const [label, change] of [
    ["an arbitrary refusal", f => { f.outcomes[0].reason = "layout-or-offset-changed"; }],
    ["a completed record during a transformed pulse", f => { f.outcomes[0] = { status: "completed" }; }],
    ["an interrupted native request despite pulse refusal", f => { f.call.rawResult.interrupted = true; }],
    ["a malformed native result despite pulse refusal", f => { f.call.rawResult = {}; }],
    ["a rejected native request despite pulse refusal", f => { f.call.rawError = "native rejection"; }],
    ["missing transformed pulse evidence", f => { f.call.completionPulse.transform = undefined; }],
    ["a pulse refusal without actual transformed pulse context", f => { f.call.completionPulse.transform = "none"; }],
  ]) {
    await test("actual Notes fixture predicate rejects " + label, () => {
      const f = nativeRouteFixture();
      f.expected.record = "note-pulse";
      f.call.completionPulse = { active: true, transform: "matrix(1,0,0,1,0,0)" };
      f.outcomes[0] = { status: "unrecordable", reason: "unsupported-clip" };
      assert.equal(f.accepts(), true, "Only the specific conservative transformed-pulse refusal is acceptable");
      change(f); assert.equal(f.accepts(), false);
    });
  }
  await test("actual Notes fixture predicate still requires completed records for supported stable geometry", () => {
    const f = nativeRouteFixture(); f.expected.record = "note-pulse";
    f.call.completionPulse = { active: true, transform: "none" };
    assert.equal(f.accepts(), true);
    f.outcomes[0] = { status: "unrecordable", reason: "unsupported-clip" };
    assert.equal(f.accepts(), false);
  });
  await test("authored native payloads parse without executing or claiming a native result", async () => {
    const errors = [];
    let scripts = 0;
    await require("./reading-jump-native-controls").run({
      execute(code) {
        try { new vm.Script(code); scripts++; } catch (error) { errors.push(error); }
        return { ok: false, syntaxOnly: true };
      },
      capture() {}, check() {},
    });
    assert(scripts > 0, "The real payload producer supplied renderer code");
    assert.deepEqual(errors, []);
  });

  function loadSearch(f) {
    const callbacks = {}, jumps = [], highlights = [];
    const control = key => ({ value: "", addEventListener(type, callback) { callbacks[key + ":" + type] = callback; } });
    Object.assign(f.c, {
      searchInput: control("input"), searchPrevBtn: control("prev"), searchNextBtn: control("next"),
      searchCloseBtn: control("close"), searchPanel: { classList: { contains: () => true } },
      searchDebounceTimer: null, pendingSearchTerm: null, pendingSearchRequest: null,
      searchMatches: [], currentMatchIndex: -1, currentMatchEl: null, TIMING: { searchDebounceDelay: 120 },
      syncSearchNavDisabled() {}, updateSearchCounter() {}, toggleSearchPanel() {},
      clearSearchHighlights() { f.c.searchMatches = []; f.c.currentMatchIndex = -1; f.c.currentMatchEl = null; },
      editorScroll: { previewNavigation() {} },
    });
    const matches = ["first", "next"].map(id => Object.assign(node(f.viewer), {
      id, classList: { add() {}, remove() {} },
      scrollIntoView: options => jumps.push({ id, options }),
    }));
    f.c.highlightSearchTerm = (term, request) => {
      highlights.push({ term, request }); f.c.searchMatches = matches; f.c.currentMatchIndex = 0;
      f.c.highlightCurrentMatch(request);
    };
    loadSharedJump(f);
    vm.runInContext(read("reading-history.js"), f.c);
    vm.runInContext(body("function readingInputContext(", "\n// Which element actually scrolls") +
      body("function createReadingHistoryConsumer(",
      "\n// ============================================\n// UNDO / REDO HISTORY"), f.c);
    vm.runInContext(body("function highlightCurrentMatch(", "\n// A disabled button") +
      body("function nextMatch(", "\nfunction toggleSearchPanel(") +
      body("function flushPendingSearch(", "\n// Index/TOC functionality") +
      body("function resyncSearchAfterRender(", "\n// ---- End incremental DOM patching"), f.c);
    const type = term => {
      f.c.searchInput.value = term; callbacks["input:input"]({ target: f.c.searchInput });
    };
    const flush = () => {
      const timer = f.c.searchDebounceTimer, callback = f.timers.get(timer);
      assert(callback, "A genuine owned debounce is armed"); f.timers.delete(timer); callback();
    };
    return { type, flush, callbacks, jumps, highlights };
  }
  await test("search captures genuine intent before debounce and old callbacks cannot consume newer requests", () => {
    const f = fixture(), search = loadSearch(f), oldPermit = f.api.capturePermit();
    search.type("old term"); const stale = f.timers.get(f.c.searchDebounceTimer);
    assert(!f.api.isPermitCurrent(oldPermit) && f.c.pendingSearchRequest.intent);
    search.type("new term"); const current = f.c.pendingSearchRequest;
    stale();
    assert.equal(f.c.pendingSearchRequest, current); assert.equal(search.highlights.length, 0);
    search.flush();
    assert.equal(search.highlights.length, 1); assert.equal(search.highlights[0].term, "new term");
    assert.equal(search.jumps.length, 1);
  });
  await test("same-tab search repair retains only its genuine pending query across source invalidation", () => {
    const f = fixture(), search = loadSearch(f);
    search.type("term"); const intent = f.c.pendingSearchRequest.intent;
    f.api.invalidate();
    f.c.resyncSearchAfterRender(f.api.capturePermit());
    assert.equal(f.c.pendingSearchRequest.intent, intent);
    assert(f.api.isIntentCurrent(intent)); search.flush();
    assert.equal(search.jumps.length, 1); assert.equal(f.c.pendingSearchRequest, null);
  });
  await test("passive search repair uses only the originating render permit and cannot mint or borrow intent", () => {
    const f = fixture(), search = loadSearch(f), intent = f.api.beginIntent();
    f.c.searchInput.value = "term";
    f.c.resyncSearchAfterRender(f.api.capturePermit());
    assert.equal(f.c.pendingSearchRequest.intent, null);
    assert(f.api.isIntentCurrent(intent)); search.flush();
    assert.equal(search.jumps.length, 0); assert(f.api.isIntentCurrent(intent));
    f.c.resyncSearchAfterRender(f.api.capturePermit());
    f.api.beginIntent(); search.flush();
    assert.equal(search.highlights.length, 2); assert.equal(search.jumps.length, 0);
  });
  await test("new genuine input suppresses a stale query jump but preserves its highlight and counter work", () => {
    const f = fixture(), search = loadSearch(f);
    search.type("term"); f.api.beginIntent(); search.flush();
    assert.equal(search.highlights.length, 1); assert.equal(search.jumps.length, 0);
    assert.equal(f.c.currentMatchIndex, 0);
  });
  await test("search Enter rebuilds highlights and issues only its final-index instant request under its own ticket", () => {
    const f = fixture(), search = loadSearch(f);
    search.type("term"); const old = f.c.pendingSearchRequest.intent;
    let prevented = false;
    search.callbacks["input:keydown"]({ key: "Enter", preventDefault() { prevented = true; } });
    assert(prevented && !f.api.isIntentCurrent(old));
    assert.equal(f.c.currentMatchIndex, 1);
    assert.deepEqual(search.jumps.map(jump => jump.id), ["next"]);
    assert(search.jumps.every(jump => jump.options.behavior === "instant" && jump.options.block === "center"));
    assert.equal(f.c.pendingSearchRequest, null);
  });
};
