"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const NODE_PIN = "24.18.1";
const MAX_PACKET = 256 * 1024;
const MAX_QUEUE = 64;
const MAX_REQUESTS = 1024;
const TOKEN = /^[a-f0-9]{64}$/;

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function requireCondition(condition, code, message) {
  if (!condition) throw failure(code, message);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function token() {
  return crypto.randomBytes(32).toString("hex");
}

function canonicalProfile(profile) {
  requireCondition(typeof profile === "string" && !profile.includes("\0") &&
    path.win32.isAbsolute(profile) &&
    /^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/i.test(profile) &&
    !profile.startsWith("\\\\?\\") && !profile.startsWith("\\\\.\\") &&
    path.win32.normalize(profile) === profile &&
    profile.split("\\").every((part, index) =>
      !/[. ]$/.test(part) && !/[<>"|?*]/.test(part) &&
      (!part.includes(":") || (index === 0 && /^[a-z]:$/i.test(part)))),
  "ERR_ADMISSION_PROFILE", "Expected an explicitly selected canonical Windows profile");
  const root = path.win32.parse(profile).root;
  return (profile.length > root.length ? profile.replace(/\\$/, "") : profile).toLowerCase();
}

// Selection/canonical resolution belongs to the caller. Never inspect a profile
// or choose a changing nearest-existing ancestor to derive either gate identity.
function profileAdmissionPaths({ canonicalProfilePath, ownerRecordRoot }) {
  const profile = canonicalProfile(canonicalProfilePath);
  requireCondition(typeof ownerRecordRoot === "string" &&
    path.isAbsolute(ownerRecordRoot) && path.resolve(ownerRecordRoot) === ownerRecordRoot,
  "ERR_ADMISSION_METADATA", "Expected a stable absolute owner-record directory");
  const relative = path.win32.relative(profile, ownerRecordRoot);
  requireCondition(relative !== "" && (relative === ".." ||
    relative.startsWith("..\\") || path.win32.isAbsolute(relative)),
  "ERR_ADMISSION_METADATA", "Owner metadata must be outside the selected profile");
  const profileKey = crypto.createHash("sha256").update(profile, "utf8").digest("hex");
  return Object.freeze({
    profileKey,
    pipePath: `\\\\.\\pipe\\profile-startup-v1-${profileKey}`,
    recordPath: path.join(ownerRecordRoot, `${profileKey}.json`),
    ownerRecordRoot,
  });
}

function createStartupRequest({ args, cwd, requestId = token() }) {
  requireCondition(typeof requestId === "string" && TOKEN.test(requestId) &&
    Array.isArray(args) && args.length <= 4096 &&
    args.every(arg => typeof arg === "string" && !arg.includes("\0")) &&
    typeof cwd === "string" && path.win32.isAbsolute(cwd) && !cwd.includes("\0"),
  "ERR_ADMISSION_REQUEST", "Invalid startup request arguments, directory or identity");
  const request = Object.freeze({ requestId, args: Object.freeze([...args]), cwd });
  encode({ version: 1, profileKey: "0".repeat(64), nonce: "0".repeat(64), ...request });
  return request;
}

function encode(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  requireCondition(body.length > 0 && body.length <= MAX_PACKET,
    "ERR_ADMISSION_PROTOCOL", "The startup packet exceeds its bound");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function decode(buffer) {
  requireCondition(buffer.length >= 4 && buffer.readUInt32BE(0) > 0 &&
    buffer.readUInt32BE(0) <= MAX_PACKET &&
    buffer.length === 4 + buffer.readUInt32BE(0),
  "ERR_ADMISSION_PROTOCOL", "Missing, trailing or incomplete startup packet");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4)));
  } catch {
    throw failure("ERR_ADMISSION_PROTOCOL", "Malformed startup packet");
  }
}

function readPacket(socket, untilEnd) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      socket.pause();
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error) reject(error);
      else {
        try { resolve(decode(Buffer.concat(chunks))); } catch (error) { reject(error); }
      }
    };
    const onData = chunk => {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > MAX_PACKET + 4) {
        finish(failure("ERR_ADMISSION_PROTOCOL", "The startup packet exceeds its bound"));
      } else if (!untilEnd && bytes >= 4) {
        const joined = Buffer.concat(chunks);
        if (joined.readUInt32BE(0) > MAX_PACKET || bytes >= 4 + joined.readUInt32BE(0)) finish();
      }
    };
    const onEnd = () => finish();
    const onClose = () => finish(failure("ERR_ADMISSION_CONNECTION",
      "The startup pipe closed without a complete response"));
    const onError = error => finish(failure("ERR_ADMISSION_CONNECTION",
      "The startup pipe failed", error));
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onClose);
    socket.once("error", onError);
    socket.resume();
  });
}

function boundedTimeout(value) {
  requireCondition(Number.isSafeInteger(value) && value > 0 && value <= 60000,
    "ERR_ADMISSION_OPTIONS", "Startup admission needs a bounded positive timeout");
  return value;
}

function verifyRecordRoot(root) {
  const stat = fs.lstatSync(root);
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink() &&
    path.relative(root, fs.realpathSync.native(root)) === "",
  "ERR_ADMISSION_METADATA", "The owner-record directory is redirected");
}

function readOwnerRecord(paths) {
  let stat;
  try {
    stat = fs.lstatSync(paths.recordPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw failure("ERR_ADMISSION_OWNER_RECORD", "The owner record cannot be inspected", error);
  }
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 4096,
    "ERR_ADMISSION_OWNER_RECORD", "The owner record is not a bounded regular file");
  const text = fs.readFileSync(paths.recordPath, "utf8");
  let value;
  try { value = JSON.parse(text); } catch {
    throw failure("ERR_ADMISSION_OWNER_RECORD", "The owner record is malformed");
  }
  requireCondition(exactKeys(value, ["version", "profileKey", "pid", "nonce"]) &&
    value.version === 1 && value.profileKey === paths.profileKey &&
    Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 0x7fffffff &&
    typeof value.nonce === "string" && TOKEN.test(value.nonce),
  "ERR_ADMISSION_OWNER_RECORD", "The owner record has an invalid process/profile binding");
  return { text, value };
}

async function provePreviousExit(record, timeoutMs) {
  if (!record) return;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      // On pinned Windows Node, signal 0 does not terminate. Only ESRCH proves
      // absence; permissions, PID reuse and a live process all remain refusals.
      process.kill(record.value.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw failure("ERR_ADMISSION_OWNER_UNPROVEN",
        "Previous owner exit could not be proven; its record was preserved", error);
    }
    const remaining = deadline - performance.now();
    requireCondition(remaining > 0, "ERR_ADMISSION_OWNER_BUSY",
      "The previous owner process is still present; its record was preserved");
    await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
  }
}

function publishOwner(paths, previous, nonce) {
  verifyRecordRoot(paths.ownerRecordRoot);
  const prefix = `.${paths.profileKey}.`;
  const leftovers = fs.readdirSync(paths.ownerRecordRoot)
    .filter(name => name.toLowerCase().startsWith(prefix) && name.toLowerCase().endsWith(".tmp"))
    .map(name => path.join(paths.ownerRecordRoot, name));
  if (leftovers.length) {
    const error = failure("ERR_ADMISSION_OWNER_LEFTOVER",
      `Owner-record work needs manual inspection: ${leftovers.join(", ")}`);
    error.preservedPaths = leftovers;
    throw error;
  }
  const current = readOwnerRecord(paths);
  requireCondition(current?.text === previous?.text, "ERR_ADMISSION_OWNER_CHANGED",
    "The prior owner record changed during admission");
  const temporary = path.join(paths.ownerRecordRoot, `${prefix}${nonce}.tmp`);
  const data = JSON.stringify({ version: 1, profileKey: paths.profileKey, pid: process.pid, nonce });
  const fd = fs.openSync(temporary, "wx", 0o600);
  let primary;
  try {
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    primary = error;
  } finally {
    try { fs.closeSync(fd); } catch (error) {
      primary = primary ? new AggregateError([primary, error], "Owner write and close failed") : error;
    }
  }
  if (primary) throw failure("ERR_ADMISSION_OWNER_WRITE",
    `Owner publication failed; preserve ${temporary}`, primary);
  requireCondition(readOwnerRecord(paths)?.text === previous?.text,
    "ERR_ADMISSION_OWNER_CHANGED", "The prior owner record changed before publication");
  fs.renameSync(temporary, paths.recordPath);
  requireCondition(fs.readFileSync(paths.recordPath, "utf8") === data,
    "ERR_ADMISSION_OWNER_WRITE", "The complete owner record could not be verified");
}

async function forwardStartupRequest({
  paths, request, ownerNonce, timeoutMs = 5000,
}) {
  boundedTimeout(timeoutMs);
  request = createStartupRequest(request);
  requireCondition(ownerNonce === undefined ||
    (typeof ownerNonce === "string" && TOKEN.test(ownerNonce)),
  "ERR_ADMISSION_REQUEST", "Invalid retry owner binding");
  const socket = net.createConnection({ path: paths.pipePath, allowHalfOpen: true });
  // Keep the readable/error reader installed before a connection can fail.
  const helloPromise = readPacket(socket, false);
  const deadline = setTimeout(() => socket.destroy(failure("ERR_ADMISSION_TIMEOUT",
    "The startup forwarding deadline expired")), timeoutMs);
  let nonce = ownerNonce;
  try {
    const hello = await helloPromise;
    requireCondition(exactKeys(hello, ["version", "kind", "profileKey", "nonce"]) &&
      hello.version === 1 && hello.kind === "hello" &&
      hello.profileKey === paths.profileKey &&
      typeof hello.nonce === "string" && TOKEN.test(hello.nonce),
    "ERR_ADMISSION_PROTOCOL", "The startup owner greeting is invalid");
    requireCondition(!nonce || nonce === hello.nonce, "ERR_ADMISSION_OWNER_CHANGED",
      "A retry reached a different owner; the request was not resent");
    nonce = hello.nonce;
    const packet = encode({ version: 1, profileKey: paths.profileKey, nonce, ...request });
    const responsePromise = readPacket(socket, true);
    // Windows named pipes do not provide TCP-style request half-close.
    // Read one framed request; only the owner closes after its acknowledgement.
    socket.write(packet);
    const response = await responsePromise;
    requireCondition(exactKeys(response,
      ["version", "profileKey", "nonce", "requestId", "status", "code"]) &&
      response.version === 1 && response.profileKey === paths.profileKey &&
      response.nonce === nonce && response.requestId === request.requestId,
    "ERR_ADMISSION_PROTOCOL", "The startup acknowledgement is not request-bound");
    requireCondition(response.status === "queued" && response.code === null,
      typeof response.code === "string" && /^ERR_ADMISSION_[A-Z_]+$/.test(response.code)
        ? response.code : "ERR_ADMISSION_PROTOCOL",
    "The startup owner refused the request");
    return Object.freeze({ requestId: request.requestId, ownerNonce: nonce, status: "queued" });
  } catch (error) {
    error.requestId = request.requestId;
    if (nonce) error.ownerNonce = nonce;
    throw error;
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
}

async function admitStartup({
  canonicalProfilePath, ownerRecordRoot, request, initialPhase = "starting",
  timeoutMs = 5000, ownerNonce,
}) {
  requireCondition(process.platform === "win32" && process.versions.node === NODE_PIN,
    "ERR_ADMISSION_RUNTIME", "Startup ownership needs the reviewed Windows Node pin");
  boundedTimeout(timeoutMs);
  requireCondition(["starting", "migration"].includes(initialPhase),
    "ERR_ADMISSION_OPTIONS", "Invalid startup admission options");
  const paths = profileAdmissionPaths({ canonicalProfilePath, ownerRecordRoot });
  request = createStartupRequest(request);
  // An ambiguous retry must never acquire a new owner and reopen its old request.
  if (ownerNonce !== undefined) {
    const acknowledgement = await forwardStartupRequest({ paths, request, ownerNonce, timeoutMs });
    return { role: "forwarded", acknowledgement };
  }
  const owner = new EventEmitter();
  const nonce = token();
  const queue = [];
  const accepted = new Map();
  const sockets = new Set();
  const waiters = new Set();
  let phase = "admitting";
  let admitted = false;
  let closing;
  let gateError;
  const settleWaiters = error => {
    for (const finish of waiters) finish(error);
  };
  const waitForAdmission = socket => new Promise((resolve, reject) => {
    requireCondition(waiters.size < MAX_QUEUE, "ERR_ADMISSION_QUEUE_FULL",
      "The startup admission waiting limit is full");
    const finish = error => {
      if (!waiters.delete(finish)) return;
      socket.pause();
      socket.off("data", onData);
      socket.off("end", onDisconnect);
      socket.off("close", onDisconnect);
      socket.off("error", finish);
      if (error) reject(error);
      else resolve();
    };
    const onData = () => finish(failure("ERR_ADMISSION_PROTOCOL",
      "Unexpected bytes followed the waiting startup request"));
    const onDisconnect = () => {
      finish(failure("ERR_ADMISSION_CONNECTION", "The waiting startup client disconnected"));
      socket.destroy();
    };
    waiters.add(finish);
    socket.on("data", onData);
    socket.once("end", onDisconnect);
    socket.once("close", onDisconnect);
    socket.once("error", finish);
    socket.resume();
  });
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", error => owner.emit("client-error", error));
    const expiresAt = performance.now() + timeoutMs;
    const deadline = setTimeout(() => socket.destroy(failure("ERR_ADMISSION_TIMEOUT",
      "The startup request deadline expired")), timeoutMs);
    socket.once("close", () => clearTimeout(deadline));
    const incoming = readPacket(socket, false);
    socket.write(encode({ version: 1, kind: "hello", profileKey: paths.profileKey, nonce }));
    const serve = async () => {
      let value;
      let response;
      try {
        value = await incoming;
        requireCondition(exactKeys(value,
          ["version", "profileKey", "nonce", "requestId", "args", "cwd"]) &&
          value.version === 1 && value.profileKey === paths.profileKey && value.nonce === nonce,
        "ERR_ADMISSION_PROTOCOL", "The startup request has a different owner/profile binding");
        const item = createStartupRequest(value);
        requireCondition(!socket.destroyed && !socket.readableEnded,
          "ERR_ADMISSION_CONNECTION", "The startup client disconnected before queueing");
        if (!admitted && phase === "admitting" && initialPhase === "starting") {
          // Retain only this bounded connection, not an accepted ID or queued open.
          await waitForAdmission(socket);
        }
        requireCondition(performance.now() < expiresAt, "ERR_ADMISSION_TIMEOUT",
          "The startup request deadline expired before queueing");
        requireCondition(!socket.destroyed && !socket.readableEnded && !socket.writableEnded,
          "ERR_ADMISSION_CONNECTION", "The startup client disconnected before queueing");
        owner.enqueue(item);
        response = { status: "queued", code: null };
      } catch (error) {
        owner.emit("client-error", error);
        response = { status: "refused", code: /^ERR_ADMISSION_[A-Z_]+$/.test(error.code)
          ? error.code : "ERR_ADMISSION_PROTOCOL" };
      }
      if (!socket.destroyed && !socket.readableEnded) socket.end(encode({
        version: 1, profileKey: paths.profileKey, nonce,
        requestId: typeof value?.requestId === "string" ? value.requestId : null, ...response,
      }));
    };
    void serve().catch(error => {
      owner.emit("client-error", error);
      socket.destroy();
    });
  });
  server.maxConnections = 32;
  server.on("error", error => {
    gateError = failure("ERR_ADMISSION_PIPE", "The profile admission listener failed", error);
    phase = "closing";
    settleWaiters(gateError);
    if (admitted) owner.emit("error", gateError);
  });
  owner.paths = paths;
  owner.nonce = nonce;
  owner.enqueue = value => {
    requireCondition(admitted && phase !== "migration" && phase !== "closing" && !gateError,
      "ERR_ADMISSION_BUSY", "The startup owner is not accepting open requests");
    const item = createStartupRequest(value);
    const fingerprint = crypto.createHash("sha256")
      .update(JSON.stringify(item)).digest("hex");
    if (accepted.has(item.requestId)) {
      requireCondition(accepted.get(item.requestId) === fingerprint,
        "ERR_ADMISSION_ID_CONFLICT", "A request identity was reused with different arguments");
      return item.requestId;
    }
    requireCondition(queue.length < MAX_QUEUE, "ERR_ADMISSION_QUEUE_FULL", "The startup queue is full");
    // Do not evict accepted IDs: an ambiguous retry must never become a second open.
    requireCondition(accepted.size < MAX_REQUESTS, "ERR_ADMISSION_DEDUPE_FULL",
      "The owner cannot retain another startup request identity");
    queue.push(item);
    accepted.set(item.requestId, fingerprint);
    owner.emit("queued", item.requestId);
    return item.requestId;
  };
  owner.takeQueued = () => queue.splice(0);
  owner.pendingCount = () => queue.length;
  owner.setPhase = next => {
    requireCondition(admitted && ["starting", "running", "migration", "closing"].includes(next) &&
      (phase !== "closing" || next === "closing"),
    "ERR_ADMISSION_PHASE", "Invalid or irreversible startup phase change");
    phase = next;
  };
  owner.close = () => {
    phase = "closing";
    requireCondition(queue.length === 0, "ERR_ADMISSION_PENDING",
      "Queued requests must be explicitly taken before closing admission");
    if (!closing) closing = new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      for (const socket of sockets) socket.destroy();
    });
    // The durable owner record deliberately survives pipe close and process quit.
    return closing;
  };
  try {
    await new Promise((resolve, reject) => {
      const onError = error => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      // Pinned Node/libuv uses FIRST_PIPE_INSTANCE for this Windows bind.
      server.listen({ path: paths.pipePath, exclusive: true });
    });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw failure("ERR_ADMISSION_PIPE", "Cannot bind admission pipe", error);
    const acknowledgement = await forwardStartupRequest({ paths, request, timeoutMs });
    return { role: "forwarded", acknowledgement };
  }
  try {
    verifyRecordRoot(ownerRecordRoot);
    const previous = readOwnerRecord(paths);
    await provePreviousExit(previous, timeoutMs);
    requireCondition(!gateError, "ERR_ADMISSION_PIPE", "Admission listener failed during ownership proof");
    publishOwner(paths, previous, nonce);
    admitted = true;
    // The first launch uses the same queue as pipe/Electron second-instance opens.
    phase = "starting";
    owner.enqueue(request);
    phase = initialPhase;
    settleWaiters();
    return { role: "primary", owner };
  } catch (error) {
    phase = "closing";
    settleWaiters(error);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
}

module.exports = {
  NODE_PIN, MAX_QUEUE, MAX_REQUESTS,
  profileAdmissionPaths, createStartupRequest, forwardStartupRequest, admitStartup,
};
