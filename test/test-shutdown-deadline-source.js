"use strict";

// Actual test-helper code with simulated transport collaborators, not Main or Electron.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = path.join(__dirname, "test-tab-refresh.js");
const source = fs.readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
new vm.Script(source, { filename: sourcePath });
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", start);
  assert(start >= 0 && end > start, `missing complete helper ${name}`);
  return source.slice(start, end + 3);
}
let helper = extract("holdDeadlineCommitIngress");
const negative = process.argv[2];
if (negative) {
  const edits = {
    "drop-argument": [
      "Reflect.apply(originalEmit, ingress.receiver, ingress.args)",
      "Reflect.apply(originalEmit, ingress.receiver, ingress.args.slice(0, 2))",
    ],
    "wrong-owner": ["ownsEvent(event)) {", "true) {"],
  };
  assert(Object.hasOwn(edits, negative), `unknown negative control ${negative}`);
  const [before, after] = edits[negative];
  assert.equal(helper.split(before).length, 2, "negative control has one exact source target");
  helper = helper.replace(before, after);
  console.log(`NEGATIVE CONTROL ${negative}: changed only the extracted transport helper`);
}

function fixture() {
  const ipcMain = new EventEmitter();
  const frame = { parent: null, frameTreeNodeId: 31, isDestroyed: () => false };
  const sends = [];
  const wc = {
    mainFrame: frame,
    isDestroyed: () => false,
    send(...args) { sends.push({ receiver: this, args }); },
  };
  let state = {
    rendererGeneration: 7, rendererPageSession: "page-seven",
    lastRequestId: 91, commitPendingId: 0,
    commitSequence: 0, commitAuthorisedSeq: 0,
  };
  const aborts = [];
  const context = vm.createContext({
    ipcMain,
    __shutdown: {
      state: () => ({ ...state }),
      abortCommit(id) { aborts.push(id); state.commitPendingId = 0; return true; },
    },
  });
  const create = new vm.Script(`${extract("replaceMethod")}\n${helper}\nholdDeadlineCommitIngress;`)
    .runInContext(context);
  const originalSend = Object.getOwnPropertyDescriptor(wc, "send");
  const originalEmit = Object.getOwnPropertyDescriptor(ipcMain, "emit");
  const hold = create({ webContents: wc });
  const event = { sender: wc, senderFrame: frame };
  const request = { id: 91, gen: 7, revision: 12 };
  const answer = { ...request, committed: true, why: "simulated producer" };
  const calls = [];
  ipcMain.on("quit-approval-committed", function (...args) {
    calls.push({ receiver: this, args });
  });
  const arm = () => {
    state = { ...state, commitPendingId: 91, commitSequence: 3, commitAuthorisedSeq: 91 };
    wc.send("quit-approval-request", request);
    wc.send("quit-approval-commit", request);
  };
  const capture = (...extra) => ipcMain.emit("quit-approval-committed", event, answer, ...extra);
  const restored = () => {
    assert.deepEqual(Object.getOwnPropertyDescriptor(wc, "send"), originalSend);
    assert.deepEqual(Object.getOwnPropertyDescriptor(ipcMain, "emit"), originalEmit);
  };
  return { ipcMain, wc, frame, sends, hold, event, request, answer, calls, aborts,
    originalSend, originalEmit,
    arm, capture, restored, state: () => state,
    update: (next) => { state = { ...state, ...next }; } };
}

const cases = [
  ["the complete Electron suite compiles without executing it", () => {
    assert(source.includes("async function runCommitDeadlineAndContinuationScenarios"));
  }],
  ["the outgoing producer request is forwarded unchanged before the ingress hold", () => {
    const f = fixture();
    try {
      f.arm();
      assert.equal(f.sends.length, 2);
      assert.equal(f.sends[1].receiver, f.wc);
      assert.equal(f.sends[1].args[1], f.request);
      assert.equal(f.hold.approvalRequests[0], f.request);
      assert.equal(f.hold.answer, null);
    } finally { f.hold.dispose(); f.restored(); }
  }],
  ["release retains the original event, payload, extra argument and emitter receiver", () => {
    const f = fixture();
    try {
      f.arm();
      const extra = {};
      f.capture(extra);
      assert.equal(f.calls.length, 0);
      assert.equal(f.hold.answer, f.answer);
      assert.equal(f.hold.snapshot().captured, 1);
      f.hold.release();
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].receiver, f.ipcMain);
      assert.equal(f.calls[0].args[0], f.event);
      assert.equal(f.calls[0].args[1], f.answer);
      assert.equal(f.calls[0].args[2], extra);
      assert.throws(() => f.hold.release(), /cannot be released/);
    } finally { f.hold.dispose(); f.restored(); }
  }],
  ["foreign owner and subframe ingress are forwarded rather than held", () => {
    const f = fixture();
    try {
      f.arm();
      const foreign = { sender: {}, senderFrame: f.frame };
      const subframe = { sender: f.wc, senderFrame: { ...f.frame, parent: f.frame } };
      f.ipcMain.emit("quit-approval-committed", foreign, f.answer);
      f.ipcMain.emit("quit-approval-committed", subframe, f.answer);
      assert.equal(f.calls.length, 2);
      assert.equal(f.calls[0].args[0], foreign);
      assert.equal(f.calls[1].args[0], subframe);
      assert.equal(f.hold.snapshot().captured, 0);
    } finally { f.hold.dispose(); f.restored(); }
  }],
  ["unrelated channels and nonmatching attempt, generation, revision or result pass through", () => {
    const f = fixture();
    try {
      f.arm();
      let unrelated = 0;
      f.ipcMain.on("other", () => { unrelated += 1; });
      f.ipcMain.emit("other", f.event, f.answer);
      for (const delta of [{ id: 92 }, { gen: 8 }, { revision: 13 }, { committed: false }]) {
        f.ipcMain.emit("quit-approval-committed", f.event, { ...f.answer, ...delta });
      }
      assert.equal(unrelated, 1);
      assert.equal(f.calls.length, 4);
      assert.equal(f.hold.snapshot().captured, 0);
    } finally { f.hold.dispose(); f.restored(); }
  }],
  ["a live retained ingress can be delivered once after its pending slot expires", () => {
    const f = fixture();
    try {
      f.arm();
      f.capture();
      f.update({ commitPendingId: 0 });
      f.hold.release();
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].args[1], f.answer);
    } finally { f.hold.dispose(); f.restored(); }
  }],
  ["duplicate matching ingress invalidates release instead of approving twice", () => {
    const f = fixture();
    try {
      f.arm();
      f.capture();
      f.capture();
      assert.equal(f.hold.snapshot().captured, 2);
      assert.throws(() => f.hold.release(), /cannot be released/);
      assert.equal(f.calls.length, 0);
    } finally { f.hold.dispose(); f.restored(); }
  }],
  ["navigation forbids release and explicitly retires the old original event", () => {
    const f = fixture();
    try {
      f.arm();
      f.capture();
      f.update({ rendererGeneration: 8, rendererPageSession: "page-eight", commitPendingId: 0 });
      assert.throws(() => f.hold.release(), /cannot be released/);
      f.hold.retire("committed-navigation");
      assert.equal(f.hold.answer, null);
      assert.equal(f.hold.snapshot().retired, "committed-navigation");
      assert.throws(() => f.hold.retire("again"), /cannot be retired/);
      assert.equal(f.calls.length, 0);
    } finally { f.hold.dispose(); f.restored(); }
  }],
  ["cleanup aborts only its exact still-pending attempt and retires without delivery", () => {
    const f = fixture();
    f.arm();
    f.capture();
    f.hold.dispose();
    f.restored();
    assert.deepEqual(f.aborts, [91]);
    assert.equal(f.calls.length, 0);
    assert.equal(f.hold.snapshot().retired, "fixture-cleanup");
    f.hold.dispose();
    f.restored();
  }],
  ["cleanup does not abort a successor attempt", () => {
    const f = fixture();
    f.arm();
    f.capture();
    f.update({ commitPendingId: 92, lastRequestId: 92 });
    f.hold.dispose();
    f.restored();
    assert.deepEqual(f.aborts, []);
    assert.equal(f.calls.length, 0);
  }],
  ["a foreign replacement is not overwritten while the other owned hook is restored", () => {
    const f = fixture();
    const replacement = () => true;
    f.ipcMain.emit = replacement;
    assert.throws(() => f.hold.restore(), /restoration failed/);
    assert.equal(f.ipcMain.emit, replacement);
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.wc, "send"), f.originalSend);
    assert.equal(f.hold.snapshot().restored, false);
    assert.equal(f.hold.snapshot().restorationAttempted, true);
  }],
  ["a throwing send restoration does not skip independent ingress restoration", () => {
    const f = fixture();
    Object.defineProperty(f.wc, "send", { configurable: false });
    assert.throws(() => f.hold.restore(), /restoration failed/);
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.ipcMain, "emit"), f.originalEmit);
    assert.equal(f.hold.snapshot().restored, false);
  }],
];

let failures = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} helper controls; Main/Electron/native NOT RUN`);
process.exitCode = failures ? 1 : 0;
