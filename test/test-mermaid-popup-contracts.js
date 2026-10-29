// Node-only controls for the ordinary Mermaid and popup actors. No Electron.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const mermaid = fs.readFileSync(path.join(__dirname, "test-mermaid-render.js"), "utf8").replace(/\r\n/g, "\n");
const popups = fs.readFileSync(path.join(__dirname, "test-popup-security.js"), "utf8").replace(/\r\n/g, "\n");
let passed = 0;

function between(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, "actual actor anchors must resolve: " + start);
  assert.equal(source.indexOf(start, first + start.length), -1, "actor start must be unique");
  return source.slice(first, last);
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
async function control(name, run) {
  await run();
  passed++;
  console.log("PASS " + name);
}

function mermaidPage() {
  const fixture = { path: "C:\\owned\\actor.md", source: "headerless text\n\nbody\n", blocks: 0,
    diskVersion: { dev: 1, ino: 2, size: 23, mtimeMs: 4, ctimeMs: 5 } };
  const tab = { id: 1, filePath: fixture.path, content: fixture.source,
    originalContent: fixture.source, diskVersion: { ...fixture.diskVersion } };
  const state = { tabs: [tab], pending: false, dirty: false, refuseClose: false, closed: 0,
    revision: 1, root: "headerless text", blocks: 0, loading: false };
  const page = { console, setTimeout, clearTimeout, URL, location: { href: "file:///C:/owned/src/index.html" },
    currentFilePath: fixture.path, originalMarkdown: fixture.source, undoHistory: [],
    undoRedoRendering: false, hasUnsavedChanges: true };
  page.window = page;
  page.document = { readyState: "complete",
    getElementById: name => name === "viewer" ? { firstElementChild: { textContent: state.root } } :
      name === "loadingScreen" ? { classList: { contains: () => state.loading } } :
        name === "openFile" ? { click: () => { state.opened = true; } } : null,
    querySelector: () => null, querySelectorAll: () => Array(state.blocks).fill({}) };
  page.getReloadRequestSession = () => "page";
  page.folia = { getQuitApprovalGeneration: async () => 1 };
  page.identity = { tabId: 1, documentRef: "a".repeat(64), pageSession: "page", pathKey: "key" };
  page.adoption = { known: true, versionMatches: true, pathKey: "key" };
  page.queryDocumentDiskAdoptionState = () => page.adoption;
  page.getPendingSaveStatus = () => ({ pending: state.pending });
  page.CustomTabs = {
    getTabs: () => state.tabs, getActiveTab: () => state.tabs[0],
    getDocumentDescriptor: () => ({ logicalPath: fixture.path, ref: "a".repeat(64) }),
    getDocumentIdentityForTab: () => page.identity,
    settleSessionLayout: async () => state.revision,
    __dirtyTabNames: () => {
      tab.content = page.originalMarkdown;
      return state.dirty || page.originalMarkdown !== fixture.source ? ["actor.md"] : [];
    },
    closeTab: async id => {
      if (!state.refuseClose) {
        state.tabs = state.tabs.filter(item => item.id !== id);
        state.closed++;
      }
    },
  };
  page.historyUndo = () => {
    page.originalMarkdown = page.undoHistory.pop();
    page.undoRedoRendering = true;
    setImmediate(() => { page.undoRedoRendering = false; });
  };
  const context = vm.createContext(page);
  vm.runInContext(between(mermaid, "const sleep =", "/**"), context);
  vm.runInContext(between(mermaid, "async function waitFor(", "// Every diagram"), context);
  vm.runInContext(between(mermaid, "async function settleMermaidSession(", "async function run(win)"), context);
  page.main = { __shutdown: {
    state: () => ({ renderer: "ready", rendererGeneration: 1, rendererPageSession: "page" }),
    documentSessionState: () => ({ entries: state.tabs.map(item => ({ id: item.id })),
      activeEntryId: state.tabs.length ? 1 : null }),
  } };
  const win = { webContents: { executeJavaScript: code => vm.runInContext(code, context) } };
  return { page, context, fixture, tab, state, win };
}

async function mermaidControls() {
  await control("session settlement waits through restore and revision zero", async () => {
    const m = mermaidPage();
    const transient = vm.runInContext("new Error('The open tabs are still awaiting document restore')", m.context);
    transient.stack = transient.message +
      "\n    at Object.settleSessionLayout (file:///C:/owned/src/custom-tabs.js:3447:13)";
    let calls = 0;
    m.page.CustomTabs.settleSessionLayout = async () => {
      calls++;
      if (calls === 1) throw transient;
      return calls === 2 ? 0 : 1;
    };
    const ready = await m.page.settleMermaidSession(m.win, "controlled restore");
    assert.equal(ready.revision, 1);
    assert.equal(calls, 3);
  });
  await control("persistence errors with the readiness message are not swallowed", async () => {
    const m = mermaidPage();
    const error = vm.runInContext("new Error('The open tabs are still awaiting document restore')", m.context);
    error.stack = error.message + "\n    at startSessionLayoutWriter (file:///C:/owned/src/custom-tabs.js:3422:5)";
    m.page.CustomTabs.settleSessionLayout = async () => { throw error; };
    await assert.rejects(m.page.settleMermaidSession(m.win, "persistence"), value => value === error);
  });
  for (const [name, change] of [
    ["dirty owner", m => { m.state.dirty = true; }],
    ["pending save", m => { m.state.pending = true; }],
    ["refused close", m => { m.state.refuseClose = true; }],
  ]) {
    await control("real retirement rejects " + name, async () => {
      const m = mermaidPage();
      change(m);
      await assert.rejects(m.page.closeCleanMermaidTabs(m.win));
      assert.equal(m.state.tabs.length, 1);
      assert.equal(m.page.hasUnsavedChanges, true);
    });
  }
  await control("retirement waits for durable layout before closing and verifies Main empty", async () => {
    const m = mermaidPage(), persistence = deferred();
    m.page.CustomTabs.settleSessionLayout = () => persistence.promise;
    const retirement = m.page.closeCleanMermaidTabs(m.win);
    await tick();
    assert.equal(m.state.closed, 0);
    persistence.resolve(1);
    await retirement;
    assert.equal(m.state.closed, 1);
    assert.equal(m.state.tabs.length, 0);
  });
  for (const [name, change, repair] of [
    ["null admission", m => { m.page.adoption = null; }, m => {
      m.page.adoption = { known: true, versionMatches: true, pathKey: "key" };
    }],
    ["wrong owner", m => { m.page.identity.tabId = 99; }, m => { m.page.identity.tabId = 1; }],
    ["stale DOM", m => { m.state.root = "previous document"; }, m => { m.state.root = "headerless text"; }],
    ["wrong disk version", m => { m.tab.diskVersion.size++; }, m => { m.tab.diskVersion.size--; }],
    ["wrong source", m => { m.page.originalMarkdown = "other"; }, m => {
      m.page.originalMarkdown = m.fixture.source;
    }],
    ["wrong diagram count", m => { m.state.blocks = 2; }, m => { m.state.blocks = 0; }],
  ]) {
    await control("admission stays pending for " + name + " before exact settlement", async () => {
      const m = mermaidPage(), waiting = deferred();
      let wake, completed = false;
      // Observe a real pending predicate, then release its controlled timer.
      // The actor's ordinary deadline remains unchanged.
      m.page.setTimeout = callback => { wake = callback; waiting.resolve(); };
      change(m);
      const admission = m.page.admitMermaidActorFixture(m.fixture, false);
      admission.then(() => { completed = true; }, () => {});
      await waiting.promise;
      assert.equal(completed, false);
      repair(m);
      wake();
      assert.equal(await admission, 1);
    });
  }
  await control("headerless admission preserves the actual first paragraph", async () => {
    const m = mermaidPage();
    assert.equal(await m.page.admitMermaidActorFixture(m.fixture), 1);
    assert.equal(m.state.opened, true);
    assert.equal(m.fixture.source.startsWith("#"), false);
  });
  await control("fixture restoration uses real undo and does not clear the dirty indicator", async () => {
    const m = mermaidPage();
    m.page.originalMarkdown = "edited";
    m.page.undoHistory.push(m.fixture.source);
    await m.page.restoreMermaidActorFixture(m.fixture);
    assert.equal(m.page.originalMarkdown, m.fixture.source);
    assert.equal(m.page.undoHistory.length, 0);
    assert.equal(m.page.hasUnsavedChanges, true);
  });
  await control("a mutation without usable undo history is retained and refused", async () => {
    const m = mermaidPage();
    m.page.originalMarkdown = "edited";
    await assert.rejects(m.page.restoreMermaidActorFixture(m.fixture), /no undo path/);
    assert.equal(m.page.originalMarkdown, "edited");
  });
  await control("Mermaid actors do not manufacture dirty history or submission state", async () => {
    assert.doesNotMatch(mermaid, /hasUnsavedChanges\s*=\s*(?:false|savedDirty)|historyRestore\(|setUnsavedState\(/);
    assert.doesNotMatch(mermaid, /mermaidDialogSubmitting\s*=\s*false/);
  });
}

function popupGuard() {
  const lifecycle = popupCleanup("deferred", false), { page } = lifecycle;
  const { app } = page, enabled = deferred(), installed = deferred(), commands = [];
  const indexFile = path.join(__dirname, "..", "src", "index.html"), indexURL = pathToFileURL(indexFile).href;
  const record = lifecycle.makeOwner(7, "deferred", indexURL);
  const { wc, frame } = record, debug = new EventEmitter();
  wc.debugger = debug;
  Object.assign(page, { indexURL, guardToken: "token", guardKey: "guard",
    guardMarker: "unexpected-dialog", promptGuardSource: () => "guard",
    isOwnedPopupPath: () => false });
  page.windows.clear();
  page.guards.clear();
  page.windows.set(record.id, record);
  record.kind = "main-pending";
  page.mainStartup = { record, loadIssued: false };
  page.main = { __shutdown: { state: () => lifecycle.read("Main.state", () => ({
    renderer: "ready", rendererGeneration: 1, rendererPageSession: "page",
  })) } };
  page.query = async () => ({ frameTree: { frame: { id: "frame", loaderId: "loader", url: indexURL } } });
  debug.attach = () => {};
  debug.sendCommand = command => {
    commands.push(command);
    if (command === "Page.enable") return enabled.promise;
    if (command === "Page.addScriptToEvaluateOnNewDocument") return installed.promise;
    if (command === "Page.getFrameTree") return page.query();
    throw new Error("unexpected command " + command);
  };
  wc.loadFile = () => wc.loadURL(indexURL);
  wc.loadURL = () => {
    const state = page.guards.get(wc.id);
    assert.equal(state.enabled, false);
    assert.equal(state.installed, false);
    commands.push("original-navigation");
    return Promise.resolve();
  };
  const context = lifecycle.context;
  vm.runInContext(between(popups, "const sleep =", "// Missing/failed setup"), context);
  vm.runInContext(between(popups, "function consumeLoadFileDelegation(", 'app.on("web-contents-created",'), context);
  vm.runInContext(between(popups, "async function bounded(", "function isOwnedPopupPath("), context);
  vm.runInContext(between(popups, "async function reconcileRootCommit(", "function assertMainOwner("), context);
  vm.runInContext(between(popups, "function assertMainOwner(", "function inspectMutes("), context);
  vm.runInContext(between(popups, "async function openPopup(", "// FAIL CLOSED."), context);
  vm.runInContext(between(popups, "function prefsOf(", "async function bounded("), context);
  vm.runInContext(between(popups, "async function run() {", "\n  hostWindow =") + "\n}", context);
  vm.runInContext(between(popups, 'app.on("web-contents-created",', 'app.on("browser-window-created",'), context);
  app.emit("web-contents-created", null, wc);
  wc.loadFile(indexFile);
  wc.emit("did-navigate", null, indexURL);
  page.guardValue = { token: "token", contentsId: wc.id, url: indexURL, executed: true,
    intact: true, sameDocument: true, open: 0, documentToken: "document" };
  page.evaluate = async () => page.guardValue;
  const state = page.guards.get(wc.id);
  const acknowledge = async (ack = { identifier: "script" }) => {
    enabled.resolve({});
    installed.resolve(ack);
    await tick();
    clearTimeout(state.timer);
  };
  return { ...lifecycle, page, record, wc, frame, state, commands, acknowledge, debug,
    rejectInstallation: async () => {
      enabled.resolve({});
      installed.reject(new Error("installation rejected"));
      await tick();
    },
    navigate: loaderId => debug.emit("message", null, "Page.frameNavigated",
      { frame: { id: "frame", loaderId, url: indexURL } }) };
}

async function popupGuardControls() {
  await control("a late contents invalidates cleanup before guard installation continues", async () => {
    const p = popupGuard();
    await p.acknowledge();
    assert.equal(await p.page.destroyOwners(), true);
    const late = new EventEmitter(), debug = new EventEmitter();
    Object.assign(late, { id: 8, debugger: debug, isDestroyed: () => false,
      getURL: () => p.page.indexURL, loadFile: () => Promise.resolve(), loadURL: () => Promise.resolve() });
    debug.attach = () => {};
    debug.sendCommand = command => Promise.resolve(
      command === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "late-script" } : {});
    p.page.app.emit("web-contents-created", null, late);
    assert.equal(p.page.ownerInventoryInvalidated, true);
    assert.equal(p.page.ownerCleanupResult, false);
    assert.equal(p.page.registeredDirs.has("fixture"), false);
    assert.equal(p.page.retainedFixtures.has("fixture"), true);
    await tick();
    const state = p.page.guards.get(late.id);
    clearTimeout(state.timer);
    assert.equal(state.installed, true);
    assert.equal(state.enabled, true);
    assert.equal(p.page.results.filter(result => result.name === "terminal popup owner inventory remained fixed").length, 1);
    await p.page.terminalCompletion;
    assert.equal(p.page.ownerInventoryMatches(), false);
    assert(p.events.includes("app-exit:1"));
    assert.equal(p.events.some(event => typeof event === "string" && event.startsWith("release:")), false);
  });
  await control("original navigation precedes ACKs and a missed CDP event is reconciled", async () => {
    const p = popupGuard();
    assert.equal(p.state.cdpCommit, null);
    assert(p.commands.indexOf("original-navigation") > p.commands.indexOf("Page.addScriptToEvaluateOnNewDocument"));
    await p.acknowledge();
    const scope = await p.page.assertGuard(p.wc);
    assert.equal(scope.commit.loaderId, "loader");
    assert.equal(scope.documentToken, "document");
    assert(p.commands.includes("Page.getFrameTree"));
  });
  await control("an observed event and actual query must agree without replacing the commit", async () => {
    const p = popupGuard();
    p.navigate("loader");
    const commit = p.state.cdpCommit;
    await p.acknowledge();
    await p.page.assertGuard(p.wc);
    assert.equal(p.state.cdpCommit, commit);
  });
  await control("a fulfilled malformed installation ACK is refused", async () => {
    const p = popupGuard();
    await p.acknowledge({});
    assert.equal(p.state.installed, false);
    assert.equal(p.state.scriptIdentifier, null);
    await p.page.terminalCompletion;
    assert(p.page.results.some(result => /script identifier/.test(String(result.detail))));
  });
  for (const [name, ack] of [["missing", undefined], ["blank", { identifier: " \t" }]]) {
    await control(name + " script identifiers cannot arm the guard after original navigation", async () => {
      const p = popupGuard();
      assert(p.commands.includes("original-navigation"));
      await p.acknowledge(ack === undefined ? null : ack);
      await p.page.terminalCompletion;
      assert.equal(p.state.installed, false);
      assert.equal(p.state.scriptIdentifier, null);
      assert.equal(p.page.stickyFailure, true);
    });
  }
  await control("a rejected script installation remains fatal after original navigation", async () => {
    const p = popupGuard();
    assert(p.commands.includes("original-navigation"));
    await p.rejectInstallation();
    await p.page.terminalCompletion;
    assert.equal(p.state.installed, false);
    assert.equal(p.page.stickyFailure, true);
  });
  for (const [name, mutate] of [
    ["event/query disagreement", p => { p.navigate("different"); }],
    ["changed epoch", p => { p.page.query = async () => {
      p.state.epoch++;
      return { frameTree: { frame: { id: "frame", loaderId: "loader", url: p.page.indexURL } } };
    }; }],
    ["changed root identity", p => { p.page.query = async () => {
      p.frame.routingId++;
      return { frameTree: { frame: { id: "frame", loaderId: "loader", url: p.page.indexURL } } };
    }; }],
    ["missing loader", p => { p.page.query = async () => ({
      frameTree: { frame: { id: "frame", url: p.page.indexURL } },
    }); }],
    ["blank frame ID", p => { p.page.query = async () => ({
      frameTree: { frame: { id: " ", loaderId: "loader", url: p.page.indexURL } },
    }); }],
    ["blank loader", p => { p.page.query = async () => ({
      frameTree: { frame: { id: "frame", loaderId: " ", url: p.page.indexURL } },
    }); }],
    ["parented frame", p => { p.page.query = async () => ({
      frameTree: { frame: { id: "frame", loaderId: "loader", parentId: "parent", url: p.page.indexURL } },
    }); }],
    ["wrong URL", p => { p.page.query = async () => ({
      frameTree: { frame: { id: "frame", loaderId: "loader", url: p.page.indexURL + "#changed" } },
    }); }],
    ["query rejection", p => { p.page.query = async () => { throw new Error("query refused"); }; }],
    ["missing guard", p => { p.page.guardValue = null; }],
    ["tampered guard", p => { p.page.guardValue.intact = false; }],
  ]) {
    await control("root reconciliation rejects " + name, async () => {
      const p = popupGuard();
      await p.acknowledge();
      mutate(p);
      await assert.rejects(p.page.assertGuard(p.wc));
      assert.equal(p.state.documentToken, null);
      await p.page.terminalCompletion;
      assert.equal(p.page.results.filter(result => result.name === "popup fatal safety refusal").length, 1);
    });
  }
}

function popupCleanup(mode = "deferred", createInitialOwners = true) {
  const lines = [], events = [], registeredDirs = new Set(["fixture"]);
  const page = { console: { log: line => lines.push(line), error: line => lines.push(line) },
    setTimeout, clearTimeout, finishing: false, stickyFailure: false, footerWritten: false,
    tearingDown: false, ownerCleanupPromise: null, ownerCleanupResult: null, terminalCompletion: null,
    ownerInventoryInvalidated: false, ownerCleanupRecords: null, storageReady: true,
    exitOwner: false, watchdog: null, results: [], windows: new Map(), guards: new Map(),
    closedReports: new Map(), closing: new Set(), observers: [], downloadObservers: new Set(),
    pendingDownloads: new Set(), ownedFixtures: new Set(["fixture"]), retainedFixtures: new Set(),
    registeredDirs, popupSentinels: new Map(), netSentinel: [],
    process: { platform: process.platform, exitCode: 0, once: (_event, hook) => { page.exitHook = hook; },
      exit: code => events.push("process-exit:" + code) },
    fs: { writeSync: (_fd, text) => lines.push(text), existsSync: () => false },
    path, fileURLToPath: require("node:url").fileURLToPath,
    pathToFileURL, captureScreenshot: async () => "captured", writeReport: summary => events.push("report:" + summary),
    readableFile: "readable", PROBE_HOST: "probe.invalid" };
  const liveReads = [], postReads = [], registrationReads = [];
  let registrationWindow = null;
  const read = (name, operation) => {
    if (page.ownerCleanupPromise || page.finishing && page.finishing !== "normal") {
      postReads.push(name);
      throw new Error("forbidden post-cancellation read: " + name);
    }
    liveReads.push(name);
    return operation();
  };
  page.captureScreenshot = async () => read("capture", () => "captured");
  page.app = Object.assign(new EventEmitter(), {
    isReady: () => true, exit: code => events.push("app-exit:" + code) });
  page.session = { defaultSession: { webRequest: { onBeforeRequest: () => events.push("network-removed") } } };
  page.releaseTempDir = dir => {
    assert.equal(page.ownerCleanupResult, true);
    assert.equal(page.ownerInventoryMatches(), true);
    events.push("release:" + dir);
    registeredDirs.delete(dir);
    return true;
  };
  const context = vm.createContext(page);
  for (const [start, end] of [
    ["function assertLiveOwnerReads(", "async function reconcileRootCommit("],
    ["async function bounded(", "async function waitUntil("],
    ["function check(name, ok, detail)", "// Electron drops"],
    ["function documentScope(", "function assertMainOwner("],
    ["function inspectMutes(", "async function closeAll("],
    ["function retainOwnedFixtures(", "async function run()"],
    ['app.on("browser-window-created",', 'for (const channel of ["open-image-popup"'],
    ['process.once("exit",', '\n\nfs = require("fs");'],
    ["const exitWithSharedSweep =", "\ntrapExternalOpens().then"],
  ]) vm.runInContext(between(popups, start, end), context);
  function makeOwner(id, destructionMode = mode,
    url = "file:///C:/owned/" + (id === 1 ? "index" : "image") + ".html") {
    const win = new EventEmitter(), wc = new EventEmitter();
    win.id = id;
    let windowDestroyed = false, contentsDestroyed = false;
    const frame = { frameTreeNodeId: id, processId: id + 10, routingId: id + 20,
      url, parent: null, detached: false, isDestroyed: () => contentsDestroyed };
    for (const key of ["frameTreeNodeId", "processId", "routingId", "url", "parent", "detached"]) {
      let value = frame[key];
      Object.defineProperty(frame, key, { get: () => read("frame." + key, () => value),
        set: next => { value = next; } });
    }
    frame.executeJavaScript = code => read("evaluation", () => page.evaluate(code));
    Object.assign(wc, { id, isDestroyed: () => contentsDestroyed,
      getURL: () => read("URL", () => url),
      isLoadingMainFrame: () => read("loading", () => false),
      getLastWebPreferences: () => read("preferences", () => ({})) });
    Object.defineProperty(wc, "mainFrame", { get: () => read("mainFrame", () => frame) });
    const record = { id, contentsId: id, win, wc, frame, kind: id === 1 ? "main" : "image",
      stopped: false, resultOffset: 0, originalURL: url, destroyCalls: 0 };
    win.isDestroyed = () => windowDestroyed;
    win.destroy = () => {
      record.destroyCalls++;
      if (destructionMode === "throw") throw new Error("destruction failed");
      if (destructionMode === "events-only") {
        win.emit("closed");
        wc.emit("destroyed");
        return;
      }
      windowDestroyed = true;
      win.emit("closed");
      if (destructionMode === "deferred") setImmediate(() => record.completeContents());
    };
    record.completeContents = () => { contentsDestroyed = true; wc.emit("destroyed"); };
    record.sentinel = { stop: async () => ({ hits: [], stalls: [], mutes: [] }) };
    Object.defineProperty(win, "webContents", { get: () => {
      if (registrationWindow === win) {
        registrationWindow = null;
        registrationReads.push(id);
        return wc;
      }
      return read("window.contents", () => wc);
    } });
    return record;
  }
  for (let id = 1; createInitialOwners && id <= 2; id++) {
    const record = makeOwner(id), { wc, win } = record, frame = wc.mainFrame, url = wc.getURL();
    page.windows.set(id, record);
    page.popupSentinels.set(id, record.sentinel);
    page.guards.set(id, { wc, frame, epoch: 1, originalURL: url,
      cdpCommit: Object.freeze({ frameId: "frame-" + id, loaderId: "loader-" + id }),
      documentToken: "doc-" + id, guardEpoch: 1 });
    record.scope = page.documentScope(wc);
    if (id === 2) page.netSentinel.push({ type: "image", url: "https://example.invalid/d.png", contentsId: id });
  }
  return { page, context, read, liveReads, postReads, registrationReads, makeOwner, lines, events, records: [...page.windows.values()],
    lateOwner: () => {
      const late = makeOwner(3, "manual");
      // The new event's one contents lookup registers its cleanup target.
      // It does not permit any live document or existing-owner inspection.
      registrationWindow = late.win;
      try { page.app.emit("browser-window-created", null, late.win); }
      finally { registrationWindow = null; }
      assert.deepEqual(registrationReads, [3]);
      return late;
    } };
}

async function cancellationControls() {
  for (const [name, invoke] of [
    ["guard admission", p => p.page.assertGuard(p.wc)],
    ["root reconciliation", p => p.page.reconcileRootCommit(p.wc, p.state)],
    ["scope construction", p => p.page.documentScope(p.wc)],
    ["scope validation", p => p.page.assertDocumentScope(p.record.scope)],
    ["retained frame", p => p.page.isRetainedRoot(p.frame, p.record.scope)],
    ["Main owner", p => p.page.assertMainOwner()],
    ["popup evaluation", p => p.page.popupEval(p.record.win, "42")],
    ["preferences", p => p.page.prefsOf(p.record.win)],
  ]) {
    await control(name + " refuses before any live read after actual fatal cancellation", async () => {
      const p = popupGuard();
      await p.acknowledge();
      p.record.scope = await p.page.assertGuard(p.wc);
      p.page.fatal(new Error("controlled cancellation"));
      await assert.rejects(async () => invoke(p), /cancelled/);
      await p.page.terminalCompletion;
      assert.deepEqual(p.postReads, []);
      assert.equal(p.lines.filter(line => /^===/.test(line)).length, 1);
    });
  }
  for (const point of ["frame tree", "guard evaluation"]) {
    await control("fatal cancellation while awaiting " + point + " cannot admit or read its dead owner", async () => {
      const p = popupGuard(), entered = deferred(), tail = deferred();
      await p.acknowledge();
      const response = point === "frame tree" ?
        { frameTree: { frame: { id: "frame", loaderId: "loader", url: p.page.indexURL } } } :
        { ...p.page.guardValue };
      if (point === "frame tree") p.page.query = () => { entered.resolve(); return tail.promise; };
      else p.page.evaluate = () => { entered.resolve(); return tail.promise; };
      const attempt = assert.rejects(p.page.assertGuard(p.wc), /cancelled/);
      await entered.promise;
      p.page.fatal(new Error("controlled pending guard cancellation"));
      tail.resolve(response);
      await attempt;
      await p.page.terminalCompletion;
      assert.equal(p.state.documentToken, null);
      assert.equal(p.state.guardEpoch, null);
      assert.deepEqual(p.postReads, []);
      assert.equal(p.lines.filter(line => /^===/.test(line)).length, 1);
    });
  }
  await control("popup evaluation propagates fatal cancellation rather than an eval-error negative result", async () => {
    const p = popupGuard(), entered = deferred(), tail = deferred();
    await p.acknowledge();
    p.record.scope = await p.page.assertGuard(p.wc);
    p.page.evaluate = code => code.includes("?.read()") ? Promise.resolve(p.page.guardValue) :
      (entered.resolve(), tail.promise);
    const attempt = assert.rejects(p.page.popupEval(p.record.win, "42"), /cancelled/);
    await entered.promise;
    p.page.fatal(new Error("controlled pending evaluation cancellation"));
    tail.resolve(42);
    await attempt;
    await p.page.terminalCompletion;
    assert.deepEqual(p.postReads, []);
  });
  for (const caller of ["openPopup", "mainEval", "run"]) {
    await control(caller + " stops before live reads when fatal follows its actual guard result", async () => {
      const p = popupGuard();
      await p.acknowledge();
      const scope = p.record.scope = await p.page.assertGuard(p.wc);
      Object.assign(p.page, {
        hostWindow: p.record.win, hostContents: p.wc,
        mainIdentity: { generation: 1, pageSession: "page", scope },
        nativeGuards: new Map(), verifyStorage: () => true,
        refuseOwnedDialog: () => {}, OwnedDialogs: function OwnedDialogs() {},
        waitForExternalTrap: () => p.read("shell trap", () => Promise.resolve(true)),
      });
      p.page.OwnedDialogs.prototype.show = p.page.refuseOwnedDialog;
      const actual = p.page.assertGuard;
      p.page.assertGuard = async (...args) => {
        const result = await actual(...args);
        p.page.fatal(new Error("controlled completed-guard cancellation"));
        return result;
      };
      await assert.rejects(caller === "openPopup" ?
        p.page.openPopup("open-image-popup", {}) :
        caller === "mainEval" ? p.page.mainEval("42") : p.page.run(), /cancelled/);
      await p.page.terminalCompletion;
      assert.deepEqual(p.postReads, []);
      assert.equal(p.lines.filter(line => /^===/.test(line)).length, 1);
    });
  }
  await control("fatal cancellation during the startup bridge witness cannot re-read Main or admit it", async () => {
    const p = popupGuard(), entered = deferred(), tail = deferred();
    await p.acknowledge();
    p.page.evaluate = code => code.includes("?.read()") ? Promise.resolve(p.page.guardValue) :
      (entered.resolve(), tail.promise);
    const attempt = assert.rejects(p.page.run(), /cancelled/);
    await entered.promise;
    p.page.fatal(new Error("controlled startup witness cancellation"));
    tail.resolve({ generation: 1, pageSession: "page", bridge: true });
    await attempt;
    await p.page.terminalCompletion;
    assert.deepEqual(p.postReads, []);
    assert.equal(p.page.results.some(result => result.name.startsWith("Main binds")), false);
  });
  for (const owner of ["A", "B"]) {
    await control("SEC-20 directory continuation " + owner + " stops after its real wait without later reads or PASS", async () => {
      for (const cancel of [false, true]) {
        const p = popupCleanup("manual"), entered = deferred(), tail = deferred(), record = p.records[1];
        const start = "  await closePopup(mermaid" + owner + ");";
        const end = owner === "A" ? "  await closePopup(mermaidB);" : "\n  // -------------------------------------------------------------------------\n  // Pop-out render QUALITY";
        const source = between(popups, start, end);
        assert(source.includes("await sleep(700)"), "the actual run() timer must be held");
        const peer = owner === "A" ? p.makeOwner(3, "manual") : null;
        if (peer) {
          p.page.windows.set(peer.id, peer);
          p.records.push(peer);
        }
        Object.assign(p.page, {
          mermaidA: record.win, mermaidB: peer ? peer.win : record.win,
          dirA: "closed-A", dirB: "closed-B", pathB: "B.html",
          popupEval: async win => p.read("directory peer evaluation", () => {
            assert.equal(win, peer.win);
            assert.equal(peer.wc.isDestroyed(), false);
            return "B";
          }),
        });
        p.page.fs.existsSync = filename => p.read("directory filesystem", () =>
          owner === "A" && ["closed-B", "B.html"].includes(filename));
        p.page.setTimeout = (callback, ms, ...args) => ms === 700 ?
          (entered.resolve(), tail.promise.then(callback)) : setTimeout(callback, ms, ...args);
        vm.runInContext(between(popups, "const sleep =", "// Missing/failed setup") +
          "\nasync function directoryContinuation() {\n" + source + "\n}", p.context);
        const attempt = p.page.directoryContinuation();
        await tick();
        assert.equal(record.win.isDestroyed(), true);
        assert.equal(record.wc.isDestroyed(), false);
        record.completeContents();
        await entered.promise;
        const count = p.page.results.length;
        assert.equal(p.page.results.some(result => result.name.startsWith("SEC-20")), false);
        if (cancel) {
          p.page.fatal(new Error("controlled SEC-20 timer cancellation"));
          assert.equal(p.records[0].wc.isDestroyed(), false);
          assert.equal(p.page.footerWritten, false);
          const cancelledCount = p.page.results.length;
          const rejected = assert.rejects(attempt, /cancelled/);
          tail.resolve();
          await rejected;
          assert.equal(p.page.results.length, cancelledCount);
          assert.deepEqual(p.postReads, []);
        } else {
          tail.resolve();
          await attempt;
          assert.equal(p.page.results.length, count + 1);
          assert.equal(p.page.results.at(-1).ok, true);
          assert(p.liveReads.includes("directory filesystem"));
          p.page.fatal(new Error("positive control cleanup"));
        }
        for (const item of p.records) item.completeContents();
        await p.page.terminalCompletion;
        assert.equal(p.lines.filter(line => /^===/.test(line)).length, 1);
        assert(p.events.includes("app-exit:1"));
      }
    });
  }
  for (const point of ["capture", "overlay geometry"]) {
    await control("sharpness " + point + " propagates fatal cancellation instead of retrying or reporting a metric", async () => {
      const p = popupCleanup("manual"), entered = deferred(), tail = deferred(), record = p.records[1];
      record.win.showInactive = () => p.read("sharpness show", () => {});
      record.win.moveTop = () => p.read("sharpness move", () => {});
      const image = {
        getSize: () => p.read("sharpness image size", () => ({ width: 400, height: 120 })),
        toBitmap: () => p.read("sharpness bitmap", () => Buffer.alloc(400 * 120 * 4)),
      };
      p.page.popupEval = async () => p.read("sharpness evaluation", () => point === "capture" ? true :
        (entered.resolve(), tail.promise));
      record.win.capturePage = () => p.read("sharpness capture", () => point === "capture" ?
        (entered.resolve(), tail.promise) : Promise.resolve(image));
      if (point === "overlay geometry") {
        let calls = 0;
        p.page.popupEval = async () => p.read("sharpness evaluation", () => ++calls === 1 ? true :
          (entered.resolve(), tail.promise));
      }
      vm.runInContext(between(popups, "const sleep =", "// Missing/failed setup") +
        "\nconst OVERLAY_GUTTER_PX = 24;\n" +
        between(popups, "  async function softEdgeFraction(", "\n  async function measureViewport("), p.context);
      const rejected = assert.rejects(p.page.softEdgeFraction(record.win), /cancelled/);
      await entered.promise;
      p.page.fatal(new Error("controlled sharpness cancellation"));
      assert.equal(p.page.footerWritten, false);
      const count = p.page.results.length;
      if (point === "capture") tail.resolve(image);
      else tail.reject(new Error("controlled renderer cancellation"));
      await rejected;
      assert.deepEqual(p.postReads, []);
      assert.equal(p.page.results.length, count);
      for (const item of p.records) item.completeContents();
      await p.page.terminalCompletion;
      assert.equal(p.lines.filter(line => /^===/.test(line)).length, 1);
    });
  }
  for (const heldAttempt of [1, 4]) {
    await control("sharpness retry " + heldAttempt + " cancels before another window read or promoted-metric result", async () => {
      for (const cancel of [false, true]) {
        const p = popupCleanup("manual"), entered = deferred(), tail = deferred(), record = p.records[1];
        let attempts = 0, backoffs = 0;
        Object.assign(record.win, {
          showInactive: () => p.read("retry show", () => {}),
          moveTop: () => p.read("retry move", () => {}),
          capturePage: () => p.read("retry capture", () => {
            attempts++;
            throw new Error("controlled ordinary capture failure");
          }),
        });
        Object.assign(p.page, {
          popup: record.win, shippedWillChange: "auto", artifactName: "controlled-retry",
          shipped: { width: 400, height: 120, total: 12000, samplingWidth: 150, frameHash: "shipped" },
          popupEval: async () => p.read("retry fresh frame", () => true),
        });
        p.page.setTimeout = (callback, ms, ...args) => {
          if (ms !== 500) return setTimeout(callback, ms, ...args);
          if (++backoffs === heldAttempt) {
            entered.resolve();
            return tail.promise.then(callback);
          }
          return setImmediate(callback);
        };
        vm.runInContext(between(popups, "const sleep =", "// Missing/failed setup") +
          "\nconst OVERLAY_GUTTER_PX = 24, MIN_SAMPLING_WIDTH_PX = 128;\n" +
          between(popups, "  async function softEdgeFraction(", "\n  async function measureViewport(") +
          "\nasync function promotedContinuation() {\n" +
          between(popups, "    const promoted = await softEdgeFraction(popup);",
            "\n  await closeAll();\n  const sharpMermaid"), p.context);
        const attempt = p.page.promotedContinuation();
        await entered.promise;
        assert.equal(attempts, heldAttempt);
        assert.equal(backoffs, heldAttempt);
        assert.equal(p.page.results.length, 0);
        if (cancel) {
          p.page.fatal(new Error("controlled sharpness backoff cancellation"));
          assert.equal(p.page.footerWritten, false);
          assert(p.records.every(item => !item.wc.isDestroyed()));
          const count = p.page.results.length;
          const rejected = assert.rejects(attempt, /cancelled/);
          tail.resolve();
          await rejected;
          assert.equal(attempts, heldAttempt);
          assert.equal(p.page.results.length, count);
          assert.deepEqual(p.postReads, []);
        } else {
          tail.resolve();
          const result = await attempt;
          assert.equal(attempts, 4);
          assert.equal(backoffs, 4);
          assert.equal(result.promoted.total, 0);
          assert.match(result.promoted.captureFailed, /controlled ordinary capture failure/);
          assert.equal(p.page.results.length, 1);
          assert.equal(p.page.results[0].ok, false);
          p.page.fatal(new Error("ordinary retry control cleanup"));
        }
        for (const item of p.records) item.completeContents();
        await p.page.terminalCompletion;
        assert.equal(p.lines.filter(line => /^===/.test(line)).length, 1);
        assert(p.events.includes("app-exit:1"));
      }
    });
  }
}

async function cleanupControls() {
  await control("ordinary popup close awaits actual contents destruction", async () => {
    const p = popupCleanup("manual"), record = p.records[1];
    let complete = false;
    const closing = p.page.closePopup(record.win).then(() => { complete = true; });
    await tick();
    assert.equal(record.win.isDestroyed(), true);
    assert.equal(record.wc.isDestroyed(), false);
    assert.equal(complete, false);
    record.completeContents();
    await closing;
    assert.equal(complete, true);
  });
  await control("terminal callers join one result and destruction precedes registry release", async () => {
    const p = popupCleanup("manual");
    const first = p.page.destroyOwners(), second = p.page.destroyOwners();
    assert.equal(first, second);
    assert.equal(p.page.registeredDirs.has("fixture"), false);
    assert(p.records.every(record => record.destroyCalls === 1));
    for (const record of p.records) record.completeContents();
    assert.equal(await first, true);
    assert.equal(p.page.destroyOwners(), first);
    assert.equal(p.page.ownerInventoryMatches(), true);
    assert.equal(p.page.registeredDirs.has("fixture"), false);
    await p.page.completeTerminalExit(0);
    assert.equal(p.events.filter(event => event === "release:fixture").length, 1);
    assert(p.events.indexOf("release:fixture") < p.events.findIndex(event => event.startsWith("report:")));
    assert(p.events.includes("app-exit:0"));
  });
  for (const timing of ["during cleanup", "after cached success"]) {
    await control("late owner " + timing + " keeps fixtures retained and exit nonzero", async () => {
      const p = popupCleanup("manual");
      let late;
      if (timing === "during cleanup") {
        const ipc = new EventEmitter();
        ipc.prependListener("popup", () => p.page.fatal(new Error("deliberate unexpected popup receipt")));
        ipc.on("popup", () => { late = p.lateOwner(); });
        ipc.emit("popup");
      } else {
        const cleanup = p.page.destroyOwners();
        for (const record of p.records) record.completeContents();
        assert.equal(await cleanup, true);
        assert.equal(p.page.registeredDirs.has("fixture"), false);
        late = p.lateOwner();
      }
      assert.equal(p.page.windows.size, 3);
      assert.equal(late.destroyCalls, 1);
      assert.equal(late.wc.isDestroyed(), false);
      for (const record of p.records) record.completeContents();
      await p.page.terminalCompletion;
      assert.equal(p.page.ownerCleanupResult, false);
      assert.equal(p.page.ownerInventoryMatches(), false);
      assert.equal(p.page.registeredDirs.has("fixture"), false);
      assert.equal(p.page.retainedFixtures.has("fixture"), true);
      assert.equal(p.events.some(event => typeof event === "string" && event.startsWith("release:")), false);
      assert.equal(p.page.results.filter(result => result.name === "terminal popup owner inventory remained fixed").length, 1);
      assert.equal(p.lines.filter(line => /^===/.test(line)).length, 1);
      assert(p.events.includes("app-exit:1"));
      p.page.fatal(new Error("secondary late owner failure"));
      p.page.exitHook();
      assert.equal(p.lines.filter(line => /^===/.test(line)).length, 1);
      late.completeContents();
      await p.page.windows.get(late.id).destruction;
    });
  }
  await control("unconfirmed destruction remains a single sticky refusal with retained fixtures", async () => {
    const p = popupCleanup("never");
    assert.equal(await p.page.destroyOwners(), false);
    assert.equal(await p.page.destroyOwners(), false);
    assert.equal(p.page.registeredDirs.has("fixture"), false);
    assert.equal(p.page.retainedFixtures.has("fixture"), true);
    assert.equal(p.page.results.filter(result => result.name === "terminal popup cleanup completed").length, 1);
  });
  await control("destruction exceptions still cancel downloads and retain owned fixtures", async () => {
    const p = popupCleanup("throw");
    let canceled = 0;
    p.page.pendingDownloads.add({ cancel: () => { canceled++; } });
    assert.equal(await p.page.destroyOwners(), false);
    assert.equal(canceled, 1);
    assert.equal(p.page.retainedFixtures.has("fixture"), true);
  });
  await control("destruction events alone cannot confirm owners whose actual states remain live", async () => {
    const p = popupCleanup("events-only");
    assert.equal(await p.page.destroyOwners(), false);
    assert(p.records.every(record => !record.win.isDestroyed() && !record.wc.isDestroyed()));
    assert.equal(p.page.ownerInventoryMatches(), false);
    assert.equal(p.page.retainedFixtures.has("fixture"), true);
  });
  await control("fatal escalation cancels a finishing continuation and prints exactly one final footer", async () => {
    const p = popupCleanup(), drain = deferred();
    p.records[0].sentinel.stop = () => drain.promise;
    const normal = p.page.finish();
    await tick();
    p.page.fatal(new Error("deliberate fatal"));
    await p.page.terminalCompletion;
    const count = p.page.results.length, footer = p.lines.findIndex(line => /^===/.test(line));
    assert(footer >= 0);
    drain.resolve({ hits: [], stalls: [], mutes: [] });
    await normal;
    p.page.fatal(new Error("deliberate secondary"));
    p.page.exitHook();
    assert.equal(p.page.results.length, count);
    assert.equal(p.lines.filter(line => /^===/.test(line)).length, 1);
    assert.equal(p.lines.slice(footer + 1).some(line => /^(PASS|FAIL) /.test(line)), false);
    assert(p.events.includes("app-exit:1"));
    assert.deepEqual(p.postReads, []);
  });
  for (const point of ["sentinel stop", "capture"]) {
    await control("fatal cancellation joins ordinary close during " + point + " without later live reads", async () => {
      const p = popupCleanup(), entered = deferred(), tail = deferred(), record = p.records[1];
      if (point === "sentinel stop") record.sentinel.stop = () => { entered.resolve(); return tail.promise; };
      else {
        record.sentinel.stop = async () => ({ hits: ["controlled failure"], stalls: [], mutes: [] });
        p.page.captureScreenshot = () => { entered.resolve(); return tail.promise; };
      }
      const closing = assert.rejects(p.page.closePopup(record.win), /cancelled/);
      await entered.promise;
      p.page.fatal(new Error("controlled close cancellation"));
      await p.page.terminalCompletion;
      const count = p.page.results.length;
      tail.resolve(point === "capture" ? "captured" : { hits: [], stalls: [], mutes: [] });
      await closing;
      assert.deepEqual(p.postReads, []);
      assert.equal(p.page.results.length, count);
      assert.equal(p.lines.filter(line => /^===/.test(line)).length, 1);
    });
  }
  await control("fatal cancellation joins a finishing capture without another capture or footer", async () => {
    const p = popupCleanup(), entered = deferred(), tail = deferred();
    p.page.stickyFailure = true;
    let captures = 0;
    p.page.captureScreenshot = () => { captures++; entered.resolve(); return tail.promise; };
    const normal = p.page.finish();
    await entered.promise;
    p.page.fatal(new Error("controlled terminal capture cancellation"));
    await p.page.terminalCompletion;
    const count = p.page.results.length;
    tail.resolve("captured");
    await normal;
    assert.equal(captures, 1);
    assert.deepEqual(p.postReads, []);
    assert.equal(p.page.results.length, count);
    assert.equal(p.lines.filter(line => /^===/.test(line)).length, 1);
  });
  await control("normal finishing permits sentinel scope reads only until owner cleanup starts", async () => {
    const p = popupCleanup(), entered = deferred(), tail = deferred(), record = p.records[0];
    record.sentinel.stop = () => { entered.resolve(); return tail.promise; };
    const normal = p.page.finish();
    await entered.promise;
    p.page.assertDocumentScope(record.scope);
    assert.equal(p.page.isRetainedRoot(record.frame, record.scope), true);
    assert.equal(p.page.documentScope(record.wc).documentToken, record.scope.documentToken);
    tail.resolve({ hits: [], stalls: [], mutes: [] });
    await normal;
    assert(p.events.includes("app-exit:0"));
    assert.throws(() => p.page.documentScope(record.wc), /cancelled/);
    assert.deepEqual(p.postReads, []);
  });
  await control("process exit before verified cleanup refuses fixture sweeping synchronously", async () => {
    const p = popupCleanup("manual");
    p.page.exitHook();
    assert.equal(p.page.stickyFailure, true);
    assert.equal(p.page.ownerCleanupResult, false);
    assert.equal(p.page.registeredDirs.has("fixture"), false);
    assert.equal(p.page.retainedFixtures.has("fixture"), true);
    for (const record of p.records) record.completeContents();
    await p.page.ownerCleanupPromise;
    assert.equal(p.page.ownerCleanupResult, false);
    assert.equal(p.page.registeredDirs.has("fixture"), false);
  });
}

(async () => {
  await mermaidControls();
  await popupGuardControls();
  await cancellationControls();
  await cleanupControls();
  console.log("=== " + passed + "/" + passed + " Node-only contract controls passed ===");
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
