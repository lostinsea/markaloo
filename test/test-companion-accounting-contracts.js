// Node-only startup/accounting controls. No Electron or companion launch.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "test-tab-refresh.js"), "utf8")
  .replace(/\r\n/g, "\n");
const routes = [
  ["./test-reload-transport-contract.js", 13],
  ["./test-owned-transport-contract.js", 19],
  ["./test-shutdown-response-contract.js", 14],
  ["./test-deletion-delivery-contract.js", 8],
];
let passed = 0;

function between(text, start, end) {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, "actual source boundaries must resolve");
  assert.equal(text.indexOf(start, first + start.length), -1, "source start must be unique");
  return text.slice(first, last);
}

const startupSource = between(source, "\nconst results = [];\n",
  "// This is deliberately data-only:");
const startupCalls = between(startupSource,
  "// Direct Electron and companion launches", "// Missing or late startup reports");
const totalsSource = between(source, "const COMPANION_ASSERTION_TOTALS = {",
  "// ONE SPAWNER FOR BOTH COMPANIONS.");
const transcriptSource = between(source, "function summariseCompanionTranscript(text)",
  "const COMPANION_TRANSCRIPT_UNUSABLE_MARKER");
const { summariseCompanionTranscript, reconcileCompanionCompletion } =
  vm.runInNewContext(transcriptSource +
    "\n({ summariseCompanionTranscript, reconcileCompanionCompletion });", {},
  { timeout: 5000 });

function runStartup(text = startupSource, { failRoute, throwRoute } = {}) {
  const order = [];
  const counts = [];
  const late = [];
  const deferred = [];
  const context = {
    console: { log() {} },
    queueMicrotask: callback => deferred.push(callback),
    failStartup: (kind, error) => { throw new Error(kind + ": " + error.message); },
    require: name => {
      assert(routes.some(([route]) => route === name), "only actual contract modules may load");
      const actual = require(path.join(__dirname, name));
      return {
        run: callback => {
          order.push(name);
          if (throwRoute === name) throw new Error("controlled startup exception");
          let count = 0;
          let returned = false;
          const value = actual.run((label, ok, detail) => {
            if (returned) late.push(label);
            count++;
            callback(label, failRoute === name && count === 1 ? false : ok, detail);
          });
          returned = true;
          counts.push(count);
          assert(!value || typeof value.then !== "function", "startup route must finish synchronously");
          return value;
        },
      };
    },
  };
  const observed = vm.runInNewContext(text + "\n({ results, startupContractAssertionCount, " +
    "expected: EXPECTED_STARTUP_CONTRACT_ASSERTIONS, unavailableEvidence });", context,
  { timeout: 10000 });
  assert.deepEqual(order, routes.map(([route]) => route), "actual startup call order");
  assert.deepEqual(counts, routes.map(([, count]) => count), "actual callback cardinality");
  assert.equal(observed.expected, routes.reduce((sum, [, count]) => sum + count, 0));
  assert.equal(observed.startupContractAssertionCount, 54);
  assert.equal(observed.results.length, 54);
  assert(observed.results.every(record => record.ok === true));
  assert.equal(observed.unavailableEvidence, 0);
  assert.equal(deferred.length, 0);
  return { observed, late };
}

function totals(platform, startupCount = 54, currentResults = 54) {
  return vm.runInNewContext(totalsSource + "\nCOMPANION_ASSERTION_TOTALS;", {
    actualHostPlatform: platform,
    startupContractAssertionCount: startupCount,
    results: Array(currentResults).fill({ ok: true }),
  }, { timeout: 5000 });
}

function completion(total, expectedTotal, { failures = 0, unavailable = 0,
  code = failures ? 1 : unavailable ? 2 : 0, tail = "" } = {}) {
  const lines = Array.from({ length: total }, (_, index) =>
    index < failures ? `FAIL  check ${index}  -> controlled failure` : `PASS  check ${index}`);
  for (let index = 0; index < unavailable; index++) {
    lines.push(`UNAVAILABLE  automatic case ${index}  -> actual manual-only boundary`);
  }
  lines.push(`=== ${total - failures}/${total} passed${unavailable ? `; ${unavailable} unavailable` : ""} ===`);
  return reconcileCompanionCompletion({
    code, timedOut: false, error: null, closeObserved: true, expectedTotal,
    transcript: summariseCompanionTranscript(lines.join("\n") + "\n" + tail),
    streamErrors: [],
  });
}

async function control(name, exercise) {
  await exercise();
  passed++;
  console.log("PASS " + name);
}

(async () => {
  await control("actual four startup routes report 13/19/14/8 synchronously before Main", async () => {
    const observed = runStartup();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(observed.late, []);
    assert.equal(observed.observed.results.length, 54);
    assert(source.indexOf(startupSource) + startupSource.length <
      source.indexOf('require("../src/main.js")'));
  });
  await control("each missing or duplicated startup route is rejected", () => {
    for (const [route] of routes) {
      const call = `require("${route}").run(check);`;
      assert.throws(() => runStartup(startupSource.replace(call, "")), /contract inventory/);
      assert.throws(() => runStartup(startupSource.replace(call, call + "\n" + call)),
        /contract inventory/);
    }
  });
  await control("equal-count reordered startup routes cannot satisfy the source integration gate", () => {
    const first = `require("${routes[0][0]}").run(check);`;
    const second = `require("${routes[1][0]}").run(check);`;
    const reordered = startupSource.replace(first, "__FIRST_CALL__")
      .replace(second, first).replace("__FIRST_CALL__", second);
    assert.throws(() => runStartup(reordered), /actual startup call order/);
  });
  await control("unexecuted and deferred startup routes cannot enter a smaller baseline", () => {
    for (const deferred of [`if (false) {\n${startupCalls}\n}`,
      `queueMicrotask(() => {\n${startupCalls}\n});`]) {
      assert.throws(() => runStartup(startupSource.replace(startupCalls, deferred)), /contract inventory/);
    }
  });
  await control("false startup reports and thrown routes fail before the snapshot is used", () => {
    for (const [route] of routes) {
      assert.throws(() => runStartup(startupSource, { failRoute: route }), /contract inventory/);
      assert.throws(() => runStartup(startupSource, { throwRoute: route }),
        /controlled startup exception/);
    }
  });
  await control("actual platform matrices retain D's independently derived branch addends", () => {
    for (const platform of ["win32", "linux", "darwin"]) {
      const expected = platform === "darwin" ? [61, 63, 61, 61, 61] : [64, 63, 63, 62, 62];
      const actual = totals(platform);
      for (const [index, kind] of ["queued", "commit", "pending", "continuation", "poisoned"].entries()) {
        assert.equal(actual.teardown[kind], expected[index], platform + "/" + kind);
      }
      assert.equal(actual.portable, 47, "portable accounting is outside this repair");
    }
  });
  await control("actual reconciler accepts supported totals and rejects either adjacent total", () => {
    for (const platform of ["win32", "linux"]) {
      for (const expected of Object.values(totals(platform).teardown)) {
        assert.equal(completion(expected, expected).kind, "passed");
        assert.equal(completion(expected - 1, expected).kind, "invalid");
        assert.equal(completion(expected + 1, expected).kind, "invalid");
      }
    }
  });
  await control("Darwin automatic cases remain unavailable, never an exit-zero scenario pass", () => {
    const expected = totals("darwin").teardown;
    for (const kind of ["queued", "pending", "continuation", "poisoned"]) {
      assert.equal(completion(expected[kind], expected[kind], { unavailable: 1 }).kind, "unavailable");
      assert.equal(completion(expected[kind], expected[kind], { unavailable: 1, code: 0 }).kind, "invalid");
    }
    assert.equal(completion(expected.commit, expected.commit).kind, "passed");
  });
  await control("a false startup result retains failure priority over unavailable", () => {
    for (const unavailable of [0, 1]) {
      assert.equal(completion(61, 61, { failures: 1, unavailable }).kind, "failed");
      assert.equal(completion(61, 61, { failures: 1, unavailable, code: 0 }).kind, "invalid");
    }
  });
  await control("common-mode missing startup is rejected instead of shrinking parent and child", () => {
    assert.equal(completion(56, 56).kind, "passed", "unguarded dynamic expectation is vulnerable");
    const deletion = `require("${routes[3][0]}").run(check);`;
    assert.throws(() => runStartup(startupSource.replace(deletion, "")), /contract inventory/);
    assert.equal(completion(56, totals("win32").teardown.queued).kind, "invalid");
  });
  await control("late extra reports cannot move the frozen startup expectation", () => {
    const expected = totals("win32", runStartup().observed.startupContractAssertionCount, 55);
    assert.equal(expected.teardown.queued, 64);
    assert.equal(completion(65, expected.teardown.queued).kind, "invalid");
  });
  await control("post-footer reports remain invalid under the actual parser and reconciler", () => {
    assert.equal(completion(64, 64, { tail: "PASS  late report\n" }).kind, "invalid");
  });
  assert.equal(passed, 12, "complete source-control inventory");
  console.log("12/12 companion accounting source controls; actual modules/VM only, native NOT RUN");
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
