"use strict";

// Actual owned helpers and the unchanged Main continuation/timing functions.
// Transport, DOM, owned-dialog provider and lifecycle ports are simulated.
// No Electron or actual Main-owned dialog runs.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const sourcePath = path.join(__dirname, "test-tab-refresh.js");
const source = fs.readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
const mainPath = path.join(__dirname, "..", "src", "main.js");
const main = fs.readFileSync(mainPath, "utf8").replace(/\r\n/g, "\n");
new vm.Script(source, { filename: sourcePath });

function extract(text, name) {
  const start = text.indexOf(`function ${name}(`);
  const end = text.indexOf("\n}\n", start);
  assert(start >= 0 && end > start, `complete actual helper ${name}`);
  const prefix = text.slice(start - 6, start) === "async " ? "async " : "";
  return prefix + text.slice(start, end + 3);
}
let approvalSource = extract(source, "holdOrdinaryShutdownApproval");
let captureSource = extract(source, "captureOrdinaryShutdownDiscards");
const negative = process.argv[2];
if (negative) {
  const mutations = {
    "foreign-owner": [approvalSource, "event?.sender === wc && !wc.isDestroyed()",
      "true && !wc.isDestroyed()", "approval"],
    "cached-permission": [captureSource,
      "const content = selected === tab.id\n        ? editing ? window.markdownEditor.value : window.originalMarkdown\n        : tab.content;",
      "const content = tab.content;", "capture"],
    "queued-is-started": [extract(source, "waitForOrdinaryShutdownContinuation"),
      "Number.isFinite(record.continuationInvokedAt)", "true", "continuation"],
  };
  assert(Object.hasOwn(mutations, negative), "known private negative control");
  const [text, before, after, scope] = mutations[negative];
  assert.equal(text.split(before).length, 2, "one exact private mutation target");
  if (scope === "approval") approvalSource = text.replace(before, after);
  if (scope === "capture") captureSource = text.replace(before, after);
  console.log(`NEGATIVE CONTROL ${negative}: only extracted ${scope} code changed`);
}

function approvalFixture(options = {}) {
  const ipcMain = new EventEmitter();
  const frame = { parent: null, frameTreeNodeId: 7, isDestroyed: () => false };
  const sends = [];
  const wc = {
    mainFrame: frame, isDestroyed: () => false,
    send(...args) { sends.push({ receiver: this, args }); },
  };
  let state = {
    lastRequestId: 40, pendingId: 0, pendingReason: null,
    rendererGeneration: 3, rendererPageSession: "simulated-page-three",
  };
  const create = new vm.Script(
    `${extract(source, "replaceMethod")}\n${approvalSource}\nholdOrdinaryShutdownApproval;`,
  ).runInContext(vm.createContext({
    ipcMain, __shutdown: { state: () => ({ ...state }) },
  }));
  const originalSend = Object.getOwnPropertyDescriptor(wc, "send");
  const originalEmit = Object.getOwnPropertyDescriptor(ipcMain, "emit");
  const hold = create({ webContents: wc });
  const calls = [];
  ipcMain.on("quit-approval-response", function (...args) {
    calls.push({ receiver: this, args });
  });
  const request = { id: 41, gen: 3, reason: "window-close" };
  const reply = { id: 41, gen: 3, revision: 12, dirtyFiles: [] };
  const event = { sender: wc, senderFrame: frame };
  const arm = () => {
    state = { ...state, lastRequestId: 41, pendingId: 41, pendingReason: "window-close" };
    wc.send("quit-approval-request", request, "original-send-extra");
  };
  const capture = (...extra) => ipcMain.emit("quit-approval-response", event, reply, ...extra);
  const restored = () => {
    assert.deepEqual(Object.getOwnPropertyDescriptor(wc, "send"), originalSend);
    assert.deepEqual(Object.getOwnPropertyDescriptor(ipcMain, "emit"), originalEmit);
  };
  return { ipcMain, frame, wc, sends, calls, hold, request, reply, event, arm, capture, restored,
    update: value => { state = { ...state, ...value }; }, options };
}

function pageFixture(options = {}) {
  const root = path.join(path.parse(process.cwd()).root, "ordinary-vm-fixtures");
  const file = path.join(root, "active.md");
  const background = path.join(root, "background.md");
  const owner = id => ({
    pageSession: "simulated-page", rendererGeneration: 4, tabId: id,
    documentGeneration: 2, pathKey: String(id), documentRef: `simulated-ref-${id}`,
  });
  const active = { id: 1, filename: "active.md", filePath: file,
    content: "OLD CACHE", originalContent: "OLD CACHE" };
  const other = { id: 2, filename: "background.md", filePath: background,
    content: "BACKGROUND EDIT", originalContent: "BACKGROUND BASE" };
  const tabs = [active, other];
  let editing = !!options.editing;
  const inputs = [];
  const editor = {
    value: options.editorText || "LIVE EDIT",
    readOnly: !!options.readOnly,
    dispatchEvent(event) {
      inputs.push(event);
      if (options.eagerCache) active.content = this.value;
    },
  };
  const window = {
    originalMarkdown: "VIEW EDIT", markdownEditor: options.noEditor ? null : editor,
    getReloadRequestSession: () => "simulated-page",
    CustomTabs: {
      isDocumentFrozen: () => !!options.frozen,
      __inEditMode: () => editing,
      getActiveTabId: () => 1,
      getActiveTab: () => active,
      getTabs: () => tabs,
      getDocumentIdentityForTab: id => owner(id),
      __documentState: tab => ({ dirty: tab === other }),
      async settleSessionLayout() {},
    },
  };
  const page = vm.createContext({
    window,
    document: {
      body: { inert: !!options.inert },
      getElementById(id) {
        assert.equal(id, "toggleEdit");
        return { click() { editing = !editing; editor.value = active.content; } };
      },
    },
    Event: class { constructor(type, init) { this.type = type; this.bubbles = init.bubbles; } },
  });
  const exec = async code => new vm.Script(code).runInContext(page);
  return { root, file, background, owner, active, other, tabs, window, editor, inputs, exec, page,
    editing: () => editing };
}

function capture(f, phase = "owned VM retirement") {
  const fn = new vm.Script(`${captureSource}\ncaptureOrdinaryShutdownDiscards;`)
    .runInContext(vm.createContext({ path, dir: f.root }));
  return fn(f.exec, phase);
}

function input(f, marker = "ACTUAL_HELPER_INPUT") {
  const fn = new vm.Script(
    `${extract(source, "editOrdinaryShutdownFixture")}\neditOrdinaryShutdownFixture;`,
  ).runInContext(vm.createContext({
    waitForCondition: async (run, expression) => run(expression),
  }));
  return fn(f.exec, marker);
}

function renderFixture() {
  let release;
  let reject;
  let painted = false;
  const calls = [];
  const active = { id: 1, filePath: "C:\\simulated\\alpha.md", content: "OLD" };
  const render = new Promise((resolve, refuse) => { release = resolve; reject = refuse; })
    .then(() => { painted = true; });
  const window = {
    renderMarkdown: function (...args) { calls.push({ receiver: this, args }); return render; },
    CustomTabs: {
      async switchToTab(id) {
        active.id = id;
        window.renderMarkdown("SIMULATED_RENDER");
      },
      async settleSessionLayout() { assert.equal(painted, true); },
      getActiveTab: () => active,
    },
  };
  const descriptor = Object.getOwnPropertyDescriptor(window, "renderMarkdown");
  const page = vm.createContext({
    window, document: { getElementById: () => ({ textContent: painted ? "PAINTED" : "OLD" }) },
  });
  const exec = async code => new vm.Script(code).runInContext(page);
  const helper = new vm.Script(`${extract(source, "withOrdinaryShutdownCleanup")}\n${
    extract(source, "switchOrdinaryShutdownFixture")}\nswitchOrdinaryShutdownFixture;`)
    .runInContext(vm.createContext({}));
  return { window, descriptor, calls, release, reject,
    run: () => helper(exec, 2, "PAINTED") };
}

function questionFixture({ click = "returns" } = {}) {
  const state = {
    pendingId: 31, pendingReason: "window-close",
    rendererGeneration: 4, rendererPageSession: "simulated-question-page",
  };
  const owner = { isDestroyed: () => false, webContents: { isDestroyed: () => false } };
  const rig = { dialogs: [], answer: 1 };
  const tails = [];
  const guarded = function () { throw new Error("shared guard refused unexpected question"); };
  class DialogProvider {}
  DialogProvider.prototype.show = guarded;
  const provider = new DialogProvider();
  provider.owners = new Map();
  const options = {
    title: "Unsaved changes", message: '"active.md" has unsaved changes.',
    detail: "Simulated presentation", buttons: ["Discard changes", "Cancel"],
    defaultId: 1, cancelId: 1, isCurrent: () => true, signal: { aborted: false },
  };
  let producer = null;
  let providerCalls = 0;
  let request = null;
  const originalProvider = function (actualOwner, actualOptions) {
    providerCalls += 1;
    assert.equal(this, provider);
    assert.equal(actualOwner, owner);
    assert.equal(actualOptions, options);
    let resolve;
    producer = new Promise(done => { resolve = done; });
    const host = Object.assign(new EventEmitter(), {
      destroyed: false, isDestroyed() { return this.destroyed; },
      isVisible: () => true, getParentWindow: () => owner,
      destroy() {
        this.destroyed = true;
        request.done = true;
        this.emit("closed");
        resolve({ response: 1, cause: "cancel", displayed: true, failed: false });
      },
      webContents: {
        getURL: () => "file:///simulated-owned-dialog.html",
        getLastWebPreferences: () => ({
          nodeIntegration: false, contextIsolation: true, sandbox: true,
        }),
        async executeJavaScript(code) {
          if (code.includes("appMessageDialog')?.open")) return true;
          const choice = code.match(/data-dialog-choice="(\d+)"/);
          if (choice) {
            if (click === "refuses") throw new Error("simulated click transport refused before choice");
            host.destroyed = true;
            request.done = true;
            host.emit("closed");
            resolve({ response: Number(choice[1]), cause: "choice", displayed: true, failed: false });
            if (click === "held") return new Promise(() => {});
            if (click === "rejects-after-close") {
              throw new Error("simulated evaluation response lost after host destruction");
            }
            return true;
          }
          return {
            title: options.title, message: options.message, detail: options.detail,
            buttons: options.buttons.slice(), focused: "1",
          };
        },
      },
    });
    request = {
      id: "simulated-broker-request", owner, sender: owner.webContents, options,
      window: host, displayed: true, done: false,
    };
    this.owners.set(owner, { active: request, queue: [] });
    return producer;
  };
  const install = new vm.Script(`${extract(source, "replaceMethod")}\n${
    extract(source, "withOrdinaryShutdownCleanup")}\n${
    extract(source, "installMainOwnedShutdownQuestions")}\n${
    extract(source, "installOrdinaryShutdownQuestions")}\ninstallOrdinaryShutdownQuestions;`)
    .runInContext(vm.createContext({
      OwnedDialogs: DialogProvider, realOwnedDialogShow: originalProvider,
      __shutdown: { state: () => ({ ...state }) },
      ownedDialogUrl: "file:///simulated-owned-dialog.html",
      waitUntil: async predicate => predicate(), setTimeout, clearTimeout, Date,
    }));
  const actor = install(owner, rig, tails);
  return {
    actor, rig, state, tails, options, provider, owner, guarded,
    host: () => request?.window,
    producer: () => producer, providerCalls: () => providerCalls,
    async join() {
      let timeout;
      try {
        await Promise.race([
          Promise.all(tails),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(
              "Simulated original question settled but its driver did not join")), 500);
          }),
        ]);
      } finally { clearTimeout(timeout); }
    },
    show: (actualOwner = owner, actualOptions = options) =>
      provider.show(actualOwner, actualOptions),
  };
}

const cases = [
  ["the full test suite compiles without importing or launching Electron", () => {
    assert(source.includes("async function runShutdownScenarios("));
  }],
  ["the exact outgoing Main request, receiver and extra argument pass through", () => {
    const f = approvalFixture();
    try {
      f.arm();
      assert.equal(f.sends.length, 1);
      assert.equal(f.sends[0].receiver, f.wc);
      assert.equal(f.sends[0].args[1], f.request);
      assert.equal(f.sends[0].args[2], "original-send-extra");
      assert.equal(f.hold.request, f.request);
    } finally { f.hold.dispose(); f.restored(); }
  }],
  ["release uses the original ingress event, payload, extra argument and emitter receiver once", () => {
    const f = approvalFixture();
    try {
      f.arm();
      const extra = {};
      f.capture(extra);
      assert.equal(f.calls.length, 0);
      assert.equal(f.hold.response, f.reply);
      f.hold.release();
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].receiver, f.ipcMain);
      assert.equal(f.calls[0].args[0], f.event);
      assert.equal(f.calls[0].args[1], f.reply);
      assert.equal(f.calls[0].args[2], extra);
      assert.throws(() => f.hold.release(), /cannot be released twice/);
    } finally { f.hold.dispose(); f.restored(); }
  }],
  ["foreign-window and subframe simulated events are never held", () => {
    const f = approvalFixture();
    try {
      f.arm();
      f.ipcMain.emit("quit-approval-response", { sender: {}, senderFrame: f.frame }, f.reply);
      f.ipcMain.emit("quit-approval-response",
        { sender: f.wc, senderFrame: { ...f.frame, parent: f.frame } }, f.reply);
      assert.equal(f.calls.length, 2);
      assert.equal(f.hold.response, null);
    } finally { f.hold.dispose(); f.restored(); }
  }],
  ["different channels, request ids and generations pass through unchanged", () => {
    const f = approvalFixture();
    try {
      f.arm();
      let other = 0;
      f.ipcMain.on("other", () => { other += 1; });
      f.ipcMain.emit("other", f.event, f.reply);
      f.ipcMain.emit("quit-approval-response", f.event, { ...f.reply, id: 42 });
      f.ipcMain.emit("quit-approval-response", f.event, { ...f.reply, gen: 4 });
      assert.equal(other, 1);
      assert.equal(f.calls.length, 2);
      assert.equal(f.hold.response, null);
    } finally { f.hold.dispose(); f.restored(); }
  }],
  ["a page, generation or pending-attempt change prevents release", () => {
    for (const change of [
      { rendererPageSession: "replacement" }, { rendererGeneration: 4 }, { pendingId: 42 },
    ]) {
      const f = approvalFixture();
      try {
        f.arm(); f.capture(); f.update(change);
        assert.throws(() => f.hold.release(), /another attempt/);
        assert.equal(f.calls.length, 0);
      } finally { f.hold.dispose(); f.restored(); }
    }
  }],
  ["retirement is named, one-use and never delivers a substitute result", () => {
    const f = approvalFixture();
    try {
      f.arm(); f.capture();
      assert.throws(() => f.hold.retire(""), /without a reason/);
      f.hold.retire("simulated fallback consumed the request");
      assert.throws(() => f.hold.retire("again"), /twice/);
      assert.throws(() => f.hold.release(), /cannot be released/);
      assert.equal(f.calls.length, 0);
    } finally { f.hold.dispose(); f.restored(); }
    assert.equal(f.hold.snapshot().retired, "simulated fallback consumed the request");
  }],
  ["independent ingress restoration still runs when send ownership is lost", () => {
    const f = approvalFixture();
    f.arm(); f.capture();
    const foreign = () => {};
    f.wc.send = foreign;
    assert.throws(() => f.hold.dispose(), /restoration failed/);
    assert.equal(f.wc.send, foreign);
    assert.equal(Object.hasOwn(f.ipcMain, "emit"), false);
    assert.equal(f.hold.snapshot().restored, false);
    assert.equal(f.hold.snapshot().restorationAttempted, true);
  }],
  ["active editor permission uses live text while the old cache stays unchanged", async () => {
    const f = pageFixture({ editing: true });
    const result = await capture(f);
    const active = result.find(record => record.tabId === 1);
    assert(active, "the live active permission must exist");
    assert.equal(active.content, "LIVE EDIT");
    assert.deepEqual(JSON.parse(JSON.stringify(active.owner)), f.owner(1));
    assert.equal(active.filePath, f.file);
    assert(active.reason.includes("owned VM retirement"));
    assert.equal(f.active.content, "OLD CACHE");
  }],
  ["active view and inactive permission use their distinct actual source stores", async () => {
    const f = pageFixture();
    const result = await capture(f);
    assert(result.some(record => record.tabId === 1), "the live view permission must exist");
    assert.equal(result.find(record => record.tabId === 1).content, "VIEW EDIT");
    assert.equal(result.find(record => record.tabId === 2).content, "BACKGROUND EDIT");
  }],
  ["clean files need no discard permission", async () => {
    const f = pageFixture();
    f.window.originalMarkdown = f.active.originalContent;
    f.other.content = f.other.originalContent;
    f.window.CustomTabs.__documentState = () => ({ dirty: false });
    assert.equal((await capture(f)).length, 0);
  }],
  ["frozen, unreadable and out-of-directory fixtures refuse before shared close", async () => {
    await assert.rejects(capture(pageFixture({ frozen: true })), /still frozen/);
    await assert.rejects(capture(pageFixture({ editing: true, noEditor: true })), /cannot read/);
    const f = pageFixture();
    f.active.filePath = path.join(path.dirname(f.root), "not-ours.md");
    await assert.rejects(capture(f), /outside the test fixture/);
  }],
  ["retirement passes exact permissions and joins shared close before layout", async () => {
    const f = pageFixture({ editing: true });
    const order = [];
    let permission;
    const create = new vm.Script(`${captureSource}\n${
      extract(source, "retireOrdinaryShutdownFixtures")}\nretireOrdinaryShutdownFixtures;`)
      .runInContext(vm.createContext({
        path, dir: f.root,
        closeOwnedFixtureTabs: async (_run, phase, options) => {
          permission = options.expectedDiscards;
          assert.equal(phase, "ordered retirement");
          order.push("close-start");
          await Promise.resolve();
          order.push("close-return");
          return { records: [], remaining: [] };
        },
      }));
    f.window.CustomTabs.settleSessionLayout = async () => { order.push("layout"); };
    await create(f.exec, "ordered retirement");
    assert.equal(permission[0].content, "LIVE EDIT");
    assert.deepEqual(order, ["close-start", "close-return", "layout"]);
  }],
  ["a shared-close rejection does not become an empty successful retirement", async () => {
    const f = pageFixture();
    let layout = 0;
    f.window.CustomTabs.settleSessionLayout = async () => { layout += 1; };
    const create = new vm.Script(`${captureSource}\n${
      extract(source, "retireOrdinaryShutdownFixtures")}\nretireOrdinaryShutdownFixtures;`)
      .runInContext(vm.createContext({
        path, dir: f.root,
        closeOwnedFixtureTabs: async () => { throw new Error("genuine supplier refusal"); },
      }));
    await assert.rejects(create(f.exec, "refused retirement"), /supplier refusal/);
    assert.equal(layout, 0);
  }],
  ["the actual input actor preserves the supplied separate cache and live witnesses", async () => {
    const f = pageFixture();
    const result = await input(f);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.inputs[0].type, "input");
    assert.equal(f.inputs[0].bubbles, true);
    assert.equal(result.cacheAfter, "OLD CACHE");
    assert.equal(result.baselineAfter, "OLD CACHE");
    assert(result.live.includes("ACTUAL_HELPER_INPUT"));
    assert.equal(f.editing(), true);
  }],
  ["inert, read-only, empty-input and eager-cache collaborators cannot satisfy the input actor", async () => {
    await assert.rejects(input(pageFixture({ inert: true })), /did not reach/);
    await assert.rejects(input(pageFixture({ readOnly: true })), /did not reach/);
    await assert.rejects(input(pageFixture(), ""), /nonempty edit marker/);
    await assert.rejects(input(pageFixture({ eagerCache: true })), /independent live and cache/);
  }],
  ["the switch actor joins the original render after switchToTab has returned", async () => {
    const f = renderFixture();
    let outcome = null;
    const work = f.run().then(
      value => { outcome = { value }; }, error => { outcome = { error }; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].receiver, f.window);
      assert.equal(outcome, null);
    } finally { f.release(); }
    await work;
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.value.tabId, 2);
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.window, "renderMarkdown"), f.descriptor);
  }],
  ["a rejected original render stays a failure and still restores its descriptor", async () => {
    const f = renderFixture();
    const work = f.run();
    f.reject(new Error("original render rejected"));
    await assert.rejects(work, /original render rejected/);
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.window, "renderMarkdown"), f.descriptor);
  }],
  ["render failure and lost observation ownership are both retained", async () => {
    const f = renderFixture();
    const foreign = () => {};
    const work = f.run();
    await Promise.resolve();
    f.window.renderMarkdown = foreign;
    f.reject(new Error("primary renderer failure"));
    await assert.rejects(work, error =>
      error.errors?.length === 2 && /primary renderer failure/.test(error.message) &&
      /observation ownership changed/.test(error.message));
    assert.equal(f.window.renderMarkdown, foreign);
  }],
  ["ordinary cleanup retains the primary failure and runs every independent restoration", async () => {
    const cleanup = new vm.Script(
      `${extract(source, "withOrdinaryShutdownCleanup")}\nwithOrdinaryShutdownCleanup;`)
      .runInContext(vm.createContext({}));
    const primary = new Error("primary");
    const secondary = new Error("secondary");
    const order = [];
    await assert.rejects(cleanup(() => { throw primary; }, [
      () => { order.push("first"); throw secondary; },
      async () => { order.push("second"); },
    ]), error => error.errors?.[0] === primary && error.errors[1] === secondary &&
      /primary/.test(error.message) && /secondary/.test(error.message));
    assert.deepEqual(order, ["first", "second"]);
    assert.equal(await cleanup(() => 17, [() => { order.push("third"); }]), 17);
  }],
  ["the owned-question actor returns and joins the simulated original provider Promise", async () => {
    const f = questionFixture();
    const result = f.show();
    assert.equal(result, f.producer());
    await Promise.all(f.tails);
    assert.equal(f.providerCalls(), 1);
    assert.equal(f.rig.dialogs.length, 1);
    assert.equal(f.rig.dialogs[0].displayed, true);
    assert.equal(f.rig.dialogs[0].response, 1);
    assert.equal(f.rig.dialogs[0].result.cause, "choice");
    f.actor.restore();
    assert.equal(f.provider.show, f.guarded);
    assert.throws(() => f.actor.restore(), /restored twice/);
  }],
  ["destroying the answered host releases the driver even when its evaluation never returns", async () => {
    const f = questionFixture({ click: "held" });
    const producer = f.show();
    assert.equal(producer, f.producer());
    await f.join();
    assert.equal((await producer).cause, "choice");
    assert.equal(f.rig.dialogs[0].driverSettled, true);
    assert.equal(f.host().listenerCount("closed"), 0);
    f.actor.restore();
  }],
  ["host destruction does not turn its lost evaluation response into a failed genuine choice", async () => {
    const f = questionFixture({ click: "rejects-after-close" });
    const producer = f.show();
    await f.join();
    assert.equal((await producer).response, 1);
    assert.equal(f.rig.dialogs[0].driverError, null);
    assert.equal(f.host().listenerCount("closed"), 0);
    f.actor.restore();
  }],
  ["a refused choice evaluation remains a failure and joins owned cancellation and listener cleanup", async () => {
    const f = questionFixture({ click: "refuses" });
    const producer = f.show();
    await assert.rejects(f.join(), /simulated click transport refused before choice/);
    assert.equal((await producer).cause, "cancel");
    assert.equal(f.host().isDestroyed(), true);
    assert.equal(f.host().listenerCount("closed"), 0);
    f.actor.restore();
  }],
  ["foreign and unexpected owned questions still reach the unchanged guard", () => {
    const f = questionFixture();
    try {
      assert.throws(() => f.show({ webContents: {} }), /shared guard refused/);
      assert.throws(() => f.show(f.owner, { ...f.options, title: "Unrelated permission" }),
        /shared guard refused/);
      assert.throws(() => f.show(f.owner, { ...f.options, cancelId: 0 }), /shared guard refused/);
      assert.equal(f.providerCalls(), 0);
      assert.equal(f.tails.length, 0);
    } finally { f.actor.restore(); }
  }],
  ["held owned-question work prevents restoration until its original result settles", async () => {
    const f = questionFixture();
    let release;
    f.rig.answer = () => new Promise(resolve => { release = resolve; });
    const result = f.show();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.rig.dialogs.length, 1);
    assert.equal(f.rig.dialogs[0].response, null);
    assert.throws(() => f.actor.restore(), /legacy answer work unjoined/);
    release(0);
    await Promise.all(f.tails);
    assert.equal((await result).response, 0);
    f.actor.restore();
  }],
  ["an owner-attempt change while the answer is held fails and cancels, never approves", async () => {
    const f = questionFixture();
    let release;
    f.rig.answer = () => new Promise(resolve => { release = resolve; });
    const result = f.show();
    await new Promise(resolve => setImmediate(resolve));
    f.state.pendingId += 1;
    release(0);
    const outcomes = await Promise.allSettled(f.tails);
    assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 2);
    assert.match(outcomes[1].reason.message, /choice is stale/);
    assert.match(outcomes[2].reason.message, /choice is stale/);
    assert.equal((await result).cause, "cancel");
    assert.equal(f.rig.dialogs[0].result.cause, "cancel");
    assert.equal(f.rig.dialogs[0].choiceDelivered, false);
    f.actor.restore();
  }],
  ["queued production continuation is not mistaken for a started async handoff", async () => {
    const actualFunctions = [
      "enableShutdownTiming", "beginShutdownTiming", "markShutdownTiming",
      "completeShutdownTiming", "shutdownTimingState", "runApprovedContinuations",
    ].map(name => extract(main, name)).join("\n");
    const completedLimit = main.match(/^const SHUTDOWN_TIMING_COMPLETED_LIMIT = \d+;$/m);
    assert(completedLimit, "actual timing limit declaration exists");
    let helper = extract(source, "waitForOrdinaryShutdownContinuation");
    if (negative === "queued-is-started") {
      helper = helper.replace("Number.isFinite(record.continuationInvokedAt)", "true");
    }
    const queued = [];
    let entered = 0;
    let polls = 0;
    const context = vm.createContext({
      performance, setImmediate: callback => queued.push(callback),
      isUpdaterShutdownReason: () => false,
      isSameShutdownDocumentSession: () => true,
      grantShutdownAuthorization() {}, revokeShutdownAuthorization() {}, releaseShutdownFreeze() {},
      declineIntent() {}, log() {},
      waitUntil: async predicate => {
        if (await predicate()) return true;
        polls += 1;
        assert.equal(entered, 0);
        assert.equal(queued.length, 1);
        queued.shift()();
        return predicate();
      },
    });
    const run = new vm.Script(`
      ${completedLimit[0]}
      let shutdownTimingRecords = null;
      let shutdownTimingCompletedCount = 0;
      let deletionEvidenceCapacityLatched = false;
      let updaterContinuationEpoch = 0, shutdownRequestSeq = 1, shutdownContinuationEpoch = 0;
      let shutdownPendingContinuationCount = 0;
      const SHUTDOWN_CONTINUATION_PENDING = Symbol('pending');
      ${actualFunctions}
      const __shutdown = { timing: { state: shutdownTimingState } };
      ${helper}
      enableShutdownTiming();
      beginShutdownTiming(1, 'window-close');
      ({
        queue: continuation => runApprovedContinuations(
          [{ reason: 'window-close', continuation }], 1, {}, 1, 0, 0, false),
        wait: () => waitForOrdinaryShutdownContinuation('window-close', 0),
        pending: () => shutdownPendingContinuationCount,
      });
    `).runInContext(context);
    run.queue(() => { entered += 1; return false; });
    assert.equal(run.pending(), 0);
    assert.equal(entered, 0);
    const result = await run.wait();
    assert.equal(polls, 1);
    assert.equal(entered, 1);
    assert(Number.isFinite(result.continuationInvokedAt));
    assert.equal(run.pending(), 0);
  }],
];

const completionDeadline = setTimeout(() => {
  throw new Error("Ordinary source controls did not reach their complete result");
}, 110000);
(async () => {
  let failures = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
  }
  console.log(`ordinary source/VM: ${cases.length - failures}/${cases.length}; native NOT RUN`);
  console.log("Simulated sender events do not qualify Main sender authentication or deferred R573.");
  clearTimeout(completionDeadline);
  process.exitCode = failures ? 1 : 0;
})();
