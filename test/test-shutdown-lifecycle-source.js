"use strict";

// Actual leaf helpers with simulated page collaborators. No Main or Electron.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const companion = process.argv.at(-1) === "--companion";
const args = process.argv.slice(2, companion ? -1 : undefined);
if (args.length > 1 || args.some(argument => !argument || argument.startsWith("--")))
  throw new Error("Usage: node test-shutdown-lifecycle-source.js [sourcePath] [--companion]");
const output = (message, fatal = false) => {
  const prefix = companion ? `[companion ${fatal ? "stderr" : "stdout"}] ` : "";
  for (const line of String(message).split(/\r\n|\r|\n/))
    (fatal ? console.error : console.log)(prefix + line);
};
const sourcePath = args[0] || path.join(__dirname, "test-tab-refresh.js");
const source = fs.readFileSync(sourcePath, "utf8");
let passed = 0;
let failures = 0;
const check = (name, body) => {
  try {
    body();
    passed += 1;
    output("PASS  lifecycle source " + name);
  } catch (error) {
    failures += 1;
    output("FAIL  lifecycle source " + name + "  -> " + error.stack);
  }
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const filePath = "fixture-native.md";
  const text = "Exact physical fixture\n\nsecond paragraph\n";
  const paintMarker = "second paragraph";
  const processorGate = deferred();
  const renderGate = deferred();
  const log = [];
  const pageSession = "page-1";
  const owner = { tabId: options.wrongTab ? "foreign-tab" : "tab-1",
    pageSession: options.wrongPage ? "foreign-page" : pageSession };
  const tab = {
    id: "tab-1", filePath, content: text, originalContent: text,
    hasUnsavedChanges: false, diskVersion: { dev: 1, ino: 2, size: 23, mtimeMs: 4, ctimeMs: 5 },
  };
  const clock = { now: 0, waits: [] };
  const viewer = { textContent: "Exact physical fixturesecond paragraph" };
  const dialog = { showOpenDialog() { throw new Error("Unowned chooser used"); } };
  const originalChooser = dialog.showOpenDialog;
  const tabs = [tab];
  const page = {
    originalMarkdown: text, currentFilePath: filePath,
    getReloadRequestSession: () => pageSession,
    queryDocumentDeletionState: () => ({ known: !options.unknownOwner,
      unresolved: options.unresolvedOwner === true }),
    document: { getElementById: () => viewer },
    Date: { now: () => clock.now },
    setTimeout: (callback, delay) => {
      assert.equal(delay, 25, "Actual restore polling retains its finite interval");
      clock.waits.push(delay); clock.now += delay;
      options.afterDelay?.({ page, tab, viewer, clock, text });
      callback();
    },
    CustomTabs: {
      getActiveTab: () => tabs.at(-1),
      getTabs: () => tabs,
      getDocumentIdentityForTab: () => options.missingOwner ? null : owner,
      getDocumentDescriptor: () => ({ logicalPath: options.wrongDescriptor ? "foreign.md" : filePath }),
      settleSessionLayout: async () => {
        log.push("layout");
        if (options.layoutFailure) throw new Error("controlled layout failure");
      },
      isDocumentFrozen: () => options.frozen === true,
      __inEditMode: () => false,
      async closeTab(id) {
        log.push("close:" + id);
        assert.equal(page.originalMarkdown, text);
        await turn();
        if (!options.refuseClose) tabs.splice(tabs.findIndex(item => item.id === id), 1);
      },
    },
  };
  if (options.preexistingObservation) page.__dialogBatchNative = { preexisting: true };
  page.window = page;
  const context = vm.createContext(page);
  const exec = code => vm.runInContext(code, context, { timeout: 1000 });
  page.folia = {
    async openFileDialog() {
      const selected = await dialog.showOpenDialog({}, { properties: ["multiSelections"] });
      assert.deepEqual(selected.filePaths, [filePath]);
      const state = page.__dialogBatchNative;
      const processor = {
        packet: { path: filePath }, eventUndefined: !options.eventLeak,
        settled: false, promise: processorGate.promise,
      };
      const render = { settled: false, promise: renderGate.promise };
      state.processors.push(processor);
      state.renders.push(render);
      for (const record of [processor, render]) {
        record.promise.then(
          () => { record.settled = true; },
          error => { record.settled = true; record.error = error.message; },
        );
      }
    },
  };
  const start = source.indexOf("async function openShutdownLifecycleFixture(");
  const end = source.indexOf("async function runShutdownGenerationScenarios(", start);
  assert.ok(start >= 0 && end > start, "Actual lifecycle helper source is missing");
  const helpers = vm.compileFunction(source.slice(start, end) +
    "\nreturn { openShutdownLifecycleFixture, clearShutdownLifecycleDocuments, settleShutdownLifecycleRestore };", [
    "dialog", "installDialogBatchPageObservation", "restoreDialogBatchPageObservation",
    "replaceMethod", "waitForCondition", "boundedDialogWork", "require",
  ])(dialog, async evaluate => {
    log.push("observe");
    await evaluate(`(() => {
      window.__dialogBatchNative = { processors: [], renders: [] };
      ${options.partialInstallFailure ? "throw new Error('controlled partial installation failure');" : ""}
      return true;
    })()`);
  }, async () => {
    log.push("restore-observer");
    delete page.__dialogBatchNative;
    if (options.cleanupFailure) throw new Error("controlled observer cleanup failure");
  }, (target, key, replacement) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { ...descriptor, value: replacement });
    return () => { log.push("restore-chooser"); Object.defineProperty(target, key, descriptor); };
  }, async (evaluate, expression) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await evaluate(expression)) return true;
      await turn();
    }
    return false;
  }, work => work, require);
  return { ...helpers, exec, filePath, text, paintMarker, page, tab, log, dialog,
    originalChooser, processorGate, renderGate, tabs, clock, viewer, owner, pageSession };
}

async function activeCloseLayoutContracts() {
  const tabsSource = fs.readFileSync(path.join(__dirname, "..", "src", "custom-tabs.js"), "utf8")
    .replace(/\r\n/g, "\n");
  const region = (start, end) => {
    const first = tabsSource.indexOf(start), last = tabsSource.indexOf(end, first);
    assert(first >= 0 && first === tabsSource.lastIndexOf(start) && last > first);
    return tabsSource.slice(first, last);
  };
  const actual = region("  async function closeTab(tabId) {", "\n  function updateTabContent(") +
    region("  let sessionRestoreStarted = false;", "\n  async function loadSavedTabs(");
  function layoutFixture() {
    const durable = deferred(), replacement = deferred(), calls = [], errors = [], retired = new Set();
    const tabs = [1, 2].map(id => ({ id, filename: `owned-${id}.md`, filePath: `owned-${id}.md`,
      scrollPosition: 0, anchor: null }));
    const documentState = new WeakMap(tabs.map(tab =>
      [tab, { admission: { entryId: `entry-${tab.id}`, ref: `ref-${tab.id}` } }]));
    let durableLayout = null, switching = false;
    const context = vm.createContext({
      tabs, activeTabId: 2, activeTabForMutations: tabs[1], documentState,
      closingTabs: new Set(), pendingConfirmedReload: null, approvalRendererGeneration: 7,
      mayMutateDocument: () => true, isDocumentFrozen: () => false,
      snapshotActiveTab() {}, isDirty: () => false, safeDocumentLabel: value => value,
      documentIdentity: tab => ({ tabId: tab.id, documentRef: documentState.get(tab).admission.ref }),
      consultDocumentDeletionState: () => ({ known: true, unresolved: false, revision: 1 }),
      bumpDocumentRevision() {}, dismissUpdatePrompt() {}, renderTabs() {},
      notify: (...args) => errors.push(args),
      getActiveTab: () => tabs.find(tab => tab.id === context.activeTabId),
      switchToTab: async id => {
        switching = true;
        await replacement.promise;
        context.activeTabId = id;
        context.activeTabForMutations = tabs.find(tab => tab.id === id);
      },
      console: { log() {}, error: (...args) => errors.push(args) },
      window: {
        getReloadRequestSession: () => "source-page",
        retireDeletionTombstone: (_path, owner) => {
          retired.add(owner.documentRef);
          return { retired: true };
        },
        folia: { saveSessionLayout: async layout => {
          calls.push(layout);
          if (calls.length === 1) await durable.promise;
          else if (layout.entries.some(entry => retired.has(entry.documentRef))) {
            throw new Error("Controlled Main refuses a retired reference");
          }
          durableLayout = layout;
        } },
      },
    });
    const api = vm.runInContext(actual +
      "\n({ closeTab, saveTabs, settleSessionLayout });", context);
    return { ...api, context, calls, errors, retired, durable, replacement,
      durableLayout: () => durableLayout, switching: () => switching };
  }
  const active = layoutFixture();
  active.saveTabs();
  active.saveTabs();
  assert.equal(active.calls.length, 1, "The real writer holds the first durable layout");
  assert(active.calls[0].entries.some(entry => entry.documentRef === "ref-2"),
    "The pending pre-close layout genuinely contains the closing owner");
  const closing = active.closeTab(2);
  assert.equal(active.switching(), true);
  assert.equal(active.retired.has("ref-2"), true);
  assert.equal(active.context.activeTabId, 2, "Replacement selection is still held");
  active.durable.resolve();
  await turn();
  try {
    check("active close replaces queued retired refs before awaiting replacement selection", () => {
      assert.equal(active.calls.length, 2);
      assert.deepEqual(JSON.parse(JSON.stringify(active.calls[1])), {
        entries: [{ id: "entry-1", documentRef: "ref-1", scrollPosition: 0, anchor: null }],
        activeEntryId: null,
      });
      assert.equal(active.errors.length, 0);
      assert.equal(active.context.activeTabId, 2);
    });
  } finally { active.replacement.resolve(); }
  await closing;
  await active.settleSessionLayout();
  check("active close eventually persists the genuine replacement active identity", () => {
    assert.equal(active.context.activeTabId, 1);
    assert.equal(active.durableLayout().activeEntryId, "entry-1");
    assert.deepEqual(Array.from(active.durableLayout().entries, entry => entry.documentRef), ["ref-1"]);
  });
  const background = layoutFixture();
  background.saveTabs();
  background.saveTabs();
  let backgroundCompleted = false;
  const backgroundClose = background.closeTab(1).then(() => { backgroundCompleted = true; });
  await turn();
  check("background close remains independent of a held durable layout write", () => {
    assert.equal(backgroundCompleted, true);
    assert.equal(background.retired.has("ref-1"), true);
    assert.equal(background.calls.length, 1);
    assert.equal(background.switching(), false);
  });
  background.durable.resolve();
  await backgroundClose;
  await background.settleSessionLayout();
  assert.equal(background.durableLayout().activeEntryId, "entry-2");
}

async function main() {
  await activeCloseLayoutContracts();
  check("compiles the entire unexecuted Electron suite", () => {
    new vm.Script(source, { filename: sourcePath });
  });
  const current = fixture();
  let settled = false;
  const opening = current.openShutdownLifecycleFixture(
    current.exec, current.filePath, current.text, current.paintMarker);
  opening.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await turn();
  check("holds the actual helper on its original processor promise", () => {
    assert.equal(settled, false);
    assert.deepEqual(current.log, ["observe"]);
  });
  current.processorGate.resolve();
  await turn();
  check("joins the original render after its processor settles", () => {
    assert.equal(settled, false);
    assert.deepEqual(current.log, ["observe"]);
  });
  current.renderGate.resolve();
  const admission = await opening;
  check("returns its checked owner and restores both observations", () => {
    assert.equal(admission.tabId, current.tab.id);
    assert.equal(admission.filePath, current.filePath);
    assert.equal(current.dialog.showOpenDialog, current.originalChooser);
    assert.deepEqual(current.log, ["observe", "layout", "restore-chooser", "restore-observer"]);
  });
  check("keeps raw source authority separate from rendered paragraph text", () => {
    assert.equal(current.page.document.getElementById("viewer").textContent.includes(current.text.trim()), false);
    assert.equal(admission.filePath, current.filePath);
  });
  for (const option of ["missingOwner", "unknownOwner", "wrongDescriptor", "eventLeak"]) {
    const negative = fixture({ [option]: true });
    negative.processorGate.resolve();
    negative.renderGate.resolve();
    await assert.rejects(negative.openShutdownLifecycleFixture(
      negative.exec, negative.filePath, negative.text, negative.paintMarker), error =>
      error instanceof AggregateError &&
      error.errors.some(item => /admission, owner or original paint/.test(item.message)));
    check("refuses " + option + " and restores its chooser", () => {
      assert.equal(negative.dialog.showOpenDialog, negative.originalChooser);
      assert.equal(negative.log.at(-1), "restore-observer");
    });
  }
  for (const option of ["preexistingObservation", "partialInstallFailure"]) {
    const negative = fixture({ [option]: true });
    await assert.rejects(negative.openShutdownLifecycleFixture(
      negative.exec, negative.filePath, negative.text, negative.paintMarker),
    error => error instanceof AggregateError && error.errors.length === 1 &&
      /already owned|partial installation/.test(error.errors[0].message));
    check("respects observation ownership after " + option, () => {
      assert.equal(negative.dialog.showOpenDialog, negative.originalChooser);
      if (option === "preexistingObservation") {
        assert.equal(negative.page.__dialogBatchNative?.preexisting, true,
          "Pre-existing observation must survive rejected installation");
        assert.equal(negative.log.includes("restore-observer"), false);
      } else {
        assert.equal(negative.page.__dialogBatchNative, undefined);
        assert.equal(negative.log.at(-1), "restore-observer");
      }
    });
  }
  const failed = fixture({ cleanupFailure: true });
  const failedOpen = failed.openShutdownLifecycleFixture(
    failed.exec, failed.filePath, failed.text, failed.paintMarker);
  await turn();
  failed.processorGate.reject(new Error("controlled original processor failure"));
  failed.renderGate.resolve();
  await assert.rejects(failedOpen, error => error instanceof AggregateError &&
    error.errors.length === 2 &&
    error.errors[0].message === "controlled original processor failure" &&
    error.errors[1].message === "controlled observer cleanup failure");
  check("retains original-work and cleanup errors together", () => {
    assert.equal(failed.dialog.showOpenDialog, failed.originalChooser);
  });
  const restored = await current.settleShutdownLifecycleRestore(
    current.exec, current.filePath, current.text, current.paintMarker);
  check("checks the restored owner and settles the actual layout boundary", () => {
    assert.equal(restored.owner.tabId, current.tab.id);
    assert.equal(restored.pageSession, current.pageSession);
    assert.equal(restored.owner.pageSession, current.pageSession);
    assert.equal(current.page.originalMarkdown, current.text);
    assert.equal(current.viewer.textContent.includes(current.paintMarker), true);
    assert.equal(current.clock.waits.length, 0);
    assert.equal(current.log.at(-1), "layout");
  });
  const restoreTimeout = "Shutdown lifecycle restore did not reach its painted authenticated owner";
  for (const [label, option] of [
    ["missing owner", "missingOwner"], ["wrong tab", "wrongTab"],
    ["wrong page", "wrongPage"], ["wrong descriptor", "wrongDescriptor"],
    ["unknown Main owner", "unknownOwner"], ["unresolved Main owner", "unresolvedOwner"],
  ]) {
    const negative = fixture({ [option]: true });
    assert.equal(negative.page.getReloadRequestSession(), "page-1",
      "Expected page session is independent of the returned owner");
    assert.equal(negative.tab.id, "tab-1", "Expected tab is independent of the returned owner");
    assert.equal(negative.tab.content, negative.text);
    assert.equal(negative.tab.originalContent, negative.text);
    assert.equal(negative.page.originalMarkdown, negative.text);
    assert.equal(negative.page.currentFilePath, negative.filePath);
    assert.equal(negative.tab.hasUnsavedChanges, false);
    assert.equal(negative.viewer.textContent.includes(negative.paintMarker), true);
    const observedOwner = negative.page.CustomTabs.getDocumentIdentityForTab(
      negative.tab.id, negative.filePath, negative.pageSession);
    const descriptor = negative.page.CustomTabs.getDocumentDescriptor(negative.tab.id);
    const deletion = negative.page.queryDocumentDeletionState(negative.filePath, observedOwner);
    const invalid = {
      missingOwner: observedOwner === null,
      wrongTab: observedOwner?.tabId !== negative.tab.id,
      wrongPage: observedOwner?.pageSession !== negative.pageSession,
      wrongDescriptor: descriptor.logicalPath !== negative.tab.filePath,
      unknownOwner: deletion.known === false,
      unresolvedOwner: deletion.unresolved === true,
    };
    assert.equal(invalid[option], true, "The specific invalid restored-owner setup must be present");
    let restoredOwner, timeout;
    try {
      restoredOwner = await negative.settleShutdownLifecycleRestore(
        negative.exec, negative.filePath, negative.text, negative.paintMarker);
    } catch (error) {
      if (error.name !== "Error" || error.message !== restoreTimeout) throw error;
      timeout = error;
    }
    check("restored-owner gate refuses " + label, () => {
      assert.equal(timeout?.message, restoreTimeout, "The exact actual helper timeout must refuse the owner");
      assert.equal(restoredOwner, undefined);
      assert.deepEqual(negative.log, [], "Invalid ownership must never reach layout");
      assert.equal(negative.clock.now, 8000, "The actual polling deadline must be exhausted");
      assert.equal(negative.clock.waits.length, 320);
      assert.equal(negative.clock.waits.every(delay => delay === 25), true);
    });
  }
  for (const delayed of ["source", "paint"]) {
    const recovery = fixture({ afterDelay: ({ page, viewer, clock, text }) => {
      if (clock.waits.length !== 2) return;
      if (delayed === "source") page.originalMarkdown = text;
      else viewer.textContent = "Exact physical fixturesecond paragraph";
    } });
    if (delayed === "source") recovery.page.originalMarkdown = "Still restoring source";
    else recovery.viewer.textContent = "Still restoring paint";
    assert.equal(delayed === "source" ? recovery.page.originalMarkdown === recovery.text :
      recovery.viewer.textContent.includes(recovery.paintMarker), false,
    "Delayed recovery starts with its actual source or paint requirement unsatisfied");
    const recovered = await recovery.settleShutdownLifecycleRestore(
      recovery.exec, recovery.filePath, recovery.text, recovery.paintMarker);
    check("recovers delayed restored " + delayed + " before settling layout", () => {
      assert.equal(recovered.owner.tabId, recovery.tab.id);
      assert.equal(recovered.owner.pageSession, recovery.pageSession);
      assert.equal(recovery.page.originalMarkdown, recovery.text);
      assert.equal(recovery.viewer.textContent.includes(recovery.paintMarker), true);
      assert.deepEqual(recovery.clock.waits, [25, 25]);
      assert.equal(recovery.clock.now, 50);
      assert.deepEqual(recovery.log, ["layout"]);
    });
  }
  const failedLayout = fixture({ layoutFailure: true });
  await assert.rejects(failedLayout.settleShutdownLifecycleRestore(
    failedLayout.exec, failedLayout.filePath, failedLayout.text, failedLayout.paintMarker),
  /controlled layout failure/);
  check("does not hide an unexpected restored-layout failure", () => {
    assert.deepEqual(failedLayout.log, ["layout"]);
  });
  current.page.originalMarkdown = "new live text";
  current.tab.content = "old cached text";
  await current.clearShutdownLifecycleDocuments(current.exec);
  check("awaits owned tab removal and folds teardown bytes before close", () => {
    assert.equal(current.tabs.length, 0);
    assert.equal(current.log.at(-1), "layout");
  });
  for (const option of ["refuseClose", "frozen"]) {
    const negative = fixture({ [option]: true });
    await assert.rejects(negative.clearShutdownLifecycleDocuments(negative.exec),
      option === "frozen" ? /still frozen/ : /could not retire/);
    check("does not report successful cleanup for " + option, () => {
      assert.equal(negative.tabs.length, 1);
      assert.equal(negative.log.includes("layout"), false);
    });
  }
  output("Lifecycle source controls; no Main/native execution");
  output(`=== ${passed}/${passed + failures} passed ===`);
  if (failures) process.exitCode = 1;
}

main().catch(error => {
  output("FAIL  lifecycle source harness completed  -> " + error.stack, true);
  process.exitCode = 1;
});
