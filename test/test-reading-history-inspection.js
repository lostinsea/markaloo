"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");
const helperSource = fs.readFileSync(path.join(__dirname, "reading-history-inspection.js"), "utf8");
const nativeSource = fs.readFileSync(path.join(__dirname, "test-reading-history-native.js"), "utf8");
let passed = 0, finished = false;
process.once("exit", () => {
  if (!finished && !process.exitCode) process.exitCode = 1;
});
async function check(name, action) {
  await action();
  passed++;
  console.log("PASS " + name);
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(argv = ["--reader-inspection-holds"], options = {}) {
  let now = 1000000, nextTimer = 0;
  const timers = new Map(), nodes = [], calls = [], delayed = [];
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  class Node {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.listeners = new Map();
      this.style = {};
      nodes.push(this);
    }
    setAttribute() {}
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = null;
    }
    addEventListener(event, listener) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event).add(listener);
    }
    removeEventListener(event, listener) { this.listeners.get(event)?.delete(listener); }
    fire(event, trusted = true) {
      const value = { isTrusted: trusted, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; } };
      for (const listener of [...(this.listeners.get(event) || [])]) listener(value);
      return value;
    }
  }
  const body = new Node("body");
  const find = (node, id) => node.id === id ? node : node.children.map(child => find(child, id)).find(Boolean);
  const renderer = vm.createContext({ window: {}, Date: ClockDate, document: {
    body, createElement: tag => new Node(tag), getElementById: id => find(body, id),
  } });
  const owner = new EventEmitter(), contents = new EventEmitter();
  owner.webContents = contents;
  owner.destroyed = contents.destroyed = false;
  owner.isDestroyed = () => owner.destroyed;
  contents.isDestroyed = () => contents.destroyed;
  const evaluate = code => vm.runInContext(code, renderer);
  contents.executeJavaScript = code => {
    const install = code.startsWith("(function installReaderInspection");
    calls.push(install ? "install" : "cleanup");
    if (install && options.installError) throw new Error("controlled installation failure");
    if (!install && options.cleanupError) throw new Error("controlled cleanup failure");
    if (!install && options.cleanupStall) return new Promise(() => {});
    if (install && options.delayedInstall) return new Promise((resolve, reject) => {
      delayed.push(() => {
        try { Promise.resolve(evaluate(code)).then(resolve, reject); } catch (error) { reject(error); }
      });
    });
    const result = evaluate(code);
    return install && options.reply ? Promise.resolve(result).then(options.reply) : result;
  };
  const context = vm.createContext({
    module: { exports: {} }, require, Date: ClockDate,
    setTimeout(callback, milliseconds) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + milliseconds });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(helperSource, context);
  const { ReaderInspection, HOLD_MS, CLEANUP_MS } = context.module.exports;
  const inspection = new ReaderInspection(argv);
  const button = action => nodes.findLast(node => node.tagName === "button" &&
    node.textContent === action && node.parent);
  return { inspection, owner, contents, nodes, calls, delayed, HOLD_MS, CLEANUP_MS, button,
    panel: () => find(body, "reader-inspection-controls"),
    async tick(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(id)) timer.callback();
      }
      await flush();
    },
    clean(checkNodes = true) {
      assert.equal(inspection.active, false);
      assert.equal(timers.size, 0);
      assert.equal(owner.eventNames().length, 0);
      assert.equal(contents.eventNames().length, 0);
      if (checkNodes) {
        assert.equal(find(body, "reader-inspection-controls"), undefined);
        for (const node of nodes) for (const listeners of node.listeners.values()) assert.equal(listeners.size, 0);
      }
    },
  };
}

function captureHarness(options = {}) {
  const files = new Map(), captures = [], assertions = [];
  let acquisitions = 0;
  const context = vm.createContext({
    path, evidence: path.resolve("not-created-reader-control-data"), captures,
    observedContents: { async capturePage() {
      acquisitions++;
      if (options.captureError) throw new Error("controlled acquisition failure");
      return { toPNG: () => Buffer.from(options.empty ? "" : "controlled image bytes") };
    } },
    bounded: action => action(), digest: value => require("crypto").createHash("sha256").update(value).digest("hex"),
    fs: {
      writeFileSync(file, value) { assert.equal(files.has(file), false); files.set(file, value); },
      statSync: file => ({ size: files.get(file).length }), readFileSync: file => files.get(file),
    },
    demand(name, ok) { assertions.push({ name, ok }); if (!ok) throw new Error(name); },
  });
  const start = nativeSource.indexOf("async function capture(");
  const end = nativeSource.indexOf("\nasync function inspectCheckpoint(", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(nativeSource.slice(start, end), context);
  return { context, captures, assertions, acquisitions: () => acquisitions };
}

function branchCaptureHarness(options = {}) {
  const h = captureHarness(options), frames = [], sleepers = [], delays = [], timers = new Map();
  const state = { loading: false, available: true, active: "Native history Alpha",
    current: "Native history Alpha", visible: true, animations: [], ownerLost: false,
    wrongPort: false, wrongPoint: false };
  const heading = { isConnected: true, textContent: "Native history Alpha" };
  const button = textContent => ({
    isConnected: true, textContent,
    classList: { contains: name => name === "active" && state.active === textContent },
    getAttribute: name => name === "aria-current" && state.current === textContent ? "location" : null,
  });
  const headings = [heading], buttons = [button("Native history Alpha"), button("Native history Beta")];
  const renderer = vm.createContext({
    currentFilePath: "controlled-fixture.md", originalMarkdown: "controlled Source",
    readingDisplay: { source: { source: "controlled Source" } }, readingRenderCompletion: null,
    loadingScreen: { classList: { contains: () => state.loading } },
    viewer: { querySelectorAll: selector => {
      assert.equal(selector, "h1,h2,h3,h4,h5,h6"); return headings;
    } },
    indexList: { querySelectorAll: selector => {
      assert.equal(selector, "button.index-item"); return buttons;
    } },
    indexPanel: { classList: { contains: name => name === "visible" && state.visible },
      getAnimations: options => { assert.equal(options.subtree, true); return state.animations; } },
    window: { readingLocationAdapter: { available: () => state.available },
      __readingHistoryNative: { position: point => {
        assert.equal(point, "A");
        if (state.wrongPort) throw new Error("controlled production port or tab lifetime changed");
        if (state.wrongPoint) throw new Error("controlled saved Source atom/alignment differs");
        return { sourceKey: "controlled-key", start: 5 };
      } } },
    requestAnimationFrame: callback => { frames.push(callback); },
  });
  let nextTimer = 0;
  Object.assign(h.context, {
    fixture: "controlled-fixture.md", markdown: "controlled Source",
    liveMain: () => !state.ownerLost, guardsIntact: () => true,
    setTimeout(callback, milliseconds) {
      const id = ++nextTimer; delays.push(milliseconds); timers.set(id, callback); return id;
    },
    clearTimeout(id) { timers.delete(id); },
    sleep: milliseconds => { assert.equal(milliseconds, 50); return new Promise(resolve => sleepers.push(resolve)); },
  });
  h.context.observedContents.executeJavaScript = code => {
    if (options.frameError && code.startsWith("new Promise")) throw new Error("controlled frame rejection");
    return vm.runInContext(code, renderer);
  };
  const start = nativeSource.indexOf("async function bounded(");
  const end = nativeSource.indexOf("\nasync function capture(", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(nativeSource.slice(start, end), h.context);
  return { ...h, state, renderer, headings, buttons, frames, sleepers, delays, timers,
    take: () => h.context.waitForBranchCapture("A", "Native history Alpha")
      .then(() => h.context.capture("branch00-alpha-initial", false)),
    async frame() { const pending = frames.splice(0); assert.equal(pending.length, 1); pending[0](); await flush(); },
    async poll() { assert.equal(sleepers.length, 1); sleepers.shift()(); await flush(); },
    async expire() { for (const callback of [...timers.values()]) callback(); await flush(); },
  };
}

const releaseCaptureNames = [
  "release01-coalesced-tail", "release02-explicit-return", "release03-issued-back",
  "release04-failed-branch-retained", "release05-stale-highlight-repair", "release06-second-tab-gamma",
  "release07-independent-tabs", "release07b-cancel-close-question", "release07c-canceled-close-retained",
  "release08-reopened-empty", "release09-ten-location-cap", "release10-renderer-lifetime-reset",
];

function releaseCaptureHarness(name, options = {}) {
  const h = branchCaptureHarness(options), dirty = name.startsWith("release07b-") || name.startsWith("release07c-");
  const second = name.startsWith("release06-") || name.startsWith("release07");
  const point = {
    "release01-coalesced-tail": "search-tail", "release02-explicit-return": "explicit-next",
    "release03-issued-back": "explicit-next", "release04-failed-branch-retained": "explicit-next",
    "release05-stale-highlight-repair": "repair-capture", "release06-second-tab-gamma": "second-gamma",
    "release07-independent-tabs": "second-gamma", "release09-ten-location-cap": "cap12",
  }[name];
  const source = second ? "controlled second Source" : "controlled Source";
  const heading = second ? "Other history Gamma" : "Native history Tail";
  Object.assign(h.state, { active: heading, current: heading, page: "new-page", dialogAnimations: [],
    availability: { back: name !== "release07b-cancel-close-question", forward: false } });
  h.headings[0].textContent = heading;
  const button = textContent => ({
    isConnected: true, textContent,
    classList: { contains: value => value === "active" && h.state.active === textContent },
    getAttribute: value => value === "aria-current" && h.state.current === textContent ? "location" : null,
  });
  h.buttons.splice(0, h.buttons.length, button(heading), button("other heading"));
  const closeState = { tab: 42, source, editor: source + " dirty edit", selection: [3, 5, "forward"],
    dirty: true, undo: ["original"], redo: ["redo"], availability: { back: true, forward: false } };
  const dialog = { open: name === "release07b-cancel-close-question",
    getAnimations: () => h.state.dialogAnimations };
  const title = { textContent: "Close without saving?" }, cancel = { textContent: "Cancel" };
  Object.assign(h.context, { secondFixture: "controlled-second.md", secondMarkdown: "controlled second Source" });
  Object.assign(h.renderer, {
    currentFilePath: second ? "controlled-second.md" : "controlled-fixture.md", originalMarkdown: source,
    readingDisplay: { source: { source: dirty ? closeState.editor : source } },
    isEditMode: dirty, hasUnsavedChanges: dirty, undoHistory: structuredClone(closeState.undo),
    redoHistory: structuredClone(closeState.redo), structuredClone,
    markdownEditor: { value: closeState.editor, selectionStart: 3, selectionEnd: 5, selectionDirection: "forward" },
    document: {
      getElementById: id => id === "appMessageDialog" ? dialog : id === "appMessageTitle" ? title : null,
      querySelector: () => cancel,
    },
  });
  const positionCalls = [];
  Object.assign(h.renderer.window, {
    CustomTabs: { getActiveTab: () => ({ id: h.state.tab ?? 42 }) },
    readingHistoryControls: { availability: () => h.state.availability },
    getReloadRequestSession: () => h.state.page,
    __readingHistoryNative: {
      documentState() {
        if (h.state.wrongPort) throw new Error("controlled production port or tab lifetime changed");
        return { edit: h.renderer.isEditMode, dirty: h.renderer.hasUnsavedChanges };
      },
      position(value) {
        assert.equal(value, point);
        positionCalls.push(value);
        if (h.state.wrongPoint) throw new Error("controlled saved Source atom/alignment differs");
      },
    },
  });
  return { ...h, dialog, title, cancel, closeState, positionCalls,
    take: () => h.context.waitForReleaseCapture(name, dirty ? closeState : null,
      name === "release10-renderer-lifetime-reset" ? "old-page" : null).then(() => h.context.capture(name)),
  };
}

function checkpointHarness(options = {}) {
  const h = captureHarness(options), records = [];
  const state = { document: { source: "controlled Source", dirty: false },
    position: { sourceKey: "controlled-key", start: 5, end: 9, availability: { back: true, forward: false } },
    focus: { id: "controlled-focus", tag: "BUTTON" } };
  let snapshots = 0;
  Object.assign(h.context, {
    observedMain: {}, isDeepStrictEqual: require("util").isDeepStrictEqual,
    liveMain: () => !options.ownerLost,
    exec: async () => {
      snapshots++;
      if (options.ownerLost && snapshots > 1) throw new Error("controlled owner loss");
      const current = structuredClone(state);
      if (options.changed && snapshots > 1) current.document.dirty = true;
      return current;
    },
    inspection: { checkpoints: records, async hold(_owner, checkpoint) {
      records.push({ checkpoint });
      if (options.cancel) throw new Error("controlled operator canceled");
    } },
  });
  const start = nativeSource.indexOf("async function inspectCheckpoint(");
  const end = nativeSource.indexOf("\n// This function is serialized", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(nativeSource.slice(start, end), h.context);
  return { ...h, records };
}

async function run() {
  await check("an unfinished pure-control run cannot silently exit green", () => {
    const source = fs.readFileSync(__filename, "utf8");
    const start = source.indexOf('process.once("exit"');
    const end = source.indexOf("\n});", start) + "\n});".length;
    assert.ok(start >= 0 && end > start);
    for (const [complete, initialCode, expectedCode] of [[false, 0, 1], [true, 0, 0], [false, 7, 7]]) {
      let onExit;
      const state = { exitCode: initialCode, once(_event, listener) { onExit = listener; } };
      const context = vm.createContext({ process: state });
      vm.runInContext("let finished = " + complete + ";\n" + source.slice(start, end), context);
      onExit();
      assert.equal(state.exitCode, expectedCode);
    }
  });
  await check("default off has no controls, records, owner calls or timers", async () => {
    const h = harness([]);
    assert.equal(h.inspection.enabled, false);
    await assert.rejects(h.inspection.hold(h.owner, "initial"), /disabled/);
    assert.equal(h.inspection.checkpoints.length, 0);
    assert.equal(h.calls.length, 0);
    h.clean();
  });
  await check("only the exact opt-in switch is accepted once", () => {
    for (const args of [["--reader-inspection-holds=false"], ["--reader-inspection-other"],
      ["--reader-inspection-holds", "--reader-inspection-holds"]]) {
      assert.throws(() => harness(args), /requires exactly/);
    }
    assert.equal(harness(["entry.js", "--reader-inspection-holds"]).inspection.enabled, true);
  });
  await check("hold and cleanup limits remain 30000/1000ms within the unchanged startup bound", () => {
    const h = harness();
    assert.equal(h.HOLD_MS, 30000);
    assert.equal(h.CLEANUP_MS, 1000);
    assert.equal(4 * h.HOLD_MS, 120000);
    assert.ok(4 * h.HOLD_MS + h.CLEANUP_MS < 180000);
    assert.match(nativeSource, /startup-inclusive watchdog expired"\)\), 180000\)/);
    h.clean();
  });
  await check("the four exact checkpoints continue in order and remove controls before return", async () => {
    const h = harness();
    await assert.rejects(h.inspection.hold(h.owner, "toc-beta"), /out of order/);
    let oldButton;
    for (const checkpoint of ["initial", "toc-beta", "back-alpha", "forward-gamma"]) {
      const promise = h.inspection.hold(h.owner, checkpoint);
      await assert.rejects(h.inspection.hold(h.owner, checkpoint), /active/);
      assert.ok(h.panel());
      if (oldButton) oldButton.fire("click");
      assert.equal(h.inspection.active, true);
      assert.equal(h.button("Continue").fire("mousedown").defaultPrevented, true);
      h.button("Continue").fire("click", false);
      await flush();
      assert.equal(h.inspection.active, true);
      oldButton = h.button("Continue");
      oldButton.fire("click");
      const record = await promise;
      assert.equal(record.checkpoint, checkpoint);
      assert.equal(record.operatorAction, "continue");
      assert.equal(record.terminalReason, "continued");
      assert.equal(record.cleanup, "removed-before-action-return");
      assert.equal(record.error, null);
      h.clean();
    }
    assert.equal(new Set(h.inspection.checkpoints.map(record => record.token)).size, 4);
    await assert.rejects(h.inspection.hold(h.owner, "initial"), /out of order/);
  });
  for (const action of ["cancel", "timeout"]) {
    await check("the final Gamma hold retains bounded teardown: " + action, async () => {
      const h = harness();
      for (const checkpoint of ["initial", "toc-beta", "back-alpha"]) {
        const promise = h.inspection.hold(h.owner, checkpoint);
        h.button("Continue").fire("click");
        await promise;
        h.clean();
      }
      const promise = h.inspection.hold(h.owner, "forward-gamma");
      const rejected = assert.rejects(promise, action === "cancel" ? /canceled/ : /timeout/);
      if (action === "cancel") h.button("Cancel").fire("click");
      else await h.tick(h.HOLD_MS);
      await rejected;
      assert.equal(h.inspection.checkpoints.length, 4);
      assert.equal(h.inspection.checkpoints[3].terminalReason, action === "cancel" ? "canceled" : "timeout");
      await assert.rejects(h.inspection.hold(h.owner, "forward-gamma"), /previously failed/);
      h.clean();
    });
  }
  await check("Cancel rejects without an automatic continuation or visual acceptance", async () => {
    const h = harness(), promise = h.inspection.hold(h.owner, "initial");
    const rejected = assert.rejects(promise, /canceled/);
    h.button("Cancel").fire("click");
    await rejected;
    assert.equal(h.inspection.checkpoints[0].operatorAction, "cancel");
    assert.equal(h.inspection.checkpoints[0].terminalReason, "canceled");
    await assert.rejects(h.inspection.hold(h.owner, "toc-beta"), /previously failed/);
    h.clean();
  });
  await check("the Main deadline expires at 30s and a late action cannot revive it", async () => {
    const h = harness(), promise = h.inspection.hold(h.owner, "initial");
    const rejected = assert.rejects(promise, /timeout/), oldButton = h.button("Continue");
    await h.tick(h.HOLD_MS - 1);
    assert.equal(h.inspection.active, true);
    await h.tick(1);
    await rejected;
    oldButton.fire("click");
    assert.equal(h.inspection.checkpoints[0].terminalReason, "timeout");
    assert.equal(h.inspection.checkpoints[0].operatorAction, null);
    h.clean();
  });
  await check("window close cancels into teardown rather than closing ahead of accounting", async () => {
    const h = harness(), promise = h.inspection.hold(h.owner, "initial");
    const rejected = assert.rejects(promise, /window-close/);
    let prevented = false;
    h.owner.emit("close", { preventDefault() { prevented = true; } });
    await rejected;
    assert.equal(prevented, true);
    assert.equal(h.inspection.checkpoints[0].cleanup, "removed-after-interruption");
    h.clean();
  });
  for (const event of ["closed", "destroyed", "render-process-gone"]) {
    await check("owner interruption is explicit and bounded: " + event, async () => {
      const h = harness(), promise = h.inspection.hold(h.owner, "initial");
      const rejected = assert.rejects(promise, /destroyed|renderer-gone/);
      if (event === "closed") h.owner.emit(event);
      else {
        if (event === "destroyed") h.contents.destroyed = true;
        h.contents.emit(event);
      }
      await rejected;
      h.clean(event !== "destroyed");
    });
  }
  await check("a changed reply identity is refused after the original controls were removed", async () => {
    const h = harness(undefined, { reply: reply => ({ ...reply, token: "wrong-owner" }) });
    const rejected = assert.rejects(h.inspection.hold(h.owner, "initial"), /Invalid/);
    h.button("Continue").fire("click");
    await rejected;
    h.clean();
  });
  await check("installation errors reach the caller and remove registered Main listeners", async () => {
    const h = harness(undefined, { installError: true });
    await assert.rejects(h.inspection.hold(h.owner, "initial"), /installation failure/);
    assert.match(h.inspection.checkpoints[0].holdError, /installation failure/);
    h.clean();
  });
  await check("cleanup overtaking installation permanently retires that token", async () => {
    const h = harness(undefined, { delayedInstall: true });
    const rejected = assert.rejects(h.inspection.hold(h.owner, "initial"), /window-close/);
    h.owner.emit("close", { preventDefault() {} });
    await rejected;
    h.delayed[0]();
    await flush();
    h.clean();
  });
  await check("a never-started panel cannot install after expiry", async () => {
    const h = harness(undefined, { delayedInstall: true });
    const rejected = assert.rejects(h.inspection.hold(h.owner, "initial"), /timeout/);
    await h.tick(h.HOLD_MS);
    await rejected;
    h.delayed[0]();
    await flush();
    h.clean();
  });
  for (const stalled of [false, true]) {
    await check("cleanup failure preserves the interruption: " + (stalled ? "deadline" : "exception"), async () => {
      const h = harness(undefined, stalled ? { cleanupStall: true } : { cleanupError: true });
      const rejected = assert.rejects(h.inspection.hold(h.owner, "initial"), /inspection and cleanup failed/);
      h.owner.emit("close", { preventDefault() {} });
      await flush();
      if (stalled) await h.tick(h.CLEANUP_MS);
      await rejected;
      const record = h.inspection.checkpoints[0];
      assert.match(record.holdError, /window-close/);
      assert.match(record.cleanupError, stalled ? /timed out/ : /cleanup failure/);
      assert.equal(record.cleanup, "failed");
      h.clean(false); // The existing finish path destroys the owner if page cleanup fails.
    });
  }
  await check("actual capture body keeps supplementary Alpha outside logical PASS credit", async () => {
    const h = captureHarness();
    const alpha = await h.context.capture("00-alpha-initial", false);
    assert.equal(h.assertions.length, 0);
    assert.equal(alpha.viewed, false);
    assert.equal(h.captures.length, 1);
    await h.context.capture("01-beta-recorded");
    assert.deepEqual(h.assertions, [{ name: "capture exists: 01-beta-recorded", ok: true }]);
    assert.equal(h.acquisitions(), 2);
  });
  await check("actual supplementary capture rejects empty or failed acquisition without retries", async () => {
    for (const options of [{ empty: true }, { captureError: true }]) {
      const h = captureHarness(options);
      await assert.rejects(h.context.capture("00-alpha-initial", false), /Empty inspection|acquisition failure/);
      assert.equal(h.acquisitions(), 1);
      assert.equal(h.assertions.length, 0);
      assert.equal(h.captures.length, 0);
    }
  });
  await check("branch capture awaits current TOC transitions and two frames before its one supplementary image", async () => {
    const h = branchCaptureHarness();
    h.state.animations = [{ playState: "running", pending: false }];
    const pending = h.take();
    await flush();
    assert.equal(h.acquisitions(), 0);
    assert.equal(h.frames.length, 0);
    h.state.animations = [];
    await h.poll();
    assert.equal(h.frames.length, 1);
    await h.frame();
    assert.equal(h.acquisitions(), 0);
    assert.equal(h.frames.length, 1);
    await h.frame();
    await pending;
    assert.equal(h.acquisitions(), 1);
    assert.equal(h.captures.length, 1);
    assert.equal(h.assertions.length, 0);
    assert.equal(h.captures[0].viewed, false);
    assert.equal(h.timers.size, 0);
    assert.ok(h.delays.length > 0 && h.delays.every(delay => delay === 15000));
  });
  for (const [name, change] of [
    ["initial loading overlay", h => { h.state.loading = true; }],
    ["pending render", h => { h.renderer.readingRenderCompletion = {}; }],
    ["unavailable adapter", h => { h.state.available = false; }],
    ["old Welcome DOM", h => { h.headings[0].textContent = "Welcome to Markaloo"; }],
    ["disconnected heading", h => { h.headings[0].isConnected = false; }],
    ["ambiguous heading", h => { h.headings.push({ ...h.headings[0] }); }],
    ["previous TOC highlight", h => { h.state.active = "Native history Beta"; }],
    ["previous TOC aria-current", h => { h.state.current = "Native history Beta"; }],
    ["missing TOC entry", h => { h.buttons.shift(); }],
    ["ambiguous TOC entry", h => { h.buttons.push({ ...h.buttons[0] }); }],
    ["disconnected TOC entry", h => { h.buttons[0].isConnected = false; }],
    ["closed TOC", h => { h.state.visible = false; }],
    ["running transition", h => { h.state.animations = [{ playState: "running", pending: false }]; }],
    ["pending transition", h => { h.state.animations = [{ playState: "finished", pending: true }]; }],
    ["paused transition", h => { h.state.animations = [{ playState: "paused", pending: false }]; }],
  ]) {
    await check("branch capture refuses unresolved " + name + " within the original action bound", async () => {
      const h = branchCaptureHarness();
      change(h);
      const rejected = assert.rejects(h.take(), /branch capture A timed out/);
      await flush();
      assert.equal(h.acquisitions(), 0);
      assert.equal(h.frames.length, 0);
      assert.equal(h.sleepers.length, 1);
      assert.ok(h.delays.every(delay => delay === 15000));
      await h.expire();
      await rejected;
      assert.equal(h.acquisitions(), 0);
      assert.equal(h.captures.length, 0);
    });
  }
  for (const [name, change, error] of [
    ["different file", h => { h.renderer.currentFilePath = "other.md"; }, /Source owner changed/],
    ["different source", h => { h.renderer.originalMarkdown = "other Source"; }, /Source owner changed/],
    ["different published source", h => { h.renderer.readingDisplay.source.source = "old Source"; }, /displayed Source changed/],
    ["lost owner", h => { h.state.ownerLost = true; }, /Lost the actual Main owner/],
    ["changed production port", h => { h.state.wrongPort = true; }, /production port or tab lifetime changed/],
    ["wrong saved endpoint", h => { h.state.wrongPoint = true; }, /saved Source atom\/alignment differs/],
  ]) {
    await check("branch capture rejects " + name + " without acquisition or retry", async () => {
      const h = branchCaptureHarness();
      change(h);
      await assert.rejects(h.take(), error);
      assert.equal(h.acquisitions(), 0);
      assert.equal(h.frames.length, 0);
      assert.equal(h.sleepers.length, 0);
      assert.equal(h.timers.size, 0);
    });
  }
  await check("branch capture propagates frame rejection without an image", async () => {
    const h = branchCaptureHarness({ frameError: true });
    await assert.rejects(h.take(), /controlled frame rejection/);
    assert.equal(h.acquisitions(), 0);
    assert.equal(h.timers.size, 0);
  });
  await check("branch capture bounds stalled frames without capture or a second frame attempt", async () => {
    const h = branchCaptureHarness();
    const rejected = assert.rejects(h.take(), /timed out/);
    await flush();
    assert.equal(h.frames.length, 1);
    await h.expire();
    await rejected;
    assert.equal(h.frames.length, 1);
    assert.equal(h.acquisitions(), 0);
    assert.equal(h.timers.size, 0);
    await h.frame();
    await h.frame();
    assert.equal(h.acquisitions(), 0);
    assert.equal(h.timers.size, 0);
  });
  await check("branch capture revalidates readiness after its frames instead of recapturing", async () => {
    const h = branchCaptureHarness();
    const rejected = assert.rejects(h.take(), /readiness changed before acquisition/);
    await flush();
    await h.frame();
    h.state.active = "Native history Beta";
    await h.frame();
    await rejected;
    assert.equal(h.acquisitions(), 0);
    assert.equal(h.frames.length, 0);
    assert.equal(h.timers.size, 0);
  });
  for (const [name, change, error] of [
    ["owner", h => { h.state.ownerLost = true; }, /Lost the actual Main owner/],
    ["Source", h => { h.renderer.originalMarkdown = "replaced Source"; }, /Source owner changed/],
    ["saved endpoint", h => { h.state.wrongPoint = true; }, /saved Source atom\/alignment differs/],
  ]) {
    await check("branch capture rejects a superseded " + name + " after its frames", async () => {
      const h = branchCaptureHarness();
      const rejected = assert.rejects(h.take(), error);
      await flush();
      await h.frame();
      change(h);
      await h.frame();
      await rejected;
      assert.equal(h.acquisitions(), 0);
      assert.equal(h.frames.length, 0);
      assert.equal(h.timers.size, 0);
    });
  }
  for (const name of releaseCaptureNames) {
    await check("release readiness uses the actual endpoint and two frames before " + name, async () => {
      const h = releaseCaptureHarness(name);
      const pending = h.take();
      await flush();
      assert.equal(h.acquisitions(), 0);
      assert.equal(h.frames.length, 1);
      await h.frame();
      assert.equal(h.acquisitions(), 0);
      await h.frame();
      await pending;
      assert.equal(h.acquisitions(), 1);
      assert.equal(h.captures[0].viewed, false);
      assert.equal(h.assertions.length, 1);
      assert.equal(h.assertions[0].name, "capture exists: " + name);
      assert.equal(h.timers.size, 0);
      assert.ok(h.delays.every(delay => delay === 15000));
    });
  }
  for (const [name, captureName, change, error] of [
    ["second-file owner", "release06-second-tab-gamma", h => {
      h.renderer.currentFilePath = "controlled-fixture.md";
    }, /Source owner changed/],
    ["second-file published Source", "release07-independent-tabs", h => {
      h.renderer.readingDisplay.source.source = "controlled Source";
    }, /displayed Source changed/],
    ["saved Search point", "release02-explicit-return", h => {
      h.state.wrongPoint = true;
    }, /saved Source atom\/alignment differs/],
    ["reopened lifetime", "release08-reopened-empty", h => {
      h.state.wrongPort = true;
    }, /production port or tab lifetime changed/],
    ["old renderer", "release10-renderer-lifetime-reset", h => {
      h.state.page = "old-page";
    }, /old renderer lifetime/],
    ["dirty published Source", "release07b-cancel-close-question", h => {
      h.renderer.readingDisplay.source.source = "controlled second Source";
    }, /displayed Source changed/],
    ["lost Split", "release07b-cancel-close-question", h => {
      h.renderer.isEditMode = false;
    }, /dirty Split ownership/],
    ["dirty tab", "release07b-cancel-close-question", h => { h.state.tab = 43; }, /close state changed/],
    ["dirty editor", "release07c-canceled-close-retained", h => {
      h.renderer.markdownEditor.value += " changed";
    }, /close state changed/],
    ["dirty selection", "release07c-canceled-close-retained", h => {
      h.renderer.markdownEditor.selectionStart++;
    }, /close state changed/],
    ["dirty Undo", "release07c-canceled-close-retained", h => {
      h.renderer.undoHistory.push("changed");
    }, /close state changed/],
    ["dirty Redo", "release07c-canceled-close-retained", h => {
      h.renderer.redoHistory.length = 0;
    }, /close state changed/],
    ["dirty timeline", "release07c-canceled-close-retained", h => {
      h.state.availability.forward = true;
    }, /close state changed/],
    ["modal history still enabled", "release07b-cancel-close-question", h => {
      h.state.availability.back = true;
    }, /close state changed/],
  ]) {
    await check("release readiness rejects " + name + " without capture", async () => {
      const h = releaseCaptureHarness(captureName);
      change(h);
      await assert.rejects(h.take(), error);
      assert.equal(h.acquisitions(), 0);
      assert.equal(h.frames.length, 0);
      assert.equal(h.timers.size, 0);
    });
  }
  for (const [name, captureName, change] of [
    ["Search TOC", "release01-coalesced-tail", h => { h.state.active = "other heading"; }],
    ["question not open", "release07b-cancel-close-question", h => { h.dialog.open = false; }],
    ["wrong question", "release07b-cancel-close-question", h => { h.title.textContent = "Different question"; }],
    ["missing actual Cancel", "release07b-cancel-close-question", h => { h.cancel.textContent = "Different"; }],
    ["question not dismissed", "release07c-canceled-close-retained", h => { h.dialog.open = true; }],
    ["question transition", "release07b-cancel-close-question", h => {
      h.state.dialogAnimations = [{ playState: "running" }];
    }],
    ["fresh-lifetime loading", "release08-reopened-empty", h => { h.state.loading = true; }],
  ]) {
    await check("release readiness bounds unresolved " + name, async () => {
      const h = releaseCaptureHarness(captureName);
      change(h);
      const rejected = assert.rejects(h.take(), /timed out/);
      await flush();
      assert.equal(h.frames.length, 0);
      await h.expire();
      await rejected;
      assert.equal(h.acquisitions(), 0);
    });
  }
  await check("release readiness rechecks exact dirty state after presentation frames", async () => {
    const h = releaseCaptureHarness("release07c-canceled-close-retained");
    const rejected = assert.rejects(h.take(), /close state changed/);
    await flush();
    await h.frame();
    h.state.tab = 43;
    await h.frame();
    await rejected;
    assert.equal(h.acquisitions(), 0);
  });
  await check("fresh renderer capture does not force the TOC open or invent an old saved point", async () => {
    const h = releaseCaptureHarness("release10-renderer-lifetime-reset");
    h.state.visible = false;
    const pending = h.take();
    await flush();
    await h.frame();
    await h.frame();
    await pending;
    assert.deepEqual(h.positionCalls, []);
    assert.equal(h.state.visible, false);
  });
  await check("centered Search capture checks its saved point without guessing a query-named TOC heading", async () => {
    const h = releaseCaptureHarness("release01-coalesced-tail");
    h.state.active = h.state.current = h.buttons[1].textContent;
    h.headings[0].textContent = h.buttons[1].textContent;
    const pending = h.take();
    await flush();
    await h.frame();
    await h.frame();
    await pending;
    assert.deepEqual(h.positionCalls, ["search-tail", "search-tail"]);
    assert.equal(h.acquisitions(), 1);
  });
  await check("release capture bounds stalled frames without a retry or late acquisition", async () => {
    const h = releaseCaptureHarness("release09-ten-location-cap");
    const rejected = assert.rejects(h.take(), /timed out/);
    await flush();
    assert.equal(h.frames.length, 1);
    await h.expire();
    await rejected;
    await h.frame();
    await h.frame();
    assert.equal(h.frames.length, 0);
    assert.equal(h.acquisitions(), 0);
    assert.equal(h.timers.size, 0);
  });
  await check("release capture rejects an unknown endpoint before touching the renderer", async () => {
    const h = releaseCaptureHarness("release-unknown");
    await assert.rejects(h.take(), /Unknown release capture/);
    assert.equal(h.frames.length, 0);
    assert.equal(h.acquisitions(), 0);
  });
  await check("actual checkpoint wrapper records action and Source context beside its one capture", async () => {
    const h = checkpointHarness(), action = { kind: "controlled actual action" };
    await h.context.inspectCheckpoint("toc-beta", "B", "01-beta-recorded", true, action);
    const record = h.records[0];
    assert.equal(record.action, action);
    assert.equal(record.before.position.sourceKey, "controlled-key");
    assert.deepEqual(record.after.position, record.before.position);
    assert.equal(record.capture, h.captures[0]);
    assert.equal(record.capture.viewed, false);
    assert.equal(h.acquisitions(), 1);
    assert.equal(h.assertions[0].name, "capture exists: 01-beta-recorded");
  });
  await check("the actual Gamma gate is after Search and keeps one existing capture in either mode", async () => {
    const start = nativeSource.indexOf('  if (inspection.enabled) await inspectCheckpoint("forward-gamma"');
    const end = nativeSource.indexOf('\n  await sameDocument("pending Search recovery', start);
    const debounce = nativeSource.indexOf('const late = await exec("window.__readingHistoryNative.pastDebounce()")');
    const recovery = nativeSource.indexOf('demand("actual toolbar Forward still reaches Gamma after first-debounce cancellation"');
    assert.ok(debounce >= 0 && recovery > debounce && start > recovery && end > start);
    for (const enabled of [false, true]) {
      const h = checkpointHarness();
      h.context.inspection.enabled = enabled;
      h.context.preserved = { sourceKey: "controlled-Gamma", availability: { back: true, forward: false } };
      await vm.runInContext("(async () => {" + nativeSource.slice(start, end) + "\n})()", h.context);
      assert.equal(h.acquisitions(), 1);
      assert.equal(h.captures.length, 1);
      assert.equal(h.records.length, enabled ? 1 : 0);
      assert.equal(h.captures[0].viewed, false);
      assert.deepEqual(h.assertions, [{ name: "capture exists: 05-forward-gamma-preserved", ok: true }]);
      if (enabled) {
        assert.equal(h.records[0].checkpoint, "forward-gamma");
        assert.equal(h.records[0].action.kind, "actual-document-forward-dom-click");
        assert.equal(h.records[0].action.sourcePosition, h.context.preserved);
      }
    }
  });
  for (const option of ["cancel", "changed"]) {
    await check("actual checkpoint wrapper retains its original image before failing: " + option, async () => {
      const h = checkpointHarness({ [option]: true });
      await assert.rejects(h.context.inspectCheckpoint("toc-beta", "B", "01-beta-recorded", true, {}),
        option === "cancel" ? /operator canceled/ : /changed document/);
      assert.equal(h.acquisitions(), 1);
      assert.equal(h.assertions.length, 0);
      assert.equal(h.records[0].capture, h.captures[0]);
      assert.match(h.records[0].error, option === "cancel" ? /canceled/ : /changed/);
      if (option === "changed") assert.match(h.records[0].stateError, /changed/);
    });
  }
  await check("actual checkpoint wrapper reports owner loss without a fabricated capture", async () => {
    const h = checkpointHarness({ ownerLost: true });
    await assert.rejects(h.context.inspectCheckpoint("toc-beta", "B", "01-beta-recorded", true, {}), /capture failed/);
    assert.equal(h.acquisitions(), 0);
    assert.match(h.records[0].stateError, /owner loss/);
    assert.match(h.records[0].captureError, /lost before checkpoint capture/);
  });
  assert.match(nativeSource, /inspection: \{ enabled: inspection.enabled, visualAcceptance: null,/);
  console.log(`=== reading-history-inspection-controls: ${passed}/${passed} passed ===`);
}

run().then(() => { finished = true; }).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
