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

async function largeRenderChoiceContracts() {
  const { EventEmitter } = require("node:events");
  const currentSource = source.replace(/\r\n/g, "\n");
  const region = (start, end) => {
    const first = currentSource.indexOf(start), last = currentSource.indexOf(end, first);
    assert(first >= 0 && first === currentSource.lastIndexOf(start) && last > first);
    return currentSource.slice(first, last);
  };
  const actual = [
    region("function replaceMethod(", "\n// A stand-in for"),
    region("function unexpectedDialog(", "\nconst realOwnedDialogShow"),
    region("const restoreDialogSafety = [", "\n// Refuse rather than invent"),
    region("async function boundedDialogWork(", "\nfunction inspectCleanRefreshSource("),
    region("async function answerLargeRenderQuestion(", "\nasync function runLargeRenderBoundary("),
  ].join("\n");
  async function exercise({ choice = "0", result, pendingProducer = false,
    rejectProducer = false, closeHost = true, closeForeign = false,
    evaluationReply = true, rejectEvaluation = false } = {}) {
    const producer = deferred(), evaluation = deferred(), timers = [], input = [], removals = [];
    const owner = {}, expected = { owner, calls: 0 };
    const host = new EventEmitter(), foreign = new EventEmitter();
    const baseline = () => {};
    host.on("closed", baseline); foreign.on("closed", baseline);
    let closedListener, listenerBeforeInput = false, observedProducer = false, originalCall;
    let evaluationSettled = false;
    evaluation.promise.then(() => { evaluationSettled = true; }, () => { evaluationSettled = true; });
    const once = host.once, remove = host.removeListener;
    host.once = function (name, listener) {
      assert.equal(name, "closed"); closedListener = listener;
      return once.apply(this, arguments);
    };
    host.removeListener = function (name, listener) {
      removals.push({ name, listener }); return remove.apply(this, arguments);
    };
    const producerError = new Error("controlled original producer rejection");
    const evaluationError = new Error("controlled evaluation rejection");
    let producerSettled = false;
    producer.promise.then(() => { producerSettled = true; }, () => { producerSettled = true; });
    class SourceOwnedDialogs {
      show(...args) { originalCall = { receiver: this, args }; return producer.promise; }
    }
    const original = SourceOwnedDialogs.prototype.show;
    const api = vm.runInNewContext(actual +
      "\n({ answerLargeRenderQuestion, restoreDialogSafety });", {
      OwnedDialogs: SourceOwnedDialogs, realOwnedDialogShow: original,
      dialogSafety: { expected, presentations: 0, unexpected: [] },
      setTimeout(callback, delay) {
        assert.equal(delay, 12000);
        const timer = { callback, active: true }; timers.push(timer); return timer;
      },
      clearTimeout(timer) { timer.active = false; },
    }, { timeout: 1000 });
    const broker = new SourceOwnedDialogs();
    const options = { title: "Large document", message: "Exact guard name",
      detail: "Exact detail", buttons: ["Open anyway", "Cancel"], defaultId: 1, cancelId: 1 };
    const returned = broker.show(owner, options);
    observedProducer = returned === producer.promise && expected.producer === producer.promise &&
      originalCall.receiver === broker && originalCall.args[0] === owner &&
      originalCall.args[1] === options && expected.calls === 1;
    host.webContents = {
      executeJavaScript(code, gesture) {
        input.push({ code, gesture });
        listenerBeforeInput = host.listeners("closed").includes(closedListener);
        if (closeForeign) foreign.emit("closed");
        if (closeHost) host.emit("closed");
        if (rejectEvaluation) return Promise.reject(evaluationError);
        return evaluationReply ? Promise.resolve(true) : evaluation.promise;
      },
    };
    let outcome;
    try {
      api.answerLargeRenderQuestion(host, expected.producer, choice).then(
        value => { outcome = { value }; }, error => { outcome = { error }; });
      if (rejectProducer) producer.reject(producerError);
      else if (!pendingProducer) producer.resolve(result);
      await turn();
      if (!outcome) {
        const timer = timers.find(item => item.active);
        assert(timer, "A pending actual answer helper must retain its bounded operation");
        timer.callback();
        await turn();
      }
      assert(outcome, "The controlled bounded operation must settle");
    } finally { api.restoreDialogSafety.forEach(restore => restore()); }
    return { ...outcome, producerError, evaluationError, observedProducer, producerSettled,
      listenerBeforeInput, evaluationSettled, input, result, choice,
      cleaned: SourceOwnedDialogs.prototype.show === original &&
        host.listeners("closed").length === 1 && host.listeners("closed")[0] === baseline &&
        foreign.listeners("closed").length === 1 && foreign.listeners("closed")[0] === baseline &&
        removals.some(item => item.name === "closed" && item.listener === closedListener) &&
        timers.every(timer => !timer.active) };
  }
  const valid = { displayed: true, failed: false, cause: "choice", response: 0 };
  const intact = result => {
    assert.equal(result.observedProducer, true, "The observer must return and retain the original producer");
    assert.equal(result.listenerBeforeInput, true, "The exact host must be observed before clicking");
    assert.equal(result.cleaned, true, "Only the owned host listener and original observer may be removed");
    assert.deepEqual(result.input, [{
      code: `document.querySelector('#appMessageButtons [data-dialog-choice="${result.choice}"]').click(); true`,
      gesture: true,
    }]);
  };
  const closed = await exercise({ result: valid, evaluationReply: false });
  check("large-render choice joins the original producer without a destroyed-host evaluation reply", () => {
    intact(closed); assert.equal(closed.error, undefined); assert.equal(closed.value, valid);
    assert.equal(closed.evaluationSettled, false, "The evaluation genuinely has no reply");
  });
  const normal = await exercise({ choice: "1", result: { ...valid, response: 1 }, closeHost: false });
  check("large-render normal evaluation and explicit Cancel retain the original producer and input", () => {
    intact(normal); assert.equal(normal.error, undefined); assert.equal(normal.value, normal.result);
  });
  const closureOnly = await exercise({ pendingProducer: true });
  check("large-render host closure alone cannot replace the original producer result", () => {
    intact(closureOnly); assert.equal(closureOnly.producerSettled, false);
    assert.match(closureOnly.error?.message || "", /^Timed out: original test-owned large-render choice$/);
  });
  const bad = [];
  for (const result of [undefined, { ...valid, displayed: false }, { ...valid, displayed: 1 },
    { ...valid, failed: true }, { ...valid, failed: 0 }, { ...valid, cause: "cancel" },
    { ...valid, response: 1 }, { ...valid, response: "0" }, { ...valid, emergency: true }]) {
    bad.push(await exercise({ result }));
  }
  check("large-render choice rejects missing undisplayed failed cancelled foreign and emergency producer results", () => {
    for (const result of bad) {
      intact(result);
      assert.equal(result.error?.message, "Large-render question did not return its genuine chosen result");
    }
  });
  const rejected = await exercise({ rejectProducer: true });
  check("large-render choice propagates the original producer rejection", () => {
    intact(rejected); assert.equal(rejected.error, rejected.producerError);
  });
  const failedEvaluation = await exercise({ result: valid, closeHost: false, rejectEvaluation: true });
  check("large-render choice propagates evaluation errors without its exact host closure", () => {
    intact(failedEvaluation); assert.equal(failedEvaluation.error, failedEvaluation.evaluationError);
  });
  const foreign = await exercise({ result: valid, closeHost: false,
    closeForeign: true, evaluationReply: false });
  check("large-render transport cannot settle from a different host closing", () => {
    intact(foreign);
    assert.match(foreign.error?.message || "", /^Timed out: explicit test-owned large-render choice$/);
  });
}

async function ownedReadPathContracts() {
  // These fake stat ports have no I/O; after release, microtasks settle before the next turn.
  const observeStat = work => {
    const outcome = work.then(value => ({ status: "fulfilled", value }),
      error => ({ status: "rejected", error }));
    return () => Promise.race([outcome, turn().then(() => ({ status: "pending" }))]);
  };
  const stranded = deferred(), statError = new Error("controlled owned stat failure");
  const joinStranded = observeStat(stranded.promise);
  let pendingStat, recoveredStat, rejectedStat;
  try {
    pendingStat = await joinStranded();
    rejectedStat = await observeStat(Promise.reject(statError))();
  } finally { stranded.resolve("released owned stat"); }
  recoveredStat = await joinStranded();
  check("owned-read stat join exposes pending and rejected work without fabricating a value", () => {
    assert.equal(pendingStat.status, "pending");
    assert.equal("value" in pendingStat, false);
    assert.equal(rejectedStat.status, "rejected");
    assert.equal(rejectedStat.error, statError);
    assert.equal("value" in rejectedStat, false);
    assert.deepEqual(recoveredStat, { status: "fulfilled", value: "released owned stat" });
  });
  for (const kind of ["stable", "atomic"]) {
    const atomic = kind === "atomic";
    const startText = atomic ? "  const atomicReaderPath = " : "  const ownedReaderPath = ";
    const endText = atomic ? "  tabDiskObservation = atomicObservation;" : "  let midReadRefresh;";
    const start = source.indexOf(startText), end = source.indexOf(endText, start);
    assert(start >= 0 && start === source.lastIndexOf(startText) && end > start);
    const logical = "c:\\fixture\\beta.md", physical = "C:\\Fixture\\Beta.md";
    const calls = [], handles = [], resolutions = [];
    const stats = { dev: 1, ino: 2, size: 23, mtimeMs: 4, ctimeMs: 5 };
    const originalOpen = async function (filePath) {
      assert.equal(this, ownedFs.promises);
      calls.push(filePath);
      const handle = {
        stat: async () => stats,
        readFile: async () => "exact first descriptor bytes",
        close: async () => {},
      };
      handles.push({ handle, stat: handle.stat, read: handle.readFile, close: handle.close });
      return handle;
    };
    const ownedFs = {
      realpathSync: { native(filePath) {
        resolutions.push(filePath);
        assert.equal(filePath, logical);
        return physical;
      } },
      promises: { open: originalOpen },
    };
    const restoreName = atomic ? "restoreAtomicOpen" : "restoreStableReadOpen";
    const releaseName = atomic ? "releaseAtomicSecondStat" : "releaseStableReadSecondStat";
    const countName = atomic ? "atomicOpenCalls" : "stableReadOpenCalls";
    const targetName = atomic ? "atomicReaderPath" : "ownedReaderPath";
    const matchedName = atomic ? "atomicMatchedReadPath" : "stableMatchedReadPath";
    const suffix = `\nreturn { restore: ${restoreName}, release: () => ${releaseName},
      count: () => ${countName}, target: () => ${targetName}, matched: () => ${matchedName},
      closed: () => ${atomic ? "atomicClosedAttempts" : "[]"} };`;
    const api = vm.compileFunction(source.slice(start, end) + suffix, [
      "fs", "stableReadRequest", "atomicReadRequest", "fileB", "replaceMethod",
    ])(ownedFs, { filePath: logical }, { filePath: logical }, logical,
      (object, key, replacement) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        Object.defineProperty(object, key, { ...descriptor, value: replacement });
        return () => Object.defineProperty(object, key, descriptor);
      });
    let evidence;
    try {
      const logicalHandle = await ownedFs.promises.open(logical);
      const physicalHandle = await ownedFs.promises.open(physical);
      await physicalHandle.stat();
      if (atomic) await physicalHandle.readFile("utf8");
      let heldSettled = false;
      const joinHeld = observeStat(physicalHandle.stat().then(value => { heldSettled = true; return value; }));
      await turn();
      evidence = {
        resolutions: resolutions.slice(), target: api.target(), matched: api.matched(),
        calls: calls.slice(), count: api.count(), held: typeof api.release() === "function",
        settled: heldSettled, logicalUntouched: logicalHandle.stat === handles[0].stat &&
          logicalHandle.readFile === handles[0].read && logicalHandle.close === handles[0].close,
      };
      if (api.release()) api.release()();
      evidence.join = await joinHeld();
      const second = await ownedFs.promises.open(physical);
      await second.stat();
      await second.stat();
      await physicalHandle.close();
      await second.close();
      evidence.finalCount = api.count();
      evidence.closed = Array.from(api.closed());
    } finally { api.restore(); }
    check(kind + " owned-read hook captures only the exact physical target before the request", () => {
      assert.notEqual(logical, physical, "The controlled fixture must discriminate spellings");
      assert.deepEqual(evidence.resolutions, [logical]);
      assert.equal(evidence.target, physical);
      assert.equal(evidence.matched, physical);
      assert.deepEqual(evidence.calls, [logical, physical]);
      assert.equal(evidence.logicalUntouched, true, "Logical adoption must not arm the Main read hold");
      assert.equal(evidence.count, 1);
      assert.equal(evidence.held, true);
      assert.equal(evidence.settled, false, "The physical second stat must genuinely remain pending");
      assert.equal(evidence.join.status, "fulfilled",
        evidence.join.error?.stack || "The owned stat did not settle after its captured release");
      assert.equal(evidence.join.value, stats);
    });
    check(kind + " owned-read hook preserves retry descriptors and exact restoration", () => {
      assert.equal(evidence.join.status, "fulfilled",
        evidence.join.error?.stack || "An unjoined owned stat cannot qualify descriptor cleanup");
      assert.equal(evidence.finalCount, 2);
      if (atomic) assert.deepEqual(evidence.closed, [1, 2]);
      assert.equal(ownedFs.promises.open, originalOpen);
      assert.equal(handles.length, 3);
    });
  }
}

async function dirtyReloadQuestionContracts() {
  const start = source.indexOf("async function answerDirtyReloadQuestion(");
  const end = source.indexOf("\nasync function answerLargeRenderQuestion(", start);
  assert(start >= 0 && end > start);
  const answer = vm.compileFunction(source.slice(start, end) +
    "\nreturn answerDirtyReloadQuestion;", ["boundedDialogWork"])(work => work);
  async function exercise(options = {}) {
    const pending = deferred(), records = [], input = [], observers = [];
    const choice = options.choice || "cancel";
    const dialog = { open: false };
    const buttons = [
      { dataset: { dialogChoice: "cancel" }, textContent: "Cancel" },
      { dataset: { dialogChoice: "proceed" },
        textContent: options.wrongButtons ? "Discard and close" : "Discard and reload" },
    ];
    const nodes = {
      appMessageDialog: dialog,
      appMessageTitle: { textContent: options.wrongTitle ? "Close this file?" : "Discard unsaved changes?" },
      appMessageText: { textContent: options.wrongMessage ? "Discard another document?" :
        "You have unsaved changes. Reload from disk and discard them?" },
    };
    const page = { __confirmCalls: 0 };
    let originalCalls = 0, originalReceiver, originalEvent, producerSettled = false;
    const event = { type: "click", exact: true };
    pending.promise.then(() => { producerSettled = true; }, () => { producerSettled = true; });
    const original = function (received) {
      originalCalls += 1; originalReceiver = this; originalEvent = received;
      dialog.open = true;
      records.push({ target: dialog, oldValue: null });
      if (options.duplicate) records.push({ target: dialog, oldValue: null });
      page.document.activeElement = buttons[options.wrongDefault ? 1 : 0];
      return pending.promise;
    };
    const reload = { onclick: original, click() {
      input.push("reload");
      const returned = this.onclick(event);
      assert.equal(returned, pending.promise, "The observed handler must return its original producer");
    } };
    nodes.reloadFileBtn = reload;
    for (const button of buttons) button.click = () => {
      input.push(button.dataset.dialogChoice);
      dialog.open = false;
      records.push({ target: dialog, oldValue: "" });
      if (options.reject) pending.reject(options.reject);
      else if (!options.holdRequest) pending.resolve();
    };
    page.document = {
      documentElement: {}, activeElement: null,
      getElementById: id => nodes[id],
      querySelectorAll: selector => {
        assert.equal(selector, "#appMessageButtons [data-dialog-choice]"); return buttons;
      },
      querySelector: selector => buttons.find(button => selector ===
        `#appMessageButtons [data-dialog-choice="${button.dataset.dialogChoice}"]`),
    };
    page.MutationObserver = class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe(target, settings) {
        assert.equal(target, page.document.documentElement);
        assert.deepEqual(JSON.parse(JSON.stringify(settings)),
          { subtree: true, attributes: true, attributeFilter: ["open"], attributeOldValue: true });
      }
      takeRecords() { return records.splice(0); }
      disconnect() { this.disconnected = true; }
    };
    page.window = page;
    const context = vm.createContext(page);
    let outcome;
    answer(code => vm.runInContext(code, context, { timeout: 1000 }), choice).then(
      value => { outcome = { value }; }, error => { outcome = { error }; });
    await turn();
    const whileClosed = { open: dialog.open, settled: outcome !== undefined,
      producerSettled, confirmations: page.__confirmCalls };
    if (options.holdRequest) { pending.resolve(); await turn(); }
    assert(outcome, "The controlled actual helper must finish");
    return { ...outcome, input, whileClosed, page, originalCalls, receiver: originalReceiver === reload,
      event: originalEvent === event, restored: reload.onclick === original &&
        observers.length === 1 && observers[0].disconnected, choice };
  }
  const valid = [];
  for (const choice of ["cancel", "proceed"]) valid.push(await exercise({ choice, holdRequest: true }));
  check("dirty Reload answers actual Cancel and Proceed and joins the unchanged original request", () => {
    for (const result of valid) {
      assert.equal(result.error, undefined);
      assert.deepEqual(result.input, ["reload", result.choice]);
      assert.equal(result.originalCalls, 1);
      assert.equal(result.receiver, true); assert.equal(result.event, true);
      assert.equal(result.whileClosed.open, false);
      assert.equal(result.whileClosed.settled, false, "A closed question is not a settled request");
      assert.equal(result.whileClosed.producerSettled, false);
      assert.equal(result.whileClosed.confirmations, 0);
      assert.equal(result.page.__confirmCalls, 1);
      assert.equal(result.value.presentations, 1); assert.equal(result.value.settled, true);
      assert.equal(result.restored, true);
    }
  });
  const malformed = [];
  for (const option of ["wrongTitle", "wrongMessage", "wrongButtons", "wrongDefault", "duplicate"])
    malformed.push({ option, result: await exercise({ [option]: true }) });
  check("dirty Reload refuses foreign questions non-Cancel defaults and duplicate presentations", () => {
    for (const { option, result } of malformed) {
      assert.match(result.error?.message || "", ["wrongTitle", "wrongMessage", "wrongButtons"].includes(option)
        ? /unexpected question/ : /exactly one Cancel-default question/);
      assert.deepEqual(result.input, ["reload"], "An unverified question must not receive a choice");
      assert.equal(result.page.__confirmCalls, 0);
      assert.equal(result.restored, true);
    }
  });
  const rejection = new Error("controlled original dirty Reload rejection");
  const rejected = await exercise({ reject: rejection });
  check("dirty Reload retains original request rejection and disposes only its observation", () => {
    assert.equal(rejected.error, rejection);
    assert.equal(rejected.page.__confirmCalls, 0);
    assert.deepEqual(rejected.input, ["reload", "cancel"]);
    assert.equal(rejected.restored, true);
  });
}

async function mermaidAdmissionContract() {
  const start = source.indexOf('  const mermaidInitial = "graph TD;');
  const end = source.indexOf("\n  await sleep(400);", start);
  assert(start >= 0 && end > start);
  const calls = [], filePath = "physical-mermaid-fixture.mmd", evaluate = () => {
    throw new Error("The Mermaid fixture must use the existing production admission helper");
  };
  const admitted = { tabId: 7, owner: { tabId: 7 }, descriptor: { ref: "verified" },
    diskVersion: { dev: 1, ino: 2, size: 23, mtimeMs: 4, ctimeMs: 5 } };
  const run = vm.compileFunction("return (async () => {" + source.slice(start, end) +
    "\nreturn { mermaidTab, mermaidAdmission }; })();", [
    "exec", "fileM", "write", "openShutdownLifecycleFixture", "require",
  ]);
  let value, error;
  try {
    value = await run(evaluate, filePath, (target, bytes) => calls.push(["write", target, bytes]),
      async (...args) => { calls.push(["admit", ...args]); return admitted; }, require);
  } catch (caught) { error = caught; }
  check("Mermaid fixture uses the real chooser admission leaf with exact Main-wrapped source and original paint", () => {
    assert.equal(error, undefined);
    assert.equal(value.mermaidTab, admitted.tabId);
    assert.equal(value.mermaidAdmission, admitted);
    assert.deepEqual(calls, [
      ["write", filePath, "graph TD;\n  A-->B;\n"],
      ["admit", evaluate, filePath, "```mermaid\ngraph TD;\n  A-->B;\n\n```", "A"],
    ]);
  });
  const closeMarker = "    JSON.stringify(afterMermaid),\n  );";
  const normalized = source.replace(/\r\n/g, "\n");
  const closeStart = normalized.indexOf(closeMarker) + closeMarker.length;
  const closeEnd = normalized.indexOf("\n  await sleep(400);", closeStart);
  assert(closeStart >= closeMarker.length && closeEnd > closeStart);
  const close = vm.compileFunction("return (async () => {" + normalized.slice(closeStart, closeEnd) +
    "\n})();", ["exec", "mermaidTab", "closeOwnedFixtureTabs"]);
  const closed = [];
  let closeError;
  try { await close(evaluate, admitted.tabId, async (...args) => { closed.push(args); }); }
  catch (caught) { closeError = caught; }
  check("Mermaid fixture genuinely retires only its owned tab without rewriting its content or dirty state", () => {
    assert.equal(closeError, undefined);
    assert.equal(closed.length, 1);
    assert.equal(closed[0][0], evaluate);
    assert.equal(closed[0][1], "refreshed .mmd retirement");
    assert.deepEqual(JSON.parse(JSON.stringify(closed[0][2])), { tabIds: [admitted.tabId] });
  });
}

async function main() {
  await activeCloseLayoutContracts();
  await largeRenderChoiceContracts();
  await ownedReadPathContracts();
  await dirtyReloadQuestionContracts();
  await mermaidAdmissionContract();
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
