"use strict";
const fs = require("fs");
const vm = require("vm");
const { createReadingHistory, MAX_LOCATIONS } = require("../src/reading-history");
const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}
function throwsTypeError(action) {
  try { action(); } catch (error) { return error instanceof TypeError; }
  return false;
}
const point = top => ({ top, left: 0, heading: null, nested: [] });
const encoded = history => JSON.stringify(history.snapshot());
function jump(history, from, to) {
  return history.commit(history.stageJump(point(from)), point(to), true);
}
function traverse(history, direction, from, to) {
  return history.commit(history.stageTraverse(direction, point(from)), point(to), true);
}

const initial = createReadingHistory();
check("empty history has no implicit location or traversal", initial.snapshot().entries.length === 0 &&
  initial.snapshot().index === -1 && !initial.snapshot().canBack && !initial.snapshot().canForward);
const emptyBefore = encoded(initial);
const canceled = initial.stageJump(point(0));
check("staging does not commit a departure or change the timeline", encoded(initial) === emptyBefore);
check("canceling an owned stage succeeds once", initial.cancel(canceled) && !initial.cancel(canceled));
check("a canceled completion cannot create history",
  initial.commit(canceled, point(10), true).reason === "stale" && encoded(initial) === emptyBefore);
const stationary = initial.stageJump(point(0));
check("a no-travel first jump leaves even the revision unchanged",
  initial.commit(stationary, undefined, false).reason === "no-travel" && encoded(initial) === emptyBefore);

const first = jump(initial, 0, 100);
let state = initial.snapshot();
check("first arrived jump records departure and destination, including current",
  first.committed && state.entries.length === 2 && state.index === 1 &&
  state.entries[0].location.top === 0 && state.entries[1].location.top === 100 &&
  state.canBack && !state.canForward);
check("first entries receive distinct stable IDs", state.entries[0].id !== state.entries[1].id);
const targetId = state.entries[1].id;
traverse(initial, -1, 150, 0);
state = initial.snapshot();
check("Back refreshes the actual scrolled departure without appending",
  state.entries.length === 2 && state.index === 0 && state.entries[1].id === targetId &&
  state.entries[1].location.top === 150 && !state.canBack && state.canForward);
traverse(initial, 1, 20, 150);
state = initial.snapshot();
check("Forward returns to the refreshed departure and refreshes its own departure",
  state.index === 1 && state.entries[0].location.top === 20 && state.entries[1].location.top === 150);

traverse(initial, -1, 160, 20);
const branchBefore = encoded(initial);
const failedBranch = initial.stageJump(point(25));
initial.cancel(failedBranch);
check("a failed new jump preserves the complete Forward branch", encoded(initial) === branchBefore);
const noTravelBranch = initial.stageJump(point(25));
initial.commit(noTravelBranch, undefined, false);
check("a same-position jump preserves departure, index, revision and Forward", encoded(initial) === branchBefore);
jump(initial, 25, 300);
state = initial.snapshot();
check("only a successful new jump truncates Forward and refreshes departure",
  state.entries.length === 2 && state.entries[0].location.top === 25 &&
  state.entries[1].location.top === 300 && state.entries[1].id !== targetId && !state.canForward);

const capped = createReadingHistory();
for (let top = 1; top <= 12; top++) jump(capped, top - 1, top);
state = capped.snapshot();
check("the cap is ten total entries, not ten Back entries",
  MAX_LOCATIONS === 10 && state.entries.length === 10 && state.index === 9 &&
  state.entries[0].location.top === 3 && state.entries[9].location.top === 12);
check("eviction preserves unique increasing entry IDs",
  state.entries.every((entry, index, entries) => index === 0 || entry.id > entries[index - 1].id));
const fullIds = state.entries.map(entry => entry.id);
const fullBefore = encoded(capped);
const fullCanceled = capped.stageJump(point(12.5));
capped.cancel(fullCanceled);
check("staging at capacity never evicts an entry", encoded(capped) === fullBefore);
traverse(capped, -1, 12.5, 11);
traverse(capped, -1, 11.5, 10);
jump(capped, 10.5, 99);
state = capped.snapshot();
check("branching below capacity drops only Forward entries",
  state.entries.length === 9 && state.index === 8 &&
  state.entries.slice(0, 8).every((entry, index) => entry.id === fullIds[index]) &&
  state.entries[7].location.top === 10.5 && state.entries[8].location.top === 99);

const typing = createReadingHistory();
const typedFirst = jump(typing, 0, 10);
const originBefore = typing.snapshot().entries[0];
typing.commit(typing.stageReplace(typedFirst.entryId), point(20), true);
state = typing.snapshot();
check("continued typing replaces only its current owned destination",
  state.entries.length === 2 && state.index === 1 && state.entries[1].id === typedFirst.entryId &&
  state.entries[1].location.top === 20 && state.entries[0] === originBefore);
const replacementBefore = encoded(typing);
typing.commit(typing.stageReplace(typedFirst.entryId), undefined, false);
check("a failed replacement retains the last reached destination", encoded(typing) === replacementBefore);
jump(typing, 20, 30);
check("an old typing destination cannot replace a later explicit entry",
  typing.stageReplace(typedFirst.entryId).reason === "entry-changed" &&
  typing.snapshot().entries.at(-1).location.top === 30);

const superseded = typing.stageJump(point(30));
const successor = typing.stageJump(point(31));
const beforeSupersession = encoded(typing);
check("an older stage cannot commit over a newer owner",
  typing.commit(superseded, point(40), true).reason === "stale" &&
  encoded(typing) === beforeSupersession);
typing.cancel(successor);
check("canceling the successor does not resurrect an earlier stage",
  typing.commit(superseded, point(40), true).reason === "stale");
const oneUse = typing.stageJump(point(30));
typing.commit(oneUse, point(50), true);
const committedOnce = encoded(typing);
check("a consumed receipt cannot commit twice", typing.commit(oneUse, point(60), true).reason === "stale" &&
  encoded(typing) === committedOnce);
check("forged and foreign receipts are explicit errors",
  throwsTypeError(() => typing.commit({}, point(1), true)) &&
  throwsTypeError(() => typing.commit(createReadingHistory().stageJump(point(0)), point(1), true)));

const availability = createReadingHistory();
const eligible = availability.stageJump(point(0));
check("exhausted traversal is explicitly unavailable",
  availability.stageTraverse(-1, point(0)).reason === "boundary");
check("an unavailable action does not supersede an eligible stage",
  availability.commit(eligible, point(10), true).committed);
const replacement = availability.stageReplace(availability.snapshot().entries[1].id);
check("an unavailable replacement does not supersede current ownership",
  availability.stageReplace(999).reason === "entry-changed" &&
  availability.commit(replacement, point(11), true).committed);
check("invalid directions and entry IDs are rejected",
  [0, "back", null].every(direction => throwsTypeError(() => availability.stageTraverse(direction, point(0)))) &&
  [0, -1, 1.5, NaN].every(id => throwsTypeError(() => availability.stageReplace(id))));

const oldIds = availability.snapshot().entries.map(entry => entry.id);
const retired = availability.stageJump(point(11));
availability.clear();
check("semantic clear removes values and retires pending work",
  availability.snapshot().entries.length === 0 && availability.snapshot().index === -1 &&
  availability.commit(retired, point(12), true).reason === "stale");
jump(availability, 100, 110);
check("clear never reuses IDs from an earlier document lifetime",
  availability.snapshot().entries.every(entry => !oldIds.includes(entry.id)));

const immutable = createReadingHistory();
const departure = { top: 0, heading: { text: "Heading", ordinal: 1 }, nested: [{ top: 5 }] };
const arrival = { top: 100, nested: [{ top: 15 }] };
const immutableStage = immutable.stageJump(departure);
departure.heading.text = "Changed";
departure.nested[0].top = 999;
immutable.commit(immutableStage, arrival, true);
arrival.nested[0].top = 888;
const immutableState = immutable.snapshot();
check("caller mutation cannot change staged or committed locations",
  immutableState.entries[0].location.heading.text === "Heading" &&
  immutableState.entries[0].location.nested[0].top === 5 &&
  immutableState.entries[1].location.nested[0].top === 15);
check("snapshots and nested location values are immutable",
  throwsTypeError(() => { immutableState.entries.push({}); }) &&
  throwsTypeError(() => { immutableState.entries[1].location.nested[0].top = 99; }));
let getterCalls = 0;
const accessor = { get top() { getterCalls++; return 0; } };
check("location accessors are rejected without executing them",
  throwsTypeError(() => immutable.stageJump(accessor)) && getterCalls === 0);
const cycle = {}; cycle.self = cycle;
const hidden = Object.defineProperty({}, "top", { value: 0 });
const symbolic = { [Symbol("node")]: 1 };
class NodeLike { constructor() { this.top = 0; } }
check("non-data, cyclic and non-finite locations are rejected",
  [null, [], { top: Infinity }, { top: NaN }, { top: undefined }, { action() {} },
    cycle, hidden, symbolic, new NodeLike()].every(location =>
    throwsTypeError(() => immutable.stageJump(location))));
const shared = { top: 2 };
check("shared acyclic data is not mistaken for a cycle",
  immutable.stageJump({ first: shared, second: shared }).kind === "jump");
const needsResult = immutable.stageJump(point(1));
check("missing arrival classification is an explicit error",
  throwsTypeError(() => immutable.commit(needsResult, point(2))) &&
  immutable.commit(needsResult, point(2), true).committed);

const browserSource = fs.readFileSync(require.resolve("../src/reading-history"), "utf8");
const browser = vm.runInNewContext(browserSource + `\n(() => {
  const history = window.FoliaReadingHistory.createReadingHistory();
  history.commit(history.stageJump({top:0}), {top:10}, true);
  return history.snapshot().entries.length === 2 && history.snapshot().canBack;
})()`, { window: {} });
check("the same source exports the working browser API without Node globals", browser);
check("CommonJS import does not create a browser global", !Object.hasOwn(globalThis, "FoliaReadingHistory"));
console.log(`=== ${results.filter(Boolean).length}/${results.length} passed ===`);
process.exitCode = results.every(Boolean) ? 0 : 1;
