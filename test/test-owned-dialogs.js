const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");
const assert = require("assert/strict");
const artifacts = path.join(__dirname, "owned-dialogs-artifacts");
fs.mkdirSync(artifacts, { recursive: true });
process.env.TMP = artifacts;
process.env.TEMP = artifacts;
require("./test-userdata-isolation");
const { app, BrowserWindow, ipcMain, session } = require("electron");
const { OwnedDialogs, ownerRendererAvailable } = require("../src/owned-dialogs");
const { popupTheme } = require("../src/popup-theme");
app.on("window-all-closed", () => {});
const watchdog = setTimeout(() => {
  console.error("Owned dialog verification exceeded its bounded runtime");
  app.exit(1);
}, 90000);
process.on("unhandledRejection", error => {
  console.error(error);
  app.exit(1);
});
let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}  -> behavioral condition was ${JSON.stringify(condition)}`);
  }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}
function extract(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function exists: ${name}`);
  if (source.slice(start - 6, start) === "async ") start -= 6;
  const end = source.indexOf("\n}", start);
  assert.ok(end !== -1, `function ends: ${name}`);
  return source.slice(start, end + 2);
}

function checkMainAuthority() {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8")
    .replace(/\r\n/g, "\n");
  const frame = { isDestroyed: () => false };
  const target = { isDestroyed: () => false, mainFrame: frame };
  const owner = { isDestroyed: () => false, webContents: target };
  const context = {
    BrowserWindow: { fromWebContents: () => owner }, mainWindow: owner,
    approvalRendererGeneration: 7, approvalRendererPageSession: "page",
    approvalRendererState: "ready", fileOpenDeliveryEpoch: 3,
    shutdownCommitIngressBlocked: false,
  };
  vm.createContext(context);
  vm.runInContext(extract(source, "captureFileOpenDelivery"), context);
  const delivery = context.captureFileOpenDelivery(target, 3);
  check("open delivery starts with its actual owner and page", delivery.current());
  context.fileOpenDeliveryEpoch += 1;
  check("a competing open revokes the delayed large-file answer", !delivery.current());
  context.fileOpenDeliveryEpoch = 3;
  context.approvalRendererGeneration += 1;
  check("navigation revokes the delayed large-file answer", !delivery.current());
  context.approvalRendererGeneration = 7;
  context.shutdownCommitIngressBlocked = true;
  check("frozen shutdown revokes the delayed large-file answer", !delivery.current());
  context.shutdownCommitIngressBlocked = false;
  context.approvalRendererPageSession = null;
  context.approvalRendererState = "loading";
  const startup = context.captureFileOpenDelivery(target, 3);
  context.approvalRendererPageSession = "startup-page";
  context.approvalRendererState = "ready";
  check("initial ready handshake does not revoke the same startup open", startup.current());
  const state = { unreadable: false, unresolved: true, revision: 11 };
  Object.assign(context, {
    closingDocumentOwnerFromEnvelope: () => ({}), documentOwnerKey: () => "owner",
    documentDeletionTombstones: new Map(), describeDocumentDeletionState: () => state,
    retirementRefusal: (why, live) => ({ retired: false, why, revision: live.revision }),
    ownerDocumentBaselines: new Map([["owner", {}]]),
    cancelDocumentReplacementConsents: () => {},
    forgetDocumentOwnerAliases: () => { throw new Error("MUTATION-REACHED"); },
  });
  vm.runInContext(extract(source, "retireDeletedDocumentOwner"), context);
  const retirementGate = data => {
    try { return context.retireDeletedDocumentOwner({}, data); }
    catch (error) {
      if (error.message === "MUTATION-REACHED") return { mutationReached: true };
      throw error;
    }
  };
  const stale = retirementGate({
    acknowledgedDeletion: true, expectedDeletionRevision: 10,
  });
  check("retirement rejects evidence changed during the async close", stale.why === "deletion-evidence-changed");
  const absent = retirementGate({ acknowledgedDeletion: true });
  check("retirement cannot acknowledge evidence without a revision", absent.why === "deletion-evidence-changed");
  check("the exact current acknowledged revision reaches the existing retirement", retirementGate({
    acknowledgedDeletion: true, expectedDeletionRevision: 11,
  }).mutationReached === true);
  state.unresolved = false;
  check("unacknowledged clean close does not need a revision", retirementGate({
    acknowledgedDeletion: false,
  }).mutationReached === true);
}

async function checkMainContinuations() {
  const dirname = path.join(__dirname, "..", "src");
  const source = fs.readFileSync(path.join(dirname, "main.js"), "utf8").replace(/\r\n/g, "\n");
  const frame = { isDestroyed: () => false };
  const messages = [];
  const ownerSender = {
    mainFrame: frame, isDestroyed: () => false,
    send: (channel, value) => messages.push({ channel, value }),
  };
  const owner = { webContents: ownerSender, isDestroyed: () => false };
  let nativeCount = 0;
  let invalidateFallback = false;
  const presentation = {
    approvalRendererGeneration: 1, approvalRendererPageSession: "page",
    approvalRendererState: "ready", console: { error: () => {} },
    ownerRendererAvailable: () => true,
    AbortController, setInterval, clearInterval,
    mainDialogs: () => ({
      show: async (_owner, options) => options.onFailure({
        response: options.cancelId, cause: "cancel", failed: true,
      }),
    }),
    dialog: {
      showMessageBox: async (_owner, options) => {
        nativeCount += 1;
        if (invalidateFallback) presentation.approvalRendererGeneration += 1;
        return { response: options.buttons.length === 2 && options.cancelId === 1 ? 0 : 1 };
      },
    },
  };
  vm.createContext(presentation);
  vm.runInContext(extract(source, "showOwnedMessage"), presentation);
  const warning = { title: "Guard", message: "Continue?", buttons: ["Proceed", "Cancel"], defaultId: 1, cancelId: 1 };
  let outcome = await presentation.showOwnedMessage(owner, warning);
  check("routine presentation failure cancels without a native second prompt",
    outcome.failed && outcome.response === 1 && nativeCount === 0);
  check("routine presentation failure has an explicit error channel",
    messages.some(message => message.channel === "show-error"));
  outcome = await presentation.showOwnedMessage(owner, warning, "shutdown");
  check("only eligible shutdown presentation failure can use emergency native consent",
    outcome.emergency && outcome.cause === "choice" && nativeCount === 1);
  invalidateFallback = true;
  outcome = await presentation.showOwnedMessage(owner, warning, "shutdown");
  check("an emergency fallback cannot approve after owner generation changes",
    outcome.response === 1 && outcome.cause === "stale");
  let independentOptions;
  presentation.mainDialogs = () => ({
    show: async (_owner, options) => {
      independentOptions = options;
      return { response: 1, cause: "choice", displayed: true };
    },
  });
  frame.isDestroyed = () => true;
  outcome = await presentation.showOwnedMessage(owner, warning, "shutdown");
  check("Main retains a shutdown question on its window after the document frame is disposed",
    independentOptions?.allowUnavailableRenderer === true && outcome.cause === "choice");
  independentOptions = null;
  outcome = await presentation.showOwnedMessage(owner, warning);
  check("ordinary file consent still requires a live owning document",
    independentOptions === null && outcome.cause === "stale");
  let thawSends = 0;
  const thawContext = {
    shutdownCommitIngressBlocked: true,
    foliaUpdaterAttemptRetainsFreeze: () => false,
    shutdownOwnerWindow: () => ({
      webContents: {
        isDestroyed: () => false, isCrashed: () => true,
        send: () => { thawSends += 1; },
      },
    }),
    ownerRendererAvailable, QUIT_APPROVAL_THAW: "thaw",
  };
  vm.createContext(thawContext);
  vm.runInContext(extract(source, "releaseShutdownFreeze"), thawContext);
  thawContext.releaseShutdownFreeze();
  check("Main clears its freeze without sending thaw to a crashed renderer",
    thawContext.shutdownCommitIngressBlocked === false && thawSends === 0);
  let resolveQuestion;
  let settled;
  const shutdown = {
    AbortController, shutdownOwnerWindow: () => ({}),
    shutdownQuestionConsumers: new WeakMap(),
    pendingShutdown: null, deletionEvidenceCapacityLatched: false,
    deletionEvidenceRevision: 6, staleShutdownDialogCompletionCount: 0,
    deletionEvidenceTombstoneFileLabels: () => [], log: () => {},
    showOwnedMessage: () => new Promise(resolve => { resolveQuestion = resolve; }),
    settleShutdown: (_record, approved) => { settled = approved; },
    askDeletionEvidenceCapacityApproval: () => { settled = "stronger-question"; },
  };
  vm.createContext(shutdown);
  vm.runInContext(extract(source, "askShutdownQuestion"), shutdown);
  const question = { title: "Close", confirmLabel: "Discard", message: "Unsaved work", why: "test" };
  const ask = () => {
    settled = undefined;
    const record = {};
    shutdown.pendingShutdown = record;
    shutdown.askShutdownQuestion(record, question);
    return record;
  };
  ask();
  resolveQuestion({ response: 0, cause: "cancel" });
  await delay(0);
  check("shutdown cannot interpret lifecycle cancellation as discard", settled === false);
  ask();
  resolveQuestion({ response: 0, cause: "choice" });
  await delay(0);
  check("shutdown retains explicit discard outcome", settled === true);
  ask();
  shutdown.pendingShutdown = {};
  resolveQuestion({ response: 0, cause: "choice" });
  await delay(0);
  check("a late shutdown answer cannot settle a replacement request",
    settled === undefined && shutdown.staleShutdownDialogCompletionCount === 1);
  ask();
  shutdown.deletionEvidenceCapacityLatched = true;
  resolveQuestion({ response: 0, cause: "choice" });
  await delay(0);
  check("a newly blocked save authority forces the stronger shutdown question", settled === "stronger-question");

  const fixture = path.join(artifacts, "external.owned-unknown");
  const sender = { isDestroyed: () => false, send: () => {} };
  const bootstrap = { used: true, nonce: "private-test-nonce" };
  const admission = { descriptor: { documentUrl: pathToFileURL(fixture).href } };
  const handlers = new Map();
  let openCount = 0;
  const external = {
    fs, path, pathToFileURL, __dirname: dirname,
    SUPPORTED_EXTENSIONS: { markdown: [".md"], mermaid: [".mmd"] },
    fileURLToPath: require("url").fileURLToPath, process,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    privateSessionBootstraps: new WeakMap([[sender, bootstrap]]),
    isApprovalSender: () => true, approvalRendererState: "ready",
    approvalRendererGeneration: 4, approvalRendererPageSession: "page",
    shutdownCommitIngressBlocked: false, watchedOwner: {}, watchedFilePath: fixture,
    admittedDocumentReference: () => admission,
    sameDocumentOwner: (left, right) => left === right,
    BrowserWindow: { fromWebContents: () => ({}) },
    showOwnedMessage: () => new Promise(resolve => { resolveQuestion = resolve; }),
    shell: { openPath: async () => { openCount += 1; return ""; } },
  };
  vm.createContext(external);
  vm.runInContext(extract(source, "diskVersionFromStats") + "\n" +
    extract(source, "diskVersionChanged"), external);
  const start = source.indexOf("const TRUSTED_LINK_EXECUTABLE_EXTS");
  const end = source.indexOf("\nfunction documentSessionFiles()", start);
  vm.runInContext(source.slice(start, end), external);
  const gesture = handlers.get("private-trusted-document-gesture");
  const event = { sender, senderFrame: { url: pathToFileURL(path.join(dirname, "index.html")).href } };
  const data = { nonce: bootstrap.nonce, kind: "link", href: fixture, documentRef: "owned" };
  fs.writeFileSync(fixture, "original");
  let answer = gesture(event, data);
  resolveQuestion({ response: 1, cause: "choice" });
  check("external confirmation opens its unchanged retained target", await answer && openCount === 1);
  const beforeChanged = openCount;
  answer = gesture(event, data);
  fs.writeFileSync(fixture, "changed while the question was open");
  resolveQuestion({ response: 1, cause: "choice" });
  check("external confirmation refuses a file changed during the question", !await answer && openCount === beforeChanged);
  const beforeGeneration = openCount;
  answer = gesture(event, data);
  external.approvalRendererGeneration += 1;
  resolveQuestion({ response: 1, cause: "choice" });
  check("external confirmation cannot cross a page generation", !await answer && openCount === beforeGeneration);
  const beforeSelection = openCount;
  answer = gesture(event, data);
  external.watchedOwner = {};
  resolveQuestion({ response: 1, cause: "choice" });
  check("external confirmation cannot cross a document selection", !await answer && openCount === beforeSelection);
  const beforeFreeze = openCount;
  answer = gesture(event, data);
  external.shutdownCommitIngressBlocked = true;
  resolveQuestion({ response: 1, cause: "choice" });
  check("external confirmation cannot cross frozen shutdown", !await answer && openCount === beforeFreeze);
  external.shutdownCommitIngressBlocked = false;
  const beforeClassification = openCount;
  answer = gesture(event, data);
  fs.unlinkSync(fixture);
  fs.mkdirSync(fixture);
  resolveQuestion({ response: 1, cause: "choice" });
  check("external confirmation refuses changed target classification", !await answer && openCount === beforeClassification);
  fs.rmdirSync(fixture);
}

async function checkMainPostOpen() {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8")
    .replace(/\r\n/g, "\n");
  const fixture = path.join(artifacts, "delayed-large.md");
  const frame = { isDestroyed: () => false };
  const sender = { mainFrame: frame, isDestroyed: () => false };
  const owner = { webContents: sender, isDestroyed: () => false };
  let approve;
  let deliveries;
  let remembered;
  let refusals;
  const context = {
    path, fs, BrowserWindow: { fromWebContents: () => owner },
    mainWindow: owner, approvalRendererGeneration: 3,
    approvalRendererPageSession: "page", approvalRendererState: "ready",
    shutdownCommitIngressBlocked: false, fileOpenDeliveryEpoch: 0,
    log: () => {}, resolveCanonicalFilePath: value => fs.realpathSync.native(value),
    readDocumentStats: value => fs.statSync(value),
    markdownSnapshotPromise: async value => ({
      content: fs.readFileSync(value, "utf8"), modifiedTime: fs.statSync(value).mtimeMs,
      diskVersion: context.diskVersionFromStats(fs.statSync(value)),
      physical: { readTarget: fs.realpathSync.native(value) },
    }),
    confirmLargeDocument: () => new Promise(resolve => { approve = resolve; }),
    rememberDocumentModifiedTime: () => { remembered += 1; },
    safeSendFileOpen: () => { deliveries += 1; return true; },
    sendFileOpenFailure: (_sender, _path, _request, why) => { refusals.push(why); },
  };
  vm.createContext(context);
  for (const name of ["diskVersionFromStats", "diskVersionChanged", "captureFileOpenDelivery",
    "fileOpenSnapshotIsCurrent", "openFile"]) {
    vm.runInContext(extract(source, name), context);
  }
  async function delayedOpen(change) {
    fs.writeFileSync(fixture, "# Original snapshot");
    approve = null;
    deliveries = 0;
    remembered = 0;
    refusals = [];
    context.openFile(fixture, { sender });
    await waitFor(() => approve, "retained large-file question");
    if (change) fs.writeFileSync(fixture, "# A different later snapshot and length");
    approve(true);
    await waitFor(() => deliveries > 0 || refusals.length > 0, "large-file decision delivery");
  }
  await delayedOpen(false);
  check("large-file approval still delivers an unchanged retained snapshot",
    deliveries === 1 && remembered === 1 && refusals.length === 0);
  await delayedOpen(true);
  check("large-file approval cannot deliver bytes whose disk snapshot changed",
    deliveries === 0 && remembered === 0 && refusals.includes("superseded-open"));
}

async function checkMainPresentationHandlers(broker, owner, displayed, choose) {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8")
    .replace(/\r\n/g, "\n");
  const handlers = new Map();
  let attempts = 0;
  let autoCancel = false;
  const context = {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow, shutdownOwnerWindow: () => owner,
    approvalRendererGeneration: 7, approvalRendererPageSession: "page",
    shutdownCommitIngressBlocked: false, log: () => {},
    showOwnedMessage: (target, options) => {
      attempts += 1;
      return autoCancel ? Promise.resolve({ response: 1, cause: "choice" }) : broker.show(target, options);
    },
  };
  vm.createContext(context);
  vm.runInContext(extract(source, "isApprovalSender") + "\n" +
    extract(source, "askAboutLargeDocument"), context);
  const start = source.indexOf('ipcMain.handle("confirm-large-render"');
  const end = source.indexOf("\nfunction captureFileOpenDelivery(", start);
  vm.runInContext(source.slice(start, end), context);
  const confirm = handlers.get("confirm-large-render");
  const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame };
  const answer = confirm(event, { name: "Retained file.md", seconds: 12 });
  const request = await displayed();
  check("Main large-render handler preserves exact title and Cancel metadata",
    request.presentation.title === "Large document" && request.presentation.defaultId === 1 &&
    request.presentation.cancelId === 1 && request.presentation.message.includes("Retained file.md") &&
    request.presentation.detail === "Markaloo may not respond until the document finishes opening.");
  await choose(request, 0);
  check("Main large-render handler has a real successful isolated child control", await answer === true);
  autoCancel = true;
  const foreign = new BrowserWindow({
    show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await foreign.loadURL("data:text/html,<title>Foreign Main caller</title>");
  attempts = 0;
  const foreignReply = await confirm({
    sender: foreign.webContents, senderFrame: foreign.webContents.mainFrame,
  }, { name: "Foreign.md", seconds: 12 });
  check("Main large-render handler refuses an actual foreign window before presentation work",
    foreignReply === false && attempts === 0);
  foreign.destroy();
  attempts = 0;
  const malformed = [
    null, [], { name: "bad", seconds: "12" }, { name: "bad", seconds: -1 },
    { name: "x".repeat(1025), seconds: 12 }, { name: "bad\0name", seconds: 12 },
  ];
  const replies = [];
  for (const value of malformed) replies.push(await confirm(event, value));
  check("Main large-render handler refuses malformed metadata before presentation work",
    replies.every(value => value === false) && attempts === 0);

  let notices = 0;
  let noticeOwner;
  const download = {
    session, mainWindow: owner, popupKinds: new Map(),
    deletionEvidenceCapacityLatched: false, deletionEvidenceCapacityDownloadNoticeShown: false,
    saveAuthorityLatchWriteError: "test safety latch", noteDeletionEvidenceCapacityRefusal: () => {},
    console: { warn: () => {}, error: () => {} },
    notifyDeletionEvidenceCapacityDownloadBlocked: retainedOwner => {
      notices += 1; noticeOwner = retainedOwner; return true;
    },
  };
  vm.createContext(download);
  vm.runInContext(extract(source, "isDownloadAllowed"), download);
  const original = new Set(session.defaultSession.listeners("will-download"));
  const downloadStart = source.indexOf("    // The independent dialog host has its own deny-all download session.");
  const downloadEnd = source.indexOf("\n    createWindow();", downloadStart);
  vm.runInContext(source.slice(downloadStart, downloadEnd), download);
  try {
    const allowed = download.isDownloadAllowed;
    check("SEC-30 the download policy admits the app's blob: exports and nothing else",
      allowed("blob:file:///owned") && !allowed("https://example.invalid") &&
      !allowed("file:///owned") && !allowed(undefined));
    check("SEC-30 the download policy is wired to the default session",
      session.defaultSession.listeners("will-download").some(listener => !original.has(listener)));
    let cancelled = false;
    session.defaultSession.emit("will-download", { preventDefault: () => { cancelled = true; } },
      { getURL: () => "https://example.invalid" }, owner.webContents);
    check("Main download policy wiring cancels a forbidden URL without dispatching a notice",
      cancelled && notices === 0);
    cancelled = false;
    download.deletionEvidenceCapacityLatched = true;
    session.defaultSession.emit("will-download", { preventDefault: () => { cancelled = true; } },
      { getURL: () => "blob:file:///owned" }, owner.webContents);
    check("Main blocked export keeps its exact original root owner and remains cancelled",
      cancelled && notices === 1 && noticeOwner === owner);
  } finally {
    for (const listener of session.defaultSession.listeners("will-download")) {
      if (!original.has(listener)) session.defaultSession.removeListener("will-download", listener);
    }
  }
}

async function checkProductionBridge() {
  const nonce = "b".repeat(64);
  let resolveLarge;
  let largeRequest;
  const themes = [];
  const bootstrap = event => { event.returnValue = true; };
  ipcMain.on("bootstrap-legacy-document-session", bootstrap);
  ipcMain.handle("quit-approval-generation", () => 9);
  ipcMain.handle("private-publish-dialog-theme", (_event, data) => {
    themes.push(data);
    return true;
  });
  ipcMain.handle("confirm-large-render", (_event, data) => {
    largeRequest = data;
    return new Promise(resolve => { resolveLarge = resolve; });
  });
  const html = path.join(artifacts, "bridge.html");
  fs.writeFileSync(html, "<!doctype html><title>Production preload bridge</title>");
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, "..", "src", "main-preload.js"),
      additionalArguments: [`--folia-session-bootstrap=${nonce}`],
    },
  });
  try {
    await win.loadFile(html);
    const promise = await win.webContents.executeJavaScript(`(() => {
      window.largeAnswer = folia.confirmLargeRender({name:"guard.md",seconds:4,ignored:"not forwarded"});
      return typeof window.largeAnswer.then === "function";
    })()`);
    await waitFor(() => resolveLarge, "fixed large-render invoke");
    check("production large-render bridge is asynchronous and sends only fixed metadata",
      promise && Object.keys(largeRequest).sort().join(",") === "name,seconds");
    resolveLarge(false);
    check("production large-render bridge preserves cancellation",
      await win.webContents.executeJavaScript("window.largeAnswer") === false);
    check("production large-render bridge refuses malformed metadata before IPC",
      await win.webContents.executeJavaScript(`folia.confirmLargeRender({name:"x",seconds:"bad"})
        .then(()=>false,()=>true)`));
    win.webContents.send("main-dialog-visibility", true);
    await delay(30);
    let values = await win.webContents.executeJavaScript(`(() => {
      window.busyAnswers=[];
      window.removeBusy=folia.onMainDialogVisibility(value=>window.busyAnswers.push(value));
      return window.busyAnswers;
    })()`);
    check("a late visibility subscriber receives the current Main hold", values.length === 1 && values[0] === true);
    win.webContents.send("main-dialog-visibility", false);
    await delay(30);
    values = await win.webContents.executeJavaScript("window.busyAnswers");
    check("visibility bridge publishes fixed boolean changes", values.length === 2 && values[1] === false);
    await win.webContents.executeJavaScript("window.removeBusy()");
    win.webContents.send("main-dialog-visibility", true);
    await delay(30);
    values = await win.webContents.executeJavaScript("window.busyAnswers");
    check("visibility bridge unsubscribe removes only that callback", values.length === 2);
    await win.webContents.executeJavaScript(`folia.publishDialogTheme("parchment");folia.publishDialogTheme("ember")`);
    await waitFor(() => themes.length > 0, "private appearance publication");
    check("theme publication carries only private bootstrap, generation and allow-listed appearance",
      themes.at(-1).themeId === "ember" && themes.at(-1).nonce === nonce &&
      themes.at(-1).rendererGeneration === 9 &&
      Object.keys(themes.at(-1)).sort().join(",") === "nonce,rendererGeneration,themeId");
    check("theme publication refuses arbitrary strings",
      await win.webContents.executeJavaScript(`(() => {
        try { folia.publishDialogTheme("url(file:///other)");return false; } catch {return true;}
      })()`));
  } finally {
    win.destroy();
    ipcMain.removeListener("bootstrap-legacy-document-session", bootstrap);
    for (const channel of ["quit-approval-generation", "private-publish-dialog-theme", "confirm-large-render"]) {
      ipcMain.removeHandler(channel);
    }
  }
}

async function checkRendererLoss(broker, options, choose) {
  const makeOwner = async title => {
    const owner = new BrowserWindow({
      show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await owner.loadURL("data:text/html," + encodeURIComponent(`<title>${title}</title>`));
    return owner;
  };
  const displayedFor = async owner => {
    await waitFor(() => broker.owners.get(owner)?.active?.displayed, "renderer-loss dialog displayed");
    return broker.owners.get(owner).active;
  };
  const crash = async owner => {
    const gone = new Promise(resolve => owner.webContents.once("render-process-gone", resolve));
    owner.webContents.forcefullyCrashRenderer();
    await gone;
  };
  const owner = await makeOwner("Independent questions during document loss");
  const independent = { ...options, allowUnavailableRenderer: true, isCurrent: () => true };
  const activeAnswer = broker.show(owner, independent);
  let activeSettled = false;
  activeAnswer.then(() => { activeSettled = true; });
  await waitFor(() => broker.owners.get(owner)?.active?.displayed || activeSettled,
    "independent renderer-loss fixture displayed or refused");
  const active = broker.owners.get(owner)?.active;
  if (!active?.displayed) {
    check("renderer-loss fixture has a displayed independent host and three queued requests", false);
    owner.destroy();
    await activeAnswer;
    return;
  }
  const queuedAnswer = broker.show(owner, { ...independent, title: "Retained queued question" });
  const queued = broker.owners.get(owner).queue[0];
  const ordinaryAnswer = broker.show(owner, { ...options, title: "Document-bound queued question" });
  let expiredAuthority = true;
  const expiredAnswer = broker.show(owner, {
    ...independent, title: "Expired Main authority", isCurrent: () => expiredAuthority,
  });
  const expired = broker.owners.get(owner).queue[2];
  check("renderer-loss fixture has a displayed independent host and three queued requests",
    active.displayed && !active.window.isDestroyed() && !queued.window &&
    broker.owners.get(owner).queue.length === 3 && !owner.webContents.isCrashed() &&
    expired?.currentTimer && !expired.done);
  clearInterval(expired.currentTimer);
  expired.currentTimer = null;
  let expiredAtRendererLoss = false;
  owner.webContents.once("render-process-gone", () => {
    expiredAtRendererLoss = expired.done && !broker.owners.get(owner)?.queue.includes(expired);
  });
  expiredAuthority = false;
  await crash(owner);
  check("a displayed independent question survives its owner's renderer loss",
    owner.webContents.isCrashed() && !active.done && !active.window.isDestroyed() &&
    broker.owners.get(owner)?.active === active && broker.current(active));
  check("a queued independent question survives its owner's renderer loss",
    !queued.done && !queued.window && broker.owners.get(owner)?.queue.includes(queued) &&
    broker.current(queued));
  const ordinaryResult = await ordinaryAnswer;
  check("renderer loss cancels queued document-bound consent",
    ordinaryResult.response === options.cancelId && ordinaryResult.cause === "stale");
  const expiredResult = expired.done ? await expiredAnswer : null;
  check("renderer loss cancels independent consent whose Main authority expired",
    expiredAtRendererLoss && expiredResult?.response === options.cancelId && expiredResult.cause === "stale");
  if (!expired.done) broker.finish(expired, expired.cancelId, false, "stale");
  await expiredAnswer;
  if (!active.done) await choose(active, 0);
  const activeResult = await activeAnswer;
  check("a displayed independent question accepts an explicit current choice after renderer loss",
    activeResult.response === 0 && activeResult.cause === "choice");
  if (!queued.done) {
    await waitFor(() => queued.displayed || queued.done, "retained queued question displayed");
    if (!queued.done) await choose(queued, 0);
  }
  const queuedResult = await queuedAnswer;
  check("a queued independent question accepts an explicit current choice after renderer loss",
    queuedResult.response === 0 && queuedResult.cause === "choice");
  owner.destroy();

  const ordinaryOwner = await makeOwner("Displayed document-bound question");
  const ordinaryDisplayedAnswer = broker.show(ordinaryOwner, options);
  const ordinaryDisplayed = await displayedFor(ordinaryOwner);
  const followingAnswer = broker.show(ordinaryOwner, independent);
  const following = broker.owners.get(ordinaryOwner).queue[0];
  check("document-bound crash fixture has a real displayed host and independent queued control",
    ordinaryDisplayed.displayed && !ordinaryDisplayed.window.isDestroyed() && !following.window &&
    !ordinaryOwner.webContents.isCrashed());
  await crash(ordinaryOwner);
  const ordinaryDisplayedResult = await ordinaryDisplayedAnswer;
  check("renderer loss cancels displayed document-bound consent",
    ordinaryDisplayedResult.response === options.cancelId && ordinaryDisplayedResult.cause === "stale" &&
    ordinaryDisplayed.window.isDestroyed());
  if (!following.done) {
    await waitFor(() => following.displayed || following.done, "independent question after document cancellation");
    if (!following.done) await choose(following, 0);
  }
  const followingResult = await followingAnswer;
  check("independent queued consent stays choosable after document-bound cancellation",
    followingResult.response === 0 && followingResult.cause === "choice");
  ordinaryOwner.destroy();

  const revokedOwner = await makeOwner("Independent owner revocation");
  const navigationActiveAnswer = broker.show(revokedOwner, independent);
  const navigationActive = await displayedFor(revokedOwner);
  const navigationQueuedAnswer = broker.show(revokedOwner, independent);
  check("independent navigation fixture has both displayed and queued questions",
    navigationActive.displayed && broker.owners.get(revokedOwner).queue.length === 1);
  await revokedOwner.loadURL("data:text/html,<title>Committed replacement page</title>");
  const navigationResults = await Promise.all([navigationActiveAnswer, navigationQueuedAnswer]);
  check("committed navigation cancels displayed and queued independent questions",
    navigationResults.every(value => value.response === options.cancelId && value.cause === "stale") &&
    navigationActive.window.isDestroyed() && !broker.owners.has(revokedOwner));
  const destructionActiveAnswer = broker.show(revokedOwner, independent);
  const destructionActive = await displayedFor(revokedOwner);
  const destructionQueuedAnswer = broker.show(revokedOwner, independent);
  check("independent destruction fixture has both displayed and queued questions",
    destructionActive.displayed && broker.owners.get(revokedOwner).queue.length === 1);
  revokedOwner.destroy();
  const destructionResults = await Promise.all([destructionActiveAnswer, destructionQueuedAnswer]);
  check("owner destruction cancels displayed and queued independent questions",
    destructionResults.every(value => value.response === options.cancelId &&
      ["cancel", "stale"].includes(value.cause)) &&
    destructionActive.window.isDestroyed() && !broker.owners.has(revokedOwner));
}

async function run() {
  checkMainAuthority();
  await checkMainContinuations();
  await checkMainPostOpen();
  await checkProductionBridge();
  const broker = new OwnedDialogs();
  const owner = new BrowserWindow({
    show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await owner.loadURL("data:text/html,<title>Owned dialog test</title><p>Owner</p>");
  const busy = [];
  const send = owner.webContents.send.bind(owner.webContents);
  owner.webContents.send = (channel, value, ...rest) => {
    if (channel === "main-dialog-visibility") busy.push(value);
    return send(channel, value, ...rest);
  };
  const options = {
    title: "Literal <dialog>", message: "A <script> is text, not markup.",
    detail: "Retained Main options", buttons: ["Proceed", "Cancel"], defaultId: 1, cancelId: 1,
  };
  const displayed = async () => {
    await waitFor(() => broker.owners.get(owner)?.active?.displayed, "dialog displayed");
    return broker.owners.get(owner).active;
  };
  const choose = async (request, id) => {
    let closed;
    const closing = new Promise(resolve => {
      closed = resolve;
      request.window.once("closed", closed);
    });
    try {
      // Answering destroys this renderer; its evaluation response may not arrive.
      await Promise.race([closing, request.window.webContents.executeJavaScript(
        `document.querySelector('[data-dialog-choice="${id}"]').click();true`)]);
    } finally {
      request.window.removeListener("closed", closed);
    }
  };
  broker.publishTheme(owner, "abyss");
  let answer = broker.show(owner, options);
  let request = await displayed();
  const wc = request.window.webContents;
  const prefs = wc.getLastWebPreferences();
  check("independent host has sandbox and isolation, no Node", prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration);
  check("independent host does not inherit default-session test preloads", wc.session !== session.defaultSession);
  const appearance = await wc.executeJavaScript(`({
    theme: document.body.dataset.theme,
    background: getComputedStyle(document.querySelector('dialog')).backgroundColor,
    text: document.querySelector('#appMessageText').textContent,
    injected: document.querySelector('#appMessageText script') !== null,
    focused: document.activeElement.dataset.dialogChoice,
    node: typeof require
  })`);
  check("late-published actual scheme reaches the independent host", appearance.theme === "abyss");
  check("Main text is literal and cannot inject markup", appearance.text.includes("<script>") && !appearance.injected);
  check("Cancel receives initial focus", appearance.focused === "1");
  check("host document has no Node require", appearance.node === "undefined");
  const completedIdentity = { id: request.id, nonce: request.nonce };
  await choose(request, 0);
  let result = await answer;
  check("explicit current button maps to Main's retained index", result.response === 0 && result.cause === "choice");
  check("drained queue broadcasts balanced visibility", busy.join(",") === "true,false");
  await checkMainPresentationHandlers(broker, owner, displayed, choose);

  async function forgedResponse(name, eventFor, changes = {}) {
    const pendingAnswer = broker.show(owner, options);
    const pending = await displayed();
    ipcMain.emit("owned-dialog-response", eventFor(pending), {
      id: pending.id, nonce: pending.nonce, response: 0, cause: "choice", ...changes,
    });
    await delay(40);
    check(name, !pending.done);
    if (!pending.done) await choose(pending, 1);
    await pendingAnswer;
  }
  await forgedResponse("an exact nonce and id from the wrong sender cannot answer", () => ({
    sender: owner.webContents, senderFrame: owner.webContents.mainFrame,
  }));
  await forgedResponse("a wrong nonce from the actual child cannot answer", pending => ({
    sender: pending.window.webContents, senderFrame: pending.window.webContents.mainFrame,
  }), { nonce: "wrong" });
  await forgedResponse("the actual child sender cannot answer from a different frame", pending => ({
    sender: pending.window.webContents, senderFrame: { url: broker.url },
  }));
  await forgedResponse("an out-of-range choice cannot select a retained button", pending => ({
    sender: pending.window.webContents, senderFrame: pending.window.webContents.mainFrame,
  }), { response: 999 });
  await forgedResponse("an unknown disposition cannot become permission", pending => ({
    sender: pending.window.webContents, senderFrame: pending.window.webContents.mainFrame,
  }), { cause: "invented" });

  answer = broker.show(owner, { ...options, buttons: ["OK"], defaultId: 0, cancelId: 0 });
  request = await displayed();
  ipcMain.emit("owned-dialog-response", {
    sender: request.window.webContents, senderFrame: request.window.webContents.mainFrame,
  }, { ...completedIdentity, response: 0, cause: "choice" });
  await delay(40);
  check("a completed request cannot be replayed into the next dialog", !request.done);
  if (!request.done) {
    await request.window.webContents.executeJavaScript(
      `document.querySelector('dialog').dispatchEvent(new Event('cancel', {cancelable:true}))`);
  }
  result = await answer;
  check("Escape-style cancellation is not a single-button acknowledgement", result.response === 0 && result.cause === "cancel");

  let current = true;
  answer = broker.show(owner, { ...options, isCurrent: () => current });
  request = await displayed();
  current = false;
  result = await answer;
  check("a stale owner cancels without granting permission", result.response === 1 && result.cause === "stale");
  check("stale prompt is destroyed, not left behind", request.window.isDestroyed());

  answer = broker.show(owner, options);
  request = await displayed();
  const retainedFrame = owner.webContents.mainFrame;
  const retainedUrl = owner.webContents.getURL();
  owner.webContents.emit("did-navigate", {}, retainedUrl, 200, "OK");
  result = await Promise.race([answer, delay(800).then(() => null)]);
  check("committed-navigation notification cancels a retained same-frame same-URL owner",
    owner.webContents.mainFrame === retainedFrame && owner.webContents.getURL() === retainedUrl &&
    result?.cause === "stale" && request.window.isDestroyed());
  if (!request.done) await choose(request, 1);
  await answer;

  answer = broker.show(owner, options);
  request = await displayed();
  const originalUrl = owner.webContents.getURL();
  owner.webContents.reload();
  result = await Promise.race([answer, delay(800).then(() => null)]);
  await waitFor(() => !owner.webContents.isLoading(), "owner reload completed");
  check("same-URL committed owner navigation cancels the old question",
    owner.webContents.getURL() === originalUrl && result?.response === 1 && result?.cause === "stale");
  check("committed owner navigation destroys its prior child", request.window.isDestroyed());
  if (!request.done) await choose(request, 1);
  await answer;

  const abort = new AbortController();
  answer = broker.show(owner, { ...options, signal: abort.signal });
  request = await displayed();
  abort.abort();
  result = await answer;
  check("abort settles exactly as cancellation", result.response === 1 && result.cause === "aborted");

  answer = broker.show(owner, { ...options, defaultId: 99 });
  result = await answer;
  check("real helper rejection reports presentation failure, not a user answer", result.failed && !result.displayed && result.cause !== "choice");

  let releaseFallback;
  let fallbackStarted = false;
  answer = broker.show(owner, {
    ...options,
    onFailure: async () => {
      fallbackStarted = true;
      check("failed child is destroyed before emergency fallback", request.window.isDestroyed());
      return new Promise(resolve => { releaseFallback = resolve; });
    },
  });
  request = await displayed();
  const queued = broker.show(owner, { ...options, title: "Queued control" });
  request.window.emit("unresponsive");
  await waitFor(() => fallbackStarted, "fallback started");
  check("emergency fallback retains the owner's serialized queue", broker.owners.get(owner).active === request);
  check("no second themed host is raised over emergency fallback", broker.owners.get(owner).queue.length === 1);
  releaseFallback({ response: 1, cause: "cancel", displayed: true, emergency: true });
  await answer;
  const queuedRequest = await displayed();
  check("queue resumes only after fallback settles", queuedRequest.presentation.title === "Queued control");
  await choose(queuedRequest, 1);
  await queued;

  const otherOwner = new BrowserWindow({
    show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await otherOwner.loadURL("data:text/html,<title>Second owner</title>");
  answer = broker.show(owner, { ...options, title: "First FIFO" });
  const firstRequest = await displayed();
  const secondAnswer = broker.show(owner, { ...options, title: "Second FIFO" });
  const otherAnswer = broker.show(otherOwner, { ...options, title: "Independent owner" });
  await waitFor(() => broker.owners.get(otherOwner)?.active?.displayed, "other owner displayed");
  const otherRequest = broker.owners.get(otherOwner).active;
  check("a different owner has its own independent active dialog",
    broker.owners.size === 2 && broker.owners.get(owner).active === firstRequest &&
    otherRequest.window !== firstRequest.window);
  check("one owner never displays both of its queued questions",
    broker.owners.get(owner).queue.length === 1);
  await choose(firstRequest, 1);
  await answer;
  const secondRequest = await displayed();
  check("one owner's questions are presented in FIFO order", secondRequest.presentation.title === "Second FIFO");
  await choose(secondRequest, 1);
  await choose(otherRequest, 1);
  await Promise.all([secondAnswer, otherAnswer]);
  otherOwner.destroy();
  const abortQueue = new AbortController();
  const bounded = Array.from({ length: 8 }, () => broker.show(owner, {
    ...options, signal: abortQueue.signal,
  }));
  const overflow = await broker.show(owner, options);
  check("the per-owner queue is bounded and refuses overflow without approval",
    overflow.failed && overflow.response === 1 && overflow.cause !== "choice" &&
    broker.owners.get(owner).queue.length === 7);
  abortQueue.abort();
  const cancelledQueue = await Promise.all(bounded);
  check("aborting a full owner queue cannot display or approve its remaining questions",
    cancelledQueue.every(item => item.response === 1 && item.cause !== "choice") &&
    broker.owners.size === 0);

  await checkRendererLoss(broker, options, choose);

  const paletteProbe = new BrowserWindow({
    show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const backgrounds = {
    "default-light": "rgb(245, 245, 245)", clarity: "rgb(246, 248, 250)",
    parchment: "rgb(244, 239, 228)", "default-dark": "rgb(26, 26, 26)",
    abyss: "rgb(17, 21, 28)", ember: "rgb(28, 27, 24)",
  };
  for (const scheme of Object.keys(backgrounds)) {
    const theme = popupTheme(scheme);
    check(`popup ${scheme} uses canonical tokens and bundled font data`,
      theme.css.includes("--bg-primary:") && theme.css.includes("data:font/ttf;base64,") &&
      !theme.css.includes("url('../fonts/"));
    await paletteProbe.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
      `<style>${theme.css}body{background:var(--bg-primary)}</style><body ${theme.attributes}>Palette</body>`));
    const actual = await paletteProbe.webContents.executeJavaScript(`document.fonts.ready.then(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      family: getComputedStyle(document.body).fontFamily,
      font: document.fonts.check('14px "Fira Code Local"')
    }))`);
    check(`popup ${scheme} actually paints the selected canonical scheme and font`,
      actual.background === backgrounds[scheme] && actual.family.includes("Fira Code Local") && actual.font);
  }
  paletteProbe.destroy();
  const crashedOwner = new BrowserWindow({
    show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await crashedOwner.loadURL("data:text/html,<title>Disposable renderer failure</title>");
  broker.publishTheme(crashedOwner, "abyss");
  const crashed = new Promise(resolve => crashedOwner.webContents.once("render-process-gone", resolve));
  crashedOwner.webContents.forcefullyCrashRenderer();
  await crashed;
  let crashAnswer;
  const crashPending = broker.show(crashedOwner, { ...options, allowUnavailableRenderer: true });
  crashPending.then(value => { crashAnswer = value; });
  let crashRequest;
  for (let attempt = 0; attempt < 100 && !crashAnswer; attempt += 1) {
    const candidate = broker.owners.get(crashedOwner)?.active;
    if (candidate?.displayed) { crashRequest = candidate; break; }
    await delay(20);
  }
  const crashTheme = crashRequest ? await crashRequest.window.webContents.executeJavaScript(
    "document.body.dataset.theme") : null;
  check("a crashed document still has an independent emergency host in its cached scheme",
    crashedOwner.webContents.isCrashed() && crashTheme === "abyss");
  if (crashRequest && !crashRequest.done) await choose(crashRequest, 1);
  await crashPending;
  crashedOwner.destroy();
  answer = broker.show(owner, options);
  request = await displayed();
  owner.destroy();
  result = await answer;
  check("owner destruction cannot produce a positive answer", result.response === 1 && result.cause !== "choice");
  check("owner destruction leaves no child or queued request", request.window.isDestroyed() && broker.owners.size === 0);
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
}

app.whenReady().then(run).then(() => {
  clearTimeout(watchdog);
  app.exit(failed ? 1 : 0);
}, error => {
  clearTimeout(watchdog);
  console.error(error.stack || error);
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  app.exit(1);
});
