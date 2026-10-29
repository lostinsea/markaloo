"use strict";

// Actual-source/VM controls only. No Electron, real admission or real dialog.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { isDeepStrictEqual } = require("node:util");

const source = fs.readFileSync(path.join(__dirname, "test-tab-refresh.js"), "utf8")
  .replace(/\r\n/g, "\n");
const start = source.indexOf("async function closeOwnedFixtureTabs(exec, phase,");
const end = source.indexOf("\nasync function run(win) {", start);
assert.ok(start >= 0 && end > start, "exact shared close source exists");
assert.equal(source.indexOf("async function closeOwnedFixtureTabs(exec, phase,", start + 1), -1);
const helper = source.slice(start, end);
const aliasStart = source.indexOf("  const nativeOriginalDiscard = await exec(");
const aliasEnd = source.indexOf("\n  selectNativePath(repeatedLogicalPath);", aliasStart);
assert.ok(aliasStart >= 0 && aliasEnd > aliasStart, "exact alias cleanup caller exists");
const aliasCaller = source.slice(aliasStart, aliasEnd);
const producer = fs.readFileSync(
  path.join(__dirname, "..", "src", "custom-tabs.js"), "utf8",
).replace(/\r\n/g, "\n");
const stateStart = producer.indexOf("    __documentState: (tab) => {");
const stateEnd = producer.indexOf("    __reloadState:", stateStart);
assert.ok(stateStart >= 0 && stateEnd > stateStart, "actual document-state projection exists");
const stateProjection = producer.slice(stateStart, stateEnd);

let passed = 0;
async function check(name, run) {
  await run();
  passed += 1;
  console.log("PASS  " + name);
}

function fixture(options = {}) {
  const calls = [];
  const checks = [];
  const liveRefs = new Set(["REF_A", "REF_B", "REF_C"]);
  const tabs = ["A", "B", "C"].map(id => ({
    id, filePath: id + ".md", filename: id + ".md", content: "BODY_" + id,
    originalContent: "BODY_" + id,
    dirty: (options.dirty || []).includes(id), revision: 1,
  }));
  const owners = new Map(tabs.map(tab => [tab.id, {
    pageSession: "PAGE", rendererGeneration: 1, tabId: tab.id,
    documentGeneration: 1, pathKey: tab.filePath, documentRef: "REF_" + tab.id,
  }]));
  const documentState = new WeakMap(tabs.map(tab => [tab, {
    get dirty() { return tab.dirty; },
    get content() { return tab.content; },
    get originalContent() { return tab.originalContent; },
    get foldedLive() { return tab.content; },
    get mutationRevision() { return tab.revision; },
    reloadConflict: !!options.reloadConflict,
    saveFailure: !!options.saveFailure,
    deletionTombstone: options.tombstone ? { eventId: 1 } : null,
  }]));
  const projectState = vm.runInNewContext("({" + stateProjection + "})", {
    documentState,
    sameDocument: (left, right) => left === right,
  }).__documentState;
  let selected = options.selected || "B";
  let intent = 7;
  let tick = 0;
  let observer = null;
  let queued = [];
  let currentQuestion = null;
  let pendingResolve = null;
  const heldCloses = [];
  const closeStarted = new Map();
  const dialog = { open: false };
  const fields = {
    appMessageTitle: { textContent: "Close without saving?" },
    appMessageText: {
      textContent: "This tab has unsaved changes. Close it and discard them?",
    },
    appMessageName: { textContent: "" },
  };
  const buttons = [
    { dataset: { dialogChoice: "cancel" }, textContent: "Cancel" },
    { dataset: { dialogChoice: "proceed" }, textContent: "Discard and close" },
  ];
  const removal = tab => {
    const index = tabs.indexOf(tab);
    if (index >= 0 && !options.noRemoval) tabs.splice(index, 1);
    if (!options.keepAdmission) liveRefs.delete("REF_" + tab.id);
    if (options.foreignEvidence) win.__fixtureTabCleanup = { key: "FOREIGN" };
  };
  buttons[1].click = () => {
    calls.push("approve:" + currentQuestion.id);
    dialog.open = false;
    removal(currentQuestion);
    pendingResolve();
  };
  const win = {
    markdownEditor: { value: "BODY_" + selected },
    originalMarkdown: "BODY_" + selected,
    getReloadRequestSession: () => "PAGE",
    getPendingSaveStatus: () => ({ count: options.pending ? 1 : 0 }),
    folia: {
      getVersion: () => "CONTROL_ONLY",
      queryDocumentDeletionState: () => ({
        known: !options.unknownOwner, unresolved: !!options.deleted,
        revision: options.changedDeletion && dialog.open ? 2 : 1,
      }),
    },
    CustomTabs: {
      getTabs: () => tabs,
      getActiveTabId: () => selected,
      getDocumentIdentityForTab: (id, filePath, session) => {
        assert.equal(filePath, tabs.find(tab => tab.id === id)?.filePath);
        assert.equal(session, "PAGE");
        const owner = owners.get(id);
        return options.changedOwner && dialog.open
          ? { ...owner, documentGeneration: 2 } : owner;
      },
      getDocumentDescriptor: id => ({ ref: "REF_" + id, logicalPath: id + ".md" }),
      __documentState: projectState,
      __inEditMode: () => true,
      __shutdownFreeze: () => ({ frozen: !!options.frozen, dialogDecisionIntent: intent }),
      closeTab: tabId => {
        if (calls.some(call => call === "close:" + tabId)) {
          throw new Error("duplicate close");
        }
        calls.push("close:" + tabId);
        closeStarted.get(tabId)?.();
        const tab = tabs.find(item => item.id === tabId);
        if (options.rejectClose) return Promise.reject(new Error("CLOSE_REJECTED"));
        if (options.incomplete) return new Promise(() => {});
        if (options.heldClose) return new Promise(resolve => {
          heldCloses.push(() => { removal(tab); resolve(); });
        });
        if (options.activeFold && tab.id === selected) {
          tab.content = options.foldNewlines
            ? win.markdownEditor.value.replace(/\n/g, "\r\n") : win.markdownEditor.value;
          tab.dirty = true;
          tab.revision += 1;
        }
        if (!tab.dirty && !options.reloadConflict && !options.saveFailure) {
          removal(tab);
          return Promise.resolve();
        }
        if (options.silentDirtyRemoval) {
          removal(tab);
          return Promise.resolve();
        }
        currentQuestion = tab;
        fields.appMessageName.textContent = tab.filename;
        if (options.wrongQuestion) fields.appMessageTitle.textContent = "Different question";
        dialog.open = true;
        intent += options.wrongIntent ? 2 : 1;
        queued.push({ target: dialog, oldValue: null });
        if (options.duplicateQuestion) queued.push({ target: dialog, oldValue: null });
        if (options.changedRevision) tab.revision += 1;
        if (options.changedContent) tab.content += "_CHANGED";
        if (options.changedSelection) selected = "C";
        if (options.flashQuestion) {
          queueMicrotask(() => { dialog.open = false; removal(tab); pendingResolve(); });
        }
        return new Promise(resolve => { pendingResolve = resolve; });
      },
    },
  };
  if (options.activeFold) {
    tabs.find(tab => tab.id === selected).content = "OLD_CACHE";
    tabs.find(tab => tab.id === selected).dirty = false;
  }
  if (options.preexistingEvidence) win.__fixtureTabCleanup = { key: "OLD" };
  if (options.preexistingQuestion) dialog.open = true;
  class Observer {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    takeRecords() { const result = queued; queued = []; return result; }
    disconnect() { observer = null; }
  }
  const page = vm.createContext({
    window: win,
    document: {
      documentElement: {},
      getElementById: id => id === "appMessageDialog" ? dialog : fields[id],
      querySelectorAll: () => buttons,
      querySelector: () => buttons[1],
    },
    MutationObserver: Observer,
    Date: { now: () => tick },
    setTimeout: options.heldClose ? setTimeout :
      (callback, ms) => { tick += ms; queueMicrotask(callback); },
  });
  const exec = async code => {
    if (options.unreadableEvidence && code.includes("window.__fixtureTabCleanup?.key")) {
      throw new Error("PAGE_UNREADABLE");
    }
    const result = await vm.runInContext(code, page);
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  };
  const host = vm.createContext({
    require, isDeepStrictEqual, AggregateError,
    __shutdown: {
      documentAdmissionIsCurrent: ref => {
        calls.push("main:" + ref + ":" + liveRefs.has(ref));
        return liveRefs.has(ref);
      },
    },
    check: (name, ok, detail) => checks.push({ name, ok, detail }),
    waitForCondition: async (run, expression) => !!await run(expression),
  });
  const close = vm.runInContext(helper + "\ncloseOwnedFixtureTabs", host);
  const permission = id => ({
    tabId: id, filePath: id + ".md", owner: { ...owners.get(id) },
    content: "BODY_" + id, reason: "Discard this exact fixture edit",
  });
  return {
    win, tabs, calls, checks, liveRefs, permission, exec, close, dialog,
    observer: () => observer, heldCloses,
    waitForClose: id => calls.includes("close:" + id) ? Promise.resolve() :
      new Promise(resolve => closeStarted.set(id, resolve)),
  };
}

async function refuses(options, expected, permissions = ["A"]) {
  const state = fixture({ dirty: ["A"], ...options });
  const expectedDiscards = permissions.map(id => state.permission(id));
  if (options.badPermission) options.badPermission(expectedDiscards);
  await assert.rejects(
    state.close(state.exec, "control", { tabIds: ["A"], expectedDiscards }), expected,
  );
  assert.equal(state.calls.some(call => call.startsWith("approve:")), false);
  assert.equal(state.tabs.some(tab => tab.id === "A"), true);
  assert.equal(state.observer(), null);
  return state;
}

function runAliasCaller(state, change = () => {}) {
  const tab = state.tabs.find(item => item.id === "A");
  tab.content = "# Admitted source\n\nNATIVE_ALIAS_KEEP_EDIT\n";
  tab.hasUnsavedChanges = true;
  const nativeOriginal = {
    owner: state.permission("A").owner, document: { ref: "REF_A" },
  };
  change(tab, nativeOriginal);
  return vm.runInNewContext("(async () => {" + aliasCaller + "\n})()", {
    exec: state.exec, nativeOriginal, source: "A.md",
    clearFixtureTabs: (phase, expectedDiscards) =>
      state.close(state.exec, phase, { expectedDiscards }),
  });
}

async function main() {
  await check("all closes retain background-first active-last order and Main retirement barriers", async () => {
    const state = fixture();
    const result = await state.close(state.exec, "control");
    assert.deepEqual(state.calls.filter(call => call.startsWith("close:")),
      ["close:A", "close:C", "close:B"]);
    assert.equal(result.records.length, 3);
    assert.equal(result.remaining.length, 0);
    assert.ok(state.calls.indexOf("main:REF_A:false") < state.calls.indexOf("close:C"));
    assert.ok(state.calls.indexOf("main:REF_C:false") < state.calls.indexOf("close:B"));
    assert.equal(Object.hasOwn(state.win, "__fixtureTabCleanup"), false);
  });
  await check("explicit subsets preserve unrelated tabs and their original order", async () => {
    const state = fixture();
    const result = await state.close(state.exec, "subset", { tabIds: ["B"] });
    assert.deepEqual(result.remaining.map(tab => tab.id), ["A", "C"]);
    assert.deepEqual(state.calls.filter(call => call.startsWith("close:")), ["close:B"]);
  });
  await check("a held original close prevents the next owner from starting", async () => {
    const state = fixture({ heldClose: true });
    const result = state.close(state.exec, "held", { tabIds: ["A", "B"] });
    await state.waitForClose("A");
    assert.deepEqual(state.calls.filter(call => call.startsWith("close:")), ["close:A"]);
    assert.equal(state.heldCloses.length, 1);
    state.heldCloses.shift()();
    await state.waitForClose("B");
    assert.deepEqual(state.calls.filter(call => call.startsWith("close:")), ["close:A", "close:B"]);
    assert.equal(state.heldCloses.length, 1);
    state.heldCloses.shift()();
    assert.equal((await result).records.length, 2);
  });
  await check("duplicate and missing target IDs refuse before any close", async () => {
    for (const tabIds of [["A", "A"], ["MISSING"]]) {
      const state = fixture();
      await assert.rejects(state.close(state.exec, "control", { tabIds }), /exact existing/);
      assert.equal(state.calls.some(call => call.startsWith("close:")), false);
    }
  });
  await check("exact ordinary dirty permission answers the actual question once", async () => {
    const state = fixture({ dirty: ["A"] });
    const result = await state.close(state.exec, "dirty", {
      tabIds: ["A"], expectedDiscards: [state.permission("A")],
    });
    assert.equal(result.records[0].answered, true);
    assert.equal(result.records[0].presentations, 1);
    assert.deepEqual(state.calls.filter(call => call.startsWith("approve:")), ["approve:A"]);
  });
  await check("a permitted active edit survives its real close-time cache fold", async () => {
    const state = fixture({ selected: "A", activeFold: true });
    const tab = state.tabs.find(item => item.id === "A");
    tab.originalContent = "DISK_BASE";
    const result = await state.close(state.exec, "active fold", {
      tabIds: ["A"], expectedDiscards: [state.permission("A")],
    });
    assert.equal(result.records[0].initialCache, "OLD_CACHE");
    assert.equal(result.records[0].initialLive, "BODY_A");
    assert.equal(result.records[0].needsDiscard, true);
    assert.equal(result.records[0].mutationRevision, 2);
    assert.equal(result.records[0].answered, true);
    assert.deepEqual(state.calls.filter(call => call.startsWith("approve:")), ["approve:A"]);
  });
  await check("textarea newline spelling does not invent or erase discard consent", async () => {
    const clean = fixture({ selected: "A" });
    const cleanTab = clean.tabs.find(tab => tab.id === "A");
    cleanTab.content = cleanTab.originalContent = "BODY_A\r\n";
    clean.win.markdownEditor.value = "BODY_A\n";
    const cleanResult = await clean.close(clean.exec, "clean CRLF", { tabIds: ["A"] });
    assert.equal(cleanResult.records[0].needsDiscard, false);
    assert.equal(cleanResult.records[0].answered, false);
    const dirty = fixture({ selected: "A", activeFold: true, foldNewlines: true });
    dirty.win.markdownEditor.value = "BODY_A\nEDIT\n";
    const permission = { ...dirty.permission("A"), content: dirty.win.markdownEditor.value };
    const dirtyResult = await dirty.close(dirty.exec, "dirty CRLF", {
      tabIds: ["A"], expectedDiscards: [permission],
    });
    assert.equal(dirtyResult.records[0].needsDiscard, true);
    assert.equal(dirtyResult.records[0].answered, true);
    assert.equal(dirtyResult.records[0].mutationRevision, 2);
  });
  await check("dirty questions without exact owner content or reason never receive approval", async () => {
    await refuses({}, /fixture cleanup failed/, []);
    for (const badPermission of [
      entries => { entries[0].owner.documentGeneration = 9; },
      entries => { entries[0].filePath = "OTHER.md"; },
      entries => { entries[0].tabId = "B"; },
      entries => { entries[0].content = "OTHER"; },
      entries => { entries[0].reason = ""; },
      entries => { entries.push({ ...entries[0] }); },
    ]) await refuses({ badPermission }, /fixture cleanup failed/);
  });
  await check("deleted unresolved or unknown owners refuse before issuing a close", async () => {
    for (const flags of [{ deleted: true }, { unknownOwner: true }, { tombstone: true }]) {
      const state = await refuses(flags, /fixture cleanup failed/);
      assert.equal(state.calls.some(call => call.startsWith("close:")), false);
    }
  });
  await check("actual conflict and Save-failure dirtiness require exact consent even with unchanged bytes", async () => {
    for (const flags of [{ reloadConflict: true }, { saveFailure: true }]) {
      const state = fixture(flags);
      assert.equal(state.tabs[0].content, state.tabs[0].originalContent);
      assert.equal(state.tabs[0].dirty, false);
      assert.equal(state.win.CustomTabs.__documentState(state.tabs[0]).dirty, true);
      const result = await state.close(state.exec, "retained dirty state", {
        tabIds: ["A"], expectedDiscards: [state.permission("A")],
      });
      assert.equal(result.records[0].needsDiscard, true);
      assert.equal(result.records[0].answered, true);
      const refused = fixture(flags);
      await assert.rejects(refused.close(refused.exec, "no permission", { tabIds: ["A"] }),
        /fixture cleanup failed/);
      assert.equal(refused.calls.some(call => call.startsWith("close:")), false);
    }
  });
  await check("changed owner selection mutation deletion and intent fail without approval", async () => {
    for (const name of ["changedOwner", "changedSelection", "changedRevision",
      "changedContent", "changedDeletion", "wrongIntent"]) {
      await refuses({ [name]: true }, /fixture cleanup failed/);
    }
  });
  await check("silent dirty removal and between-poll external answers cannot pass cleanup", async () => {
    for (const flags of [{ silentDirtyRemoval: true }, { flashQuestion: true }]) {
      const state = fixture({ dirty: ["A"], ...flags });
      await assert.rejects(state.close(state.exec, "control", {
        tabIds: ["A"], expectedDiscards: [state.permission("A")],
      }), /fixture cleanup failed/);
      assert.equal(state.calls.some(call => call.startsWith("approve:")), false);
      assert.equal(Object.hasOwn(state.win, "__fixtureTabCleanup"), true);
    }
    const state = await refuses({ silentDirtyRemoval: true }, /fixture cleanup failed/, []);
    assert.equal(state.calls.some(call => call.startsWith("close:")), false);
  });
  await check("pending saves frozen state wrong or repeated questions refuse without approval", async () => {
    for (const name of ["pending", "frozen", "wrongQuestion", "duplicateQuestion",
      "preexistingQuestion"]) {
      await refuses({ [name]: true }, /fixture cleanup failed/);
    }
  });
  await check("resolved close without exact removal or Main retirement stops the next target", async () => {
    for (const flags of [{ noRemoval: true }, { keepAdmission: true }]) {
      const state = fixture(flags);
      await assert.rejects(state.close(state.exec, "control"), /cleanup failed|left its captured/);
      assert.deepEqual(state.calls.filter(call => call.startsWith("close:")), ["close:A"]);
      assert.equal(Object.hasOwn(state.win, "__fixtureTabCleanup"), true);
    }
  });
  await check("rejected and incomplete closes retain their genuine evidence and fail", async () => {
    for (const flags of [{ rejectClose: true }, { incomplete: true }]) {
      const state = fixture(flags);
      await assert.rejects(state.close(state.exec, "control"), /fixture cleanup failed/);
      assert.deepEqual(state.calls.filter(call => call.startsWith("close:")), ["close:A"]);
      assert.equal(state.win.__fixtureTabCleanup.records.length, 1);
      assert.equal(state.observer(), null);
      assert.match(state.checks[0].detail, /CLOSE_REJECTED|remained incomplete/);
    }
  });
  await check("foreign evidence is never erased and missing histories are explicitly unknown", async () => {
    const state = fixture({ foreignEvidence: true });
    await assert.rejects(state.close(state.exec, "control"), /evidence ownership changed/);
    assert.equal(state.win.__fixtureTabCleanup.key, "FOREIGN");
    const old = fixture({ preexistingEvidence: true });
    await assert.rejects(old.close(old.exec, "control"), /fixture cleanup failed/);
    assert.equal(old.win.__fixtureTabCleanup.key, "OLD");
    assert.match(old.checks[0].detail, /"known":false/);
  });
  await check("primary and independent evidence read failures remain visible", async () => {
    const state = fixture({ rejectClose: true, unreadableEvidence: true });
    await assert.rejects(state.close(state.exec, "control"), error => {
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[0]), /CLOSE_REJECTED/);
      assert.match(String(error.errors[1]), /PAGE_UNREADABLE/);
      return true;
    });
    assert.match(state.checks[0].detail, /"known":false/);
    assert.equal(state.win.__fixtureTabCleanup.records[0].error.includes("CLOSE_REJECTED"), true);
  });
  await check("the actual native spelling caller permits only its deliberately retained original edit", async () => {
    const state = fixture({ dirty: ["A"] });
    await runAliasCaller(state);
    assert.deepEqual(state.calls.filter(call => call.startsWith("approve:")), ["approve:A"]);
    assert.equal(state.tabs.length, 0);
    for (const change of [
      tab => { tab.content += "OTHER"; },
      tab => { tab.filePath = "OTHER.md"; },
      tab => { tab.hasUnsavedChanges = false; },
      (_tab, original) => { original.owner.documentGeneration += 1; },
      (_tab, original) => { original.document.ref = "OTHER"; },
    ]) {
      const bad = fixture({ dirty: ["A"] });
      await assert.rejects(runAliasCaller(bad, change), /retained original edit/);
      assert.equal(bad.calls.some(call => call.startsWith("close:")), false);
    }
  });
  console.log("SOURCE/VM ONLY: " + passed + " passed; native close behavior is not qualified.");
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
