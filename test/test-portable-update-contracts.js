"use strict";

// Actual portable callers and selected suppliers; simulated renderer/lifecycle
// ports only. No Electron, native question, child, batch or installer is run.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const vm = require("node:vm");
const projectRequire = createRequire(path.join(process.cwd(), "package.json"));
const source = fs.readFileSync(path.join(__dirname, "test-tab-refresh.js"), "utf8")
  .replace(/\r\n/g, "\n");
const closerInput = process.argv[2] || path.join(__dirname, "test-tab-refresh.js");
const closerInputSource = fs.readFileSync(closerInput, "utf8").replace(/\r\n/g, "\n");
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
const actorSource = between(source, "async function runPortableUpdateScenarios(",
  "\n// ============================================================\n// TEARDOWN IS NOT CONSENT");
const fixtureSource = between(source, "function createInstalledUpdaterFixture(",
  "async function runInstalledUpdateCommitScenarios(");
const closerSource = between(closerInputSource, "async function closeOwnedFixtureTabs(",
  "\nasync function run(win)");
assert.equal(createHash("sha256").update(closerSource).digest("hex"),
  "8771b1324757f3f6cc88e98cfc66cc0cbbf7fc8a70d628a4d91494f6ffa33aef",
  "portable controls use the actual selected captured-target supplier");
const installSource = between(actorSource, "  const startInstall =",
  "\n\n  try {");
const actorPrelude = actorSource.slice(actorSource.indexOf("{") + 1,
  actorSource.indexOf("\n\n  try {"));
const rigSource = between(source, "function replaceMethod(",
  "\nfunction portableInstallEvent(");
const validatorSource = between(mainSource, "  validateReady: artifact => {",
  "\n  onDownloadStart:").slice("  validateReady: ".length).trim().replace(/,$/, "");
assert.equal(createHash("sha256").update(fixtureSource).digest("hex"),
  "7d15a9ac97e54fac695054382e9649ec21a510348c4baf90b6bf058d6a97b92c",
  "portable uses the exact selected supplier, including both separating LFs");
const producerModule = { exports: {} };
vm.runInNewContext(producer, { require: projectRequire, module: producerModule });
const { createUpdateState } = producerModule.exports;
let passed = 0;
const messages = error => [error.message, ...Array.from(error.errors || [], messages)].join("\n");
async function check(name, run) {
  await run();
  passed += 1;
  console.log("PASS  " + name);
}
function harness({ platform = "darwin", override = {}, rendererReady = true } = {}) {
  const trace = [];
  const checks = [];
  const app = Object.create({ isPackaged: false });
  const updater = new EventEmitter();
  const originalCheck = updater.checkForUpdates = () => {
    throw new Error("Unborrowed check");
  };
  const originalDownload = updater.downloadUpdate = () => {
    throw new Error("Unborrowed download");
  };
  const controller = createUpdateState({
    installedVersion: "0.11.3", platform,
    enabled: () => app.isPackaged,
    getUpdater: () => updater,
    readAvailability: () => null,
    writeAvailability: () => {},
    log: () => {},
    isInstalling: () => false,
    canInstall: () => true,
    validateReady: () => false,
    onDownloadStart: () => {},
    onDownloadReady: () => {},
    onDownloadEnd: () => {},
    publish: () => {},
  });
  controller.attach(updater);
  updater.on("update-available", controller.observeAvailable);
  const window = { folia: {
    getUpdateState() {
      trace.push("read");
      return { ...controller.snapshot(), ...override };
    },
    checkForUpdates() { trace.push("check"); return controller.check(); },
    downloadUpdate() { trace.push("download"); return controller.download(); },
    installUpdate() { trace.push("install"); },
  } };
  const context = vm.createContext({
    window, app, path, process: { env: {}, platform }, isDeepStrictEqual,
    dir: "portable-control", AggregateError, setImmediate,
    require(name) {
      if (name === "child_process") return {};
      if (name === "electron-updater") return { autoUpdater: updater };
      return projectRequire(name);
    },
    fs: {
      mkdirSync() { trace.push("mkdir"); },
      rmSync() { trace.push("remove"); },
    },
    ipcMain: { listeners: () => [() => { throw new Error("Native handler forbidden"); }] },
    shutdownRig: () => ({
      restore() { trace.push("restore-rig"); },
      reset() { trace.push("reset-rig"); },
    }),
    __shutdown: {
      state: () => ({ renderer: rendererReady ? "ready" : "loading",
        pendingId: 0, commitPendingId: 0, shutdownPendingContinuationCount: 0 }),
      reset() { trace.push("reset-main"); },
    },
    check: (name, ok, detail) => { checks.push({ name, ok, detail }); },
    write() { throw new Error("Automatic fixture write reached"); },
    async waitUntil(predicate) { return predicate(); },
    replaceMethod(target, name, implementation) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      Object.defineProperty(target, name, {
        value: implementation, configurable: true, writable: true,
      });
      trace.push("borrow-" + name);
      return () => {
        trace.push("restore-" + name);
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete target[name];
      };
    },
  });
  const exec = async code => structuredClone(await vm.runInContext(code, context));
  const win = { isDestroyed: () => false, webContents: { executeJavaScript: exec } };
  vm.runInContext(fixtureSource + "\n" + actorSource +
    "\nglobalThis.run = runPortableUpdateScenarios;", context);
  return {
    context, trace, checks, app, updater, controller,
    run: () => context.run(win),
    assertRestored() {
      assert.equal(updater.checkForUpdates, originalCheck);
      assert.equal(updater.downloadUpdate, originalDownload);
      assert.equal(Object.hasOwn(app, "isPackaged"), false);
      assert.equal(Object.hasOwn(updater, "downloadedUpdateHelper"), false);
      for (const name of ["checkForUpdates", "downloadUpdate"]) {
        assert.equal(trace.filter(item => item === "restore-" + name).length, 1);
      }
      assert.equal(trace.filter(item => item === "restore-rig").length, 1);
      assert.equal(trace.filter(item => item === "reset-main").length, 0);
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function documents() {
  const fields = ["pageSession", "rendererGeneration", "tabId",
    "documentGeneration", "pathKey", "documentRef"];
  const text = "# Portable update fixture\n";
  const owner = { pageSession: "PAGE", rendererGeneration: 7, tabId: 1,
    documentGeneration: 3, pathKey: "KEY", documentRef: "REF" };
  const descriptor = { ref: "REF", logicalPath: "fixture.md", readTarget: "physical.md" };
  const tab = { id: 1, filePath: "fixture.md", content: text, originalContent: text,
    hasUnsavedChanges: false, mtimeMs: 100,
    diskVersion: { dev: 1, ino: 2, size: text.length, mtimeMs: 100, ctimeMs: 100 } };
  const tabs = [tab];
  const state = { maintained: true, dirty: false, mutationRevision: 4, deletionTombstone: false };
  const options = { frozen: false, known: true, unresolved: false, mainCurrent: true,
    admitted: true, selection: 9, registrationAccepted: true, thawDrift: false,
    retainMain: false, malformedClose: false, pendingId: 0, lastRequestId: 9,
    installing: false, absorbedId: 0, replayScheduled: false,
    replaceAtRendererTurn: null, replaceDuringSettlement: false,
    foreignDuringSettlement: false, foreignDuringLayout: false,
    foreignAfterClose: false, mutatePermissionDuringSettlement: null };
  const trace = [], registrations = [], closes = [];
  const foreignOwners = [], foreignEvidence = new Map();
  let rendererTurns = 0;
  const replaceOwner = () => {
    owner.documentGeneration += 1;
    owner.documentRef += "-replacement";
    descriptor.ref = owner.documentRef;
    trace.push("replace-owner");
  };
  const addForeignOwner = label => {
    const foreign = { ...owner, documentRef: "FOREIGN-" + label,
      documentGeneration: 99, readTarget: "foreign-" + label + ".md" };
    foreignOwners.push(foreign);
    foreignEvidence.set(foreign.documentRef, { baseline: label, deletionRevision: 17 });
    trace.push("foreign-owner:" + label);
    return foreign;
  };
  let mainRetired = false, registration = null, closeGate = null;
  const closeEntered = deferred();
  const window = {
    currentFilePath: "fixture.md", originalMarkdown: text,
    getReloadRequestSession: () => owner.pageSession,
    getPendingSaveStatus: () => ({ count: 0, pending: false }),
    CustomTabs: {
      getActiveTabId: () => tabs[0]?.id ?? null,
      getTabs: () => { trace.push("read-tabs"); return tabs; },
      getDocumentIdentityForTab: () => ({ ...owner }),
      getDocumentDescriptor: () => ({ ...descriptor }),
      __documentState: () => ({ ...state }),
      isDocumentFrozen: () => options.frozen,
      async settleSessionLayout() {
        trace.push("settle-layout");
        if (options.foreignDuringLayout) {
          options.foreignDuringLayout = false;
          addForeignOwner("LAYOUT");
        }
      },
    },
    folia: {
      queryDocumentDeletionState: () => ({
        known: options.known, unresolved: options.unresolved, revision: 1,
      }),
      getVersion() {
        trace.push("barrier");
        if (registration && options.registrationAccepted) {
          options.known = registration.owner.selectionGeneration === options.selection;
          registration = null;
        }
        return "0.11.3";
      },
      registerDocumentOwner(payload) {
        trace.push("register");
        registration = structuredClone(payload);
        registrations.push(registration);
      },
    },
  };
  const context = vm.createContext({
    window, path, process: { env: {}, platform: "win32" }, isDeepStrictEqual, setTimeout,
    setImmediate(callback) {
      return setImmediate(() => {
        if (options.replaceDuringSettlement) {
          options.replaceDuringSettlement = false;
          replaceOwner();
        }
        if (options.foreignDuringSettlement) {
          options.foreignDuringSettlement = false;
          addForeignOwner("SETTLEMENT");
        }
        if (options.mutatePermissionDuringSettlement) {
          options.mutatePermissionDuringSettlement.content = "FOREIGN";
          options.mutatePermissionDuringSettlement.owner.documentRef = "FOREIGN";
          options.mutatePermissionDuringSettlement = null;
          trace.push("mutate-permission");
        }
        callback();
      });
    },
    dir: "fixtures", fileA: "fixture.md", isEditMode: false,
    hasUnsavedChanges: false, markdownEditor: { value: text },
    document: { getElementById: () => ({ open: false }) },
    toggleEditBtn: { click() { trace.push("restore-mode"); context.isEditMode = false; } },
    fs: {
      statSync() { throw new Error("Unrequested metadata substitution"); },
    },
    require(name) {
      if (name === "child_process") return {};
      if (name === "electron-updater") return { autoUpdater: {} };
      return projectRequire(name);
    },
    ipcMain: { listeners: () => [] },
    shutdownRig: () => ({ reset() { trace.push("reset-rig"); } }),
    __shutdown: {
      state: () => ({ renderer: "ready", pendingId: options.pendingId, commitPendingId: 0,
        queuedReason: null, lastRequestId: options.lastRequestId,
        updateInstallStarted: options.installing,
        absorbedUserIntentId: options.absorbedId,
        absorbedUserReplayScheduled: options.replayScheduled,
        shutdownPendingContinuationCount: 0 }),
      documentSessionState: () => ({ owners: [
        ...(!tabs.length && !options.retainMain || mainRetired || !options.mainCurrent ? [] :
          [{ ...owner, readTarget: descriptor.readTarget, selectionGeneration: options.selection }]),
        ...foreignOwners.map(foreign => ({ ...foreign })),
      ] }),
      documentAdmissionIsCurrent: ref => !mainRetired && options.admitted && ref === descriptor.ref,
      reset() {
        trace.push("reset-main");
        options.pendingId = 0;
        options.installing = false;
        options.known = false;
        foreignEvidence.clear();
        if (options.frozen) {
          options.frozen = false;
          options.selection += 1;
          if (options.thawDrift) context.markdownEditor.value += "DRIFT";
        }
      },
    },
    async waitForCondition(exec, code) { return exec(code); },
    async waitUntil(predicate) { return predicate(); },
    async closeOwnedFixtureTabs(_exec, phase, settings) {
      closes.push(structuredClone({ phase, settings }));
      trace.push("close-enter");
      closeEntered.resolve();
      if (closeGate) await closeGate.promise;
      const closing = tabs.splice(0);
      mainRetired = !options.retainMain;
      context.hasUnsavedChanges = false;
      if (options.foreignAfterClose) {
        options.foreignAfterClose = false;
        addForeignOwner("CLOSE");
      }
      trace.push("close-settled");
      return { records: closing.map(closed => ({
        tabId: closed.id, closed: !options.malformedClose, settled: true, error: null,
      })), remaining: [] };
    },
    write(file, content) { trace.push(["write", file, content]); },
    async openShutdownLifecycleFixture(_exec, filePath, body, marker) {
      trace.push(["native-admission-port", filePath, body, marker]);
      tab.id += 1;
      owner.tabId = tab.id;
      owner.documentGeneration += 1;
      owner.documentRef += "-new";
      descriptor.ref = owner.documentRef;
      descriptor.logicalPath = descriptor.readTarget = tab.filePath = filePath;
      window.currentFilePath = filePath;
      tab.content = tab.originalContent = body;
      tab.hasUnsavedChanges = false;
      state.dirty = false;
      options.known = true;
      mainRetired = false;
      tabs.push(tab);
      window.originalMarkdown = context.markdownEditor.value = body;
    },
    AggregateError,
  });
  const exec = async code => {
    rendererTurns += 1;
    if (options.replaceAtRendererTurn === rendererTurns) replaceOwner();
    return structuredClone(await vm.runInContext(code, context));
  };
  window.markdownEditor = context.markdownEditor;
  window.CustomTabs.__inEditMode = () => context.isEditMode;
  window.CustomTabs.__shutdownFreeze = () => ({ frozen: options.frozen, dialogDecisionIntent: 0 });
  window.CustomTabs.closeTab = async id => {
    const index = tabs.findIndex(current => current.id === id);
    assert.notEqual(index, -1, "the original shared closer has a live target");
    closes.push(id);
    tabs.splice(index, 1);
    mainRetired = true;
    context.hasUnsavedChanges = false;
  };
  context.MutationObserver = class {
    observe() {}
    takeRecords() { return []; }
    disconnect() {}
  };
  context.check = (name, ok, detail) => assert.equal(ok, true, name + ": " + detail);
  context.win = { isDestroyed: () => false, webContents: { executeJavaScript: exec } };
  vm.runInContext(actorPrelude + `
    globalThis.actor = { readPortableDocuments, mainPortableOwner, capturePortableDiscard,
      inspectPortableFixture, retirePortableFixture, replacePortableFixture, resetCounts,
      settlePortableOriginalWork, portableChildren, portableDirectories,
      expectedDiscards, setUpdater(value) { updaterFixture = value; } };`, context);
  return {
    actor: context.actor, context, tab, tabs, state, owner, descriptor, options,
    trace, registrations, closes, closeEntered, fields, text, foreignOwners, foreignEvidence,
    holdClose() { closeGate = deferred(); return closeGate; },
    useRealCloser() { vm.runInContext(closerSource, context); },
    replaceOwner, addForeignOwner,
    scheduleReplacement(turns) { options.replaceAtRendererTurn = rendererTurns + turns; },
    dirty(content, { lazy = true, frozen = false } = {}) {
      context.isEditMode = true;
      context.hasUnsavedChanges = true;
      context.markdownEditor.value = content;
      state.dirty = true;
      tab.hasUnsavedChanges = true;
      state.mutationRevision += 1;
      if (!lazy) tab.content = content;
      options.frozen = frozen;
    },
  };
}

function automatic({ pendingTail = false, initialOwner = null } = {}) {
  const h = documents();
  const root = fs.mkdtempSync(path.join(__dirname, "portable-control-"));
  const app = Object.create({ isPackaged: false });
  const updater = new EventEmitter();
  const originalCheck = updater.checkForUpdates = () => { throw new Error("Unborrowed check"); };
  const originalDownload = updater.downloadUpdate = () => { throw new Error("Unborrowed download"); };
  let atBoundary = false, fixture, creates = 0;
  const validateReady = vm.runInNewContext("(" + validatorSource + ")", {
    autoUpdater: updater,
    isExistingRegularFile: file => fs.existsSync(file) && fs.statSync(file).isFile(),
  });
  const controller = createUpdateState({
    installedVersion: "0.11.3", platform: "win32",
    enabled: () => app.isPackaged, getUpdater: () => updater,
    readAvailability: () => ({ schema: 1, version: "12.4.9" }),
    writeAvailability: () => {}, log: () => {},
    isInstalling: () => h.options.installing,
    canInstall: () => true, validateReady,
    onDownloadStart: () => {}, onDownloadReady: () => {}, onDownloadEnd: () => {},
    publish: () => {},
  });
  controller.attach(updater);
  updater.on("update-available", controller.observeAvailable);
  const folia = h.context.window.folia;
  Object.assign(folia, {
    getUpdateState() { h.trace.push("read-update"); return controller.snapshot(); },
    checkForUpdates() { h.trace.push("public-check"); void controller.check(); },
    downloadUpdate() { h.trace.push("public-download"); void controller.download(); },
  });
  h.context.dir = root;
  h.context.fileA = path.join(root, "fixture.md");
  if (initialOwner) {
    h.tab.filePath = h.context.fileA;
    h.descriptor.logicalPath = h.context.fileA;
    h.context.window.currentFilePath = h.context.fileA;
    if (initialOwner === "unknown") h.options.known = false;
    if (initialOwner === "unresolved") h.options.unresolved = true;
    if (initialOwner === "deleted") h.state.deletionTombstone = true;
    if (initialOwner === "foreign") h.options.mainCurrent = false;
    if (initialOwner === "orphan") {
      h.tabs.length = 0;
      h.options.retainMain = true;
    }
  } else {
    h.tabs.length = 0;
  }
  Object.assign(h.context, {
    app, fs,
    process: { env: {}, platform: "win32" },
    ipcMain: { listeners: () => [() => { throw new Error("Native install handler forbidden"); }] },
    shutdownRig: () => ({
      reset() { h.trace.push("reset-rig"); },
      restore() { h.trace.push("restore-rig"); },
    }),
    check(name, ok) {
      h.trace.push(["actor-check", name, ok]);
      assert.equal(ok, true, name);
    },
    require(name) {
      if (name === "child_process") return {};
      if (name === "electron-updater") return { autoUpdater: updater };
      return projectRequire(name);
    },
    write(file, content) { fs.writeFileSync(file, content, "utf8"); },
    async waitUntil(predicate) {
      for (let turn = 0; turn < 12; turn += 1) {
        if (await predicate()) return true;
        await new Promise(resolve => setImmediate(resolve));
      }
      return false;
    },
    replaceMethod(target, name, implementation) {
      if (target === fs) {
        assert.equal(name, "mkdtempSync");
        atBoundary = true;
        if (pendingTail) h.options.installing = true;
        h.trace.push("contained-native-boundary");
        throw new Error("PORTABLE_CONTROL_BOUNDARY");
      }
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      Object.defineProperty(target, name, {
        value: implementation, writable: true, configurable: true,
      });
      return () => {
        h.trace.push("restore-" + name);
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete target[name];
      };
    },
  });
  h.context.win.isDestroyed = () => false;
  const create = vm.runInContext(fixtureSource + "\ncreateInstalledUpdaterFixture", h.context);
  h.context.createInstalledUpdaterFixture = (...args) => {
    creates += 1;
    fixture = create(...args);
    return fixture;
  };
  const run = vm.runInContext(actorSource + "\nrunPortableUpdateScenarios", h.context);
  return {
    ...h, root, updater, app, controller,
    run: () => run(h.context.win),
    get creates() { return creates; },
    get fixture() { return fixture; },
    assertRestored() {
      assert.equal(updater.checkForUpdates, originalCheck);
      assert.equal(updater.downloadUpdate, originalDownload);
      assert.equal(Object.hasOwn(app, "isPackaged"), false);
      assert.equal(Object.hasOwn(updater, "downloadedUpdateHelper"), false);
    },
    cleanup() {
      atBoundary = false;
      h.options.installing = false;
      if (pendingTail && fixture) fixture.restore();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// Actual portable caller/rig bodies; controlled driver records and Main lookup.
// The separate provider suite executes the selected provider/preload bodies.
function questionHarness() {
  const lookups = [];
  const consumers = new Map();
  const records = [];
  const trace = [];
  const app = { quit() { throw new Error("Uncontained quit"); } };
  const dialog = { showMessageBox() { throw new Error("Uncontained native question"); } };
  const win = { close() { throw new Error("Uncontained close"); },
    webContents: { executeJavaScript() { throw new Error("Unexpected renderer work"); } } };
  const originals = { quit: app.quit, close: win.close, native: dialog.showMessageBox };
  let onRecord;
  let restored = false;
  const driver = {
    records,
    async join(...args) {
      assert.equal(args.length, 0, "partial ledger is never supplied as afterDispatch");
      const results = [];
      let observed;
      do {
        observed = records.length;
        results.push(...await Promise.allSettled(records.flatMap(record =>
          [record.joined, record.observerWork])));
      } while (observed !== records.length);
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "Simulated question ledger failed");
    },
    restore() {
      if (restored || records.some(record =>
        !record.settled || !record.driverSettled || !record.observerSettled)) {
        throw new Error("Simulated driver cannot restore unfinished or repeated work");
      }
      restored = true;
      trace.push("restore-driver");
    },
  };
  const context = vm.createContext({
    app, dialog, win, fs, path, dir: "portable-question-control", isDeepStrictEqual,
    AggregateError,
    require(name) {
      if (name === "child_process") return {};
      if (name === "electron-updater") return { autoUpdater: {} };
      return projectRequire(name);
    },
    ipcMain: { listeners: () => [] },
    __shutdown: {
      readQuestionConsumer(id, signal) {
        lookups.push({ id, signal });
        const row = consumers.get(signal);
        return row?.id === id ? row.consumer : null;
      },
      reset() { throw new Error("Partial question joining cannot reset Main"); },
    },
    installMainOwnedShutdownQuestions(owner, tails, options) {
      assert.equal(owner, win);
      assert.equal(options.policy, "cancellable");
      onRecord = options.onRecord;
      trace.push("install-driver");
      return driver;
    },
  });
  vm.runInContext(rigSource + "\nglobalThis.actor = (() => {" + actorPrelude + `
    return { rig, installPortableQuestions, joinPortableQuestions, joinPortableChoice,
      portableDialogs, portableScenarioQuestions, resetPortableQuestionCounters,
      restorePortableQuestionRig, holdPortableAnswer,
      state: () => ({ entries: portableQuestionEntries, offset: portableQuestionOffset,
        nativeFailures: portableNativeFailures }) };
  })();`, context);
  const actor = context.actor;
  const actualReset = actor.rig.reset;
  actor.rig.reset = () => { trace.push("reset-rig"); actualReset(); };
  actor.installPortableQuestions();
  function publish({ finishOnChoose = true, consumeOnChoose = true,
    registration = "exact", consumerTail = null } = {}) {
    const producer = deferred(), drive = deferred(), consumed = deferred(), presentation = deferred();
    const id = records.length + 101;
    const signal = new AbortController().signal;
    const record = {
      requestId: id, brokerId: id + 1000, options: { signal, title: "Unsaved changes" },
      pendingReason: "update-install", displayed: false, retired: false, settled: false,
      observerSettled: false, driverSettled: false, choiceDelivered: false,
      presentationReady: presentation.promise, choices: [], result: null,
    };
    const consumer = consumed.promise.then(() => consumerTail?.());
    producer.promise.then(result => {
      record.result = result;
      record.settled = record.retired = true;
    }, () => { record.settled = record.retired = true; });
    drive.promise.then(() => { record.driverSettled = true; },
      () => { record.driverSettled = true; });
    record.joined = Promise.allSettled([producer.promise, drive.promise]).then(results => {
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "Simulated producer/driver failed");
      return record;
    });
    record.choose = index => {
      assert.equal(record.displayed, true);
      assert.equal(record.retired, false);
      assert.equal(record.choices.length, 0);
      assert.ok([0, 1].includes(index));
      record.choices.push(index);
      record.choiceDelivered = true;
      if (finishOnChoose) {
        producer.resolve({ cause: "choice", response: index });
        drive.resolve();
      }
      if (consumeOnChoose) consumed.resolve();
    };
    records.push(record);
    const work = onRecord(record);
    record.observerWork = work;
    work.then(() => { record.observerSettled = true; },
      () => { record.observerSettled = true; });
    if (registration !== "absent") {
      consumers.set(registration === "wrong-signal" ? new AbortController().signal : signal,
        { id: registration === "wrong-id" ? id + 1 : id, consumer });
    }
    return {
      record, producer, drive, consumed, consumer, work,
      display() {
        record.displayed = true;
        record.presentation = { message: "alpha.md" };
        presentation.resolve({ kind: "displayed", presentation: record.presentation });
      },
      cancelBeforeDisplay() {
        producer.resolve({ cause: "aborted", response: 1 });
        drive.resolve();
        consumed.resolve();
        presentation.resolve({ kind: "completed" });
      },
    };
  }
  return { actor, app, dialog, win, originals, records, lookups, trace, publish };
}

async function main() {
  await check("manual-only portable callers return the actual controller capability before preparation", async () => {
    const h = harness();
    const result = await h.run();
    assert.equal(result.mode, "manual-only");
    assert.deepEqual(result.updateState, structuredClone(h.controller.snapshot()));
    assert.equal(result.updateState.manualOnly, true);
    assert.equal(result.updateState.canDownload, false);
    assert.equal(result.updateState.canInstall, false);
    assert.equal(h.checks.every(record => record.ok), true);
    assert.equal(h.checks.some(record => record.name.includes("manual-only")), true);
    assert.deepEqual(h.trace.filter(item =>
      ["check", "download", "install"].includes(item)), []);
    h.assertRestored();
  });
  for (const manualOnly of [undefined, null, "false", 0]) {
    await check("portable callers reject nonboolean manualOnly " + String(manualOnly), async () => {
      const h = harness({ override: { manualOnly } });
      await assert.rejects(h.run(), error => /explicit capability/.test(messages(error)));
      assert.deepEqual(h.trace.filter(item =>
        ["check", "download", "install"].includes(item)), []);
      h.assertRestored();
    });
  }
  for (const field of ["canDownload", "canInstall"]) {
    await check("manual-only portable callers reject an active " + field, async () => {
      const h = harness({ override: { [field]: true } });
      await assert.rejects(h.run(), error => /manual-only updater boundary is invalid/.test(messages(error)));
      assert.equal(h.checks.find(record => record.name.includes("manual-only")).ok, false);
      h.assertRestored();
    });
  }
  await check("manual-only capability cleanup does not wait for or cancel unrelated checking work", async () => {
    const h = harness({ override: { canCheck: false } });
    const result = await h.run();
    assert.equal(result.mode, "manual-only");
    h.assertRestored();
  });
  await check("a rejected eligibility read still restores the unused selected fixture once", async () => {
    const h = harness();
    h.context.window.folia.getUpdateState = () => { throw new Error("ELIGIBILITY_READ"); };
    await assert.rejects(h.run(), error => /ELIGIBILITY_READ/.test(messages(error)));
    h.assertRestored();
  });
  await check("a containment-restoration error does not skip independent provider restoration", async () => {
    const h = harness();
    h.context.shutdownRig = () => ({
      restore() { h.trace.push("restore-rig"); throw new Error("RIG_RESTORE"); },
    });
    await assert.rejects(h.run(), error => /RIG_RESTORE/.test(messages(error)));
    h.assertRestored();
  });
  await check("a renderer-readiness failure does not borrow a supplier or return an automatic result", async () => {
    const h = harness({ rendererReady: false });
    await assert.rejects(h.run(), error => /did not become ready/.test(messages(error)));
    assert.equal(h.trace.some(item => item.startsWith("borrow-")), false);
    assert.equal(h.checks.length, 1);
    assert.equal(h.checks[0].ok, false);
  });
  await check("the actual portable install caller uses the supported public bridge", async () => {
    const calls = [];
    const context = vm.createContext({
      exec: async code => {
        calls.push(code);
        const page = vm.createContext({
          window: { folia: { installUpdate() { calls.push("public-install"); } } },
        });
        return vm.runInContext(code, page);
      },
    });
    vm.runInContext(installSource + "\nglobalThis.start = startInstall;", context);
    await context.start();
    assert.deepEqual(calls, ["window.folia.installUpdate(); null;", "public-install"]);
  });
  await check("portable cleanup captures the actual lazy editor text without changing its older cache", async () => {
    const h = documents();
    const content = h.text + "LIVE\n";
    h.dirty(content);
    await h.actor.capturePortableDiscard(content, "owned portable live edit");
    const permission = h.actor.expectedDiscards.get(h.tab.id);
    assert.equal(permission.content, content);
    assert.equal(h.tab.content, h.text);
    assert.equal(h.tab.originalContent, h.text);
    await h.actor.retirePortableFixture();
    assert.equal(h.closes.length, 1);
    assert.deepEqual(h.closes[0].settings.tabIds, [1]);
    assert.deepEqual(h.closes[0].settings.expectedDiscards, [structuredClone(permission)]);
    assert.deepEqual(h.closes[0].settings.expectedTargets, [{
      tabId: 1, path: "fixture.md", owner: structuredClone(h.owner),
      descriptor: structuredClone(h.descriptor), disposition: "dirty-discard",
      liveContent: content, cacheContent: h.text, savedContent: h.text,
    }]);
    assert.ok(h.trace.indexOf("close-settled") < h.trace.indexOf("reset-main"));
  });
  await check("completed portable freezes re-register the retained version using the post-thaw Main selection", async () => {
    const h = documents();
    const content = h.text + "FOLDED\n";
    h.dirty(content, { lazy: false, frozen: true });
    await h.actor.capturePortableDiscard(content, "owned completed portable fixture");
    await h.actor.retirePortableFixture();
    assert.equal(h.registrations.length, 1);
    const request = h.registrations[0];
    assert.equal(request.owner.selectionGeneration, 10);
    assert.deepEqual(Object.keys(request.owner), [...h.fields, "selectionGeneration"]);
    assert.deepEqual(request.diskVersion, h.tab.diskVersion);
    assert.equal(request.modifiedTime, 100);
    assert.ok(h.trace.indexOf("register") < h.trace.indexOf("close-enter"));
  });
  await check("portable thaw preserves a live/cache split rather than folding or clearing it", async () => {
    const h = documents();
    const content = h.text + "LAZY\n";
    h.dirty(content, { frozen: true });
    await h.actor.capturePortableDiscard(content, "owned frozen lazy fixture");
    const gate = h.holdClose();
    const retiring = h.actor.retirePortableFixture();
    await h.closeEntered.promise;
    assert.equal(h.tab.content, h.text);
    assert.equal(h.context.markdownEditor.value, content);
    assert.equal(h.tab.originalContent, h.text);
    gate.resolve();
    await retiring;
  });
  for (const kind of ["unknown", "unresolved", "deleted"]) {
    await check("portable retirement refuses " + kind + " owners before reset", async () => {
      const h = documents();
      h.options.frozen = true;
      if (kind === "unknown") h.options.known = false;
      if (kind === "unresolved") h.options.unresolved = true;
      if (kind === "deleted") h.state.deletionTombstone = true;
      await assert.rejects(h.actor.retirePortableFixture(), /deleted or unresolved/);
      assert.equal(h.trace.includes("reset-main"), false);
      assert.equal(h.closes.length, 0);
    });
  }
  for (const kind of ["admission", "owner", "timestamp"]) {
    await check("portable retirement refuses stale " + kind + " evidence", async () => {
      const h = documents();
      if (kind === "admission") h.options.admitted = false;
      if (kind === "owner") h.options.mainCurrent = false;
      if (kind === "timestamp") h.tab.mtimeMs += 1;
      await assert.rejects(h.actor.retirePortableFixture(), /exact retained Main owner/);
      assert.equal(h.trace.includes("reset-main"), false);
      assert.equal(h.closes.length, 0);
    });
  }
  await check("a sent registration is not accepted as ordinary ownership without current deletion evidence", async () => {
    const h = documents();
    h.options.frozen = true;
    h.options.registrationAccepted = false;
    await assert.rejects(h.actor.retirePortableFixture(), /did not restore exact ordinary ownership/);
    assert.equal(h.registrations.length, 1);
    assert.equal(h.closes.length, 0);
  });
  await check("portable restoration refuses text drift during the genuine thaw", async () => {
    const h = documents();
    h.options.frozen = true;
    h.options.thawDrift = true;
    await assert.rejects(h.actor.retirePortableFixture(), /changed captured document buffers/);
    assert.equal(h.registrations.length, 0);
    assert.equal(h.closes.length, 0);
  });
  await check("portable ordinary permissions require the exact actual live text", async () => {
    const h = documents();
    h.dirty(h.text + "ACTUAL\n");
    await assert.rejects(h.actor.capturePortableDiscard(h.text + "OTHER\n", "fixture"), /exact captured/);
    assert.equal(h.actor.expectedDiscards.size, 0);
  });
  await check("portable replacement awaits the original r5 close before writing or admitting its next fixture", async () => {
    const h = documents();
    const gate = h.holdClose();
    const replacing = h.actor.replacePortableFixture();
    await h.closeEntered.promise;
    assert.equal(h.trace.some(item => Array.isArray(item)), false);
    assert.equal(h.trace.includes("reset-main"), false);
    gate.resolve();
    const admitted = await replacing;
    assert.equal(admitted.activePath, "fixture.md");
    assert.equal(admitted.activeId, 2);
    assert.ok(h.trace.indexOf("close-settled") <
      h.trace.findIndex(item => Array.isArray(item) && item[0] === "write"));
  });
  for (const kind of ["receipt", "Main retirement"]) {
    await check("portable callers reject premature " + kind + " evidence", async () => {
      const h = documents();
      h.options.malformedClose = kind === "receipt";
      h.options.retainMain = kind === "Main retirement";
      await assert.rejects(h.actor.retirePortableFixture(), /retained an owner|preceded visible or Main/);
      assert.equal(h.trace.includes("reset-main"), false);
      assert.equal(h.trace.some(item => Array.isArray(item)), false);
    });
  }
  await check("portable counter boundaries prepare one next candidate only after genuine admission settles", async () => {
    const h = documents();
    h.actor.setUpdater({
      async read() { return { canCheck: true }; },
      async prepare() { h.trace.push("prepare"); return "NEXT"; },
    });
    assert.equal(await h.actor.resetCounts(), "NEXT");
    assert.equal(h.trace.filter(item => item === "prepare").length, 1);
    assert.ok(h.trace.findIndex(item => Array.isArray(item) &&
      item[0] === "native-admission-port") < h.trace.indexOf("prepare"));
  });
  for (const [name, start, result] of [
    ["forged-marker", "    // The successful hand-off commits a real renderer freeze.", "portableForgedMarkerTab"],
    ["token-replay", "    // A TOKEN THAT IS THE SAME EVERY TIME IS NOT A SECRET,", "tokenReplayFixture"],
  ]) {
    await check("the actual " + name + " boundary retires its committed freeze before inspecting the next fixture", async () => {
      const h = documents();
      h.options.frozen = true;
      h.options.installing = true;
      h.options.lastRequestId = 10;
      h.actor.portableChildren.set(new EventEmitter(), {
        directory: "ack-batch", unrefRequestId: 9, closeReturned: false,
      });
      h.actor.setUpdater({
        async read() { return { status: "installing", canCheck: !h.options.installing }; },
        async prepare() { h.trace.push("prepare"); },
      });
      h.context.check = (label, ok) => assert.equal(ok, true, label);
      const boundary = between(actorSource, start, "\n    rig.answer = 1;");
      const inspected = await vm.runInContext("(async () => {\n" + boundary +
        "\nreturn " + result + ";\n})()", h.context);
      assert.equal(inspected.tabId, 2);
      assert.equal(h.options.frozen, false);
      assert.equal(h.registrations.length, 1);
      assert.equal(h.trace.filter(item => item === "prepare").length, 1);
      assert.ok(h.trace.indexOf("close-settled") < h.trace.indexOf("prepare"));
    });
  }
  for (const removeDirectory of [true, false]) {
    await check("original portable close " + (removeDirectory ? "joins cancellation before reset" : "cannot stand in for directory retirement"), async () => {
      const h = documents();
      const child = new EventEmitter();
      const record = { directory: "owned-batch", unrefRequestId: null, closeReturned: false };
      let exists = true, originalTimerLive = true;
      child.on("close", () => {
        h.trace.push("original-close");
        record.closeReturned = true;
        if (removeDirectory) {
          originalTimerLive = false;
          exists = false;
        }
      });
      h.actor.portableChildren.set(child, record);
      h.actor.portableDirectories.add(record.directory);
      h.context.fs.existsSync = () => exists;
      h.options.installing = true;
      h.actor.setUpdater({ async read() { return { canCheck: !h.options.installing }; } });
      child.on("close", () => { if (removeDirectory) h.options.installing = false; });
      if (removeDirectory) {
        await h.actor.retirePortableFixture();
        assert.equal(originalTimerLive, false);
        assert.ok(h.trace.indexOf("original-close") < h.trace.indexOf("reset-main"));
      } else {
        await assert.rejects(h.actor.retirePortableFixture(), /original child cancellation did not retire/);
        assert.equal(originalTimerLive, true);
        assert.equal(h.trace.includes("reset-main"), false);
        assert.equal(h.closes.length, 0);
      }
    });
  }
  for (const newerRequest of [false, true]) {
    await check("acknowledged portable cleanup " + (newerRequest ? "joins a stable post-ACK tail without treating its latch as work" : "requires the actual post-ACK request"), async () => {
      const h = documents();
      h.options.installing = true;
      h.actor.portableChildren.set(new EventEmitter(), {
        directory: "ack-batch", unrefRequestId: 9, closeReturned: false,
      });
      h.actor.setUpdater({ async read() {
        return { status: "installing", canCheck: !h.options.installing };
      } });
      if (newerRequest) {
        h.options.lastRequestId = 10;
        await h.actor.settlePortableOriginalWork();
        assert.equal(h.options.installing, true);
        assert.equal(h.actor.portableChildren.size, 0);
      } else {
        await assert.rejects(h.actor.settlePortableOriginalWork(), /original updater work did not settle/);
        assert.equal(h.actor.portableChildren.size, 1);
      }
      assert.equal(h.trace.includes("reset-main"), false);
    });
  }
  await check("post-release cancellation retires original callbacks without clearing its intentional session latch", async () => {
    const h = documents();
    const child = new EventEmitter();
    const record = { directory: "cancelled-after-release", unrefRequestId: null, closeReturned: false };
    let exists = true;
    child.on("close", () => { record.closeReturned = true; exists = false; });
    h.actor.portableChildren.set(child, record);
    h.actor.portableDirectories.add(record.directory);
    h.context.fs.existsSync = () => exists;
    h.options.installing = true;
    h.actor.setUpdater({ async read() {
      return { status: "error", canCheck: !h.options.installing };
    } });
    await h.actor.settlePortableOriginalWork();
    assert.equal(record.closeReturned, true);
    assert.equal(exists, false);
    assert.equal(h.options.installing, true);
    assert.equal(h.actor.portableChildren.size, 0);
    assert.equal(h.trace.includes("reset-main"), false);
  });
  await check("a new original child during the quiet drain invalidates the sampled retirement", async () => {
    const h = documents();
    h.options.installing = true;
    h.options.lastRequestId = 10;
    h.actor.portableChildren.set(new EventEmitter(), {
      directory: "older-ack", unrefRequestId: 9, closeReturned: false,
    });
    h.actor.setUpdater({ async read() { return { status: "installing", canCheck: false }; } });
    setImmediate(() => {
      h.actor.portableChildren.set(new EventEmitter(), {
        directory: "new-original", unrefRequestId: null, closeReturned: false,
      });
    });
    await assert.rejects(h.actor.settlePortableOriginalWork(), /original updater work did not settle/);
    assert.equal(h.actor.portableChildren.size, 2);
    assert.equal(h.trace.includes("reset-main"), false);
  });
  await check("quiet portable state is rechecked after the original queued continuation runs", async () => {
    const h = documents();
    setImmediate(() => { h.options.pendingId = 77; h.options.lastRequestId += 1; });
    await assert.rejects(h.actor.retirePortableFixture(), /original updater work did not settle/);
    assert.equal(h.trace.includes("reset-main"), false);
    assert.equal(h.closes.length, 0);
  });
  await check("portable retirement refuses an absorbed original shutdown replay", async () => {
    const h = documents();
    h.options.absorbedId = 4;
    h.options.replayScheduled = true;
    await assert.rejects(h.actor.retirePortableFixture(), /original updater work did not settle/);
    assert.equal(h.trace.includes("reset-main"), false);
  });
  await check("the actual portable surrogate records unref on the captured original child", async () => {
    const h = documents();
    h.context.portableBatchDir = file => path.dirname(file);
    h.context.replaceMethod = (target, key, implementation) => {
      target[key] = implementation;
      return () => { delete target[key]; };
    };
    const spawnObserver = between(actorSource, "    restoreSpawn = replaceMethod(",
      "\n    installPortableQuestions();");
    vm.runInContext(spawnObserver + "\nglobalThis.childPort = childProcess;", h.context);
    const first = h.context.childPort.spawn("cmd.exe", ["/c", "one/update.bat"], {});
    const second = h.context.childPort.spawn("cmd.exe", ["/c", "two/update.bat"], {});
    first.unref();
    assert.equal(first.unrefCalls, 1);
    assert.equal(second.unrefCalls, 0);
    assert.equal(h.actor.portableChildren.get(first).unrefRequestId, 9);
    assert.equal(h.actor.portableChildren.get(second).unrefRequestId, null);
  });
  await check("portable retirement refuses a replacement owner arriving during original-work settlement", async () => {
    const h = documents();
    h.useRealCloser();
    const before = await h.actor.readPortableDocuments();
    h.options.replaceDuringSettlement = true;
    const failure = await h.actor.retirePortableFixture().then(() => null, error => error);
    assert.equal(h.trace.filter(item => item === "replace-owner").length, 1,
      "the replacement really occurred inside the settlement await");
    assert.notEqual(h.owner.documentRef, before.tabs[0].owner.documentRef);
    assert.equal(h.closes.length, 0, "the actual selected closer must not close the replacement owner");
    assert.equal(h.tabs.length, 1);
    assert.equal(h.trace.includes("reset-main"), false);
    assert.ok(failure, "the captured-owner mismatch must refuse cleanup");
  });
  await check("the selected captured-target closer retires an unchanged portable owner", async () => {
    const h = documents();
    h.useRealCloser();
    await h.actor.retirePortableFixture();
    assert.equal(h.closes.length, 1, "the actual selected source called the simulated closeTab");
    assert.equal(h.tabs.length, 0);
    assert.equal(h.context.__shutdown.documentSessionState().owners.length, 0);
  });
  for (const boundary of ["plan", "close"]) {
    await check("portable captured ownership survives the actual selected " + boundary + " dispatch gap", async () => {
      const h = documents();
      h.useRealCloser();
      h.scheduleReplacement(boundary === "plan" ? 2 : 3);
      await assert.rejects(h.actor.retirePortableFixture(), error =>
        /Captured fixture target changed|Fixture close has no ordinary authenticated owner/.test(messages(error)));
      assert.equal(h.trace.filter(item => item === "replace-owner").length, 1,
        "the simulated renderer reached the scheduled dispatch turn");
      assert.equal(h.closes.length, 0);
      assert.equal(h.tabs.length, 1);
      assert.equal(h.trace.includes("reset-main"), false);
    });
  }
  await check("portable final reset refuses a new unclaimed Main owner after its captured owner retires", async () => {
    const h = documents();
    h.options.foreignAfterClose = true;
    await assert.rejects(h.actor.retirePortableFixture(), /Main owner retirement/);
    assert.equal(h.closes.length, 1, "only the captured original owner was closed");
    assert.equal(h.trace.includes("reset-main"), false);
    assert.equal(h.context.__shutdown.documentSessionState().owners[0].documentRef, "FOREIGN-CLOSE");
    assert.deepEqual(h.foreignEvidence.get("FOREIGN-CLOSE"),
      { baseline: "CLOSE", deletionRevision: 17 });
  });
  await check("portable final reset rechecks unclaimed Main evidence after layout settlement", async () => {
    const h = documents();
    h.options.foreignDuringLayout = true;
    await assert.rejects(h.actor.retirePortableFixture(), /Main owner authority changed/);
    assert.equal(h.trace.includes("foreign-owner:LAYOUT"), true);
    assert.equal(h.closes.length, 1);
    assert.equal(h.trace.includes("reset-main"), false);
    assert.deepEqual(h.foreignEvidence.get("FOREIGN-LAYOUT"),
      { baseline: "LAYOUT", deletionRevision: 17 });
  });
  for (const kind of ["replacement", "extra owner"]) {
    await check("portable frozen reset preserves a " + kind + " arriving during original settlement", async () => {
      const h = documents();
      h.useRealCloser();
      h.options.frozen = true;
      h.options.replaceDuringSettlement = kind === "replacement";
      h.options.foreignDuringSettlement = kind === "extra owner";
      await assert.rejects(h.actor.retirePortableFixture(), /Main owner authority changed/);
      assert.equal(h.trace.includes(kind === "replacement"
        ? "replace-owner" : "foreign-owner:SETTLEMENT"), true);
      assert.equal(h.trace.includes("reset-main"), false);
      assert.equal(h.options.known, true);
      assert.equal(h.options.frozen, true);
      assert.equal(h.closes.length, 0);
      assert.equal(h.tabs.length, 1);
      if (kind === "extra owner") assert.deepEqual(h.foreignEvidence.get("FOREIGN-SETTLEMENT"),
        { baseline: "SETTLEMENT", deletionRevision: 17 });
    });
  }
  for (const kind of ["missing state", "missing tab", "malformed state", "malformed tab",
    "state-only dirty", "tab-only dirty"]) {
    await check("portable captures refuse " + kind + " flags without inventing a clean disposition", async () => {
      const h = documents();
      h.options.frozen = true;
      if (kind === "missing state") delete h.state.dirty;
      if (kind === "missing tab") delete h.tab.hasUnsavedChanges;
      if (kind === "malformed state") h.state.dirty = "false";
      if (kind === "malformed tab") h.tab.hasUnsavedChanges = 0;
      if (kind === "state-only dirty") h.state.dirty = true;
      if (kind === "tab-only dirty") h.tab.hasUnsavedChanges = true;
      await assert.rejects(h.actor.retirePortableFixture(), /exact disposition or text/);
      assert.equal(h.closes.length, 0);
      assert.equal(h.trace.includes("reset-main"), false);
    });
  }
  for (const kind of ["live", "cache", "saved"]) {
    await check("portable " + kind + " captures refuse missing text instead of coercing it", async () => {
      const h = documents();
      if (kind === "live") h.context.window.originalMarkdown = null;
      if (kind === "cache") h.tab.content = null;
      if (kind === "saved") h.tab.originalContent = null;
      await assert.rejects(h.actor.retirePortableFixture(), /exact disposition or text/);
      assert.equal(h.closes.length, 0);
      assert.equal(h.trace.includes("reset-main"), false);
    });
  }
  await check("portable discard consent stays captured across original-work settlement", async () => {
    const h = documents();
    const content = h.text + "ORIGINAL\n";
    h.dirty(content);
    await h.actor.capturePortableDiscard(content, "original permission");
    h.options.mutatePermissionDuringSettlement = h.actor.expectedDiscards.get(1);
    await h.actor.retirePortableFixture();
    assert.equal(h.trace.includes("mutate-permission"), true);
    const permission = h.closes[0].settings.expectedDiscards[0];
    assert.equal(permission.content, content);
    assert.equal(permission.owner.documentRef, "REF");
  });
  await check("the complete actor finally reuses failed retirement instead of adopting its replacement", async () => {
    const h = automatic({ initialOwner: "owned" });
    h.useRealCloser();
    h.options.replaceDuringSettlement = true;
    try {
      await assert.rejects(h.run(), error => /Main owner authority changed/.test(messages(error)));
      assert.equal(h.trace.filter(item => item === "replace-owner").length, 1);
      assert.equal(h.trace.filter(item => item === "read-tabs").length, 1,
        "finally must not capture the replacement through a second retirement");
      assert.equal(h.closes.length, 0);
      assert.equal(h.tabs.length, 1);
      assert.equal(h.trace.includes("reset-main"), false);
      assert.equal(h.trace.includes("restore-rig"), false);
      assert.equal(Object.hasOwn(h.app, "isPackaged"), true);
    } finally {
      h.fixture.restore();
      h.cleanup();
    }
  });
  for (const initialOwner of ["unknown", "unresolved", "deleted", "foreign", "orphan"]) {
    await check("the complete actor refuses an initial " + initialOwner + " owner without resetting its Main evidence", async () => {
      const h = automatic({ initialOwner });
      try {
        await assert.rejects(h.run(), error => (initialOwner === "foreign"
          ? /no exact retained Main owner/ : initialOwner === "orphan"
            ? /unowned Main document owner/ : /deleted or unresolved owner/).test(messages(error)));
        assert.equal(h.trace.includes("reset-main"), false);
        assert.equal(h.trace.includes("public-check"), false);
        assert.equal(h.trace.includes("public-download"), false);
        assert.equal(h.trace.includes("contained-native-boundary"), false);
        assert.equal(h.closes.length, 0);
        assert.equal(h.tabs.length, initialOwner === "orphan" ? 0 : 1);
        assert.equal(h.options.selection, 9);
        h.assertRestored();
      } finally { h.cleanup(); }
    });
  }
  await check("the actual automatic portable caller uses one selected fixture and real Check/Download before the native boundary", async () => {
    const h = automatic();
    try {
      await assert.rejects(h.run(), error => /PORTABLE_CONTROL_BOUNDARY/.test(messages(error)));
      assert.equal(h.creates, 1);
      assert.equal(h.trace.filter(item => item === "public-check").length, 1);
      assert.equal(h.trace.filter(item => item === "public-download").length, 1);
      assert.ok(h.trace.indexOf("public-check") < h.trace.indexOf("public-download"));
      assert.ok(h.trace.indexOf("public-download") < h.trace.indexOf("contained-native-boundary"));
      const readyCheck = h.trace.find(item => Array.isArray(item) &&
        item[0] === "actor-check" && item[1].includes("regular-file fixture"));
      assert.equal(readyCheck?.[2], true);
      assert.equal(h.controller.snapshot().availableVersion, "12.4.10");
      h.assertRestored();
      assert.equal(fs.existsSync(path.join(h.root, "portable-update")), false);
    } finally { h.cleanup(); }
  });
  await check("portable callers retain providers, metadata and the regular artifact while an original-work port remains unsettled", async () => {
    const h = automatic({ pendingTail: true });
    try {
      await assert.rejects(h.run(), error =>
        /PORTABLE_CONTROL_BOUNDARY/.test(messages(error)) &&
        /original updater work did not settle/.test(messages(error)));
      assert.equal(h.creates, 1);
      assert.equal(h.trace.includes("restore-checkForUpdates"), false);
      assert.equal(h.trace.includes("restore-downloadUpdate"), false);
      assert.equal(h.trace.includes("restore-rig"), false);
      assert.equal(h.app.isPackaged, true);
      const artifact = h.updater.downloadedUpdateHelper.file;
      assert.equal(fs.statSync(artifact).isFile(), true);
    } finally { h.cleanup(); }
  });
  await check("portable question captures the original registered consumer and synchronous answer plan", async () => {
    const h = questionHarness();
    let calls = 0;
    let receiver;
    let options;
    h.actor.rig.answer = function (value) {
      calls += 1;
      receiver = this;
      options = value;
      return 1;
    };
    const q = h.publish();
    const entry = h.actor.state().entries[0];
    assert.equal(entry.consumer, null, "synchronous onRecord cannot see later registration");
    assert.equal(h.lookups.length, 0);
    h.actor.rig.answer = () => { throw new Error("Replacement answer must not run"); };
    await entry.captureWork;
    assert.equal(entry.consumer, q.consumer);
    assert.notEqual(q.record.requestId, q.record.brokerId);
    assert.deepEqual(h.lookups, [{ id: q.record.requestId, signal: q.record.options.signal }]);
    assert.equal(calls, 0, "answer waits for actual presentation");
    q.display();
    await h.actor.joinPortableChoice(0, "update-install", 1);
    assert.equal(calls, 1);
    assert.equal(receiver, h.actor.rig);
    assert.equal(options, q.record.options);
    assert.deepEqual(q.record.choices, [1]);
    await h.actor.joinPortableQuestions();
    h.actor.restorePortableQuestionRig();
  });
  await check("portable question refuses missing or mismatched original consumer registration", async () => {
    for (const registration of ["absent", "wrong-id", "wrong-signal"]) {
      const h = questionHarness();
      const q = h.publish({ registration });
      q.cancelBeforeDisplay();
      await assert.rejects(h.actor.joinPortableQuestions(), error =>
        /no exact original Main consumer/.test(messages(error)));
      assert.deepEqual(q.record.choices, []);
      assert.equal(h.actor.state().offset, 0);
      assert.equal(h.trace.includes("reset-rig"), false);
    }
  });
  await check("portable choices require displayed genuine results, including response zero", async () => {
    const absent = questionHarness();
    const lost = absent.publish();
    lost.cancelBeforeDisplay();
    await absent.actor.joinPortableQuestions();
    assert.equal(absent.actor.portableDialogs().length, 0);
    assert.equal(absent.actor.portableScenarioQuestions().length, 1);
    await assert.rejects(absent.actor.joinPortableChoice(0, "update-install", 1),
      /did not display/);
    await assert.rejects(absent.actor.resetPortableQuestionCounters(), /undisplayed/);
    assert.deepEqual(lost.record.choices, []);
    const h = questionHarness();
    h.actor.rig.answer = 0;
    const q = h.publish();
    q.display();
    await h.actor.joinPortableChoice(0, "update-install", 0);
    assert.deepEqual(q.record.choices, [0]);
    await assert.rejects(h.actor.joinPortableChoice(0, "window-close", 0), /expected genuine choice/);
    q.record.result = { cause: "aborted", response: 0 };
    await assert.rejects(h.actor.joinPortableChoice(0, "update-install", 0), /expected genuine choice/);
  });
  await check("portable bookkeeping independently joins producer, callback and original consumer", async () => {
    for (const held of ["consumer", "producer"]) {
      const h = questionHarness();
      const q = h.publish({ consumeOnChoose: held !== "consumer",
        finishOnChoose: held !== "producer" });
      q.display();
      const entry = h.actor.state().entries[0];
      await entry.callbackWork;
      if (held === "consumer") await q.record.joined;
      else await entry.consumerWork;
      let reset = false;
      const pending = h.actor.resetPortableQuestionCounters().then(() => { reset = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reset, false);
      assert.equal(h.trace.includes("reset-rig"), false);
      assert.throws(() => h.actor.restorePortableQuestionRig(), /unresolved|unfinished/);
      q.producer.resolve({ cause: "choice", response: 1 });
      q.drive.resolve();
      q.consumed.resolve();
      await pending;
      assert.equal(reset, true);
      assert.equal(h.actor.state().offset, 1);
      assert.equal(h.actor.state().entries[0].consumer, q.consumer);
      h.actor.restorePortableQuestionRig();
    }
  });
  await check("a cancelled portable question retains its started answer without choosing a successor", async () => {
    const h = questionHarness();
    const hold = h.actor.holdPortableAnswer();
    const entered = deferred();
    h.actor.rig.answer = () => { entered.resolve(); return hold.promise; };
    const old = h.publish({ finishOnChoose: false, consumeOnChoose: false });
    old.display();
    await entered.promise;
    old.producer.resolve({ cause: "aborted", response: 1 });
    old.drive.resolve();
    old.consumed.resolve();
    await old.record.joined;
    h.actor.rig.answer = 0;
    const next = h.publish();
    next.display();
    await h.actor.joinPortableChoice(1, "update-install", 0);
    let joined = false;
    const pending = h.actor.joinPortableQuestions().then(() => { joined = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(joined, false);
    assert.equal(h.actor.state().entries[0].legacyReturn, hold.promise);
    hold.release(1);
    await pending;
    assert.deepEqual(old.record.choices, []);
    assert.deepEqual(next.record.choices, [0]);
    assert.equal(h.actor.state().entries[0].consumer, old.consumer);
    assert.equal(h.actor.state().entries[1].consumer, next.consumer);
    assert.throws(() => hold.release(1), /one valid release/);
  });
  await check("portable partial ledger joins synchronous reroutes and retains historical entries", async () => {
    const h = questionHarness();
    let next;
    const first = h.publish({ consumerTail() {
      h.actor.rig.answer = 0;
      next = h.publish();
      next.display();
    } });
    first.display();
    await h.actor.joinPortableQuestions();
    assert.equal(h.records.length, 2);
    assert.deepEqual(first.record.choices, [1]);
    assert.deepEqual(next.record.choices, [0]);
    await h.actor.joinPortableChoice(1, "update-install", 0);
    await h.actor.resetPortableQuestionCounters();
    assert.equal(h.actor.portableScenarioQuestions().length, 0);
    assert.equal(h.actor.state().entries.length, 2);
    assert.equal(h.actor.state().entries[0].consumer, first.consumer);
    const laterWork = deferred();
    let laterFinished = false;
    laterWork.promise.then(() => { laterFinished = true; });
    const third = h.publish();
    third.display();
    await h.actor.joinPortableChoice(0, "update-install", 1);
    await h.actor.joinPortableQuestions();
    assert.equal(laterFinished, false, "partial joining supplies no later-work completion");
    laterWork.resolve();
  });
  await check("portable question preserves independent errors and rejects caught native fallback", async () => {
    const h = questionHarness();
    const entered = deferred();
    h.actor.rig.answer = () => { entered.resolve(); throw new Error("CALLBACK_FAILURE"); };
    const q = h.publish({ finishOnChoose: false, consumeOnChoose: false });
    q.display();
    await entered.promise;
    q.producer.reject(new Error("PRODUCER_FAILURE"));
    q.drive.reject(new Error("DRIVER_FAILURE"));
    q.consumed.reject(new Error("CONSUMER_FAILURE"));
    await assert.rejects(h.actor.joinPortableQuestions(), error =>
      ["CALLBACK_FAILURE", "PRODUCER_FAILURE", "DRIVER_FAILURE", "CONSUMER_FAILURE"]
        .every(message => messages(error).includes(message)));
    await assert.rejects(h.actor.resetPortableQuestionCounters());
    assert.equal(h.actor.state().offset, 0);
    assert.equal(h.trace.includes("reset-rig"), false);
    const native = questionHarness();
    let answers = 0;
    native.actor.rig.answer = () => { answers += 1; return 0; };
    await assert.rejects(native.dialog.showMessageBox(native.win, { title: "UNEXPECTED" }),
      /Unexpected native portable question/);
    await assert.rejects(native.actor.joinPortableQuestions(), error =>
      /Unexpected native portable question/.test(messages(error)));
    assert.equal(answers, 0);
    assert.equal(native.actor.portableScenarioQuestions().length, 0);
    assert.equal(native.actor.state().nativeFailures.length, 1);
  });
  await check("portable restoration checks exact borrowed ownership and cannot restore unfinished work", async () => {
    const h = questionHarness();
    const q = h.publish({ consumeOnChoose: false });
    q.display();
    await q.work;
    await q.record.joined;
    assert.throws(() => h.actor.restorePortableQuestionRig(), /unresolved/);
    q.consumed.resolve();
    await h.actor.joinPortableQuestions();
    for (const [target, name] of [[h.app, "quit"], [h.win, "close"], [h.dialog, "showMessageBox"]]) {
      const owned = Object.getOwnPropertyDescriptor(target, name);
      const foreign = () => { throw new Error("FOREIGN_OWNER"); };
      Object.defineProperty(target, name, { ...owned, value: foreign });
      assert.throws(() => h.actor.restorePortableQuestionRig(), /ownership is unresolved/);
      assert.equal(target[name], foreign);
      assert.equal(h.trace.includes("restore-driver"), false);
      Object.defineProperty(target, name, owned);
    }
    h.actor.restorePortableQuestionRig();
    assert.equal(h.app.quit, h.originals.quit);
    assert.equal(h.win.close, h.originals.close);
    assert.equal(h.dialog.showMessageBox, h.originals.native);
    assert.throws(() => h.actor.restorePortableQuestionRig(), /unresolved|repeated/);
  });
  console.log(`=== ${passed}/${passed} portable source/VM controls passed ===`);
}

const watchdog = setTimeout(() => {
  console.error("Portable source/VM control body did not settle");
  process.exit(1);
}, 15000);
main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => clearTimeout(watchdog));
