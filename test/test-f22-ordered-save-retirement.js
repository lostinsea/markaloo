"use strict";

// Actual E caller; composition cases also execute the shared closer/projection.
// Page/Main/close/restoration ports are controlled. No Electron or native work.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "test-tab-refresh.js"), "utf8")
  .replace(/\r\n/g, "\n");
const between = (text, start, end) => {
  const first = text.indexOf(start);
  assert.notEqual(first, -1, "Missing source start: " + start);
  assert.equal(text.indexOf(start, first + start.length), -1, "Ambiguous source start");
  const last = text.indexOf(end, first + start.length);
  assert.notEqual(last, -1, "Missing source end: " + end);
  return text.slice(first, last);
};
const authored = between(source, "  const retireOrderedSaveE = async () => {",
  "  try {\n    producerCapturedSaves = await exec(");
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 2 && args[0] === "--negative",
  "Use no arguments or --negative permission|owner|mode");
let helper = authored;
if (args.length) {
  const mutations = {
    permission: ["tabIds: [orderedSaveTab.id], expectedDiscards: [permission]",
      "tabIds: null, expectedDiscards: []"],
    owner: ["fields.every(field => identity[field] === expected[field])", "true"],
    mode: ["restored.editMode !== false", "false"],
  };
  assert.ok(Object.hasOwn(mutations, args[1]), "Unknown negative control");
  const [before, after] = mutations[args[1]];
  assert.equal(helper.split(before).length, 2, "Mutation has one exact anchor");
  helper = helper.replace(before, after);
  console.log(`NEGATIVE CONTROL ${args[1]}: only extracted E retirement code changed`);
}
const clone = value => JSON.parse(JSON.stringify(value));
const text = "F22_SAVE_E_NEWER_FAILURE";
const baseline = "F22_SAVE_B_NEWER";
const filePath = "C:\\fixture\\f22-stale-save-order.md";
const fixtureSource = fs.readFileSync(
  path.join(__dirname, "test-fixture-close-contracts.js"), "utf8",
).replace(/\r\n/g, "\n");
const fixtureBoundary = fixtureSource.indexOf("\nasync function main() {");
assert.ok(fixtureBoundary > 0, "Existing shared closer fixture boundary");
const sharedFixture = vm.runInNewContext(
  fixtureSource.slice(0, fixtureBoundary) + "\nfixture",
  { require, __dirname, console, queueMicrotask, setTimeout, setImmediate },
);
const identity = {
  pageSession: "e-page", rendererGeneration: 3, tabId: 41,
  documentGeneration: 7, pathKey: "e-path", documentRef: "e-document",
};
function fixture() {
  const tab = { id: 41, filePath, content: text, originalContent: baseline,
    hasUnsavedChanges: true };
  const state = { maintained: true, dirty: true, deletionTombstone: null,
    reloadConflict: false };
  const page = {
    tabs: [tab], activeId: 41, editMode: true, owner: clone(identity),
    descriptor: { ref: identity.documentRef, logicalPath: filePath, readTarget: filePath },
    pending: { pending: false, count: 0 },
    deletion: { known: true, unresolved: false }, frozen: false, dialog: { open: false },
  };
  const measured = { id: 41, activeTabId: 41, content: text, editor: text,
    original: baseline, editMode: true, dirty: true, documentState: { dirty: true },
    pending: { count: 0, pending: false }, failedSaves: true,
    deletionTombstone: false, reloadConflict: false, selection: clone(identity) };
  const evidence = { capturedIdentityE: true, newerFailureApplied: true,
    oldSuccessSettled: true, afterOldSuccess: measured };
  const main = { renderer: "ready", pendingId: 0,
    rendererPageSession: identity.pageSession, rendererGeneration: 3 };
  const custody = { admitted: true, owners: [clone(identity)] };
  const window = {
    currentFilePath: filePath, markdownEditor: { value: text },
    // originalMarkdown remains a separate saved-render witness, not live E.
    originalMarkdown: baseline,
    getReloadRequestSession: () => identity.pageSession,
    getPendingSaveStatus: () => page.pending,
    folia: { queryDocumentDeletionState: () => page.deletion },
    CustomTabs: {
      getTabs: () => page.tabs,
      getActiveTab: () => page.tabs.find(item => item.id === page.activeId),
      getActiveTabId: () => page.activeId,
      getDocumentIdentityForTab: () => page.owner,
      getDocumentDescriptor: () => page.descriptor,
      __documentState: () => state,
      __inEditMode: () => page.editMode,
      __shutdownFreeze: () => ({ frozen: page.frozen }),
    },
  };
  const pageContext = vm.createContext({ window,
    document: { getElementById: () => page.dialog } });
  const calls = [];
  const behavior = { keepMode: false, keepAdmission: false, keepOwner: false,
    noDiscard: false, reject: null, extraTabAfter: false };
  const scope = {
    orderedSaveEditModeBefore: false, orderedSaveEvidence: evidence,
    orderedSaveFile: filePath, orderedSaveTab: { id: 41 },
    __shutdown: {
      state: () => main,
      documentAdmissionIsCurrent: ref => ref === identity.documentRef && custody.admitted,
      documentSessionState: () => ({ owners: custody.owners }),
    },
    exec: code => Promise.resolve(vm.runInContext(code, pageContext, { timeout: 1000 })),
    closeOwnedFixtureTabs: async (_exec, phase, options) => {
      calls.push({ phase, options: clone(options) });
      if (behavior.reject) throw behavior.reject;
      const record = { tabId: 41, initialLive: window.markdownEditor.value,
        initialCache: tab.content, identity: clone(page.owner),
        needsDiscard: !behavior.noDiscard, answered: true, closed: true, settled: true };
      page.tabs = behavior.extraTabAfter ? [{ id: 99 }] : [];
      page.activeId = null;
      window.currentFilePath = null;
      page.editMode = behavior.keepMode;
      custody.admitted = behavior.keepAdmission;
      if (!behavior.keepOwner) custody.owners = [];
      return { records: [record], remaining: [] };
    },
  };
  const context = vm.createContext(scope);
  const run = () => vm.runInContext(helper + "\nretireOrderedSaveE()", context,
    { timeout: 1000 });
  return { tab, state, page, measured, evidence, main, custody, window, scope,
    calls, behavior, run };
}
function composedFixture(replaceAt = null) {
  let shared, replaced = false;
  const replace = () => {
    options.saveFailure = false;
    shared.replace(41);
    shared.win.markdownEditor.value = shared.win.originalMarkdown = "REPLACEMENT";
    replaced = true;
  };
  const options = { selected: "B", dirty: ["B"], saveFailure: true,
    onAdmission() {
      if (replaceAt === "pre-effect" && !replaced) replace();
    } };
  shared = sharedFixture(options);
  const tab = shared.tabs.find(item => item.id === "B");
  shared.tabs.splice(0, shared.tabs.length, tab);
  tab.id = 41;
  tab.content = text;
  tab.originalContent = baseline;
  const owner = { ...shared.owners.get("B"), tabId: 41 };
  shared.owners.set(41, owner);
  shared.descriptors.set(41, shared.descriptors.get("B"));
  shared.win.markdownEditor.value = text;
  shared.win.originalMarkdown = baseline;
  shared.win.CustomTabs.getActiveTab = () => shared.tabs[0] || null;
  shared.win.CustomTabs.getActiveTabId = () => shared.tabs[0]?.id ?? null;
  shared.win.CustomTabs.__inEditMode = () => shared.tabs.length > 0;
  Object.defineProperty(shared.win, "currentFilePath", {
    get: () => shared.tabs[0]?.filePath ?? null,
  });
  const f = fixture();
  f.measured.selection = clone(owner);
  f.main.rendererPageSession = owner.pageSession;
  f.main.rendererGeneration = owner.rendererGeneration;
  f.scope.orderedSaveFile = tab.filePath;
  f.scope.exec = shared.exec;
  f.scope.__shutdown.documentAdmissionIsCurrent = ref => shared.liveRefs.has(ref);
  f.scope.__shutdown.documentSessionState = () => ({
    owners: shared.tabs.map(current => shared.owners.get(current.id)),
  });
  f.scope.closeOwnedFixtureTabs = (...args) => {
    f.calls.push({ phase: args[1], options: clone(args[2]) });
    if (replaceAt === "before-plan") replace();
    return shared.close(...args);
  };
  return { ...f, shared, replaced: () => replaced };
}
const cases = [];
const test = (name, run) => cases.push([name, run]);
test("actual actor parses and keeps the selected ordinary closer", () => {
  new vm.Script(source);
  const closer = between(source, "async function closeOwnedFixtureTabs(exec, phase,",
    "\nasync function run(win)").trimEnd() + "\n";
  assert.equal(crypto.createHash("sha256").update(closer).digest("hex"),
    "8771b1324757f3f6cc88e98cfc66cc0cbbf7fc8a70d628a4d91494f6ffa33aef");
});
test("retirement follows every original measured assertion and producer restoration", () => {
  const call = source.indexOf("  await retireOrderedSaveE();");
  assert.ok(call > source.indexOf(
    '"F22 shutdown dirty-list oracle refuses for exactly the two held D and E saves'));
  assert.ok(call < source.indexOf("  // Notification mutations are the user-visible oracle."));
  const actor = between(source, "  const orderedSaveFile =",
    "  // Notification mutations are the user-visible oracle.");
  assert.ok(!actor.includes("window.confirm") && !actor.includes("__f22OrderedSaveConfirm"));
  for (const marker of ["restoreOrderedSaveOpen();", "restoreOrderedSaveSend();",
    "if (orderedEaccesMute) await sentinel.unmute();",
    "orderedSaveEvidence.afterOldSuccess.content === \"F22_SAVE_E_NEWER_FAILURE\"",
    "orderedSaveEvidence.afterOldSuccess.original === \"F22_SAVE_B_NEWER\""]) {
    assert.ok(actor.includes(marker), "Preserved original witness: " + marker);
  }
  assert.ok(!/clearDocumentEditor\s*\(|\.click\s*\(|(?:\.value|\.content|originalMarkdown)\s*=(?!=)/
    .test(authored), "Caller neither clears buffers nor performs a second mode action");
});
test("actual last-close source supplies closed-editor restoration", () => {
  const customTabs = fs.readFileSync(path.join(__dirname, "..", "src", "custom-tabs.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  const close = between(customTabs, "  async function closeTab(tabId)", "  function updateTabContent(");
  assert.ok(close.indexOf("tabs.splice(tabIndex, 1)") <
    close.indexOf("if (window.clearDocumentEditor) window.clearDocumentEditor();"));
  const clear = between(renderer, "function clearDocumentEditor()", "window.captureDocumentEditor");
  assert.ok(clear.includes("setEditorPresentation(false, false)"));
});
test("only measured live E receives exact owner/path/literal permission and retires", async () => {
  const f = fixture();
  const before = JSON.stringify(f.evidence);
  await f.run();
  assert.equal(JSON.stringify(f.evidence), before, "Measured dirty/baseline evidence is retained");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].options, {
    tabIds: [41], expectedDiscards: [{ tabId: 41, filePath, owner: identity,
      content: text, reason: "Discard measured F22 ordered E failure after all save assertions" }],
    expectedTargets: [{ tabId: 41, path: filePath, owner: identity,
      descriptor: { ref: identity.documentRef, logicalPath: filePath, readTarget: filePath },
      disposition: "dirty-discard", liveContent: text, cacheContent: text,
      savedContent: baseline }],
  });
  assert.equal(f.window.originalMarkdown, baseline, "No live-E claim is made about originalMarkdown");
});
const refusal = (name, change) => test(name, async () => {
  const f = fixture();
  change(f);
  await assert.rejects(f.run(), /F22 ordered E/);
  assert.equal(f.calls.length, 0, "Invalid owner must refuse BEFORE any discard/close");
});
refusal("fresh admission must have started in view mode", f => {
  f.scope.orderedSaveEditModeBefore = true;
});
refusal("missing measured E acceptance refuses", f => { f.evidence.capturedIdentityE = false; });
refusal("missing newer failure transition refuses", f => { f.evidence.newerFailureApplied = false; });
refusal("unsettled older D refuses", f => { f.evidence.oldSuccessSettled = false; });
refusal("measured live bytes cannot be replaced by cache", f => { f.measured.editor += "\n"; });
refusal("measured baseline must remain B", f => { f.measured.original = text; });
refusal("measured pending save refuses", f => { f.measured.pending.count = 1; });
refusal("lost current Main admission refuses", f => { f.custody.admitted = false; });
refusal("foreign Main generation refuses", f => { f.main.rendererGeneration++; });
refusal("missing exact current Main owner refuses", f => { f.custody.owners = []; });
refusal("current renderer owner change refuses before close", f => { f.page.owner.documentGeneration++; });
refusal("foreign descriptor path refuses the captured retirement target", f => {
  f.page.descriptor.logicalPath = "OTHER.md";
});
refusal("unexpected companion is not given discard permission", f => { f.page.tabs.push({ id: 99 }); });
refusal("live E change refuses before close", f => { f.window.markdownEditor.value += "\n"; });
refusal("cached E change refuses before close", f => { f.tab.content += "\n"; });
refusal("current baseline change refuses before close", f => { f.tab.originalContent = text; });
refusal("new pending save refuses before close", f => { f.page.pending = { count: 1, pending: true }; });
refusal("dirty E cannot be silently marked clean", f => { f.state.dirty = false; });
refusal("deleted owner receives no ordinary discard permission", f => { f.page.deletion.unresolved = true; });
refusal("unknown deletion authority refuses", f => { f.page.deletion.known = false; });
refusal("renderer tombstone refuses ordinary permission", f => { f.state.deletionTombstone = {}; });
refusal("foreign question refuses before close", f => { f.page.dialog.open = true; });
refusal("frozen mutation boundary refuses before close", f => { f.page.frozen = true; });
test("original closer rejection is propagated without a fallback action", async () => {
  const f = fixture();
  f.behavior.reject = new Error("controlled original closer rejection");
  await assert.rejects(f.run(), error => error === f.behavior.reject);
  assert.equal(f.calls.length, 1);
});
for (const [name, flag] of [
  ["closed owner must really restore view mode", "keepMode"],
  ["retired admission cannot remain current", "keepAdmission"],
  ["exact E owner cannot remain registered", "keepOwner"],
  ["cleanup cannot be credited without E discard", "noDiscard"],
  ["unexpected remaining page tab refuses", "extraTabAfter"],
]) test(name, async () => {
  const f = fixture();
  f.behavior[flag] = true;
  await assert.rejects(f.run(), /F22 ordered E did not retire/);
  assert.equal(f.calls.length, 1);
});
test("actual E caller and selected supplier share the exact dirty target and separate consent", async () => {
  const f = composedFixture();
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.expectedTargets[0].disposition, "dirty-discard");
  assert.equal(f.calls[0].options.expectedTargets[0].liveContent, text);
  assert.equal(f.calls[0].options.expectedTargets[0].savedContent, baseline);
  assert.deepEqual(Array.from(f.shared.calls.filter(call => call === "close:41")), ["close:41"]);
  assert.deepEqual(Array.from(f.shared.calls.filter(call => call === "approve:41")), ["approve:41"]);
  assert.equal(f.shared.tabs.length, 0);
});
for (const stage of ["before-plan", "pre-effect"]) test(
  "actual E caller/supplier refuse a replacement clean owner " + stage, async () => {
    const f = composedFixture(stage);
    await assert.rejects(f.run(), /Captured fixture target|fixture cleanup failed/);
    assert.equal(f.replaced(), true, "The replacement really reached the tested boundary");
    const replacement = f.shared.tabs[0];
    assert.equal(replacement.content, "REPLACEMENT");
    assert.equal(replacement.hasUnsavedChanges, false);
    assert.equal(f.shared.win.CustomTabs.__documentState(replacement).dirty, false);
    assert.notEqual(f.shared.owners.get(41).documentRef, f.measured.selection.documentRef);
    assert.equal(f.shared.calls.some(call => call.startsWith("close:")), false);
    assert.equal(f.shared.calls.some(call => call.startsWith("approve:")), false);
    assert.equal(f.shared.tabs.includes(replacement), true);
  },
);
(async () => {
  let failed = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name + "\n" + error.stack); }
  }
  console.log(`F22 ordered Save E contracts: ${cases.length - failed} passed, ${failed} failed; source/VM only, native NOT RUN.`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
