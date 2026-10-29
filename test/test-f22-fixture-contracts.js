"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { saveResultEchoesRequest } = require("./save-result-correlation");

const source = fs.readFileSync(path.join(__dirname, "test-tab-refresh.js"), "utf8").replace(/\r\n/g, "\n");
let passed = 0;
const check = (name, value) => {
  assert.ok(value, name);
  passed += 1;
  console.log("PASS " + name);
};
const between = (start, end) => {
  const first = source.indexOf(start);
  const last = first < 0 ? -1 : source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, "source boundaries: " + start);
  return source.slice(first, last);
};
const witnessDeclaration = between(
  "  const rendererSelectionWitnessSource = `",
  "\n  // The same witness, for a switch",
);
const pairDeclaration = between(
  "  const createCompanionTab = ",
  "\n\n  // The same correlation, plus the producer-owned path",
);
const pageTemplate = (start, end, values) => {
  const body = between(start, end);
  return vm.runInNewContext(body.slice(body.indexOf("`"), body.lastIndexOf("`") + 1), values);
};
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const fields = ["pageSession", "rendererGeneration", "tabId",
  "documentGeneration", "pathKey", "documentRef"];

function pairFixture(fault = {}) {
  const primary = { id: 1, filePath: "C:\\fixture\\primary.md",
    content: "a\r\nb\r", originalContent: "a\r\nb\r" };
  const companion = { id: 2, filePath: "C:\\fixture\\other.md", content: "other" };
  const owner = { pageSession: "page", rendererGeneration: 3, tabId: 1,
    documentGeneration: 4, pathKey: primary.filePath, documentRef: "primary-ref" };
  const admission = deferred();
  const switching = deferred();
  const layout = deferred();
  const calls = [];
  const window = { currentFilePath: primary.filePath, markdownEditor: { value: "a\nb\n" },
    getReloadRequestSession: () => "page", getActiveFileSelectionGeneration: () => 5 };
  window.CustomTabs = {
    getActiveTabId: () => primary.id,
    getActiveTab: () => primary,
    getActiveDocumentIdentity: () => owner,
    __inEditMode: () => true,
    __documentState: () => ({ dirty: fault.dirty === true }),
    switchToTab: async id => {
      calls.push("switch");
      assert.equal(id, primary.id);
      if (fault.switch) throw new Error("switch refused");
      await switching.promise;
      window.currentFilePath = primary.filePath;
    },
    settleSessionLayout: async () => {
      calls.push("layout");
      await layout.promise;
      if (fault.path) window.currentFilePath = companion.filePath;
      if (fault.cache) primary.content = "changed";
      if (fault.baseline) primary.originalContent = "changed";
      if (fault.editor) window.markdownEditor.value = "changed";
    },
  };
  const context = vm.createContext({ window, primary, saveResultEchoesRequest, setTimeout,
    __shutdown: {
      documentAdmissionIsCurrent: ref => !fault.admission && ref === owner.documentRef,
      documentSessionState: () => ({
        owners: [{ ...owner, ...(fault.ownerField ? { [fault.ownerField]: "wrong" } : {}) }],
      }),
    },
    createActiveTab: async (filePath, content) => {
      calls.push("admit");
      assert.equal(filePath, companion.filePath);
      assert.equal(content, companion.content);
      if (fault.chooser) throw new Error("admission refused");
      await admission.promise;
      return companion;
    },
    exec: code => {
      if (code === "window.folia.getVersion()") {
        calls.push("barrier");
        return Promise.resolve("test-version");
      }
      return vm.runInContext(code, context);
    },
  });
  vm.runInContext(witnessDeclaration + "\n" + pairDeclaration, context);
  const run = () => vm.runInContext(
    `createCompanionTab(primary, ${JSON.stringify(companion.filePath)}, "other")`, context);
  return { run, calls, companion, admission, switching, layout };
}

async function main() {
  const held = pairFixture();
  let finished = false;
  const pending = held.run().then(result => { finished = true; return result; });
  await turn();
  check("companion uses admission before restoring primary", held.calls.join() === "admit" && !finished);
  held.admission.resolve();
  await turn();
  check("restoration joins the actual switch Promise", held.calls.join() === "admit,switch" && !finished);
  held.switching.resolve();
  await turn();
  check("restoration joins layout before its final witness", held.calls.join() === "admit,switch,layout" && !finished);
  held.layout.resolve();
  check("restoration returns the admitted companion after the Main barrier",
    await pending === held.companion && held.calls.join() === "admit,switch,layout,barrier");

  for (const [label, fault, message] of [
    ["chooser refusal", { chooser: true }, /admission refused/],
    ["switch refusal", { switch: true }, /switch refused/],
    ...["path", "cache", "baseline", "editor", "dirty"].map(key =>
      [key + " changed after layout", { [key]: true }, /clean primary/]),
    ["retired admission", { admission: true }, /current Main owner/],
    ...fields.map(field => [field + " mismatch", { ownerField: field }, /current Main owner/]),
  ]) {
    const fixture = pairFixture(fault);
    fixture.admission.resolve();
    fixture.switching.resolve();
    fixture.layout.resolve();
    await assert.rejects(fixture.run(), message, label);
    check("companion refuses " + label, true);
  }

  for (const [first, last] of [
    ["const crlfTab = await createActiveTab", "const crlfVersionAfterOpen"],
    ["const mixedNewlineTab = await createActiveTab", "const mixedNewlineVersionAfterOpen"],
    ["const tab = await createActiveTab(filePath, spellingCase.original)", "if (!(await exec"],
    ["const activeEditorFoldTab = await createActiveTab", "if (!(await exec"],
  ]) {
    const caller = between(first, last);
    check("paired caller admits its companion before measuring: " + first,
      caller.includes("await createCompanionTab(") && !caller.includes("CustomTabs.createTab("));
  }

  const original = "fff\n";
  const edited = "ffX\n";
  const tab = { id: 1, filePath: "C:\\fixture\\fold.md", content: original };
  const context = vm.createContext({ window: { markdownEditor: { value: original },
    CustomTabs: { getTabs: () => [tab], __documentState: () => ({ maintained: true, dirty: true }) } } });
  vm.runInContext(`
    window.initialIndexOf = String.prototype.indexOf;
    window.initialReplace = String.prototype.replace;
    window.CustomTabs.switchToTab = () => {
      const text = window.markdownEditor.value;
      for (let i = 0; i < 5; i++) text.indexOf('absent');
      text.replace('f', 'f');
      return new Promise(resolve => { window.finishSwitch = resolve; });
    };
  `, context);
  const measured = pageTemplate("  const activeEditorFoldEvidence = await exec(`",
    "\n  await switchAndWitness(", {
      activeEditorFoldTab: tab, activeEditorFoldOtherTab: { id: 2 }, activeEditorFoldEdited: edited,
    });
  let measuredFinished = false;
  const measurement = vm.runInContext(measured, context).then(result => {
    measuredFinished = true;
    return result;
  });
  await turn();
  check("measured first switch remains joined while held", !measuredFinished);
  check("scan spies are restored before awaiting switch completion", vm.runInContext(
    "String.prototype.indexOf === window.initialIndexOf && String.prototype.replace === window.initialReplace", context));
  vm.runInContext("'later'.indexOf('a'); 'later'.replace('a', 'b'); window.finishSwitch()", context);
  const evidence = await measurement;
  check("simulated scan keeps the exact synchronous 5/1/6x budget",
    evidence.indexOfCalls === 5 && evidence.replaceCalls === 1 &&
    evidence.scannedBytes === 6 * original.length && evidence.switchStarted === true);
  check("native scan oracle keeps its exact required counts",
    source.includes("activeEditorFoldEvidence.indexOfCalls === 5") &&
    source.includes("activeEditorFoldEvidence.replaceCalls === 1") &&
    source.includes("6 * activeEditorFoldOriginal.length"));

  const identity = { pageSession: "page", rendererGeneration: 3, tabId: tab.id,
    documentGeneration: 4, pathKey: tab.filePath, documentRef: "fold-ref" };
  Object.assign(context.window, { getReloadRequestSession: () => "page",
    originalMarkdown: "view-edited" });
  Object.assign(context.window.CustomTabs, {
    getActiveTab: () => tab,
    getDocumentIdentityForTab: (id, filePath, session) => {
      assert.equal(id, tab.id);
      assert.equal(filePath, tab.filePath);
      assert.equal(session, "page");
      return identity;
    },
  });
  const permissionSource = pageTemplate("  const activeEditorFoldDiscard = await exec(`",
    "\n  if (activeEditorFoldDiscard.content", {
      activeEditorFoldTab: tab, activeEditorFoldFile: tab.filePath,
    });
  for (const editMode of [true, false]) {
    context.window.CustomTabs.__inEditMode = () => editMode;
    context.window.markdownEditor.value = edited;
    const permission = JSON.parse(JSON.stringify(vm.runInContext(permissionSource, context)));
    check("discard captures exact " + (editMode ? "live editor" : "live view") + " text, never old cache",
      permission.content === (editMode ? edited : "view-edited") && permission.content !== tab.content);
    assert.deepEqual(permission.owner, identity);
    check("discard keeps the complete per-tab owner", true);
  }
  const retirement = between('  await closeOwnedFixtureTabs(exec, "F22 measured editor-fold retirement"',
    "\n  // ---- F22 regression: deleted-tab evidence");
  check("focused return follows exact dirty retirement of only the admitted pair",
    retirement.includes("tabIds: [activeEditorFoldOtherTab.id, activeEditorFoldTab.id]") &&
    retirement.includes("expectedDiscards: [activeEditorFoldDiscard]") &&
    retirement.indexOf("expectedDiscards:") < retirement.indexOf("if (newlineFocusedHarness) return"));
  console.log(`F22 fixture contracts: ${passed} passed, 0 failed; simulated page/admission/scan, not Main/native qualification.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
