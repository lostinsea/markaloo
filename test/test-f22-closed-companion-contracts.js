"use strict";

// Actual-source/VM controls. Main, admission and selection are controlled ports.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "test-tab-refresh.js"), "utf8")
  .replace(/\r\n/g, "\n");
function between(text, start, end) {
  const first = text.indexOf(start), last = text.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, "source boundaries: " + start);
  assert.equal(text.indexOf(start, first + start.length), -1, "unique source boundary");
  return text.slice(first, last);
}
const closer = between(source, "async function closeOwnedFixtureTabs(",
  "\nasync function run(win)");
assert.equal(createHash("sha256").update(closer).digest("hex"),
  "8771b1324757f3f6cc88e98cfc66cc0cbbf7fc8a70d628a4d91494f6ffa33aef");
const setup = between(source, "  const closedDeletedFile =",
  "  const closedCloseKey =");
const cleanCapture = between(source, "  const closedCloseKey =",
  "  const heldClosedDeliveries = [];");
const deletedClose = between(source, "  const closedOwnerFields =",
  "  const closedDeletedGone = closedClose.gone;");
const retirement = between(source, "  if (closedDeletedGone !== true) {",
  "\n  // Keep the owning tab open and active,");
const fixtureSource = fs.readFileSync(
  path.join(__dirname, "test-fixture-close-contracts.js"), "utf8",
).replace(/\r\n/g, "\n");
const fixtureBoundary = fixtureSource.indexOf("\nasync function main() {");
assert(fixtureBoundary > 0, "existing closer VM fixture boundary");
const fixture = vm.runInNewContext(
  fixtureSource.slice(0, fixtureBoundary) + "\nfixture",
  { require, __dirname, console, queueMicrotask, setTimeout, setImmediate },
);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function reached(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("VM control did not reach " + label)), 5000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0;
async function check(name, run) {
  await run();
  passed++;
  console.log("PASS " + name);
}

function setupCaller(state, failAt = null) {
  const events = [], primary = deferred(), companion = deferred();
  const primaryEntered = deferred(), companionEntered = deferred();
  const directory = "C:\\fixture";
  const aFile = path.join(directory, "f22-deleted-closed-a.md");
  const bFile = path.join(directory, "f22-deleted-closed-b.md");
  const admittedA = { id: 10, filePath: aFile, content: "F22_DELETED_CLOSED\r\n" };
  const admittedB = { id: 11, filePath: bFile, content: "F22_DELETED_CLOSED_B_BASE\r\n" };
  const context = {
    dir: directory, path, exec: state.exec, deletedA: { id: "A" },
    closeOwnedFixtureTabs: async (...args) => {
      events.push("retire");
      const result = await state.close(...args);
      events.push("retired");
      return result;
    },
    seedSettledFixture: async (file, content) => {
      assert.equal(state.liveRefs.has("REF_A"), false);
      assert.equal(content, file === aFile ? admittedA.content : admittedB.content);
      events.push(file === aFile ? "seed-A" : "seed-B");
      if (failAt === "seed") throw new Error("seed refused");
    },
    createActiveTab: async (file, content) => {
      assert.equal(file, aFile);
      assert.equal(content, admittedA.content);
      events.push("admit-A");
      primaryEntered.resolve();
      if (failAt === "primary") throw new Error("primary refused");
      await primary.promise;
      return admittedA;
    },
    createCompanionTab: async (owner, file, content) => {
      assert.equal(owner, admittedA);
      assert.equal(file, bFile);
      assert.equal(content, admittedB.content);
      events.push("pair-B-and-restore-A");
      companionEntered.resolve();
      if (failAt === "companion") throw new Error("companion refused");
      await companion.promise;
      return admittedB;
    },
  };
  return {
    events, primary, companion, primaryEntered, companionEntered, admittedA, admittedB,
    run: () => vm.runInNewContext("(async () => {\n" + setup +
      "\nreturn { closedDeletedA, closedDeletedB, closedSetupRetirement };\n})()", context),
  };
}

function retirementCaller(state, gone = true) {
  // This separately exercises only the ordinary companion's exact caller.
  const index = state.tabs.findIndex(tab => tab.id === "A");
  if (index >= 0) state.tabs.splice(index, 1);
  state.liveRefs.delete("REF_A");
  return vm.runInNewContext("(async () => {\n" + retirement +
    "\nreturn closedCompanionRetirement;\n})()", {
    exec: state.exec, closeOwnedFixtureTabs: state.close,
    closedDeletedGone: gone, closedDeletedA: { id: "A" }, closedDeletedB: { id: "B" },
  });
}

const producer = fs.readFileSync(path.join(__dirname, "..", "src", "custom-tabs.js"), "utf8")
  .replace(/\r\n/g, "\n");
const dialogs = fs.readFileSync(path.join(__dirname, "..", "src", "app-dialogs.js"), "utf8");
const contextSource = between(producer, "  function captureDialogContext(",
  "\n  function bumpTabMutationRevision(");
const closeSource = between(producer, "  function safeDocumentLabel(",
  "\n  function updateTabContent(");
const projection = between(producer, "    __documentState: (tab) => {", "    __reloadState:");

function deletedFixture(options = {}) {
  const dir = "C:\\fixture", aPath = path.join(dir, "f22-deleted-closed-a.md");
  const bPath = path.join(dir, "f22-deleted-closed-b.md");
  const bytes = "F22_DELETED_CLOSED\r\n", bBytes = "F22_DELETED_CLOSED_B_BASE\r\n";
  const tabs = [10, 11].map((id, index) => ({
    id, filePath: index ? bPath : aPath,
    filename: index ? "f22-deleted-closed-b.md" : "f22-deleted-closed-a.md",
    content: index ? bBytes : bytes, originalContent: index ? bBytes : bytes,
    hasUnsavedChanges: false, dirty: false, revision: 1,
  }));
  const owners = new Map(tabs.map(tab => [tab.id, {
    pageSession: "PAGE", rendererGeneration: 1, tabId: tab.id,
    documentGeneration: 1, pathKey: tab.filePath, documentRef: "REF_" + tab.id,
  }]));
  const descriptors = new Map(tabs.map(tab => [tab.id, {
    ref: "REF_" + tab.id, pathKey: tab.filePath,
    logicalPath: tab.filePath, readTarget: tab.filePath,
  }]));
  const admitted = new Set(["REF_10", "REF_11"]);
  const mainOwners = tabs.map(tab => ({ ...owners.get(tab.id), readTarget: tab.filePath }));
  const documentState = new WeakMap(tabs.map(tab => [tab, {
    get dirty() { return tab.dirty; }, get content() { return tab.content; },
    get originalContent() { return tab.originalContent; },
    get foldedLive() { return tab.content; },
    get mutationRevision() { return tab.revision; },
    reloadConflict: false, saveFailure: false, deletionTombstone: null,
  }]));
  const state = {
    tabs, a: tabs[0], b: tabs[1], owners, descriptors, admitted, choices: [], retirements: [],
    queries: [], errors: [], barriers: 0, polls: new Set(), clock: 0,
    deletionRevision: 7, unknown: false, unresolved: true, unreadable: false,
    saveRevision: 1, pending: 0, frozen: false, reloadSequence: 1,
    barrierGate: deferred(), barrierEntered: deferred(),
  };
  class Element extends EventTarget {
    constructor(tag) {
      super(); this.tagName = tag; this.children = []; this.parent = null;
      this.dataset = {}; this.id = ""; this.textContent = ""; this.className = "";
      this.open = false; this.hidden = false;
    }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) {
      for (const node of this.children) node.parent = null;
      this.children = []; this.append(...nodes);
    }
    setAttribute() {}
    querySelectorAll(selector) {
      const matches = node => selector.startsWith("#") ? node.id === selector.slice(1) :
        selector.startsWith(".") ? node.className.split(" ").includes(selector.slice(1)) :
        selector === "dialog[open]" ? node.tagName === "dialog" && node.open :
        selector === "button" ? node.tagName === "button" :
        selector === "[data-dialog-choice]" ? !!node.dataset.dialogChoice :
        selector.startsWith('[data-dialog-choice="')
          ? node.dataset.dialogChoice === selector.slice(21, -2) : false;
      return this.children.flatMap(node => [
        ...(matches(node) ? [node] : []), ...node.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    get isConnected() { return this.parent !== null; }
    closest() { return null; }
    checkVisibility() { return true; }
    focus() { document.activeElement = this; }
    click() {
      if (this.dataset.dialogChoice) {
        state.choices.push(this.dataset.dialogChoice);
        if (this.dataset.dialogChoice === "proceed") options.onProceed?.(state);
      }
      this.dispatchEvent(new Event("click"));
    }
    getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100 }; }
  }
  class Dialog extends Element {
    showModal() { this.open = true; }
    close() { this.open = false; queueMicrotask(() => this.dispatchEvent(new Event("close"))); }
  }
  const document = new Element("document");
  document.body = new Element("body"); document.append(document.body);
  document.createElement = tag => tag === "dialog" ? new Dialog(tag) : new Element(tag);
  document.getElementById = id => document.querySelector("#" + id);
  const refresh = new Element("button"); refresh.id = "refreshBtn";
  document.body.append(refresh); document.activeElement = refresh;
  const originalShow = Dialog.prototype.showModal;
  const win = new EventTarget();
  win.markdownEditor = { value: bytes.replace(/\r\n/g, "\n") };
  win.originalMarkdown = bytes; win.currentFilePath = aPath;
  win.getReloadRequestSession = () => "PAGE";
  win.getPendingSaveStatus = () => ({
    revision: state.saveRevision, count: state.pending, pending: state.pending > 0, paths: [],
  });
  win.getActiveFileSelectionGeneration = () => state.selected === 11 ? 2 : 1;
  win.getLatestReloadRequestSequence = () => state.reloadSequence;
  win.getReloadRequestDiagnostics = () => ({
    sequence: state.reloadSequence, pendingNavigationToken: state.navigation || 0,
  });
  win.folia = {
    getVersion: async () => {
      state.barriers++;
      if (state.barriers === 2) {
        options.beforeAnswer?.(state);
        state.barrierEntered.resolve();
        if (options.holdBeforeAnswer) await state.barrierGate.promise;
      }
      return "VM_ONLY";
    },
    queryDocumentDeletionState: request => {
      state.queries.push({ ...request });
      return { known: !state.unknown, unresolved: state.unresolved,
        unreadable: state.unreadable, revision: state.deletionRevision };
    },
  };
  win.queryDocumentDeletionState = (file, owner) =>
    win.folia.queryDocumentDeletionState({ ...owner, filePath: file });
  win.retireDeletionTombstone = (file, owner, tombstone, consent) => {
    state.retirements.push({ file, owner: { ...owner }, consent: { ...consent } });
    assert.equal(file, aPath);
    assert.equal(owner.documentRef, "REF_10");
    assert.equal(consent.acknowledgedDeletion, true);
    assert.equal(consent.expectedDeletionRevision, state.deletionRevision);
    if (options.refuseRetirement) return { retired: false, why: "port-refusal" };
    if (!options.keepMainAdmission) admitted.delete("REF_10");
    return { retired: true };
  };
  const page = vm.createContext({
    window: win, document, HTMLDialogElement: Dialog,
    documentState, tabs, owners, descriptors, state,
    AbortController, CSS: { escape: id => id }, queueMicrotask,
    console: { log() {}, error: (...args) => state.errors.push(args.map(String)) },
    Date: { now: () => state.clock },
    setInterval: callback => { state.polls.add(callback); return callback; },
    clearInterval: callback => state.polls.delete(callback),
    setTimeout: (callback, ms) => {
      state.clock += ms;
      queueMicrotask(() => {
        if (state.clock % 100 === 0) for (const poll of [...state.polls]) poll();
        callback();
      });
    },
  });
  vm.runInContext(`
    let activeTabId = 10, documentRevision = 0, dialogDecisionIntent = 0;
    let latestTabSwitchIntent = 1;
    const approvalRendererGeneration = 1, frozenDocumentOperationOverflowCount = 0;
    const pendingConfirmedReload = null;
    const mayMutateDocument = () => !state.frozen;
    const isDocumentFrozen = () => state.frozen;
    const getActiveTab = () => tabs.find(tab => tab.id === activeTabId);
    const documentIdentity = tab => owners.get(tab.id);
    const liveDocument = () => window.markdownEditor.value;
    const isDirty = tab => tab.dirty;
    const snapshotActiveTab = () => { throw new Error('Unexpected active close'); };
    const notify = message => state.errors.push(message);
    const bumpDocumentRevision = () => { documentRevision++; };
    const renderTabs = () => {};
    const saveTabs = () => {};
    const sameDocument = (left, right) => left === right;
    window.CustomTabs = {
      getTabs: () => tabs, getActiveTabId: () => activeTabId,
      getDocumentIdentityForTab: id => ({ ...owners.get(id) }),
      getDocumentDescriptor: id => descriptors.get(id),
      __inEditMode: () => true,
      ${projection}
      __shutdownFreeze: () => ({
        frozen: state.frozen, dialogDecisionIntent, revision: documentRevision,
        deferredOperationCount: 0, deferredOperationsDropped: false,
      }),
    };
    ${contextSource}
    ${closeSource}
    window.CustomTabs.closeTab = closeTab;
  `, page);
  vm.runInContext(dialogs, page);
  const exec = async code => {
    const result = await vm.runInContext(code, page);
    return result === undefined ? undefined : plain(result);
  };
  const host = vm.createContext({
    require, exec, focusedRendererDialogGuard: options.focusedGuard || null,
    closedDeletedA: state.a, closedDeletedB: state.b,
    closedDeletedFile: aPath, closedDeletedBFile: bPath, closedDeletedBBytes: bBytes,
    closedEnvelopeHeld: true, heldClosedDeliveries: [{ prerequisite: "controlled producer port" }],
    closedHeldIdentity: { prerequisite: "controlled identity port" },
    ready: { rendererPageSession: "PAGE", rendererGeneration: 1 },
    __shutdown: {
      state: () => ({ renderer: "ready", pendingId: 0,
        rendererPageSession: "PAGE", rendererGeneration: 1 }),
      documentAdmissionIsCurrent: ref => admitted.has(ref),
      documentSessionState: () => ({
        owners: mainOwners.filter(owner => admitted.has(owner.documentRef)),
      }),
    },
    switchB: async () => {
      vm.runInContext("activeTabId = 11; latestTabSwitchIntent++;", page);
      state.selected = 11; win.currentFilePath = bPath; win.originalMarkdown = bBytes;
      win.markdownEditor.value = bBytes.replace(/\r\n/g, "\n");
      options.beforeStart?.(state);
    },
  });
  state.win = win; state.page = page; state.dialog = () => document.getElementById("appMessageDialog");
  state.originalShow = originalShow; state.currentShow = () => Dialog.prototype.showModal;
  state.showAgain = () => state.dialog().showModal();
  state.replaceButtons = () => state.dialog().querySelector("#appMessageButtons")
    .replaceChildren(new Element("button"), new Element("button"));
  state.appendButton = (choice = true) => {
    const extra = new Element("button");
    if (choice) extra.dataset.dialogChoice = "foreign";
    extra.textContent = "Different action";
    state.dialog().querySelector("#appMessageButtons").append(extra);
  };
  state.run = () => vm.runInContext("(async () => {\n" + cleanCapture +
    "\nawait switchB();\n" + deletedClose + "\nreturn closedClose;\n})()", host);
  state.dispose = () => win.dispatchEvent(new Event("pagehide"));
  options.initially?.(state);
  return state;
}

async function main() {
  await check("setup joins actual ordinary retirement before seeding or calling admission", async () => {
    const state = fixture({ heldClose: true }), caller = setupCaller(state);
    const pending = caller.run();
    await reached(state.waitForClose("A"), "outgoing close");
    assert.deepEqual(caller.events, ["retire"]);
    assert.equal(state.liveRefs.has("REF_A"), true);
    state.heldCloses.shift()();
    await reached(caller.primaryEntered.promise, "primary admission");
    assert.deepEqual(caller.events, ["retire", "retired", "seed-A", "admit-A"]);
    assert.equal(state.liveRefs.has("REF_A"), false);
    caller.primary.resolve();
    await reached(caller.companionEntered.promise, "companion admission");
    assert.equal(caller.events.at(-1), "pair-B-and-restore-A");
    let completed = false;
    pending.then(() => { completed = true; });
    assert.equal(completed, false);
    caller.companion.resolve();
    const result = await reached(pending, "completed pair setup");
    assert.equal(caller.events.at(-1), "pair-B-and-restore-A");
    assert.equal(result.closedDeletedA.id, caller.admittedA.id);
    assert.equal(result.closedDeletedB.id, caller.admittedB.id);
    assert.deepEqual(plain(result.closedSetupRetirement.remaining).map(tab => tab.id), ["B", "C"]);
  });
  for (const [label, fault] of [
    ["dirty", { dirty: ["A"] }], ["deleted", { deleted: true }],
    ["unknown", { unknownOwner: true }], ["unretired Main admission", { keepAdmission: true }],
    ["rejected close", { rejectClose: true }],
  ]) {
    await check("setup refuses " + label + " predecessor without opening another fixture", async () => {
      const state = fixture(fault), caller = setupCaller(state);
      await assert.rejects(caller.run(), /fixture cleanup failed|left its captured fixture owner live/);
      assert.deepEqual(caller.events, ["retire"]);
      assert.equal(state.calls.some(call => call.startsWith("approve:")), false);
    });
  }
  for (const failure of ["seed", "primary", "companion"]) {
    await check(failure + " failure rejects the actual pair setup", async () => {
      const caller = setupCaller(fixture(), failure);
      caller.primary.resolve();
      caller.companion.resolve();
      await assert.rejects(caller.run(), /refused/);
    });
  }
  await check("companion retirement awaits its original close and Main retirement, preserving unrelated tabs", async () => {
    const state = fixture({ heldClose: true });
    const pending = retirementCaller(state);
    await reached(state.waitForClose("B"), "companion close");
    assert.equal(state.liveRefs.has("REF_B"), true);
    assert.deepEqual(plain(state.calls).filter(call => call.startsWith("close:")), ["close:B"]);
    state.heldCloses.shift()();
    const result = await reached(pending, "companion retirement");
    assert.equal(state.liveRefs.has("REF_B"), false);
    assert.deepEqual(plain(result.remaining).map(tab => tab.id), ["C"]);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].tabId, "B");
  });
  await check("a missing deleted-owner close cannot retire the ordinary companion", async () => {
    const state = fixture();
    await assert.rejects(retirementCaller(state, false), /cannot retire before/);
    assert.equal(state.calls.some(call => call.startsWith("close:")), false);
  });
  for (const [label, fault] of [
    ["dirty", { dirty: ["B"] }], ["deleted", { deleted: true }],
    ["unknown", { unknownOwner: true }], ["unretired Main admission", { keepAdmission: true }],
    ["rejected close", { rejectClose: true }],
  ]) {
    await check("ordinary companion retirement refuses " + label + " without broad approval", async () => {
      const state = fixture(fault);
      await assert.rejects(retirementCaller(state), /fixture cleanup failed|left its captured fixture owner live/);
      assert.equal(state.calls.some(call => call.startsWith("approve:")), false);
    });
  }
  await check("next actor has no broad clear and the companion file is never unlinked", async () => {
    const boundary = between(source, "  const closedAfterLateAcknowledgement =",
      "\n  const heldReplacementDeliveries =");
    assert(!setup.includes("clearTabs("));
    assert(!setup.includes("CustomTabs.createTab("));
    assert(!boundary.includes("clearTabs("));
    assert(!source.includes("unlinkSync(closedDeletedBFile)"));
  });
  await check("actual clean-deleted close and dialog await Main revalidation before one production choice", async () => {
    const state = deletedFixture({ holdBeforeAnswer: true });
    try {
      const pending = state.run();
      await reached(state.barrierEntered.promise, "Main pre-answer barrier");
      const evidence = state.win.__f22ClosedOwner;
      assert.equal(evidence.done instanceof Promise || typeof evidence.done.then === "function", true);
      assert.equal(evidence.settled, false);
      assert.equal(evidence.presentations.length, 1);
      assert.equal(state.dialog().open, true);
      assert.deepEqual(state.choices, []);
      assert.deepEqual(state.retirements, []);
      assert.equal(state.admitted.has("REF_10"), true);
      state.barrierGate.resolve();
      const result = await reached(pending, "actual deleted close");
      assert.equal(result.gone, true);
      assert.deepEqual(state.choices, ["proceed"]);
      assert.equal(state.retirements.length, 1);
      assert.equal(state.admitted.has("REF_10"), false);
      assert.equal(state.admitted.has("REF_11"), true);
      assert.deepEqual(state.tabs.map(tab => tab.id), [11]);
      assert.equal(state.queries.length, 4, "two driver checks plus the original before/after-consent checks");
      assert.equal(state.dialog().open, false);
      assert.equal(state.currentShow(), state.originalShow);
      assert.equal(Object.hasOwn(state.win, "__f22ClosedOwner"), false);
      assert.deepEqual(state.errors, []);
    } finally { state.dispose(); }
  });
  for (const [label, change] of [
    ["dirty cache", s => { s.a.dirty = true; }],
    ["saved baseline", s => { s.a.originalContent += "CHANGED"; }],
    ["live editor", s => { s.win.markdownEditor.value += "CHANGED"; }],
    ["unknown initial owner", s => { s.owners.delete(10); }],
  ]) {
    await check("initial capture rejects " + label, async () => {
      const state = deletedFixture({ initially: change });
      try {
        await assert.rejects(state.run(), /exact clean live primary/);
        assert.deepEqual(state.choices, []);
        assert.deepEqual(state.retirements, []);
        assert.equal(state.currentShow(), state.originalShow);
      } finally { state.dispose(); }
    });
  }
  for (const [label, change] of [
    ["unknown deletion", s => { s.unknown = true; }],
    ["resolved deletion", s => { s.unresolved = false; }],
    ["unreadable deletion", s => { s.unreadable = true; }],
    ["pending Save", s => { s.pending = 1; }],
    ["frozen page", s => { s.frozen = true; }],
    ["pending navigation", s => { s.navigation = 1; }],
    ["missing Main admission", s => { s.admitted.delete("REF_10"); }],
  ]) {
    await check("deleted close refuses " + label + " before presentation", async () => {
      const state = deletedFixture({ beforeStart: change });
      try {
        await assert.rejects(state.run(), /genuine deleted-owner close failed/);
        assert.deepEqual(state.choices, []);
        assert.deepEqual(state.retirements, []);
        assert.equal(state.currentShow(), state.originalShow);
      } finally { state.dispose(); }
    });
  }
  for (const [label, change] of [
    ["wrong title", s => { s.dialog().querySelector("#appMessageTitle").textContent = "Different question"; }],
    ["wrong message", s => { s.dialog().querySelector("#appMessageText").textContent = "Different message"; }],
    ["wrong filename", s => { s.dialog().querySelector("#appMessageName").textContent = "different.md"; }],
    ["wrong affirmative label", s => { s.dialog().querySelectorAll("[data-dialog-choice]")[1].textContent = "Discard and close"; }],
    ["extra action", s => { s.appendButton(); }],
    ["extra unlabelled action", s => { s.appendButton(false); }],
    ["changed identity", s => { s.owners.get(10).documentGeneration++; }],
    ["changed cache", s => { s.a.content += "CHANGED"; }],
    ["changed baseline", s => { s.a.originalContent += "CHANGED"; }],
    ["changed live selection", s => { s.win.markdownEditor.value += "CHANGED"; }],
    ["changed deletion revision", s => { s.deletionRevision++; }],
    ["changed Save revision", s => { s.saveRevision++; }],
    ["changed reload sequence", s => { s.reloadSequence++; }],
    ["changed decision intent", s => { vm.runInContext("dialogDecisionIntent++;", s.page); }],
  ]) {
    await check("owned question cancels rather than approving " + label, async () => {
      const state = deletedFixture({ beforeAnswer: change });
      try {
        await assert.rejects(state.run(), /genuine deleted-owner close failed/);
        assert.deepEqual(state.choices, ["cancel"]);
        assert.deepEqual(state.retirements, []);
        assert.equal(state.admitted.has("REF_10"), true);
        assert.equal(state.tabs.includes(state.a), true);
        assert.equal(state.dialog().open, false);
        assert.equal(state.currentShow(), state.originalShow);
        assert.equal(state.win.__f22ClosedOwner.settled, true);
      } finally { state.dispose(); }
    });
  }
  for (const [label, change] of [
    ["duplicate presentation", s => { s.showAgain(); }],
    ["replaced buttons", s => { s.replaceButtons(); }],
  ]) {
    await check("lost presentation ownership never answers or cancels " + label, async () => {
      const state = deletedFixture({ beforeAnswer: change });
      try {
        await assert.rejects(state.run(), /genuine deleted-owner close failed/);
        assert.deepEqual(state.choices, []);
        assert.deepEqual(state.retirements, []);
        assert.equal(state.admitted.has("REF_10"), true);
        assert(state.win.__f22ClosedOwner.cleanupFailures.length > 0);
        assert.equal(state.currentShow(), state.originalShow);
      } finally { state.dispose(); }
    });
  }
  await check("original close rechecks deletion after the production choice", async () => {
    const state = deletedFixture({ onProceed: s => { s.deletionRevision++; } });
    try {
      await assert.rejects(state.run(), /genuine deleted-owner close failed/);
      assert.deepEqual(state.choices, ["proceed"]);
      assert.deepEqual(state.retirements, []);
      assert.equal(state.admitted.has("REF_10"), true);
      assert.equal(state.tabs.includes(state.a), true);
      assert.equal(state.currentShow(), state.originalShow);
    } finally { state.dispose(); }
  });
  for (const fault of ["refuseRetirement", "keepMainAdmission", "focusedGuard"]) {
    await check("deleted close cannot continue after " + fault, async () => {
      const state = deletedFixture({ [fault]: true });
      try {
        await assert.rejects(state.run(), /genuine deleted-owner close failed/);
        assert.equal(state.admitted.has("REF_11"), true);
        assert.equal(state.tabs.includes(state.b), true);
        assert.equal(state.currentShow(), state.originalShow);
      } finally { state.dispose(); }
    });
  }
  console.log(`F22 closed-companion contracts: ${passed} passed, 0 failed; source/VM callers only. ` +
    "Close, confirmation and embedded dialog bodies are actual source. " +
    "Main, held-envelope, admission, selection and DOM are controlled ports; no native qualification.");
}

reached(main(), "the complete F22 control body").catch(error => {
  console.error(error);
  process.exitCode = 1;
});
