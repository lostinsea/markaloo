"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const MAIN = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8")
  .replace(/\r\n/g, "\n");
const RENDERER = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8")
  .replace(/\r\n/g, "\n");
const PRELOAD = fs.readFileSync(path.join(__dirname, "..", "src", "main-preload.js"), "utf8");
const TABS = fs.readFileSync(path.join(__dirname, "..", "src", "custom-tabs.js"), "utf8")
  .replace(/\r\n/g, "\n");

function between(source, first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start);
  assert(start >= 0 && end > start, `Actual source anchors: ${first}`);
  return source.slice(start, end);
}

function mainFunction(name) {
  const start = MAIN.indexOf("function " + name + "(");
  const end = MAIN.indexOf("\n}\n", start);
  assert(start >= 0 && end > start, "Actual Main function: " + name);
  return MAIN.slice(start, end + 3);
}

const laneSource = between(MAIN, "const MAX_SESSION_DOCUMENTS = 512;",
  'ipcMain.handle("open-admitted-readme"');
const retrySource = between(MAIN, 'ipcMain.handle("retry-retained-startup-opens"',
  "\n// ============================================");
const loadSource = between(MAIN, "  attachShutdownGuards(mainWindow);",
  "\n\n  // Hide the menu bar.").slice("  attachShutdownGuards(mainWindow);".length);
const loadedSource = between(MAIN, '  mainWindow.webContents.on("did-finish-load", () => {',
  "\n\n  // Open DevTools");
const responsiveSource = between(MAIN, '  win.on("responsive", () => {',
  "\n\n  // The guard.");
const closeStart = MAIN.indexOf('  win.on("close", (event) => {',
  MAIN.indexOf("function attachShutdownGuards(win)"));
const closeEnd = MAIN.indexOf("\n  });", closeStart) + "\n  });".length;
assert(closeStart >= 0 && closeEnd > closeStart);
const closeSource = MAIN.slice(closeStart, closeEnd);
const tick = () => new Promise(resolve => setImmediate(resolve));
const file = name => path.resolve(name + ".md");
const id = index => index.toString(16).padStart(64, "0");

function laneFixture(options = {}) {
  let now = 0;
  let scheduled = 0;
  let drains = 0;
  let retirements = 0;
  let readError = null;
  let admissionError = null;
  let sendError = null;
  let confirm = true;
  let admissionSequence = 0;
  const reads = [];
  const messages = [];
  const errors = [];
  const nativeWarnings = [];
  const warningReplies = [];
  let releaseReady;
  const ready = options.ready === false
    ? new Promise(resolve => { releaseReady = resolve; }) : Promise.resolve();
  const timers = new Map();
  const immediates = [];
  const handlers = new Map();
  const admissions = new Map();
  const owners = new Map();
  const lifecycle = { shutdownRequests: 0, closed: 0, activations: 0 };
  let consume;
  let hasPending;
  const target = Object.assign(new EventEmitter(), {
    mainFrame: { frameTreeNodeId: 1, isDestroyed: () => false },
    isDestroyed: () => false, isLoading: () => options.loading === true,
    send(channel, data) {
      if (sendError === channel) throw new Error("owned send failure");
      messages.push({ channel, data });
      options.onSend?.(channel, data);
    },
  });
  const win = Object.assign(new EventEmitter(), {
    webContents: target, isDestroyed: () => false,
    isMinimized: () => false, focus() { lifecycle.activations++; },
    loadFile() { lifecycle.loadSubscriptionsAtStart = target.listenerCount("did-stop-loading"); },
  });
  const event = () => ({ sender: target, senderFrame: target.mainFrame });
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, whenReady: () => ready,
    getName: () => "Folia",
    getPath: key => path.resolve("uncreated-headless-" + key),
    requestSingleInstanceLock: () => true,
  });
  let context = null;
  if (options.actualContext) {
    const argv = process.argv;
    try {
      process.argv = options.args || argv;
      context = require("../src/profile-startup").getMainStartup(app);
    } finally {
      process.argv = argv;
    }
  }
  const sandbox = {
    path, crypto, performance: { now: () => now },
    __dirname: path.join(__dirname, "..", "src"),
    fs: { existsSync: () => true },
    mainWindow: win, win, BrowserWindow: { fromWebContents: () => win },
    approvalRendererState: "ready", approvalRendererGeneration: 1,
    approvalRendererPageSession: "owned-page", shutdownCommitIngressBlocked: false,
    console: { error(...args) { errors.push(args); } }, log() {},
    startupContext: context || {
      drain() { drains++; },
      setConsumer(callback, pending) { consume = callback; hasPending = pending; },
      setErrorHandler() {},
    },
    app,
    dialog: { showMessageBox(...args) {
      nativeWarnings.push(args);
      return new Promise((resolve, reject) => warningReplies.push({ resolve, reject }));
    } },
    isMarkdownFile: filePath => path.extname(filePath).toLowerCase() === ".md",
    retireOrdinaryShutdownForStartup() { retirements++; },
    hasCurrentShutdownAuthorization: () => false,
    requestShutdown() { lifecycle.shutdownRequests++; },
    closeApprovedWindow() { lifecycle.closed++; },
    isApprovalSender: e => e.sender === target && e.senderFrame === target.mainFrame,
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
    setImmediate(callback) { immediates.push(callback); },
    setTimeout(callback, delay) {
      assert(Number.isFinite(delay) && delay >= 0);
      const handle = { unref() {} };
      timers.set(handle, { at: now + delay, callback });
      scheduled++;
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle); },
    safeFileLabel: value => value,
    documentAdmissions: admissions, knownDocumentOwners: owners,
    normaliseFilePath: value => typeof value === "string" ? { resolved: path.resolve(value) } : null,
    normaliseDocumentOwner: (owner, filePath) => owner &&
      owner.pageSession === sandbox.approvalRendererPageSession &&
      owner.rendererGeneration === sandbox.approvalRendererGeneration &&
      Number.isSafeInteger(owner.tabId) && owner.tabId > 0 &&
      Number.isSafeInteger(owner.documentGeneration) && owner.documentGeneration > 0 &&
      Number.isSafeInteger(owner.selectionGeneration) && owner.selectionGeneration > 0 &&
      typeof owner.documentRef === "string" && typeof filePath === "string"
      ? { ...owner, spelling: path.resolve(filePath) } : null,
    admittedDocumentReference(ref, owner, filePath) {
      const entry = admissions.get(ref);
      return entry && entry.owner === owner.tabId &&
        entry.descriptor.logicalPath === path.resolve(filePath) ? entry : null;
    },
    markdownSnapshotPromise(filePath) {
      return new Promise((resolve, reject) => reads.push({
        filePath, resolve, reject, readError,
      }));
    },
    confirmLargeDocument: () => confirm,
    fileOpenSnapshotIsCurrent: () => true,
    rememberDocumentModifiedTime() {},
    issueDocumentAdmission(_sender, filePath) {
      if (admissionError) throw admissionError;
      const descriptor = { ref: id(10000 + ++admissionSequence),
        pathKey: path.resolve(filePath), logicalPath: path.resolve(filePath) };
      admissions.set(descriptor.ref, { descriptor, owner: null });
      return descriptor;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    laneSource, mainFunction("documentOwnerKey"), mainFunction("sameDocumentOwner"),
    mainFunction("captureFileOpenDelivery"), mainFunction("safeSendFileOpen"),
    mainFunction("sendFileOpenFailure"), "let fileOpenDeliveryEpoch = 0;",
    "let activeDialogExtraBatch = null;", mainFunction("openFile"),
    between(MAIN, "const startupClosingState = {", "function isCurrentOrdinaryShutdownIntent("),
    loadSource, loadedSource, responsiveSource, mainFunction("holdStartupClosing"), closeSource,
    retrySource,
  ].join("\n"), sandbox);
  if (context) {
    context.drain();
    assert.equal(context.hasPendingRequests(), options.loading === true,
      "The actual initial activation is retained only while the window loads");
  }
  const state = vm.runInContext("startupDocuments", sandbox);
  function flush() {
    let turns = 0;
    while (immediates.length) {
      assert(++turns < 100, "No unbounded pump loop");
      immediates.shift()();
    }
  }
  function advance(value) {
    now = value;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= now && timers.delete(handle)) timer.callback();
    }
    flush();
    assert([...timers.values()].every(timer => timer.at > now), "No due-timer spin");
  }
  function queue(index, name = "document-" + index) {
    const request = { requestId: id(index) };
    const accepted = sandbox.queueStartupDocument(request, file(name));
    flush();
    return accepted;
  }
  function offer() {
    return messages.filter(message => message.data?.documentOpenTicket).at(-1)?.data;
  }
  function report(data, source = event()) {
    return handlers.get("report-startup-document-open")(source, data);
  }
  function adopt(record, options = {}) {
    const descriptor = record.admission;
    const ref = options.ref || descriptor.ref;
    const spelling = options.spelling || record.filePath;
    const owner = {
      pageSession: sandbox.approvalRendererPageSession,
      rendererGeneration: sandbox.approvalRendererGeneration, tabId: options.tabId || 1,
      documentGeneration: 1, selectionGeneration: 1,
      pathKey: options.pathKey || descriptor.pathKey, documentRef: ref,
      spelling: path.resolve(spelling),
    };
    if (!options.unregistered) {
      owners.set(sandbox.documentOwnerKey(owner), owner);
      admissions.set(ref, { descriptor: { ...descriptor, logicalPath: path.resolve(spelling) },
        owner: owner.tabId });
    }
    return { kind: "adopted", startup: record.correlation, owner, filePath: spelling };
  }
  return {
    sandbox, state, target, messages, errors, nativeWarnings, timers, reads, admissions, owners,
    lifecycle,
    queue, flush, advance, offer, report, adopt,
    retry(data = {
      pageSession: sandbox.approvalRendererPageSession,
      rendererGeneration: sandbox.approvalRendererGeneration,
    }, source = event()) {
      return handlers.get("retry-retained-startup-opens")(source, data);
    },
    consume: request => consume(request), hasPending: () => hasPending(),
    pending: () => state.pending.size,
    warningState: () => vm.runInContext("startupWarnings", sandbox),
    ordinaryClose() {
      const event = { defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; } };
      win.emit("close", event);
      return event;
    },
    async responsive() {
      win.emit("responsive");
      flush();
      await tick();
    },
    async ready() { releaseReady(); await tick(); },
    async dismissWarning(index) {
      warningReplies[index].resolve({ response: 0 });
      await tick();
    },
    async rejectWarning(index, error) {
      warningReplies[index].reject(error);
      await tick();
    },
    active: () => state.active,
    immediateCount: () => immediates.length,
    scheduled: () => scheduled, drains: () => drains, retirements: () => retirements,
    setNow(value) { now = value; },
    accept(ticket = offer().documentOpenTicket) {
      return handlers.get("accept-native-document-ticket")(event(), { ticket });
    },
    take(ticket, sender = target) {
      return sandbox.takeNativeDocumentTicket({ sender, senderFrame: target.mainFrame }, ticket);
    },
    async read() {
      const read = reads.shift();
      assert(read, "An actual asynchronous read is pending");
      if (read.readError) read.reject(read.readError);
      else read.resolve({ content: "# Owned document", modifiedTime: 1,
        diskVersion: { mtimeMs: 1 }, physical: {} });
      await tick();
      flush();
    },
    failRead() { readError = new Error("owned read failure"); },
    failAdmission() { admissionError = new Error("owned admission failure"); },
    failSend(channel) { sendError = channel; },
    declineLarge() { confirm = false; },
    generation() {
      sandbox.approvalRendererGeneration++;
      sandbox.approvalRendererPageSession = "replacement-page";
      sandbox.invalidateStartupDocumentGeneration();
      sandbox.scheduleStartupDocumentPump();
      flush();
    },
  };
}

for (const flags of [[], ["--remote-debugging-port=9222"]]) {
  test("load completion settles the initial no-document activation: " + JSON.stringify(flags), () => {
    const argv = process.argv;
    const f = laneFixture({ actualContext: true, loading: true,
      args: [process.execPath, ...flags] });
    const context = f.sandbox.startupContext;
    assert.equal(process.argv, argv, "The fixture restored its caller's arguments");
    assert.equal(context.owner.pendingCount(), 0, "The real drain retained the initial request");
    assert(context.hasPendingRequests(), "The initial activation still holds startup ownership");
    assert.equal(f.pending(), 0, "No document request was manufactured");
    assert.equal(f.lifecycle.activations, 0);
    f.target.emit("did-finish-load");
    f.flush();
    assert(context.hasPendingRequests(), "The earlier finish drain still sees aggregate loading");
    assert.equal(f.lifecycle.activations, 0);
    f.target.isLoading = () => false;
    for (let index = 0; index < 3; index++) f.target.emit("did-stop-loading");
    assert.equal(context.hasPendingRequests(), false, "Load stop settles the original activation");
    assert.equal(f.lifecycle.activations, 1, "The original activation is consumed exactly once");
    assert.equal(f.immediateCount(), 1, "Repeated load wakes still coalesce the document pump");
    f.flush();
    assert.equal(f.lifecycle.loadSubscriptionsAtStart, 1);
    assert.equal(f.messages.length, 0, "Activation needs no document offer or warning");
    assert.equal(f.reads.length, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.retirements(), 0);
    f.target.emit("did-stop-loading");
    f.flush();
    assert.equal(f.lifecycle.activations, 1, "Later resource loads cannot replay activation");
    f.ordinaryClose();
    assert.equal(f.lifecycle.shutdownRequests, 1, "The first Close enters ordinary approval");
    assert.equal(f.retirements(), 0, "Startup ownership does not refuse that Close");
    assert.equal(f.nativeWarnings.length, 0);
  });
}

test("the first Close after load stop does not drain and refuse a retained activation", () => {
  const f = laneFixture({ actualContext: true, loading: true,
    args: [process.execPath, "--remote-debugging-port=9222"] });
  const context = f.sandbox.startupContext;
  assert(context.hasPendingRequests(), "The initial no-document activation is actually retained");
  f.target.emit("did-finish-load");
  f.flush();
  assert(context.hasPendingRequests(), "An early finish drain cannot consume it");
  f.target.isLoading = () => false;
  f.target.emit("did-stop-loading");
  f.flush();
  f.ordinaryClose();
  assert.equal(f.lifecycle.shutdownRequests, 1, "Close reaches ordinary approval on its first try");
  assert.equal(f.retirements(), 0, "Close did not first refuse and then drain startup work");
  assert.equal(context.hasPendingRequests(), false);
  assert.equal(f.lifecycle.activations, 1);
  assert.equal(f.nativeWarnings.length, 0);
});

for (const blocked of ["window-missing", "window-destroyed", "loading"]) {
  test("load completion preserves the current activation guard: " + blocked, () => {
    const f = laneFixture({ actualContext: true, loading: true,
      args: [process.execPath, "--remote-debugging-port=9222"] });
    const context = f.sandbox.startupContext;
    const win = f.sandbox.mainWindow;
    assert(context.hasPendingRequests(), "The initial activation is retained before load stop");
    f.target.isLoading = () => false;
    if (blocked === "window-missing") f.sandbox.mainWindow = null;
    if (blocked === "window-destroyed") win.isDestroyed = () => true;
    if (blocked === "loading") f.target.isLoading = () => true;
    for (let index = 0; index < 3; index++) f.target.emit("did-stop-loading");
    f.flush();
    assert(context.hasPendingRequests(), "The existing consumer still refuses this activation");
    assert.equal(f.lifecycle.activations, 0);
    assert.equal(f.pending(), 0);
    assert.equal(f.messages.length, 0);
    assert.equal(f.reads.length, 0);
    assert.equal(f.timers.size, 0, "No polling or retry timer is manufactured");
    f.sandbox.mainWindow = win;
    win.isDestroyed = () => false;
    f.target.isLoading = () => false;
    f.target.emit("did-stop-loading");
    f.flush();
    assert.equal(context.hasPendingRequests(), false, "A later real load stop retries the same activation");
    assert.equal(f.lifecycle.activations, 1);
  });
}

test("aggregate load completion wakes an original open already transferred while loading", async () => {
  const f = laneFixture({ actualContext: true });
  const context = f.sandbox.startupContext;
  assert.equal(context.hasPendingRequests(), false);
  f.target.isLoading = () => true;
  context.owner.enqueue({
    requestId: id(1), args: ["app", "loading-original.md"], cwd: process.cwd(),
  });
  f.flush();
  const record = f.state.pending.get(id(1));
  assert.equal(context.owner.pendingCount(), 0, "The outer owner has handed off the request");
  assert.equal(record.filePath, file("loading-original"));
  assert.equal(record.state, "queued", "The loading pump has not offered the original file");
  assert.equal(f.active(), null);
  assert.equal(f.offer(), undefined);
  assert.equal(f.immediateCount(), 0, "The early scheduled pump has already returned");
  assert(context.hasPendingRequests(), "Main still owns the original request");
  let classifications = 0;
  f.sandbox.fs.existsSync = () => { classifications++; return true; };
  f.target.emit("did-finish-load");
  f.flush();
  assert.equal(classifications, 0, "The finished-load drain has no outer request left");
  assert.equal(f.offer(), undefined, "Aggregate loading still prevents an offer");
  f.target.isLoading = () => false;
  for (let index = 0; index < 3; index++) f.target.emit("did-stop-loading");
  assert.equal(f.immediateCount(), 1, "Repeated load wakes use the existing coalesced pump");
  assert.equal(f.offer(), undefined, "Load completion only schedules delivery");
  f.flush();
  assert.equal(f.lifecycle.loadSubscriptionsAtStart, 1, "The wake is registered before loadFile");
  assert.equal(f.active(), record, "Load completion offers the same retained record");
  assert.equal(f.offer().startup.requestId, id(1));
  assert.equal(f.offer().filePath, file("loading-original"));
  assert.equal(classifications, 0, "Recovery does not manufacture another outer request");
  assert(f.accept(), "The normal native-ticket admission still owns the open");
  await f.read();
  assert.equal(context.hasPendingRequests(), true, "Delivery alone cannot settle ownership");
  assert(f.report(f.adopt(record)));
  assert.equal(context.hasPendingRequests(), false, "Only verified adoption settles the open");
  f.target.emit("did-stop-loading");
  f.flush();
  assert.equal(f.messages.filter(message => message.data?.documentOpenTicket).length, 1);
});

for (const state of ["offered", "opening", "awaiting-receipt", "held"]) {
  test("load completion preserves existing document authority: " + state, async () => {
    const f = laneFixture();
    f.queue(1);
    const record = f.active();
    if (state === "opening" || state === "awaiting-receipt") assert(f.accept());
    if (state === "awaiting-receipt") await f.read();
    if (state === "held") {
      assert(f.report({ kind: "retained", startup: f.offer().startup, reason: "consent-declined" }));
    }
    f.flush();
    assert.equal(record.state, state, "The actual document path reached the intended state");
    const before = { ...record };
    const active = f.active();
    const reads = f.reads.length;
    for (let index = 0; index < 3; index++) f.target.emit("did-stop-loading");
    f.flush();
    assert.equal(f.state.pending.get(id(1)), record);
    assert.deepEqual({ ...record }, before, "Waking delivery cannot reset bindings or notices");
    assert.equal(f.active(), active);
    assert.equal(f.reads.length, reads);
    assert.equal(f.messages.filter(message => message.data?.documentOpenTicket).length, 1);
  });
}

for (const blocked of ["renderer", "session", "window", "contents", "loading", "shutdown"]) {
  test("a load wake still respects the current delivery guard: " + blocked, () => {
    const f = laneFixture();
    f.target.isLoading = () => true;
    assert(f.consume({ requestId: id(1), args: ["app", "guarded.md"], cwd: process.cwd() }));
    f.flush();
    const record = f.state.pending.get(id(1));
    assert.equal(record.state, "queued");
    assert.equal(f.offer(), undefined);
    f.target.isLoading = () => false;
    f.target.emit("did-stop-loading");
    assert.equal(f.immediateCount(), 1, "The actual load listener scheduled the pump");
    if (blocked === "renderer") f.sandbox.approvalRendererState = "loading";
    if (blocked === "session") f.sandbox.approvalRendererPageSession = null;
    if (blocked === "window") f.sandbox.mainWindow.isDestroyed = () => true;
    if (blocked === "contents") f.target.isDestroyed = () => true;
    if (blocked === "loading") f.target.isLoading = () => true;
    if (blocked === "shutdown") f.sandbox.shutdownCommitIngressBlocked = true;
    f.flush();
    assert.equal(f.state.pending.get(id(1)), record);
    assert.equal(record.state, "queued", "A later guard change keeps the original work owned");
    assert.equal(f.active(), null);
    assert.equal(f.offer(), undefined);
    assert.equal(f.reads.length, 0);
    assert.equal(f.timers.size, 0, "No delivery or retry timer is manufactured");
  });
}

test("updater exclusion sees the actual offered, opening and receipt ledger until adoption", async () => {
  const f = laneFixture({ actualContext: true });
  const context = f.sandbox.startupContext;
  vm.runInContext(mainFunction("assertWindowsUpdateAdmission"), f.sandbox);
  const emptyPause = context.pauseForUpdate();
  assert.doesNotThrow(() => f.sandbox.assertWindowsUpdateAdmission(emptyPause),
    "An actually empty Main/context is a matching green control");
  assert(context.resumeAfterUpdate(emptyPause));
  assert(f.queue(1));
  const record = f.active();
  function refuses(expected) {
    assert.equal(record.state, expected, "The actual Main path reached this ownership state");
    const pause = context.pauseForUpdate();
    assert.equal(context.owner.pendingCount(), 0, "The owner queue alone would miss Main-owned work");
    assert(context.hasPendingRequests());
    assert.throws(() => f.sandbox.assertWindowsUpdateAdmission(pause), /accepted file opens/);
    assert(context.resumeAfterUpdate(pause));
    assert.equal(f.state.pending.get(id(1)), record, "A refusal never replaces or settles the accepted record");
  }
  refuses("offered");
  assert(f.accept());
  refuses("opening");
  await f.read();
  refuses("awaiting-receipt");
  assert(f.report(f.adopt(record)));
  assert.equal(f.pending(), 0);
  assert.equal(context.hasPendingRequests(), false);
  const completedPause = context.pauseForUpdate();
  assert.doesNotThrow(() => f.sandbox.assertWindowsUpdateAdmission(completedPause),
    "Actual verified adoption removes the launch exclusion");
  assert(context.resumeAfterUpdate(completedPause));
  assert.equal(f.messages.filter(message => message.channel === "file-opened").length, 1,
    "Pause/refusal did not reopen the document");
});

test("retained read failure has a Main-owned warning even when notification IPC succeeds unnoticed", async () => {
  const f = laneFixture();
  f.failRead();
  f.queue(1);
  f.accept();
  await f.read();
  assert.equal(f.pending(), 1);
  assert.equal(f.active(), null);
  assert(f.messages.some(message => message.channel === "show-error"),
    "IPC really succeeded without any renderer notification consumer");
  assert.equal(f.nativeWarnings.length, 1, "Main independently owns an explanation");
  await f.dismissWarning(0);
  assert.equal(f.pending(), 1, "Dismissing a warning does not settle the accepted open");
});

test("Main startup warnings stay bounded and deduplicated without granting any document authority", async () => {
  const f = laneFixture();
  f.queue(1);
  const offered = f.offer();
  f.sandbox.queueStartupWarning("document", "Document warning");
  f.sandbox.queueStartupWarning("document", "Document warning");
  for (let index = 0; index < 20; index++) {
    f.sandbox.queueStartupWarning("context", "Context " + index);
    f.sandbox.queueStartupWarning("document", "Document replacement " + index);
  }
  await tick();
  assert.equal(f.nativeWarnings.length, 1);
  assert.equal(f.warningState().pending.size, 2, "Only the latest two notice classes wait");
  await f.dismissWarning(0);
  assert.equal(f.nativeWarnings.length, 2);
  assert.equal(f.nativeWarnings[1][0].message, "Context 19");
  await f.dismissWarning(1);
  assert.equal(f.nativeWarnings.length, 3);
  assert.equal(f.nativeWarnings[2][0].message, "Document replacement 19");
  await f.dismissWarning(2);
  assert.equal(f.warningState().active, null);
  assert.equal(f.warningState().pending.size, 0);
  assert.equal(f.pending(), 1);
  assert.equal(f.reads.length, 0, "A warning cannot consume a ticket or read a file");
  assert.equal(f.offer(), offered, "Dismissing warnings cannot offer another open");
  for (const args of f.nativeWarnings) {
    assert.equal(args.length, 1, "The native warning has no document-window dependency");
    assert.deepEqual(Array.from(args[0].buttons), ["OK"], "This is not shutdown consent");
  }
});

test("a Main warning waits for application readiness without needing a document window", async () => {
  const f = laneFixture({ ready: false });
  f.sandbox.mainWindow = null;
  f.sandbox.queueStartupWarning("context", "Owned pre-ready notice");
  await tick();
  assert.equal(f.nativeWarnings.length, 0);
  assert(f.warningState().active);
  await f.ready();
  assert.equal(f.nativeWarnings.length, 1);
  assert.equal(f.nativeWarnings[0].length, 1);
  await f.dismissWarning(0);
  assert.equal(f.warningState().active, null);
});

test("native warning failure stays explicit and does not settle or reopen accepted work", async () => {
  const f = laneFixture();
  f.failRead();
  f.queue(1);
  f.accept();
  await f.read();
  const error = new Error("owned native warning failure");
  await f.rejectWarning(0, error);
  assert(f.errors.some(args => args[1] === error), "The original native failure is reported");
  assert.equal(f.pending(), 1);
  assert.equal(f.state.pending.get(id(1)).state, "held");
  assert.equal(f.reads.length, 0);
  assert.equal(f.warningState().active, null);
  f.sandbox.queueStartupWarning("context", "A later ordinary close remains held");
  await tick();
  assert.equal(f.nativeWarnings.length, 2, "A later gesture can explain the still-held work");
  await f.dismissWarning(1);
  assert.equal(f.pending(), 1);
});

for (const rejected of [false, true]) {
  test((rejected ? "rejected" : "dismissed") +
    " document warning after actual responsive event, rejected=" + rejected, async () => {
    const f = laneFixture();
    f.failRead();
    f.failSend("show-error");
    f.queue(1);
    f.accept();
    f.target.isLoading = () => true;
    await f.read();
    const record = f.state.pending.get(id(1));
    assert.equal(record.state, "held");
    assert(record.mainNoticeQueued, "The original record queued its Main notice");
    assert(!f.messages.some(message => message.channel === "show-error"),
      "The loading renderer cannot provide the missing explanation");
    assert.equal(f.nativeWarnings.length, 1);
    if (rejected) {
      const error = new Error("owned original document warning rejection");
      await f.rejectWarning(0, error);
      assert(f.errors.some(args => args[1] === error));
    } else await f.dismissWarning(0);
    assert.equal(f.nativeWarnings.length, 1, "There is no immediate warning retry storm");
    await f.responsive();
    assert.equal(f.pending(), 1);
    assert.equal(f.state.pending.get(id(1)), record, "The same accepted request stays owned");
    assert.equal(record.state, "held");
    assert.equal(f.active(), null);
    assert.equal(f.reads.length, 0, "Warning recovery cannot retry the failed document");
    assert.equal(f.messages.filter(message => message.data?.documentOpenTicket).length, 1,
      "Readiness cannot issue another document attempt");
    if (!rejected) {
      assert.equal(f.nativeWarnings.length, 1, "A successfully dismissed warning is not reissued");
    }
  });
}

test("fresh ordinary Close explains a retained document after its original warning rejects", async () => {
  const f = laneFixture({ actualContext: true });
  f.failRead();
  f.failSend("show-error");
  f.queue(1);
  f.accept();
  f.target.isLoading = () => true;
  await f.read();
  const record = f.state.pending.get(id(1));
  assert.equal(record.state, "held");
  assert.equal(f.nativeWarnings.length, 1);
  const error = new Error("owned document warning rejection before fresh Close");
  await f.rejectWarning(0, error);
  assert(f.errors.some(args => args[1] === error));
  assert.equal(f.warningState().active, null, "The first failed attempt fully settled");
  assert.equal(f.warningState().pending.size, 0);
  assert.equal(f.nativeWarnings.length, 1, "No automatic retry occurred");
  assert(f.ordinaryClose().defaultPrevented, "The actual registered Close guard holds teardown");
  await tick();
  assert.equal(f.nativeWarnings.length, 2, "Fresh Close attempts a Main-owned explanation");
  const args = f.nativeWarnings[1];
  assert.equal(args.length, 1, "The warning does not depend on the loading document renderer");
  assert.match(args[0].message, /file opens are still pending/i);
  assert.deepEqual(Array.from(args[0].buttons), ["OK"]);
  await f.dismissWarning(1);
  assert.equal(f.pending(), 1);
  assert.equal(f.state.pending.get(id(1)), record);
  assert.equal(record.state, "held");
  assert.equal(f.active(), null);
  assert.equal(f.reads.length, 0);
  assert.equal(f.messages.filter(message => message.data?.documentOpenTicket).length, 1);
  assert.equal(f.lifecycle.closed, 0);
  assert.equal(f.lifecycle.shutdownRequests, 0, "Held Close does not reask or replay shutdown");
  assert(!f.messages.some(message => message.channel === "show-error"));
});

test("logical ownership survives ticket take, read and send until actual registered adoption", async () => {
  const f = laneFixture();
  assert(f.queue(1));
  assert.equal(f.retirements(), 1);
  assert(f.accept());
  assert.equal(f.pending(), 1);
  assert.equal(f.active().state, "opening");
  await f.read();
  assert.equal(f.active().state, "awaiting-receipt");
  assert.equal(f.nativeWarnings.length, 0, "A healthy delivery does not warn");
  assert.equal(f.pending(), 1);
  const receipt = f.adopt(f.active(), { unregistered: true });
  assert.equal(f.report(receipt), false, "A path and unregistered owner are not adoption");
  const valid = f.adopt(f.active());
  assert.equal(f.report(valid), true);
  assert.equal(f.pending(), 0);
  assert.equal(f.report(valid), true, "A lost acknowledgment retries receipt, not open");
  assert.equal(f.reads.length, 0);
});

test("startup reads serialize through actual adoption, not accept acknowledgment", async () => {
  const f = laneFixture();
  f.queue(1);
  f.queue(2);
  assert.equal(f.messages.filter(message => message.data?.documentOpenTicket).length, 1);
  f.accept();
  await f.read();
  f.sandbox.scheduleStartupDocumentPump();
  f.flush();
  assert.equal(f.messages.filter(message => message.data?.documentOpenTicket).length, 1);
  assert(f.report(f.adopt(f.active())));
  f.flush();
  assert.equal(f.offer().startup.requestId, id(2));
  assert.equal(f.pending(), 1);
});

test("cached or alias adoption may keep its real older reference", async () => {
  const f = laneFixture();
  f.queue(1);
  f.accept();
  await f.read();
  assert(f.report(f.adopt(f.active(), { ref: id(8000), spelling: file("alias") })));
  assert.equal(f.pending(), 0);
});

test("a registered owner of another physical path cannot settle startup", async () => {
  const f = laneFixture();
  f.queue(1);
  f.accept();
  await f.read();
  assert.equal(f.report(f.adopt(f.active(), { pathKey: file("other") })), false);
  assert.equal(f.pending(), 1);
});

test("logical capacity applies backpressure to all unresolved states without eviction", () => {
  const f = laneFixture();
  for (let index = 1; index <= 512; index++) assert(f.queue(index));
  assert.equal(f.pending(), 512);
  assert.equal(f.queue(513), false);
  assert(f.queue(1), "Repeated insertion is idempotent");
  assert.equal(f.pending(), 512);
  assert.throws(() => f.queue(1, "changed"), /identity changed/);
});

test("actual consumer transfers ownership without a window and keeps quit held through adoption", async () => {
  const f = laneFixture();
  const win = f.sandbox.mainWindow;
  f.sandbox.mainWindow = null;
  assert(f.consume({ requestId: id(1), args: ["app", "retained.md"], cwd: process.cwd() }));
  f.flush();
  assert.equal(f.pending(), 1);
  assert.equal(f.hasPending(), true);
  assert.equal(f.offer(), undefined);
  f.sandbox.mainWindow = win;
  f.sandbox.scheduleStartupDocumentPump();
  f.flush();
  f.accept();
  assert.equal(f.hasPending(), true, "Taking the capability is not completed delivery");
  await f.read();
  assert.equal(f.hasPending(), true, "Sending the bytes is not renderer ownership");
  assert(f.report(f.adopt(f.active())));
  assert.equal(f.hasPending(), false);
});

test("actual consumer keeps classification stable while logical capacity applies backpressure", async () => {
  const f = laneFixture();
  for (let index = 1; index <= 512; index++) assert(f.queue(index));
  let classifications = 0;
  f.sandbox.fs.existsSync = candidate =>
    candidate !== file("stable") || ++classifications === 1;
  const request = { requestId: id(513), args: ["app", "stable.md"], cwd: process.cwd() };
  assert.equal(f.consume(request), false, "The context still owns the untransferred request");
  assert.equal(classifications, 1);
  f.accept();
  await f.read();
  assert(f.report(f.adopt(f.active())));
  assert.equal(f.consume(request), true);
  assert.equal(classifications, 1, "Retry did not reinterpret a disappeared path as focus-only");
  assert.equal(f.state.pending.get(id(513)).filePath, file("stable"));
  assert.equal(f.pending(), 512);
});

test("expiry revokes capability but keeps logical work and sends one nonce-bound idle probe", () => {
  const f = laneFixture();
  f.queue(1);
  const original = f.offer();
  f.advance(60001);
  assert.equal(f.pending(), 1);
  assert.equal(f.take(original.documentOpenTicket), null);
  const probe = f.messages.filter(message => message.data?.startupProbe).at(-1).data.startupProbe;
  assert(probe.nonce);
  assert.equal(f.active().state, "expired");
  const { nonce, ...startup } = probe;
  assert.equal(f.report({ kind: "idle", startup, nonce: id(999) }), false);
  assert(f.report({ kind: "idle", startup, nonce }));
  f.flush();
  assert.equal(f.offer().startup.attempt, 2);
  assert.equal(f.take(original.documentOpenTicket), null);
  f.advance(120002);
  const next = f.messages.filter(message => message.data?.startupProbe).at(-1).data.startupProbe;
  const { nonce: nextNonce, ...nextStartup } = next;
  assert(f.report({ kind: "idle", startup: nextStartup, nonce: nextNonce }));
  f.flush();
  assert.equal(f.active(), null);
  assert.equal(f.state.pending.get(id(1)).reason, "automatic-retry-exhausted");
  for (let index = 0; index < 5; index++) {
    f.sandbox.scheduleStartupDocumentPump();
    f.flush();
    assert.equal(f.report({ kind: "idle", startup: nextStartup, nonce: nextNonce }), false);
  }
  assert.equal(f.messages.filter(message => message.data?.documentOpenTicket).length, 2);
});

test("an authenticated expired take frees native capacity; another sender cannot", () => {
  const f = laneFixture();
  f.queue(1);
  const ticket = f.offer().documentOpenTicket;
  f.setNow(60001);
  assert.equal(f.take(ticket, { isDestroyed: () => false }), null);
  assert.equal(f.active().ticket, ticket);
  assert.equal(f.take(ticket), null);
  f.flush();
  assert.equal(f.active().ticket, null);
  assert(f.messages.some(message => message.data?.startupProbe));
  assert.equal(f.pending(), 1);
});

test("full native capacity wakes from its own single deadline without a new arrival", () => {
  const f = laneFixture();
  for (let index = 0; index < 512; index++) {
    assert(f.sandbox.deliverNativeDocumentIntent(f.target, file("plain")));
  }
  f.queue(1);
  assert.equal(f.active(), null);
  assert.equal(f.timers.size, 1);
  f.advance(60001);
  assert.equal(f.offer().startup.requestId, id(1));
  assert.equal(f.timers.size, 1);
  assert.equal(f.pending(), 1);
});

for (const mode of ["read", "admission", "send", "large"]) {
  test(`failure after successful take remains owned and visible: ${mode}`, async () => {
    const f = laneFixture();
    if (mode === "read") f.failRead();
    if (mode === "admission") f.failAdmission();
    if (mode === "send") f.failSend("file-opened");
    if (mode === "large") f.declineLarge();
    f.queue(1);
    f.accept();
    await f.read();
    assert.equal(f.pending(), 1);
    assert.equal(f.state.pending.get(id(1)).state, "held");
    assert(f.errors.length > 0);
    assert(f.messages.some(message => message.channel === "show-error"));
    assert.equal(f.active(), null);
    assert.equal(f.reads.length, 0);
  });
}

test("same-frame opening timeout is ambiguous, not permission to reopen", async () => {
  const f = laneFixture();
  f.queue(1);
  f.accept();
  f.advance(60001);
  assert.equal(f.active().state, "held");
  assert.equal(f.active().ambiguous, true);
  f.sandbox.retryRetainedStartupDocuments();
  f.flush();
  assert.equal(f.reads.length, 1);
  await f.read();
  assert(f.report(f.adopt(f.active())), "The same late attempt may still prove real adoption");
  assert.equal(f.pending(), 0);
});

test("committed page replacement invalidates the old read and receipt before new work", async () => {
  const f = laneFixture();
  f.queue(1);
  const old = f.offer();
  f.accept();
  f.generation();
  assert.equal(f.offer().startup.attempt, 2);
  await f.read();
  assert.equal(f.messages.filter(message => message.channel === "file-opened").length, 0);
  assert.equal(f.report({ kind: "retained", startup: old.startup, reason: "open-failed" }), false);
  assert.equal(f.active().state, "offered");
});

test("committed page replacement also retires a delivered but unadopted attempt", async () => {
  const f = laneFixture();
  f.queue(1);
  f.accept();
  await f.read();
  const old = f.adopt(f.active());
  f.generation();
  assert.equal(f.report(old), false);
  assert.equal(f.pending(), 1);
  assert.equal(f.offer().startup.attempt, 2);
  f.accept();
  await f.read();
  assert(f.report(f.adopt(f.active())));
  assert.equal(f.pending(), 0);
});

test("explicit refusal stays held across readiness and page changes until deliberate Retry", () => {
  const f = laneFixture();
  f.queue(1);
  const old = f.offer();
  assert(f.report({ kind: "retained", startup: old.startup, reason: "consent-declined" }));
  f.generation();
  assert.equal(f.state.pending.get(id(1)).state, "held");
  assert.equal(f.messages.filter(message => message.data?.documentOpenTicket).length, 1);
  f.sandbox.retryRetainedStartupDocuments();
  f.flush();
  assert.equal(f.offer().startup.attempt, 2);
  assert.equal(f.pending(), 1);
});

test("a delayed refusal cannot restore its retired authority after explicit Retry", () => {
  const f = laneFixture();
  f.queue(1);
  const startup = f.offer().startup;
  assert(f.report({ kind: "retained", startup, reason: "consent-declined" }));
  f.sandbox.retryRetainedStartupDocuments();
  assert.equal(f.report({ kind: "retained", startup, reason: "consent-declined" }), false);
  f.flush();
  assert.equal(f.active().state, "offered");
});

test("updater ingress freeze retains accepted work without consumption or retry-budget churn", () => {
  const f = laneFixture();
  f.queue(1);
  f.sandbox.shutdownCommitIngressBlocked = true;
  assert.equal(f.accept(), false);
  f.advance(60001);
  for (let index = 0; index < 10; index++) {
    f.sandbox.scheduleStartupDocumentPump();
    f.flush();
  }
  assert.equal(f.pending(), 1);
  assert.equal(f.active().replacementUsed, false);
  assert.equal(f.messages.filter(message => message.data?.startupProbe).length, 0);
  f.sandbox.shutdownCommitIngressBlocked = false;
  f.sandbox.scheduleStartupDocumentPump();
  f.flush();
  assert.equal(f.messages.filter(message => message.data?.startupProbe).length, 1);
});

function rendererFixture(options = {}) {
  const reports = [];
  const retries = [];
  const notices = [];
  const errors = [];
  const timers = [];
  const listeners = new Map();
  let external;
  let onError;
  let acceptCount = 0;
  const window = {
    markaloo: {
      async reportStartupDocumentOpen(report) {
        reports.push(report);
        if (options.report) return options.report(report);
        return true;
      },
      onExternalFileOpenRequest(callback) { external = callback; },
      async acceptDocumentOpenTicket() { acceptCount++; return options.accept !== false; },
      async cancelDocumentOpenTicket() { return true; },
      async retryRetainedStartupOpens(data) {
        retries.push(data);
        return options.retry ? options.retry(data) : true;
      },
      onError(callback) { onError = callback; },
    },
  };
  const sandbox = {
    window, reloadRequestSession: "owned-page",
    console: { error(...args) { errors.push(args); } },
    showNotification(message) { notices.push(message); },
    mayMutateRendererDocument: () => options.mayMutate !== false,
    currentDocumentRendererGeneration: () => 1,
    hasUnsavedWork: () => !!options.consent,
    confirmUnsavedAction: () => options.consent,
    cancelPendingNavigation() {}, i18n: value => value,
    setTimeout(callback) { timers.push(callback); },
    document: { createElement: () => ({
      addEventListener(name, callback) { listeners.set(name, callback); },
    }) },
    fileMenu: { appendChild() {}, classList: { remove() {} } },
  };
  vm.createContext(sandbox);
  vm.runInContext(between(RENDERER, "const startupDocumentReceipts = new Map();",
    "// Update zoom on load"), sandbox);
  assert.equal(typeof listeners.get("click"), "function", "The actual Retry menu registered its click");
  assert.equal(typeof onError, "function", "The actual error listener delivers Main notices");
  const startup = { requestId: id(1), attempt: 1, frameTreeNodeId: 1,
    rendererGeneration: 1, pageSession: "owned-page" };
  const data = { startup, filePath: file("one"), documentOpenTicket: id(44) };
  return {
    sandbox, window, reports, retries, notices, errors, timers, data,
    clickRetry: () => listeners.get("click")(),
    error: message => onError(message),
    external: data => external(data),
    accepts: () => acceptCount,
    receiptCount: () => vm.runInContext("startupDocumentReceipts.size", sandbox),
  };
}

function retryMenuFixture(options = {}) {
  const order = [];
  const results = [];
  let renderer;
  const main = laneFixture({ actualContext: true, onSend(channel, data) {
    if (channel === "show-error") renderer.error(data);
  } });
  renderer = rendererFixture({
    mayMutate: options.mayMutate,
    report(report) {
      order.push(report.kind);
      return options.report ? options.report(main, report) : main.report(report);
    },
    retry(data) {
      order.push("retry");
      const admitted = main.retry(data);
      results.push(admitted);
      return admitted;
    },
  });
  return { main, renderer, order, results };
}

test("actual Retry menu explains an ambiguous timeout without reopening or releasing Close", async () => {
  const { main, renderer, results } = retryMenuFixture();
  main.queue(1);
  assert(main.accept());
  main.advance(60001);
  const record = main.active();
  const correlation = record.correlation;
  assert.equal(record.state, "held");
  assert.equal(record.ambiguous, true, "The accepted open really timed out without a receipt");
  assert.equal(record.ticket, null);
  assert.equal(main.reads.length, 1, "The original read is still unresolved");
  main.queue(2);
  const notices = renderer.notices.length;
  await renderer.clickRetry();
  assert.deepEqual(results, [true], "True means admitted, not recovered");
  assert.equal(renderer.notices.length, notices + 1,
    "Deliberate Retry explains that the active open is still unconfirmed");
  assert.match(renderer.notices.at(-1), /still unconfirmed/i);
  assert.match(renderer.notices.at(-1), /has not been reopened/i);
  assert(renderer.notices.at(-1).includes(path.basename(record.filePath)));
  main.flush();
  assert.equal(main.active(), record);
  assert.equal(record.correlation, correlation, "Retry cannot replace the original attempt");
  assert.equal(record.state, "held");
  assert.equal(record.ambiguous, true);
  assert.equal(record.attempt, 1);
  assert.equal(record.ticket, null);
  assert.equal(main.reads.length, 1);
  assert.equal(main.messages.filter(message => message.data?.documentOpenTicket).length, 1);
  assert.equal(main.state.pending.get(id(2)).state, "queued", "Later intent stays queued");
  assert.equal(main.pending(), 2);
  assert(main.ordinaryClose().defaultPrevented, "Retry grants no ordinary Close permission");
  assert.equal(main.lifecycle.shutdownRequests, 0);
  assert.equal(main.lifecycle.closed, 0);
});

for (const lost of ["delivery", "acknowledgment"]) {
  test("actual Retry menu replays adoption before Main retry after lost " + lost, async () => {
    let recover = false;
    const { main, renderer, order, results } = retryMenuFixture({
      report(lane, report) {
        if (!recover) {
          if (lost === "acknowledgment") assert(lane.report(report));
          throw new Error("owned lost " + lost);
        }
        return lane.report(report);
      },
    });
    main.queue(1);
    assert(main.accept());
    await main.read();
    const record = main.active();
    main.advance(60001);
    assert.equal(record.state, "held");
    assert.equal(record.ambiguous, true);
    const adoption = main.adopt(record);
    renderer.window.reportAdoptedStartupDocument(main.offer(), adoption.owner, adoption.filePath);
    await tick();
    assert.equal(renderer.receiptCount(), 1, "The failed send really left a pending adoption");
    assert.equal(main.pending(), lost === "delivery" ? 1 : 0);
    assert.equal(main.state.completed.size, lost === "delivery" ? 0 : 1);
    const owners = main.owners.size;
    const admissions = main.admissions.size;
    const notices = renderer.notices.length;
    recover = true;
    await renderer.clickRetry();
    assert.deepEqual(order, ["adopted", "adopted", "retry"],
      "The actual menu waits for this receipt resend before invoking Main retry");
    assert.deepEqual(results, [true]);
    assert.equal(renderer.receiptCount(), 0);
    assert.equal(main.pending(), 0);
    assert.equal(main.active(), null);
    assert.equal(main.state.completed.size, 1);
    assert.equal(main.owners.size, owners, "Receipt replay cannot register a second owner");
    assert.equal(main.admissions.size, admissions);
    assert.equal(main.reads.length, 0);
    assert.equal(main.messages.filter(message => message.data?.documentOpenTicket).length, 1);
    assert.equal(main.messages.filter(message => message.channel === "file-opened").length, 1);
    assert.equal(renderer.notices.length, notices, "Resolved work cannot emit a stale ambiguity notice");
    renderer.window.reportRetainedStartupDocument(main.offer(), "open-failed");
    renderer.window.finishStartupDocumentDelivery(main.offer());
    await tick();
    assert.equal(renderer.reports.length, 2, "Committed adoption cannot be downgraded after acknowledgment");
    assert(main.ordinaryClose().defaultPrevented, "Close still waits for ordinary approval, not automatic teardown");
    assert.equal(main.lifecycle.shutdownRequests, 1, "Resolved startup work no longer blocks ordinary approval");
  });
}

test("actual Retry menu requeues a safe held open once across queued, offered and opening clicks", async () => {
  const { main, renderer, results } = retryMenuFixture();
  main.queue(1);
  assert(main.report({ kind: "retained", startup: main.offer().startup, reason: "consent-declined" }));
  const record = main.state.pending.get(id(1));
  assert.equal(record.state, "held");
  assert.equal(record.ambiguous, false);
  const notices = renderer.notices.length;
  main.target.isLoading = () => true;
  for (let index = 0; index < 3; index++) {
    await renderer.clickRetry();
    main.flush();
    assert.equal(record.state, "queued");
    assert.equal(record.attempt, 1);
    assert.equal(record.correlation, null);
  }
  main.target.isLoading = () => false;
  main.sandbox.scheduleStartupDocumentPump();
  main.flush();
  const correlation = record.correlation;
  assert.equal(record.state, "offered");
  assert.equal(record.attempt, 2);
  for (const phase of ["offered", "opening"]) {
    if (phase === "opening") assert(main.accept());
    for (let index = 0; index < 3; index++) {
      await renderer.clickRetry();
      main.flush();
      assert.equal(record.state, phase);
      assert.equal(record.correlation, correlation);
      assert.equal(record.attempt, 2);
    }
  }
  assert(results.every(value => value === true));
  assert.equal(results.length, 9);
  assert.equal(main.reads.length, 1);
  assert.equal(main.messages.filter(message => message.data?.documentOpenTicket).length, 2);
  assert.equal(renderer.notices.length, notices, "Safely retryable work is not ambiguous");
});

for (const failure of ["rejected", "transport-failed", "in-flight"]) {
  test("actual Retry menu retains adoption and authority when its receipt is " + failure, async () => {
    let finishReport;
    const { main, renderer, results } = retryMenuFixture({
      report(lane, report) {
        if (failure === "rejected") return false;
        if (failure === "transport-failed") throw new Error("owned receipt transport failure");
        return new Promise(resolve => { finishReport = () => resolve(lane.report(report)); });
      },
    });
    main.queue(1);
    assert(main.accept());
    await main.read();
    main.advance(60001);
    const record = main.active();
    const correlation = record.correlation;
    assert.equal(record.state, "held");
    assert.equal(record.ambiguous, true);
    const adoption = main.adopt(record);
    renderer.window.reportAdoptedStartupDocument(main.offer(), adoption.owner, adoption.filePath);
    await tick();
    assert.equal(renderer.reports.length, 1);
    assert.equal(renderer.receiptCount(), 1);
    renderer.window.reportRetainedStartupDocument(main.offer(), "open-failed");
    renderer.window.finishStartupDocumentDelivery(main.offer());
    let menuFinished = false;
    const click = renderer.clickRetry().then(() => { menuFinished = true; });
    await tick();
    assert(menuFinished, "Retry does not join an already in-flight receipt indefinitely");
    await click;
    assert.deepEqual(results, [true]);
    assert.equal(renderer.reports.length, failure === "in-flight" ? 1 : 2);
    assert(renderer.reports.every(report => report.kind === "adopted"),
      "A later refusal cannot downgrade the pending committed owner");
    assert.equal(renderer.receiptCount(), 1);
    assert.equal(main.active(), record);
    assert.equal(record.correlation, correlation);
    assert.equal(record.state, "held");
    assert.equal(record.ambiguous, true);
    assert.equal(main.pending(), 1);
    assert.equal(main.state.completed.size, 0);
    assert.equal(main.messages.filter(message => message.data?.documentOpenTicket).length, 1);
    assert.equal(main.reads.length, 0);
    assert.match(renderer.notices.at(-1), /still unconfirmed/i);
    assert.match(renderer.notices.at(-1), /has not been reopened/i);
    if (failure === "in-flight") {
      finishReport();
      await tick();
      assert.equal(renderer.receiptCount(), 0, "The original in-flight receipt can still settle later");
      assert.equal(main.pending(), 0);
    } else {
      assert.equal(renderer.errors.length, 2, "Both controlled receipt failures remain explicit");
    }
  });
}

test("actual Retry menu keeps safe retries queued behind the ambiguous active open", async () => {
  const { main, renderer } = retryMenuFixture();
  main.queue(2);
  assert(main.report({ kind: "retained", startup: main.offer().startup, reason: "consent-declined" }));
  const safe = main.state.pending.get(id(2));
  main.queue(1);
  assert(main.accept());
  main.advance(60001);
  const active = main.active();
  const correlation = active.correlation;
  main.queue(3);
  assert.equal(safe.state, "held");
  assert.equal(safe.ambiguous, false);
  assert.equal(active.state, "held");
  assert.equal(active.ambiguous, true);
  const notices = renderer.notices.length;
  await renderer.clickRetry();
  main.flush();
  assert.equal(safe.state, "queued", "The other safe request really was requeued");
  assert.equal(safe.correlation, null);
  assert.equal(safe.attempt, 1);
  assert.equal(main.active(), active);
  assert.equal(active.correlation, correlation);
  assert.equal(main.state.pending.get(id(3)).state, "queued");
  assert.equal(main.pending(), 3);
  assert.equal(main.reads.length, 1);
  assert.equal(main.messages.filter(message => message.data?.documentOpenTicket).length, 2);
  assert.equal(renderer.notices.length, notices + 1);
  assert(renderer.notices.at(-1).includes(path.basename(active.filePath)));
  assert(!/nothing (?:was )?retried|all .*finished/i.test(renderer.notices.at(-1)),
    "The notice describes only the ambiguous active file, not the whole queue");
  await main.read();
  const adoption = main.adopt(active);
  renderer.window.reportAdoptedStartupDocument(main.offer(), adoption.owner, adoption.filePath);
  await tick();
  main.flush();
  assert.equal(main.active(), safe, "Real late adoption releases the next safe request");
  assert.equal(safe.attempt, 2);
  assert.equal(main.pending(), 2, "Later intent remains owned");
});

test("actual Retry menu is silent for empty and already resolved work", async () => {
  const { main, renderer, results } = retryMenuFixture();
  await renderer.clickRetry();
  main.flush();
  assert.equal(main.pending(), 0);
  assert.equal(renderer.notices.length, 0);
  main.queue(1);
  assert(main.accept());
  await main.read();
  assert(main.report(main.adopt(main.active())));
  await renderer.clickRetry();
  main.flush();
  assert.deepEqual(results, [true, true]);
  assert.equal(renderer.notices.length, 0);
  assert.equal(main.state.completed.size, 1);
  assert.equal(main.messages.filter(message => message.data?.documentOpenTicket).length, 1);
});

test("actual Retry menu respects the renderer mutation guard before receipts and Main IPC", async () => {
  const { main, renderer, results } = retryMenuFixture({ mayMutate: false, report: () => false });
  main.queue(1);
  assert(main.accept());
  await main.read();
  main.advance(60001);
  const record = main.active();
  const adoption = main.adopt(record);
  renderer.window.reportAdoptedStartupDocument(main.offer(), adoption.owner, adoption.filePath);
  await tick();
  assert.equal(renderer.receiptCount(), 1);
  const notices = renderer.notices.length;
  await renderer.clickRetry();
  assert.equal(renderer.reports.length, 1, "The blocked menu did not resend pending receipts");
  assert.equal(renderer.retries.length, 0);
  assert.deepEqual(results, []);
  assert.equal(renderer.notices.length, notices);
  assert.equal(main.active(), record);
  assert.equal(record.state, "held");
  assert.equal(record.ambiguous, true);
});

test("the actual Main Retry registration rejects stale sender, frame, page and generation", async () => {
  const { main, renderer } = retryMenuFixture();
  main.queue(1);
  assert(main.report({ kind: "retained", startup: main.offer().startup, reason: "consent-declined" }));
  const record = main.state.pending.get(id(1));
  const before = { ...record };
  const notices = renderer.notices.length;
  const current = { pageSession: "owned-page", rendererGeneration: 1 };
  assert.equal(main.retry(current, { sender: {}, senderFrame: main.target.mainFrame }), false);
  assert.equal(main.retry(current, { sender: main.target, senderFrame: {} }), false);
  assert.equal(main.retry({ ...current, pageSession: "old-page" }), false);
  assert.equal(main.retry({ ...current, rendererGeneration: 2 }), false);
  assert.equal(main.retry(null), false);
  main.flush();
  assert.deepEqual({ ...record }, before, "Rejected authority cannot requeue or reset the attempt");
  assert.equal(renderer.notices.length, notices);
  assert.equal(main.messages.filter(message => message.data?.documentOpenTicket).length, 1);
  await renderer.clickRetry();
  main.flush();
  assert.equal(record.state, "offered", "The same registered handler accepts the current menu");
  assert.equal(record.attempt, 2);
});

test("actual Retry menu cannot bypass Main shutdown ingress", async () => {
  const { main, renderer, results } = retryMenuFixture();
  main.queue(1);
  assert(main.report({ kind: "retained", startup: main.offer().startup, reason: "consent-declined" }));
  const record = main.state.pending.get(id(1));
  const before = { ...record };
  main.sandbox.shutdownCommitIngressBlocked = true;
  await renderer.clickRetry();
  main.flush();
  assert.deepEqual(results, [false]);
  assert.deepEqual({ ...record }, before);
  assert.match(renderer.notices.at(-1), /cannot retry while closing/i);
  assert(main.errors.some(args => /cannot retry during updater\/shutdown/.test(args[0])));
  assert.equal(main.messages.filter(message => message.data?.documentOpenTicket).length, 1);
});

for (const guard of ["window-missing", "window-destroyed", "contents-destroyed", "loading", "send-failed"]) {
  test("ambiguous Retry feedback preserves the existing guarded delivery: " + guard, async () => {
    const { main, renderer, results } = retryMenuFixture();
    main.queue(1);
    assert(main.accept());
    main.advance(60001);
    const record = main.active();
    const correlation = record.correlation;
    const notices = renderer.notices.length;
    if (guard === "window-missing") main.sandbox.mainWindow = null;
    if (guard === "window-destroyed") main.sandbox.mainWindow.isDestroyed = () => true;
    if (guard === "contents-destroyed") main.target.isDestroyed = () => true;
    if (guard === "loading") main.target.isLoading = () => true;
    if (guard === "send-failed") main.failSend("show-error");
    await renderer.clickRetry();
    main.flush();
    assert.deepEqual(results, [true], "Notification delivery does not redefine admission");
    assert.equal(renderer.notices.length, notices);
    assert.equal(main.active(), record);
    assert.equal(record.correlation, correlation);
    assert.equal(record.state, "held");
    assert.equal(record.ambiguous, true);
    assert.equal(main.reads.length, 1);
    assert.equal(main.messages.filter(message => message.data?.documentOpenTicket).length, 1);
    if (guard === "send-failed") {
      assert(main.errors.some(args => args[0] === "Retained startup open notice could not be delivered:"));
    }
  });
}

test("a long consent question defers idle proof until its actual finally path", async () => {
  let finishConsent;
  const f = rendererFixture({ accept: false, consent: new Promise(resolve => { finishConsent = resolve; }) });
  const handling = f.external(f.data);
  await f.external({ startupProbe: { ...f.data.startup, nonce: id(55) } });
  assert.equal(f.reports.length, 0);
  assert.equal(f.accepts(), 0);
  finishConsent({ approved: true, isCurrent: () => true });
  await handling;
  await tick();
  assert.equal(f.accepts(), 1);
  assert.equal(f.reports.filter(report => report.kind === "idle").length, 1);
});

test("a declined question after expiry never authorizes an automatic re-question", async () => {
  let finishConsent;
  const f = rendererFixture({ consent: new Promise(resolve => { finishConsent = resolve; }) });
  const handling = f.external(f.data);
  await f.external({ startupProbe: { ...f.data.startup, nonce: id(55) } });
  finishConsent({ approved: false, isCurrent: () => true });
  await handling;
  assert.equal(f.reports[0].kind, "retained");
  assert.equal(f.reports[0].reason, "consent-declined");
  assert.equal(f.accepts(), 0);
});

test("renderer remains busy after accept acknowledgment through document ownership", async () => {
  const f = rendererFixture();
  await f.external(f.data);
  await f.external({ startupProbe: { ...f.data.startup, nonce: id(55) } });
  assert.equal(f.reports.length, 0);
  f.window.finishStartupDocumentDelivery(f.data);
  await tick();
  assert.equal(f.reports[0].kind, "retained");
  assert.equal(f.reports[1].kind, "idle");
});

test("a previous page's external offer cannot enter the current consent or open handler", async () => {
  const f = rendererFixture();
  await f.external({ ...f.data, startup: { ...f.data.startup, pageSession: "old-page" } });
  assert.equal(f.accepts(), 0);
  assert.equal(f.reports.length, 0);
  await f.external(f.data);
  assert.equal(f.accepts(), 1, "The stale offer did not retain the current busy slot");
});

test("refused ordinary native delivery does not claim nonexistent startup retention", async () => {
  const f = rendererFixture({ accept: false });
  const { startup, ...ordinary } = f.data;
  assert(startup);
  await f.external(ordinary);
  assert.equal(f.accepts(), 1);
  assert.equal(f.reports.length, 0);
  assert(f.notices.some(message => /Retry opening the file/.test(message)));
  assert(f.notices.every(message => !/still retained/.test(message)));
});

test("lost adoption acknowledgment retries only receipt and later render failure cannot downgrade it", async () => {
  let calls = 0;
  const f = rendererFixture({ report: () => {
    if (++calls === 1) throw new Error("owned lost acknowledgment");
    return true;
  } });
  await f.external(f.data);
  f.window.reportAdoptedStartupDocument(f.data, {
    pageSession: "owned-page", rendererGeneration: 1, tabId: 1,
    documentGeneration: 1, pathKey: f.data.filePath, documentRef: id(88),
  }, f.data.filePath);
  await tick();
  assert.equal(f.timers.length, 1);
  f.timers.shift()();
  await tick();
  assert.equal(f.receiptCount(), 0);
  f.window.finishStartupDocumentDelivery(f.data);
  f.window.reportRetainedStartupDocument(f.data, "open-failed");
  await tick();
  assert.equal(f.reports.length, 2);
  assert(f.reports.every(report => report.kind === "adopted"));
  assert.equal(f.accepts(), 1);
});

function tabDeliveryFixture(options = {}) {
  const renderer = rendererFixture();
  const { window, data } = renderer;
  const oldRef = id(88);
  const tab = { id: 1, filePath: data.filePath, content: "owned edit",
    originalContent: "old disk", hasUnsavedChanges: !!options.cached };
  const state = { generation: 1, admission: { ref: oldRef } };
  const deferred = [];
  const abandoned = [];
  const registered = [];
  let committed = false;
  let restored = false;
  const sandbox = {
    window, console: { log() {}, error() {} },
    latestFileOpenIntent: 0, latestFileOpenPath: null, activeTabId: 1,
    documentState: new Map([[tab, state]]), tabs: [tab],
    pendingActivationTabs: new Set(), appliedDiskAdoptionApprovals: new Set(),
    largeConfirmed: new Set(), approvalRendererGeneration: 1,
    deferPreHandshakeFileOpen(callback) {
      if (!options.preHandshake) return false;
      deferred.push(callback);
      return true;
    },
    deferFrozenDocumentOperation(_reason, callback) {
      if (!options.frozen) return false;
      deferred.push(callback);
      return true;
    },
    mayMutateDocument: () => true,
    reserveDocumentIdentity: () => ({ tabId: 1, documentGeneration: 2 }),
    findTabByPath: () => tab, findTabForAdmission: () => tab,
    tabSpellingKey: () => data.filePath,
    normaliseTabPath: () => ({ spelling: data.filePath }),
    tabPathKey: () => data.filePath,
    liveDocument: () => options.cached ? tab.content : tab.originalContent,
    sameDocument: (a, b) => a === b,
    hasUnsavedMutation: () => !!options.cached, isDirty: () => !!options.cached,
    async verifyDiskAdoption() {
      if (options.freezeAfterAttestation) options.frozen = true;
      return { capability: id(90), pathKey: data.filePath, documentGeneration: 2 };
    },
    isDocumentFrozen: () => !!options.frozen,
    abandonDiskAdoption(capability) { abandoned.push(capability); },
    normaliseAdoptionDiskVersion: () => ({ mtimeMs: 1 }),
    approvedReloadSnapshotMatches: () => true,
    matchesDiskAdoptionApproval: () => true,
    snapshotActiveTab() {},
    snapshotTabAdoption: () => ({ generation: state.generation, content: tab.content }),
    adoptTabPathIdentity: (_tab, _path, key) => key,
    adoptCleanDocument(_tab, content, generation) {
      tab.content = content;
      state.generation = generation;
      return true;
    },
    restoreTabAdoption(_tab, prior) {
      restored = true;
      state.generation = prior.generation;
      tab.content = prior.content;
    },
    restoreNavigationAfterFailedAdoption() {}, rememberTabPathAlias() {},
    completeDiskAdoption: () => true,
    registerTabDiskOwner(owner) { registered.push(owner); },
    documentIdentity: () => ({
      pageSession: "owned-page", rendererGeneration: 1, tabId: tab.id,
      documentGeneration: state.generation, pathKey: tab.filePath,
      documentRef: state.admission.ref,
    }),
    markCompletedBackgroundAdoptionConflict: () => !!options.conflict,
    saveTabs() {}, renderTabs() {}, notify() {},
    openAdditionalFiles: async () => {},
    async switchToTab(_id, selection) {
      if (options.refuse) return false;
      const owner = sandbox.documentIdentity();
      const boundary = between(RENDERER,
        "  if (typeof options.onTrackingCommitted === 'function') {",
        "  // Leave Welcome unchanged");
      // Execute the actual renderer handoff boundary, not a simulated receipt.
      vm.runInNewContext(boundary, {
        options: { onTrackingCommitted() {
          committed = true;
          selection.onTrackingCommitted();
        } },
        data, trackingDecision: { owner }, openedPath: tab.filePath,
        reportAdoptedStartupDocument: window.reportAdoptedStartupDocument,
      });
      if (options.renderFailure) throw new Error("owned post-commit render failure");
      return true;
    },
  };
  window.getReloadRequestSession = () => "owned-page";
  window.preflightFileOpen = () => {
    if (options.background) sandbox.activeTabId = 2;
    return { accepted: true };
  };
  window.captureFileOpenNavigation = () => ({ owned: true });
  vm.createContext(sandbox);
  vm.runInContext(between(TABS, "      const handleFileOpened = async (event, data) => {",
    '      documentEvents.on("file-opened", dispatchFileOpened);') +
    "\nthis.dispatch = dispatchFileOpened;", sandbox);
  return {
    ...renderer, tab, state, deferred, abandoned, registered, options,
    dispatch: (overrides = {}) => sandbox.dispatch({}, { ...data, path: data.filePath,
      content: "new disk", document: { ref: id(89), openTicket: id(91) }, ...overrides }),
    committed: () => committed, restored: () => restored,
  };
}

test("a stale tab delivery cannot mutate, report refusal or occupy the new page", async () => {
  const f = tabDeliveryFixture();
  await f.dispatch({ startup: { ...f.data.startup, pageSession: "old-page" } });
  assert.equal(f.tab.content, "owned edit");
  assert.equal(f.committed(), false);
  assert.equal(f.reports.length, 0);
});

test("fallback delivery rejects an old page before its preflight and finalization", async () => {
  const calls = [];
  const sandbox = {
    reloadRequestSession: "owned-page",
    preflightFileOpen() { calls.push("preflight"); return { accepted: false }; },
    finishStartupDocumentDelivery() { calls.push("finalize"); },
  };
  vm.createContext(sandbox);
  vm.runInContext(between(RENDERER, "async function handleFileOpened(event, data) {",
    "// Handle file opened"), sandbox);
  await sandbox.handleFileOpened({}, { startup: { pageSession: "old-page" } });
  assert.deepEqual(calls, []);
  await sandbox.handleFileOpened({}, {});
  assert.deepEqual(calls, ["preflight", "finalize"]);
});

for (const options of [
  {}, { cached: true }, { background: true }, { background: true, cached: true },
  { background: true, conflict: true }, { renderFailure: true },
]) {
  test("actual CustomTabs dispatch settles only committed ownership: " + JSON.stringify(options),
    async () => {
      const f = tabDeliveryFixture(options);
      await f.external(f.data);
      await f.dispatch();
      await tick();
      assert.equal(f.reports.length, 1, "One adoption, not dispatcher refusal or duplicate open");
      assert.equal(f.reports[0].kind, "adopted");
      assert.equal(f.reports[0].owner.documentGeneration, options.cached ? 1 : 2);
      assert.equal(f.reports[0].owner.documentRef, options.cached ? id(88) : id(89));
      assert.equal(f.tab.content, options.cached ? "owned edit" : "new disk");
      assert.equal(f.restored(), false);
      assert.equal(f.abandoned.length, 0);
      if (options.background) assert.equal(f.registered.length, 1);
      else assert.equal(f.committed(), true);
    });
}

test("actual refused tab selection rolls back and retains instead of reporting adoption", async () => {
  const f = tabDeliveryFixture({ refuse: true });
  await f.external(f.data);
  await f.dispatch();
  assert.equal(f.committed(), false);
  assert.equal(f.restored(), true);
  assert.equal(f.tab.content, "owned edit");
  assert.equal(f.abandoned.length, 1);
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].kind, "retained");
});

for (const mode of ["preHandshake", "frozen", "freezeAfterAttestation"]) {
  test("actual deferred tab delivery stays owned until replay: " + mode, async () => {
    const f = tabDeliveryFixture({ [mode]: true });
    await f.external(f.data);
    await f.dispatch();
    assert.equal(f.deferred.length, 1);
    assert.equal(f.reports.length, 0, "Deferral is not final refusal or idle");
    f.options[mode] = false;
    f.options.frozen = false;
    await f.deferred.shift()();
    await tick();
    assert.equal(f.reports.length, 1);
    assert.equal(f.reports[0].kind, "adopted");
  });
}

test("preload allows only closed startup reports and projects correlation on its three events", async () => {
  let api;
  const invokes = [];
  const listeners = new Map();
  const sandbox = {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
        webUtils: {},
        ipcRenderer: {
          on(channel, callback) { listeners.set(channel, callback); },
          async invoke(channel, value) { invokes.push({ channel, value }); return true; },
          removeListener() {},
        },
      };
    },
    process: { argv: [], isMainFrame: true },
    window: { addEventListener() {} }, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(PRELOAD, sandbox);
  const startup = { requestId: id(1), attempt: 1, frameTreeNodeId: 1,
    rendererGeneration: 1, pageSession: "owned-page" };
  const retained = { kind: "retained", startup, reason: "consent-declined" };
  assert(await api.reportStartupDocumentOpen(retained));
  for (const invalid of [
    { ...retained, extra: true }, { ...retained, kind: "cancelled" },
    { ...retained, reason: "anything" },
    { ...retained, startup: { ...startup, requestId: "bad" } },
    { ...retained, startup: { ...startup, attempt: 0 } },
    { ...retained, startup: { ...startup, extra: true } },
    { kind: "idle", startup, nonce: "bad" },
    { kind: "adopted", startup, filePath: file("one"), owner: {} },
  ]) await assert.rejects(api.reportStartupDocumentOpen(invalid));
  assert.equal(invokes.length, 1, "Invalid reports never reach Main");
  for (const [subscribe, channel] of [
    ["onExternalFileOpenRequest", "external-file-open-request"],
    ["onFileOpened", "file-opened"], ["onFileOpenResult", "file-open-result"],
  ]) {
    let observed;
    api[subscribe](data => { observed = data; });
    listeners.get(channel)({}, { startup, secret: "not exposed" });
    assert.equal(JSON.stringify(observed.startup), JSON.stringify(startup));
    assert.equal(observed.secret, undefined);
  }
});
