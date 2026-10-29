"use strict";
// Actual caller/helper/closed-listener/getter source; remaining ports are simulated.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const suitePath = process.argv[2];
const manifestPath = process.argv[3];
assert(suitePath && manifestPath, "exact source/manifest arguments are required");
const mainPath = process.argv[4] || path.join(path.dirname(suitePath), "..", "src", "main.js");
const folder = path.dirname(manifestPath);
const read = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const hash = source => crypto.createHash("sha256").update(source).digest("hex");
const suite = read(suitePath);
const main = read(mainPath);
const extract = name => {
  const start = suite.indexOf(`function ${name}(`);
  const end = suite.indexOf("\n}\n", start);
  assert(start >= 0 && end > start, `complete ${name}`);
  return (suite.slice(start - 6, start) === "async " ? "async " : "") + suite.slice(start, end + 3);
};
const helper = extract("installTeardownOwnerLossQuestions");
const caller = extract("runTeardownScenario");
const boundedWork = extract("boundedDialogWork");
const selectedDriver = extract("installMainOwnedShutdownQuestions");
const chooseStart = selectedDriver.indexOf("const choose = index => {");
const chooseEnd = selectedDriver.indexOf("\n      };", chooseStart);
assert(chooseStart > 0 && chooseEnd > chooseStart);
const chooseSource = selectedDriver.slice(chooseStart + "const choose = ".length,
  chooseEnd + "\n      }".length);
const registrationStart = main.indexOf('  win.on("closed", () => {', main.indexOf("function attachShutdownGuards(win) {"));
const registrationEnd = main.indexOf("\n  });\n}", registrationStart) + "\n  });".length;
assert(registrationStart > 0 && registrationEnd > registrationStart);
const registration = main.slice(registrationStart, registrationEnd);
const getterStart = main.indexOf("readQuestionConsumer: (requestId, signal) => {");
const getterEnd = main.indexOf("\n          },", getterStart);
assert(getterStart > 0 && getterEnd > getterStart);
const getter = main.slice(getterStart + "readQuestionConsumer: ".length, getterEnd + "\n          }".length);
const bindings = { suite: hash(suite), main: hash(main), helper: hash(helper), caller: hash(caller),
  closedRegistration: hash(registration), consumerGetter: hash(getter), chooseCapability: hash(chooseSource),
  boundedWork: hash(boundedWork) };
const expected = JSON.parse(read(manifestPath));
for (const [name, value] of Object.entries(bindings)) assert.equal(value, expected[name], `pinned ${name}`);
console.log("SOURCE BINDINGS " + JSON.stringify(bindings));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
const contains = (error, value) => error === value ||
  (Array.isArray(error?.errors) && error.errors.some(nested => contains(nested, value)));
const hasMessage = (error, message) => String(error?.message || "").includes(message) ||
  (Array.isArray(error?.errors) && error.errors.some(nested => hasMessage(nested, message)));

const fixtureDirectories = [];
function fixture(settings = {}) {
  const trace = [];
  const checks = [];
  const dir = fs.mkdtempSync(path.join(folder, "vm-fixture-"));
  fixtureDirectories.push(dir);
  const owner = Object.assign(new EventEmitter(), { destroyed: false });
  owner.isDestroyed = () => owner.destroyed;
  owner.webContents = {
    isDestroyed: () => owner.destroyed,
    mainFrame: { parent: null, frameTreeNodeId: 7, isDestroyed: () => owner.destroyed },
    executeJavaScript: async code => exec(code),
  };
  owner.destroy = () => {
    trace.push("destroy");
    if (owner.destroyed) return;
    owner.destroyed = true;
    if (!settings.dropClosedEvent) owner.emit("closed");
  };
  const consumerGate = deferred();
  const driverGate = deferred();
  const producer = deferred();
  const state = { renderer: "ready", rendererPageSession: "simulated-page", lastRequestId: 0,
    settleWhy: null, authorized: false, updateInstallStarted: false, commitPendingId: 0 };
  const page = { live: "", cached: "", baseline: "", dirty: false };
  const rig = { dialogs: [], closes: 0, reset: () => trace.push("rig-reset"),
    restore: () => trace.push("rig-restore") };
  const updater = { quitAndInstall() { throw new Error("external install must remain stubbed"); } };
  let actor;
  let question;
  let consumer;
  let installed = 0;
  let context;
  const stateSnapshot = () => ({ ...state,
    pendingId: context.pendingShutdown?.id || 0,
    pendingReason: context.pendingShutdown?.reason || null,
    queuedReason: context.queuedShutdown?.reason || null });
  const dispatch = reason => {
    page.cached = page.live;
    page.dirty = true;
    if (context.pendingShutdown) {
      assert.equal(reason, "update-install");
      context.queuedShutdown = { reason };
      return;
    }
    const controller = new AbortController();
    const record = { id: ++state.lastRequestId, reason, dialogController: controller };
    context.pendingShutdown = record;
    question = {
      requestId: record.id, pendingReason: reason, owner, sender: owner.webContents,
      generation: 4, pageSession: state.rendererPageSession, brokerId: "simulated-broker",
      options: { title: "Unsaved changes", message: `"teardown-${settings.kase || "pending"}.md" has unsaved changes.`,
        buttons: ["Discard changes", "Cancel"], defaultId: 1, cancelId: 1, signal: controller.signal },
      producer: producer.promise, settled: false, driverSettled: false, choiceSubmitted: null,
      choiceDelivered: false, completionKind: null, retired: false,
      displayed: !settings.completedPresentation,
      presentationReady: Promise.resolve({ kind: settings.completedPresentation ? "completed" : "displayed" }),
    };
    const answerHost = { isDestroyed: () => owner.isDestroyed() || question.retired };
    const choose = vm.runInNewContext(`(${chooseSource})`, {
      Number, Error, record: question, options: question.options,
      request: { window: answerHost, displayed: question.displayed }, answerHost,
      current: () => context.pendingShutdown === record && !question.retired &&
        !owner.isDestroyed() && !controller.signal.aborted,
      decide: () => trace.push("choice-submitted"),
    });
    question.choose = settings.allowLateChoice ? index => {
      if (question.retired) { question.choiceSubmitted = index; return; }
      return choose(index);
    } : choose;
    question.joined = producer.promise.then(async result => {
      trace.push("driver-settled");
      question.result = result;
      question.settled = true;
      question.retired = true;
      if (settings.holdDriver) await driverGate.promise;
      question.driverSettled = true;
      question.completionKind = settings.choiceCompletion ? "choice" : "cancellation";
    });
    controller.signal.addEventListener("abort", () => {
      trace.push("provider-cancel");
      producer.resolve({ cause: "stale", response: 1, failed: false, displayed: true });
    }, { once: true });
    consumer = producer.promise.then(async () => {
      trace.push("consumer-start");
      if (settings.holdConsumer) await consumerGate.promise;
      if (Object.hasOwn(settings, "consumerError")) throw settings.consumerError;
      trace.push("consumer-finished");
    });
    context.shutdownQuestionConsumers.set(controller.signal, { requestId: record.id, record, consumer });
    actor.records.push(question);
  };
  const exec = async code => {
    if (code === "window.folia.getUpdateState()") return { manualOnly: false };
    if (code.includes("window.folia.installUpdate()")) { dispatch("update-install"); return null; }
    if (code.includes("const tab = window.CustomTabs.getActiveTab()")) {
      return { live: page.live, cached: page.cached, baseline: page.baseline, dirty: page.dirty };
    }
    if (code.includes("Teardown initial document restore did not settle")) return true;
    throw new Error("Unexpected simulated renderer request: " + code);
  };
  context = vm.createContext({
    fs, path, __dirname: path.join(path.dirname(mainPath), "..", "test"),
    dir, setImmediate,
    setTimeout: settings.fastDeadlines ? (callback, ms) => setTimeout(callback, Math.min(ms, 5)) : setTimeout,
    clearTimeout,
    Promise, AggregateError, Map, Number, Function,
    require: name => { assert.equal(name, "electron-updater"); return { autoUpdater: updater }; },
    pendingShutdown: null, queuedShutdown: null, pendingShutdownCommit: null,
    activeDialogExtraBatch: null, approvalRendererState: "ready", lastRendererUnusableReason: null,
    shutdownQuestionConsumers: new WeakMap(),
    invalidateDeferredUpdaterContinuations: () => trace.push("original-prefix"),
    finishShutdownCommit: () => {}, declineIntent: () => trace.push("queued-declined"),
    cancelAbsorbedUserShutdown: () => {},
    isUpdaterShutdownReason: reason => reason === "update-install",
    settleShutdown(record, approved, why) {
      assert.equal(approved, false);
      state.settleWhy = why;
      context.pendingShutdown = null;
      record.dialogController.abort();
    },
    win: owner,
    waitUntil: async predicate => {
      for (let count = 0; count < 10; count += 1) {
        if (await predicate()) return true;
        await turn();
      }
      return false;
    },
    write: (file, text) => fs.writeFileSync(file, text),
    check: (name, passed) => { checks.push([name, Boolean(passed)]); },
    unavailable: () => { throw new Error("Unexpected manual-only path"); },
    createBaseUpdaterBranchBorrow: () => ({
      recordQuitAndInstall: () => { installed += 1; },
      restore: () => trace.push("base-restore"),
    }),
    shutdownRig: () => rig,
    clearShutdownLifecycleDocuments: async () => {},
    openShutdownLifecycleFixture: async (run, file, text) => {
      page.live = page.cached = page.baseline = text;
      return { filePath: file, tabId: "simulated-tab", owner: { tabId: "simulated-tab",
        pageSession: state.rendererPageSession }, descriptor: { logicalPath: file } };
    },
    prepareTeardownEditor: async (run, file, baseline, addition) => {
      page.live = baseline + addition;
      page.dirty = true;
      return { live: page.live, cached: page.cached, baseline, dirty: true };
    },
    createInstalledUpdaterFixture: () => ({
      prepare: async () => ({ candidate: "simulated-version",
        state: { canInstall: true, readyVersion: "simulated-version" } }),
      restore: () => {
        trace.push("updater-restore");
        if (settings.restoreError) throw settings.restoreError;
      },
    }),
    replaceMethod(object, name, replacement) {
      const original = object[name];
      object[name] = replacement;
      return () => { trace.push("method-restore"); object[name] = original; };
    },
    guardEvent: () => ({ preventDefault() {} }),
    installMainOwnedShutdownQuestions(target, tails, options) {
      assert.equal(target, owner);
      assert.equal(options.policy, "cancellable");
      assert.equal(actor, undefined, "one selected-driver port");
      actor = {
        records: [],
        async join(...args) {
          assert.equal(args.length, 0, "partial consumer must never be passed as afterDispatch");
          trace.push("ledger-join");
          await Promise.all(this.records.map(record => record.joined));
          if (Object.hasOwn(settings, "driverError")) throw settings.driverError;
          return { dispatchBoundaryJoined: false };
        },
        restore() {
          assert(this.records.every(record => record.driverSettled));
          trace.push("actor-restore");
        },
      };
      return actor;
    },
  });
  const readQuestionConsumer = vm.runInContext(`(${getter})`, context);
  context.__shutdown = {
    state: stateSnapshot,
    reset() { trace.push("reset"); },
    readQuestionConsumer(id, signal) {
      trace.push("consumer-lookup");
      if (settings.missingConsumer) return null;
      if (settings.foreignConsumerIdentity) return readQuestionConsumer(id + 1, signal);
      return readQuestionConsumer(id, signal);
    },
  };
  vm.runInContext(registration, context, { filename: "actual-a1c-closed-registration.js" });
  const originalClosed = owner.rawListeners("closed")[0];
  if (settings.missingClosed) owner.removeListener("closed", originalClosed);
  owner.on("close", event => { event.preventDefault(); dispatch("window-close"); });
  const api = vm.runInContext(boundedWork + "\n" + helper + "\n" + caller +
    "\n({ installTeardownOwnerLossQuestions, runTeardownScenario });", context);
  return { owner, trace, checks, page, actor: () => actor, question: () => question,
    consumer: () => consumer, dispatch, context, originalClosed, state: stateSnapshot, dir,
    installed: () => installed, releaseConsumer: consumerGate.resolve, releaseDriver: driverGate.resolve,
    install: () => api.installTeardownOwnerLossQuestions(owner, [], main),
    run: kase => api.runTeardownScenario(owner, kase) };
}
const cases = [];
const test = (name, run) => cases.push([name, run]);
for (const kase of ["queued", "pending"]) {
  test(`actual ${kase} caller joins cancellation and original partial consumption before reset`, async () => {
    const f = fixture({ kase, holdConsumer: true });
    let done = false;
    const running = f.run(kase).finally(() => { done = true; });
    const runningOutcome = Promise.allSettled([running]);
    try {
      for (let i = 0; i < 10 && !f.trace.includes("consumer-start"); i += 1) await turn();
      assert(f.trace.includes("original-prefix"));
      assert(f.trace.includes("provider-cancel"));
      assert.equal(done, false, "consumer is still held after producer/driver completion");
      assert.equal(f.trace.filter(value => value === "reset").length, 1, "only initial reset happened");
      f.releaseConsumer();
      await running;
      assert.equal(f.checks.length, kase === "queued" ? 5 : 4);
      assert.deepEqual(f.checks.filter(([, passed]) => !passed), []);
      assert.equal(f.actor().records.length, 1);
      assert.equal(f.installed(), 0);
      assert(f.trace.indexOf("consumer-finished") < f.trace.lastIndexOf("reset"));
      assert(f.trace.indexOf("actor-restore") < f.trace.lastIndexOf("reset"));
      assert.equal(f.owner.rawListeners("closed").includes(f.originalClosed), true);
      assert.equal(f.owner.rawListeners("closed").length, 1, "only caller observer removed");
    } finally {
      f.releaseConsumer();
      await Promise.allSettled([runningOutcome, f.consumer()]);
    }
  });
}
test("completed presentation cannot satisfy the actual pending caller setup", async () => {
  const f = fixture({ kase: "pending", completedPresentation: true });
  await assert.rejects(f.run("pending"), error => /displayed witness/.test(String(error.errors?.[0])));
  assert(f.trace.includes("provider-cancel"), "failed setup still destroys original owner");
  assert(f.trace.includes("consumer-finished"));
});
test("null original consumer refuses reset instead of treating not-yet-registered as complete", async () => {
  const f = fixture({ kase: "pending", missingConsumer: true });
  await assert.rejects(f.run("pending"));
  assert.equal(f.trace.filter(value => value === "reset").length, 1);
  assert(f.trace.includes("actor-restore"));
});
test("foreign request identity cannot return an original consumer", async () => {
  const f = fixture({ kase: "pending", foreignConsumerIdentity: true });
  await assert.rejects(f.run("pending"));
  assert.equal(f.trace.filter(value => value === "reset").length, 1);
});
test("missing exact original closed callback is rejected before driver installation", () => {
  const f = fixture({ missingClosed: true });
  assert.throws(f.install, /exact original closed listener/);
  assert.equal(f.actor(), undefined);
});
test("actual caller installation failure still disposes its owner and refuses reset", async () => {
  const f = fixture({ kase: "pending", missingClosed: true });
  await assert.rejects(f.run("pending"));
  assert.equal(f.owner.isDestroyed(), true);
  assert.equal(f.trace.filter(value => value === "reset").length, 1);
  assert(f.trace.includes("updater-restore") && f.trace.includes("rig-restore"));
});
test("changed original listener ordering cannot qualify the closed prefix", async () => {
  const f = fixture();
  const work = f.install();
  f.dispatch("update-install");
  await work.observe("update-install");
  f.owner.removeListener("closed", f.originalClosed);
  f.owner.on("closed", f.originalClosed);
  await assert.rejects(work.destroyAndJoin());
  await assert.rejects(work.cleanup());
  assert.equal(f.owner.isDestroyed(), true);
});
test("missing closed event is not replaced by isDestroyed or an empty pending state", async () => {
  const f = fixture({ dropClosedEvent: true });
  const work = f.install();
  f.dispatch("update-install");
  await work.observe("update-install");
  const running = work.destroyAndJoin();
  await turn();
  f.context.settleShutdown(f.context.pendingShutdown, false, "simulated-cleanup-only");
  await assert.rejects(running);
  await assert.rejects(work.cleanup());
});
test("retired late approval must be refused, not artificially delivered", async () => {
  const f = fixture({ allowLateChoice: true });
  const work = f.install();
  f.dispatch("update-install");
  await work.observe("update-install");
  await assert.rejects(work.destroyAndJoin(), /retired question accepted/);
  await work.cleanup();
});
test("genuine choice is not normalized into owner-loss cancellation", async () => {
  const f = fixture({ choiceCompletion: true });
  const work = f.install();
  f.dispatch("update-install");
  await work.observe("update-install");
  await assert.rejects(work.destroyAndJoin(), /genuine cancellation/);
  await work.cleanup();
});
test("a question cancelled before the owner-loss action cannot qualify that action", async () => {
  const f = fixture();
  const work = f.install();
  f.dispatch("update-install");
  await work.observe("update-install");
  f.context.pendingShutdown.dialogController.abort();
  await Promise.all([f.question().joined, f.consumer()]);
  assert.equal(f.owner.isDestroyed(), false);
  try {
    await assert.rejects(work.destroyAndJoin(), /settled before owner-loss/);
  } finally { await work.cleanup(); }
});
test("an already-aborted signal cannot qualify owner loss before settlement observers run", async () => {
  const f = fixture();
  const work = f.install();
  f.dispatch("update-install");
  await work.observe("update-install");
  f.context.pendingShutdown.dialogController.abort();
  try {
    await assert.rejects(work.destroyAndJoin(), /before owner-loss/);
  } finally { await work.cleanup(); }
});
test("same-turn Discard index zero is submitted choice, not an unanswered question", async () => {
  const f = fixture();
  const work = f.install();
  f.dispatch("update-install");
  await work.observe("update-install");
  f.question().choose(0);
  assert.equal(f.question().choiceSubmitted, 0, "actual selected capability latches numeric zero");
  try {
    await assert.rejects(work.destroyAndJoin(), /before owner-loss/);
  } finally { await work.cleanup(); }
});
test("driver and falsy original-consumer failures remain independently visible", async () => {
  const driverError = new Error("controlled driver failure");
  const f = fixture({ kase: "pending", driverError, consumerError: null });
  await assert.rejects(f.run("pending"), error => contains(error, driverError) && contains(error, null));
  assert.equal(f.trace.filter(value => value === "reset").length, 1);
  assert(f.trace.includes("updater-restore") && f.trace.includes("rig-restore"));
});
test("a later restoration failure does not skip independent restorations", async () => {
  const failure = new Error("controlled updater restore failure");
  const f = fixture({ kase: "pending", restoreError: failure });
  await assert.rejects(f.run("pending"), error => contains(error, failure));
  assert(f.trace.includes("base-restore") && f.trace.includes("method-restore") &&
    f.trace.includes("rig-restore"));
});
for (const kind of ["consumer", "ledger"]) {
  test(`unfinished original ${kind} times out, refuses reset and attempts independent restorations`, async () => {
    const f = fixture({ kase: "pending", fastDeadlines: true,
      holdConsumer: kind === "consumer", holdDriver: kind === "ledger" });
    const running = f.run("pending");
    const outcome = Promise.allSettled([running]);
    let deadline;
    try {
      const observed = await Promise.race([
        outcome,
        new Promise(resolve => { deadline = setTimeout(() => resolve(null), 100); }),
      ]);
      assert(observed, "incomplete accounting must fail before the external control deadline");
      assert.equal(observed[0].status, "rejected");
      assert(hasMessage(observed[0].reason, "Timed out: teardown Main question " + kind));
      assert.equal(f.trace.filter(value => value === "reset").length, 1);
      assert(f.trace.includes("updater-restore") && f.trace.includes("base-restore") &&
        f.trace.includes("method-restore") && f.trace.includes("rig-restore"));
      if (kind === "ledger") {
        assert.equal(f.question().driverSettled, false, "deadline did not complete original driver work");
        assert(!f.trace.includes("actor-restore"), "unfinished driver restoration remains refused");
      } else {
        assert(!f.trace.includes("consumer-finished"), "deadline did not complete original consumption");
      }
    } finally {
      clearTimeout(deadline);
      f.releaseConsumer();
      f.releaseDriver();
      await Promise.allSettled([outcome, f.consumer(), f.question()?.joined]);
    }
  });
}
const deadline = setTimeout(() => { throw new Error("Teardown source controls did not finish"); }, 110000);
(async () => {
  let failures = 0;
  try {
    for (const [name, run] of cases) {
      try { await run(); console.log("PASS " + name); }
      catch (error) { failures += 1; console.error("FAIL " + name + "\n" + error.stack); }
    }
  } finally {
    clearTimeout(deadline);
    for (const dir of fixtureDirectories) fs.rmSync(dir, { recursive: true });
  }
  console.log(`teardown caller/helper source with simulated ports: ${cases.length - failures}/${cases.length}; Main module/native NOT RUN`);
  process.exitCode = failures ? 1 : 0;
})();
