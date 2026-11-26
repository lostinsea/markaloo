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
  "\nmodule.exports = { fixture, walk, Box, Text };",
  { require, __dirname, module: helpers, console, process: { argv: [], env: {} } });
const { fixture, walk, Box, Text } = helpers.exports;
function declaration(name, source = renderer) {
  const start = source.indexOf("function " + name + "(");
  const end = source.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start, name);
  return (source.slice(start - 6, start) === "async " ? "async " : "") + source.slice(start, end + 2);
}
function integration(text = "A sufficiently long ordinary reading paragraph.",
  { modeTransform = source => source, beforeParse, afterParse, beforePublish, patchReal = false, splitScroll = false,
    implementation } = {}) {
  const frames = [];
  const f = fixture({ rendererCallbacks: true, verifyDetached: patchReal, implementation,
    ...(splitScroll ? { active: s => s.isEditMode, requestFrame: callback => frames.push(callback),
      scrollerScale: node => f.sandbox.scrollerScale(node),
      ownsMermaidSvg: svg => f.sandbox.ownsReadingMermaidSvg(svg) } : {}) }), s = f.sandbox;
  const tab = { id: 1, content: text, originalContent: text }, events = [], writes = [];
  const normalize = value => value.replace(/\r\n?/g, "\n");
  let admittedText = normalize(text), admittedKey = 1;
  let intent = {}, permit = {}, currentTab = tab, layoutShift = 0;
  const viewport = {
    beginIntent() { intent = {}; permit = {}; return intent; },
    beginChange() { return { intent: this.beginIntent(), permit }; },
    isIntentCurrent: value => value === intent,
    invalidate() { permit = {}; },
    capturePermit: () => permit,
    beginRequest() { permit = {}; return permit; },
    isPermitCurrent: value => value === permit,
  };
  s.window.CustomTabs = { getActiveTab: () => currentTab,
    admitReadingSource(owner, source) {
      if (owner !== tab || source.source !== normalize(tab.content)) return null;
      if (source.source !== admittedText) { admittedText = source.source; admittedKey++; }
      return "controlled-cache-" + admittedKey;
    },
    hasReadingSource(owner, source, key) {
      return owner === currentTab && normalize(owner.content) === source.source && key === "controlled-cache-" + admittedKey;
    },
    snapshotExactEditorContent: () => tab.content,
    updateTabContent(value) { tab.content = value; } };
  s.window.dispatchEvent = event => events.push(event.type);
  Object.assign(s, { editorScroll: splitScroll ? f.controller : { ...f.controller, enter: () => true, leave() {} },
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
  vm.runInContext(patchReal ? patch : patch.slice(0, patchEnd) + "\n}", s);
  if (patchReal) {
    Object.assign(s, { noteViewerMutation() {}, flattenCollapsibleSections() {}, resyncSearchAfterRender() {},
      sanitizeHtml: html => html, _BLOCK_WRAPPER_CLASSES: ["mermaid-container"],
      escapeHtml: text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") });
    vm.runInContext(["_mermaidNode", "_blockHash", "_getBlockHash", "_lcsPairs", "mintPlaceholderNonce",
      "createBlockPlaceholders", "mermaidPreMarkup"].map(name => declaration(name)).join("\n"), s);
  }
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
    const rendered = geometry(f.render(value, { beforeParse: source => beforeParse?.(source, s),
      afterParse: afterParse && ((source, html) => afterParse(source, html, s)),
      replace: patchReal ? (source, html) => {
        admission = s.captureReadingAdmission(source, s.renderGeneration);
        s.patchViewerDOM(html, source, permit, admission, modeReading);
      } : null, beforeReplace(source) {
      admission = s.captureReadingAdmission(source, s.renderGeneration);
      s.patchViewerDOM(null, source, permit, admission, modeReading);
    } }));
    beforePublish?.(f, s);
    if (!patchReal) {
      const associations = rendered.associations.map(pair =>
        s.readingBodyAssociation(pair.fresh, pair.body, rendered.bindings));
      s.admitReadingPresentation(rendered.mapped, associations, admission);
    }
    if (splitScroll) s.editorScroll.commit(rendered.mapped, { textPending: true });
    if (finalize) {
      const published = s.publishReadingPresentation(rendered.mapped);
      if (!patchReal) assert.equal(published, true, "actual final producer binding publishes");
    }
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
  const api = { f, s, tab, events, writes, viewport, publish, frames, nativeCompletion: null,
    shift(value) { layoutShift = value; },
    replaceTab() { currentTab = { ...tab }; viewport.invalidate(); },
    capture() { return s.window.readingLocationAdapter.capture(); },
    restore(location, ticket = viewport.beginIntent()) { return s.window.readingLocationAdapter.restore(location, ticket); },
    captureBookmark() { return vm.runInContext("captureViewBookmark()", s); },
    restoreBookmark(location, ticket = viewport.beginIntent()) { return s.restoreViewBookmark(location, ticket); },
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
test("View rebinds the exact wrapped character after same-source rerender, not an offscreen fingerprint", async () => {
  const text = "Earlier prose.\n\nabcdefghijklmnopqrstuvwx";
  const a = integration(text), { f, s } = a;
  const layout = (width, leading) => {
    const prose = f.preview.querySelectorAll("p"), node = walk(prose[1])[0];
    prose[0].getBoundingClientRect = () => f.rect(0, 0 - f.body.scrollTop, 100, 20);
    prose[1].getBoundingClientRect = () => f.rect(0, leading - f.body.scrollTop, 100, 100);
    node.geometry = i => [f.rect(10 + (i % width) * 8, leading + Math.floor(i / width) * 20 - f.body.scrollTop)];
    return { node, offscreen: prose[0] };
  };
  let live = layout(8, 120);
  f.body.scrollTop = 139;
  const before = a.captureBookmark();
  assert.equal(before.status, "captured");
  assert.equal(before.location.value.start, text.indexOf("ijkl"));
  assert.equal(before.location.top, 1);
  const previous = live.node;
  s.renderGeneration++; a.publish();
  live = layout(4, 100);
  assert.notEqual(live.node, previous, "same bytes were rendered into new DOM");
  live.offscreen.append(new Text("Unrelated offscreen decoration"));
  f.body.scrollTop = 195;
  assert.equal(a.capture().status, "unavailable", "legacy publication cannot supply a fallback");
  const record = await a.restoreBookmark(before.location);
  assert.equal(record.travel, "observed-travel");
  assert.equal(live.node.geometry(8)[0].top, 1, "the very same source character is aligned");
  assert.equal((await a.restoreBookmark(before.location)).travel, "no-observed-travel");
  const writes = a.writes.length;
  a.replaceTab();
  assert.equal((await a.restoreBookmark(before.location)).reason, "stale-view-bookmark");
  assert.equal(a.writes.length, writes);
});
test("View restores the exact table row and cell, at the saved distance", async () => {
  const text = "| Head | Other |\n| --- | --- |\n| Alpha | Beta |\n| Gamma | Delta |\n| Epsilon | Zeta |\n";
  const a = integration(text), { f } = a, table = f.preview.querySelector("table");
  f.body.style.overflowX = "auto";
  const header = table.querySelector("thead");
  table.tHead = header;
  let pinAt = null;
  const offset = () => Math.max(0, (pinAt ?? f.body.scrollTop) - 100);
  Object.defineProperty(header.style, "transform", { get: () => `matrix(1, 0, 0, 1, 0, ${offset()})` });
  header.getBoundingClientRect = () => f.rect(0, 100 + offset() - f.body.scrollTop, 160, 20);
  const rows = table.querySelectorAll("tr"), marker = walk(rows[2].querySelectorAll("td")[1])[0];
  table.getBoundingClientRect = () => f.rect(0, 100 - f.body.scrollTop, 160, 180);
  for (const [row, tr] of rows.entries()) for (const [col, cell] of tr.children.entries()) {
    for (const node of walk(cell)) node.geometry = i =>
      [f.rect((col ? 20 : 110) + i * 8 - f.body.scrollLeft,
        [100 + offset(), 129, 151, 184][row] - f.body.scrollTop)];
  }
  f.body.scrollTop = 90;
  const unpinned = a.captureBookmark();
  assert.equal(unpinned.status, "captured", unpinned.reason);
  assert.equal(unpinned.location.value.start, text.indexOf("Other"));
  assert.equal(unpinned.location.top, 10);
  f.body.scrollTop = 126;
  const stop = a.captureBookmark();
  assert.equal(stop.status, "captured");
  assert.equal(stop.location.value.start, text.indexOf("Delta"));
  assert.equal(stop.location.top, 25);
  assert.equal(header.getBoundingClientRect().bottom, 20, "header covers the prior row");
  f.body.scrollTop = 40;
  assert.equal((await a.restoreBookmark(stop.location)).travel, "observed-travel");
  assert.equal(marker.geometry(0)[0].top, 25);
  // The outer offset can move before the pin animation has caught up.
  pinAt = f.body.scrollTop;
  assert.equal(offset(), 26);
  a.nativeCompletion = () => Promise.resolve().then(() => {
    assert.equal(f.body.scrollTop, 90);
    assert.equal(header.getBoundingClientRect().top, 36);
    pinAt = null;
    return { interrupted: false };
  });
  assert.equal((await a.restoreBookmark(unpinned.location)).travel, "observed-travel");
  assert.equal(f.body.scrollTop, 90, "restores the natural header, not its pinned position");
  assert.equal(walk(rows[0].querySelectorAll("th")[1])[0].geometry(0)[0].top, 10);
  a.tab.content += "\nNew revision.";
  assert.equal((await a.restoreBookmark(stop.location)).reason, "stale-view-bookmark");
});
test("View restores a deep highlighted code line and refuses a clamped horizontal return", async () => {
  const lines = Array.from({ length: 32 }, (_, index) => `const C${String(index + 1).padStart(2, "0")} = ${index + 1};`);
  const text = "```js\n" + lines.join("\n") + "\n```\n\nAfter the code.";
  const a = integration(text), { f, s } = a;
  const pre = f.preview.querySelector("pre"), code = pre.querySelector("code");
  const tokens = lines.map((line, index) => {
    const node = new Text(line + "\n"), span = new Box("SPAN", [node]);
    span.setAttribute("class", "token keyword");
    node.geometry = i => [f.rect(24 + 8 * i - pre.scrollLeft, 20 + index * 12 - f.body.scrollTop, 8, 7)];
    return span;
  });
  code.replaceChildren(...tokens);
  Object.assign(s, { fixturePre: pre, fixtureCode: code, fixtureTokens: tokens });
  vm.runInContext(`readingGeneratedContainers.set(fixturePre, {
    code: fixtureCode, decorations: fixtureTokens, controls: []
  })`, s);
  pre.clientHeight = pre.scrollHeight = 406;
  pre.getBoundingClientRect = () => f.rect(0, 2 - f.body.scrollTop, 100, 406);
  f.body.scrollTop = 339; pre.scrollLeft = 12;
  const stop = a.captureBookmark(), marker = walk(tokens[27])[0];
  assert.equal(stop.status, "captured", stop.reason);
  assert.equal(stop.location.value.start, text.indexOf(lines[27]));
  assert.equal(stop.location.top, 5);
  f.body.scrollTop = 10; pre.scrollLeft = 0;
  assert.equal((await a.restoreBookmark(stop.location)).travel, "observed-travel");
  assert.equal(marker.geometry(0)[0].top, 5);
  assert.equal(pre.scrollLeft, 12);

  const write = pre.scrollTo;
  pre.scrollTo = request => write({ ...request, left: 0 });
  f.body.scrollTop = 10; pre.scrollLeft = 0;
  assert.equal((await a.restoreBookmark(stop.location)).reason, "bookmark-did-not-arrive");
  assert.equal(marker.geometry(0)[0].top, 5, "vertical arrival alone is not success");
  assert.equal(pre.scrollLeft, 0);

  const after = f.preview.querySelector("p");
  after.getBoundingClientRect = () => f.rect(0, 414 - f.body.scrollTop, 100, 24);
  walk(after)[0].geometry = i => [f.rect(8 + i * 8, 414 - f.body.scrollTop)];
  f.body.scrollTop = 401;
  const padding = a.captureBookmark();
  assert.equal(padding.status, "captured", padding.reason);
  assert.equal(padding.location.value.start, text.indexOf("After"));
});
test("View does not mistake a visible thematic rule inside a mapped block for padding", () => {
  const a = integration("> Mapped text above.\n>\n> ---\n\nProse below.");
  const { f } = a, quote = f.preview.querySelector("blockquote"), rule = quote.querySelector("hr");
  assert.ok(rule);
  quote.getBoundingClientRect = () => f.rect(0, 80 - f.body.scrollTop, 100, 50);
  rule.getBoundingClientRect = () => f.rect(0, 115 - f.body.scrollTop, 100, 2);
  for (const node of walk(quote)) node.geometry = () => [f.rect(10, 80 - f.body.scrollTop)];
  const below = f.preview.querySelectorAll("p").at(-1);
  below.getBoundingClientRect = () => f.rect(0, 145 - f.body.scrollTop, 100, 20);
  for (const node of walk(below)) node.geometry = () => [f.rect(10, 145 - f.body.scrollTop)];
  f.body.scrollTop = 110;
  assert.equal(rule.getBoundingClientRect().top, 5);
  assert.equal(a.captureBookmark().reason, "visible-block-unverified");
  f.body.scrollTop = 135;
  assert.equal(a.captureBookmark().location.value.start, a.tab.content.indexOf("Prose"));
});
test("View binds short and tall generated diagrams to distinct fence occurrences across patching", async () => {
  const flow = "```mermaid\nflowchart TD\nA --> B\n```";
  const sequence = "```mermaid\nsequenceDiagram\nA->>B: step\n```";
  const text = `${flow}\n\n${sequence}\n\n${flow}\n\nProse after the mixture.`;
  let blocks;
  function layoutDiagrams(f, s) {
    const diagrams = f.preview.querySelectorAll("pre");
    for (const [index, pre] of diagrams.entries()) {
      if (!pre.querySelector("svg")) continue;
      if (!pre.parentElement.classList.contains("mermaid-container")) {
        const wrapper = new Box("DIV");
        wrapper.setAttribute("class", "mermaid-container mermaid-breakout");
        pre.replaceWith(wrapper); wrapper.append(pre);
        s.diagramFixturePre = pre; s.diagramFixtureWrapper = wrapper;
        vm.runInContext("readingDiagramWrappers.set(diagramFixturePre, diagramFixtureWrapper)", s);
      }
      const wrapper = pre.parentElement;
      wrapper.style.transform = "matrix(1, 0, 0, 1, -80, 0)";
      wrapper.getBoundingClientRect = () => f.rect(0, [15, 75, 255][index] - f.body.scrollTop, 100, [35, 160, 145][index]);
    }
    for (const p of f.preview.querySelectorAll("p")) {
      p.getBoundingClientRect = () => p.textContent ? f.rect(0, 420 - f.body.scrollTop, 100, 20) : f.rect(0, 0, 0, 0);
      for (const node of walk(p)) node.geometry = i => [f.rect(10 + i * 8, 420 - f.body.scrollTop)];
    }
  }
  const a = integration(text, {
    patchReal: true,
    beforeParse(source, s) {
      blocks = s.createBlockPlaceholders("MERMAID_BLOCK_");
      source.replaceSpecial("mermaid", /```mermaid[\r\n]+([\s\S]*?)```/g,
        (_match, code) => blocks.take(code.trim()));
    },
    afterParse(source, html, s) {
      return source.restore(blocks, "mermaid", html, s.mermaidPreMarkup, false);
    },
    beforePublish: layoutDiagrams,
  });
  const { f, s } = a;
  const nodes = f.preview.querySelectorAll("pre");
  assert.equal(nodes.length, 3);
  for (const [index, pre] of nodes.entries()) {
    pre.id = `fresh-${index}`;
    assert.equal(pre.children.length, 0, "no cached SVG is installed");
    pre.cloneNode = () => {
      const clone = new Box("PRE");
      Object.defineProperty(clone, "textContent", { set: source => clone.append(new Text(source)) });
      clone.style.setProperty = () => {};
      return clone;
    };
  }
  const appendChild = function (node) { this.append(node); };
  const stage = new Box("DIV");
  stage.appendChild = appendChild;
  const create = f.doc.createElement;
  f.doc.createElement = tag => tag === "div" ? stage : create(tag);
  f.doc.body = f.body;
  f.body.appendChild = appendChild;
  Object.assign(s, { mermaidDesiredDark: false, mermaidNodeIdSeq: 0, mermaid: { async run({ nodes: clones }) {
    assert.equal(clones.length, 3);
    for (const clone of clones) {
      const svg = new Box("SVG");
      svg.localName = "svg"; svg.namespaceURI = "http://www.w3.org/2000/svg";
      svg.setAttribute("aria-roledescription", clone.childNodes[0].data.startsWith("flowchart") ? "flowchart-v2" : "sequence");
      clone.replaceChildren(svg);
    }
  } } });
  vm.runInContext(declaration("runMermaidAtDocumentScale"), s);
  const adopted = await s.runMermaidAtDocumentScale({ nodes });
  f.doc.createElement = create;
  assert.equal(adopted.length, 3, "the actual cold Mermaid adoption accepted every fixture fence");
  assert.equal(stage.parentElement, null);
  layoutDiagrams(f, s);
  s.publishReadingPresentation(a.rendered.mapped);
  const capture = (scrollTop, start, top) => {
    f.body.scrollTop = scrollTop;
    const result = a.captureBookmark();
    assert.equal(result.status, "captured", result.reason);
    assert.equal(result.location.value.start, start);
    assert.equal(result.location.top, top);
    return result.location;
  };
  const first = capture(0, 0, 16);
  const middle = capture(140, text.indexOf(sequence), 1);
  const duplicate = capture(340, text.lastIndexOf(flow), 1);
  const prose = capture(400, text.indexOf("Prose"), 20);
  s.renderGeneration++; a.publish();
  for (const [stop, top] of [[duplicate, 340], [middle, 140], [first, 0], [prose, 400]]) {
    assert.equal((await a.restoreBookmark(stop)).travel, "observed-travel");
    assert.equal(f.body.scrollTop, top, "restore moved to the original occurrence and its visible distance");
  }
  const beforeRaw = f.preview.querySelector("pre");
  a.tab.content = text.replace(flow, `<pre class="mermaid" data-mermaid-src="flowchart TD
A --&gt; B">flowchart TD
A --&gt; B</pre>`);
  s.renderGeneration++; a.publish();
  const raw = f.preview.querySelector("pre");
  assert.notEqual(raw, beforeRaw, "an authored lookalike cannot inherit renderer fence ownership");
  f.body.scrollTop = 0;
  assert.equal(a.captureBookmark().reason, "visible-block-unverified");
  a.tab.content = text;
  s.renderGeneration++; a.publish();
  const back = f.preview.querySelector("pre");
  assert.notEqual(back, raw, "the returning fence gets a new admission, not the old authored node");
  s.diagramFixturePre = back;
  assert.equal(vm.runInContext("diagramFenceBodies.has(diagramFixturePre)", s), true);
});
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
test("unchanged Edit entry resolves and rechecks only runs spanning its exact text interval", async () => {
  const signature = "function readingAtom(publication, group, run, index) {";
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "editor-scroll.js"), "utf8");
  assert.ok(source.includes(signature));
  const passage = "Z is the exact passage.";
  const a = integration(passage + "\n\n" + "Unrelated source. ".repeat(120), {
    implementation: source.replace(signature, signature + "\n    globalThis.countEntryAtom?.();"),
  });
  function observeEditPublicationProof(a) {
    const { f, s } = a;
    let active = 0, rootReads = 0, opened = 0;
    f.preview.namespaceURI = "http://www.w3.org/1999/xhtml";
    f.preview.getRootNode = () => f.doc;
    const query = f.preview.querySelectorAll.bind(f.preview);
    f.preview.querySelectorAll = selector => {
      if (active && selector === "*") rootReads++;
      return query(selector);
    };
    s.MutationObserver = class {
      live = false;
      observe(target) {
        if (target === f.preview && !this.live) { active++; opened++; this.live = true; }
      }
      disconnect() { if (this.live) { active--; this.live = false; } }
      takeRecords() { return []; }
    };
    return () => ({ active, rootReads, opened });
  }
  test("unchanged CRLF Edit entry reuses root checks without changing source bytes", async () => {
    const original = "A sufficiently long exact paragraph.\r\n\r\nAnother paragraph.";
    const a = integration(original); installMode(a);
    a.f.editor.value = original.replace(/\r\n/g, "\n");
    const observed = observeEditPublicationProof(a), warnings = [];
    a.s.console = { ...console, warn: (...args) => warnings.push(args) };
    assert.equal(a.capture().status, "captured");
    await a.s.changeCurrentDocumentEditor(true);
    const { active, rootReads, opened } = observed();
    assert.equal(a.f.preview.scrollTop, 60);
    assert.deepEqual(warnings, []);
    assert.equal(a.s.originalMarkdown, original);
    assert.equal(a.tab.content, original);
    assert.ok(opened > 0 && rootReads === opened, "each synchronous proof verifies the root once");
    assert.equal(active, 0);
  });
  test("Edit entry leaves no publication proof observing while native completion is pending", async () => {
    const a = integration(); installMode(a);
    const observed = observeEditPublicationProof(a);
    let release, reachWait;
    const wait = new Promise(resolve => { reachWait = resolve; });
    a.nativeCompletion = () => new Promise(resolve => { release = resolve; reachWait(); });
    const entering = a.s.changeCurrentDocumentEditor(true);
    await Promise.race([wait, entering.then(() => { throw new Error("Edit never issued a native request"); })]);
    const pending = observed(), writes = a.writes.length;
    try { a.viewport.beginIntent(); } finally { release({ interrupted: false }); }
    await entering;
    assert.ok(pending.opened > 0 && pending.rootReads > 0, "a real pre-write proof was used");
    assert.equal(pending.active, 0, "the native wait already owns no observer");
    assert.equal(observed().opened, pending.opened, "a superseded request cannot open another proof");
    assert.equal(a.writes.length, writes);
  });
  for (const authority of ["renderer source", "tab cache"]) {
    test("Edit entry drops root reuse when only the " + authority + " changes", async () => {
      const a = integration(); installMode(a);
      const observed = observeEditPublicationProof(a), original = a.s.originalMarkdown;
      const resolve = a.s.editorScroll.resolveVisibleText;
      let injected = false;
      a.s.editorScroll.resolveVisibleText = (...args) => {
        const result = resolve(...args);
        if (!injected) {
          assert.equal(result.status, "resolved");
          assert.equal(observed().rootReads, 1, "the admitted proof is sealed before the authority changes");
          injected = true;
          if (authority === "renderer source") a.s.originalMarkdown += " changed";
          else a.tab.content += " changed";
        }
        return result;
      };
      await a.s.changeCurrentDocumentEditor(true);
      assert.ok(injected);
      assert.equal(a.f.editor.value, original, "the textarea is unchanged");
      assert.equal(a.f.preview.scrollTop, 60, "the full verifier still permits the original endpoint");
      assert.ok(observed().rootReads > observed().opened, "later checks used the full verifier");
      assert.equal(observed().active, 0);
    });
  }
  test("a caller-supplied Edit proof cannot bypass the full root check", () => {
    const a = integration(), captured = a.capture();
    assert.equal(captured.status, "captured");
    const context = a.s.readingPresentationContext(), saved = captured.location.text;
    assert.equal(a.f.controller.resolveVisibleText(saved, a.f.body, context).status, "resolved");
    a.f.preview.setAttribute("data-proof-changed", "yes");
    let forgedCalls = 0;
    const forged = { matches() { forgedCalls++; return true; } };
    assert.notEqual(a.f.controller.resolveVisibleText(saved, a.f.body, context, null, true, forged).status, "resolved");
    assert.equal(forgedCalls, 0);
  });
  test("Edit entry rechecks the full root after an unobserved foreign attribute change", async () => {
    const marker = "function matchesReadingRoot(publication, foreignAttributes) {";
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "editor-scroll.js"), "utf8");
    assert.ok(source.includes(marker));
    const a = integration(undefined, {
      implementation: source.replace(marker, marker + "\n    globalThis.countRootVerification?.();"),
    });
    installMode(a);
    const observed = observeEditPublicationProof(a), warnings = [];
    a.s.console = { ...console, warn: (...args) => warnings.push(args) };
    const foreign = a.f.preview.firstElementChild;
    assert.ok(foreign, "owned root has a foreign-attribute witness");
    foreign.namespaceURI = "http://www.w3.org/2000/svg";
    let verifications = 0, beforeMutation;
    a.s.countRootVerification = () => { verifications++; };
    const resolve = a.s.editorScroll.resolveVisibleText;
    a.s.editorScroll.resolveVisibleText = (...args) => {
      const result = resolve(...args);
      if (beforeMutation === undefined) {
        assert.equal(result.status, "resolved");
        assert.equal(observed().rootReads, 1, "the initial root proof is sealed");
        beforeMutation = verifications;
        foreign.setAttribute("viewBox", "0 0 42 17");
      }
      return result;
    };
    await a.s.changeCurrentDocumentEditor(true);
    assert.ok(beforeMutation > 0 && verifications > beforeMutation,
      "the pre-write receipt recheck went through full root verification");
    assert.equal(a.writes.length, 0, "the changed publication never authorized a native write");
    assert.equal(warnings[0]?.[1], "target-geometry-changed");
  });
  installMode(a);
  const { s, f } = a;
  assert.equal(a.capture().location.text.start, 0);
  const checks = [], warnings = [];
  s.console = { ...console, warn: (...args) => warnings.push(args) };
  let atoms = 0, counting = false;
  s.countEntryAtom = () => { if (counting) atoms++; };
  for (const name of ["resolveVisibleText", "isTextLocationCurrent"]) {
    const original = s.editorScroll[name];
    s.editorScroll[name] = (...args) => {
      checks.push(name);
      counting = true;
      try { return original(...args); } finally { counting = false; }
    };
  }
  await s.changeCurrentDocumentEditor(true);
  assert.equal(f.preview.scrollTop, 60, "the exact passage arrives after Split reflow");
  assert.deepEqual(checks, Array.from({ length: 3 }, () =>
    ["resolveVisibleText", "isTextLocationCurrent"]).flat(), "before-write, after-write and final checks all run");
  assert.deepEqual(warnings, [], "the mode restore reported successful arrival");
  assert.ok(atoms > 0 && atoms <= checks.length * passage.length,
    `looked outside the saved interval's run: ${atoms} atoms in ${checks.length} checks`);
});
function installMermaidLayout(a, container, tables = []) {
  const { f, s } = a, queryAll = f.preview.querySelectorAll.bind(f.preview);
  f.preview.querySelectorAll = selector => {
    if (selector === ".mermaid-container") return container ? [container] : [];
    if (selector === ".table-container") return tables;
    return queryAll(selector);
  };
  s.document.querySelector = selector => selector === ".content-wrapper" ? f.body : null;
  Object.assign(s, { tableBreakoutCoalesceTimer: null,
    publishBreakoutBudget: () => ({ splitView: s.isEditMode, available: 200, zoomFactor: 1 }) });
  vm.runInContext(["applyMermaidBreakout", "applyTableBreakout", "applyWideContentLayout"]
    .map(name => declaration(name)).join("\n"), s);
}
const availabilityEvents = a => a.events.filter(event => event === "reading-location-availability-changed").length;
test("Mermaid layout: actual Edit entry restores the same Source point after clearing breakout", async () => {
  const markdown = "```mermaid\nflowchart LR\nA[Alpha] --> B[Beta]\n```\n\nBeta passage";
  let container;
  const warnings = [];
  const a = integration(markdown, {
    beforeParse: mapped => mapped.replaceSpecial("mermaid", /```mermaid\n[\s\S]*?```/, () => ""),
    beforePublish(f, s) {
      // This test isolates publication after exact capture; the landmark
      // suite exercises the SVG clip and transformed label separately.
      const svg = new Box("svg"), pre = new Box("PRE", [svg]);
      svg.localName = "svg";
      svg.namespaceURI = "http://www.w3.org/2000/svg";
      svg.setAttribute("aria-roledescription", "flowchart-v2");
      Object.defineProperty(pre, "firstElementChild", { value: svg });
      container = new Box("DIV", [pre]);
      container.setAttribute("class", "mermaid-container mermaid-breakout");
      container.setAttribute("style", "--table-breakout-width: 180px; --mv-breakout-applied: 180px;");
      const classes = container.classList;
      Object.defineProperty(container, "classList", { value: { ...classes, remove(name) {
        container.setAttribute("class", container.getAttribute("class").split(" ").filter(value => value !== name).join(" "));
      } } });
      const styles = new Map([["--table-breakout-width", "180px"], ["--mv-breakout-applied", "180px"]]);
      container.style.removeProperty = name => {
        styles.delete(name);
        container.setAttribute("style", [...styles].map(([key, value]) => `${key}: ${value};`).join(" "));
      };
      container.querySelector = selector => selector === ":scope > .mermaid" ? pre : null;
      f.preview.append(container, f.preview.firstChild);
      s.rememberReadingMermaidSvg(pre);
      assert.equal(s.ownsReadingMermaidSvg(svg), true);
    },
  });
  installMode(a);
  installMermaidLayout(a, container);
  a.s.console = { ...console, warn: (...args) => warnings.push(args) };
  a.shift(80);
  a.f.body.scrollTop = 80;
  const saved = a.capture();
  assert.equal(saved.status, "captured", saved.reason);
  assert.equal(saved.location.text.start, markdown.indexOf("Beta passage"));
  assert.ok(container.classList.contains("mermaid-breakout"));
  const before = availabilityEvents(a);
  await a.s.changeCurrentDocumentEditor(true);
  assert.equal(a.s.isEditMode, true);
  assert.equal(a.s.renderGeneration, 1, "the same live DOM must be restored without a render");
  assert.equal(container.getAttribute("class"), "mermaid-container");
  assert.equal(container.getAttribute("style"), "");
  assert.equal(a.f.preview.scrollTop, 60, JSON.stringify(warnings));
  assert.deepEqual(warnings, []);
  assert.equal(availabilityEvents(a), before + 1, "one new publication, not one per mutation");
  assert.equal(a.capture().location.text.start, saved.location.text.start);
  a.s.applyTableBreakout();
  assert.equal(availabilityEvents(a), before + 1, "an unchanged Split layout does not republish");
});
test("Mermaid layout: plain Edit entry restores without republishing", async () => {
  const a = integration(); installMode(a);
  installMermaidLayout(a);
  const before = availabilityEvents(a);
  await a.s.changeCurrentDocumentEditor(true);
  assert.equal(a.f.preview.scrollTop, 60);
  assert.equal(availabilityEvents(a), before);
});

function directMermaidEditFixture({ afterPadding = false, splitScale = 1, splitLayoutHeight = 100 } = {}) {
  const flow = "```mermaid\nflowchart TD\nA --> B\n```";
  const sequence = "```mermaid\nsequenceDiagram\nA->>B: Step eleven\n```";
  const pie = "```mermaid\npie\n\"Sample\": 2\n```";
  const prose = "M19 High landing inventory, elm ruler.";
  const text = `${flow}\n\n${pie}\n\n${sequence}\n\n${flow}\n\n${prose}\n\nEnd.`;
  let blocks;
  const a = integration(text, {
    patchReal: true, splitScroll: true,
    beforeParse(source, s) {
      blocks = s.createBlockPlaceholders("MERMAID_BLOCK_");
      source.replaceSpecial("mermaid", /```mermaid[\r\n]+([\s\S]*?)```/g, (_match, code) => blocks.take(code.trim()));
    },
    afterParse(source, html, s) { return source.restore(blocks, "mermaid", html, s.mermaidPreMarkup, false); },
    beforePublish(f, s) {
      const scroller = () => s.getViewerScroller();
      const diagramTop = i => (s.isEditMode ? [10, 60, 135, 250] :
        [10, 85, 160, splitScale === 1 ? 340 : 540])[i] - scroller().scrollTop;
      const diagramHeight = i => (s.isEditMode ? [30, 55, 90, 85] : [45, 55, 150, 145])[i];
      const drawingRect = (x, y, w, h) => {
        const scale = s.isEditMode ? splitScale : 1;
        return f.rect(x * scale, y * scale, w * scale, h * scale);
      };
      for (const [i, pre] of f.preview.querySelectorAll("pre").entries()) {
        if (!pre.querySelector("svg")) {
          const svg = new Box("SVG", [new Text("Diagram label")]), wrapper = new Box("DIV");
          svg.localName = "svg"; svg.namespaceURI = "http://www.w3.org/2000/svg";
          svg.setAttribute("aria-roledescription", ["flowchart-v2", "pie", "sequence", "flowchart-v2"][i]);
          pre.replaceChildren(svg);
          wrapper.setAttribute("class", "mermaid-container");
          pre.replaceWith(wrapper); wrapper.append(pre);
          Object.assign(s, { editTestPre: pre, editTestWrapper: wrapper });
          vm.runInContext("readingDiagramWrappers.set(editTestPre, editTestWrapper); rememberReadingMermaidSvg(editTestPre)", s);
        }
        const svg = pre.querySelector("svg"), wrapper = pre.parentElement;
        pre.style.overflowX = pre.style.overflowY = "visible";
        pre.getBoundingClientRect = wrapper.getBoundingClientRect =
          () => drawingRect(0, diagramTop(i), 100, diagramHeight(i) + 20);
        svg.getBoundingClientRect = () => drawingRect(10, diagramTop(i) + 10, 80, diagramHeight(i));
        svg.firstChild.geometry = from => [drawingRect(10 + from * 6, diagramTop(i) + diagramHeight(i) / 2, 8, 16)];
      }
      for (const p of f.preview.querySelectorAll("p")) {
        const top = () => (s.isEditMode ? 390 : afterPadding ? 505 : 500) +
          (p.textContent === prose ? 0 : 60) - scroller().scrollTop;
        p.getBoundingClientRect = () => p.textContent ? f.rect(0, top(), 100, 35) : f.rect(0, 0, 0, 0);
        for (const node of walk(p)) node.geometry = i => {
          const width = s.isEditMode ? 12 : 20;
          return [f.rect(4 + (i % width) * 7, top() + Math.floor(i / width) * 16, 7, 16)];
        };
      }
    },
  });
  installMode(a);
  const { f, s } = a;
  f.body.append(f.editor);
  f.body.scrollHeight = 700; f.preview.scrollHeight = 580;
  const style = s.getComputedStyle;
  s.getComputedStyle = (node, pseudo) => ({
    rotate: "none", scale: "none", translate: "none", offsetPath: "none", ...style(node, pseudo),
  });
  Object.defineProperty(f.preview, "currentCSSZoom", { configurable: true, get: () => s.isEditMode ? splitScale : 1 });
  if (splitScale !== 1) {
    f.doc.defaultView.innerHeight = f.body.clientHeight = f.body.offsetHeight = 400;
    f.body.box = f.rect(0, 0, 100, 400);
    f.preview.getBoundingClientRect = () => f.rect(0, 0, 100, s.isEditMode ? 100 * splitScale : 400);
    Object.defineProperty(f.preview, "offsetHeight", { get: () => s.isEditMode ? splitLayoutHeight : 400 });
    vm.runInContext(`${declaration("snapScrollerScale")}\n${declaration("scrollerScale")}`, s);
  }
  f.editor.style.lineHeight = "18px";
  const rawY = offset => {
    const lines = text.slice(0, offset).split("\n"), last = lines.pop();
    return 6 + 18 * (lines.reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 18)), 0) +
      Math.floor(last.length / 18));
  };
  const create = f.doc.createElement, range = f.doc.createRange;
  let mirror;
  const append = Box.prototype.append;
  f.doc.body = f.body;
  f.doc.querySelector = selector => f.body.querySelector(selector);
  f.doc.createDocumentFragment = () => new Box();
  f.doc.createElement = tag => {
    if (tag === "div") {
      const div = create(tag), set = div.setAttribute;
      div.setAttribute = function (name, value) {
        set.call(div, name, value);
        if (name === "aria-hidden" && value === "true") {
          mirror = div;
          mirror.replaceChildren = fragment => Box.prototype.replaceChildren.call(div, ...fragment.children);
        }
      };
      return div;
    }
    if (tag !== "span") return create(tag);
    const span = new Box("SPAN");
    Object.defineProperty(span, "textContent", { set: value => append.call(span, new Text(value)) });
    return span;
  };
  f.doc.createRange = () => {
    const r = range();
    r.getBoundingClientRect = () => {
      let at = r.startOffset;
      for (const node of walk(mirror)) {
        if (node === r.startContainer) return f.rect(0, rawY(at));
        at += node.length;
      }
      return r.getClientRects()[0];
    };
    return r;
  };
  // The normal interpolator also measures block and text geometry from the DOM.
  for (const node of [f.preview, f.editor, ...f.preview.querySelectorAll("*")]) {
    node.getClientRects = () => [node.getBoundingClientRect()];
  }
  vm.runInContext(declaration("publishReadingViewportInput"), s);
  const paneEvent = (pane, type, fields) => {
    const event = { type, target: pane, ...fields };
    if (type === "wheel") s.publishReadingViewportInput(event);
    for (const listener of pane.listeners.get(type) || []) listener(event);
  };
  const flushFrames = () => { while (a.frames.length) a.frames.shift()(); };
  return { ...a, prose, flow, sequence, rawY, paneEvent, flushFrames };
}

test("Mermaid layout: first Edit restores the same prose atom after mixed diagrams", async () => {
  const a = directMermaidEditFixture(), { f, s, prose, rawY } = a;
  f.body.scrollTop = 518;
  const offset = a.tab.content.indexOf(prose) + 20;
  assert.equal(a.capture().status, "unavailable", "whole-document capture refuses before reaching the prose");
  assert.equal(a.captureBookmark().location.value.start, offset, "the local proof reaches the wrapped source atom");
  await s.changeCurrentDocumentEditor(true);
  assert.equal(s.renderGeneration, 1, "the source and diagram nodes were retained");
  assert.equal(f.preview.scrollTop, 408, "preview uses the same atom after reflow, not the old pixel offset");
  assert.equal(f.editor.scrollTop, rawY(offset), "Raw uses the exact wrapped source line");
  assert.ok(!a.events.includes("preview-navigation-intent"), "mode entry does not make a history navigation");
});

test("Mermaid layout: first Edit keeps prose below visible wrapper padding", async () => {
  const a = directMermaidEditFixture({ afterPadding: true }), { f, s, prose, rawY } = a;
  f.body.scrollTop = 501;
  const svg = f.preview.querySelectorAll("svg").at(-1), wrapper = svg.parentElement.parentElement;
  assert.ok(svg.getBoundingClientRect().bottom < 0 && wrapper.getBoundingClientRect().bottom > 0);
  assert.equal(a.capture().status, "unavailable");
  await s.changeCurrentDocumentEditor(true);
  assert.equal(f.preview.scrollTop, 386, "diagram padding is not visible artwork");
  assert.equal(f.editor.scrollTop, rawY(a.tab.content.indexOf(prose)));
});

for (const marker of ["sequence", "flow"]) {
  test(`Mermaid layout: first Edit inside ${marker === "flow" ? "the second identical fence" : "the tall sequence"}`, async () => {
    const a = directMermaidEditFixture(), { f, s, rawY } = a;
    const index = marker === "flow" ? 3 : 2;
    const svg = f.preview.querySelectorAll("svg")[index];
    f.body.scrollTop = index === 3 ? 423 : 245;
    const offset = a.tab.content.lastIndexOf(a[marker]);
    assert.ok(offset > 0 && (index !== 3 || a.tab.content.indexOf(a[marker]) === 0));
    assert.equal(a.captureBookmark().location.value.start, offset, "the fixture starts inside the requested occurrence");
    const view = svg.getBoundingClientRect(), fraction = (1 - view.top) / view.height;
    await s.changeCurrentDocumentEditor(true);
    const split = svg.getBoundingClientRect();
    assert.ok(Math.abs(split.top + fraction * split.height - 1) <= 1, "preview kept the same fraction of this SVG");
    assert.equal(f.editor.scrollTop, rawY(offset), "Raw shows this opener, not a similar fence or interpolated line");
    const before = f.editor.scrollTop;
    for (const listener of f.preview.listeners.get("scroll") || []) listener({ target: f.preview });
    while (a.frames.length) a.frames.shift()();
    assert.equal(f.editor.scrollTop, before, "scheduled split sync must not overwrite the exact Raw position");
  });
}

test("Mermaid layout: first Edit preserves the visible diagram point across zoomed Split", async () => {
  const a = directMermaidEditFixture({ splitScale: 4 }), { f, s, flow, rawY } = a;
  f.body.scrollTop = 434;
  const svg = f.preview.querySelectorAll("svg").at(-1);
  const before = svg.getBoundingClientRect(), fraction = 1 / before.height;
  const inset = before.top + 1;
  assert.equal(s.scrollerScale(f.body), 1);
  assert.ok(inset < f.body.clientHeight && inset > f.preview.clientHeight, "unconverted Split units would put the point offscreen");
  await s.changeCurrentDocumentEditor(true);
  assert.equal(s.scrollerScale(f.preview), 4);
  const after = svg.getBoundingClientRect();
  assert.ok(Math.abs(after.top + fraction * after.height - inset) <= 1, "the exact point stays at the same visible inset");
  assert.equal(f.editor.scrollTop, rawY(a.tab.content.lastIndexOf(flow)), "Raw shows the second fence at high zoom");
});

for (const [caseName, gate] of [
  ["uses the actual scroll scale for the second diagram", null],
  ["refuses a clipped diagram point", "clip"],
  ["refuses an unverified scroll scale", "zoom"],
  ["refuses a scaled scroll chain", "transform"],
]) {
  test(`Mermaid layout: cold 200% Edit ${caseName}`, async () => {
    const a = directMermaidEditFixture({ splitScale: 2, splitLayoutHeight: 357 }), { f, s, flow, rawY } = a;
    const clipTop = 48, height = 713;
    f.doc.defaultView.innerHeight = clipTop + height;
    f.body.clientHeight = f.body.offsetHeight = height;
    f.body.getBoundingClientRect = f.preview.getBoundingClientRect = () => f.rect(0, clipTop, 100, height);
    f.preview.clientHeight = 357;
    f.preview.scrollHeight = 10000;
    f.body.scrollTop = 623;
    const [first, , , second] = f.preview.querySelectorAll("svg"), pre = second.parentElement;
    const view = second.getBoundingClientRect, viewPre = pre.getBoundingClientRect;
    const fraction = (clipTop + 1 - view().top) / view().height;
    const pointBeforeEditScroll = 5529.765625, splitDrawingHeight = 1600;
    second.getBoundingClientRect = () => s.isEditMode
      ? f.rect(20, pointBeforeEditScroll - fraction * splitDrawingHeight - 2 * f.preview.scrollTop, 160, splitDrawingHeight)
      : view();
    // The PRE moves with the SVG. In the matched trace its top crossed the
    // stationary clip; in the negative control it still cuts off the witness.
    pre.style.overflowY = "hidden";
    pre.clientHeight = 2000;
    pre.getBoundingClientRect = () => s.isEditMode
      ? f.rect(0, (gate === "clip" ? pointBeforeEditScroll + 1 : 4341) - 2 * f.preview.scrollTop, 200, 4000)
      : viewPre();
    if (gate === "zoom") delete f.preview.currentCSSZoom;
    if (gate === "transform") f.body.style.scale = "1.1";
    let offset = 0;
    const writes = [];
    Object.defineProperty(f.preview, "scrollTop", { get: () => offset, set: value => {
      writes.push(value); offset = Math.round(value * 2) / 2;
    } });
    const fence = a.tab.content.lastIndexOf(flow);
    assert.ok(fence > a.tab.content.indexOf(flow) && fraction > 0 && fraction < 1);
    assert.equal(a.captureBookmark().location.value.start, fence);
    assert.equal(offset, 0);
    assert.equal(f.editor.scrollTop, 0);
    await s.changeCurrentDocumentEditor(true);
    assert.equal(s.scrollerScale(f.preview), 713 / 357, "the border-box estimate does not snap to the actual 2× motion");
    if (gate === "transform" || gate === "zoom") {
      assert.deepEqual(writes, [], "a CSS zoom factor alone cannot authenticate this scroll translation");
      assert.equal(f.editor.scrollTop, 0);
      return;
    }
    assert.equal(writes.length, 1, "the first Edit may place Preview only once");
    const diagram = second.getBoundingClientRect(), point = diagram.top + fraction * diagram.height;
    assert.ok(first.getBoundingClientRect().bottom <= clipTop, "the first identical drawing is offscreen");
    if (gate === "clip") {
      assert.ok(point < pre.getBoundingClientRect().top, "the PRE still clips this point");
      assert.equal(f.editor.scrollTop, 0, "a clipped point does not release Raw");
    } else {
      assert.ok(Math.abs(point - (clipTop + 1)) <= 0.5,
        `the same point must retain its viewport inset within half a pixel of rounding, got ${point}`);
      assert.equal(f.editor.scrollTop, rawY(fence), "Raw shows the second fence");
      // Both inset divisors round to the same scrollTop here; check the request too.
      const requested = (pointBeforeEditScroll - (clipTop + 1)) / 2;
      assert.ok(Math.abs(writes[0] - requested) < 1e-8,
        `the requested scroll must use 2× for both the point and the inset, got ${writes[0]}`);
    }
  });
}

test("Mermaid layout: a Split clamp cannot claim sync before real pane input", async () => {
  const a = directMermaidEditFixture(), { f, s, flow, rawY, paneEvent, flushFrames } = a;
  f.body.scrollTop = 423;
  await s.changeCurrentDocumentEditor(true);
  const exact = rawY(a.tab.content.lastIndexOf(flow));
  assert.equal(f.editor.scrollTop, exact);
  f.preview.clientHeight = 280;
  const clamped = f.preview.scrollHeight - f.preview.clientHeight;
  assert.ok(clamped < f.preview.scrollTop, "the resize really clamps Preview");
  f.preview.scrollTop = clamped;
  paneEvent(f.preview, "scroll");
  flushFrames();
  assert.equal(f.editor.scrollTop, exact, "passive layout travel does not overwrite Raw");
  paneEvent(f.preview, "wheel", { isTrusted: true, deltaY: -30, deltaX: 0 });
  f.preview.scrollTop = 5;
  paneEvent(f.preview, "scroll");
  flushFrames();
  assert.notEqual(f.editor.scrollTop, exact, "the next wheel re-enables normal Split sync");
});

for (const supersede of [false, true]) {
  test(`Mermaid layout: first Edit ${supersede ? "yields to newer input" : "rebinds after its own final render"}`, async () => {
    const a = directMermaidEditFixture(), { f, s, rawY, sequence } = a;
    f.body.scrollTop = 245;
    s.editorScroll.start(); // Exact View source still owns the displayed diagram, but Split must render.
    installModeDispatcher(a, { hold: true });
    const entering = s.changeCurrentDocumentEditor(true);
    await a.targetStarted;
    const early = await Promise.race([entering.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
    assert.equal(early, false, "initial readiness does not settle Edit while the owned render is incomplete");
    assert.equal(f.editor.scrollTop, 0, "initial render is not authority to write Raw");
    assert.equal(f.preview.scrollTop, 0, "initial render is not authority to write Preview");
    if (supersede) {
      a.paneEvent(f.preview, "wheel", { isTrusted: true, deltaY: 24, deltaX: 0 });
      assert.ok(a.events.includes("reading-history-input-admitted"), "the real reader wheel handler admitted the input");
      f.editor.scrollTop = 51;
      f.preview.scrollTop = 64;
    }
    a.releaseTarget();
    await entering;
    assert.equal(f.preview.scrollTop, supersede ? 64 : 189.6, "Preview uses the owned final diagram unless superseded");
    assert.equal(f.editor.scrollTop, supersede ? 51 : rawY(a.tab.content.indexOf(sequence)), "Raw uses the exact fence unless superseded");
  });
}
function breakoutBox(node) {
  const classes = node.classList;
  Object.defineProperty(node, "classList", { value: { ...classes,
    toggle(name, enabled) {
      const names = new Set((node.getAttribute("class") || "").split(" ").filter(Boolean));
      if (enabled) names.add(name); else names.delete(name);
      node.setAttribute("class", [...names].join(" "));
    },
    add(name) { this.toggle(name, true); },
    remove(name) { this.toggle(name, false); },
  } });
  const values = new Map();
  const serialize = () => node.setAttribute("style",
    [...values].map(([name, value]) => `${name}: ${value};`).join(" "));
  Object.assign(node.style, {
    getPropertyValue: name => values.get(name) || "",
    setProperty(name, value) { values.set(name, value); serialize(); },
    removeProperty(name) { if (values.delete(name)) serialize(); },
  });
  return node;
}
function mermaidResize({ visibleTable = false } = {}) {
  const markdown = "```mermaid\nflowchart LR\nA[Alpha] --> B[Beta]\n```\n\nBeta passage";
  const budgetName = "--mv-breakout-budget";
  let diagram;
  const a = integration(markdown, {
    beforeParse: mapped => mapped.replaceSpecial("mermaid", /```mermaid\n[\s\S]*?```/, () => ""),
    beforePublish(f, s) {
      const svg = new Box("svg"), pre = new Box("PRE", [svg]);
      svg.localName = "svg";
      svg.namespaceURI = "http://www.w3.org/2000/svg";
      svg.viewBox = { baseVal: { width: 180 } };
      svg.setAttribute("aria-roledescription", "flowchart-v2");
      Object.defineProperty(pre, "firstElementChild", { value: svg });
      diagram = breakoutBox(new Box("DIV", [pre]));
      diagram.setAttribute("class", "mermaid-container");
      diagram.querySelector = selector => selector === ":scope > .mermaid" ? pre : null;
      f.preview.append(diagram, f.preview.firstChild);
      s.rememberReadingMermaidSvg(pre);
      assert.equal(s.ownsReadingMermaidSvg(svg), true);
      // This table drives only the layout branch; the reading fixture maps prose.
      const tables = visibleTable ? [breakoutBox(new Box("DIV", [breakoutBox(new Box("TABLE"))]))] : [];
      installMermaidLayout({ f, s }, diagram, tables);
      breakoutBox(f.preview);
      s.document.getElementById = () => null;
      s.tableColumnSizing = { isDragging: () => false, wanted: () => 100 };
      const cache = renderer.slice(renderer.indexOf("let lastBreakoutAvailable = null;"),
        renderer.indexOf("// The zoom path's budget publish."));
      vm.runInContext(renderer.match(/^const TABLE_BREAKOUT_GUTTER = .*;$/m)[0] + "\n" + cache, s);
      f.body.clientWidth = 1216;
      diagram.box = f.rect(558, 0, 100, 100);
      s.applyTableBreakout(false);
    },
  });
  const budget = () => a.f.preview.style.getPropertyValue(budgetName);
  assert.equal(budget(), "1168px");
  assert.ok(diagram.classList.contains("mermaid-breakout"));
  const attributes = () => [diagram.getAttribute("class"), diagram.getAttribute("style")];
  const beforeResize = attributes();
  const initial = a.capture();
  assert.equal(initial.status, "captured", initial.reason);
  assert.equal(initial.location.text.start, markdown.indexOf("Beta passage"));
  return { a, initial, resize(publishReading) {
    a.f.body.clientWidth += 80;
    diagram.box = a.f.rect(diagram.box.left + 40, 0, 100, 100);
    a.s.applyTableBreakout(publishReading);
    assert.equal(budget(), "1248px", "resize really changed the inline viewer budget");
    assert.deepEqual(attributes(), beforeResize, "the diagram wrapper did not change");
  } };
}
test("Mermaid layout: budget-only resize keeps the first Reader departure recordable", () => {
  const { a, initial, resize } = mermaidResize();
  const before = availabilityEvents(a);
  resize();
  const after = a.capture();
  assert.equal(after.status, "captured", after.reason);
  assert.deepEqual(after.location, initial.location);
  assert.equal(availabilityEvents(a), before + 1, "resize publishes exactly once");
  a.s.applyTableBreakout();
  assert.equal(availabilityEvents(a), before + 1, "unchanged budget and wrapper do not republish");
});
test("Mermaid layout: a budget change with caller-owned publication does not publish", () => {
  const { a, initial, resize } = mermaidResize();
  const before = availabilityEvents(a);
  resize(false);
  assert.equal(availabilityEvents(a), before);
  assert.equal(a.capture().reason, "presentation-unbound-or-stale", "the old fingerprint is still rejected");
  a.s.refreshReadingPresentation();
  assert.deepEqual(a.capture().location, initial.location, "the explicit caller can refresh the current presentation");
});
test("Mermaid layout: a budget change with a visible table publishes once", () => {
  const { a, initial, resize } = mermaidResize({ visibleTable: true });
  const before = availabilityEvents(a);
  resize();
  assert.equal(availabilityEvents(a), before + 1, "the table pass owns the only publication");
  assert.deepEqual(a.capture().location, initial.location);
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
  const selected = process.env.MARKALOO_MERMAID_MODE_ONLY === "1"
    ? cases.filter(([name]) => name.startsWith("Mermaid layout:")) : cases;
  let passed = 0;
  for (const [name, run] of selected) {
    try { await run(); passed++; console.log("PASS " + name); }
    catch (error) { console.log("FAIL " + name + "  -> " + error.stack); }
  }
  console.log(`=== ${passed}/${selected.length} passed ===`);
  process.exitCode = passed === selected.length ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
