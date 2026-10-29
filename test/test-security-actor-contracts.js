"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { isDeepStrictEqual } = require("node:util");

const source = fs.readFileSync(path.join(__dirname, "test-render-security.js"), "utf8")
  .replace(/\r\n/g, "\n");
let checks = 0;
function check(name, operation) {
  operation();
  checks++;
  console.log("PASS " + name);
}
function between(start, end) {
  const first = source.indexOf(start);
  assert(first >= 0 && source.indexOf(start, first + start.length) === -1, start);
  const last = source.indexOf(end, first + start.length);
  assert(last > first, end);
  return source.slice(first, last);
}
function compile(code, context) {
  return vm.runInNewContext("(" + code.trim() + ")", context);
}

async function main() {
  const filePath = path.join(__dirname, "fixture.md"), generation = 7;
  const fixture = { filePath, heading: "Fixture", body: "# Fixture\n" };
  const action = { fixture, start: { entries: 0 }, settled: true, error: null };
  const entry = { action, kind: "drop", sender: true, frame: true,
    url: "file:///owned.html", filePath };
  const event = { trusted: true, prevented: true, count: 1, name: path.basename(filePath) };
  const ingressContext = { entries: [entry], pageUrl: entry.url, path };
  const ingress = compile(between("    function securityDropIngressMatches(",
    "    function dropDocumentMatches("), ingressContext);
  check("actual drop ingress accepts exact trusted owned evidence", () =>
    assert.equal(ingress(action, event), true));
  for (const [name, changed] of [
    ["untrusted event", { trusted: false }], ["uncanceled event", { prevented: false }],
    ["no file", { count: 0 }], ["multiple files", { count: 2 }],
    ["different filename", { name: "different.md" }],
  ]) {
    check("actual drop ingress rejects " + name, () =>
      assert.equal(ingress(action, { ...event, ...changed }), false));
  }
  for (const [name, changed] of [
    ["foreign action", { action: {} }], ["wrong route", { kind: "link" }],
    ["foreign sender", { sender: false }], ["foreign frame", { frame: false }],
    ["changed page", { url: "file:///other.html" }], ["wrong path", { filePath: "other.md" }],
  ]) {
    ingressContext.entries = [{ ...entry, ...changed }];
    check("actual drop ingress rejects " + name, () =>
      assert.equal(ingress(action, event), false));
  }
  for (const records of [[], [entry, entry]]) {
    ingressContext.entries = records;
    check("actual drop ingress rejects missing or duplicate Main entries", () =>
      assert.equal(ingress(action, event), false));
  }
  ingressContext.entries = [entry];
  for (const changed of [{ settled: false }, { error: "Main failed" }]) {
    Object.assign(action, changed);
    check("actual drop ingress rejects incomplete Main settlement", () =>
      assert.equal(ingress(action, event), false));
    Object.assign(action, { settled: true, error: null });
  }

  const owner = {
    id: 11, tabs: [{ id: 11, path: filePath }], path: filePath, current: filePath,
    content: fixture.body, original: fixture.body, live: fixture.body,
    descriptor: { logicalPath: filePath, documentUrl: pathToFileURL(filePath).href,
      ref: "a".repeat(64) },
    identity: { tabId: 11, documentRef: "a".repeat(64),
      rendererGeneration: generation, pageSession: "page" },
    pageSession: "page", state: { maintained: true, dirty: false,
      liveWitnessMatchesContent: true }, markedDirty: false,
    pending: { pending: false, count: 0 }, heading: fixture.heading,
    loading: false, welcome: false,
  };
  const matches = compile(between("    function dropDocumentMatches(",
    "    async function dispatchDrop("), { generation, pathToFileURL });
  check("actual dropped-document oracle accepts an exact clean admitted owner", () =>
    assert.equal(matches(owner, fixture, 1), true));
  for (const [name, changed] of [
    ["wrong owner count", { tabs: [] }], ["wrong path", { path: "other" }],
    ["wrong current file", { current: "other" }], ["wrong store", { content: "" }],
    ["wrong baseline", { original: "" }], ["wrong live body", { live: "" }],
    ["missing descriptor", { descriptor: null }], ["missing identity", { identity: null }],
    ["foreign generation", { identity: { ...owner.identity, rendererGeneration: 8 } }],
    ["foreign page session", { pageSession: "other" }],
    ["unmaintained owner", { state: { ...owner.state, maintained: false } }],
    ["dirty owner", { state: { ...owner.state, dirty: true } }],
    ["unwitnessed live source", { state: { ...owner.state, liveWitnessMatchesContent: false } }],
    ["dirty tab", { markedDirty: true }], ["pending save", { pending: { pending: true, count: 1 } }],
    ["stale DOM", { heading: "Previous" }], ["loading DOM", { loading: true }],
    ["welcome instead of document", { welcome: true }],
  ]) {
    check("actual dropped-document oracle rejects " + name, () =>
      assert.equal(matches({ ...owner, ...changed }, fixture, 1), false));
  }

  const observationCode = between("    const observer = {\n      enter(event, data) {\n" +
    "        const record = { filePath: data?.filePath, kind: data?.kind,",
    "    const dropSlots = [");
  const dropWaitCode = between("    async function dropWait(", "    const pageState =");
  const finishCode = between("    async function finishDrop(",
    "    try {\n    securityGestureRegistration.observer = observer;");
  const dirtySetup = between(
    '    const dirty = fixtures.get("dirty.md"), other = fixtures.get("other.md");',
    '    await exec("changeCurrentDocumentEditor(true)");');
  for (const attributed of [true, false]) {
    const contents = {}, frame = {}, registration = {};
    const context = {
      entries: [], sends: [], reads: [], faults: [], active: null,
      fixturePaths: new Set([filePath]), pageUrl: entry.url, generation, path, pathToFileURL,
      contents, frame, securityGestureRegistration: registration, samePage: () => true,
      originalSend() {}, originalOpen: async () => ({}), events: [], records: [],
      fixtures: new Map([["dirty.md", fixture], ["other.md", {}]]),
      readSecurityImageOwner: async () => owner, dropBarrier: async () => {},
      pageState: async () => ({ events: context.events, overlay: false, dialog: null }),
      fs: { promises: {}, readFileSync: () => fixture.body },
      shutdown: { documentAdmissionIsCurrent: () => true },
      check: (name, passed) => context.records.push({ name, passed }),
      sleep: async () => { throw new Error("Unexpected Node-only drop wait"); },
    };
    const api = vm.runInNewContext(observationCode + dropWaitCode +
      between("    function securityDropIngressMatches(", "    async function dispatchDrop(") +
      finishCode + "\n({ observer, observedSend, observedOpen });", context);
    contents.send = api.observedSend; context.fs.promises.open = api.observedOpen;
    registration.observer = api.observer;
    context.dispatchDrop = async nextFixture => {
      const current = { fixture: nextFixture, pending: true, settled: false,
        start: { entries: context.entries.length, sends: context.sends.length,
          reads: context.reads.length, events: context.events.length } };
      if (attributed) context.active = current;
      const record = api.observer.enter({ sender: contents, senderFrame: frame },
        { kind: "drop", filePath });
      await api.observedOpen(filePath);
      api.observedSend("external-file-open-request", { filePath });
      api.observedSend("file-opened", { path: filePath, content: fixture.body });
      context.events.push(event);
      api.observer.finish(record, true, null);
      return current;
    };
    frame.url = entry.url;
    const setup = vm.runInNewContext("(async () => {" + dirtySetup +
      "\nreturn dirtyOwner;})()", context);
    if (attributed) {
      assert.equal(await setup, owner);
      check("actual dirty-source setup uses the same attributed admitted-drop lifecycle", () => {
        assert.equal(context.faults.length, 0); assert.equal(context.active, null);
        assert.equal(context.entries.length, 1);
        assert.equal(context.entries[0].action.settled, true);
        assert.equal(context.entries[0].action.pending, false);
        assert.equal(context.records.length, 2);
        assert(context.records.every(record => record.passed));
      });
      api.observedSend("file-opened", { path: filePath, content: fixture.body });
      check("actual drop observation still refuses deliveries after dirty setup closes", () =>
        assert.deepEqual(context.faults, ["Unattributed late Main drop delivery"]));
    } else {
      await assert.rejects(setup, /Drop authority failed/);
      check("actual dirty-source setup refuses unattributed I/O and delivery without clearing faults", () =>
        assert(context.faults.includes("Unattributed dropped-file read") &&
          context.faults.includes("Unattributed late Main drop delivery")));
    }
  }

  const cleanupCode = between("      if (active && !active.settled) {",
    "      if (ownsDebugger && dragPending && !contents.isDestroyed())");
  for (const state of [null, { settled: true, pending: true }, { settled: false, pending: true }]) {
    let waits = 0, releaseSleep = null, completed = false;
    const context = { active: state && { ...state }, cleanup: [],
      sleep: () => {
        assert.equal(releaseSleep, null, "cleanup must await its outstanding sleep");
        waits++;
        return new Promise(resolve => {
          releaseSleep = () => { context.active.settled = true; resolve(); };
        });
      } };
    const operation = vm.runInNewContext("(async () => {" + cleanupCode + "})()", context)
      .then(() => { completed = true; });
    if (state?.settled === false) {
      await Promise.resolve();
      assert.equal(typeof releaseSleep, "function");
      assert.equal(completed, false); assert.equal(context.active.settled, false);
      assert.equal(context.cleanup.length, 0);
      releaseSleep();
    }
    await operation;
    check("actual drop cleanup refuses unfinished lifecycle: " + JSON.stringify(state), () => {
      assert.equal(context.cleanup.length, state ? 1 : 0);
      assert.equal(waits, state?.settled === false ? 1 : 0);
      if (state) {
        assert.match(context.cleanup[0].message, /lifecycle completion is unconfirmed/);
        assert.equal(context.active.pending, false);
      }
    });
  }

  const installCode = between("    await exec(`\n      (() => {\n" +
    "        if (Object.hasOwn(window, '__securityDrop')", "    const dropReset =");
  const disposeCode = between("    async function disposeDropPage()", "    async function dropBarrier()");
  for (const scenario of ["owned", "foreign", "existing-undefined-global"]) {
    const listeners = new Set(), calls = [], window = {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      dispatchEvent: event => { calls.push(event.type); return true; },
    };
    const foreign = { ownerKey: "foreign-key", listener() {}, fireDrag: () => calls.push("foreign") };
    if (scenario === "foreign") {
      window.__securityDrop = foreign; window.__securityDropListener = foreign.listener;
      window.__fireDrag = foreign.fireDrag; listeners.add(foreign.listener);
    } else if (scenario === "existing-undefined-global") {
      window.__fireDrag = undefined;
    }
    const page = vm.createContext({ window,
      DataTransfer: class { constructor() { this.items = { add() {} }; } },
      File: class {}, DragEvent: class {
        constructor(type, options) { this.type = type; Object.assign(this, options); }
      },
    });
    const context = {
      dropPageKey: "owned-key", samePage: () => true,
      exec: async code => vm.runInContext(code, page),
    };
    const dispose = compile(disposeCode, context);
    const setup = vm.runInNewContext("(async () => {" + installCode + "})()", context);
    if (scenario === "owned") {
      await setup;
      assert.equal(window.__securityDrop.ownerKey, "owned-key");
      await dispose();
      check("actual drop page disposal removes only its own keyed installation", () => {
        assert.equal(listeners.size, 0); assert.deepEqual(calls, ["dragend"]);
        for (const key of ["__securityDrop", "__securityDropListener", "__fireDrag"]) {
          assert.equal(Object.hasOwn(window, key), false);
        }
      });
    } else {
      await assert.rejects(setup, /Drop probe already exists/);
      await assert.rejects(dispose(), /lost its owned probe/);
      check("actual drop setup/disposal preserves a collision: " + scenario, () => {
        assert.deepEqual(calls, []);
        if (scenario === "foreign") {
          assert.equal(window.__securityDrop, foreign);
          assert.equal(window.__securityDropListener, foreign.listener);
          assert.equal(window.__fireDrag, foreign.fireDrag);
          assert.equal(listeners.size, 1);
        } else {
          assert.equal(Object.hasOwn(window, "__fireDrag"), true);
          assert.equal(window.__fireDrag, undefined);
        }
      });
    }
  }

  const retirementCode = between("    function requireDroppedAdmissionRetired(",
    "    async function admitDroppedFixture(");
  for (const current of [false, true, null]) {
    const retirement = compile(retirementCode,
      { shutdown: { documentAdmissionIsCurrent: () => current } });
    check("actual dropped-owner retirement requires an explicit Main false: " + current, () => {
      if (current === false) assert.doesNotThrow(() => retirement(owner));
      else assert.throws(() => retirement(owner), /admission did not actually retire/);
    });
  }
  const targetEnd = '    }, "known clean drop target retirement");';
  const targetRetirement = between(targetEnd, "    const sourceBeforeUndo").slice(targetEnd.length);
  const sourceRetirement = between(
    "    await closeSecurityImageFixture(restored, dirty.filePath, dirty.body, dirty.heading);",
    '    check("drop actors retire their exact owners');
  const retired = [], closed = [], lifecycle = ["target-close-completed"];
  await vm.runInNewContext(retirementCode + "\n(async () => {" +
    targetRetirement + sourceRetirement + "})()", {
    target: { descriptor: { ref: "target-ref" } }, restored: { descriptor: { ref: "source-ref" } },
    dirty: fixture, dropBarrier: async () => { lifecycle.push("barrier"); },
    closeSecurityImageFixture: async nextOwner => {
      closed.push(nextOwner.descriptor.ref);
      lifecycle.push("close:" + nextOwner.descriptor.ref);
    },
    shutdown: { documentAdmissionIsCurrent: ref => {
      retired.push(ref); lifecycle.push("retire:" + ref); return false;
    } },
  });
  check("actual consent teardown checks both captured Main refs after target and source close", () => {
    assert.deepEqual(retired, ["target-ref", "source-ref"]);
    assert.deepEqual(closed, ["source-ref"]);
    assert.deepEqual(lifecycle, ["target-close-completed", "barrier", "retire:target-ref",
      "close:source-ref", "barrier", "retire:source-ref"]);
  });

  const ensureCode = between("  const n11EnsureAlive = async (why) => {", "  const n11Click =");
  for (const healthy of [true, false]) {
    const retained = { entries: ["entry"], sends: ["send"], work: ["read"], nav: ["navigation"] };
    const context = {
      n11Healthy: async () => healthy, n11Owner: { id: 11 }, n11Sealed: { entries: 1 },
      n11ReadinessErrors: ["retained readiness diagnostic"], n11Entries: retained.entries,
      n11Sends: retained.sends, n11Work: retained.work, n11Navs: retained.nav, n11Faults: [],
    };
    const ensure = vm.runInNewContext(
      ensureCode + "\nn11EnsureAlive;", context);
    if (healthy) {
      await ensure("healthy");
      check("healthy N11 continuation needs no reload or substitute transport", () =>
        assert.deepEqual(retained, { entries: ["entry"], sends: ["send"],
          work: ["read"], nav: ["navigation"] }));
    } else {
      await assert.rejects(ensure("lost"), error => {
        assert.match(error.message, /N11 continuation refused/);
        assert.match(error.message, /"oldPageHistories":"UNKNOWN"/);
        assert.match(error.message, /retained readiness diagnostic/);
        return true;
      });
      check("lost N11 continuation fails with unknown page evidence and retained Main history", () =>
        assert.deepEqual(retained, { entries: ["entry"], sends: ["send"],
          work: ["read"], nav: ["navigation"] }));
    }
  }

  const healthyCode = between("  async function n11Healthy()", "  async function n11Install()");
  const healthyOwner = { id: 11, identity: { rendererGeneration: 7 }, descriptor: { ref: "ref" },
    pageSession: "page" };
  const healthyContext = {
    n11SamePage: () => true, n11Owner: healthyOwner,
    n11Shutdown: { state: () => ({ renderer: "ready", rendererGeneration: 7,
      rendererPageSession: "page" }), documentAdmissionIsCurrent: () => true },
    exec: async () => 7, readSecurityImageOwner: async () => healthyOwner,
    n11ReadPage: async () => ({ observing: true, sentinel: [] }),
    securityImageOwnerMatches: () => true, isDeepStrictEqual,
    n11ReadFile: () => fixture.body, fs: {}, n11SourcePath: filePath,
    n11FixtureBody: fixture.body, n11Heading: fixture.heading, n11ReadinessErrors: [],
  };
  const healthy = compile(healthyCode, healthyContext);
  const originalHealthy = await healthy();
  check("actual N11 healthy-owner gate accepts its original admitted page", () =>
    assert.equal(originalHealthy, true));
  healthyContext.n11Shutdown.documentAdmissionIsCurrent = () => false;
  assert.equal(await healthy(), false);
  checks++; console.log("PASS actual N11 gate refuses same-page stale admission");
  healthyContext.n11Shutdown.documentAdmissionIsCurrent = () => true;
  healthyContext.securityImageOwnerMatches = () => false;
  assert.equal(await healthy(), false);
  checks++; console.log("PASS actual N11 gate refuses a current-page owner predicate mismatch");
  healthyContext.securityImageOwnerMatches = () => true;
  healthyContext.readSecurityImageOwner = async () => ({ ...healthyOwner, id: 12 });
  assert.equal(await healthy(), false);
  checks++; console.log("PASS actual N11 gate refuses another tab on the same admitted page");
  healthyContext.readSecurityImageOwner = async () => healthyOwner;
  healthyContext.n11SamePage = () => false;
  assert.equal(await healthy(), false);
  checks++; console.log("PASS actual N11 gate refuses a replaced page");
  healthyContext.n11SamePage = () => true;
  healthyContext.readSecurityImageOwner = async () => { throw new Error("owner unreadable"); };
  assert.equal(await healthy(), false);
  check("actual N11 gate retains an unreadable-owner diagnostic", () =>
    assert.deepEqual(healthyContext.n11ReadinessErrors, ["owner unreadable"]));

  const lostCode = between("  async function n11LostResult(", "  const n11EnsureAlive");
  const lost = compile(lostCode, {
    n11Slice: (items, start) => items.slice(start),
    visualUtils: { readShellOpens: async () => ["safe", "actual-open"],
      readExternalOpens: async () => ["actual-external"] }, win: {},
    n11Sends: [{ channel: "external-file-open-request", path: "actual-target" }],
    n11Work: [{ kind: "read", file: "actual-target" }],
    n11Contents: { isDestroyed: () => true }, n11Navs: ["actual-navigation"],
  });
  const report = await lost({ entry: "actual-entry", result: false },
    { shell: 1, external: 0, sends: 0, work: 0, navigation: 0 }, null, new Error("lost page"));
  check("lost N11 report keeps missing page evidence unknown, not empty", () => {
    assert.equal(report.errors, null); assert.equal(report.notifications, null);
    assert.equal(report.clicked.trusted, null); assert.equal(report.clicked.prevented, null);
    assert.equal(report.nav.href, null); assert.equal(report.observationLost, true);
  });
  check("lost N11 report preserves real Main slices and original failure", () => {
    assert.equal(JSON.stringify(report.openPath), '["actual-open"]');
    assert.equal(JSON.stringify(report.external), '["actual-external"]');
    assert.equal(report.offers[0].path, "actual-target");
    assert.equal(report.fileWork[0].file, "actual-target");
    assert.equal(report.nav.mainProcessNavs[0], "actual-navigation");
    assert.equal(report.entry, "actual-entry"); assert.equal(report.failure, "lost page");
  });

  const clickCode = between("  const n11Click = async (text) => {",
    "  try {\n  await n11Install();");
  let pageLost = false, laterCarriers = 0;
  const clickContext = {
    path, n11EnsureAlive: async () => {}, n11NoLate: async () => {},
    n11Owner: healthyOwner, n11Actions: [], n11Active: null, n11Sealed: {
      shell: 1, external: 0, sends: 0, work: 0, navigation: 0,
    },
    n11Slice: (items, start) => items.slice(start),
    visualUtils: { readShellOpens: async () => ["safe", "actual-open"],
      readExternalOpens: async () => ["actual-external"] }, win: {},
    n11Sends: [{ channel: "external-file-open-request", path: "actual-target" }],
    n11Work: [{ kind: "read", file: "actual-target" }], n11Navs: ["actual-navigation"],
    exec: async () => ({ hit: true, width: 10, height: 10, text: "web",
      href: "http://probe.invalid/page", svgAnchor: false }),
    n11Healthy: async () => true, n11SamePage: () => !pageLost, inputs: [], records: [],
    n11Contents: {
      sendInputEvent: event => clickContext.inputs.push(event),
      isDestroyed: () => pageLost, getURL: () => entry.url,
    },
    n11Wait: async () => {
      pageLost = true;
      throw new Error("original page destroyed during click");
    },
    check: (name, passed, details) => clickContext.records.push({ name, passed, details }),
  };
  const lostClick = vm.runInNewContext(lostCode + "\n" + clickCode +
    "\nn11Click;", clickContext);
  await assert.rejects(async () => {
    await lostClick("web");
    laterCarriers++;
    await lostClick("caps");
  }, error => /N11 lost its original page observations/.test(error.message) &&
    error.cause.message === "original page destroyed during click");
  check("actual lost N11 click records failure, throws and prevents later carriers", () => {
    assert.equal(laterCarriers, 0); assert.equal(clickContext.n11Actions.length, 1);
    assert.equal(clickContext.n11Actions[0].pending, false);
    assert.equal(clickContext.n11Active, null); assert.equal(clickContext.inputs.length, 2);
    const failed = clickContext.records.filter(record => !record.passed);
    assert.equal(failed.length, 1);
    const evidence = JSON.parse(failed[0].details);
    assert.equal(evidence.observationLost, true); assert.equal(evidence.errors, null);
    assert.deepEqual(evidence.external, ["actual-external"]);
    assert.equal(evidence.fileWork[0].file, "actual-target");
  });

  const neutral = between('  for (const mode of ["full", "light-format"]) {\n    await render(',
    "  // @@@html still displays");
  const expected = [
    "FEATURE HTML comments preserve their neighboring images (full)",
    "FEATURE unknown-language fences preserve escaped code (full)",
    "FEATURE HTML comments preserve their neighboring images (light-format)",
    "FEATURE unknown-language fences preserve escaped code (light-format)",
  ];
  for (const scenario of ["good", "blank-full-images", "blank-light-images",
    "corrupt-full-second-source", "corrupt-light-second-source", "unescaped-code"]) {
    let mode = null;
    const results = [];
    await vm.runInNewContext("(async () => {" + neutral + "})()", {
      render: async (_body, nextMode) => { mode = nextMode; },
      exec: async code => code.includes("imgCount")
        ? { imgCount: scenario === "blank-" + mode.replace("-format", "") + "-images" ? 0 : 2,
          srcs: ["a.png", scenario === "corrupt-" + mode.replace("-format", "") +
            "-second-source" ? "wrong.png" : "b.png"],
          alts: ["one", "two"], markerText: false }
        : { codeBlock: true, boldInjected: scenario === "unescaped-code", text: "<b>literal code</b>" },
      check: (name, passed) => results.push({ name, passed }),
    });
    const failures = results.filter(result => !result.passed).map(result => result.name);
    check("neutral current-feature oracles discriminate " + scenario, () => {
      assert.deepEqual(results.map(result => result.name), expected);
      assert.deepEqual(failures, scenario === "good" ? [] :
        ["blank-full-images", "corrupt-full-second-source"].includes(scenario) ? [expected[0]] :
        ["blank-light-images", "corrupt-light-second-source"].includes(scenario) ? [expected[2]] :
          [expected[1], expected[3]]);
    });
  }
  console.log("PASS " + checks + "/" + checks +
    " Node-only actor/oracle controls; no Electron, browser or native qualification");
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
