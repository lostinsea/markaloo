"use strict";

// Actual pair helpers, with controlled Main/page/DOM/close ports.
// No native question, filesystem deletion, watcher, ACK or retirement runs.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "test-tab-refresh.js"), "utf8")
  .replace(/\r\n/g, "\n");
const between = (start, end) => {
  const first = source.indexOf(start);
  assert.notEqual(first, -1, "Missing source: " + start);
  assert.equal(source.indexOf(start, first + start.length), -1, "Ambiguous source: " + start);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(last, -1, "Missing source end: " + end);
  return source.slice(first, last);
};
const authored = between("  const backgroundPairFields = [",
  '  const backgroundFile = path.join(dir, "f22-reload-background.md");');
const nativeObserverSource = between("function observeNativeDocumentPorts(",
  "async function runIsolatedOrdinaryMetadataControls(");
const clone = value => JSON.parse(JSON.stringify(value));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 2 && args[0] === "--negative",
  "Use no arguments or --negative owner|selection|footer");
let helpers = authored;
if (args.length) {
  const lateStart = "          if (!Object.keys(nodes).every(name => document.getElementById({";
  const lateEnd = '            throw new Error("F22 pair deletion question changed before its exact answer");';
  const mutations = {
    owner: ["!sameOwner(owner)", "false"],
    selection: ["selected !== expectedSelectedId", "false"],
    footer: [authored.slice(authored.indexOf(lateStart), authored.indexOf(lateEnd)),
      "          if (false) {\n"],
  };
  assert.ok(Object.hasOwn(mutations, args[1]), "Unknown negative control");
  const [before, after] = mutations[args[1]];
  assert.ok(before.length > 10);
  assert.equal(helpers.split(before).length, 2, "One exact mutation anchor");
  helpers = helpers.replace(before, after);
  console.log(`NEGATIVE CONTROL ${args[1]}: only extracted pair helper code changed`);
}
const identity = id => ({ pageSession: "pair-page", rendererGeneration: 3,
  tabId: id, documentGeneration: 7, pathKey: "path-" + id, documentRef: "doc-" + id });
function fixture(inactive = false) {
  const targetTab = { id: 11, filePath: path.join(path.sep, "fixture", "deleted.md"),
    content: "TARGET_NO_LF", originalContent: "TARGET_NO_LF", hasUnsavedChanges: false };
  const companion = { id: 12, filePath: path.join(path.sep, "fixture", "companion.md"),
    content: "COMPANION_NO_LF", originalContent: "COMPANION_NO_LF", hasUnsavedChanges: false };
  const target = { tabId: 11, filePath: targetTab.filePath, content: targetTab.content,
    owner: identity(11), descriptor: { ref: "doc-11" } };
  const state = { maintained: true, dirty: false, mutationRevision: 4,
    reloadConflict: false, deletionTombstone: { revision: 8 } };
  const page = { tabs: inactive ? [targetTab, companion] : [targetTab],
    selected: inactive ? 12 : 11, owner: identity(11), mode: false, frozen: false,
    pending: 0, deletion: { known: true, unresolved: true, revision: 8 },
    admitted: true, owners: [identity(11)], fileExists: false };
  const behavior = { unknownTarget: false, lateFooter: false, replaceNode: false,
    rejectClose: false, secondQuestion: false, mutateCompanion: false,
    leaveOwner: false, leaveAdmission: false };
  const counts = { close: 0, click: 0, deletionReads: 0, failures: [] };
  const observers = [];
  const dialog = { open: false, contains: () => true };
  const footer = { children: [], querySelectorAll: () => footer.children.filter(node => node.button) };
  const title = { textContent: "Close this copy?" };
  const name = { textContent: "deleted.md" };
  const message = { textContent: "This tab may be the only remaining copy of the file. Close the tab?" };
  const nodes = { appMessageDialog: dialog, appMessageTitle: title, appMessageName: name,
    appMessageText: message, appMessageButtons: footer };
  let resolveClose;
  const selectedTab = () => page.tabs.find(tab => tab.id === page.selected);
  const window = {
    currentFilePath: selectedTab().filePath, originalMarkdown: selectedTab().content,
    getReloadRequestSession: () => "pair-page",
    getPendingSaveStatus: () => ({ count: page.pending, pending: page.pending !== 0 }),
    folia: {
      getVersion: () => "controlled",
      queryDocumentDeletionState: () => {
        counts.deletionReads++;
        if (behavior.lateFooter && counts.deletionReads === 3) {
          footer.children.push({ button: true, dataset: { dialogChoice: "extra" },
            textContent: "Extra action", disabled: false, parentElement: footer });
        }
        return clone(page.deletion);
      },
    },
    CustomTabs: {
      getTabs: () => page.tabs,
      getActiveTab: selectedTab,
      getActiveTabId: () => page.selected,
      getDocumentIdentityForTab: id => id === 11 ? clone(page.owner) : identity(id),
      getDocumentDescriptor: id => ({ ref: "doc-" + id,
        logicalPath: page.tabs.find(tab => tab.id === id)?.filePath,
        readTarget: page.tabs.find(tab => tab.id === id)?.filePath }),
      __documentState: tab => tab.id === 11 ? clone(state) :
        { maintained: true, dirty: false, mutationRevision: 2 },
      __inEditMode: () => page.mode,
      __shutdownFreeze: () => ({ frozen: page.frozen, dialogDecisionIntent: counts.close }),
      closeTab: () => {
        counts.close++;
        if (behavior.rejectClose) return Promise.reject(new Error("controlled original close rejected"));
        dialog.open = true;
        for (const observer of observers) observer.records.push({ target: dialog, oldValue: null });
        if (behavior.replaceNode) nodes.appMessageTitle = { textContent: "Foreign title" };
        return new Promise(resolve => { resolveClose = resolve; });
      },
    },
  };
  const cancel = { button: true, dataset: { dialogChoice: "cancel" }, textContent: "Cancel",
    disabled: false, parentElement: footer, click: () => { throw new Error("Cancel was not authorized"); } };
  const proceed = { button: true, dataset: { dialogChoice: "proceed" }, textContent: "Close tab",
    disabled: false, parentElement: footer, click: () => {
      counts.click++;
      page.tabs = page.tabs.filter(tab => tab.id !== 11);
      if (page.selected === 11) {
        page.selected = null; window.currentFilePath = null; window.originalMarkdown = "";
      }
      if (behavior.mutateCompanion) companion.content = "UNEXPECTED_COMPANION_CHANGE";
      if (!behavior.leaveOwner) page.owners = [];
      page.admitted = behavior.leaveAdmission;
      dialog.open = behavior.secondQuestion;
      if (behavior.secondQuestion) {
        for (const observer of observers) observer.records.push({ target: dialog, oldValue: null });
      }
      resolveClose();
    } };
  footer.children.push(cancel, proceed);
  class Observer {
    constructor() { this.records = []; observers.push(this); }
    observe() {}
    takeRecords() { return this.records.splice(0); }
    disconnect() {}
  }
  const context = vm.createContext({ window,
    document: { documentElement: {}, getElementById: id => nodes[id] || null },
    MutationObserver: Observer, setTimeout: fn => setTimeout(fn, 0) });
  const main = { renderer: "ready", pendingId: 0, rendererPageSession: "pair-page",
    rendererGeneration: 3 };
  const scope = {
    target, fs: { existsSync: () => page.fileExists }, require, path,
    win: { webContents: {} }, ipcMain: new EventEmitter(),
    __shutdown: {
      state: () => main,
      documentAdmissionIsCurrent: ref => ref === "doc-11" && page.admitted,
      documentSessionState: () => ({ owners: page.owners }),
    },
    check: (name, okay, detail) => { if (!okay) counts.failures.push({ name, detail }); },
    exec: code => Promise.resolve(vm.runInContext(code, context, { timeout: 1000 })),
  };
  const host = vm.createContext(scope);
  vm.runInContext(nativeObserverSource + "\n" + helpers + "\n" +
    (inactive ? "backgroundFailureDeletedOwner = target; backgroundFailureCompanionId = 12;" :
      "backgroundDeletedOwner = target;"), host);
  const run = () => vm.runInContext("closeBackgroundPairDeletedOwner(" +
    (behavior.unknownTarget ? "JSON.parse(JSON.stringify(target))" : "target") + ")", host);
  const capture = expected => {
    scope.expectedCapture = expected;
    return vm.runInContext(
      "captureBackgroundPairOwner({id:11},target.filePath,target.content,expectedCapture)", host);
  };
  const dispose = () => { if (resolveClose) resolveClose(); };
  const adopt = (prior, packet, records) => {
    Object.assign(scope, { adoptionPrior: prior, adoptionPacket: packet, adoptionRecords: records });
    return vm.runInContext(
      "backgroundPairAdoptedTarget(adoptionPrior,adoptionPacket,adoptionRecords)", host);
  };
  const observe = () => vm.runInContext("observeBackgroundPairAdoption(target.filePath)", host);
  return { target, targetTab, companion, state, page, behavior, counts, window,
    main, footer, proceed, title, name, message, nodes, run, capture, dispose,
    adopt, observe, scope };
}
async function adoptionFixture() {
  const f = fixture();
  f.page.deletion.unresolved = false;
  f.state.deletionTombstone = null;
  const prior = await f.capture();
  const next = { ...clone(prior.owner), documentGeneration: 8 };
  const version = { dev: 1, ino: 2, size: 23, mtimeMs: 120, ctimeMs: 121 };
  const content = "F22_BACKGROUND_ACCEPTED";
  const digest = crypto.createHash("sha256").update(content).digest("hex");
  const packet = { success: true, path: prior.filePath, content,
    modifiedTime: 120, diskVersion: clone(version),
    reloadRequest: { ...clone(prior.owner), session: prior.owner.pageSession,
      path: prior.filePath, sequence: 3 } };
  const records = [{
    channel: "commit-document-disk-adoption", replies: 1,
    data: { filePath: prior.filePath, ownerFilePath: prior.filePath,
      pageSession: next.pageSession, rendererGeneration: next.rendererGeneration,
      oldOwner: clone(prior.owner), proposedOwner: clone(next),
      capability: "actual-capability", modifiedTime: 120,
      diskVersion: clone(version), contentDigest: digest },
    reply: { accepted: true, capability: "actual-capability",
      pathKey: next.pathKey, tabId: next.tabId,
      documentGeneration: next.documentGeneration, version: clone(version),
      contentDigest: digest, revision: 4 },
  }, {
    channel: "complete-document-disk-adoption", replies: 1,
    data: { filePath: prior.filePath, ownerFilePath: prior.filePath,
      pageSession: next.pageSession, rendererGeneration: next.rendererGeneration,
      actualOwner: clone(next), capability: "actual-capability", revision: 4 },
    reply: { completed: true, capability: "actual-capability", unresolvedEvidence: false },
    mainOwners: [clone(next)], admissionCurrent: true,
  }, ...[1, 2].map(() => ({
    channel: "check-owned-tab-disk-snapshot", replies: 1,
    data: { filePath: prior.filePath, sourcePath: prior.filePath,
      owner: clone(next), diskVersion: clone(version) },
    reply: { matches: true, pathKey: next.pathKey, diskVersion: clone(version) },
  }))];
  return { ...f, prior, next, packet, records };
}
const cases = [];
const test = (name, run) => cases.push([name, run]);
test("full current actor parses and both raw companion admissions are gone", () => {
  new vm.Script(source);
  assert.ok(!source.includes('window.CustomTabs.createTab(${JSON.stringify(backgroundFile)}'));
  assert.ok(!source.includes('window.CustomTabs.createTab(${JSON.stringify(backgroundFailureBFile)}'));
});
test("accepted companion admission precedes every held result and keeps original no-LF bytes", () => {
  const actor = between('  const reloadForegroundFile =',
    "    async function closeDeletedReloadOrigin(");
  const admission = source.indexOf("  const backgroundTab = await createCompanionTab(");
  assert.ok(actor.indexOf("  const backgroundTab = await createCompanionTab(") <
    actor.indexOf('if (channel === "file-reload-result")'));
  assert.ok(admission > -1);
  assert.ok(source.includes('await seedSettledFixture(backgroundFile, "F22_BACKGROUND_BASE");'));
  assert.ok(source.includes('await captureBackgroundPairOwner(reloadForegroundTab, reloadForegroundFile, "F22_RELOAD_FOREGROUND_BASE");'));
  assert.ok(source.includes('const backgroundCompanionOwner = await captureBackgroundPairOwner(backgroundTab, backgroundFile, "F22_BACKGROUND_BASE");'));
});
test("legacy deleted driver remains byte-exact outside this two-owner slice", () => {
  const legacy = between("    async function closeDeletedReloadOrigin(",
    "    // A path is not a tab generation.");
  assert.equal(crypto.createHash("sha256").update(legacy).digest("hex"),
    "0ebd35be05b86b9dfd1d3f098837df76d2a488801001934135daf1c8e7cd1106");
});
test("failure admission restores A before unlink without consuming held replies", () => {
  const actor = between('    const backgroundFailureAFile =',
    "    // No path-only fallback is allowed after the origin has closed.");
  assert.ok(actor.indexOf("const backgroundFailureRestored") <
    actor.indexOf("fs.unlinkSync(backgroundFailureAFile)"));
  assert.ok(actor.includes("heldReloadResults.length !== backgroundFailureSetupHeldCount"));
  assert.ok(actor.includes('await seedSettledFixture(backgroundFailureAFile, "F22_BACKGROUND_FAILURE_A")'));
  assert.ok(actor.includes('await seedSettledFixture(backgroundFailureBFile, "F22_BACKGROUND_FAILURE_B")'));
  assert.ok(!actor.includes("expectedDiscards"));
});
test("actual B selection is joined before original success/failure packets are forwarded", () => {
  const success = source.indexOf("await switchAndWitness(backgroundTab.id, backgroundFile, null);");
  assert.ok(success < source.indexOf('if (heldReloadResults[2]) realReloadSend.call'));
  const failure = source.indexOf("const backgroundFailureSelected = await switchAndWitness(");
  assert.ok(failure < source.indexOf('if (backgroundFailure) realReloadSend.call'));
  assert.ok(authored.includes("evidence.done = tabs.closeTab(target.tabId);"));
  assert.ok(authored.includes("await evidence.done;"));
  assert.ok(!/switchToTab|switchAndWitness|window\.confirm|MarkalooDialogs\.show/.test(authored));
});
test("retirement order is clean A then deleted active B; deleted inactive A then clean B", () => {
  assert.ok(source.indexOf('exec, "F22 accepted background foreground retirement"') <
    source.indexOf("await closeBackgroundPairDeletedOwner(backgroundDeletedOwner);"));
  assert.ok(source.indexOf("await closeBackgroundPairDeletedOwner(backgroundFailureDeletedOwner);") <
    source.indexOf('exec, "F22 background failure companion retirement"'));
  assert.ok(!authored.includes("expectedDiscards"));
});
test("fresh capture proves exact ordinary clean no-LF bytes and current Main admission", async () => {
  const f = fixture();
  f.page.deletion.unresolved = false;
  f.state.deletionTombstone = null;
  const result = await f.capture();
  assert.equal(result.content, "TARGET_NO_LF");
  assert.deepEqual(clone(result.owner), identity(11));
  assert.equal(result.disposition, "clean");
  assert.equal(result.path, f.targetTab.filePath);
  assert.equal(result.liveContent, "TARGET_NO_LF");
  assert.equal(result.cacheContent, "TARGET_NO_LF");
  assert.equal(result.savedContent, "TARGET_NO_LF");
});
test("failure B retains its setup target through the genuine pre-delivery selection", () => {
  const actor = between('    const backgroundFailureAFile =',
    "    // No path-only fallback is allowed after the origin has closed.");
  assert.ok(actor.includes("const backgroundFailureCleanOwner = await captureBackgroundPairOwner("));
  assert.ok(actor.includes("backgroundFailureSelected[field] === backgroundFailureCleanOwner.owner[field]"));
  const validation = actor.indexOf('backgroundFailureB, backgroundFailureBFile, "F22_BACKGROUND_FAILURE_B",\n      backgroundFailureCleanOwner,');
  assert.ok(validation > actor.indexOf("const backgroundFailureSelected"));
  assert.ok(validation < actor.indexOf("if (backgroundFailure) realReloadSend.call"));
  assert.ok(actor.includes("expectedTargets: [backgroundFailureCleanOwner]"));
});
test("pre-delivery capture rejects a new current owner instead of replacing its earlier target", async () => {
  const f = fixture();
  f.page.deletion.unresolved = false;
  f.state.deletionTombstone = null;
  const expected = await f.capture();
  f.page.owner.documentGeneration++;
  f.page.owners = [clone(f.page.owner)];
  assert.equal((await f.capture()).owner.documentGeneration, 8,
    "The replacement has fresh Main custody and passes an unbound capture");
  await assert.rejects(f.capture(expected), /earlier clean owner/);
  assert.equal(expected.owner.documentGeneration, 7);
  assert.equal(f.counts.close, 0);
});
test("accepted A binds the actual proposed/completed Main owner and retained descriptor", async () => {
  const f = await adoptionFixture();
  const target = f.adopt(f.prior, f.packet, f.records);
  assert.deepEqual(clone(target.owner), f.next);
  assert.deepEqual(clone(target.descriptor), clone(f.prior.descriptor));
  assert.equal(target.disposition, "clean");
  assert.equal(target.liveContent, "F22_BACKGROUND_ACCEPTED");
  assert.equal(target.cacheContent, target.liveContent);
  assert.equal(target.savedContent, target.liveContent);
});
test("accepted A refuses missing stale foreign or failed original adoption witnesses", async () => {
  for (const change of [
    f => { f.packet.reloadRequest.documentGeneration++; },
    f => { f.records[0].data.oldOwner.documentRef = "FOREIGN"; },
    f => { f.records[0].reply.accepted = false; },
    f => { f.records[0].reply.contentDigest = "OTHER"; },
    f => { f.records[0].data.diskVersion.mtimeMs++; },
    f => { f.records[0].reply.tabId++; },
    f => { f.records[1].data.capability = "OTHER"; },
    f => { f.records[1].data.actualOwner.documentGeneration++; },
    f => { f.records[1].mainOwners = []; },
    f => { f.records[1].admissionCurrent = false; },
    f => { f.records[1].reply.unresolvedEvidence = true; },
    f => { f.records[2].reply.matches = false; },
    f => { f.records[2].data.owner.documentRef = "FOREIGN"; },
    f => { f.records[2].data.sourcePath = "FOREIGN.md"; },
    f => { f.records.pop(); },
    f => { f.records.push(clone(f.records[0])); },
    f => { f.records.reverse(); },
  ]) {
    const f = await adoptionFixture();
    assert.equal(f.adopt(f.prior, f.packet, f.records).owner.documentGeneration, 8);
    change(f);
    assert.throws(() => f.adopt(f.prior, f.packet, f.records), /original adoption owner/);
    assert.equal(f.counts.close, 0);
  }
});
test("existing observer snapshots Main ownership only after the original completion reply", async () => {
  const f = await adoptionFixture();
  const originals = new Map();
  for (const channel of ["commit-document-disk-adoption", "complete-document-disk-adoption",
    "check-owned-tab-disk-snapshot"]) {
    const original = (event, data) => {
      if (channel === "complete-document-disk-adoption") {
        f.page.owners = [clone(data.actualOwner)];
        event.returnValue = f.records[1].reply;
      }
    };
    originals.set(channel, original);
    f.scope.ipcMain.on(channel, original);
  }
  const observer = f.observe();
  try {
    const event = { sender: f.scope.win.webContents };
    f.scope.ipcMain.emit("complete-document-disk-adoption", event, f.records[1].data);
    assert.equal(observer.records.length, 1);
    assert.equal(event.returnValue, f.records[1].reply);
    assert.equal(observer.records[0].replies, 1);
    assert.equal(observer.records[0].mainOwners[0].documentGeneration, 8);
    f.page.owners[0].documentGeneration = 99;
    assert.equal(observer.records[0].mainOwners[0].documentGeneration, 8);
  } finally { observer.restore(); }
  for (const [channel, original] of originals) {
    assert.deepEqual(f.scope.ipcMain.listeners(channel), [original]);
  }
});
test("accepted A target is authenticated before B unlink and passed unchanged to clean retirement", () => {
  const actor = between('    const foregroundBeforeBackground =',
    "    async function closeDeletedReloadOrigin(");
  assert.ok(actor.indexOf("const foregroundBeforeBackground") <
    actor.indexOf('fs.writeFileSync(reloadForegroundFile, "F22_BACKGROUND_ACCEPTED"'));
  assert.ok(actor.indexOf("observeBackgroundPairAdoption(reloadForegroundFile)") <
    actor.indexOf('if (heldReloadResults[2]) realReloadSend.call'));
  assert.ok(actor.indexOf("backgroundPairAdoptedTarget(") <
    actor.indexOf("fs.unlinkSync(backgroundFile)"));
  assert.ok(actor.includes("accepted.sequence !== heldReloadResults[2].reloadRequest.sequence"));
  assert.ok(actor.includes("finally { backgroundAdoption.restore(); }"));
  assert.ok(actor.includes("expectedTargets: [foregroundCleanOwner]"));
});
for (const inactive of [false, true]) test(inactive
  ? "deleted inactive A closes without selecting it or mutating active B"
  : "deleted active B uses one real-schema proceed and original close", async () => {
  const f = fixture(inactive);
  const before = clone(f.companion);
  const result = await f.run();
  assert.equal(result.gone, true);
  assert.equal(f.counts.close, 1);
  assert.equal(f.counts.click, 1);
  assert.equal(result.presentations, 1);
  assert.deepEqual(f.companion, before);
  assert.equal(f.page.selected, inactive ? 12 : null);
});
const refusal = (name, change, { inactive = false, beforeClose = false } = {}) =>
  test(name, async () => {
    const f = fixture(inactive);
    try {
      change(f);
      await assert.rejects(f.run(), /F22 pair/);
      assert.equal(f.counts.click, 0, "Refusal never answers a question");
      if (beforeClose) assert.equal(f.counts.close, 0);
    } finally { f.dispose(); }
  });
refusal("a cloned target gains no two-owner authority", f => { f.behavior.unknownTarget = true; }, { beforeClose: true });
refusal("recreated file refuses deleted-copy consent", f => { f.page.fileExists = true; }, { beforeClose: true });
refusal("pending Main shutdown refuses", f => { f.main.pendingId = 4; }, { beforeClose: true });
refusal("stale Main renderer generation refuses", f => { f.main.rendererGeneration++; }, { beforeClose: true });
refusal("lost current admission refuses", f => { f.page.admitted = false; }, { beforeClose: true });
refusal("wrong current renderer owner refuses", f => { f.page.owner.documentGeneration++; }, { beforeClose: true });
refusal("dirty target gets no deleted-copy approval", f => { f.state.dirty = true; }, { beforeClose: true });
refusal("cache/live mismatch gets no close approval", f => { f.window.originalMarkdown += "\n"; }, { beforeClose: true });
refusal("pending target save refuses", f => { f.page.pending = 1; }, { beforeClose: true });
refusal("unknown deletion authority refuses", f => { f.page.deletion.known = false; }, { beforeClose: true });
refusal("ordinary owner cannot use deleted-copy consent", f => { f.page.deletion.unresolved = false; }, { beforeClose: true });
refusal("missing revision cannot masquerade as stable deletion", f => { delete f.page.deletion.revision; }, { beforeClose: true });
refusal("wrong inactive-pair foreground is refused", f => {
  const foreign = { ...f.companion, id: 13 };
  f.page.tabs.push(foreign); f.page.selected = 13;
}, { inactive: true, beforeClose: true });
refusal("foreign open question is untouched", f => { f.nodes.appMessageDialog.open = true; }, { beforeClose: true });
refusal("dirty wording is not approved", f => { f.title.textContent = "Close without saving?"; });
refusal("foreign filename is not approved", f => { f.name.textContent = "foreign.md"; });
refusal("changed question message is not approved", f => { f.message.textContent += " Changed"; });
refusal("disabled proceed is not approved", f => { f.proceed.disabled = true; });
refusal("extra footer action is not ignored", f => { f.footer.children.push({ button: true }); });
refusal("replaced dialog node is not approved", f => { f.behavior.replaceNode = true; });
refusal("late footer action is revalidated immediately before click", f => { f.behavior.lateFooter = true; });
test("original close rejection remains a failed owned attempt", async () => {
  const f = fixture();
  f.behavior.rejectClose = true;
  await assert.rejects(f.run(), /F22 pair/);
  assert.equal(f.counts.click, 0);
  assert.equal(f.counts.failures.length, 1);
  const evidence = JSON.parse(f.counts.failures[0].detail).evidence;
  assert.equal(evidence.originalJoined, true);
  assert.match(evidence.originalJoinError, /controlled original close rejected/);
});
test("unexpected question retains its unfinished original close and denies safe reset", async () => {
  const f = fixture();
  try {
    f.title.textContent = "Close without saving?";
    await assert.rejects(f.run(), error =>
      /F22 pair/.test(error.message) && error.errors.some(failure =>
        /original close remains unfinished; no safe reset/.test(failure.message)));
    assert.equal(f.counts.close, 1);
    assert.equal(f.counts.click, 0);
    const record = f.window.__f22BackgroundClose;
    assert.equal(record.settled, false);
    assert.equal(typeof record.done.then, "function");
    const evidence = JSON.parse(f.counts.failures[0].detail).evidence;
    assert.equal(evidence.originalJoined, false);
    assert.equal(evidence.answered, false);
  } finally { f.dispose(); }
});
for (const [name, flag] of [
  ["a second question is not a successful retirement", "secondQuestion"],
  ["inactive close cannot mutate the active companion", "mutateCompanion"],
  ["Main admission must actually retire", "leaveAdmission"],
  ["exact Main owner must actually retire", "leaveOwner"],
]) test(name, async () => {
  const f = fixture(true);
  try {
    f.behavior[flag] = true;
    await assert.rejects(f.run(), /F22 pair/);
    assert.equal(f.counts.click, 1);
  } finally { f.dispose(); }
});
(async () => {
  let failures = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log("PASS " + name); }
    catch (error) { failures++; console.error("FAIL " + name + "\n" + error.stack); }
  }
  console.log(`F22 background pair contracts: ${cases.length - failures} passed, ${failures} failed; source/VM only, native NOT RUN.`);
  if (failures) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
