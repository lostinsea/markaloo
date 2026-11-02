"use strict";

// Node-only source/VM controls. Actual producer functions are extracted as
// text; no Electron module, native window or physical Save is executed.
// Input and mutation use actual producer code. Save/switch completion is
// simulated to test actor preconditions and oracles, not the production fold.
// The ordinary integration actors check the real fold; their native run is
// separate and remains required.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const artifact = path.join(__dirname, "test-tab-refresh.js");
const source = fs.readFileSync(artifact, "utf8").replace(/\r\n/g, "\n");
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 2 && args[0] === "--producer-root",
  "Use no arguments in the repository, or --producer-root <exact-source-snapshot>");
const producerRoot = args.length ? path.resolve(args[1]) : path.resolve(__dirname, "..", "src");
const renderer = fs.readFileSync(path.join(producerRoot, "renderer.js"), "utf8").replace(/\r\n/g, "\n");
const customTabs = fs.readFileSync(path.join(producerRoot, "custom-tabs.js"), "utf8").replace(/\r\n/g, "\n");
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, "Missing start: " + start);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, "Missing end: " + end);
  return text.slice(from, to);
};
const clone = value => JSON.parse(JSON.stringify(value));
const identityFields = ["pageSession", "rendererGeneration", "tabId",
  "documentGeneration", "pathKey", "documentRef"];
const helperStart = "  let scenario8bDiscardPermission = null;";
const observerStart = "  await exec(`\n    let __defaultSaveQuestionInstallation = (() => {";
const helpers = between(source, helperStart, observerStart);
const scenario7 = "  // ---- Scenario 7: exiting edit mode";
const errors = "  const errors = await exec(`window.__e2eErrors || []`);";
const saveStart = "  // ---- Scenario 6: saving in view mode";
const slice = between(source, saveStart, errors);
const actors = between(source, scenario7, errors);

function sourceContracts() {
  new vm.Script(source, { filename: artifact });
  check(true, "Complete authored artifact parses without executing it");
  check(!/window\.(?:fs|ipcRenderer)|require\s*\(|window\.(?:confirm|alert)\s*=/.test(slice),
    "Save actors do not invent page privileges or intercept retired dialogs");
  check(!/window\.originalMarkdown\s*=(?!=)|updateTabContent\s*\(|setUnsavedState\s*\(/.test(actors),
    "No fictional saved document or fake clean transition in Save7 onward");
  check(!/captureDialogContext\s*\(/.test(helpers), "Consent observer does not invalidate real consent");
  check(!actors.includes("S9E_STALE") && !actors.includes("resetApplied"),
    "Obsolete fabricated reload/reset setup is gone");
  check(source.includes("await openDefaultFixture(\n    fileB, fs.readFileSync(fileB"),
    "New Beta is admitted through the original chooser/Main path");
  const savedHistory = actors.indexOf(
    'await saveDefaultSaveDocument(fileA, "# Alpha\\n\\nS7_OLD_UNDO_POINT\\n")');
  const betaAdmission = actors.indexOf("const tabBAdmission");
  check(savedHistory >= 0 && betaAdmission >= 0 && savedHistory < betaAdmission,
  "Older-history Undo is genuinely saved before Beta admission");
  check(actors.includes('await editDefaultSaveDocument("# Beta\\n\\nS8B_ON_B\\n", "S8B_ON_B")') &&
    actors.includes("secondTabArrival.editMode === false"),
  "Beta's own closed editor is explicitly opened before typing");
  check(actors.includes("scenario8bDiscardPermission = {") &&
    actors.includes('content: "# Alpha\\n\\nS8B_ON_A\\n"') &&
    actors.includes("owner: s8bDirtyA.owner"),
  "Exactly the retained Alpha edit has a named future-close permission");
  check(actors.includes("const bgVersionFields = [\"dev\", \"ino\", \"size\", \"mtimeMs\", \"ctimeMs\"]") &&
    actors.includes("bgVersion.tabVersion?.[field] === bgVersion.before[field]") &&
    actors.includes("bgPreSaveDocument.tab.diskVersion?.[field] === bgPreSaveBefore[field]"),
  "Both physical disk-version checks retain all exact original fields");
  check(/const scenario9dSucceeded =[\s\S]+?two\.editMode === true[\s\S]+?two\.dirty === false;/
    .test(actors) && actors.includes("if (scenario9dSucceeded) {") &&
    actors.includes("const reloadCompletion = await reloadSelectedAndWait("),
  "Open-editor Reload remains gated on the successful real two-Save actor");
  for (const expression of [
    "saveQueueEnqueuedCount === saveQueueBefore.saveQueueEnqueuedCount + 2",
    "saveQueueStartedCount === saveQueueBefore.saveQueueStartedCount + 2",
    "saveQueueCompletedCount === saveQueueBefore.saveQueueCompletedCount + 2",
    "saveQueuePendingCount === 0", "saveQueueActivePathCount === 0",
    "saveQueueOverlapCount === saveQueueBefore.saveQueueOverlapCount",
    "saveQueueMaxActiveForSinglePath === 1",
    "const firstResultReleaseDeadlineMs = 3000;",
    "const firstSettlement = await waitForBgSettlement(1200);",
    "}, 6500);", "const exitDeadline = exitStartedAt + 6000;",
    "completionTimer = setTimeout(() => resolve(false), 8000);",
  ]) check(actors.includes(expression), "Retained queue/deadline contract: " + expression);
}

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const defaultAdmissionSource = between(source, "  const defaultMainOwns = async (snapshot) => {",
  "  const defaultSaveFixtureBody = ");
const defaultAdmissionCaller = between(source, "  const defaultSaveFixtureBody = ",
  "  const undoSave = await exec(");
const longDocSource = between(source, "  const longDoc = (marker) =>",
  '\n\n  write(fileA, longDoc("V1"));');
const longDoc = vm.compileFunction(longDocSource + "\nreturn longDoc;")();

function defaultAdmissionFixture(options = {}) {
  const fixture = pageFixture(), { page, control, context } = fixture;
  const body = options.body ?? longDoc("SPLIT");
  if (options.deletionState) control.query = options.deletionState;
  Object.assign(control.tab, { content: body, originalContent: body, hasUnsavedChanges: false });
  page.originalMarkdown = page.markdownEditor.value = body;
  page.viewer.textContent = body;
  page.hasUnsavedWorkForReload = () => false;
  const getElement = page.document.getElementById;
  page.document.getElementById = id => id === "viewer" ? page.viewer : getElement(id);
  control.pending.count = 0;
  const processor = deferred(), render = deferred();
  const trace = [], setup = [];
  let reads = 0, snapshotReads = 0, currentCalls = 0, ownerReads = 0, deletionReads = 0;
  let observation;
  const win = {}, chooserOptions = { properties: ["openFile"] };
  const dialog = { showOpenDialog() { throw new Error("Unintercepted chooser"); } };
  const originalChooser = Object.getOwnPropertyDescriptor(dialog, "showOpenDialog");
  page.folia.queryDocumentDeletionState = () => { deletionReads++; return control.query; };
  page.CustomTabs.settleSessionLayout = async () => { trace.push("layout"); };
  page.folia.getVersion = async () => { trace.push("Main flush"); };
  page.folia.openFileDialog = async () => {
    trace.push("chooser");
    const choice = await dialog.showOpenDialog(win, chooserOptions);
    assert.deepEqual(Array.from(choice.filePaths), [control.tab.filePath]);
    const record = { packet: { path: control.tab.filePath }, eventUndefined: true,
      phase: observation.phase, settled: false };
    record.promise = processor.promise.then(() => {
      record.settled = true;
      const painted = { prefix: body.slice(0, 24), phase: observation.phase, settled: false };
      painted.promise = render.promise.then(() => { painted.settled = true; });
      observation.renders.push(painted);
      return true;
    });
    observation.processors.push(record);
  };
  const host = {
    win, dialog, expectedChooserOptions: chooserOptions,
    isDeepStrictEqual: require("node:util").isDeepStrictEqual,
    __shutdown: {
      documentAdmissionIsCurrent: () => { currentCalls++; return options.current !== false; },
      documentSessionState: () => {
        ownerReads++;
        const owner = { ...control.owner, readTarget: control.descriptor.readTarget };
        if (options.wrongMainOwner) owner.documentGeneration++;
        return { owners: [owner] };
      },
    },
    exec: async script => {
      if (script.includes("const tab = window.CustomTabs.getActiveTab();")) {
        snapshotReads++;
        options.beforeSnapshot?.(fixture);
      }
      const value = await vm.runInContext(script, context, { timeout: 1000 });
      return value === undefined ? undefined : clone(value);
    },
    installDialogBatchPageObservation: async () => {
      observation = { processors: [], renders: [], phase: "" };
      page.__dialogBatchNative = observation;
      trace.push("install");
    },
    restoreDialogBatchPageObservation: async () => {
      trace.push("restore observation");
      await Promise.allSettled([...observation.processors, ...observation.renders]
        .map(record => record.promise));
      assert.equal(page.__dialogBatchNative, observation);
      delete page.__dialogBatchNative;
      if (options.observationError) throw options.observationError;
      return true;
    },
    replaceMethod: (object, key, replacement) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      Object.defineProperty(object, key, { ...descriptor, value: replacement });
      return () => {
        trace.push("restore chooser");
        Object.defineProperty(object, key, descriptor);
        if (options.chooserError) throw options.chooserError;
      };
    },
    waitUntil: async (predicate, budget) => { assert.equal(budget, 8000); return predicate(); },
    boundedDialogWork: (work, label, budget) => {
      assert.equal(label, "default-fixture original processor and rendering");
      assert.equal(budget, 8000);
      trace.push("join");
      return work;
    },
    fs: { readFileSync: (file, encoding) => {
      assert.equal(file, control.tab.filePath);
      assert.equal(encoding, "utf8");
      reads++;
      return body;
    } },
    fileA: control.tab.filePath, longDoc,
    check: (name, condition) => setup.push({ name, condition }),
  };
  const api = vm.runInNewContext(`(() => {
    ${defaultAdmissionSource}
    return { openDefaultFixture, caller: async () => {
      ${defaultAdmissionCaller}
      return { tabCAdmission, tabC };
    } };
  })()`, host, { timeout: 1000 });
  const start = (caller = false, marker = "SPLIT body 0") => {
    let settled = false;
    const work = caller ? api.caller() : api.openDefaultFixture(control.tab.filePath, body, marker);
    const outcome = work.then(value => { settled = true; return { value }; },
      error => { settled = true; return { error }; });
    return { outcome, settled: () => settled };
  };
  const finish = async work => {
    await turn();
    processor.resolve();
    await turn();
    const renderHeld = !work.settled() && snapshotReads === 0 &&
      observation.renders.length === 1 && observation.renders[0].settled === false;
    if (options.renderError) render.reject(options.renderError);
    else render.resolve();
    const result = await work.outcome;
    check(renderHeld, "Actual default admission joins its original unfinished render before reading ownership");
    return result;
  };
  const restored = () => {
    const descriptor = Object.getOwnPropertyDescriptor(dialog, "showOpenDialog");
    return !Object.hasOwn(page, "__dialogBatchNative") &&
      Reflect.ownKeys(originalChooser).every(key => descriptor[key] === originalChooser[key]) &&
      trace.filter(step => step === "restore chooser").length === 1 &&
      trace.filter(step => step === "restore observation").length === 1;
  };
  return { fixture, body, trace, setup, start, finish, restored,
    counts: () => ({ reads, snapshotReads, currentCalls, ownerReads, deletionReads }) };
}

async function defaultFixtureCallerContracts() {
  const fixture = defaultAdmissionFixture(), work = fixture.start(true);
  await turn();
  check(!work.settled() && fixture.counts().snapshotReads === 0 &&
    fixture.trace.includes("join") && !fixture.trace.includes("layout"),
  "Actual default admission waits for the original processor before reading its owner");
  const result = await fixture.finish(work);
  check(!result.error, "Actual default Save caller completes with its original clean SPLIT body and marker");
  check(fixture.counts().reads === 1 && fixture.setup.length === 1 &&
    fixture.setup[0].condition === true && fixture.body === longDoc("SPLIT") &&
    fixture.body.includes("SPLIT body 0") && !fixture.body.includes("Alpha") &&
    result.value.tabC === fixture.fixture.control.tab.id &&
    fixture.counts().currentCalls === 1 && fixture.counts().ownerReads === 1 &&
    fixture.counts().deletionReads === 1 && fixture.restored(),
  "Actual default Save caller admits its exact once-read SPLIT body through the genuine helper");
  const wrong = defaultAdmissionFixture({ body: "# Alpha\n\nstale disk body\n" });
  const failed = await wrong.finish(wrong.start(true));
  check(failed.error?.name === "AggregateError" && wrong.setup[0].condition === false &&
    wrong.counts().reads === 1 && wrong.counts().currentCalls === 0 && wrong.restored(),
  "Actual caller rejects the wrong disk setup rather than rewriting the fixture or hiding the check");
}

async function defaultFixtureOwnerContracts() {
  for (const [label, beforeSnapshot] of [
    ["source", ({ page }) => { page.originalMarkdown = "WRONG SOURCE"; }],
    ["cached source", ({ control }) => { control.tab.content = "WRONG CACHE"; }],
    ["original source", ({ control }) => { control.tab.originalContent = "WRONG BASELINE"; }],
    ["owner", ({ control }) => { control.owner.tabId++; }],
    ["reference", ({ control }) => { control.owner.documentRef = "FOREIGN"; }],
    ["pending save", ({ control }) => { control.pending.count = 1; }],
    ["dirty state", ({ control }) => { control.tab.hasUnsavedChanges = true; }],
  ]) {
    const fixture = defaultAdmissionFixture({ beforeSnapshot });
    const result = await fixture.finish(fixture.start());
    check(result.error?.name === "AggregateError" && fixture.counts().currentCalls === 0 &&
      fixture.counts().deletionReads === 0 && fixture.restored(),
    "Actual admission rejects " + label + " without evaluating short-circuited Main predicates");
  }
  for (const [options, ownerReads, deletionReads] of [
    [{ current: false }, 0, 0],
    [{ wrongMainOwner: true }, 1, 0],
    [{ deletionState: { known: false, unresolved: false } }, 1, 1],
    [{ deletionState: { known: true, unresolved: true } }, 1, 1],
  ]) {
    const fixture = defaultAdmissionFixture(options);
    const result = await fixture.finish(fixture.start());
    check(result.error?.name === "AggregateError" && fixture.counts().currentCalls === 1 &&
      fixture.counts().ownerReads === ownerReads &&
      fixture.counts().deletionReads === deletionReads && fixture.restored(),
    "Actual admission rejects noncurrent, foreign, unknown or unresolved Main ownership without extra queries");
  }
}

async function defaultFixtureDiagnosticsContracts() {
  const stale = defaultAdmissionFixture();
  const rejected = await stale.finish(stale.start(false, "Alpha"));
  const prefix = "Default fixture admission failed: ";
  check(rejected.error?.name === "AggregateError" && rejected.error.message.startsWith(prefix),
    "Actual default admission retains inspectable failure-only diagnostic evidence");
  const detail = JSON.parse(rejected.error.message.slice(prefix.length));
  check(detail.captured.sourceMatches === true && detail.captured.markerPresent === false &&
    detail.localOwner === false && detail.mainOwner === "unobserved" &&
    stale.counts().currentCalls === 0 && stale.counts().deletionReads === 0 && stale.restored(),
  "Actual failure evidence distinguishes a stale Alpha marker without retrying Main predicates");
  const operation = new RangeError("original render sentinel");
  const chooser = new Error("original chooser cleanup sentinel");
  const observation = new TypeError("original observation cleanup sentinel");
  const failed = defaultAdmissionFixture({
    renderError: operation, chooserError: chooser, observationError: observation,
  });
  const result = await failed.finish(failed.start());
  const diagnostic = JSON.parse(result.error.message.slice(prefix.length));
  const expected = [operation, chooser, observation];
  check(result.error.errors.length === expected.length &&
    expected.every((error, index) => result.error.errors[index] === error &&
      diagnostic.failures[index].name === error.name &&
      diagnostic.failures[index].message === error.message &&
      diagnostic.failures[index].stack === error.stack) &&
    diagnostic.failures[0].phase === "joining original processor and render" &&
    diagnostic.failures[1].phase === "restoring chooser" &&
    diagnostic.failures[2].phase === "restoring page observation" &&
    diagnostic.captured === "unobserved" && diagnostic.mainOwner === "unobserved" &&
    failed.counts().snapshotReads === 0 && failed.counts().currentCalls === 0 && failed.restored(),
  "Actual aggregate retains original operation and independent cleanup errors in the outer stack");
  check(expected.every(error => result.error.stack.includes(error.message)),
    "The existing outer stack printer can see each original operation and cleanup failure");
  const malformed = defaultAdmissionFixture({
    beforeSnapshot: ({ page }) => { page.viewer.textContent = null; },
  });
  const malformedResult = await malformed.finish(malformed.start());
  const malformedDetail = JSON.parse(malformedResult.error.message.slice(prefix.length));
  check(malformedResult.error.errors[0].name === "TypeError" &&
    malformedDetail.captured.markerPresent === "unobserved" &&
    malformedDetail.failures[0].phase === "validating captured owner" &&
    malformedDetail.mainOwner === "unobserved" &&
    malformed.counts().currentCalls === 0 && malformed.restored(),
  "Diagnostic formatting cannot replace the original malformed-viewer validation error");
  const missing = defaultAdmissionFixture({
    beforeSnapshot: ({ page }) => { page.CustomTabs.getDocumentIdentityForTab = () => null; },
  });
  const missingResult = await missing.finish(missing.start());
  const missingDetail = JSON.parse(missingResult.error.message.slice(prefix.length));
  check(missingDetail.captured.ownerTabMatches === "unobserved" &&
    missingDetail.captured.ownerRefMatches === "unobserved" &&
    missingDetail.mainOwner === "unobserved" && missing.counts().currentCalls === 0 &&
    missing.restored(),
  "Missing captured identities are unobserved rather than matching two absent fields");
}

function pageFixture() {
  const saved = "# Alpha\n\nSAVED\n";
  const typed = "# Alpha\n\nTYPED\n";
  const tab = { id: 21, filePath: "C:\\fixture\\alpha.md", content: typed,
    originalContent: saved, hasUnsavedChanges: true, diskVersion: {} };
  const owner = { pageSession: "page", rendererGeneration: 3, tabId: tab.id,
    documentGeneration: 7, pathKey: "c:\\fixture\\alpha.md", documentRef: "ref" };
  const descriptor = { ref: "ref", pathKey: owner.pathKey,
    logicalPath: tab.filePath, readTarget: tab.filePath };
  const state = { maintained: true, dirty: true, reloadConflict: false,
    deletionTombstone: false, mutationRevision: 10 };
  const pending = { count: 0, revision: 12 };
  const buttons = [
    { dataset: { dialogChoice: "cancel" }, textContent: "Cancel" },
    { dataset: { dialogChoice: "proceed" },
      textContent: "Discard and leave edit mode", disabled: false },
  ];
  const elements = {
    appMessageDialog: { open: false },
    appMessageTitle: { textContent: "Discard unsaved changes?" },
    appMessageText: {
      textContent: "You have unsaved changes. Leave edit mode and discard them?" },
    appMessageName: { textContent: "" },
  };
  const control = { tab, owner, descriptor, state, pending, buttons, elements,
    selection: 9, intent: 4, frozen: false, approved: 0, exits: 0,
    query: { known: true, unresolved: false }, saved, typed };
  const page = {
    currentFilePath: tab.filePath, originalMarkdown: saved,
    markdownEditor: { value: typed }, hasUnsavedChanges: true, isEditMode: true,
    viewer: { textContent: "TYPED" },
    document: {
      getElementById: id => elements[id],
      querySelectorAll: () => buttons,
      querySelector: () => buttons[1],
    },
    getReloadRequestSession: () => "page",
    getActiveFileSelectionGeneration: () => control.selection,
    getPendingSaveStatus: () => ({ ...pending }),
    CustomTabs: {
      getActiveTab: () => tab, getActiveTabId: () => tab.id, getTabs: () => [tab],
      getDocumentIdentityForTab: () => owner,
      getDocumentDescriptor: () => descriptor,
      __documentState: () => state,
      isDocumentFrozen: () => control.frozen,
      __shutdownFreeze: () => ({ dialogDecisionIntent: control.intent }),
      captureDialogContext: () => { throw new Error("Must not recapture consent"); },
    },
    folia: { queryDocumentDeletionState: () => control.query },
    exitEditBtn: { click: () => {
      control.exits++;
      control.intent++;
      elements.appMessageDialog.open = true;
    } },
  };
  buttons[1].click = () => {
    control.approved++;
    page.isEditMode = false;
    page.hasUnsavedChanges = false;
    page.originalMarkdown = saved;
    page.markdownEditor.value = saved;
    page.viewer.textContent = "SAVED";
    tab.content = saved;
    tab.hasUnsavedChanges = false;
    elements.appMessageDialog.open = false;
  };
  page.window = page;
  return { page, control, context: vm.createContext(page) };
}

async function loadHelpers(fixture, mutateAtChoice = () => {}, mutateBeforeInput = () => {}) {
  let mutated = false;
  const host = {
    exec: async script => {
      if (script.includes("const expected =") && !mutated) {
        mutated = true;
        mutateAtChoice(fixture);
      }
      if (script.includes("Save fixture changed before its ordinary input")) mutateBeforeInput(fixture);
      const value = await vm.runInContext(script, fixture.context, { timeout: 1000 });
      return value === undefined ? undefined : clone(value);
    },
    defaultMainOwns: async () => fixture.control.query.known === true &&
      fixture.control.query.unresolved === false,
    fs: { readFileSync: () => fixture.control.saved },
    waitForCondition: async (_exec, script) =>
      vm.runInContext(script, fixture.context, { timeout: 1000 }),
  };
  return vm.runInNewContext(`(async () => {
    ${helpers}
    return { discardDefaultSaveEdit, readDefaultSaveDocument, editDefaultSaveDocument };
  })()`, host, { timeout: 1000 });
}

function installOrdinaryInput(fixture, transformSource = value => value) {
  const { page, control, context } = fixture;
  Object.assign(control.state, { saveFailure: false, content: control.tab.content,
    foldedLive: control.tab.content });
  const listeners = [], timers = new Map();
  const menuClasses = new Set(["visible"]), noteMenuClasses = new Set(["visible"]);
  const classes = values => ({
    add: name => values.add(name), remove: name => values.delete(name),
    contains: name => values.has(name),
  });
  const menuState = () => ({
    documentVisible: page.contextMenu.classList.contains("visible"),
    notesVisible: page.notesPanelContextMenu.classList.contains("visible"),
    noteId: page.notesPanelContextNoteId,
  });
  control.inputTrace = [];
  control.inputMenuState = menuState;
  let nextTimer = 1;
  page.markdownEditor.addEventListener = (name, callback) => {
    assert.equal(name, "input"); listeners.push(callback);
  };
  page.markdownEditor.dispatchEvent = () => {
    for (const listener of listeners) listener();
    for (const [id, callback] of [...timers]) {
      timers.delete(id); callback();
    }
  };
  Object.assign(page, {
    Event: function Event(type) { this.type = type; },
    documentState: new Map([[control.tab, control.state]]),
    activeTabForMutations: control.tab, activeTabId: control.tab.id,
    tabs: [control.tab], previewDebounceTimer: null, fileOpenSequence: 1, editorModeRevision: 1,
    TIMING: { previewDebounceDelay: 1 },
    setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    mayMutateRendererDocument: () => true,
    contextMenu: { classList: classes(menuClasses) },
    notesPanelContextMenu: { classList: classes(noteMenuClasses) },
    notesPanelContextNoteId: "owned-input-note", rightClickTarget: page.markdownEditor,
    editorScroll: { changed: () => {
      control.inputTrace.push({ phase: "scroll", menus: menuState() });
    } },
    unsavedIndicator: { style: {} }, fileTrackingPauseOwner: null,
    isFileTrackingActive: false, fileTrackingResumeHold: 0,
    hasPendingSaveFor: () => false, saveFailedFor: () => false, reloadConflictFor: () => false,
    frozenForShutdown: () => false, normaliseDocumentPath: value => ({ spelling: value.toLowerCase() }),
    assertFileTrackingOwnership: () => { throw new Error("Unexpected tracking resume"); },
    renderMarkdown: content => { page.viewer.textContent = content; },
  });
  vm.runInContext(fs.readFileSync(path.join(producerRoot, "context-menu-utils.js"), "utf8"), context);
  page.hideContextMenuHelper = page.FoliaContextMenu.hideContextMenu;
  vm.runInContext(between(renderer, "function hideContextMenu(event)",
    "\n// Show context menu on right-click"), context);
  vm.runInContext(between(renderer, "function hideNotesPanelContextMenu(event)",
    "\ndocument.addEventListener('click'"), context);
  const dismiss = page.hideDocumentContextMenus;
  page.hideDocumentContextMenus = (...args) => {
    const result = dismiss(...args);
    control.inputTrace.push({ phase: "dismiss", args, menus: menuState() });
    return result;
  };
  const mutation = between(customTabs, "  function bumpTabMutationRevision(",
    "  function bumpDocumentRevision(") +
    between(customTabs, "  function noteActiveContentMutation()",
      "  function confirmedReloadStillCurrent(");
  page.CustomTabs.noteActiveContentMutation = vm.runInContext(`(() => {
    ${mutation}
    return noteActiveContentMutation;
  })()`, context);
  const noteMutation = page.CustomTabs.noteActiveContentMutation;
  page.CustomTabs.noteActiveContentMutation = (...args) => {
    control.inputTrace.push({ phase: "tab-mutation", menus: menuState() });
    return noteMutation(...args);
  };
  const documentStateReader = between(customTabs, "__documentState: (tab) => {",
    "__reloadState:").replace("__documentState:", "").trim().replace(/,$/, "");
  page.CustomTabs.__documentState = vm.runInContext("(" + documentStateReader + ")", context);
  const inputSource =
    between(renderer, "function normaliseReloadSnapshot(", "function setDocumentDirtyState(") +
    between(renderer, "function setDocumentDirtyState(", "function withFileTrackingResumeHeld(") +
    between(renderer, "function setDocumentDirtyFromContent(", "function currentReloadSnapshot(") +
    between(renderer, "function updateUnsavedIndicator(", "// ============================================\n// RECENT FILES") +
    between(renderer, "// Live preview with fast debounce", "// Sync editor textarea");
  vm.runInContext(transformSource(inputSource), context, { timeout: 1000 });
  check(listeners.length === 1, "Exact current ordinary preview input producer was installed");
}

function inputMenuContracts() {
  const make = transformSource => {
    const fixture = pageFixture(), { page, control } = fixture;
    control.tab.content = control.tab.originalContent = control.saved;
    control.tab.hasUnsavedChanges = false; control.state.dirty = false;
    page.markdownEditor.value = control.saved; page.hasUnsavedChanges = false;
    page.viewer.textContent = "SAVED";
    installOrdinaryInput(fixture, transformSource);
    check(page.contextMenu.classList.contains("visible") &&
      page.notesPanelContextMenu.classList.contains("visible") &&
      page.notesPanelContextNoteId === "owned-input-note" &&
      page.rightClickTarget === page.markdownEditor &&
      control.state.mutationRevision === 10 && control.inputTrace.length === 0,
    "Ordinary input fixture starts with both real menus visible and an editor-owned captured note");
    return fixture;
  };
  const input = fixture => {
    fixture.page.markdownEditor.value = fixture.control.typed;
    fixture.page.markdownEditor.dispatchEvent(new fixture.page.Event("input"));
  };
  const verify = ({ page, control }) => {
    assert.deepEqual(control.inputTrace.map(event => event.phase),
      ["dismiss", "scroll", "tab-mutation"],
      "Full menu dismissal precedes scroll and actual tab mutation");
    assert.deepEqual(control.inputTrace[0].args, [], "Ordinary input requests full dismissal");
    for (const event of control.inputTrace) assert.deepEqual(event.menus,
      { documentVisible: false, notesVisible: false, noteId: null },
      "Both menus and captured note are dismissed before downstream work");
    assert.equal(control.state.mutationRevision, 11, "Actual mutation revision increases");
    assert.equal(control.tab.content, control.saved, "Live input does not eagerly fold the tab cache");
    assert.equal(page.viewer.textContent, control.typed, "Actual input still paints its live preview");
  };
  const positive = make();
  input(positive); verify(positive);
  check(true, "Ordinary input fully dismisses real menus before scroll and actual mutation without eager cache folding");
  for (const [label, transform, expected] of [
    ["omitted dismissal", text => text.replace("  hideDocumentContextMenus();\n", ""),
      "Full menu dismissal precedes scroll and actual tab mutation"],
    ["preview-only dismissal", text => text.replace("  hideDocumentContextMenus();",
      "  hideDocumentContextMenus(true);"), "Ordinary input requests full dismissal"],
    ["reordered dismissal", text => text.replace(
      "  hideDocumentContextMenus();\n" +
      "  // History changes the source, not which pane the reader chose to drive it.\n" +
      "  if (preserveScrollOwner) editorScroll.start();\n  else editorScroll.changed();",
      "  if (preserveScrollOwner) editorScroll.start();\n  else editorScroll.changed();\n" +
      "  hideDocumentContextMenus();"),
      "Full menu dismissal precedes scroll and actual tab mutation"],
  ]) {
    let changed = false;
    const fixture = make(text => {
      const altered = transform(text);
      assert.notEqual(altered, text, "Mutation reaches the actual ordinary-input producer");
      changed = true; return altered;
    });
    input(fixture);
    assert.throws(() => verify(fixture), error =>
      error.code === "ERR_ASSERTION" && error.message.startsWith(expected));
    check(changed && fixture.control.state.mutationRevision === 11 &&
      fixture.control.tab.content === fixture.control.saved &&
      fixture.page.viewer.textContent === fixture.control.typed,
    "Real ordinary-input menu contract detects " + label + " without crashing or disabling mutation");
  }
  for (const denied of ["permission", "non-edit mode"]) {
    const fixture = make(), { page, control } = fixture;
    if (denied === "permission") page.mayMutateRendererDocument = () => false;
    else page.isEditMode = false;
    const before = { menus: control.inputMenuState(), revision: control.state.mutationRevision,
      preview: page.viewer.textContent, cache: control.tab.content, dirty: page.hasUnsavedChanges };
    input(fixture);
    check(JSON.stringify(before) === JSON.stringify({
      menus: control.inputMenuState(), revision: control.state.mutationRevision,
      preview: page.viewer.textContent, cache: control.tab.content, dirty: page.hasUnsavedChanges }) &&
      control.inputTrace.length === 0,
    "Ordinary input leaves menus revision preview cache and dirty state untouched for " + denied);
  }
}

async function consentContracts() {
  const positive = pageFixture();
  const api = await loadHelpers(positive);
  const question = await api.discardDefaultSaveEdit(
    positive.control.typed, "positive contract", "SAVED");
  check(positive.control.approved === 1 && positive.control.exits === 1 &&
    question.intent === 5 && question.question.open === true,
  "Real choice handler is reached once only after the exact question");
  const cases = [
    ["active tab", f => { f.control.tab.id++; }],
    ["tab path", f => { f.control.tab.filePath += ".changed"; }],
    ["renderer path", f => { f.page.currentFilePath += ".changed"; }],
    ...identityFields.map(field => ["owner " + field, f => { f.control.owner[field] += "changed"; }]),
    ["descriptor", f => { f.control.descriptor.ref += "changed"; }],
    ["document mutation", f => { f.control.state.mutationRevision++; }],
    ["deleted document", f => { f.control.state.deletionTombstone = true; }],
    ["reload conflict", f => { f.control.state.reloadConflict = true; }],
    ["freeze", f => { f.control.frozen = true; }],
    ["unknown Main owner", f => { f.control.query.known = false; }],
    ["unresolved Main owner", f => { f.control.query.unresolved = true; }],
    ["editor bytes", f => { f.page.markdownEditor.value += "changed"; }],
    ["cached bytes", f => { f.control.tab.content += "changed"; }],
    ["saved baseline", f => { f.control.tab.originalContent += "changed"; }],
    ["renderer baseline", f => { f.page.originalMarkdown += "changed"; }],
    ["editor closed", f => { f.page.isEditMode = false; }],
    ["renderer clean", f => { f.page.hasUnsavedChanges = false; }],
    ["tab clean", f => { f.control.tab.hasUnsavedChanges = false; }],
    ["selection", f => { f.control.selection++; }],
    ["pending count", f => { f.control.pending.count++; }],
    ["pending revision", f => { f.control.pending.revision++; }],
    ["decision intent", f => { f.control.intent++; }],
    ["closed question", f => { f.control.elements.appMessageDialog.open = false; }],
    ["different title", f => { f.control.elements.appMessageTitle.textContent += "?"; }],
    ["different message", f => { f.control.elements.appMessageText.textContent += "?"; }],
    ["deleted-owner filename", f => { f.control.elements.appMessageName.textContent = "alpha.md"; }],
    ["choice id", f => { f.control.buttons[1].dataset.dialogChoice = "other"; }],
    ["choice label", f => { f.control.buttons[1].textContent = "Discard"; }],
    ["choice disabled", f => { f.control.buttons[1].disabled = true; }],
  ];
  for (const [label, mutate] of cases) {
    const fixture = pageFixture();
    const negative = await loadHelpers(fixture, mutate);
    await assert.rejects(negative.discardDefaultSaveEdit(
      fixture.control.typed, label, "SAVED"));
    check(fixture.control.approved === 0, "No approval after changing " + label);
  }
  for (const field of ["known", "unresolved", "deletionTombstone", "reloadConflict"]) {
    const fixture = pageFixture();
    if (field === "known") fixture.control.query.known = false;
    else if (field === "unresolved") fixture.control.query.unresolved = true;
    else fixture.control.state[field] = true;
    const negative = await loadHelpers(fixture);
    await assert.rejects(negative.discardDefaultSaveEdit(
      fixture.control.typed, field, "SAVED"));
    check(fixture.control.exits === 0 && fixture.control.approved === 0,
      "No ordinary discard is opened for initial " + field);
  }
}

function requestContracts() {
  const declaration = between(source, "  const bgRequests = [];",
    "  const heldBgSaveResults = [];");
  const make = () => {
    const webContents = { mainFrame: {} };
    const owner = { pageSession: "page", rendererGeneration: 3, tabId: 21,
      documentGeneration: 7, pathKey: "path", documentRef: "ref" };
    const host = { win: { webContents }, fileB: "C:\\fixture\\beta.md",
      bgSavedContent: "# Beta\n\nS9C_TYPED\n", saveIdentityFields: identityFields,
      bgBaseline: { owner, selection: 9 } };
    const observe = vm.runInNewContext(`(() => {
      ${declaration}
      return { receive: observeBgSaveRequest, requests: bgRequests,
        failure: () => bgRequestFailure };
    })()`, host);
    const event = { sender: webContents, senderFrame: webContents.mainFrame };
    const request = { filePath: host.fileB, content: host.bgSavedContent,
      requestId: 17, saveRequest: { ...owner, selectionGeneration: 9, requestId: 17 } };
    return { observe, event, request };
  };
  const good = make();
  const before = JSON.stringify(good.request);
  good.observe.receive(good.event, good.request);
  check(good.observe.requests.length === 1 && !good.observe.failure() &&
    JSON.stringify(good.request) === before && !("returnValue" in good.event),
  "Main observation records a genuine request without answering or altering it");
  for (const field of [...identityFields, "selectionGeneration", "requestId"]) {
    const fixture = make();
    fixture.request.saveRequest[field] += "changed";
    fixture.observe.receive(fixture.event, fixture.request);
    check(fixture.observe.requests.length === 0 && !!fixture.observe.failure(),
      "Main observation rejects mismatching " + field);
  }
  for (const key of ["sender", "senderFrame"]) {
    const fixture = make();
    fixture.event[key] = {};
    fixture.observe.receive(fixture.event, fixture.request);
    check(fixture.observe.requests.length === 0, "Foreign " + key + " is never accepted");
  }
  for (const key of ["filePath", "content"]) {
    const fixture = make();
    fixture.request[key] += "other";
    fixture.observe.receive(fixture.event, fixture.request);
    check(fixture.observe.requests.length === 0, "Other Save " + key + " is ignored");
  }
}

async function subscriptionContracts() {
  const raw = between(source, "    const bgStageOut = await exec(`",
    "    bgStage = JSON.parse(bgStageOut);");
  const template = raw.slice(raw.indexOf("`"), raw.lastIndexOf("`") + 1);
  const make = async () => {
    const fixture = pageFixture(), { control, page, context } = fixture;
    const mine = control.tab;
    mine.filePath = page.currentFilePath = "C:\\fixture\\beta.md";
    control.owner.pathKey = control.descriptor.pathKey = "c:\\fixture\\beta.md";
    control.descriptor.logicalPath = control.descriptor.readTarget = mine.filePath;
    mine.content = mine.originalContent = page.originalMarkdown = control.saved = "OLD";
    mine.hasUnsavedChanges = control.state.dirty = page.hasUnsavedChanges = false;
    page.markdownEditor.value = "OLD";
    const other = { id: 22, filePath: "C:\\fixture\\alpha.md", content: "ALPHA" };
    let active = mine, count = 0, revision = 8, callback, unsubscribed = 0, saves = 0;
    page.__defaultSaveQuestions = { questions: [] };
    page.getPendingSaveStatus = () => ({ count, revision });
    page.saveButton = { click: () => {
      saves++; count++; revision++;
      mine.content = page.markdownEditor.value; mine.hasUnsavedChanges = control.state.dirty = true;
    } };
    Object.assign(page.CustomTabs, {
      getTabs: () => [mine, other], getActiveTab: () => active,
      getActiveTabId: () => active.id,
      switchToTab: async id => {
        active = [mine, other].find(t => t.id === id);
        page.currentFilePath = active.filePath;
      },
    });
    page.folia.onSaveMarkdownResult = listener => {
      callback = listener; return () => { unsubscribed++; };
    };
    installOrdinaryInput(fixture);
    const api = await loadHelpers(fixture);
    await api.editDefaultSaveDocument("# Beta\n\nS9C_TYPED\n", "S9C_TYPED");
    const bgPreSaveDocument = await api.readDefaultSaveDocument();
    assert.equal(bgPreSaveDocument.tab.content, "OLD");
    assert.equal(bgPreSaveDocument.tab.dirty, false);
    const body = vm.runInNewContext(template, {
      saveTabB: 21, fileB: mine.filePath, bgSavedContent: "# Beta\n\nS9C_TYPED\n",
      bgPreSaveDocument, saveIdentityFields: identityFields,
    });
    return { fixture, mine, other, body, callback: value => callback(value),
      unsubscribed: () => unsubscribed, saves: () => saves };
  };
  const healthy = await make();
  const { mine, other, fixture: { page, context } } = healthy;
  const stage = JSON.parse(await vm.runInContext(healthy.body, context, { timeout: 1000 }));
  const probe = page.__s9cFirstDeliveryProbe;
  check(stage.otherSelected && stage.dispatched.count === 1 &&
    stage.dispatched.revision > stage.before.revision && probe.request === null &&
    stage.prepared.content === "# Beta\n\nS9C_TYPED\n" && stage.prepared.original === "OLD" &&
    stage.prepared.dirty === true,
  "S9c admits unfurled real input, proves Save preparation's fold, then switches tabs");
  const result = { requestId: 17, path: mine.filePath, saveResultAttempt: 1 };
  healthy.callback(result);
  check(probe.deliveries.length === 0, "Unobserved requests cannot authorize result observation");
  probe.request = { requestId: 17, path: mine.filePath };
  healthy.callback({ ...result, path: "other" });
  check(probe.deliveries.length === 0, "Mismatched result path is ignored");
  healthy.callback(result);
  check(probe.deliveries.length === 1 && probe.deliveries[0].activeTabId === other.id &&
    probe.deliveries[0].pending === 1, "One projected payload is observed without settling/faking it");
  page.__s9cFirstDeliveryProbe = {};
  assert.throws(() => probe.cleanup(), /ownership/);
  check(healthy.unsubscribed() === 0, "Cleanup refuses a displaced observation");
  page.__s9cFirstDeliveryProbe = probe;
  check(probe.cleanup() === true && healthy.unsubscribed() === 1 &&
    !Object.hasOwn(page, "__s9cFirstDeliveryProbe"), "Owned typed subscription is unsubscribed");
  for (const [label, change] of [
    ["cache", f => { f.mine.content = "OTHER"; }],
    ["cache dirty", f => { f.mine.hasUnsavedChanges = true; }],
    ["saved baseline", f => { f.mine.originalContent = "OTHER"; }],
    ["disk version", f => { f.mine.diskVersion = { size: 1 }; }],
    ["owner", f => { f.fixture.control.owner.documentRef = "other"; }],
    ["mutation", f => { f.fixture.control.state.mutationRevision++; }],
    ["selection", f => { f.fixture.control.selection++; }],
    ["Main owner", f => { f.fixture.control.query.known = false; }],
  ]) {
    const negative = await make();
    change(negative);
    await assert.rejects(vm.runInContext(negative.body, negative.fixture.context));
    check(negative.saves() === 0, "S9c refuses changed pre-dispatch " + label);
  }
  const noFold = await make();
  noFold.fixture.page.saveButton.click = () => {};
  await assert.rejects(vm.runInContext(noFold.body, noFold.fixture.context),
    /preparation did not fold/);
  check(true, "S9c refuses to proceed unless genuine Save preparation folded its live bytes");
}

function execBody(start, end, values = {}) {
  const raw = between(source, start, end);
  return vm.runInNewContext(raw.slice(raw.indexOf("`"), raw.lastIndexOf("`") + 1), values);
}

async function discardHistoryContracts() {
  const historyController = fs.readFileSync(
    path.join(__dirname, "test-editor-history-controls.js"), "utf8").replace(/\r\n/g, "\n");
  const historyFixture = vm.runInNewContext(`(() => {
    ${between(historyController, 'const root = path.join(__dirname, "..");', "\nfor (const [id")}
    return fixture;
  })()`, { __dirname, fs: { readFileSync: (file, encoding) => {
    const relative = path.relative(path.join(__dirname, "..", "src"), file);
    assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative));
    return fs.readFileSync(path.join(producerRoot, relative), encoding);
  } }, path, vm, assert, console, Event });
  const beforeBody = execBody("  const discardBefore = await exec(`", "\n  const s7Question = ");
  const afterBody = execBody("  const discardAfter = await exec(`", "\n  const s7Questions = ");
  const guard = (name, discard) => {
    let accepted;
    const text = between(source, '  check(\n    "' + name + '",', "\n  );") + "\n  );";
    vm.runInNewContext("const discard = " + JSON.stringify(discard) + ";\n" + text,
      { discardOut: JSON.stringify(discard),
      isDeepStrictEqual: require("node:util").isDeepStrictEqual,
      check: (_name, condition) => { accepted = condition; } });
    return accepted === true;
  };
  const diverged = "the edit-mode session really did diverge from the saved content";
  const repainted = "the preview is repainted from the saved content, not left showing the discard";
  const restored = "undo cannot resurrect discarded content, and older undo points survive";
  const make = () => {
    const f = historyFixture(), c = f.context;
    f.seed("# Alpha\n\nS7_SAVED\n");
    c.isEditMode = false;
    c.viewer = { textContent: c.originalMarkdown };
    Object.defineProperty(c.window, "originalMarkdown", { get: () => c.originalMarkdown });
    c.markdownEditor.dispatchEvent = event => f.emit(event.type);
    vm.runInContext(between(renderer, "function captureEditSessionBaseline(force)",
      "\n// Called by custom-tabs.js"), c);
    c.toggleEditBtn = { click: () => {
      c.isEditMode = true;
      actualOpenPrimer(c);
    } };
    const render = c.renderMarkdown;
    c.renderMarkdown = content => { c.viewer.textContent = content; return render(content); };
    return f;
  };
  const actualOpenPrimer = context => vm.runInContext(between(renderer,
    "    captureEditSessionBaseline(true);\n    markdownEditor.value",
    "\n    if (!editorScroll.enter())"), context);
  const execute = async (f, body) => {
    let settled = false;
    const outcome = vm.runInContext(body, f.context, { timeout: 1000 })
      .then(value => { settled = true; return { value: clone(value) }; },
        error => { settled = true; return { error }; });
    // Drain the existing controller's discrete jobs, not native wall-clock waits.
    for (let turnIndex = 0; turnIndex < 20 && !settled; turnIndex++) {
      for (const [id, callback] of [...f.timers]) { f.timers.delete(id); callback(); }
      f.finishRenders(); f.flushMicrotasks(); await turn();
    }
    assert.ok(settled, "Actual S7 history work must settle under the existing controlled scheduler");
    return outcome;
  };
  const actual = make();
  const before = await execute(actual, beforeBody);
  assert.ifError(before.error);
  check(guard(diverged, { before: before.value }),
    "Actual S7 inputs and Undo Undo Redo finish at exact EARLY with OLD SAVED undo and TYPED redo: " +
      JSON.stringify(before.value));
  for (const changed of [
    { viewerShowsEarly: false, viewerShowsSaved: true },
    { viewerShowsEarly: false, viewerShowsSaved: false },
    { content: "# Alpha\n\nS7_TYPED\n" }, { undoSources: ["# Alpha\n\nS7_SAVED\n"] },
    { redoSources: [] },
  ]) check(!guard(diverged, { before: { ...before.value, ...changed } }),
    "Actual S7 native divergence gate refuses wrong source preview or exact history: " + JSON.stringify(changed));
  for (const [label, body] of [
    ["first Undo", beforeBody.replace("      historyUndo();", "")],
    ["second Undo", beforeBody.replace(
      "      historyUndo();\n      await new Promise(r => setTimeout(r, 400));\n      historyRedo();",
      "      await new Promise(r => setTimeout(r, 400));\n      historyRedo();")],
    ["Redo", beforeBody.replace("      historyRedo();", "")],
  ]) {
    assert.notEqual(body, beforeBody, "Counterfactual must remove the named actual S7 history call");
    const result = await execute(make(), body);
    assert.ifError(result.error);
    check(!guard(diverged, { before: result.value }),
      "Actual S7 native divergence gate rejects a missing " + label);
  }
  const unpainted = make(), ordinaryRender = unpainted.context.renderMarkdown;
  unpainted.context.renderMarkdown = content => content.includes("S7_TYPED")
    ? { then: done => done() } : ordinaryRender(content);
  const rejected = await execute(unpainted, beforeBody);
  check(!!rejected.error && /actual TYPED source and preview/.test(rejected.error.message) &&
    unpainted.context.markdownEditor.value === "# Alpha\n\nS7_TYPED\n",
  "S7 refuses missing TYPED preview before any Undo or Redo can conceal the failed setup");
  actual.run("{" + between(renderer, "      const baseline = editSessionBaseline;",
    "      // The tab record holds its own copy") + "}");
  actual.context.isEditMode = false;
  actual.context.renderMarkdown(actual.context.originalMarkdown);
  actual.finishRenders();
  const after = await execute(actual, afterBody);
  assert.ifError(after.error);
  check(guard(repainted, after.value) && guard(restored, after.value),
    "Actual history restore and native post-discard guards exclude both edits and preserve mandatory OLD Undo");
  for (const marker of ["S7_EARLY", "S7_TYPED"]) {
    const leftover = clone(after.value);
    leftover.after["viewerShows" + (marker === "S7_EARLY" ? "Early" : "Typed")] = true;
    check(!guard(repainted, leftover), "Native discard preview gate rejects leftover " + marker);
    for (const stack of ["undoSources", "redoSources"]) {
      const resurrected = clone(after.value);
      resurrected.after[stack].push("# Alpha\n\n" + marker + "\n");
      check(!guard(restored, resurrected),
        "Native discarded-history gate rejects " + marker + " remaining in " + stack);
    }
  }
  const lostOld = clone(after.value); lostOld.undone.olderPointReached = false;
  check(!guard(restored, lostOld), "The original older Undo point remains mandatory after discard");
}

function reloadPreviewFixture(options = {}) {
  const fixture = pageFixture(), { page, control, context } = fixture;
  const content = "# Beta\n\nS9D_SECOND\n";
  control.tab.filePath = page.currentFilePath = "C:\\fixture\\beta.md";
  Object.assign(control.tab, { content, originalContent: content, hasUnsavedChanges: false });
  Object.assign(control.owner, { pathKey: control.tab.filePath.toLowerCase() });
  Object.assign(control.descriptor, { pathKey: control.owner.pathKey,
    logicalPath: control.tab.filePath, readTarget: control.tab.filePath });
  Object.assign(control.state, { dirty: false });
  Object.assign(page, { originalMarkdown: content, hasUnsavedChanges: false,
    undoHistory: ["# Beta\n\nS9D_BASE\n"], redoHistory: [], exactTypingSource: content });
  page.markdownEditor.value = content;
  page.viewer.textContent = "# Beta\n\nS9D_FIRST\n";
  control.pending.count = 0;
  control.disk = content;
  control.current = true;
  const other = { id: 22, filePath: "C:\\fixture\\other.md",
    content: "OTHER", originalContent: "OTHER", hasUnsavedChanges: false };
  page.CustomTabs.getTabs = () => [control.tab, other];
  vm.runInContext(between(renderer, "function historySnapshot()", "\nfunction historyRestore("), context);
  const render = deferred(), renders = [], reloads = [];
  let paint, mainQueries = 0;
  page.renderMarkdown = text => {
    renders.push(text);
    paint = render.promise.then(() => {
      page.viewer.textContent = options.viewer ?? text;
    });
    return paint;
  };
  const setup = between(source, "  if (scenario9dSucceeded) {",
    "    const reloaded = await readDefaultSaveDocument();")
    .slice("  if (scenario9dSucceeded) {".length);
  const mainOwnership = between(source, "  const defaultMainOwns = async (snapshot) => {",
    "\n  async function joinDefaultFileOpenWork");
  const api = vm.runInNewContext(`(() => {
    ${mainOwnership}
    ${helpers}
    return async () => {
      ${setup}
      return { reloadBefore, reloadCompletion };
    };
  })()`, {
    fileB: control.tab.filePath, diskTwo: content, saveTabB: control.tab.id,
    isDeepStrictEqual: require("node:util").isDeepStrictEqual,
    __shutdown: {
      documentAdmissionIsCurrent: () => control.current,
      documentSessionState: () => ({ owners: [{
        ...control.owner, readTarget: control.descriptor.readTarget,
      }] }),
    },
    exec: async script => {
      const value = await vm.runInContext(script, context, { timeout: 1000 });
      if (script.includes("window.folia.queryDocumentDeletionState(") &&
          ++mainQueries === 2) options.afterMainQuery?.({ page, control });
      return value === undefined ? undefined : clone(value);
    },
    fs: { readFileSync: (file, encoding) => {
      assert.equal(file, control.tab.filePath); assert.equal(encoding, "utf8");
      return control.disk;
    } },
    boundedDialogWork: (work, label) => {
      assert.equal(label, "Scenario 9e saved preview render"); return work;
    },
    reloadSelectedAndWait: async (...args) => {
      reloads.push(args);
      control.disk = args[4];
      return { dispatched: true, landed: true };
    },
  }, { timeout: 1000 });
  const start = () => {
    let settled = false;
    const outcome = api().then(value => { settled = true; return { value }; },
      error => { settled = true; return { error }; });
    return { outcome, settled: () => settled };
  };
  const finish = async (work, mutate = () => {}) => {
    await turn();
    const held = renders.length === 1 && !work.settled() &&
      reloads.length === 0 && control.disk === content &&
      page.viewer.textContent.includes("S9D_FIRST");
    mutate({ page, control, other });
    if (options.renderError) render.reject(options.renderError);
    else render.resolve();
    const result = await work.outcome;
    if (paint) await Promise.allSettled([paint]);
    return { ...result, held };
  };
  return { page, control, other, content, renders, reloads, start, finish };
}

async function reloadPreviewContracts() {
  const positive = reloadPreviewFixture();
  const completed = await positive.finish(positive.start());
  check(completed.held,
    "S9e awaits the original saved SECOND render before any external write or Reload");
  check(!completed.error && positive.renders.length === 1 &&
    positive.renders[0] === positive.content &&
    completed.value.reloadBefore.viewer.includes("S9D_SECOND") &&
    !completed.value.reloadBefore.viewer.includes("S9E_RELOADED") &&
    positive.page.originalMarkdown === positive.content &&
    positive.page.markdownEditor.value === positive.content &&
    positive.control.tab.originalContent === positive.content,
  "S9e actual production caller paints only captured saved bytes without changing source or baseline");
  check(JSON.stringify(positive.reloads) === JSON.stringify([[positive.control.tab.id,
    positive.control.tab.filePath, "S9D_SECOND", "S9E_RELOADED", "# Beta\n\nS9E_RELOADED\n"]]) &&
    completed.value.reloadCompletion.landed === true,
  "Only exact saved-preview completion admits the unchanged explicit Reload actor");
  for (const viewer of ["# Beta\n\nS9D_FIRST\n", "# Beta\n\nS9E_RELOADED\n",
    "# Beta\n\nS9D_FIRST\nS9D_SECOND\n"]) {
    const stale = reloadPreviewFixture({ viewer });
    const result = await stale.finish(stale.start());
    check(result.held && !!result.error && stale.reloads.length === 0 &&
      stale.control.disk === stale.content,
    "S9e refuses a fulfilled original render with stale or future Reload DOM: " + viewer.trim());
  }
  for (const [label, mutate] of [
    ["source", ({ page }) => { page.originalMarkdown = "WRONG"; }],
    ["editor", ({ page }) => { page.markdownEditor.value = "WRONG"; }],
    ["cache", ({ control }) => { control.tab.content = "WRONG"; }],
    ["baseline", ({ control }) => { control.tab.originalContent = "WRONG"; }],
    ["dirty tab", ({ control }) => { control.tab.hasUnsavedChanges = true; }],
    ["dirty editor", ({ page }) => { page.hasUnsavedChanges = true; }],
    ["pending Save", ({ control }) => { control.pending.count = 1; }],
    ["pending revision", ({ control }) => { control.pending.revision++; }],
    ["owner", ({ control }) => { control.owner.documentGeneration++; }],
    ["descriptor", ({ control }) => { control.descriptor.ref = "OTHER"; }],
    ["selection", ({ control }) => { control.selection++; }],
    ["history", ({ page }) => { page.undoHistory.push("OTHER"); }],
    ["other tab", ({ other }) => { other.content = "OTHER CHANGE"; }],
    ["disk", ({ control }) => { control.disk = "EXTERNAL"; }],
    ["Main currentness", ({ control }) => { control.current = false; }],
    ["Main deletion witness", ({ control }) => { control.query.known = false; }],
  ]) {
    const changed = reloadPreviewFixture();
    const result = await changed.finish(changed.start(), mutate);
    check(result.held && !!result.error && changed.reloads.length === 0,
      "S9e refuses " + label + " drift during its original render before any Reload");
  }
  for (const [label, afterMainQuery] of [
    ["source", ({ page }) => { page.originalMarkdown = "WRONG"; }],
    ["pending Save", ({ control }) => { control.pending.count = 1; }],
  ]) {
    const changed = reloadPreviewFixture({ afterMainQuery });
    const result = await changed.finish(changed.start());
    check(result.held && !!result.error && changed.reloads.length === 0,
      "S9e final page witness refuses " + label + " drift during Main currentness query");
  }
  const failure = new RangeError("original saved-preview render failure");
  const rejected = reloadPreviewFixture({ renderError: failure });
  const result = await rejected.finish(rejected.start());
  check(result.error === failure && rejected.reloads.length === 0 &&
    rejected.control.disk === rejected.content,
  "S9e retains original render rejection and never dispatches external work");
  for (const [label, mutate] of [
    ["source", f => { f.page.originalMarkdown = "WRONG"; }],
    ["dirty", f => { f.page.hasUnsavedChanges = true; }],
    ["pending", f => { f.control.pending.count = 1; }],
    ["Main currentness", f => { f.control.current = false; }],
  ]) {
    const initial = reloadPreviewFixture();
    mutate(initial);
    const result = await initial.finish(initial.start());
    check(!!result.error && initial.renders.length === 0 && initial.reloads.length === 0 &&
      initial.control.disk === initial.content,
    "S9e refuses initial " + label + " without invoking a preview producer");
  }
}

async function sameTaskContracts() {
  const race = execBody("  const raceDispatch = await exec(`", "  const raceSettled =");
  const during = execBody("  const duringDispatch = await exec(`", "  if (!await waitUntil(", {});
  const make = initial => {
    let count = 0, revision = 6;
    const calls = [], writes = [];
    const page = {
      isEditMode: true, hasUnsavedChanges: true,
      getPendingSaveStatus: () => ({ count, revision }),
      markdownEditor: { value: initial, dispatchEvent: () => {
        calls.push("input"); page.hasUnsavedChanges = true;
      } },
      saveButton: { click: () => {
        calls.push("save"); writes.push(page.markdownEditor.value); count++; revision++;
      } },
      exitEditBtn: { click: () => { calls.push("exit"); assert.equal(count, 1); } },
      Event: function Event(type) { this.type = type; },
    };
    page.window = page;
    return { page, calls, writes };
  };
  const exit = make("# Beta\n\nS9_TYPED\n");
  const exitState = vm.runInNewContext(race, exit.page);
  check(exit.calls.join(",") === "save,exit" &&
    exitState.before.count === 0 && exitState.after.count === 1 &&
    exitState.after.revision > exitState.before.revision && exitState.editMode,
  "Actual Save/Exit source dispatches in that order before a reply can arrive");
  const input = make("# Beta\n\nS9B_SENT\n");
  const inputState = vm.runInNewContext(during, input.page);
  check(input.calls.join(",") === "save,input" &&
    input.writes[0] === "# Beta\n\nS9B_SENT\n" &&
    inputState.editor === "# Beta\n\nS9B_AFTER\n" &&
    inputState.after.count === 1 && inputState.after.revision > inputState.before.revision,
  "Actual Save/later-input source keeps dispatched bytes separate from later editor bytes");
  const second = make("# Beta\n\nS9D_FIRST\n"), completion = deferred();
  Object.assign(second.page, {
    currentFilePath: "C:\\fixture\\beta.md", originalMarkdown: "# Beta\n\nS9D_FIRST\n",
    __defaultSaveQuestions: { questions: [] },
    document: { getElementById: () => ({ open: false }) },
    waitForPendingSaves: () => completion.promise,
    setTimeout: () => 1, clearTimeout: () => {},
  });
  const twoSaveBody = execBody("  const twoOut = await exec(`", "  const two = JSON.parse(twoOut);",
    { twoQuestionStart: 0 });
  const twoSaveWork = vm.runInNewContext(twoSaveBody, second.page);
  const synchronous = second.calls.join(",") === "save,save" &&
    JSON.stringify(second.writes) === JSON.stringify(
      ["# Beta\n\nS9D_FIRST\n", "# Beta\n\nS9D_SECOND\n"]);
  completion.resolve();
  const twoSave = JSON.parse(await twoSaveWork);
  check(synchronous && twoSave.dispatchedPending === 2 &&
    twoSave.dispatchedRevision === twoSave.before.revision + 2 && twoSave.settled,
  "Unchanged actual S9d dispatches FIRST and SECOND Saves synchronously with no input or render");
  const reloadGate = between(source, "  const scenario9dSucceeded =", "  // ---- Scenario 9e:");
  const gate = (two, diskTwo) => vm.runInNewContext(`(() => {
    ${reloadGate}
    return scenario9dSucceeded;
  })()`, { two, diskTwo });
  const saved = { editMode: true, storeIsSecond: true, dirty: false };
  check(gate(saved, "# Beta\n\nS9D_SECOND\n") === true,
    "Actual open-editor Reload gate admits a successful two-Save result");
  for (const [label, two, disk] of [
    ["closed editor", { ...saved, editMode: false }, "S9D_SECOND"],
    ["wrong disk", saved, "S9D_FIRST"],
    ["wrong store", { ...saved, storeIsSecond: false }, "S9D_SECOND"],
    ["dirty buffer", { ...saved, dirty: true }, "S9D_SECOND"],
  ]) check(gate(two, disk) === false, "Actual Reload gate rejects " + label);
}

async function deliveryContracts() {
  const fileB = "C:\\fixture\\beta.md", content = "# Beta\n\nS9C_TYPED\n";
  const result = () => ({ requestId: 17, path: fileB, success: true,
    savedContent: content, saveRequest: { requestId: 17 }, saveResultAttempt: 1 });
  const holdSource = between(source, "  const heldBgSaveResults = [];", "  let bgStage = null;");
  const hold = () => {
    const sent = [], webContents = { send: (...args) => { sent.push(args); } };
    let restorations = 0;
    const state = vm.runInNewContext(`(() => {
      ${holdSource}
      return { held: heldBgSaveResults, restore: restoreBgSaveSendOnce,
        interceptedAt: () => bgFirstResultInterceptedAt };
    })()`, {
      win: { webContents }, fileB, bgSavedContent: content, Date: { now: () => 10000 },
      replaceMethod: (target, key, replacement) => {
        const original = target[key]; target[key] = replacement;
        return () => { restorations++; target[key] = original; };
      },
    });
    return { state, sent, webContents, restorations: () => restorations };
  };
  const good = hold();
  good.webContents.send("save-markdown-result", result());
  check(good.state.held.length === 1 && good.sent.length === 0 &&
    good.state.interceptedAt() === 10000, "Actual route holds a genuine matching first success");
  good.webContents.send("save-markdown-result", result());
  check(good.sent.length === 1 && good.state.held.length === 1,
    "Already-held results cannot capture additional deliveries");
  good.state.restore(); good.state.restore();
  check(good.restorations() === 1, "Actual result route is restored exactly once");
  for (const [label, change] of [
    ["failure", value => { value.success = false; }],
    ["path", value => { value.path += ".other"; }],
    ["content", value => { value.savedContent += "other"; }],
    ["correlation", value => { value.saveRequest.requestId++; }],
    ["missing identity", value => { value.saveRequest = null; }],
    ["retry", value => { value.saveResultAttempt = 2; }],
  ]) {
    const fixture = hold(), packet = result(); change(packet);
    fixture.webContents.send("save-markdown-result", packet);
    check(fixture.state.held.length === 0 && fixture.sent.length === 1,
      "Actual hold route does not capture " + label);
  }
  const releaseSource = between(source, "  const releaseBgSaveResult =", "  const readBgSettlement =");
  const release = elapsed => {
    const sent = [], attempts = new Set(), webContents = {};
    const state = vm.runInNewContext(`(() => {
      let bgFirstResultReleaseElapsedMs = null;
      ${releaseSource}
      return { release: releaseBgSaveResult,
        elapsed: () => bgFirstResultReleaseElapsedMs };
    })()`, {
      win: { webContents }, fileB, bgSavedContent: content, bgSaveRequestId: 17,
      bgFirstResultInterceptedAt: 10000, firstResultReleaseDeadlineMs: 3000,
      releasedBgSaveAttempts: attempts, Date: { now: () => 10000 + elapsed },
      realBgSaveSend: function (...args) { assert.equal(this, webContents); sent.push(args); },
    });
    return { state, sent, attempts };
  };
  const beforeDeadline = release(2999);
  beforeDeadline.state.release(result(), "control");
  check(beforeDeadline.sent.length === 1 && beforeDeadline.attempts.has(1) &&
    beforeDeadline.state.elapsed() === 2999, "Actual release accepts first delivery before 3000ms");
  assert.throws(() => beforeDeadline.state.release(result(), "duplicate"));
  check(beforeDeadline.sent.length === 1, "Actual release cannot deliver the first result twice");
  for (const elapsed of [3000, 3001, Infinity, NaN]) {
    const fixture = release(elapsed);
    assert.throws(() => fixture.state.release(result(), "deadline"));
    check(fixture.sent.length === 0, "Actual release rejects elapsed " + elapsed);
  }
  for (const [label, change] of [
    ["request", value => { value.requestId++; }],
    ["path", value => { value.path += ".other"; }],
    ["failure", value => { value.success = false; }],
    ["content", value => { value.savedContent += "other"; }],
    ["retry", value => { value.saveResultAttempt = 2; }],
    ["invalid attempt", value => { value.saveResultAttempt = 1.5; }],
  ]) {
    const fixture = release(100), packet = result(); change(packet);
    assert.throws(() => fixture.state.release(packet, label));
    check(fixture.sent.length === 0 && fixture.attempts.size === 0,
      "Actual release rejects changed " + label);
  }
  const settlementSource = between(source, "  const readBgSettlement =",
    "  const switchBackToBgSavedTab =");
  for (const [pending, delivery, correlation, expected] of [
    [0, 2, 3, true], [1, 2, 3, false], [0, 3, 3, false], [0, 2, 4, false],
    [null, 2, 3, false],
  ]) {
    let budget;
    const settled = await vm.runInNewContext(`(async () => {
      ${settlementSource}
      return waitForBgSettlement(1200);
    })()`, {
      exec: async () => pending,
      __shutdown: { state: () => ({
        saveOutcomeDeliveryCount: delivery, saveCorrelationCount: correlation }) },
      bgMainBaseline: { saveOutcomeDeliveryCount: 2, saveCorrelationCount: 3 },
      waitUntil: async (predicate, timeout) => { budget = timeout; return predicate(); },
    });
    check(settled.settled === expected && budget === 1200,
      "ACK settlement requires renderer zero and both Main maps at their exact baseline: " +
      [pending, delivery, correlation]);
  }
  const firstDeliveryCheck = between(source,
    '  check(\n    "the first successful save result is delivered while the other physical tab remains active and settles the saved tab",',
    '  check(\n    "a save whose reply arrived on another tab');
  const qualify = change => {
    const host = {
      bgDeliveryObserved: true, bgFirstDeliverySettled: { settled: true }, bgNaturalRetry: null,
      releasedBgSaveAttempts: new Set([1]), bgFirstResultReleaseElapsedMs: 2999,
      firstResultReleaseDeadlineMs: 3000, bgSavedContent: content, fileB,
      bgStage: { request: { requestId: 17, path: fileB }, otherTabId: 22, savedTabId: 21 },
      bgHeldBeforeRelease: { request: { requestId: 17 }, pending: 1 },
      bg: { firstDelivery: { requestId: 17, path: fileB, saveResultAttempt: 1,
        activeTabId: 22, activePath: "C:\\fixture\\alpha.md", pending: 0,
        savedTab: { id: 21, path: fileB, content, original: content, dirty: false } } },
    };
    let accepted;
    host.check = (_title, outcome) => { accepted = outcome; };
    change(host);
    vm.runInNewContext(firstDeliveryCheck, host);
    return accepted;
  };
  check(qualify(() => {}) === true, "Actual first-delivery oracle accepts complete first-attempt evidence");
  for (const [label, change] of [
    ["unobserved delivery", h => { h.bgDeliveryObserved = false; }],
    ["unsettled first delivery", h => { h.bgFirstDeliverySettled.settled = false; }],
    ["natural retry cleanup", h => { h.bgNaturalRetry = { settled: true }; }],
    ["deadline", h => { h.bgFirstResultReleaseElapsedMs = 3000; }],
    ["held correlation", h => { h.bgHeldBeforeRelease.request.requestId++; }],
    ["no pending pre-release request", h => { h.bgHeldBeforeRelease.pending = 0; }],
    ["retry delivery", h => { h.bg.firstDelivery.saveResultAttempt = 2; }],
    ["saved tab selected", h => { h.bg.firstDelivery.activeTabId = 21; }],
    ["unsettled renderer", h => { h.bg.firstDelivery.pending = 1; }],
    ["dirty saved tab", h => { h.bg.firstDelivery.savedTab.dirty = true; }],
    ["wrong saved baseline", h => { h.bg.firstDelivery.savedTab.original = "other"; }],
  ]) check(qualify(change) === false, "Actual first-delivery oracle refuses " + label);
}

async function liveEditorContract() {
  const fixture = pageFixture();
  fixture.control.tab.content = fixture.control.saved;
  fixture.control.tab.hasUnsavedChanges = false;
  fixture.control.state.dirty = false;
  fixture.page.markdownEditor.value = fixture.control.saved;
  fixture.page.hasUnsavedChanges = false;
  fixture.page.viewer.textContent = "SAVED";
  installOrdinaryInput(fixture);
  const api = await loadHelpers(fixture);
  await api.editDefaultSaveDocument(fixture.control.typed, "TYPED");
  check(fixture.page.markdownEditor.value === fixture.control.typed &&
    fixture.page.hasUnsavedChanges && fixture.page.viewer.textContent.includes("TYPED") &&
    fixture.control.tab.content === fixture.control.saved,
  "Actual edit wait accepts the painted dirty live editor before a genuine cache fold");
  const changes = [
    ["owner", f => { f.control.owner.documentRef += "changed"; }],
    ["path", f => { f.page.currentFilePath += ".changed"; }],
    ["cache", f => { f.control.tab.content += "changed"; }],
    ["cached dirty witness", f => { f.control.tab.hasUnsavedChanges = true; }],
    ["saved baseline", f => { f.control.tab.originalContent += "changed"; }],
    ["renderer baseline", f => { f.page.originalMarkdown += "changed"; }],
    ["disk version", f => { f.control.tab.diskVersion.size = 9; }],
    ["descriptor", f => { f.control.descriptor.ref += "changed"; }],
    ["maintained state witness", f => { f.control.state.dirty = true; }],
    ["selection", f => { f.control.selection++; }],
    ["pending revision", f => { f.control.pending.revision++; }],
    ["Main ownership", f => { f.control.query.known = false; }],
  ];
  for (const phase of ["before input", "after input"]) {
    for (const [label, mutate] of changes) {
      const f = pageFixture(), { control, page } = f;
      control.tab.content = control.saved; control.tab.hasUnsavedChanges = false;
      control.state.dirty = false;
      page.markdownEditor.value = control.saved; page.hasUnsavedChanges = false;
      installOrdinaryInput(f);
      let dispatched = 0;
      const dispatch = page.markdownEditor.dispatchEvent;
      page.markdownEditor.dispatchEvent = event => {
        dispatched++; dispatch(event);
        if (phase === "after input") mutate(f);
      };
      const api = await loadHelpers(f, () => {}, phase === "before input" ? mutate : () => {});
      await assert.rejects(api.editDefaultSaveDocument(control.typed, "TYPED"));
      check(dispatched === (phase === "before input" ? 0 : 1),
        "Actual edit helper refuses changed " + label + " " + phase);
    }
  }
}

async function liveConsentContract() {
  const fixture = pageFixture();
  fixture.control.tab.content = fixture.control.saved;
  fixture.control.tab.hasUnsavedChanges = false;
  fixture.control.state.dirty = false;
  fixture.page.markdownEditor.value = fixture.control.saved;
  fixture.page.hasUnsavedChanges = false;
  installOrdinaryInput(fixture);
  const api = await loadHelpers(fixture);
  await api.editDefaultSaveDocument(fixture.control.typed, "TYPED");
  await api.discardDefaultSaveEdit(fixture.control.typed, "unfolded live editor", "SAVED");
  check(fixture.control.exits === 1 && fixture.control.approved === 1 &&
    fixture.page.originalMarkdown === fixture.control.saved &&
    fixture.page.markdownEditor.value === fixture.control.saved,
  "Owned consent checks live dirty bytes without requiring an eager cache fold");
}

async function switchPermissionContracts() {
  const body = between(source, '  const s8bCachedA = await editDefaultSaveDocument(',
    "  const secondTabArrival = await readDefaultSaveDocument();");
  const run = async fold => {
    const fixture = pageFixture(), { control, page, context } = fixture;
    control.saved = "# Alpha\n\nSAVED\n";
    control.tab.content = control.tab.originalContent = control.saved;
    control.tab.hasUnsavedChanges = false; control.state.dirty = false;
    page.markdownEditor.value = page.originalMarkdown = control.saved;
    page.hasUnsavedChanges = false;
    const beta = { id: 22, filePath: "C:\\fixture\\beta.md", content: "BETA",
      originalContent: "BETA", hasUnsavedChanges: false };
    let active = control.tab;
    page.CustomTabs.getTabs = () => [control.tab, beta];
    page.CustomTabs.getActiveTab = () => active;
    installOrdinaryInput(fixture);
    const api = await loadHelpers(fixture);
    const outcome = await vm.runInNewContext(`(async () => {
      ${body}
      return { s8bCachedA, s8bDirtyA, s8bFoldedA, permission: scenario8bDiscardPermission };
    })()`, {
      ...api, tabC: 21, saveTabB: 22, fileA: control.tab.filePath,
      saveIdentityFields: identityFields, scenario8bDiscardPermission: null,
      defaultMainOwns: async () => true,
      exec: async script => clone(await vm.runInContext(script, context)),
      check: (_name, condition) => assert.ok(condition),
      switchToTabAndWait: async id => {
        assert.equal(id, 22);
        assert.equal(control.tab.content, control.saved, "Input must not eagerly mirror the cache");
        if (fold) {
          control.tab.content = page.markdownEditor.value;
          control.tab.hasUnsavedChanges = control.state.dirty = true;
        }
        active = beta; page.currentFilePath = beta.filePath;
        page.isEditMode = false; page.hasUnsavedChanges = false;
        page.originalMarkdown = page.markdownEditor.value = beta.content;
      },
    });
    return outcome;
  };
  const folded = await run(true);
  check(folded.s8bCachedA.tab.content === "# Alpha\n\nSAVED\n" &&
    folded.s8bDirtyA.tab.content === folded.s8bCachedA.tab.content &&
    folded.s8bDirtyA.editor === "# Alpha\n\nS8B_ON_A\n" &&
    folded.permission.content === folded.s8bDirtyA.editor &&
    folded.s8bFoldedA.tab.content === folded.permission.content &&
    folded.s8bFoldedA.tab.dirty === true,
  "Actual S8b captures live permission independently, then proves the accepted switch fold");
  await assert.rejects(run(false));
  check(true, "Actual S8b rejects a switch that did not fold Alpha's dirty live editor");
}

async function questionObserverContracts() {
  const installation = execBody(observerStart, "  let defaultSaveFailure = null;");
  const tail = between(source, "  } catch (error) {\n    defaultSaveFailure = error;",
    "\n\n  const errors = await exec(`window.__e2eErrors || []`);");
  const make = async () => {
    const fixture = pageFixture();
    let delivery, disconnected = 0, disconnectError = null;
    fixture.page.MutationObserver = function (callback) {
      delivery = callback;
      this.observe = (target, options) => {
        assert.equal(target, fixture.control.elements.appMessageDialog);
        assert.equal(options.attributeOldValue, true);
      };
      this.disconnect = () => {
        disconnected++;
        if (disconnectError) throw disconnectError;
      };
    };
    await vm.runInContext(installation, fixture.context);
    const probe = fixture.page.__defaultSaveQuestions;
    return {
      fixture, probe, delivery: records => delivery(records),
      disconnected: () => disconnected,
      failDisconnect: error => { disconnectError = error; },
      finish: (primary, fail = primary !== null) => vm.runInNewContext(`(async () => {
        let defaultSaveFailure = null;
        let defaultSaveFailed = false;
        try { if (fail) throw primary;
        ${tail}
        return 'completed';
      })()`, {
        primary, fail,
        exec: async script => vm.runInContext(script, fixture.context),
      }),
    };
  };
  const healthy = await make(), dialog = healthy.fixture.control.elements.appMessageDialog;
  dialog.open = true;
  healthy.delivery([{ target: dialog, attributeName: "open", oldValue: null }]);
  check(healthy.probe.questions.length === 1 &&
    healthy.probe.questions[0].title === "Discard unsaved changes?",
  "Actual passive observer records a healthy owned open question");
  dialog.open = false;
  healthy.delivery([
    { target: dialog, attributeName: "open", oldValue: null },
    { target: dialog, attributeName: "open", oldValue: "" },
  ]);
  check(healthy.probe.questions.length === 2,
    "Actual passive observer records open+close before delivery, not only currently-open dialogs");
  healthy.delivery([
    { target: dialog, attributeName: "open", oldValue: "" },
    { target: {}, attributeName: "open", oldValue: null },
  ]);
  check(healthy.probe.questions.length === 2, "Repeated open attributes and foreign targets are not openings");
  check(await healthy.finish(null) === "completed" && healthy.disconnected() === 1 &&
    !Object.hasOwn(healthy.fixture.page, "__defaultSaveQuestions"),
  "Actual owned observation cleanup disconnects and removes only its installation");
  const primaryOnly = await make(), primary = new Error("primary sentinel");
  await assert.rejects(primaryOnly.finish(primary), error => error === primary);
  check(primaryOnly.disconnected() === 1, "Successful cleanup preserves the original primary failure");
  for (const kind of ["foreign", "copied owner", "forged owner", "missing observer",
    "unreadable observer", "unreadable slot", "lost installation"]) {
    const fixture = await make(), page = fixture.fixture.page;
    let foreignDisconnected = 0, getterCalls = 0;
    let retained = fixture.probe;
    if (kind === "foreign") {
      retained = page.__defaultSaveQuestions = {
        observer: { disconnect() { foreignDisconnected++; } },
      };
    } else if (kind === "copied owner") {
      retained = page.__defaultSaveQuestions = { observer: fixture.probe.observer,
        owner: fixture.probe.owner };
    } else if (kind === "forged owner") {
      retained = page.__defaultSaveQuestions = { observer: fixture.probe.observer,
        owner: Object.freeze({ cleanup() { foreignDisconnected++; return true; } }) };
    } else if (kind === "missing observer") delete fixture.probe.observer;
    else if (kind === "unreadable observer") {
      Object.defineProperty(fixture.probe, "observer", {
        get() { getterCalls++; throw new Error("unreadable observer"); }, configurable: true,
      });
    } else if (kind === "unreadable slot") {
      Object.defineProperty(page, "__defaultSaveQuestions", {
        get() { getterCalls++; throw new Error("unreadable slot"); }, configurable: true,
      });
    } else vm.runInContext("__defaultSaveQuestionInstallation = null", fixture.fixture.context);
    await assert.rejects(fixture.finish(primary), error =>
      error.name === "AggregateError" && error.errors.length === 2 &&
      error.errors[0] === primary && !!error.errors[1]);
    check(Object.hasOwn(page, "__defaultSaveQuestions") && foreignDisconnected === 0 &&
      getterCalls === 0 && (kind === "unreadable slot" ||
        Object.getOwnPropertyDescriptor(page, "__defaultSaveQuestions").value === retained),
    "Actual cleanup retains primary+cleanup failures and does not erase/invoke " + kind);
  }
  const failed = await make(), cleanupFailure = new Error("disconnect sentinel");
  failed.failDisconnect(cleanupFailure);
  await assert.rejects(failed.finish(primary), error =>
    error.name === "AggregateError" && error.errors[0] === primary &&
    error.errors[1].errors[0] === cleanupFailure);
  check(Object.hasOwn(failed.fixture.page, "__defaultSaveQuestions"),
    "Independent disconnect failure is aggregated explicitly, not logged away or erased");
  const cleanupOnly = await make();
  cleanupOnly.failDisconnect(cleanupFailure);
  await assert.rejects(cleanupOnly.finish(null), error =>
    error.name === "AggregateError" && error.errors[0] === cleanupFailure);
  check(true, "Cleanup failure is independently fatal without a primary error");
  for (const value of [null, undefined, false, 0, ""]) {
    const falsy = await make();
    falsy.failDisconnect(cleanupFailure);
    await assert.rejects(falsy.finish(value, true), error =>
      error.name === "AggregateError" && Object.is(error.errors[0], value) &&
      error.errors[1].errors[0] === cleanupFailure);
    check(true, "Even a falsy thrown primary remains explicit alongside cleanup failure: " + String(value));
  }
}

const lazyHelpers = between(source, "async function nativeInactiveFixtureReceipts(",
  "async function runEarlyNativeLargeTabGuard(");
const lazyCaller = between(source, '  const fileBig = path.join(dir, "guard-big.md");',
  "  // Vacuity guards.");
const lazyChecks = between(source, "  // Vacuity guards.",
  "  // ---- Scenario 11:");
const inactiveReloadCaller = between(source,
  '  await clearFixtureTabs("reload-ownership preflight");',
  "  const reloadDisk = fs.readFileSync(fileA");
const exactLargeReceiptSource = between(source, "function exactLargeRenderReceipt(",
  "async function withEarlyLargeRenderFault(");
const answerLargeSource = between(source, "async function answerLargeRenderQuestion(",
  "async function runLargeRenderBoundary(");

function lazyNativeFixture(options = {}) {
  const { EventEmitter } = require("node:events");
  const isDeepStrictEqual = require("node:util").isDeepStrictEqual;
  const root = path.join(__dirname, "source-native-lazy-fixtures");
  const files = new Map(), admissions = new Map(), grants = new Map();
  const owners = [], tabs = [], calls = [], restores = [], closed = [];
  const state = { renderer: "ready", pendingId: 0, rendererGeneration: 3,
    rendererPageSession: "source-native-session" };
  const control = { active: null, viewer: "", path: null, question: null,
    choiceRequested: false, choice: deferred(), terminal: [], hostReads: [],
    constructorCalls: [], selections: [], held: [], actorFailures: [], questionAnswers: [] };
  const win = { webContents: new EventEmitter() };
  win.webContents.id = 19;
  win.webContents.mainFrame = {};
  const originalSend = win.webContents.send = (...args) => calls.push(["forwarded", ...args]);
  const chooserOptions = { properties: ["openFile", "multiSelections"], filters: ["source chooser"] };
  const dialog = { showOpenDialog: async () => { throw new Error("Unowned native chooser"); } };
  const originalChooser = dialog.showOpenDialog;
  const dialogSafety = { expected: null };
  const ownedDialogFile = path.join(root, "dialog.html"), ownedDialogUrl = "source://owned-dialog";
  const sourceId = require("node:url").pathToFileURL(path.resolve(__dirname, "../src/custom-tabs.js")).href;
  let sequence = 0, largeObservation, nativeObserver;
  const receipt = filePath => {
    const ref = (++sequence).toString(16).padStart(64, "0");
    const content = files.get(filePath);
    const diskVersion = { dev: 1, ino: sequence, size: Buffer.byteLength(content),
      mtimeMs: 100 + sequence, ctimeMs: 200 + sequence };
    const entry = { path: filePath, content, modifiedTime: diskVersion.mtimeMs, diskVersion,
      document: { ref, logicalPath: filePath, readTarget: filePath,
        pathKey: filePath, diskVersion } };
    admissions.set(ref, entry);
    return entry;
  };
  const identity = tab => tab && ({ pageSession: state.rendererPageSession,
    rendererGeneration: state.rendererGeneration, tabId: tab.id,
    documentGeneration: tab.id, pathKey: tab.filePath, documentRef: tab.ref });
  const recordQuestion = request => {
    const record = { owner: true, frame: true, sender: win.webContents,
      senderFrame: win.webContents.mainFrame, senderId: 19, generation: 3,
      pageSession: state.rendererPageSession, rawKeys: ["name", "seconds"], raw: request,
      settled: options.earlyQuestionReply === true && control.question === null };
    largeObservation.records.push(record);
    return record;
  };
  class Host extends EventEmitter {
    constructor(request, record, bridge) {
      super();
      this.destroyed = false;
      this.request = request; this.record = record; this.bridge = bridge;
      const choose = choice => {
        record.settled = true; record.reply = choice === "0";
        const producer = dialogSafety.expected.producerGate;
        producer.resolve({ displayed: true, failed: false, emergency: false,
          cause: "choice", response: Number(choice) });
        bridge.resolve(choice === "0");
        this.destroy();
      };
      const document = {
        activeElement: { dataset: { dialogChoice: "1" } },
        getElementById: id => ({
          appMessageDialog: { open: true }, appMessageTitle: { textContent: "Large document" },
          appMessageText: { textContent: `"${request.name}" may take about ${request.seconds} seconds to display.` },
          appMessageDetail: { textContent: "Markaloo may not respond until the document finishes opening." },
        })[id],
        querySelectorAll: () => [{ textContent: "Open anyway" }, { textContent: "Cancel" }],
        querySelector: selector => ({ click: () => choose(selector.includes('"0"') ? "0" : "1") }),
      };
      const popup = vm.createContext({ document });
      this.webContents = {
        getURL: () => ownedDialogUrl,
        executeJavaScript: async script => {
          if (script.includes(".click(); true")) {
            control.choiceRequested = true;
            await control.choice.promise;
          }
          const result = vm.runInContext(script, popup);
          if (script.includes("title: document.getElementById('appMessageTitle')")) {
            control.constructorBoundary = {
              recordSettled: record.settled,
              producerPending: control.constructorProducer.settled === false,
              terminalCount: control.terminal.length,
              permissionCalls: dialogSafety.expected.calls,
              metadata: clone(result),
            };
          }
          return result;
        },
      };
    }
    loadFile() { return Promise.resolve(); }
    getParentWindow() { return win; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return !this.destroyed; }
    destroy() {
      if (!this.destroyed) {
        this.destroyed = true;
        if (!Object.hasOwn(this.record, "reply")) {
          this.record.settled = true; this.record.reply = false;
        }
        dialogSafety.expected?.producerGate.resolve({ displayed: true, failed: false,
          emergency: false, cause: "host-closed", response: 1 });
        this.bridge.resolve(false);
        this.emit("closed");
      }
    }
  }
  const originalLoad = Host.prototype.loadFile;
  const page = {
    FoliaFileHelpers: require(path.join(producerRoot, "file-helpers.js")),
    getReloadRequestSession: () => state.rendererPageSession,
    document: { getElementById: id => id === "viewer" ? { textContent: control.viewer } : null },
  };
  const accepted = new Set();
  const switchToTab = async id => {
    const tab = tabs.find(candidate => candidate.id === id);
    const verdict = page.FoliaFileHelpers.isLargeDocument(tab.content);
    if (verdict.large && !accepted.has(id) && control.active !== id) {
      const request = { name: path.basename(tab.filePath), seconds: Math.round(verdict.estimatedMs / 1000) };
      const record = recordQuestion(request), bridge = deferred();
      if (control.question) {
        control.question.record = record;
        control.question.bridge = bridge;
      } else {
        const expected = dialogSafety.expected;
        assert.ok(expected, "Constructor must use the existing native owned-question seam");
        expected.calls++;
        expected.producerGate = deferred();
        expected.producer = expected.producerGate.promise;
        const producer = control.constructorProducer = { settled: false };
        expected.producer.then(() => { producer.settled = true; });
        const host = new Host(request, record, bridge);
        await host.loadFile(ownedDialogFile);
      }
      if (!await bridge.promise) {
        const detail = { message: "[CustomTabs] Large tab switch declined: " + request.name,
          sourceId: options.wrongTerminalSource ? "source://foreign.js" : sourceId, lineNumber: 2642 };
        control.terminal.push(detail);
        if (!options.missingTerminal) win.webContents.emit("console-message", detail);
        return;
      }
      accepted.add(id);
    }
    control.active = id; control.path = tab.filePath; control.viewer = tab.content;
    page.currentFilePath = tab.filePath;
    const selection = { channel: "select-file-tracking", replies: 1,
      data: { owner: identity(tab) }, reply: { accepted: true } };
    control.selections.push(selection);
    nativeObserver?.records.push(selection);
    return true;
  };
  page.CustomTabs = {
    createTab(filePath, content, opts = {}) {
      control.constructorCalls.push({ filePath, content, opts });
      const admitted = admissions.get(opts.documentAdmission?.ref);
      if (!admitted || admitted.path !== filePath || admitted.content !== content ||
          opts.modifiedTime !== admitted.modifiedTime ||
          !isDeepStrictEqual(clone(opts.diskVersion), clone(admitted.diskVersion)) ||
          opts.confirmed || opts.verifiedDiskAdoption || opts.reservedIdentity ||
          opts.deferOwnerRegistration) return null;
      const tab = { id: tabs.length + 1, filePath, content, originalContent: content,
        hasUnsavedChanges: false, ref: admitted.document.ref };
      tabs.push(tab);
      owners.push(identity(tab));
      if (opts.activate !== false) {
        const work = switchToTab(tab.id);
        work.catch(error => control.actorFailures.push(error));
      }
      return tab;
    },
    getTabs: () => tabs,
    getActiveTabId: () => control.active,
    getActiveTab: () => tabs.find(tab => tab.id === control.active),
    getDocumentIdentityForTab: id => identity(tabs.find(tab => tab.id === id)),
    switchToTab,
  };
  page.folia = Object.freeze({
    openFileDialog: () => {
      const work = (async () => {
        const result = await dialog.showOpenDialog(win, chooserOptions);
        const primary = receipt(result.filePaths[0]);
        const extraReadGrants = result.filePaths.slice(1).map(filePath => {
          const grant = "actual-grant-" + filePath;
          grants.set(grant, filePath);
          return grant;
        });
        if (options.wrongPrimaryBody) primary.content = "wrong physical body";
        if (options.missingAdmission) delete primary.document;
        win.webContents.send("file-opened", { ...primary, allPaths: result.filePaths, extraReadGrants });
      })();
      control.held.push(work);
    },
    readDialogExtra: request => {
      assert.equal(request.pageSession, state.rendererPageSession);
      assert.equal(request.rendererGeneration, state.rendererGeneration);
      const filePath = grants.get(request.grant);
      assert.ok(filePath, "An actual one-use native extra grant is required");
      grants.delete(request.grant);
      const entry = receipt(filePath);
      if (options.wrongExtraPath) entry.document.logicalPath = root;
      return entry;
    },
    getVersion: () => "source-only",
  });
  page.window = page;
  const context = vm.createContext(page);
  const exec = async script => {
    const result = await vm.runInContext(script, context);
    if (options.ownerDrift && control.choiceRequested && !control.question) state.rendererGeneration++;
    return result;
  };
  const waitUntil = async predicate => {
    for (let turnIndex = 0; turnIndex < 20; turnIndex++) {
      if (await predicate()) return true;
      await turn();
    }
    return false;
  };
  const replaceMethod = (object, key, replacement) => {
    const previous = object[key];
    object[key] = replacement;
    return () => { restores.push(key); object[key] = previous; };
  };
  const scope = {
    fs: { readFileSync(filePath, encoding) {
      assert.equal(encoding, "utf8"); assert.ok(files.has(filePath));
      control.hostReads.push(filePath); return files.get(filePath);
    } },
    path, __dirname, require, isDeepStrictEqual, BrowserWindow: Host, dialog,
    ownedDialogFile, ownedDialogUrl, dialogSafety, replaceMethod, waitUntil,
    boundedDialogWork: async work => await work,
    __shutdown: { state: () => ({ ...state }),
      documentAdmissionIsCurrent: ref => admissions.has(ref) && !options.revokedAdmission,
      documentSessionState: () => ({ owners }) },
    observeEarlyLargeRender: () => {
      largeObservation = { target: win.webContents, frame: win.webContents.mainFrame,
        generation: 3, pageSession: state.rendererPageSession, records: [], unexpected: [],
        restore() { restores.push("large observer"); } };
      return largeObservation;
    },
    observeNativeDocumentPorts: () => {
      nativeObserver = { records: [], restore() { restores.push("selection observer"); } };
      return nativeObserver;
    },
    closeOwnedFixtureTabs: async (_exec, _label, { tabIds }) => {
      closed.push(...tabIds);
      if (options.cleanupFailure) throw new Error("source cleanup sentinel");
    },
  };
  const compiled = vm.compileFunction(exactLargeReceiptSource + answerLargeSource + lazyHelpers +
    "\nreturn { nativeInactiveFixtureReceipts, runNativeLazyTabSizeGuard };", Object.keys(scope))(...Object.values(scope));
  const question = async (choice, _failLoad, _request, operation) => {
    control.question = {};
    const answer = { settled: false };
    const work = exec(operation).then(value => {
      if (options.switchConsumerFailure && choice === "1") {
        throw new Error("original renderer switch failed after its native reply");
      }
      if (options.emptySwitchConsumerFailure && choice === "1") throw "";
      if (options.falseCancelValue && choice === "1") return false;
      if (options.undefinedProceedValue && choice === "0") return undefined;
      return value;
    }).then(
      value => { answer.value = value; answer.settled = true; },
      error => { answer.error = String(error.message || error); answer.settled = true; });
    await turn();
    const pending = !answer.settled && !control.question.record.settled;
    control.question.record.settled = true;
    control.question.record.reply = choice === "0";
    control.question.bridge.resolve(choice === "0");
    await work;
    if (options.missingSwitchResolvedValue && choice === "1") delete answer.value;
    control.questionAnswers.push({ choice, nativeReply: control.question.record.reply, answer });
    control.question = null;
    return { calls: 1, metadata: { pendingBeforeChoice: pending }, answer };
  };
  const write = (filePath, body) => files.set(filePath, body);
  const run = () => vm.compileFunction("return (async () => {\n" + lazyCaller + "\nreturn guard;\n})();",
    ["path", "dir", "write", "runNativeLazyTabSizeGuard", "win", "exec",
      "largeRenderQuestion", "expectedChooserOptions", "switchToTabAndWait"])(
      path, root, write, compiled.runNativeLazyTabSizeGuard, win, exec, question, chooserOptions, switchToTab);
  return { run, compiled, control, page, exec, scope, root, files, owners, closed, restores,
    intact: () => win.webContents.send === originalSend && dialog.showOpenDialog === originalChooser &&
      Host.prototype.loadFile === originalLoad && dialogSafety.expected === null,
    choice: () => control.choice.resolve(), win, chooserOptions, switchToTab, write };
}

function replacementNativeFixture(options = {}) {
  const filePath = path.join(__dirname, "source-replacement.md");
  const body = options.body ?? "F22_DELETED_A_BASE\r\n";
  const replacementBody = options.replacementBody ?? "F22_DELETED_A_EXTERNAL_REPLACEMENT\r\n";
  const originalOwner = { pageSession: "replacement-session", rendererGeneration: 3,
    tabId: 7, documentGeneration: 9, pathKey: filePath, documentRef: "a".repeat(64) };
  let owner = { ...originalOwner }, currentBody = body;
  const pending = deferred(), calls = [], records = [];
  const control = { confirms: 0, cancels: 0, restores: 0, nativeCalls: 0,
    initialReads: 0, originalWork: null, request: null, adoptionRestores: 0 };
  const elements = {
    reloadDocumentDialog: { open: false, matches() { return this.open; } },
    reloadDocumentTitle: { textContent: "Reload document?" },
    reloadDocumentName: { textContent: path.basename(filePath) },
    reloadDocumentReason: { textContent: "The file disappeared and later reappeared with the same name. Are you sure you want to reload it?" },
    reloadDocumentCancel: { textContent: "Cancel", autofocus: true, click() {
      control.cancels++; elements.reloadDocumentDialog.open = false; pending.resolve(false);
    } },
    reloadDocumentConfirm: { textContent: "Reload from disk", listeners: [],
      addEventListener(_name, listener) { this.listeners.push(listener); },
      click() {
        control.confirms++; this.listeners.forEach(listener => listener());
        elements.reloadDocumentDialog.open = false; pending.resolve(true);
      } },
  };
  const document = { getElementById: id => elements[id], activeElement: null };
  const originalConfirm = request => {
    calls.push(request);
    elements.reloadDocumentDialog.open = true;
    document.activeElement = elements.reloadDocumentCancel;
    return pending.promise;
  };
  const page = {
    currentFilePath: filePath, originalMarkdown: body,
    getReloadRequestSession: () => originalOwner.pageSession,
    CustomTabs: { getActiveTabId: () => 7,
      getDocumentIdentityForTab: () => ({ ...owner }),
      getActiveDocumentIdentity: () => ({ ...owner }),
      confirmDocumentReplacement: originalConfirm },
    folia: Object.freeze({}),
    document,
  };
  if (options.holdAdoption) {
    page.__f22ReplacementAdoptionProbe = {
      held: [], enabled: true, restored: false,
      restore() {
        control.adoptionRestores++;
        this.enabled = false;
        this.restored = true;
      },
    };
  }
  page.window = page;
  const context = vm.createContext(page);
  const reload = () => {
    control.nativeCalls++;
    const request = control.request = {
      id: "c".repeat(32), reason: "file-reappeared", expiresAt: Date.now() + 10000,
      fileName: path.basename(filePath), pageSession: originalOwner.pageSession,
      rendererGeneration: originalOwner.rendererGeneration, owner: { ...originalOwner },
    };
    const record = { channel: "commit-document-disk-adoption", replies: 1,
      data: { filePath, oldOwner: { ...originalOwner } },
      reply: { accepted: false, why: "confirmation-required", confirmation: clone(request) } };
    if (options.wrongMainOwner) record.data.oldOwner.documentRef = "b".repeat(64);
    if (options.wrongMainDescriptor) record.reply.confirmation.id = "d".repeat(32);
    if (options.duplicateReply) record.replies = 2;
    if (!options.missingReceipt) records.push(record);
    const work = page.CustomTabs.confirmDocumentReplacement(request);
    control.originalWork = work.then(approved => {
      if (approved) {
        currentBody = page.originalMarkdown = replacementBody;
        const probe = page.__f22ReplacementAdoptionProbe;
        if (probe?.enabled) {
          for (const channel of ["start-file-watching", "set-active-file"]) {
            probe.held.push({ channel, payload: { filePath, adoptDeletion: true } });
          }
        }
      }
      return approved;
    });
  };
  page.reloadCurrentFile = reload;
  const exec = async script => {
    const result = await vm.runInContext(script, context);
    if (options.setupFailure && control.initialReads++ === 0) throw new Error("replacement setup sentinel");
    return result;
  };
  const native = { records, restore() { control.restores++; } };
  const helperSource = between(source,
    "  const observeReplacementDialog = async (filePath, tabId, content) => {",
    "  let deletedAReloadDialog = null;");
  const observe = vm.compileFunction(helperSource + "\nreturn observeReplacementDialog;",
    ["observeNativeDocumentPorts", "win", "exec", "boundedDialogWork", "waitForCondition", "path"])(
      (_win, channels) => {
        assert.deepEqual(channels, ["commit-document-disk-adoption"]);
        return native;
      }, {}, exec, async work => await work,
      async (_exec, predicate) => {
        const answer = await exec(predicate);
        if (options.changedOwner) owner = { ...owner, documentGeneration: 99 };
        if (options.changedSource) page.originalMarkdown = "CHANGED\r\n";
        return answer;
      }, path);
  return { observe, exec, reload, control, page, elements, body, filePath, calls,
    originalConfirm, pending, currentBody: () => currentBody };
}

async function replacementNativeBoundaryContracts() {
  const fixture = replacementNativeFixture();
  const restore = await fixture.observe(fixture.filePath, 7, fixture.body);
  fixture.reload();
  await turn();
  check(fixture.control.nativeCalls === 1 && fixture.calls.length === 1 &&
    fixture.elements.reloadDocumentDialog.open && fixture.control.confirms === 0 &&
    fixture.currentBody() === fixture.body && fixture.page.fs === undefined &&
    fixture.page.ipcRenderer === undefined && fixture.page.require === undefined,
  "Actual replacement observer holds the original default-Cancel dialog after one genuine native receipt without renderer privileges");
  await restore.confirm();
  await fixture.control.originalWork;
  const outcome = await restore();
  check(fixture.currentBody() === "F22_DELETED_A_EXTERNAL_REPLACEMENT\r\n" && fixture.control.confirms === 1 &&
    fixture.control.cancels === 0 && outcome.calls.length === 1 &&
    outcome.calls[0].approved && outcome.calls[0].approvedBeforeReload &&
    outcome.calls[0].confirmClicked && outcome.calls[0].dialogClosed &&
    outcome.calls[0].mismatches.length === 0 && outcome.receipts.length === 1 &&
    outcome.receipts[0].confirmation.id === fixture.control.request.id &&
    fixture.page.CustomTabs.confirmDocumentReplacement === fixture.originalConfirm &&
    !Object.hasOwn(fixture.page, "__f22ReloadConsentProbe") && fixture.control.restores === 1,
  "Actual replacement handshake correlates the Main reply before its sole real Confirm, joins original completion, and restores both halves");
  for (const option of ["wrongMainOwner", "wrongMainDescriptor", "duplicateReply",
    "missingReceipt", "changedOwner", "changedSource"]) {
    const negative = replacementNativeFixture({ [option]: true });
    const cleanup = await negative.observe(negative.filePath, 7, negative.body);
    negative.reload();
    await assert.rejects(cleanup.confirm());
    await negative.control.originalWork;
    const refused = await cleanup();
    check(negative.control.confirms === 0 && negative.control.cancels === 1 &&
      negative.currentBody() === negative.body && refused.calls[0].approved === false &&
      refused.calls[0].mismatches.length > 0 && negative.control.restores === 1 &&
      negative.page.CustomTabs.confirmDocumentReplacement === negative.originalConfirm,
    "Actual replacement handshake refuses " + option + " without adoption and restores the original live confirmation");
  }
  const abandoned = replacementNativeFixture();
  const abandonCleanup = await abandoned.observe(abandoned.filePath, 7, abandoned.body);
  abandoned.reload();
  const cancelled = await abandonCleanup();
  await abandoned.control.originalWork;
  check(abandoned.control.confirms === 0 && abandoned.control.cancels === 1 &&
    cancelled.calls[0].approved === false && abandoned.control.restores === 1,
  "Actual failure cleanup cancels and joins an unanswered original replacement rather than leaking it");
  const failedSetup = replacementNativeFixture({ setupFailure: true });
  await assert.rejects(failedSetup.observe(failedSetup.filePath, 7, failedSetup.body),
    /replacement setup sentinel/);
  check(failedSetup.control.restores === 1 &&
    failedSetup.page.CustomTabs.confirmDocumentReplacement === failedSetup.originalConfirm &&
    !Object.hasOwn(failedSetup.page, "__f22ReloadConsentProbe"),
  "Actual partially-installed replacement setup independently restores Main and page observations before preserving failure");
  const callerFixture = replacementNativeFixture();
  const callerSource = between(source, "  let deletedAReloadDialog = null;",
    "  const replacementAfterExplicitAdoption = ");
  const actualCaller = await vm.compileFunction("return (async () => {\n" + callerSource +
    "\nreturn { explicitReplacementAdopted, deletedAReloadDialog };\n})();",
    ["observeReplacementDialog", "deletedAFile", "deletedA", "exec", "waitForCondition"])(
      callerFixture.observe, callerFixture.filePath, { id: 7 }, callerFixture.exec,
      async (_exec, predicate) => {
        for (let index = 0; index < 20; index++) {
          if (await callerFixture.exec(predicate)) return true;
          await turn();
        }
        return false;
      });
  check(actualCaller.explicitReplacementAdopted === true &&
    actualCaller.deletedAReloadDialog.calls[0].confirmClicked &&
    callerFixture.control.confirms === 1 && callerFixture.control.restores === 1 &&
    callerFixture.page.CustomTabs.confirmDocumentReplacement === callerFixture.originalConfirm,
  "Actual explicit-replacement caller answers the original native consent then joins its unchanged reload and cleanup");
  const secondCallerFixture = replacementNativeFixture({
    body: "F22_DELETED_REPLACEMENT_OLD\r\n",
    replacementBody: "F22_DELETED_REPLACEMENT_NEW\r\n", holdAdoption: true,
  });
  const secondCallerSource = between(source, "  let replacementReloaded = false;",
    "  const replacementBefore = await deletionTabSnapshot(replacementDeletedA.id);");
  let adoptionWaits = 0;
  const secondCaller = await vm.compileFunction("return (async () => {\n" + secondCallerSource +
    "\nreturn { replacementReloaded, replacementCurrentOwner, replacementAdoption, replacementDialog };\n})();",
    ["observeReplacementDialog", "replacementDeletedFile", "replacementDeletedA", "exec",
      "waitForCondition", "consoleAttribution", "replacementHeldIdentity"])(
      secondCallerFixture.observe, secondCallerFixture.filePath, { id: 7 }, secondCallerFixture.exec,
      async (_exec, predicate) => {
        adoptionWaits++;
        for (let index = 0; index < 20; index++) {
          if (await secondCallerFixture.exec(predicate)) return true;
          await turn();
        }
        return false;
      }, null, { deliveryId: "held-old-owner" });
  const secondJoined = await secondCallerFixture.control.originalWork;
  check(adoptionWaits === 1 && secondJoined === true &&
    secondCaller.replacementReloaded === true &&
    secondCaller.replacementCurrentOwner.tabId === 7 &&
    secondCaller.replacementDialog.calls.length === 1 &&
    secondCaller.replacementDialog.calls[0].confirmClicked &&
    secondCallerFixture.control.nativeCalls === 1 &&
    secondCallerFixture.control.confirms === 1 && secondCallerFixture.control.cancels === 0 &&
    secondCallerFixture.control.restores === 1 &&
    secondCallerFixture.page.CustomTabs.confirmDocumentReplacement === secondCallerFixture.originalConfirm &&
    secondCallerFixture.currentBody() === "F22_DELETED_REPLACEMENT_NEW\r\n" &&
    secondCaller.replacementAdoption.held.map(record => record.channel).join(",") ===
      "start-file-watching,set-active-file" &&
    secondCaller.replacementAdoption.held.every(record => record.payload.adoptDeletion === true) &&
    secondCallerFixture.control.adoptionRestores === 1 &&
    secondCallerFixture.page.__f22ReplacementAdoptionProbe.restored === true,
  "Actual second replacement-owner caller confirms before its unchanged adoption wait, joins original completion, and preserves held-adoption cleanup");
}

async function ordinarySuffixBoundaryContracts() {
  const owner = { pageSession: "suffix-session", rendererGeneration: 3, tabId: 7,
    documentGeneration: 9, pathKey: "alpha.md", documentRef: "a".repeat(64) };
  const baseline = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 };
  let live = { ...baseline }, refusal = null;
  const requests = [];
  const page = { CustomTabs: { getTabs: () => [{ id: 7, diskVersion: baseline }] },
    folia: Object.freeze({ checkOwnedTabDiskSnapshot(request) {
      requests.push(clone(request));
      return refusal || { matches: true, pathKey: owner.pathKey, diskVersion: { ...live } };
    } }) };
  const diskHelper = between(source, "    const f22DiskVersion = (filePath) => {",
    "    // A result is THIS request's result");
  const diskVersion = vm.compileFunction(diskHelper + "\nreturn f22DiskVersion;",
    ["window", "f22ActiveOwner"])(page, () => ({ ...owner }));
  const first = diskVersion("alpha.md");
  live = { ...live, ctimeMs: 17 };
  const second = diskVersion("alpha.md");
  check(first.ctimeMs === 5 && second.ctimeMs === 17 && requests.length === 2 &&
    ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(field => second[field] === live[field]) &&
    requests.every(request => request.filePath === "alpha.md" &&
      request.pageSession === owner.pageSession &&
      request.rendererGeneration === owner.rendererGeneration &&
      identityFields.every(field => request.owner[field] === owner[field]) &&
      JSON.stringify(request.diskVersion) === JSON.stringify(baseline)),
  "Actual F22 pre-click helper makes fresh full-identity native checks and retains live ctime-only metadata changes");
  for (const bad of [
    { matches: false, why: "stale-owner" },
    { matches: true, pathKey: "foreign.md", diskVersion: live },
    { matches: true, pathKey: owner.pathKey, diskVersion: { ...live, ino: 99 } },
    { matches: true, pathKey: owner.pathKey, diskVersion: { ...live, ctimeMs: NaN } },
    { matches: true, pathKey: owner.pathKey, diskVersion: null },
  ]) {
    refusal = bad;
    assert.throws(() => diskVersion("alpha.md"));
    check(true, "Actual F22 native metadata refusal cannot fall back to cached version: " + JSON.stringify(bad));
  }
  const missingOwner = vm.compileFunction(diskHelper + "\nreturn f22DiskVersion;",
    ["window", "f22ActiveOwner"])(page, () => null);
  assert.throws(() => missingOwner("alpha.md"));
  check(page.fs === undefined, "Actual pre-click helper rejects missing ownership without renderer fs or static stats");

  const orderedSource = between(source, "  const orderedSnapshot = async (expectedPendingSaves = null) => {",
    "  const stableOrderedSnapshot = ");
  const tab = { id: 7, content: "EDITOR", originalContent: "BASE", hasUnsavedChanges: true };
  const orderedPage = {
    CustomTabs: { getTabs: () => [tab], getActiveTabId: () => 7,
      __documentState: () => ({ dirty: true }), __inEditMode: () => true,
      __dirtyTabNames: () => ["alpha.md"], getActiveDocumentIdentity: () => owner },
    originalMarkdown: "EDITOR", markdownEditor: { value: "EDITOR" },
    getReloadRequestDiagnostics: () => ({ pending: 0 }),
    getPendingSaveStatus: () => ({ count: 0, pending: false, paths: [] }),
    getReloadRequestSession: () => owner.pageSession,
    __f22OrderedSaveProbe: { alerts: [], controls: [], notifications: [],
      saveSettlementEvents: [], saveResultObservations: [] },
    document: { getElementById: () => null },
    saveFailedFor: () => 0,
  };
  orderedPage.window = orderedPage;
  const orderedContext = vm.createContext(orderedPage);
  let physical = "FIRST\r\n", reads = 0;
  const orderedSnapshot = vm.compileFunction(orderedSource + "\nreturn orderedSnapshot;",
    ["fs", "orderedSaveFile", "orderedSaveTab", "exec"])({
      readFileSync(filePath, encoding) {
        assert.equal(filePath, "ordered.md"); assert.equal(encoding, "utf8");
        reads++; return physical;
      },
    }, "ordered.md", tab, async script => vm.runInContext(script, orderedContext));
  const firstOrdered = await orderedSnapshot();
  physical = "SECOND\r\n";
  const secondOrdered = await orderedSnapshot();
  check(reads === 2 && firstOrdered.disk === "FIRST\r\n" && secondOrdered.disk === "SECOND\r\n" &&
    firstOrdered.content === "EDITOR" && secondOrdered.original === "BASE" &&
    firstOrdered.documentState.dirty && orderedPage.fs === undefined,
  "Actual ordered Save snapshot reads exact fresh physical bytes in the host and retains independent renderer state");

  const companionSource = between(source, "  const frozenDeletedA = await createActiveTab(",
    "  const frozenAInitial = ");
  let selectedGeneration = 0;
  const trace = [];
  const companion = await vm.compileFunction("return (async () => {\n" + companionSource +
    "\nreturn { frozenDeletedA, frozenDeletedB, frozenSelectedOwner };\n})();",
    ["createActiveTab", "createCompanionTab", "acceptedSelectionWitness",
      "frozenDeletedFile", "deletedBFile"])(
      async () => { trace.push("admit A"); selectedGeneration++; return { id: 1 }; },
      async (primary, filePath, body) => {
        assert.equal(primary.id, 1); assert.equal(filePath, "B.md");
        assert.equal(body, "F22_DELETED_B_BASE\r\n");
        trace.push("admit B", "restore A"); selectedGeneration += 2;
        return { id: 2 };
      },
      async (filePath, id) => {
        assert.equal(filePath, "A.md"); assert.equal(id, 1);
        trace.push("capture actual A acceptance");
        return { owner: { ...owner, selectionGeneration: selectedGeneration } };
      }, "A.md", "B.md");
  check(companion.frozenDeletedB.id === 2 && companion.frozenSelectedOwner.selectionGeneration === 3 &&
    trace.join(",") === "admit A,admit B,restore A,capture actual A acceptance",
  "Actual frozen-deletion setup genuinely admits its companion then captures fresh Main selection after restoration");
}

async function lazyNativeBoundaryContracts() {
  const fixture = lazyNativeFixture();
  let completed = false;
  let guard;
  let operationError;
  const work = fixture.run().then(
    result => { completed = true; guard = result; },
    error => { completed = true; operationError = error; },
  );
  for (let index = 0; !fixture.control.choiceRequested && !completed && index < 20; index++) await turn();
  if (operationError) throw operationError;
  check(fixture.control.choiceRequested && !completed &&
    fixture.control.constructorCalls.length === 2 &&
    fixture.page.fs === undefined && fixture.page.ipcRenderer === undefined &&
    fixture.page.require === undefined && Object.isFrozen(fixture.page.folia),
  "Actual S10 boundary reaches a pending constructor question without renderer filesystem raw IPC or require");
  check(fixture.control.active === 1 && fixture.control.viewer.includes("GUARD_SMALL_DOC") &&
    fixture.control.selections.length === 1 && fixture.control.terminal.length === 0,
  "Held original constructor permission cannot select or repaint the expensive tab before the real choice");
  check(fixture.control.constructorCalls[0].opts.activate === false &&
    fixture.control.constructorCalls[1].opts.activate === undefined &&
    fixture.control.constructorCalls.every(call => call.opts.documentAdmission &&
      !call.opts.confirmed && !call.opts.verifiedDiskAdoption),
  "Actual ordinary and default-activation large constructors use genuine unbound receipts without cached approval");
  fixture.choice();
  await work;
  if (operationError) throw operationError;
  check(fixture.control.questionAnswers.length === 2 &&
    fixture.control.questionAnswers.every(({ answer }) => answer.settled === true &&
      Object.hasOwn(answer, "value") && !Object.hasOwn(answer, "error")) &&
    fixture.control.questionAnswers[0].nativeReply === false &&
    fixture.control.questionAnswers[0].answer.value === undefined &&
    fixture.control.questionAnswers[1].nativeReply === true &&
    fixture.control.questionAnswers[1].answer.value === true,
  "Actual S10 distinguishes native false/true permission from outer undefined/true switch completion without synthetic rejection members");
  check(fixture.intact() && fixture.closed.join(",") === "1,2" &&
    fixture.restores.includes("large observer") && fixture.restores.includes("selection observer") &&
    fixture.control.actorFailures.length === 0 && fixture.control.hostReads.length === 4,
  "Actual S10 joins owned native choice and terminal consumer, retires both real tabs, and restores every observer");
  const judge = output => {
    const assertions = [];
    vm.compileFunction(lazyChecks, ["guard", "check"])(output,
      (name, success) => assertions.push({ name, success }));
    return assertions;
  };
  const assertions = judge(guard);
  const names = [
    "the guard sample really is scored as expensive and the control is not",
    "an ordinary document is never asked about",
    "opening an expensive file asks, and declining leaves the reader put",
    "switching to an expensive tab asks first",
    "declining leaves the reader on the tab they were viewing",
    "declining leaves the document they were reading on screen",
    "accepting switches to the expensive tab",
    "a cost already accepted is not asked about again",
  ];
  check(assertions.length === 8 && assertions.every((item, index) => item.success && item.name === names[index]),
    "Actual S10 caller retains and satisfies all eight distinct original assertions including create-time decline");
  for (const [index, field, value] of [
    [0, "bigIsLarge", false], [1, "askedForSmall", 1], [2, "askedOnCreate", 0],
    [3, "askedOnDecline", 0], [4, "activeAfterDecline", false],
    [5, "viewerAfterDecline", false], [6, "askedOnAccept", 0], [7, "askedOnRevisit", 1],
  ]) {
    const failed = judge({ ...guard, [field]: value }).filter(item => !item.success);
    check(failed.length === 1 && failed[0].name === names[index],
      "Actual original S10 oracle rejects exactly its missing obligation: " + field);
  }
  for (const option of ["missingAdmission", "wrongPrimaryBody", "wrongExtraPath",
    "revokedAdmission", "missingTerminal", "wrongTerminalSource", "earlyQuestionReply",
    "ownerDrift", "switchConsumerFailure", "emptySwitchConsumerFailure",
    "missingSwitchResolvedValue", "cleanupFailure"]) {
    const negative = lazyNativeFixture({ [option]: true });
    negative.choice();
    const switchAnswerCase = ["switchConsumerFailure", "emptySwitchConsumerFailure",
      "missingSwitchResolvedValue"].includes(option);
    await assert.rejects(negative.run(), switchAnswerCase
      ? /Explicit lazy switch lacks its genuine pending question and chosen completion/
      : option === "earlyQuestionReply"
        ? /Constructor question lacks its pending original Main producer and exact Cancel-default receipt/
        : undefined);
    if (option === "earlyQuestionReply") {
      const boundary = negative.control.constructorBoundary;
      assert.equal(boundary.recordSettled, true);
      assert.equal(boundary.producerPending, true);
      assert.equal(boundary.terminalCount, 0);
      assert.equal(boundary.permissionCalls, 1);
      assert.equal(boundary.metadata.title, "Large document");
      assert.equal(boundary.metadata.buttons.join(","), "Open anyway,Cancel");
      assert.equal(boundary.metadata.focused, "1");
      assert.equal(negative.control.choiceRequested, false);
      assert.equal(negative.control.questionAnswers.length, 0);
    }
    if (switchAnswerCase) {
      assert.equal(negative.control.questionAnswers.length, 1);
      const answer = negative.control.questionAnswers[0].answer;
      assert.equal(answer.settled, true);
      assert.equal(Object.hasOwn(answer, "value"), false);
      assert.equal(Object.hasOwn(answer, "error"), option !== "missingSwitchResolvedValue");
      if (option !== "missingSwitchResolvedValue") {
        assert.equal(answer.error, option === "emptySwitchConsumerFailure" ? "" :
          "original renderer switch failed after its native reply");
      }
    }
    check(negative.intact(), "Actual S10 refuses " + option + " and restores its owned native slots");
  }
  for (const option of ["falseCancelValue", "undefinedProceedValue"]) {
    const wrongValue = lazyNativeFixture({ [option]: true });
    wrongValue.choice();
    await assert.rejects(wrongValue.run(),
      /Explicit lazy switch lacks its genuine pending question and chosen completion/);
    const answer = wrongValue.control.questionAnswers.at(-1);
    const proceed = option === "undefinedProceedValue";
    check(wrongValue.intact() && wrongValue.control.questionAnswers.length === (proceed ? 2 : 1) &&
      answer.choice === (proceed ? "0" : "1") && answer.nativeReply === proceed &&
      answer.answer.settled === true && Object.hasOwn(answer.answer, "value") &&
      !Object.hasOwn(answer.answer, "error") &&
      answer.answer.value === (proceed ? undefined : false),
    "Actual S10 rejects wrong outer " + option + " while retaining the genuine native permission result");
  }
  const inactive = lazyNativeFixture();
  const fileA = path.join(inactive.root, "alpha.md");
  inactive.write(fileA, "# Alpha\n\nACTUAL_INACTIVE_DISK\n");
  const nativeChecks = [];
  const nativeRun = vm.compileFunction("return (async () => {\n" + inactiveReloadCaller + "\n})();",
    ["clearFixtureTabs", "nativeInactiveFixtureReceipts", "win", "exec", "fileA",
      "expectedChooserOptions", "__shutdown", "check", "switchToTabAndWait"])(
      async () => {}, inactive.compiled.nativeInactiveFixtureReceipts, inactive.win, inactive.exec,
      fileA, inactive.chooserOptions, inactive.scope.__shutdown,
      (name, success) => nativeChecks.push({ name, success }),
      async id => {
        check(inactive.control.active === null && inactive.control.selections.length === 0 &&
          inactive.owners.length === 1,
        "Actual reload-ownership caller admits its inactive tab before the unchanged explicit selection");
        return inactive.switchToTab(id);
      });
  await nativeRun;
  check(nativeChecks.length === 1 && nativeChecks[0].success && inactive.intact() &&
    inactive.control.active === 1 && inactive.control.viewer.includes("ACTUAL_INACTIVE_DISK"),
  "Actual reload-ownership caller preserves genuine Main admission and original explicit selected-disk setup");
}

async function reloadRecoveryBoundaryContracts() {
  const actor = between(source, "      recoveryRequest = await exec(`",
    "\n      recoverySettled =");
  const acceptance = between(source, "      recoverySettled =",
    "\n        await waitForCondition(");
  const accepts = vm.compileFunction(
    "let recoverySettled;\n" + acceptance + "true;\nreturn recoverySettled;",
    ["recoveryRequest"]);
  const producer = between(customTabs, "  async function requestReloadWithConfirmation() {",
    "\n  async function reloadFromUpdatePrompt(");
  const confirmation = between(customTabs, "  function captureDialogContext(",
    "\n  function bumpTabMutationRevision(");
  const fixture = (options = {}) => {
    const gate = deferred();
    const control = { requests: 0, dispatches: 0, sequence: 1, presentations: [],
      clicks: [], observers: [], records: [], settled: false, renders: [] };
    const tab = { id: 21, filePath: "C:\\fixture\\alpha.md", content: "DIRTY",
      originalContent: "SAVED", hasUnsavedChanges: true };
    const state = { mutationRevision: 1 };
    const dialog = { open: false };
    const elements = { appMessageDialog: dialog, appMessageTitle: {}, appMessageText: {} };
    const document = { documentElement: {}, activeElement: null,
      getElementById: id => elements[id],
      querySelectorAll: selector => {
        assert.equal(selector, "#appMessageButtons [data-dialog-choice]");
        return control.buttons || [];
      },
      querySelector: selector => {
        const choice = selector.match(/^\#appMessageButtons \[data-dialog-choice="(cancel|proceed)"\]$/)?.[1];
        assert.ok(choice, "Only the genuine question's explicit choice is clickable");
        return control.buttons.find(button => button.dataset.dialogChoice === choice);
      } };
    const page = {
      confirm: () => { throw new Error("Retired synchronous confirmation was called"); },
      renderMarkdown: text => { control.renders.push(text); return Promise.resolve(); },
      getPendingSaveStatus: () => ({ pending: false, revision: 1 }),
      getReloadRequestSession: () => "recovery-page",
      getLatestReloadRequestSequence: () => control.sequence,
      getActiveFileSelectionGeneration: () => 1,
      requestCurrentFileReload: () => {
        control.dispatches++;
        control.sequence++;
        return true;
      },
      MarkalooDialogs: { show: settings => {
        control.presentations.push(settings);
        elements.appMessageTitle.textContent = settings.title;
        elements.appMessageText.textContent = options.wrongQuestion ? "Unrelated question" : settings.message;
        control.buttons = settings.buttons.map(button => ({
          dataset: { dialogChoice: button.id }, textContent: button.label,
          click: () => {
            control.clicks.push({ choice: button.id, beforeDispatch: control.dispatches,
              beforeSettlement: control.settled });
            dialog.open = false;
            control.records.push({ target: dialog, oldValue: "" });
          },
        }));
        document.activeElement = control.buttons[options.wrongDefault ? 1 : 0];
        dialog.open = true;
        control.records.push({ target: dialog, oldValue: null });
        if (options.duplicate) control.records.push({ target: dialog, oldValue: null });
        return gate.promise;
      } },
      CustomTabs: { __reloadState: () => ({ acceptedSequence: control.sequence }) },
    };
    const context = vm.createContext({ window: page, document, console,
      MutationObserver: function () {
        const record = { observed: 0, disconnected: 0 };
        control.observers.push(record);
        this.observe = (target, settings) => {
          record.observed++;
          assert.equal(target, document.documentElement);
          assert.equal(settings.attributeOldValue, true);
          assert.equal(settings.subtree, true);
          assert.deepEqual(Array.from(settings.attributeFilter), ["open"]);
          if (options.observeError) throw new Error("recovery observer setup failed");
        };
        this.takeRecords = () => control.records.splice(0);
        this.disconnect = () => { record.disconnected++; };
      },
      tabs: [tab], activeTabId: tab.id, documentRevision: 1, dialogDecisionIntent: 0,
      approvalRendererGeneration: 1, latestTabSwitchIntent: 0,
      frozenDocumentOperationOverflowCount: 0, pendingConfirmedReload: null,
      documentState: new WeakMap([[tab, state]]),
      isDocumentFrozen: () => false, mayMutateDocument: () => true,
      snapshotActiveTab: () => tab, getActiveTab: () => tab, isDirty: () => true,
      liveDocument: () => tab.content, t: (_key, fallback) => fallback,
      documentIdentity: () => ({ pageSession: "recovery-page", rendererGeneration: 1,
        tabId: tab.id, documentGeneration: 1, pathKey: tab.filePath, documentRef: "owned-alpha" }),
      canonicalTabPath: value => value, notify: () => {},
    });
    vm.runInContext(confirmation + "\n" + producer, context);
    const originalRequest = context.requestReloadWithConfirmation;
    page.CustomTabs.requestReloadWithConfirmation = function () {
      control.requests++;
      const request = originalRequest();
      control.producer = request;
      return request;
    };
    const originalBinding = page.CustomTabs.requestReloadWithConfirmation;
    const originalConfirm = page.confirm;
    const exec = async script => {
      if (options.withoutJoin) {
        const joined = "requested = await recoveryProducer;";
        assert.equal(script.split(joined).length - 1, 1, "The missing-await control changes the actual join");
        script = script.replace(joined, "requested = recoveryProducer;");
      }
      if (options.cancel) {
        const proceed = `[data-dialog-choice="proceed"]').click();`;
        assert.equal(script.split(proceed).length - 1, 1, "The Cancel control changes the actual Proceed click");
        script = script.replace(proceed, `[data-dialog-choice="cancel"]').click();`);
      }
      return structuredClone(await vm.runInContext(script, context));
    };
    const running = vm.compileFunction("return (async () => {\nlet recoveryRequest;\n" +
      actor + "\nreturn recoveryRequest;\n})();", ["exec"])(exec);
    running.then(() => { control.settled = true; }, () => { control.settled = true; });
    return { control, page, context, running, originalRequest,
      release: () => {
        const choice = control.clicks.at(-1)?.choice;
        assert.ok(choice, "The original producer is released only after an actual explicit choice");
        gate.resolve({ cause: "choice", choice });
      },
      intact: () => page.confirm === originalConfirm &&
        page.CustomTabs.requestReloadWithConfirmation === originalBinding &&
        control.observers.length === 1 && control.observers[0].disconnected === 1 };
  };
  const good = fixture();
  await turn();
  if (good.control.settled) await good.running;
  check(good.originalRequest.constructor.name === "AsyncFunction" &&
    typeof good.control.producer?.then === "function" && !good.control.settled &&
    good.control.requests === 1 && good.control.dispatches === 0,
  "Actual recovery actor stays pending on the real async producer after its genuine Proceed click");
  const question = good.control.presentations[0];
  check(good.control.presentations.length === 1 && question.defaultId === "cancel" &&
    question.cancelId === "cancel" && question.title === "Discard unsaved changes?" &&
    question.message === "You have unsaved changes. Reload from disk and discard them?" &&
    question.buttons.map(button => button.label).join("|") === "Cancel|Discard and reload" &&
    good.control.clicks.length === 1 && good.control.clicks[0].choice === "proceed" &&
    good.control.clicks[0].beforeDispatch === 0 && !good.control.clicks[0].beforeSettlement,
  "Actual recovery producer presents one owned Cancel-default question before any reload dispatch");
  good.release();
  const result = await good.running;
  check(result.requested === true && typeof result.requested === "boolean" &&
    result.confirmCalls === 1 && result.confirmPrompt === question.message &&
    result.confirmRestored === true && result.renderProbeInstalled === true &&
    good.control.dispatches === 1 && accepts(result) === true && good.intact(),
  "Actual recovery actor joins the direct producer boolean, crosses structuredClone and restores observation");
  check(good.page.__f22ReloadRecoveryRenderProbe.calls.length === 0 &&
    good.page.renderMarkdown === good.page.__f22ReloadRecoveryRenderProbe.renderWrapper,
  "Recovery question observation preserves the existing real-render probe without inventing a render");
  await good.page.renderMarkdown("ACTUAL_RECOVERY_RENDER");
  await turn();
  check(good.control.renders.join("|") === "ACTUAL_RECOVERY_RENDER" &&
    good.page.__f22ReloadRecoveryRenderProbe.terminal.length === 1 &&
    good.page.__f22ReloadRecoveryRenderProbe.terminal[0].success === true,
  "Existing recovery render probe still delegates and records the actual returned render completion");
  const unjoined = fixture({ withoutJoin: true });
  await assert.rejects(unjoined.running, error => error.name === "DataCloneError");
  check(unjoined.control.requests === 1 && unjoined.control.dispatches === 0 && unjoined.intact(),
  "Returning the old nested producer Promise genuinely fails the renderer structured-clone boundary");
  unjoined.release();
  await unjoined.control.producer;
  for (const option of ["cancel", "stale"]) {
    const refused = fixture({ cancel: option === "cancel" });
    await turn();
    if (option === "stale") refused.context.documentRevision++;
    check(!refused.control.settled && refused.control.dispatches === 0,
      "Recovery " + option + " retains a genuinely unsettled original producer before its decision");
    refused.release();
    const response = await refused.running;
    check(response.requested === false && accepts(response) === false &&
      refused.control.dispatches === 0 && refused.intact(),
    "Actual recovery acceptance refuses " + option + " without a reload or changed request binding");
  }
  for (const option of ["duplicate", "wrongQuestion", "wrongDefault"]) {
    const invalid = fixture({ [option]: true });
    await turn();
    check(invalid.control.requests === 1 && invalid.control.dispatches === 0 &&
      invalid.control.clicks.length === 1 && invalid.control.clicks[0].choice === "cancel" &&
      !invalid.control.settled,
    "Invalid recovery " + option + " cancels its actual question and joins the original producer");
    invalid.release();
    await assert.rejects(invalid.running, /Reload ownership recovery/);
    check(invalid.intact() && invalid.control.dispatches === 0,
      "Invalid recovery " + option + " restores its observer and both original handler identities");
  }
  const setup = fixture({ observeError: true });
  await assert.rejects(setup.running, /recovery observer setup failed/);
  check(setup.control.requests === 0 && setup.control.presentations.length === 0 && setup.intact(),
    "Recovery observer setup failure disconnects without calling the direct producer");
}

(async () => {
  let failures = 0;
  for (const run of [sourceContracts, consentContracts, requestContracts,
    subscriptionContracts, sameTaskContracts, deliveryContracts,
    liveEditorContract, liveConsentContract, switchPermissionContracts, questionObserverContracts,
    inputMenuContracts, defaultFixtureCallerContracts, defaultFixtureOwnerContracts,
    defaultFixtureDiagnosticsContracts, discardHistoryContracts, reloadPreviewContracts,
    lazyNativeBoundaryContracts, ordinarySuffixBoundaryContracts, replacementNativeBoundaryContracts,
    reloadRecoveryBoundaryContracts]) {
    try { await run(); }
    catch (error) {
      failures++;
      console.error("FAIL " + run.name + "  -> " + error.stack);
    }
  }
  console.log(`${checks} source/VM controls passed; ${failures} groups failed; native execution NOT RUN`);
  if (failures) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
