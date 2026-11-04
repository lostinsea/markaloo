const { EventEmitter } = require("events");

const rectKeys = ["x", "y", "width", "height"];
const copyRect = value => Object.fromEntries(rectKeys.map(key => [key, value[key]]));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function observeSearchRestore(win, contents, originalBounds) {
  const expected = Object.freeze(copyRect(originalBounds));
  const ownDescriptor = Object.getOwnPropertyDescriptor(win, "setBounds");
  const nativeSetBounds = win.setBounds;
  const receipts = [];
  const errors = [];
  let revision = 0;
  let overflow = false;
  let disposed = false;
  let released = false;
  const changed = () => { revision++; };
  const snapshot = () => ({
    bounds: copyRect(win.getBounds()), content: copyRect(win.getContentBounds()),
    minimum: [...win.getMinimumSize()], zoom: contents.getZoomFactor(), revision,
  });
  const observe = action => {
    try { return action(); }
    catch (error) { errors.push(String(error)); return null; }
  };
  function observedSetBounds(...args) {
    const receipt = {
      receiver: this === win, count: args.length, returned: false,
      request: observe(() => copyRect(args[0])),
      keys: observe(() => Object.keys(args[0]).sort()),
    };
    if (receipts.length < 2) receipts.push(receipt);
    else overflow = true;
    try {
      const result = Reflect.apply(nativeSetBounds, this, args);
      receipt.returned = true;
      return result;
    } finally {
      receipt.native = observe(snapshot);
    }
  }
  Object.defineProperty(win, "setBounds", {
    configurable: true, writable: true,
    enumerable: ownDescriptor?.enumerable ?? false, value: observedSetBounds,
  });
  win.on("resize", changed);
  win.on("move", changed);
  const intact = () => Object.getOwnPropertyDescriptor(win, "setBounds")?.value === observedSetBounds;
  return {
    snapshot,
    verify(before, viewport, after, minimum, browserZoom, dpr) {
      const requests = receipts.length === 2 && !overflow && errors.length === 0 && intact() &&
        receipts.every(receipt => receipt.receiver && receipt.count === 1 && receipt.returned &&
          same(receipt.keys, [...rectKeys].sort()) && same(receipt.request, expected));
      // This is a no-drift witness, not an expected size or a completion claim.
      const stable = !!receipts[1]?.native &&
        same(receipts[1].native, before) && same(before, after);
      const coherent = browserZoom === 1 && before.zoom === browserZoom && after.zoom === browserZoom &&
        same(before.minimum, minimum) && same(after.minimum, minimum) && viewport.dpr === dpr &&
        [viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0) &&
        viewport.width === before.content.width && viewport.height === before.content.height &&
        viewport.width === after.content.width && viewport.height === after.content.height;
      return {requests, stable, coherent, expected, receipts, errors, overflow, before, viewport, after};
    },
    dispose() {
      if (disposed) return released;
      disposed = true;
      released = intact();
      if (released) {
        if (ownDescriptor) Object.defineProperty(win, "setBounds", ownDescriptor);
        else delete win.setBounds;
      }
      win.removeListener("resize", changed);
      win.removeListener("move", changed);
      return released;
    },
  };
}

function runSearchRestoreContractChecks(check) {
  const original = {x: 776, y: 157, width: 1200, height: 802};
  function fixture() {
    const args = [];
    const result = {};
    let outer = {...original, height: 804};
    let content = {x: 782, y: 183, width: 1188, height: 772};
    let failure = null;
    class Window extends EventEmitter {
      setBounds(...values) {
        args.push({receiver: this, values});
        if (failure) throw failure;
        return result;
      }
      getBounds() { return {...outer}; }
      getContentBounds() { return {...content}; }
      getMinimumSize() { return [0, 0]; }
    }
    const win = new Window();
    const contents = {getZoomFactor: () => 1};
    const expected = {...original};
    const observer = observeSearchRestore(win, contents, expected);
    const viewport = {width: 1188, height: 772, dpr: 1.25};
    const verify = (before = observer.snapshot(), view = viewport, after = observer.snapshot()) =>
      observer.verify(before, view, after, [0, 0], 1, 1.25);
    return {win, observer, expected, viewport, verify, args, result,
      fail: error => { failure = error; },
      mutate: () => { outer.height += 20; content.height += 20; win.emit("resize"); },
      returnToOriginal: () => { outer.height -= 20; content.height -= 20; win.emit("resize"); },
      move: offset => {
        outer.x += offset; outer.y += offset;
        content.x += offset; content.y += offset;
        win.emit("move");
      }};
  }
  const use = action => {
    const state = fixture();
    try { action(state); } finally { state.observer.dispose(); }
  };
  const valid = state => {
    state.win.setBounds(state.expected);
    state.win.setBounds(state.expected);
  };
  use(state => {
    valid(state);
    const outcome = state.verify();
    check("search restore accepts correct requests with stable normalized native geometry",
      outcome.requests && outcome.stable && outcome.coherent, JSON.stringify(outcome));
    check("search restore observes the real receiver argument identity count and return",
      state.args.length === 2 && state.args.every(call => call.receiver === state.win &&
        call.values.length === 1 && call.values[0] === state.expected) &&
        state.win.setBounds(state.expected) === state.result);
    check("search restore rejects an extra delegated request", !state.verify().requests);
  });
  for (const wrong of [0, 1]) use(state => {
    for (let index = 0; index < 2; index++) {
      state.win.setBounds(index === wrong ? {...state.expected, height: 822} : state.expected);
    }
    const outcome = state.verify();
    check(`search restore rejects the wrong actual request ${wrong + 1}`,
      !outcome.requests && outcome.stable && outcome.coherent, JSON.stringify(outcome));
  });
  use(state => {
    state.expected.height += 20;
    valid(state);
    check("search restore keeps original expected bounds separate from mutable actor arguments",
      !state.verify().requests);
  });
  use(state => {
    valid(state);
    check("search restore rejects a stale renderer viewport despite stable native geometry",
      !state.verify(undefined, {...state.viewport, height: 770}).coherent);
    check("search restore rejects an unsupported browser zoom instead of inventing a conversion",
      !state.observer.verify(state.observer.snapshot(), state.viewport, state.observer.snapshot(),
        [0, 0], 1.25, 1.25).coherent);
  });
  use(state => {
    valid(state);
    state.mutate();
    const outcome = state.verify(undefined, {...state.viewport, height: 792});
    check("search restore rejects later geometry drift even when its viewport is coherent",
      !outcome.stable && outcome.requests && outcome.coherent, JSON.stringify(outcome));
  });
  use(state => {
    valid(state);
    const before = state.observer.snapshot();
    state.mutate();
    const outcome = state.verify(before, {...state.viewport, height: 792});
    check("search restore rejects native geometry changing across its renderer observation",
      !outcome.stable && !outcome.coherent && outcome.requests, JSON.stringify(outcome));
  });
  use(state => {
    valid(state);
    const before = state.observer.snapshot();
    state.mutate();
    state.returnToOriginal();
    const outcome = state.verify(before);
    check("search restore rejects out and back geometry drift during verification",
      !outcome.stable && outcome.requests && outcome.coherent, JSON.stringify(outcome));
  });
  use(state => {
    valid(state);
    const before = state.observer.snapshot();
    state.move(20);
    state.move(-20);
    const outcome = state.verify(before);
    check("search restore rejects move only out and back drift during verification",
      !outcome.stable && outcome.requests && outcome.coherent, JSON.stringify(outcome));
  });
  use(state => {
    const error = new Error("expected fake delegate failure");
    state.fail(error);
    let caught;
    try { state.win.setBounds(state.expected); } catch (failure) { caught = failure; }
    check("search restore preserves the original delegated exception", caught === error);
  });
  use(state => {
    const before = state.observer.snapshot();
    state.win.getBounds = () => { throw new Error("expected observer read failure"); };
    const returned = state.win.setBounds(state.expected);
    state.win.setBounds(state.expected);
    const outcome = state.verify(before, state.viewport, before);
    check("search restore fails explicitly on observation errors without changing the actor return",
      returned === state.result && !outcome.requests && outcome.errors.length === 2);
  });
  use(state => {
    valid(state);
    const foreign = () => {};
    state.win.setBounds = foreign;
    check("search restore rejects an intervening replacement without overwriting it at cleanup",
      !state.verify().requests && !state.observer.dispose() && state.win.setBounds === foreign &&
        state.win.listenerCount("resize") === 0 && state.win.listenerCount("move") === 0);
  });
  use(state => {
    const inherited = Object.getPrototypeOf(state.win).setBounds;
    const otherListener = () => {};
    state.win.on("resize", otherListener);
    state.observer.dispose();
    check("search restore removes only its own wrapper and geometry listeners",
      !Object.hasOwn(state.win, "setBounds") && state.win.setBounds === inherited &&
        state.win.listeners("resize").length === 1 && state.win.listeners("resize")[0] === otherListener &&
        state.win.listenerCount("move") === 0);
    const fresh = observeSearchRestore(state.win, {getZoomFactor: () => 1}, original);
    check("search restore starts with fresh invocation receipts", !fresh.verify(
      fresh.snapshot(), state.viewport, fresh.snapshot(), [0, 0], 1, 1.25).requests);
    fresh.dispose();
  });
}

module.exports = {observeSearchRestore, runSearchRestoreContractChecks};
if (require.main === module) {
  let passed = 0, total = 0;
  runSearchRestoreContractChecks((name, ok, detail = "") => {
    total++;
    if (ok) passed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
  });
  console.log(`=== ${passed}/${total} passed ===`);
  process.exitCode = passed === total ? 0 : 1;
}
