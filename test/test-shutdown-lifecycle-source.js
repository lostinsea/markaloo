"use strict";

// Actual leaf helpers with simulated page collaborators. No Main or Electron.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = process.argv[2] || path.join(__dirname, "test-tab-refresh.js");
const source = fs.readFileSync(sourcePath, "utf8");
let passed = 0;
const check = (name, body) => {
  body();
  passed += 1;
  console.log("PASS  lifecycle source " + name);
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
  const owner = { tabId: "tab-1", pageSession: "page-1" };
  const tab = {
    id: owner.tabId, filePath, content: text, originalContent: text,
    hasUnsavedChanges: false, diskVersion: { dev: 1, ino: 2, size: 23, mtimeMs: 4, ctimeMs: 5 },
  };
  const dialog = { showOpenDialog() { throw new Error("Unowned chooser used"); } };
  const originalChooser = dialog.showOpenDialog;
  const tabs = [tab];
  const page = {
    originalMarkdown: text, currentFilePath: filePath,
    getReloadRequestSession: () => owner.pageSession,
    queryDocumentDeletionState: () => ({ known: !options.unknownOwner, unresolved: false }),
    document: { getElementById: () => ({ textContent: "Exact physical fixturesecond paragraph" }) },
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
    originalChooser, processorGate, renderGate, tabs };
}

async function main() {
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
    assert.equal(current.log.at(-1), "layout");
  });
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
  console.log(`=== ${passed}/${passed} lifecycle source controls passed; no Main/native execution ===`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
