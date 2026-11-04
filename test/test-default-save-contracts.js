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
    actors.includes("const bgVersionIdentityFields = [\"dev\", \"ino\", \"size\", \"mtimeMs\"]") &&
    actors.includes("bgPreSaveDocument.tab.diskVersion?.[field] === bgPreSaveBefore[field]"),
  "S9c separates adopted identity from physical stability and retains the original pre-Save guard");
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

function backgroundSaveVersionContracts() {
  const predicate = between(source,
    '  const bgVersionFields = ["dev", "ino", "size", "mtimeMs", "ctimeMs"];',
    '  check(\n    "the background-save fixture\'s adopted disk version matches the physical file",');
  const compile = text => vm.compileFunction(text + "\nreturn bgVersionClean;",
    ["bgVersion", "fileB", "diskBgBaseline"]);
  const evaluate = compile(predicate);
  const fileB = "C:\\fixture\\beta.md", bytes = "# Beta\n\nS9B_SENT\n";
  const fields = ["dev", "ino", "size", "mtimeMs", "ctimeMs"];
  const identity = fields.slice(0, -1), slots = ["tabVersion", "before", "after"];
  const version = { dev: 17, ino: 23, size: Buffer.byteLength(bytes),
    mtimeMs: 132.5, ctimeMs: 148.75 };
  const fixture = () => ({ path: fileB, content: bytes,
    tabVersion: { ...version }, before: { ...version }, after: { ...version } });
  const run = (value, fn = evaluate) => fn(value, fileB, bytes);
  const setup = fixture();
  check(slots.every(slot => fields.every(field => Number.isFinite(setup[slot][field]))) &&
    setup.tabVersion !== setup.before && setup.before !== setup.after &&
    setup.tabVersion !== setup.after && setup.content === bytes,
  "S9c version setup has exact bytes and three independently mutable finite five-field versions");
  check(run(setup) === true, "S9c actual baseline predicate accepts an unchanged physical version");
  for (const ctime of [version.ctimeMs - 0.125, version.ctimeMs + 0.125, 0, -1, Number.MAX_VALUE]) {
    const drift = fixture();
    drift.tabVersion.ctimeMs = ctime;
    check(drift.tabVersion.ctimeMs !== drift.before.ctimeMs &&
      identity.every(field => drift.tabVersion[field] === drift.before[field]) &&
      fields.every(field => drift.before[field] === drift.after[field]) &&
      run(drift) === true,
    "S9c accepts only finite adopted ctime drift with stable physical metadata: " + ctime);
  }
  for (const field of identity) {
    const mismatch = fixture();
    mismatch.tabVersion[field] += 0.125;
    check(mismatch.tabVersion[field] !== mismatch.before[field] &&
      mismatch.before[field] === mismatch.after[field] && run(mismatch) === false,
    "S9c rejects adopted/baseline " + field + " mismatch despite stable physical metadata");
  }
  for (const field of fields) {
    const mismatch = fixture();
    mismatch.after[field] += 0.125;
    check(mismatch.before[field] !== mismatch.after[field] &&
      mismatch.tabVersion[field] === mismatch.before[field] && run(mismatch) === false,
    "S9c rejects physical before/after " + field + " instability");
  }
  for (const slot of slots) {
    for (const field of fields) {
      for (const [label, invalid] of [
        ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity],
        ["missing", undefined], ["null", null], ["numeric string", String(version[field])],
      ]) {
        const malformed = fixture();
        malformed[slot][field] = invalid;
        check(!Number.isFinite(malformed[slot][field]) && run(malformed) === false,
          "S9c rejects nonfinite " + slot + "." + field + ": " + label);
      }
    }
    for (const malformed of [undefined, null, {}, [], "version", 1]) {
      const missing = fixture();
      missing[slot] = malformed;
      check(run(missing) === false, "S9c rejects malformed " + slot + ": " + String(malformed));
    }
  }
  for (const field of fields) {
    for (const invalid of [undefined, null, false, "148.75", NaN, Infinity, -Infinity]) {
      const equalInvalid = fixture();
      for (const slot of slots) equalInvalid[slot][field] = invalid;
      check(run(equalInvalid) === false,
        "S9c equal malformed " + field + " in all three versions cannot pass equality: " + String(invalid));
    }
  }
  for (const content of [bytes.replace("S9B_SENT", "S9B_DENT"), bytes + " ",
    bytes.replace(/\n/g, "\r\n"), "", null, undefined, Buffer.from(bytes)]) {
    const changed = fixture();
    changed.content = content;
    check(changed.content !== bytes && run(changed) === false,
      "S9c preserves exact baseline bytes, including same-size edits and line endings: " + String(content));
  }
  const changedPath = fixture();
  changedPath.path += ".other";
  check(run(changedPath) === false, "S9c preserves the exact physical baseline path guard");

  const strictAdoption = predicate.replace(
    'const bgVersionIdentityFields = ["dev", "ino", "size", "mtimeMs"];',
    'const bgVersionIdentityFields = ["dev", "ino", "size", "mtimeMs", "ctimeMs"];');
  assert.notEqual(strictAdoption, predicate);
  const adoptedDrift = fixture();
  adoptedDrift.tabVersion.ctimeMs += 0.125;
  check(run(adoptedDrift) === true && run(adoptedDrift, compile(strictAdoption)) === false,
    "Restoring adopted ctime equality fails the finite adopted-only drift acceptance control");
  const physicalStart = "    bgVersionFields.every(\n      (field) =>\n";
  const weakPhysical = predicate.replace(physicalStart,
    "    bgVersionIdentityFields.every(\n      (field) =>\n");
  assert.notEqual(weakPhysical, predicate);
  const physicalDrift = fixture();
  physicalDrift.after.ctimeMs += 0.125;
  check(run(physicalDrift) === false && run(physicalDrift, compile(weakPhysical)) === true,
    "Removing only physical ctime stability fails the separate physical-read rejection control");
  for (const field of identity) {
    const declaration = 'const bgVersionIdentityFields = ["dev", "ino", "size", "mtimeMs"];';
    const missingIdentity = predicate.replace(declaration,
      "const bgVersionIdentityFields = " + JSON.stringify(identity.filter(key => key !== field)) + ";");
    assert.notEqual(missingIdentity, predicate);
    const mismatch = fixture();
    mismatch.tabVersion[field] += 0.125;
    check(run(mismatch) === false && run(mismatch, compile(missingIdentity)) === true,
      "Removing adopted " + field + " equality is independently detected by its mismatch control");
  }
  const finiteStart = "    bgVersionFields.every(field =>\n";
  const finiteEnd = "    bgVersionIdentityFields.every(field =>\n";
  const finiteGuard = between(predicate, finiteStart, finiteEnd);
  const missingFinite = predicate.replace(finiteGuard, "");
  const equalInvalid = fixture();
  for (const slot of slots) equalInvalid[slot].ctimeMs = undefined;
  check(run(equalInvalid) === false && run(equalInvalid, compile(missingFinite)) === true,
    "Removing finite validation admits equal missing ctime and fails the malformed-version control");
  for (const field of fields) {
    const weakFinite = predicate.replace(finiteStart,
      '    bgVersionFields.filter(field => field !== "' + field + '").every(field =>\n');
    assert.notEqual(weakFinite, predicate);
    const equalInvalidField = fixture();
    for (const slot of slots) equalInvalidField[slot][field] = "148.75";
    check(run(equalInvalidField) === false && run(equalInvalidField, compile(weakFinite)) === true,
      "Removing finite validation for only " + field + " admits an equal invalid triple");
  }
  const missingBytes = predicate.replace("    bgVersion.content === diskBgBaseline &&\n", "");
  assert.notEqual(missingBytes, predicate);
  const changedBytes = fixture();
  changedBytes.content = bytes.replace("S9B_SENT", "S9B_DENT");
  check(run(changedBytes) === false && run(changedBytes, compile(missingBytes)) === true,
    "Removing byte equality admits a same-size edit and fails the unchanged original byte safeguard");
}

function installedLauncherDiagnosticContracts() {
  let actor = between(source, "async function runWindowsInstalledLauncherScenarios(",
    "\nfunction installMainOwnedShutdownQuestions(");
  const remove = (start, end) => { actor = actor.replace(between(actor, start, end), ""); };
  remove("  let launcherDiagnostic = null;", "  const restoreFields = () => {");
  const field = between(actor, "  const setField =", "  const setLatch =");
  actor = actor.replace(field, field.replace(" => {\n", " =>\n")
    .replace(/^.*launcherDiagnostic.*\n/gm, "")
    .replace("    const result = Object.defineProperty", "    Object.defineProperty")
    .replace("    return result;\n  };\n", ""));
  actor = actor.replace(between(actor, "    if (!await waitForCondition(exec, `",
    '      throw new Error("Windows launcher fixture'),
  '    if (!await waitForCondition(exec, "!window.CustomTabs.isDocumentFrozen()", 8000)) {\n');
  actor = actor.replace("    const prepared = await updaterFixture.prepare();",
    "    await updaterFixture.prepare();");
  remove("  const start = () => {", "\n  let launcherFailure = null;");
  actor = actor.replace("\n  let launcherFailure = null;",
    "  const start = () => exec(`window.folia.installUpdate(); null;`);\n\n  let launcherFailure = null;");
  remove("    try {\n      launcherDiagnosticToken =", "    write(installerPath,");
  actor = actor.replace(/^.*launcherDiagnostic\??\.[^\n]*\n/gm, "").replaceAll("launcherCheck(", "check(");
  for (const label of ["directory", "package"]) actor = actor.replace(
    '        launcherPoll("unsupported-' + label + '",\n' +
      "          __shutdown.state().lastRequestId > " + label + "RequestBefore &&\n" +
      "          __shutdown.state().updaterInstallAttemptId === 0),",
    "        __shutdown.state().lastRequestId > " + label + "RequestBefore &&\n" +
      "        __shutdown.state().updaterInstallAttemptId === 0,");
  remove("    let rendererDiagnostic =", "    for (const restore of [");
  remove('    try {\n      console.log("WINDOWS_LAUNCHER_DIAGNOSTIC ', "    if (failures.length) {");
  check(require("node:crypto").createHash("sha256").update(actor).digest("hex") ===
    "f8153bf99092ed1e95fd6e32618a2bf75b91dacd447b81f3b454b41097e97b71",
  "Outside passive diagnostics the complete original Windows actor, predicates, metadata order, deadlines and cleanup are byte-equivalent");
  const helper = between(source, "  const createLauncherDiagnostic = () => {",
    "  const observeLauncherRenderer = token => {");
  const rendererHelper = between(source, "  const observeLauncherRenderer = token => {",
    "  let launcherDiagnosticToken = null;");
  const mainLines = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8")
    .replace(/\r\n/g, "\n").split("\n");
  check(mainLines[12735].trim() === "releaseShutdownFreeze();" &&
    mainLines.slice(12728, 12736).join("\n").includes("else if (started === false)") &&
    mainLines[14140].includes('updateState.fail(new Error("The downloaded update is incomplete.') &&
    mainLines.slice(14136, 14141).join("\n").includes("catch (err)"),
  "Launcher diagnostic route coordinates name the actual post-return-false thaw and preflight publication");
  const make = ({ enabled = false } = {}) => {
    const ipc = new (require("node:events").EventEmitter)();
    const state = { lastRequestId: 7, rendererGeneration: 3, rendererPageSession: "owned-page",
      pendingId: 0, updaterInstallAttemptId: 0 };
    const model = { ignored: false, stateFault: false, jsonFault: false, originalThrow: null,
      stack: "at publication (C:\\repo\\src\\main.js:14141:5)", enabled, enables: 0,
      disables: 0, entries: [], emits: 0, sends: 0, stackAllocations: 0, stackReads: 0 };
    const wc = { id: 12, mainFrame: {}, send(channel, payload) {
      model.sends++; model.sendThis = this; model.sendPayload = payload;
      if (model.originalThrow) throw model.originalThrow;
      return "original-send-return";
    } };
    const originalEmit = ipc.emit, originalSend = wc.send;
    ipc.on("install-update", () => {
      model.emits++;
      if (model.originalThrow) throw model.originalThrow;
      if (!model.ignored) state.lastRequestId++;
    });
    const updater = { installerPath: "C:\\fixture\\setup.exe", installDirectory: "",
      downloadedUpdateHelper: { file: "C:\\fixture\\setup.exe", versionInfo: { version: "0.12.1" } },
      quitAndInstallCalled: false };
    const context = vm.createContext({ updater, ipcMain: ipc, wc, win: { id: 4, webContents: wc },
      children: [], spawnCalls: [], Buffer, AggregateError,
      Error: class extends Error { constructor(...args) {
        super(...args);
        model.stackAllocations++;
        Object.defineProperty(this, "stack", { get() { model.stackReads++; return model.stack; } });
      } },
      JSON: { stringify: (...args) => {
        if (model.jsonFault) throw new Error("controlled serialization fault");
        return JSON.stringify(...args);
      } },
      replaceMethod: (target, key, implementation) => {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        Object.defineProperty(target, key, { value: implementation, configurable: true, writable: true });
        return () => descriptor ? Object.defineProperty(target, key, descriptor) : delete target[key];
      },
      __shutdown: { state: () => {
        if (model.stateFault) throw new Error("controlled projection fault");
        return state;
      }, timing: {
        state: () => ({ enabled: model.enabled, requests: model.entries }),
        enable: () => { model.enables++; model.enabled = true; model.entries = []; },
        disable: () => { model.disables++; model.enabled = false; },
      } },
    });
    const diagnostic = vm.runInContext(helper + "\ncreateLauncherDiagnostic()", context);
    diagnostic.install();
    const emit = () => ipc.emit("install-update", { sender: wc, senderFrame: wc.mainFrame });
    const packet = () => JSON.parse(diagnostic.packet({ records: [] }));
    return { diagnostic, model, updater, state, ipc, wc, emit, packet, originalEmit, originalSend };
  };
  const filtered = make();
  const ingress = { sender: filtered.wc, senderFrame: filtered.wc.mainFrame };
  const ingressPayload = { id: 8, gen: 3, revision: 4 };
  let approvalDelegations = 0;
  for (const channel of ["quit-approval-response", "quit-approval-committed", "quit-approval-verified"]) {
    filtered.ipc.on(channel, function (event, data) {
      assert.equal(this, filtered.ipc);
      assert.equal(event, ingress);
      assert.equal(data, ingressPayload);
      approvalDelegations++;
    });
    assert.equal(filtered.ipc.emit(channel, ingress, ingressPayload), true);
  }
  assert.equal(filtered.emit(), true);
  for (const [channel, data] of [
    ["quit-approval-request", ingressPayload], ["quit-approval-commit", ingressPayload],
    ["quit-approval-verify", ingressPayload], ["update-status", { status: "available" }],
    ["update-status", { status: "error", error: "unrelated error" }],
    ["update-status", { status: "installing",
      error: "The downloaded update is incomplete. Download it again." }],
  ]) {
    assert.equal(filtered.wc.send(channel, data), "original-send-return");
    assert.equal(filtered.model.sendThis, filtered.wc);
    assert.equal(filtered.model.sendPayload, data);
  }
  check(filtered.model.stackAllocations === 0 && filtered.model.stackReads === 0 &&
    approvalDelegations === 3 && filtered.model.emits === 1 && filtered.model.sends === 6 &&
    filtered.packet().records.every(record => record.stack === null),
  "Unrelated original ingress approval commit verification and status paths delegate exactly once without acquiring or materializing callsites");
  filtered.model.entries = [{ id: 8, reason: "update-install", continuationInvokedAt: 101 }];
  assert.equal(filtered.wc.send("update-status", { status: "error",
    error: "The downloaded update is incomplete. Download it again." }), "original-send-return");
  filtered.model.stack = "at continuation (C:\\repo\\src\\main.js:12736:9)";
  assert.equal(filtered.wc.send("quit-approval-thaw"), "original-send-return");
  const filteredPacket = filtered.packet();
  check(filtered.model.stackAllocations === 2 && filtered.model.stackReads === 2 &&
    filtered.model.sends === 8 && filteredPacket.routes.length === 1 &&
    filteredPacket.records.filter(record => record.stack !== null).every(record =>
      record.kind === "send:return") &&
    filteredPacket.records.filter(record => record.stack !== null).length === 2,
  "Only normal returned generic preflight publication and thaw materialize one callsite each and preserve actual route classification");
  let originalStackReads = 0;
  const originalThrow = { message: "original bounded message " + "x".repeat(5000),
    get stack() { originalStackReads++; throw new Error("forbidden original exception stack read"); } };
  filtered.model.originalThrow = originalThrow;
  assert.throws(() => filtered.wc.send("quit-approval-thaw"), error => error === originalThrow);
  assert.throws(filtered.emit, error => error === originalThrow);
  const observedThrows = filtered.packet().records.filter(record => record.kind.endsWith(":throw"));
  check(originalStackReads === 0 && filtered.model.stackAllocations === 2 &&
    filtered.model.stackReads === 2 && filtered.model.sends === 9 && filtered.model.emits === 2 &&
    observedThrows.length === 2 && observedThrows.every(record =>
      record.stack === null && record.originalError.endsWith("[truncated]")) &&
    originalThrow.message.length > 5000,
  "Original throws preserve exact exception and delegation with bounded message only and never acquire or project any exception stack");
  filtered.diagnostic.restore();
  const h = make();
  check(h.model.enables === 1, "Launcher diagnostics arm disabled timing before original operations");
  check(h.emit() === true && h.model.emits === 1,
    "Launcher ingress delegates exactly once and retains the original synchronous return");
  h.model.ignored = true;
  h.emit();
  let packet = h.packet();
  check(packet.invocations[0].admittedId === 8 && packet.invocations[1].admittedId === null &&
    packet.terminal === "UNOBSERVED",
  "An ignored second Install cannot inherit the first admitted id or turn id advancement into completion");
  const payload = { status: "error", error: "The downloaded update is incomplete. Download it again." };
  h.model.entries = [{ id: 8, reason: "update-install", continuationInvokedAt: 101, settledAt: 90 }];
  check(h.wc.send("update-status", payload) === "original-send-return" &&
    h.model.sendThis === h.wc && h.model.sendPayload === payload,
  "Launcher send preserves receiver, payload reference and original return");
  h.model.stack = "at reset (C:\\repo\\src\\main.js:15100:9)";
  h.wc.send("quit-approval-thaw");
  check(h.packet().terminal === "UNOBSERVED",
    "A reset or other refusal thaw cannot substitute for the exact post-return-false terminal route");
  h.model.stack = "at continuation (C:\\repo\\src\\main.js:12736:9)";
  h.wc.send("quit-approval-thaw");
  packet = h.packet();
  check(packet.routes.length === 1 && packet.routes[0].requestId === 8 &&
    packet.routes[0].invocation === 1 && packet.routes[0].continuationEntry === 101 &&
    packet.consumerJoin.startsWith("UNOBSERVED") &&
    packet.thawCorrelation.wireId.startsWith("ABSENT"),
  "Only same-request publication plus continuation entry and exact post-return-false thaw yields route evidence, never a join");
  h.diagnostic.beforeReset();
  check(h.packet().records.some(record => record.kind === "before-reset" &&
    record.timing.some(clock => clock.id === 8 && clock.continuationInvokedAt === 101)),
  "Original timing evidence is copied before reset can erase the seam");
  h.wc.send("quit-approval-thaw");
  check(h.packet().routes.length === 1, "Reset traffic cannot earn a second terminal route");
  h.diagnostic.bodyExit();
  h.wc.send("quit-approval-thaw");
  check(h.packet().routes.length === 1, "Cleanup traffic is labelled and excluded from terminal route credit");
  h.diagnostic.restore();
  check(h.ipc.emit === h.originalEmit && h.wc.send === h.originalSend && h.model.disables === 1,
    "Launcher observation restores both exact method owners and only its borrowed timing state");

  const enabled = make({ enabled: true });
  check(enabled.model.enables === 0, "Already-enabled timing is not re-enabled and cleared by diagnostics");
  enabled.diagnostic.restore();
  check(enabled.model.disables === 0, "Previously-enabled timing remains enabled after observation");
  const fault = make();
  const originalError = new Error("original failure " + "x".repeat(9000));
  fault.model.stateFault = true;
  fault.model.originalThrow = originalError;
  assert.throws(fault.emit, error => error === originalError && error.message.length > 9000);
  check(fault.model.emits === 1 && fault.packet().errors.length > 0,
    "Projection faults cannot block exact-once ingress or replace or truncate its original exception");
  assert.throws(() => fault.wc.send("update-status", payload), error => error === originalError);
  check(fault.model.sends === 1, "Projection faults preserve exact-once send and the same original throw");
  fault.model.jsonFault = true;
  const unavailable = JSON.parse(fault.diagnostic.packet({ records: [] }));
  check(unavailable.unavailable === "launcher diagnostic serialization failed",
    "Serialization faults produce explicit valid unavailable evidence without replacing the original failure");
  fault.diagnostic.restore();
  const unpublished = make();
  unpublished.emit();
  unpublished.model.entries = [{ id: 8, reason: "update-install", continuationInvokedAt: 101 }];
  unpublished.model.originalThrow = originalError;
  assert.throws(() => unpublished.wc.send("update-status", payload), error => error === originalError);
  unpublished.model.originalThrow = null;
  unpublished.model.stack = "at continuation (C:\\repo\\src\\main.js:12736:9)";
  unpublished.wc.send("quit-approval-thaw");
  check(unpublished.packet().terminal === "UNOBSERVED" &&
    unpublished.packet().records.some(record => record.kind === "send:throw") &&
    !unpublished.packet().records.some(record => record.kind === "send:return" && record.channel === "update-status"),
  "Publication ENTRY or original throw cannot replace a returned generic-error publication");
  unpublished.diagnostic.restore();
  const wrongPublisher = make();
  wrongPublisher.emit();
  wrongPublisher.model.entries = [{ id: 8, reason: "update-install", continuationInvokedAt: 101 }];
  wrongPublisher.model.stack = "at another route (C:\\repo\\src\\main.js:13855:9)";
  wrongPublisher.wc.send("update-status", payload);
  wrongPublisher.model.stack = "at continuation (C:\\repo\\src\\main.js:12736:9)";
  wrongPublisher.wc.send("quit-approval-thaw");
  check(wrongPublisher.packet().terminal === "UNOBSERVED",
    "A generic error from a different publication route cannot establish the NSIS preflight outcome");
  wrongPublisher.diagnostic.restore();
  const large = make();
  large.updater.downloadedUpdateHelper.packageFile = "界".repeat(10000);
  for (let i = 0; i < 80; i++) large.diagnostic.note("bounded", { ordinal: i });
  const serialized = large.diagnostic.packet({ records: [] });
  const bounded = JSON.parse(serialized);
  check(Buffer.byteLength(serialized, "utf8") <= 65536 && bounded.records.length < 64 &&
    bounded.records[0].ordinal === 0 && bounded.records.at(-1).ordinal === 79 && bounded.dropped > 0,
  "Launcher packet trims projected evidence to valid UTF-8 bounded JSON while retaining first/last and drop counts");
  check(bounded.records.at(-1).metadata.packageFile.endsWith("[truncated]"),
    "Only projected oversized metadata is bounded with an explicit truncation marker");
  large.diagnostic.restore();
  const ownership = make();
  const foreign = () => {};
  ownership.wc.send = foreign;
  assert.throws(() => ownership.diagnostic.restore(), /Launcher diagnostic restoration failed/);
  check(ownership.wc.send === foreign && ownership.ipc.emit === ownership.originalEmit &&
    ownership.model.disables === 1,
  "Foreign observation ownership fails visibly without clobbering it or skipping independent restoration");

  for (const [label, change] of [
    ["no continuation entry", x => { x.model.entries = []; }],
    ["foreign generation", x => { x.state.rendererGeneration++; }],
    ["foreign page session", x => { x.state.rendererPageSession = "replacement"; }],
    ["different request", x => { x.state.lastRequestId++; }],
  ]) {
    const mismatch = make();
    mismatch.emit();
    mismatch.model.entries = [{ id: 8, reason: "update-install", continuationInvokedAt: 101 }];
    mismatch.wc.send("update-status", payload);
    change(mismatch);
    mismatch.model.stack = "at continuation (C:\\repo\\src\\main.js:12736:9)";
    mismatch.wc.send("quit-approval-thaw");
    check(mismatch.packet().terminal === "UNOBSERVED",
      "Ambiguous launcher correlation stays unobserved: " + label);
    mismatch.diagnostic.restore();
  }
  const window = { getReloadRequestSession: () => "owned-page",
    CustomTabs: { __shutdownFreeze: () => ({ frozen: true, id: 8, revision: 3 }) }, folia: {} };
  let callback, disposed = 0;
  window.folia.onQuitApprovalThaw = listener => { callback = listener; return () => { disposed++; }; };
  window.folia.onUpdateStatus = () => { throw new Error("controlled second subscription failure"); };
  const context = vm.createContext({ window });
  vm.runInContext(rendererHelper + '\nobserveLauncherRenderer("owned-token")', context);
  check(window.__installedLauncherDiagnostic.off.length === 1 &&
    typeof window.__installedLauncherDiagnostic.off[0] === "function" &&
    window.__installedLauncherDiagnostic.errors.includes("renderer setup unavailable"),
  "Each obtained renderer disposer is retained before a later subscription can fail");
  window.CustomTabs.__shutdownFreeze = () => { throw new Error("controlled freeze getter failure"); };
  assert.doesNotThrow(() => callback());
  check(window.__installedLauncherDiagnostic.errors.includes("renderer capture unavailable"),
    "Passive renderer callbacks cannot throw into the production thaw delivery");
  const collection = between(source, "      rendererDiagnostic = await boundedDialogWork(exec(`",
    '), "Windows launcher diagnostic collection only", 1000);');
  const expression = vm.runInNewContext(collection.slice(collection.indexOf("`")),
    { launcherDiagnosticToken: "owned-token" });
  const collected = vm.runInContext(expression, context);
  check(disposed === 1 && collected.token === "owned-token" && !window.__installedLauncherDiagnostic,
    "Actual bounded renderer collection disposes partial setup exactly once and retires only its owned buffer");
  const callbacks = {};
  let liveFreeze = { frozen: true, id: 8, revision: 3 }, liveDisposed = 0;
  const liveWindow = { getReloadRequestSession: () => "owned-page",
    CustomTabs: { __shutdownFreeze: () => liveFreeze }, folia: {
      onQuitApprovalThaw: cb => { callbacks.thaw = cb; return () => { liveDisposed++; }; },
      onUpdateStatus: cb => { callbacks.status = cb; return () => { liveDisposed++; }; },
    } };
  const liveContext = vm.createContext({ window: liveWindow });
  vm.runInContext(rendererHelper + '\nobserveLauncherRenderer("owned-token")', liveContext);
  callbacks.status({ status: "error" });
  liveFreeze = { frozen: false, id: 0, revision: 3 };
  callbacks.thaw();
  const observed = liveWindow.__installedLauncherDiagnostic.records;
  check(observed.at(-2).kind === "status" && observed.at(-2).freeze.id === 8 &&
    observed.at(-1).kind === "thaw" && observed.at(-1).freeze.frozen === false &&
    observed.at(-1).pageSession === "owned-page" &&
    liveWindow.__installedLauncherDiagnostic.poll(false) === false,
  "Passive renderer status/thaw receives retain owned page, receive order and real freeze state without inventing a wire id");
  vm.runInContext(expression, liveContext);
  check(liveDisposed === 2, "Both successful renderer subscriptions are retired by the actual collection path");
  let starts = 0;
  const brokenWindow = { folia: { installUpdate: () => { starts++; } } };
  Object.defineProperty(brokenWindow, "__installedLauncherDiagnostic", {
    get() { throw new Error("controlled observer property failure"); },
  });
  const brokenContext = vm.createContext({ window: brokenWindow, launcherDiagnostic: null,
    launcherDiagnosticToken: "owned-token" });
  brokenContext.exec = code => vm.runInContext(code, brokenContext);
  const startSource = between(source, '  const start = () => {\n    launcherDiagnostic?.note("start");',
    "\n\n  let launcherFailure = null;");
  assert.doesNotThrow(() => vm.runInContext(rendererHelper + startSource + "\nstart()", brokenContext));
  check(starts === 1, "Even renderer setup projection failure cannot block the unchanged original Install invocation");
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

async function shutdownAggregateDiagnosticContracts() {
  const scenario = between(source, "async function runShutdownScenarios(",
    "\nasync function runSameDocumentShutdownScenarios(");
  const catchStart = "  } catch (error) {\n    bodyError = error;\n  } finally {";
  const cleanup = scenario.slice(scenario.lastIndexOf(catchStart), scenario.lastIndexOf("\n}"));
  assert.ok(cleanup.startsWith(catchStart), "The actual ordinary shutdown catch/finally is extracted");
  const boundary = cleanup.slice(cleanup.lastIndexOf("    if (bodyError || cleanupErrors.length) {"),
    cleanup.lastIndexOf("\n  }"));
  const legacy = '    if (bodyError || cleanupErrors.length) {\n' +
    '      throw new AggregateError([bodyError, ...cleanupErrors].filter(Boolean),\n' +
    '        "Ordinary shutdown scenario or independent cleanup failed");\n    }';
  assert.equal(cleanup.split(boundary).length, 2, "One exact final aggregate boundary is controlled");
  const formatter = between(source, "function uncaughtExceptionDetail(error) {", "\nfunction writeFatal(");
  const sameDescriptor = between(source, "function sameDescriptor(left, right) {", "\n}\n") + "\n}";
  const util = require("node:util");
  const bodyLeaf = new Error("SHUTDOWN_BODY_DEEP_LEAF");
  const nestedBody = new AggregateError([new AggregateError([bodyLeaf], "BODY_LEVEL_TWO")], "BODY_LEVEL_ONE");
  const body = new AggregateError([nestedBody, ...Array.from({ length: 130 },
    (_, index) => "BODY_CHILD_" + index)], "SHUTDOWN_BODY");
  let customReads = 0;
  Object.defineProperty(body, util.inspect.custom, {
    get() { customReads++; throw new Error("Error inspection must not invoke application hooks"); },
  });
  const rendererError = new Error("INDEPENDENT_RENDERER_CLEANUP");
  const dialogError = new Error("INDEPENDENT_DIALOG_CLEANUP");
  const cleanupLeaf = new Error("SHUTDOWN_CLEANUP_DEEP_LEAF");
  const readinessError = new AggregateError([new AggregateError([cleanupLeaf], "CLEANUP_LEVEL_TWO"),
    "X".repeat(12000) + "UNTRUNCATED_CLEANUP_TAIL"], "INDEPENDENT_READINESS_CLEANUP");
  const timingError = new Error("INDEPENDENT_TIMING_CLEANUP");
  const formatError = new Error("DIAGNOSTIC_FORMATTER_REFUSED");
  const run = async (options = {}) => {
    const trace = [], assertions = [], unavailable = [];
    let inspections = 0, thrown = null;
    const app = { quit() {} };
    const descriptor = Object.getOwnPropertyDescriptor(app, "quit");
    const action = (label, error) => () => { trace.push(label); if (error) throw error; };
    const rejected = error => { const promise = Promise.reject(error); promise.catch(() => {}); return promise; };
    const failed = options.failures === true;
    const holds = ["first", "last"].map(label => {
      let restored = false;
      return { dispose() { trace.push("hold-" + label); restored = true; },
        snapshot: () => ({ restored, captured: true, released: true }) };
    });
    const activeCleanup = options.legacy ? cleanup.replace(boundary, legacy) : cleanup;
    const context = vm.createContext({
      AggregateError, app, bodyError: null,
      work: async () => { if ((failed && !options.cleanupOnly) || options.bodyOnly) throw body; },
      require: name => {
        assert.equal(name, "util");
        return { inspect: (value, settings) => {
          inspections++;
          assert.equal(value.bodyError, (failed && !options.cleanupOnly) || options.bodyOnly ? body : null);
          if (options.formatFailure) throw formatError;
          return util.inspect(value, settings);
        } };
      },
      heldDialogs: [{ settled: false, settle: choice => {
        assert.equal(choice, 1); trace.push("held-dialog");
      } }],
      rendererTails: failed ? [rejected(rendererError)] : [],
      dialogTails: failed ? [rejected(dialogError)] : [],
      ownedHolds: holds,
      __shutdown: {
        state: () => ({ shutdownPendingContinuationCount: 0, rendererPageSession: "source-page" }),
        reset: action("reset"), timing: { disable: action("timing", failed && timingError) },
      },
      setImmediate: callback => { trace.push("turn"); return setImmediate(callback); },
      requestCounterOwner: "owned-source-counter", counterPageSession: "source-page",
      exec: async script => {
        if (script.includes("const state = window.__ordinaryShutdownRequestCounter;")) {
          trace.push("counter-remove"); return true;
        }
        assert.equal(script, "!!window.__ordinaryShutdownRequestCounter");
        trace.push("counter-check"); return false;
      },
      readinessFixture: { restore: action("readiness", failed && readinessError) },
      baseUpdaterBranchBorrow: { restore: action("base-borrow"),
        snapshot: () => ({ platform: process.platform, quitAndInstallPlatforms: [] }) },
      automaticUpdatesAvailable: false, actualHostPlatform: process.platform,
      unavailable: (...args) => unavailable.push(args),
      restoreInstall: action("install"), countPublicUpdateCommit: null,
      electronAutoUpdater: { removeListener: (channel, listener) => {
        assert.equal(channel, "before-quit-for-update"); assert.equal(listener, null);
        trace.push("electron-update");
      } },
      restoreUpdaterLatch: action("updater-latch"),
      ownedQuestions: { restore: action("owned-questions") },
      restoreOrdinaryEmergencyGuard: action("emergency"),
      rig: { restore: action("rig"), appQuitDescriptor: descriptor },
      timingWasEnabled: false,
      check: (name, success) => { assertions.push({ name, success }); },
    });
    try {
      await vm.runInContext(formatter + "\n" + sameDescriptor + "\n(async () => {\ntry { await work();\n" +
        activeCleanup + "\n})()", context);
    } catch (error) { thrown = error; }
    return { trace, assertions, unavailable, inspections, thrown };
  };
  const current = await run({ failures: true });
  const error = current.thrown;
  check(error instanceof AggregateError && error.errors.length === 5 &&
    error.errors[0] === body && error.errors[1].errors[0] === rendererError &&
    error.errors[2].errors[0] === dialogError && error.errors[3] === readinessError &&
    error.errors[4] === timingError,
  "Actual shutdown boundary preserves the body and every independently collected cleanup error in original order");
  check(error.message.startsWith("Ordinary shutdown scenario or independent cleanup failed\n") &&
    error.stack.includes("bodyError:") && error.stack.includes("cleanupErrors:") &&
    ["SHUTDOWN_BODY_DEEP_LEAF", "BODY_CHILD_129", "INDEPENDENT_RENDERER_CLEANUP",
      "INDEPENDENT_DIALOG_CLEANUP", "SHUTDOWN_CLEANUP_DEEP_LEAF",
      "UNTRUNCATED_CLEANUP_TAIL", "INDEPENDENT_TIMING_CLEANUP"]
      .every(marker => error.stack.includes(marker)),
  "Actual stack-only terminal output retains labeled body and independent cleanup lanes with complete nested children");
  check(current.inspections === 1 && customReads === 0,
    "Shutdown diagnostics use actual Node inspection without invoking application inspection hooks");
  const old = await run({ failures: true, legacy: true });
  check(old.thrown instanceof AggregateError && old.thrown.errors.length === error.errors.length &&
    old.thrown.errors[0] === body && old.thrown.errors[1].errors[0] === rendererError &&
    old.thrown.errors[2].errors[0] === dialogError &&
    old.thrown.errors[3] === readinessError && old.thrown.errors[4] === timingError &&
    !old.thrown.stack.includes("SHUTDOWN_BODY_DEEP_LEAF") &&
    !old.thrown.stack.includes("SHUTDOWN_CLEANUP_DEEP_LEAF"),
  "Former stack-only aggregate genuinely loses nested causes while preserving the same thrown error accounting");
  const expectedTrace = ["held-dialog", "turn", "hold-last", "hold-first", "reset", "turn", "turn",
    "counter-remove", "counter-check", "readiness", "base-borrow", "install", "electron-update",
    "updater-latch", "owned-questions", "emergency", "rig", "timing"];
  assert.deepEqual(current.trace, expectedTrace);
  assert.deepEqual(current.trace, old.trace);
  assert.deepEqual(current.assertions, old.assertions);
  assert.deepEqual(current.unavailable, old.unavailable);
  check(current.assertions.length === 3 && current.assertions.every(assertion => assertion.success),
    "Diagnostics change neither cleanup order nor any existing behavioral assertion, even after independent cleanup failures");
  const healthy = await run();
  check(healthy.thrown === null && healthy.inspections === 0 &&
    JSON.stringify(healthy.trace) === JSON.stringify(expectedTrace),
  "Healthy shutdown performs the same cleanup and does not invoke failure diagnostics or throw");
  const bodyOnly = await run({ bodyOnly: true });
  check(bodyOnly.thrown.errors.length === 1 && bodyOnly.thrown.errors[0] === body &&
    bodyOnly.thrown.stack.includes("bodyError:") &&
    bodyOnly.thrown.stack.includes("cleanupErrors: []"),
  "Body-only shutdown failures label the empty independent cleanup lane without inventing an error");
  const cleanupOnly = await run({ failures: true, cleanupOnly: true });
  check(cleanupOnly.thrown.errors.length === 4 &&
    cleanupOnly.thrown.errors[0].errors[0] === rendererError &&
    cleanupOnly.thrown.errors[1].errors[0] === dialogError &&
    cleanupOnly.thrown.errors[2] === readinessError && cleanupOnly.thrown.errors[3] === timingError &&
    cleanupOnly.thrown.stack.includes("bodyError: null") &&
    cleanupOnly.thrown.stack.includes("SHUTDOWN_CLEANUP_DEEP_LEAF") &&
    !cleanupOnly.thrown.stack.includes("SHUTDOWN_BODY_DEEP_LEAF"),
  "Cleanup-only shutdown failures retain their independent causes without inventing a body failure");
  const failedFormat = await run({ failures: true, formatFailure: true });
  check(failedFormat.thrown instanceof AggregateError && failedFormat.thrown.errors.length === 5 &&
    failedFormat.thrown.errors[0] === body && failedFormat.thrown.errors[3] === readinessError &&
    failedFormat.thrown.errors[4] === timingError &&
    failedFormat.thrown.stack.includes("Shutdown diagnostics unavailable:") &&
    failedFormat.thrown.stack.includes("DIAGNOSTIC_FORMATTER_REFUSED") &&
    JSON.stringify(failedFormat.trace) === JSON.stringify(expectedTrace),
  "Formatter refusal preserves the original aggregate and completed cleanup instead of replacing their failure");
}

async function popupCaptureDiagnosticContracts() {
  const scenario = between(source, "async function runShutdownScenarios(",
    "\nasync function runSameDocumentShutdownScenarios(");
  const actor = between(scenario, "    const beforePopup = __shutdown.state().lastRequestId;",
    "\n    // Main-side holds retain genuine ingress.");
  const guardStart = actor.indexOf("      if (!popupOpened || created.length !== 1");
  const guardEnd = actor.indexOf(" {\n        const failure = new Error(", guardStart) + 2;
  assert.ok(guardStart > 0 && guardEnd > guardStart, "The actual final popup authority guard is controlled");
  const guard = actor.slice(guardStart, guardEnd);
  const packetStart = actor.indexOf('        try {\n          failure.message += "\\n" + require("util").inspect({');
  const packetEnd = actor.indexOf('        try {\n          failure.message += "\\nPopup authority:');
  assert.ok(packetEnd > guardEnd);
  const packet = packetStart > guardEnd ? actor.slice(packetStart, packetEnd) : "";
  const legacy = '      if (!popupOpened || created.length !== 1 ||\n' +
    '          created[0].webContents.getLastWebPreferences().preload !==\n' +
    '            path.join(__dirname, "..", "src", "popup-preload.js")) {';
  const cleanup = between(source, "async function withOrdinaryShutdownCleanup(",
    "\nfunction holdOrdinaryShutdownApproval(");
  const bounded = between(source, "async function boundedDialogWork(", "\nfunction inspectCleanRefreshSource(");
  const formatter = between(source, "function uncaughtExceptionDetail(error) {", "\nfunction writeFatal(");
  const preload = fs.readFileSync(path.join(producerRoot, "popup-preload.js"), "utf8");
  const { EventEmitter } = require("node:events");
  const util = require("node:util");
  const expectedPreload = path.join(__dirname, "..", "src", "popup-preload.js");
  const run = async (options = {}) => {
    const trace = [], assertions = [], preferences = [];
    const app = new EventEmitter(), ipcMain = new EventEmitter();
    const state = { lastRequestId: 9, pendingId: 0, renderer: "ready",
      rendererGeneration: 4, rendererPageSession: "retained-popup-document" };
    const rootFrame = { frameTreeNodeId: 31, processId: 11, routingId: 21,
      url: "file:///fixture/index.html", parent: null, isDestroyed: () => false };
    const host = { id: 1, mainFrame: rootFrame, isDestroyed: () => false, getURL: () => rootFrame.url };
    const owner = { id: 1, webContents: host, isDestroyed: () => false };
    const windows = [owner];
    let inspected = null, error = null, probes = 0, waits = 0;
    const create = () => {
      const index = preferences.length;
      const prefs = { sandbox: true, contextIsolation: true, nodeIntegration: false,
        additionalArguments: ["OBSERVED_POPUP_" + index], ...options.unsafe };
      if (!options.missingPreload) prefs.preload =
        options.wrongPreload ? "C:\\foreign\\popup-preload.js" : expectedPreload;
      preferences.push(prefs);
      let destroyed = false;
      const page = { window: {} }, pageContext = vm.createContext(page);
      vm.runInNewContext(preload, {
        process: { argv: ["electron", "--popup-kind=" + (options.wrongKind ? "image" : "mermaid")] },
        require: name => {
          assert.equal(name, "electron");
          return { contextBridge: { exposeInMainWorld: (key, value) => { page.window[key] = value; } },
            ipcRenderer: { once() { throw new Error("No PDF/export dispatch is permitted"); },
              send() { throw new Error("No PDF/export dispatch is permitted"); } } };
        },
      });
      if (options.missingBridge) delete page.window.popupBridge;
      if (options.extraBridge) page.window.popupBridge.saveImage = () => {};
      if (options.nodeGlobal) page.require = () => {};
      if (options.processGlobal) page.process = {};
      const frame = { frameTreeNodeId: 131 + index, processId: 111, routingId: 121 + index,
        url: "file:///fixture/mermaid-" + index + ".html", parent: null, isDestroyed: () => destroyed,
        executeJavaScript: async script => {
          probes++;
          if (options.rejectProbe) throw new Error("ACTUAL_POPUP_PROBE_REFUSED");
          const value = vm.runInContext(script, pageContext);
          if (options.staleSource) state.rendererGeneration++;
          if (options.movedPopup) frame.routingId++;
          if (options.swappedContents) candidate.webContents = { ...candidate.webContents };
          return value;
        } };
      const candidate = { id: 101 + index,
        webContents: { id: 801 + index, mainFrame: frame,
          isDestroyed: () => destroyed, isLoadingMainFrame: () => false,
          getURL: () => frame.url, getLastWebPreferences: () => prefs },
        close() {
          trace.push("close"); destroyed = true;
          if (options.lateDuplicate) ipcMain.emit("open-mermaid-popup", lastEvent, lastPayload);
        },
        destroy() { trace.push("destroy"); destroyed = true; },
        isDestroyed: () => destroyed };
      windows.push(candidate);
      if (!options.missingCreation) app.emit("browser-window-created", {}, candidate);
    };
    let lastEvent, lastPayload;
    const production = (event, payload) => {
      lastEvent = event; lastPayload = payload;
      for (let index = 0; index < (options.count ?? 1); index++) create();
    };
    const originalCreation = () => {};
    ipcMain.on("open-mermaid-popup", production);
    app.on("browser-window-created", originalCreation);
    let context;
    const dispatch = payload => {
      const frame = { ...rootFrame, ...(options.foreignFrame ? { routingId: 999 } : {}) };
      const event = { sender: options.foreignSender ? { id: 999 } : host, senderFrame: frame };
      const received = options.wrongPayload ? { ...payload, isDarkMode: true } : payload;
      if (options.missingReceipt) production(event, received);
      else ipcMain.emit("open-mermaid-popup", event, received);
      if (options.duplicate) ipcMain.emit("open-mermaid-popup", event, received);
    };
    context = vm.createContext({ Error, AggregateError, path, __dirname, app, ipcMain, win: owner,
      Date, setTimeout, clearTimeout, isDeepStrictEqual: util.isDeepStrictEqual,
      BrowserWindow: { getAllWindows: () => windows.filter(window => !window.isDestroyed()) },
      exec: async script => vm.runInContext(script, context),
      window: { folia: { openMermaidPopup: dispatch } },
      require: name => {
        assert.equal(name, "util");
        return { inspect: (value, settings) => {
          if (Object.hasOwn(value, "popupOpened")) {
            inspected = value;
            if (options.formatFailure) throw new Error("POPUP_DIAGNOSTIC_FORMATTER_REFUSED");
          }
          return util.inspect(value, settings);
        } };
      },
      waitUntil: async (predicate, bound) => {
        assert.equal(bound, 10000); waits++;
        if (waits === 1 && options.waitFalse) return false;
        return predicate();
      },
      rig: { dialogs: [] }, __shutdown: { state: () => ({ ...state }) },
      check: (name, success) => assertions.push({ name, success }),
    });
    let body = options.legacy ? actor.replace(guard, legacy) : actor;
    if (options.withoutPacket && packet) body = body.replace(packet, "");
    try { await vm.runInContext(formatter + "\n" + cleanup + "\n" + bounded +
      "\n(async () => {\n" + body + "\n})()", context); }
    catch (failure) { error = failure; }
    assert.deepEqual(ipcMain.listeners("open-mermaid-popup"), [production]);
    assert.deepEqual(app.listeners("browser-window-created"), [originalCreation]);
    return { trace, assertions, error, bodyError: error?.errors?.[0] || error,
      inspected, preferences, windows: windows.slice(1), probes, waits, state };
  };
  const healthy = await run();
  check(healthy.error === null && healthy.inspected === null &&
    healthy.trace.join("|") === "close" && healthy.probes === 1 && healthy.waits === 2 &&
    healthy.assertions.length === 1 && healthy.assertions[0].success === true &&
    healthy.state.lastRequestId === 9 && healthy.state.pendingId === 0,
  "Receipt-correlated popup preserves the original normal close, bounds, shutdown assertion and owner counters");
  const omitted = await run({ missingPreload: true });
  check(omitted.error === null && omitted.probes === 1 && omitted.trace.join("|") === "close" &&
    omitted.assertions[0].success === true && !Object.hasOwn(omitted.preferences[0], "preload"),
  "Actual omitted metadata is admitted only by the genuine fixed receipt, creation, isolation and executed exact Mermaid preload bridge");
  const old = await run({ missingPreload: true, legacy: true });
  check(old.bodyError instanceof Error && old.probes === 1 && old.trace.join("|") === "destroy" &&
    old.assertions.length === 0 && old.windows.length === 1 &&
    !Object.hasOwn(old.preferences[0], "preload"),
  "Former metadata-only witness genuinely rejects the known positive even after valid receipt and executed bridge qualification");
  const noPacket = await run({ wrongPreload: true, withoutPacket: true });
  check(noPacket.bodyError instanceof Error && noPacket.trace.join("|") === "destroy" &&
    noPacket.assertions.length === 0 && noPacket.inspected === null &&
    !noPacket.bodyError.stack.includes("expectedPreload:") &&
    noPacket.bodyError.stack.includes("Popup authority:"),
  "Removing the original R1240 packet genuinely omits observed preferences without removing the new authority evidence or original refusal");
  for (const options of [{ waitFalse: true }, { count: 0 }, { count: 2 }, { wrongPreload: true },
    { missingPreload: true, missingReceipt: true }, { missingPreload: true, missingBridge: true },
    { foreignSender: true }, { foreignFrame: true }, { wrongPayload: true }, { duplicate: true },
    { missingCreation: true }, { wrongKind: true }, { extraBridge: true }, { nodeGlobal: true },
    { processGlobal: true }, { rejectProbe: true }, { staleSource: true }, { movedPopup: true },
    { swappedContents: true },
    { unsafe: { nodeIntegration: true } }, { unsafe: { contextIsolation: false } },
    { unsafe: { sandbox: false } }]) {
    const refused = await run(options), data = refused.inspected;
    const owned = options.count !== 0 && !options.missingReceipt && !options.missingCreation &&
      !options.foreignSender && !options.foreignFrame && !options.wrongPayload;
    check(refused.bodyError instanceof Error &&
      refused.bodyError.message.startsWith("Ordinary popup close did not capture its one new isolated popup\n") &&
      !refused.trace.includes("close") && refused.assertions.length === 0 &&
      refused.trace.join("|") === (owned ? "destroy" : "") &&
      !!data && data.expectedPreload === expectedPreload &&
      data.createdCount === refused.windows.length && data.created.length === refused.windows.length &&
      data.created.every((entry, index) => entry.windowId === refused.windows[index].id &&
        entry.webContentsId === refused.windows[index].webContents.id &&
        entry.webPreferences === refused.preferences[index]) &&
      refused.bodyError.stack.includes("popupOpened: " + data.popupOpened) &&
      refused.bodyError.stack.includes("createdCount: " + refused.windows.length) &&
      refused.bodyError.stack.includes(util.inspect(expectedPreload)) &&
      data.created.every((entry, index) =>
        refused.bodyError.stack.includes("windowId: " + entry.windowId) &&
        refused.bodyError.stack.includes("webContentsId: " + entry.webContentsId) &&
        refused.bodyError.stack.includes("OBSERVED_POPUP_" + index)),
    "Actual popup authority refuses " + JSON.stringify(options) + " while retaining the R1240 diagnostic packet");
  }
  const late = await run({ lateDuplicate: true });
  check(late.bodyError instanceof Error && late.bodyError.message.includes("authority changed during normal close") &&
    late.assertions.length === 0,
  "A duplicate fixed request during actual normal close cannot inherit the earlier successful popup witness");
  const failedFormat = await run({ wrongPreload: true, formatFailure: true });
  check(failedFormat.bodyError instanceof Error && failedFormat.trace.join("|") === "destroy" &&
    failedFormat.assertions.length === 0 &&
    failedFormat.bodyError.message.startsWith("Ordinary popup close did not capture its one new isolated popup\n") &&
    failedFormat.bodyError.stack.includes("Popup capture diagnostics unavailable:") &&
    failedFormat.bodyError.stack.includes("POPUP_DIAGNOSTIC_FORMATTER_REFUSED"),
  "Popup diagnostic formatting refusal cannot replace the original capture refusal or close a rejected window");
}

async function reloadJourneyBoundaryContracts() {
  const journey = between(source, "async function runDocumentControlCloseJourney(",
    "\nasync function installDialogBatchPageObservation(");
  const priorAssertion = journey.indexOf('"SEC-08 actual close warns, acknowledges and retires only the deleted fixture owner"');
  const tailStart = journey.indexOf("\n  );\n", priorAssertion) + "\n  );\n".length;
  assert.ok(priorAssertion > 0 && tailStart > priorAssertion);
  const tail = journey.slice(tailStart, journey.lastIndexOf("\n}"));
  const legacyTail = '  await exec(`window.CustomTabs.switchToTab(${before.id}); null;`);\n' +
    tail.slice(tail.indexOf("  const restored ="));
  const switchCase = (options = {}) => {
    const gate = deferred(), control = { calls: 0, waits: 0, captures: [], checks: [],
      settled: false, finished: false, ownerVersion: 5 };
    const page = { window: { CustomTabs: { getActiveTabId: () => 7,
      switchToTab(id) {
        assert.equal(id, 7); control.calls++;
        control.work = (async () => {
          await gate.promise;
          if (options.error) throw options.error;
          control.settled = true; control.ownerVersion++;
          return Object.hasOwn(options, "result") ? options.result : true;
        })();
        control.work.catch(() => {});
        return control.work;
      } } }, document: { getElementById: () => ({ querySelector: () => ({ textContent: "Beta" }) }) } };
    const context = vm.createContext(page);
    const exec = async code => vm.runInContext(code, context);
    control.promise = vm.compileFunction("return (async () => {\n" +
      (options.legacy ? legacyTail : tail) + "\ncapture();})();",
    ["exec", "before", "waitForCondition", "check", "capture"])(
      exec, { id: 7, heading: "Beta" },
      async (run, predicate) => { control.waits++; return run(predicate); },
      (name, success) => control.checks.push({ name, success }),
      () => control.captures.push({ pending: !control.settled, ownerVersion: control.ownerVersion }));
    control.promise.then(() => { control.finished = true; }, error => { control.error = error; });
    return { control, release: () => gate.resolve(), exec };
  };
  const joined = switchCase();
  await turn();
  const waited = joined.control.calls === 1 && !joined.control.finished && !joined.control.settled &&
    joined.control.waits === 0 && joined.control.captures.length === 0 &&
    await joined.exec("window.CustomTabs.getActiveTabId() === 7 && document.getElementById('viewer').querySelector('h1').textContent === 'Beta'");
  joined.release(); await joined.control.promise;
  check(waited,
  "Actual return-to-Beta actor joins its one held switch even when the old ID/heading predicate is already true");
  check(joined.control.work instanceof Promise && joined.control.settled &&
    joined.control.captures.length === 1 && !joined.control.captures[0].pending &&
    joined.control.captures[0].ownerVersion === 6 && joined.control.waits === 1 &&
    joined.control.checks[0].name === "SEC-08 actual deletion close restores the previous rendered document" &&
    joined.control.checks[0].success === true,
  "Joined true switch completion precedes capture and retains the separate original rendered-document assertion");
  const dropped = switchCase({ legacy: true });
  await dropped.control.promise;
  check(dropped.control.calls === 1 && !dropped.control.settled &&
    dropped.control.captures[0].pending && dropped.control.captures[0].ownerVersion === 5 &&
    dropped.control.checks[0].success === true,
  "Actual former null-returning actor captures stale ownership while its same real asynchronous switch is still held");
  dropped.release(); await dropped.control.work;
  for (const result of [undefined, false, 0, 1, {}]) {
    const refused = switchCase({ result }); refused.release();
    await assert.rejects(refused.control.promise, /return switch did not succeed/);
    check(refused.control.calls === 1 && refused.control.waits === 0 &&
      refused.control.captures.length === 0 && refused.control.checks.length === 0,
    "Return-to-Beta requires exact successful true, not " + String(result));
  }
  const switchError = new Error("CONTROLLED_SWITCH_REJECTION");
  const rejected = switchCase({ error: switchError }); rejected.release();
  await assert.rejects(rejected.control.promise, error => error === switchError);
  check(rejected.control.calls === 1 && rejected.control.captures.length === 0 && rejected.control.waits === 0,
  "Original asynchronous return-switch rejection propagates without another switch or stale capture");

  const native = between(source, "async function runReloadTransportFailure(",
    "\nasync function runDocumentControlCloseJourney(");
  const formatter = between(source, "function uncaughtExceptionDetail(error) {", "\nfunction writeFatal(");
  const bounded = between(source, "async function boundedDialogWork(", "\nfunction inspectCleanRefreshSource(");
  const { EventEmitter } = require("node:events"), util = require("node:util");
  const observerCase = async (options = {}) => {
    const control = { sequence: 4, accepted: 4, selection: 9, calls: [], sends: [], assertions: [], timers: [],
      drains: 0, logs: [], packet: null, owner: { tabId: 7, pathKey: "beta-key",
        pageSession: "reload-session", documentGeneration: 3, documentRef: "a".repeat(64),
        rendererGeneration: 2 } };
    const ipcMain = new EventEmitter(), frame = { frameTreeNodeId: 31, processId: 11,
      routingId: 21, url: "file:///fixture/index.html", parent: null, detached: false,
      isDestroyed: () => false };
    const target = { id: 101, mainFrame: frame };
    const win = { webContents: target, isDestroyed: () => false };
    const nodes = { fileUpdateToast: { shown: false }, notificationMessage: { textContent: "" },
      appMessageDialog: { open: false }, appMessageTitle: { textContent: "CURRENT_TITLE" },
      appMessageText: { textContent: "CURRENT_TEXT" } };
    nodes.fileUpdateToast.classList = { contains: () => nodes.fileUpdateToast.shown };
    const tab = { id: 7, content: "# Beta\r\nBODY\r\n" };
    const page = { currentFilePath: "C:\\fixture\\beta.md", originalMarkdown: tab.content,
      fileUpdateNotificationShown: false, document: { getElementById: id => nodes[id] },
      currentReloadSnapshot: () => tab.content, i18n: key => key,
      showFileUpdateNotification() { page.fileUpdateNotificationShown = true; nodes.fileUpdateToast.shown = true; },
      showNotification(text) { nodes.notificationMessage.textContent = text; },
      window: { getReloadRequestSession: () => control.owner.pageSession,
        getReloadRequestDiagnostics: () => ({ sequence: control.sequence }),
        getActiveFileSelectionGeneration: () => control.selection,
        getLatestReloadRequestSequence: () => control.sequence,
        CustomTabs: { getActiveTab: () => tab, getActiveTabId: () => tab.id,
          getActiveDocumentIdentity: () => ({ ...control.owner }),
          __reloadState: () => ({ acceptedSequence: control.accepted }) } } };
    const context = vm.createContext(page), receiver = {}, extra = {};
    const sendResult = {}, completion = Promise.resolve("ORIGINAL_COMPLETION");
    const originalSend = function (...args) {
      control.sends.push({ receiver: this, args });
      if (!options.mismatchField && !options.foreignFrame && !options.foreignSender &&
          !options.ownerChanged && !options.selectionChanged && args[1]?.success) {
        control.accepted = args[1].reloadRequest.sequence;
        nodes.notificationMessage.textContent = "notif.fileReloaded";
        nodes.fileUpdateToast.shown = false; page.fileUpdateNotificationShown = false;
      }
      return sendResult;
    };
    target.send = originalSend;
    const descriptor = Object.getOwnPropertyDescriptor(target, "send");
    const originalError = new Error("ORIGINAL_MAIN_FAILURE");
    const original = function (...args) {
      control.calls.push({ receiver: this, args });
      if (options.mainThrows) throw originalError;
      if (options.mainRejects) {
        control.rejection = Promise.reject(originalError);
        return control.rejection;
      }
      const request = args[1];
      const reply = { path: request.filePath, content: tab.content, success: true,
        extra: undefined, notFinite: NaN,
        reloadSession: { pageSession: request.reloadRequestSession,
          rendererGeneration: request.reloadRequestRendererGeneration },
        reloadRequest: { sequence: request.reloadRequestSequence, path: request.reloadRequestPath,
          snapshot: request.reloadRequestSnapshot, session: request.reloadRequestSession,
          tabId: request.reloadRequestTabId, documentGeneration: request.reloadRequestDocumentGeneration,
          pathKey: request.reloadRequestDocumentPathKey, documentRef: request.reloadRequestDocumentRef,
          rendererGeneration: request.reloadRequestRendererGeneration,
          selectionGeneration: request.reloadRequestSelectionGeneration } };
      control.sendReturn = target.send.call(options.foreignReply ? {} : target, "file-reload-result", reply, extra);
      return completion;
    };
    ipcMain.on("reload-file", original);
    page.window.reloadCurrentFile = function () {
      if (options.refuse) {
        page.fileUpdateNotificationShown = false; nodes.fileUpdateToast.shown = false;
        nodes.notificationMessage.textContent = "CONTROLLED_PRODUCTION_REFUSAL"; return false;
      }
      if (options.ownerChanged) control.owner.documentGeneration++;
      if (options.selectionChanged) control.selection++;
      const owner = control.owner;
      const request = { filePath: page.currentFilePath, reloadRequestPath: owner.pathKey,
        reloadRequestSequence: ++control.sequence, reloadRequestSnapshot: tab.content,
        reloadRequestSession: owner.pageSession, reloadRequestTabId: owner.tabId,
        reloadRequestDocumentGeneration: owner.documentGeneration,
        reloadRequestDocumentPathKey: owner.pathKey, reloadRequestDocumentRef: owner.documentRef,
        reloadRequestRendererGeneration: owner.rendererGeneration,
        reloadRequestSelectionGeneration: control.selection, extra: undefined, notFinite: NaN };
      if (options.mismatchField) request[options.mismatchField] =
        typeof request[options.mismatchField] === "number" ? request[options.mismatchField] + 1 :
          request[options.mismatchField] + "-changed";
      if (options.diagnosticGetter) {
        request.filePath += "-changed";
        control.getterError = new Error("CONTROLLED_DIAGNOSTIC_GETTER");
        Object.defineProperty(request, "reloadRequestSequence", {
          get() { throw control.getterError; }, enumerable: true });
      }
      const event = { sender: options.foreignSender ? {} : target,
        senderFrame: options.foreignFrame ? { ...frame } : frame };
      control.request = request; control.event = event;
      for (let index = 0; index < (options.duplicate ? 2 : 1); index++) {
        control.forwardReturn = ipcMain.listeners("reload-file")[0].call(receiver, event, request, extra);
      }
      return true;
    };
    let body = native;
    if (options.legacyObserver) body = body
      .replace("if (args[0]?.sender === target) {", "if (false) {")
      .replace('      if (this === target && args[0] === "file-reload-result") observedReplies.push(args[1]);', "");
    if (options.unboundedFresh) body = body.replace(
      "fresh = await boundedDialogWork(exec(", "fresh = await ((work) => work)(exec(");
    const heldRead = deferred();
    const exec = async code => {
      if (options.freshFailure && code.includes("acceptedSequence:")) throw new Error("FRESH_READ_REFUSED");
      if (options.holdFresh && code.includes("acceptedSequence:")) {
        control.freshRequested = true;
        control.finishFresh = () => {
          control.freshReleased = true;
          if (options.lateReject) heldRead.reject(new Error("LATE_DIAGNOSTIC_REJECTION"));
          else heldRead.resolve(vm.runInContext(code, context));
        };
        return heldRead.promise;
      }
      return vm.runInContext(code, context);
    };
    let error = null;
    try {
      const work = vm.compileFunction(formatter + "\n" + bounded + "\n" + body +
        "\nreturn runReloadTransportFailure(win, exec, sentinel);",
      ["win", "exec", "sentinel", "ipcMain", "waitForCondition", "check", "require", "console",
        "setTimeout", "clearTimeout"])(
        win, exec, { drain: async () => { control.drains++; } }, ipcMain,
        async (run, expression, bound) => { assert.equal(bound, 8000); await turn(); return run(expression); },
        (name, success, detail) => control.assertions.push({ name, success, detail }),
        name => {
          assert.equal(name, "util");
          return { inspect: (packet, settings) => {
            control.packet = packet;
            if (options.formatFailure) throw new Error("TERMINAL_FORMAT_REFUSED");
            return util.inspect(packet, settings);
          } };
        }, { error: (...args) => control.logs.push(args.join(" ")) },
        (callback, delay) => {
          if (!options.holdFresh) return setTimeout(callback, delay);
          const timer = { callback, delay, cleared: false };
          control.timers.push(timer);
          return timer;
        },
        timer => {
          if (options.holdFresh) timer.cleared = true;
          else clearTimeout(timer);
        });
      work.then(() => { control.actorSettled = true; }, failure => {
        control.actorSettled = true; control.actorError = failure;
      });
      if (options.holdFresh) {
        await turn();
        control.beforeTimeout = { freshRequested: control.freshRequested,
          actorSettled: !!control.actorSettled, freshReleased: !!control.freshReleased,
          listenerOwned: ipcMain.listeners("reload-file")[0] !== original,
          sendOwned: target.send !== originalSend };
        for (const timer of control.timers) timer.callback();
        await turn();
        control.beforeLate = { actorSettled: !!control.actorSettled, error: control.actorError,
          freshReleased: !!control.freshReleased, packet: control.packet,
          fresh: control.packet?.fresh, logCount: control.logs.length,
          listenerRestored: ipcMain.listeners("reload-file")[0] === original,
          descriptorRestored: Object.getOwnPropertyDescriptor(target, "send").value === descriptor.value };
        control.finishFresh();
        await turn();
        control.afterLate = { error: control.actorError, fresh: control.packet?.fresh,
          logCount: control.logs.length, listenerRestored: ipcMain.listeners("reload-file")[0] === original,
          descriptorRestored: Object.getOwnPropertyDescriptor(target, "send").value === descriptor.value };
      }
      await work;
    } catch (failure) { error = failure; }
    assert.deepEqual(ipcMain.listeners("reload-file"), [original]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(target, "send"), descriptor);
    return { control, error, originalError, target, frame, receiver, extra, sendResult, completion };
  };
  const healthy = await observerCase();
  check(!healthy.error && healthy.control.calls.length === 2 && healthy.control.drains === 2 &&
    healthy.control.assertions.length === 5 && healthy.control.assertions.every(result => result.success) &&
    healthy.control.logs.length === 0 && healthy.control.forwardReturn === healthy.completion &&
    healthy.control.sendReturn === healthy.sendResult &&
    healthy.control.calls.every(call => call.receiver === healthy.receiver && call.args[2] === healthy.extra),
  "Actual reload observer retains its synchronous entrypoint, both original exact-match successes, retry, forwarding receivers/results and restoration");
  for (const field of ["filePath", "reloadRequestPath", "reloadRequestSequence", "reloadRequestSnapshot",
    "reloadRequestSession", "reloadRequestTabId", "reloadRequestDocumentGeneration",
    "reloadRequestDocumentPathKey", "reloadRequestDocumentRef", "reloadRequestRendererGeneration",
    "reloadRequestSelectionGeneration"]) {
    const bad = await observerCase({ mismatchField: field }), packet = bad.control.packet;
    check(bad.error?.message === "Genuine reload did not settle with its exact owner" &&
      bad.control.calls.length === 1 && bad.control.forwardReturn === bad.completion &&
      packet.requests.length === 0 && packet.replies.length === 0 &&
      packet.observedRequests.length === 1 && packet.observedReplies.length === 1 &&
      packet.observedRequests[0].request === bad.control.request &&
      !packet.observedRequests[0].accepted && packet.observedRequests[0].exactMainFrame &&
      packet.observedRequests[0].failedWitnessComparisons.length === 1 &&
      packet.observedRequests[0].failedWitnessComparisons[0].field === field &&
      packet.observedRequests[0].failedWitnessComparisons[0].actual === bad.control.request[field] &&
      Object.hasOwn(packet.observedRequests[0].request, "extra") &&
      Number.isNaN(packet.observedReplies[0].notFinite) &&
      bad.control.logs[0].includes("extra: undefined") && bad.control.logs[0].includes("notFinite: NaN"),
    "Actual unmatched same-window request and independent reply retain full lossless fields and failed comparison without admission: " + field);
  }
  const wrapped = await observerCase({ foreignFrame: true });
  check(wrapped.error && wrapped.control.packet.requests.length === 0 &&
    wrapped.control.packet.observedRequests[0].senderFrame === wrapped.control.event.senderFrame &&
    wrapped.control.packet.observedRequests[0].mainFrame === wrapped.frame &&
    !wrapped.control.packet.observedRequests[0].exactMainFrame &&
    wrapped.control.packet.observedRequests[0].senderFrameFacts.routingId === wrapped.frame.routingId &&
    wrapped.control.packet.observedRequests[0].failedWitnessComparisons.length === 0 &&
    wrapped.control.calls.length === 1,
  "Actual distinct sender-frame wrapper is diagnosed with full frame facts but never loosens the original exact-reference matcher");
  const ownerChanged = await observerCase({ ownerChanged: true });
  const selectionChanged = await observerCase({ selectionChanged: true });
  check(ownerChanged.control.packet.fresh.owner.documentGeneration >
      ownerChanged.control.packet.witness.owner.documentGeneration &&
    selectionChanged.control.packet.fresh.selection > selectionChanged.control.packet.witness.selection &&
    selectionChanged.control.packet.fresh.acceptedSequence === 4 &&
    selectionChanged.control.packet.fresh.sequence === 5 &&
    selectionChanged.control.packet.fresh.prompt.shown === true &&
    selectionChanged.control.packet.fresh.prompt.dialogOpen === false,
  "Failure records genuinely fresh owner, selection, dispatched/accepted sequences and prompt state rather than relabeling the pre-dispatch witness");
  const refused = await observerCase({ refuse: true });
  check(refused.error && refused.control.calls.length === 0 &&
    refused.control.packet.observedRequests.length === 0 && refused.control.packet.observedReplies.length === 0 &&
    refused.control.packet.fresh.sequence === 4 && refused.control.packet.fresh.acceptedSequence === 4 &&
    refused.control.packet.fresh.prompt.shown === false &&
    refused.control.packet.fresh.prompt.notification === "CONTROLLED_PRODUCTION_REFUSAL",
  "A genuine synchronous production refusal remains distinct from an observed unmatched dispatch and supplies current prompt state");
  const lossy = await observerCase({ mismatchField: "reloadRequestSelectionGeneration", legacyObserver: true });
  check(lossy.error && lossy.control.calls.length === 1 && lossy.control.sends.length === 1 &&
    lossy.control.packet.requests.length === 0 && lossy.control.packet.observedRequests.length === 0 &&
    lossy.control.packet.observedReplies.length === 0,
  "Former lossy exact-only observation reports zero while the same unmatched dispatch and target reply both ran");
  for (const options of [{ duplicate: true }, { foreignSender: true }, { foreignReply: true }]) {
    const bad = await observerCase(options);
    check(bad.error && bad.control.assertions.some(result => !result.success) &&
      (options.duplicate ? bad.control.packet.observedRequests.length === 2 :
        options.foreignSender ? bad.control.packet.observedRequests.length === 0 :
          bad.control.packet.observedReplies.length === 0),
    "Diagnostics do not admit or broaden duplicate/foreign routing: " + JSON.stringify(options));
  }
  const thrown = await observerCase({ mainThrows: true });
  check(thrown.error === thrown.originalError && thrown.control.calls.length === 1 &&
    thrown.control.packet.observedRequests.length === 1 && thrown.control.packet.fresh.owner.tabId === 7,
  "Original Main synchronous exception preserves identity and forwarding count while independent fresh diagnostics and restoration still run");
  const asyncFailure = await observerCase({ mainRejects: true });
  check(asyncFailure.error === asyncFailure.originalError &&
    asyncFailure.control.forwardReturn === asyncFailure.control.rejection &&
    asyncFailure.control.calls.length === 1 && asyncFailure.control.packet.requests[0].completed &&
    asyncFailure.control.packet.requests[0].error === asyncFailure.originalError,
  "Original matched Main promise rejection retains its exact completion, error identity and unchanged awaited failure path");
  const getterFailure = await observerCase({ diagnosticGetter: true });
  check(getterFailure.error === getterFailure.control.getterError &&
    getterFailure.control.calls.length === 1 &&
    getterFailure.control.packet.observationErrors[0] === getterFailure.control.getterError &&
    getterFailure.control.packet.observedRequests[0].request === getterFailure.control.request &&
    !getterFailure.control.packet.observedRequests[0].accepted,
  "A diagnostic field getter failure is recorded independently without masking or replacing the original forwarded Main exception");
  const freshFailure = await observerCase({ refuse: true, freshFailure: true });
  const formatFailure = await observerCase({ refuse: true, formatFailure: true });
  check(freshFailure.error?.message === refused.error.message &&
    freshFailure.control.packet.fresh.error.includes("FRESH_READ_REFUSED") &&
    formatFailure.error?.message === refused.error.message &&
    formatFailure.control.logs[0].includes("TERMINAL_FORMAT_REFUSED"),
  "Fresh-read and formatter failures cannot replace the original reload refusal or prevent observer restoration");
  for (const lateReject of [false, true]) {
    const held = await observerCase({ mainThrows: true, holdFresh: true, lateReject });
    const before = held.control.beforeTimeout, timed = held.control.beforeLate;
    check(before.freshRequested && !before.actorSettled && !before.freshReleased &&
      before.listenerOwned && before.sendOwned && held.control.timers.length === 1 &&
      held.control.timers[0].delay === 12000 && held.control.timers[0].cleared &&
      timed.actorSettled && !timed.freshReleased && timed.error === held.originalError &&
      held.error === held.originalError && timed.listenerRestored && timed.descriptorRestored &&
      timed.fresh.error.includes("Timed out: reload terminal fresh state"),
    "Actual held terminal diagnostic times out through the unchanged bounded helper, then preserves original error and restores observers before late " +
      (lateReject ? "rejection" : "completion"));
    check(held.control.afterLate.error === held.originalError &&
      held.control.afterLate.fresh === timed.fresh && held.control.afterLate.logCount === timed.logCount &&
      held.control.afterLate.listenerRestored && held.control.afterLate.descriptorRestored &&
      held.control.calls.length === 1 && held.control.assertions.length === 1,
    "Late diagnostic " + (lateReject ? "rejection" : "completion") +
      " cannot replace terminal evidence, rethrow another error or reinstall the restored observers");
  }
  const unbounded = await observerCase({ mainThrows: true, holdFresh: true, unboundedFresh: true });
  check(unbounded.control.beforeTimeout.freshRequested && unbounded.control.timers.length === 0 &&
    !unbounded.control.beforeLate.actorSettled && !unbounded.control.beforeLate.freshReleased &&
    !unbounded.control.beforeLate.listenerRestored && !unbounded.control.beforeLate.descriptorRestored &&
    unbounded.control.beforeLate.packet === null && unbounded.error === unbounded.originalError &&
    unbounded.control.afterLate.listenerRestored && unbounded.control.afterLate.descriptorRestored,
  "Actual former unbounded diagnostic blocks the original throw and restoration until its held read is explicitly released");
}

async function shutdownRestoreOrderingContracts() {
  const helpers = between(source, "  let cleanFixtureAdmissions = null;",
    "  const ownApprovalHold = () => {");
  const observe = between(source, "async function observeOrdinaryShutdownFixtures(",
    "\nasync function runShutdownScenarios(");
  const restore = between(source, "async function settleShutdownLifecycleRestore(",
    "\nasync function runShutdownGenerationScenarios(");
  const bounded = between(source, "async function boundedDialogWork(", "\nfunction inspectCleanRefreshSource(");
  const main = fs.readFileSync(path.join(producerRoot, "main.js"), "utf8").replace(/\r\n/g, "\n");
  const scope = between(main, "function admissionScopeIsCurrent(", "\nfunction pruneAdmissionScopeFences(");
  const referenceStart = main.indexOf("function admittedDocumentReference(");
  const referenceEnd = main.indexOf("\n}\n", referenceStart);
  assert.ok(referenceStart > 0 && referenceEnd > referenceStart);
  const reference = main.slice(referenceStart, referenceEnd + 3);
  const closeStart = source.indexOf("async function closeOwnedFixtureTabs(");
  const guardStart = source.indexOf("  for (const target of plan.targets) {", closeStart);
  const guardEnd = source.indexOf("    const cleanupKey = require(", guardStart);
  assert.ok(closeStart > 0 && guardStart > closeStart && guardEnd > guardStart);
  const guard = vm.compileFunction(source.slice(guardStart, guardEnd) + "\n}\nreturn true;",
    ["plan", "__shutdown", "phase"]);
  const fixture = async (options = {}) => {
    const fileQ1 = "C:\\fixture\\quit-alpha.md", fileQ2 = "C:\\fixture\\quit-beta.md";
    const inputs = { alpha: { path: fileQ1, pathKey: "alpha-key", content: "# Quit Alpha\n\nQ_ALPHA\n" },
      beta: { path: fileQ2, pathKey: "beta-key", content: "# Quit Beta\n\nQ_BETA\n" } };
    const control = { trace: [], reloads: 0, resets: 0, chooserCalls: 0, records: new Map(),
      pendingSaves: { pending: false, count: 0 }, frozen: false, authorized: false,
      pendingId: 0, commitPendingId: 0, continuations: 0, dropped: false, clock: 0 };
    const wc = { isDestroyed: () => false,
      mainFrame: { frameTreeNodeId: 31, isDestroyed: () => false } };
    const mainContext = vm.createContext({ mainWindow: { webContents: wc },
      approvalRendererState: "ready", approvalRendererGeneration: 3,
      approvalRendererPageSession: "ordinary-page-3", documentAdmissions: control.records,
      admittedOwnerTabs: new Map(), committedDiskAdoptions: new Map() });
    const admission = vm.runInContext(scope + "\n" + reference +
      "\n(ref => !!admittedDocumentReference(ref))", mainContext);
    let tabs = [], selected = null, nextId = 0, nextRef = 0, pendingRestore = false;
    const page = { window: {}, document: { getElementById: () => ({ textContent:
      options.omitPaint && control.reloads ? "UNPAINTED" : tabs.find(tab => tab.id === selected)?.content || "",
      querySelectorAll: () => [{ textContent: tabs.find(tab => tab.id === selected)?.content || "" }] }) },
      Date: { now: () => control.clock },
      setTimeout: (callback, delay) => {
        assert.equal(delay, 25); control.clock += 1000;
        if (pendingRestore) finishRestore();
        queueMicrotask(callback);
      } };
    const ownerOf = tab => tab ? { ...tab.owner } : null;
    const descriptorOf = tab => tab ? { ...tab.descriptor } : null;
    const admit = tab => control.records.set(tab.descriptor.ref, {
      sender: wc, frameTreeNodeId: wc.mainFrame.frameTreeNodeId,
      rendererGeneration: mainContext.approvalRendererGeneration,
      pageSession: mainContext.approvalRendererPageSession, retired: false,
      tabId: tab.id, documentGeneration: tab.owner.documentGeneration, descriptor: tab.descriptor });
    const makeTab = input => {
      const id = ++nextId, ref = (++nextRef).toString(16).padStart(64, "0");
      return { id, filePath: input.path, content: input.content, originalContent: input.content,
        hasUnsavedChanges: false, descriptor: { ref, logicalPath: input.path },
        owner: { tabId: id, documentRef: ref, pathKey: input.pathKey, documentGeneration: 1,
          rendererGeneration: mainContext.approvalRendererGeneration,
          pageSession: mainContext.approvalRendererPageSession } };
    };
    const syncSelected = () => {
      const tab = tabs.find(tab => tab.id === selected);
      page.window.currentFilePath = tab?.filePath;
      page.window.originalMarkdown = tab?.content;
      page.window.markdownEditor = { value: tab?.content };
    };
    const finishRestore = () => {
      pendingRestore = false; control.trace.push("restore-admissions");
      if (!options.omitReadmission) for (const tab of tabs) admit(tab);
    };
    page.window.getReloadRequestSession = () => mainContext.approvalRendererPageSession;
    page.window.getActiveFileSelectionGeneration = () => 1;
    page.window.getPendingSaveStatus = () => ({ ...control.pendingSaves });
    page.window.queryDocumentDeletionState = (_path, owner) => ({
      known: !!owner && admission(owner.documentRef), unresolved: false });
    page.window.CustomTabs = {
      getTabs: () => tabs, getActiveTab: () => tabs.find(tab => tab.id === selected),
      getActiveTabId: () => selected,
      getDocumentIdentityForTab: id => ownerOf(tabs.find(tab => tab.id === id)),
      getDocumentDescriptor: id => descriptorOf(tabs.find(tab => tab.id === id)),
      __dirtyTabNames: () => tabs.filter(tab => tab.hasUnsavedChanges).map(tab => tab.filePath),
      __inEditMode: () => !!control.editing,
      __shutdownFreeze: () => ({ frozen: control.frozen, deferredOperationsDropped: control.dropped }),
      isDocumentFrozen: () => control.frozen,
      settleSessionLayout: async () => {
        control.trace.push("layout");
        if (pendingRestore || tabs.some(tab => !admission(tab.descriptor.ref))) {
          throw new Error("The open tabs are still awaiting document restore");
        }
      },
    };
    page.document.querySelectorAll = () => [{ dataset: { tabId: String(selected) } }];
    const pageContext = vm.createContext(page);
    const exec = async code => vm.runInContext(code, pageContext);
    const shutdown = {
      state: () => ({ renderer: mainContext.approvalRendererState,
        rendererGeneration: mainContext.approvalRendererGeneration,
        pendingId: control.pendingId, commitPendingId: control.commitPendingId,
        shutdownPendingContinuationCount: control.continuations, authorized: control.authorized }),
      documentAdmissionIsCurrent: admission,
      reset() {
        control.trace.push("reset"); control.resets++; control.frozen = false;
        control.records.clear();
      },
    };
    wc.reload = () => {
      control.trace.push("reload"); control.reloads++;
      if (!options.sameGeneration) mainContext.approvalRendererGeneration++;
      mainContext.approvalRendererPageSession = "ordinary-page-" + mainContext.approvalRendererGeneration;
      mainContext.approvalRendererState = "ready";
      wc.mainFrame.frameTreeNodeId++;
      const selectedPath = tabs.find(tab => tab.id === selected)?.filePath;
      tabs = tabs.map(tab => makeTab(Object.values(inputs).find(input => input.path === tab.filePath)));
      selected = tabs.find(tab => tab.filePath === selectedPath)?.id;
      syncSelected(); pendingRestore = true;
    };
    let body = helpers;
    if (options.oldOrdering) body = body.replace(
      "if (freeze.frozen || recoverRetained) {", "if (freeze.frozen) {");
    if (options.omitReload) body = body.replace("      wc.reload();", "      null;");
    if (options.omitSettle) body = body.replace(
      '      await settleShutdownLifecycleRestore(exec, fixture.path, fixture.content,\n' +
      '        fixture.path === fileQ1 ? "Q_ALPHA" : "Q_BETA");', "");
    if (options.noCapturedAdmissions) body = body.replace("    cleanFixtureAdmissions = [alpha, beta];", "");
    const compiled = vm.compileFunction(observe + "\n" + bounded + "\n" + restore + "\n" + body +
      "\nreturn { openCleanFixtures, restoreCleanDocuments };",
    ["exec", "__shutdown", "wc", "fileQ1", "fileQ2", "cleanCloseFixtureInputs", "joinDialogs",
      "openShutdownLifecycleFixture", "retireOrdinaryShutdownFixtures", "waitForCondition",
      "waitUntil", "setTimeout", "clearTimeout"])(
      exec, shutdown, wc, fileQ1, fileQ2, inputs,
      async () => { control.trace.push("join"); },
      async (_exec, filePath, text, marker) => {
        control.trace.push("chooser"); control.chooserCalls++;
        const input = Object.values(inputs).find(entry => entry.path === filePath);
        assert.equal(text, input.content); assert(input.content.includes(marker));
        const tab = makeTab(input); tabs.push(tab); selected = tab.id; admit(tab); syncSelected();
        assert(admission(tab.descriptor.ref));
        return { tabId: tab.id, filePath, owner: ownerOf(tab), descriptor: descriptorOf(tab) };
      },
      async (_exec, phase) => {
        control.trace.push("retire");
        const targets = tabs.map(tab => ({ tabId: tab.id, path: tab.filePath, expectedTarget: null,
          owner: ownerOf(tab), descriptor: descriptorOf(tab) }));
        guard({ targets }, shutdown, phase);
        tabs = []; selected = null; syncSelected();
      },
      async (run, predicate, timeout) => { assert.equal(timeout, 5000); return run(predicate); },
      async (predicate, timeout) => { assert.equal(timeout, 20000); return predicate(); },
      setTimeout, clearTimeout);
    await compiled.openCleanFixtures();
    control.trace = []; control.chooserCalls = 0;
    mainContext.approvalRendererState = options.ready ? "ready" : "unusable";
    control.frozen = !!options.frozen; control.authorized = !!options.authorized;
    control.dropped = !!options.dropped;
    control.pendingId = options.pendingId || 0; control.commitPendingId = options.commitPendingId || 0;
    control.continuations = options.continuations || 0;
    const initialRefs = tabs.map(tab => tab.descriptor.ref);
    const initialRecordsSurvive = initialRefs.every(ref => control.records.has(ref));
    const initialAdmissions = initialRefs.map(admission);
    if (options.dirty) tabs[0].hasUnsavedChanges = true;
    if (options.wrongContent) tabs[0].content += "UNSAVED";
    if (options.wrongBaseline) tabs[0].originalContent += "WRONG";
    if (options.foreign) tabs[0].filePath = "C:\\foreign\\other.md";
    if (options.foreignRef) tabs[0].descriptor.ref = "f".repeat(64);
    if (options.foreignOwner) tabs[0].owner.documentGeneration++;
    if (options.wrongSelectedSource) page.window.originalMarkdown += "UNSAVED";
    if (options.editorDirty) { control.editing = true; page.window.markdownEditor.value += "UNSAVED"; }
    if (options.pendingSave) control.pendingSaves = { pending: true, count: 1 };
    const before = JSON.stringify(tabs);
    let error = null, result;
    try { result = await compiled.restoreCleanDocuments(); } catch (failure) { error = failure; }
    return { control, error, result, initialRefs, initialRecordsSurvive, initialAdmissions, before,
      after: JSON.stringify(tabs), records: control.records, tabs, generation: mainContext.approvalRendererGeneration };
  };
  const recovered = await fixture();
  check(recovered.initialRefs.length === 2 && recovered.initialRecordsSurvive &&
    recovered.initialRefs.every(ref => typeof ref === "string") &&
    recovered.initialAdmissions.every(value => value === false) &&
    !recovered.error && recovered.result.tabs === 2 && recovered.control.reloads === 1 &&
    recovered.control.resets === 2 && recovered.control.chooserCalls === 2 && recovered.generation > 3 &&
    recovered.control.trace.indexOf("reload") < recovered.control.trace.indexOf("restore-admissions") &&
    recovered.control.trace.indexOf("restore-admissions") < recovered.control.trace.indexOf("retire"),
  "Actual nonready/unfrozen helper restores a newer authenticated page before strict retirement despite surviving refused old descriptors");
  const old = await fixture({ oldOrdering: true });
  check(old.error?.message.includes("no current Main admission") && old.control.trace.join("|") === "join|retire" &&
    old.records.size === 2 && old.initialAdmissions.every(value => !value) &&
    old.control.resets === 0 && old.control.reloads === 0 && old.control.chooserCalls === 0,
  "Actual old retire-before-recovery ordering is refused by the real Main predicate before any baseline-clearing reset");
  const noReload = await fixture({ omitReload: true });
  check(noReload.error?.message.includes("did not reach a replacement page") &&
    noReload.control.resets === 1 && noReload.control.reloads === 0 &&
    !noReload.control.trace.includes("retire") && noReload.control.chooserCalls === 0,
  "Bare reset cannot replace the genuine reload and newer READY generation before retirement");
  const sameGeneration = await fixture({ sameGeneration: true });
  check(sameGeneration.error?.message.includes("did not reach a replacement page") &&
    sameGeneration.control.reloads === 1 && sameGeneration.generation === 3 &&
    !sameGeneration.control.trace.includes("retire") && sameGeneration.control.chooserCalls === 0,
  "A ready signal without a strictly newer generation cannot qualify retained recovery");
  for (const options of [{ omitSettle: true }, { omitReadmission: true }, { omitPaint: true }]) {
    const bad = await fixture(options);
    check(bad.error && bad.control.reloads === 1 && bad.control.chooserCalls === 0 &&
      (options.omitSettle ? bad.error.message.includes("no current Main admission") :
        !bad.control.trace.includes("retire")),
    "Actual authenticated restore cannot be omitted or replaced by READY alone: " + JSON.stringify(options));
  }
  for (const options of [{ dirty: true }, { wrongContent: true }, { wrongBaseline: true },
    { foreign: true }, { foreignRef: true }, { foreignOwner: true }, { wrongSelectedSource: true },
    { editorDirty: true }, { pendingSave: true }, { noCapturedAdmissions: true }]) {
    const bad = await fixture(options);
    check(bad.error?.message.includes("cannot discard unproven or dirty fixtures") &&
      bad.before === bad.after && bad.control.resets === 0 && bad.control.reloads === 0 &&
      bad.control.chooserCalls === 0 && !bad.control.trace.includes("retire"),
    "Unfrozen nonready recovery refuses without discarding or rewriting retained data: " + JSON.stringify(options));
  }
  for (const options of [{ pendingId: 7 }, { commitPendingId: 8 }, { continuations: 1 }]) {
    const bad = await fixture(options);
    check(bad.error?.message.includes("before its consuming attempt settled") &&
      bad.control.trace.join("|") === "join" && bad.control.resets === 0,
    "Original joined-dialog and no-pending-continuation prerequisites remain required: " + JSON.stringify(options));
  }
  const unauthorized = await fixture({ frozen: true });
  const authorized = await fixture({ frozen: true, authorized: true });
  check(unauthorized.error?.message.includes("unauthorised retained freeze") &&
    unauthorized.control.resets === 0 && unauthorized.control.reloads === 0 &&
    !authorized.error && authorized.control.reloads === 1 && authorized.control.resets === 2,
  "Only the frozen branch requires authorization; its original authenticated recovery remains intact");
  const ready = await fixture({ ready: true });
  const dropped = await fixture({ ready: true, dropped: true });
  check(!ready.error && ready.control.reloads === 0 && ready.control.resets === 1 &&
    ready.control.trace.indexOf("retire") < ready.control.trace.indexOf("reset") &&
    !dropped.error && dropped.control.reloads === 1 &&
    dropped.control.trace.indexOf("retire") < dropped.control.trace.indexOf("reload"),
  "Ready retirement and the existing post-retirement empty-page recovery keep their original ordering");
}

async function ackContinuationDiagnosticContracts() {
  const loop = between(source, "    const committedReplyCases = [",
    "\n    const reloadWithRestoredPhysicalSelection = async");
  const start = "        if (!await waitUntil(() => rig.closes === 1, 10000)) {";
  const boundary = between(loop, start, '\n        if (outcome === "committed") {');
  const legacy = start + '\n' +
    '          throw new Error("Ordinary ACK fixture did not join its real released continuation");\n        }';
  const cleanup = between(source, "async function withOrdinaryShutdownCleanup(",
    "\nfunction holdOrdinaryShutdownApproval(");
  const formatter = between(source, "function uncaughtExceptionDetail(error) {", "\nfunction writeFatal(");
  const util = require("node:util");
  const run = async (options = {}) => {
    const trace = [], created = [], inspected = [];
    const commit = { id: 11, gen: 3, revision: 5 };
    const ack = { ...commit, committed: true, unobserved: undefined };
    let hooks = 0;
    Object.defineProperty(ack, "extra", { enumerable: true,
      get() { hooks++; throw new Error("Packet inspection invoked a getter"); } });
    Object.defineProperty(ack, util.inspect.custom, {
      get() { hooks++; throw new Error("Packet inspection invoked a custom hook"); },
    });
    const replacementRequest = { id: 12, gen: 3, reason: "window-close" };
    const replacementResponse = { id: 12, gen: 3, revision: 5, dirtyFiles: [], status: "ok" };
    const oldSnapshot = { packet: commit, captured: 1, released: false,
      retired: null, restored: false, restorationAttempted: false };
    const replacementSnapshot = { request: replacementRequest, captured: true, released: true,
      retired: null, restored: false, restorationAttempted: false };
    const state = { renderer: "ready", rendererGeneration: 3, pendingId: 0,
      commitPendingId: 12, shutdownPendingContinuationCount: 0, authorized: false };
    const records = [{ id: 11, reason: "window-close", continuationInvokedAt: undefined },
      { id: 12, reason: "window-close", continuationInvokedAt: 27 },
      { id: 99, reason: "FOREIGN_REQUEST_MUST_NOT_BE_REPORTED", continuationInvokedAt: 31 }];
    const questions = [0, 1].map(response => ({ pendingReason: "window-close", response,
      options: { type: "warning", title: "ACTUAL_QUESTION_" + response,
        message: "Observed question", detail: "X".repeat(12000) + "ACK_QUESTION_DETAIL_TAIL",
        buttons: ["Close anyway", "Cancel"], defaultId: 1, cancelId: 1 } }));
    const rig = { closes: options.closes ?? 0, quits: 0, dialogs: questions, answer: 1 };
    const diagnosticFault = options.unformattable ? Object.defineProperty({}, "stack", {
      get() { throw new Error("Unreadable diagnostic exception"); },
    }) : new Error("ACK_DIAGNOSTIC_REFUSED");
    const read = (label, value) => {
      trace.push(label);
      if (options.fault === label) throw diagnosticFault;
      return value;
    };
    const hold = { get answer() { return read("held-answer", ack); },
      snapshot: () => read("original-snapshot", { ...oldSnapshot }) };
    const reissued = options.noReplacement ? null : {
      get request() { return read("replacement-request", replacementRequest); },
      get response() { return read("replacement-response", replacementResponse); },
      snapshot: () => read("replacement-snapshot", { ...replacementSnapshot }),
    };
    const context = vm.createContext({
      Error: function (message) { const error = new Error(message); created.push(error); return error; },
      AggregateError, replyCase: { name: "fractional revision" }, commit, hold, reissued, rig,
      __shutdown: { state: () => read("state", state),
        timing: { state: () => read("timing", { enabled: true, requests: records }) } },
      waitUntil: async (predicate, timeout) => {
        trace.push("wait"); assert.equal(timeout, 10000); return predicate();
      },
      require: name => {
        assert.equal(name, "util");
        return { inspect: (packet, settings) => {
          inspected.push(packet); read("inspect", null);
          return util.inspect(packet, settings);
        } };
      },
      restoreReplacement: () => {
        if (reissued) { trace.push("restore-replacement"); replacementSnapshot.restored = true; }
      },
      restoreOriginal: () => { trace.push("restore-original"); oldSnapshot.restored = true; },
    });
    let error = null, result;
    try {
      result = await vm.runInContext(formatter + "\n" + cleanup +
        "\nwithOrdinaryShutdownCleanup(async () => {\n" + (options.legacy ? legacy : boundary) +
        '\nreturn "UNCHANGED_SUCCESS";\n}, [restoreReplacement, restoreOriginal]);', context);
    } catch (failure) { error = failure; }
    return { trace, created, inspected, error, result, commit, ack, replacementRequest,
      replacementResponse, state, records, rig, oldSnapshot, replacementSnapshot, hooks };
  };
  const current = await run(), packet = current.inspected[0], failure = current.created[0];
  check(current.error instanceof AggregateError && current.error.errors[0] === failure &&
    failure.message.startsWith("Ordinary ACK fixture did not join its real released continuation\n") &&
    failure.stack.includes("ACK continuation observation:") &&
    current.trace[0] === "wait" && current.trace.filter(label => label === "wait").length === 1,
  "Actual ACK timeout appends evidence to the same original Error after its unchanged exact-one-close wait");
  check(packet.replyCase === "fractional revision" && packet.commit === current.commit &&
    packet.heldACK === current.ack && packet.replacementRequest === current.replacementRequest &&
    packet.replacementResponse === current.replacementResponse &&
    packet.originalHold.packet === current.commit && packet.originalHold.released === false &&
    packet.originalHold.restored === false && packet.replacementHold.request === current.replacementRequest &&
    packet.replacementHold.released === true && packet.replacementHold.restored === false &&
    packet.state === current.state && packet.closes === 0 && packet.quits === 0,
  "Actual ACK packet retains both existing holds and the replacement response absent from its hold snapshot");
  check(packet.timing.enabled && packet.timing.requests.length === 2 &&
    packet.timing.requests[0] === current.records[0] && packet.timing.requests[1] === current.records[1] &&
    failure.stack.includes("continuationInvokedAt: 27") &&
    !failure.stack.includes("FOREIGN_REQUEST_MUST_NOT_BE_REPORTED") &&
    failure.stack.includes("unobserved: undefined"),
  "Actual ACK packet retains old/new timing including continuation entry without inventing absent evidence");
  check(packet.questions.length === 2 && packet.questions[0].response === 0 &&
    packet.questions[1].response === 1 && packet.questions[1].options.defaultId === 1 &&
    packet.questions[1].options.cancelId === 1 && current.rig.answer === 1 &&
    failure.stack.includes("ACK_QUESTION_DETAIL_TAIL") && current.hooks === 0,
  "Actual question answers and safe defaults survive untruncated inspection without invoking application hooks");
  check(current.trace.slice(-2).join("|") === "restore-replacement|restore-original" &&
    current.oldSnapshot.released === false && current.replacementSnapshot.released === true &&
    current.oldSnapshot.restored && current.replacementSnapshot.restored &&
    current.error.message.includes("ACK continuation observation:"),
  "Existing independent cleanup follows packet capture without releasing the original held ACK or changing answers");
  for (const fault of ["held-answer", "replacement-request", "replacement-response",
    "original-snapshot", "replacement-snapshot", "timing", "state", "inspect"]) {
    const refused = await run({ fault, unformattable: fault === "inspect" });
    check(refused.error?.errors[0] === refused.created[0] &&
      refused.created[0].message.startsWith("Ordinary ACK fixture did not join its real released continuation\n") &&
      refused.created[0].stack.includes("ACK continuation diagnostics unavailable:") &&
      refused.created[0].stack.includes(fault === "inspect" ?
        "<exception could not be formatted>" : "ACK_DIAGNOSTIC_REFUSED") &&
      refused.trace.slice(-2).join("|") === "restore-replacement|restore-original",
    "Observational " + fault + " failure preserves the original ACK Error and both independent restorations");
  }
  const legacyRun = await run({ legacy: true });
  check(legacyRun.error?.errors[0] === legacyRun.created[0] &&
    !legacyRun.created[0].stack.includes("ACK continuation observation:") &&
    legacyRun.inspected.length === 0 &&
    legacyRun.trace.join("|") === "wait|restore-replacement|restore-original",
  "Executed old ACK timeout counterfactual throws and cleans up but genuinely loses all post-release evidence");
  const duplicate = await run({ closes: 2 });
  check(duplicate.error?.errors[0] === duplicate.created[0] && duplicate.inspected[0].closes === 2,
  "Two closes still fail the original exactly-one condition rather than being accepted as completion");
  const success = await run({ closes: 1 });
  check(!success.error && success.result === "UNCHANGED_SUCCESS" && success.created.length === 0 &&
    success.inspected.length === 0 && success.trace.join("|") === "wait|restore-replacement|restore-original",
  "Successful original ACK continuation performs no diagnostic reads and keeps its cleanup and result");
  const noReplacement = await run({ noReplacement: true });
  check(noReplacement.error?.errors[0] === noReplacement.created[0] &&
    noReplacement.inspected[0].replacementRequest === null &&
    noReplacement.inspected[0].replacementResponse === null &&
    noReplacement.inspected[0].replacementHold === null &&
    noReplacement.inspected[0].timing.requests.length === 1,
  "ACK failures without a replacement retain only the original request evidence and explicit null replacement");
}

async function terminalAggregateDiagnosticContracts() {
  const formatter = between(source, "function uncaughtExceptionDetail(error) {", "\nfunction writeFatal(");
  const legacyFormatter = 'function uncaughtExceptionDetail(error) {\n  try {\n' +
    '    return error && error.stack ? String(error.stack) : String(error);\n' +
    '  } catch {\n    return "<exception could not be formatted>";\n  }\n}\n';
  const terminal = between(source, '  } catch (error) {\n    let rendererErrors = "";',
    "\n\n  let restoreBatchQuit = null;");
  const lifecycle = between(source, "async function openShutdownLifecycleFixture(",
    "\nasync function clearShutdownLifecycleDocuments(");
  const aggregation = between(lifecycle, "    if (failure || failures.length) {",
    "\n  }\n  return result;");
  const util = require("node:util");
  const leaf = new Error("PRIMARY_DEEP_LEAF", { cause: new Error("PRIMARY_DEEP_CAUSE") });
  leaf.stack += "\n    at ORIGINAL_PRIMARY_FRAME\n" +
    "X".repeat(12000) + "UNTRUNCATED_LIFECYCLE_STACK_TAIL";
  const primary = new AggregateError([new AggregateError([leaf], "PRIMARY_NESTED")],
    "PRIMARY_FAILURE", { cause: new Error("PRIMARY_AGGREGATE_CAUSE") });
  const chooserCleanup = new Error("INDEPENDENT_CHOOSER_CLEANUP", {
    cause: new Error("CHOOSER_CLEANUP_CAUSE"),
  });
  const observationCleanup = new AggregateError([new Error("INDEPENDENT_OBSERVATION_CLEANUP")],
    "OBSERVATION_CLEANUP_FAILURE", { cause: new Error("OBSERVATION_CLEANUP_CAUSE") });
  let aggregate = null, hooks = 0;
  try {
    vm.compileFunction(aggregation, ["failure", "failures", "AggregateError"])(
      primary, [chooserCleanup, observationCleanup], AggregateError);
  } catch (error) { aggregate = error; }
  check(aggregate instanceof AggregateError && aggregate.errors[0] === primary &&
    aggregate.errors[1] === chooserCleanup && aggregate.errors[2] === observationCleanup,
  "Actual lifecycle aggregate already retains the primary failure and both independent cleanup errors in order");
  Object.defineProperty(aggregate, util.inspect.custom, {
    get() { hooks++; throw new Error("Aggregate inspection must not invoke application hooks"); },
  });
  Object.defineProperty(aggregate, "unobserved", { enumerable: true,
    get() { hooks++; throw new Error("Aggregate inspection must not evaluate application getters"); } });
  const rendererEvidence = '[{"message":"RENDERER_PORT_EVIDENCE"}]';
  const run = async (input, options = {}) => {
    const lines = [], results = [], reads = [];
    let inspections = 0;
    const activeFormatter = options.oldFormatter ? legacyFormatter : formatter;
    const activeTerminal = options.oldReporter ? terminal.replace("uncaughtExceptionDetail(error)",
      "(error && error.stack ? error.stack : error)") : terminal;
    await vm.runInNewContext(activeFormatter + "\n(async () => {\n  try { throw input;\n" +
      activeTerminal + "\n})()", {
      input, AggregateError, results,
      console: { log: line => lines.push(line) },
      win: { webContents: { executeJavaScript: async (script, gesture) => {
        reads.push({ script, gesture });
        if (options.rendererFailure) throw new Error("SIMULATED_RENDERER_EVIDENCE_REFUSAL");
        return rendererEvidence;
      } } },
      require: name => {
        assert.equal(name, "util");
        return { inspect: (value, settings) => {
          inspections++;
          assert.equal(value, aggregate);
          if (options.formatFailure) throw new Error("SIMULATED_AGGREGATE_FORMATTER_REFUSAL");
          return util.inspect(value, settings);
        } };
      },
    });
    return { lines, results, reads, inspections };
  };
  const current = await run(aggregate);
  const required = ["PRIMARY_DEEP_LEAF", "PRIMARY_DEEP_CAUSE", "PRIMARY_AGGREGATE_CAUSE",
    "ORIGINAL_PRIMARY_FRAME", "UNTRUNCATED_LIFECYCLE_STACK_TAIL", "INDEPENDENT_CHOOSER_CLEANUP",
    "CHOOSER_CLEANUP_CAUSE", "INDEPENDENT_OBSERVATION_CLEANUP", "OBSERVATION_CLEANUP_CAUSE"];
  check(required.every(marker => current.lines[0].includes(marker)) && current.inspections === 1 &&
    hooks === 0 && !/\u001b\[/.test(current.lines[0]),
  "Actual formatter and terminal retain nested primary and independent cleanup stacks and causes without hooks or colors");
  check(current.lines.length === 1 && current.lines[0].startsWith("FAIL  harness threw  -> ") &&
    (current.lines[0].match(/^FAIL  harness threw  -> /gm) || []).length === 1 &&
    current.lines[0].endsWith("\nrenderer errors: " + rendererEvidence) &&
    current.results.length === 1 && current.results[0].name === "harness" &&
    current.results[0].ok === false && current.reads.length === 1 &&
    current.reads[0].script === "JSON.stringify(window.__e2eErrors || [])" &&
    current.reads[0].gesture === true,
  "Actual terminal preserves its single failure header renderer suffix original renderer read and one failed accounting entry");
  for (const option of ["oldFormatter", "oldReporter"]) {
    const incomplete = await run(aggregate, { [option]: true });
    check(incomplete.lines.length === 1 &&
      incomplete.lines[0].includes("Shutdown lifecycle admission or observation cleanup failed") &&
      required.every(marker => !incomplete.lines[0].includes(marker)) &&
      incomplete.inspections === 0 && incomplete.results.length === 1 &&
      incomplete.results[0].ok === false,
    "Executed " + option + " counterfactual loses actual nested evidence even when the other edit is present");
  }
  const normal = new Error("UNCHANGED_NORMAL_ERROR", { cause: new Error("UNCHANGED_NORMAL_CAUSE") });
  const ordinary = await run(normal);
  check(ordinary.lines[0] === "FAIL  harness threw  -> " + normal.stack +
    "\nrenderer errors: " + rendererEvidence && ordinary.inspections === 0,
  "Normal Error stack formatting remains byte-exact and does not enter aggregate inspection");
  for (const input of ["primitive evidence", 0, false, 13n, Symbol("evidence"), null, undefined]) {
    const primitive = await run(input);
    check(primitive.lines[0] === "FAIL  harness threw  -> " + String(input) +
      "\nrenderer errors: " + rendererEvidence && primitive.inspections === 0 &&
      primitive.results.length === 1 && primitive.results[0].ok === false,
    "Existing primitive formatter branch and terminal accounting remain stable for " + typeof input + ":" + String(input));
  }
  const unreadableStack = Object.defineProperty({}, "stack", {
    get() { throw new Error("Unreadable original stack"); },
  });
  const unreadableValue = { toString() { throw new Error("Unreadable original value"); } };
  for (const input of [unreadableStack, unreadableValue]) {
    const refused = await run(input);
    check(refused.lines[0] === "FAIL  harness threw  -> <exception could not be formatted>" +
      "\nrenderer errors: " + rendererEvidence && refused.results.length === 1 &&
      refused.results[0].ok === false,
    "Existing defensive formatter fallback remains exact when original diagnostic access throws");
  }
  const refusedFormat = await run(aggregate, { formatFailure: true });
  check(refusedFormat.lines[0] === "FAIL  harness threw  -> <exception could not be formatted>" +
    "\nrenderer errors: " + rendererEvidence && refusedFormat.results.length === 1 &&
    refusedFormat.results[0].ok === false && refusedFormat.inspections === 1,
  "Built-in aggregate inspection refusal uses the unchanged defensive fallback without hiding terminal accounting");
  const refusedRenderer = await run(aggregate, { rendererFailure: true });
  check(refusedRenderer.lines.length === 1 && required.every(marker => refusedRenderer.lines[0].includes(marker)) &&
    !refusedRenderer.lines[0].includes("\nrenderer errors:") &&
    refusedRenderer.results.length === 1 && refusedRenderer.results[0].ok === false,
  "Existing renderer-evidence refusal still omits only its suffix and retains nested failure details and accounting");
}

async function shutdownAdmissionDiagnosticContracts() {
  const lifecycle = between(source, "async function openShutdownLifecycleFixture(",
    "\nasync function clearShutdownLifecycleDocuments(");
  const prefix = "Shutdown lifecycle admission, owner or original paint did not settle";
  const diagnosticStart = lifecycle.indexOf("        const assertionError = new Error(");
  const diagnosticEnd = lifecycle.indexOf("\n      }\n      return { tabId:", diagnosticStart);
  const condition = "      if (!processor.eventUndefined || !processor.settled || processor.error ||\n" +
    "          processor.packet.path !== filePath || state.renders.length !== 1 ||\n" +
    "          state.renders.some(record => !record.settled || record.error) ||\n" +
    "          !tab || tab.filePath !== filePath || tab.content !== text ||\n" +
    "          tab.originalContent !== text || window.originalMarkdown !== text ||\n" +
    "          window.currentFilePath !== filePath || descriptor?.logicalPath !== filePath ||\n" +
    "          owner?.tabId !== tab.id || owner?.pageSession !== pageSession ||\n" +
    "          deletion?.known !== true || deletion.unresolved !== false ||\n" +
    "          !document.getElementById('viewer').textContent.includes(paintMarker)) {";
  check(lifecycle.includes(condition),
  "Admission diagnostics retain the exact original compound criteria including exactly one render and original paint");
  const run = async (options = {}) => {
    const fixture = pageFixture(), { page, control, context } = fixture;
    const text = "# Alpha\n\nADMISSION_PACKET\n", filePath = control.tab.filePath;
    Object.assign(control.tab, { content: text, originalContent: text, hasUnsavedChanges: false });
    page.originalMarkdown = page.viewer.textContent = text;
    const processor = deferred(), render = deferred(), layout = deferred();
    const trace = [], scripts = [], errors = [], assertionErrors = [];
    const observation = { phase: "setup", processors: [], renders: [] };
    const cleanupFailure = new Error(options.cleanupErrorMessage ?? "ADMISSION_OBSERVATION_CLEANUP");
    const joinFailure = new Error(options.joinErrorMessage ?? "ADMISSION_ORIGINAL_" + options.reject);
    const diagnosticFailure = new Error("ADMISSION_DIAGNOSTIC_FAULT");
    let delivered = false, snapshotReads = 0, deletionReads = 0, settled = false, packetSerializations = 0;
    let diagnosticFaultReads = 0, viewerReads = 0, projectedPacket;
    const originalChooser = () => { throw new Error("Unowned admission chooser"); };
    const dialog = { showOpenDialog: originalChooser }, win = {};
    const record = { packet: { path: filePath }, eventUndefined: true, phase: "setup", settled: false };
    const painted = { phase: "setup", prefix: text.slice(0, 24), settled: false };
    painted.promise = render.promise.then(() => { painted.settled = true; });
    painted.promise.catch(() => {});
    record.promise = processor.promise.then(() => {
      record.settled = true;
      observation.renders.push(painted);
    });
    record.promise.catch(() => {});
    page.folia.openFileDialog = async () => {
      const choice = await dialog.showOpenDialog(win, { properties: ["multiSelections"] });
      assert.deepEqual(Array.from(choice.filePaths), [filePath]);
      observation.processors.push(record); delivered = true;
    };
    page.CustomTabs.settleSessionLayout = () => {
      trace.push("layout-start");
      return layout.promise.then(() => {
        trace.push("layout-joined");
        if (options.countMismatch) observation.renders.push({ ...painted });
        const fault = () => {
          diagnosticFaultReads++;
          assert.equal(assertionErrors.length, 1,
            "The actual assertion Error exists before any diagnostic fault");
          throw diagnosticFailure;
        };
        if (options.fault === "missing-viewer") delete page.viewer;
        if (options.fault === "render-getter") Object.defineProperty(painted, "error", { get: fault });
        if (options.fault === "owner-getter") Object.defineProperty(control.owner, "pageSession", { get: fault });
        if (options.fault === "deletion-getter") Object.defineProperty(control.query, "why", {
          enumerable: true, get: fault,
        });
        if (options.fault === "error-coercion") record.error = { toString: fault };
        if (options.fault === "raw-deletion") control.query.extra = Promise.resolve("RAW_PROMISE");
        options.mutate?.({ page, control, observation, record, painted });
      });
    };
    const activeTab = page.CustomTabs.getActiveTab;
    page.CustomTabs.getActiveTab = () => {
      snapshotReads++; trace.push("snapshot");
      return options.absentTab === "undefined" ? undefined : options.absentTab ? null : activeTab();
    };
    page.queryDocumentDeletionState = () => { deletionReads++; return control.query; };
    const getElement = page.document.getElementById;
    page.document.getElementById = id => {
      if (id !== "viewer") return getElement(id);
      viewerReads++; return page.viewer;
    };
    context.admissionObservation = observation;
    context.Error = class extends Error {
      constructor(message) {
        super(message);
        if (message === prefix) { assertionErrors.push(this); trace.push("assertion-created"); }
      }
    };
    context.JSON = { stringify: (value, ...args) => {
      if (value && Object.hasOwn(value, "failedPredicates")) {
        packetSerializations++; projectedPacket = value;
        if (options.serializationFault === "throw") { diagnosticFaultReads++; throw diagnosticFailure; }
        if (options.serializationFault === "undefined") { diagnosticFaultReads++; return undefined; }
      }
      return JSON.stringify(value, ...args);
    } };
    let actual = lifecycle;
    if (options.oldMessage && diagnosticStart >= 0 && diagnosticEnd > diagnosticStart) {
      actual = actual.slice(0, diagnosticStart) + "        throw new Error('" + prefix + "');" +
        actual.slice(diagnosticEnd);
    }
    if (options.unguarded) {
      actual = actual.replace("        try {\n          const scalar = value => {",
        "          const scalar = value => {");
      actual = actual.replace("\n        } catch {\n          assertionError.message = '" +
        prefix + ": admission diagnostic unavailable';\n        }\n        throw assertionError;",
        "\n        throw assertionError;");
    }
    const exec = async script => {
      scripts.push(script);
      try { return await vm.runInContext(script, context); }
      catch (error) { errors.push(error); throw error; }
    };
    const api = vm.runInNewContext(actual + "\nopenShutdownLifecycleFixture;", {
      require, AggregateError, dialog, win, exec,
      installDialogBatchPageObservation: installer => installer(
        "(() => { window.__dialogBatchNative = admissionObservation; return true; })()"),
      restoreDialogBatchPageObservation: async () => {
        trace.push("restore-observation");
        assert.equal(page.__dialogBatchNative, observation);
        delete page.__dialogBatchNative;
        if (options.cleanupFailure) throw cleanupFailure;
      },
      replaceMethod: (target, key, replacement) => {
        target[key] = replacement;
        return () => { trace.push("restore-chooser"); target[key] = originalChooser; };
      },
      waitForCondition: async (_exec, predicate, budget) => {
        assert.equal(budget, 8000); await turn();
        assert.equal(await exec(predicate), true); return true;
      },
      boundedDialogWork: (work, label, budget) => {
        assert.equal(label, "shutdown lifecycle original processor and paint");
        assert.equal(budget, 8000); trace.push("original-join"); return work;
      },
    });
    const outcome = api(exec, filePath, text, "ADMISSION_PACKET").then(
      value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    await turn();
    const processorHeld = delivered && !settled && snapshotReads === 0 && !trace.includes("layout-start");
    if (options.reject === "processor") processor.reject(joinFailure);
    else processor.resolve();
    await turn();
    const renderHeld = options.reject !== "processor" && !settled && snapshotReads === 0 &&
      record.settled && observation.renders.length === 1 && !painted.settled;
    if (options.reject === "render") render.reject(joinFailure);
    else render.resolve();
    await turn();
    const layoutHeld = !options.reject && !settled && snapshotReads === 0 &&
      trace.includes("layout-start") && !trace.includes("snapshot");
    if (options.reject === "layout") layout.reject(joinFailure);
    else layout.resolve();
    const result = await outcome, leaf = result.error?.errors?.[0];
    const packet = leaf?.message.startsWith(prefix + ": {") ?
      JSON.parse(leaf.message.slice(prefix.length + 2)) : null;
    return { ...result, leaf, packet, errors, trace, scripts, snapshotReads, deletionReads,
      processorHeld, renderHeld, layoutHeld, cleanupFailure, joinFailure, observation, record, painted,
      assertionErrors, diagnosticFailure, diagnosticFaultReads, viewerReads, projectedPacket, query: control.query,
      packetSerializations, restored: dialog.showOpenDialog === originalChooser &&
        !Object.hasOwn(page, "__dialogBatchNative") &&
        trace.filter(step => step === "restore-chooser").length === 1 &&
        trace.filter(step => step === "restore-observation").length === 1 };
  };
  const clean = await run();
  check(!clean.error && clean.processorHeld && clean.renderHeld && clean.layoutHeld &&
    clean.snapshotReads === 1 && clean.deletionReads === 1 && clean.restored &&
    clean.trace.indexOf("layout-joined") < clean.trace.indexOf("snapshot") &&
    clean.packetSerializations === 0 && clean.assertionErrors.length === 0 && clean.scripts.length === 5,
  "Actual successful admission joins original processor render and layout before one owner read and exact cleanup");
  const changes = [
    ["processor.eventUndefined", ({ record }) => { record.eventUndefined = false; }],
    ["processor.settled", ({ record }) => { record.settled = false; }],
    ["processor.error", ({ record }) => { record.error = "PROCESSOR_OBSERVATION_ERROR"; }],
    ["processor.packet.path", ({ record }) => { record.packet.path = "C:\\fixture\\wrong.md"; }],
    ["renders.count", ({ observation, painted }) => { observation.renders.push({ ...painted }); }],
    ["renders.settledOrError", ({ painted }) => { painted.settled = false; }],
    ["activeTab.filePath", ({ control }) => { control.tab.filePath = "C:\\fixture\\wrong.md"; }],
    ["activeTab.content", ({ control }) => { control.tab.content = "WRONG_CURRENT"; }],
    ["activeTab.originalContent", ({ control }) => { control.tab.originalContent = "WRONG_ORIGINAL"; }],
    ["originalMarkdown", ({ page }) => { page.originalMarkdown = "WRONG_MARKDOWN"; }],
    ["currentFilePath", ({ page }) => { page.currentFilePath = "C:\\fixture\\wrong.md"; }],
    ["descriptor.logicalPath", ({ control }) => { control.descriptor.logicalPath = "C:\\fixture\\wrong.md"; }],
    ["owner.tabId", ({ control }) => { control.owner.tabId++; }],
    ["owner.pageSession", ({ control }) => { control.owner.pageSession = "WRONG_PAGE"; }],
    ["deletion.known", ({ control }) => { control.query.known = false; }],
    ["deletion.unresolved", ({ control }) => { control.query.unresolved = true; }],
    ["paintMarker", ({ page }) => { page.viewer.textContent = "UNPAINTED"; }],
  ];
  for (const [name, mutate] of changes) {
    const failed = await run({ mutate });
    check(failed.leaf === failed.errors[0] && failed.leaf === failed.assertionErrors[0] &&
      failed.packet?.failedPredicates.join("|") === name &&
      failed.processorHeld && failed.renderHeld && failed.layoutHeld && failed.restored &&
      failed.snapshotReads === 1 && failed.deletionReads === 1 && failed.packetSerializations === 1 &&
      failed.scripts.length === clean.scripts.length,
    "Actual admission packet identifies only the unchanged failed predicate: " + name);
  }
  const compound = await run({ mutate: ({ record, painted, page, control }) => {
    record.error = "PROCESSOR_EVIDENCE"; painted.error = "RENDER_EVIDENCE";
    control.tab.content = "WRONG_CURRENT"; control.tab.originalContent = "WRONG_ORIGINAL";
    page.originalMarkdown = "WRONG_MARKDOWN"; control.owner.pageSession = "WRONG_PAGE";
    control.query = { known: false, unresolved: true, why: "ACTUAL_DELETION_RESULT" };
    page.viewer.textContent = "UNPAINTED";
  }, cleanupFailure: true });
  check(JSON.stringify(compound.packet) === JSON.stringify({
    failedPredicates: ["processor.error", "renders.settledOrError", "activeTab.content",
      "activeTab.originalContent", "originalMarkdown", "owner.pageSession",
      "deletion.known", "deletion.unresolved", "paintMarker"],
    processor: { path: "C:\\fixture\\alpha.md", eventUndefined: true, settled: true, error: "PROCESSOR_EVIDENCE" },
    renders: { count: 1, records: [{ phase: "setup", prefix: "# Alpha\n\nADMISSION_PACKE",
      settled: true, error: "RENDER_EVIDENCE" }] },
    document: { activeTabId: "21", activePath: "C:\\fixture\\alpha.md",
      currentPath: "C:\\fixture\\alpha.md", descriptorPath: "C:\\fixture\\alpha.md",
      contentEqualsExpected: false, originalContentEqualsExpected: false, originalMarkdownEqualsExpected: false },
    owner: { tabId: "21", pageSession: "WRONG_PAGE", activeTabId: "21", currentPageSession: "page" },
    deletion: { known: false, unresolved: true, why: "ACTUAL_DELETION_RESULT" }, paintMarkerPresent: false,
  }),
  "Actual admission packet retains complete serializable observer document owner deletion and paint evidence");
  check(compound.error.errors.length === 2 && compound.error.errors[0] === compound.errors[0] &&
    compound.error.errors[1] === compound.cleanupFailure && compound.restored &&
    compound.packet.processor.error === compound.record.error &&
    compound.packet.renders.records[0].error === compound.painted.error &&
    compound.projectedPacket.deletion !== compound.query,
  "Admission packet survives observation deletion and retains the original Error ahead of independent cleanup failure");
  const absent = await run({ absentTab: true });
  check(absent.packet?.failedPredicates.join("|") ===
    "activeTab|activeTab.filePath|activeTab.content|activeTab.originalContent|descriptor.logicalPath|" +
    "owner.pageSession|deletion.known|deletion.unresolved" &&
    absent.packet.document.activeTabId === "undefined" && absent.packet.owner.tabId === "undefined" &&
    absent.packet.deletion === null && absent.packet.paintMarkerPresent === true &&
    absent.deletionReads === 0 && absent.restored,
  "Missing active owner remains a failed original admission with explicit absent identities rather than a diagnostic TypeError");
  const undefinedTab = await run({ absentTab: "undefined" });
  check(undefinedTab.packet?.deletion === "undefined" && undefinedTab.packet.document.activeTabId === "undefined" &&
    undefinedTab.packet.owner.tabId === "undefined" && undefinedTab.deletionReads === 0 && undefinedTab.restored,
  "Undefined original owner and deletion evidence serialize explicitly without invented successful deletion defaults");
  const noPaint = await run({ mutate: changes.at(-1)[1] });
  check(noPaint.packet.processor.error === "undefined" &&
    noPaint.packet.renders.records[0].error === "undefined" &&
    noPaint.packet.processor.settled === true && noPaint.packet.renders.records[0].settled === true &&
    noPaint.packet.renders.count === 1 && noPaint.packet.paintMarkerPresent === false,
  "Absent observer errors stay explicitly undefined evidence while a settled single render can still fail original paint");
  for (const reject of ["processor", "render", "layout"]) {
    const rejected = await run({ reject });
    check(rejected.error.errors[0] === rejected.joinFailure && rejected.packet === null &&
      rejected.snapshotReads === 0 && rejected.deletionReads === 0 && rejected.restored &&
      rejected.assertionErrors.length === 0 && rejected.packetSerializations === 0 &&
      rejected.viewerReads === 0,
    "Original admission " + reject + " rejection remains the same failure without a post-join diagnostic");
  }
  const old = await run({ oldMessage: true, mutate: changes.at(-1)[1] });
  check(old.leaf?.message === prefix && old.packet === null &&
    old.processorHeld && old.renderHeld && old.layoutHeld && old.restored,
  "Executed original admission error counterfactual joins and cleans up but loses the exact failed predicate");
  const shortCount = await run({ countMismatch: true });
  check(shortCount.packet?.failedPredicates.join("|") === "renders.count" &&
    shortCount.packet.renders.count === 2 && shortCount.packet.renders.records.length === 2 &&
    shortCount.viewerReads === 1 && shortCount.leaf === shortCount.assertionErrors[0] &&
    shortCount.processorHeld && shortCount.renderHeld && shortCount.layoutHeld && shortCount.restored,
  "Actual false single-render count short-circuits the original viewer criterion before the guarded diagnostic reads it");
  const unavailable = prefix + ": admission diagnostic unavailable";
  for (const fault of ["missing-viewer", "render-getter", "owner-getter",
    "deletion-getter", "error-coercion", "raw-deletion"]) {
    const refused = await run({ countMismatch: true, fault });
    check(refused.leaf === refused.assertionErrors[0] && refused.leaf === refused.errors[0] &&
      refused.leaf.message === unavailable && refused.leaf.stack.includes(unavailable) &&
      refused.error.errors.length === 1 && refused.packet === null &&
      refused.packetSerializations === 0 && refused.observation.renders.length === 2 &&
      (["missing-viewer", "raw-deletion"].includes(fault) || refused.diagnosticFaultReads === 1) &&
      (fault !== "missing-viewer" || refused.viewerReads === 1) && refused.restored &&
      refused.trace.slice(-2).join("|") === "restore-chooser|restore-observation",
    "Guarded admission diagnostic preserves the established assertion and cleanup on " + fault);
  }
  for (const serializationFault of ["throw", "undefined"]) {
    const refused = await run({ countMismatch: true, serializationFault });
    check(refused.leaf === refused.assertionErrors[0] && refused.leaf.message === unavailable &&
      refused.leaf.stack.includes(unavailable) &&
      refused.packet === null && refused.packetSerializations === 1 &&
      refused.diagnosticFaultReads === 1 && refused.leaf !== refused.diagnosticFailure && refused.restored,
    "Actual admission JSON " + serializationFault + " fault cannot replace the established original assertion");
  }
  for (const options of [{ fault: "missing-viewer" }, { fault: "render-getter" },
    { serializationFault: "throw" }]) {
    const unsafe = await run({ ...options, countMismatch: true, unguarded: true });
    check(unsafe.assertionErrors.length === 1 && unsafe.leaf !== unsafe.assertionErrors[0] &&
      !unsafe.leaf.message.startsWith(prefix) && unsafe.packet === null && unsafe.restored &&
      (options.fault !== "missing-viewer" || unsafe.viewerReads === 1),
    "Executed unguarded diagnostic counterfactual loses the original assertion on " +
      (options.fault || "JSON serialization"));
  }
  const longProcessor = "P".repeat(4096) + "PROCESSOR_TAIL", longRender = "R".repeat(8192) + "RENDER_TAIL";
  const longPhase = "PHASE".repeat(600), longPrefix = "PREFIX".repeat(600);
  const bounded = await run({ mutate: ({ record, painted }) => {
    record.error = longProcessor; painted.error = longRender;
    painted.phase = longPhase; painted.prefix = longPrefix;
  } });
  check(bounded.packet.processor.error === "P".repeat(2048) +
      "... [truncated; original length " + longProcessor.length + "]" &&
    bounded.packet.renders.records[0].error === "R".repeat(2048) +
      "... [truncated; original length " + longRender.length + "]" &&
    bounded.packet.processor.error.length < 2100 && bounded.packet.renders.records[0].error.length < 2100 &&
    bounded.record.error === longProcessor && bounded.painted.error === longRender &&
    bounded.packet.renders.records[0].phase === longPhase &&
    bounded.packet.renders.records[0].prefix === longPrefix && bounded.restored,
  "Only projected processor and render error text is bounded with explicit truncation while original records and other evidence stay exact");
  const boundary = "B".repeat(2048);
  const exactBound = await run({ mutate: ({ record, painted }) => {
    record.error = boundary; painted.error = boundary;
  } });
  check(exactBound.packet.processor.error === boundary && exactBound.packet.renders.records[0].error === boundary &&
    !exactBound.packet.processor.error.includes("truncated"),
  "Projected errors exactly at the diagnostic text bound remain unchanged without a false truncation marker");
  const longOriginal = "ORIGINAL_EXCEPTION_" + "X".repeat(10000) + "_ORIGINAL_TAIL";
  const longCleanup = "INDEPENDENT_CLEANUP_" + "C".repeat(10000) + "_CLEANUP_TAIL";
  const rejectedLong = await run({ reject: "processor", joinErrorMessage: longOriginal,
    cleanupFailure: true, cleanupErrorMessage: longCleanup });
  check(rejectedLong.error.errors[0] === rejectedLong.joinFailure &&
    rejectedLong.joinFailure.message === longOriginal &&
    rejectedLong.error.errors[1] === rejectedLong.cleanupFailure &&
    rejectedLong.cleanupFailure.message === longCleanup && rejectedLong.packet === null &&
    rejectedLong.assertionErrors.length === 0 && rejectedLong.packetSerializations === 0 &&
    rejectedLong.viewerReads === 0 && rejectedLong.restored,
  "Original producer exceptions and independent cleanup errors are never truncated or routed through diagnostics");
  const guardCleanup = await run({ countMismatch: true, fault: "render-getter", cleanupFailure: true });
  check(guardCleanup.error.errors[0] === guardCleanup.assertionErrors[0] &&
    guardCleanup.leaf.message === unavailable && guardCleanup.error.errors[1] === guardCleanup.cleanupFailure &&
    guardCleanup.restored && guardCleanup.trace.slice(-2).join("|") === "restore-chooser|restore-observation",
  "A diagnostic getter failure keeps the original assertion first and independently restores chooser then observation despite cleanup failure");
  const validWithBrokenSerializer = await run({ serializationFault: "throw" });
  check(!validWithBrokenSerializer.error && validWithBrokenSerializer.assertionErrors.length === 0 &&
    validWithBrokenSerializer.packetSerializations === 0 && validWithBrokenSerializer.diagnosticFaultReads === 0 &&
    validWithBrokenSerializer.viewerReads === 1 && validWithBrokenSerializer.restored,
  "Valid original admission never constructs an assertion or executes diagnostics even when the diagnostic serializer is broken");
}

async function installedQuestionSnapshotContracts() {
  const definition = between(source, "  const readInstalledDocument = () => exec(`",
    "\n  const installedMainOwns = ");
  const program = vm.runInNewContext(definition + "\nreadInstalledDocument();", { exec: code => code });
  const edit = between(source, "  const editInstalledFixture = async (content, reason) => {",
    "\n    await exec(`(() => {\n      const before = ");
  const admissionGuard = edit.slice(edit.indexOf("    if (before.path !== commitFile"));
  const guard = vm.compileFunction("return (async () => {\n" + admissionGuard + "\nreturn true;\n})();",
    ["before", "commitFile", "installedMainOwns"]);
  const fixture = (options = {}) => {
    const { page, control, context } = pageFixture(), listeners = new Set(), trace = [], deliveries = [];
    const fieldError = new Error("INSTALLED_SNAPSHOT_FIELD_FAILURE");
    const cleanupError = new Error("INSTALLED_SNAPSHOT_CLEANUP_FAILURE");
    let subscriptions = 0, unsubscriptions = 0, returnedHandles = 0, fieldReads = 0, callbackError, callback;
    const readTab = page.CustomTabs.getActiveTab;
    page.CustomTabs.getActiveTab = () => {
      fieldReads++; trace.push("read-tab");
      if (options.fieldFailure === "tab") throw fieldError;
      return readTab();
    };
    if (options.fieldFailure === "viewer") Object.defineProperty(page.viewer, "textContent", {
      get() { throw fieldError; },
    });
    const getElement = page.document.getElementById;
    page.document.getElementById = id => id === "appMessageDialog" ?
      options.local === undefined ? null : { open: options.local } : getElement(id);
    page.folia.onMainDialogVisibility = function(listener) {
      assert.equal(this, page.folia);
      subscriptions++; listeners.add(listener); callback = listener; trace.push("subscribe");
      if (!["missing", "late"].includes(options.signal)) {
        for (const value of options.deliveries ?? [options.main ?? false]) {
          deliveries.push(value);
          try { listener(value); trace.push("callback-returned"); }
          catch (error) { callbackError = error; throw error; }
        }
      }
      returnedHandles++; trace.push("return-handle");
      if (Object.hasOwn(options, "handle")) return options.handle;
      return () => {
        unsubscriptions++; trace.push("unsubscribe"); listeners.delete(listener);
        if (options.cleanupFailure) throw cleanupError;
      };
    };
    if (Object.hasOwn(options, "capability")) page.folia.onMainDialogVisibility = options.capability;
    let actual = program;
    if (options.unsafeLocal) actual = actual.replace(
      "document.getElementById('appMessageDialog')?.open === true || mainVisible",
      "document.getElementById('appMessageDialog').open === true || mainVisible");
    if (options.localOnly) actual = actual.replace(
      "document.getElementById('appMessageDialog')?.open === true || mainVisible",
      "document.getElementById('appMessageDialog')?.open === true");
    let snapshot, error;
    try { snapshot = vm.runInContext(actual, context); } catch (failure) { error = failure; }
    return { snapshot, error, trace, deliveries, fieldError, cleanupError, control,
      counts: () => ({ subscriptions, unsubscriptions, returnedHandles, fieldReads,
        listeners: listeners.size, callbackError }),
      deliverLate: value => { deliveries.push(value); callback(value); },
      repeat: () => vm.runInContext(actual, context) };
  };
  const idle = fixture({ main: false });
  check(JSON.stringify(idle.snapshot) === JSON.stringify({
    path: "C:\\fixture\\alpha.md", original: "# Alpha\n\nSAVED\n", editor: "# Alpha\n\nTYPED\n",
    editMode: true, dirty: true,
    tab: { id: 21, path: "C:\\fixture\\alpha.md", content: "# Alpha\n\nTYPED\n",
      original: "# Alpha\n\nSAVED\n", dirty: true, diskVersion: {} },
    state: { maintained: true, dirty: true, reloadConflict: false,
      deletionTombstone: false, mutationRevision: 10 },
    owner: { pageSession: "page", rendererGeneration: 3, tabId: 21, documentGeneration: 7,
      pathKey: "c:\\fixture\\alpha.md", documentRef: "ref" },
    descriptor: { ref: "ref", pathKey: "c:\\fixture\\alpha.md",
      logicalPath: "C:\\fixture\\alpha.md", readTarget: "C:\\fixture\\alpha.md" },
    pending: { count: 0, revision: 12 }, selection: 9, frozen: false, question: false, viewer: "TYPED",
  }) && !idle.error && idle.deliveries[0] === false &&
    idle.counts().subscriptions === 1 && idle.counts().unsubscriptions === 1 && idle.counts().listeners === 0,
  "Actual installed snapshot accepts lazy absent local surface only with genuine immediate Main false and preserves every other field");
  for (const options of [{ main: true }, { main: false, local: true }, { main: true, local: false }]) {
    const busy = fixture(options);
    let ownershipCalls = 0;
    await assert.rejects(guard(busy.snapshot, busy.snapshot.path, async () => {
      ownershipCalls++; throw new Error("Busy snapshots must not reach ownership qualification");
    }), /Installed edit has no current owned editor/);
    check(busy.snapshot.question === true && ownershipCalls === 0 &&
      busy.counts().subscriptions === 1 && busy.counts().unsubscriptions === 1 &&
      busy.counts().listeners === 0,
    "Actual installed busy-only question refuses edit before ownership: " + JSON.stringify(options));
  }
  for (const value of [undefined, null, 0, 1, "false", {}, Promise.resolve(false)]) {
    const malformed = fixture({ deliveries: [value], local: true });
    check(!malformed.snapshot && /did not synchronously report a Boolean/.test(malformed.error?.message) &&
      malformed.counts().returnedHandles === 1 && malformed.counts().unsubscriptions === 1 &&
      malformed.counts().listeners === 0 && malformed.counts().fieldReads === 0 &&
      malformed.counts().callbackError === undefined &&
      malformed.trace.join("|") === "subscribe|callback-returned|return-handle|unsubscribe",
    "Malformed immediate Main visibility is rejected after obtaining and disposing the handle even when local is open: " + String(value));
  }
  for (const capability of [undefined, null, 0, {}]) {
    const missing = fixture({ capability, local: true });
    check(!missing.snapshot && /capability is missing/.test(missing.error?.message) &&
      missing.counts().subscriptions === 0 && missing.counts().fieldReads === 0,
    "Missing or noncallable Main visibility capability never becomes local-only success: " + String(capability));
  }
  for (const signal of ["missing", "late"]) {
    const missing = fixture({ signal, local: true });
    check(!missing.snapshot && /did not synchronously report a Boolean/.test(missing.error?.message) &&
      missing.counts().returnedHandles === 1 && missing.counts().unsubscriptions === 1 &&
      missing.counts().listeners === 0 && missing.counts().fieldReads === 0,
    "Main visibility " + signal + " first delivery fails closed and disposes the real callable handle");
    if (signal === "late") {
      const originalError = missing.error;
      missing.deliverLate(false);
      check(missing.deliveries[0] === false && missing.error === originalError && !missing.snapshot &&
        missing.counts().listeners === 0 && missing.counts().unsubscriptions === 1,
      "A genuine late Boolean cannot resurrect an already-refused installed snapshot");
    }
  }
  for (const handle of [undefined, null, 0, {}]) {
    const malformed = fixture({ handle, main: false });
    check(!malformed.snapshot && /did not return cleanup/.test(malformed.error?.message) &&
      malformed.counts().returnedHandles === 1 && malformed.counts().fieldReads === 0 &&
      malformed.counts().callbackError === undefined,
    "Noncallable Main visibility cleanup handle rejects an otherwise idle snapshot: " + String(handle));
  }
  for (const fieldFailure of ["tab", "viewer"]) {
    const failed = fixture({ main: false, fieldFailure });
    check(failed.error === failed.fieldError && !failed.snapshot &&
      failed.counts().subscriptions === 1 && failed.counts().unsubscriptions === 1 &&
      failed.counts().listeners === 0 && failed.trace.at(-1) === "unsubscribe",
    "Actual installed snapshot " + fieldFailure + " read failure still unsubscribes exactly once and preserves the field error");
  }
  const cleanup = fixture({ main: false, cleanupFailure: true });
  check(cleanup.error === cleanup.cleanupError && !cleanup.snapshot &&
    cleanup.counts().unsubscriptions === 1 && cleanup.counts().listeners === 0,
  "A failing callable visibility disposer remains a failed installed snapshot rather than a returned ready result");
  const malformedFirst = fixture({ deliveries: [undefined, false], local: true });
  check(!malformedFirst.snapshot && /did not synchronously report a Boolean/.test(malformedFirst.error?.message) &&
    malformedFirst.deliveries.length === 2 && malformedFirst.counts().unsubscriptions === 1 &&
    malformedFirst.counts().listeners === 0,
  "A later Boolean cannot repair malformed initial cached Main visibility evidence");
  for (let index = 0; index < 12; index++) idle.repeat();
  check(idle.counts().subscriptions === 13 && idle.counts().unsubscriptions === 13 &&
    idle.counts().listeners === 0 && idle.counts().returnedHandles === 13,
  "Repeated actual installed snapshots leave no Main visibility callbacks and dispose every returned handle once");
  const changingOptions = { main: false }, changing = fixture(changingOptions);
  changingOptions.main = true;
  const busyAgain = changing.repeat();
  changingOptions.main = false;
  const idleAgain = changing.repeat();
  check(changing.snapshot.question === false && busyAgain.question === true && idleAgain.question === false &&
    changing.counts().subscriptions === 3 && changing.counts().unsubscriptions === 3 &&
    changing.counts().listeners === 0,
  "Each actual installed snapshot samples its own current immediate Main visibility instead of reusing an earlier idle value");
  let ownershipCalls = 0;
  await assert.rejects(guard(idle.snapshot, idle.snapshot.path, async () => {
    ownershipCalls++; return false;
  }), /Installed edit has no current owned editor/);
  check(ownershipCalls === 1 && idle.snapshot.question === false,
  "Idle visibility does not bypass the unchanged installed current-owner admission gate");
  const unsafe = fixture({ main: false, unsafeLocal: true });
  check(!unsafe.snapshot && /Cannot read properties of null.*open/.test(unsafe.error?.message) &&
    unsafe.deliveries[0] === false && unsafe.counts().unsubscriptions === 1 && unsafe.counts().listeners === 0,
  "Executed actual snapshot null-dereference counterfactual fails on the genuinely absent lazy local dialog");
  const localOnly = fixture({ main: true, localOnly: true });
  check(!localOnly.error && localOnly.snapshot.question === false && localOnly.deliveries[0] === true &&
    localOnly.counts().unsubscriptions === 1,
  "Executed optional-chain-only counterfactual incorrectly loses genuine Main queue busy evidence without proving presentation");
}

async function generationFinalizerContracts() {
  const scenario = between(source, "async function runShutdownGenerationScenarios(",
    "\nfunction createInstalledUpdaterFixture(");
  const finalizer = scenario.slice(scenario.lastIndexOf("\n  } catch (error) {") + 1,
    scenario.lastIndexOf("\n}"));
  assert.ok(finalizer.startsWith("  } catch (error) {"), "The actual generation body catch and finalizer are extracted");
  const main = fs.readFileSync(path.join(producerRoot, "main.js"), "utf8").replace(/\r\n/g, "\n");
  const capture = between(main, "function captureFileOpenDelivery(", "\nfunction fileOpenSnapshotIsCurrent(");
  const chooser = between(main, "function openFileDialog() {",
    "\n// ============================================\n// IPC HANDLERS - File Operations");
  const release = between(main, "function releaseShutdownFreeze(options = {}) {",
    "\nipcMain.on(QUIT_APPROVAL_COMMITTED,");
  const revoke = between(main, "function revokeShutdownAuthorization() {", "\nfunction grantShutdownAuthorization(");
  const reset = between(main, "          reset: () => {", "\n          },\n        },");
  const resetEffects = between(reset, "            releaseShutdownFreeze({ force: true });",
    "\n            lastUpdaterInstallAttemptState") + "\n" +
    between(reset, "            ownerDocumentBaselines.clear();", "\n            quarantinedDocumentOwners.clear();");
  assert.ok(!reset.includes("knownDocumentOwners.clear()"), "Actual reset keeps the authenticated owner registry");
  const commitFence = between(main, "    shutdownCommitIngressBlocked = true;",
    "\n  } catch (error) {\n    // The renderer cannot be reached to commit.");
  const nullCommit = between(main,
    "function finishShutdownCommit(attempt, committed, why, options = {}) {",
    "\n  attempt.settled = true;") + "\n  throw new Error('Only the null settled-commit path is modeled');\n}";
  const rigSource = between(source, "function shutdownRig(win) {", "\nfunction portableInstallEvent(");
  const replaceSource = between(source, "function replaceMethod(", "\n// A stand-in for the cancellable event");
  const run = async (options = {}) => {
    const trace = [], assertions = [], deliveries = [], chooserTails = [], chooserErrors = [];
    const trackingEvents = {}, trackingDescriptor = { value() {} };
    const owners = new Map(), baselines = new Map(), persisted = new Map();
    const bodyFailure = new Error("GENERATION_BODY_FAILURE");
    const trackingFailure = new Error("GENERATION_TRACKING_RESTORE_FAILURE");
    const rigFailure = new Error("GENERATION_RIG_RESTORE_FAILURE");
    const finalizerFailure = new Error("GENERATION_CHOOSER_FAILURE");
    let active = null, pageSession = "generation-page-3", resetCalls = 0, admissions = 0;
    const frame = { isDestroyed: () => false, parent: null, frameTreeNodeId: 7 };
    const wc = { mainFrame: frame, isDestroyed: () => false,
      send: channel => trace.push(channel === "COMMIT" ? "commit" : "thaw") };
    const indexFile = "C:\\fixture\\src\\index.html";
    const owner = { webContents: wc, isDestroyed: () => false,
      close() { throw new Error("Unstubbed window close must not be used by Source controls"); } };
    const installOwner = (filePath, content, descriptor) => {
      const identity = { pageSession, rendererGeneration: mainContext.approvalRendererGeneration,
        tabId: 1, documentGeneration: admissions, documentRef: descriptor.ref, pathKey: filePath };
      active = { id: 1, filePath, content, originalContent: content, identity, descriptor };
      owners.set(identity.documentRef, identity);
      baselines.set(identity.documentRef, { filePath, content });
      persisted.set(filePath, { filePath, content });
    };
    const mainContext = vm.createContext({
      mainWindow: owner, BrowserWindow: { fromWebContents: target => target === wc ? owner : null },
      approvalRendererGeneration: 3, approvalRendererPageSession: pageSession,
      approvalRendererState: "ready", fileOpenDeliveryEpoch: 0, shutdownCommitIngressBlocked: false,
      shutdownAuthorized: true, shutdownAuthorizationOwnerId: 1,
      shutdownAuthorizationGeneration: 3, shutdownAuthorizationCapacityLatched: false,
      ownerDocumentBaselines: baselines, activeDialogExtraBatch: null, documentAdmissions: new Map(),
      shutdownOwnerWindow: () => owner, ownerRendererAvailable: target => target === wc,
      foliaUpdaterAttemptRetainsFreeze: () => false, QUIT_APPROVAL_THAW: "THAW",
      QUIT_APPROVAL_COMMIT: "COMMIT", wc, record: { id: 76, revision: 1 },
      attempt: { generation: 3 }, cancelDocumentReplacementConsents() {},
      SUPPORTED_EXTENSIONS: { markdown: [".md"], mermaid: [".mmd"] },
      dialog: { showOpenDialog: () => {
        trace.push("chooser");
        const promise = Promise.resolve({ canceled: false, filePaths: [mainContext.chosenPath] });
        const then = promise.then.bind(promise);
        promise.then = (...args) => { const tail = then(...args); chooserTails.push(tail); return tail; };
        return promise;
      } },
      markdownSnapshotPromise: async filePath => ({ content: mainContext.chosenText,
        modifiedTime: 1, diskVersion: { mtimeMs: 1, size: 2 }, physical: { readTarget: filePath } }),
      confirmLargeDocument: () => true, rememberDocumentModifiedTime() {},
      issueDocumentAdmission: (_target, filePath) => {
        assert.equal(mainContext.shutdownCommitIngressBlocked, false);
        return { ref: "admission-" + ++admissions, logicalPath: filePath };
      },
      safeSendFileOpen: (target, channel, packet, generation) => {
        assert.equal(target, wc); assert.equal(channel, "file-opened");
        assert.equal(generation, mainContext.approvalRendererGeneration);
        deliveries.push(packet); trace.push("admission");
        installOwner(packet.path, packet.content, packet.document); return true;
      },
      console: { error: (...args) => chooserErrors.push(args) },
    });
    vm.runInContext("let updateMainDialogDepth = 0, updateSchedule = null;\n" +
      between(main, "function trackUpdateDialog(promise) {", "\nfunction mainDialogs() {") + "\n" +
      capture + "\n" + chooser + "\n" + release + "\n" + revoke + "\n" + nullCommit, mainContext);
    const rigContext = vm.createContext({ win: owner, dialog: mainContext.dialog, app: { quit() {} } });
    vm.runInContext(replaceSource + "\n" + rigSource + "\nglobalThis.actualRig = shutdownRig(win);", rigContext);
    vm.runInContext(commitFence, mainContext);
    owner.close();
    vm.runInContext("revokeShutdownAuthorization(); finishShutdownCommit(null, false, 'navigated');", mainContext);
    const initial = { live: !owner.isDestroyed(), closes: rigContext.actualRig.closes,
      blocked: mainContext.shutdownCommitIngressBlocked,
      authorized: mainContext.shutdownAuthorized };
    const open = async (_exec, filePath, content) => {
      trace.push("admission-attempt");
      if (options.admissionFailure) throw finalizerFailure;
      mainContext.chosenPath = filePath; mainContext.chosenText = content;
      const before = deliveries.length, tailStart = chooserTails.length;
      mainContext.openFileDialog();
      await Promise.all(chooserTails.slice(tailStart));
      if (deliveries.length !== before + 1) throw new Error("NATIVE_FILE_NOT_DELIVERED");
      return { filePath, tabId: active.id, owner: active.identity, descriptor: active.descriptor };
    };
    const page = { window: {
      getReloadRequestSession: () => pageSession,
      CustomTabs: { getActiveTab: () => active, getTabs: () => active ? [active] : [],
        getDocumentIdentityForTab: () => active.identity },
      queryDocumentDeletionState: (_filePath, identity) => ({
        known: owners.get(identity.documentRef) === identity && baselines.has(identity.documentRef),
        unresolved: false,
      }),
    } };
    const renderer = vm.createContext(page);
    const exec = async script => vm.runInContext(script, renderer);
    const host = { ...owner, loadFile: async target => {
      assert.equal(target, indexFile); trace.push("reload");
      mainContext.approvalRendererGeneration++;
      pageSession = "generation-page-" + mainContext.approvalRendererGeneration;
      mainContext.approvalRendererPageSession = pageSession;
      owners.clear();
      if (!options.noReadmission) {
        const descriptor = { ...active.descriptor, ref: "restored-" + ++admissions };
        installOwner(active.filePath, active.content, descriptor);
      }
    } };
    let bodyObserved = null, error = null;
    let actualFinalizer = finalizer;
    if (options.noPreparation) actualFinalizer = actualFinalizer.replace(
      '      __shutdown.reset();\n      const resetAdmission =', '      const resetAdmission =');
    if (options.noMeasuredReset) actualFinalizer = actualFinalizer.replace(
      '      __shutdown.reset();\n      const resetBoundaryAfter =', '      const resetBoundaryAfter =');
    if (options.oldMasking) actualFinalizer = actualFinalizer.replace(
      "    bodyFailed = true;\n    bodyError = error;", "    throw error;");
    const context = vm.createContext({
      AggregateError, bodyFailed: false, bodyError: null, win: host, exec, indexFile, path, dir: "C:\\fixture", write() {},
      Object: { defineProperty: (target, key, descriptor) => {
        assert.equal(target, trackingEvents); assert.equal(key, "select-file-tracking");
        assert.equal(descriptor, trackingDescriptor);
        trace.push("restore-tracking"); if (options.trackingFailure) throw trackingFailure;
      } }, ipcMain: { _events: trackingEvents }, trackingDescriptor,
      rig: { restore: () => {
        trace.push("restore-rig"); rigContext.actualRig.restore();
        if (options.rigFailure) throw rigFailure;
      } },
      __shutdown: {
        reset: () => { trace.push("reset-" + ++resetCalls); vm.runInContext(resetEffects, mainContext); },
        state: () => ({ renderer: "ready", rendererGeneration: mainContext.approvalRendererGeneration,
          knownDocumentOwnerCount: owners.size }),
        documentSessionState: () => ({ entries: Array.from(persisted.values()) }),
      },
      openShutdownLifecycleFixture: open,
      waitUntil: async predicate => predicate(),
      check: (name, success, detail) => assertions.push({ name, success, detail }),
      work: async () => {
        try {
          if (options.bodyChooser) await open(exec, "C:\\fixture\\navigation-edit.md", "BODY");
          else if (options.bodyFailure) throw bodyFailure;
          else if (Object.hasOwn(options, "bodyValue")) throw options.bodyValue;
        } catch (failure) { bodyObserved = failure; throw failure; }
      },
    });
    try { await vm.runInContext("(async () => {\ntry { await work();\n" + actualFinalizer + "\n})()", context); }
    catch (failure) { error = failure; }
    return { trace, assertions, error, bodyObserved, bodyFailure, trackingFailure, rigFailure,
      finalizerFailure, initial, resetCalls, deliveries, chooserErrors, owners, baselines, persisted };
  };
  const good = await run();
  check(good.initial.live && good.initial.closes === 1 && good.initial.blocked &&
    !good.initial.authorized && !good.error && good.chooserErrors.length === 0,
  "Actual commit fence survives a stubbed close and authorization revocation in a live window until finalizer reset");
  check(good.resetCalls === 2 && good.trace.indexOf("reset-1") < good.trace.indexOf("chooser") &&
    good.trace.indexOf("admission") < good.trace.indexOf("reset-2") &&
    good.trace.indexOf("reset-2") < good.trace.indexOf("reload") &&
    good.assertions.length === 3 && good.assertions.every(assertion => assertion.success),
  "Actual finalizer prep reset precedes the genuine chooser source; measured reset still erases only baseline before reload re-admission");
  const noPreparation = await run({ noPreparation: true, bodyFailure: true });
  check(noPreparation.error?.errors?.[0] === noPreparation.bodyFailure &&
    noPreparation.error.errors[1]?.message === "NATIVE_FILE_NOT_DELIVERED" &&
    noPreparation.error.errors[1] !== noPreparation.bodyFailure &&
    noPreparation.resetCalls === 0 && noPreparation.deliveries.length === 0 &&
    noPreparation.trace.includes("chooser") && !noPreparation.trace.includes("admission"),
  "Omitted preparatory reset genuinely lets the unchanged Main chooser refuse the live committed fence while retaining body and finalizer errors");
  const bodyChooser = await run({ bodyChooser: true });
  check(bodyChooser.error?.errors?.length === 1 && bodyChooser.error.errors[0] === bodyChooser.bodyObserved &&
    bodyChooser.bodyObserved.message === "NATIVE_FILE_NOT_DELIVERED" &&
    bodyChooser.assertions.every(assertion => assertion.success) &&
    bodyChooser.deliveries.length === 1 && bodyChooser.trace.indexOf("chooser") < bodyChooser.trace.indexOf("reset-1"),
  "Earlier authorization-revocation body admission remains unrepaired and visible even when finalizer recovery succeeds");
  const failures = await run({ bodyFailure: true, trackingFailure: true, rigFailure: true, admissionFailure: true });
  check(failures.error instanceof AggregateError && failures.error.errors.length === 4 &&
    failures.error.errors[0] === failures.bodyFailure && failures.error.errors[1] === failures.trackingFailure &&
    failures.error.errors[2] === failures.rigFailure && failures.error.errors[3] === failures.finalizerFailure &&
    failures.trace.indexOf("restore-tracking") < failures.trace.indexOf("restore-rig") &&
    failures.trace.indexOf("restore-rig") < failures.trace.indexOf("reset-1") &&
    failures.trace.indexOf("reset-1") < failures.trace.indexOf("admission-attempt"),
  "Actual generation finalization preserves body and independent tracking rig and chooser failure identity/order while attempting each");
  const cleanBody = await run({ admissionFailure: true });
  check(cleanBody.error?.errors?.length === 1 && cleanBody.error.errors[0] === cleanBody.finalizerFailure,
  "A finalizer-only failure stays a genuine failure without inventing a body error");
  const noMeasured = await run({ noMeasuredReset: true });
  check(noMeasured.assertions.find(assertion => assertion.name.includes("drops the restored tab baseline"))?.success === false,
  "Preparatory reset cannot substitute for or move the measured reset after authenticated baseline capture");
  const noReadmission = await run({ noReadmission: true });
  check(noReadmission.error?.errors?.[0]?.message.includes("Reset recovery did not restore") &&
    noReadmission.assertions.at(-1)?.success === false,
  "Unchanged finalizer predicates refuse a newer generation without authenticated owner and baseline re-registration");
  const legacy = await run({ oldMasking: true, bodyFailure: true,
    trackingFailure: true, rigFailure: true, admissionFailure: true });
  check(legacy.error?.errors?.length === 3 && !legacy.error.errors.includes(legacy.bodyFailure) &&
    legacy.error.errors[0] === legacy.trackingFailure &&
    legacy.error.errors[1] === legacy.rigFailure &&
    legacy.error.errors[2] === legacy.finalizerFailure &&
    failures.error.errors.includes(failures.bodyFailure),
  "Old finally-masking counterfactual loses the body Error unlike the executed actual generation finalizer");
  for (const bodyValue of [0, false, null, undefined]) {
    const primitive = await run({ bodyValue });
    check(primitive.error instanceof AggregateError && primitive.error.errors.length === 1 &&
      primitive.error.errors[0] === bodyValue &&
      primitive.assertions.length === 3 && primitive.assertions.every(assertion => assertion.success),
    "Generation finalization retains a thrown falsy " + typeof bodyValue + " body value rather than treating it as success");
  }
}

async function generationNavigationSetupContracts() {
  const generationQuestions = between(source, "function installGenerationShutdownQuestions(",
    "\nasync function runShutdownGenerationScenarios(");
  const scenario = between(source, "    // This nonterminal close stub can test authority revocation, not a live",
    "    // An unanswered host's real abort");
  const discardBoundary = between(source, "    if (retainDiscardChoice) {\n      const discardBoundaryBefore",
    "\n    if (!await waitUntil(() => __shutdown.state().pendingId === 0)) {");
  const open = between(source, "async function openShutdownLifecycleFixture(",
    "\nasync function clearShutdownLifecycleDocuments(");
  const restore = between(source, "async function settleShutdownLifecycleRestore(",
    "\nfunction installGenerationShutdownQuestions(");
  const replace = between(source, "function replaceMethod(", "\n// A stand-in for the cancellable event");
  const bounded = between(source, "async function boundedDialogWork(", "\nfunction inspectCleanRefreshSource(");
  const ownedCleanup = between(source, "async function withOrdinaryShutdownCleanup(",
    "\nfunction holdOrdinaryShutdownApproval(");
  const main = fs.readFileSync(path.join(producerRoot, "main.js"), "utf8").replace(/\r\n/g, "\n");
  const capture = between(main, "function captureFileOpenDelivery(", "\nfunction fileOpenSnapshotIsCurrent(");
  const chooser = between(main, "function openFileDialog() {",
    "\n// ============================================\n// IPC HANDLERS - File Operations");
  const restoreRoute = between(main, 'ipcMain.handle("restore-document-session",',
    '\nipcMain.handle("save-document-session-layout",');
  const prepareRoute = between(main, 'ipcMain.handle("prepare-document-disk-adoption",',
    "\nfunction diskAdoptionAuthorityIsCurrent(");
  const authority = between(main, "function diskAdoptionAuthorityIsCurrent(",
    "\nipcMain.on(\"check-committed-disk-adoption\",");
  const committedCheck = between(main, 'ipcMain.on("check-committed-disk-adoption",',
    "\nfunction cancelDocumentReplacementConsents(");
  const commit = between(main, "function commitDocumentDiskAdoption(",
    '\nipcMain.on("commit-document-disk-adoption",');
  const identity = between(main, "function normaliseDocumentIdentity(", "\nfunction normaliseDocumentOwner(");
  const versionNormalizer = between(main, "function normaliseDiskVersion(", "\nfunction rememberDocumentVersion(");
  const closingOwner = between(main, "function closingDocumentOwnerFromEnvelope(",
    "\n// Owner-scoped, and authoritative");
  const keyStart = main.indexOf("function documentOwnerKey(");
  const ownerKey = main.slice(keyStart, main.indexOf("\n}\n", keyStart) + 3);
  const activation = between(customTabs, "  async function switchToTab(", "\n  // Mirrors main's safeFileLabel.");
  const verification = between(customTabs, "  async function verifyDiskAdoption(", "\n  // Pull newer content off disk");
  const approvalMatch = between(customTabs, "  function matchesDiskAdoptionApproval(", "\n  function snapshotTabAdoption(");
  const loadSaved = between(customTabs, "  async function loadSavedTabs(", "\n  const tabPathAliases =");
  const navigate = between(main, '  wc.on("did-navigate", () => {',
    "\n\n  // The page finished loading");
  const revoke = between(main, "function revokeShutdownAuthorization() {", "\nfunction grantShutdownAuthorization(");
  const dirty = between(customTabs, "  function dirtyTabNames(", "\n  window.addEventListener(PENDING_SAVE_STATUS_EVENT,");
  const run = async (options = {}) => {
    // Both Main adoption gates and renderer restore/activation/verification execute.
    // Filesystem, registration, renderer lifecycle/paint/layout and close/ACK are ports.
    const file = "C:\\fixture\\f22-navigation-edit.md";
    const seed = "Navigation edit fixture\n\n" +
      (options.discardBoundary ? "Generation discard fixture\n\n" : "") + "before\n";
    const version = { dev: 1, ino: 2, size: seed.length, mtimeMs: 3, ctimeMs: 4 };
    const trace = [], assertions = [], trackingSelections = [], handlers = new Map(), owners = new Map();
    const baselines = new Map(), knownOwners = new Map(), adoptionCalls = [], preparations = [];
    const documentState = new Map();
    const crypto = require("node:crypto");
    const aReadStarted = deferred(), aReadRelease = deferred(), pageWorks = [];
    let aReadHeld = false, aReadReleased = false;
    let active = null, nextRef = 0, pageSession = "navigation-page-5", clock = 0, closeRequests = 0;
    let layoutCalls = 0, reloadWork = null, beforeOwner = null, restoredOwner = null, painted = "";
    let phaseA = null;
    const frame = { isDestroyed: () => false, parent: null, frameTreeNodeId: 31 };
    const wc = Object.assign(new (require("node:events").EventEmitter)(), {
      mainFrame: frame, isDestroyed: () => false,
    });
    const nativeOwner = { webContents: wc, isDestroyed: () => false };
    const dialog = { showOpenDialog() { throw new Error("Unowned Source chooser"); } };
    const state = { renderer: "ready", rendererGeneration: 5, authorized: false,
      pendingId: 0, commitPendingId: 0, lastRequestId: 100 };
    let questionCallback = null, questionRecord = null, questionConsumer = null;
    const questionRecords = [];
    let questionConsumerResolve = null, questionCallbackWork = null, questionDriverRestored = false;
    const page = { window: {}, document: { getElementById: () => ({ textContent: painted }) },
      Date: { now: () => clock += 1000 }, setTimeout: resolve => { resolve(); return 0; } };
    const rendererContext = vm.createContext(page);
    const mainContext = vm.createContext({
      mainWindow: nativeOwner, BrowserWindow: { fromWebContents: target => target === wc ? nativeOwner : null },
      wc, pendingShutdown: null, pendingShutdownCommit: null, shutdownAuthorized: false,
      shutdownAuthorizationOwnerId: 0, shutdownAuthorizationGeneration: 0, shutdownAuthorizationCapacityLatched: false,
      latestAcceptedSaveSequenceByDocument: new Map(), latestWatcherSelectionGeneration: 0,
      overlayProbeOwner: null, releaseDeletionDeliveriesForPage() {},
      quitAfterFrozenUpdaterDocumentLoss: () => false,
      finishShutdownCommit: attempt => { assert.equal(attempt, null); },
      restartPendingShutdownAfterNavigation: attempt => { assert.equal(attempt, null); },
      approvalRendererGeneration: 5, approvalRendererPageSession: pageSession, approvalRendererState: "ready",
      fileOpenDeliveryEpoch: 0, shutdownCommitIngressBlocked: false, activeDialogExtraBatch: null,
      documentAdmissions: new Map(), documentSessionFailure: null,
      documentSessionManifest: { entries: [], activeEntryId: null }, protectedSessionEntries: new Set(),
      unavailableSessionEntries: new Set(), pinnedAdoptionAdmissionReferences: () => new Set(),
      isApprovalSender: event => event.sender === wc && event.senderFrame === frame,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler),
        on: (name, handler) => handlers.set(name, handler) },
      SUPPORTED_EXTENSIONS: { markdown: [".md"], mermaid: [".mmd"] }, dialog,
      markdownSnapshotPromise: async filePath => {
        assert.equal(filePath, file); trace.push("snapshot");
        return { content: seed, modifiedTime: 3, diskVersion: { ...version },
          physical: { readTarget: file, pathKey: file } };
      },
      confirmLargeDocument: () => true, rememberDocumentModifiedTime() {},
      issueDocumentAdmission: (target, filePath, diskVersion, physical, provenance, entryId = "navigation-entry") => {
        assert.equal(target, wc); assert.equal(filePath, file);
        assert.equal(physical.readTarget, file);
        const descriptor = { ref: crypto.createHash("sha256").update(String(++nextRef)).digest("hex"),
          entryId, logicalPath: file, pathKey: file,
          readTarget: options.wrongPhysical ? "C:\\foreign.md" : file, diskVersion };
        mainContext.documentAdmissions.set(descriptor.ref, { sender: wc, frame,
          generation: state.rendererGeneration, pageSession, descriptor, tabId: null });
        trace.push("admission-" + mainContext.approvalRendererGeneration);
        return descriptor;
      },
      safeSendFileOpen: (target, channel, packet, generation) => {
        assert.equal(target, wc); assert.equal(channel, "file-opened");
        assert.equal(generation, state.rendererGeneration);
        const observation = page.window.__dialogBatchNative;
        const processor = { eventUndefined: true, settled: false, error: null, packet };
        observation.processors.push(processor);
        processor.promise = Promise.resolve().then(() => {
          installInitial(packet); processor.settled = true;
          observation.renders.push({ settled: true, error: null, promise: Promise.resolve() });
        });
        for (const [field, variable] of Object.entries({
          renderer: "approvalRendererState", rendererGeneration: "approvalRendererGeneration",
          rendererPageSession: "approvalRendererPageSession", authorized: "shutdownAuthorized",
          authorizationGeneration: "shutdownAuthorizationGeneration",
        })) Object.defineProperty(state, field, {
          enumerable: true, configurable: true,
          get: () => mainContext[variable], set: value => { mainContext[variable] = value; },
        });
        return true;
      },
      console: { error: (...args) => trace.push("main-error:" + args.join(" ")) },
    });
    const currentAdmission = (ref, owner, filePath) => {
      const record = mainContext.documentAdmissions.get(ref);
      return record && record.sender === wc && record.frame === frame &&
        record.generation === state.rendererGeneration && record.pageSession === pageSession &&
        record.descriptor.logicalPath === filePath &&
        (!owner || owner.documentRef === ref && owner.pageSession === pageSession &&
          owner.rendererGeneration === state.rendererGeneration &&
          (!record.tabId || record.tabId === owner.tabId)) ? record : null;
    };
    const stats = () => ({ ...version, isFile: () => true });
    const sameVersion = (left, right) => !!left && !!right &&
      Object.keys(version).every(key => left[key] === right[key]);
    Object.assign(mainContext, {
      crypto, Buffer, pendingDiskAdoptions: new Map(), committedDiskAdoptions: new Map(),
      pendingDocumentReplacementConsents: new Map(), documentDeletionTombstones: new Map(),
      pathOnlyDeletionEvidence: new Map(), deletionOverflowEvidence: new Map(),
      filePathAliases: new Map(), supersededDocumentOwners: new Set(),
      knownDocumentOwners: knownOwners, ownerDocumentBaselines: baselines,
      deletionEvidenceRevision: 1, DISK_ADOPTION_CAPABILITY_MS: 60000, MAX_PENDING_DISK_ADOPTIONS: 128,
      admittedDocumentReference: currentAdmission,
      approvedBrowserDocumentPermission: (event, filePath) => {
        assert.equal(event.sender, wc); assert.equal(event.senderFrame, frame); assert.equal(filePath, file);
        const record = Array.from(mainContext.documentAdmissions.values()).find(candidate =>
          currentAdmission(candidate.descriptor.ref, null, filePath));
        if (!record) throw new Error("Unadmitted source");
        return { filePath, ref: record.descriptor.ref, generation: state.rendererGeneration, pageSession };
      },
      approvedBrowserPermissionIsCurrent: permission =>
        permission.generation === state.rendererGeneration && permission.pageSession === pageSession &&
        !(options.revokedAuthority && state.rendererGeneration === 7) &&
        !!currentAdmission(permission.ref, null, permission.filePath),
      sameDocumentOwner: (left, right) => !!left && !!right &&
        identityFields.every(field => left[field] === right[field]),
      resolveCanonicalFileKey: filePath => filePath === file ? file : null,
      canonicalFileKey: filePath => filePath === file ? file : null,
      resolveCanonicalFilePath: filePath => filePath === file ? file : null,
      filePathSpellingKey: filePath => filePath,
      diskVersionChanged: (left, right) => !sameVersion(left, right),
      diskVersionFromStats: value => Object.fromEntries(Object.keys(version).map(key => [key, value[key]])),
      readDocumentStats: filePath => filePath === file ? stats() : null,
      fs: { promises: {
        open: async filePath => {
          assert.equal(filePath, file);
          const readingGeneration = state.rendererGeneration;
          return { stat: async () => stats(),
            readFile: async () => {
              if (options.holdAPreparation && readingGeneration === 6) {
                aReadHeld = true; trace.push("A-read-held"); aReadStarted.resolve();
                await aReadRelease.promise; trace.push("A-read-completed");
              }
              return options.changedDiskBytes && readingGeneration === 7 ? seed + "CHANGED" : seed;
            },
            close: async () => {} };
        },
        stat: async filePath => { assert.equal(filePath, file); return stats(); },
      } },
      wrapMermaidContent: text => text, removeBOM: text => text.replace(/^\uFEFF/, ""),
      prunePendingDiskAdoptions() {}, adoptionOverflowKeys: () => [],
      adoptionEvidencePathKeys: () => new Set(), unreachablePhysicalDeletionSpellings: () => [],
      sharedDeletionEvidenceNeedsSiblingCheck: () => false, orphanedDeletionForSpelling: () => false,
      pathOnlyDeletionForSpelling: () => false, log: (...args) => trace.push(args.join(" ")),
    });
    vm.runInContext("let updateMainDialogDepth = 0, updateSchedule = null;\n" +
      between(main, "function trackUpdateDialog(promise) {", "\nfunction mainDialogs() {") + "\n" +
      capture + "\n" + chooser + "\n" + restoreRoute + "\n" +
      prepareRoute + "\n" + authority + "\n" + committedCheck + "\n" + commit + "\n" +
      identity + "\n" + ownerKey + "\n" + versionNormalizer + "\n" + closingOwner + "\n" +
      revoke + "\n" + navigate, mainContext);
    const register = (tab, descriptor) => {
      const identity = { tabId: tab.id, pageSession,
        rendererGeneration: state.rendererGeneration, documentGeneration: nextRef,
        documentRef: descriptor.ref, pathKey: file, spelling: file };
      assert.ok(currentAdmission(descriptor.ref, identity, file));
      mainContext.documentAdmissions.get(descriptor.ref).tabId = tab.id;
      tab.owner = identity;
      owners.set(identity.documentRef, identity);
      const key = mainContext.documentOwnerKey(identity);
      knownOwners.set(key, identity); baselines.set(key, { owner: identity, content: tab.content });
      return identity;
    };
    const recordSelection = (tab, restored) => {
      const selection = { filePath: file, adoptBaseline: true, diskVersion: { ...tab.diskVersion }, owner: tab.owner };
      const decision = { accepted: true, trackingActive: true };
      if (restored && options.badVersion) selection.diskVersion.mtimeMs++;
      if (restored && options.refusedSelection) decision.accepted = false;
      if (restored && options.foreignSelection) selection.owner = { ...tab.owner, pageSession: "foreign-page" };
      trackingSelections.push({ selection, decision });
      return decision.accepted;
    };
    const create = (filePath, content, settings) => {
      const tab = { id: ++rendererContext.tabIdCounter, filename: path.basename(filePath), filePath,
        content, originalContent: content, hasUnsavedChanges: false,
        descriptor: settings.documentAdmission, diskVersion: settings.diskVersion, mtimeMs: settings.modifiedTime };
      register(tab, settings.documentAdmission);
      documentState.set(tab, { admission: settings.documentAdmission, pathKey: file,
        generation: tab.owner.documentGeneration, mutationRevision: 0 });
      rendererContext.tabs.push(tab);
      return tab;
    };
    const installInitial = packet => {
      active = create(packet.path, packet.content, { documentAdmission: packet.document,
        diskVersion: packet.diskVersion, modifiedTime: packet.modifiedTime });
      rendererContext.activeTabId = active.id;
      page.window.originalMarkdown = packet.content; page.window.currentFilePath = file; painted = packet.content;
      beforeOwner = active.owner;
      recordSelection(active, false);
    };
    Object.assign(page.window, {
      folia: {
        openFileDialog: () => { trace.push("chooser"); mainContext.openFileDialog(); },
        restoreSession: () => handlers.get("restore-document-session")({ sender: wc, senderFrame: frame }),
        checkCommittedDiskAdoption: data => {
          const event = { sender: wc, senderFrame: frame };
          handlers.get("check-committed-disk-adoption")(event, data);
          return event.returnValue;
        },
      },
      crypto: crypto.webcrypto,
      prepareDocumentDiskAdoption: async data => {
        const result = await handlers.get("prepare-document-disk-adoption")({ sender: wc, senderFrame: frame }, data);
        preparations.push({ data, result }); return result;
      },
      commitDocumentDiskAdoption: data => {
        const result = mainContext.commitDocumentDiskAdoption({ sender: wc, senderFrame: frame }, data);
        adoptionCalls.push({ data, result, blocked: mainContext.shutdownCommitIngressBlocked });
        trace.push("commit-" + state.rendererGeneration + ":" + (result.accepted ? "accepted" : result.why));
        return result;
      },
      getReloadRequestSession: () => pageSession,
      queryDocumentDeletionState: (_filePath, identity) => ({
        known: owners.get(identity.documentRef) === identity &&
          baselines.has(mainContext.documentOwnerKey(identity)), unresolved: false,
      }),
      CustomTabs: {
        getActiveTab: () => active,
        getDocumentIdentityForTab: () => active?.owner,
        getDocumentDescriptor: () => active?.descriptor,
        settleSessionLayout: async () => {
          trace.push("layout-" + ++layoutCalls);
          if (!options.noPersistence && active) {
            mainContext.documentSessionManifest = {
              entries: [{ id: active.descriptor.entryId, filePath: file, provenance: "native-dialog" }],
              activeEntryId: options.notSelected ? null : active.descriptor.entryId,
            };
          }
        },
      },
    });
    Object.assign(rendererContext, {
      tabs: [], activeTabId: null, tabIdCounter: 40, nextDocumentGeneration: 0,
      approvalRendererGeneration: 5, latestTabSwitchIntent: 0, latestFileOpenIntent: 0,
      pendingConfirmedReload: null, pendingActivationTabs: new Set(), pendingHandshakeTrackingAssertion: null,
      sessionRestoreInProgress: false, sessionRestoreStarted: false, sessionRestoreToken: 0,
      sessionOwnerReady: Promise.resolve(true), renderGeneration: 0, documentState,
      appliedDiskAdoptionApprovals: new Set(), handedOffDiskAdoptionApprovals: new Set(),
      TextEncoder, Uint8Array,
      createTab: create, findTabForAdmission: () => null, safeDocumentLabel: value => value,
      documentIdentity: (tab, session) => tab?.owner?.pageSession === session ? tab.owner : null,
      liveDocument: () => page.window.originalMarkdown,
      normaliseDiskVersion: mainContext.normaliseDiskVersion, sameDiskVersion: sameVersion,
      normaliseTabPath: value => ({ spelling: value }), tabSpellingKey: tab => tab.filePath,
      isDocumentFrozen: () => false, mayMutateDocument: () => true,
      hasUnsavedMutation: tab => tab.hasUnsavedChanges, confirmLargeTab: () => true,
      refreshTabFromDisk: () => false,
      abandonDiskAdoption: capability => {
        mainContext.pendingDiskAdoptions.delete(capability);
        mainContext.committedDiskAdoptions.delete(capability);
      },
      notify: message => trace.push("notification:" + message),
      console: { log() {}, warn: (...args) => trace.push("renderer-warning:" + args[0]),
        error: (...args) => trace.push("renderer-error:" + args[0]) },
      queuePreHandshakeTrackingAssertion() {}, dismissUpdatePrompt() {}, renderTabs() {},
      bumpDocumentRevision() {},
      positionOf: () => ({}), restorePosition() {},
      approvedReloadSnapshotMatches: approval => {
        const grant = mainContext.committedDiskAdoptions.get(approval.capability);
        return !!grant && grant.rendererGeneration === state.rendererGeneration && sameVersion(grant.version, version);
      },
      saveTabs: () => { if (active) return page.window.CustomTabs.settleSessionLayout(); },
      inEditMode: () => false, frozenDocumentOperationsDropped: false,
      pendingSaveStatusForShutdown: () => ({ pending: false }),
      snapshotActiveTab: () => {
        if (!active) return;
        trace.push("dirty-fold");
        active.content = page.window.originalMarkdown;
        active.hasUnsavedChanges = active.content !== active.originalContent;
      },
      isDirty: tab => tab.hasUnsavedChanges,
    });
    page.window.beginFileOpen = (data, settings) => {
      const tab = rendererContext.tabs.find(candidate => candidate.id === settings.ownerTabId);
      const grant = mainContext.committedDiskAdoptions.get(settings.deletionAdoptionApproval?.capability);
      assert.ok(tab && grant && grant.proposedOwner.documentRef === tab.owner.documentRef);
      assert.equal(grant.rendererGeneration, state.rendererGeneration);
      if (!recordSelection(tab, true)) return null;
      active = tab; restoredOwner = tab.owner;
      page.window.currentFilePath = data.path; page.window.originalMarkdown = data.content;
      settings.onTrackingCommitted();
      trace.push("selection-" + state.rendererGeneration);
      return { approvedOwner: tab.owner };
    };
    page.window.completeFileOpen = (_context, restorePosition) => { restorePosition(); return true; };
    page.window.renderMarkdown = async content => {
      if (!options.noPaint) painted = content;
      trace.push("paint-" + state.rendererGeneration);
    };
    vm.runInContext(dirty + "\n" + verification + "\n" + approvalMatch + "\n" + activation + "\n" +
      loadSaved + "\nwindow.CustomTabs.__dirtyTabNames = dirtyTabNames;", rendererContext);
    const exec = async script => vm.runInContext(script, rendererContext);
    const rig = { closes: 0, quits: 0, dialogs: [], answer: 1, reset: () => {
      trace.push("rig-reset"); rig.closes = 0; rig.quits = 0; rig.dialogs = []; rig.answer = 1;
    } };
    const waitUntil = async predicate => {
      // These ports choose two schedules without changing the actor's READY test:
      // ordinary A drains; held A exposes READY while the actual file read remains pending.
      if (state.rendererGeneration === 6 && reloadWork) {
        if (options.holdAPreparation) await aReadStarted.promise;
        else await reloadWork;
      }
      for (let count = 0; count < 10; count++) { if (await predicate()) return true; await turn(); }
      return false;
    };
    wc.reload = () => {
      trace.push("reload");
      active = null; painted = "";
      wc.emit("did-navigate");
      trace.push("navigation-invalidated-" + state.rendererGeneration);
      mainContext.approvalRendererPageSession = pageSession = "navigation-page-" + state.rendererGeneration;
      state.renderer = "ready";
      if (options.holdAPreparation && state.rendererGeneration === 7) {
        aReadReleased = true; trace.push("A-read-release"); aReadRelease.resolve();
      }
      page.window.currentFilePath = null; page.window.originalMarkdown = "";
      Object.assign(rendererContext, { tabs: [], activeTabId: null,
        sessionRestoreInProgress: false, sessionRestoreStarted: false,
        approvalRendererGeneration: state.rendererGeneration });
      documentState.clear();
      reloadWork = rendererContext.loadSavedTabs();
      pageWorks.push(reloadWork);
    };
    const context = vm.createContext({
      exec, wc, rig, dialog, navigationEditFile: file, navigationSeed: seed, trackingSelections,
      replacementTracking: null, indexFile: "C:\\fixture\\src\\index.html", path, nativePathKey: value => value,
      fs: { realpathSync: { native: value => value } }, setTimeout, clearTimeout, require,
      __shutdown: {
        reset: () => {
          trace.push("reset"); mainContext.shutdownCommitIngressBlocked = false; state.authorized = false;
          if (aReadHeld && !aReadReleased) trace.push("reset-held-A-generation-" + state.rendererGeneration);
          baselines.clear();
        },
        state: () => ({ ...state }),
        documentSessionState: () => mainContext.documentSessionManifest,
        readQuestionConsumer: (requestId, signal) =>
          requestId === questionRecord?.requestId && signal === questionRecord.options.signal
            ? questionConsumer : null,
      },
      installMainOwnedShutdownQuestions: (target, tails, settings) => {
        assert.equal(settings.policy, "ordinary-strict");
        questionCallback = settings.onRecord;
        return {
          records: questionRecords,
          async join(boundary) {
            if (boundary) await boundary();
            if (questionCallbackWork) await questionCallbackWork;
            return { dispatchBoundaryJoined: !!boundary };
          },
          restore() { questionDriverRestored = true; questionCallback = null; },
        };
      },
      prepareDiscardTerminalBoundary() {
        mainContext.shutdownCommitIngressBlocked = true;
        state.authorized = true;
        rig.closes = 1;
      },
      guardEvent: () => ({ prevented: false }),
      win: { webContents: wc, loadFile: async target => {
        assert.equal(target, "C:\\fixture\\src\\index.html");
        const initialNavigation = state.rendererGeneration === 5;
        if (!initialNavigation && options.loadFailure) throw options.loadFailure;
        if (!initialNavigation && options.noNavigationInvalidation) {
          wc.removeListener("did-navigate", wc.listeners("did-navigate")[0]);
        }
        trace.push(initialNavigation ? "initial-load" : "separate-reload");
        wc.reload();
        if (initialNavigation) {
          // Native load completion and asynchronous tab restoration are different
          // producers: the held actual adoption read must still survive into B.
          if (options.holdAPreparation) await aReadStarted.promise;
          else await reloadWork;
          if (options.holdALoadCompletion) {
            options.onALoadHeld({ state: { ...state }, trace: trace.slice(),
              assertions: assertions.slice(), listeners: wc.listenerCount("did-navigate") });
            await options.aLoadRelease;
          }
          if (options.aLoadFailure) throw options.aLoadFailure;
          trace.push("A-load-completed");
        } else await reloadWork;
      }, emit: (name, event) => {
        assert.equal(name, "close"); event.prevented = true;
        closeRequests++; trace.push("close-" + closeRequests);
        if (closeRequests === 1) {
          assert.equal(active.content, seed); assert.equal(active.hasUnsavedChanges, false);
          assert.ok(beforeOwner && mainContext.documentSessionManifest.activeEntryId);
          rig.closes++; state.authorized = true;
          state.authorizationGeneration = state.rendererGeneration;
          mainContext.shutdownCommitIngressBlocked = true;
        } else {
          assert.ok(active.hasUnsavedChanges);
          if (!options.noQuestion) {
            state.pendingId = ++state.lastRequestId;
            const signal = new AbortController().signal;
            questionConsumer = new Promise(resolve => { questionConsumerResolve = resolve; });
            questionRecord = {
              owner: context.win, sender: wc, requestId: state.pendingId, pendingReason: "window-close",
              generation: state.rendererGeneration, pageSession,
              options: { title: "Unsaved changes", message: path.basename(file),
                buttons: ["Discard changes", "Cancel"], defaultId: 1, cancelId: 1, signal },
              response: null, displayed: true, settled: false, retired: false,
              presentation: { title: "Unsaved changes" },
              presentationReady: Promise.resolve({ kind: "displayed" }),
              choose(response) {
                trace.push("answer-" + response);
                this.response = options.nonCancel ? 0 : response;
                this.result = { cause: "choice", response: this.response, displayed: true, failed: false };
                this.choiceDelivered = true; this.driverSettled = true; this.settled = true; this.retired = true;
                if (options.nonCancel) rig.closes++;
                if (options.extraClose) rig.closes++;
                state.pendingId = options.pendingCancel ? 99 : 0;
                if (options.pendingCommit) state.commitPendingId = 99;
                questionConsumerResolve(this.result);
              },
            };
            questionRecords.push(questionRecord);
            questionCallbackWork = Promise.resolve(questionCallback(questionRecord)).then(() => {
              questionRecord.observerSettled = true;
            });
          }
        }
      } },
      waitUntil, navigationTrackingWitness: async () => ({ pageSession }),
      waitForCondition: async (runExec, predicate) => waitUntil(() => runExec(predicate)),
      installDialogBatchPageObservation: async installer => installer(
        "(() => { window.__dialogBatchNative = { processors: [], renders: [] }; return true; })()"),
      restoreDialogBatchPageObservation: async () => { delete page.window.__dialogBatchNative; },
      check: (name, success, detail) => {
        if (name.startsWith("navigation revokes the granted")) {
          trace.push("revocation-assertion");
          phaseA = { ...rig, dialogs: rig.dialogs.slice(), resets: trace.filter(value => value === "reset").length };
        }
        assertions.push({ name, success: !!success, detail });
      },
      console: { log() {} },
    });
    vm.runInContext(replace + "\n" + bounded + "\n" + open + "\n" + restore + "\n" + ownedCleanup +
      "\n" + generationQuestions, context);
    if (options.staleOwner) {
      const settle = context.settleShutdownLifecycleRestore;
      context.settleShutdownLifecycleRestore = async (...args) => {
        const value = await settle(...args);
        return { ...value, tabId: options.reusedTabId ? value.tabId : beforeOwner.tabId, owner: beforeOwner };
      };
    }
    let actual = scenario;
    if (options.oldVoidALoad) actual = actual.replace(
      "    await win.loadFile(indexFile);\n    const successorReady =",
      "    wc.reload();\n    const successorReady =");
    if (options.oldChooser) actual = actual.replace(
      "const navigationAdmission = await settleShutdownLifecycleRestore(",
      "const navigationAdmission = await openShutdownLifecycleFixture(");
    if (options.noBoundary) actual = actual.replace(
      "        __shutdown.reset();\n        rig.reset();\n        navigationLifecycleGeneration",
      "        rig.reset();\n        navigationLifecycleGeneration");
    if (options.noRealReload) actual = actual.replace(
      "    try { await win.loadFile(indexFile); }", "    try { /* reload omitted */ }");
    if (options.resetBeforeA) actual = actual.replace("    const afterRevocation = __shutdown.state();",
      "    const afterRevocation = __shutdown.state();\n    __shutdown.reset();");
    if (options.resetBeforeNavigate) actual = actual.replace(
      '    wc.once("did-navigate", onNavigationLifecycle);',
      '    __shutdown.reset();\n    wc.once("did-navigate", onNavigationLifecycle);');
    if (options.noRevocation) {
      const reload = wc.reload;
      wc.reload = () => { reload(); state.authorized = true; };
    }
    if (options.noPreadmission) actual = actual.replace(
      "const navigationPreadmission = await openShutdownLifecycleFixture(\n" +
      '      exec, navigationEditFile, navigationSeed, "Navigation edit fixture",\n    );',
      'const navigationPreadmission = { descriptor: { entryId: "absent" } };');
    if (options.discardBoundary) {
      let actualBoundary = discardBoundary;
      if (options.noDiscardReset) actualBoundary = actualBoundary.replace(
        "          __shutdown.reset();\n          rig.reset();", "          rig.reset();");
      if (options.earlyDiscardReset) actualBoundary = actualBoundary.replace(
        '      wc.once("did-navigate", onDiscardLifecycle);',
        '      __shutdown.reset();\n      wc.once("did-navigate", onDiscardLifecycle);');
      actual += "\nprepareDiscardTerminalBoundary();\nconst retainDiscardChoice = true;\n" +
        "let restoredCollisionAdmission = null;\nconst discardNavigationFile = navigationEditFile;\n" +
        "const discardSeed = navigationSeed;\n" + actualBoundary;
    }
    let error = null;
    try { await vm.runInContext("(async () => {\n" + actual + "\n})()", context); }
    catch (failure) { error = failure; }
    await Promise.all(pageWorks);
    return { trace, assertions, error, rig, beforeOwner, restoredOwner, closeRequests, phaseA,
      adoptionCalls, preparations, active, painted,
      aReadHeld, aReadReleased, remainingNavigationListeners: wc.listenerCount("did-navigate"),
      questionDriverRestored,
      blocked: mainContext.shutdownCommitIngressBlocked,
      state: { ...state },
      persisted: mainContext.documentSessionManifest, observation: page.window.__dialogBatchNative };
  };
  const good = await run();
  assert.equal(good.error, null, require("node:util").inspect({
    error: good.error, trace: good.trace, preparations: good.preparations, adoptionCalls: good.adoptionCalls,
  }, { depth: null }));
  check(!good.error && good.assertions.length === 3 && good.assertions.every(assertion => assertion.success) &&
    good.beforeOwner.tabId !== good.restoredOwner.tabId &&
    good.beforeOwner.documentRef !== good.restoredOwner.documentRef &&
    good.beforeOwner.pageSession !== good.restoredOwner.pageSession,
  "Split generation actor preserves its separate revocation and edit/Cancel checks with a genuinely activated fresh replacement owner");
  check(good.trace.filter(value => value === "chooser").length === 1 &&
    good.trace.indexOf("chooser") < good.trace.indexOf("close-1") &&
    good.trace.indexOf("layout-1") < good.trace.indexOf("close-1") &&
    good.trace.indexOf("close-1") < good.trace.indexOf("reload") &&
    good.trace.indexOf("revocation-assertion") < good.trace.lastIndexOf("reset") &&
    good.trace.indexOf("separate-reload") < good.trace.lastIndexOf("reset") &&
    good.trace.lastIndexOf("reset") < good.trace.indexOf("commit-7:accepted") &&
    good.phaseA.resets === 1 && good.trace.filter(value => value === "reset").length === 2,
  "Revocation is asserted before any separate-lifecycle reset and the physical fixture was persisted before the approved close");
  check(good.adoptionCalls.length === 2 && good.adoptionCalls[0].blocked &&
    good.adoptionCalls[0].result.accepted === false &&
    good.adoptionCalls[0].result.why === "stale-adoption-identity" &&
    !good.adoptionCalls[1].blocked && good.adoptionCalls[1].result.accepted === true &&
    good.preparations.length === 2 && good.preparations.every(record =>
      record.result.known === true && record.result.versionMatches === true),
  "Actual renderer restore activation and verifyDiskAdoption reach actual Main preparation and commit: retained fence refuses, separate initialization accepts");
  check(good.trace.indexOf("commit-7:accepted") < good.trace.indexOf("selection-7") &&
    good.trace.indexOf("selection-7") < good.trace.indexOf("paint-7") &&
    !good.trace.includes("selection-6") && !good.trace.includes("paint-6") &&
    good.phaseA.closes === 1 && good.phaseA.quits === 0 &&
    good.closeRequests === 2 && good.rig.closes === 0 && good.rig.quits === 0 &&
    good.rig.dialogs.length === 1 && good.rig.dialogs[0].response === 1 && good.questionDriverRestored &&
    good.state.pendingId === 0 && good.state.commitPendingId === 0 &&
    good.rig.answer === 1 && good.trace.includes("dirty-fold") &&
    good.persisted.entries[0].filePath.endsWith("f22-navigation-edit.md") && !good.observation,
  "Only accepted adoption reaches selection/paint; saved phase-A close evidence stays one while separate live-only edit and joined Cancel leave zero closes/quits");
  const aLoadRelease = deferred(), aLoadHeld = deferred();
  let heldLoadActorCompleted = false;
  const heldLoadWork = run({ holdALoadCompletion: true, aLoadRelease: aLoadRelease.promise,
    onALoadHeld: snapshot => aLoadHeld.resolve(snapshot) }).then(result => {
    heldLoadActorCompleted = true;
    return result;
  });
  const firstLoadOutcome = await Promise.race([
    aLoadHeld.promise.then(snapshot => ({ snapshot })),
    heldLoadWork.then(result => ({ result })),
  ]);
  const heldLoadSnapshot = firstLoadOutcome.snapshot;
  const bBlockedWhileALoadHeld = !!heldLoadSnapshot &&
    heldLoadSnapshot.state.renderer === "ready" && heldLoadSnapshot.state.rendererGeneration === 6 &&
    heldLoadSnapshot.listeners === 1 && heldLoadSnapshot.assertions.length === 0 &&
    !heldLoadSnapshot.trace.includes("separate-reload") && !heldLoadActorCompleted;
  aLoadRelease.resolve();
  const heldLoadJoined = await heldLoadWork;
  check(bBlockedWhileALoadHeld,
    "Actual A navigation producer stays joined after READY: B has neither installed its listener nor begun its load while A completion is held");
  check(!heldLoadJoined.error && heldLoadJoined.assertions.every(assertion => assertion.success) &&
    heldLoadJoined.trace.indexOf("A-load-completed") < heldLoadJoined.trace.indexOf("revocation-assertion") &&
    heldLoadJoined.trace.indexOf("revocation-assertion") < heldLoadJoined.trace.indexOf("separate-reload"),
  "Releasing A's original same-index load completion permits the unchanged revocation assertion and then B's original post-Main boundary");
  const oldVoidLoad = await run({ oldVoidALoad: true });
  check(!oldVoidLoad.error && oldVoidLoad.trace.includes("separate-reload") &&
    !oldVoidLoad.trace.includes("initial-load") && !oldVoidLoad.trace.includes("A-load-completed"),
  "The former void reload counterfactual can begin B without joining any original A navigation producer");
  const aLoadFailure = new Error("ORIGINAL_A_LOAD_REJECTED_AFTER_READY");
  const rejectedALoad = await run({ aLoadFailure });
  check(rejectedALoad.error === aLoadFailure && rejectedALoad.state.renderer === "ready" &&
    rejectedALoad.state.rendererGeneration === 6 && rejectedALoad.assertions.length === 0 &&
    !rejectedALoad.trace.includes("separate-reload") && rejectedALoad.remainingNavigationListeners === 1,
  "A's rejected original load remains its exact failure even after READY and cannot be swallowed or start B");
  for (const option of ["noPreadmission", "noPersistence", "notSelected", "wrongPhysical"]) {
    const bad = await run({ [option]: true });
    check(bad.error?.message === "Navigation approval fixture is not its persisted selected physical entry" &&
      bad.closeRequests === 0 && !bad.trace.includes("reload") && !bad.observation,
    "Actual preapproval guard refuses missing or foreign persisted selected physical fixture: " + option);
  }
  for (const reusedTabId of [false, true]) {
    const stale = await run({ staleOwner: true, reusedTabId });
    check(stale.error?.message === "Navigation fixture is not the restored active owner" &&
      stale.closeRequests === 1 && stale.beforeOwner.pageSession !== stale.restoredOwner.pageSession,
    "An old admitted owner cannot stand in for the restored page even with " +
      (reusedTabId ? "a matching replacement tab ID" : "its previous tab ID"));
  }
  for (const option of ["badVersion", "refusedSelection", "foreignSelection", "noQuestion",
    "nonCancel", "extraClose", "pendingCancel", "pendingCommit"]) {
    const bad = await run({ [option]: true });
    check(bad.assertions[0].success && bad.adoptionCalls.at(-1).result.accepted === true &&
      (option === "refusedSelection"
        ? bad.error?.message === "Shutdown lifecycle restore did not reach its painted authenticated owner" &&
          !bad.active && !bad.painted
        : option === "noQuestion"
          ? bad.assertions[1].success && bad.error?.errors?.some(error =>
            error.message === "Generation question has no exact original Main consumer") &&
            bad.questionDriverRestored
        : !bad.error && bad.assertions[1].success && bad.assertions[2].success === false),
    "Separate physical-owner/Cancel oracle rejects refused selection or exact version/question/close/pending failure: " + option);
  }
  const old = await run({ oldChooser: true, noBoundary: true });
  check(old.error?.errors?.some(error => error.message === "Shutdown lifecycle native file was not delivered") &&
    old.trace.filter(value => value === "chooser").length === 2 &&
    old.closeRequests === 1 && old.blocked && !old.observation,
  "Old postclose chooser remains refused by unchanged Main ingress authority; issuer receipts cannot bypass the actual activation gate");
  const unpainted = await run({ noPaint: true });
  check(unpainted.error?.message === "Shutdown lifecycle restore did not reach its painted authenticated owner" &&
    unpainted.closeRequests === 1,
  "Actual replacement restore helper still refuses an unpainted page rather than treating newer READY as content completion");
  const noBoundary = await run({ noBoundary: true });
  check(noBoundary.error?.message === "Shutdown lifecycle restore did not reach its painted authenticated owner" &&
    noBoundary.adoptionCalls.length === 2 && noBoundary.adoptionCalls.every(record =>
      record.blocked && record.result.accepted === false && record.result.why === "stale-adoption-identity") &&
    !noBoundary.active && !noBoundary.painted && noBoundary.closeRequests === 1 &&
    noBoundary.assertions.length === 1 && noBoundary.assertions[0].success,
  "Without the separate-lifecycle reset the actual Main commit rejects both real renderer activations and no active/painted success is fabricated");
  const noReload = await run({ noRealReload: true });
  check(noReload.error?.message === "Separate navigation lifecycle did not reach its post-Main navigation boundary" &&
    noReload.adoptionCalls.length === 1 && !noReload.active && !noReload.painted &&
    noReload.assertions.length === 1 && noReload.assertions[0].success,
  "Reset's retained registrations cannot substitute for the separate real reload and fresh authenticated owner/baseline");
  const earlyReset = await run({ resetBeforeA: true });
  check(!earlyReset.error && earlyReset.phaseA.resets === 2 &&
    earlyReset.trace.indexOf("revocation-assertion") > earlyReset.trace.indexOf("reset",
      earlyReset.trace.indexOf("reset") + 1) && good.phaseA.resets === 1,
  "Executed early-reset counterfactual is distinguishable by actual order even when its state-only boolean would otherwise look revoked");
  const notRevoked = await run({ noRevocation: true });
  check(!notRevoked.error && notRevoked.assertions[0].success === false &&
    good.assertions[0].success && good.phaseA.closes === 1,
  "Narrow phase-A assertion independently rejects a navigation that fails to revoke the saved real grant");
  for (const [option, why] of [["revokedAuthority", "adoption-moved-during-read"],
    ["changedDiskBytes", "disk-bytes-or-target-moved"]]) {
    const bad = await run({ [option]: true });
    check(bad.error?.message === "Shutdown lifecycle restore did not reach its painted authenticated owner" &&
      bad.preparations.at(-1).result.known === false && bad.preparations.at(-1).result.why === why &&
      bad.adoptionCalls.length === 1 && !bad.active && !bad.painted,
    "Actual Main preparation cannot fabricate valid authority or matching physical bytes through dependency ports: " + option);
  }
  const heldA = await run({ holdAPreparation: true });
  check(!heldA.error && heldA.aReadHeld && heldA.aReadReleased &&
    heldA.phaseA.resets === 1 && heldA.assertions.length === 3 &&
    heldA.assertions.every(assertion => assertion.success) &&
    heldA.trace.includes("reset-held-A-generation-7") &&
    !heldA.trace.includes("reset-held-A-generation-6") &&
    heldA.trace.indexOf("reset-held-A-generation-7") < heldA.trace.indexOf("A-read-release"),
  "Actual A file read remains pending across the revocation assertion; Main's navigation listener invalidates its generation before B reset releases the fence");
  check(heldA.preparations.some(record => record.data.rendererGeneration === 6 &&
      record.result.known === false && record.result.why === "adoption-moved-during-read") &&
    heldA.adoptionCalls.length === 1 && heldA.adoptionCalls[0].data.rendererGeneration === 7 &&
    heldA.adoptionCalls[0].result.accepted === true && heldA.painted &&
    heldA.remainingNavigationListeners === 1 && good.remainingNavigationListeners === 1 &&
    noReload.remainingNavigationListeners === 1,
  "Released stale A preparation is refused by actual Main post-await scope checks while only fresh B commits/selects/paints and the actor's one-shot listener is removed");
  const earlyBoundary = await run({ holdAPreparation: true, resetBeforeNavigate: true });
  check(!earlyBoundary.error && earlyBoundary.trace.includes("reset-held-A-generation-6") &&
    earlyBoundary.trace.filter(value => value === "reset").length === 3 &&
    !heldA.trace.includes("reset-held-A-generation-6") &&
    earlyBoundary.trace.indexOf("reset-held-A-generation-6") < earlyBoundary.trace.indexOf("separate-reload"),
  "Held-read counterfactual exposes an impermissible fence release before navigation invalidation even if another check later refuses the old work");
  const missingInvalidation = await run({ noNavigationInvalidation: true });
  check(missingInvalidation.error?.errors?.some(error =>
      error.message === "Separate navigation lifecycle missed Main's invalidated loading boundary") &&
    missingInvalidation.trace.filter(value => value === "reset").length === 1,
  "Actual synchronous boundary callback stores and reports invalid Main navigation state without resetting or throwing uncaught from the event");
  const loadFailure = new Error("SEPARATE_NATIVE_LOAD_FAILURE");
  const failedLoad = await run({ loadFailure });
  check(failedLoad.error?.errors?.length === 1 && failedLoad.error.errors[0] === loadFailure &&
    failedLoad.remainingNavigationListeners === 1 &&
    failedLoad.trace.filter(value => value === "reset").length === 1,
  "Rejected original index-load promise preserves its exact failure and always removes the owned one-shot navigation observer");
  const discardReady = await run({ discardBoundary: true });
  check(!discardReady.error && discardReady.adoptionCalls.at(-1).result.accepted === true &&
    discardReady.state.rendererGeneration === 8 && discardReady.trace.includes("commit-8:accepted") &&
    discardReady.remainingNavigationListeners === 1 &&
    discardReady.trace.filter(value => value === "reset").length === 3 &&
    discardReady.trace.lastIndexOf("separate-reload") < discardReady.trace.lastIndexOf("reset"),
  "The genuine-Discard case invalidates the postterminal page before reset then genuinely adopts and paints its fresh physical restoration");
  const discardBlocked = await run({ discardBoundary: true, noDiscardReset: true });
  check(discardBlocked.error?.message === "Shutdown lifecycle restore did not reach its painted authenticated owner" &&
    discardBlocked.adoptionCalls.at(-1).blocked &&
    discardBlocked.adoptionCalls.at(-1).result.why === "stale-adoption-identity" &&
    !discardBlocked.active && !discardBlocked.painted && discardBlocked.remainingNavigationListeners === 1,
  "Without the separate genuine-Discard reset its real renderer activation reaches Main's retained fence and cannot fabricate an active physical edit owner");
  const discardEarly = await run({ discardBoundary: true, earlyDiscardReset: true });
  check(discardEarly.trace.filter(value => value === "reset").length === 4 &&
    discardEarly.trace.lastIndexOf("reset") > discardEarly.trace.lastIndexOf("separate-reload") &&
    discardEarly.trace[discardEarly.trace.lastIndexOf("separate-reload") - 1] === "reset",
  "The genuine-Discard boundary counterfactual exposes resetting before its real navigation rather than treating a terminal page as editable");
}

async function generationOwnedQuestionContracts() {
  const native = between(source, "    const navigationQuestions = installGenerationShutdownQuestions(",
    "\n    // An unanswered host's real abort");
  const nativeSend = between(source, "    let releaseSendFallback;",
    "\n    rig.reset();\n    const sendRecoveryReloadGeneration");
  const nativeProbe = between(source, "    const realProbeExecuteJavaScript = wc.executeJavaScript;",
    "\n    rig.reset();\n    await win.loadFile(bareFile);");
  const overlayProbeSource = vm.compileFunction(between(source, "const OVERLAY_PROBE_SOURCE =",
    "\nconst sleep =") + "\nreturn OVERLAY_PROBE_SOURCE;")();
  const extract = name => {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf("\n}\n", start);
    assert.ok(start >= 0 && end > start, "Complete actual " + name);
    return (source.slice(start - 6, start) === "async " ? "async " : "") + source.slice(start, end + 3);
  };
  const driverSource = ["replaceMethod", "withOrdinaryShutdownCleanup",
    "installMainOwnedShutdownQuestions", "installOrdinaryShutdownQuestions"].map(extract).join("\n");
  // Reuse the existing actual provider/preload/driver fixture, not its test runner.
  // Electron, Main consumer dispatch, navigation and physical-selection ports remain simulated.
  const fixtureText = between(fs.readFileSync(path.join(__dirname, "test-main-shutdown-question-source.js"),
    "utf8").replace(/\r\n/g, "\n"), "function fixture(settings = {}) {", "\nconst messages = ");
  const dependencies = {
    assert, crypto: require("node:crypto"), EventEmitter: require("node:events").EventEmitter,
    path, vm, require, setTimeout, setInterval, clearTimeout, clearInterval,
    pathToFileURL: require("node:url").pathToFileURL, driverSource,
    providerPath: path.join(producerRoot, "owned-dialogs.js"),
    preloadPath: path.join(producerRoot, "owned-dialog-preload.js"),
    providerSource: fs.readFileSync(path.join(producerRoot, "owned-dialogs.js"), "utf8"),
    preloadSource: fs.readFileSync(path.join(producerRoot, "owned-dialog-preload.js"), "utf8"),
  };
  const fixture = vm.compileFunction(fixtureText + "\nreturn fixture;",
    Object.keys(dependencies))(...Object.values(dependencies));
  const main = fs.readFileSync(path.join(producerRoot, "main.js"), "utf8").replace(/\r\n/g, "\n");
  const showOwned = between(main, "async function showOwnedMessage(",
    "\n// ============================================");
  const makeMain = (f, dialog, themed = f.broker) => vm.compileFunction(showOwned + "\nreturn showOwnedMessage;",
    ["approvalRendererGeneration", "approvalRendererPageSession", "approvalRendererState",
      "mainDialogs", "ownerRendererAvailable", "dialog", "console", "AbortController",
      "setInterval", "clearInterval"])(
      f.state.rendererGeneration, f.state.rendererPageSession, "ready", () => themed,
      sender => !!sender && !sender.isDestroyed(), dialog, { error() {} },
      AbortController, setInterval, clearInterval);
  const run = async (options = {}) => {
    let observer = null, originalConsumer = null, requestSignal = null;
    let originalConsumerSettled = false, heldSendObserved = false, ownerProbeFaults = 0;
    const cannotCheck = options.actor === "send" || options.actor === "probe";
    const f = fixture({ policy: "ordinary-strict", onRecord: record => observer(record) });
    f.state.pendingId = 0; f.state.commitPendingId = 0; f.state.lastRequestId = 30;
    f.state.authorized = false;
    if (options.actor === "probe") f.state.rendererPageSession = null;
    const assertions = [], consumerReads = [];
    const originalNative = async () => { throw new Error("Unclaimed source-native call"); };
    const dialog = { showMessageBox: originalNative };
    const show = makeMain(f, dialog, options.themedFailure ? {
      show() { throw new Error("Controlled original themed host failure"); },
    } : f.broker);
    const file = "C:\\fixture\\f22-navigation-edit.md";
    const setup = { filePath: file, currentFilePath: file, tabId: 7, active: { id: 7 },
      owner: { tabId: 7, pathKey: file, pageSession: f.state.rendererPageSession },
      diskVersionValid: true };
    const target = options.wrongOwner ? Object.create(f.owner) : f.owner;
    f.rig.closes = 0; f.rig.quits = 0;
    f.owner.webContents.executeJavaScript = async () => false;
    f.owner.loadFile = async () => {
      try { await f.owner.webContents.executeJavaScript(overlayProbeSource); }
      catch (error) {
        ownerProbeFaults++;
        f.state.renderer = "unusable";
        f.state.probeOwnerToken = 0;
        f.state.rendererUnusableReason = "page could not be inspected: " + error.message;
      }
    };
    const realDiscardSend = f.owner.webContents.send;
    f.owner.on("close", event => {
      event.preventDefault();
      f.state.pendingId = options.wrongRequest ? 32 : 31; f.state.lastRequestId = f.state.pendingId;
      f.state.pendingReason = options.wrongReason ? "app-quit" : "window-close";
      if (options.actor === "send") {
        try { f.owner.webContents.send("quit-approval-request"); }
        catch (error) {
          assert.equal(error.message, "controlled synchronous shutdown send failure");
          f.state.pendingDispatchedTo = 0; f.state.pendingDispatchToken = 0;
          f.state.sendFailureCount = 1;
        }
      }
      requestSignal = new AbortController().signal;
      originalConsumer = show(f.owner, f.options({
        ...(cannotCheck ? { title: "Unsaved changes cannot be checked", buttons: ["Close anyway", "Cancel"] } : {}),
        message: options.wrongFile ? '"foreign.md" has unsaved changes.' : '"' + path.basename(file) + '" has unsaved changes.',
        ...(options.wrongButtons ? { buttons: ["Continue", "Cancel"] } : {}),
        ...(options.wrongDefault ? { defaultId: 0 } : {}),
        signal: requestSignal,
      }), "shutdown").then(result => {
        f.state.pendingId = 0;
        if (cannotCheck) f.state.settleWhy = "fallback-unresponsive";
        originalConsumerSettled = true;
        return result;
      });
    });
    const context = vm.createContext({
      path, dialog, win: target, wc: f.owner.webContents, rig: f.rig,
      realDiscardSend, bareFile: "bare.md", OVERLAY_PROBE_SOURCE: overlayProbeSource,
      navigationLifecycleGeneration: f.state.rendererGeneration + (options.wrongGeneration ? 1 : 0),
      navigationLifecycleReady: true, navigationEditFile: file, navigationEditSetup: setup,
      acceptedNavigationSelection: true, successorTrackingStart: 0, replacementTracking: null,
      fs: { realpathSync: { native: value => value } }, nativePathKey: value => value,
      navigationTrackingWitness: async () => null, console: { log() {} },
      guardEvent: () => ({ prevented: false, preventDefault() { this.prevented = true; } }),
      __shutdown: {
        state: () => ({ ...f.state }),
        readQuestionConsumer(id, signal) {
          consumerReads.push({ id, signal, consumer: originalConsumer });
          return !options.noConsumer && id === f.state.lastRequestId && signal === requestSignal ? originalConsumer : null;
        },
      },
      installMainOwnedShutdownQuestions(target, tails, settings) {
        assert.equal(target, context.win); assert.equal(settings.policy, "ordinary-strict");
        observer = settings.onRecord;
        const push = f.tails.push;
        f.tails.push = function (...work) {
          tails.push(...work);
          return Reflect.apply(push, this, work);
        };
        return f.actor;
      },
      async waitUntil(predicate) {
        if (!originalConsumer) return predicate();
        if (options.actor === "send" && !heldSendObserved && f.actor.records[0]) {
          await f.actor.records[0].presentationReady;
          await turn();
          heldSendObserved = f.rig.dialogs[0] === f.actor.records[0] &&
            !f.actor.records[0].settled && !originalConsumerSettled;
          return predicate();
        }
        await originalConsumer;
        await Promise.allSettled(f.tails);
        const record = f.actor.records[0];
        if (record) {
          if (options.noPresentation) record.presentation = null;
          if (options.noResult) record.result = null;
          if (options.emergency) record.result.emergency = true;
          if (options.failed) record.result.failed = true;
          if (options.notDisplayed) record.result.displayed = false;
          if (options.notChoice) record.result.cause = "cancel";
          if (options.notDelivered) record.choiceDelivered = false;
          if (options.actualEmergencyResult) record.result = options.actualEmergencyResult;
        }
        return predicate();
      },
      check: (name, success) => assertions.push({ name, success }),
    });
    vm.runInContext(extract("replaceMethod") + "\n" + extract("withOrdinaryShutdownCleanup") +
      "\n" + extract("installGenerationShutdownQuestions"), context);
    let error = null;
    try { await vm.runInContext("(async () => {\n" +
      (options.actor === "send" ? nativeSend : options.actor === "probe" ? nativeProbe : native) +
      "\n})()", context); }
    catch (failure) { error = failure; }
    finally {
      f.owner.destroy();
      await Promise.allSettled(f.tails);
      assert.equal(dialog.showMessageBox, originalNative, "Exact native refusal wrapper restored");
      assert.equal(f.OwnedDialogs.prototype.show, f.guard, "Exact guarded themed show restored");
      assert.equal(f.timers.size, 0, "Original provider and driver work left no timer");
    }
    return { error, assertions, f, consumerReads, originalConsumer, heldSendObserved, ownerProbeFaults };
  };
  const good = await run();
  assert.equal(good.error, null, require("node:util").inspect(good.error, { depth: null }));
  check(good.assertions.length === 1 && good.assertions[0].success &&
    good.f.actor.records.length === 1 && good.f.providerCalls.length === 1 &&
    good.consumerReads.length === 1 && good.consumerReads[0].id === 31 &&
    good.consumerReads[0].consumer === good.originalConsumer &&
    good.consumerReads[0].signal === good.f.actor.records[0].options.signal &&
    good.f.actor.records[0].choiceDelivered && good.f.rig.dialogs[0] === good.f.actor.records[0] &&
    good.f.refusals() === 0 && good.f.sends.join(",") === "1",
  "B actor uses actual provider/preload/strict driver presentation and original producer Cancel, then joins its exact Main consumer");
  for (const option of ["noPresentation", "noResult", "emergency", "failed", "notDisplayed", "notChoice",
    "notDelivered", "noConsumer", "wrongReason", "wrongGeneration", "wrongFile", "themedFailure",
    "wrongRequest", "wrongOwner", "wrongButtons", "wrongDefault"]) {
    const bad = await run({ [option]: true });
    check(!bad.assertions.some(assertion => assertion.success) &&
      (bad.error || bad.assertions.length === 1 && !bad.assertions[0].success),
    "B owned-question oracle rejects missing owned evidence or exact original request failure: " + option);
  }
  for (const actor of ["send", "probe"]) {
    const owned = await run({ actor });
    assert.equal(owned.error, null, require("node:util").inspect(owned.error, { depth: null }));
    check(owned.assertions.length === (actor === "send" ? 1 : 2) &&
      owned.assertions.every(assertion => assertion.success) &&
      owned.f.actor.records.length === 1 && owned.f.providerCalls.length === 1 &&
      owned.f.actor.records[0].result.cause === "choice" && owned.f.actor.records[0].result.response === 1 &&
      owned.f.actor.records[0].choiceDelivered &&
      owned.consumerReads[0].consumer === owned.originalConsumer &&
      (actor === "send" ? owned.heldSendObserved
        : owned.ownerProbeFaults === 1 && owned.f.actor.records[0].pageSession === null),
    "Actual " + actor + " failure actor presents its owned cannot-check Cancel and joins original work: " +
      (actor === "send" ? "answer remains held during dispatch-failure witness" : "null page session and owner-only probe fault"));
    for (const option of ["themedFailure", "emergency", "noConsumer"]) {
      const bad = await run({ actor, [option]: true });
      check(bad.error || bad.assertions.length === (actor === "send" ? 1 : 2) &&
        bad.assertions.at(-1).success === false,
      "Actual " + actor + " cannot-check actor rejects unowned emergency or missing Main consumer: " + option);
    }
  }
  const emergency = fixture({ policy: "ordinary-strict" });
  let actualEmergencyResult;
  const legacy = { dialogs: [], closes: 0, quits: 0, pendingId: 31, commitPendingId: 0 };
  try {
    const show = makeMain(emergency, { async showMessageBox(_owner, options) {
      legacy.dialogs.push({ options, response: 1 });
      return { response: 1 };
    } }, { show() { throw new Error("Controlled original themed host failure"); } });
    actualEmergencyResult = await show(emergency.owner, emergency.options(), "shutdown");
    legacy.pendingId = 0;
    check(legacy.dialogs.length === 1 && legacy.dialogs[0].response === 1 &&
      legacy.pendingId === 0 && legacy.commitPendingId === 0 && legacy.closes === 0 && legacy.quits === 0 &&
      actualEmergencyResult.cause === "choice" && actualEmergencyResult.response === 1 &&
      actualEmergencyResult.displayed === true && actualEmergencyResult.emergency === true,
    "Actual Main themed construction failure reaches Electron-stub Cancel and satisfies the old response/pending/zero-close oracle");
  } finally { await emergency.close(); }
  const rejectedEmergency = await run({ actualEmergencyResult });
  check(!rejectedEmergency.error && rejectedEmergency.assertions.length === 1 &&
    rejectedEmergency.assertions[0].success === false,
  "B owned-question oracle rejects the actual Main emergency Cancel result even when the old Cancel oracle would pass");

  const askSource = between(main, "function askShutdownQuestion(", "\nfunction askDiscardApproval(");
  const staleGuard = "      if (pendingShutdown !== record) {\n" +
    "        staleShutdownDialogCompletionCount += 1;\n        return;\n      }";
  assert.equal(askSource.split(staleGuard).length - 1, 2, "Both actual Main result/error identity guards exist");
  const qualifyChoice = between(source, "      if (retainDiscardChoice) {\n        discardQuestions.record.choose(0);",
    "\n      const staleDialogBefore = ");
  const hostBinding = between(source, "      const retainedDiscardHost = discardQuestions.record.request.window;",
    "\n      const oldDiscardState = ");
  const collisionOracle = between(source, "      const staleOldDiscardObserved = await waitUntil(",
    "\n      // The next document is still allowed to complete an ordinary clean close.");
  const collision = async (retainChoice, options = {}) => {
    let observer, question, retainedHost;
    let collisionFixture = fixture;
    if (options.suppressBrokerDestroy) {
      assert.equal(retainChoice, false, "Only the unanswered abort counter suppresses destruction");
      const destroyStatement = "    if (request.window && !request.window.isDestroyed()) request.window.destroy();";
      assert.equal(dependencies.providerSource.split(destroyStatement).length, 2,
        "Exactly the actual broker finish destruction statement is suppressed");
      const counterDependencies = { ...dependencies, providerSource:
        dependencies.providerSource.replace(destroyStatement, "    // Controlled missing broker destruction.") };
      collisionFixture = vm.compileFunction(fixtureText + "\nreturn fixture;",
        Object.keys(counterDependencies))(...Object.values(counterDependencies));
    }
    const f = collisionFixture({ policy: retainChoice ? "ordinary-strict" : "cancellable",
      onRecord: record => observer(record) });
    f.state.pendingId = 0; f.state.lastRequestId = 30;
    const nativeOriginal = async () => { throw new Error("Unclaimed collision-native call"); };
    const dialog = { showMessageBox: nativeOriginal };
    const settlements = [], transitions = [], assertions = [], consumerReads = [];
    const old = { id: 31, gen: f.state.rendererGeneration, reason: "window-close", asked: false };
    const replacement = { id: 32, gen: old.gen + 1, reason: "window-close" };
    const file = "C:\\fixture\\f22-discard-navigation.md", seed = "CLEAN PHYSICAL SEED";
    const mainContext = vm.createContext({
      pendingShutdown: null, staleShutdownDialogCompletionCount: 0,
      deletionEvidenceCapacityLatched: false, shutdownQuestionConsumers: new Map(),
      AbortController, setInterval, clearInterval, console: { error() {} },
      mainDialogs: () => f.broker, shutdownOwnerWindow: () => f.owner, dialog,
      ownerRendererAvailable: sender => !!sender && !sender.isDestroyed(),
      settleWithoutWindow() { throw new Error("Controlled owner must stay alive"); },
      settleShutdown(record, approved) {
        settlements.push({ record, approved });
        if (mainContext.pendingShutdown === record) mainContext.pendingShutdown = null;
      },
      log() {},
    });
    for (const [field, stateField] of Object.entries({
      approvalRendererGeneration: "rendererGeneration",
      approvalRendererPageSession: "rendererPageSession",
    })) Object.defineProperty(mainContext, field, { get: () => f.state[stateField] });
    mainContext.approvalRendererState = "ready";
    vm.runInContext(showOwned + "\n" +
      (options.noStaleGuard ? askSource.replace(staleGuard, "") : askSource), mainContext);
    const state = () => ({ ...f.state, pendingId: mainContext.pendingShutdown?.id || 0,
      pendingReason: mainContext.pendingShutdown?.reason || null,
      staleShutdownDialogCompletionCount: mainContext.staleShutdownDialogCompletionCount });
    const shutdown = {
      state,
      readQuestionConsumer(id, signal) {
        const found = mainContext.shutdownQuestionConsumers.get(signal);
        consumerReads.push(found);
        return found?.requestId === id ? found.consumer : null;
      },
      reset() {
        transitions.push("retire-old-request");
        mainContext.pendingShutdown = null;
        old.dialogAbortController?.abort();
        f.state.pendingId = 0;
      },
    };
    const context = vm.createContext({
      path, dialog, OwnedDialogs: f.OwnedDialogs, __shutdown: shutdown,
      installMainOwnedShutdownQuestions(owner, tails, settings) {
        assert.equal(owner, f.owner);
        assert.equal(settings.policy, retainChoice ? "ordinary-strict" : "cancellable");
        observer = settings.onRecord;
        const push = f.tails.push;
        f.tails.push = function (...work) {
          tails.push(...work);
          return Reflect.apply(push, this, work);
        };
        return f.actor;
      },
    });
    vm.runInContext(extract("replaceMethod") + "\n" + extract("installGenerationDiscardQuestion"), context);
    try {
      question = context.installGenerationDiscardQuestion(f.owner, f.rig, file, retainChoice);
      mainContext.pendingShutdown = old; f.state.pendingId = old.id; f.state.lastRequestId = old.id;
      mainContext.askShutdownQuestion(old, { confirmLabel: "Discard changes", title: "Unsaved changes",
        message: '"' + path.basename(file) + '" has unsaved changes.', detail: "", why: "dirty" });
      await question.record.presentationReady;
      await question.record.observerWork;
      if (options.destroyBeforeCapture) question.record.request.window.destroy();
      const oldState = state();
      const actorContext = vm.createContext({
        retainDiscardChoice: retainChoice, discardQuestions: question, rig: { closes: 0, quits: 0 },
        __shutdown: shutdown, oldDiscardState: oldState, console: { log() {} },
        check: (name, success) => assertions.push({ name, success }),
      });
      vm.runInContext(hostBinding, actorContext);
      retainedHost = vm.runInContext("retainedDiscardHost", actorContext);
      assert.equal(retainedHost, question.record.request.window, "Native capture retains the actual broker child");
      assert.equal(retainedHost.isDestroyed(), false, "Actual captured dialog host is live before choice/navigation");
      if (retainChoice) {
        if (options.abortedChoice) old.dialogAbortController.abort();
        await vm.runInContext("(async () => {\n" +
          (options.abortedChoice ? qualifyChoice.replace("discardQuestions.record.choose(0);",
            "/* The actual original producer was aborted before any choice. */").replace(
            "await discardQuestions.joinChoice();",
            "await discardQuestions.producer; /* Probe the oracle as well as the strict-driver rejection. */") : qualifyChoice) +
          "\n})()", actorContext);
        assert.equal(mainContext.pendingShutdown, old);
        assert.equal(settlements.length, 0, "Held actual delivery cannot settle the original Main request");
        assert.equal(question.savedResult, question.record.result);
        assert.equal(question.producer, question.record.producer);
        assert.throws(() => question.release(), /still-current Main request/);
        if (options.preNavigationFailure) {
          await question.cleanup[0]();
          await question.delivery;
          await question.originalConsumer;
          return { preNavigationRetired: transitions.join(",") === "retire-old-request" &&
            mainContext.pendingShutdown === null && settlements.length === 0, assertions };
        }
      }
      const staleBefore = mainContext.staleShutdownDialogCompletionCount;
      mainContext.pendingShutdown = replacement;
      f.state.pendingId = replacement.id;
      f.state.rendererGeneration = replacement.gen;
      f.state.rendererPageSession = "replacement-page";
      old.dialogAbortController?.abort();
      f.owner.webContents.emit("did-navigate");
      if (retainChoice) question.release();
      await question.join();
      Object.assign(actorContext, {
        staleDialogBefore: staleBefore,
        oldDiscardFixture: { cached: seed, live: seed + "\nDIRTY", dirtyFlag: false },
        discardSeed: seed, oldDiscardAsked: true, dirtyDiscardClose: { prevented: true },
        oldDiscardRevision: 17, replacementRequestHeld: true,
        heldReplacementRequest: { id: replacement.id, gen: replacement.gen },
        replacementDiscardState: state(),
        replacementCollision: { filePath: file, identity: { tabId: 7 }, tabId: 7, revision: 17, target: 17 },
        discardNavigationFile: file,
        freezeAfterNavigation: { frozen: false, editorReadOnly: false, wrapperInert: false },
        emittedDiscardRequests: [], waitUntil: async predicate => predicate(),
      });
      await vm.runInContext("(async () => {\n" + collisionOracle + "\n})()", actorContext);
      const legacyAssertions = [];
      if (options.suppressBrokerDestroy) {
        const originalCheck = actorContext.check;
        actorContext.check = (name, success) => legacyAssertions.push({ name, success });
        try {
          await vm.runInContext("(async () => {\n" + collisionOracle.replace(
            "              retainedDiscardHost.isDestroyed() &&\n", "") + "\n})()", actorContext);
        } finally { actorContext.check = originalCheck; }
      }
      return { assertions, question, settlements, staleBefore,
        staleAfter: mainContext.staleShutdownDialogCompletionCount,
        pending: mainContext.pendingShutdown, replacement, consumerReads, f, retainedHost,
        hostAliveAtOracle: !retainedHost.isDestroyed(), legacyAssertions };
    } finally {
      if (question) {
        const outcomes = [];
        for (const cleanup of question.cleanup) {
          try { await cleanup(); } catch (error) { outcomes.push(error); }
        }
        if (options.abortedChoice) {
          assert.equal(outcomes.length, 1);
          assert.ok(require("node:util").inspect(outcomes, { depth: null }).includes(
            "Ordinary owned question did not return its genuine chosen result"));
        } else assert.equal(outcomes.length, 0, require("node:util").inspect(outcomes, { depth: null }));
      }
      if (retainedHost && !retainedHost.isDestroyed()) retainedHost.destroy();
      f.owner.destroy();
      await Promise.allSettled(f.tails);
      assert.equal(dialog.showMessageBox, nativeOriginal);
      assert.equal(f.OwnedDialogs.prototype.show, f.guard);
      assert.equal(f.timers.size, 0);
    }
  };
  for (const retained of [false, true]) {
    const result = await collision(retained);
    check(result.assertions.every(assertion => assertion.success) &&
      result.staleAfter === result.staleBefore + 1 && result.pending === result.replacement &&
      result.settlements.length === 0 && result.f.providerCalls.length === 1 &&
      result.consumerReads.length === 1 &&
      result.consumerReads[0].consumer === result.question.originalConsumer &&
      result.retainedHost === result.question.record.request.window && !result.hostAliveAtOracle &&
      (retained ? result.question.savedResult.cause === "choice" && result.question.savedResult.response === 0
        : ["aborted", "stale"].includes(result.question.record.result.cause) &&
          result.question.record.result.response === 1),
    "Actual Main stale guard preserves colliding replacement against " +
      (retained ? "unchanged genuinely chosen Discard result with held original delivery" : "actual unanswered owned-host abort"));
    const unguarded = await collision(retained, { noStaleGuard: true });
    check(unguarded.assertions.at(-2).success === true && unguarded.assertions.at(-1).success === false &&
      unguarded.staleAfter === unguarded.staleBefore,
    "Removing actual Main result identity guard fails only the stale-count/replacement oracle for " +
      (retained ? "genuine late success" : "real abort"));
  }
  const leakedAbortHost = await collision(false, { suppressBrokerDestroy: true });
  check(leakedAbortHost.assertions.at(-2).success === true &&
    leakedAbortHost.assertions.at(-1).success === false && leakedAbortHost.hostAliveAtOracle &&
    leakedAbortHost.legacyAssertions.length === 2 &&
    leakedAbortHost.legacyAssertions.every(assertion => assertion.success) &&
    leakedAbortHost.staleAfter === leakedAbortHost.staleBefore + 1 &&
    leakedAbortHost.pending === leakedAbortHost.replacement && leakedAbortHost.settlements.length === 0 &&
    leakedAbortHost.question.record.result.failed === false &&
    ["aborted", "stale"].includes(leakedAbortHost.question.record.result.cause) &&
    leakedAbortHost.question.record.retired === true &&
    leakedAbortHost.retainedHost.isDestroyed() === true,
  "Suppressing only actual broker destruction preserves abort/producer/consumer/stale/replacement conditions but fails the captured-host oracle before later cleanup destroys it");
  await assert.rejects(collision(false, { destroyBeforeCapture: true }),
    /Generation collision did not retain its live original dialog host/);
  check(true, "The actual pre-navigation host capture refuses an already-destroyed original child instead of crediting a retired record");
  await assert.rejects(collision(true, { abortedChoice: true }),
    /Retained Discard setup did not produce its genuine successful choice/);
  check(true, "Actual broker aborted Cancel cannot qualify as a genuine retained Discard approval");
  const retiredFailure = await collision(true, { preNavigationFailure: true });
  check(retiredFailure.preNavigationRetired,
    "Pre-navigation failure retires the old Main request before releasing unchanged genuine Discard and never delivers approval to it");
}

(async () => {
  let failures = 0;
  for (const run of [sourceContracts, backgroundSaveVersionContracts, installedLauncherDiagnosticContracts,
    consentContracts, requestContracts,
    subscriptionContracts, sameTaskContracts, deliveryContracts,
    liveEditorContract, liveConsentContract, switchPermissionContracts, questionObserverContracts,
    inputMenuContracts, defaultFixtureCallerContracts, defaultFixtureOwnerContracts,
    defaultFixtureDiagnosticsContracts, discardHistoryContracts, reloadPreviewContracts,
    lazyNativeBoundaryContracts, ordinarySuffixBoundaryContracts, replacementNativeBoundaryContracts,
    reloadRecoveryBoundaryContracts, shutdownAggregateDiagnosticContracts,
    popupCaptureDiagnosticContracts, reloadJourneyBoundaryContracts, shutdownRestoreOrderingContracts,
    ackContinuationDiagnosticContracts, terminalAggregateDiagnosticContracts, shutdownAdmissionDiagnosticContracts,
    installedQuestionSnapshotContracts, generationFinalizerContracts,
    generationNavigationSetupContracts, generationOwnedQuestionContracts]) {
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
