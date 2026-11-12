"use strict";
const fs = require("fs");
const vm = require("vm");
const { createReadingViewport } = require("../src/reading-viewport");
const results = [];
function check(name, ok) {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + String(ok)}`);
}
function throwsTypeError(action) {
  try { action(); } catch (error) { return error instanceof TypeError; }
  return false;
}

function fixture() {
  const state = {
    tab: {}, lifetime: {}, selection: {}, source: 1, render: 1, mode: 1,
    writes: [], notifications: 0, onStop: null, onChanged: null,
    onIntentSnapshot: null, onViewportSnapshot: null,
  };
  const identityWithGetter = (identity, callback) => {
    const first = identity[0];
    Object.defineProperty(identity, 0, { get() { callback(); return first; } });
    return identity;
  };
  const readIntent = () => identityWithGetter(
    [state.tab, state.lifetime, state.selection], () => state.onIntentSnapshot?.());
  const readViewport = () => identityWithGetter(
    [state.tab, state.lifetime, state.selection, state.source, state.render, state.mode],
    () => state.onViewportSnapshot?.());
  const owner = createReadingViewport({
    readIntent, readViewport,
    stopMotion(chain, current) {
      for (const box of chain) {
        if (!current()) break;
        state.writes.push(box);
        state.onStop?.(box);
      }
    },
    changed() {
      state.notifications++;
      state.onChanged?.();
    },
  });
  return { owner, state };
}

const { owner, state } = fixture();
const emptyPermit = owner.capturePermit();
check("an idle permit is issued and immutable", Object.isFrozen(emptyPermit) && owner.isPermitCurrent(emptyPermit));
check("a forged permit cannot authorize a viewport write", !owner.isPermitCurrent({}));
check("a forged intent cannot start or supersede movement",
  !owner.isIntentCurrent({}) && owner.trackMotion({}, [{}]).reason === "stale-intent");
const first = owner.beginIntent();
check("genuine intent invalidates an idle restoration permit",
  owner.isIntentCurrent(first) && !owner.isPermitCurrent(emptyPermit) && state.notifications === 1);
const firstPermit = owner.capturePermit();
const inner = {}, outer = {}, root = {};
const originalChain = [inner, outer, root, inner];
const movement = owner.trackMotion(first, originalChain);
originalChain.length = 0;
check("accepted movement retains current intent and a distinct immutable receipt",
  movement.accepted && Object.isFrozen(movement) && Object.isFrozen(movement.receipt) &&
  owner.isIntentCurrent(first) && owner.isMotionCurrent(movement.receipt));
check("movement supersedes restoration even without an arrival or travel sample",
  !owner.isPermitCurrent(firstPermit) && state.writes.length === 0);
check("unknown cancellation cannot stop the current motion",
  !owner.cancelMotion({}) && owner.isMotionCurrent(movement.receipt) && state.writes.length === 0);
check("owned cancellation stops each captured box once, including the root",
  owner.cancelMotion(movement.receipt) &&
  state.writes.length === 3 && state.writes[0] === inner &&
  state.writes[1] === outer && state.writes[2] === root);
check("owned cancellation is idempotent and does not invent a new intent",
  !owner.cancelMotion(movement.receipt) && state.writes.length === 3 && owner.isIntentCurrent(first));
check("a canceled execution is never current", !owner.isMotionCurrent(movement.receipt));

const second = owner.beginIntent();
const secondMovement = owner.trackMotion(second, [outer]);
const writesBeforeStale = state.writes.length;
const missingReceipt = fixture();
const missingReceiptMotion = missingReceipt.owner.trackMotion(missingReceipt.owner.beginIntent(), [root]);
check("missing-receipt control has a live owned execution", missingReceipt.owner.isMotionCurrent(missingReceiptMotion.receipt));
check("missing cancellation receipts cannot borrow the current execution",
  !missingReceipt.owner.cancelMotion() && !missingReceipt.owner.cancelMotion(undefined) &&
  !missingReceipt.owner.cancelMotion(null) && missingReceipt.state.writes.length === 0 &&
  missingReceipt.owner.isMotionCurrent(missingReceiptMotion.receipt));
const sparseChain = fixture();
const sparseTicket = sparseChain.owner.beginIntent();
const sparseMotion = sparseChain.owner.trackMotion(sparseTicket, [root]);
check("sparse-chain control has a live owned execution", sparseChain.owner.isMotionCurrent(sparseMotion.receipt));
check("sparse chains fail before they can cancel the current execution",
  throwsTypeError(() => sparseChain.owner.trackMotion(sparseTicket, new Array(1))) &&
  sparseChain.owner.isMotionCurrent(sparseMotion.receipt) && sparseChain.state.writes.length === 0);
check("superseded intent is refused before it can cancel a successor",
  owner.trackMotion(first, [inner]).reason === "stale-intent" &&
  state.writes.length === writesBeforeStale && owner.isMotionCurrent(secondMovement.receipt));
const pendingPermit = owner.capturePermit();
owner.invalidate();
check("a source rebuild retires execution and viewport permits but retains genuine intent",
  !owner.isMotionCurrent(secondMovement.receipt) && !owner.isPermitCurrent(pendingPermit) &&
  owner.isIntentCurrent(second));
state.source++;
state.render++;
const resumed = owner.trackMotion(second, [inner]);
check("the originating intent can rebuild execution against a newer same-tab source",
  resumed.accepted && owner.isMotionCurrent(resumed.receipt) && owner.isIntentCurrent(second));
const currentPermit = owner.capturePermit();
check("old receipt cleanup cannot stop the rebuilt execution",
  !owner.cancelMotion(secondMovement.receipt) && owner.isMotionCurrent(resumed.receipt) &&
  owner.isPermitCurrent(currentPermit));

for (const field of ["source", "render", "mode"]) {
  const { owner: local, state: changed } = fixture();
  const ticket = local.beginIntent();
  const permit = local.capturePermit();
  const moving = local.trackMotion(ticket, [{}]);
  const bound = local.capturePermit();
  changed[field]++;
  check(`changed ${field} identity independently fences late viewport work`,
    !local.isPermitCurrent(permit) && !local.isPermitCurrent(bound) &&
    !local.isMotionCurrent(moving.receipt) && local.isIntentCurrent(ticket));
}
for (const field of ["tab", "lifetime", "selection"]) {
  const { owner: local, state: changed } = fixture();
  const ticket = local.beginIntent();
  const moving = local.trackMotion(ticket, [{}]);
  const bound = local.capturePermit();
  changed[field] = {};
  check(`changed ${field} identity fences both intent and execution`,
    !local.isIntentCurrent(ticket) && !local.isPermitCurrent(bound) &&
    !local.isMotionCurrent(moving.receipt));
}

const other = fixture().owner;
check("foreign receipts and permits have no authority",
  !other.isIntentCurrent(second) && !other.isPermitCurrent(currentPermit) &&
  !other.isMotionCurrent(resumed.receipt) && !other.cancelMotion(resumed.receipt));
const invalidChain = owner.beginIntent();
check("empty and malformed movement chains are rejected explicitly",
  throwsTypeError(() => owner.trackMotion(invalidChain, [])) &&
  throwsTypeError(() => owner.trackMotion(invalidChain, [null])));

const nested = fixture();
const old = nested.owner.trackMotion(nested.owner.beginIntent(), [inner, outer, root]);
let successor = null;
nested.state.onStop = () => {
  nested.state.onStop = null;
  successor = nested.owner.trackMotion(nested.owner.beginIntent(), [root]);
};
nested.owner.cancelMotion(old.receipt);
check("the cancellation actor really installed a successor during its first native write",
  !!successor?.accepted && nested.state.writes.length > 0);
check("old chain cleanup cannot keep writing after a reentrant successor",
  nested.state.writes.length === 1 && nested.state.writes[0] === inner &&
  nested.owner.isMotionCurrent(successor.receipt));

const idleSuccessor = fixture();
const idleOldMotion = idleSuccessor.owner.trackMotion(idleSuccessor.owner.beginIntent(), [inner, outer]);
let idleTicket = null;
idleSuccessor.state.onStop = () => {
  idleSuccessor.state.onStop = null;
  idleTicket = idleSuccessor.owner.beginIntent();
};
idleSuccessor.owner.cancelMotion(idleOldMotion.receipt);
check("a no-motion successor really superseded the cancellation actor", idleTicket !== null);
check("old cancellation stops writing after even a no-motion successor",
  idleSuccessor.owner.isIntentCurrent(idleTicket) && idleSuccessor.state.writes.length === 1);

const reentrant = fixture();
const oldTicket = reentrant.owner.beginIntent();
reentrant.owner.trackMotion(oldTicket, [inner]);
let newerTicket = null;
reentrant.state.onStop = () => {
  reentrant.state.onStop = null;
  newerTicket = reentrant.owner.beginIntent();
};
const canceledIntent = reentrant.owner.beginIntent();
check("a reentrant newer intent is not borrowed by the older begin call",
  newerTicket && reentrant.owner.isIntentCurrent(newerTicket) &&
  !reentrant.owner.isIntentCurrent(canceledIntent));

const changedDuringTrack = fixture();
const sharedTicket = changedDuringTrack.owner.beginIntent();
let newerMotion = null;
changedDuringTrack.state.onChanged = () => {
  changedDuringTrack.state.onChanged = null;
  newerMotion = changedDuringTrack.owner.trackMotion(sharedTicket, [root]);
};
const overtaken = changedDuringTrack.owner.trackMotion(sharedTicket, [inner]);
check("same-intent reentry really installs a newer execution", newerMotion?.accepted);
check("a stale outer track cannot replace a same-intent successor",
  overtaken.reason === "superseded" &&
  changedDuringTrack.owner.isMotionCurrent(newerMotion.receipt));

const copiedDuringTrack = fixture();
const copyingTicket = copiedDuringTrack.owner.beginIntent();
let copyingSuccessor = null;
const changingChain = [inner];
Object.defineProperty(changingChain, 0, {
  get() {
    copyingSuccessor = copiedDuringTrack.owner.trackMotion(copiedDuringTrack.owner.beginIntent(), [root]);
    return inner;
  },
});
const staleCopy = copiedDuringTrack.owner.trackMotion(copyingTicket, changingChain);
check("chain collection really admitted a newer user intent", copyingSuccessor?.accepted);
check("a request superseded during chain collection cannot cancel the successor",
  staleCopy.reason === "superseded" && copiedDuringTrack.state.writes.length === 0 &&
  copiedDuringTrack.owner.isMotionCurrent(copyingSuccessor.receipt));

const sameIntentCopy = fixture();
const copyingSameTicket = sameIntentCopy.owner.beginIntent();
let sameIntentSuccessor = null;
const sameIntentChain = [inner];
Object.defineProperty(sameIntentChain, 0, {
  get() {
    sameIntentSuccessor = sameIntentCopy.owner.trackMotion(copyingSameTicket, [root]);
    return inner;
  },
});
const staleSameCopy = sameIntentCopy.owner.trackMotion(copyingSameTicket, sameIntentChain);
check("chain collection really admitted a newer same-intent execution", sameIntentSuccessor?.accepted);
check("same-intent chain reentry cannot cancel or replace its successor",
  staleSameCopy.reason === "superseded" && sameIntentCopy.state.writes.length === 0 &&
  sameIntentCopy.owner.isMotionCurrent(sameIntentSuccessor.receipt));

const permitReentry = fixture();
const staleDuringRead = permitReentry.owner.capturePermit();
let permitGetterRan = false;
permitReentry.state.onViewportSnapshot = () => {
  permitReentry.state.onViewportSnapshot = null;
  permitGetterRan = true;
  permitReentry.owner.invalidate();
};
check("identity collection cannot make an invalidated permit look current",
  !permitReentry.owner.isPermitCurrent(staleDuringRead) && permitGetterRan);

const intentReentry = fixture();
const oldDuringRead = intentReentry.owner.beginIntent();
let newestDuringRead = null;
intentReentry.state.onIntentSnapshot = () => {
  intentReentry.state.onIntentSnapshot = null;
  newestDuringRead = intentReentry.owner.beginIntent();
};
check("identity collection cannot make a superseded intent look current",
  !intentReentry.owner.isIntentCurrent(oldDuringRead) && newestDuringRead &&
  intentReentry.owner.isIntentCurrent(newestDuringRead));

const captureReentry = fixture();
const captureTicket = captureReentry.owner.beginIntent();
let capturedSuccessor = null;
captureReentry.state.onViewportSnapshot = () => {
  captureReentry.state.onViewportSnapshot = null;
  capturedSuccessor = captureReentry.owner.trackMotion(captureTicket, [root]);
};
const staleCapture = captureReentry.owner.trackMotion(captureTicket, [inner]);
check("permit capture really admitted a newer same-intent execution", capturedSuccessor?.accepted);
check("permit capture cannot overwrite a reentrant successor",
  staleCapture.reason === "superseded" && captureReentry.state.writes.length === 0 &&
  captureReentry.owner.isMotionCurrent(capturedSuccessor.receipt));

const motionReentry = fixture();
const motionToCancel = motionReentry.owner.trackMotion(motionReentry.owner.beginIntent(), [root]);
let motionGetterRan = false;
motionReentry.state.onViewportSnapshot = () => {
  motionReentry.state.onViewportSnapshot = null;
  motionGetterRan = true;
  motionReentry.owner.cancelMotion(motionToCancel.receipt);
};
check("identity collection cannot make a cancelled motion look current",
  !motionReentry.owner.isMotionCurrent(motionToCancel.receipt) && motionGetterRan &&
  motionReentry.state.writes.length === 1);

const admissionReentry = fixture();
const admissionTicket = admissionReentry.owner.beginIntent();
let admissionSuccessor = null;
admissionReentry.state.onIntentSnapshot = () => {
  admissionReentry.state.onIntentSnapshot = null;
  admissionSuccessor = admissionReentry.owner.trackMotion(admissionTicket, [root]);
};
const staleAdmission = admissionReentry.owner.trackMotion(admissionTicket, [inner]);
check("initial intent collection really admitted a newer execution", admissionSuccessor?.accepted);
check("initial intent collection cannot borrow a successor epoch",
  staleAdmission.reason === "superseded" && admissionReentry.state.writes.length === 0 &&
  admissionReentry.owner.isMotionCurrent(admissionSuccessor.receipt));

const beginningReentry = fixture();
let begunTicket = null, begunMotion = null;
beginningReentry.state.onIntentSnapshot = () => {
  beginningReentry.state.onIntentSnapshot = null;
  begunTicket = beginningReentry.owner.beginIntent();
  begunMotion = beginningReentry.owner.trackMotion(begunTicket, [root]);
};
const staleBeginning = beginningReentry.owner.beginIntent();
check("begin-intent collection really installed a newer execution", begunMotion?.accepted);
check("an older begin-intent snapshot cannot invalidate the newer execution",
  !beginningReentry.owner.isIntentCurrent(staleBeginning) &&
  beginningReentry.owner.isIntentCurrent(begunTicket) && beginningReentry.state.writes.length === 0 &&
  beginningReentry.owner.isMotionCurrent(begunMotion.receipt));

const beginningPermit = fixture();
const beforeBeginning = beginningPermit.owner.capturePermit();
let permitWasRetired = false;
beginningPermit.state.onIntentSnapshot = () => {
  beginningPermit.state.onIntentSnapshot = null;
  permitWasRetired = !beginningPermit.owner.isPermitCurrent(beforeBeginning);
};
beginningPermit.owner.beginIntent();
check("genuine input retires old permits before reading external identity", permitWasRetired);

const mutableIdentity = [1];
const copied = createReadingViewport({
  readIntent: () => mutableIdentity, readViewport: () => mutableIdentity,
  stopMotion() {}, changed() {},
});
const copiedTicket = copied.beginIntent(), copiedPermit = copied.capturePermit();
mutableIdentity[0] = 2;
check("captured identities do not borrow mutable identity arrays",
  !copied.isIntentCurrent(copiedTicket) && !copied.isPermitCurrent(copiedPermit));
check("missing callbacks and empty identity tuples fail loudly",
  throwsTypeError(() => createReadingViewport({})) &&
  throwsTypeError(() => createReadingViewport({
    readIntent: () => [], readViewport: () => [], stopMotion() {}, changed() {},
  }).beginIntent()));
check("ownership never certifies arrival, travel or a history commit",
  !Object.hasOwn(owner, "arrived") && !Object.hasOwn(owner, "complete") &&
  !Object.hasOwn(owner, "commit"));

const browser = { window: {} };
vm.runInNewContext(fs.readFileSync(require.resolve("../src/reading-viewport"), "utf8"), browser);
check("the classic browser export matches the CommonJS factory contract",
  typeof browser.window.MarkalooReadingViewport?.createReadingViewport === "function" &&
  Object.isFrozen(browser.window.MarkalooReadingViewport));

require("./reading-viewport-lifecycle-controls")(check).catch(error => {
  console.log(error.stack);
  check("actual-source lifecycle controls complete without unexpected faults", false);
}).finally(() => {
  const passed = results.filter(Boolean).length;
  console.log(`=== ${passed}/${results.length} passed ===`);
  if (passed !== results.length) process.exitCode = 1;
});
