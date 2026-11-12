"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const {
  observeLocalStorageRead,
  probeDisposableLocalStorage,
  validateInitialLocalStorageHistograms,
  validateLocalStorageHistograms: validateFinalHistograms,
  validatePersistedSettings,
  verifyLevelDbPreconditions,
  verifySupportedLocalStorage,
} = require("../src/profile-migration-probe");

const prefix = "Storage.LocalStorage.";
const probePath = path.resolve(__dirname, "..", "src", "profile-migration-probe.html");
const appUrl = pathToFileURL(probePath).href;
const storageKey = "file:///";
function histogram(operation, values = [0]) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return {
    name: prefix + operation, count: values.length,
    sum: values.reduce((sum, value) => sum + value, 0),
    buckets: [...counts].sort(([a], [b]) => a - b).map(([low, count]) => ({
      low, high: low + 1, count,
    })),
  };
}
function initialHistograms() {
  const duration = histogram("Duration.OpenDatabase2.OnDisk", [12]);
  duration.buckets[0].high = 14;
  return { histograms: [
    histogram("OpenDatabase.OnDisk"), duration,
    histogram("ReadAllMetadata.OnDisk"), histogram("Duration.ReadAllMetadata.OnDisk"),
  ] };
}
function goodHistograms() {
  // The six-entry final shape is source-derived, not yet observed natively.
  return { histograms: [...initialHistograms().histograms,
    histogram("ReadMapKeyValues.OnDisk"), histogram("Duration.ReadMapKeyValues.OnDisk", [27]),
  ] };
}
function validateLocalStorageHistograms(response, initial = { histograms: [] }) {
  return validateFinalHistograms(response, initial);
}
function settings() {
  return [
    ["themeMode", "desktop"], ["darkMode", "enabled"],
    ["themeLightScheme", "parchment"], ["themeDarkScheme", "abyss"],
    ["readingZoom", "120"], ["notesVisible", "hidden"],
    ["editorSplitRatio", "0.35"], ["readingSidePanel", "toc"],
    ["recentFiles", JSON.stringify([{ path: "C:\\docs\\a.md", name: "a.md", timestamp: 12 }])],
    ["openTabs", JSON.stringify([{
      filePath: "C:\\docs\\a.md", scrollPosition: 42,
      anchor: { scrollTop: 42, text: "Heading", ordinal: 1, delta: -2 },
    }])],
    ["activeTabPath", "C:\\docs\\a.md"], ["unrecognized-old-key", "preserve exactly"],
  ];
}
function ownedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "markaloo-probe-test-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  return root;
}
function supportedStore(root) {
  const directory = path.join(root, "Local Storage", "leveldb");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "CURRENT"), "MANIFEST-000001\n");
  fs.writeFileSync(path.join(directory, "MANIFEST-000001"), "unparsed owned fixture");
}
function fakeTarget(directory, options = {}) {
  const calls = [];
  const target = new EventEmitter();
  const debuggerApi = new EventEmitter();
  let attached = false;
  let reads = 0;
  let loaded = false;
  debuggerApi.isAttached = () => attached;
  debuggerApi.attach = version => {
    calls.push(["attach", version]);
    if (options.attachError) throw options.attachError;
    attached = true;
  };
  debuggerApi.detach = () => {
    calls.push(["detach"]);
    attached = false;
    if (options.cleanupError) throw options.cleanupError;
    debuggerApi.emit("detach", {}, "target closed");
  };
  debuggerApi.sendCommand = async (command, params) => {
    calls.push([command, params]);
    if (options.commandError) throw options.commandError;
    if (command === "Browser.getHistograms") {
      assert.deepEqual(params, { query: prefix, delta: false });
      return reads === 0 ? (options.before || { histograms: [] })
        : (options.after || goodHistograms());
    }
    if (command === "Page.getFrameTree") {
      return options.frameTree || {
        frameTree: { frame: { id: "main", url: appUrl, securityOrigin: "file://" } },
      };
    }
    if (command === "Storage.getStorageKey") {
      assert.deepEqual(params, { frameId: "main" });
      return { storageKey: options.actualKey || storageKey };
    }
    assert.equal(command, "DOMStorage.getDOMStorageItems");
    assert.deepEqual(params, {
      storageId: { storageKey, isLocalStorage: true },
    });
    reads++;
    if (options.duringRead) return options.duringRead(target, debuggerApi);
    if (options.readError) throw options.readError;
    if (options.afterRead) options.afterRead();
    return { entries: options.entries || settings() };
  };
  target.debugger = debuggerApi;
  target.session = { getStoragePath: () => options.storagePath || directory };
  target.isDestroyed = () => false;
  target.getURL = () => loaded ? (options.url || appUrl) : "";
  target.getLastWebPreferences = () => options.preferences || ({
    javascript: false, nodeIntegration: false, contextIsolation: true, sandbox: true,
  });
  target.probeWindow = {
    webContents: target,
    loadFile: async filename => {
      calls.push(["loadFile", filename]);
      assert.equal(filename, probePath);
      target.emit("did-start-navigation", {}, appUrl, false, true);
      if (options.loadError) throw options.loadError;
      if (options.duringLoad) await options.duringLoad();
      loaded = true;
    },
  };
  return { target, calls };
}
function observe(target, directory, options = {}) {
  return observeLocalStorageRead({
    probeWindow: target.probeWindow, expectedStoragePath: directory, ...options,
  });
}

test("bounded on-disk evidence counts buckets and preserves the full settings map", () => {
  assert.deepEqual(validateLocalStorageHistograms(goodHistograms()),
    { openCount: 1, readCount: 1 });
  const entries = settings();
  assert.deepEqual(validatePersistedSettings(entries), entries);
  assert.notEqual(validatePersistedSettings(entries), entries);
  assert.deepEqual(validateInitialLocalStorageHistograms({ histograms: [] }),
    { histograms: [] });
});

test("empty, observed and independently partial initialization admit one final map read", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  const initial = initialHistograms().histograms;
  const cases = [[], initial, ...initial.map(item => [item]),
    initial.map(item => histogram(item.name.slice(prefix.length), []))];
  for (const histograms of cases) {
    const before = { histograms: structuredClone(histograms) };
    const after = goodHistograms();
    after.histograms.reverse();
    const snapshot = validateInitialLocalStorageHistograms(before);
    assert.deepEqual(validateLocalStorageHistograms(after, snapshot),
      { openCount: 1, readCount: 1 });
    const { target, calls } = fakeTarget(root, { before, after });
    assert.equal((await observe(target, root)).readCount, 1);
    assert.equal(calls.filter(call => call[0] === "loadFile").length, 1);
    assert.equal(calls.filter(call => call[0] === "Browser.getHistograms").length, 2);
  }
});

test("duration evidence accepts the observed coarse bucket and other nonnegative timings", () => {
  for (const [sum, low, high] of [[12, 12, 14], [135, 128, 144]]) {
    const before = initialHistograms();
    before.histograms[1] = {
      name: prefix + "Duration.OpenDatabase2.OnDisk",
      count: 1, sum, buckets: [{ low, high, count: 1 }],
    };
    const after = goodHistograms();
    after.histograms[1] = structuredClone(before.histograms[1]);
    assert.deepEqual(validateLocalStorageHistograms(after,
      validateInitialLocalStorageHistograms(before)), { openCount: 1, readCount: 1 });
  }
});

test("initial stale, failed, recovery, write and unknown evidence refuses before loadFile", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  const cases = [
    ["ReadMapKeyValues.OnDisk", [0], "ERR_PROBE_NOT_FRESH"],
    ["Duration.ReadMapKeyValues.OnDisk", [0], "ERR_PROBE_NOT_FRESH"],
    ["OpenDatabase.OnDisk", [0, 0], "ERR_PROBE_NOT_FRESH"],
    ["ReadAllMetadata.OnDisk", [0, 0], "ERR_PROBE_NOT_FRESH"],
    ["Duration.OpenDatabase2.OnDisk", [1, 1], "ERR_PROBE_NOT_FRESH"],
    ["Duration.ReadAllMetadata.OnDisk", [1, 1], "ERR_PROBE_NOT_FRESH"],
    ["OpenDatabase.OnDisk", [2], "ERR_PROBE_DATABASE_STATUS"],
    ["ReadAllMetadata.OnDisk", [2], "ERR_PROBE_DATABASE_STATUS"],
    ["Recovery.OpenFailure", [0], "ERR_PROBE_RECOVERY"],
    ["DestroyDatabase.OnDisk", [0], "ERR_PROBE_RECOVERY"],
    ["CommitErrorCountAtReset", [0], "ERR_PROBE_RECOVERY"],
    ["Duration.OpenDatabase2.InMemory", [0], "ERR_PROBE_IN_MEMORY"],
    ["PutMetadata.OnDisk", [0], "ERR_PROBE_NOT_FRESH"],
    ["DeleteSessions.OnDisk", [0], "ERR_PROBE_NOT_FRESH"],
    ["CleanUpStaleData.OnDisk", [0], "ERR_PROBE_NOT_FRESH"],
    ["NewOperation.OnDisk", [0], "ERR_PROBE_HISTOGRAM_API"],
    ["Duration.NewOperation.OnDisk", [0], "ERR_PROBE_NOT_FRESH"],
    ["UnknownCounter", [0], "ERR_PROBE_HISTOGRAM_API"],
    ["Duration.OpenDatabase2.OnDisk", [-1], "ERR_PROBE_HISTOGRAM_API"],
  ];
  for (const [operation, values, code] of cases) {
    const before = { histograms: [histogram(operation, values)] };
    assert.throws(() => validateInitialLocalStorageHistograms(before), { code }, operation);
    const { target, calls } = fakeTarget(root, { before });
    await assert.rejects(observe(target, root), { code }, operation);
    assert.deepEqual(calls.map(call => call[0]),
      ["attach", "Browser.getHistograms", "detach"], operation);
  }
});

test("all six final statuses and durations are required exactly once", () => {
  const expected = goodHistograms().histograms;
  for (let index = 0; index < expected.length; index++) {
    for (const replacement of [null, [], [0, 0]]) {
      const after = goodHistograms();
      const operation = expected[index].name.slice(prefix.length);
      if (replacement === null) after.histograms.splice(index, 1);
      else after.histograms[index] = histogram(operation, replacement);
      assert.throws(() => validateLocalStorageHistograms(after),
        { code: "ERR_PROBE_MISSING_EVIDENCE" }, `${operation}: ${replacement}`);
    }
  }
});

test("successful unrelated operations and unknown positive telemetry cannot supplement final evidence", () => {
  for (const operation of [
    "PutMetadata.OnDisk", "CloneMap.OnDisk", "DeleteStorageKeysFromSession.OnDisk",
    "DeleteSessions.OnDisk", "PurgeOrigins.OnDisk", "CleanUpStaleData.OnDisk",
    "UpdateMaps.OnDisk", "Duration.PutMetadata.OnDisk",
    "Duration.NewOperation.OnDisk", "UnknownCounter",
  ]) {
    const after = goodHistograms();
    after.histograms.push(histogram(operation));
    assert.throws(() => validateLocalStorageHistograms(after),
      { code: "ERR_PROBE_HISTOGRAM_API" }, operation);
  }
  for (const operation of [
    "Duration.OpenDatabase2.OnDisk", "Duration.ReadAllMetadata.OnDisk",
    "Duration.ReadMapKeyValues.OnDisk",
  ]) {
    const after = goodHistograms();
    after.histograms = after.histograms.filter(item => item.name !== prefix + operation);
    after.histograms.push(histogram(operation, [-1]));
    assert.throws(() => validateLocalStorageHistograms(after),
      { code: "ERR_PROBE_HISTOGRAM_API" }, operation);
  }
});

test("zero-count names are allowed but every returned entry still needs a valid shape", () => {
  const zero = histogram("UnknownCounter", []);
  const before = { histograms: [...initialHistograms().histograms, zero] };
  const after = goodHistograms();
  after.histograms.push(structuredClone(zero));
  assert.deepEqual(validateLocalStorageHistograms(after,
    validateInitialLocalStorageHistograms(before)), { openCount: 1, readCount: 1 });
  for (const mutate of [
    item => { item.sum = 1; },
    item => { item.buckets = null; },
    item => { item.buckets = [{ low: 0, high: 1, count: 0 }]; },
    item => { item.count = 0.5; },
    item => { item.name = "Storage.SessionStorage.UnknownCounter"; },
  ]) {
    const invalid = structuredClone(zero);
    mutate(invalid);
    assert.throws(() => validateInitialLocalStorageHistograms({ histograms: [invalid] }),
      { code: "ERR_PROBE_HISTOGRAM_API" });
    assert.throws(() => validateLocalStorageHistograms({
      histograms: [...goodHistograms().histograms, invalid],
    }), { code: "ERR_PROBE_HISTOGRAM_API" });
  }
  assert.throws(() => validateInitialLocalStorageHistograms({ histograms: [zero, zero] }),
    { code: "ERR_PROBE_HISTOGRAM_API" });
  assert.throws(() => validateLocalStorageHistograms({
    histograms: [...goodHistograms().histograms, zero, zero],
  }), { code: "ERR_PROBE_HISTOGRAM_API" });
});

test("initial evidence is normalized, immutable and independent of CDP response objects", () => {
  const before = initialHistograms();
  const saved = structuredClone(before);
  const snapshot = validateInitialLocalStorageHistograms(before);
  const reversed = { histograms: [...saved.histograms].reverse() };
  assert.deepEqual(snapshot, validateInitialLocalStorageHistograms(reversed));
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.histograms));
  for (const item of snapshot.histograms) {
    const original = before.histograms.find(histogram => histogram.name === item.name);
    assert.notEqual(item, original);
    assert.notEqual(item.buckets, original.buckets);
    assert.ok(Object.isFrozen(item));
    assert.ok(Object.isFrozen(item.buckets));
    assert.notEqual(item.buckets[0], original.buckets[0]);
    assert.ok(Object.isFrozen(item.buckets[0]));
  }
  before.histograms[1].sum = 13;
  before.histograms[1].buckets[0].high = 15;
  assert.deepEqual(snapshot, validateInitialLocalStorageHistograms(saved));
  const snapshotBytes = JSON.stringify(snapshot);
  assert.deepEqual(validateLocalStorageHistograms(goodHistograms(), snapshot),
    { openCount: 1, readCount: 1 });
  assert.equal(JSON.stringify(snapshot), snapshotBytes);
  assert.throws(() => { snapshot.histograms[0].buckets[0].count = 2; }, TypeError);
  assert.throws(() => validateFinalHistograms(goodHistograms()),
    { code: "ERR_PROBE_HISTOGRAM_API" });
});

test("positive initial samples cannot disappear, decrease or change their sum or bucket", () => {
  const initial = validateInitialLocalStorageHistograms(initialHistograms());
  for (const [mutate, code] of [
    [response => { response.histograms.splice(1, 1); }, "ERR_PROBE_MISSING_EVIDENCE"],
    [response => {
      response.histograms[1] = histogram("Duration.OpenDatabase2.OnDisk", []);
    }, "ERR_PROBE_MISSING_EVIDENCE"],
    [response => { response.histograms[1].sum = 13; }, "ERR_PROBE_HISTOGRAM_API"],
    [response => { response.histograms[1].buckets[0].low = 11; }, "ERR_PROBE_HISTOGRAM_API"],
    [response => { response.histograms[1].buckets[0].high = 15; }, "ERR_PROBE_HISTOGRAM_API"],
  ]) {
    const after = goodHistograms();
    mutate(after);
    assert.throws(() => validateLocalStorageHistograms(after, initial), { code });
  }
});

test("observer carries its independent initial snapshot across load and map enumeration", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  const before = initialHistograms();
  const after = goodHistograms();
  const { target, calls } = fakeTarget(root, {
    before, after,
    duringLoad: () => {
      before.histograms[1].sum = 13;
      after.histograms[1].sum = 13;
    },
  });
  await assert.rejects(observe(target, root), { code: "ERR_PROBE_HISTOGRAM_API" });
  assert.equal(calls.filter(call => call[0] === "loadFile").length, 1);
  assert.equal(calls.filter(call => call[0] === "DOMStorage.getDOMStorageItems").length, 1);
  assert.equal(calls.filter(call => call[0] === "Browser.getHistograms").length, 2);
  assert.equal(calls.at(-1)[0], "detach");
});

test("histogram admission rejects missing positive evidence and nonexclusive opens", () => {
  for (const response of [
    { histograms: [] },
    { histograms: [histogram("OpenDatabase.OnDisk")] },
    { histograms: [histogram("ReadMapKeyValues.OnDisk")] },
    { histograms: [histogram("OpenDatabase.OnDisk", [0, 0]),
      histogram("ReadMapKeyValues.OnDisk")] },
  ]) assert.throws(() => validateLocalStorageHistograms(response),
    { code: "ERR_PROBE_MISSING_EVIDENCE" });
});

test("zero-valued recovery/destroy/reset observations cannot masquerade as success", () => {
  for (const operation of [
    "Recovery.OpenFailure", "Recovery.MetadataReadFailure",
    "Recovery.CommitErrorThresholdExceeded", "Recovery.OpenFailure.InMemory",
    "DestroyDatabase.OnDisk", "CommitErrorCountAtReset",
  ]) {
    const response = goodHistograms();
    response.histograms.push(histogram(operation));
    assert.throws(() => validateLocalStorageHistograms(response),
      { code: "ERR_PROBE_RECOVERY" });
  }
});

test("in-memory fallback, nonzero statuses and unknown database operations are rejected", () => {
  for (const operation of ["OpenDatabase.InMemory", "ReadMapKeyValues.InMemory"]) {
    const response = goodHistograms();
    response.histograms.push(histogram(operation));
    assert.throws(() => validateLocalStorageHistograms(response),
      { code: "ERR_PROBE_IN_MEMORY" });
  }
  for (const operation of ["OpenDatabase", "ReadMapKeyValues", "ReadAllMetadata",
    "PutMetadata", "CloneMap", "DeleteStorageKeysFromSession", "DeleteSessions",
    "PurgeOrigins", "CleanUpStaleData", "UpdateMaps"]) {
    const response = goodHistograms();
    response.histograms = response.histograms.filter(item =>
      item.name !== `${prefix}${operation}.OnDisk`);
    response.histograms.push(histogram(`${operation}.OnDisk`, [0, 2]));
    assert.throws(() => validateLocalStorageHistograms(response),
      { code: "ERR_PROBE_DATABASE_STATUS" });
  }
  const unknown = goodHistograms();
  unknown.histograms.push(histogram("NewOperation.OnDisk"));
  assert.throws(() => validateLocalStorageHistograms(unknown),
    { code: "ERR_PROBE_HISTOGRAM_API" });
});

test("histogram shapes, totals, ranges, duplicates and sums are checked independently", () => {
  const mutations = [
    item => { item.count++; },
    item => { item.sum = 1; },
    item => { item.buckets[0].count = 0; },
    item => { item.buckets[0].high = 0; },
    item => { item.buckets.push({ ...item.buckets[0] }); item.count++; },
    item => { item.count = 0.5; },
    item => { item.buckets = null; },
    item => { item.name = "Storage.SessionStorage.OpenDatabase.OnDisk"; },
  ];
  for (const mutate of mutations) {
    const response = goodHistograms();
    mutate(response.histograms[0]);
    assert.throws(() => validateLocalStorageHistograms(response),
      { code: "ERR_PROBE_HISTOGRAM_API" });
  }
  const duplicate = goodHistograms();
  duplicate.histograms.push(duplicate.histograms[0]);
  assert.throws(() => validateLocalStorageHistograms(duplicate),
    { code: "ERR_PROBE_HISTOGRAM_API" });
  const coarse = goodHistograms();
  coarse.histograms[0].buckets[0].high = 2;
  assert.throws(() => validateLocalStorageHistograms(coarse),
    { code: "ERR_PROBE_DATABASE_STATUS" });
  assert.throws(() => validateInitialLocalStorageHistograms(goodHistograms()),
    { code: "ERR_PROBE_NOT_FRESH" });
  assert.throws(() => validateLocalStorageHistograms({}),
    { code: "ERR_PROBE_HISTOGRAM_API" });
});

test("known settings reject invalid domains instead of adopting application defaults", () => {
  const bad = [
    ["themeMode", "automatic"], ["darkMode", "true"],
    ["themeLightScheme", ""], ["themeDarkScheme", ""],
    ["readingZoom", " 120 "], ["readingZoom", "55"],
    ["readingZoom", "Infinity"], ["readingZoom", "500"],
    ["notesVisible", "false"], ["readingSidePanel", "sidebar"],
    ["editorSplitRatio", "Infinity"], ["editorSplitRatio", ""],
    ["recentFiles", "{"], ["recentFiles", "{}"],
    ["recentFiles", '[{"path":"relative.md","name":"relative.md","timestamp":1}]'],
    ["openTabs", "null"], ["openTabs", '[{"filePath":"relative.md"}]'],
    ["openTabs", '[{"filePath":"C:\\\\a.md","scrollPosition":-1}]'],
    ["openTabs", '[{"filePath":"C:\\\\a.md","anchor":{}}]'],
    ["activeTabPath", "relative.md"],
  ];
  for (const [key, value] of bad) {
    const entries = settings().filter(entry => entry[0] !== key);
    entries.push([key, value]);
    assert.throws(() => validatePersistedSettings(entries),
      { code: "ERR_PROBE_SETTINGS" }, key);
  }
  assert.throws(() => validatePersistedSettings([]), { code: "ERR_PROBE_EMPTY_SETTINGS" });
  assert.throws(() => validatePersistedSettings([["other", "value"]]),
    { code: "ERR_PROBE_EMPTY_SETTINGS" });
  assert.throws(() => validatePersistedSettings([["themeMode", "dark"], ["themeMode", "light"]]),
    { code: "ERR_PROBE_SETTINGS" });
  assert.throws(() => validatePersistedSettings([["themeMode", null]]),
    { code: "ERR_PROBE_SETTINGS" });
});

test("legacy supported values retain fallback semantics and optional tab fields", () => {
  const entries = [
    ["themeLightScheme", "withdrawn-scheme"], ["editorSplitRatio", "1.5"],
    ["openTabs", '[{"filePath":"C:\\\\a.md"}]'], ["activeTabPath", ""],
    ["recentFiles", "[]"],
  ];
  assert.deepEqual(validatePersistedSettings(entries), entries);
  for (const key of ["openTabs", "recentFiles"]) {
    const entries = settings().filter(entry => entry[0] !== key);
    const length = key === "openTabs" ? 513 : 101;
    entries.push([key, JSON.stringify(Array.from({ length }, () => ({
      filePath: "C:\\a.md", path: "C:\\a.md", name: "a.md", timestamp: 1,
    })))]);
    assert.throws(() => validatePersistedSettings(entries), { code: "ERR_PROBE_SETTINGS" });
  }
});

test("LevelDB preconditions require CURRENT's existing regular manifest and reject rebuilds", t => {
  const root = ownedFixture(t);
  const directory = path.join(root, "leveldb");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "CURRENT"), "MANIFEST-000001\n");
  fs.writeFileSync(path.join(directory, "MANIFEST-000001"), "owned fixture, not a parsed database");
  assert.deepEqual(verifyLevelDbPreconditions(directory), {
    status: "preconditions-checked", backend: "leveldb", manifestName: "MANIFEST-000001",
  });
  fs.mkdirSync(`${directory}__tmp_for_rebuild`);
  assert.throws(() => verifyLevelDbPreconditions(directory), { code: "ERR_PROBE_REBUILD" });
  fs.rmdirSync(`${directory}__tmp_for_rebuild`);
  for (const current of ["", "../MANIFEST-000001\n", "MANIFEST-000002\nextra", "MANIFEST-1\r\n"]) {
    fs.writeFileSync(path.join(directory, "CURRENT"), current);
    assert.throws(() => verifyLevelDbPreconditions(directory), { code: "ERR_PROBE_CURRENT" });
  }
  fs.writeFileSync(path.join(directory, "CURRENT"), "MANIFEST-000002\n");
  assert.throws(() => verifyLevelDbPreconditions(directory), { code: "ENOENT" });
  fs.mkdirSync(path.join(directory, "MANIFEST-000002"));
  assert.throws(() => verifyLevelDbPreconditions(directory), { code: "ERR_PROBE_CURRENT" });
});

test("LevelDB directory redirection is refused before a database could be opened", t => {
  const root = ownedFixture(t);
  const directory = path.join(root, "physical");
  const link = path.join(root, "link");
  fs.mkdirSync(directory);
  fs.symlinkSync(directory, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => verifyLevelDbPreconditions(link), { code: "ERR_PROBE_DIRECTORY" });
});

test("CURRENT and manifest cannot be empty files or redirected directories", t => {
  const root = ownedFixture(t);
  const directory = path.join(root, "leveldb");
  fs.mkdirSync(directory);
  const current = path.join(directory, "CURRENT");
  const manifest = path.join(directory, "MANIFEST-000001");
  fs.writeFileSync(current, "MANIFEST-000001\n");
  fs.writeFileSync(manifest, "");
  assert.throws(() => verifyLevelDbPreconditions(directory), { code: "ERR_PROBE_CURRENT" });
  fs.unlinkSync(manifest);
  const other = path.join(root, "other-manifest");
  fs.mkdirSync(other);
  fs.symlinkSync(other, manifest, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => verifyLevelDbPreconditions(directory), { code: "ERR_PROBE_CURRENT" });
  fs.unlinkSync(current);
  fs.symlinkSync(other, current, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => verifyLevelDbPreconditions(directory), { code: "ERR_PROBE_CURRENT" });
});

test("observer attaches before access, awaits full-map read, queries counts and detaches", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  const { target, calls } = fakeTarget(root);
  const result = await observe(target, root);
  assert.deepEqual(result, {
    status: "observed", storageKey, settings: settings(), openCount: 1, readCount: 1,
  });
  assert.deepEqual(calls.map(call => call[0]),
    ["attach", "Browser.getHistograms", "loadFile", "Page.getFrameTree",
      "Storage.getStorageKey", "DOMStorage.getDOMStorageItems",
      "Storage.getStorageKey", "Browser.getHistograms", "detach"]);
  assert.equal(target.listenerCount("did-start-navigation"), 0);
  assert.equal(target.debugger.listenerCount("detach"), 0);
});

test("wrong storage, wrong document and stale histograms never reach settings access", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  for (const options of [{ storagePath: root + "-other" }, { url: "about:blank" },
    { before: goodHistograms() }]) {
    const { target, calls } = fakeTarget(root, options);
    await assert.rejects(observe(target, root), {
      code: options.before ? "ERR_PROBE_NOT_FRESH" : "ERR_PROBE_TARGET",
    });
    assert.equal(calls.some(call => call[0] === "DOMStorage.getDOMStorageItems"), false);
  }
});

test("read failures, API failures and empty settings do not return success", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  for (const options of [
    { attachError: new Error("attach failure") },
    { commandError: new Error("unsupported command") },
    { loadError: new Error("navigation failure") },
    { readError: new Error("evaluation failure") },
    { entries: [] },
    { after: { histograms: [] } },
  ]) {
    const { target } = fakeTarget(root, options);
    await assert.rejects(observe(target, root));
  }
});

test("debugger detach/navigation/renderer loss interrupt read and prohibit later commands", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  for (const event of ["detach", "did-start-navigation", "render-process-gone", "destroyed"]) {
    let finishRead;
    const { target, calls } = fakeTarget(root, {
      duringRead: (contents, debuggerApi) => new Promise(resolve => {
        finishRead = resolve;
        if (event === "detach") debuggerApi.emit(event, {}, "external detach");
        else contents.emit(event);
      }),
    });
    await assert.rejects(observe(target, root), {
      code: event === "detach" ? "ERR_PROBE_DETACHED"
        : event === "did-start-navigation" ? "ERR_PROBE_NAVIGATION" : "ERR_PROBE_TARGET",
    });
    finishRead({ entries: settings() });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.filter(call => call[0] === "Browser.getHistograms").length, 1);
  }
});

test("bounded timeout rejects a hung read and suppresses late follow-up work", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  let finishRead;
  const { target, calls } = fakeTarget(root, {
    duringRead: () => new Promise(resolve => { finishRead = resolve; }),
  });
  await assert.rejects(observe(target, root, { timeoutMs: 10 }), { code: "ERR_PROBE_TIMEOUT" });
  finishRead({ entries: settings() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call[0] === "Browser.getHistograms").length, 1);
  assert.equal(calls.at(-1)[0], "detach");
});

test("navigation timeout and failed cleanup never become an observed result", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  let finishLoad;
  const hung = fakeTarget(root, {
    duringLoad: () => new Promise(resolve => { finishLoad = resolve; }),
  });
  await assert.rejects(observe(hung.target, root, { timeoutMs: 10 }),
    { code: "ERR_PROBE_TIMEOUT" });
  finishLoad();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hung.calls.some(call => call[0] === "Page.getFrameTree"), false);
  const cleanup = new Error("detach after a successful read failed");
  const failed = fakeTarget(root, { cleanupError: cleanup });
  await assert.rejects(observe(failed.target, root), error => error === cleanup);
});

test("cleanup errors retain both the original failure and cleanup failure", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  const first = new Error("read failure");
  const second = new Error("detach failure");
  const { target } = fakeTarget(root, { readError: first, cleanupError: second });
  await assert.rejects(observe(target, root), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [first, second]);
    return true;
  });
});

test("frame storage-key binding rejects wrong keys even with otherwise perfect metrics", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  for (const options of [
    { actualKey: "https://wrong.example" },
    { actualKey: "file://" },
    { actualKey: "file:///#nonce" },
    { frameTree: { frameTree: { frame: { id: "main", url: "about:blank" } } } },
    { frameTree: { frameTree: { frame: { id: "main", url: appUrl }, childFrames: [{}] } } },
    { frameTree: { frameTree: { frame: {
      id: "main", url: appUrl, securityOrigin: "null",
    } } } },
    { frameTree: { frameTree: { frame: {
      id: "main", url: appUrl, securityOrigin: "file://", unreachableUrl: appUrl,
    } } } },
  ]) {
    const { target, calls } = fakeTarget(root, options);
    await assert.rejects(observe(target, root), { code: "ERR_PROBE_ORIGIN" });
    assert.equal(calls.some(call => call[0] === "DOMStorage.getDOMStorageItems"), false);
  }
});

test("the frame key and physical storage binding are checked again after enumeration", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  for (const change of ["storage-key", "storage-path"]) {
    const fixture = fakeTarget(root, {
      duringRead: contents => {
        if (change === "storage-path") {
          contents.session.getStoragePath = () => root + "-changed";
        } else {
          const send = contents.debugger.sendCommand;
          contents.debugger.sendCommand = (command, params) =>
            command === "Storage.getStorageKey" ? { storageKey: "file://" } : send(command, params);
        }
        return { entries: settings() };
      },
    });
    await assert.rejects(observe(fixture.target, root), {
      code: change === "storage-key" ? "ERR_PROBE_ORIGIN" : "ERR_PROBE_TARGET",
    });
    assert.equal(fixture.calls.filter(call => call[0] === "Browser.getHistograms").length, 1);
  }
});

test("a normal scripted/preloaded window is not an admitted probe target", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  for (const changes of [
    { javascript: true }, { preload: "normal-preload.js" },
    { nodeIntegration: true }, { sandbox: false }, { contextIsolation: false },
  ]) {
    const preferences = {
      javascript: false, nodeIntegration: false, sandbox: true, contextIsolation: true, ...changes,
    };
    const { target, calls } = fakeTarget(root, { preferences });
    await assert.rejects(observe(target, root), { code: "ERR_PROBE_TARGET" });
    assert.equal(calls.length, 0);
  }
});

test("SQLite, coexistence and sidecar-only stores are unsupported, not missing LevelDB", t => {
  const root = ownedFixture(t);
  supportedStore(root);
  for (const name of ["LocalStorage", "LocalStorage-wal", "LocalStorage-shm", "LocalStorage-journal"]) {
    const filename = path.join(root, name);
    fs.writeFileSync(filename, "owned unsupported fixture");
    assert.throws(() => verifySupportedLocalStorage(root),
      { code: "ERR_PROBE_UNSUPPORTED_SQLITE" });
    fs.unlinkSync(filename);
  }
  for (const name of ["file__0.localstorage", "file__0.localstorage-journal", "storage.sqlite"]) {
    const filename = path.join(root, "Local Storage", name);
    fs.writeFileSync(filename, "owned unsupported fixture");
    assert.throws(() => verifySupportedLocalStorage(root),
      { code: "ERR_PROBE_UNSUPPORTED_SQLITE" });
    fs.unlinkSync(filename);
  }
  const sqliteOnly = path.join(root, "sqlite-only");
  fs.mkdirSync(sqliteOnly);
  fs.writeFileSync(path.join(sqliteOnly, "LocalStorage"), "owned SQLite-only fixture");
  assert.throws(() => verifySupportedLocalStorage(sqliteOnly),
    { code: "ERR_PROBE_UNSUPPORTED_SQLITE" });
});

test("a backend created by Chromium during the disposable read cannot pass", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  const { target } = fakeTarget(root, {
    afterRead: () => fs.writeFileSync(path.join(root, "LocalStorage"), "owned created backend"),
  });
  await assert.rejects(observe(target, root), { code: "ERR_PROBE_UNSUPPORTED_SQLITE" });
});

function fakeElectron(root, options = {}) {
  const app = new EventEmitter();
  app.isReady = () => true;
  const { target, calls } = fakeTarget(root, options);
  const probeSession = {
    getStoragePath: () => root,
    getPreloads: () => [],
    getPreloadScripts: () => options.preloads || [],
  };
  target.session = probeSession;
  target.setWindowOpenHandler = handler => {
    assert.deepEqual(handler(), { action: "deny" });
  };
  let destroyed = false;
  class BrowserWindow {
    static getAllWindows() { return options.existingWindows || []; }
    constructor(preferences) {
      calls.push(["window", preferences]);
      assert.equal(preferences.show, false);
      assert.deepEqual(preferences.webPreferences, {
        session: probeSession, javascript: false, nodeIntegration: false,
        contextIsolation: true, sandbox: true,
      });
      this.webContents = target;
      this.loadFile = target.probeWindow.loadFile;
    }
    isDestroyed() { return destroyed; }
    destroy() { destroyed = true; calls.push(["destroy"]); }
  }
  const electron = {
    app, BrowserWindow,
    session: {
      fromPath: (directory, preferences) => {
        calls.push(["session", directory]);
        assert.equal(directory, root);
        assert.deepEqual(preferences, { cache: false });
        if (!options.reusedSession) app.emit("session-created", probeSession);
        return probeSession;
      },
    },
  };
  return { electron, calls };
}
function runProbe(electron, profilePath, options = {}) {
  return probeDisposableLocalStorage({
    electron, profilePath,
    runtimeVersions: { electron: "43.4.1", chrome: "150.0.7871.224" }, ...options,
  });
}

test("runner owns one explicit persistent session and inert window, never normal startup", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  const { electron, calls } = fakeElectron(root);
  const result = await runProbe(electron, root);
  assert.equal(result.status, "observed");
  assert.equal(calls.filter(call => call[0] === "session").length, 1);
  assert.equal(calls.filter(call => call[0] === "window").length, 1);
  assert.equal(calls.filter(call => call[0] === "loadFile").length, 1);
  assert.equal(calls.at(-1)[0], "destroy");
  assert.equal(electron.app.listenerCount("session-created"), 0);
  await assert.rejects(runProbe(electron, root), { code: "ERR_PROBE_NOT_FRESH" });
});

test("runner refuses runtime drift, existing windows, reused sessions and session preloads", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  for (const options of [
    { existingWindows: [{}] }, { reusedSession: true }, { preloads: [{ id: "app-preload" }] },
  ]) {
    const { electron, calls } = fakeElectron(root, options);
    await assert.rejects(runProbe(electron, root), {
      code: options.preloads ? "ERR_PROBE_TARGET" : "ERR_PROBE_NOT_FRESH",
    });
    assert.equal(calls.some(call => call[0] === "window"), false);
    assert.equal(electron.app.listenerCount("session-created"), 0);
  }
  const { electron, calls } = fakeElectron(root);
  await assert.rejects(runProbe(electron, root, {
    runtimeVersions: { electron: "43.4.2", chrome: "150.0.7871.224" },
  }), { code: "ERR_PROBE_RUNTIME" });
  assert.equal(calls.length, 0);
});

test("a second session interrupts the observation and the owned window still closes", async t => {
  const root = ownedFixture(t);
  supportedStore(root);
  let electron;
  const fixture = fakeElectron(root, {
    duringRead: () => {
      electron.app.emit("session-created", {});
      return new Promise(() => {});
    },
  });
  electron = fixture.electron;
  await assert.rejects(runProbe(electron, root), { code: "ERR_PROBE_NOT_FRESH" });
  assert.equal(fixture.calls.at(-1)[0], "destroy");
  assert.equal(electron.app.listenerCount("session-created"), 0);
});

test("packaged probe HTML has no scripts, resources, frames or origin-changing sandbox", () => {
  const html = fs.readFileSync(probePath, "utf8");
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  for (const directive of [
    "default-src 'none'", "script-src 'none'", "frame-src 'none'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  ]) assert.ok(html.includes(directive), directive);
  assert.doesNotMatch(html, /<(?:script|iframe|frame|link|img|object|embed|audio|video)\b/i);
  assert.doesNotMatch(html, /\b(?:src|href|sandbox)\s*=/i);
  assert.doesNotMatch(html, /(?:^|;)\s*sandbox\b/i);
});
