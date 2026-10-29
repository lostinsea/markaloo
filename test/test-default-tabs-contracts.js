"use strict";

// Source/VM contracts only: this does not launch Electron or admit a document.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "test-tab-refresh.js"), "utf8")
  .replace(/\r\n/g, "\n");
const producer = fs.readFileSync(
  path.join(__dirname, "..", "src", "custom-tabs.js"), "utf8",
).replace(/\r\n/g, "\n");

function between(text, start, end) {
  const first = text.indexOf(start);
  assert.notEqual(first, -1, "source start exists: " + start);
  assert.equal(text.indexOf(start, first + start.length), -1, "source start is unique");
  const last = text.indexOf(end, first + start.length);
  assert.notEqual(last, -1, "source end exists: " + end);
  return text.slice(first, last);
}

const factory = between(source,
  "  function installDefaultFileOpenRaceObserver(key, fixtures) {",
  "\n  const fileOpenRaceKey =");
const mainOwnership = between(source,
  "  const defaultMainOwns = async (snapshot) => {",
  "\n  async function joinDefaultFileOpenWork");
const originalJoin = between(source,
  "  async function joinDefaultFileOpenWork(expected, phase) {",
  "\n  const openDefaultFixture =");
const admissionHelper = between(source,
  "  const openDefaultFixture = async (filePath, body, marker) => {",
  "\n  const tabCAdmission =");
const finalOracle = between(source,
  "  const raceOwns = (snapshot, fixture, text) =>",
  '\n  await clearFixtureTabs("file-open race teardown")');
const continuation = between(producer,
  "      window.renderMarkdown(tab.content).then(() => {",
  "\n      }).catch((error) => {")
  .slice("      window.renderMarkdown(tab.content).then(() => {".length);

let passed = 0;
async function check(name, run) {
  await run();
  passed += 1;
  console.log("PASS  " + name);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const fixtures = [{ path: "A", text: "BODY_A" }, { path: "B", text: "BODY_B" }];
function page() {
  const calls = [];
  const work = [];
  const viewer = { textContent: "" };
  const win = {
    currentFilePath: "A", originalMarkdown: "BODY_A",
    hasUnsavedWorkForReload: () => false,
    getPendingSaveStatus: () => ({ count: 0 }),
    getReloadRequestSession: () => "SESSION",
    getReloadRequestDiagnostics: () => ({ fileOpenSequence: 1 }),
    CustomTabs: {
      __dirtyTabNames: () => [],
      isDocumentFrozen: () => false,
      getActiveTab: () => ({
        id: win.currentFilePath, filePath: win.currentFilePath,
        content: win.originalMarkdown, originalContent: win.originalMarkdown,
        hasUnsavedChanges: false,
      }),
      getDocumentIdentityForTab: (tabId, filePath, session) => {
        assert.equal(tabId, win.currentFilePath);
        assert.equal(filePath, win.currentFilePath);
        assert.equal(session, "SESSION");
        return { tabId, documentRef: "REF_" + filePath };
      },
      getDocumentDescriptor: () => ({
        ref: "REF_" + win.currentFilePath, logicalPath: win.currentFilePath,
      }),
    },
  };
  const original = win.renderMarkdown = function (...args) {
    const pending = deferred();
    calls.push({ receiver: this, args });
    work.push(pending);
    return pending.promise.then(value => { viewer.textContent = args[0]; return value; });
  };
  const context = vm.createContext({
    window: win, document: { getElementById: id => id === "viewer" ? viewer : null },
    setTimeout, clearTimeout,
  });
  const install = vm.runInContext(factory + "\ninstallDefaultFileOpenRaceObserver", context);
  install("race", fixtures);
  return { win, context, original, observer: win.race, calls, work, viewer };
}

function selected(state, index) {
  state.win.currentFilePath = fixtures[index].path;
  state.win.originalMarkdown = fixtures[index].text;
}

function runContinuation(overrides = {}, body = continuation) {
  const tab = {};
  const calls = [];
  const context = {
    generation: 1, renderGeneration: 1, activeTabId: 1, tabId: 1,
    tabs: [tab], tab, isDocumentFrozen: () => false,
    adoptionApproval: null, position: {}, fileOpenContext: {},
    autoReloaded: null, mayMutateDocument: () => true,
    restorePosition: () => calls.push("restore"),
    window: { completeFileOpen: (_context, restore) => {
      calls.push("complete");
      restore();
      return true;
    } },
    ...overrides,
  };
  vm.runInNewContext("(() => {" + body + "\n})()", context);
  return calls;
}

async function main() {
  await check("race renders real work once and holds its successful completion", async () => {
    const state = page();
    const options = { witness: true };
    const result = state.win.renderMarkdown("BODY_A", options);
    let completed = false;
    result.then(() => { completed = true; });
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].receiver, state.win);
    assert.equal(state.calls[0].args[1], options);
    assert.equal(state.observer.reached("A"), false);
    state.work[0].resolve("REAL_RESULT");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(state.observer.reached("A"), true);
    assert.equal(completed, false);
    state.observer.release("A");
    assert.equal(await result, "REAL_RESULT");
    const cleanup = await state.observer.dispose();
    assert.equal(cleanup.owned, true);
    assert.equal(cleanup.settled, true);
    assert.equal(state.win.renderMarkdown, state.original);
    assert.equal(Object.hasOwn(state.win, "race"), false);
  });
  await check("two real render returns complete in B then A order", async () => {
    const state = page();
    const completions = [];
    const a = state.win.renderMarkdown("BODY_A").then(() => completions.push("A"));
    state.work[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    selected(state, 1);
    const b = state.win.renderMarkdown("BODY_B").then(() => completions.push("B"));
    state.work[1].resolve();
    await Promise.resolve();
    await Promise.resolve();
    state.observer.release("B");
    await state.observer.finish("B");
    assert.deepEqual(completions, ["B"]);
    state.observer.release("A");
    await Promise.all([a, b]);
    await state.observer.finish("A");
    assert.deepEqual(completions, ["B", "A"]);
    assert.deepEqual(Array.from(state.observer.evidence().releases), ["B", "A"]);
    assert.equal(state.observer.snapshot().viewer, "BODY_B");
    assert.equal((await state.observer.dispose()).settled, true);
  });
  await check("missing, premature and repeated race releases refuse explicitly", async () => {
    const state = page();
    assert.throws(() => state.observer.release("A"), /Missing/);
    const pending = state.win.renderMarkdown("BODY_A");
    assert.throws(() => state.observer.release("A"), /incomplete/);
    assert.throws(() => state.win.renderMarkdown("BODY_A"), /repeated/);
    assert.throws(() => state.win.renderMarkdown("BODY_B"), /Unexpected/);
    state.work[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    state.observer.release("A");
    assert.throws(() => state.observer.release("A"), /incomplete/);
    await pending;
    await state.observer.dispose();
  });
  await check("cleanup releases outstanding held work and waits for original work", async () => {
    const state = page();
    const result = state.win.renderMarkdown("BODY_A");
    let completed = false;
    const cleanup = state.observer.dispose().then(value => {
      completed = true;
      return value;
    });
    await Promise.resolve();
    assert.equal(completed, false);
    state.work[0].resolve();
    await result;
    assert.equal((await cleanup).settled, true);
  });
  await check("original rendering errors remain errors through observation and cleanup", async () => {
    const state = page();
    const pending = state.win.renderMarkdown("BODY_A");
    const rejection = assert.rejects(pending, /REAL_RENDER_FAILURE/);
    state.work[0].reject(new Error("REAL_RENDER_FAILURE"));
    await rejection;
    assert.throws(() => state.observer.reached("A"), /REAL_RENDER_FAILURE/);
    const cleanup = await state.observer.dispose();
    assert.equal(cleanup.settled, true);
    assert.match(cleanup.errors.join(), /REAL_RENDER_FAILURE/);
  });
  await check("cleanup reports lost hook ownership without replacing a foreign hook", async () => {
    const state = page();
    const foreign = () => Promise.resolve();
    state.win.renderMarkdown = foreign;
    const cleanup = await state.observer.dispose();
    assert.equal(cleanup.owned, false);
    assert.equal(state.win.renderMarkdown, foreign);
  });
  await check("cleanup reports an unfinished original renderer instead of confirming it", async () => {
    const state = page();
    let expire;
    state.context.setTimeout = (callback, delay) => {
      assert.equal(delay, 8000);
      expire = callback;
      return 1;
    };
    state.context.clearTimeout = () => {};
    const pending = state.win.renderMarkdown("BODY_A");
    const cleanup = state.observer.dispose();
    assert.equal(typeof expire, "function");
    expire();
    assert.equal((await cleanup).settled, false);
    state.work[0].resolve();
    await pending;
  });
  await check("occupied observer state is not overwritten, including undefined", () => {
    const state = page();
    state.win.occupied = undefined;
    const install = vm.runInContext("installDefaultFileOpenRaceObserver", state.context);
    assert.throws(() => install("occupied", fixtures), /occupied/);
    assert.equal(Object.hasOwn(state.win, "occupied"), true);
    assert.equal(state.win.renderMarkdown === state.original, false);
    return state.observer.dispose();
  });
  await check("Main ownership requires the exact admission and every owner field", async () => {
    const owner = {
      pageSession: "S", rendererGeneration: 1, tabId: 2,
      documentGeneration: 3, pathKey: "P", documentRef: "R", readTarget: "T",
    };
    const descriptor = { ref: "R", pathKey: "P", readTarget: "T" };
    let current = true;
    let mainRecord = { ...owner };
    let boundGeneration = 3;
    const queries = [];
    const owns = vm.runInNewContext(mainOwnership + "\ndefaultMainOwns", {
      __shutdown: {
        documentAdmissionIsCurrent: ref => current && ref === "R",
        documentSessionState: () => ({ owners: [mainRecord] }),
      },
      exec: code => vm.runInNewContext(code, {
        window: { folia: { queryDocumentDeletionState: request => {
          queries.push(request);
          return {
            known: request.documentGeneration === boundGeneration &&
              request.documentRef === "R" && request.filePath === "A",
            unresolved: false,
          };
        } } },
      }),
    });
    const snapshot = { owner, descriptor, path: "A" };
    assert.equal(await owns(snapshot), true);
    assert.equal(queries.length, 1);
    for (const field of ["pageSession", "rendererGeneration", "tabId",
      "documentGeneration", "pathKey", "documentRef"]) {
      assert.equal(await owns({ ...snapshot, owner: { ...owner, [field]: "FOREIGN" } }),
        false, field);
    }
    assert.equal(await owns({ ...snapshot, descriptor: { ...descriptor, readTarget: "OTHER" } }), false);
    assert.equal(await owns({ ...snapshot, descriptor: { ...descriptor, ref: "OTHER" } }), false);
    assert.equal(await owns({ ...snapshot, owner: null }), false);
    mainRecord = { ...owner, readTarget: "OTHER_MAIN_TARGET" };
    assert.equal(await owns(snapshot), false);
    mainRecord = { ...owner };
    boundGeneration = 4;
    assert.equal(await owns(snapshot), false, "same reference retains an old owner but binds a newer generation");
    boundGeneration = 3;
    current = false;
    assert.equal(await owns(snapshot), false);
  });
  await check("the actual original-work join waits for the processor after rendering", async () => {
    const pending = deferred();
    const processor = {
      packet: { path: "A" }, phase: "P", eventUndefined: true,
      settled: false, promise: pending.promise,
    };
    pending.promise.then(() => { processor.settled = true; });
    const state = {
      processors: [processor],
      renders: [{ prefix: "BODY_A", phase: "P", settled: true, promise: Promise.resolve() }],
    };
    const join = vm.runInNewContext(originalJoin + "\njoinDefaultFileOpenWork", {
      window: { __dialogBatchNative: state },
    });
    let done = false;
    const result = join([{ path: "A", prefix: "BODY_A" }], "P").then(value => {
      done = true;
      return value;
    });
    await Promise.resolve();
    assert.equal(done, false);
    pending.resolve();
    assert.equal((await result).processors[0].settled, true);
  });
  await check("the actual original-work join preserves processor rejection", async () => {
    const pending = deferred();
    const state = {
      processors: [{ packet: { path: "A" }, phase: "P",
        eventUndefined: true, settled: false, promise: pending.promise }],
      renders: [{ prefix: "BODY_A", phase: "P", settled: true, promise: Promise.resolve() }],
    };
    const join = vm.runInNewContext(originalJoin + "\njoinDefaultFileOpenWork", {
      window: { __dialogBatchNative: state },
    });
    const rejection = assert.rejects(join([{ path: "A", prefix: "BODY_A" }], "P"),
      /PROCESSOR_FAILURE/);
    pending.reject(new Error("PROCESSOR_FAILURE"));
    await rejection;
  });
  await check("admission failure independently restores chooser and page observation", async () => {
    const order = [];
    const owner = {};
    const originalChooser = () => {};
    const dialog = { showOpenDialog: originalChooser };
    const options = { properties: ["openFile", "multiSelections"] };
    const make = (restorationFailure) => vm.runInNewContext(
      admissionHelper + "\nopenDefaultFixture", {
        win: owner, dialog, expectedChooserOptions: options,
        isDeepStrictEqual: require("node:util").isDeepStrictEqual,
        installDialogBatchPageObservation: async () => { order.push("install"); },
        restoreDialogBatchPageObservation: async () => {
          order.push("page restore");
          if (restorationFailure) throw new Error("PAGE_RESTORE_FAILURE");
          return true;
        },
        replaceMethod: (target, key, value) => {
          target[key] = value;
          return () => {
            order.push("chooser restore");
            target[key] = originalChooser;
            if (restorationFailure) throw new Error("CHOOSER_RESTORE_FAILURE");
          };
        },
        waitUntil: predicate => predicate(),
        boundedDialogWork: work => work,
        exec: async code => {
          if (code.includes("Object.prototype.hasOwnProperty")) return false;
          if (code.includes("window.folia.openFileDialog()")) {
            await dialog.showOpenDialog(owner, options);
            return undefined;
          }
          if (code.includes("processors.length > 0")) return true;
          if (code.includes("joinDefaultFileOpenWork")) throw new Error("PROCESSOR_FAILURE");
          return true;
        },
        joinDefaultFileOpenWork: function joinDefaultFileOpenWork() {},
      });
    await assert.rejects(make(false)("A", "BODY_A", "BODY_A"), error => {
      assert.match(error.errors[0].message, /PROCESSOR_FAILURE/);
      return true;
    });
    assert.deepEqual(order, ["install", "chooser restore", "page restore"]);
    assert.equal(dialog.showOpenDialog, originalChooser);
    order.length = 0;
    await assert.rejects(make(true)("A", "BODY_A", "BODY_A"), error => {
      assert.equal(error.errors.length, 3);
      assert.match(error.errors[0].message, /PROCESSOR_FAILURE/);
      assert.match(error.errors[1].message, /CHOOSER_RESTORE_FAILURE/);
      assert.match(error.errors[2].message, /PAGE_RESTORE_FAILURE/);
      return true;
    });
    assert.deepEqual(order, ["install", "chooser restore", "page restore"]);
  });
  await check("the actual final race oracle rejects identity drift, revocation and stale paint", () => {
    const raceFixtures = [
      { path: "A", text: "RACE_OPEN_A" }, { path: "B", text: "RACE_OPEN_B" },
    ];
    const snap = (index) => ({
      path: raceFixtures[index].path, original: raceFixtures[index].text, viewer: raceFixtures[index].text,
      tab: { id: index + 1, path: raceFixtures[index].path, content: raceFixtures[index].text,
        original: raceFixtures[index].text, dirty: false },
      descriptor: { ref: "REF_" + index, logicalPath: raceFixtures[index].path },
      owner: { pageSession: "S", rendererGeneration: 1, tabId: index + 1,
        documentGeneration: 3, pathKey: raceFixtures[index].path, documentRef: "REF_" + index },
      diagnostics: { fileOpenSequence: index + 1 },
    });
    const baseline = {
      afterA: snap(0), afterB: snap(1), final: snap(1), finalMainOwned: true,
      gates: fixtures.map(fixture => ({ ...fixture, rendered: true, completed: true, error: null })),
      releases: ["B", "A"],
      originalWork: {
        processors: fixtures.map(() => ({ settled: true, eventUndefined: true })),
        renders: fixtures.map(() => ({ settled: true })),
      },
    };
    const evaluate = (mutate) => {
      const sample = JSON.parse(JSON.stringify(baseline));
      mutate(sample);
      const results = [];
      const context = vm.createContext({
        fileOpenRaceA: "A", fileOpenRaceB: "B",
        isDeepStrictEqual: require("node:util").isDeepStrictEqual,
        check: (_name, success) => results.push(success),
      });
      vm.runInContext("const fileOpenRace = " + JSON.stringify(sample) + ";\n" + finalOracle, context);
      return results;
    };
    assert.deepEqual(evaluate(() => {}), [true, true]);
    for (const field of ["pageSession", "rendererGeneration", "documentGeneration", "pathKey"]) {
      assert.equal(evaluate(value => { value.final.owner[field] = "DRIFT"; })[1], false, field);
    }
    assert.equal(evaluate(value => { value.finalMainOwned = false; })[1], false);
    assert.equal(evaluate(value => { value.final.viewer = "BODY_A"; })[1], false);
  });
  await check("the actual current tab render continuation completes and restores", () => {
    assert.deepEqual(runContinuation(), ["complete", "restore"]);
  });
  await check("the actual stale tab continuation stops before completeFileOpen", () => {
    assert.deepEqual(runContinuation({ renderGeneration: 2 }), []);
    assert.deepEqual(runContinuation({ activeTabId: 2 }), []);
    assert.deepEqual(runContinuation({ tabs: [] }), []);
    assert.deepEqual(runContinuation({ isDocumentFrozen: () => true }), []);
  });
  await check("the stale-continuation control detects removal of its actual guard", () => {
    const guard = "        if (generation !== renderGeneration || activeTabId !== tabId ||\n" +
      "            !tabs.includes(tab) || isDocumentFrozen()) return;";
    assert.equal(continuation.includes(guard), true);
    const removed = continuation.replace(guard, "");
    assert.deepEqual(runContinuation({ renderGeneration: 2 }, removed), ["complete"]);
  });
  console.log("SOURCE/VM ONLY: " + passed + " passed; native behavior is not qualified.");
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
