"use strict";

// All database bytes and ownership callbacks below are fixtures, not a Chromium
// integrity check or an Electron singleton test. No Electron process is started.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { migrateWindowsProfile, RECEIPT_NAME } = require("../src/profile-migration");

const modulePath = path.join(__dirname, "..", "src", "profile-migration.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "markaloo-profile-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "Folia");
  const target = path.join(root, "Markaloo");
  const storage = path.join("Local Storage", "leveldb");
  const entry = {
    id: "a".repeat(32),
    filePath: path.join(root, "original-document.md"),
    provenance: "native-dialog",
    scrollPosition: 42,
    anchor: { scrollTop: 40, text: "Heading", ordinal: 1, delta: -2 },
  };
  const state = {
    width: 900, height: 700, maximized: true,
    updateAvailability: { availableVersion: "0.13.0", checkedAt: 123 },
    updateSchedule: { lastAttemptAt: 122 },
    unknownFutureSetting: { retained: true },
  };
  const files = {
    "window-state.json": JSON.stringify(state),
    "document-session.json": JSON.stringify({
      version: 1, importStatus: "completed", entries: [entry],
      approvedEntries: [entry], activeEntryId: entry.id,
    }),
    "document-session-import.json": '{"version":1,"status":"completed"}',
    [path.join(storage, "CURRENT")]: "MANIFEST-000007\n",
    [path.join(storage, "MANIFEST-000007")]: Buffer.from([1, 0, 7, 255]),
    [path.join(storage, "000008.ldb")]: Buffer.from([0, 128, 9, 255]),
    [path.join(storage, "000009.log")]: Buffer.from("fixture-only WAL: theme and tabs"),
    [path.join(storage, "LOCK")]: "not copied",
    [path.join(storage, "LOG")]: "diagnostic, not copied",
    [path.join(storage, "LOG.old")]: "diagnostic, not copied",
    "Cookies": "private cookie, not copied",
    ".updaterId": "old updater identity, not copied",
    [path.join("Cache", "cached-document")]: "cache, not copied",
    [path.join("Downloads", "old-update.exe")]: "download, not copied",
  };
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  fs.writeFileSync(entry.filePath, "# Original document\n");
  return { root, source, target, storage, files, entry };
}

function tree(directory) {
  if (!fs.existsSync(directory)) return null;
  const result = {};
  function visit(base, prefix = "") {
    for (const entry of fs.readdirSync(base).sort()) {
      const relative = path.join(prefix, entry);
      const file = path.join(base, entry);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) result[relative] = `link:${fs.readlinkSync(file)}`;
      else if (stat.isDirectory()) visit(file, relative);
      else result[relative] = fs.readFileSync(file).toString("base64");
    }
  }
  visit(directory);
  return result;
}

function stubs(f) {
  const calls = { ownership: 0, validation: 0, held: false };
  const options = {
    appDataPath: f.root,
    withProfileOwnership: async (profiles, run) => {
      assert.deepEqual(profiles, { sourcePath: f.source, targetPath: f.target });
      assert.equal(calls.held, false);
      calls.ownership++;
      calls.held = true;
      try {
        return await run();
      } finally {
        calls.held = false;
      }
    },
    validateLocalStorage: async ({ directory, backend }) => {
      assert.equal(calls.held, true, "validation runs inside the ownership boundary");
      assert.equal(backend, "leveldb");
      assert.notEqual(directory, path.join(f.source, f.storage));
      assert.equal(path.dirname(path.dirname(path.dirname(directory))), f.root);
      assert.deepEqual(fs.readFileSync(path.join(directory, "000009.log")),
        Buffer.from(f.files[path.join(f.storage, "000009.log")]));
      if (directory !== path.join(f.target, f.storage)) {
        assert.equal(fs.existsSync(path.join(directory, "LOCK")), false);
      }
      calls.validation++;
      return { status: "validated", backend: "leveldb" };
    },
  };
  return { options, calls };
}

function loadWithFs(overrides) {
  const module = { exports: {} };
  const fakeFs = new Proxy(fs, {
    get(target, key) {
      return Object.hasOwn(overrides, key) ? overrides[key] : target[key];
    },
  });
  const wrap = vm.runInThisContext(
    `(function(require, module, exports) {\n${fs.readFileSync(modulePath, "utf8")}\n})`,
    { filename: modulePath },
  );
  wrap(name => name === "node:fs" ? fakeFs : require(name), module, module.exports);
  return module.exports.migrateWindowsProfile;
}

function assertNoStage(f) {
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith(".markaloo-migration-")), []);
}

function errorCode(code) {
  return error => {
    assert.equal(error.code, code);
    return true;
  };
}

async function publishPending(f) {
  const migrate = loadWithFs({
    renameSync: (source, target) => {
      assert.equal(target, f.target);
      fs.renameSync(source, target);
      throw Object.assign(new Error("interrupted after directory publication"), { code: "EIO" });
    },
  });
  await assert.rejects(migrate(stubs(f).options), error => error.phase === "publish");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8")).status, "pending");
  assertNoStage(f);
}

test("recognized current destination wins unchanged, even when the legacy profile is corrupt", async t => {
  const f = fixture(t);
  fs.mkdirSync(f.target);
  fs.writeFileSync(path.join(f.target, "new-settings"), "current");
  fs.writeFileSync(path.join(f.target, "window-state.json"), '{"width":1000,"height":800}');
  fs.writeFileSync(path.join(f.source, "window-state.json"), "{bad");
  const before = tree(f.target);
  const { options, calls } = stubs(f);
  options.validateLocalStorage = () => assert.fail("existing state must not be imported");
  assert.deepEqual(await migrateWindowsProfile(options), { status: "existing", targetPath: f.target });
  assert.deepEqual(tree(f.target), before);
  assert.equal(calls.ownership, 1);
  assert.equal(calls.held, false);
  assertNoStage(f);
});

test("empty, unknown and partial current destinations are preserved but refused", async t => {
  for (const files of [{}, { "new-settings": "current" },
    { "window-state.json": "{}" }, { "window-state.json": '{"unknown":true}' },
    { "window-state.json": '{"width":900}' },
    { "document-session-import.json": '{"version":1,"status":"completed"}' }]) {
    const f = fixture(t);
    fs.mkdirSync(f.target);
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(f.target, name), bytes);
    const targetBefore = tree(f.target);
    const sourceBefore = tree(f.source);
    await assert.rejects(migrateWindowsProfile(stubs(f).options), error =>
      ["PROFILE_UNRECOGNIZED_TARGET", "PROFILE_INVALID_STATE"].includes(error.code));
    assert.deepEqual(tree(f.target), targetBefore);
    assert.deepEqual(tree(f.source), sourceBefore);
    assertNoStage(f);
  }
});

test("an established database profile without a migration receipt is validated read-only", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  fs.renameSync(f.source, f.target);
  const before = tree(f.target);
  const { options, calls } = stubs(f);
  assert.equal((await migrateWindowsProfile(options)).status, "existing");
  assert.equal(calls.validation, 1);
  assert.deepEqual(tree(f.target), before);
  assert.equal(fs.existsSync(f.source), false);
  assert.equal(fs.existsSync(path.join(f.target, RECEIPT_NAME)), false);
  assertNoStage(f);
});

test("an established main-owned session is recognized without creating a receipt or importing old settings", async t => {
  const f = fixture(t);
  fs.mkdirSync(f.target);
  fs.copyFileSync(path.join(f.source, "document-session.json"),
    path.join(f.target, "document-session.json"));
  const before = tree(f.target);
  assert.equal((await migrateWindowsProfile(stubs(f).options)).status, "existing");
  assert.deepEqual(tree(f.target), before);
  assertNoStage(f);
});

test("existing database validation cannot be skipped or replaced by an invalid result", { skip: process.platform !== "win32" }, async t => {
  for (const validator of [undefined, async () => ({ status: "unverified", backend: "leveldb" })]) {
    const f = fixture(t);
    fs.renameSync(f.source, f.target);
    const before = tree(f.target);
    const { options } = stubs(f);
    options.validateLocalStorage = validator;
    await assert.rejects(migrateWindowsProfile(options), errorCode(
      validator ? "PROFILE_INVALID_STORAGE" : "PROFILE_STORAGE_VALIDATOR_REQUIRED"));
    assert.deepEqual(tree(f.target), before);
    assert.equal(fs.existsSync(f.source), false);
    assertNoStage(f);
  }
});

test("fresh install does not create either profile or a staging directory", async t => {
  const f = fixture(t);
  fs.rmSync(f.source, { recursive: true });
  const { options, calls } = stubs(f);
  assert.deepEqual(await migrateWindowsProfile(options), { status: "fresh", targetPath: f.target });
  assert.equal(fs.existsSync(f.source), false);
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(calls.validation, 0);
  assertNoStage(f);
});

test("ownership must be present, entered once, and return the completed result", async t => {
  const f = fixture(t);
  await assert.rejects(migrateWindowsProfile({ appDataPath: f.root }),
    errorCode("PROFILE_OWNERSHIP_REQUIRED"));
  await assert.rejects(migrateWindowsProfile({
    appDataPath: f.root, withProfileOwnership: async () => ({ status: "fresh" }),
  }), errorCode("PROFILE_OWNERSHIP_INVALID"));
  await assert.rejects(migrateWindowsProfile({
    appDataPath: "relative", withProfileOwnership: async () => {},
  }), errorCode("PROFILE_INVALID_PATH"));
  fs.mkdirSync(f.target);
  fs.writeFileSync(path.join(f.target, "window-state.json"), '{"width":900,"height":700}');
  const before = tree(f.target);
  await assert.rejects(migrateWindowsProfile({
    appDataPath: f.root,
    withProfileOwnership: async (_paths, run) => { await run(); return run(); },
  }), errorCode("PROFILE_OWNERSHIP_INVALID"));
  assert.deepEqual(tree(f.target), before);
});

test("ownership refusal is an error, never a fresh-install result", async t => {
  const f = fixture(t);
  const refusal = new Error("legacy singleton unavailable");
  await assert.rejects(migrateWindowsProfile({
    appDataPath: f.root,
    withProfileOwnership: async () => { throw refusal; },
  }), error => error === refusal);
  assert.equal(fs.existsSync(f.target), false);
  assertNoStage(f);
});

test("a missing or invalid strict validator cannot publish settings", { skip: process.platform !== "win32" }, async t => {
  for (const validator of [undefined, async () => true,
    async () => ({ status: "validated", backend: "sqlite" })]) {
    const f = fixture(t);
    const { options } = stubs(f);
    options.validateLocalStorage = validator;
    await assert.rejects(migrateWindowsProfile(options),
      errorCode(validator ? "PROFILE_INVALID_STORAGE" : "PROFILE_STORAGE_VALIDATOR_REQUIRED"));
    assert.equal(fs.existsSync(f.target), false);
    assertNoStage(f);
  }
});

test("Windows migration preserves complete settings, tab authority, binary DB/WAL and source bytes", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  const sourceBefore = tree(f.source);
  const documentBefore = fs.readFileSync(f.entry.filePath);
  const { options, calls } = stubs(f);
  assert.deepEqual(await migrateWindowsProfile(options), { status: "migrated", targetPath: f.target });
  assert.deepEqual(tree(f.source), sourceBefore);
  assert.deepEqual(fs.readFileSync(f.entry.filePath), documentBefore);
  for (const relative of ["window-state.json", "document-session.json", "document-session-import.json",
    ...["CURRENT", "MANIFEST-000007", "000008.ldb", "000009.log"].map(name => path.join(f.storage, name))]) {
    assert.deepEqual(fs.readFileSync(path.join(f.target, relative)),
      fs.readFileSync(path.join(f.source, relative)), relative);
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8"));
  assert.equal(receipt.version, 1);
  assert.equal(receipt.status, "completed");
  assert.equal(Object.keys(receipt.files).length, 7);
  assert.equal(Object.keys(tree(f.target)).length, 8);
  assert.equal(fs.existsSync(path.join(f.target, "original-document.md")), false);
  assert.equal(calls.validation, 1);
  assert.equal(calls.held, false);
  assertNoStage(f);
  const completed = tree(f.target);
  fs.writeFileSync(path.join(f.source, "window-state.json"), '{"changedLater":true}');
  assert.equal((await migrateWindowsProfile(options)).status, "existing");
  assert.deepEqual(tree(f.target), completed, "a later version must not reimport the old profile");
  assert.equal(calls.validation, 2, "existing settings are revalidated, never reimported");
});

test("malformed receipts and incomplete published profiles refuse without touching any competing data", { skip: process.platform !== "win32" }, async t => {
  const mutations = [
    f => fs.writeFileSync(path.join(f.target, RECEIPT_NAME), "{broken"),
    f => changeReceipt(f, saved => { saved.version = 2; }),
    f => changeReceipt(f, saved => { saved.status = "attempted"; }),
    f => changeReceipt(f, saved => { delete saved.files; }),
    f => changeReceipt(f, saved => { saved.files = []; }),
    f => changeReceipt(f, saved => { saved.files = {}; }),
    f => changeReceipt(f, saved => { saved.files["window-state.json"].sha256 = "bad"; }),
    f => changeReceipt(f, saved => { saved.files["window-state.json"].bytes = -1; }),
    f => changeReceipt(f, saved => { saved.files["..\\outside"] = saved.files["window-state.json"]; }),
    f => changeReceipt(f, saved => { delete saved.files[path.join(f.storage, "CURRENT")]; }),
    f => fs.unlinkSync(path.join(f.target, "window-state.json")),
    f => fs.rmSync(path.join(f.target, "Local Storage"), { recursive: true }),
  ];
  for (const mutate of mutations) {
    const f = fixture(t);
    const { options } = stubs(f);
    assert.equal((await migrateWindowsProfile(options)).status, "migrated");
    mutate(f);
    const targetBefore = tree(f.target);
    const sourceBefore = tree(f.source);
    await assert.rejects(migrateWindowsProfile(options));
    assert.deepEqual(tree(f.target), targetBefore);
    assert.deepEqual(tree(f.source), sourceBefore);
    assertNoStage(f);
  }
});

function changeReceipt(f, change) {
  const file = path.join(f.target, RECEIPT_NAME);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  change(saved);
  fs.writeFileSync(file, JSON.stringify(saved));
}

test("normal settings edits and LevelDB rotation do not have to match migration-time digests", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  assert.equal((await migrateWindowsProfile(stubs(f).options)).status, "migrated");
  const receiptBefore = fs.readFileSync(path.join(f.target, RECEIPT_NAME));
  fs.writeFileSync(path.join(f.target, "window-state.json"), '{"width":1200,"height":950,"unknownFuture":true}');
  const database = path.join(f.target, f.storage);
  fs.renameSync(path.join(database, "MANIFEST-000007"), path.join(database, "MANIFEST-000011"));
  fs.writeFileSync(path.join(database, "CURRENT"), "MANIFEST-000011\n");
  fs.unlinkSync(path.join(database, "000008.ldb"));
  fs.unlinkSync(path.join(database, "000009.log"));
  fs.writeFileSync(path.join(database, "000012.ldb"), "fixture-only newly compacted data");
  fs.writeFileSync(path.join(f.source, "window-state.json"), "{old profile now corrupt");
  const targetBefore = tree(f.target);
  const sourceBefore = tree(f.source);
  const { options } = stubs(f);
  let validated = false;
  options.validateLocalStorage = async ({ directory, backend }) => {
    assert.equal(directory, database);
    assert.equal(backend, "leveldb");
    validated = true;
    return { status: "validated", backend };
  };
  assert.equal((await migrateWindowsProfile(options)).status, "existing");
  assert.equal(validated, true);
  assert.deepEqual(fs.readFileSync(path.join(f.target, RECEIPT_NAME)), receiptBefore);
  assert.deepEqual(tree(f.target), targetBefore);
  assert.deepEqual(tree(f.source), sourceBefore);
  assertNoStage(f);
});

test("older profiles without main-owned session JSON preserve their database for the existing importer", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.source, "document-session.json"));
  fs.unlinkSync(path.join(f.source, "document-session-import.json"));
  const { options } = stubs(f);
  assert.equal((await migrateWindowsProfile(options)).status, "migrated");
  assert.equal(fs.existsSync(path.join(f.target, "document-session.json")), false);
  assert.deepEqual(fs.readFileSync(path.join(f.target, f.storage, "000009.log")),
    fs.readFileSync(path.join(f.source, f.storage, "000009.log")));
});

test("a profile with JSON state and no local settings database needs no DB adapter", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.source, "Local Storage"), { recursive: true });
  const { options } = stubs(f);
  options.validateLocalStorage = undefined;
  assert.equal((await migrateWindowsProfile(options)).status, "migrated");
  assert.equal(fs.existsSync(path.join(f.target, "Local Storage")), false);
});

test("a legacy directory with no recognized state cannot produce an unusable completion receipt", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  for (const name of ["window-state.json", "document-session.json", "document-session-import.json"]) {
    fs.unlinkSync(path.join(f.source, name));
  }
  fs.rmSync(path.join(f.source, "Local Storage"), { recursive: true });
  const before = tree(f.source);
  const migrate = loadWithFs({
    mkdtempSync: () => assert.fail("unrecognized legacy state must refuse before staging"),
  });
  await assert.rejects(migrate(stubs(f).options), errorCode("PROFILE_INVALID_STATE"));
  assert.deepEqual(tree(f.source), before);
  assert.equal(fs.existsSync(f.target), false);
  assertNoStage(f);
});

test("corrupt JSON, session IDs, permissions, anchors and partial import markers fail closed", { skip: process.platform !== "win32" }, async t => {
  const mutations = [
    f => fs.writeFileSync(path.join(f.source, "window-state.json"), "{broken"),
    f => fs.writeFileSync(path.join(f.source, "window-state.json"), "[]"),
    f => fs.unlinkSync(path.join(f.source, "document-session.json")),
    f => fs.writeFileSync(path.join(f.source, "document-session-import.json"), '{"version":1,"status":"failed-corrupt"}'),
    f => changeSession(f, saved => { saved.importStatus = "attempted"; }),
    f => changeSession(f, saved => { saved.entries.push(saved.entries[0]); }),
    f => changeSession(f, saved => { saved.approvedEntries = []; }),
    f => changeSession(f, saved => { saved.activeEntryId = "b".repeat(32); }),
    f => changeSession(f, saved => { saved.entries[0].filePath = "relative.md"; }),
    f => changeSession(f, saved => { saved.entries[0].anchor.ordinal = -1; }),
    f => changeSession(f, saved => { saved.entries[0].scrollPosition = -1; }),
  ];
  for (const mutate of mutations) {
    const f = fixture(t);
    mutate(f);
    const before = tree(f.source);
    await assert.rejects(migrateWindowsProfile(stubs(f).options),
      error => error.phase === "inspect");
    assert.deepEqual(tree(f.source), before);
    assert.equal(fs.existsSync(f.target), false);
    assertNoStage(f);
  }
});

function changeSession(f, change) {
  const file = path.join(f.source, "document-session.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  change(saved);
  fs.writeFileSync(file, JSON.stringify(saved));
}

test("unknown stores and incomplete LevelDB layouts are not treated as absent", { skip: process.platform !== "win32" }, async t => {
  const mutations = [
    f => fs.writeFileSync(path.join(f.source, "Local Storage", "unknown-backend"), "unknown"),
    f => fs.rmSync(path.join(f.source, f.storage), { recursive: true }),
    f => fs.writeFileSync(path.join(f.source, f.storage, "CURRENT"), "MANIFEST-999999\n"),
    f => fs.writeFileSync(path.join(f.source, f.storage, "CURRENT"), "../outside\n"),
    f => fs.writeFileSync(path.join(f.source, f.storage, "unknown-store"), "unknown"),
  ];
  for (const mutate of mutations) {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(migrateWindowsProfile(stubs(f).options),
      error => ["PROFILE_UNSUPPORTED_STORAGE", "PROFILE_INVALID_STORAGE"].includes(error.code));
    assert.equal(fs.existsSync(f.target), false);
    assertNoStage(f);
  }
});

test("real root SQLite stores and sidecars refuse before staging, with or without LevelDB", { skip: process.platform !== "win32" }, async t => {
  for (const withLevelDB of [false, true]) {
    for (const name of ["LocalStorage", "LocalStorage-wal", "LocalStorage-shm", "LocalStorage-journal"]) {
      const f = fixture(t);
      if (!withLevelDB) fs.rmSync(path.join(f.source, "Local Storage"), { recursive: true });
      fs.writeFileSync(path.join(f.source, name), "fixture-only SQLite bytes");
      const before = tree(f.source);
      const migrate = loadWithFs({
        mkdtempSync: () => assert.fail("unsupported SQLite must refuse before staging"),
      });
      const { options } = stubs(f);
      options.validateLocalStorage = () => assert.fail("SQLite must not fall through to a LevelDB probe");
      await assert.rejects(migrate(options), errorCode("PROFILE_UNSUPPORTED_SQLITE"));
      assert.deepEqual(tree(f.source), before);
      assert.equal(fs.existsSync(f.target), false);
      assertNoStage(f);
    }
  }
});

test("root SQLite directories and unreadable SQLite inspection are not accepted as absent", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, "LocalStorage"));
  await assert.rejects(migrateWindowsProfile(stubs(f).options),
    errorCode("PROFILE_UNSUPPORTED_SQLITE"));
  assert.equal(fs.statSync(path.join(f.source, "LocalStorage")).isDirectory(), true);
  assertNoStage(f);
  const g = fixture(t);
  fs.writeFileSync(path.join(g.source, "LocalStorage-wal"), "preserve");
  const before = tree(g.source);
  const migrate = loadWithFs({
    lstatSync: file => {
      if (file === path.join(g.source, "LocalStorage-wal")) {
        throw Object.assign(new Error("SQLite inspection denied"), { code: "EACCES" });
      }
      return fs.lstatSync(file);
    },
    mkdtempSync: () => assert.fail("unreadable SQLite must refuse before staging"),
  });
  await assert.rejects(migrate(stubs(g).options), error => {
    assert.equal(error.phase, "inspect");
    assert.equal(error.cause.code, "EACCES");
    return true;
  });
  assert.deepEqual(tree(g.source), before);
  assert.equal(fs.existsSync(g.target), false);
  assertNoStage(g);
});

test("an established target with root SQLite is preserved but cannot be certified as completed", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  fs.renameSync(f.source, f.target);
  fs.writeFileSync(path.join(f.target, "LocalStorage"), "unsupported");
  const before = tree(f.target);
  await assert.rejects(migrateWindowsProfile(stubs(f).options),
    errorCode("PROFILE_UNSUPPORTED_SQLITE"));
  assert.deepEqual(tree(f.target), before);
  assertNoStage(f);
});

test("source inspection access errors cannot become a fresh installation", async t => {
  const f = fixture(t);
  const migrate = loadWithFs({
    lstatSync: file => {
      if (file === f.source) throw Object.assign(new Error("access denied"), { code: "EACCES" });
      return fs.lstatSync(file);
    },
  });
  await assert.rejects(migrate(stubs(f).options), error => {
    assert.equal(error.code, "PROFILE_MIGRATION_FAILED");
    assert.equal(error.cause.code, "EACCES");
    return true;
  });
  assert.equal(fs.existsSync(f.target), false);
});

test("read, partial-copy, byte mismatch, flush and rename failures leave no partial destination", { skip: process.platform !== "win32" }, async t => {
  for (const fault of ["read", "copy", "bytes", "flush", "rename"]) {
    const f = fixture(t);
    const before = tree(f.source);
    let copies = 0;
    const ioError = () => { throw Object.assign(new Error(`injected ${fault}`), { code: "EIO" }); };
    const migrate = loadWithFs({
      openSync: (file, flags) => fault === "read" && file === path.join(f.source, "window-state.json") ?
        ioError() : fs.openSync(file, flags),
      copyFileSync: (source, target, flags) => {
        if (fault === "copy" && ++copies === 2) ioError();
        fs.copyFileSync(source, target, flags);
        if (fault === "bytes") fs.appendFileSync(target, "corruption");
      },
      fsyncSync: fd => fault === "flush" ? ioError() : fs.fsyncSync(fd),
      renameSync: (source, target) => fault === "rename" ? ioError() : fs.renameSync(source, target),
    });
    await assert.rejects(migrate(stubs(f).options));
    assert.deepEqual(tree(f.source), before);
    assert.equal(fs.existsSync(f.target), false);
    assertNoStage(f);
    if (fault === "copy") assert.equal(copies, 2, "one file was copied before the injected failure");
  }
});

test("validator failures and validator writes cannot publish a repaired or changed database", { skip: process.platform !== "win32" }, async t => {
  for (const action of ["throw", "change-db", "create-log", "add-cookie", "change-source"]) {
    const f = fixture(t);
    const { options, calls } = stubs(f);
    options.validateLocalStorage = async ({ directory }) => {
      if (action === "throw") throw new Error("fixture corruption");
      if (action === "change-db") fs.appendFileSync(path.join(directory, "000009.log"), "repaired");
      if (action === "create-log") fs.writeFileSync(path.join(directory, "LOG"), "opened DB");
      if (action === "add-cookie") fs.writeFileSync(path.join(directory, "..", "..", "Cookies"), "new");
      if (action === "change-source") fs.appendFileSync(path.join(f.source, f.storage, "000009.log"), "external write");
      return { status: "validated", backend: "leveldb" };
    };
    await assert.rejects(migrateWindowsProfile(options),
      error => error.phase === "validate");
    assert.equal(calls.held, false);
    assert.equal(fs.existsSync(f.target), false);
    assertNoStage(f);
  }
});

test("Windows rename refuses destination races, including an empty pre-existing directory", { skip: process.platform !== "win32" }, async t => {
  for (const populated of [false, true]) {
    const f = fixture(t);
    let racingState;
    const migrate = loadWithFs({
      renameSync: (source, target) => {
        assert.equal(target, f.target);
        fs.mkdirSync(target);
        if (populated) fs.writeFileSync(path.join(target, "new-state"), "must remain");
        racingState = tree(target);
        return fs.renameSync(source, target);
      },
    });
    await assert.rejects(migrate(stubs(f).options), error => error.phase === "publish");
    assert.deepEqual(tree(f.target), racingState);
    assertNoStage(f);
    await assert.rejects(migrateWindowsProfile(stubs(f).options),
      errorCode("PROFILE_UNRECOGNIZED_TARGET"));
    assert.deepEqual(tree(f.target), racingState, "a retry preserves every competing byte");
    assertNoStage(f);
  }
});

test("a failure after publication never removes the new profile and a retry never reimports", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  const before = tree(f.source);
  const migrate = loadWithFs({
    renameSync: (source, target) => {
      fs.renameSync(source, target);
      throw Object.assign(new Error("interrupted after publication"), { code: "EIO" });
    },
  });
  await assert.rejects(migrate(stubs(f).options), error => error.phase === "publish");
  assert.deepEqual(tree(f.source), before);
  const published = tree(f.target);
  assert.ok(published[RECEIPT_NAME], "the publication actually happened before the injected error");
  const pending = JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8"));
  assert.equal(pending.status, "pending", "publication is not completion before final verification");
  assert.equal(fs.readFileSync(path.join(f.target, "window-state.json"), "utf8"),
    f.files["window-state.json"]);
  assertNoStage(f);
  const { options, calls } = stubs(f);
  assert.equal((await migrateWindowsProfile(options)).status, "existing");
  assert.equal(calls.validation, 1, "the current database is revalidated without importing again");
  const finalized = tree(f.target);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8")),
    { ...pending, status: "completed" });
  delete published[RECEIPT_NAME];
  delete finalized[RECEIPT_NAME];
  assert.deepEqual(finalized, published, "only the pending receipt is promoted");
});

test("valid-looking data changed after directory publication cannot become an existing completed profile on retry", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  const sourceBefore = tree(f.source);
  const migrate = loadWithFs({
    renameSync: (source, target) => {
      assert.equal(target, f.target);
      fs.renameSync(source, target);
      fs.writeFileSync(path.join(target, "window-state.json"), '{"width":1200,"height":900}');
    },
  });
  await assert.rejects(migrate(stubs(f).options), errorCode("PROFILE_PUBLISH_INVALID"));
  const targetBefore = tree(f.target);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8")).status, "pending");
  const { options } = stubs(f);
  options.validateLocalStorage = () => assert.fail("changed pending bytes refuse before validation");
  for (let retry = 0; retry < 3; retry++) {
    await assert.rejects(migrateWindowsProfile(options), errorCode("PROFILE_PENDING_CHANGED"));
    assert.deepEqual(tree(f.target), targetBefore);
    assert.deepEqual(tree(f.source), sourceBefore);
    assertNoStage(f);
  }
});

test("malformed or changed pending publications remain untouched and cannot be promoted", { skip: process.platform !== "win32" }, async t => {
  const mutations = [
    [f => fs.writeFileSync(path.join(f.target, RECEIPT_NAME), "{broken"), "PROFILE_MIGRATION_FAILED"],
    [f => changeReceipt(f, saved => { saved.version = 2; }), "PROFILE_INVALID_RECEIPT"],
    [f => changeReceipt(f, saved => { saved.status = "attempted"; }), "PROFILE_INVALID_RECEIPT"],
    [f => changeReceipt(f, saved => { saved.files = {}; }), "PROFILE_INVALID_RECEIPT"],
    [f => changeReceipt(f, saved => { saved.files["window-state.json"].sha256 = "bad"; }), "PROFILE_INVALID_RECEIPT"],
    [f => fs.writeFileSync(path.join(f.target, "window-state.json"), '{"width":1100,"height":800}'), "PROFILE_PENDING_CHANGED"],
    [f => fs.unlinkSync(path.join(f.target, "window-state.json")), "PROFILE_INCOMPLETE_TARGET"],
    [f => fs.appendFileSync(path.join(f.target, f.storage, "000009.log"), "changed"), "PROFILE_PENDING_CHANGED"],
    [f => fs.unlinkSync(path.join(f.target, f.storage, "000008.ldb")), "PROFILE_PENDING_CHANGED"],
    [f => fs.writeFileSync(path.join(f.target, f.storage, "000010.ldb"), "new"), "PROFILE_PENDING_CHANGED"],
    [f => {
      fs.renameSync(path.join(f.target, f.storage, "MANIFEST-000007"),
        path.join(f.target, f.storage, "MANIFEST-000011"));
      fs.writeFileSync(path.join(f.target, f.storage, "CURRENT"), "MANIFEST-000011\n");
    }, "PROFILE_PENDING_CHANGED"],
    [f => fs.writeFileSync(path.join(f.target, "Cookies"), "unknown competing data"), "PROFILE_CHANGED"],
  ];
  for (const [mutate, code] of mutations) {
    const f = fixture(t);
    await publishPending(f);
    mutate(f);
    const targetBefore = tree(f.target);
    const sourceBefore = tree(f.source);
    const { options } = stubs(f);
    options.validateLocalStorage = () => assert.fail("invalid pending state must refuse before validation");
    for (let retry = 0; retry < 2; retry++) {
      await assert.rejects(migrateWindowsProfile(options), errorCode(code));
      assert.deepEqual(tree(f.target), targetBefore);
      assert.deepEqual(tree(f.source), sourceBefore);
      assertNoStage(f);
    }
  }
});

test("pending completion requires accepted read-only validation and never reimports the source", { skip: process.platform !== "win32" }, async t => {
  for (const validator of [undefined, async () => ({ status: "unverified", backend: "leveldb" })]) {
    const f = fixture(t);
    await publishPending(f);
    const targetBefore = tree(f.target);
    const { options } = stubs(f);
    options.validateLocalStorage = validator;
    await assert.rejects(migrateWindowsProfile(options),
      errorCode(validator ? "PROFILE_INVALID_STORAGE" : "PROFILE_STORAGE_VALIDATOR_REQUIRED"));
    assert.deepEqual(tree(f.target), targetBefore);
    assertNoStage(f);
  }
  const f = fixture(t);
  await publishPending(f);
  fs.writeFileSync(path.join(f.source, "window-state.json"), "{old source now corrupt");
  const sourceBefore = tree(f.source);
  const { options, calls } = stubs(f);
  const migrate = loadWithFs({
    mkdtempSync: () => assert.fail("pending completion must not allocate another profile copy"),
    copyFileSync: () => assert.fail("pending completion must not reimport any file"),
  });
  assert.equal((await migrate(options)).status, "existing");
  assert.equal(calls.validation, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8")).status, "completed");
  assert.deepEqual(tree(f.source), sourceBefore);
  assertNoStage(f);
});

test("pending validation mutations cannot mark changed target bytes completed", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  await publishPending(f);
  const sourceBefore = tree(f.source);
  const { options } = stubs(f);
  let mutated;
  options.validateLocalStorage = async ({ directory, backend }) => {
    fs.appendFileSync(path.join(directory, "000009.log"), "validator changed data");
    mutated = tree(f.target);
    return { status: "validated", backend };
  };
  await assert.rejects(migrateWindowsProfile(options), errorCode("PROFILE_CHANGED"));
  assert.deepEqual(tree(f.target), mutated);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8")).status, "pending");
  assert.deepEqual(tree(f.source), sourceBefore);
  assertNoStage(f);
});

test("JSON-only pending publication completes without a database validator", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.source, "Local Storage"), { recursive: true });
  await publishPending(f);
  const { options } = stubs(f);
  options.validateLocalStorage = undefined;
  assert.equal((await migrateWindowsProfile(options)).status, "existing");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8")).status, "completed");
  assert.equal(fs.existsSync(path.join(f.target, "Local Storage")), false);
  assertNoStage(f);
});

test("receipt creation, partial-write, flush, readback and atomic-rename failures keep pending data intact", { skip: process.platform !== "win32" }, async t => {
  for (const fault of ["open", "write", "flush", "bytes", "rename"]) {
    const f = fixture(t);
    await publishPending(f);
    const targetBefore = tree(f.target);
    const sourceBefore = tree(f.source);
    let temporary;
    const ioError = () => { throw Object.assign(new Error(`injected completion ${fault}`), { code: "EIO" }); };
    const migrate = loadWithFs({
      openSync: (file, flags, mode) => {
        if (flags === "wx") {
          temporary = file;
          if (fault === "open") ioError();
        }
        return fs.openSync(file, flags, mode);
      },
      writeFileSync: (file, data, options) => {
        if (typeof file === "number" && fault === "write") {
          fs.writeSync(file, "partial receipt");
          ioError();
        }
        return fs.writeFileSync(file, data, options);
      },
      fsyncSync: fd => fault === "flush" ? ioError() : fs.fsyncSync(fd),
      readFileSync: (file, options) => file === temporary && fault === "bytes" ?
        "invalid completed bytes" : fs.readFileSync(file, options),
      renameSync: (source, target) => fault === "rename" ? ioError() : fs.renameSync(source, target),
    });
    await assert.rejects(migrate(stubs(f).options),
      errorCode(fault === "bytes" ? "PROFILE_INVALID_RECEIPT" : "PROFILE_MIGRATION_FAILED"));
    assert.ok(temporary, "the injected failure reached receipt completion");
    assert.equal(fs.existsSync(temporary), false, "only this attempt's exact temporary file is cleaned");
    assert.deepEqual(tree(f.target), targetBefore);
    assert.deepEqual(tree(f.source), sourceBefore);
    assert.equal((await migrateWindowsProfile(stubs(f).options)).status, "existing");
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8")).status, "completed");
    assertNoStage(f);
  }
});

test("an atomic receipt rename that succeeds then throws is completed and retryable", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  await publishPending(f);
  const migrate = loadWithFs({
    renameSync: (source, target) => {
      assert.equal(target, path.join(f.target, RECEIPT_NAME));
      fs.renameSync(source, target);
      throw Object.assign(new Error("interrupted after receipt commit"), { code: "EIO" });
    },
  });
  await assert.rejects(migrate(stubs(f).options));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8")).status, "completed");
  const completed = tree(f.target);
  assert.equal((await migrateWindowsProfile(stubs(f).options)).status, "existing");
  assert.deepEqual(tree(f.target), completed);
  assertNoStage(f);
});

test("receipt cleanup never removes an unknown replacement or hides a cleanup failure", { skip: process.platform !== "win32" }, async t => {
  for (const replaced of [false, true]) {
    const f = fixture(t);
    await publishPending(f);
    let temporary;
    const migrate = loadWithFs({
      renameSync: source => {
        temporary = source;
        if (replaced) {
          const other = path.join(f.root, "owned-competing-receipt");
          fs.writeFileSync(other, "competing bytes must survive");
          fs.renameSync(other, source);
        }
        throw Object.assign(new Error("receipt rename failed"), { code: "EIO" });
      },
      unlinkSync: file => {
        assert.equal(replaced, false, "unknown replacement must not reach unlink");
        assert.equal(file, temporary);
        throw Object.assign(new Error("receipt cleanup denied"), { code: "EACCES" });
      },
    });
    await assert.rejects(migrate(stubs(f).options), error => {
      assert.equal(error.code, "PROFILE_RECEIPT_CLEANUP_FAILED");
      assert.ok(error.message.includes(temporary));
      return true;
    });
    assert.equal(fs.existsSync(temporary), true);
    if (replaced) assert.equal(fs.readFileSync(temporary, "utf8"), "competing bytes must survive");
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8")).status, "pending");
    const beforeRetry = tree(f.target);
    await assert.rejects(migrateWindowsProfile(stubs(f).options), errorCode("PROFILE_CHANGED"));
    assert.deepEqual(tree(f.target), beforeRetry);
    assertNoStage(f);
  }
});

test("real subprocess exits distinguish pending directory publication, interrupted receipt preparation and completed commit", { skip: process.platform !== "win32" }, async t => {
  const childSource = `
    "use strict";
    const fs = require("node:fs");
    const path = require("node:path");
    const [modulePath, appDataPath, point] = process.argv.slice(1);
    const target = path.join(appDataPath, "Markaloo");
    const receipt = path.join(target, "markaloo-profile-migration.json");
    const renameSync = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (destination === receipt && point === "before-promotion") process.exit(82);
      renameSync(source, destination);
      if (destination === target && point === "directory") process.exit(81);
      if (destination === receipt && point === "after-promotion") process.exit(83);
    };
    require(modulePath).migrateWindowsProfile({
      appDataPath,
      withProfileOwnership: async (_paths, run) => await run(),
      validateLocalStorage: async () => ({ status: "validated", backend: "leveldb" }),
    }).then(() => process.exit(84), error => {
      console.error(error);
      process.exit(85);
    });
  `;
  for (const [point, exitCode] of [["directory", 81], ["before-promotion", 82], ["after-promotion", 83]]) {
    const f = fixture(t);
    const sourceBefore = tree(f.source);
    const child = spawnSync(process.execPath, ["-e", childSource, modulePath, f.root, point], {
      cwd: f.root, encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, exitCode, child.stderr);
    assert.deepEqual(tree(f.source), sourceBefore);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8"));
    assert.equal(receipt.status, point === "after-promotion" ? "completed" : "pending");
    const temporaries = fs.readdirSync(f.target).filter(name => name.endsWith(".tmp"));
    assert.equal(temporaries.length, point === "before-promotion" ? 1 : 0);
    assertNoStage(f);
    const beforeRetry = tree(f.target);
    for (let retry = 0; retry < 3; retry++) {
      if (point === "before-promotion") {
        await assert.rejects(migrateWindowsProfile(stubs(f).options), error => {
          assert.equal(error.code, "PROFILE_CHANGED");
          assert.ok(error.message.includes(path.join(f.target, temporaries[0])));
          return true;
        });
        assert.deepEqual(tree(f.target), beforeRetry, "unknown interrupted temporary is preserved, not multiplied");
      } else {
        assert.equal((await migrateWindowsProfile(stubs(f).options)).status, "existing");
        assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, RECEIPT_NAME), "utf8")).status, "completed");
      }
      assert.deepEqual(tree(f.source), sourceBefore);
      assertNoStage(f);
    }
  }
});

test("unknown reserved staging entries are preserved and reported before another copy", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  const names = [".markaloo-migration-unknown", ".markaloo-migration-",
    ".markaloo-migration-file", ".MARKALOO-MIGRATION-UPPERCASE", ".markaloo-migration-link"];
  fs.mkdirSync(path.join(f.root, names[0]));
  fs.writeFileSync(path.join(f.root, names[0], "unowned"), "preserve");
  fs.mkdirSync(path.join(f.root, names[1]));
  fs.writeFileSync(path.join(f.root, names[2]), "not even a directory");
  fs.writeFileSync(path.join(f.root, names[3]), "case-insensitive reserved name");
  fs.symlinkSync(f.source, path.join(f.root, names[4]), "junction");
  const before = tree(f.root);
  const entriesBefore = fs.readdirSync(f.root).sort();
  const migrate = loadWithFs({
    mkdtempSync: () => assert.fail("leftovers must refuse before allocating another stage"),
    copyFileSync: () => assert.fail("leftovers must refuse before copying"),
    rmSync: () => assert.fail("unknown leftovers must not be deleted"),
  });
  const { options } = stubs(f);
  options.validateLocalStorage = () => assert.fail("leftovers must refuse before validation");
  for (let retry = 0; retry < 3; retry++) {
    await assert.rejects(migrate(options), error => {
      assert.equal(error.code, "PROFILE_STAGE_LEFTOVER");
      assert.equal(error.phase, "inspect");
      assert.ok(error.message.includes("manual inspection before retrying"));
      for (const name of names) assert.ok(error.message.includes(path.join(f.root, name)));
      return true;
    });
    assert.deepEqual(tree(f.root), before);
    assert.deepEqual(fs.readdirSync(f.root).sort(), entriesBefore);
    assert.equal(fs.statSync(path.join(f.root, names[1])).isDirectory(), true);
    assert.equal(fs.existsSync(f.target), false);
  }
});

test("failure to inspect reserved staging entries refuses without copying", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  const before = tree(f.root);
  const migrate = loadWithFs({
    readdirSync: directory => {
      if (directory === f.root) {
        throw Object.assign(new Error("staging inspection denied"), { code: "EACCES" });
      }
      return fs.readdirSync(directory);
    },
    mkdtempSync: () => assert.fail("staging inspection must complete before allocation"),
  });
  await assert.rejects(migrate(stubs(f).options), error => {
    assert.equal(error.code, "PROFILE_MIGRATION_FAILED");
    assert.equal(error.phase, "inspect");
    assert.equal(error.cause.code, "EACCES");
    return true;
  });
  assert.deepEqual(tree(f.root), before);
  assert.equal(fs.existsSync(f.target), false);
  assertNoStage(f);
});

test("process exit during copying or validation leaves one preserved stage and retries cannot accumulate copies", { skip: process.platform !== "win32" }, async t => {
  const childSource = `
    "use strict";
    const fs = require("node:fs");
    const [modulePath, appDataPath, phase] = process.argv.slice(1);
    if (phase === "copy") {
      const copyFileSync = fs.copyFileSync;
      fs.copyFileSync = (source, target, flags) => {
        copyFileSync(source, target, flags);
        process.exit(71);
      };
    }
    const { migrateWindowsProfile } = require(modulePath);
    migrateWindowsProfile({
      appDataPath,
      withProfileOwnership: async (_paths, run) => await run(),
      validateLocalStorage: async () => process.exit(72),
    }).then(() => process.exit(73), error => {
      console.error(error);
      process.exit(74);
    });
  `;
  for (const phase of ["copy", "validate"]) {
    const f = fixture(t);
    const sourceBefore = tree(f.source);
    const child = spawnSync(process.execPath, ["-e", childSource, modulePath, f.root, phase], {
      cwd: f.root, encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, phase === "copy" ? 71 : 72, child.stderr);
    assert.deepEqual(tree(f.source), sourceBefore);
    assert.equal(fs.existsSync(f.target), false);
    const stages = fs.readdirSync(f.root).filter(name => name.startsWith(".markaloo-migration-"));
    assert.equal(stages.length, 1, "process exit really bypassed finally and left its stage");
    const stage = path.join(f.root, stages[0]);
    const copied = phase === "copy" ? ["window-state.json"] :
      ["window-state.json", "document-session.json", "document-session-import.json",
        ...["CURRENT", "MANIFEST-000007", "000008.ldb", "000009.log"]
          .map(name => path.join(f.storage, name))];
    assert.deepEqual(tree(stage), Object.fromEntries(copied.map(name => [name, sourceBefore[name]])),
      "the child exited at the intended copy/validation boundary");
    assert.equal(fs.existsSync(path.join(stage, RECEIPT_NAME)), false);
    const beforeRetry = tree(f.root);
    const entriesBefore = fs.readdirSync(f.root).sort();
    const migrate = loadWithFs({
      mkdtempSync: () => assert.fail("a retry must not allocate another stage"),
      copyFileSync: () => assert.fail("a retry must not copy again"),
      rmSync: () => assert.fail("a retry must preserve the interrupted stage"),
    });
    const { options } = stubs(f);
    options.validateLocalStorage = () => assert.fail("a retry must refuse before validation");
    for (let retry = 0; retry < 3; retry++) {
      await assert.rejects(migrate(options), error => {
        assert.equal(error.code, "PROFILE_STAGE_LEFTOVER");
        assert.equal(error.phase, "inspect");
        assert.ok(error.message.includes(stage), "the refusal reports the exact preserved path");
        return true;
      });
      assert.deepEqual(tree(f.root), beforeRetry);
      assert.deepEqual(fs.readdirSync(f.root).sort(), entriesBefore);
      assert.equal(fs.existsSync(f.target), false);
    }
  }
});

test("completed and established targets still classify successfully despite unknown staging entries", { skip: process.platform !== "win32" }, async t => {
  for (const completed of [false, true]) {
    const f = fixture(t);
    if (completed) {
      assert.equal((await migrateWindowsProfile(stubs(f).options)).status, "migrated");
    } else {
      fs.mkdirSync(f.target);
      fs.writeFileSync(path.join(f.target, "window-state.json"), '{"width":1000,"height":800}');
    }
    const unknown = path.join(f.root, ".markaloo-migration-unknown");
    fs.mkdirSync(unknown);
    fs.writeFileSync(path.join(unknown, "unowned"), "preserve");
    const before = tree(f.root);
    const entriesBefore = fs.readdirSync(f.root).sort();
    const migrate = loadWithFs({
      mkdtempSync: () => assert.fail("existing state must not allocate another stage"),
      copyFileSync: () => assert.fail("existing state must not be reimported"),
      rmSync: () => assert.fail("unknown staging entries must not be deleted"),
    });
    assert.equal((await migrate(stubs(f).options)).status, "existing");
    assert.deepEqual(tree(f.root), before);
    assert.deepEqual(fs.readdirSync(f.root).sort(), entriesBefore);
  }
});

test("a fresh installation does not inspect or change leftover staging entries", async t => {
  const f = fixture(t);
  fs.rmSync(f.source, { recursive: true });
  const unknown = path.join(f.root, ".markaloo-migration-unknown");
  fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(unknown, "unowned"), "preserve");
  const before = tree(f.root);
  const entriesBefore = fs.readdirSync(f.root).sort();
  const migrate = loadWithFs({
    readdirSync: () => assert.fail("fresh startup has no stage to allocate"),
    mkdtempSync: () => assert.fail("fresh startup must not allocate a stage"),
  });
  assert.deepEqual(await migrate(stubs(f).options), { status: "fresh", targetPath: f.target });
  assert.deepEqual(tree(f.root), before);
  assert.deepEqual(fs.readdirSync(f.root).sort(), entriesBefore);
  assert.equal(fs.existsSync(f.source), false);
  assert.equal(fs.existsSync(f.target), false);
});

test("cleanup errors remain visible, including the original copy failure", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  const migrate = loadWithFs({
    copyFileSync: () => { throw Object.assign(new Error("copy failed"), { code: "EIO" }); },
    rmSync: () => { throw Object.assign(new Error("cleanup denied"), { code: "EACCES" }); },
  });
  await assert.rejects(migrate(stubs(f).options), error => {
    assert.equal(error.code, "PROFILE_CLEANUP_FAILED");
    assert.equal(error.cause.cause.code, "EIO");
    assert.equal(error.cleanupError.code, "EACCES");
    assert.equal(path.dirname(error.stagePath), f.root);
    return true;
  });
  assert.equal(fs.existsSync(f.target), false);
});

test("profile junctions are rejected, not followed into other data", async t => {
  const f = fixture(t);
  const owned = path.join(f.root, "owned-other-directory");
  fs.mkdirSync(owned);
  fs.writeFileSync(path.join(owned, "untouched"), "original");
  fs.symlinkSync(owned, f.target, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(migrateWindowsProfile(stubs(f).options),
    errorCode("PROFILE_INVALID_DIRECTORY"));
  assert.equal(fs.readFileSync(path.join(owned, "untouched"), "utf8"), "original");
});
