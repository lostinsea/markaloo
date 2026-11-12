"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const tabsSource = fs.readFileSync(path.join(__dirname, "..", "src", "custom-tabs.js"), "utf8");
const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
function declaration(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "production declaration exists: " + name);
  // Named declarations in these regions start at column zero or two.
  const indent = source.slice(source.lastIndexOf("\n", start) + 1, start);
  const end = source.indexOf("\n" + indent + "}", start);
  assert.ok(end > start, "production declaration ends: " + name);
  return source.slice(start, end + indent.length + 2);
}
let passed = 0, total = 0;
function test(name, run) {
  total++;
  try { run(); passed++; console.log("PASS " + name); }
  catch (error) { console.log("FAIL " + name + "  -> " + error.stack); }
}
function cacheFixture() {
  const tab = { id: 1, filePath: "a.md" };
  const state = { content: "X\r\nbody", originalContent: "X\r\nbody",
    readingKey: "initial-X", readingWitness: {}, generation: 1 };
  const sandbox = { documentState: new WeakMap([[tab, state]]), tabs: [tab],
    tabPathAliases: new Map(), nextDocumentGeneration: 1, readingSourceSequence: 0,
    window: {}, console, Object, normaliseTabPath: value => ({ spelling: value }),
    getActiveTab: () => tab, liveDocument: () => state.content,
    mayMutateDocument: () => true, bumpDocumentRevision(owner) {
      const current = sandbox.documentState.get(owner);
      current.mutationRevision = (current.mutationRevision || 0) + 1;
    },
    freshEditorState: () => ({ open: false }) };
  sandbox.sameDocument = (a, b) => a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");
  vm.createContext(sandbox);
  for (const name of ["normaliseNewlines", "freshReadingKey", "installReadingCache",
    "admitReadingSource", "setCleanDocument", "adoptCleanDocument", "snapshotTabAdoption", "restoreTabAdoption"]) {
    vm.runInContext(declaration(tabsSource, name), sandbox);
  }
  return { tab, state, sandbox };
}
test("cache admission normalizes only at the boundary and returns the current label", () => {
  const { tab, state, sandbox: s } = cacheFixture();
  assert.equal(s.admitReadingSource(tab, { source: "X\nbody" }), state.readingKey);
  assert.equal(s.admitReadingSource(tab, { source: "Y\nbody" }), null);
});
test("actual initialization and every content writer maintain labels and fresh installation witnesses", () => {
  const { tab, sandbox: s } = cacheFixture();
  Object.assign(s, { cachedSpellingFor: (_tab, content) => content,
    inEditMode: () => true, renderTabs() {}, saveTabs() {},
    activeTabId: 1, tabForDocumentIdentity: () => tab, snapshotActiveTab() {},
    isDirty: owner => s.documentState.get(owner).dirty, diskVersionForAdoption: () => null });
  for (const name of ["defineDocumentAccessors", "foldDocumentContent", "adoptDocumentContent",
    "adoptExactEditorContent", "applySaveResultDecision"])
    vm.runInContext(declaration(tabsSource, name), s);
  const state = s.defineDocumentAccessors(tab, "initial");
  s.liveDocument = () => tab.content;
  assert.equal(s.admitReadingSource(tab, { source: "initial" }), state.readingKey);
  const routes = [
    () => { tab.content = "setter"; },
    () => s.setCleanDocument(tab, "clean"),
    () => s.foldDocumentContent(tab, "fold"),
    () => s.adoptDocumentContent(tab, "adopt"),
    () => s.adoptExactEditorContent("exact"),
    () => s.applySaveResultDecision({ mayMutate: true, success: true, savedContent: "exact" }),
  ];
  for (const route of routes) {
    const witness = state.readingWitness, key = state.readingKey, content = state.content;
    route();
    assert.notEqual(state.readingWitness, witness, "the actual writer installed a fresh witness");
    assert.equal(s.admitReadingSource(tab, { source: state.content }), state.readingKey);
    if (state.content !== content) assert.notEqual(state.readingKey, key);
    else assert.equal(state.readingKey, key, "same-content Save preserves only the content label");
  }
  const prior = state.readingWitness;
  s.liveDocument = () => "live preview edit";
  assert.ok(s.admitReadingSource(tab, { source: "live preview edit" }));
  assert.equal(state.content, "live preview edit", "real admission folds the actual live producer text");
  assert.notEqual(state.readingWitness, prior);
});
test("every same-content installation gets a fresh witness but keeps its label", () => {
  const { tab, state, sandbox: s } = cacheFixture(), prior = state.readingWitness;
  s.installReadingCache(tab, state, "X\nbody");
  assert.equal(state.readingKey, "initial-X");
  assert.notEqual(state.readingWitness, prior);
});
test("real adoption rollback restores X label with a fresh witness", () => {
  const { tab, state, sandbox: s } = cacheFixture(), witness = state.readingWitness;
  state.editor = { open: false };
  const prior = s.snapshotTabAdoption(tab, tab.filePath);
  assert.equal(state.readingAdoption, prior.operation);
  assert.notEqual(state.readingAdoption, prior, "tab state cannot retain the old full-document snapshot");
  assert.deepEqual(Object.keys(state.readingAdoption), []);
  assert.equal(s.adoptCleanDocument(tab, "Y", null, prior), true);
  const installed = state.readingWitness;
  assert.equal(state.content, "Y", "the adoption really installed Y");
  assert.notEqual(state.readingKey, "initial-X");
  assert.equal(s.restoreTabAdoption(tab, prior), true);
  assert.equal(state.content, "X\r\nbody");
  assert.equal(state.readingKey, "initial-X");
  assert.notEqual(state.readingWitness, witness);
  assert.notEqual(state.readingWitness, installed);
  assert.equal(s.restoreTabAdoption(tab, prior), false, "duplicate cleanup cannot restore twice");
});
test("intervening Z refuses the whole rollback including metadata", () => {
  const { tab, state, sandbox: s } = cacheFixture();
  state.editor = { open: false };
  const prior = s.snapshotTabAdoption(tab, tab.filePath);
  s.adoptCleanDocument(tab, "Y", null, prior);
  s.installReadingCache(tab, state, "Z");
  state.generation = 99;
  const key = state.readingKey, witness = state.readingWitness;
  assert.equal(s.restoreTabAdoption(tab, prior), false);
  assert.equal(state.content, "Z");
  assert.equal(state.generation, 99);
  assert.equal(state.readingKey, key);
  assert.equal(state.readingWitness, witness);
});
test("live mutation without cache installation still refuses post-adoption rollback", () => {
  const { tab, state, sandbox: s } = cacheFixture();
  state.editor = { open: false };
  const prior = s.snapshotTabAdoption(tab, tab.filePath);
  s.adoptCleanDocument(tab, "Y", null, prior);
  const witness = state.readingWitness;
  state.mutationRevision++;
  assert.equal(s.restoreTabAdoption(tab, prior), false);
  assert.equal(state.content, "Y");
  assert.equal(state.readingWitness, witness);
});
test("pre-install failure restores metadata once without inventing restored content", () => {
  const { tab, state, sandbox: s } = cacheFixture();
  const prior = s.snapshotTabAdoption(tab, tab.filePath);
  state.pathKey = "temporary";
  assert.equal(s.restoreTabAdoption(tab, prior), true);
  assert.equal(state.pathKey, undefined);
  assert.equal(state.readingKey, "initial-X");
});
test("closed and replacement lifetimes cannot restore their old operation", () => {
  for (const replacement of [false, true]) {
    const { tab, state, sandbox: s } = cacheFixture();
    const prior = s.snapshotTabAdoption(tab, tab.filePath);
    if (replacement) s.documentState.set(tab, { ...state }); else s.tabs.length = 0;
    assert.equal(s.restoreTabAdoption(tab, prior), false);
  }
});
test("displayed Source lookup is independent of pending cache/editor text", () => {
  const source = {}, tab = { id: 3 }, s = {
    readingDisplay: { source, tab, key: "display-X", selection: 7, generation: 4 },
    fileOpenSequence: 7, renderGeneration: 4, readingPresentationRevision: 8,
    window: { CustomTabs: { getActiveTab: () => tab } },
  };
  vm.createContext(s);
  vm.runInContext(declaration(renderer, "readingPresentationContext") +
    "\n" + declaration(renderer, "readingSourceIdentity"), s);
  assert.equal(s.readingSourceIdentity(source), "display-X");
  assert.equal(s.readingSourceIdentity({}), null);
  s.fileOpenSequence++;
  assert.equal(s.readingSourceIdentity(source), null);
});
test("final publication uses exact patcher associations, never an undefined target map", () => {
  const source = {}, nested = {}, fresh = { querySelectorAll: () => [nested] };
  const body = { querySelectorAll: () => [], getAttribute: () => null };
  const nestedBody = { querySelector: () => ({}) };
  const descriptor = { readingCode: {} }, bindings = new WeakMap([[nested, descriptor]]);
  const tab = { id: 3 };
  const s = {
    readingDisplay: { tab, source, key: "X", selection: 7, generation: 4,
      associations: [{ fresh, body, bindings, targets: new Map([[fresh, body], [nested, nestedBody]]) }] },
    renderGeneration: 4, fileOpenSequence: 7, readingPresentationRevision: 2,
    readingAttributeRecords: new WeakMap(), readingGeneratedContainers: new WeakMap(),
    readingPseudoRecords: new WeakMap(), readingCollapsibleSections: new WeakMap(), Event: class {},
    window: { CustomTabs: { getActiveTab: () => tab }, dispatchEvent() {} },
    editorScroll: { bindReadingPresentation(_source, _context, associations) {
      assert.equal(associations[0].owners[0].body, nestedBody);
      return { status: "bound" };
    }, publishTextSource: () => ({ status: "published" }) },
  };
  vm.createContext(s);
  for (const name of ["readingPresentationContext", "readingSourceIdentity", "publishReadingPresentation"])
    vm.runInContext(declaration(renderer, name), s);
  body.querySelector = () => ({});
  assert.equal(s.publishReadingPresentation(source), true);
});
console.log(`=== ${passed}/${total} passed ===`);
process.exitCode = passed === total ? 0 : 1;
