"use strict";

if (process.platform !== "win32") {
  console.log("Skipping Windows-only profile startup admission tests.");
  process.exit(0);
}

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { test } = require("node:test");
const {
  NODE_PIN, MAX_QUEUE, MAX_REQUESTS, profileAdmissionPaths,
  createStartupRequest, forwardStartupRequest, admitStartup,
} = require("../src/profile-startup-admission");

assert.equal(process.versions.node, NODE_PIN,
  `Profile startup admission tests require Node ${NODE_PIN}; got ${process.versions.node}`);

const modulePath = path.resolve(__dirname, "..", "src", "profile-startup-admission.js");
const id = () => crypto.randomBytes(32).toString("hex");

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function packets(bytes) {
  const result = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    result.push(JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString("utf8")));
    offset += 4 + length;
  }
  assert.equal(offset, bytes.length);
  return result;
}

async function fixtureMain() {
  const fs = require("node:fs");
  const [mode, modulePath, profile, records] = process.argv.slice(2);
  if (mode === "import-only") {
    const originalLoad = require("node:module")._load;
    require("node:module")._load = function (request, ...rest) {
      if (request === "electron") throw new Error("Import loaded Electron");
      return originalLoad.call(this, request, ...rest);
    };
    for (const name of ["writeFileSync", "mkdirSync", "openSync", "unlinkSync", "renameSync"]) {
      fs[name] = () => { throw new Error(`Import called ${name}`); };
    }
    require("node:net").createServer = () => { throw new Error("Import created a listener"); };
    require(modulePath);
    process.exit(0);
  }
  const admission = require(modulePath);
  if (mode === "interrupt-publication") fs.renameSync = () => process.exit(0);
  const result = await admission.admitStartup({
    canonicalProfilePath: profile, ownerRecordRoot: records,
    request: admission.createStartupRequest({ args: ["fixture"], cwd: process.cwd() }),
  });
  if (result.role !== "primary") throw new Error("Fixture did not own its unique test gate");
  const { owner } = result;
  owner.on("error", error => { throw error; });
  owner.takeQueued();
  owner.setPhase("running");
  process.send({ status: "ready", pid: process.pid, nonce: owner.nonce });
  process.on("message", async command => {
    if (command === "close-pipe") {
      await owner.close();
      process.send({ status: "pipe-closed" });
    } else if (command === "take") {
      process.send({ status: "taken", requests: owner.takeQueued() });
    } else if (command === "exit") process.exit(0);
    else if (command === "exit259") process.exit(259);
  });
  process.on("disconnect", () => process.exit(91));
  setTimeout(() => process.exit(92), 10000);
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-admission-test-"));
  const profile = path.join(root, "selected", "Markaloo");
  const records = path.join(root, "neutral-owner-records");
  const fixture = path.join(root, "fixture.js");
  fs.mkdirSync(records);
  fs.writeFileSync(fixture, `(${fixtureMain.toString()})().catch(error => { console.error(error); process.exit(1); });`);
  const owners = [];
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await child.closed;
    }
    for (const owner of owners) {
      owner.takeQueued();
      await owner.close();
    }
    fs.rmSync(root, { recursive: true });
  });
  const options = {
    canonicalProfilePath: profile, ownerRecordRoot: records,
    request: createStartupRequest({ args: ["fixture", "first.md"], cwd: root }),
    timeoutMs: 2000,
  };
  const owned = { root, profile, records, fixture, options };
  owned.paths = profileAdmissionPaths(options);
  owned.admit = async changes => {
    const result = await admitStartup({ ...options, ...changes });
    if (result.role === "primary") {
      owners.push(result.owner);
      result.owner.on("error", error => { throw error; });
    }
    return result;
  };
  owned.child = mode => {
    const child = spawn(process.execPath, [
      fixture, mode, modulePath, profile, records,
    ], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.closed = new Promise(resolve => child.once("close", (...args) => resolve(args)));
    children.push(child);
    return child;
  };
  owned.childOwner = async () => {
    const child = owned.child("owner");
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const [ready] = await Promise.race([
      once(child, "message"),
      child.closed.then(() => { throw new Error(`Fixture exited before readiness: ${stderr}`); }),
    ]);
    assert.equal(ready.status, "ready", stderr);
    assert.equal(ready.pid, child.pid);
    return child;
  };
  return owned;
}

test("import does not read/create profile, owner files, Electron or a pipe", t => {
  const owned = setup(t);
  const result = spawnSync(process.execPath, [
    owned.fixture, "import-only", modulePath, owned.profile, owned.records,
  ], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(NODE_PIN, "24.18.1");
  assert.deepEqual(fs.readdirSync(owned.records), []);
  assert.equal(fs.existsSync(owned.profile), false);
});

test("profile identity is stable before/after profile creation and case-insensitive", t => {
  const owned = setup(t);
  const original = profileAdmissionPaths(owned.options);
  fs.mkdirSync(owned.profile, { recursive: true });
  assert.deepEqual(profileAdmissionPaths(owned.options), original);
  const differentCase = profileAdmissionPaths({
    ...owned.options, canonicalProfilePath: owned.profile.toUpperCase(),
  });
  assert.equal(differentCase.pipePath, original.pipePath);
  assert.equal(differentCase.recordPath, original.recordPath);
  for (const name of ["Markaloo-Dev", "relocated-profile", "Folia"]) {
    const other = profileAdmissionPaths({
      ...owned.options, canonicalProfilePath: path.join(owned.root, name),
    });
    assert.notEqual(other.profileKey, original.profileKey);
    assert.notEqual(other.pipePath, original.pipePath);
  }
});

test("primary publishes a complete neutral owner record without creating a profile", async t => {
  const owned = setup(t);
  const result = await owned.admit();
  assert.equal(result.role, "primary");
  const record = JSON.parse(fs.readFileSync(owned.paths.recordPath, "utf8"));
  assert.deepEqual(record, {
    version: 1, profileKey: owned.paths.profileKey, pid: process.pid, nonce: result.owner.nonce,
  });
  assert.deepEqual(result.owner.takeQueued(), [owned.options.request]);
  assert.equal(fs.existsSync(owned.profile), false);
  await result.owner.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(owned.paths.recordPath, "utf8")), record);
});

test("pinned FIRST_PIPE_INSTANCE admits one primary; contender forwards unchanged args/cwd", async t => {
  const owned = setup(t);
  const { owner } = await owned.admit();
  owner.takeQueued();
  owner.setPhase("running");
  const request = createStartupRequest({
    args: ["Markaloo.exe", "--", "a file.md", "--not-an-admission-flag"],
    cwd: path.join(owned.root, "original-cwd"),
  });
  let queued = false;
  owner.once("queued", requestId => {
    assert.equal(requestId, request.requestId);
    assert.equal(owner.pendingCount(), 1);
    queued = true;
  });
  const contender = await owned.admit({ request });
  assert.equal(contender.role, "forwarded");
  assert.equal(contender.acknowledgement.status, "queued");
  assert.equal(contender.acknowledgement.requestId, request.requestId);
  assert.equal(contender.acknowledgement.ownerNonce, owner.nonce);
  assert.ok(queued, "ack followed actual queue insertion");
  assert.deepEqual(owner.takeQueued(), [request]);
  assert.equal(fs.existsSync(owned.profile), false);
});

test("same early queue accepts an Electron-style second-instance request as data", async t => {
  const owned = setup(t);
  const { owner } = await owned.admit();
  const request = createStartupRequest({ args: ["--open", "second.md"], cwd: owned.root });
  owner.enqueue(request);
  assert.deepEqual(owner.takeQueued(), [owned.options.request, request]);
  assert.ok(Object.isFrozen(request) && Object.isFrozen(request.args));
});

test("matching ambiguous retries are acknowledged once, even after explicit queue transfer", async t => {
  const owned = setup(t);
  const { owner } = await owned.admit();
  owner.takeQueued();
  const request = createStartupRequest({ args: ["retry.md"], cwd: owned.root });
  const forward = changes => forwardStartupRequest({
    paths: owned.paths, request, ownerNonce: owner.nonce, timeoutMs: 1000, ...changes,
  });
  await forward();
  await forward();
  assert.deepEqual(owner.takeQueued(), [request]);
  await forward();
  assert.deepEqual(owner.takeQueued(), []);
  await assert.rejects(forward({
    request: { ...request, args: ["different.md"] },
  }), { code: "ERR_ADMISSION_ID_CONFLICT" });
});

test("retry cannot silently cross an owner nonce", async t => {
  const owned = setup(t);
  const { owner } = await owned.admit();
  owner.takeQueued();
  const request = createStartupRequest({ args: ["retry.md"], cwd: owned.root });
  await assert.rejects(forwardStartupRequest({
    paths: owned.paths, request, ownerNonce: id(), timeoutMs: 1000,
  }), error => {
    assert.equal(error.code, "ERR_ADMISSION_OWNER_CHANGED");
    assert.equal(error.requestId, request.requestId);
    return true;
  });
  assert.equal(owner.pendingCount(), 0);
});

test("ambiguous retry with a bound old owner cannot become a fresh primary", async t => {
  const owned = setup(t);
  const { owner } = await owned.admit();
  owner.takeQueued();
  const record = fs.readFileSync(owned.paths.recordPath);
  await owner.close();
  await assert.rejects(owned.admit({ ownerNonce: owner.nonce }),
    { code: "ERR_ADMISSION_CONNECTION" });
  assert.deepEqual(fs.readFileSync(owned.paths.recordPath), record);
  assert.equal(fs.existsSync(owned.profile), false);
});

test("an independent Node fixture owns the pipe and receives the contender's queued request", async t => {
  const owned = setup(t);
  const child = await owned.childOwner();
  const record = fs.readFileSync(owned.paths.recordPath);
  const forwarded = await owned.admit();
  assert.equal(forwarded.role, "forwarded");
  assert.deepEqual(fs.readFileSync(owned.paths.recordPath), record);
  const taken = once(child, "message");
  child.send("take");
  assert.deepEqual((await taken)[0], { status: "taken", requests: [owned.options.request] });
  assert.equal(fs.existsSync(owned.profile), false);
});

for (const phase of ["migration", "closing"]) {
  test(`${phase} owner refuses matching pipe requests without silently queueing`, async t => {
    const owned = setup(t);
    const { owner } = await owned.admit();
    owner.takeQueued();
    owner.setPhase(phase);
    const request = createStartupRequest({ args: ["refuse.md"], cwd: owned.root });
    await assert.rejects(owned.admit({ request }), { code: "ERR_ADMISSION_BUSY" });
    assert.equal(owner.pendingCount(), 0);
    if (phase === "closing") {
      assert.throws(() => owner.setPhase("running"), { code: "ERR_ADMISSION_PHASE" });
    }
  });
}

test("queue capacity refuses explicitly and retains every accepted request", async t => {
  const owned = setup(t);
  const { owner } = await owned.admit();
  owner.takeQueued();
  const requests = Array.from({ length: MAX_QUEUE }, () =>
    createStartupRequest({ args: ["queued.md"], cwd: owned.root }));
  for (const request of requests) owner.enqueue(request);
  const retry = createStartupRequest({ args: ["later.md"], cwd: owned.root });
  assert.throws(() => owner.enqueue(retry), { code: "ERR_ADMISSION_QUEUE_FULL" });
  assert.deepEqual(owner.takeQueued(), requests);
  owner.enqueue(retry);
  assert.deepEqual(owner.takeQueued(), [retry]);
});

test("bounded dedupe never evicts accepted IDs and reopens an ambiguous request", async t => {
  const owned = setup(t);
  const { owner } = await owned.admit();
  owner.takeQueued();
  for (let index = 1; index < MAX_REQUESTS; index++) {
    owner.enqueue(createStartupRequest({ args: ["one.md"], cwd: owned.root }));
    owner.takeQueued();
  }
  assert.throws(() => owner.enqueue(createStartupRequest({
    args: ["overflow.md"], cwd: owned.root,
  })), { code: "ERR_ADMISSION_DEDUPE_FULL" });
  owner.enqueue(owned.options.request);
  assert.deepEqual(owner.takeQueued(), []);
});

test("close reports pending requests instead of dropping them; owner record survives", async t => {
  const owned = setup(t);
  const { owner } = await owned.admit();
  const record = fs.readFileSync(owned.paths.recordPath);
  assert.throws(() => owner.close(), { code: "ERR_ADMISSION_PENDING" });
  assert.deepEqual(owner.takeQueued(), [owned.options.request]);
  await owner.close();
  assert.deepEqual(fs.readFileSync(owned.paths.recordPath), record);
});

for (const bad of ["pid-zero", "pid-negative", "pid-string", "wrong-profile", "bad-nonce",
  "malformed", "unknown-field", "directory"]) {
  test(`invalid ${bad} owner record refuses without an OS query or replacement`, async t => {
    const owned = setup(t);
    const record = { version: 1, profileKey: owned.paths.profileKey, pid: process.pid, nonce: id() };
    if (bad === "pid-zero") record.pid = 0;
    if (bad === "pid-negative") record.pid = -1;
    if (bad === "pid-string") record.pid = String(process.pid);
    if (bad === "wrong-profile") record.profileKey = id();
    if (bad === "bad-nonce") record.nonce = "not-a-nonce";
    if (bad === "unknown-field") record.extra = true;
    if (bad === "directory") fs.mkdirSync(owned.paths.recordPath);
    else fs.writeFileSync(owned.paths.recordPath, bad === "malformed" ? "{" : JSON.stringify(record));
    const before = bad === "directory" ? null : fs.readFileSync(owned.paths.recordPath);
    let calls = 0;
    t.mock.method(process, "kill", () => {
      calls++;
      throw new Error("Invalid PID must never be queried");
    });
    await assert.rejects(owned.admit(), { code: "ERR_ADMISSION_OWNER_RECORD" });
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(owned.profile), false);
    if (before) assert.deepEqual(fs.readFileSync(owned.paths.recordPath), before);
    else assert.ok(fs.statSync(owned.paths.recordPath).isDirectory());
  });
}

for (const code of ["EPERM", "EACCES", "EINVAL"]) {
  test(`${code} is not evidence that the prior owned fixture PID exited`, async t => {
    const owned = setup(t);
    const record = JSON.stringify({
      version: 1, profileKey: owned.paths.profileKey, pid: process.pid, nonce: id(),
    });
    fs.writeFileSync(owned.paths.recordPath, record);
    let queried = false;
    t.mock.method(process, "kill", (pid, signal) => {
      assert.equal(pid, process.pid);
      assert.equal(signal, 0);
      queried = true;
      const error = new Error("Owned fixture query refusal");
      error.code = code;
      throw error;
    });
    await assert.rejects(owned.admit(), { code: "ERR_ADMISSION_OWNER_UNPROVEN" });
    assert.ok(queried);
    assert.equal(fs.readFileSync(owned.paths.recordPath, "utf8"), record);
    assert.equal(fs.existsSync(owned.profile), false);
  });
}

test("an early-closed pipe cannot bypass the actual prior process lifetime", async t => {
  const owned = setup(t);
  const child = await owned.childOwner();
  const original = fs.readFileSync(owned.paths.recordPath, "utf8");
  const pipeClosed = once(child, "message");
  child.send("close-pipe");
  assert.equal((await pipeClosed)[0].status, "pipe-closed");
  let witness;
  const checked = new Promise(resolve => { witness = resolve; });
  let checks = 0;
  const actualKill = process.kill;
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, child.pid);
    assert.equal(signal, 0);
    checks++;
    witness();
    return actualKill(pid, signal);
  });
  const pending = owned.admit();
  await checked;
  assert.equal(fs.readFileSync(owned.paths.recordPath, "utf8"), original);
  assert.equal(fs.existsSync(owned.profile), false);
  const exited = once(child, "close");
  child.send("exit");
  await exited;
  const { owner } = await pending;
  assert.ok(checks >= 2, "a live query alone did not authorize ownership");
  const current = JSON.parse(fs.readFileSync(owned.paths.recordPath, "utf8"));
  assert.equal(current.pid, process.pid);
  assert.notEqual(current.nonce, JSON.parse(original).nonce);
  assert.deepEqual(owner.takeQueued(), [owned.options.request]);
});

async function admittingOwner(t, changes = {}) {
  const owned = setup(t);
  const prior = await owned.childOwner();
  const original = fs.readFileSync(owned.paths.recordPath);
  const pipeClosed = once(prior, "message");
  prior.send("close-pipe");
  assert.equal((await pipeClosed)[0].status, "pipe-closed");
  const request = createStartupRequest({ args: ["waiting-open.md"], cwd: owned.root });
  let observed;
  const received = new Promise(resolve => { observed = resolve; });
  const createServer = net.createServer;
  let server;
  t.mock.method(net, "createServer", (...args) => {
    const candidate = createServer(...args);
    if (!server) server = candidate;
    candidate.on("connection", socket => {
      const chunks = [];
      socket.on("data", chunk => {
        chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        if (bytes.length >= 4 && bytes.length === bytes.readUInt32BE(0) + 4 &&
            packets(bytes)[0].requestId === request.requestId) observed(socket);
      });
    });
    return candidate;
  });
  let checked;
  const proofStarted = new Promise(resolve => { checked = resolve; });
  const kill = process.kill;
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, prior.pid);
    assert.equal(signal, 0);
    const result = kill(pid, signal);
    checked();
    return result;
  });
  const primary = owned.admit({ timeoutMs: 3000, ...changes })
    .then(result => ({ result }), error => ({ error }));
  await proofStarted;
  assert.ok(server.listening, "B bound its real pipe before querying live A");
  assert.deepEqual(fs.readFileSync(owned.paths.recordPath), original);
  let released;
  const release = () => {
    if (!released) released = (async () => {
      prior.send("exit");
      await prior.closed;
      return primary;
    })();
    return released;
  };
  return { owned, prior, original, request, received, server, primary, release };
}

test("ordinary C waits for bound B to publish after live A exits, then queues exactly once", async t => {
  const waiting = await admittingOwner(t);
  const { owned, request } = waiting;
  let outcome;
  const contender = owned.admit({ request, timeoutMs: 2000 })
    .then(result => (outcome = { result }), error => (outcome = { error }));
  try {
    await waiting.received;
    assert.deepEqual(fs.readFileSync(owned.paths.recordPath), waiting.original,
      "C sent its request while A still owned the durable record");
    assert.ok(!outcome?.result, "C received no early positive acknowledgement");
    const primary = await waiting.release();
    assert.equal(primary.error, undefined);
    const { owner } = primary.result;
    const forwarded = await contender;
    assert.equal(forwarded.error, undefined, forwarded.error?.stack);
    assert.equal(forwarded.result.role, "forwarded");
    assert.equal(forwarded.result.acknowledgement.ownerNonce, owner.nonce);
    assert.deepEqual(JSON.parse(fs.readFileSync(owned.paths.recordPath, "utf8")), {
      version: 1, profileKey: owned.paths.profileKey, pid: process.pid, nonce: owner.nonce,
    });
    assert.deepEqual(owner.takeQueued(), [owned.options.request, request],
      "B's initial queue setup preceded C's one insertion");
    await owned.admit({ request, ownerNonce: owner.nonce });
    assert.deepEqual(owner.takeQueued(), [], "the accepted identity was retained for retry");
  } finally {
    await waiting.release();
    await contender;
  }
});

test("waiting C deadline removes both the open and its unaccepted identity", async t => {
  const waiting = await admittingOwner(t);
  const { owned, request } = waiting;
  const contender = owned.admit({ request, timeoutMs: 100 })
    .then(result => ({ result }), error => ({ error }));
  try {
    const socket = await waiting.received;
    const closed = new Promise(resolve => socket.once("close", resolve));
    const outcome = await contender;
    assert.equal(outcome.error?.code, "ERR_ADMISSION_CONNECTION");
    assert.equal(outcome.error.cause?.code, "ERR_ADMISSION_TIMEOUT");
    await closed;
    assert.deepEqual(fs.readFileSync(owned.paths.recordPath), waiting.original);
    const primary = await waiting.release();
    assert.equal(primary.error, undefined);
    const { owner } = primary.result;
    assert.deepEqual(owner.takeQueued(), [owned.options.request]);
    const replacement = createStartupRequest({ ...request, args: ["after-deadline.md"] });
    owner.enqueue(replacement);
    assert.deepEqual(owner.takeQueued(), [replacement],
      "the expired request did not reserve an accepted-ID fingerprint");
  } finally {
    await waiting.release();
    await contender;
  }
});

for (const action of ["disconnect", "trailing-bytes"]) {
  test(`waiting C ${action} never inserts its request after publication`, async t => {
    const waiting = await admittingOwner(t);
    const { owned, request } = waiting;
    const connect = net.createConnection;
    let client;
    t.mock.method(net, "createConnection", (...args) => {
      client = connect(...args);
      return client;
    });
    const contender = owned.admit({ request })
      .then(result => ({ result }), error => ({ error }));
    try {
      const socket = await waiting.received;
      const closed = new Promise(resolve => socket.once("close", resolve));
      if (action === "disconnect") client.destroy();
      else client.write(Buffer.from([0]));
      const outcome = await contender;
      assert.equal(outcome.error?.code, action === "disconnect"
        ? "ERR_ADMISSION_CONNECTION" : "ERR_ADMISSION_PROTOCOL");
      await closed;
      const primary = await waiting.release();
      assert.equal(primary.error, undefined);
      const { owner } = primary.result;
      assert.deepEqual(owner.takeQueued(), [owned.options.request]);
      const replacement = createStartupRequest({ ...request, args: ["new-payload.md"] });
      owner.enqueue(replacement);
      assert.deepEqual(owner.takeQueued(), [replacement]);
    } finally {
      await waiting.release();
      await contender;
    }
  });
}

test("waiting C rechecks its absolute deadline after synchronous owner publication", async t => {
  const waiting = await admittingOwner(t);
  const { owned, request } = waiting;
  const now = performance.now.bind(performance);
  let published = false;
  t.mock.method(performance, "now", () => now() + (published ? 60000 : 0));
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (...args) => {
    const result = rename(...args);
    if (args[1] === owned.paths.recordPath) published = true;
    return result;
  });
  const contender = owned.admit({ request })
    .then(result => ({ result }), error => ({ error }));
  try {
    await waiting.received;
    const primary = await waiting.release();
    assert.equal(primary.error, undefined);
    assert.ok(published, "the owner record was actually renamed before the clock advanced");
    const outcome = await contender;
    assert.equal(outcome.error?.code, "ERR_ADMISSION_TIMEOUT",
      "the absolute check ran before the still-pending real timeout callback");
    const { owner } = primary.result;
    assert.deepEqual(owner.takeQueued(), [owned.options.request]);
    owner.enqueue(createStartupRequest({ ...request, args: ["not-expired-later.md"] }));
    assert.equal(owner.takeQueued().length, 1);
  } finally {
    await waiting.release();
    await contender;
  }
});

test("waiting C is settled when admission fails and the prior record stays unchanged", async t => {
  const waiting = await admittingOwner(t);
  const { owned, request } = waiting;
  const leftover = path.join(owned.records, `.${owned.paths.profileKey}.${id()}.tmp`);
  fs.writeFileSync(leftover, "owned interrupted-publication control");
  const contender = owned.admit({ request })
    .then(result => ({ result }), error => ({ error }));
  try {
    await waiting.received;
    const primary = await waiting.release();
    assert.equal(primary.error?.code, "ERR_ADMISSION_OWNER_LEFTOVER");
    const outcome = await contender;
    assert.equal(outcome.result, undefined);
    assert.equal(outcome.error?.code, "ERR_ADMISSION_PROTOCOL");
    assert.equal(outcome.error.ownerNonce?.length, 64);
    assert.deepEqual(fs.readFileSync(owned.paths.recordPath), waiting.original);
    assert.equal(fs.readFileSync(leftover, "utf8"), "owned interrupted-publication control");
    assert.equal(fs.existsSync(owned.profile), false);
  } finally {
    await waiting.release();
    await contender;
  }
});

test("listener failure settles waiting C and closing refuses another C before A exits", async t => {
  const waiting = await admittingOwner(t);
  const { owned, request } = waiting;
  const contender = owned.admit({ request })
    .then(result => ({ result }), error => ({ error }));
  try {
    await waiting.received;
    waiting.server.emit("error", new Error("Owned listener-failure control"));
    const outcome = await contender;
    assert.equal(outcome.error?.code, "ERR_ADMISSION_PIPE");
    await assert.rejects(owned.admit({
      request: createStartupRequest({ args: ["closing-refusal.md"], cwd: owned.root }),
    }), { code: "ERR_ADMISSION_BUSY" });
    assert.deepEqual(fs.readFileSync(owned.paths.recordPath), waiting.original);
    const primary = await waiting.release();
    assert.equal(primary.error?.code, "ERR_ADMISSION_PIPE");
    assert.deepEqual(fs.readFileSync(owned.paths.recordPath), waiting.original);
  } finally {
    await waiting.release();
    await contender;
  }
});

test("migration intent refuses C immediately while B still waits for live A", async t => {
  const waiting = await admittingOwner(t, { initialPhase: "migration" });
  const { owned, request } = waiting;
  const contender = owned.admit({ request })
    .then(result => ({ result }), error => ({ error }));
  try {
    await waiting.received;
    const outcome = await contender;
    assert.equal(outcome.error?.code, "ERR_ADMISSION_BUSY");
    assert.deepEqual(fs.readFileSync(owned.paths.recordPath), waiting.original);
    const primary = await waiting.release();
    assert.equal(primary.error, undefined);
    const { owner } = primary.result;
    assert.deepEqual(owner.takeQueued(), [owned.options.request]);
    assert.throws(() => owner.enqueue(request), { code: "ERR_ADMISSION_BUSY" });
  } finally {
    await waiting.release();
    await contender;
  }
});

test("waiting requests stay within the listener cap and are queued once after publication", async t => {
  const waiting = await admittingOwner(t);
  const { owned, server } = waiting;
  assert.ok(server.maxConnections > 0 && server.maxConnections <= MAX_QUEUE);
  const requests = Array.from({ length: server.maxConnections }, () =>
    createStartupRequest({ args: ["bounded-wait.md"], cwd: owned.root }));
  const arrivals = new Set();
  let observed;
  const received = new Promise(resolve => { observed = resolve; });
  server.on("connection", socket => {
    const chunks = [];
    socket.on("data", chunk => {
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (bytes.length >= 4 && bytes.length === bytes.readUInt32BE(0) + 4) {
        arrivals.add(packets(bytes)[0].requestId);
        if (arrivals.size === requests.length) observed();
      }
    });
  });
  const contenders = requests.map(request => forwardStartupRequest({
    paths: owned.paths, request, timeoutMs: 2000,
  }).then(result => ({ result }), error => ({ error })));
  try {
    await received;
    const count = await new Promise((resolve, reject) =>
      server.getConnections((error, count) => error ? reject(error) : resolve(count)));
    assert.equal(count, server.maxConnections, "every allowed socket contains a full waiting request");
    await assert.rejects(forwardStartupRequest({
      paths: owned.paths, request: waiting.request, timeoutMs: 1000,
    }), { code: "ERR_ADMISSION_PROTOCOL" });
    const primary = await waiting.release();
    assert.equal(primary.error, undefined);
    const outcomes = await Promise.all(contenders);
    assert.ok(outcomes.every(outcome => !outcome.error && outcome.result.status === "queued"));
    const queue = primary.result.owner.takeQueued();
    assert.deepEqual(queue[0], owned.options.request);
    assert.equal(queue.length, requests.length + 1);
    assert.deepEqual(new Set(queue.slice(1).map(item => item.requestId)),
      new Set(requests.map(item => item.requestId)));
  } finally {
    await waiting.release();
    await Promise.all(contenders);
  }
});

test("live prior owned PID times out asynchronously and retains its exact record", async t => {
  const owned = setup(t);
  const { owner } = await owned.admit();
  owner.takeQueued();
  await owner.close();
  const record = fs.readFileSync(owned.paths.recordPath);
  let queries = 0;
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const actualKill = process.kill;
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, process.pid);
    assert.equal(signal, 0);
    queries++;
    return actualKill(pid, signal);
  });
  await assert.rejects(owned.admit({ timeoutMs: 100 }), { code: "ERR_ADMISSION_OWNER_BUSY" });
  assert.ok(queries > 1 && yielded);
  assert.deepEqual(fs.readFileSync(owned.paths.recordPath), record);
});

test("actual Windows Node fixture exit status 259 is still witnessed as absent", async t => {
  const owned = setup(t);
  const child = await owned.childOwner();
  const closed = once(child, "close");
  child.send("exit259");
  const [code] = await closed;
  assert.equal(code, 259);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  const actualKill = process.kill;
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, child.pid);
    assert.equal(signal, 0);
    return actualKill(pid, signal);
  });
  const { owner } = await owned.admit();
  owner.takeQueued();
  assert.equal(JSON.parse(fs.readFileSync(owned.paths.recordPath, "utf8")).pid, process.pid);
});

test("owner-record publication is complete/atomic and stale temp work is preserved", async t => {
  const owned = setup(t);
  const stale = path.join(owned.records, `.${owned.paths.profileKey}.${id()}.tmp`);
  fs.writeFileSync(stale, "preserve interrupted publication");
  await assert.rejects(owned.admit(), error => {
    assert.equal(error.code, "ERR_ADMISSION_OWNER_LEFTOVER");
    assert.deepEqual(error.preservedPaths, [stale]);
    return true;
  });
  assert.equal(fs.existsSync(owned.paths.recordPath), false);
  assert.equal(fs.readFileSync(stale, "utf8"), "preserve interrupted publication");
  assert.equal(fs.existsSync(owned.profile), false);
});

test("actual Node exit during atomic publication preserves prior record and refuses unchanged retries", async t => {
  const owned = setup(t);
  const prior = await owned.childOwner();
  const priorClosed = once(prior, "close");
  prior.send("exit");
  await priorClosed;
  const record = fs.readFileSync(owned.paths.recordPath);
  const interrupted = owned.child("interrupt-publication");
  assert.equal((await once(interrupted, "close"))[0], 0);
  assert.deepEqual(fs.readFileSync(owned.paths.recordPath), record);
  const names = fs.readdirSync(owned.records).filter(name => name.endsWith(".tmp"));
  assert.equal(names.length, 1, "interruption really left unpublished owner work");
  const temporary = path.join(owned.records, names[0]);
  const bytes = fs.readFileSync(temporary);
  assert.equal(JSON.parse(bytes).pid, interrupted.pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(owned.admit(), { code: "ERR_ADMISSION_OWNER_LEFTOVER" });
    assert.deepEqual(fs.readFileSync(owned.paths.recordPath), record);
    assert.deepEqual(fs.readFileSync(temporary), bytes);
  }
  assert.equal(fs.existsSync(owned.profile), false);
});

test("a record changed after actual prior PID exit proof is not overwritten", async t => {
  const owned = setup(t);
  const child = await owned.childOwner();
  const closed = once(child, "close");
  child.send("exit");
  await closed;
  const replacement = JSON.stringify({
    version: 1, profileKey: owned.paths.profileKey, pid: process.pid, nonce: id(),
  });
  const actualKill = process.kill;
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, child.pid);
    assert.equal(signal, 0);
    try { return actualKill(pid, signal); } catch (error) {
      assert.equal(error.code, "ESRCH");
      fs.writeFileSync(owned.paths.recordPath, replacement);
      throw error;
    }
  });
  await assert.rejects(owned.admit(), { code: "ERR_ADMISSION_OWNER_CHANGED" });
  assert.equal(fs.readFileSync(owned.paths.recordPath, "utf8"), replacement);
  assert.equal(fs.readdirSync(owned.records).filter(name => name.endsWith(".tmp")).length, 0);
});

async function fakePeer(t, owned, handler) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    handler(socket);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(owned.paths.pipePath, resolve);
  });
}

for (const bad of ["wrong-id", "duplicate", "truncated"]) {
  test(`${bad} acknowledgement cannot count as queue acceptance`, async t => {
    const owned = setup(t);
    const nonce = id();
    await fakePeer(t, owned, socket => {
      socket.write(frame({
        version: 1, kind: "hello", profileKey: owned.paths.profileKey, nonce,
      }));
      const chunks = [];
      socket.on("data", chunk => {
        chunks.push(chunk);
        const received = Buffer.concat(chunks);
        if (received.length < 4 || received.length < received.readUInt32BE(0) + 4) return;
        const request = packets(Buffer.concat(chunks))[0];
        const reply = frame({
          version: 1, profileKey: owned.paths.profileKey, nonce,
          requestId: bad === "wrong-id" ? id() : request.requestId,
          status: "queued", code: null,
        });
        socket.end(bad === "duplicate" ? Buffer.concat([reply, reply]) :
          bad === "truncated" ? reply.subarray(0, 7) : reply);
      });
    });
    await assert.rejects(owned.admit(), { code: "ERR_ADMISSION_PROTOCOL" });
    assert.deepEqual(fs.readdirSync(owned.records), []);
    assert.equal(fs.existsSync(owned.profile), false);
  });
}

test("a trickling peer cannot extend the absolute forwarding deadline", async t => {
  const owned = setup(t);
  const timers = [];
  t.after(() => timers.forEach(clearInterval));
  await fakePeer(t, owned, socket => {
    socket.write(Buffer.from([0, 0, 1, 0]));
    timers.push(setInterval(() => { if (!socket.destroyed) socket.write(Buffer.from([32])); }, 15));
  });
  const started = performance.now();
  await assert.rejects(owned.admit({ timeoutMs: 100 }), { code: "ERR_ADMISSION_CONNECTION" });
  assert.ok(performance.now() - started < 1500);
  assert.deepEqual(fs.readdirSync(owned.records), []);
});

test("trailing or malformed request bytes cannot be queued", async t => {
  const owned = setup(t);
  const { owner } = await owned.admit();
  owner.takeQueued();
  const socket = net.createConnection({ path: owned.paths.pipePath, allowHalfOpen: true });
  const chunks = [];
  socket.on("data", chunk => chunks.push(chunk));
  const ended = once(socket, "end");
  const request = createStartupRequest({ args: ["do-not-queue.md"], cwd: owned.root });
  const invalid = frame({
    version: 1, profileKey: owned.paths.profileKey, nonce: owner.nonce, ...request,
  });
  invalid.writeUInt32BE(invalid.length - 4 + 5);
  socket.write(Buffer.concat([invalid, Buffer.from("extra")]));
  await ended;
  const responses = packets(Buffer.concat(chunks));
  assert.equal(responses[1].status, "refused");
  assert.equal(owner.pendingCount(), 0);
  socket.destroy();
});

for (const malformed of ["wrong-nonce", "wrong-profile", "non-utf8", "oversize", "duplicate"]) {
  test(`${malformed} request is refused without replacing record or queueing`, async t => {
    const owned = setup(t);
    const { owner } = await owned.admit();
    owner.takeQueued();
    const record = fs.readFileSync(owned.paths.recordPath);
    const request = createStartupRequest({ args: ["refuse.md"], cwd: owned.root });
    const value = {
      version: 1, profileKey: owned.paths.profileKey, nonce: owner.nonce, ...request,
    };
    if (malformed === "wrong-nonce") value.nonce = id();
    if (malformed === "wrong-profile") value.profileKey = id();
    let bytes = frame(value);
    if (malformed === "non-utf8") bytes = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
    if (malformed === "oversize") {
      bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(0x7fffffff);
    }
    if (malformed === "duplicate") bytes = Buffer.concat([bytes, bytes]);
    const socket = net.createConnection({ path: owned.paths.pipePath, allowHalfOpen: true });
    socket.on("error", () => {});
    t.after(() => socket.destroy());
    const chunks = [];
    socket.on("data", chunk => chunks.push(chunk));
    const ended = once(socket, "end");
    socket.write(bytes);
    await ended;
    const responses = packets(Buffer.concat(chunks));
    assert.equal(responses[1].status, "refused");
    assert.equal(owner.pendingCount(), 0);
    assert.deepEqual(fs.readFileSync(owned.paths.recordPath), record);
    socket.destroy();
  });
}

test("an incomplete trickling request cannot extend the owner's absolute deadline", async t => {
  const owned = setup(t);
  const { owner } = await owned.admit({ timeoutMs: 100 });
  owner.takeQueued();
  let observedTimeout = false;
  owner.on("client-error", error => {
    if (error.code === "ERR_ADMISSION_TIMEOUT" || error.cause?.code === "ERR_ADMISSION_TIMEOUT") {
      observedTimeout = true;
    }
  });
  const socket = net.createConnection({ path: owned.paths.pipePath, allowHalfOpen: true });
  socket.resume();
  const ended = new Promise((resolve, reject) => {
    socket.once("end", () => resolve());
    socket.once("close", () => resolve());
    socket.on("error", error => error.code === "EPIPE" ? resolve() : reject(error));
  });
  socket.write(Buffer.from([0, 0, 1, 0]));
  const timer = setInterval(() => {
    if (!socket.destroyed) socket.write(Buffer.from([32]));
  }, 15);
  t.after(() => { clearInterval(timer); socket.destroy(); });
  const started = performance.now();
  await ended;
  assert.ok(performance.now() - started < 1500);
  assert.ok(observedTimeout, "the owner actually detected its request deadline");
  assert.equal(owner.pendingCount(), 0);
});

test("lost acknowledgement is safely retried without a second queue entry", async t => {
  const owned = setup(t);
  const { owner } = await owned.admit();
  owner.takeQueued();
  const request = createStartupRequest({ args: ["ambiguous.md"], cwd: owned.root });
  const socket = net.createConnection({ path: owned.paths.pipePath, allowHalfOpen: true });
  socket.on("error", () => {});
  socket.resume();
  const closed = once(socket, "close");
  owner.once("queued", requestId => {
    assert.equal(requestId, request.requestId);
    socket.destroy();
  });
  socket.write(frame({
    version: 1, profileKey: owned.paths.profileKey, nonce: owner.nonce, ...request,
  }));
  await closed;
  assert.equal(owner.pendingCount(), 1, "lost ack followed actual queue insertion");
  const forwarded = await owned.admit({ request, ownerNonce: owner.nonce });
  assert.equal(forwarded.role, "forwarded");
  assert.deepEqual(owner.takeQueued(), [request]);
});

test("ambiguous profile/metadata paths and unbounded requests fail explicitly", t => {
  const owned = setup(t);
  assert.throws(() => profileAdmissionPaths({
    ...owned.options, canonicalProfilePath: "relative\\profile",
  }), { code: "ERR_ADMISSION_PROFILE" });
  assert.throws(() => profileAdmissionPaths({
    ...owned.options, ownerRecordRoot: path.join(owned.profile, "owners"),
  }), { code: "ERR_ADMISSION_METADATA" });
  for (const suffix of [".", " ", ":stream"]) {
    assert.throws(() => profileAdmissionPaths({
      ...owned.options, canonicalProfilePath: owned.profile + suffix,
    }), { code: "ERR_ADMISSION_PROFILE" });
  }
  assert.throws(() => createStartupRequest({ args: ["x".repeat(300000)], cwd: owned.root }),
    { code: "ERR_ADMISSION_PROTOCOL" });
  const maximum = { requestId: id(), args: [""], cwd: owned.root };
  maximum.args[0] = "x".repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(maximum)) - 1);
  assert.ok(Buffer.byteLength(JSON.stringify(maximum)) < 256 * 1024);
  assert.throws(() => createStartupRequest(maximum), { code: "ERR_ADMISSION_PROTOCOL" },
    "the transport envelope must also fit before queueing or installing a response reader");
  assert.throws(() => createStartupRequest({ args: ["a\0b"], cwd: owned.root }),
    { code: "ERR_ADMISSION_REQUEST" });
});
