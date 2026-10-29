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

function installOrdinaryInput(fixture) {
  const { page, control, context } = fixture;
  Object.assign(control.state, { saveFailure: false, content: control.tab.content,
    foldedLive: control.tab.content });
  const listeners = [], timers = new Map();
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
    editorScroll: { changed: () => {} },
    unsavedIndicator: { style: {} }, fileTrackingPauseOwner: null,
    isFileTrackingActive: false, fileTrackingResumeHold: 0,
    hasPendingSaveFor: () => false, saveFailedFor: () => false, reloadConflictFor: () => false,
    frozenForShutdown: () => false, normaliseDocumentPath: value => ({ spelling: value.toLowerCase() }),
    assertFileTrackingOwnership: () => { throw new Error("Unexpected tracking resume"); },
    renderMarkdown: content => { page.viewer.textContent = content; },
  });
  const mutation = between(customTabs, "  function bumpTabMutationRevision(",
    "  function bumpDocumentRevision(") +
    between(customTabs, "  function noteActiveContentMutation()",
      "  function confirmedReloadStillCurrent(");
  page.CustomTabs.noteActiveContentMutation = vm.runInContext(`(() => {
    ${mutation}
    return noteActiveContentMutation;
  })()`, context);
  const documentStateReader = between(customTabs, "__documentState: (tab) => {",
    "__reloadState:").replace("__documentState:", "").trim().replace(/,$/, "");
  page.CustomTabs.__documentState = vm.runInContext("(" + documentStateReader + ")", context);
  const inputSource =
    between(renderer, "function normaliseReloadSnapshot(", "function setDocumentDirtyState(") +
    between(renderer, "function setDocumentDirtyState(", "function withFileTrackingResumeHeld(") +
    between(renderer, "function setDocumentDirtyFromContent(", "function currentReloadSnapshot(") +
    between(renderer, "function updateUnsavedIndicator(", "// ============================================\n// RECENT FILES") +
    between(renderer, "// Live preview with fast debounce", "// Sync editor textarea");
  vm.runInContext(inputSource, context, { timeout: 1000 });
  check(listeners.length === 1, "Exact current ordinary preview input producer was installed");
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

function sameTaskContracts() {
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

(async () => {
  let failures = 0;
  for (const run of [sourceContracts, consentContracts, requestContracts,
    subscriptionContracts, sameTaskContracts, deliveryContracts,
    liveEditorContract, liveConsentContract, switchPermissionContracts, questionObserverContracts]) {
    try { await run(); }
    catch (error) {
      failures++;
      console.error("FAIL " + run.name + ": " + error.stack);
    }
  }
  console.log(`${checks} source/VM controls passed; ${failures} groups failed; native execution NOT RUN`);
  if (failures) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
