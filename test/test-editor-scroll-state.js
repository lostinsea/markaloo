"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "..", "src", "editor-scroll.js"), "utf8");
const companion = process.argv[2] === "--companion";
if (process.argv.length !== (companion ? 3 : 2))
  throw new Error("Usage: node test-editor-scroll-state.js [--companion]");
const output = message => console.log((companion ? "[companion stdout] " : "") + message);

class Pane {
  constructor(parentElement = null) {
    this.parentElement = parentElement;
    this.scrollTop = 100;
    this.scrollHeight = 1000;
    this.clientHeight = 100;
    this.value = "# Wheel";
    this.style = { overflowY: "auto", overscrollBehaviorY: "auto" };
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type, options = {}) {
    const event = { target: this, deltaX: 0, deltaY: 70, ...options };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

function fixture() {
  let now = 0, selection = 1, active = true, frozen = false, frame = 0;
  const editor = new Pane(), preview = new Pane(), nested = new Pane(preview);
  class Observer { observe() {} disconnect() {} }
  const context = vm.createContext({
    window: { dispatchEvent() {} }, document: { fonts: { addEventListener() {} } },
    Element: Pane, Event: class {}, ResizeObserver: Observer, MutationObserver: Observer,
    crypto: require("crypto"), performance: { now: () => now },
    getComputedStyle: element => element.style,
    // Ownership is synchronous; native geometry and follower writes run in the Electron suite.
    requestAnimationFrame: () => ++frame, cancelAnimationFrame() {},
  });
  vm.runInContext(source, context);
  const controller = context.window.createEditorScroll({
    editor, preview, active: () => active, frozen: () => frozen,
    identity: () => selection, scale: () => 1,
  });
  const commit = () => controller.commit(controller.source(editor.value), { textPending: true });
  commit();
  editor.emit("wheel");
  return {
    editor, preview, nested, controller, commit,
    wheel: options => preview.emit("wheel", { target: nested, ...options }),
    travel: (delta = 70) => { preview.scrollTop += delta; preview.emit("scroll"); },
    owner: () => controller.diagnostics().owner,
    advance: milliseconds => { now += milliseconds; },
    changeIdentity: () => { selection++; },
    setActive: value => { active = value; }, setFrozen: value => { frozen = value; },
  };
}

let passed = 0, total = 0;
function test(name, run) {
  total++;
  const f = fixture();
  try {
    run(f);
    passed++;
    output("PASS " + name);
  } catch (error) {
    output("FAIL " + name + "  -> " + error.message);
  } finally { f.controller.leave(); }
}

test("nested input alone does not transfer outer ownership", f => {
  f.wheel();
  f.nested.scrollTop += 70;
  f.preview.emit("scroll", { target: f.nested });
  assert.equal(f.owner(), "editor");
});
test("actual same-direction nested chaining transfers outer ownership", f => {
  f.wheel(); f.advance(30); f.travel();
  assert.equal(f.owner(), "preview");
});
test("opposite outer travel cannot consume nested intent", f => {
  f.wheel(); f.travel(-70);
  assert.equal(f.owner(), "editor");
});
test("expired nested input cannot own later outer travel", f => {
  f.wheel(); f.advance(251); f.travel();
  assert.equal(f.owner(), "editor");
});
for (const behavior of ["contain", "none"]) test("nested " + behavior + " cannot authorize outer ownership", f => {
  f.nested.style.overscrollBehaviorY = behavior;
  f.wheel(); f.travel();
  assert.equal(f.owner(), "editor");
});
for (const options of [{ ctrlKey: true }, { metaKey: true }, { defaultPrevented: true },
  { deltaX: 90, deltaY: 20 }, { deltaY: 0 }]) {
  test("ineligible nested wheel stays independent " + JSON.stringify(options), f => {
    f.wheel(); f.wheel(options); f.travel();
    assert.equal(f.owner(), "editor");
  });
}
for (const input of ["wheel", "pointerdown", "keydown"]) test("newer " + input + " retires nested intent", f => {
  f.wheel();
  if (input === "wheel") f.editor.emit(input);
  else f.preview.emit(input, { target: f.nested, key: "a" });
  f.travel();
  assert.equal(f.owner(), "editor");
});
test("explicit preview navigation retires a delayed editor chain", f => {
  f.controller.previewNavigation();
  f.editor.emit("wheel", { target: new Pane(f.editor) });
  f.controller.previewNavigation();
  f.editor.scrollTop += 70; f.editor.emit("scroll");
  assert.equal(f.owner(), "preview");
});
for (const lifecycle of ["start", "invalidate", "changed"]) {
  test(lifecycle + " prevents stale nested ownership", f => {
    f.wheel(); f.controller[lifecycle](); f.travel();
    assert.equal(f.owner(), "editor");
  });
}
test("reset clears the document and queued nested ownership", f => {
  f.wheel(); f.controller.reset(); f.travel();
  assert.equal(f.owner(), null);
});
test("a replacement render retires same-document nested input", f => {
  f.wheel(); f.commit(); f.travel();
  assert.equal(f.owner(), "editor");
});
test("a stale document identity cannot consume nested input", f => {
  f.wheel(); f.changeIdentity(); f.travel();
  assert.equal(f.owner(), "editor");
});
for (const state of ["Active", "Frozen"]) test("unusable " + state + " input is retired before recovery", f => {
  f.wheel(); f["set" + state](state === "Frozen"); f.travel();
  f["set" + state](state !== "Frozen"); f.travel();
  assert.equal(f.owner(), "editor");
});
test("leaving and reentering the editor retires nested input", f => {
  f.controller.previewNavigation();
  f.editor.emit("wheel", { target: new Pane(f.editor) });
  f.controller.leave(); f.controller.enter();
  f.editor.scrollTop += 70; f.editor.emit("scroll");
  assert.equal(f.owner(), "preview");
});
output(`=== ${passed}/${total} passed ===`);
process.exitCode = passed === total ? 0 : 1;
