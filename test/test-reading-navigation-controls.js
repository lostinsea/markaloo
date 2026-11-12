"use strict";

// Node/source routes only; this does not qualify physical mouse devices.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, "src", name), "utf8");
const renderer = read("renderer.js").replace(/\r\n/g, "\n");
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function between(source, first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, "production slice anchors resolve");
  return source.slice(start, end);
}

function key(key, overrides = {}) {
  return {
    key, code: key === "-" || key === "_" ? "Minus" : key,
    altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    isComposing: false, defaultPrevented: false,
    target: { tagName: "DIV", isContentEditable: false, closest: () => null },
    getModifierState: () => false,
    preventDefault() { this.defaultPrevented = true; },
    ...overrides,
  };
}

function shortcutFixture(platform) {
  const calls = [];
  const context = vm.createContext({
    window: { markaloo: { platform } },
    requestReadingHistoryNavigation(direction, event) {
      calls.push({ direction, event });
      return context.accepted;
    },
    accepted: true,
  });
  vm.runInContext(between(renderer, "function readingHistoryShortcutDirection(",
    "\nfunction updateReadingHistoryControls("), context);
  return {
    calls, context,
    direction: event => context.readingHistoryShortcutDirection(event),
    handle: event => context.handleReadingHistoryShortcut(event),
  };
}

test("toolbar puts named disabled reading controls before Reload", () => {
  const html = read("index.html");
  const back = html.match(/<button\b[^>]*id="readingBackBtn"[\s\S]*?<\/button>/)?.[0];
  const forward = html.match(/<button\b[^>]*id="readingForwardBtn"[\s\S]*?<\/button>/)?.[0];
  assert.ok(back && forward, "both actual buttons exist");
  for (const [button, label] of [[back, "Back"], [forward, "Forward"]]) {
    assert.match(button, /class="nav-btn\b/);
    assert.match(button, /type="button"/);
    assert.match(button, /\bdisabled\b/);
    assert.match(button, /data-i18n-title="title\.reading/);
    assert.match(button, new RegExp('aria-label="' + label + ' in this document"'));
    assert.match(button, /aria-hidden="true"/);
  }
  assert.ok(html.indexOf('id="readingBackBtn"') < html.indexOf('id="readingForwardBtn"'));
  assert.ok(html.indexOf('id="readingForwardBtn"') < html.indexOf('id="refreshBtn"'));
});

for (const [platform, back, forward] of [
  ["win32", key("ArrowLeft", { altKey: true }), key("ArrowRight", { altKey: true })],
  ["linux", key("-", { ctrlKey: true, altKey: true }),
    key("_", { ctrlKey: true, shiftKey: true })],
  ["darwin", key("-", { ctrlKey: true }), key("_", { ctrlKey: true, shiftKey: true })],
]) {
  test(platform + " routes its exact Back and Forward chords", () => {
    const f = shortcutFixture(platform);
    assert.equal(f.direction(back), -1);
    assert.equal(f.direction(forward), 1);
    assert.equal(f.handle(back), true);
    assert.equal(f.handle(forward), true);
    assert.deepEqual(f.calls.map(call => call.direction), [-1, 1]);
    assert.ok(back.defaultPrevented && forward.defaultPrevented);
  });
  test(platform + " recognizes blocked/exhausted chords without consuming browser defaults", () => {
    const f = shortcutFixture(platform);
    f.context.accepted = false;
    const event = { ...back, defaultPrevented: false };
    assert.equal(f.handle(event), true, "recognized commands must stop minus dispatch");
    assert.equal(event.defaultPrevented, false);
    assert.equal(f.calls.length, 1);
  });
}

test("plain arrows remain file history and macOS Command-minus remains zoom", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const f = shortcutFixture(platform);
    assert.equal(f.direction(key("ArrowLeft")), null);
    assert.equal(f.direction(key("ArrowRight")), null);
    assert.equal(f.direction(key("-", { metaKey: true })), null);
  }
  const source = between(renderer, "// KEYBOARD SHORTCUTS",
    "\n// Mouse wheel zoom");
  assert.ok(source.indexOf("handleReadingHistoryShortcut(e)") <
    source.indexOf("if (e.ctrlKey || e.metaKey)"));
  assert.match(source, /if \(handleReadingHistoryShortcut\(e\)\) return;/);
  assert.match(renderer, /function navigateBack\(\)/);
  assert.match(renderer, /function navigateForward\(\)/);
});

test("nearby modifier combinations are not reading history", () => {
  assert.equal(shortcutFixture("win32").direction(key("ArrowLeft",
    { altKey: true, ctrlKey: true })), null);
  assert.equal(shortcutFixture("win32").direction(key("ArrowRight",
    { altKey: true, shiftKey: true })), null);
  assert.equal(shortcutFixture("linux").direction(key("-", { ctrlKey: true })), null);
  assert.equal(shortcutFixture("linux").direction(key("_",
    { ctrlKey: true, altKey: true, shiftKey: true })), null);
  assert.equal(shortcutFixture("darwin").direction(key("-",
    { ctrlKey: true, metaKey: true })), null);
  assert.equal(shortcutFixture("darwin").direction(key("-",
    { ctrlKey: true, altKey: true })), null);
  assert.equal(shortcutFixture("unknown").direction(key("-", { ctrlKey: true })), null);
});

function mainFixture(platform) {
  const win = new EventEmitter();
  const contents = new EventEmitter();
  const sends = [];
  win.isDestroyed = () => false;
  contents.isDestroyed = () => false;
  contents.send = (...args) => sends.push(args);
  win.webContents = contents;
  const context = vm.createContext({ process: { platform }, mainWindow: win, console });
  vm.runInContext(between(read("main.js"), "function attachReadingHistoryCommands(",
    "\nfunction createWindow("), context);
  context.attachReadingHistoryCommands(win);
  return { win, contents, sends, context };
}

for (const platform of ["win32", "linux"]) {
  test(platform + " Main maps only standard browser app commands", () => {
    const f = mainFixture(platform);
    f.win.emit("app-command", {}, "browser-backward");
    f.win.emit("app-command", {}, "browser-forward");
    f.win.emit("app-command", {}, "browser-refresh");
    f.win.emit("app-command", {}, "back");
    assert.deepEqual(f.sends, [
      ["reading-history-command", -1], ["reading-history-command", 1],
    ]);
  });
  test(platform + " Main drops stale owners and removes its window listener", () => {
    const f = mainFixture(platform);
    f.context.mainWindow = {};
    f.win.emit("app-command", {}, "browser-backward");
    assert.equal(f.sends.length, 0);
    f.context.mainWindow = f.win;
    f.contents.isDestroyed = () => true;
    f.win.emit("app-command", {}, "browser-forward");
    assert.equal(f.sends.length, 0);
    f.win.emit("closed");
    assert.equal(f.win.listenerCount("app-command"), 0);
  });
}

test("macOS does not register a mouse-command promise", () => {
  const f = mainFixture("darwin");
  assert.equal(f.win.listenerCount("app-command"), 0);
  assert.match(read("main.js"), /attachReadingHistoryCommands\(mainWindow\);/);
});

function preloadFixture() {
  const ipcRenderer = new EventEmitter();
  const page = new EventEmitter();
  const context = vm.createContext({
    ipcRenderer, process: { isMainFrame: true }, console,
    window: {
      addEventListener: (name, callback) => page.on(name, callback),
      removeEventListener: (name, callback) => page.removeListener(name, callback),
    },
  });
  vm.runInContext(between(read("main-preload.js"),
    "function subscribeReadingHistoryCommand(", "\nconst dialogThemeIds"), context);
  return { ipcRenderer, page, context };
}

test("isolated preload accepts only the two reading commands and never exposes the IPC event", () => {
  const f = preloadFixture();
  const calls = [];
  f.context.subscribeReadingHistoryCommand((...args) => calls.push(args));
  const event = { sender: "private Main event" };
  for (const value of [-1, null, {}, [1], "browser-backward", "1", 0, 1]) {
    f.ipcRenderer.emit("reading-history-command", event, value);
  }
  assert.deepEqual(calls, [[-1], [1]]);
  assert.equal(f.ipcRenderer.listenerCount("reading-history-command"), 1);
});

test("preload unsubscribe and pagehide retire only their owned subscriptions", () => {
  const f = preloadFixture();
  const calls = [];
  const first = f.context.subscribeReadingHistoryCommand(value => calls.push("first:" + value));
  f.context.subscribeReadingHistoryCommand(value => calls.push("second:" + value));
  first();
  first();
  f.ipcRenderer.emit("reading-history-command", {}, -1);
  assert.deepEqual(calls, ["second:-1"]);
  assert.equal(f.ipcRenderer.listenerCount("reading-history-command"), 1);
  f.page.emit("pagehide");
  assert.equal(f.ipcRenderer.listenerCount("reading-history-command"), 0);
  f.ipcRenderer.emit("reading-history-command", {}, 1);
  assert.deepEqual(calls, ["second:-1"]);
});

test("preload refuses invalid callbacks and subframe subscriptions", () => {
  const f = preloadFixture();
  assert.throws(() => f.context.subscribeReadingHistoryCommand(null), /callback/i);
  f.context.process.isMainFrame = false;
  assert.throws(() => f.context.subscribeReadingHistoryCommand(() => {}), /main frame/i);
  assert.equal(f.ipcRenderer.listenerCount("reading-history-command"), 0);
});

test("the public bridge exposes a fixed platform and a named read-only subscription", () => {
  const source = read("main-preload.js");
  assert.match(source, /platform:\s*process\.platform/);
  assert.match(source, /onReadingHistoryCommand\(callback\)\s*\{\s*return subscribeReadingHistoryCommand\(callback\);/);
  assert.doesNotMatch(source, /sendReadingHistoryCommand|invokeReadingHistoryCommand/);
});

class Target {
  constructor(tagName = "DIV") {
    this.nodeType = 1;
    this.tagName = tagName;
    this.isContentEditable = false;
    this.disabled = true;
    this.listeners = new Map();
    this.attributes = new Map();
  }
  addEventListener(type, callback, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Map());
    this.listeners.get(type).set(callback, options);
  }
  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }
  emit(type, overrides = {}) {
    const event = { type, target: this, ...overrides };
    for (const [callback, options] of [...(this.listeners.get(type) || [])]) {
      if (options?.once) this.removeEventListener(type, callback);
      callback(event);
    }
    return event;
  }
  closest() {
    return ["INPUT", "TEXTAREA", "SELECT"].includes(this.tagName) ||
      this.attributes.get("role") === "textbox" ? this : this.parentElement?.closest() || null;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
}

function consumerFixture(platform = "linux") {
  const window = new Target();
  const document = new Target();
  const back = new Target("BUTTON");
  const forward = new Target("BUTTON");
  const body = new Target("BODY");
  const subscribers = new Set();
  const commands = new Set();
  const mainDialogs = new Set();
  const pending = [];
  const calls = [];
  const errors = [];
  const observers = [];
  const state = {
    tab: { id: 1, back: true, forward: false },
    modal: false, frozen: false, editorComposing: false,
  };
  document.body = body;
  document.activeElement = body;
  document.getElementById = id => ({ readingBackBtn: back, readingForwardBtn: forward })[id];
  document.querySelector = () => state.modal ? {} : null;
  document.querySelectorAll = () => [];
  const core = {
    availability: () => ({ back: state.tab.back, forward: state.tab.forward }),
    navigate(direction) {
      calls.push({ direction, tab: state.tab });
      state.tab.back = false;
      state.tab.forward = false;
      return new Promise(resolve => pending.push(resolve));
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  };
  window.readingHistoryControls = core;
  window.markaloo = {
    platform,
    onReadingHistoryCommand(callback) {
      commands.add(callback);
      return () => commands.delete(callback);
    },
    onMainDialogVisibility(callback) {
      mainDialogs.add(callback);
      callback(false);
      return () => mainDialogs.delete(callback);
    },
  };
  const context = vm.createContext({
    window, document,
    console: { error: (...args) => errors.push(args) },
    zoomLevel: 100, ZOOM_CONFIG: { level: 100, min: 50, max: 400, step: 10 },
    zoomWrites: 0,
    updateZoom() { context.zoomWrites++; },
    toggleSearchPanel() {},
    i18n: label => label === "title.readingBack" ? "Back in this document" : "Forward in this document",
    editorHistoryComposing: () => state.editorComposing,
    frozenForShutdown: () => state.frozen,
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        observers.push(this);
      }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
  });
  vm.runInContext(between(renderer, "let readingHistoryControlState = null;",
    "// ============================================\n// KEYBOARD SHORTCUTS").replace(/\r\n/g, "\n"), context);
  context.installReadingHistoryControls();
  vm.runInContext(between(renderer, "// KEYBOARD SHORTCUTS", "\n// Mouse wheel zoom"), context);
  return {
    state, window, document, back, forward, context, pending, calls, errors, observers,
    subscribers, commands, mainDialogs,
    notify: value => { for (const callback of subscribers) callback(value); },
    command: direction => { for (const callback of commands) callback(direction); },
    mainDialog: visible => { for (const callback of mainDialogs) callback(visible); },
  };
}

function mousePhase(f, type, button, overrides = {}) {
  const down = type.endsWith("down");
  const event = f.window.emit(type, {
    target: f.document.body, button, buttons: down ? ({ 0: 1, 1: 4, 2: 2, 3: 8, 4: 16 }[button] || 0) : 0,
    isTrusted: true, cancelable: true, defaultPrevented: false, propagationStopped: false,
    isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    pointerType: type.startsWith("pointer") ? "mouse" : undefined,
    getModifierState: () => false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...overrides,
  });
  return f.document.emit(type, event);
}

function mouseGesture(f, button) {
  const events = [];
  const callsAfterPhase = [];
  const target = f.document.body;
  target.disabled = false;
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    const down = type.endsWith("down");
    f.document.activeElement = down ? (button === 3 ? f.back : f.forward) : target;
    events.push(mousePhase(f, type, button));
    callsAfterPhase.push(f.calls.length);
  }
  return { events, callsAfterPhase };
}

for (const [button, direction, label] of [[3, -1, "Back"], [4, 1, "Forward"]]) {
  test("trusted DOM mouse " + label + " reaches guarded history without native IPC", () => {
    const f = consumerFixture("win32");
    f.state.tab.back = direction === -1;
    f.state.tab.forward = direction === 1;
    f.notify();
    assert.equal(f.context.readingHistoryControlsBlocked(), false,
      "the controlled reader has no modal, composition or shutdown blocker");
    assert.equal(f.window.readingHistoryControls.availability()[
      direction === -1 ? "back" : "forward"], true,
      "the requested direction is genuinely available");
    assert.equal((direction === -1 ? f.back : f.forward).disabled, false);
    assert.equal(f.commands.size, 0, "Windows must not install a second native history receiver");
    assert.equal(f.calls.length, 0, "fixture setup has not navigated");

    const gesture = mouseGesture(f, button);
    assert.deepEqual(gesture.events.map(event => event.type),
      ["pointerdown", "mousedown", "pointerup", "mouseup"]);
    assert.ok(gesture.events.every(event => event.isTrusted && event.button === button &&
      !event.target.isContentEditable && event.target.closest() === null),
      "the complete controlled side-button sequence reaches a noneditable reader target");
    assert.deepEqual(gesture.callsAfterPhase, [0, 1, 1, 1],
      "only the trusted mousedown must request history; pointer and release phases must not");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].direction, direction);
    assert.equal(f.calls[0].tab, f.state.tab);
    assert.equal(f.pending.length, 1);
    assert.equal(f.errors.length, 0);
    assert.deepEqual(gesture.events.map(event => event.defaultPrevented), [false, true, false, true]);
    assert.ok(gesture.events.every(event => !event.propagationStopped));
  });
}

test("Windows DOM ownership ignores native commands before during and after a mouse gesture", async () => {
  const f = consumerFixture("win32");
  assert.equal(f.commands.size, 0);
  f.command(-1);
  assert.equal(f.calls.length, 0, "native-before-down has no reading consumer");
  mousePhase(f, "mousedown", 3);
  assert.equal(f.calls.length, 1);
  f.command(-1);
  assert.equal(f.calls.length, 1, "native-during-down cannot add a traversal");
  f.pending.shift()(true);
  await Promise.resolve();
  await Promise.resolve();
  f.state.tab.back = true;
  f.state.tab.forward = true;
  f.notify();
  mousePhase(f, "mouseup", 3);
  f.command(1);
  assert.equal(f.calls.length, 1, "native-after-up stays ignored even with fresh availability");
});

for (const platform of ["linux", "darwin"]) {
  test(platform + " keeps native reading commands without adding a DOM mouse ingress", () => {
    const f = consumerFixture(platform);
    assert.equal(f.commands.size, 1);
    for (const button of [3, 4]) {
      const gesture = mouseGesture(f, button);
      assert.deepEqual(gesture.callsAfterPhase, [0, 0, 0, 0]);
      assert.ok(gesture.events.every(event => !event.defaultPrevented));
    }
    f.command(-1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].direction, -1);
    f.state.tab.forward = true;
    f.command(1);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].direction, 1);
    assert.equal(f.document.listeners.get("mousedown")?.size || 0, 0);
    assert.equal(f.document.listeners.get("mouseup")?.size || 0, 0);
  });
}

test("reading controls reject an unavailable or unsupported authoritative platform", () => {
  for (const platform of [null, "", "unknown", 1]) {
    assert.throws(() => consumerFixture(platform), /platform.*unavailable or unsupported/);
  }
});

test("Windows mouse ownership preserves toolbar and Alt-arrow reading commands", () => {
  for (const [direction, button, arrow] of [[-1, "back", "ArrowLeft"], [1, "forward", "ArrowRight"]]) {
    for (const route of ["toolbar", "shortcut"]) {
      const f = consumerFixture("win32");
      f.state.tab.back = direction === -1;
      f.state.tab.forward = direction === 1;
      f.notify();
      if (route === "toolbar") f[button].emit("click");
      else assert.equal(f.document.emit("keydown", key(arrow, { altKey: true })).defaultPrevented, true);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].direction, direction);
      assert.equal(f.commands.size, 0);
    }
  }
});

test("Windows side-button adapter leaves synthetic and ordinary mouse events unchanged", () => {
  for (const [button, isTrusted] of [
    [0, true], [1, true], [2, true], [5, true], ["3", true], [3, false], [4, false],
  ]) {
    const f = consumerFixture("win32");
    f.state.tab.forward = true;
    for (const type of ["mousedown", "mouseup"]) {
      const event = mousePhase(f, type, button, { isTrusted });
      assert.equal(event.defaultPrevented, false);
      assert.equal(event.propagationStopped, false);
      assert.equal(f.calls.length, 0);
    }
  }
  const f = consumerFixture("win32");
  f.state.tab.forward = true;
  for (const type of ["pointerdown", "pointerup", "auxclick", "click", "contextmenu"]) {
    for (const button of [3, 4]) {
      assert.equal(mousePhase(f, type, button).defaultPrevented, false);
      assert.equal(f.calls.length, 0);
    }
  }
});

test("Windows side-button phases cancel browser defaults even when navigation is blocked", () => {
  const guards = [
    ["modal", f => { f.state.modal = true; }],
    ["native dialog", f => { f.mainDialog(true); }],
    ["composition", f => { f.document.emit("compositionstart"); }],
    ["editor composition", f => { f.state.editorComposing = true; }],
    ["shutdown", f => { f.state.frozen = true; }],
    ["exhausted", f => { f.state.tab.back = f.state.tab.forward = false; }],
    ["handled", () => ({ defaultPrevented: true })],
    ["composing event", () => ({ isComposing: true })],
    ["IME event", () => ({ keyCode: 229 })],
    ["AltGraph", () => ({ getModifierState: name => name === "AltGraph" })],
  ];
  for (const [name, guard] of guards) {
    for (const button of [3, 4]) {
      const f = consumerFixture("win32");
      f.state.tab.forward = true;
      const overrides = guard(f) || {};
      for (const type of ["mousedown", "mouseup"]) {
        const event = mousePhase(f, type, button, overrides);
        assert.equal(event.defaultPrevented, true, name + " " + type);
        assert.equal(event.propagationStopped, false, name + " preserves propagation");
        assert.equal(f.calls.length, 0, name + " does not dispatch");
      }
    }
  }
});

test("Windows mouse respects both editable targets and independently focused editors", () => {
  const editables = [
    () => new Target("INPUT"), () => new Target("TEXTAREA"), () => new Target("SELECT"),
    () => Object.assign(new Target(), { isContentEditable: true }),
    () => { const node = new Target(); node.setAttribute("role", "textbox"); return node; },
    () => {
      const parent = new Target();
      parent.setAttribute("role", "textbox");
      return Object.assign(new Target("SPAN"), { parentElement: parent });
    },
  ];
  for (const makeEditable of editables) {
    for (const site of ["target", "focus"]) {
      const f = consumerFixture("win32");
      const editable = makeEditable();
      if (site === "focus") f.document.activeElement = editable;
      for (const type of ["mousedown", "mouseup"]) {
        const event = mousePhase(f, type, 3, site === "target" ? { target: editable } : {});
        assert.equal(f.calls.length, 0, site + " editability blocks the mouse route");
        assert.equal(event.defaultPrevented, true, site + " still owns browser history");
      }
    }
  }
  const f = consumerFixture("win32");
  const text = { nodeType: 3, parentElement: new Target("TEXTAREA") };
  assert.equal(mousePhase(f, "mousedown", 3, { target: text }).defaultPrevented, true);
  assert.equal(f.calls.length, 0, "a text-node target retains its editable parent's guard");
});

test("Windows release never retries after completion and an unmatched release only cancels default", async () => {
  const f = consumerFixture("win32");
  assert.equal(mousePhase(f, "mouseup", 3).defaultPrevented, true);
  assert.equal(f.calls.length, 0, "release without down cannot navigate");
  assert.equal(mousePhase(f, "mousedown", 3).defaultPrevented, true);
  assert.equal(f.calls.length, 1);
  f.pending.shift()(true);
  await Promise.resolve();
  await Promise.resolve();
  f.state.tab.back = true;
  f.notify();
  assert.equal(mousePhase(f, "mouseup", 3).defaultPrevented, true);
  assert.equal(f.calls.length, 1, "fresh availability after completion is not a release-time retry");
});

test("Windows mouse has no held-button latch after a release is missed", async () => {
  const f = consumerFixture("win32");
  mousePhase(f, "mousedown", 3);
  assert.equal(f.calls.length, 1);
  f.pending.shift()(true);
  await Promise.resolve();
  await Promise.resolve();
  f.state.tab.back = true;
  f.notify();
  mousePhase(f, "mousedown", 3);
  assert.equal(f.calls.length, 2, "a later genuine press does not need an earlier mouseup or blur");
});

test("Windows mouse listeners are nonpassive once-only and removed with their page owner", async () => {
  const f = consumerFixture("win32");
  for (const type of ["mousedown", "mouseup"]) {
    assert.equal(f.document.listeners.get(type).size, 1);
    assert.equal([...f.document.listeners.get(type).values()][0].passive, false);
  }
  assert.throws(() => f.context.installReadingHistoryControls(), /already installed/);
  assert.equal(f.document.listeners.get("mousedown").size, 1);
  mousePhase(f, "mousedown", 3);
  assert.equal(f.pending.length, 1);
  f.window.emit("pagehide");
  for (const type of ["mousedown", "mouseup"]) assert.equal(f.document.listeners.get(type).size, 0);
  assert.equal(f.subscribers.size, 0);
  assert.equal(f.mainDialogs.size, 0);
  assert.ok(f.observers.every(observer => observer.disconnected));
  f.state.tab.back = true;
  f.pending.shift()(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.back.disabled, true, "late completion cannot repaint a dead mouse owner");
  for (const type of ["mousedown", "mouseup"]) {
    assert.equal(mousePhase(f, type, 3).defaultPrevented, false);
  }
  assert.equal(f.calls.length, 1);
});

test("Windows mouse reports traversal failures and still owns both browser defaults", async () => {
  for (const failure of ["async", "sync"]) {
    const f = consumerFixture("win32");
    let attempts = 0;
    f.window.readingHistoryControls.navigate = () => {
      attempts++;
      if (failure === "sync") throw new Error("mouse dispatch failed");
      return Promise.reject(new Error("mouse restore failed"));
    };
    assert.equal(mousePhase(f, "mousedown", 3).defaultPrevented, true);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.errors.length, 1);
    assert.equal(mousePhase(f, "mouseup", 3).defaultPrevented, true);
    assert.equal(attempts, 1, "failure cannot turn release into a second request");
  }
});

test("toolbar, shortcuts and native commands dispatch the same guarded core traversal", () => {
  for (const route of ["toolbar", "shortcut", "native"]) {
    const f = consumerFixture();
    assert.equal(f.back.disabled, false);
    assert.equal(f.forward.disabled, true);
    if (route === "toolbar") f.back.emit("click");
    else if (route === "shortcut") f.context.handleReadingHistoryShortcut(
      key("-", { ctrlKey: true, altKey: true }));
    else f.command(-1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].direction, -1);
    assert.equal(f.calls[0].tab, f.state.tab);
    assert.equal(f.back.disabled, true, "current pending availability is painted synchronously");
  }
});

test("current-tab availability wins over old notifications and old async completions", async () => {
  const f = consumerFixture();
  f.command(-1);
  assert.equal(f.calls.length, 1, "an old-tab traversal is genuinely pending");
  const second = { id: 2, back: false, forward: true };
  f.state.tab = second;
  f.notify({ back: true, forward: false });
  assert.equal(f.back.disabled, true);
  assert.equal(f.forward.disabled, false);
  f.pending.shift()(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.back.disabled, true);
  assert.equal(f.forward.disabled, false);
  f.command(-1);
  assert.equal(f.calls.length, 1, "exhausted current tab cannot borrow old availability");
  f.command(1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].tab, second);
});

test("all routes refuse modal, editable, composition, frozen and exhausted navigation", () => {
  const guards = [
    f => { f.state.modal = true; },
    f => { f.mainDialog(true); },
    f => { f.document.activeElement = new Target("INPUT"); },
    f => { f.document.activeElement.isContentEditable = true; },
    f => { f.document.emit("compositionstart"); },
    f => { f.state.editorComposing = true; },
    f => { f.state.frozen = true; },
    f => { f.state.tab.back = false; },
  ];
  for (const guard of guards) {
    const f = consumerFixture();
    guard(f);
    f.command(-1);
    f.context.requestReadingHistoryNavigation(-1, key("-", {
      ctrlKey: true, altKey: true, target: f.document.activeElement,
    }));
    assert.equal(f.calls.length, 0);
  }
});

test("composition, AltGraph and already-handled chords never fall through to zoom", () => {
  const cases = [
    { isComposing: true }, { keyCode: 229 },
    { getModifierState: name => name === "AltGraph" }, { defaultPrevented: true },
  ];
  for (const overrides of cases) {
    const f = consumerFixture();
    const event = key("-", { ctrlKey: true, altKey: true, ...overrides });
    const originalDefault = event.defaultPrevented;
    const delivered = f.document.emit("keydown", event);
    assert.equal(delivered.defaultPrevented, originalDefault);
    assert.equal(f.calls.length, 0);
    assert.equal(f.context.zoomWrites, 0);
  }
});

test("the actual broad keyboard route preserves nonconflicting zoom but never zooms an exhausted history chord", () => {
  for (const [platform, history, zoom] of [
    ["linux", key("-", { ctrlKey: true, altKey: true }), key("-", { ctrlKey: true })],
    ["darwin", key("-", { ctrlKey: true }), key("-", { metaKey: true })],
    ["win32", key("ArrowLeft", { altKey: true }), key("-", { ctrlKey: true })],
  ]) {
    const f = consumerFixture(platform);
    f.state.tab.back = false;
    f.document.emit("keydown", history);
    assert.equal(f.calls.length, 0);
    assert.equal(f.context.zoomLevel, 100);
    assert.equal(f.context.zoomWrites, 0);
    f.document.emit("keydown", zoom);
    assert.equal(f.context.zoomLevel, 90);
    assert.equal(f.context.zoomWrites, 1);
  }
});

test("unexpected traversal failures are reported without inventing success", async () => {
  const f = consumerFixture();
  f.window.readingHistoryControls.navigate = () => Promise.reject(new Error("restore failed"));
  assert.equal(f.context.requestReadingHistoryNavigation(-1), true,
    "an eligible async request is consumed before completion");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0][0], /navigation failed/);
  f.window.readingHistoryControls.navigate = () => { throw new Error("dispatch failed"); };
  assert.equal(f.context.requestReadingHistoryNavigation(-1), false);
  assert.equal(f.errors.length, 2);
  assert.match(f.errors[1][0], /dispatch failed/);
});

test("pagehide removes owned consumers and old completions cannot repaint a dead page", async () => {
  const f = consumerFixture();
  f.command(-1);
  assert.equal(f.pending.length, 1);
  f.window.emit("pagehide");
  assert.equal(f.subscribers.size, 0);
  assert.equal(f.commands.size, 0);
  assert.equal(f.mainDialogs.size, 0);
  assert.ok(f.observers.every(observer => observer.disconnected));
  assert.equal(f.back.listeners.get("click").size, 0);
  f.state.tab.back = true;
  f.pending.shift()(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.back.disabled, true);
  f.context.requestReadingHistoryNavigation(-1);
  assert.equal(f.calls.length, 1);
});

test("invalid directions fail loudly rather than inventing a traversal", () => {
  const f = consumerFixture();
  for (const direction of [0, "back", "-1", null, NaN, 2]) {
    assert.throws(() => f.context.requestReadingHistoryNavigation(direction), /direction/);
  }
  assert.equal(f.calls.length, 0);
});

const nativeHistorySource = fs.readFileSync(path.join(__dirname, "test-reading-history-native.js"), "utf8")
  .replace(/\r\n/g, "\n");
function nativeKeyFixture() {
  const listeners = new Map(), calls = [];
  const reader = { id: "", tagName: "BODY", closest: () => null };
  const input = { id: "searchInput", tagName: "INPUT", value: "", closest() { return this; } };
  const state = { document: { source: "exact source", selection: [1, 2, "forward"], dirty: false },
    undo: ["previous source"], redo: ["next source"], top: 100, left: 0,
    availability: { back: true, forward: true }, result: Promise.resolve(true) };
  const original = { availability: () => state.availability, subscribe() {},
    navigate(direction) { calls.push(direction); return state.result; } };
  const control = { core: original }, document = { activeElement: reader };
  const window = {
    __readingHistoryNative: { documentState: () => state.document },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) { assert.equal(listeners.get(type), callback); listeners.delete(type); },
  };
  const context = vm.createContext({ window, document, readingHistoryControlState: control,
    structuredClone, undoHistory: state.undo, redoHistory: state.redo, zoomLevel: 100,
    getViewerScroller: () => ({ scrollTop: state.top, scrollLeft: state.left }),
    viewer: {}, getComputedStyle: () => ({ zoom: "1" }), searchInput: input,
    searchMatches: [], pendingSearchTerm: null, pendingSearchRequest: null, searchDebounceTimer: null });
  vm.runInContext(between(nativeHistorySource, "function installHistoryKeyProbe(",
    "\nasync function sendWindowsHistoryKey("), context);
  context.installHistoryKeyProbe();
  const api = window.__readingHistoryKeys;
  const emit = (type, overrides = {}) => listeners.get(type)({
    type, key: "ArrowLeft", isTrusted: true, altKey: true, ctrlKey: false,
    metaKey: false, shiftKey: false, repeat: false, isComposing: false,
    getModifierState: () => false, target: document.activeElement, ...overrides,
  });
  return { api, context, state, document, reader, input, control, original, calls, emit,
    pair(overrides) { emit("keydown", overrides); emit("keyup", overrides); },
    clean() {
      const result = api.dispose();
      assert.equal(control.core, original);
      assert.equal(listeners.size, 0);
      assert.equal(window.__readingHistoryKeys, undefined);
      return result;
    } };
}

test("the native Windows selector is exact, unique, platform-scoped and default off", () => {
  const context = vm.createContext({});
  vm.runInContext(between(nativeHistorySource, "function windowsHistoryKeysEnabled(",
    "\nlet inspection, windowsHistoryKeys;"), context);
  const selected = context.windowsHistoryKeysEnabled;
  assert.equal(selected([], "win32"), false);
  assert.equal(selected([], "darwin"), false);
  assert.equal(selected(["entry", "--windows-history-keys"], "win32"), true);
  for (const [args, platform] of [
    [["--windows-history-keys=false"], "win32"], [["--windows-history-other"], "win32"],
    [["--windows-history-keys", "--windows-history-keys"], "win32"],
    [["--windows-history-keys"], "linux"], [["--windows-history-keys"], "darwin"],
  ]) assert.throws(() => selected(args, platform), /require exactly/);
  const branch = "  if (windowsHistoryKeys) return runWindowsHistoryKeys();";
  assert.ok(nativeHistorySource.indexOf(branch) > nativeHistorySource.indexOf('save(\'A\')'));
  for (const enabled of [false, true]) {
    let runs = 0;
    const routing = vm.createContext({ windowsHistoryKeys: enabled, runWindowsHistoryKeys() { runs++; } });
    vm.runInContext("(function () {" + branch + "\nreturn 'ordinary';})()", routing);
    assert.equal(runs, enabled ? 1 : 0);
  }
});

test("the native key observer awaits the identical real traversal promise and removes its listeners", async () => {
  const f = nativeKeyFixture();
  let release;
  f.state.result = new Promise(resolve => { release = resolve; });
  const armed = f.api.arm(-1, 1, "reader");
  f.emit("keydown");
  assert.equal(f.control.core.navigate(-1), f.state.result);
  f.emit("keyup");
  let finished = false;
  const result = f.api.finish(armed.index).then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false);
  release(true);
  assert.equal((await result).finished, true);
  assert.deepEqual(f.calls, [-1]);
  assert.equal(f.clean().finished, 1);
});

for (const target of ["reader", "search"]) {
  test("the native key observer accounts zero traversals for an owned " + target + " target", async () => {
    const f = nativeKeyFixture();
    if (target === "search") f.document.activeElement = f.input;
    const armed = f.api.arm(-1, 0, target);
    f.pair();
    const result = await f.api.finish(armed.index);
    assert.equal(result.directions.length, 0);
    assert.equal(result.events.length, 2);
    assert.deepEqual(f.calls, []);
    f.clean();
  });
}

for (const [name, overrides] of [
  ["untrusted", { isTrusted: false }], ["wrong target", { target: {} }],
  ["wrong arrow", { key: "ArrowRight" }], ["missing Alt", { altKey: false }],
  ["extra modifier", { ctrlKey: true }], ["repeat", { repeat: true }],
  ["composition", { isComposing: true }], ["AltGraph", { getModifierState: () => true }],
]) {
  test("the native key observer refuses " + name + " delivery", async () => {
    const f = nativeKeyFixture(), armed = f.api.arm(-1, 0, "reader");
    f.pair(overrides);
    await assert.rejects(f.api.finish(armed.index), /key delivery/);
    assert.equal(f.clean().finished, 0);
  });
}

test("the native key observer refuses duplicates, stale replies and overlapping attempts", async () => {
  const f = nativeKeyFixture(), armed = f.api.arm(-1, 0, "reader");
  assert.throws(() => f.api.arm(-1, 0, "reader"), /attempt/);
  await assert.rejects(f.api.finish(armed.index + 1), /another attempt/);
  f.emit("keydown"); f.pair();
  await assert.rejects(f.api.finish(armed.index), /duplicate/);
  f.clean();
});

for (const [expected, actual] of [[0, -1], [1, null], [1, 1]]) {
  test("the native key observer refuses traversal accounting " + expected + "/" + actual, async () => {
    const f = nativeKeyFixture(), armed = f.api.arm(-1, expected, "reader");
    f.emit("keydown");
    if (actual !== null) f.control.core.navigate(actual);
    f.emit("keyup");
    await assert.rejects(f.api.finish(armed.index), /number or direction/);
    f.clean();
  });
}

test("the native key observer refuses failed real completions", async () => {
  const f = nativeKeyFixture(), armed = f.api.arm(-1, 1, "reader");
  f.state.result = Promise.resolve(false);
  f.emit("keydown"); f.control.core.navigate(-1); f.emit("keyup");
  await assert.rejects(f.api.finish(armed.index), /traversal failed/);
  f.clean();
});

for (const change of ["viewport", "availability", "undo value", "Search", "zoom"]) {
  test("the native key observer refuses hidden " + change + " mutation", async () => {
    const f = nativeKeyFixture(), armed = f.api.arm(-1, 0, "reader");
    f.pair();
    if (change === "viewport") f.state.top++;
    if (change === "availability") f.state.availability = { back: false, forward: true };
    if (change === "undo value") f.state.undo[0] = "same-length replacement";
    if (change === "Search") f.context.pendingSearchTerm = "unexpected";
    if (change === "zoom") f.context.zoomLevel = 110;
    await assert.rejects(f.api.finish(armed.index), /changed/);
    f.clean();
  });
}

test("missing keyup is bounded by the existing Main deadline, not a successful silent attempt", async () => {
  const f = nativeKeyFixture(), armed = f.api.arm(-1, 0, "reader");
  f.emit("keydown");
  let expire, delay;
  f.context.setTimeout = (callback, milliseconds) => { expire = callback; delay = milliseconds; return 1; };
  f.context.clearTimeout = () => {};
  vm.runInContext(between(nativeHistorySource, "async function bounded(",
    "\nfunction exec("), f.context);
  const result = f.context.bounded(() => f.api.finish(armed.index), "renderer action");
  assert.equal(delay, 15000);
  expire();
  await assert.rejects(result, /timed out/);
  assert.equal(f.clean().finished, 0);
});

test("the opt-in native keyboard scenario retains ten exact chords and four existing holds", () => {
  const body = between(nativeHistorySource, "async function runWindowsHistoryKeys(",
    "\nasync function finish(");
  assert.equal([...body.matchAll(/await sendWindowsHistoryKey\(/g)].length, 10);
  assert.deepEqual([...body.matchAll(/inspectCheckpoint\("([^"]+)"/g)].map(match => match[1]),
    ["initial", "toc-beta", "back-alpha", "forward-gamma"]);
  const delivery = between(nativeHistorySource, "async function sendWindowsHistoryKey(",
    "\nasync function runWindowsHistoryKeys(");
  assert.match(delivery, /sendInputEvent\(\{ type: "keyDown", keyCode, modifiers: \["alt"\] \}\)/);
  assert.match(delivery, /sendInputEvent\(\{ type: "keyUp", keyCode, modifiers: \["alt"\] \}\)/);
  assert.doesNotMatch(delivery, /dispatchEvent|\.click\(|sleep\(/);
  assert.match(body, /__readingHistoryKeys\.dispose/);
});

test("the actual keyboard-case itinerary emits its separate eighteen scenario assertions in either inspection mode", async () => {
  const body = between(nativeHistorySource, "async function runWindowsHistoryKeys(",
    "\nasync function finish(");
  for (const enabled of [false, true]) {
    const assertions = [], checkpoints = [], chords = [], images = [];
    const document = { edit: false, dirty: false, source: "exact source" };
    const context = vm.createContext({
      process: { platform: "win32" }, observedContents: { getZoomFactor: () => 1, sendInputEvent() {} },
      inspection: { enabled }, observedMain: {}, sentinel: {},
      installHistoryKeyProbe: function installHistoryKeyProbe() {},
      isDeepStrictEqual: require("util").isDeepStrictEqual,
      exec: async code => {
        if (code.startsWith("(function installHistoryKeyProbe")) return {
          document: { ...document }, viewport: { zoom: 100, cssZoom: "1" },
          availability: { back: false, forward: false },
        };
        if (code === "window.__readingHistoryKeys.state()") return { document: { ...document } };
        if (code === "window.__readingHistoryKeys.dispose()") return { attempts: 10, finished: 10, unarmedCalls: 0 };
        return true;
      },
      waitReady: async () => {},
      demand(name, condition) { assert.ok(condition, name); assertions.push(name); },
      async capture(name) { images.push(name); context.demand("capture exists: " + name, true); },
      async inspectCheckpoint(stage, _point, name, logical) {
        checkpoints.push(stage);
        if (logical) await context.capture(name);
        else images.push(name);
      },
      async sendWindowsHistoryKey(...args) { chords.push(args); context.demand(args[0], true); },
      proveSentinelAlive: async () => ({ console: true, dom: true }),
    });
    vm.runInContext(body, context);
    await context.runWindowsHistoryKeys();
    assert.equal(assertions.length, 18);
    assert.deepEqual(chords.map(([, direction, expected, point, target]) => [direction, expected, point, target]), [
      [-1, 0, "A", "reader"], [1, 0, "A", "reader"], [-1, 1, "B", "reader"],
      [-1, 0, "B", "search"], [1, 0, "B", "search"], [-1, 1, "A", "reader"],
      [-1, 0, "A", "reader"], [1, 1, "B", "reader"], [1, 1, "C", "reader"], [1, 0, "C", "reader"],
    ]);
    assert.deepEqual(checkpoints, enabled ? ["initial", "toc-beta", "back-alpha", "forward-gamma"] : []);
    assert.deepEqual(images, enabled ? ["keys00-alpha-initial", "keys01-beta-recorded",
      "keys02-alpha-back", "keys03-gamma-forward"] : ["keys01-beta-recorded", "keys02-alpha-back", "keys03-gamma-forward"]);
  }
});

test("the no-op selector is exact, unique, default off and exclusive of Windows keys", () => {
  const context = vm.createContext({});
  vm.runInContext(between(nativeHistorySource, "function readingHistoryNoopEnabled(",
    "\nfunction windowsHistoryKeysEnabled("), context);
  const select = context.readingHistoryNoopEnabled;
  assert.equal(select([], false), false);
  assert.equal(select(["--windows-history-keys"], true), false);
  assert.equal(select(["entry", "--reading-history-noop", "--reader-inspection-holds"], false), true);
  for (const [argv, keys] of [
    [["--reading-history-noop=false"], false], [["--reading-history-other"], false],
    [["--reading-history-noop", "--reading-history-noop"], false], [["--reading-history-noop"], true],
  ]) assert.throws(() => select(argv, keys), /requires exactly/);
  const branch = "  if (readingHistoryNoop) return runReadingHistoryNoop();";
  assert.ok(nativeHistorySource.indexOf(branch) > nativeHistorySource.indexOf('save(\'A\')'));
  assert.ok(nativeHistorySource.indexOf(branch) < nativeHistorySource.indexOf("  if (windowsHistoryKeys)"));
  for (const selected of [false, true]) {
    let runs = 0;
    const routing = vm.createContext({ readingHistoryNoop: selected, runReadingHistoryNoop() { runs++; return "no-op"; } });
    const result = vm.runInContext("(function () {" + branch + "\nreturn 'ordinary';})()", routing);
    assert.equal(runs, selected ? 1 : 0);
    assert.equal(result, selected ? "no-op" : "ordinary");
  }
});

function nativeNoopFixture() {
  const target = { id: "beta", textContent: "Native history Beta", isConnected: true }, jumps = [];
  const state = {
    document: { edit: false, dirty: false, source: "exact source", selection: [1, 2, "forward"] },
    source: { version: 1, text: { start: 10 }, horizontal: { outer: 0 } },
    undo: ["previous source"], redo: ["next source"], top: 100, left: 0, cssZoom: "1",
    availability: { back: true, forward: true }, drawer: true, owner: true, calls: 1, clicks: 0,
    completion: Promise.resolve({ status: "completed", scope: "request-offsets", travel: "no-observed-travel" }),
  };
  const button = { dataset: { headerId: target.id }, click() {
    state.clicks++;
    for (let i = 0; i < state.calls; i++) jumps.push({
      target: state.target ?? target, block: state.block ?? "start", handle: { completion: state.completion },
    });
    state.mutate?.();
  } };
  const context = vm.createContext({
    structuredClone, ensure(condition, message) { if (!condition) throw new Error(message); },
    intact() { if (!state.owner) throw new Error("actual production owner changed"); },
    documentState: () => state.document, location: () => state.source,
    getViewerScroller: () => ({ scrollTop: state.top, scrollLeft: state.left }),
    viewer: { querySelectorAll: () => [target], contains: node => node === target },
    getComputedStyle: () => ({ zoom: state.cssZoom }), zoomLevel: 100,
    realControls: { availability: () => state.availability },
    indexList: { querySelectorAll: () => [button] },
    indexPanel: { classList: { contains: () => state.drawer } }, jumps,
    document: { activeElement: { id: "", tagName: "BODY" } },
    undoHistory: state.undo, redoHistory: state.redo, searchInput: { value: "" }, searchMatches: [],
    currentMatchIndex: -1, currentMatchEl: null, pendingSearchTerm: null,
    pendingSearchRequest: null, searchDebounceTimer: null,
  });
  vm.runInContext(between(nativeHistorySource, "  function noOpState(",
    "\n  // Observe genuine production results"), context);
  const method = between(nativeHistorySource, "    async samePositionJump(", "\n    async history(");
  vm.runInContext("var api = ({" + method + "});", context);
  return { api: context.api, context, target, button, state, jumps };
}

test("the actual same-position probe awaits its one real completion and retains exact before/after state", async () => {
  const f = nativeNoopFixture();
  let release;
  f.state.completion = new Promise(resolve => { release = resolve; });
  let finished = false;
  const result = f.api.samePositionJump("Native history Beta").then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(f.state.clicks, 1);
  assert.equal(f.jumps[0].handle.completion, f.state.completion);
  release({ status: "completed", scope: "request-offsets", travel: "no-observed-travel" });
  const observation = await result;
  assert.equal(observation, f.api.noOpObservation);
  assert.equal(observation.calls, 1);
  assert.deepEqual(observation.before, observation.after);
  assert.deepEqual(observation.before.document.undoValues, ["previous source"]);
  assert.deepEqual(observation.before.document.redoValues, ["next source"]);
});

for (const [name, change, error] of [
  ["disconnected target", f => { f.target.isConnected = false; }, /unique, connected and owned/],
  ["closed TOC", f => { f.state.drawer = false; }, /open-drawer/],
  ["missing Forward branch", f => { f.state.availability.forward = false; }, /both history directions/],
  ["preexisting Search", f => { f.context.pendingSearchTerm = "unexpected"; }, /empty Search/],
  ["missing call", f => { f.state.calls = 0; }, /exactly one real jump/],
  ["duplicate calls", f => { f.state.calls = 2; }, /exactly one real jump/],
  ["wrong target", f => { f.state.target = {}; }, /actual target or completion/],
  ["wrong alignment", f => { f.state.block = "center"; }, /actual target or completion/],
  ["missing completion", f => { f.state.completion = null; }, /actual target or completion/],
  ["unrecordable completion", f => { f.state.completion = Promise.resolve({ status: "unrecordable", reason: "target-clipped" }); }, /genuine no-travel/],
  ["moved completion", f => { f.state.completion = Promise.resolve({ status: "completed", scope: "request-offsets", travel: "observed-travel" }); }, /genuine no-travel/],
  ["wrong completion scope", f => { f.state.completion = Promise.resolve({ status: "completed", scope: "global", travel: "no-observed-travel" }); }, /genuine no-travel/],
]) {
  test("the actual no-op probe refuses " + name, async () => {
    const f = nativeNoopFixture();
    change(f);
    await assert.rejects(f.api.samePositionJump("Native history Beta"), error);
  });
}

for (const [name, mutate] of [
  ["Source point", f => { f.state.source.text.start++; }],
  ["viewport", f => { f.state.top++; }],
  ["availability", f => { f.state.availability.forward = false; }],
  ["document", f => { f.state.document.dirty = true; }],
  ["same-length Undo", f => { f.state.undo[0] = "replacement source"; }],
  ["same-length Redo", f => { f.state.redo[0] = "replacement source"; }],
  ["Search", f => { f.context.pendingSearchTerm = "unexpected"; }],
  ["focus", f => { f.context.document.activeElement.id = "unexpected"; }],
  ["zoom", f => { f.context.zoomLevel = 110; }],
]) {
  test("the actual no-op probe detects hidden " + name + " mutation", async () => {
    const f = nativeNoopFixture();
    f.state.mutate = () => mutate(f);
    await assert.rejects(f.api.samePositionJump("Native history Beta"), /no-op changed/);
    assert.equal(f.api.noOpObservation.record.travel, "no-observed-travel");
    assert.ok(f.api.noOpObservation.after);
  });
}

test("the actual no-op probe refuses a late extra jump or changed production owner", async () => {
  const late = nativeNoopFixture();
  late.state.completion = late.state.completion.then(record => { late.jumps.push({}); return record; });
  await assert.rejects(late.api.samePositionJump("Native history Beta"), /extra jump/);
  const owner = nativeNoopFixture();
  owner.state.mutate = () => { owner.state.owner = false; };
  await assert.rejects(owner.api.samePositionJump("Native history Beta"), /owner changed/);
});

test("a missing no-op completion remains bounded by the existing Main action deadline", async () => {
  const f = nativeNoopFixture();
  f.state.completion = new Promise(() => {});
  let expire, delay;
  f.context.setTimeout = (callback, milliseconds) => { expire = callback; delay = milliseconds; return 1; };
  f.context.clearTimeout = () => {};
  vm.runInContext(between(nativeHistorySource, "async function bounded(", "\nfunction exec("), f.context);
  const pending = f.context.bounded(() => f.api.samePositionJump("Native history Beta"), "renderer action");
  await Promise.resolve();
  assert.equal(delay, 15000);
  expire();
  await assert.rejects(pending, /timed out/);
  assert.equal(f.api.noOpObservation.record, null);
});

function noopItineraryFixture(enabled, corruption = null) {
  const assertions = [], checkpoints = [], images = [], actions = [], observations = [];
  const document = { edit: false, dirty: false, source: "exact source", undoValues: ["old"], redoValues: ["new"] };
  const search = { value: "", matches: 0, index: -1, current: false, term: null, request: null, timer: false };
  const timeline = ["A"];
  let index = 0, partial = null;
  const availability = () => ({ back: index > 0, forward: index < timeline.length - 1 });
  const state = () => structuredClone({ document, search, viewport: { zoom: 100, cssZoom: "1" },
    availability: availability() });
  const context = vm.createContext({
    inspection: { enabled }, observedContents: { getZoomFactor: () => 1 },
    observedMain: {}, sentinel: {}, noOpObservations: observations,
    isDeepStrictEqual: require("util").isDeepStrictEqual,
    async exec(code) {
      actions.push(code);
      if (code === "window.__readingHistoryNative.noOpState()") return state();
      const jump = code.match(/^window\.__readingHistoryNative\.jump\('Native history (Beta|Gamma)'\)$/);
      if (jump) { timeline.splice(index + 1, Infinity, jump[1] === "Beta" ? "B" : "C"); index++; return { availability: availability() }; }
      if (/^window\.__readingHistoryNative\.save\('[BC]'\)$/.test(code)) return true;
      const history = code.match(/^window\.__readingHistoryNative\.history\((-?1)\)$/);
      if (history) { index += Number(history[1]); assert.ok(index >= 0 && index < timeline.length); return true; }
      const position = code.match(/^window\.__readingHistoryNative\.position\('([ABC])'\)$/);
      if (position) { assert.equal(timeline[index], position[1], "the saved Source endpoint must really be reached"); return { availability: availability() }; }
      if (code === "window.__readingHistoryNative.samePositionJump('Native history Beta')") {
        assert.equal(timeline[index], "B");
        assert.deepEqual(timeline, ["A", "B", "C"]);
        const before = state();
        partial = { calls: 1, record: { status: "completed", scope: "request-offsets", travel: "no-observed-travel" },
          before, after: structuredClone(before) };
        if (corruption === "duplicate") timeline.splice(index + 1, 0, "B");
        if (corruption === "truncate") timeline.splice(index + 1);
        if (corruption === "completion") { partial.record.travel = "observed-travel"; throw new Error("genuine no-travel completion refused"); }
        return partial;
      }
      if (code === "window.__readingHistoryNative.noOpObservation") return partial;
      if (code === "window.__readingHistoryNative.dispose()") return true;
      throw new Error("Unexpected no-op itinerary action: " + code);
    },
    demand(name, condition) { assert.ok(condition, name); assertions.push(name); },
    async capture(name) { images.push(name); context.demand("capture exists: " + name, true); },
    async inspectCheckpoint(stage, _point, name, logical) {
      checkpoints.push(stage);
      if (logical) await context.capture(name);
      else images.push(name);
    },
    proveSentinelAlive: async () => ({ console: true, dom: true }),
  });
  vm.runInContext(between(nativeHistorySource, "async function runReadingHistoryNoop(",
    "\nfunction installHistoryKeyProbe("), context);
  return { context, assertions, checkpoints, images, actions, observations };
}

test("the actual no-op itinerary emits fifteen separate scenario assertions with four existing holds or three captures", async () => {
  for (const enabled of [false, true]) {
    const f = noopItineraryFixture(enabled);
    await f.context.runReadingHistoryNoop();
    assert.equal(f.assertions.length, 15);
    assert.deepEqual(f.checkpoints, enabled ? ["initial", "toc-beta", "back-alpha", "forward-gamma"] : []);
    assert.deepEqual(f.images, enabled ? ["noop00-alpha-initial", "noop01-beta-noop-preserved",
      "noop02-alpha-back", "noop03-gamma-forward"] : ["noop01-beta-noop-preserved", "noop02-alpha-back", "noop03-gamma-forward"]);
    assert.equal(f.actions.filter(code => code.includes(".samePositionJump(")).length, 1);
    assert.deepEqual(f.actions.filter(code => code.includes(".history(")).map(code => code.match(/\((-?1)\)/)[1]), ["-1", "-1", "1", "1"]);
    assert.equal(f.observations.length, 1);
  }
});

for (const corruption of ["duplicate", "truncate", "completion"]) {
  test("the actual no-op itinerary refuses " + corruption + " rather than reporting a successful branch", async () => {
    const f = noopItineraryFixture(false, corruption);
    await assert.rejects(f.context.runReadingHistoryNoop());
    if (corruption === "completion") {
      assert.equal(f.observations[0].partial.record.travel, "observed-travel");
      assert.match(f.observations[0].error, /genuine no-travel/);
    }
  });
}

test("the branch-replacement selector is exact, unique, default off and exclusive of accepted scenarios", () => {
  const context = vm.createContext({});
  vm.runInContext(between(nativeHistorySource, "function readerBranchReplacementEnabled(",
    "\nfunction readingHistoryNoopEnabled("), context);
  const select = context.readerBranchReplacementEnabled;
  for (const argv of [[], ["--reader-inspection-holds"], ["--windows-history-keys"], ["--reading-history-noop"]]) {
    assert.equal(select(argv, false, false), false);
  }
  assert.equal(select(["entry", "--reader-branch-replacement", "--reader-inspection-holds"], false, false), true);
  for (const [argv, keys, noOp] of [
    [["--reader-branch-replacement=false"], false, false],
    [["--reader-branch-other"], false, false],
    [["--reader-branch-replacement", "--reader-branch-replacement"], false, false],
    [["--reader-branch-replacement"], true, false],
    [["--reader-branch-replacement"], false, true],
  ]) assert.throws(() => select(argv, keys, noOp), /requires exactly/);
  const admission = between(nativeHistorySource, "let inspection, windowsHistoryKeys;",
    '\n({ app, BrowserWindow, dialog, shell } = require("electron"));');
  for (const argv of [
    ["--reader-branch-replacement", "--windows-history-keys"],
    ["--reader-branch-replacement", "--reading-history-noop"],
    ["--reader-branch-replacement", "--windows-history-keys", "--reading-history-noop"],
  ]) {
    const mixed = vm.createContext({ process: { argv, platform: "win32" },
      ReaderInspection: class {}, fatal(error) { throw error; } });
    vm.runInContext(between(nativeHistorySource, "function readerBranchReplacementEnabled(",
      "\nlet inspection, windowsHistoryKeys;"), mixed);
    assert.throws(() => vm.runInContext(admission, mixed), /requires exactly/);
  }
});

test("actual pre-scenario routing keeps ordinary, no-op and Windows journeys isolated from branch replacement", () => {
  const routing = between(nativeHistorySource, "  if (readerBranchReplacement) return runReaderBranchReplacement();",
    '\n  if (inspection.enabled) await inspectCheckpoint("initial"');
  assert.ok(nativeHistorySource.indexOf(routing) > nativeHistorySource.indexOf("save('A')"));
  for (const selected of ["ordinary", "branch", "no-op", "keys"]) {
    const calls = [];
    const context = vm.createContext({
      readerBranchReplacement: selected === "branch", readingHistoryNoop: selected === "no-op",
      windowsHistoryKeys: selected === "keys",
      publicationProducers: false,
      runReaderBranchReplacement() { calls.push("branch"); return "branch"; },
      runReadingHistoryNoop() { calls.push("no-op"); return "no-op"; },
      runWindowsHistoryKeys() { calls.push("keys"); return "keys"; },
    });
    assert.equal(vm.runInContext("(function () {" + routing + "\nreturn 'ordinary';})()", context), selected);
    assert.deepEqual(calls, selected === "ordinary" ? [] : [selected]);
  }
});

function nativeTravelFixture() {
  const f = nativeNoopFixture();
  f.state.completion = Promise.resolve({ status: "completed", scope: "request-offsets", travel: "observed-travel" });
  const method = between(nativeHistorySource, "    async jump(",
    "\n    // Keep no-travel admission separate");
  vm.runInContext("var travelApi = ({" + method + "});", f.context);
  return { ...f, api: f.context.travelApi };
}

test("the unchanged actual travel probe awaits its one original completion and returns that exact record", async () => {
  const f = nativeTravelFixture();
  let release, finished = false;
  f.state.completion = new Promise(resolve => { release = resolve; });
  const pending = f.api.jump("Native history Beta").then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(f.state.clicks, 1);
  assert.equal(f.jumps[0].handle.completion, f.state.completion);
  const record = { status: "completed", scope: "request-offsets", travel: "observed-travel" };
  release(record);
  const result = await pending;
  assert.equal(result.record, record);
  assert.equal(result.target, f.target.id);
});

for (const [name, change, error] of [
  ["missing call", f => { f.state.calls = 0; }, /exactly one document jump/],
  ["duplicate calls", f => { f.state.calls = 2; }, /exactly one document jump/],
  ["wrong target", f => { f.state.target = {}; }, /actual TOC target and completion/],
  ["wrong alignment", f => { f.state.block = "center"; }, /actual TOC target and completion/],
  ["missing completion", f => { f.state.completion = null; }, /actual TOC target and completion/],
  ["rejected completion", f => { f.state.completion = Promise.reject(new Error("travel completion rejected")); }, /travel completion rejected/],
  ["unrecordable completion", f => { f.state.completion = Promise.resolve({ status: "unrecordable" }); }, /recordable travel/],
  ["wrong completion scope", f => { f.state.completion = Promise.resolve({ status: "completed", scope: "global", travel: "observed-travel" }); }, /recordable travel/],
  ["no-travel completion", f => { f.state.completion = Promise.resolve({ status: "completed", scope: "request-offsets", travel: "no-observed-travel" }); }, /recordable travel/],
]) {
  test("the actual replacement travel probe refuses " + name, async () => {
    const f = nativeTravelFixture();
    change(f);
    await assert.rejects(f.api.jump("Native history Beta"), error);
  });
}

test("the replacement's never-completing real travel request stays bounded by the original action deadline", async () => {
  const f = nativeTravelFixture();
  f.state.completion = new Promise(() => {});
  let expire, delay;
  f.context.setTimeout = (callback, milliseconds) => { expire = callback; delay = milliseconds; return 1; };
  f.context.clearTimeout = () => {};
  vm.runInContext(between(nativeHistorySource, "async function bounded(", "\nfunction exec("), f.context);
  const pending = f.context.bounded(() => f.api.jump("Native history Beta"), "renderer action");
  await Promise.resolve();
  assert.equal(delay, 15000);
  expire();
  await assert.rejects(pending, /timed out/);
  assert.equal(f.jumps.length, 1);
});

function branchItineraryFixture(enabled, corruption = null) {
  const assertions = [], checkpoints = [], images = [], actions = [], observations = [], captureReadiness = [];
  const stable = {
    document: { edit: false, dirty: false, source: "exact source", selection: [1, 2, "forward"],
      undoValues: ["old"], redoValues: ["new"] },
    search: { value: "", matches: 0, index: -1, current: false, term: null, request: null, timer: false },
    focus: { id: "", tag: "BODY" }, viewport: { zoom: 100, cssZoom: "1" },
  };
  const points = { A: 0, B: 100, C: 200 }, saved = new Map([["A", "A"]]), timeline = ["A"];
  let index = 0, actual = "A";
  const availability = () => ({ back: index > 0, forward: index < timeline.length - 1 });
  const state = () => structuredClone({ ...stable, source: { text: { start: points[actual] } },
    availability: availability() });
  const context = vm.createContext({
    inspection: { enabled }, observedContents: { getZoomFactor: () => 1 },
    observedMain: {}, sentinel: {}, branchReplacementObservations: observations,
    isDeepStrictEqual: require("util").isDeepStrictEqual,
    async exec(code) {
      actions.push(code);
      if (code === "window.__readingHistoryNative.noOpState()") return state();
      const jump = code.match(/^window\.__readingHistoryNative\.jump\('Native history (Beta|Gamma)'\)$/);
      if (jump) {
        actual = jump[1] === "Beta" ? "B" : "C";
        if (!(actual === "C" && corruption === "uncommitted")) {
          if (!(actual === "C" && corruption === "retain-beta")) timeline.splice(index + 1);
          timeline.push(actual);
          index = timeline.length - 1;
        }
        if (actual === "C") {
          if (corruption === "lose-alpha") timeline[0] = "B";
          if (corruption === "duplicate-alpha") { timeline.splice(index, 0, "A"); index++; }
          if (corruption === "undo") stable.document.undoValues[0] = "other";
          if (corruption === "redo") stable.document.redoValues[0] = "other";
          if (corruption === "selection") stable.document.selection[0]++;
          if (corruption === "search") stable.search.term = "unexpected";
          if (corruption === "focus") stable.focus.id = "unexpected";
          if (corruption === "zoom") stable.viewport.zoom = 110;
        }
        return { target: jump[1].toLowerCase(), record: { status: "completed", scope: "request-offsets",
          travel: "observed-travel" }, availability: availability() };
      }
      const save = code.match(/^window\.__readingHistoryNative\.save\('([BC])'\)$/);
      if (save) { saved.set(save[1], actual); return true; }
      const history = code.match(/^window\.__readingHistoryNative\.history\((-?1)\)$/);
      if (history) {
        index += Number(history[1]);
        assert.ok(index >= 0 && index < timeline.length, "an enabled actual neighbor is required");
        actual = corruption === "forward-beta" && Number(history[1]) === 1 ? "B" : timeline[index];
        return true;
      }
      const position = code.match(/^window\.__readingHistoryNative\.position\('([ABC])'\)$/);
      if (position) {
        assert.equal(actual, saved.get(position[1]), "the saved Source endpoint must really be reached");
        return { start: points[actual], availability: availability() };
      }
      if (code === "window.__readingHistoryNative.dispose()") return true;
      throw new Error("Unexpected branch itinerary action: " + code);
    },
    demand(name, condition) { assert.ok(condition, name); assertions.push(name); },
    async waitForBranchCapture(point, heading) { captureReadiness.push([point, heading]); },
    async capture(name, logical = true) {
      images.push(name);
      if (logical) context.demand("capture exists: " + name, true);
    },
    async inspectCheckpoint(stage, _point, name, logical) {
      checkpoints.push(stage);
      if (logical) await context.capture(name);
      else images.push(name);
    },
    proveSentinelAlive: async () => ({ console: true, dom: true }),
  });
  const start = nativeHistorySource.indexOf("async function runReaderBranchReplacement(");
  assert.ok(start > 0, "the actual branch itinerary must exist");
  vm.runInContext(nativeHistorySource.slice(start), context);
  return { context, assertions, checkpoints, images, actions, observations, timeline, captureReadiness };
}

test("the actual replacement itinerary has fourteen assertions, two jumps, three traversals and four images with or without holds", async () => {
  for (const enabled of [false, true]) {
    const f = branchItineraryFixture(enabled);
    await f.context.runReaderBranchReplacement();
    assert.equal(f.assertions.length, 14);
    assert.deepEqual(f.timeline, ["A", "C"]);
    assert.deepEqual(f.actions.filter(code => /\.(jump|history)\(/.test(code)), [
      "window.__readingHistoryNative.jump('Native history Beta')", "window.__readingHistoryNative.history(-1)",
      "window.__readingHistoryNative.jump('Native history Gamma')", "window.__readingHistoryNative.history(-1)",
      "window.__readingHistoryNative.history(1)",
    ]);
    assert.deepEqual(f.checkpoints, enabled ? ["initial", "toc-beta", "back-alpha", "forward-gamma"] : []);
    assert.deepEqual(f.images, ["branch00-alpha-initial", "branch01-beta-recorded",
      "branch02-alpha-back", "branch03-gamma-forward"]);
    assert.deepEqual(f.captureReadiness, [["A", "Native history Alpha"], ["B", "Native history Beta"],
      ["A", "Native history Alpha"], ["C", "Native history Gamma"]]);
    assert.equal(f.observations.length, 1);
    assert.equal(f.observations[0].obsoleteBeta.position.start, 100);
    assert.equal(f.observations[0].before.source.text.start, 0);
    assert.equal(f.observations[0].after.source.text.start, 200);
    assert.deepEqual(f.observations[0].before.availability, { back: false, forward: true });
    assert.deepEqual(f.observations[0].after.availability, { back: true, forward: false });
    assert.equal(f.observations[0].jump.record.travel, "observed-travel");
  }
});

for (let failed = 0; failed < 4; failed++) {
  test("branch capture readiness failure stops before image " + failed + " without retry", async () => {
    const f = branchItineraryFixture(false);
    let calls = 0;
    f.context.waitForBranchCapture = async () => {
      if (calls++ === failed) throw new Error("controlled branch readiness failure");
    };
    await assert.rejects(f.context.runReaderBranchReplacement(), /controlled branch readiness failure/);
    assert.equal(calls, failed + 1);
    assert.deepEqual(f.images, ["branch00-alpha-initial", "branch01-beta-recorded",
      "branch02-alpha-back", "branch03-gamma-forward"].slice(0, failed));
  });
}

for (const [corruption, error] of [
  ["retain-beta", /saved Source endpoint/],
  ["uncommitted", /successful Gamma jump replaces/],
  ["lose-alpha", /saved Source endpoint/],
  ["duplicate-alpha", /one Back after replacement reaches original Alpha/],
  ["forward-beta", /saved Source endpoint/],
  ["undo", /branch replacement commit preserves exact/],
  ["redo", /branch replacement commit preserves exact/],
  ["selection", /branch replacement commit preserves exact/],
  ["search", /branch replacement commit preserves exact/],
  ["focus", /branch replacement commit preserves exact/],
  ["zoom", /branch replacement commit preserves exact/],
]) {
  test("the actual replacement itinerary detects " + corruption + " at its required assertion", async () => {
    const f = branchItineraryFixture(false, corruption);
    await assert.rejects(f.context.runReaderBranchReplacement(), error);
  });
}

const releaseCaptureNames = [
  "release01-coalesced-tail", "release02-explicit-return", "release03-issued-back",
  "release04-failed-branch-retained", "release05-stale-highlight-repair", "release06-second-tab-gamma",
  "release07-independent-tabs", "release07b-cancel-close-question", "release07c-canceled-close-retained",
  "release08-reopened-empty", "release09-ten-location-cap", "release10-renderer-lifetime-reset",
];
const releaseItinerarySource = between(nativeHistorySource, "async function runReleaseHistoryBatch(",
  "\nasync function runPublicationProducers(");
const releaseCaptureSites = [...releaseItinerarySource.matchAll(
  /  await waitForReleaseCapture\("([^"]+)"([^;\n]*?)\);\r?\n  await capture\("\1"\);/g)];

test("the finite release itinerary keeps twelve original captures and forty-eight route assertions", () => {
  const imageNames = [...releaseItinerarySource.matchAll(/^  await capture\("([^"]+)"\);/gm)].map(match => match[1]);
  assert.deepEqual(imageNames, releaseCaptureNames);
  assert.deepEqual(releaseCaptureSites.map(match => match[1]), releaseCaptureNames);
  const names = [];
  for (const line of releaseItinerarySource.split(/\r?\n/)) {
    let match;
    if ((match = line.match(/^  demand\("([^"]+)"/))) names.push(match[1]);
    else if ((match = line.match(/^  (?:const \w+ = )?await search\("([^"]+)"\)/))) {
      names.push("trusted arrived Search preview: " + match[1]);
    } else if ((match = line.match(/^  await unchangedDocument\("([^"]+)"/))) names.push(match[1]);
    else if ((match = line.match(/^  await capture\("([^"]+)"\)/))) names.push("capture exists: " + match[1]);
  }
  assert.equal(names.length, 48);
  assert.equal(names.filter(name => name.startsWith("capture exists:")).length, 12);
  assert.equal(names.filter(name => name.startsWith("trusted arrived Search preview:")).length, 4);
  assert.ok(releaseItinerarySource.includes('await api("remember(\'repair-capture\'," + JSON.stringify(repair.location) + ")")'));
});

for (const name of releaseCaptureNames) {
  test("release readiness failure stops its actual acquisition seam: " + name, async () => {
    const site = releaseCaptureSites.find(match => match[1] === name);
    assert.ok(site, "the actual native acquisition seam must exist");
    let checks = 0, images = 0;
    const context = vm.createContext({
      beforeCancel: { tab: 42 }, oldPage: "previous-page",
      async waitForReleaseCapture(actual, closeState = null, oldPage = null) {
        assert.equal(actual, name);
        if (name.startsWith("release07b-") || name.startsWith("release07c-")) assert.equal(closeState.tab, 42);
        if (name === "release10-renderer-lifetime-reset") assert.equal(oldPage, "previous-page");
        checks++;
        throw new Error("controlled release readiness failure");
      },
      capture() { images++; },
    });
    await assert.rejects(vm.runInContext("(async()=>{\n" + site[0] + "\n})()", context),
      /controlled release readiness failure/);
    assert.equal(checks, 1);
    assert.equal(images, 0);
  });
}

test("the finite release selector is exact, unique and cannot consume an accepted scenario or inspection hold", () => {
  const context = vm.createContext({});
  vm.runInContext(between(nativeHistorySource, "function releaseHistoryBatchEnabled(", "\ntry {"), context);
  const select = context.releaseHistoryBatchEnabled;
  assert.equal(select([], false, false), false);
  assert.equal(select(["--release-history-batch"], false, false), true);
  for (const [argv, other, holds] of [
    [["--release-history-bat"], false, false],
    [["--release-history-batch=1"], false, false],
    [["--release-history-batch", "--release-history-batch"], false, false],
    [["--release-history-batch"], true, false],
    [["--release-history-batch"], false, true],
  ]) assert.throws(() => select(argv, other, holds), /exactly --release-history-batch/);
});

test("the actual scenario router reaches only the selected release or previously accepted itinerary", () => {
  const routing = between(nativeHistorySource, "  if (releaseHistoryBatch) return runReleaseHistoryBatch();",
    "\n  if (inspection.enabled)");
  for (const selected of ["release", "branch", "no-op", "keys", "ordinary"]) {
    const calls = [];
    const context = vm.createContext({
      releaseHistoryBatch: selected === "release", readerBranchReplacement: selected === "branch",
      readingHistoryNoop: selected === "no-op", windowsHistoryKeys: selected === "keys",
      publicationProducers: false,
      runReleaseHistoryBatch() { calls.push("release"); },
      runReaderBranchReplacement() { calls.push("branch"); },
      runReadingHistoryNoop() { calls.push("no-op"); },
      runWindowsHistoryKeys() { calls.push("keys"); },
    });
    vm.runInContext("(function(){" + routing + "})()", context);
    assert.deepEqual(calls, selected === "ordinary" ? [] : [selected]);
  }
});

test("the producer companion selector is exact, unique and excludes accepted routes, modes and inspection holds", () => {
  const context = vm.createContext({});
  vm.runInContext(between(nativeHistorySource, "function publicationProducersEnabled(", "\ntry {"), context);
  const select = context.publicationProducersEnabled;
  assert.equal(select([], false, false), false);
  assert.equal(select(["--release-history-batch"], true, false), false);
  assert.equal(select(["--publication-producers"], false, false), true);
  for (const [argv, other, holds] of [
    [["--publication-producer"], false, false],
    [["--publication-producers=1"], false, false],
    [["--publication-producers", "--publication-producers"], false, false],
    [["--publication-producers"], true, false],
    [["--publication-producers"], false, true],
    [["--publication-producers", "--reading-mode-native"], false, false],
    [["--publication-producers", "--mode-reader"], false, false],
  ]) assert.throws(() => select(argv, other, holds), /require exactly/);
  const declarations = between(nativeHistorySource, "function readerBranchReplacementEnabled(",
    "\nlet inspection, windowsHistoryKeys;");
  const admission = between(nativeHistorySource, "let inspection, windowsHistoryKeys;",
    '\n({ app, BrowserWindow, dialog, shell } = require("electron"));');
  for (const flag of ["--release-history-batch", "--reader-branch-replacement",
    "--reading-history-noop", "--windows-history-keys", "--reader-inspection-holds", "--reading-mode-native"]) {
    const mixed = vm.createContext({
      process: { argv: ["--publication-producers", flag], platform: "win32" },
      ReaderInspection: class { constructor(argv) { this.enabled = argv.includes("--reader-inspection-holds"); } },
      fatal(error) { throw error; },
    });
    vm.runInContext(declarations, mixed);
    assert.throws(() => vm.runInContext(admission, mixed), /require.*exactly/);
  }
});

test("the actual router keeps the producer companion separate from every accepted itinerary", () => {
  const routing = between(nativeHistorySource, "  if (releaseHistoryBatch) return runReleaseHistoryBatch();",
    "\n  if (inspection.enabled)");
  for (const selected of ["release", "branch", "no-op", "keys", "producers", "ordinary"]) {
    const calls = [];
    const context = vm.createContext({
      releaseHistoryBatch: selected === "release", readerBranchReplacement: selected === "branch",
      readingHistoryNoop: selected === "no-op", windowsHistoryKeys: selected === "keys",
      publicationProducers: selected === "producers",
      runReleaseHistoryBatch() { calls.push("release"); },
      runReaderBranchReplacement() { calls.push("branch"); },
      runReadingHistoryNoop() { calls.push("no-op"); },
      runWindowsHistoryKeys() { calls.push("keys"); },
      runPublicationProducers() { calls.push("producers"); },
    });
    vm.runInContext("(function(){" + routing + "})()", context);
    assert.deepEqual(calls, selected === "ordinary" ? [] : [selected]);
  }
});

function releaseProbeFixture() {
  const f = nativeNoopFixture(), context = f.context;
  Object.assign(context, {
    releaseHistoryBatch: true, saved: {}, traversals: [], issueHook: null, issuedBack: null,
    canceledRequest: null, pendingListener: null, controlsState: {},
  });
  const methods = between(nativeHistorySource, "    remember(", "\n    async jump(");
  vm.runInContext("var releaseApi = ({" + methods + "});", context);
  return { ...f, api: context.releaseApi };
}

const installedProbeSource = between(nativeHistorySource, "function installHistoryProbe(", "\nasync function run(");
const probeInstallationSites = nativeHistorySource.split("\n").filter(line =>
  line.includes('await exec("(" + installHistoryProbe.toString()'));

function injectedReleaseFixture() {
  const events = [], listeners = new Map(), tab = { id: 42 };
  let inputListener = null, closes = 0, flushed = null;
  const sourcePoint = { version: 1, text: { sourceKey: "injected-source", start: 5 } };
  const capture = () => ({ status: "captured", location: sourcePoint });
  const handle = { request: Promise.resolve({ interrupted: false }),
    completion: Promise.resolve({ status: "unrecordable", reason: "superseded" }) };
  const realControls = {
    availability: () => ({ back: true, forward: true }),
    navigate(direction) {
      assert.equal(direction, -1);
      events.push("real-back");
      return Promise.resolve(true);
    },
  };
  const realJump = () => { events.push("native-issued"); return handle; };
  class RendererElement {
    scrollIntoView() {}
    scrollTo() {}
  }
  const permit = {};
  const renderer = vm.createContext({
    Element: RendererElement, captureReadingLocation: capture, scrollElementIntoView: realJump,
    readingHistoryControlState: { core: realControls },
    pendingSearchRequest: null, pendingSearchTerm: null, searchDebounceTimer: null, searchMatches: [],
    searchInput: {
      value: "",
      addEventListener(name, callback, options) {
        assert.equal(name, "input");
        assert.equal(options.once, true);
        assert.equal(inputListener, null);
        inputListener = callback;
      },
      removeEventListener(name, callback) {
        assert.equal(name, "input");
        assert.equal(callback, inputListener);
        inputListener = null;
      },
    },
    searchCloseBtn: { click() {
      closes++;
      renderer.pendingSearchRequest = renderer.pendingSearchTerm = renderer.searchDebounceTimer = null;
    } },
    readingViewport: { capturePermit: () => permit },
    flushPendingSearch(intent, request) {
      assert.equal(intent, null);
      flushed = request;
    },
    resyncSearchAfterRender(value) {
      assert.equal(value, permit);
      renderer.pendingSearchRequest = { intent: null, segment: null };
    },
    document: { getElementById(id) {
      assert.equal(id, "readingBackBtn");
      return { disabled: false, click() { renderer.readingHistoryControlState.core.navigate(-1); } };
    } },
    window: {
      readingHistoryControls: realControls,
      readingLocationAdapter: Object.freeze({ capture, restore() {}, available: () => true }),
      CustomTabs: { getActiveTab: () => tab },
      addEventListener(name, callback) { listeners.set(name, callback); },
      removeEventListener(name, callback) {
        assert.equal(listeners.get(name), callback);
        listeners.delete(name);
      },
    },
  });
  return { renderer, events, handle, realJump, realControls, sourcePoint, listeners,
    inputListener: () => inputListener, closes: () => closes, flushed: () => flushed,
    fireInput: event => inputListener(event) };
}

async function injectActualProbe(f, site, enabled, options = {}) {
  const emitted = [];
  // The receiving VM must not inherit Node's selector or hand-built probe locals.
  const sender = vm.createContext({
    releaseHistoryBatch: enabled,
    exec(code) {
      emitted.push(code);
      if (options.dropArgument) {
        const mutated = code.replace(/\)\((?:true|false)\)$/, ")()");
        assert.notEqual(mutated, code);
        code = mutated;
      }
      return vm.runInContext(code, f.renderer);
    },
  });
  vm.runInContext(options.source || installedProbeSource, sender);
  await vm.runInContext("(async()=>{\n" + site + "\n})()", sender);
  assert.equal(emitted.length, 1);
  for (const name of ["releaseHistoryBatch", "ensure", "intact", "saved", "jumps", "traversals",
    "issueHook", "issuedBack", "canceledRequest", "pendingListener", "realJump", "realControls"]) {
    assert.equal(vm.runInContext("typeof " + name, f.renderer), "undefined", name + " must remain local");
  }
  return f.renderer.window.__readingHistoryNative;
}

const survivorSequenceSource = between(nativeHistorySource,
  '  await exec("window.CustomTabs.closeTab(" + secondTab + ")");',
  '\n  demand("closing the other tab preserves the surviving timeline"');
const survivorReadinessSource = between(survivorSequenceSource,
  '  await waitReady("surviving first tab final DOM after close",',
  '\n  await exec("(" + installHistoryProbe.toString()');

function survivorSequenceFixture(source = survivorSequenceSource, unavailable = false) {
  const f = injectedReleaseFixture(), first = f.renderer.window.CustomTabs.getActiveTab(), other = { id: 43 };
  const state = { active: other, tabs: [first, other], available: false, loading: true, heading: "Other history Alpha" };
  const markdown = "# Native history Alpha";
  let release, installations = 0, checks = 0;
  const render = new Promise(resolve => { release = resolve; });
  Object.assign(f.renderer, {
    currentFilePath: "survivor.md", originalMarkdown: markdown,
    readingDisplay: { source: { source: "# Other history Alpha" } }, readingRenderCompletion: render,
    viewer: { querySelector: () => ({ textContent: state.heading }) },
    loadingScreen: { classList: { contains: () => state.loading } },
  });
  Object.assign(f.renderer.window.CustomTabs, {
    getActiveTab: () => state.active, getTabs: () => state.tabs,
    async closeTab(id) {
      assert.equal(id, other.id);
      state.tabs = [first]; state.active = first;
      return true;
    },
  });
  f.renderer.window.readingLocationAdapter = Object.freeze({
    ...f.renderer.window.readingLocationAdapter, available: () => state.available,
  });
  const sender = vm.createContext({
    fixture: "survivor.md", markdown, firstTab: first.id, secondTab: other.id, releaseHistoryBatch: true,
    async exec(code) {
      if (code.startsWith("(function installHistoryProbe(")) installations++;
      if (code.includes("readingRenderCompletion===null")) checks++;
      return vm.runInContext(code, f.renderer);
    },
    sleep(milliseconds) { assert.equal(milliseconds, 50); return unavailable ? Promise.resolve() : render; },
    demand(name, condition) {
      assert.equal(name, "actual clean close retires only the second tab");
      assert.equal(condition, true);
    },
  });
  vm.runInContext(installedProbeSource +
    between(nativeHistorySource, "async function waitReady(", "\nasync function capture("), sender);
  const pending = vm.runInContext("(async()=>{\n" + source + "\n})()", sender);
  const outcome = pending.then(() => null, error => error);
  return {
    ...f, state, pending, outcome, installations: () => installations, checks: () => checks,
    publish() {
      state.heading = "Native history Alpha"; state.loading = false; state.available = !unavailable;
      f.renderer.readingDisplay.source.source = markdown; f.renderer.readingRenderCompletion = null;
      release();
    },
  };
}

test("the actual other-tab close sequence waits for surviving publication before installing its real probe", async () => {
  const f = survivorSequenceFixture();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.checks(), 1);
  assert.equal(f.installations(), 0);
  assert.equal(f.renderer.window.__readingHistoryNative, undefined);
  f.publish();
  assert.equal(await f.outcome, null);
  assert.equal(f.checks(), 2);
  assert.equal(f.installations(), 1);
  assert.equal(f.renderer.window.__readingHistoryNative.dispose(), true);
});

test("the actual survivor prerequisite rejects each wrong owner source DOM loading render and adapter state", async () => {
  for (const [name, change] of [
    ["owner", f => { f.state.active = { id: 99 }; }],
    ["path", f => { f.renderer.currentFilePath = "other.md"; }],
    ["source", f => { f.renderer.originalMarkdown = "# Other history Alpha"; }],
    ["displayed source", f => { f.renderer.readingDisplay.source.source = "# Other history Alpha"; }],
    ["heading", f => { f.state.heading = "Other history Alpha"; }],
    ["loading", f => { f.state.loading = true; }],
    ["render", f => { f.renderer.readingRenderCompletion = Promise.resolve(); }],
    ["adapter", f => { f.state.available = false; }],
  ]) {
    const f = survivorSequenceFixture();
    await new Promise(resolve => setImmediate(resolve));
    f.publish();
    change(f);
    await assert.rejects(f.pending, /Timed out waiting for prerequisite: surviving first tab final DOM after close/, name);
    assert.equal(f.checks(), 300, name);
    assert.equal(f.installations(), 0, name);
  }
});

for (const mutation of ["remove wait", "remove await"]) {
  test("the actual survivor sequence detects " + mutation + " before pending publication", async () => {
    const source = mutation === "remove wait" ?
      survivorSequenceSource.replace(survivorReadinessSource, "") :
      survivorSequenceSource.replace('  await waitReady("surviving first tab final DOM after close",',
        '  waitReady("surviving first tab final DOM after close",');
    assert.notEqual(source, survivorSequenceSource);
    const f = survivorSequenceFixture(source);
    assert.match((await f.outcome).message, /The production location adapter must be installed, not a substitute/);
    assert.equal(f.installations(), 1);
    assert.equal(f.renderer.window.__readingHistoryNative, undefined);
    f.publish();
    await new Promise(resolve => setImmediate(resolve));
  });
}

test("a genuinely unavailable surviving adapter still exhausts readiness and fails the unchanged installer guard", async () => {
  const f = survivorSequenceFixture(survivorSequenceSource, true);
  f.publish();
  await assert.rejects(f.pending, /Timed out waiting for prerequisite: surviving first tab final DOM after close/);
  assert.equal(f.checks(), 300);
  assert.equal(f.installations(), 0);
  await assert.rejects(injectActualProbe(f, probeInstallationSites[0], true),
    /The production location adapter must be installed, not a substitute/);
  assert.equal(f.renderer.window.__readingHistoryNative, undefined);
});

test("the source includes all seven real history-probe installations", () => {
  const companion = nativeHistorySource.slice(nativeHistorySource.indexOf("async function runPublicationProducers("));
  const companionSites = companion.split("\n").filter(line =>
    line.includes('await exec("(" + installHistoryProbe.toString()'));
  assert.equal(companionSites.length, 1, "the separate two-case producer companion reinstalls once");
  assert.equal(probeInstallationSites.length - companionSites.length, 7);
  assert.equal(probeInstallationSites.length, 8);
});

for (const [index, site] of probeInstallationSites.entries()) {
  test("actual injected release callbacks keep their local selector at installation " + index, async () => {
    const f = injectedReleaseFixture(), api = await injectActualProbe(f, site, true);
    assert.equal(api.remember("imported", f.sourcePoint), true);
    assert.equal(api.armIssuedBack(), true);
    assert.equal(f.renderer.scrollElementIntoView({}, "center", {}), f.handle);
    f.events.push("caller-returned");
    assert.deepEqual(f.events, ["native-issued", "real-back", "caller-returned"]);
    const result = await api.issuedBackResult();
    assert.equal(result.requestIssued, true);
    assert.equal(result.consumerContinuationNotYetReached, true);
    assert.equal(result.recovered, true);
    assert.equal(result.record, await f.handle.completion);
    const request = { term: "old-query", segment: { previewed: false } };
    f.renderer.searchInput.value = request.term;
    f.renderer.pendingSearchRequest = request;
    f.renderer.searchDebounceTimer = 1;
    assert.equal(api.armCanceledRequest(), true);
    f.fireInput({ isTrusted: true, target: f.renderer.searchInput });
    assert.equal(f.closes(), 1);
    f.renderer.searchInput.value = "different-arrived-query";
    f.renderer.searchMatches = [{}];
    const before = api.repairAndReplayCanceled();
    assert.equal(before.location, f.sourcePoint);
    assert.equal(before.jumps, 1);
    assert.equal(f.flushed(), request);
    assert.equal(f.events.length, 3);
    assert.equal(api.dispose(), true);
    assert.equal(f.renderer.scrollElementIntoView, f.realJump);
    assert.equal(f.renderer.readingHistoryControlState.core, f.realControls);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.inputListener(), null);
  });
  for (const dropArgument of [false, true]) {
    test("actual injected nonrelease guards refuse " + (dropArgument ? "an omitted argument" : "false") +
      " at installation " + index, async () => {
      const f = injectedReleaseFixture();
      const api = await injectActualProbe(f, site, dropArgument, { dropArgument });
      assert.throws(() => api.remember("point", f.sourcePoint), /Only the release route may import/);
      assert.throws(() => api.armIssuedBack(), /Only one release request-issued Back may be armed/);
      assert.throws(() => api.armCanceledRequest(), /release cancel listener must not overlap/);
      assert.equal(f.events.length, 0);
      assert.equal(f.inputListener(), null);
      assert.equal(f.closes(), 0);
      assert.equal(api.dispose(), true);
    });
  }
}

for (const [method, args] of [
  ["remember", ["point", { version: 1 }]], ["armIssuedBack", []], ["armCanceledRequest", []],
]) {
  test("the actual injected " + method + " regression reproduces the lost Node closure when reverted", async () => {
    const mutant = installedProbeSource.replace("function installHistoryProbe(releaseHistoryBatch = false)",
      "function installHistoryProbe()");
    assert.notEqual(mutant, installedProbeSource);
    const f = injectedReleaseFixture();
    const api = await injectActualProbe(f, probeInstallationSites[0], true, { source: mutant });
    assert.throws(() => api[method](...args),
      error => error.name === "ReferenceError" && /releaseHistoryBatch is not defined/.test(error.message));
    assert.equal(f.events.length, 0);
    assert.equal(f.inputListener(), null);
    assert.equal(api.dispose(), true);
  });
}

test("the release observer awaits the original real completion without replacing its record", async () => {
  const f = releaseProbeFixture();
  let release;
  const request = Promise.resolve({ interrupted: false });
  const completion = new Promise(resolve => { release = resolve; });
  f.jumps.push({ handle: { request, completion } });
  let finished = false;
  const waiting = f.api.releaseJump(0).then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false);
  const record = { status: "completed", scope: "request-offsets", travel: "observed-travel" };
  release(record);
  const observed = await waiting;
  assert.equal(observed.record, record);
  assert.equal(f.jumps[0].handle.request, request);
  assert.equal(f.jumps[0].handle.completion, completion);
});

test("release-only observations refuse a different tab owner before reading or acting", async () => {
  for (const [method, args] of [
    ["remember", ["point", { version: 1 }]], ["releaseCounts", []], ["releaseJump", [0]],
    ["armIssuedBack", []], ["issuedBackResult", []], ["armCanceledRequest", []],
    ["repairAndReplayCanceled", []], ["failedClippedJump", []],
  ]) {
    const f = releaseProbeFixture();
    f.state.owner = false;
    await assert.rejects(async () => f.api[method](...args), /actual production owner changed/);
    assert.equal(f.jumps.length, 0);
    assert.equal(f.context.issueHook, null);
    assert.equal(f.context.pendingListener, null);
  }
});

test("a late original release completion cannot certify a replacement tab", async () => {
  const f = releaseProbeFixture();
  let release;
  f.jumps.push({ handle: { request: Promise.resolve({ interrupted: false }),
    completion: new Promise(resolve => { release = resolve; }) } });
  const waiting = f.api.releaseJump(0);
  f.state.owner = false;
  release({ status: "completed", scope: "request-offsets", travel: "observed-travel" });
  await assert.rejects(waiting, /actual production owner changed/);
});

for (const missing of ["issued request", "original completion"]) {
  test("the release observer refuses a missing " + missing, async () => {
    const f = releaseProbeFixture();
    f.jumps.push({ handle: missing === "issued request" ? { completion: Promise.resolve({}) } :
      { request: Promise.resolve({ interrupted: false }) } });
    await assert.rejects(f.api.releaseJump(0), /actual native request and its original completion/);
  });
}

function requestIssuedFixture(record, recovered = true) {
  const f = releaseProbeFixture(), events = [];
  const handle = { request: Promise.resolve({ interrupted: false }), completion: Promise.resolve(record) };
  f.context.realJump = () => { events.push("native-issued"); return handle; };
  f.context.realControls.navigate = direction => {
    assert.equal(direction, -1); events.push("real-back"); return Promise.resolve(recovered);
  };
  f.context.document.getElementById = id => {
    assert.equal(id, "readingBackBtn");
    return { disabled: false, click() { f.context.controlsState.core.navigate(-1); } };
  };
  vm.runInContext(between(nativeHistorySource, "  const observedJump = function", "\n  const onDown ="), f.context);
  return { ...f, events, handle };
}

test("request-issued Back runs synchronously after the genuine call and preserves its identical handle", async () => {
  const f = requestIssuedFixture({ status: "unrecordable", reason: "superseded" });
  f.api.armIssuedBack();
  const returned = f.context.scrollElementIntoView(f.target, "center", {});
  f.events.push("caller-returned");
  assert.equal(returned, f.handle);
  assert.deepEqual(f.events, ["native-issued", "real-back", "caller-returned"]);
  const observation = await f.api.issuedBackResult();
  assert.equal(observation.requestIssued, true);
  assert.equal(observation.consumerContinuationNotYetReached, true);
  assert.equal(observation.recovered, true);
  assert.equal(f.context.issuedBack, null);
});

for (const [name, record, recovered] of [
  ["already accepted preview", { status: "completed", scope: "request-offsets", travel: "observed-travel" }, true],
  ["wrong refusal reason", { status: "unrecordable", reason: "document-changed" }, true],
  ["failed recovery", { status: "unrecordable", reason: "superseded" }, false],
]) {
  test("request-issued recovery refuses " + name, async () => {
    const f = requestIssuedFixture(record, recovered);
    f.api.armIssuedBack();
    f.context.scrollElementIntoView(f.target, "center", {});
    await assert.rejects(f.api.issuedBackResult(), /supersede the actual preview completion/);
  });
}

function cancelReleaseFixture() {
  const f = releaseProbeFixture();
  let listener, closes = 0;
  f.context.searchInput.value = "old-term";
  f.context.searchInput.addEventListener = (name, callback, options) => {
    assert.equal(name, "input"); assert.equal(options.once, true); listener = callback;
  };
  const request = { term: "old-term", segment: { previewed: false } };
  f.context.pendingSearchRequest = request;
  f.context.searchDebounceTimer = 1;
  f.context.searchCloseBtn = { click() { closes++; } };
  f.api.armCanceledRequest();
  return { ...f, request, fire: event => listener(event), closes: () => closes };
}

test("the canceled-request observer retains the exact request from genuine first input", () => {
  const f = cancelReleaseFixture();
  f.fire({ isTrusted: true, target: f.context.searchInput });
  assert.equal(f.context.canceledRequest, f.request);
  assert.equal(f.closes(), 1);
});

for (const bad of ["untrusted", "different target", "different term", "missing timer", "already previewed"]) {
  test("the canceled-request observer refuses " + bad + " setup", () => {
    const f = cancelReleaseFixture();
    const event = { isTrusted: true, target: f.context.searchInput };
    if (bad === "untrusted") event.isTrusted = false;
    if (bad === "different target") event.target = {};
    if (bad === "different term") f.request.term = "different";
    if (bad === "missing timer") f.context.searchDebounceTimer = null;
    if (bad === "already previewed") f.request.segment.previewed = true;
    assert.throws(() => f.fire(event), /genuine first input/);
    assert.equal(f.closes(), 0);
    assert.equal(f.context.canceledRequest, null);
  });
}

for (const corrupt of [false, true]) {
  test("highlight repair " + (corrupt ? "rejects a borrowed stale intent" : "uses the exact canceled request without a navigation intent"), () => {
    const f = cancelReleaseFixture();
    f.fire({ isTrusted: true, target: f.context.searchInput });
    Object.assign(f.context, {
      pendingSearchRequest: null, pendingSearchTerm: null, searchDebounceTimer: null,
      searchMatches: [{}], readingViewport: { capturePermit: () => "actual-permit" },
      flushPendingSearch(intent, request) {
        assert.equal(intent, null); assert.equal(request, f.request);
      },
      resyncSearchAfterRender(permit) {
        assert.equal(permit, "actual-permit");
        f.context.pendingSearchRequest = { intent: corrupt ? {} : null, segment: null };
      },
    });
    f.context.searchInput.value = "different-arrived-term";
    if (corrupt) assert.throws(() => f.api.repairAndReplayCanceled(), /must not borrow/);
    else {
      const before = f.api.repairAndReplayCanceled();
      assert.equal(before.jumps, 0);
      assert.equal(before.location, f.state.source);
    }
  });
}

function chooserGuardFixture(sequence) {
  const window = {}, options = { properties: ["openFile", "multiSelections"], filters: ["exact fixture filters"] };
  const context = vm.createContext({
    method: "showOpenDialog", observedMain: window, chooserOptions: options,
    chooserAllowance: null, chooserCalls: 0, chooserSequence: sequence,
    liveMain: () => true, guardsIntact: () => true,
    isDeepStrictEqual: require("util").isDeepStrictEqual,
    fatal(error) { throw error; },
  });
  vm.runInContext(between(nativeHistorySource, '  const guard = method === "showOpenDialog"',
    "\n  guards[method] = guard;"), context);
  const guard = vm.runInContext("guard", context);
  return { context, guard, window, options, arm(file) {
    const allowance = { window, fixture: file, consumed: false };
    context.chooserAllowance = allowance;
    return allowance;
  } };
}

for (const sequence of [["first"], ["first", "second", "first"]]) {
  test("the actual native chooser consumes only its exact " + sequence.length + "-open itinerary", async () => {
    const f = chooserGuardFixture(sequence);
    for (const file of sequence) {
      const allowance = f.arm(file);
      const response = await f.guard(f.window, f.options);
      assert.equal(allowance.consumed, true);
      assert.equal(f.context.chooserAllowance, null);
      assert.deepEqual(Array.from(response.filePaths), [file]);
      assert.equal(response.canceled, false);
    }
    assert.equal(f.context.chooserCalls, sequence.length);
    f.arm("first");
    assert.throws(() => f.guard(f.window, f.options), /Unexpected native chooser/);
    assert.equal(f.context.chooserCalls, sequence.length);
  });
}

for (const bad of ["wrong file", "wrong window", "wrong options", "extra argument", "consumed allowance", "dead owner", "changed guards"]) {
  test("the actual bounded chooser refuses " + bad, () => {
    const f = chooserGuardFixture(["first", "second", "first"]);
    const allowance = f.arm("first"), args = [f.window, f.options];
    if (bad === "wrong file") allowance.fixture = "second";
    if (bad === "wrong window") args[0] = {};
    if (bad === "wrong options") args[1] = { properties: ["openFile"] };
    if (bad === "extra argument") args.push("extra");
    if (bad === "consumed allowance") allowance.consumed = true;
    if (bad === "dead owner") f.context.liveMain = () => false;
    if (bad === "changed guards") f.context.guardsIntact = () => false;
    assert.throws(() => f.guard(...args), /Unexpected native chooser/);
    assert.equal(f.context.chooserCalls, 0);
    assert.equal(f.context.chooserAllowance, null);
  });
}

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      passed++;
      console.log("PASS " + name);
    } catch (error) {
      console.log("FAIL " + name + "  -> " + JSON.stringify(error.message));
    }
  }
  console.log(`=== ${passed}/${tests.length} passed ===`);
  process.exitCode = passed === tests.length ? 0 : 1;
})();
