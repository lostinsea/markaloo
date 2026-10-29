"use strict";

// Actual Main function bodies, with controlled provider/native/lifecycle ports.
// No Main module, Electron app, native question or request lifecycle runs.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8")
  .replace(/\r\n/g, "\n");
const between = (start, end) => {
  const first = source.indexOf(start);
  assert.notEqual(first, -1, "Missing source: " + start);
  assert.equal(source.indexOf(start, first + start.length), -1, "Ambiguous source: " + start);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(last, -1, "Missing source end: " + end);
  return source.slice(first, last);
};
const ask = between("function askShutdownQuestion(record, options) {",
  "function askDiscardApproval(record, files) {");
const show = between("async function showOwnedMessage(owner, options, emergency = null) {",
  "// ============================================");
const registry = "const shutdownQuestionConsumers = app.isPackaged ? null : new WeakMap();";
assert.equal(source.split(registry).length, 2);
const getterStart = source.indexOf("          readQuestionConsumer: (requestId, signal) => {");
assert.notEqual(getterStart, -1);
const getterEnd = source.indexOf("          documentAdmissionIsCurrent:", getterStart);
assert.notEqual(getterEnd, -1);
const getter = source.slice(getterStart, getterEnd);
const gateStart = source.lastIndexOf("...(app.isPackaged", getterStart);
assert.ok(gateStart > 0);
const privateExport = "({\n" + source.slice(gateStart, getterStart) + getter + "\n      }\n    })\n})";
new vm.Script(privateExport);
const registration = [
  "  if (shutdownQuestionConsumers) {",
  "    shutdownQuestionConsumers.set(abortController.signal, {",
  "      requestId: questionRequestId, record, consumer: questionConsumer,",
  "    });",
  "  }\n",
].join("\n");
const replaceOnce = (text, before, after) => {
  assert.equal(text.split(before).length, 2, "One exact source edit: " + before);
  return text.replace(before, after);
};
let baseline = replaceOnce(ask, "  const questionRequestId = record.id;\n", "");
baseline = replaceOnce(baseline, "  const questionConsumer = showOwnedMessage(win, {",
  "  showOwnedMessage(win, {");
baseline = replaceOnce(baseline, registration, "");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const options = () => ({ confirmLabel: "Discard changes", title: "Unsaved changes",
  message: "Controlled document has unsaved changes.", detail: "Controlled detail", why: "dirty" });
function fixture({ packaged = false, original = false, actualShow = false } = {}) {
  const trace = [], calls = [], providers = [], native = [], timers = [];
  const config = { noWindow: false, showThrow: null, providerThrow: null,
    firstSettleThrow: null, finalSettleThrow: null, reask: false };
  const win = { isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (...args) => trace.push(["send", ...args]) } };
  let context;
  const provider = {
    show(owner, forwarded) {
      assert.equal(this, provider);
      const work = deferred();
      const entry = { owner, options: forwarded, ...work,
        early: context.api?.readQuestionConsumer(context.pendingShutdown?.id, forwarded.signal) };
      providers.push(entry);
      trace.push(["provider", forwarded.title, forwarded.signal.aborted]);
      if (config.providerThrow) throw config.providerThrow;
      return work.promise;
    },
  };
  context = vm.createContext({
    app: { isPackaged: packaged }, AbortController,
    pendingShutdown: null, staleShutdownDialogCompletionCount: 0,
    deletionEvidenceCapacityLatched: false, deletionEvidenceRevision: 7,
    approvalRendererGeneration: 3, approvalRendererPageSession: "consumer-page",
    approvalRendererState: "ready",
    shutdownOwnerWindow: () => config.noWindow ? null : win,
    settleWithoutWindow: record => trace.push(["without-window", record.id]),
    settleShutdown: (record, approved, why) => {
      trace.push(["settle", record.id, approved, why]);
      if (config.firstSettleThrow) {
        const error = config.firstSettleThrow; config.firstSettleThrow = null; throw error;
      }
      if (config.finalSettleThrow && why === "dialog-failed") throw config.finalSettleThrow;
      if (context.pendingShutdown === record) context.pendingShutdown = null;
    },
    deletionEvidenceTombstoneFileLabels: () => ["controlled-deleted.md"],
    askDeletionEvidenceCapacityApproval: record => {
      trace.push(["reroute", record.id]);
      if (config.reask) context.askShutdownQuestion(record, options());
    },
    log: (...args) => trace.push(["log", ...args]),
    mainDialogs: () => provider,
    ownerRendererAvailable: () => true,
    console: { error: (...args) => trace.push(["console", ...args.map(
      value => value instanceof Error ? value.message : value)]) },
    setInterval: () => { const timer = { cleared: false }; timers.push(timer); return timer; },
    clearInterval: timer => { timer.cleared = true; },
    dialog: { showMessageBox: (owner, forwarded) => {
      const work = deferred(); native.push({ owner, options: forwarded, ...work });
      trace.push(["native-port", forwarded.title]); return work.promise;
    } },
  });
  vm.runInContext(registry + "\n" + (original ? baseline : ask), context);
  context.api = vm.runInContext(privateExport, context).__shutdown;
  if (actualShow) vm.runInContext(show, context);
  const actual = actualShow ? context.showOwnedMessage :
    function controlledShow(owner, outer) {
      return provider.show(owner, { ...outer, allowUnavailableRenderer: true });
    };
  context.showOwnedMessage = function observedShow(...args) {
    if (config.showThrow) throw config.showThrow;
    const produced = Reflect.apply(actual, this, args);
    const call = { owner: args[0], options: args[1], emergency: args[2], produced,
      thenCalls: 0, catchCalls: 0, intermediate: null, consumer: null };
    calls.push(call);
    trace.push(["show-return", call.options.title, call.emergency]);
    const then = produced.then;
    produced.then = function observedThen(...handlers) {
      const next = Reflect.apply(then, this, handlers);
      if (!call.intermediate) {
        call.thenCalls++; call.intermediate = next;
        const catchMethod = next.catch;
        next.catch = function observedCatch(...errors) {
          call.catchCalls++;
          const consumer = Reflect.apply(catchMethod, this, errors);
          call.consumer = consumer; return consumer;
        };
      }
      return next;
    };
    return produced;
  };
  const askRecord = (record = { id: 1 }, questionOptions = options()) => {
    context.pendingShutdown = record;
    const result = context.askShutdownQuestion(record, questionOptions);
    return { record, result, call: calls.at(-1), provider: providers.at(-1),
      signal: record.dialogAbortController?.signal };
  };
  const read = (id, signal) => context.api?.readQuestionConsumer(id, signal);
  return { context, config, trace, calls, providers, native, timers, win, ask: askRecord, read };
}
const cases = [];
const test = (name, run) => cases.push([name, run]);
test("reversing only retention edits restores the exact original consumer body", () => {
  assert.equal(hash(baseline), "fa1c8d43847bdabb6da579cbedd42022c5558794918801046b42e7ac807db3d2");
  assert.equal(hash(show), "2e6e19a62c55c927670ec55878c8235a6fbebc956553c4f6ca4c7b312c768162");
  assert.ok(ask.includes("isCurrent: () => pendingShutdown === record,"));
});
test("the private lookup returns the same final original chain, not either producer", async () => {
  const h = fixture(), q = h.ask(), handle = h.read(q.record.id, q.signal);
  assert.equal(q.result, undefined);
  assert.equal(handle, q.call.consumer);
  assert.notEqual(handle, q.call.produced);
  assert.notEqual(handle, q.call.intermediate);
  assert.equal(h.read(q.record.id, q.signal), handle);
  q.provider.resolve({ cause: "choice", response: 1 }); await handle;
});
test("synchronous provider observation is unavailable, never already completed", async () => {
  const h = fixture(), q = h.ask();
  assert.equal(q.provider.early, null);
  assert.equal(h.read(q.record.id, q.provider.options.signal), q.call.consumer);
  q.provider.resolve({ cause: "cancel", response: 1 }); await q.call.consumer;
});
test("malformed request IDs and nonobject signals refuse without an action", async () => {
  const h = fixture(), q = h.ask();
  for (const id of [undefined, null, 0, -1, 1.5, NaN, Infinity, "1"]) {
    assert.equal(h.read(id, q.signal), null);
  }
  for (const signal of [undefined, null, false, 1, "signal"]) assert.equal(h.read(1, signal), null);
  assert.equal(h.calls.length, 1);
  q.provider.resolve({ cause: "cancel", response: 1 }); await q.call.consumer;
});
test("a different positive request cannot borrow this question handle", async () => {
  const h = fixture(), q = h.ask();
  assert.equal(h.read(2, q.signal), null);
  q.provider.resolve({ cause: "cancel", response: 1 }); await q.call.consumer;
});
test("copied or foreign signals confer no question identity", async () => {
  const h = fixture(), q = h.ask();
  assert.equal(h.read(1, {}), null);
  assert.equal(h.read(1, new AbortController().signal), null);
  assert.equal(h.read(1, { ...q.signal }), null);
  q.provider.resolve({ cause: "cancel", response: 1 }); await q.call.consumer;
});
for (const [label, result, approved] of [
  ["genuine approval", { cause: "choice", response: 0 }, true],
  ["genuine cancel", { cause: "choice", response: 1 }, false],
  ["provider cancellation", { cause: "cancel", response: 1 }, false],
  ["provider stale result", { cause: "stale", response: 0 }, false],
  ["provider aborted result", { cause: "aborted", response: 0 }, false],
]) test(label + " keeps the original answer-consumption result", async () => {
  const h = fixture(), q = h.ask();
  q.provider.resolve(result); await h.read(1, q.signal);
  assert.deepEqual(h.trace.filter(row => row[0] === "settle"), [["settle", 1, approved, "dirty"]]);
  assert.equal(h.context.pendingShutdown, null);
  assert.equal(q.record.dialogAbortController, null);
  assert.equal(h.read(1, q.signal), q.call.consumer);
});
test("concurrent stale and current requests retain distinct exact consumers", async () => {
  const h = fixture(), old = h.ask({ id: 1 }), current = h.ask({ id: 2 });
  assert.notEqual(old.signal, current.signal);
  assert.notEqual(h.read(1, old.signal), h.read(2, current.signal));
  assert.equal(h.read(1, current.signal), null);
  old.provider.resolve({ cause: "choice", response: 0 }); await old.call.consumer;
  assert.equal(h.context.staleShutdownDialogCompletionCount, 1);
  assert.equal(h.context.pendingShutdown, current.record);
  current.provider.resolve({ cause: "choice", response: 1 }); await current.call.consumer;
  assert.equal(h.read(1, old.signal), old.call.consumer);
});
test("an aborted original signal remains a readable historical key", async () => {
  const h = fixture(), q = h.ask();
  q.record.dialogAbortController.abort(); q.provider.resolve({ cause: "aborted", response: 1 });
  await q.call.consumer;
  assert.equal(q.signal.aborted, true);
  assert.equal(h.read(1, q.signal), q.call.consumer);
});
test("same-request rerouting gets another signal and does not complete the later question", async () => {
  const h = fixture(), q = h.ask();
  h.config.reask = true; h.context.deletionEvidenceCapacityLatched = true;
  q.provider.resolve({ cause: "choice", response: 0 }); await q.call.consumer;
  assert.equal(h.calls.length, 2);
  const next = h.calls[1], signal = next.options.signal;
  assert.notEqual(signal, q.signal);
  assert.equal(h.read(1, q.signal), q.call.consumer);
  assert.equal(h.read(1, signal), next.consumer);
  assert.equal(h.trace.some(row => row[0] === "settle"), false);
  h.providers[1].resolve({ cause: "choice", response: 1 }); await next.consumer;
});
test("retained lookup does not depend on simulated current pending state or reset", async () => {
  const h = fixture(), q = h.ask();
  h.context.pendingShutdown = null;
  q.provider.resolve({ cause: "choice", response: 0 }); await q.call.consumer;
  assert.equal(h.read(1, q.signal), q.call.consumer);
  const reset = between("          reset: () => {", "\n          },");
  assert.ok(!reset.includes("shutdownQuestionConsumers"));
});
test("source allocation and private exports survive a later packaged-test spoof", async () => {
  const h = fixture();
  h.context.app.isPackaged = true;
  const q = h.ask();
  assert.equal(h.read(1, q.signal), q.call.consumer);
  q.provider.resolve({ cause: "cancel", response: 1 }); await q.call.consumer;
});
test("initially packaged Main has neither a registry nor the private export", async () => {
  const h = fixture({ packaged: true }), q = h.ask();
  assert.equal(h.context.api, undefined);
  assert.equal(vm.runInContext("shutdownQuestionConsumers", h.context), null);
  assert.equal(q.result, undefined);
  q.provider.resolve({ cause: "cancel", response: 1 }); await q.call.consumer;
});
test("already-asked records still return without starting another question", () => {
  const h = fixture(), record = { id: 1, asked: true };
  assert.equal(h.ask(record).result, undefined);
  assert.equal(h.calls.length, 0);
});
test("missing owner follows the original synchronous path without a question", () => {
  const h = fixture(); h.config.noWindow = true;
  assert.equal(h.ask().result, undefined);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.trace, [["without-window", 1]]);
});
test("a controlled synchronous show throw is unchanged and registers no handle", () => {
  const h = fixture(), error = new Error("controlled synchronous show failure");
  h.config.showThrow = error;
  assert.throws(() => h.ask(), value => value === error);
  assert.equal(h.calls.length, 0);
  assert.equal(h.read(1, h.context.pendingShutdown.dialogAbortController.signal), null);
});
test("original asynchronous rejection is consumed by the existing catch", async () => {
  const h = fixture(), q = h.ask(), error = new Error("controlled rejection");
  q.provider.reject(error); await q.call.consumer;
  assert.ok(h.trace.some(row => row[0] === "log" && row[2] === error.message));
  assert.deepEqual(h.trace.filter(row => row[0] === "settle"),
    [["settle", 1, false, "dialog-failed"]]);
});
test("a consumer-body throw still reaches its original final catch", async () => {
  const h = fixture(), q = h.ask();
  h.config.firstSettleThrow = new Error("controlled consumer failure");
  q.provider.resolve({ cause: "choice", response: 0 }); await q.call.consumer;
  assert.deepEqual(h.trace.filter(row => row[0] === "settle"),
    [["settle", 1, true, "dirty"], ["settle", 1, false, "dialog-failed"]]);
});
test("an error escaping the original final catch remains the same rejection", async () => {
  const h = fixture(), q = h.ask(), error = new Error("controlled final catch failure");
  h.config.finalSettleThrow = error;
  const rejected = assert.rejects(q.call.consumer, value => value === error);
  q.provider.reject(new Error("provider rejection")); await rejected;
  assert.equal(h.read(1, q.signal), q.call.consumer);
});
test("lookup adds no new original promise reactions or actions", async () => {
  const h = fixture(), q = h.ask(), before = h.trace.slice();
  for (let i = 0; i < 5; i++) assert.equal(h.read(1, q.signal), q.call.consumer);
  assert.equal(q.call.thenCalls, 1); assert.equal(q.call.catchCalls, 1);
  assert.deepEqual(h.trace, before);
  q.provider.resolve({ cause: "cancel", response: 1 }); await q.call.consumer;
});
test("actual show body forwards the exact signal through a fresh provider-options object", async () => {
  const h = fixture({ actualShow: true }), q = h.ask();
  assert.equal(q.call.owner, h.win); assert.equal(q.provider.owner, h.win);
  assert.equal(q.call.emergency, "shutdown");
  assert.notEqual(q.provider.options, q.call.options);
  assert.equal(q.provider.options.signal, q.signal);
  assert.equal(q.provider.options.allowUnavailableRenderer, true);
  assert.equal(q.provider.early, null);
  assert.equal(h.read(1, q.provider.options.signal), q.call.consumer);
  q.provider.resolve({ cause: "choice", response: 1 }); await q.call.consumer;
});
async function timingScenario(original, fallback) {
  const h = fixture({ original, actualShow: true });
  if (fallback) h.config.providerThrow = new Error("controlled construction failure");
  const q = h.ask();
  h.trace.push(["ask-return", q.result]);
  assert.equal(q.result, undefined);
  if (fallback) {
    assert.equal(h.native.length, 1);
    h.native[0].resolve({ response: 1 });
  } else q.provider.resolve({ cause: "choice", response: 0 });
  await q.call.consumer;
  h.trace.push(["consumer-observed"]);
  if (fallback) assert.ok(h.timers.every(timer => timer.cleared));
  return h.trace;
}
for (const fallback of [false, true]) test(fallback
  ? "actual emergency-port failure ordering matches the unchanged original consumer"
  : "actual normal-provider ordering matches the unchanged original consumer", async () => {
  assert.deepEqual(await timingScenario(false, fallback), await timingScenario(true, fallback));
});
(async () => {
  let failures = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log("PASS " + name); }
    catch (error) { failures++; console.error("FAIL " + name + "\n" + error.stack); }
  }
  console.log(`Main question-consumer controls: ${cases.length - failures} passed, ${failures} failed; actual function bodies/controlled ports only, Main module/native NOT RUN.`);
  if (failures) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
