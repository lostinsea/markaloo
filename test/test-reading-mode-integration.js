"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
const editorFixture = fs.readFileSync(path.join(__dirname, "test-document-editor.js"), "utf8");
const landmarks = fs.readFileSync(path.join(__dirname, "test-reading-landmarks.js"), "utf8");
const helpers = { exports: {} };
vm.runInNewContext(landmarks.slice(0, landmarks.indexOf("let passed = 0")) +
  "\nmodule.exports = { fixture, walk, Box, Text };", { require, __dirname, module: helpers, console });
const { fixture, walk, Box, Text } = helpers.exports;
function declaration(name, source = renderer) {
  const start = source.indexOf("function " + name + "(");
  const end = source.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start, name);
  return (source.slice(start - 6, start) === "async " ? "async " : "") + source.slice(start, end + 2);
}
function integration(text = "A sufficiently long ordinary reading paragraph.", { modeTransform = source => source } = {}) {
  const f = fixture({ rendererCallbacks: true }), s = f.sandbox;
  const tab = { id: 1, content: text, originalContent: text }, events = [], writes = [];
  let admittedText = text, admittedKey = 1;
  let intent = {}, permit = {}, currentTab = tab, layoutShift = 0;
  const viewport = {
    beginIntent() { intent = {}; permit = {}; return intent; },
    isIntentCurrent: value => value === intent,
    invalidate() { permit = {}; },
    capturePermit: () => permit,
    beginRequest() { permit = {}; return permit; },
    isPermitCurrent: value => value === permit,
  };
  s.window.CustomTabs = { getActiveTab: () => currentTab,
    admitReadingSource(owner, source) {
      if (owner !== tab || source.source !== tab.content) return null;
      if (source.source !== admittedText) { admittedText = source.source; admittedKey++; }
      return "controlled-cache-" + admittedKey;
    },
    snapshotExactEditorContent: () => tab.content,
    updateTabContent(value) { tab.content = value; } };
  s.window.dispatchEvent = event => events.push(event.type);
  Object.assign(s, { editorScroll: { ...f.controller, enter: () => true, leave() {} },
    viewer: f.preview,
    fileOpenSequence: 7, renderGeneration: 1, readingViewport: viewport,
    getViewerScroller: () => s.isEditMode ? f.preview : f.body,
    scrollerScale: () => 1, frozenForShutdown: () => false, isEditMode: false,
    console, Promise, setTimeout, clearTimeout, Event: class { constructor(type) { this.type = type; } } });
  vm.runInContext(modeTransform(renderer.slice(renderer.indexOf("let readingDisplay = null;"),
    renderer.indexOf("const editorScroll = window.createEditorScroll("))), s);
  const diagnosticsStart = renderer.indexOf("window.getEditorScrollDiagnostics = ");
  const diagnosticsEnd = renderer.indexOf(";", diagnosticsStart);
  assert.ok(diagnosticsStart >= 0 && diagnosticsEnd > diagnosticsStart, "the actual diagnostic facade is present");
  vm.runInContext(renderer.slice(diagnosticsStart, diagnosticsEnd + 1), s);
  const patch = declaration("patchViewerDOM"), patchEnd = patch.indexOf("  noteViewerMutation();");
  assert.ok(patchEnd > 0);
  vm.runInContext(patch.slice(0, patchEnd) + "\n}", s);
  f.body.style.overflowY = "auto";
  f.preview.style.overflowY = "visible";
  const outer = () => s.getViewerScroller();
  function geometry(rendered) {
    for (const node of walk(f.preview)) node.geometry = from => {
      const owner = node.parentElement.closest("pre");
      return [f.rect(20 + from * 8 - outer().scrollLeft - (owner?.scrollLeft || 0),
        10 + layoutShift - outer().scrollTop - (owner?.scrollTop || 0))];
    };
    for (const pre of f.preview.querySelectorAll("pre")) {
      pre.style.overflowY = pre.style.overflowX = "auto";
      pre.getBoundingClientRect = () => f.rect(0, -outer().scrollTop, 100, 100);
    }
    return rendered;
  }
  function publish(value = tab.content, { modeReading = null, permit = viewport.capturePermit(), finalize = true } = {}) {
    let admission;
    const rendered = geometry(f.render(value, { beforeReplace(source) {
      admission = s.captureReadingAdmission(source, s.renderGeneration);
      s.patchViewerDOM(null, source, permit, admission, modeReading);
    } }));
    const associations = rendered.associations.map(pair =>
      s.readingBodyAssociation(pair.fresh, pair.body, rendered.bindings));
    s.admitReadingPresentation(rendered.mapped, associations, admission);
    if (finalize) assert.equal(s.publishReadingPresentation(rendered.mapped), true, "actual final producer binding publishes");
    api.decorate?.(rendered);
    for (const target of [f.body, f.preview, ...f.preview.querySelectorAll("pre"), ...f.preview.querySelectorAll("table")]) {
      target.scrollTo = request => {
        writes.push({ target, request });
        target.scrollTop = Math.max(0, Math.min(400, request.top));
        target.scrollLeft = Math.max(0, request.left);
        return api.nativeCompletion ? api.nativeCompletion() : Promise.resolve({ interrupted: false });
      };
    }
    return rendered;
  }
  const api = { f, s, tab, events, writes, viewport, publish, nativeCompletion: null,
    shift(value) { layoutShift = value; },
    replaceTab() { currentTab = { ...tab }; viewport.invalidate(); },
    capture() { return s.window.readingLocationAdapter.capture(); },
    restore(location, ticket = viewport.beginIntent()) { return s.window.readingLocationAdapter.restore(location, ticket); },
  };
  api.rendered = publish();
  return api;
}
function installMode(a) {
  const { f, s, tab } = a, button = () => ({ disabled: false, style: {}, setAttribute() {} });
  Object.defineProperty(f.body, "classList", { value: { toggle(_name, open) {
    f.preview.style.overflowY = open ? "auto" : "visible";
    f.body.style.overflowY = open ? "hidden" : "auto";
    a.shift(open ? 60 : 0);
  } } });
  Object.assign(s, {
    mayMutateRendererDocument: () => true, currentDocumentActionOwner: () => tab,
    fileMenu: { classList: { remove() {} } }, editorModeRevision: 0, editorExitOperation: null,
    currentSaveDocumentIdentity: () => ({ documentGeneration: 1 }),
    currentFilePath: "a.md", originalMarkdown: tab.content, markdownEditor: f.editor,
    hasUnsavedChanges: false, pendingSaveFor: () => null, hasPendingSaveFor: () => false,
    confirmUnsavedAction: async () => ({ approved: true, isCurrent: () => true }), i18n: value => value,
    hideDocumentContextMenus() {}, tableColumnSizing: { cancel() {} }, tableCellSession: null,
    contentWrapper: f.body, refreshBtn: button(), toggleEditBtn: button(), openEditorBtn: button(),
    updateEditorHistoryControls() {}, applyTableBreakout() {},
    captureEditSessionBaseline() { s.editSessionBaseline = { document: s.originalMarkdown, history: [], dirty: false }; },
    setDocumentDirtyState(value) { s.hasUnsavedChanges = value; },
    saveFailedFor: () => false, reloadConflictFor: () => false,
    retainCurrentDocumentEditor() {}, previewDebounceTimer: null,
    cancelEditorDeferredWork() { s.previewDebounceTimer = null; },
    historyRestore() {}, assertFileTrackingOwnership() {}, editSessionBaseline: null,
    async renderMarkdown(value, _force, options) {
      const permit = a.viewport.capturePermit();
      s.renderGeneration++;
      tab.content = value; a.publish(value, { permit, modeReading: options?.modeReading || null });
    },
  });
  f.editor.value = tab.content;
  vm.runInContext(declaration("setEditorPresentation"), s);
  assert.equal(typeof s.window.changeCurrentDocumentEditor, "function", "the actual mode closure exports its consumer");
  s.changeCurrentDocumentEditor = s.window.changeCurrentDocumentEditor;
}
function focusModeAtom(a) {
  for (const node of walk(a.f.preview)) node.geometry = () => [];
  const node = walk(a.f.preview).find(node => node.data.includes("Z"));
  assert.ok(node, "a real Source text atom is present");
  const index = node.data.indexOf("Z");
  node.geometry = at => [at === index ? a.f.rect(10, 10) : a.f.rect(250, -100)];
}
function installModeDispatcher(a, { light = false, hold = false } = {}) {
  const { s, tab } = a;
  let started;
  a.targetStarted = new Promise(resolve => { started = resolve; });
  s._lastRenderedContent = tab.content;
  s.tableColumnSizing.reset = () => {};
  s.detectRenderMode = () => light ? "light-format" : "full";
  a.targets = [];
  const target = (value, generation, permit, preservePosition, modeReading, initialReady) => {
    assert.equal(generation, s.renderGeneration);
    if (!light && modeReading) assert.equal(preservePosition, true, "the actual mode render suppresses the top reset");
    tab.content = value;
    const rendered = a.publish(value, { modeReading, permit, finalize: !hold });
    a.targets.push({ generation, key: s.readingSourceIdentity(rendered.mapped) });
    initialReady?.();
    if (hold) return new Promise(resolve => {
      a.releaseTarget = () => { s.publishReadingPresentation(rendered.mapped); resolve(); };
      started();
    });
    return Promise.resolve();
  };
  s.renderMarkdownFull = target;
  s.renderLightFormat = (value, generation, permit, modeReading) => target(value, generation, permit, true, modeReading);
  vm.runInContext(declaration("renderMarkdown"), s);
}
const cases = [];
function test(name, run) { cases.push([name, run]); }
test("real producer and Source capture displayed X while pending cache/editor Y differs", () => {
  const a = integration(), initial = a.capture();
  assert.equal(initial.status, "captured");
  a.tab.content = "Pending Y"; a.f.editor.value = "Other pending editor text";
  assert.equal(a.capture().location.text.sourceKey, initial.location.text.sourceKey);
  assert.equal(a.s.window.readingLocationAdapter.available(), true);
  assert.ok(a.events.includes("reading-location-availability-changed"));
  const before = a.f.metrics.ranges;
  a.s.window.readingLocationAdapter.available();
  assert.equal(a.f.metrics.ranges, before, "availability performs no Range work");
});
test("actual heading and Prism producers publish mixed formatted, code and table Source bodies", () => {
  const a = integration("# Heading\n\nA **formatted** paragraph.\n\n```\ncode\n```\n\n| H |\n| --- |\n| cell |\n");
  const { f, s } = a, heading = f.preview.querySelector("h1"), code = f.preview.querySelector("code");
  Object.defineProperty(heading, "id", { get: () => heading.getAttribute("id"),
    set: value => heading.setAttribute("id", value) });
  f.doc.getElementById = id => f.preview.querySelectorAll("*").find(node => node.getAttribute("id") === id) || null;
  Object.defineProperty(code, "classList", { value: { add(name) { code.setAttribute("class", name); } } });
  f.doc.querySelectorAll = selector => {
    assert.equal(selector, "pre code:not(.prism-highlighted)");
    return [code];
  };
  s.Prism = { highlightElement(element) {
    const span = new Box("SPAN", [...element.childNodes]);
    element.childNodes = []; element.append(span);
    element.parentNode.setAttribute("tabindex", "0");
  } };
  for (const name of ["slugifyHeading", "assignHeadingIds", "highlightNewElements"])
    vm.runInContext(declaration(name), s);
  s.assignHeadingIds([heading]); s.highlightNewElements(); s.refreshReadingPresentation();
  assert.equal(heading.getAttribute("id"), "heading");
  assert.equal(code.querySelectorAll("span").length, 1, "the real producer sees actual replaced Prism DOM");
  for (const [selector, kind] of [["h1", "text"], ["strong", "text"], ["code", "code"], ["td", "table"]]) {
    for (const node of walk(f.preview)) node.geometry = () => [];
    walk(f.preview.querySelector(selector))[0].geometry = from => [f.rect(10 + from * 8, 10)];
    const result = a.capture();
    assert.equal(result.status, "captured", selector);
    assert.equal(result.location.text.runKind, kind, selector);
  }
});
test("the actual Notes visibility producer republishes without reviving an old viewport permit", () => {
  const a = integration(), { f, s } = a;
  let toggle;
  Object.defineProperty(f.preview, "classList", { value: { toggle(name, enabled) {
    if (enabled) f.preview.setAttribute("class", name); else f.preview.removeAttribute("class");
  } } });
  Object.assign(s, { notesVisible: true,
    showNotesToggle: { addEventListener(_type, callback) { toggle = callback; }, classList: { toggle() {} } },
    localStorage: { setItem() {} }, noteTooltip: { style: {}, classList: { remove() {} } },
  });
  vm.runInContext(renderer.slice(renderer.indexOf("showNotesToggle.addEventListener('click'"),
    renderer.indexOf("// Update showNotesToggle visibility")), s);
  const saved = a.capture().location, permit = a.viewport.capturePermit();
  toggle({ stopPropagation() {} });
  assert.equal(a.viewport.isPermitCurrent(permit), false);
  assert.equal(s.window.readingLocationAdapter.available(), true);
  assert.equal(a.capture().location.text.sourceKey, saved.text.sourceKey);
  f.preview.setAttribute("class", "unexplained-mutation");
  assert.equal(a.capture().status, "unavailable");
  assert.equal(s.window.readingLocationAdapter.available(), false, "refused publication cannot advertise stale readiness");
  toggle({ stopPropagation() {} });
  assert.equal(a.capture().status, "captured", "a real final producer can explicitly bind again");
});
test("actual adapter restores inner-only travel and both horizontal axes", async () => {
  const a = integration("```\ncode\n```"), pre = a.f.preview.querySelectorAll("pre")[0];
  const before = a.capture();
  assert.equal(before.status, "captured");
  assert.equal(before.location.text.alignment.nested.length, 1);
  a.shift(30); pre.scrollLeft = 8; a.f.body.scrollLeft = 9;
  const result = await a.restore(before.location);
  assert.equal(result.status, "completed");
  assert.equal(result.travel, "observed-travel");
  assert.equal(pre.scrollTop, 30);
  assert.equal(a.f.body.scrollTop, 0, "inner-only movement is not mistaken for zero travel");
  assert.equal(pre.scrollLeft, 0); assert.equal(a.f.body.scrollLeft, 0);
  assert.ok(a.writes.every(write => write.request.behavior === "instant"));
  assert.equal((await a.restore(before.location)).travel, "no-observed-travel");
});
test("horizontal-only nested code remains in the complete restore chain", async () => {
  const a = integration("```\ncode\n```"), pre = a.f.preview.querySelectorAll("pre")[0];
  pre.scrollHeight = pre.clientHeight;
  pre.scrollWidth = 300;
  const before = a.capture();
  assert.equal(before.status, "captured");
  assert.equal(before.location.text.alignment.nested.length, 1, "horizontal overflow really owns a nested descriptor");
  pre.scrollLeft = 10;
  const result = await a.restore(before.location);
  assert.equal(result.status, "completed");
  assert.equal(result.travel, "observed-travel");
  assert.equal(pre.scrollLeft, 0);
  assert.equal(pre.scrollTop, 0);
});
test("rewrap may create overflow without changing the authenticated nested chain", async () => {
  const a = integration("```\ncode\n```"), pre = a.f.preview.querySelectorAll("pre")[0];
  pre.scrollHeight = pre.clientHeight; pre.scrollWidth = pre.clientWidth;
  const before = a.capture();
  assert.equal(before.status, "captured");
  assert.equal(before.location.text.alignment.nested.length, 1, "the current source-backed auto scroller is retained even while its text fits");
  pre.clientWidth = 30; pre.scrollWidth = 100;
  assert.equal((await a.restore(before.location)).status, "completed");
});
test("native completion cannot replace a moved target with a newly valid receipt", async () => {
  const a = integration(), saved = a.capture().location;
  let release;
  a.nativeCompletion = () => new Promise(resolve => { release = resolve; });
  const restoring = a.restore(saved);
  assert.equal(typeof release, "function", "the exact request is still in flight");
  a.shift(50);
  release({ interrupted: false });
  const result = await restoring;
  assert.equal(result.status, "unrecordable");
  assert.equal(result.reason, "target-geometry-changed");
});
for (const [phase, failAt] of [["pre-write", 1], ["post-write-completion", 2], ["final", 3]]) {
  test("restore diagnostics retain the existing failed guard without reevaluation: " + phase, async () => {
    const a = integration(), saved = a.capture().location;
    const original = a.s.editorScroll.isTextLocationCurrent;
    let checks = 0;
    a.s.editorScroll.isTextLocationCurrent = receipt => ++checks === failAt ? false : original(receipt);
    const result = await a.restore(saved);
    assert.equal(result.status, "unrecordable");
    assert.equal(result.reason, "target-geometry-changed");
    assert.equal(checks, failAt, "diagnostics never repeat the failed currentness predicate");
    const record = a.s.window.getEditorScrollDiagnostics().lastReadingRestoreFailure;
    assert.equal(JSON.stringify(record), JSON.stringify(phase === "pre-write"
      ? { phase, index: 0, rectCount: 1 } : { phase, index: phase === "final" ? null : 0, resolutionStatus: "resolved" }));
    assert.ok(Object.isFrozen(record));
    assert.ok(Object.values(record).every(value => value === null || ["string", "number"].includes(typeof value)));
    assert.equal((await a.restore(null)).reason, "invalid-reading-location");
    assert.equal(a.s.window.getEditorScrollDiagnostics().lastReadingRestoreFailure, null, "every restore entry clears stale detail");
    assert.equal((await a.restore(saved)).status, "completed");
    assert.equal(a.s.window.getEditorScrollDiagnostics().lastReadingRestoreFailure, null);
  });
}
test("restore diagnostic preserves the rectangle guard's short circuit", async () => {
  const a = integration(), saved = a.capture().location, original = a.s.editorScroll.resolveVisibleText;
  a.s.editorScroll.resolveVisibleText = (...args) => {
    const result = original(...args);
    result.receipt.range.getClientRects = () => [];
    return result;
  };
  a.s.editorScroll.isTextLocationCurrent = () => { throw new Error("the rectangle guard must short-circuit"); };
  assert.equal((await a.restore(saved)).reason, "target-geometry-changed");
  assert.equal(JSON.stringify(a.s.window.getEditorScrollDiagnostics().lastReadingRestoreFailure),
    JSON.stringify({ phase: "pre-write", index: 0, rectCount: 0 }));
  assert.equal(a.writes.length, 0);
});
test("outer completion checks previously restored inner offsets too", async () => {
  const a = integration("```\ncode\n```"), pre = a.f.preview.querySelectorAll("pre")[0];
  const saved = a.capture().location;
  let release;
  a.nativeCompletion = () => a.writes.length === 1 ? Promise.resolve({ interrupted: false }) :
    new Promise(resolve => { release = resolve; });
  const restoring = a.restore(saved);
  await new Promise(setImmediate);
  assert.equal(typeof release, "function", "the outer request follows actual inner completion");
  pre.scrollLeft = 1;
  release({ interrupted: false });
  assert.equal((await restoring).reason, "target-geometry-changed");
  assert.equal(a.s.window.getEditorScrollDiagnostics().lastReadingRestoreFailure.index, 1);
});
for (const failure of ["missing", "malformed", "interrupted", "rejected", "input", "render", "tab"]) {
  test("actual adapter refuses native completion/currentness failure: " + failure, async () => {
    const a = integration(), saved = a.capture().location;
    a.shift(30);
    a.nativeCompletion = () => {
      if (failure === "missing") return undefined;
      if (failure === "malformed") return Promise.resolve({});
      if (failure === "interrupted") return Promise.resolve({ interrupted: true });
      if (failure === "rejected") return Promise.reject(new Error("test rejection"));
      if (failure === "input") a.viewport.beginIntent();
      if (failure === "render") a.viewport.invalidate();
      if (failure === "tab") a.replaceTab();
      return Promise.resolve({ interrupted: false });
    };
    assert.equal((await a.restore(saved)).status, "unrecordable");
    const writes = a.writes.length, stale = a.viewport.beginIntent();
    a.viewport.beginIntent();
    assert.equal((await a.restore(saved, stale)).status, "unrecordable");
    assert.equal(a.writes.length, writes, "stale intent never receives renewed write authority");
  });
}
test("actual enter/leave modes restore a text landmark across Reader/Split rewrap", async () => {
  const a = integration(); installMode(a);
  const { s, f } = a;
  f.editor.selectionStart = 3; f.editor.selectionEnd = 8; f.editor.scrollLeft = 17;
  f.body.scrollLeft = 2; f.preview.scrollLeft = 3;
  const source = f.editor.value;
  await s.changeCurrentDocumentEditor(true);
  assert.equal(s.isEditMode, true);
  assert.equal(f.preview.scrollTop, 60, "Split rewrap restores the actual text point");
  assert.equal(f.editor.value, source);
  assert.equal(f.editor.selectionStart, 3); assert.equal(f.editor.selectionEnd, 8);
  assert.equal(f.editor.scrollLeft, 17);
  assert.equal(f.body.scrollLeft, 2); assert.equal(f.preview.scrollLeft, 3);
  f.preview.scrollTop = 55;
  await s.changeCurrentDocumentEditor(false);
  assert.equal(s.isEditMode, false);
  assert.equal(f.body.scrollTop, 0);
  assert.equal(f.body.scrollLeft, 2); assert.equal(f.preview.scrollLeft, 3);
});
test("mode exit captures after both the save wait and discard confirmation", async () => {
  const a = integration(); installMode(a); const { s } = a;
  await s.changeCurrentDocumentEditor(true);
  s.hasUnsavedChanges = true;
  let settle;
  s.pendingSaveFor = () => new Promise(resolve => { settle = resolve; });
  s.confirmUnsavedAction = async () => {
    a.f.preview.scrollTop = 35;
    return { approved: true, isCurrent: () => true };
  };
  const leaving = s.changeCurrentDocumentEditor(false);
  a.f.preview.scrollTop = 20;
  settle(); await leaving;
  const outerWrite = a.writes.filter(write => write.target === a.f.body).at(-1);
  assert.ok(outerWrite, "discard really rendered and restored");
  assert.equal(outerWrite.request.top, -25, "capture used the final exit position, not the pre-wait position");
});
test("layout-only mode changes keep the current nested horizontal offset", async () => {
  const a = integration("```\ncode\n```"); installMode(a);
  const pre = a.f.preview.querySelector("pre"), toggle = a.f.body.classList.toggle;
  pre.scrollWidth = 500; pre.scrollLeft = 23;
  a.f.body.classList.toggle = (...args) => { toggle(...args); pre.scrollLeft = 41; };
  await a.s.changeCurrentDocumentEditor(true);
  assert.equal(a.f.preview.querySelector("pre"), pre, "layout-only entry retains the actual owner");
  assert.equal(pre.scrollLeft, 41, "Discard-only policy cannot replace the destination's current offset");
});
for (const kind of ["code", "table"]) for (const pending of [false, true])
test("later Discard maps displayed " + kind + " Source, pending textarea=" + pending, async () => {
  const text = "p".repeat(80) + "Z" + "s".repeat(50);
  const baseline = kind === "code" ? "```\n" + text + "\n```" : "| H |\n| --- |\n| " + text + " |\n";
  const edited = baseline.replace(text, text.slice(0, 10) + "unique-prefix!" + text.slice(10));
  const a = integration(baseline); installMode(a); const { s, f } = a;
  await s.changeCurrentDocumentEditor(true);
  f.preview.scrollTop = 0;
  a.decorate = () => {
    if (kind === "table") f.preview.querySelector("table").style.overflowY = "auto";
    f.preview.querySelector(kind === "code" ? "pre" : "table").scrollWidth = 500;
    focusModeAtom(a);
  };
  a.tab.content = f.editor.value = edited;
  a.publish(edited); s.hasUnsavedChanges = true;
  const nested = f.preview.querySelector(kind === "code" ? "pre" : "table");
  nested.scrollLeft = 23;
  const before = a.capture(), warnings = [], mappings = [];
  assert.equal(before.status, "captured"); assert.equal(before.location.text.atom, "Z");
  assert.equal(before.location.text.alignment.nested.length, 1);
  if (pending) {
    a.tab.content = f.editor.value = edited.replace("Z", "pending text with no target");
    s.previewDebounceTimer = 71;
    assert.equal(a.capture().location.text.sourceKey, before.location.text.sourceKey, "pending editor/cache does not replace displayed origin");
  }
  const prepare = s.editorScroll.prepareModeTextCorrespondence;
  s.editorScroll.prepareModeTextCorrespondence = (...args) => {
    assert.equal(s.readingSourceIdentity(args[1]), null, "target Source is not published or used as the old display");
    const result = prepare(...args); mappings.push(result); return result;
  };
  s.console = { ...console, warn: (...args) => warnings.push(args) };
  installModeDispatcher(a);
  const writes = a.writes.length, saved = JSON.stringify(before.location);
  await s.changeCurrentDocumentEditor(false);
  assert.equal(s.isEditMode, false); assert.equal(s.originalMarkdown, baseline);
  assert.equal(warnings.length, 0, "the actual mode consumer completes mapped restoration: " + JSON.stringify(warnings));
  assert.ok(a.writes.length > writes);
  assert.equal(mappings.length, 1); assert.equal(mappings[0].status, "prepared");
  assert.equal(mappings[0].correspondence.fromKey, before.location.text.sourceKey);
  assert.equal(a.targets.length, 1);
  const replacement = f.preview.querySelector(kind === "code" ? "pre" : "table");
  assert.notEqual(replacement, nested, "Discard actually replaces the changed Source owner");
  assert.ok(replacement.scrollWidth > replacement.clientWidth, "the replacement still has horizontal travel");
  assert.equal(replacement.scrollLeft, 23, "Discard restores the captured nested horizontal offset");
  assert.equal(mappings[0].correspondence.toKey, a.targets[0].key);
  assert.equal(JSON.stringify(before.location), saved, "saved version-1 values do not gain mapping fields");
  assert.equal((await a.restore(before.location)).status, "unrecordable", "history/public adapter never borrows the completed mode mapping");
});
test("saved clean exit flushes a pending light preview with a private insertion correspondence", async () => {
  const baseline = "```\n" + "p".repeat(80) + "Z" + "s".repeat(50) + "\n```";
  const edited = baseline.slice(0, 14) + "unique-prefix!" + baseline.slice(14);
  const a = integration(baseline); installMode(a); const { s, f } = a;
  await s.changeCurrentDocumentEditor(true); f.preview.scrollTop = 0;
  a.decorate = () => {
    focusModeAtom(a);
    const pre = f.preview.querySelector("pre");
    pre.scrollWidth = 500; pre.scrollLeft = 17;
  };
  a.decorate();
  const previous = f.preview.querySelector("pre");
  previous.scrollLeft = 23;
  const before = a.capture().location;
  f.editor.value = edited; s.originalMarkdown = edited; s.hasUnsavedChanges = false; s.previewDebounceTimer = 71;
  const warnings = [];
  s.console = { ...console, warn: (...args) => warnings.push(args) };
  installModeDispatcher(a, { light: true });
  await s.changeCurrentDocumentEditor(false);
  assert.equal(warnings.length, 0);
  assert.equal(a.targets.length, 1); assert.equal(a.tab.content, edited);
  assert.equal(s.isEditMode, false);
  assert.notEqual(f.preview.querySelector("pre"), previous);
  assert.equal(f.preview.querySelector("pre").scrollLeft, 17, "clean pending previews do not acquire Discard's policy");
  assert.notEqual(a.capture().location.text.sourceKey, before.text.sourceKey);
});
test("an already running saved preview completes before exit capture without retaining its old Source", async () => {
  const baseline = "```\n" + "p".repeat(80) + "Z" + "s".repeat(50) + "\n```";
  const a = integration(baseline); installMode(a); const { s, f } = a;
  await s.changeCurrentDocumentEditor(true); f.preview.scrollTop = 0;
  a.decorate = () => focusModeAtom(a);
  f.editor.value = s.originalMarkdown = baseline.slice(0, 14) + "unique-prefix!" + baseline.slice(14);
  s.hasUnsavedChanges = false; s.previewDebounceTimer = null;
  let comparisons = 0;
  const prepare = s.editorScroll.prepareModeTextCorrespondence;
  s.editorScroll.prepareModeTextCorrespondence = (...args) => { comparisons++; return prepare(...args); };
  installModeDispatcher(a, { hold: true });
  const preview = s.renderMarkdown(f.editor.value);
  await a.targetStarted;
  let exited = false;
  const leaving = s.changeCurrentDocumentEditor(false).then(() => { exited = true; });
  await Promise.resolve();
  assert.equal(exited, false); assert.equal(s.isEditMode, true);
  a.releaseTarget(); await preview; await leaving;
  assert.equal(s.isEditMode, false); assert.equal(a.targets.length, 1);
  assert.equal(comparisons, 0, "capture uses the completed current Source and no historical correspondence");
  assert.equal(a.capture().location.text.atom, "Z");
});
test("context-changing ordinary typing is still an explicit mode refusal without a top fallback", async () => {
  const baseline = "```\n" + "p".repeat(80) + "Z" + "s".repeat(50) + "\n```";
  const a = integration(baseline); installMode(a); const { s, f } = a;
  await s.changeCurrentDocumentEditor(true); f.preview.scrollTop = 0;
  a.decorate = () => focusModeAtom(a);
  a.tab.content = f.editor.value = baseline.replace("Z", "new Z");
  a.publish(a.tab.content); s.hasUnsavedChanges = true;
  assert.equal(a.capture().location.text.atom, "Z");
  const warnings = [], writes = a.writes.length;
  s.console = { ...console, warn: (...args) => warnings.push(args) };
  f.body.scrollTop = 7; installModeDispatcher(a);
  await s.changeCurrentDocumentEditor(false);
  assert.equal(warnings.length, 1); assert.equal(warnings[0][1], "mode-source-correspondence-unavailable");
  assert.equal(a.writes.length, writes); assert.equal(f.body.scrollTop, 7);
  assert.equal(s.isEditMode, false); assert.equal(s.originalMarkdown, baseline);
});
for (const kind of ["code", "table"]) test("a refused multiple-edit " + kind + " mode handoff never retries the public changed-source resolver", async () => {
  const text = "p".repeat(160) + "Z" + "s".repeat(160);
  const owner = kind === "code" ? "```\n" + text + "\n```" : "| H |\n| --- |\n| " + text + " |\n";
  const baseline = "An unchanged introduction.\n\n" + owner;
  const edited = "First added paragraph.\n\nAn unchanged introduction.\n\nSecond added paragraph.\n\n" + owner;
  const a = integration(baseline); installMode(a); const { s, f } = a;
  await s.changeCurrentDocumentEditor(true); f.preview.scrollTop = 0;
  a.decorate = () => {
    if (kind === "table") f.preview.querySelector("table").style.overflowY = "auto";
    focusModeAtom(a);
  };
  a.tab.content = f.editor.value = edited;
  a.publish(edited); s.hasUnsavedChanges = true;
  const captured = a.capture(), warnings = [], mappings = [];
  assert.equal(captured.status, "captured"); assert.equal(captured.location.text.atom, "Z");
  assert.equal(captured.location.text.alignment.nested.length, 1);
  const prepare = s.editorScroll.prepareModeTextCorrespondence;
  s.editorScroll.prepareModeTextCorrespondence = (...args) => {
    const result = prepare(...args); mappings.push(result); return result;
  };
  s.console = { ...console, warn: (...args) => warnings.push(args) };
  const writes = a.writes.length, saved = JSON.stringify(captured.location);
  f.body.scrollTop = 7; installModeDispatcher(a);
  await s.changeCurrentDocumentEditor(false);
  assert.equal(mappings.length, 1); assert.equal(mappings[0].status, "unsupported");
  assert.equal(s.editorScroll.resolveVisibleText(captured.location.text, f.body, s.readingPresentationContext()).status,
    "resolved", "the unchanged public resolver can accept this unique context and uniformly shifted owner");
  assert.equal(warnings.length, 1); assert.equal(warnings[0][1], "mode-source-correspondence-unavailable");
  assert.equal(a.writes.length, writes, "refused mapping never falls through to a weaker position write");
  assert.equal(f.body.scrollTop, 7); assert.equal(s.isEditMode, false); assert.equal(s.originalMarkdown, baseline);
  assert.equal(JSON.stringify(captured.location), saved, "refusal leaves the saved location unchanged");
});
for (const supersession of ["permit", "publication", "intent"]) test("mode mapping cannot outlive exact final target: " + supersession, async () => {
  const baseline = "```\n" + "p".repeat(80) + "Z" + "s".repeat(50) + "\n```";
  const a = integration(baseline); installMode(a); const { s, f } = a;
  await s.changeCurrentDocumentEditor(true); f.preview.scrollTop = 0;
  a.decorate = () => focusModeAtom(a);
  a.tab.content = f.editor.value = baseline.slice(0, 14) + "unique-prefix!" + baseline.slice(14);
  a.publish(a.tab.content); s.hasUnsavedChanges = true;
  f.preview.querySelector("pre").scrollLeft = 23;
  const warnings = [], writes = a.writes.length;
  s.console = { ...console, warn: (...args) => warnings.push(args) };
  installModeDispatcher(a, { hold: true });
  const leaving = s.changeCurrentDocumentEditor(false);
  await Promise.race([a.targetStarted, leaving.then(() => { throw new Error("mode exit never reached target adoption"); })]);
  assert.equal(typeof a.releaseTarget, "function", "target adoption really reached held finalization");
  assert.equal(s.window.readingLocationAdapter.available(), false);
  if (supersession === "intent") a.viewport.beginIntent();
  else if (supersession === "permit") a.viewport.invalidate();
  else { s.renderGeneration++; a.publish(a.tab.content); }
  a.releaseTarget(); await leaving;
  assert.equal(a.writes.length, writes, "stale mapping never acquires renewed native authority");
  assert.equal(warnings.length, supersession === "intent" ? 0 : 1);
  if (warnings.length) assert.equal(warnings[0][1], "mode-target-publication-stale");
});
for (const failure of ["intent", "interrupted", "malformed", "owner-chain"])
test("Discard nested restoration stops before outer writes after " + failure, async () => {
  const text = "p".repeat(80) + "Z" + "s".repeat(50), baseline = "```\n" + text + "\n```";
  const a = integration(baseline); installMode(a); const { s, f } = a;
  await s.changeCurrentDocumentEditor(true);
  a.decorate = () => { focusModeAtom(a); f.preview.querySelector("pre").scrollWidth = 500; };
  a.tab.content = f.editor.value = baseline.slice(0, 14) + "unique-prefix!" + baseline.slice(14);
  a.publish(a.tab.content); s.hasUnsavedChanges = true;
  f.preview.querySelector("pre").scrollLeft = 23;
  assert.equal(a.capture().location.horizontal.nested[0], 23, "capture really owns a nonzero nested offset");
  const writes = a.writes.length, warnings = [];
  s.console = { ...console, warn: (...args) => warnings.push(args) };
  installModeDispatcher(a);
  a.nativeCompletion = () => Promise.resolve().then(() => {
    if (failure === "intent") a.viewport.beginIntent();
    if (failure === "owner-chain") f.preview.querySelector("pre").style.overflowX = "hidden";
    return failure === "malformed" ? {} : { interrupted: failure === "interrupted" };
  });
  await s.changeCurrentDocumentEditor(false);
  assert.equal(a.writes.length, writes + 1, "only the already-issued nested request may write");
  assert.equal(a.writes.at(-1).request.left, 23);
  assert.equal(a.writes.at(-1).target.tagName, "PRE");
  assert.equal(s.originalMarkdown, baseline); assert.equal(s.isEditMode, false);
  assert.equal(warnings.length, failure === "intent" ? 0 : 1);
});
test("the public restore port ignores caller-supplied mode handoffs", async () => {
  const a = integration(), location = a.capture().location;
  let forgedCalls = 0;
  const result = await a.s.window.readingLocationAdapter.restore(location, a.viewport.beginIntent(), false,
    { take() { forgedCalls++; throw new Error("forged mapping"); } });
  assert.equal(result.status, "completed"); assert.equal(forgedCalls, 0);
});
for (const kind of ["code", "table"]) test("a classic-script helper cannot admit forged multiple-edit " + kind + " correspondence", async () => {
  const text = "p".repeat(160) + "Z" + "s".repeat(160);
  const baseline = kind === "code" ? "```\n" + text + "\n```" : "| H |\n| --- |\n| " + text + " |\n";
  const edited = baseline.slice(0, 24) + "first!" + baseline.slice(24, 44) + "second!" + baseline.slice(44);
  const a = integration(baseline), { s, f } = a;
  a.decorate = () => {
    if (kind === "table") f.preview.querySelector("table").style.overflowY = "auto";
    focusModeAtom(a);
  };
  a.decorate();
  const captured = a.capture();
  assert.equal(captured.status, "captured"); assert.equal(captured.location.text.atom, "Z");
  assert.equal(captured.location.text.alignment.nested.length, 1);
  let prepared, targetKey;
  a.tab.content = edited; s.renderGeneration++;
  a.publish(edited, { modeReading: { prepare(source, admission) {
    targetKey = admission.key;
    prepared = s.editorScroll.prepareModeTextCorrespondence(
      captured.location.text, source, admission.key, s.readingPresentationContext());
  } } });
  assert.equal(prepared.status, "unsupported", "the real old/new Source comparison refuses both separated changes");
  assert.notEqual(s.editorScroll.resolveVisibleText(captured.location.text, f.body,
    s.readingPresentationContext()).status, "resolved", "ordinary owner matching cannot restore this changed owner");
  const correspondence = { fromKey: captured.location.text.sourceKey, toKey: targetKey,
    at: 24, oldEnd: 24, newEnd: 37 };
  assert.equal(s.editorScroll.resolveVisibleText(captured.location.text, f.body,
    s.readingPresentationContext(), correspondence).status, "resolved",
  "the forged tuple reaches the real resolver and would bypass preparation");
  const writes = a.writes.length, saved = JSON.stringify(captured.location);
  let requests = 0, forgedCalls = 0;
  const begin = a.viewport.beginRequest;
  a.viewport.beginRequest = () => { requests++; return begin(); };
  const forged = { take() { forgedCalls++; return { status: "ready", correspondence }; }, current: () => true };
  // VM global declarations model a classic script's Window bindings.
  const entry = s.restoreReadingLocation || s.window.restoreReadingLocation || s.window.readingLocationAdapter.restore;
  const result = await entry(captured.location, a.viewport.beginIntent(), false, forged);
  console.log("CONTROL forged " + kind + ": " + result.status + ", requests=" + requests +
    ", writes=" + (a.writes.length - writes) + ", caller methods=" + forgedCalls);
  assert.notEqual(result.status, "completed", "the reachable restore entry must not trust a caller's tuple");
  assert.equal(forgedCalls, 0); assert.equal(a.writes.length, writes);
  assert.equal(JSON.stringify(captured.location), saved);
});
test("mode handoff factory and internal restore are not classic-script globals", () => {
  const a = integration();
  assert.equal(vm.runInContext("typeof createModeReadingHandoff", a.s), "undefined");
  assert.equal(vm.runInContext("typeof restoreReadingLocation", a.s), "undefined");
  assert.equal(typeof a.s.window.createModeReadingHandoff, "undefined");
  assert.equal(typeof a.s.window.restoreReadingLocation, "undefined");
  assert.equal(typeof a.s.window.readingLocationAdapter.restore, "function");
});
test("typing during a clean exit's render wait keeps the dirty editor open", async () => {
  const a = integration(); installMode(a); const { s, f, tab } = a;
  await s.changeCurrentDocumentEditor(true);
  assert.equal(s.hasUnsavedChanges, false, "exit really starts without discard consent");
  let input, preview, confirmations = 0, contentMutations = 0, historyRestores = 0, release;
  f.editor.addEventListener = (name, callback) => { assert.equal(name, "input"); input = callback; };
  s.editorScroll.changed = () => { contentMutations++; };
  Object.assign(s, {
    updateUnsavedIndicator() {},
    TIMING: { previewDebounceDelay: 1 },
    setTimeout(callback, delay) { assert.equal(delay, 1); preview = callback; return 74; },
    clearTimeout() {},
    historyRestore() { historyRestores++; },
    confirmUnsavedAction: async () => { confirmations++; return { approved: false, isCurrent: () => true }; },
  });
  for (const name of ["normaliseReloadSnapshot", "sameReloadDocument", "setDocumentDirtyState",
    "noteActiveContentMutation", "setDocumentDirtyFromContent"])
    vm.runInContext(declaration(name), s);
  const start = renderer.indexOf("markdownEditor.addEventListener('input', () => {");
  const end = renderer.indexOf("// Sync editor textarea content", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(renderer.slice(start, end), s);
  s.held = new Promise(resolve => { release = resolve; });
  vm.runInContext("readingRenderCompletion = held; held.then(() => { readingRenderCompletion = null; });", s);
  const baseline = s.editSessionBaseline, original = s.originalMarkdown, revision = s.editorModeRevision;
  const writes = a.writes.length;
  let settled = false;
  const leaving = s.changeCurrentDocumentEditor(false).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "exit is actually held before layout changes");
  f.editor.value = "Typing while the final render is still settling.";
  f.editor.selectionStart = 3; f.editor.selectionEnd = 8;
  input();
  assert.equal(s.hasUnsavedChanges, true, "the actual input producer dirtied the document");
  assert.equal(contentMutations, 1);
  assert.equal(typeof preview, "function", "the actual preview producer scheduled its render");
  assert.equal(s.editorModeRevision, revision, "ordinary input did not retire the mode revision");
  release(); await leaving;
  assert.equal(s.isEditMode, true, "new typing cannot be hidden behind a consent-free exit");
  assert.equal(s.hasUnsavedChanges, true);
  assert.equal(f.editor.value, "Typing while the final render is still settling.");
  assert.equal(f.editor.selectionStart, 3); assert.equal(f.editor.selectionEnd, 8);
  assert.equal(s.originalMarkdown, original); assert.equal(tab.content, original);
  assert.equal(s.editSessionBaseline, baseline);
  assert.equal(s.previewDebounceTimer, 74, "refusal leaves the pending preview intact");
  assert.equal(a.writes.length, writes); assert.equal(historyRestores, 0);
  assert.equal(confirmations, 0); assert.equal(s.editorExitOperation, null);
  await s.changeCurrentDocumentEditor(false);
  assert.equal(confirmations, 1, "a later exit asks for consent to the new dirty content");
  assert.equal(s.isEditMode, true);
});
for (const successor of ["consent", "save"]) test("pending render cannot outlive exact exit approval: " + successor, async () => {
  const a = integration(); installMode(a); const { s } = a;
  await s.changeCurrentDocumentEditor(true);
  s.hasUnsavedChanges = true;
  let approved = true, pending = false, release;
  s.confirmUnsavedAction = async () => ({ approved: true, isCurrent: () => approved });
  s.hasPendingSaveFor = () => pending;
  s.held = new Promise(resolve => { release = resolve; });
  vm.runInContext("readingRenderCompletion = held; held.then(() => { readingRenderCompletion = null; });", s);
  const leaving = s.changeCurrentDocumentEditor(false);
  await Promise.resolve();
  if (successor === "consent") approved = false; else pending = true;
  const writes = a.writes.length;
  release(); await leaving;
  assert.equal(s.isEditMode, true);
  assert.equal(s.hasUnsavedChanges, true);
  assert.equal(a.writes.length, writes);
});
async function unavailableCaptureControl(modeTransform) {
  const a = integration(undefined, { modeTransform }); installMode(a);
  const { s, f, tab } = a;
  for (const node of walk(f.preview)) node.geometry = () => [];
  assert.equal(a.capture().status, "unavailable", "the real capture producer has no visible text fragment");
  f.body.scrollTop = 17; f.preview.scrollTop = 29;
  f.editor.selectionStart = 3; f.editor.selectionEnd = 8;
  const baseline = s.originalMarkdown, writes = a.writes.length;
  await s.changeCurrentDocumentEditor(true);
  assert.equal(s.isEditMode, true);
  assert.equal(a.writes.length, writes, "unavailable capture never authorizes a fallback scroll");
  assert.equal(f.body.scrollTop, 17, "unavailable capture must not write a top fallback");
  assert.equal(f.preview.scrollTop, 29);
  assert.equal(tab.content, baseline); assert.equal(s.originalMarkdown, baseline);
  assert.equal(f.editor.value, baseline); assert.equal(s.hasUnsavedChanges, false);
  assert.equal(f.editor.selectionStart, 3); assert.equal(f.editor.selectionEnd, 8);
}
test("unavailable real text capture changes mode without inventing a top fallback or changing Source",
  () => unavailableCaptureControl());
test("unavailable-capture control detects an invented direct top fallback in actual mode Source", async () => {
  const capture = "const capturedPosition = captureReadingLocation();";
  await assert.rejects(unavailableCaptureControl(source => {
    assert.equal(source.split(capture).length, 2, "the mutation reaches the actual mode capture once");
    return source.replace(capture, capture +
      "\n  if (capturedPosition.status !== 'captured') getViewerScroller().scrollTop = 0;");
  }), error => error.code === "ERR_ASSERTION" &&
    error.message.includes("unavailable capture must not write a top fallback"));
});
async function pendingOwnerControl(phase, successor, modeTransform) {
  const a = integration(undefined, { modeTransform }); installMode(a);
  const { s, f, tab } = a;
  await s.changeCurrentDocumentEditor(true);
  let release, rendering = null;
  if (phase === "save") s.pendingSaveFor = () => new Promise(resolve => { release = resolve; });
  else {
    installModeDispatcher(a, { hold: true });
    rendering = s.renderMarkdown(tab.content, "full");
    await a.targetStarted;
    release = a.releaseTarget;
  }
  const baseline = s.editSessionBaseline, source = s.originalMarkdown, writes = a.writes.length;
  f.editor.selectionStart = 3; f.editor.selectionEnd = 8;
  let settled = false;
  const leaving = s.changeCurrentDocumentEditor(false).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "the actual mode consumer really awaits its current " + phase);
  assert.ok(s.editorExitOperation, "the waiting operation belongs to the outgoing editor");
  if (successor === "tab") a.replaceTab();
  else if (successor === "selection") s.fileOpenSequence++;
  else if (successor === "revision") s.editorModeRevision++;
  else s.currentSaveDocumentIdentity = () => ({ documentGeneration: 2 });
  release();
  if (rendering) await rendering;
  await leaving;
  assert.equal(s.isEditMode, true, "retired pending owner must not change successor mode");
  assert.equal(a.writes.length, writes, "retired pending owner never writes a new viewport");
  assert.equal(s.editSessionBaseline, baseline);
  assert.equal(s.originalMarkdown, source); assert.equal(tab.content, source);
  assert.equal(f.editor.value, source); assert.equal(s.hasUnsavedChanges, false);
  assert.equal(f.editor.selectionStart, 3); assert.equal(f.editor.selectionEnd, 8);
  assert.equal(s.editorExitOperation, null, "the exact stale operation still releases its own slot");
}
for (const phase of ["save", "render"]) for (const successor of ["tab", "selection", "revision", "generation"])
  test("actual pending " + phase + " mode consumer rejects superseded " + successor + " ownership",
    () => pendingOwnerControl(phase, successor));
test("pending-owner control detects removal of the actual pre-layout currentness guards", async () => {
  const guard = "if (!isCurrent() || readingRenderCompletion ||";
  const captureGuard = "if (!isCurrent() || !readingViewport.isIntentCurrent(modeIntent)) return;";
  await assert.rejects(pendingOwnerControl("render", "generation", source => {
    assert.equal(source.split(guard).length, 2, "the mutation reaches exactly the intended actual-source guard");
    assert.equal(source.split(captureGuard).length, 2, "the capture boundary has its own currentness guard");
    return source.replace(guard, "if (readingRenderCompletion ||")
      .replace(captureGuard, "if (!readingViewport.isIntentCurrent(modeIntent)) return;");
  }), error => error.code === "ERR_ASSERTION" &&
    error.message.includes("retired pending owner must not change successor mode"));
});
async function nativeCaptureSettlementControl({ transform = source => source, focused = true, published = true } = {}) {
  const start = editorFixture.indexOf("  const gateCapture = async (name, source, edit) => {");
  const end = editorFixture.indexOf("  const exactGateState = async ", start);
  assert.ok(start >= 0 && end > start, "the actual native capture boundary is present");
  const frames = [], captures = [], guards = [], observations = [];
  let releaseSleep, sleepCalls = 0;
  const s = vm.createContext({ modeGate: focused, files: ["alpha.md"], scenario: "capture settlement",
    currentFilePath: "alpha.md", currentSaveDocumentIdentity: () => ({ tabId: 1 }),
    currentReloadSnapshot: () => "source", isEditMode: false, readingRenderCompletion: null,
    viewer: { querySelector: () => ({ textContent: "Alpha" }) },
    loadingScreen: { classList: { contains: () => false } },
    window: { CustomTabs: { getActiveTabId: () => 1, getActiveTab: () => ({ id: 1 }) },
      displayedReadingKeyForContent: () => published ? "published" : null },
    sleep: milliseconds => {
      assert.equal(milliseconds, 180, "the existing settling delay is unchanged");
      sleepCalls++;
      return new Promise(resolve => { releaseSleep = resolve; });
    },
    requestAnimationFrame: callback => frames.push(callback),
    need: (label, ok) => { guards.push(label); assert.equal(ok, true, label); },
    capture: async name => { captures.push(name); }, nativeObservations: observations,
    state: async () => ({ source: "source" }) });
  s.exec = expression => vm.runInContext(expression, s);
  vm.runInContext(declaration("settle", editorFixture) + "\n" +
    transform(editorFixture.slice(start, end)) + "\nglobalThis.actualGateCapture=gateCapture;", s);
  const pending = s.actualGateCapture("reader-before", "source", false);
  pending.catch(() => {});
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    await tick();
    assert.equal(captures.length, 0, "capture must wait for actual helper completion");
    assert.equal(guards.length, 0, "ownership is checked after settling, not before");
    if (!focused) {
      await pending;
      assert.equal(sleepCalls, 0, "the default route does not acquire a new settling delay");
      assert.equal(frames.length, 0);
      return;
    }
    assert.equal(sleepCalls, 1);
    releaseSleep();
    await tick();
    assert.equal(frames.length, 1);
    frames.shift()(0);
    assert.equal(frames.length, 1, "the real helper requests its second animation frame");
    assert.equal(captures.length, 0, "the first frame alone cannot release capture");
    assert.equal(guards.length, 0);
    frames.shift()(0);
    if (!published) {
      await assert.rejects(pending, /mode gate capture owns the exact visible document and mode/);
      assert.equal(captures.length, 0, "settling cannot excuse an unpublished owner");
      assert.equal(observations.length, 0);
      return;
    }
    await pending;
    assert.deepEqual(captures, ["mode-gate-reader-before"]);
    assert.equal(guards.length, 1);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].viewed, false);
  } finally {
    releaseSleep?.();
    await tick();
    while (frames.length) frames.shift()(0);
    await pending.catch(() => {});
  }
}
test("native focused capture waits for the existing helper delay and both actual frame callbacks",
  () => nativeCaptureSettlementControl());
test("native capture control detects removal of either the settling call or its await", async () => {
  for (const replacement of ["", "settle();"]) await assert.rejects(
    nativeCaptureSettlementControl({ transform(source) {
      assert.equal(source.split("await settle();").length, 2);
      return source.replace("await settle();", replacement);
    } }),
    error => error.code === "ERR_ASSERTION" &&
      error.message.includes("capture must wait for actual helper completion"));
});
test("native default capture route retains its early return",
  () => nativeCaptureSettlementControl({ focused: false }));
test("native capture still rejects an unpublished owner after settling",
  () => nativeCaptureSettlementControl({ published: false }));
test("native mode gate's exact-state oracle rejects each independent document data loss", () => {
  const s = vm.createContext({});
  vm.runInContext(declaration("modeGateStatePreserved", editorFixture), s);
  const before = { source: "draft", original: "saved", value: "draft", start: 3, end: 8,
    direction: "backward", dirty: true, undoRedo: '{"undo":["saved"],"redo":[]}',
    tab: 1, path: "alpha.md", generation: 7, selection: 9, edit: true, cached: "draft", saved: "saved" };
  assert.equal(s.modeGateStatePreserved(before, { ...before }), true, "positive exact-state control is live");
  for (const key of Object.keys(before)) {
    const changed = { ...before, [key]: typeof before[key] === "boolean" ? !before[key] :
      typeof before[key] === "number" ? before[key] + 1 : before[key] + " changed" };
    assert.equal(s.modeGateStatePreserved(before, changed), false, key + " loss must fail independently");
    const missing = { ...before }; delete missing[key];
    assert.equal(s.modeGateStatePreserved(before, missing), false, key + " cannot be silently omitted");
  }
  assert.equal(s.modeGateStatePreserved({}, {}), false, "empty snapshots cannot prove preservation");
});
test("native render gate retains the actual callback, forwards other idle work and releases once", () => {
  const source = declaration("holdNativeModeRenderFinalizer", editorFixture);
  const exercise = code => {
    const queued = [], window = { requestIdleCallback(callback, options) {
      queued.push({ callback, options }); return queued.length;
    } };
    const idle = window.requestIdleCallback, s = vm.createContext({ window, renderGeneration: 7 });
    vm.runInContext(code, s);
    const gate = s.holdNativeModeRenderFinalizer(), options = { timeout: 1000 };
    let completed = 0;
    const current = () => { completed++; }, unrelated = () => {};
    assert.equal(window.requestIdleCallback(unrelated, options), 1);
    assert.equal(queued[0].callback, unrelated, "another generation is forwarded unchanged");
    s.renderGeneration = 8;
    assert.equal(window.requestIdleCallback(current, options), 2);
    assert.equal(gate.callback, current, "the real finalizer itself is retained, not replaced");
    assert.equal(queued[1].options, options, "the original native deadline options are forwarded");
    assert.equal(gate.held, false);
    queued[1].callback();
    assert.equal(gate.held, true); assert.equal(completed, 0, "native admission does not yet execute finalization");
    s.renderGeneration = 9;
    gate.restore(); gate.release(); gate.release();
    assert.equal(window.requestIdleCallback, idle);
    assert.equal(completed, 1, "the retained native callback must execute exactly once");
  };
  exercise(source);
  assert.throws(() => exercise(source.replace("this.callback && !this.released", "this.callback")),
    error => error.code === "ERR_ASSERTION" &&
      error.message.includes("the retained native callback must execute exactly once"));
});
function nativeGateConfiguration(proof) {
  const s = vm.createContext({ process: { env: { MARKALOO_EDITOR_PROOF: proof } },
    console: { error() {} }, app: { exit(code) { throw new Error("unsupported-route:" + code); } } });
  const start = editorFixture.indexOf("const proof = process.env.MARKALOO_EDITOR_PROOF;");
  const end = editorFixture.indexOf("dialog.showOpenDialog = ", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(editorFixture.slice(start, end), s);
  return s;
}
test("native focused selector is opt-in and does not change the default six scenarios", () => {
  const defaultRoute = nativeGateConfiguration(), gate = nativeGateConfiguration("mode-gate");
  assert.equal(vm.runInContext("modeGate", defaultRoute), false);
  assert.equal(vm.runInContext("nativeScenarios.length", defaultRoute), 6);
  assert.equal(vm.runInContext("modeGate", gate), true);
  assert.equal(vm.runInContext("nativeScenarios.length", gate), 12);
  assert.throws(() => nativeGateConfiguration("mode-gate-typo"), /unsupported-route:2/);
});
test("actual focused native dispatch runs the existing group without the unrelated editor sequence", async () => {
  for (const failSetup of [false, true]) {
    const s = nativeGateConfiguration("mode-gate"), calls = [];
    Object.assign(s, { win: { setSize() {} }, evidence: "unused-source-only",
      wait: async () => {}, startErrorSentinel: () => ({}),
      open: async index => { assert.equal(index, 0); calls.push("open Alpha"); },
      runNativeReadingModePositionCases: async () => {
        calls.push("existing native group");
        if (failSetup) throw new Error("controlled-shared-setup-refusal");
      },
      recordError: (phase, error) => {
        assert.equal(phase, "native shared setup exception");
        assert.match(error.message, /controlled-shared-setup-refusal/);
        calls.push("recorded refusal");
      },
      finish: async () => { calls.push("final source and sentinel checks"); },
    });
    vm.runInContext(declaration("run", editorFixture), s);
    await s.run();
    assert.deepEqual(calls, ["open Alpha", "existing native group",
      ...(failSetup ? ["recorded refusal"] : []), "final source and sentinel checks"]);
    if (failSetup) assert.equal(vm.runInContext(
      "nativeScenarios.every(entry=>entry.status==='BLOCKED'&&entry.reason.includes('controlled-shared-setup-refusal'))", s), true);
  }
});
test("actual native receipt refuses missing or blocked mode coverage and retains default198", () => {
  const start = editorFixture.indexOf("  const nativeComplete = nativeScenarios.every(");
  const end = editorFixture.indexOf('  fs.writeFileSync(path.join(evidence, "receipt.json")', start);
  assert.ok(start >= 0 && end > start);
  for (const [proof, count, status, expected] of [
    ["mode-gate", 12, "NOT RUN", false], ["mode-gate", 12, "BLOCKED", false],
    ["mode-gate", 12, "PASS", true], [undefined, 198, "PASS", true],
    [undefined, 197, "PASS", false], [undefined, 199, "PASS", false],
  ]) {
    const s = nativeGateConfiguration(proof);
    Object.assign(s, { results: Array.from({ length: count }, () => ({ ok: true })), failures: [] });
    s.status = status;
    vm.runInContext("nativeScenarios.forEach(entry=>entry.status=status);", s);
    vm.runInContext(editorFixture.slice(start, end), s);
    assert.equal(vm.runInContext("complete&&passed", s), expected, [proof, count, status].join("/"));
  }
});
test("the native scenario helper's failed result cannot produce a passing focused footer", async () => {
  const s = nativeGateConfiguration("mode-gate");
  const start = editorFixture.indexOf("  const runScenario = async (name, body) => {");
  const end = editorFixture.indexOf('  win.webContents.on("console-message", onConsole);', start);
  const footer = editorFixture.indexOf("  const nativeComplete = nativeScenarios.every(");
  const receipt = editorFixture.indexOf('  fs.writeFileSync(path.join(evidence, "receipt.json")', footer);
  assert.ok(start >= 0 && end > start && footer >= 0 && receipt > footer);
  let recorded = false;
  Object.assign(s, { results: [{ ok: true }], failures: [], blockedReason: null,
    recordError(_phase, error) {
      assert.equal(error.message, "controlled-native-scenario-refusal");
      recorded = true;
    } });
  vm.runInContext(editorFixture.slice(start, end), s);
  vm.runInContext("nativeScenarios.forEach(entry=>entry.status='PASS');", s);
  await vm.runInContext("runScenario(nativeScenarios.at(-1).name,async()=>{throw new Error('controlled-native-scenario-refusal');})", s);
  assert.equal(recorded, true, "the actual existing helper records its controlled scenario failure");
  vm.runInContext(editorFixture.slice(footer, receipt), s);
  assert.equal(vm.runInContext("complete", s), true, "the failed scenario was attempted, not missing");
  assert.equal(vm.runInContext("passed", s), false, "scenario failure alone must reject the footer");
});
function installDeferredRender(a, { pending = true, failHighlight = false } = {}) {
  const { s, f } = a, order = [], idle = [], errors = [];
  s.window.requestIdleCallback = callback => { idle.push(callback); };
  const code = f.preview.querySelector("code");
  assert.ok(code, "the deferred fixture contains real code Source");
  Object.defineProperty(code, "classList", { value: {
    add(name) { code.setAttribute("class", name); },
    contains(name) { return code.getAttribute("class") === name; },
  } });
  s.Prism = { highlightElement(element) {
    if (failHighlight) throw new Error("controlled deferred highlighting failure");
    const span = new Box("SPAN", [...element.childNodes]);
    element.childNodes = []; element.append(span);
    element.parentNode.setAttribute("tabindex", "0");
    order.push("Prism");
  } };
  f.doc.querySelector = () => pending ? code : null;
  f.doc.querySelectorAll = () => [code];
  f.doc.createElement = tag => {
    const node = new Box(tag.toUpperCase());
    node.appendChild = child => node.append(child);
    return node;
  };
  f.doc.createTextNode = text => new Text(text);
  f.preview.replaceChildren = (...children) => {
    for (const child of f.preview.childNodes) child.parentNode = null;
    f.preview.childNodes = []; f.preview.append(...children);
  };
  s.console = { error(...args) { errors.push(args); } };
  s.i18n = key => key; s.errorText = error => error.message;
  s.noteViewerMutation = () => a.viewport.invalidate();
  s.addCodeBlockCopyButtons = () => order.push("copy controls");
  s.hideLoadingScreenFor = () => order.push("hide loading");
  s.notesPanel = { classList: { contains: () => false } };
  s.updateShowNotesToggleVisibility = () => order.push("Notes");
  s.applyNoteStyles = () => order.push("Note styles");
  s.hideDocumentContextMenus = () => {};
  s.tableColumnSizing = { reset() {} }; s.tableCellSession = null;
  s.detectRenderMode = () => "full"; s._lastRenderedContent = null;
  const full = declaration("renderMarkdownFull");
  const start = full.indexOf("    const textPending = typeof Prism");
  const guardStart = full.indexOf("  const isCurrentRender =");
  const guardEnd = full.indexOf("  // Show loading screen", guardStart);
  assert.ok(start >= 0, "the real finalizer and its error handler are extracted together");
  assert.ok(guardStart >= 0 && guardEnd > guardStart, "the actual captured-admission guard is extracted");
  vm.runInContext("async function finalize(scrollSource, generation, initialReady, admission) {\n" +
    full.slice(guardStart, guardEnd) + "  try {\n" +
    full.slice(start, full.lastIndexOf("\n}")) + "\n}\n" +
    declaration("highlightNewElements") + "\n" + declaration("renderMarkdown"), s);
  s.renderMarkdownFull = (_content, generation, _permit, _preserve, _mode, initialReady) => {
    const r = a.rendered;
    s.retireReadingPresentation();
    const associations = r.associations.map(pair => s.readingBodyAssociation(pair.fresh, pair.body, r.bindings));
    const admission = s.captureReadingAdmission(r.mapped, generation);
    s.admitReadingPresentation(r.mapped, associations, admission);
    return s.finalize(r.mapped, generation, initialReady, admission);
  };
  return { idle, order, errors, code, global: () => vm.runInContext("readingRenderCompletion", s) };
}
for (const stale of [false, true]) test("initial content resolves before actual deferred finalization, stale=" + stale, async () => {
  const a = integration("```\ncode\n```"), { s } = a;
  const control = installDeferredRender(a), viewport = {};
  let initialSettled = false, finalSettled = false;
  const initial = s.renderMarkdown(a.tab.content, "full", viewport);
  const completion = viewport.completion;
  initial.then(() => { initialSettled = true; });
  completion.then(() => { finalSettled = true; });
  assert.equal(control.global(), completion, "the global retains this exact producer, not its initial promise");
  await Promise.resolve();
  assert.equal(initialSettled, true, "initial content must not wait for held idle highlighting");
  assert.equal(finalSettled, false, "finalization remains pending");
  assert.equal(control.global(), completion);
  assert.equal(s.window.readingLocationAdapter.available(), false);
  assert.equal(control.idle.length, 1, "the real finalizer was scheduled");
  assert.equal(control.code.querySelectorAll("span").length, 0, "tokens did not exist at initial resolution");
  if (stale) s.renderGeneration++;
  control.idle.shift()();
  await Promise.all([initial, completion]);
  assert.equal(finalSettled, true);
  assert.equal(control.global(), null);
  assert.equal(s.window.readingLocationAdapter.available(), !stale);
  assert.equal(control.code.querySelectorAll("span").length, stale ? 0 : 1, "only the current producer grows actual token nodes");
  assert.deepEqual(control.order, stale ? ["hide loading"] :
    ["Prism", "copy controls", "hide loading", "Notes", "Note styles"]);
});
test("nonpending and light renders settle both owned phases", async () => {
  const a = integration("```\ncode\n```"), control = installDeferredRender(a, { pending: false });
  const viewport = {}, initial = a.s.renderMarkdown(a.tab.content, "full", viewport);
  await Promise.all([initial, viewport.completion]);
  assert.equal(control.idle.length, 0);
  assert.equal(control.global(), null);
  assert.equal(a.s.window.readingLocationAdapter.available(), true);
  let lightCalls = 0;
  a.s.renderLightFormat = () => { lightCalls++; };
  const light = {}, lightInitial = a.s.renderMarkdown(a.tab.content, "light-format", light);
  assert.ok(light.completion instanceof Promise, "light finalization is exposed before any await");
  await Promise.all([lightInitial, light.completion]);
  assert.equal(lightCalls, 1); assert.equal(control.global(), null);
});
test("actual deferred error handling settles finalization without publishing failure DOM", async () => {
  const a = integration("```\ncode\n```"), control = installDeferredRender(a, { failHighlight: true });
  const viewport = {}, initial = a.s.renderMarkdown(a.tab.content, "full", viewport);
  await Promise.resolve();
  control.idle.shift()();
  await Promise.all([initial, viewport.completion]);
  assert.equal(control.errors.length, 1);
  assert.equal(control.errors[0][1].message, "controlled deferred highlighting failure");
  assert.equal(a.f.preview.childNodes[0].className, "render-error", "the actual existing error handler ran");
  assert.equal(a.s.window.readingLocationAdapter.available(), false);
  assert.equal(control.global(), null);
});
test("finalization termination does not authorize a refused publication", async () => {
  const a = integration("```\ncode\n```"), control = installDeferredRender(a);
  const viewport = {}, initial = a.s.renderMarkdown(a.tab.content, "full", viewport);
  await Promise.resolve();
  a.s.retireReadingPresentation();
  assert.equal(a.s.readingSourceIdentity(a.rendered.mapped), null, "the actual publication admission has retired");
  let published;
  const publish = a.s.publishReadingPresentation;
  a.s.publishReadingPresentation = source => { published = publish(source); return published; };
  control.idle.shift()(); await Promise.all([initial, viewport.completion]);
  assert.equal(published, false, "the actual publication function refused the retired presentation");
  assert.equal(control.global(), null);
  assert.equal(a.s.window.readingLocationAdapter.available(), false);
});
test("bare renders without tab admission still complete both phases", async () => {
  const a = integration("```\ncode\n```"), control = installDeferredRender(a);
  a.s.window.CustomTabs.getActiveTab = () => null;
  const initial = a.s.renderMarkdown(a.tab.content, "full"), completion = control.global();
  await Promise.resolve();
  assert.equal(control.idle.length, 1, "the bare producer still schedules real highlighting");
  control.idle.shift()();
  await Promise.all([initial, completion]);
  assert.equal(control.code.querySelectorAll("span").length, 1);
  assert.equal(control.global(), null);
  assert.equal(a.s.window.readingLocationAdapter.available(), false, "completion does not invent an owner");
});
for (const retirement of ["tab", "selection"]) {
  test("same-generation " + retirement + " retirement suppresses deferred decoration", async () => {
    const a = integration("```\ncode\n```"), control = installDeferredRender(a), viewport = {};
    let seals = 0;
    const seal = a.s.editorScroll.sealTextSource;
    a.s.editorScroll.sealTextSource = (...args) => { seals++; return seal(...args); };
    const initial = a.s.renderMarkdown(a.tab.content, "full", viewport), completion = viewport.completion;
    let finalized = false;
    completion.then(() => { finalized = true; });
    await Promise.resolve();
    assert.equal(finalized, false, "the actual idle callback is still held");
    const generation = a.s.renderGeneration, selection = a.s.fileOpenSequence;
    if (retirement === "tab") {
      a.replaceTab();
      assert.notEqual(a.s.window.CustomTabs.getActiveTab(), a.tab, "the captured tab lifetime really retired");
    } else {
      a.s.fileOpenSequence++;
      assert.notEqual(a.s.fileOpenSequence, selection, "the captured selection really retired");
    }
    assert.equal(a.s.renderGeneration, generation, "no successor render masks owner retirement");
    control.idle.shift()();
    await Promise.all([initial, completion]);
    assert.equal(finalized, true, "the retired producer settles its own final phase");
    assert.equal(control.global(), null, "owned global completion is cleared");
    assert.equal(a.s.window.readingLocationAdapter.available(), false);
    assert.equal(control.code.querySelectorAll("span").length, 0, "retired content must not acquire Prism decoration");
    assert.equal(seals, 0, "retired content must not be sealed");
    assert.deepEqual(control.order, ["hide loading"], "only the producer's loading cleanup may run");
  });
  test("same-generation " + retirement + " retirement suppresses deferred error paint", async () => {
    const a = integration("```\ncode\n```"), control = installDeferredRender(a, { failHighlight: true }), viewport = {};
    const body = a.f.preview.childNodes[0];
    const initial = a.s.renderMarkdown(a.tab.content, "full", viewport), completion = viewport.completion;
    await Promise.resolve();
    const generation = a.s.renderGeneration;
    assert.equal(control.idle.length, 1, "the real error-producing idle callback is held");
    control.idle.shift()();
    if (retirement === "tab") a.replaceTab();
    else a.s.fileOpenSequence++;
    assert.equal(a.s.renderGeneration, generation, "retirement occurs before catch without a successor render");
    await Promise.all([initial, completion]);
    assert.equal(control.errors.length, 1, "the actual deferred failure remains logged");
    assert.equal(control.errors[0][1].message, "controlled deferred highlighting failure");
    assert.equal(control.global(), null);
    assert.equal(a.s.window.readingLocationAdapter.available(), false);
    assert.equal(a.f.preview.childNodes[0], body, "the retired error handler must not replace the live body");
    assert.deepEqual(control.order, ["hide loading"]);
  });
}
test("obsolete completion cannot clear a successor's global or publish stale decoration", async () => {
  const a = integration("```\ncode\n```"), control = installDeferredRender(a);
  const before = {}, after = {};
  const oldInitial = a.s.renderMarkdown(a.tab.content, "full", before);
  const newInitial = a.s.renderMarkdown(a.tab.content, "full", after);
  await Promise.resolve();
  assert.notEqual(before.completion, after.completion);
  assert.equal(control.idle.length, 2);
  control.idle.shift()(); await Promise.all([oldInitial, before.completion]);
  assert.equal(control.global(), after.completion);
  assert.equal(control.code.querySelectorAll("span").length, 0);
  assert.equal(a.s.window.readingLocationAdapter.available(), false);
  control.idle.shift()(); await Promise.all([newInitial, after.completion]);
  assert.equal(control.global(), null);
  assert.equal(a.s.window.readingLocationAdapter.available(), true);
});
test("escaping deferred failures remain rejected and observed after initial completion", async () => {
  const a = integration("```\ncode\n```"), control = installDeferredRender(a, { failHighlight: true });
  const failure = new Error("controlled error-paint failure");
  a.f.preview.replaceChildren = () => { throw failure; };
  const viewport = {}, initial = a.s.renderMarkdown(a.tab.content, "full", viewport);
  const rejected = assert.rejects(viewport.completion, error => error === failure);
  await Promise.resolve();
  control.idle.shift()();
  await Promise.all([initial, rejected]);
  assert.equal(control.errors.length, 2, "both original highlighting and escaping paint errors remain visible");
  assert.equal(control.errors[1][1], failure);
  assert.equal(control.global(), null);
});
test("a producer's early return settles its own initial and final phases", async () => {
  const a = integration("```\ncode\n```"), control = installDeferredRender(a), viewport = {};
  a.s.renderMarkdownFull = async () => {};
  const initial = a.s.renderMarkdown(a.tab.content, "full", viewport);
  await Promise.all([initial, viewport.completion]);
  assert.equal(control.idle.length, 0);
  assert.equal(control.global(), null);
});
for (const phase of ["setup", "light", "producer"]) test("synchronous " + phase + " failures remain observed rejected Promises", async () => {
  const a = integration("```\ncode\n```"), control = installDeferredRender(a), viewport = {};
  const failure = new Error("controlled synchronous " + phase + " failure");
  if (phase === "setup") a.s.tableColumnSizing.reset = () => { throw failure; };
  else if (phase === "light") {
    a.s._lastRenderedContent = a.tab.content;
    a.s.renderLightFormat = () => { throw failure; };
  } else a.s.renderMarkdownFull = () => { throw failure; };
  let initial;
  assert.doesNotThrow(() => { initial = a.s.renderMarkdown(a.tab.content, phase === "light" ? "light-format" : "full", viewport); });
  assert.ok(initial instanceof Promise);
  assert.ok(viewport.completion instanceof Promise, "a rejected final handle is exposed synchronously too");
  await Promise.all([assert.rejects(initial, error => error === failure),
    assert.rejects(viewport.completion, error => error === failure)]);
  assert.equal(control.errors.length, 1);
  assert.equal(control.errors[0][1], failure);
  assert.equal(control.global(), null);
});
(async () => {
  let passed = 0;
  for (const [name, run] of cases) {
    try { await run(); passed++; console.log("PASS " + name); }
    catch (error) { console.log("FAIL " + name + "  -> " + error.stack); }
  }
  console.log(`=== ${passed}/${cases.length} passed ===`);
  process.exitCode = passed === cases.length ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
