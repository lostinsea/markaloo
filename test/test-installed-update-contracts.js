"use strict";

// Source/VM only: real readiness producers and actor helpers, with simulated
// renderer/lifecycle dependencies. No Electron, installer or launcher is run.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const vm = require("node:vm");
const projectRequire = createRequire(path.join(process.cwd(), "package.json"));
const source = fs.readFileSync(process.argv[2] || path.join(__dirname, "test-tab-refresh.js"), "utf8")
  .replace(/\r\n/g, "\n");
const producer = fs.readFileSync(path.join(__dirname, "..", "src", "update-state.js"), "utf8");
const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

function between(text, start, end) {
  const first = text.indexOf(start);
  assert.notEqual(first, -1, "source start exists: " + start);
  assert.equal(text.indexOf(start, first + start.length), -1, "source start is unique");
  const last = text.indexOf(end, first + start.length);
  assert.notEqual(last, -1, "source end exists: " + end);
  return text.slice(first, last);
}
const fixtureSource = between(source, "function createInstalledUpdaterFixture(",
  "\nasync function runInstalledUpdateCommitScenarios(");
const installedSource = between(source, "async function runInstalledUpdateCommitScenarios(",
  "\nasync function runWindowsInstalledLauncherScenarios(");
const windowsSource = between(source, "async function runWindowsInstalledLauncherScenarios(",
  "\nasync function runShutdownScenarios(");
const documentSource = between(installedSource, "  const identityFields =",
  "\n  const admitInstalledFixture =");
const admissionSource = between(installedSource, "  const admitInstalledFixture =",
  "\n  const editInstalledFixture =");
const editSource = between(installedSource, "  const editInstalledFixture =",
  "\n  // Hold a real main-to-renderer protocol");
const gapSource = between(installedSource,
  "    rig.answer = 1;\n    const closeInGap = guardEvent();",
  "\n    // The initial approval is clean.");
const gapAdapterSource = between(source, "function installOrdinaryShutdownQuestions(",
  "\nasync function withOrdinaryShutdownCleanup(");
const gapCleanupSource = between(source, "async function withOrdinaryShutdownCleanup(",
  "\nfunction holdOrdinaryShutdownApproval(");
const validatorSource = between(mainSource, "  validateReady: artifact => {",
  "\n  onDownloadStart:").slice("  validateReady: ".length).trim().replace(/,$/, "");
const producerModule = { exports: {} };
vm.runInNewContext(producer, { require: projectRequire, module: producerModule });
const { createUpdateState } = producerModule.exports;
let passed = 0;
async function check(name, run) {
  await run();
  passed += 1;
  console.log("PASS  " + name);
}
async function waitUntil(predicate) {
  for (let turn = 0; turn < 12; turn += 1) {
    if (await predicate()) return true;
    await new Promise(resolve => setImmediate(resolve));
  }
  return false;
}
function replaceMethod(target, name, implementation) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, {
    value: implementation, configurable: true, writable: true,
  });
  return () => {
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else delete target[name];
  };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function readiness({ cached = null, platform = "win32" } = {}) {
  const app = Object.create({ isPackaged: false });
  const updater = new EventEmitter();
  const originalCheck = updater.checkForUpdates = () => { throw new Error("Unborrowed check"); };
  const originalDownload = updater.downloadUpdate = () => { throw new Error("Unborrowed download"); };
  const trace = [];
  let readyPath = null;
  const validateReady = vm.runInNewContext("(" + validatorSource + ")", {
    autoUpdater: updater,
    isExistingRegularFile: file => fs.existsSync(file) && fs.statSync(file).isFile(),
  });
  const controller = createUpdateState({
    installedVersion: "0.11.3", platform,
    enabled: () => app.isPackaged,
    getUpdater: () => updater,
    readAvailability: () => cached && ({ schema: 1, version: cached }),
    writeAvailability: () => {},
    log: (...args) => trace.push(["log", ...args]),
    isInstalling: () => false, canInstall: () => true, validateReady,
    onDownloadStart: () => { readyPath = null; trace.push(["download-start"]); },
    onDownloadReady: file => { readyPath = file; trace.push(["download-ready", file]); },
    onDownloadEnd: () => trace.push(["download-end"]),
    publish: state => trace.push(["state", state.status]),
  });
  controller.attach(updater);
  updater.on("update-available", controller.observeAvailable);
  const window = { folia: Object.freeze({
    getUpdateState: () => controller.snapshot(),
    checkForUpdates: () => { trace.push(["check-action"]); void controller.check(); },
    downloadUpdate: () => { trace.push(["download-action"]); void controller.download(); },
  }) };
  const context = vm.createContext({ window, app, require: projectRequire,
    replaceMethod, waitUntil, AggregateError, isDeepStrictEqual });
  const exec = async code => structuredClone(await vm.runInContext(code, context));
  const create = vm.runInContext(fixtureSource + "\ncreateInstalledUpdaterFixture", context);
  const fixture = create(exec, updater, __filename);
  return { fixture, controller, updater, app, trace, originalCheck, originalDownload, context, exec,
    get readyPath() { return readyPath; } };
}
function documents() {
  const owner = { pageSession: "PAGE", rendererGeneration: 7, tabId: 1,
    documentGeneration: 3, pathKey: "KEY", documentRef: "REF" };
  const descriptor = { ref: "REF", logicalPath: "fixture.md", readTarget: "physical.md" };
  const body = "# Installed commit fixture\n";
  const tab = { id: 1, filePath: "fixture.md", content: body, originalContent: body,
    hasUnsavedChanges: false, diskVersion: { mtimeMs: 1 } };
  const state = { maintained: true, dirty: false, mutationRevision: 4,
    deletionTombstone: false, reloadConflict: false };
  const tabs = [tab];
  const viewer = { textContent: "Installed commit fixture" };
  const question = { open: false };
  const options = { ownerCurrent: true, mainCurrent: true, pending: 0,
    eagerCache: false, mutate: true, paint: true, retarget: false };
  const window = {
    currentFilePath: "fixture.md", originalMarkdown: body,
    getReloadRequestSession: () => "PAGE",
    getPendingSaveStatus: () => ({ count: options.pending, revision: 1 }),
    getActiveFileSelectionGeneration: () => 1,
    CustomTabs: {
      getActiveTab: () => tabs[0],
      getTabs: () => tabs,
      getActiveTabId: () => tabs[0]?.id,
      getDocumentIdentityForTab: () => owner,
      getDocumentDescriptor: () => descriptor,
      __documentState: () => ({ ...state }),
      isDocumentFrozen: () => false,
      __shutdownFreeze: () => ({ frozen: false }),
      settleSessionLayout: () => { calls.push("settle-layout"); },
    },
    folia: {
      queryDocumentDeletionState: () => ({
        known: options.ownerCurrent, unresolved: false, revision: 1,
      }),
    },
  };
  const calls = [];
  const context = vm.createContext({
    window, viewer, isEditMode: true, hasUnsavedChanges: false,
    markdownEditor: { value: body, dispatchEvent() {
      calls.push("input");
      context.hasUnsavedChanges = true;
      if (options.mutate) state.mutationRevision += 1;
      if (options.eagerCache) tab.content = this.value;
      if (options.paint) viewer.textContent = this.value;
      if (options.retarget) owner.documentGeneration += 1;
    } },
    toggleEditBtn: { click() { context.isEditMode = true; } },
    document: { getElementById: () => question },
    Event: class Event { constructor(type) { this.type = type; } },
    __shutdown: {
      documentAdmissionIsCurrent: ref => options.mainCurrent && ref === descriptor.ref,
      documentSessionState: () => ({ owners: [{ ...owner, readTarget: descriptor.readTarget }] }),
    },
    AggregateError, Map,
  });
  const exec = async code => structuredClone(await vm.runInContext(code, context));
  const closeCalls = [];
  let closeImplementation = async (_exec, phase, settings) => {
    closeCalls.push({ phase, settings });
    const records = tabs.splice(0).map(closed => ({
      tabId: closed.id, closed: true, settled: true, error: null,
    }));
    return { records, remaining: [] };
  };
  Object.assign(context, {
    exec, commitFile: "fixture.md", waitForCondition: (_exec, code) => exec(code),
    closeOwnedFixtureTabs: (...args) => closeImplementation(...args),
  });
  vm.runInContext(documentSource + editSource +
    "\nglobalThis.actor = { readInstalledDocument, installedMainOwns, " +
    "describeInstalledTabs, clearDocuments, editInstalledFixture, expectedDiscards };", context);
  return { actor: context.actor, context, exec, owner, descriptor, tab, state,
    tabs, options, calls, closeCalls,
    setClose: implementation => { closeImplementation = implementation; } };
}

// Actual caller and ordinary adapter; shared-driver records and Main are ports.
function installedGap(options = {}) {
  const win = new EventEmitter();
  const rig = { dialogs: [], answer: null, closes: 0, quits: 0 };
  const producer = deferred();
  const driver = deferred();
  const consumer = deferred();
  for (const tail of [producer, driver, consumer]) tail.promise.catch(() => {});
  const signal = {};
  const result = { failed: false, displayed: true, cause: "choice", response: 1,
    ...options.result };
  const presentation = {
    title: options.title || "Unsaved changes",
    buttons: ["Discard changes", "Cancel"],
  };
  const record = {
    options: { ...presentation, message: "f22-installed-commit", signal },
    pendingReason: "window-close", requestId: 31, presentation,
    displayed: true, choiceSubmitted: null, choiceDelivered: false,
    completionKind: null, result: null, producer: producer.promise,
    presentationReady: Promise.resolve(options.completed
      ? { kind: "completed", result } : { kind: "displayed", presentation }),
  };
  const settle = () => {
    record.result = options.wrongResultIdentity ? { ...result } : result;
    if (options.producerError) producer.reject(options.producerError);
    else producer.resolve(result);
    if (options.driverError) driver.reject(options.driverError);
    else driver.resolve();
    if (options.consumerError) consumer.reject(options.consumerError);
    else if (!options.holdConsumer) consumer.resolve();
  };
  record.choose = index => {
    assert.equal(index, 1);
    assert.equal(record.choiceSubmitted, null);
    record.choiceSubmitted = index;
    record.choiceDelivered = !options.undelivered;
    record.completionKind = "choice";
    settle();
  };
  record.joined = Promise.allSettled([producer.promise, driver.promise]).then(outcomes => {
    const errors = outcomes.filter(item => item.status === "rejected").map(item => item.reason);
    if (errors.length) throw new AggregateError(errors, "simulated original record work");
    return record;
  });
  record.joined.catch(() => {});
  const records = [];
  let onRecord;
  let restores = 0;
  let consumerReads = 0;
  win.on("close", event => {
    event.preventDefault();
    if (options.nativeOnly) { rig.dialogs.push(record); return; }
    if (!onRecord) return;
    records.push(record);
    if (options.observerError) rig.answer = () => { throw options.observerError; };
    record.observerWork = onRecord(record);
    record.observerWork.catch(() => settle());
    if (options.completed) settle();
  });
  const context = vm.createContext({
    win, rig, waitUntil, AggregateError, Promise, JSON,
    enteredDeferredGap: true, gapState: { authorized: false, updateInstallStarted: true },
    exactGapEdit: "gap edit that nobody has been asked about", commitSignals: 0,
    guardEvent: () => ({ prevented: false, preventDefault() { this.prevented = true; } }),
    readInstalledDocument: async () => ({ editor: context.exactGapEdit }),
    check: (name, passed, detail) => assert.equal(Boolean(passed), true, name + ": " + detail),
    __shutdown: {
      state: () => ({ authorized: false }),
      readQuestionConsumer(id, actualSignal) {
        consumerReads += 1;
        assert.equal(id, record.requestId);
        assert.equal(actualSignal, signal);
        return options.missingConsumer ? null : consumer.promise;
      },
    },
    installMainOwnedShutdownQuestions(owner, tails, settings) {
      assert.equal(owner, win);
      assert.equal(Array.isArray(tails), true);
      assert.equal(settings.policy, "ordinary-strict");
      onRecord = settings.onRecord;
      return {
        records,
        async join(afterDispatch) {
          assert.equal(afterDispatch, undefined, "partial consumer is never full afterDispatch");
          const outcomes = await Promise.allSettled(records.flatMap(
            item => [item.joined, item.observerWork]));
          const errors = outcomes.filter(item => item.status === "rejected").map(item => item.reason);
          if (errors.length) throw new AggregateError(errors, "simulated observed ledger");
          return { records: records.slice(), dispatchBoundaryJoined: false };
        },
        restore() { restores += 1; },
      };
    },
  });
  const run = vm.runInContext(gapAdapterSource + gapCleanupSource +
    "\n(async () => {\n" + gapSource + "\nreturn gapCloseAsked;\n})", context);
  return { run, record, consumer, get restores() { return restores; },
    get consumerReads() { return consumerReads; } };
}

async function main() {
  await check("an unsolicited downloaded event cannot grant current readiness", async () => {
    const h = readiness();
    try {
      h.updater.emit("update-downloaded", { version: "9.9.9", downloadedFile: __filename });
      assert.equal(h.controller.snapshot().canInstall, false);
      assert.equal(h.readyPath, null);
    } finally { h.fixture.restore(); }
  });
  await check("the fixture drives real Check and Download with validated metadata", async () => {
    const h = readiness({ cached: "12.4.9" });
    try {
      const prepared = await h.fixture.prepare();
      assert.equal(prepared.candidate, "12.4.10");
      assert.equal(prepared.state.canInstall, true);
      assert.equal(prepared.state.readyVersion, prepared.candidate);
      assert.equal(h.readyPath, __filename);
      assert.equal(h.updater.downloadedUpdateHelper.file, __filename);
      assert.equal(h.updater.downloadedUpdateHelper.versionInfo.version, prepared.candidate);
      assert.deepEqual(h.trace.filter(row => row[0].endsWith("-action")).map(row => row[0]),
        ["check-action", "download-action"]);
    } finally { h.fixture.restore(); }
    assert.equal(h.updater.checkForUpdates, h.originalCheck);
    assert.equal(h.updater.downloadUpdate, h.originalDownload);
    assert.equal(Object.hasOwn(h.app, "isPackaged"), false);
  });
  await check("a later candidate advances beyond remembered availability and downloads again", async () => {
    const h = readiness();
    try {
      const first = await h.fixture.prepare();
      const second = await h.fixture.prepare();
      assert.notEqual(first.candidate, second.candidate);
      assert.equal(second.state.canInstall, true);
      assert.equal(h.trace.filter(row => row[0] === "download-start").length, 2);
    } finally { h.fixture.restore(); }
  });
  await check("the held real download tail cannot install and failure removes readiness", async () => {
    const h = readiness();
    try {
      const tail = await h.fixture.prepare({ holdDownload: true });
      assert.equal(tail.state.status, "finalizing");
      assert.equal(tail.state.canInstall, false);
      assert.equal(h.readyPath, null);
      tail.reject(new Error("controlled tail rejection"));
      assert.equal(await waitUntil(() => h.controller.snapshot().canCheck), true);
      assert.equal(h.controller.snapshot().status, "error");
      assert.equal(h.controller.snapshot().canInstall, false);
      assert.equal(h.readyPath, null);
      assert.throws(() => tail.reject(new Error("duplicate")), /ownership changed/);
    } finally { h.fixture.restore(); }
  });
  await check("metadata mutation invalidates the actual Main readiness validator", async () => {
    const h = readiness();
    try {
      await h.fixture.prepare();
      h.updater.downloadedUpdateHelper.versionInfo.version = "0.0.1";
      assert.equal(h.controller.snapshot().canInstall, false);
      assert.equal(h.controller.snapshot().readyVersion, null);
    } finally { h.fixture.restore(); }
  });
  await check("provider cleanup refuses foreign ownership but still restores independent fields", async () => {
    const h = readiness();
    h.updater.checkForUpdates = () => null;
    assert.throws(() => h.fixture.restore(), /cleanup failed/);
    assert.equal(h.updater.downloadUpdate, h.originalDownload);
    assert.equal(Object.hasOwn(h.app, "isPackaged"), false);
  });
  await check("an unreadable provider cannot prevent independent provider and field cleanup", async () => {
    const h = readiness();
    Object.defineProperty(h.updater, "checkForUpdates", {
      get() { throw new Error("unreadable foreign provider"); }, configurable: true,
    });
    assert.throws(() => h.fixture.restore(), /cleanup failed/);
    assert.equal(h.updater.downloadUpdate, h.originalDownload);
    assert.equal(Object.hasOwn(h.app, "isPackaged"), false);
  });
  await check("a failed packaged-check borrow rolls back both provider methods", async () => {
    const app = {};
    Object.defineProperty(app, "isPackaged", { value: false, configurable: false });
    const updater = { checkForUpdates() {}, downloadUpdate() {} };
    const before = Object.getOwnPropertyDescriptors(updater);
    const context = vm.createContext({ app, require: projectRequire,
      replaceMethod, waitUntil, AggregateError, isDeepStrictEqual });
    const create = vm.runInContext(fixtureSource + "\ncreateInstalledUpdaterFixture", context);
    assert.throws(() => create(async () => null, updater, __filename), /installation failed/);
    assert.deepEqual(Object.getOwnPropertyDescriptors(updater), before);
    assert.equal(app.isPackaged, false);
  });
  await check("an unfinished download cleanup reports failure and still restores providers", async () => {
    const h = readiness();
    await h.fixture.prepare({ holdDownload: true });
    assert.throws(() => h.fixture.restore(), /cleanup failed/);
    assert.equal(h.updater.checkForUpdates, h.originalCheck);
    assert.equal(h.updater.downloadUpdate, h.originalDownload);
    assert.equal(Object.hasOwn(h.app, "isPackaged"), false);
    assert.equal(await waitUntil(() => h.controller.snapshot().canCheck), true);
  });
  await check("Darwin's real manual-only producer refuses automatic fixture preparation before Check", async () => {
    const h = readiness({ platform: "darwin", cached: "12.4.9" });
    try {
      await assert.rejects(h.fixture.prepare(), /manual-only updates/);
      assert.equal(h.controller.snapshot().manualOnly, true);
      assert.equal(h.controller.snapshot().canDownload, false);
      assert.equal(h.controller.snapshot().canInstall, false);
      assert.equal(h.trace.some(row => row[0].endsWith("-action")), false);
    } finally { h.fixture.restore(); }
  });
  await check("the actual Darwin leaf reports manual-only coverage without borrowing an installer", async () => {
    const h = readiness({ platform: "darwin" });
    const checks = [];
    try {
      h.context.actualHostPlatform = "darwin";
      h.context.check = (name, passed) => checks.push({ name, passed });
      h.context.createBaseUpdaterBranchBorrow = () => { throw new Error("Forbidden branch borrow"); };
      h.context.require = () => { throw new Error("Forbidden app dependency"); };
      const run = vm.runInContext(installedSource + "\nrunInstalledUpdateCommitScenarios", h.context);
      await run({}, h.exec);
      assert.equal(checks.length, 1);
      assert.equal(checks[0].passed, true);
      assert.match(checks[0].name, /manual-only boundary/);
      assert.equal(h.trace.some(row => row[0].endsWith("-action")), false);
    } finally { h.fixture.restore(); }
  });
  for (const [name, body] of [
    ["installed updater", installedSource],
    ["Windows launcher", windowsSource],
  ]) {
    await check(name + " setup failure still restores its independent actor borrows", async () => {
      const restored = [];
      const failure = new Error("controlled fixture construction failure");
      const updater = new EventEmitter();
      const originalInstall = updater.quitAndInstall = () => {};
      const childProcess = { spawn() { throw new Error("Forbidden real spawn"); } };
      const originalSpawn = childProcess.spawn;
      const processPort = new EventEmitter();
      const nativeUpdater = new EventEmitter();
      const context = vm.createContext({
        path, dir: path.dirname(__filename), __dirname,
        actualHostPlatform: "win32", process: processPort,
        electronAutoUpdater: nativeUpdater,
        require: dependency => {
          if (dependency === "electron-updater") return { autoUpdater: updater };
          if (dependency === "child_process") return childProcess;
          throw new Error("Forbidden app dependency: " + dependency);
        },
        createBaseUpdaterBranchBorrow: () => ({ restore: async () => restored.push("branch") }),
        createInstalledUpdaterFixture: () => { throw failure; },
        shutdownRig: () => ({ restore: () => restored.push("rig") }),
        replaceMethod, AggregateError,
        __shutdown: {
          state: () => ({ rendererGeneration: 7 }),
          reset: () => restored.push("reset"),
        },
      });
      const symbol = name === "installed updater"
        ? "runInstalledUpdateCommitScenarios" : "runWindowsInstalledLauncherScenarios";
      const run = vm.runInContext(body + "\n" + symbol, context);
      await assert.rejects(run({ webContents: {} }, async () => ({ manualOnly: false })),
        error => error instanceof AggregateError && error.errors[0] === failure);
      assert.equal(updater.quitAndInstall, originalInstall);
      assert.equal(childProcess.spawn, originalSpawn);
      assert.equal(restored.includes("rig"), true);
      assert.equal(restored.includes("reset"), true);
      if (name === "installed updater") assert.equal(restored.includes("branch"), true);
    });
  }
  await check("ordinary input needs an explicit nonempty discard reason", async () => {
    const h = documents();
    await assert.rejects(h.actor.editInstalledFixture("EXACT", ""), /ordinary discard reason/);
    assert.equal(h.calls.includes("input"), false);
    assert.equal(h.actor.expectedDiscards.size, 0);
  });
  await check("ordinary actor input preserves the independent cache and captures exact consent", async () => {
    const h = documents();
    const content = "# Installed commit fixture\nEXACT_NEW_EDIT\n";
    await h.actor.editInstalledFixture(content, "discard the deliberate fixture edit");
    assert.equal(h.context.markdownEditor.value, content);
    assert.equal(h.tab.content, "# Installed commit fixture\n");
    assert.equal(h.tab.hasUnsavedChanges, false);
    assert.equal(h.context.hasUnsavedChanges, true);
    const permission = h.actor.expectedDiscards.get(h.tab.id);
    assert.equal(permission.content, content);
    assert.equal(permission.owner.documentRef, h.owner.documentRef);
    assert.equal(permission.filePath, "fixture.md");
  });
  for (const [name, change] of [
    ["unknown document owner", h => { h.options.ownerCurrent = false; }],
    ["retired Main admission", h => { h.options.mainCurrent = false; }],
    ["pending Save", h => { h.options.pending = 1; }],
  ]) {
    await check(name + " refuses before ordinary input or discard permission", async () => {
      const h = documents();
      change(h);
      await assert.rejects(h.actor.editInstalledFixture("EXACT", "ordinary discard"), /owned editor/);
      assert.equal(h.calls.includes("input"), false);
      assert.equal(h.actor.expectedDiscards.size, 0);
    });
  }
  for (const [name, change] of [
    ["an eager cache write", h => { h.options.eagerCache = true; }],
    ["a missing mutation witness", h => { h.options.mutate = false; }],
    ["an owner replacement during input", h => { h.options.retarget = true; }],
    ["a missing preview", h => { h.options.paint = false; }],
  ]) {
    await check(name + " cannot pass the live-input actor oracle", async () => {
      const h = documents();
      change(h);
      await assert.rejects(h.actor.editInstalledFixture("EXACT", "ordinary discard"),
        /lost its live edit/);
      assert.equal(h.actor.expectedDiscards.size, 0);
    });
  }
  await check("installed cleanup consumes exact shared-close permissions and awaits layout", async () => {
    const h = documents();
    await h.actor.editInstalledFixture("EXACT", "discard this edit only");
    const result = await h.actor.clearDocuments();
    assert.equal(result.remaining, 0);
    assert.equal(h.closeCalls.length, 1);
    assert.deepEqual(Array.from(h.closeCalls[0].settings.tabIds), [1]);
    assert.equal(h.closeCalls[0].settings.expectedDiscards[0].content, "EXACT");
    assert.equal(h.calls.at(-1), "settle-layout");
    assert.equal(h.actor.expectedDiscards.size, 0);
  });
  await check("incomplete cleanup fails without erasing its captured dirty permission", async () => {
    const h = documents();
    await h.actor.editInstalledFixture("EXACT", "discard this edit only");
    h.setClose(async () => ({ records: [], remaining: [{ id: 1 }] }));
    await assert.rejects(h.actor.clearDocuments(), /retained an owner/);
    assert.equal(h.actor.expectedDiscards.size, 1);
    assert.equal(h.calls.includes("settle-layout"), false);
  });
  await check("a shared-close rejection remains a rejection and does not continue cleanup", async () => {
    const h = documents();
    const failure = new Error("real close refusal");
    h.setClose(async () => { throw failure; });
    await assert.rejects(h.actor.clearDocuments(), error => error === failure);
    assert.equal(h.calls.includes("settle-layout"), false);
  });
  await check("the original installed admission waits for processor and render completion", async () => {
    const join = between(admissionSource, "      await boundedDialogWork(exec(`",
      '), "installed fixture original processor and render", 10000);');
    const quoted = join.slice("      await boundedDialogWork(exec(`".length)
      .replaceAll("${jsCommitFile}", JSON.stringify("fixture.md"));
    assert.equal(quoted.at(-1), String.fromCharCode(96));
    const expression = quoted.slice(0, -1);
    const processor = deferred();
    const render = deferred();
    const observation = {
      processors: [{ packet: { path: "fixture.md" }, eventUndefined: true,
        promise: processor.promise, settled: false }],
      renders: [],
    };
    const completion = vm.runInNewContext(expression, { window: { __dialogBatchNative: observation } });
    let done = false;
    completion.then(() => { done = true; });
    await Promise.resolve();
    assert.equal(done, false);
    observation.processors[0].settled = true;
    observation.renders.push({ prefix: "# Installed commit fixtu", promise: render.promise, settled: false });
    processor.resolve();
    await Promise.resolve();
    assert.equal(done, false);
    observation.renders[0].settled = true;
    render.resolve();
    await completion;
    assert.equal(done, true);
  });
  await check("the installed gap drives the exact normal Main question through genuine Cancel", async () => {
    const h = installedGap();
    assert.equal(await h.run(), true);
    assert.equal(h.record.choiceSubmitted, 1);
    assert.equal(h.record.choiceDelivered, true);
    assert.equal(h.consumerReads, 1);
    assert.equal(h.restores, 1);
  });
  const normalQuestionAssertion =
    "a native close inside the installed deferred-commit gap is asked rather than silently authorized";
  for (const [name, options, failure] of [
    ["native-only observation", { nativeOnly: true }, "has no single original Main question"],
    ["fallback title", { title: "Unsaved changes cannot be checked" }, "exact normal Main question"],
    ["completion without displayed observation", { completed: true }, "exact normal Main question"],
    ["missing original consumer", { missingConsumer: true }, "original Main consumer completion"],
    ["undelivered Cancel", { undelivered: true }, normalQuestionAssertion],
    ["emergency result", { result: { emergency: true } }, normalQuestionAssertion],
    ["unchosen cancellation", { result: { cause: "cancel" } }, normalQuestionAssertion],
    ["replaced original result", { wrongResultIdentity: true }, normalQuestionAssertion],
  ]) {
    await check(name + " cannot pass the installed normal-question oracle", async () => {
      const h = installedGap(options);
      await assert.rejects(h.run(), error => error.message.includes(failure));
      assert.equal(h.consumerReads, options.nativeOnly ? 0 : 1);
      assert.equal(h.record.choiceSubmitted, options.nativeOnly || options.completed ? null : 1);
      assert.equal(h.restores, 1);
    });
  }
  await check("the installed gap retains its original Main consumer before restoring the adapter", async () => {
    const h = installedGap({ holdConsumer: true });
    let done = false;
    const work = h.run().then(() => { done = true; });
    assert.equal(await waitUntil(() => h.consumerReads === 1), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.record.choiceDelivered, true);
    assert.equal(done, false);
    assert.equal(h.restores, 0);
    h.consumer.resolve();
    await work;
    assert.equal(h.restores, 1);
  });
  await check("independent installed question and consumer errors remain observable", async () => {
    const producerError = new Error("original producer failed");
    const driverError = new Error("original driver failed");
    const observerError = new Error("original observer failed");
    const consumerError = new Error("original consumer failed");
    const h = installedGap({ producerError, driverError, observerError, consumerError });
    const contains = (error, target) => error === target ||
      Array.from(error.errors || []).some(item => contains(item, target));
    await assert.rejects(h.run(), error =>
      [producerError, driverError, observerError, consumerError].every(item => contains(error, item)));
    assert.equal(h.restores, 1);
  });
  console.log(`${passed} source/VM controls passed; native installation/launcher/fold NOT RUN.`);
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
