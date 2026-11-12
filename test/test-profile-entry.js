"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { test } = require("node:test");
const { createLocalStorageValidator, CHILD_ARGUMENT } =
  require("../src/profile-migration-validation");

const ROOT = path.resolve(__dirname, "..");
const MAIN = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const closingStateStart = MAIN.indexOf("const startupClosingState = {");
const consumerStart = closingStateStart >= 0 ? closingStateStart :
  MAIN.indexOf("function handleFileArgument(");
const consumerEnd = MAIN.indexOf('\nipcMain.on("request-open-file"', consumerStart);
assert(consumerStart >= 0 && consumerEnd > consumerStart);
const consumerSource = MAIN.slice(consumerStart, consumerEnd);
const quitStart = MAIN.indexOf('app.on("before-quit", (event) => {');
const quitEnd = MAIN.indexOf("\n// ============================================", quitStart);
assert(quitStart >= 0 && quitEnd > quitStart);
const beforeQuitSource = MAIN.slice(quitStart, quitEnd);
const windowCloseStart = MAIN.indexOf('  win.on("close", (event) => {',
  MAIN.indexOf("function attachShutdownGuards(win)"));
const windowCloseEnd = MAIN.indexOf("\n  });", windowCloseStart) + "\n  });".length;
assert(windowCloseStart >= 0 && windowCloseEnd > windowCloseStart);
const windowCloseSource = MAIN.slice(windowCloseStart, windowCloseEnd);
const navigationStart = MAIN.indexOf('  wc.on("did-navigate", () => {',
  MAIN.indexOf("function attachShutdownGuards(win)"));
const navigationEnd = MAIN.indexOf("\n  });", navigationStart) + "\n  });".length;
assert(navigationStart >= 0 && navigationEnd > navigationStart);
const navigationSource = MAIN.slice(navigationStart, navigationEnd);
const responsiveStart = MAIN.indexOf('  win.on("responsive", () => {',
  MAIN.indexOf("function attachShutdownGuards(win)"));
const responsiveEnd = MAIN.indexOf("\n  });", responsiveStart) + "\n  });".length;
assert(responsiveStart >= 0 && responsiveEnd > responsiveStart);
const responsiveSource = MAIN.slice(responsiveStart, responsiveEnd);
const nativeStart = MAIN.indexOf("function deliverNativeDocumentIntent(");
const nativeEnd = MAIN.indexOf('\nipcMain.handle("accept-native-document-ticket"', nativeStart);
assert(nativeStart >= 0 && nativeEnd > nativeStart);
const nativeSource = [
  MAIN.match(/const STARTUP_DOCUMENT_DEADLINE_MS = \d+;/)[0],
  ...["nativeDocumentNow", "expireNativeDocumentTicket", "scheduleNativeDocumentDeadline"]
    .map(mainFunction),
  MAIN.slice(nativeStart, nativeEnd),
].join("\n");
const thawStart = MAIN.indexOf("function releaseShutdownFreeze(");
const thawEnd = MAIN.indexOf("\nipcMain.on(QUIT_APPROVAL_COMMITTED", thawStart);
assert(thawStart >= 0 && thawEnd > thawStart);
const thawSource = MAIN.slice(thawStart, thawEnd);

function mainFunction(name) {
  const source = MAIN.replace(/\r\n/g, "\n");
  const signature = "function " + name + "(";
  const start = source.indexOf(signature);
  const end = source.indexOf("\n}\n", start);
  assert(start >= 0 && start === source.lastIndexOf(signature) && end > start,
    "One complete actual Main function: " + name);
  return source.slice(start, end + 3);
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "markaloo-entry-test-"));
  const children = [];
  t.after(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
    if (process.env.MARKALOO_ENTRY_EVIDENCE_ROOT) {
      const evidence = path.join(process.env.MARKALOO_ENTRY_EVIDENCE_ROOT, path.basename(root));
      fs.mkdirSync(evidence, { recursive: true });
      if (fs.existsSync(trace)) fs.copyFileSync(trace, path.join(evidence, "trace.json"));
      for (const [index, child] of children.entries()) {
        fs.writeFileSync(path.join(evidence, "child-" + index + ".stderr.log"), child.stderr());
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const appData = path.join(root, "appdata");
  fs.mkdirSync(appData);
  const cwd = path.join(root, "cwd");
  fs.mkdirSync(cwd);
  for (const name of ["initial.md", "second.md", "forwarded.md", "finder.md"]) {
    fs.writeFileSync(path.join(cwd, name), "# " + name);
  }
  const config = {
    root, appData, cwd, repo: ROOT, consumerSource, beforeQuitSource, windowCloseSource, nativeSource,
    thawSource, approvedCloseSource: ["quitApprovedApp", "closeApprovedWindow"]
      .map(mainFunction).join("\n"),
    packaged: false, relocated: false, branch: null, ...options,
  };
  const script = path.join(root, "fixture.cjs");
  const trace = path.join(root, "trace.json");
  fs.writeFileSync(script, `
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const config = ${JSON.stringify(config)};
const traceFile = ${JSON.stringify(trace)};
const trace = { events: [], delivered: [], pathReads: [], main: 0, singleton: 0, ready: false };
function save() { fs.writeFileSync(traceFile, JSON.stringify(trace)); }
function mark(kind, details = {}) { trace.events.push({ kind, ...details }); save(); }
const paths = new Map([
  ["appData", config.appData],
  ["userData", config.relocated ? path.join(config.root, "selected-profile") :
    path.join(config.appData, "Markaloo")],
  ["sessionData", path.join(config.root, "initial-session")],
]);
if (config.relocated) fs.mkdirSync(paths.get("userData"));
const app = Object.assign(new EventEmitter(), {
  isPackaged: config.packaged,
  isReady: () => trace.ready,
  whenReady() {
    return trace.ready ? Promise.resolve() : new Promise(resolve => app.once("ready", resolve));
  },
  getName: () => "Markaloo",
  getPath(key) { trace.pathReads.push(key); save(); return paths.get(key); },
  setPath(key, value) {
    if (!config.ignoreSetPath) paths.set(key, value);
    mark("setPath", { key, value });
  },
  requestSingleInstanceLock() {
    trace.singleton++;
    const records = path.join(config.appData, ".markaloo-startup");
    const published = fs.existsSync(records) && fs.readdirSync(records).some(name =>
      name.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(records, name))).pid === process.pid);
    mark("singleton", { published, profileExists: fs.existsSync(paths.get("userData")) });
    return true;
  },
  exit(code) { trace.exitCode = code; save(); process.exit(code); },
  quit() {
    mark("quit");
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.emit("before-quit", event);
    if (event.defaultPrevented) { mark("quit-prevented"); return; }
    app.emit("will-quit", event);
    if (event.defaultPrevented) { mark("quit-prevented"); return; }
    mark("quit-committed");
    process.exit(0);
  },
});
const electron = { app };
const originalLoad = Module._load;
let startup;
let context;
let window = null;
let shutdownApproved = false;
function main() {
  trace.main++;
  mark("main", { beforeReady: !trace.ready });
  context = startup.getMainStartup(app);
  const sandbox = {
    path, fs, log() {}, startupContext: context, mainWindow: window,
    dialog: { async showMessageBox(options) {
      mark("native-startup-warning", { message: options.message });
      return { response: 0 };
    } },
    app, createWindow() { throw new Error("unexpected automatic window creation"); },
    isMarkdownFile: file => /\\.(md|mmd|mermaid)$/i.test(file),
    deliverNativeDocumentIntent(_target, file) {
      if (config.blockDelivery) return false;
      trace.delivered.push(file); save(); return true;
    },
    updaterQuitBoundary: null, clearImmediate,
    nativeDocumentOpenTickets: new Map(),
    startupDocuments: { classified: new WeakMap(), pending: new Map() },
    // Lifecycle-only recipient: successful delivery represents an immediate
    // handoff. The separate receipt suite exercises Main's real logical lane.
    queueStartupDocument(_request, file) {
      return !!sandbox.mainWindow && !sandbox.mainWindow.isDestroyed() &&
        sandbox.deliverNativeDocumentIntent(sandbox.mainWindow.webContents, file);
    },
    scheduleStartupDocumentPump() {},
    performance, setImmediate,
    crypto: require("node:crypto"), MAX_SESSION_DOCUMENTS: 512,
    approvalRendererState: "ready", approvalRendererGeneration: 1,
    approvalRendererPageSession: "owned", isApprovalSender: () => true,
    setTimeout, clearTimeout,
    hasCurrentShutdownAuthorization: () => shutdownApproved,
    revokeShutdownAuthorization() { shutdownApproved = false; mark("approval-revoked"); },
    shutdownOwnerWindow: () => window,
    shutdownCommitIngressBlocked: false,
    pendingShutdown: null, pendingShutdownCommit: null, queuedShutdown: null,
    absorbedUserShutdown: null, completeShutdownTiming() {},
    declineIntent() { throw new Error("Unexpected owned shutdown intent"); },
    isUpdaterShutdownReason: reason => reason.startsWith("update-"),
    markalooUpdaterAttemptRetainsFreeze: () => config.updaterFrozen === true,
    ownerRendererAvailable: wc => !!wc && !wc.isDestroyed(),
    QUIT_APPROVAL_THAW: "quit-approval-thaw",
    requestShutdown(reason, continuation) {
      mark("shutdown-approval", { reason, approved: !trace.unsavedText });
      if (!trace.unsavedText) { shutdownApproved = true; continuation(); }
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(config.thawSource, sandbox);
  if (config.actualNativeTickets) vm.runInContext(config.nativeSource, sandbox);
  vm.runInContext(config.consumerSource, sandbox);
  vm.runInContext(config.approvedCloseSource, sandbox);
  vm.runInContext(config.beforeQuitSource, sandbox);
  process.on("message", async message => {
    try {
      if (message.kind === "second") {
        app.emit("second-instance", {}, ["node", message.name], config.cwd);
      } else if (message.kind === "finder") {
        app.emit("open-file", { preventDefault() { mark("prevented"); } },
          path.join(config.cwd, "finder.md"));
      } else if (message.kind === "window") {
        if (!trace.ready) {
          trace.ready = true;
          app.emit("ready");
        }
        window = Object.assign(new EventEmitter(), {
          isDestroyed: () => false, isMinimized: () => false, focus() {},
          close() {
            const event = { preventDefault() { this.defaultPrevented = true; } };
            window.emit("close", event);
            if (!event.defaultPrevented) trace.windowClosed = true;
          },
          webContents: {
            isLoading: () => false, isDestroyed: () => false,
            mainFrame: { frameTreeNodeId: 1 },
            send(channel, detail) { mark("renderer-message", { channel, detail }); },
          },
        });
        sandbox.mainWindow = window;
        sandbox.win = window;
        vm.runInContext(config.windowCloseSource, sandbox);
        context.drain();
        await new Promise(resolve => setImmediate(resolve));
      } else if (message.kind === "window-close") {
        trace.closeStarted = sandbox.closeApprovedWindow(window);
      } else if (message.kind === "release-capacity") {
        config.blockDelivery = false;
        context.drain();
      } else if (message.kind === "consume-ticket") {
        const ticket = sandbox.nativeDocumentOpenTickets.keys().next().value;
        const record = sandbox.takeNativeDocumentTicket({
          sender: window.webContents, senderFrame: window.webContents.mainFrame,
        }, ticket);
        trace.consumed = !!record;
      } else if (message.kind === "unsaved") {
        trace.unsavedText = "owned unsaved edit";
      } else if (message.kind === "approved-close") {
        shutdownApproved = true;
        sandbox.shutdownCommitIngressBlocked = true;
      } else if (message.kind === "admission-error") {
        mark("runtime-owner-error", { mainLoaded: trace.main, unsavedText: trace.unsavedText });
        context.owner.emit("error", Object.assign(new Error("owned listener failure"), {
          code: "ERR_ADMISSION_PIPE",
        }));
      } else if (message.kind === "fail-close") {
        context.owner.close = () => {
          const error = Object.assign(new Error("owned close failure"), { code: "ERR_OWNED_CLOSE" });
          if (message.asynchronous) return Promise.reject(error);
          throw error;
        };
      } else if (message.kind === "close") {
        trace.closeStarted = sandbox.quitApprovedApp();
      } else if (message.kind === "will-quit-only") {
        const event = { preventDefault() { this.defaultPrevented = true; } };
        app.emit("will-quit", event);
        trace.willQuitPrevented = event.defaultPrevented === true;
        await new Promise(resolve => setImmediate(resolve));
      }
      trace.ownerPending = context.owner.pendingCount?.() ?? null;
      trace.nativePending = sandbox.nativeDocumentOpenTickets.size;
      trace.shutdownApproved = shutdownApproved;
      trace.shutdownFrozen = sandbox.shutdownCommitIngressBlocked;
      save();
      if (process.send) process.send({ event: message.kind, trace });
    } catch (error) { console.error(error.stack); process.exit(3); }
  });

}
Module._load = function(request, parent, isMain) {
  if (request === "electron") return electron;
  if (request === "./legacy-install" &&
      parent.filename === path.join(config.repo, "src", "profile-startup.js")) {
    return {
      copyClosedProfile() { throw new Error("No legacy source belongs to this entry fixture"); },
    };
  }
  if (request === "./main" && parent.filename === path.join(config.repo, "src", "profile-startup.js")) {
    main();
    return {};
  }
  const value = originalLoad.call(this, request, parent, isMain);
  if (request === "./profile-migration-validation" &&
      parent.filename === path.join(config.repo, "src", "profile-startup.js") &&
      config.validation) {
    return {
      ...value,
      prepareProfileValidationChild(options) {
        mark("child-preparation", { beforeReady: !trace.ready });
        return value.prepareProfileValidationChild({
          ...options,
          probe: async ({ profilePath }) => {
            mark("probe", {
              afterReady: trace.ready, profilePath,
              userData: app.getPath("userData"), sessionData: app.getPath("sessionData"),
            });
            fs.appendFileSync(path.join(profilePath, "Local Storage", "leveldb", "000003.log"),
              "disposable-only");
            return {
              status: "observed", storageKey: "file:///", openCount: 1, readCount: 1,
              settings: [["themeMode", "dark"], ["unknown", "private-value-never-in-trace"]],
            };
          },
        });
      },
    };
  }
  return value;
};
if (config.branch) {
  const source = fs.readFileSync(path.join(config.repo, "src", "profile-startup.js"), "utf8");
  const module = { exports: {}, filename: path.join(config.repo, "src", "profile-startup.js") };
  const requireSource = Module.createRequire(module.filename);
  const processFacade = Object.create(process);
  Object.defineProperty(processFacade, "platform", { value: config.branch });
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(name) { if (name === "./main") { main(); return {}; } return requireSource(name); },
    process: processFacade, console, Buffer, AggregateError,
  }, { filename: module.filename });
  startup = module.exports;
  const load = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "./profile-startup.js") return startup;
    return load.call(this, request, parent, isMain);
  };
} else {
  startup = require(path.join(config.repo, "src", "profile-startup.js"));
}
save();
import(pathToFileURL(path.join(config.repo, "src", "entry.mjs")).href).then(() => {
  mark("entry-evaluated", { beforeReady: !trace.ready });
  if (config.validation) {
    trace.ready = true;
    app.emit("ready");
  } else if (process.send) {
    process.send({ event: "evaluated", trace });
  }
}).catch(error => { console.error(error.stack); process.exit(4); });
`);
  return { root, appData, cwd, script, trace, children };
}

function start(t, owned, args = ["initial.md"]) {
  const child = fork(owned.script, args, {
    cwd: owned.cwd, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
  const exit = once(child, "exit");
  owned.children.push({ child, closed: once(child, "close"), stderr: () => stderr });
  function message(event) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Fixture message timed out: " + stderr)), 10000);
      const onMessage = value => { if (value.event === event) finish(null, value); };
      const onExit = () => finish(new Error("Fixture exited before " + event + ": " + stderr));
      function finish(error, value) {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        if (error) reject(error); else resolve(value);
      }
      child.on("message", onMessage);
      child.once("exit", onExit);
    });
  }
  return {
    child, exit, message, stderr: () => stderr,
    read: () => JSON.parse(fs.readFileSync(owned.trace, "utf8")),
    async send(kind, details = {}) {
      const pending = message(kind);
      child.send({ kind, ...details });
      return pending;
    },
  };
}

test("running owner error preserves unsaved work and ordinary quit approval",
  { skip: process.platform !== "win32" }, async t => {
    const owned = fixture(t);
    const run = start(t, owned);
    await run.message("evaluated");
    await run.send("window");
    await run.send("unsaved");
    const errored = await run.send("admission-error");
    assert.equal(errored.trace.unsavedText, "owned unsaved edit");
    assert(!errored.trace.events.some(event => event.kind === "quit-committed"));
    assert(errored.trace.events.some(event =>
      event.kind === "renderer-message" && event.channel === "show-error"));
    assert.equal(run.child.exitCode, null);
    await run.send("second", { name: "second.md" });
    assert.equal(run.read().delivered.length, 1, "Failed admission refuses new work");
    const quit = await run.send("close");
    assert(quit.trace.events.some(event =>
      event.kind === "shutdown-approval" && event.approved === false));
    assert.equal(quit.trace.unsavedText, "owned unsaved edit");
    assert.equal(run.child.exitCode, null);
    assert.equal(fs.readdirSync(path.join(owned.appData, ".markaloo-startup"))
      .filter(name => name.endsWith(".json")).length, 1, "Live PID fence remains");
  });

for (const blocked of [false, true]) {
  test("quit retains accepted startup work before drain, blocked=" + blocked,
    { skip: process.platform !== "win32" }, async t => {
      const owned = fixture(t, { blockDelivery: blocked });
      const run = start(t, owned);
      const evaluated = await run.message("evaluated");
      assert.equal(evaluated.trace.main, 1);
      if (blocked) await run.send("window");
      assert.deepEqual(run.read().delivered, []);
      const quit = await run.send("close");
      assert.equal(run.child.exitCode, null);
      assert(!quit.trace.events.some(event => event.kind === "quit-committed"));
      assert(quit.trace.events.some(event => event.kind === "quit-prevented"));
      await run.send("second", { name: "second.md" });
      if (!blocked) await run.send("window");
      const released = await run.send("release-capacity");
      assert.deepEqual(released.trace.delivered, ["initial.md", "second.md"]
        .map(name => path.join(owned.cwd, name)), "A held quit does not close admission");
      assert.equal(released.trace.events.filter(event => event.kind === "quit").length, 1,
        "Draining does not replay the earlier quit");
      await run.send("unsaved");
      const freshQuit = await run.send("close");
      assert(freshQuit.trace.events.some(event =>
        event.kind === "shutdown-approval" && event.approved === false));
      assert.equal(run.child.exitCode, null);
    });
}

test("owner failure after Main handoff uses a Main warning without abandoning accepted work",
  { skip: process.platform !== "win32" }, async t => {
    const owned = fixture(t);
    const run = start(t, owned);
    await run.message("evaluated");
    const failed = await run.send("admission-error");
    assert.equal(run.child.exitCode, null);
    assert.equal(failed.trace.ownerPending, 1);
    assert(!failed.trace.events.some(event => event.kind === "renderer-message"));
    assert(!failed.trace.events.some(event => event.kind === "native-startup-warning"),
      "The Main warning waits for application readiness");
    const ready = await run.send("window");
    assert.deepEqual(ready.trace.delivered, [path.join(owned.cwd, "initial.md")]);
    assert.equal(ready.trace.events.filter(event =>
      event.kind === "native-startup-warning" && /ERR_ADMISSION_PIPE/.test(event.message)).length, 1);
    assert.equal(run.child.exitCode, null);
  });

test("a final will-quit race retains accepted work and leaves the next quit guarded",
  { skip: process.platform !== "win32" }, async t => {
    const owned = fixture(t);
    const run = start(t, owned);
    await run.message("evaluated");
    const held = await run.send("will-quit-only");
    assert(held.trace.willQuitPrevented);
    assert.equal(held.trace.ownerPending, 1);
    await run.send("second", { name: "second.md" });
    const ready = await run.send("window");
    assert.deepEqual(ready.trace.delivered, ["initial.md", "second.md"]
      .map(name => path.join(owned.cwd, name)));
    await run.send("unsaved");
    const freshQuit = await run.send("close");
    assert(freshQuit.trace.events.some(event =>
      event.kind === "shutdown-approval" && event.approved === false));
    assert.equal(run.child.exitCode, null);
  });

test("window teardown waits for accepted retained opens without replay",
  { skip: process.platform !== "win32" }, async t => {
    const owned = fixture(t, { blockDelivery: true });
    const run = start(t, owned);
    await run.message("evaluated");
    await run.send("window");
    const held = await run.send("window-close");
    assert(!held.trace.windowClosed);
    assert(held.trace.events.some(event =>
      event.kind === "renderer-message" && event.channel === "show-error"));
    const released = await run.send("release-capacity");
    assert(!released.trace.windowClosed);
    await run.send("unsaved");
    const freshClose = await run.send("window-close");
    assert(!freshClose.trace.windowClosed);
    assert(freshClose.trace.events.some(event =>
      event.kind === "shutdown-approval" && event.approved === false));
  });

for (const updaterFrozen of [false, true]) {
  test("a held approved close releases only the ordinary freeze, updater=" + updaterFrozen,
    { skip: process.platform !== "win32" }, async t => {
      const owned = fixture(t, { blockDelivery: true, updaterFrozen });
      const run = start(t, owned);
      await run.message("evaluated");
      await run.send("window");
      const approved = await run.send("approved-close");
      assert(approved.trace.shutdownApproved && approved.trace.shutdownFrozen);
      const held = await run.send("window-close");
      assert(!held.trace.windowClosed);
      assert.equal(held.trace.shutdownApproved, false);
      assert.equal(held.trace.shutdownFrozen, updaterFrozen);
      const thaws = held.trace.events.filter(event =>
        event.kind === "renderer-message" && event.channel === "quit-approval-thaw");
      assert.equal(thaws.length, updaterFrozen ? 0 : 1);
      const released = await run.send("release-capacity");
      assert.equal(released.trace.delivered.length, 1);
      assert(!released.trace.windowClosed, "Settling opens must not replay the earlier close");
      await run.send("unsaved");
      const fresh = await run.send("window-close");
      assert(fresh.trace.events.some(event =>
        event.kind === "shutdown-approval" && event.approved === false));
    });
}

test("an allocated but unconsumed Main ticket still holds quit and window teardown",
  { skip: process.platform !== "win32" }, async t => {
    const owned = fixture(t, { actualNativeTickets: true });
    const run = start(t, owned);
    await run.message("evaluated");
    const ready = await run.send("window");
    assert.equal(ready.trace.ownerPending, 0);
    assert.equal(ready.trace.nativePending, 1);
    assert(ready.trace.events.some(event =>
      event.kind === "renderer-message" && event.channel === "external-file-open-request"));
    const held = await run.send("window-close");
    assert(!held.trace.windowClosed);
    const quit = await run.send("close");
    assert(!quit.trace.events.some(event => event.kind === "quit-committed"));
    const consumed = await run.send("consume-ticket");
    assert(consumed.trace.consumed);
    assert.equal(consumed.trace.nativePending, 0);
    assert(!consumed.trace.windowClosed);
    assert.equal(consumed.trace.events.filter(event => event.kind === "quit").length, 1);
    await run.send("unsaved");
    const freshQuit = await run.send("close");
    assert(freshQuit.trace.events.some(event =>
      event.kind === "shutdown-approval" && event.approved === false));
  });

for (const asynchronous of [false, true]) {
  test("admission cleanup contains and reports close failure, async=" + asynchronous,
    { skip: process.platform !== "win32" }, async t => {
      const owned = fixture(t);
      const run = start(t, owned);
      await run.message("evaluated");
      await run.send("window");
      assert.equal(run.read().delivered.length, 1);
      await run.send("fail-close", { asynchronous });
      const quit = await run.send("will-quit-only");
      assert(!quit.trace.events.some(event => event.kind === "quit-committed"));
      assert.equal(run.child.exitCode, null);
      assert.match(run.stderr(), /Markaloo startup cleanup failed: ERR_OWNED_CLOSE/);
    });
}

test("package selects the pre-ready ESM entry and includes its runtime closure", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.main, "src/entry.mjs");
  for (const file of [
    "src/entry.mjs", "src/profile-startup.js", "src/main.js",
    "src/profile-startup-admission.js", "src/profile-migration-validation.js",
    "src/profile-migration-probe.js", "src/profile-migration-probe.html",
    "src/profile-migration.js", "src/legacy-install.js",
  ]) {
    assert(pkg.build.files.includes(file), file);
    assert(fs.statSync(path.join(ROOT, ...file.split("/"))).isFile(), file);
  }
  assert.match(MAIN, /webContents\.on\("did-finish-load", \(\) => \{\s*startupContext\.drain\(\);/);
  assert(!MAIN.includes("fileToOpen"));
  assert(!MAIN.includes("app.requestSingleInstanceLock("));
});

for (const args of [
  ["--markaloo-installer-unknown"],
  ["--markaloo-install-migrate"],
  ["--markaloo-install-validation-child"],
  [CHILD_ARGUMENT, CHILD_ARGUMENT],
  [CHILD_ARGUMENT, "initial.md"],
  ["--markaloo-profile-validation-child=1"],
]) {
  test("malformed/private role refuses without normal fallback: " + args.join(" "), async t => {
    const owned = fixture(t);
    const run = start(t, owned, args);
    assert.deepEqual(await run.exit, [1, null]);
    const trace = run.read();
    assert.equal(trace.main, 0);
    assert.equal(trace.singleton, 0);
    assert.deepEqual(fs.readdirSync(owned.appData), []);
  });
}

for (const relocated of [false, true]) {
  test("packaged Windows starts normally without a native installation gate, relocation=" + relocated,
    { skip: process.platform !== "win32" }, async t => {
      const owned = fixture(t, { packaged: true, relocated });
      const run = start(t, owned);
      await run.message("evaluated");
      const trace = run.read();
      assert.equal(trace.main, 1);
      assert.equal(trace.singleton, 1);
      if (relocated) assert.deepEqual(fs.readdirSync(path.join(owned.root, "selected-profile")), []);
    });
}

test("real neutral forwarding and Electron second-instance requests survive pre-window startup",
  { skip: process.platform !== "win32" }, async t => {
    const owned = fixture(t);
    const run = start(t, owned);
    const initial = await run.message("evaluated");
    assert.equal(initial.trace.main, 1);
    assert.equal(initial.trace.singleton, 1);
    assert(initial.trace.events.find(event => event.kind === "singleton").published);
    assert(initial.trace.events.find(event => event.kind === "singleton").profileExists);
    assert(initial.trace.events.find(event => event.kind === "main").beforeReady);
    assert.deepEqual(initial.trace.delivered, []);
    await run.send("second", { name: "second.md" });
    const other = fixture(t, { appData: owned.appData });
    const contender = start(t, other, ["forwarded.md"]);
    assert.deepEqual(await contender.exit, [0, null]);
    assert.equal(contender.read().singleton, 0);
    assert.equal(contender.read().main, 0);
    await run.send("finder");
    assert.deepEqual(run.read().delivered, []);
    const ready = await run.send("window");
    assert.deepEqual(ready.trace.delivered, [
      path.join(owned.cwd, "initial.md"), path.join(owned.cwd, "second.md"),
      path.join(other.cwd, "forwarded.md"), path.join(owned.cwd, "finder.md"),
    ]);
    const running = await run.send("second", { name: "initial.md" });
    assert.equal(running.trace.delivered.length, 5);
    assert.equal(running.trace.delivered[4], path.join(owned.cwd, "initial.md"));
    await run.send("window");
    assert.equal(run.read().delivered.length, 5);
    await run.send("close").catch(error => {
      if (!/Fixture exited before close/.test(error.message)) throw error;
    });
    assert.deepEqual(await run.exit, [0, null]);
    const records = fs.readdirSync(path.join(owned.appData, ".markaloo-startup"));
    assert.equal(records.filter(file => file.endsWith(".json")).length, 1);
  });

test("development redirect failure refuses before singleton or Main",
  { skip: process.platform !== "win32" }, async t => {
    const owned = fixture(t, { ignoreSetPath: true });
    const run = start(t, owned);
    assert.deepEqual(await run.exit, [1, null]);
    const trace = run.read();
    assert.equal(trace.main, 0);
    assert.equal(trace.singleton, 0);
    assert(trace.events.some(event => event.kind === "setPath"));
    assert(fs.readdirSync(path.join(owned.appData, ".markaloo-startup"))
      .some(name => name.endsWith(".json")));
  });

test("ordinary explicit relocation keeps its selected profile behind neutral admission",
  { skip: process.platform !== "win32" }, async t => {
    const owned = fixture(t, { relocated: true });
    const run = start(t, owned);
    const initial = await run.message("evaluated");
    assert.equal(initial.trace.main, 1);
    assert.equal(initial.trace.singleton, 1);
    assert(initial.trace.events.find(event => event.kind === "singleton").published);
    assert(!initial.trace.events.some(event => event.kind === "setPath"));
    assert(!fs.existsSync(path.join(owned.appData, "Markaloo-dev")));
    assert.deepEqual(fs.readdirSync(path.join(owned.root, "selected-profile")), []);
    const ready = await run.send("window");
    assert.deepEqual(ready.trace.delivered, [path.join(owned.cwd, "initial.md")]);
  });

test("freeing a native delivery ticket drains a retained startup request", t => {
  const { EventEmitter } = require("node:events");
  const { getMainStartup } = require("../src/profile-startup");
  const owned = fixture(t);
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, getName: () => "Folia",
    getPath: key => key === "appData" ? owned.appData : path.join(owned.root, "isolated"),
    requestSingleInstanceLock: () => true,
  });
  const context = getMainStartup(app);
  const sent = [];
  const target = {
    isDestroyed: () => false, isLoading: () => false,
    mainFrame: { frameTreeNodeId: 1 },
    send(_channel, data) { sent.push(data); },
  };
  const nativeStart = MAIN.indexOf("function deliverNativeDocumentIntent(");
  const nativeEnd = MAIN.indexOf('\nipcMain.handle("accept-native-document-ticket"', nativeStart);
  assert(nativeStart >= 0 && nativeEnd > nativeStart);
  const sandbox = {
    app, fs, path, crypto: require("node:crypto"), startupContext: context,
    log() {}, console: { error() {} },
    isMarkdownFile: file => path.extname(file) === ".md",
    mainWindow: {
      isDestroyed: () => false, isMinimized: () => false, focus() {},
      webContents: target,
    },
    nativeDocumentOpenTickets: new Map(), MAX_SESSION_DOCUMENTS: 1,
    startupDocuments: { classified: new WeakMap(), pending: new Map(),
      deadlineAt: null, deadlineTimer: null },
    queueStartupDocument(_request, filePath) {
      return sandbox.deliverNativeDocumentIntent(target, filePath);
    },
    scheduleStartupDocumentPump() {},
    shutdownCommitIngressBlocked: false,
    performance, setTimeout, clearTimeout,
    approvalRendererState: "ready", approvalRendererGeneration: 1,
    approvalRendererPageSession: "owned", isApprovalSender: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext(nativeSource + "\n" + consumerSource, sandbox);
  context.drain();
  for (const name of ["initial.md", "second.md"]) {
    context.owner.enqueue({
      requestId: name, args: ["node", name], cwd: owned.cwd,
    });
  }
  assert.equal(sent.length, 1);
  const record = sandbox.takeNativeDocumentTicket(
    { sender: target, senderFrame: target.mainFrame }, sent[0].documentOpenTicket,
  );
  assert.equal(record.filePath, path.join(owned.cwd, "initial.md"));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].filePath, path.join(owned.cwd, "second.md"));
  context.drain();
  assert.equal(sent.length, 2);
});

function expiryFixture(t) {
  const { EventEmitter } = require("node:events");
  const { getMainStartup } = require("../src/profile-startup");
  const owned = fixture(t);
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, getName: () => "Folia",
    getPath: key => key === "appData" ? owned.appData : path.join(owned.root, "isolated"),
    requestSingleInstanceLock: () => true,
  });
  const context = getMainStartup(app);
  let now = 0;
  const timers = new Map();
  let scheduled = 0;
  const sent = [];
  const target = {
    isDestroyed: () => false, isLoading: () => false,
    mainFrame: { frameTreeNodeId: 1 },
    send(channel, data) {
      if (channel === "external-file-open-request") sent.push(data);
    },
  };
  const tickets = new Map();
  const sandbox = {
    app, fs, path, crypto: require("node:crypto"), startupContext: context, console,
    log() {}, isMarkdownFile: file => path.extname(file) === ".md",
    mainWindow: {
      isDestroyed: () => false, isMinimized: () => false, focus() {}, webContents: target,
    },
    nativeDocumentOpenTickets: tickets, MAX_SESSION_DOCUMENTS: 512,
    startupDocuments: { classified: new WeakMap(), pending: new Map(),
      deadlineAt: null, deadlineTimer: null },
    queueStartupDocument(_request, filePath) {
      return sandbox.deliverNativeDocumentIntent(target, filePath);
    },
    scheduleStartupDocumentPump() {},
    shutdownCommitIngressBlocked: false,
    approvalRendererState: "ready", approvalRendererGeneration: 1,
    approvalRendererPageSession: "owned", isApprovalSender: () => true,
    performance: { now: () => now },
    setTimeout(callback, delay) {
      const handle = { unref() {} };
      timers.set(handle, { callback, at: now + delay });
      scheduled++;
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle); },
  };
  vm.createContext(sandbox);
  vm.runInContext(nativeSource + "\n" + consumerSource, sandbox);
  context.drain();
  const file = path.join(owned.cwd, "initial.md");
  for (let index = 0; index < 512; index++) {
    assert(sandbox.deliverNativeDocumentIntent(target, file));
  }
  assert.equal(tickets.size, 512, "All native capacity really is occupied");
  context.owner.enqueue({
    requestId: "retained-after-full-capacity", args: ["node", "second.md"], cwd: owned.cwd,
  });
  assert.equal(sent.length, 512, "The accepted next request really is blocked");
  return {
    sent, tickets, timers, scheduled: () => scheduled,
    setNow(value) { now = value; },
    advance(value) {
      now = value;
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      for (const [handle, timer] of due) {
        if (timers.delete(handle)) timer.callback();
      }
      assert([...timers.values()].every(timer => timer.at > now),
        "Expiry cannot spin on an already due deadline");
    },
    take(ticket, sender = target) {
      return sandbox.takeNativeDocumentTicket({
        sender, senderFrame: target.mainFrame,
      }, ticket);
    },
    pendingDelivered() {
      return sent.some(record => record.filePath === path.join(owned.cwd, "second.md"));
    },
  };
}

test("native ticket deadlines free full capacity without another arrival", t => {
  const owned = expiryFixture(t);
  owned.advance(60001);
  assert(owned.pendingDelivered(), "The real expiry deadline must wake retained delivery");
  assert.equal(owned.scheduled(), 2, "One original deadline and one for the newly delivered ticket");
  assert.equal(owned.timers.size, 1);
});

test("presenting an expired matching native ticket frees capacity and wakes retained delivery", t => {
  const owned = expiryFixture(t);
  const ticket = owned.tickets.keys().next().value;
  owned.setNow(60001);
  assert.equal(owned.take(ticket), null, "Expired authority stays unusable");
  assert(owned.pendingDelivered(), "Expired matching presentation must release blocked delivery");
  assert(owned.tickets.size <= 512);
});

test("expired ticket presentation from another sender cannot consume its owner", t => {
  const owned = expiryFixture(t);
  const ticket = owned.tickets.keys().next().value;
  owned.setNow(60001);
  assert.equal(owned.take(ticket, { isDestroyed: () => false }), null);
  assert(owned.tickets.has(ticket));
  assert(!owned.pendingDelivered());
});

function closingAuthorityFixture(t, phase, options = {}) {
  const { EventEmitter } = require("node:events");
  const { getMainStartup } = require("../src/profile-startup");
  const owned = fixture(t);
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, getName: () => "Folia",
    getPath: key => key === "appData" ? owned.appData : path.join(owned.root, "isolated"),
    requestSingleInstanceLock: () => true,
  });
  const context = getMainStartup(app);
  const immediates = [];
  const observed = {
    continued: 0, reasked: 0, opened: 0, declined: 0, updaterRuns: 0,
    updaterDeclines: 0, notices: [], focused: 0, quitCalls: 0,
  };
  let onContinuation = null;
  let onDecline = null;
  let blocked = true;
  let loading = false;
  const nativeWarnings = [];
  const warningReplies = [];
  const warningErrors = [];
  const target = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false, isLoading: () => loading,
    send(channel, message) { observed.notices.push({ channel, message }); },
  });
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isMinimized: () => false,
    focus() { observed.focused++; }, webContents: target,
  });
  const sandbox = {
    app, fs, path, startupContext: context,
    console: options.controlWarnings
      ? { error(...args) { warningErrors.push(args); } } : console,
    dialog: { showMessageBox(...args) {
      nativeWarnings.push(args);
      if (options.controlWarnings) {
        return new Promise((resolve, reject) => warningReplies.push({ resolve, reject }));
      }
      return Promise.resolve({ response: 0 });
    } },
    log() {}, isMarkdownFile: file => path.extname(file) === ".md",
    mainWindow: win, win, nativeDocumentOpenTickets: new Map(),
    startupDocuments: { classified: new WeakMap(), pending: new Map() },
    queueStartupDocument(_request, filePath) {
      return sandbox.deliverNativeDocumentIntent(target, filePath);
    },
    scheduleStartupDocumentPump() {},
    deliverNativeDocumentIntent() {
      if (blocked) return false;
      observed.opened++;
      return true;
    },
    pendingShutdown: null, pendingShutdownCommit: null, queuedShutdown: null,
    absorbedUserShutdown: null, absorbedUserShutdownSeq: 0,
    shutdownRequestSeq: 1, shutdownContinuationEpoch: 0, updaterContinuationEpoch: 0,
    shutdownCommitIngressBlocked: false, shutdownPendingContinuationCount: 0,
    deletionEvidenceCapacityLatched: false, deletionEvidenceRevision: 1,
    shutdownCommitRefusedCount: 0, lastShutdownCommitRefusedWhy: null,
    SHUTDOWN_CONTINUATION_PENDING: Symbol("pending"),
    markShutdownTiming() {}, completeShutdownTiming() {}, beginShutdownTiming() {},
    shutdownOwnerWindow: () => win, ownerRendererAvailable: () => true,
    markalooUpdaterAttemptRetainsFreeze: () => false,
    QUIT_APPROVAL_THAW: "quit-approval-thaw",
    revokeShutdownAuthorization() {}, grantShutdownAuthorization() {},
    shutdownDocumentSession: () => ({ ownerId: 1, rendererGeneration: 1 }),
    isSameShutdownDocumentSession: () => true,
    isUpdaterShutdownReason: reason => reason.startsWith("update-"),
    dispatchShutdownRequest() { observed.reasked++; },
    isMarkalooInstalledUpdateLaunchPending: () => false,
    hasCurrentShutdownAuthorization: () => false,
    updaterQuitBoundary: null,
    quitApprovedApp() { observed.quitCalls++; return true; },
    shutdownRank: reason => ({ "window-close": 0, "app-quit": 1, "update-install": 2 })[reason],
    setImmediate(callback) { immediates.push(callback); },
    clearTimeout() {},
    wc: target, approvalRendererGeneration: 1, approvalRendererPageSession: "owned",
    approvalRendererState: "ready", navigationInvalidatedShutdownCount: 0,
    knownDocumentOwners: new Map(), latestAcceptedSaveSequenceByDocument: new Map(),
    latestWatcherSelectionGeneration: 0, overlayProbeOwner: null,
    activeDialogExtraBatch: null, lastShutdownSettleWhy: null,
    invalidateStartupDocumentGeneration() {}, releaseDeletionDeliveriesForPage() {},
    quitAfterFrozenUpdaterDocumentLoss: () => false,
  };
  app.whenReady = async () => {};
  vm.createContext(sandbox);
  vm.runInContext([
    consumerSource, thawSource,
    ...["declineIntent", "requestShutdown", "queueShutdown", "settleShutdown", "commitThenRun",
      "finishShutdownCommit", "runApprovedContinuations", "holdAbsorbedUserShutdown",
      "replayAbsorbedUserShutdownAfterUpdaterCancel",
      "restartPendingShutdownAfterNavigation"].map(mainFunction),
    navigationSource, responsiveSource, beforeQuitSource,
  ].join("\n"), sandbox);
  context.drain();
  const record = {
    id: 1, reason: "window-close", revision: null, ordinaryGeneration: 0,
    continuation() { observed.continued++; return onContinuation ? onContinuation() : true; },
    onDeclined() { observed.declined++; onDecline?.(); },
    dialogAbortController: new AbortController(),
  };
  const commit = {
    id: 1, settled: false, deadlineTimer: null, authorisedSeq: 1,
    deletionEvidenceRevision: 1, continuations: [record], approvedSession: {},
  };
  if (phase === "question") sandbox.pendingShutdown = record;
  else if (phase === "commit") sandbox.pendingShutdownCommit = commit;
  else if (phase !== "idle") sandbox.runApprovedContinuations([record], 1, {}, 1, 0, 0, false);
  return {
    sandbox, context,
    flushContinuations() {
      for (const callback of immediates.splice(0)) callback();
    },
    observed, nativeWarnings, warningErrors,
    warningState: () => vm.runInContext("startupWarnings", sandbox),
    async respondWarning(index, error = null) {
      if (error) warningReplies[index].reject(error);
      else warningReplies[index].resolve({ response: 0 });
      await new Promise(resolve => setImmediate(resolve));
    },
    async responsive() {
      win.emit("responsive");
      await new Promise(resolve => setImmediate(resolve));
    },
    ordinaryQuit() {
      const event = { defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; } };
      app.emit("before-quit", event);
      return event;
    },
    retainFocus(mode = "loading") {
      loading = true;
      if (mode === "missing") sandbox.mainWindow = null;
      if (mode === "crashed") target.isCrashed = () => true;
      app.emit("second-instance", {}, ["node"], owned.cwd);
      assert.equal(context.owner.pendingCount(), 0, "The actual context took the accepted request");
      assert(context.holdClosing(), "The real consumer retained the focus request while loading");
    },
    holdRetainedFocus() {
      assert(sandbox.holdStartupClosing());
    },
    navigate(queuedReason = "app-quit") {
      sandbox.queueShutdown(queuedReason, () => {
        if (queuedReason.startsWith("update-")) observed.updaterRuns++;
        else observed.continued++;
        return true;
      }, false, () => {
        if (queuedReason.startsWith("update-")) observed.updaterDeclines++;
        else observed.declined++;
      });
      assert.equal(sandbox.queuedShutdown.reason, queuedReason);
      target.emit("did-navigate");
    },
    shutdownState() {
      return { pending: sandbox.pendingShutdown?.reason || null,
        queued: sandbox.queuedShutdown?.reason || null };
    },
    settleCurrent(approved) {
      const current = sandbox.pendingShutdown;
      assert(current, "A real replacement shutdown question exists");
      sandbox.settleShutdown(current, approved, "owned-current-answer");
      sandbox.settleShutdown(current, approved, "duplicate-owned-answer");
      for (const callback of immediates.splice(0)) callback();
    },
    drainFocus() {
      loading = false;
      sandbox.mainWindow = win;
      context.drain();
      assert.equal(context.holdClosing(), false, "The focus request really drained");
    },
    onContinuation(callback) { onContinuation = callback; },
    onDecline(callback) { onDecline = callback; },
    freezeNewer() { sandbox.shutdownCommitIngressBlocked = true; },
    frozen: () => sandbox.shutdownCommitIngressBlocked,
    generation: () => vm.runInContext("startupClosingState.ordinaryGeneration", sandbox),
    queueOrdinary() {
      sandbox.queueShutdown("app-quit", () => { observed.continued++; },
        false, () => { observed.declined++; });
    },
    absorbOrdinary() {
      sandbox.holdAbsorbedUserShutdown({
        reason: "app-quit", ordinaryGeneration: 0,
        continuation() { observed.continued++; },
        onDeclined() { observed.declined++; },
      });
      sandbox.replayAbsorbedUserShutdownAfterUpdaterCancel("controlled-cancellation");
    },
    addUpdater() {
      commit.continuations.push({
        reason: "update-install",
        continuation() { observed.updaterRuns++; return true; },
        onDeclined() { observed.updaterDeclines++; },
      });
    },
    onAbort(callback) { record.dialogAbortController.signal.addEventListener("abort", callback); },
    hasPendingQuestion: () => sandbox.pendingShutdown !== null,
    startFreshQuestion(reason = "app-quit") {
      sandbox.requestShutdown(reason, () => { observed.continued++; return true; });
      assert.equal(sandbox.pendingShutdown.ordinaryGeneration, this.generation());
      assert.equal(observed.reasked, 1, "A fresh ordinary gesture asks the unsaved-work path");
    },
    replayOldRequest() {
      sandbox.requestShutdown("window-close", record.continuation, { ordinaryGeneration: 0 });
    },
    freshQuit() {
      this.startFreshQuestion();
      sandbox.settleShutdown(sandbox.pendingShutdown, true, "fresh-owned-answer");
      for (const callback of immediates.splice(0)) callback();
    },
    hold() {
      context.owner.enqueue({
        requestId: "open-during-shutdown", args: ["node", "second.md"], cwd: owned.cwd,
      });
      assert.equal(observed.opened, 0, "The accepted open really is retained");
      const event = { preventDefault() { this.defaultPrevented = true; } };
      assert.equal(sandbox.holdStartupClosing(event), true);
      assert(event.defaultPrevented);
      assert(observed.notices.some(notice => notice.channel === "show-error"));
    },
    release() {
      blocked = false;
      context.drain();
      assert.equal(observed.opened, 1, "The accepted file really reaches the Main delivery path");
    },
    completeOld() {
      if (phase === "question") sandbox.settleShutdown(record, true, "late-owned-answer");
      else if (phase === "commit") sandbox.finishShutdownCommit(commit, true, "late-owned-commit");
      for (const callback of immediates.splice(0)) callback();
    },
  };
}

function updaterAdmissionFixture(t, options = {}) {
  const { EventEmitter } = require("node:events");
  const owned = closingAuthorityFixture(t, "idle");
  const { sandbox, context } = owned;
  const handlers = new Map();
  const children = [];
  const failures = [];
  const updater = {
    quitAndInstallCalled: false, installerPath: path.join(__dirname, "owned-installer.exe"),
    autoRunAppAfterInstall: true,
    downloadedUpdateHelper: { downloadedFileInfo: { isAdminRightsRequired: false } },
  };
  const requests = [];
  let preflightHook = null;
  let launchBoundaryHook = null;
  Object.assign(sandbox, {
    process: { platform: options.platform || "win32", resourcesPath: "owned-resources" },
    isPortable: false, updateInstallApprovalPending: false,
    updaterDownloadInFlight: false, downloadedUpdatePath: updater.installerPath,
    updateInstallStarted: false, activeUpdaterInstallAttempt: null,
    pendingUpdaterInstallCommit: null, updaterInstallAttempts: new Map(),
    updaterInstallAttemptSeq: 0, lastUpdaterInstallAttemptState: null,
    shutdownAuthorized: false, shutdownAuthorizationOwnerId: 0,
    shutdownAuthorizationGeneration: 0, shutdownAuthorizationCapacityLatched: false,
    shutdownCommitSeq: 0, SHUTDOWN_COMMIT_TIMEOUT_MS: 5000,
    QUIT_APPROVAL_COMMIT: "quit-approval-commit",
    cancelDocumentReplacementConsents() {},
    setTimeout() { return { unref() {} }; },
    ipcMain: { on(channel, handler) { handlers.set(channel, handler); } },
    isUpdaterSender: () => true,
    updateSchedule: { beginManualAction() {} },
    updateState: {
      snapshot: () => ({ canInstall: true }),
      publish() {}, beginInstall() {},
      fail(error) { failures.push(error.message); },
    },
    getAutoUpdater: () => updater,
    isExistingRegularFile() { preflightHook?.(); return !options.missing; },
    quitApprovedUpdateApp() { owned.observed.quitCalls++; return true; },
    require(name) {
      assert.equal(name, "child_process");
      launchBoundaryHook?.();
      return { spawn(executable, args, settings) {
        requests.push({ executable, args, settings,
          pending: context.hasPendingRequests(), frozen: owned.frozen() });
        if (options.throwSpawn) throw new Error("owned prelaunch spawn refusal");
        const child = Object.assign(new EventEmitter(), { pid: 123, unref() {} });
        children.push(child);
        return child;
      } };
    },
  });
  sandbox.mainWindow.webContents.isCrashed = () => false;
  vm.runInContext([
    ...["recordUpdaterInstallAttemptState", "watchUpdaterInstallCommit",
      "finishFailedUpdaterInstallAttempt", "markalooUpdaterAttemptRetainsFreeze",
      "invalidateDeferredUpdaterContinuations", "cancelUpdateOriginShutdownState",
      "poisonUpdaterInstallAttempt", "newestOwnedUpdaterInstallAttempt",
      "releaseShutdownFreeze", "revokeShutdownAuthorization", "grantShutdownAuthorization",
      "hasCurrentShutdownAuthorization", "windowsInstalledUpdateLaunchPlan",
      "reportInstalledUpdateLaunchFailure", "commitWindowsInstalledUpdateLaunch",
      "assertWindowsUpdateAdmission", "isMarkalooInstalledUpdateLaunchPending",
      "performWindowsInstalledUpdate", "performUpdateInstall"].map(mainFunction),
    MAIN.slice(MAIN.indexOf('ipcMain.on("install-update", (event) => {'),
      MAIN.indexOf("function isExistingRegularFile(")),
  ].join("\n"), sandbox);
  return {
    ...owned, updater, requests, children, failures,
    install() { handlers.get("install-update")({}); },
    preflight(callback) { preflightHook = callback; },
    launchBoundary(callback) { launchBoundaryHook = callback; },
    approve({ defer = false } = {}) {
      const question = sandbox.pendingShutdown;
      assert(question, "The actual fresh unsaved-work question is pending");
      question.revision = 1;
      question.responseGeneration = sandbox.approvalRendererGeneration;
      question.deletionEvidenceRevision = sandbox.deletionEvidenceRevision;
      sandbox.settleShutdown(question, true, "controlled-renderer-answer");
      const commit = sandbox.pendingShutdownCommit;
      assert(commit, "The actual phase-two commit exists");
      assert(owned.frozen(), "The real phase-two commit blocks document ingress");
      sandbox.finishShutdownCommit(commit, true, "controlled-renderer-commit");
      if (!defer) owned.flushContinuations();
    },
    decline() {
      const question = sandbox.pendingShutdown;
      assert(question);
      sandbox.settleShutdown(question, false, "controlled-cancel");
    },
    enqueue(id = "after-update-pause") {
      context.owner.enqueue({ requestId: id, args: ["node"], cwd: path.dirname(updater.installerPath) });
    },
    state() {
      return {
        question: sandbox.pendingShutdown, attempt: sandbox.activeUpdaterInstallAttempt,
        approvalPending: sandbox.updateInstallApprovalPending,
        installStarted: sandbox.updateInstallStarted,
      };
    },
  };
}

for (const state of ["owner", "context", "logical", "native-ticket", "offered", "opening", "awaiting-receipt", "held"]) {
  test("updater admission refuses accepted work before shutdown: " + state, t => {
    const owned = updaterAdmissionFixture(t);
    if (state === "owner") {
      const take = owned.context.owner.takeQueued;
      owned.context.owner.takeQueued = () => [];
      owned.enqueue("before-pause");
      owned.context.owner.takeQueued = take;
      assert.equal(owned.context.owner.pendingCount(), 1);
    } else if (state === "context") {
      owned.retainFocus();
      assert.equal(owned.context.owner.pendingCount(), 0, "Owner queue is empty, context still owns focus");
    } else if (state === "native-ticket") {
      owned.sandbox.nativeDocumentOpenTickets.set("offered", {});
      assert.equal(owned.sandbox.startupDocuments.pending.size, 0);
    } else {
      owned.sandbox.startupDocuments.pending.set("retained", { state });
      if (state === "offered") owned.sandbox.nativeDocumentOpenTickets.set("offered", {});
    }
    owned.install();
    assert.equal(owned.state().question, null, "Pending accepted work cannot enter unsaved approval/freeze");
    assert.equal(owned.state().approvalPending, false);
    assert.equal(owned.requests.length, 0);
    assert(!owned.frozen());
    assert(owned.failures.some(message => /pending|opening/i.test(message)));
    assert.doesNotThrow(() => owned.enqueue("new-after-refusal"), "Refusal restores admission");
    assert.equal(owned.requests.length, 0, "Draining cannot auto-replay Install");
  });
}

test("updater pause rejects arrivals before acknowledgement and remains through phase two", t => {
  const owned = updaterAdmissionFixture(t);
  owned.install();
  assert(owned.state().question);
  assert.throws(() => owned.enqueue(), { code: "ERR_ADMISSION_BUSY" });
  assert.equal(owned.context.owner.pendingCount(), 0);
  owned.approve();
  assert.equal(owned.requests.length, 1);
  assert.equal(owned.requests[0].pending, false);
  assert.equal(owned.requests[0].frozen, true);
  assert.throws(() => owned.enqueue("after-spawn"), { code: "ERR_ADMISSION_BUSY" });
  owned.children[0].emit("spawn");
  assert.equal(owned.observed.quitCalls, 1);
  owned.install();
  assert.equal(owned.requests.length, 1, "Positive launch cannot be duplicated");
});

test("updater preflight arrival is included in the synchronous pause check", t => {
  const owned = updaterAdmissionFixture(t);
  let arrived = false;
  owned.preflight(() => {
    if (arrived) return;
    arrived = true;
    owned.retainFocus();
  });
  owned.install();
  assert(arrived, "The real nonmutating launch preflight ran");
  assert.equal(owned.state().question, null);
  assert.equal(owned.requests.length, 0);
  owned.drainFocus();
  assert.equal(owned.requests.length, 0, "Settling accepted work needs a fresh Install");
  owned.install();
  owned.approve();
  assert.equal(owned.requests.length, 1);
});

test("updater decline restores only its own pause and old approval cannot launch", t => {
  const owned = updaterAdmissionFixture(t);
  owned.install();
  const old = owned.state().question;
  const staleDecline = old.onDeclined;
  owned.decline();
  assert.doesNotThrow(() => owned.enqueue("after-decline"));
  owned.install();
  const next = owned.state().question;
  assert(next && next !== old);
  staleDecline("late-duplicate");
  assert(owned.state().approvalPending, "A stale decline cannot clear the new approval latch");
  assert.throws(() => owned.enqueue("under-new-pause"), { code: "ERR_ADMISSION_BUSY" });
  owned.approve();
  assert.equal(owned.requests.length, 1);
});

test("startup context pause generation cannot resume a successor or close accepted focus", t => {
  const owned = updaterAdmissionFixture(t);
  const first = owned.context.pauseForUpdate();
  assert(owned.context.resumeAfterUpdate(first));
  const second = owned.context.pauseForUpdate();
  assert.notEqual(first.generation, second.generation);
  assert.equal(owned.context.resumeAfterUpdate(first), false);
  assert.throws(() => owned.enqueue(), { code: "ERR_ADMISSION_BUSY" });
  assert(owned.context.resumeAfterUpdate(second));
  owned.retainFocus();
  let closed = 0;
  owned.context.owner.close = async () => { closed++; };
  const event = { preventDefault() { this.defaultPrevented = true; } };
  owned.sandbox.app.emit("will-quit", event);
  assert(event.defaultPrevented);
  assert.equal(closed, 0);
  owned.drainFocus();
  owned.sandbox.app.emit("will-quit", {});
  assert.equal(closed, 1, "Only actual empty teardown closes the admission owner");
  assert.equal(owned.context.resumeAfterUpdate(second), false);
});

test("refusing Install for accepted focus retires an earlier ordinary quit without replay", t => {
  const owned = updaterAdmissionFixture(t);
  owned.startFreshQuestion();
  const old = owned.sandbox.pendingShutdown;
  owned.retainFocus();
  owned.install();
  assert.equal(owned.sandbox.pendingShutdown, null);
  owned.drainFocus();
  owned.sandbox.settleShutdown(old, true, "late-ordinary-answer");
  owned.flushContinuations();
  assert.equal(owned.observed.continued, 0);
  assert.equal(owned.observed.reasked, 1, "Only the original, now retired ordinary question was asked");
  assert.equal(owned.requests.length, 0);
  owned.install();
  owned.approve();
  assert.equal(owned.requests.length, 1, "A fresh Install remains usable");
});

for (const failure of ["throw", "error", "ambiguous"]) {
  test("updater admission follows the actual launcher outcome: " + failure, t => {
    const owned = updaterAdmissionFixture(t, { throwSpawn: failure === "throw" });
    owned.install();
    owned.approve();
    if (failure !== "throw") assert.equal(owned.children.length, 1, "The controlled launcher returned a real mock child");
    if (failure === "error") owned.children[0].emit("error", Object.assign(new Error("not started"), { code: "EACCES" }));
    if (failure === "ambiguous") owned.children[0].emit("close", null, "owned-unobserved-start");
    if (failure === "ambiguous") {
      assert.throws(() => owned.enqueue(), { code: "ERR_ADMISSION_BUSY" });
      assert(owned.frozen());
      assert(owned.state().installStarted);
      const attempt = owned.state().attempt;
      assert.equal(owned.sandbox.finishFailedUpdaterInstallAttempt(attempt), false,
        "A later generic error cannot retire an ambiguous launcher");
      owned.install();
      assert.equal(owned.requests.length, 1);
    } else {
      assert.doesNotThrow(() => owned.enqueue());
      assert(!owned.frozen());
      assert.equal(owned.state().attempt, null);
      assert.equal(owned.updater.quitAndInstallCalled, false);
      owned.install();
      owned.decline();
      assert.equal(owned.requests.length, 1, "Only the fresh Install can create another attempt");
    }
    assert.equal(owned.observed.quitCalls, 0);
  });
}

test("updater rechecks accepted receipt work immediately before the launcher boundary", t => {
  const owned = updaterAdmissionFixture(t);
  owned.install();
  owned.approve({ defer: true });
  owned.sandbox.startupDocuments.pending.set("late-receipt", { state: "awaiting-receipt" });
  owned.flushContinuations();
  assert.equal(owned.requests.length, 0);
  assert(!owned.frozen());
  assert(owned.sandbox.startupDocuments.pending.has("late-receipt"));
  assert.doesNotThrow(() => owned.enqueue());
});

test("updater performs its final empty check after preparing the launcher port", t => {
  const owned = updaterAdmissionFixture(t);
  owned.install();
  owned.launchBoundary(() => {
    assert(owned.state().attempt, "The actual attempt owns the updater latch");
    owned.sandbox.startupDocuments.pending.set("boundary-receipt", { state: "awaiting-receipt" });
  });
  owned.approve();
  assert.equal(owned.requests.length, 0, "No process launch was attempted after the final check failed");
  assert.equal(owned.state().attempt, null);
  assert(!owned.frozen());
  assert(owned.context.hasPendingRequests(), "The receipt work remains owned");
  assert.doesNotThrow(() => owned.enqueue("after-boundary-refusal"));
});

test("updater rechecks its captured pause generation before any launch", t => {
  const owned = updaterAdmissionFixture(t);
  owned.install();
  owned.approve({ defer: true });
  const pause = owned.context.pauseForUpdate;
  assert.equal(typeof pause, "function", "The production context owns the reversible pause API");
  owned.context.handleRuntimeFailure(Object.assign(new Error("admission stopped"), { code: "ERR_ADMISSION_PIPE" }));
  owned.flushContinuations();
  assert.equal(owned.requests.length, 0);
  assert(!owned.frozen());
  assert.throws(() => owned.enqueue(), { code: "ERR_ADMISSION_BUSY" },
    "An old approval cannot reopen failed admission");
});

test("Windows admin-required metadata refuses before pause, approval or elevation fallback", t => {
  const owned = updaterAdmissionFixture(t);
  owned.updater.downloadedUpdateHelper.downloadedFileInfo.isAdminRightsRequired = true;
  owned.install();
  assert.equal(owned.state().question, null);
  assert.equal(owned.requests.length, 0);
  assert.doesNotThrow(() => owned.enqueue());
  assert(owned.failures.length);
});

test("non-Windows updater keeps its existing public handoff without a Windows admission pause", t => {
  const owned = updaterAdmissionFixture(t, { platform: "linux" });
  let handoffs = 0;
  owned.updater.quitAndInstall = () => {
    handoffs++;
    owned.updater.quitAndInstallCalled = true;
  };
  owned.install();
  assert.doesNotThrow(() => owned.enqueue("linux-before-approval"));
  owned.approve();
  assert.equal(handoffs, 1);
  assert.equal(owned.requests.length, 0);
  assert.equal(owned.state().attempt.launchOwner, "electron-updater");
  assert.doesNotThrow(() => owned.enqueue("linux-after-handoff"));
});

for (const mode of ["loading", "missing", "crashed"]) {
  test("context-retained focus explains held closing independently of its renderer: " + mode, async t => {
    const owned = closingAuthorityFixture(t, "question");
    owned.retainFocus(mode);
    owned.holdRetainedFocus();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(owned.nativeWarnings.length, 1, "Main owns a bounded warning outside the document renderer");
    assert.equal(owned.observed.continued, 0);
    assert.equal(owned.observed.reasked, 0);
    owned.drainFocus();
    owned.completeOld();
    assert.equal(owned.observed.continued, 0, "Dismissing/draining never replays the old quit");
  });
}

for (const rejected of [false, true]) {
  test((rejected ? "rejected" : "dismissed") +
    " context warning after actual responsive event, rejected=" + rejected, async t => {
    const owned = closingAuthorityFixture(t, "question", { controlWarnings: true });
    const focused = owned.observed.focused;
    owned.retainFocus();
    owned.holdRetainedFocus();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(owned.nativeWarnings.length, 1);
    assert(!owned.observed.notices.some(notice => notice.channel === "show-error"),
      "No renderer notification can explain the retained focus while loading");
    const error = rejected ? new Error("owned original context warning rejection") : null;
    await owned.respondWarning(0, error);
    if (error) assert(owned.warningErrors.some(args => args[1] === error));
    assert.equal(owned.nativeWarnings.length, 1, "There is no immediate warning retry storm");
    await owned.responsive();
    const attempts = owned.nativeWarnings.length;
    assert.equal(owned.observed.focused, focused, "Readiness did not discard or consume the held focus");
    owned.completeOld();
    assert.equal(owned.observed.continued, 0);
    assert.equal(owned.observed.reasked, 0);
    owned.drainFocus();
    assert.equal(owned.observed.focused, focused + 1, "The original accepted focus really drains later");
    owned.completeOld();
    assert.equal(owned.observed.continued, 0, "Warning recovery and draining cannot replay quit");
    assert.equal(owned.observed.reasked, 0, "Warning recovery cannot ask for fresh shutdown consent");
    if (!rejected) {
      assert.equal(attempts, 1, "A successfully dismissed context warning is not reissued");
    }
  });
}

test("fresh ordinary Quit explains a retained focus after its original warning rejects", async t => {
  const owned = closingAuthorityFixture(t, "question", { controlWarnings: true });
  const focused = owned.observed.focused;
  owned.retainFocus();
  owned.holdRetainedFocus();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(owned.nativeWarnings.length, 1);
  const error = new Error("owned context warning rejection before fresh Quit");
  await owned.respondWarning(0, error);
  assert(owned.warningErrors.some(args => args[1] === error));
  assert.equal(owned.warningState().active, null, "The first failed attempt fully settled");
  assert.equal(owned.warningState().pending.size, 0);
  assert.equal(owned.nativeWarnings.length, 1, "No automatic retry occurred");
  assert(owned.ordinaryQuit().defaultPrevented, "The actual before-quit guard holds the fresh Quit");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(owned.nativeWarnings.length, 2, "Fresh Quit attempts a Main-owned explanation");
  const args = owned.nativeWarnings[1];
  assert.equal(args.length, 1);
  assert.match(args[0].message, /file opens are still pending/i);
  assert.deepEqual(Array.from(args[0].buttons), ["OK"]);
  await owned.respondWarning(1);
  assert(!owned.observed.notices.some(notice => notice.channel === "show-error"));
  assert.equal(owned.observed.focused, focused, "The blocked focus remains accepted and undelivered");
  assert.equal(owned.observed.opened, 0);
  assert.equal(owned.observed.continued, 0);
  assert.equal(owned.observed.reasked, 0);
  assert.equal(owned.observed.quitCalls, 0);
  owned.drainFocus();
  assert.equal(owned.observed.focused, focused + 1, "The same accepted focus actually drains later");
  owned.completeOld();
  assert.equal(owned.observed.continued, 0, "Fresh notice and draining do not replay the retired quit");
  assert.equal(owned.observed.reasked, 0);
  assert.equal(owned.observed.quitCalls, 0);
});

for (const queuedReason of ["app-quit", "update-install"]) {
  test("navigation restart preserves detached intent ownership while focus is retained: " + queuedReason, t => {
    const owned = closingAuthorityFixture(t, "question");
    owned.retainFocus();
    assert.doesNotThrow(() => owned.navigate(queuedReason));
    assert.equal(owned.observed.continued, 0);
    assert.equal(owned.observed.updaterRuns, 0);
    if (queuedReason === "app-quit") {
      assert.equal(owned.observed.declined, 2, "Both stale ordinary intents decline exactly once");
      assert.deepEqual(owned.shutdownState(), { pending: null, queued: null });
      owned.drainFocus();
      owned.completeOld();
      assert.equal(owned.observed.reasked, 0, "Draining cannot replay the retired quit");
      owned.freshQuit();
      assert.equal(owned.observed.continued, 1);
    } else {
      assert.equal(owned.observed.declined, 1);
      assert.equal(owned.observed.updaterDeclines, 0, "Updater work is not discarded with ordinary authority");
      assert.deepEqual(owned.shutdownState(), { pending: "update-install", queued: null });
      owned.completeOld();
      assert.deepEqual(owned.shutdownState(), { pending: "update-install", queued: null });
      owned.drainFocus();
      owned.settleCurrent(false);
      assert.equal(owned.observed.updaterDeclines, 1, "A fresh updater answer settles exactly once");
      assert.equal(owned.observed.updaterRuns, 0);
      assert.equal(owned.observed.declined, 1);
    }
  });
  test("navigation restart retains its ordinary ranking without a held focus request: " + queuedReason, t => {
    const owned = closingAuthorityFixture(t, "question");
    owned.navigate(queuedReason);
    assert.deepEqual(owned.shutdownState(), { pending: "window-close", queued: queuedReason });
    assert.equal(owned.observed.reasked, 1);
    assert.equal(owned.observed.declined, 0);
    assert.equal(owned.observed.updaterDeclines, 0);
  });
}

test("navigation reconciliation cannot attach a stale saved ordinary intent to a reentrant fresh question", t => {
  const owned = closingAuthorityFixture(t, "question");
  owned.retainFocus();
  owned.onDecline(() => {
    owned.drainFocus();
    owned.startFreshQuestion("window-close");
  });
  owned.navigate();
  assert.equal(owned.observed.declined, 2);
  assert.equal(owned.observed.reasked, 1);
  assert.deepEqual(owned.shutdownState(), { pending: "window-close", queued: null });
  owned.completeOld();
  owned.settleCurrent(true);
  assert.equal(owned.observed.continued, 1, "Only the genuinely fresh question can close");
  assert.equal(owned.observed.declined, 2);
});

for (const phase of ["question", "commit", "continuation"]) {
  test("holding pending opens retires prior shutdown authority: " + phase, t => {
    const owned = closingAuthorityFixture(t, phase);
    owned.hold();
    owned.release();
    owned.completeOld();
    assert.equal(owned.observed.continued, 0, "Earlier quit cannot run after the accepted open");
    assert.equal(owned.observed.reasked, 0, "A new ordinary quit must come from the user");
  });
  test("prior shutdown authority still completes when no opens are held: " + phase, t => {
    const owned = closingAuthorityFixture(t, phase);
    owned.completeOld();
    assert.equal(owned.observed.continued, 1, "The original completion probe really is live");
    assert.equal(owned.observed.reasked, 0);
  });
  test("stale shutdown authority cannot thaw a newer freeze: " + phase, t => {
    const owned = closingAuthorityFixture(t, phase);
    owned.hold();
    owned.release();
    owned.freezeNewer();
    const notices = owned.observed.notices.length;
    owned.completeOld();
    assert(owned.frozen());
    assert.equal(owned.observed.notices.length, notices);
    assert.equal(owned.observed.continued, 0);
    assert.equal(owned.observed.reasked, 0);
  });
  test("fresh quit obtains current authority after held opens drain: " + phase, t => {
    const owned = closingAuthorityFixture(t, phase);
    owned.hold();
    assert.equal(owned.generation(), 1);
    owned.release();
    owned.completeOld();
    owned.freshQuit();
    assert.equal(owned.observed.continued, 1);
  });
}

test("a held question detaches before synchronous abort and retires queued ordinary quit", t => {
  const owned = closingAuthorityFixture(t, "question");
  owned.queueOrdinary();
  let aborted = false;
  owned.onAbort(() => {
    aborted = true;
    assert(!owned.hasPendingQuestion());
    owned.completeOld();
  });
  owned.hold();
  assert(aborted, "The original ordinary dialog really was aborted");
  assert.equal(owned.observed.declined, 2);
  owned.release();
  owned.completeOld();
  assert.equal(owned.observed.continued, 0);
  assert.equal(owned.observed.reasked, 0);
});

test("a held absorbed ordinary quit never replays after updater cancellation", t => {
  const owned = closingAuthorityFixture(t, "question");
  owned.absorbOrdinary();
  owned.hold();
  assert.equal(owned.observed.declined, 2);
  owned.release();
  owned.completeOld();
  assert.equal(owned.observed.continued, 0);
  assert.equal(owned.observed.reasked, 0);
});

test("a held mixed commit retires only ordinary authority and preserves updater work", t => {
  const owned = closingAuthorityFixture(t, "commit");
  owned.addUpdater();
  owned.hold();
  owned.release();
  owned.completeOld();
  assert.equal(owned.observed.continued, 0);
  assert.equal(owned.observed.updaterRuns, 1);
  assert.equal(owned.observed.updaterDeclines, 0);
  assert.equal(owned.observed.reasked, 0);
});

test("a retired ordinary request cannot re-enter after its opens drain", t => {
  const owned = closingAuthorityFixture(t, "question");
  owned.hold();
  owned.release();
  owned.replayOldRequest();
  assert.equal(owned.observed.reasked, 0);
  assert(!owned.hasPendingQuestion());
});

test("a lifecycle hold inside a continuation cannot thaw its newer freeze", t => {
  const owned = closingAuthorityFixture(t, "continuation");
  owned.onContinuation(() => {
    owned.hold();
    owned.release();
    owned.freezeNewer();
    return false;
  });
  owned.completeOld();
  assert.equal(owned.observed.continued, 1, "The original continuation really was invoked");
  assert(owned.frozen());
});

test("ordinary retirement releases before a decline callback starts a newer freeze", t => {
  const owned = closingAuthorityFixture(t, "question");
  owned.onDecline(() => {
    assert(!owned.frozen(), "The retired ordinary freeze is released before re-entry");
    owned.release();
    owned.startFreshQuestion();
    owned.freezeNewer();
  });
  owned.hold();
  assert(owned.frozen());
  owned.completeOld();
  assert(owned.frozen());
  assert(owned.hasPendingQuestion());
});

for (const branch of ["linux", "darwin"]) {
  test("ordinary non-Windows branch retains initial, Finder and second-instance requests: " + branch,
    async t => {
      const owned = fixture(t, { branch });
      const run = start(t, owned);
      const initial = await run.message("evaluated");
      assert.equal(initial.trace.main, 1);
      assert.equal(initial.trace.singleton, 1);
      await run.send("second", { name: "second.md" });
      await run.send("finder");
      const ready = await run.send("window");
      assert.deepEqual(ready.trace.delivered, ["initial.md", "second.md", "finder.md"]
        .map(file => path.join(owned.cwd, file)));
      assert(!fs.existsSync(path.join(owned.appData, ".markaloo-startup")));
    });
}

test("actual ESM child entry returns before ready and runs the real private adapter on a clone",
  async t => {
    const owned = fixture(t, { validation: true, packaged: true });
    const input = path.join(owned.root, "source", "Local Storage", "leveldb");
    const workRoot = path.join(owned.root, "work");
    fs.mkdirSync(input, { recursive: true });
    fs.mkdirSync(workRoot);
    fs.writeFileSync(path.join(input, "CURRENT"), "MANIFEST-000001\n");
    fs.writeFileSync(path.join(input, "MANIFEST-000001"), "synthetic manifest");
    fs.writeFileSync(path.join(input, "000003.log"), "synthetic wal");
    const before = fs.readdirSync(input).map(name => [name, fs.readFileSync(path.join(input, name))]);
    const validate = createLocalStorageValidator({
      executablePath: process.execPath, args: [owned.script], workRoot, timeoutMs: 10000,
    });
    assert.deepEqual(await validate({ directory: input, backend: "leveldb" }),
      { status: "validated", backend: "leveldb" });
    const trace = JSON.parse(fs.readFileSync(owned.trace, "utf8"));
    assert.equal(trace.main, 0);
    assert.equal(trace.singleton, 0);
    assert(trace.events.find(event => event.kind === "child-preparation").beforeReady);
    assert(trace.events.find(event => event.kind === "entry-evaluated").beforeReady);
    const observed = trace.events.find(event => event.kind === "probe");
    assert(observed.afterReady);
    assert(observed.profilePath.startsWith(workRoot + path.sep));
    assert.notEqual(observed.userData, observed.profilePath);
    assert.notEqual(observed.sessionData, observed.profilePath);
    assert.notEqual(observed.sessionData, observed.userData);
    assert(!JSON.stringify(trace).includes("private-value-never-in-trace"));
    assert.deepEqual(fs.readdirSync(workRoot), []);
    for (const [name, bytes] of before) {
      assert.deepEqual(fs.readFileSync(path.join(input, name)), bytes);
    }
  });
