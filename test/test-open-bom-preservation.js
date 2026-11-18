"use strict";

// Actual Main read/adoption functions, real owned temporary files and controlled
// identity ports. No Main module, Electron app, profile or native Save runs.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const helpers = require("../src/file-helpers-core");

const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 2 && args[0] === "--main-source",
  "Use no arguments or --main-source <exact-main-source>");
const mainPath = args.length ? path.resolve(args[1]) : path.join(__dirname, "..", "src", "main.js");
const source = fs.readFileSync(mainPath, "utf8").replace(/\r\n/g, "\n");
function between(start, end) {
  const first = source.indexOf(start);
  assert.notEqual(first, -1, "Missing source start: " + start);
  assert.equal(source.indexOf(start, first + start.length), -1, "Ambiguous source start: " + start);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(last, -1, "Missing source end: " + end);
  return source.slice(first, last);
}
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, "Missing actual function: " + name);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "Missing complete function: " + name);
  return (source.slice(start - 6, start) === "async " ? "async " : "") + source.slice(start, end + 3);
}
const functions = [
  "normaliseFilePath", "resolveCanonicalFilePath", "canonicalKeyFromPath",
  "resolveCanonicalFileKey", "diskVersionFromStats", "normaliseDiskVersion",
  "diskVersionChanged", "readOwnedTabDiskSnapshot", "readStableRawSnapshot",
].map(extract).join("\n");
const reads = between("function sameDiskVersion(", "\nlet testPreloadRegistered = false;");
const adoption = between('ipcMain.handle("prepare-document-disk-adoption",',
  "\nfunction diskAdoptionAuthorityIsCurrent(");
const digest = text => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "markaloo-open-bom-"));
let passed = 0;
const failures = [];

function fixture(name, text) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, text, "utf8");
  assert.deepEqual(fs.readFileSync(filePath), Buffer.from(text, "utf8"), "Exact UTF-8 test setup");
  const readTarget = fs.realpathSync.native(filePath);
  const pathKey = process.platform === "win32" ? readTarget.toLowerCase() : readTarget;
  const owner = { readTarget, documentRef: "owned-document" };
  const state = { sender: true, admitted: true, authority: true, ownerAuthorised: true };
  const pending = new Map();
  let prepare;
  const context = vm.createContext({
    ...helpers, fs, path, process, crypto, Buffer, console,
    MAX_STABLE_FILE_READ_ATTEMPTS: 3,
    authorisedTabDiskRead: () => state.ownerAuthorised ? owner : null,
    sameDocumentOwner: (left, right) => left === right,
    documentOwnerKey: value => value ? "controlled-owner" : null,
    knownDocumentOwners: new Map([["controlled-owner", owner]]),
    isKnownDocumentOwner: value => value === owner,
    ipcMain: { handle: (name, handler) => {
      assert.equal(name, "prepare-document-disk-adoption");
      assert.equal(prepare, undefined, "One actual adoption handler registered");
      prepare = handler;
    } },
    isApprovalSender: () => state.sender,
    approvalRendererState: "ready",
    approvalRendererPageSession: "bom-page",
    approvalRendererGeneration: 7,
    approvedBrowserDocumentPermission: () => ({ filePath }),
    admittedDocumentReference: () => state.admitted,
    normaliseDocumentIdentity: value => value,
    filePathSpellingKey: value => value,
    ownerDocumentBaselines: new Map(),
    documentDeletionTombstones: new Map(),
    deletionEvidenceRevision: 11,
    diskAdoptionAuthorityIsCurrent: () => state.authority,
    prunePendingDiskAdoptions: () => {},
    pathOnlyDeletionEvidence: new Map(),
    adoptionOverflowKeys: () => [],
    adoptionEvidencePathKeys: () => new Set(),
    unreachablePhysicalDeletionSpellings: () => [],
    sharedDeletionEvidenceNeedsSiblingCheck: () => false,
    pendingDiskAdoptions: pending,
    committedDiskAdoptions: new Map(),
    pendingDocumentReplacementConsents: new Map(),
    MAX_PENDING_DISK_ADOPTIONS: 16,
    orphanedDeletionForSpelling: () => false,
    log: (...values) => console.error(...values),
  });
  vm.runInContext(functions + "\n" + reads + "\n" + adoption, context, { filename: mainPath });
  const stats = fs.statSync(filePath);
  const data = {
    filePath, ownerFilePath: filePath, tabId: null,
    pageSession: "bom-page", rendererGeneration: 7,
    proposedOwner: { pathKey, documentRef: "proposed-document" },
    diskVersion: context.diskVersionFromStats(stats), modifiedTime: stats.mtimeMs,
    contentDigest: digest(text),
  };
  return { filePath, readTarget, pathKey, owner, state, pending, data, context,
    prepare: () => prepare({}, data) };
}

async function test(name, run) {
  try {
    await run();
    passed++;
    console.log("PASS " + name);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}  -> ${error.stack}`);
  }
}

const body = "# 日本語 😀\n| Name | Snippet |\n| --- | --- |\n" +
  '| 雪 | ````c#\nstring text = "🦀 | value";\n``` |\n```` |\n' +
  "Internal \uFEFF stays; trailing \uFEFF";
const spellings = [
  body, body.replace(/\n/g, "\r\n"), body.replace(/\n/, "\r\n"),
];

async function main() {
  await test("shipping initial-open reads retain exact Markdown BOMs, endings and UTF-16 text", async () => {
    for (const extension of [".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".MD"]) {
      for (const spelling of spellings) for (const prefix of ["", "\uFEFF", "\uFEFF\uFEFF"]) {
        const text = prefix + spelling;
        const f = fixture("open" + extension, text);
        const snapshot = await f.context.markdownSnapshotPromise(f.filePath, f.readTarget);
        assert.equal(snapshot.content, text);
        assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.diskVersion));
        assert.equal(snapshot.physical.readTarget, f.readTarget);
        assert.equal(snapshot.physical.pathKey, f.pathKey);
        assert.equal(snapshot.diskVersion.size, Buffer.byteLength(text, "utf8"));
        const delivered = await new Promise((resolve, reject) => {
          f.context.readMarkdownSnapshot(f.filePath, (error, content, modifiedTime, diskVersion) =>
            error ? reject(error) : resolve({ content, modifiedTime, diskVersion }));
        });
        assert.equal(delivered.content, text, "Open callback delivers unchanged source");
        assert.equal(delivered.modifiedTime, snapshot.modifiedTime);
        assert.equal(delivered.diskVersion.size, snapshot.diskVersion.size);
      }
    }
  });

  await test("shipping owned-tab reads retain the same exact Markdown source", async () => {
    for (const spelling of spellings) for (const prefix of ["", "\uFEFF", "\uFEFF\uFEFF"]) {
      const text = prefix + spelling;
      const f = fixture("owned.md", text);
      const snapshot = await f.context.readOwnedTabDiskSnapshot(f.owner, f.filePath, {}, {});
      assert.ok(snapshot && Object.isFrozen(snapshot), "An authorized real disk read completed");
      assert.equal(snapshot.content, text);
      assert.equal(snapshot.diskVersion.size, Buffer.byteLength(text, "utf8"));
    }
  });

  await test("shipping adoption attests the BOM-inclusive source from both disk readers", async () => {
    for (const spelling of spellings) for (const prefix of ["", "\uFEFF", "\uFEFF\uFEFF"]) {
      const text = prefix + spelling;
      const f = fixture("adopt.md", text);
      const snapshot = await f.context.markdownSnapshotPromise(f.filePath);
      f.data.contentDigest = digest(snapshot.content);
      assert.equal(snapshot.content, text, "The adoption request owns the complete disk source");
      const result = await f.prepare();
      assert.equal(result.known, true);
      assert.equal(result.versionMatches, true);
      assert.equal(result.pathKey, f.pathKey);
      assert.equal(f.pending.get(result.capability).contentDigest, digest(text));
      const owned = await f.context.readOwnedTabDiskSnapshot(f.owner, f.filePath, {}, {});
      f.data.contentDigest = digest(owned.content);
      assert.equal((await f.prepare()).known, true, "Owned-tab content has identical hash authority");
    }
  });

  await test("shipping adoption rejects a digest with a lost initial or internal BOM", async () => {
    const text = "\uFEFF" + body;
    for (const wrong of [text.slice(1), text.replace("Internal \uFEFF", "Internal ")]) {
      const f = fixture("wrong-digest.md", text);
      assert.notEqual(digest(wrong), digest(text), "The mismatched digest is observable");
      f.data.contentDigest = digest(wrong);
      const result = await f.prepare();
      assert.equal(result.known, false);
      assert.equal(result.why, "disk-bytes-or-target-moved");
      assert.equal(f.pending.size, 0, "No adoption authority issued for changed source");
    }
  });

  await test("Mermaid and other non-Markdown import normalization is unchanged at all three boundaries", async () => {
    const cases = [
      [".mmd", "\uFEFFgraph TD;\r\nA-->B\uFEFF", "```mermaid\ngraph TD;\r\nA-->B\uFEFF\n```"],
      [".MERMAID", "\uFEFF```mermaid\r\nA-->B\uFEFF\r\n```", "```mermaid\r\nA-->B\uFEFF\r\n```"],
      [".mermaid", "~~~mermaid\nA-->B\n~~~", "~~~mermaid\nA-->B\n~~~"],
      [".txt", "\uFEFFplain\r\ninside\uFEFF", "plain\r\ninside\uFEFF"],
    ];
    for (const [extension, text, expected] of cases) {
      const f = fixture("diagram" + extension, text);
      assert.equal((await f.context.markdownSnapshotPromise(f.filePath)).content, expected);
      assert.equal((await f.context.readOwnedTabDiskSnapshot(f.owner, f.filePath, {}, {})).content, expected);
      f.data.contentDigest = digest(expected);
      assert.equal((await f.prepare()).known, true, "Adoption hashes the existing imported form");
    }
  });

  await test("ownership, target, version and sender refusals remain in force", async () => {
    const f = fixture("guarded.md", body);
    await assert.rejects(f.context.markdownSnapshotPromise(f.filePath, f.readTarget + ".other"),
      /Document target moved before reading/);
    f.state.ownerAuthorised = false;
    assert.equal(await f.context.readOwnedTabDiskSnapshot(f.owner, f.filePath, {}, {}), null);
    f.state.sender = false;
    assert.equal((await f.prepare()).why, "invalid-adoption-sender");
    f.state.sender = true;
    f.state.admitted = false;
    assert.equal((await f.prepare()).why, "invalid-adoption-identity");
    f.state.admitted = true;
    f.state.authority = false;
    assert.equal((await f.prepare()).why, "adoption-moved-during-read");
    f.state.authority = true;
    f.data.diskVersion = { ...f.data.diskVersion, size: f.data.diskVersion.size + 1 };
    assert.equal((await f.prepare()).why, "disk-bytes-or-target-moved");
    assert.equal(f.pending.size, 0);
    assert.equal(fs.readFileSync(f.filePath, "utf8"), body);
  });

  await test("shipping Save readback still compares raw source without BOM restoration or normalization", async () => {
    for (const prefix of ["", "\uFEFF", "\uFEFF\uFEFF"]) {
      const text = prefix + spellings[2];
      const f = fixture("readback.md", text);
      const snapshot = await f.context.readStableRawSnapshot(f.filePath);
      assert.equal(snapshot.content, text);
      assert.equal(snapshot.stats.size, Buffer.byteLength(text, "utf8"));
    }
  });

  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
