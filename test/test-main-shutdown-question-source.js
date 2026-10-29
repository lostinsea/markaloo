"use strict";

// Whole production provider/preload; Electron, DOM and Main state are simulated.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const root = process.cwd();
const suitePath = process.argv[2] || path.join(root, "test", "test-tab-refresh.js");
const suite = fs.readFileSync(suitePath, "utf8").replace(/\r\n/g, "\n");
const providerPath = path.join(root, "src", "owned-dialogs.js");
const preloadPath = path.join(root, "src", "owned-dialog-preload.js");
const providerSource = fs.readFileSync(providerPath, "utf8");
const preloadSource = fs.readFileSync(preloadPath, "utf8");
const extract = name => {
  const start = suite.indexOf(`function ${name}(`);
  const end = suite.indexOf("\n}\n", start);
  assert(start >= 0 && end > start, `complete actual ${name}`);
  return (suite.slice(start - 6, start) === "async " ? "async " : "") + suite.slice(start, end + 3);
};
const driverSource = ["replaceMethod", "withOrdinaryShutdownCleanup",
  "installMainOwnedShutdownQuestions", "installOrdinaryShutdownQuestions"].map(extract).join("\n");
const hash = source => crypto.createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
const bindings = {
  suite: hash(suite), provider: hash(providerSource), preload: hash(preloadSource),
  helpers: hash(driverSource), actualMainModuleExecuted: false,
};
if (process.argv[3]) {
  const expected = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  for (const key of ["suite", "provider", "preload", "helpers"]) {
    assert.equal(bindings[key], expected[key], `pinned ${key} input`);
  }
  for (const name of ["installMainOwnedShutdownQuestions", "installOrdinaryShutdownQuestions"]) {
    assert.equal(hash(extract(name)), expected.fragments[name], `reviewed ${name} fragment`);
  }
}
console.log("SOURCE BINDINGS " + JSON.stringify({
  ...bindings, pinnedInputsVerified: Boolean(process.argv[3]),
}));

function fixture(settings = {}) {
  const ipcMain = new EventEmitter();
  const timers = new Map();
  const timeout = (callback, delay, ...args) => {
    const handle = setTimeout(() => { timers.delete(handle); callback(...args); }, delay);
    timers.set(handle, "timeout");
    return handle;
  };
  const interval = (callback, delay, ...args) => {
    const handle = setInterval(callback, delay, ...args);
    timers.set(handle, "interval");
    return handle;
  };
  const clear = handle => { clearTimeout(handle); clearInterval(handle); timers.delete(handle); };
  const children = [];
  const owner = new EventEmitter();
  owner.destroyed = false;
  owner.isDestroyed = () => owner.destroyed;
  owner.webContents = Object.assign(new EventEmitter(), {
    destroyed: false, crashed: false,
    isDestroyed() { return this.destroyed; }, isCrashed() { return this.crashed; },
    mainFrame: { url: "file:///simulated-folia.html", detached: false, destroyed: false,
      isDestroyed() { return this.destroyed; } },
    send() {},
  });
  owner.destroy = (order = "owner-first") => {
    if (owner.destroyed) return;
    if (order === "child-first") for (const child of children) child.destroy();
    owner.destroyed = true;
    owner.webContents.destroyed = true;
    owner.emit("closed");
    for (const child of children) child.destroy();
  };
  let faultRandom = false;
  let randomError = null;
  const sends = [];
  class Child extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.dom = null;
      this.bridge = null;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "", isDestroyed: () => this.destroyed },
        isDestroyed: () => this.destroyed, isCrashed: () => false,
        getURL: () => this.webContents.mainFrame.url,
        getLastWebPreferences: () => options.webPreferences,
        setWindowOpenHandler() {},
        send: (channel, data) => this.transport.emit(channel, {}, data),
        executeJavaScript: async code => {
          if (code.includes("appMessageDialog')?.open")) {
            if (settings.holdPresentation) return new Promise(() => {});
            return this.dom !== null;
          }
          const choice = code.match(/data-dialog-choice="(\d+)"/);
          if (choice) {
            if (settings.click === "refused") throw new Error("controlled evaluation refused before choice");
            if (settings.click === "refused-falsy") throw null;
            sends.push(Number(choice[1]));
            this.bridge.respond(Number(choice[1]), "choice");
            if (settings.click === "held") return new Promise(() => {});
            if (settings.click === "reject-after-close") throw new Error("closed renderer lost evaluation");
            return true;
          }
          return {
            title: this.dom.title, message: this.dom.message, detail: this.dom.detail,
            buttons: this.dom.buttons.slice(), focused: String(this.dom.defaultId),
          };
        },
      });
      this.transport = Object.assign(new EventEmitter(), {
        send: (channel, data) => ipcMain.emit(channel, {
          sender: this.webContents, senderFrame: this.webContents.mainFrame,
        }, data),
      });
      children.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    getParentWindow() { return this.options.parent; }
    setMenu() {}
    show() { this.visible = true; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
    async loadFile(file) {
      this.webContents.mainFrame.url = pathToFileURL(file).href;
      await Promise.resolve();
      if (this.destroyed || settings.delayReady) return;
      const context = vm.createContext({
        process: { argv: this.options.webPreferences.additionalArguments },
        require: name => {
          assert.equal(name, "electron");
          return { ipcRenderer: this.transport,
            contextBridge: { exposeInMainWorld: (key, api) => {
              assert.equal(key, "ownedDialog");
              assert(Object.isFrozen(api));
              this.bridge = api;
            } } };
        },
      });
      vm.runInContext(preloadSource, context, { filename: preloadPath });
      this.bridge.ready(options => {
        this.dom = options;
        this.bridge.displayed();
      }, () => {});
    }
  }
  const partition = Object.assign(new EventEmitter(), {
    webRequest: { onBeforeRequest() {} },
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
  });
  const module = { exports: {} };
  vm.runInNewContext(providerSource, {
    module, exports: module.exports, __dirname: path.dirname(providerPath),
    setTimeout: timeout, setInterval: interval, clearTimeout: clear, clearInterval: clear,
    require: name => {
      if (name === "electron") return {
        BrowserWindow: Child, ipcMain, session: { fromPartition: () => partition },
      };
      if (name === "crypto") return { randomBytes: size => {
        if (faultRandom) { faultRandom = false; throw randomError; }
        return crypto.randomBytes(size);
      } };
      return require(name);
    },
  }, { filename: providerPath });
  const { OwnedDialogs } = module.exports;
  const original = OwnedDialogs.prototype.show;
  const providerCalls = [];
  const realShow = function (...args) {
    const producer = Reflect.apply(original, this, args);
    providerCalls.push({ receiver: this, args, producer });
    if (settings.failObservationLookup) {
      const get = this.owners.get;
      this.owners.get = function () {
        this.get = get;
        throw settings.failObservationLookup;
      };
    }
    return producer;
  };
  let refusals = 0;
  const guard = function () { refusals += 1; throw new Error("unchanged guard refused"); };
  OwnedDialogs.prototype.show = guard;
  const broker = new OwnedDialogs();
  const state = {
    pendingId: 31, pendingReason: "window-close",
    rendererGeneration: 4, rendererPageSession: "simulated-main-page",
  };
  const tails = [];
  const api = new vm.Script(driverSource + "\n({ installMainOwnedShutdownQuestions, installOrdinaryShutdownQuestions });")
    .runInContext(vm.createContext({
      OwnedDialogs, realOwnedDialogShow: realShow,
      __shutdown: { state: () => ({ ...state }) }, ownedDialogUrl: broker.url,
      setTimeout: timeout, clearTimeout: clear, Date,
    }));
  const rig = { dialogs: [], answer: 1 };
  const actor = settings.ordinary ? api.installOrdinaryShutdownQuestions(owner, rig, tails)
    : api.installMainOwnedShutdownQuestions(owner, tails, {
      policy: settings.policy || "cancellable", onRecord: settings.onRecord,
    });
  const options = (overrides = {}) => ({
    title: "Unsaved changes", message: '"alpha.md" has unsaved changes.',
    detail: "Actual provider; simulated page", buttons: ["Discard changes", "Cancel"],
    defaultId: 1, cancelId: 1, allowUnavailableRenderer: true,
    isCurrent: () => true, ...overrides,
  });
  return {
    actor, broker, owner, state, tails, rig, children, sends, providerCalls, guard, OwnedDialogs,
    options, refusals: () => refusals, timers,
    failRandom(error) { randomError = error; faultRandom = true; },
    show: (value = options(), target = owner, ...extra) => broker.show(target, value, ...extra),
    unobserved: value => Reflect.apply(original, broker, [owner, value]),
    async close() {
      owner.destroy();
      await Promise.allSettled(tails);
      actor.restore();
      assert.equal(OwnedDialogs.prototype.show, guard);
      assert.equal(timers.size, 0, "all actual provider and driver timers were cleared");
      assert.equal(owner.listenerCount("closed"), 0);
      assert.equal(owner.webContents.listenerCount("did-navigate"), 0);
    },
  };
}
const messages = error => {
  const values = [String(error?.message || error)];
  for (const nested of error?.errors || []) values.push(messages(nested));
  return values.join("\n");
};
const cases = [];
const test = (name, body) => cases.push([name, body]);
const displayed = async record => {
  const value = await record.presentationReady;
  assert.equal(value.kind, "displayed");
  return record;
};

test("original receiver, arguments and producer Promise survive call-through", async () => {
  const f = fixture();
  try {
    const options = f.options();
    const extra = {};
    const producer = f.show(options, f.owner, extra);
    const record = f.actor.records[0];
    assert.equal(producer, f.providerCalls[0].producer);
    assert.equal(record.producer, producer);
    assert.equal(f.providerCalls[0].receiver, f.broker);
    assert.equal(f.providerCalls[0].args[0], f.owner);
    assert.equal(f.providerCalls[0].args[1], options);
    assert.equal(f.providerCalls[0].args[2], extra);
    await displayed(record);
    record.choose(1);
    await f.actor.join();
    assert.equal((await producer).cause, "choice");
    assert.equal(record.choiceDelivered, true);
    assert.equal(f.children[0].listenerCount("closed"), 1, "only provider-owned close listener remains");
  } finally { await f.close(); }
});
test("foreign, fallback and malformed calls retain the unchanged refusal guard", async () => {
  const f = fixture();
  try {
    assert.throws(() => f.show(f.options(), { webContents: {} }), /unchanged guard/);
    assert.throws(() => f.show(f.options({ title: "Unsaved changes cannot be checked" })), /unchanged guard/);
    assert.throws(() => f.show(f.options({ cancelId: 0 })), /unchanged guard/);
    assert.throws(() => f.show(f.options({ allowUnavailableRenderer: false })), /unchanged guard/);
    assert.equal(f.refusals(), 4);
    assert.equal(f.providerCalls.length, 0);
  } finally { await f.close(); }
});
test("actual active and queued requests keep independent one-use choices", async () => {
  const f = fixture();
  try {
    const first = f.show();
    const second = f.show(f.options({ message: '"beta.md" has unsaved changes.' }));
    const [a, b] = f.actor.records;
    assert.notEqual(a.brokerId, b.brokerId);
    await displayed(a);
    assert.throws(() => a.choose(-1), /explicit valid button/);
    assert.throws(() => b.choose(0), /not yet presented/);
    a.choose(1);
    assert.throws(() => a.choose(0), /repeated/);
    await a.joined;
    await displayed(b);
    assert.throws(() => a.choose(0), /stale/);
    b.choose(0);
    await f.actor.join();
    assert.equal((await first).response, 1);
    assert.equal((await second).response, 0);
    assert.deepEqual(f.sends, [1, 0]);
  } finally { await f.close(); }
});
for (const order of ["owner-first", "child-first"]) {
  test(`held choice owner loss uses actual ${order} cancellation`, async () => {
    const f = fixture();
    try {
      const producer = f.show();
      const record = await displayed(f.actor.records[0]);
      assert.throws(() => f.actor.restore(), /unfinished work/);
      f.owner.destroy(order);
      await f.actor.join();
      assert.equal((await producer).cause, order === "owner-first" ? "stale" : "cancel");
      assert.equal(record.completionKind, "cancellation");
      assert.throws(() => record.choose(0), /stale/);
      assert.equal(f.sends.length, 0);
    } finally { await f.close(); }
  });
}
test("queued owner cancellation completes before presentation without a fabricated answer", async () => {
  const f = fixture();
  try {
    f.show();
    const queued = f.show();
    const record = f.actor.records[1];
    assert.equal(record.request.window, undefined);
    f.owner.destroy();
    await f.actor.join();
    assert.equal((await record.presentationReady).kind, "completed");
    assert.equal((await queued).displayed, false);
    assert.equal(record.result.cause, "stale");
    assert.equal(f.sends.length, 0);
  } finally { await f.close(); }
});
for (const lifecycle of ["abort", "navigation", "authority"]) {
  test(`actual ${lifecycle} cancels displayed and queued original producers`, async () => {
    const f = fixture();
    const controller = new AbortController();
    let current = true;
    try {
      f.show(f.options({ signal: controller.signal, isCurrent: () => current }));
      f.show(f.options({ signal: controller.signal, isCurrent: () => current }));
      await displayed(f.actor.records[0]);
      if (lifecycle === "abort") controller.abort();
      if (lifecycle === "navigation") f.owner.webContents.emit("did-navigate");
      if (lifecycle === "authority") current = false;
      await f.actor.join();
      assert.deepEqual(Array.from(f.actor.records, record => record.result.cause),
        lifecycle === "abort" ? ["aborted", "stale"] : ["stale", "stale"]);
      assert.equal(f.actor.records[1].result.displayed, false);
      assert.equal(f.sends.length, 0);
    } finally { await f.close(); }
  });
}
test("registered queued abort stays aborted while its preceding question remains held", async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    f.show();
    const queued = f.show(f.options({ signal: controller.signal }));
    await displayed(f.actor.records[0]);
    controller.abort();
    await f.actor.records[1].joined;
    assert.equal((await queued).cause, "aborted");
    assert.equal(f.actor.records[1].result.displayed, false);
    assert.equal(f.actor.records[0].settled, false);
    f.actor.records[0].choose(1);
    await f.actor.join();
  } finally { await f.close(); }
});
test("renderer loss retains current independent Main questions but cancels document questions", async () => {
  const f = fixture();
  try {
    const document = f.unobserved(f.options({ allowUnavailableRenderer: false }));
    const main = f.show();
    f.owner.webContents.crashed = true;
    f.owner.webContents.mainFrame.destroyed = true;
    f.owner.webContents.emit("render-process-gone");
    assert.equal((await document).cause, "stale");
    f.state.rendererGeneration += 1;
    const record = await displayed(f.actor.records[0]);
    record.choose(1);
    await f.actor.join();
    assert.equal((await main).cause, "choice");
  } finally { await f.close(); }
});
test("a retired old capability cannot answer a replacement original request", async () => {
  const f = fixture();
  try {
    f.show();
    const old = await displayed(f.actor.records[0]);
    f.owner.webContents.emit("did-navigate");
    await old.joined;
    f.state.pendingId += 1;
    f.state.rendererPageSession = "replacement-simulated-page";
    f.show();
    const next = await displayed(f.actor.records[1]);
    assert.throws(() => old.choose(0), /stale/);
    assert.equal(next.choiceSubmitted, null);
    next.choose(1);
    await f.actor.join();
    assert.deepEqual(f.sends, [1]);
  } finally { await f.close(); }
});
for (const click of ["held", "reject-after-close", "refused"]) {
  test(`actual preload choice keeps ${click} transport distinct from producer completion`, async () => {
    const f = fixture({ click });
    try {
      f.show();
      const record = await displayed(f.actor.records[0]);
      record.choose(1);
      if (click === "refused") {
        await assert.rejects(f.actor.join(), error => messages(error).includes("evaluation refused"));
        assert.equal(record.result.cause, "cancel");
        assert.equal(record.choiceDelivered, false);
      } else {
        await f.actor.join();
        assert.equal(record.result.cause, "choice");
      }
    } finally { await f.close(); }
  });
}
test("cancellation ends an outstanding presentation evaluation and removes owned timers", async () => {
  const f = fixture({ holdPresentation: true });
  try {
    f.show();
    await new Promise(resolve => setImmediate(resolve));
    f.owner.destroy();
    await f.actor.join();
    assert.equal((await f.actor.records[0].presentationReady).kind, "completed");
  } finally { await f.close(); }
});
test("child done/closed does not finish an original producer awaiting fallback", async () => {
  const f = fixture();
  let finish;
  try {
    let resolved = false;
    const producer = f.show(f.options({ onFailure: () => new Promise(resolve => { finish = resolve; }) }));
    producer.then(() => { resolved = true; });
    await displayed(f.actor.records[0]);
    f.children[0].emit("unresponsive");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.actor.records[0].request.done, true);
    assert.equal(f.children[0].isDestroyed(), true);
    assert.equal(resolved, false);
    assert.throws(() => f.actor.restore(), /unfinished work/);
    finish({ response: 1, cause: "cancel", failed: true, displayed: true, emergency: true });
    await assert.rejects(f.actor.join(), error => messages(error).includes("emergency fallback"));
  } finally {
    if (finish) finish({ response: 1, cause: "cancel", failed: true, displayed: true });
    await f.close();
  }
});
for (const async of [false, true]) {
  test(`${async ? "rejecting" : "throwing"} onRecord is observed without changing the producer`, async () => {
    const error = new Error("original callback failure");
    const f = fixture({ onRecord: () => {
      if (async) return Promise.reject(error);
      throw error;
    } });
    try {
      const producer = f.show();
      assert.equal(producer, f.providerCalls[0].producer);
      const record = await displayed(f.actor.records[0]);
      await assert.rejects(f.actor.join(), failure => messages(failure).includes(error.message));
      assert.equal((await producer).cause, "cancel");
      assert.equal(record.choiceDelivered, false);
      assert.equal(f.providerCalls.length, 1);
      assert.equal(record.observerError, error);
    } finally { await f.close(); }
  });
}
test("fixed-point joining crosses the actual controlled dispatch chain and captures two follow-ons", async () => {
  const f = fixture({ onRecord: record => record.presentationReady.then(value => {
    if (value.kind === "displayed") record.choose(1);
  }) });
  try {
    const first = f.show();
    const dispatch = first.then(async () => {
      f.state.pendingId += 1;
      f.state.pendingReason = "update-install";
      await f.show();
      f.state.pendingId += 1;
      await f.show();
    });
    const result = await f.actor.join(() => dispatch);
    assert.equal(result.dispatchBoundaryJoined, true);
    assert.equal(f.actor.records.length, 3);
    assert.equal(new Set(f.actor.records.map(record => record.brokerId)).size, 3);
    assert.deepEqual(f.sends, [1, 1, 1]);
    assert.equal((await f.actor.join()).dispatchBoundaryJoined, false);
  } finally { await f.close(); }
});
test("producer, driver, callback and caller-boundary failures remain independently visible", async () => {
  const producer = new Error("actual provider random dependency failed");
  const callback = new Error("independent callback failed");
  const boundary = new Error("independent dispatch boundary failed");
  const f = fixture({ onRecord: () => { throw callback; } });
  try {
    f.failRandom(producer);
    const original = f.show();
    assert.equal(original, f.providerCalls[0].producer);
    await assert.rejects(f.actor.join(() => { throw boundary; }), error => {
      const value = messages(error);
      return value.includes(producer.message) && value.includes("exact original producer/broker") &&
        value.includes(callback.message) && value.includes(boundary.message);
    });
  } finally { await f.close(); }
});
test("ordinary legacy answer stays unjoined after real cancellation and cannot click late", async () => {
  const f = fixture({ ordinary: true });
  let release;
  try {
    f.rig.answer = () => new Promise(resolve => { release = resolve; });
    f.show();
    await displayed(f.actor.records[0]);
    await new Promise(resolve => setImmediate(resolve));
    f.owner.destroy();
    await f.actor.records[0].joined.catch(() => {});
    await assert.rejects(f.actor.join(), error => messages(error).includes("legacy answer work unjoined"));
    assert.throws(() => f.actor.restore(), /legacy answer work unjoined/);
    release(0);
    await Promise.allSettled(f.tails);
    assert.equal(f.sends.length, 0);
    assert.equal(f.actor.records[0].choiceDelivered, false);
  } finally {
    if (release) release(1);
    await f.close();
  }
});
test("authority lost after actual display waits for original stale cancellation, not forced child close", async () => {
  const f = fixture();
  let current = true;
  try {
    f.show(f.options({ isCurrent: () => current, onDisplayed: () => { current = false; } }));
    await f.actor.join();
    const record = f.actor.records[0];
    assert.equal(record.result.cause, "stale");
    assert.equal(record.result.displayed, true);
    assert.equal(record.displayed, false);
    assert.equal((await record.presentationReady).kind, "completed");
    assert.equal(record.driverError, null);
  } finally { await f.close(); }
});
test("unfinished async callback work remains distinct after its actual question completed", async () => {
  let release;
  const work = new Promise(resolve => { release = resolve; });
  const f = fixture({ onRecord: () => work });
  try {
    f.show();
    const record = await displayed(f.actor.records[0]);
    record.choose(1);
    await record.joined;
    assert.equal(record.settled, true);
    assert.equal(record.observerSettled, false);
    assert.throws(() => f.actor.restore(), /unfinished work/);
    release();
    await f.actor.join();
    assert.equal(record.observerSettled, true);
  } finally { release(); await f.close(); }
});
test("foreign restoration ownership is refused without overwriting the foreign method", async () => {
  const f = fixture();
  const installed = f.OwnedDialogs.prototype.show;
  const foreign = () => {};
  try {
    f.OwnedDialogs.prototype.show = foreign;
    assert.throws(() => f.actor.restore(), /ownership changed/);
    assert.equal(f.OwnedDialogs.prototype.show, foreign);
  } finally {
    f.OwnedDialogs.prototype.show = installed;
    await f.close();
  }
});
test("post-call observation setup failure preserves the same producer and joins the failure separately", async () => {
  const failure = new Error("controlled post-call observation lookup failure");
  const f = fixture({ failObservationLookup: failure });
  try {
    const producer = f.show();
    assert.equal(producer, f.providerCalls[0].producer);
    assert.equal(f.providerCalls.length, 1);
    assert.throws(() => f.actor.restore(), /unfinished work/);
    f.owner.destroy();
    await producer;
    await assert.rejects(f.actor.join(), error => messages(error).includes(failure.message));
    assert.equal(f.refusals(), 0);
  } finally { await f.close(); }
});
test("reused exact options still identify each newly registered original request", async () => {
  const f = fixture();
  try {
    const options = f.options();
    f.show(options);
    f.show(options);
    const [first, second] = f.actor.records;
    assert(second.request, "the second real broker request is identified");
    assert.notEqual(first.request, second.request);
    assert.notEqual(first.brokerId, second.brokerId);
    (await displayed(first)).choose(1);
    (await displayed(second)).choose(1);
    await f.actor.join();
    assert(f.actor.records.every(record => record.choiceDelivered));
  } finally { await f.close(); }
});
test("fixed-point joining includes a follow-on observation setup failure", async () => {
  const failure = new Error("controlled follow-on observation failure");
  const f = fixture({ failObservationLookup: failure });
  try {
    const dispatch = Promise.resolve().then(() => {
      const producer = f.show();
      f.owner.destroy();
      return producer;
    });
    await assert.rejects(f.actor.join(() => dispatch), error => messages(error).includes(failure.message));
  } finally { await f.close(); }
});
test("ordinary joining drains automatic follow-on questions before judging legacy work", async () => {
  const f = fixture({ ordinary: true });
  try {
    const first = f.show();
    const dispatch = first.then(() => {
      f.state.pendingId += 1;
      f.state.pendingReason = "update-install";
      return f.show();
    });
    await f.actor.join(() => dispatch);
    assert.equal(f.actor.records.length, 2);
    assert(f.actor.records.every(record => record.choiceDelivered && record.observerSettled));
  } finally { await f.close(); }
});
test("ordinary unfinished legacy work does not hide an independent caller-boundary failure", async () => {
  let release;
  const f = fixture({ ordinary: true });
  f.rig.answer = () => new Promise(resolve => { release = resolve; });
  try {
    f.show();
    await displayed(f.actor.records[0]);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    f.owner.destroy();
    const failure = new Error("controlled ordinary caller-boundary failure");
    await assert.rejects(f.actor.join(() => Promise.reject(failure)), error =>
      messages(error).includes(failure.message) && messages(error).includes("legacy answer work unjoined"));
  } finally {
    if (release) release(1);
    await f.close();
  }
});
test("caller-boundary observation starts before waiting for a held original question", async () => {
  const f = fixture();
  const failure = new Error("controlled already-started caller failure");
  const completion = Promise.reject(failure);
  completion.catch(() => {});
  let observed = 0;
  let joining;
  try {
    f.show();
    await displayed(f.actor.records[0]);
    joining = f.actor.join(() => { observed += 1; return completion; });
    joining.catch(() => {});
    assert.equal(observed, 1);
    f.actor.records[0].choose(1);
    await assert.rejects(joining, error => messages(error).includes(failure.message));
    assert.equal(observed, 1);
  } finally {
    f.owner.destroy();
    if (joining) await Promise.allSettled([joining]);
    await f.close();
  }
});
test("synchronous callback returns and state predicates cannot become completion boundaries", async () => {
  const f = fixture();
  try {
    for (const value of [undefined, true, false, 0]) {
      await assert.rejects(f.actor.join(() => value), error =>
        messages(error).includes("original completion Promise, not a state predicate"));
    }
    assert.equal((await f.actor.join()).dispatchBoundaryJoined, false);
  } finally { await f.close(); }
});
test("rejected callback after display retires the driver through original cancellation", async () => {
  let reject;
  const failure = new Error("controlled callback rejection after display");
  const f = fixture({ onRecord: () => new Promise((resolve, fail) => { reject = fail; }) });
  try {
    f.show();
    const record = await displayed(f.actor.records[0]);
    reject(failure);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(record.driverError || "", /controlled callback rejection after display/);
    await assert.rejects(f.actor.join(), error => messages(error).includes(failure.message));
    assert.equal(record.result.cause, "cancel");
    assert.equal(record.result.response, 1);
    assert.equal(record.result.failed, false);
    assert.equal(record.choiceDelivered, false);
    assert.equal(f.providerCalls.length, 1);
  } finally { await f.close(); }
});
for (const cause of ["pagehide", "blocked"]) {
  test(`actual preload ${cause} cancellation stays an unchanged non-choice result`, async () => {
    const f = fixture();
    try {
      const producer = f.show();
      const record = await displayed(f.actor.records[0]);
      f.children[0].bridge.respond(1, cause);
      const result = await producer;
      assert.equal(result.cause, cause);
      assert.equal(result.response, 1);
      assert.equal(result.failed, false);
      await f.actor.join();
      assert.equal(record.result, result);
      assert.equal(record.completionKind, "cancellation");
      assert.equal(record.choiceDelivered, false);
      assert.throws(() => record.choose(0), /stale/);
    } finally { await f.close(); }
  });
}
test("falsy callback rejections remain failures and retire their displayed original questions", async () => {
  const contains = (error, value) => error === value ||
    (Array.isArray(error?.errors) && error.errors.some(nested => contains(nested, value)));
  for (const value of [undefined, null, false, 0, ""]) {
    let reject;
    const f = fixture({ onRecord: () => new Promise((resolve, fail) => { reject = fail; }) });
    try {
      f.show();
      const record = await displayed(f.actor.records[0]);
      reject(value);
      await new Promise(resolve => setImmediate(resolve));
      assert.notEqual(record.driverError, null, "falsy rejection retires the displayed driver");
      await assert.rejects(f.actor.join(), error => contains(error, value));
      assert.equal(record.observerError, value);
      assert.equal(record.result.cause, "cancel");
      assert.equal(record.choiceDelivered, false);
    } finally { await f.close(); }
  }
});
test("falsy observation rejection is not mistaken for a successful click transport", async () => {
  const containsNull = error => error === null ||
    (Array.isArray(error?.errors) && error.errors.some(containsNull));
  const f = fixture({ click: "refused-falsy" });
  try {
    f.show();
    const record = await displayed(f.actor.records[0]);
    record.choose(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.notEqual(record.driverError, null, "falsy transport rejection retires the displayed driver");
    await assert.rejects(f.actor.join(), containsNull);
    assert.equal(record.result.cause, "cancel");
    assert.equal(record.choiceDelivered, false);
    assert.equal(f.sends.length, 0);
  } finally { await f.close(); }
});
const deadline = setTimeout(() => { throw new Error("Shared question controls did not finish"); }, 110000);
(async () => {
  let failed = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}\n${error.stack}`); }
  }
  console.log(`shared actual-provider/simulated-ports: ${cases.length - failed}/${cases.length}; native NOT RUN`);
  clearTimeout(deadline);
  process.exitCode = failed ? 1 : 0;
})();
