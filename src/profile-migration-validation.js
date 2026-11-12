"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  probeDisposableLocalStorage,
  validatePersistedSettings,
  verifySupportedLocalStorage,
} = require("./profile-migration-probe");

const CHILD_ARGUMENT = "--markaloo-profile-validation-child";
const WORK_PREFIX = ".markaloo-probe-";
const OWNER_FILE = "probe-owner.json";
const DATABASE_FILE = /^(?:CURRENT|MANIFEST-\d+|\d+\.(?:log|ldb|sst))$/;
const DIAGNOSTIC_FILE = /^(?:LOCK|LOG(?:\.old(?:\.\d+)?)?)$/;
const MAX_FILES = 4096;
const MAX_PACKET = 2 * 1024 * 1024;
const preparedApps = new WeakSet();

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function requireCondition(condition, code, message) {
  if (!condition) throw failure(code, message);
}

function combine(primary, secondary, message) {
  if (!primary) return secondary;
  const error = new AggregateError([primary, secondary], message);
  error.code = primary.code;
  return error;
}

function identity(stat) {
  return {
    dev: String(stat.dev), ino: String(stat.ino), size: stat.size,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
  };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function physicalDirectory(directory) {
  requireCondition(typeof directory === "string" && path.isAbsolute(directory) &&
    path.resolve(directory) === directory,
  "ERR_VALIDATION_PATH", "Expected an absolute normalized directory");
  const stat = fs.lstatSync(directory);
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink() &&
    path.relative(directory, fs.realpathSync.native(directory)) === "",
  "ERR_VALIDATION_PATH", "A validation directory is redirected");
  return stat;
}

function databaseProfile(directory) {
  requireCondition(typeof directory === "string" &&
    path.basename(directory) === "leveldb" &&
    path.basename(path.dirname(directory)) === "Local Storage",
  "ERR_VALIDATION_PATH", "Expected the supported profile Local Storage database");
  const profilePath = path.dirname(path.dirname(directory));
  verifySupportedLocalStorage(profilePath);
  return profilePath;
}

function digest(file) {
  const before = fs.lstatSync(file);
  requireCondition(before.isFile() && !before.isSymbolicLink(),
    "ERR_VALIDATION_FILE", "A database entry is not a regular file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  let primary;
  try {
    requireCondition(same(identity(before), identity(fs.fstatSync(fd))),
      "ERR_VALIDATION_INPUT_CHANGED", "A database file changed before reading");
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      hash.update(buffer.subarray(0, length));
      bytes += length;
    }
    requireCondition(Number.isSafeInteger(bytes) && bytes === before.size &&
      same(identity(before), identity(fs.fstatSync(fd))) &&
      same(identity(before), identity(fs.lstatSync(file))),
    "ERR_VALIDATION_INPUT_CHANGED", "A database file changed during reading");
  } catch (error) {
    primary = error;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      primary = combine(primary, error, "Database read and file cleanup failed");
    }
  }
  if (primary) throw primary;
  return { bytes, sha256: hash.digest("hex"), identity: identity(before) };
}

function inventory(directory) {
  databaseProfile(directory);
  const directoryIdentity = identity(physicalDirectory(directory));
  const names = fs.readdirSync(directory).sort();
  requireCondition(names.length <= MAX_FILES, "ERR_VALIDATION_INVENTORY",
    "The database inventory exceeds the bounded probe protocol");
  const files = [];
  const ignored = [];
  for (const name of names) {
    const file = path.join(directory, name);
    if (DIAGNOSTIC_FILE.test(name)) {
      const stat = fs.lstatSync(file);
      requireCondition(stat.isFile() && !stat.isSymbolicLink(),
        "ERR_VALIDATION_FILE", "A diagnostic database entry is redirected");
      ignored.push({ name, identity: identity(stat) });
      continue;
    }
    requireCondition(DATABASE_FILE.test(name), "ERR_VALIDATION_INVENTORY",
      "The database contains an unsupported entry");
    files.push({ name, ...digest(file) });
  }
  requireCondition(files.length > 0, "ERR_VALIDATION_INVENTORY",
    "The database inventory is empty");
  requireCondition(same(directoryIdentity, identity(physicalDirectory(directory))),
    "ERR_VALIDATION_INPUT_CHANGED", "The database directory changed during inventory");
  return { directoryIdentity, files, ignored };
}

function portableInventory(snapshot) {
  return snapshot.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
}

function verifyInput(directory, before) {
  try {
    requireCondition(same(before, inventory(directory)), "ERR_VALIDATION_INPUT_CHANGED",
      "The read-only database input changed during validation");
  } catch (error) {
    if (error.code === "ERR_VALIDATION_INPUT_CHANGED") throw error;
    throw failure("ERR_VALIDATION_INPUT_CHANGED",
      "The read-only database input could not be reverified", error);
  }
}

function workPaths(workPath) {
  return {
    profilePath: path.join(workPath, "profile"),
    userDataPath: path.join(workPath, "bootstrap-user-data"),
    sessionDataPath: path.join(workPath, "bootstrap-session-data"),
  };
}

function ownerText(requestId) {
  return JSON.stringify({ version: 1, requestId });
}

function checkWork(workPath, workIdentity, requestId) {
  const stat = physicalDirectory(workPath);
  requireCondition(String(stat.dev) === workIdentity.dev &&
    String(stat.ino) === workIdentity.ino,
  "ERR_VALIDATION_WORK_CHANGED", "The disposable work directory changed ownership");
  const marker = path.join(workPath, OWNER_FILE);
  const markerStat = fs.lstatSync(marker);
  requireCondition(markerStat.isFile() && !markerStat.isSymbolicLink() &&
    markerStat.size <= 256 &&
    fs.readFileSync(marker, "utf8") === ownerText(requestId),
  "ERR_VALIDATION_WORK_CHANGED", "The disposable work ownership marker changed");
}

function rejectLeftovers(workRoot) {
  physicalDirectory(workRoot);
  const leftovers = fs.readdirSync(workRoot)
    .filter(name => name.toLowerCase().startsWith(WORK_PREFIX))
    .sort().map(name => path.join(workRoot, name));
  if (leftovers.length !== 0) {
    const error = failure("ERR_VALIDATION_WORK_LEFTOVER",
      `Probe work needs manual inspection before retrying: ${leftovers.join(", ")}`);
    error.preservedPaths = leftovers;
    throw error;
  }
}

function verifyCleanupTree(directory) {
  physicalDirectory(directory);
  for (const name of fs.readdirSync(directory)) {
    const child = path.join(directory, name);
    const stat = fs.lstatSync(child);
    requireCondition(!stat.isSymbolicLink(), "ERR_VALIDATION_CLEANUP",
      "Disposable cleanup refused a redirected entry");
    if (stat.isDirectory()) verifyCleanupTree(child);
    else requireCondition(stat.isFile(), "ERR_VALIDATION_CLEANUP",
      "Disposable cleanup refused a special entry");
  }
}

function cleanupWork(workRoot, workPath, workIdentity, requestId) {
  physicalDirectory(workRoot);
  requireCondition(path.dirname(workPath) === workRoot &&
    path.basename(workPath).startsWith(WORK_PREFIX),
  "ERR_VALIDATION_CLEANUP", "Disposable cleanup is outside its allocated work directory");
  checkWork(workPath, workIdentity, requestId);
  verifyCleanupTree(workPath);
  fs.rmSync(workPath, { recursive: true });
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    same(Object.keys(value).sort(), [...keys].sort());
}

function packet(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  requireCondition(body.length > 0 && body.length <= MAX_PACKET,
    "ERR_VALIDATION_PROTOCOL", "The private probe packet is too large");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function decodePacket(buffer) {
  requireCondition(buffer.length >= 4 && buffer.readUInt32BE(0) > 0 &&
    buffer.readUInt32BE(0) <= MAX_PACKET &&
    buffer.length === 4 + buffer.readUInt32BE(0),
  "ERR_VALIDATION_PROTOCOL", "The private probe packet is missing, truncated or duplicated");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4)));
  } catch {
    // JSON parser messages can quote settings. Keep wire contents out of errors.
    throw failure("ERR_VALIDATION_PROTOCOL", "The private probe packet is malformed");
  }
}

function readRequest(fd) {
  const chunks = [];
  let bytes = 0;
  const buffer = Buffer.alloc(16 * 1024);
  let primary;
  try {
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      bytes += length;
      requireCondition(bytes <= MAX_PACKET + 4, "ERR_VALIDATION_PROTOCOL",
        "The private probe request exceeds its bound");
      chunks.push(Buffer.from(buffer.subarray(0, length)));
    }
  } catch (error) {
    primary = error;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      primary = combine(primary, error, "Probe request and pipe cleanup failed");
    }
  }
  if (primary) throw primary;
  return decodePacket(Buffer.concat(chunks));
}

function validateRequest(request) {
  requireCondition(exactKeys(request,
    ["version", "requestId", "workPath", "workIdentity", "files", "timeoutMs"]) &&
    request.version === 1 && typeof request.requestId === "string" &&
    /^[a-f0-9]{64}$/.test(request.requestId) &&
    typeof request.workPath === "string" &&
    path.basename(request.workPath).startsWith(WORK_PREFIX) &&
    exactKeys(request.workIdentity, ["dev", "ino"]) &&
    typeof request.workIdentity.dev === "string" &&
    typeof request.workIdentity.ino === "string" &&
    /^\d+$/.test(request.workIdentity.dev) && /^\d+$/.test(request.workIdentity.ino) &&
    Number.isSafeInteger(request.timeoutMs) &&
    request.timeoutMs > 0 && request.timeoutMs <= 60000 &&
    Array.isArray(request.files) && request.files.length > 0 &&
    request.files.length <= MAX_FILES,
  "ERR_VALIDATION_PROTOCOL", "The private probe request is invalid");
  const names = new Set();
  for (const file of request.files) {
    requireCondition(exactKeys(file, ["name", "bytes", "sha256"]) &&
      typeof file.name === "string" && DATABASE_FILE.test(file.name) &&
      !names.has(file.name) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 &&
      typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256),
    "ERR_VALIDATION_PROTOCOL", "The private probe inventory is invalid");
    names.add(file.name);
  }
  checkWork(request.workPath, request.workIdentity, request.requestId);
  const paths = workPaths(request.workPath);
  physicalDirectory(paths.userDataPath);
  physicalDirectory(paths.sessionDataPath);
  const copy = inventory(path.join(paths.profilePath, "Local Storage", "leveldb"));
  requireCondition(copy.ignored.length === 0 &&
    same(request.files, portableInventory(copy)),
  "ERR_VALIDATION_COPY_MISMATCH", "The unopened disposable database does not match");
  return paths;
}

function validateResult(result, requestId) {
  requireCondition(result && result.version === 1 && result.requestId === requestId,
    "ERR_VALIDATION_PROTOCOL", "The private probe result is not request-bound");
  if (result.status === "error") {
    requireCondition(exactKeys(result, ["version", "requestId", "status", "code"]) &&
      typeof result.code === "string" && /^ERR_(?:PROBE|VALIDATION)_[A-Z0-9_]+$/.test(result.code),
    "ERR_VALIDATION_PROTOCOL", "The private probe failure is malformed");
    return result;
  }
  requireCondition(exactKeys(result, [
    "version", "requestId", "status", "backend", "storageKey", "openCount", "readCount",
  ]) && result.status === "observed" && result.backend === "leveldb" &&
    result.storageKey === "file:///" && result.openCount === 1 &&
    Number.isSafeInteger(result.readCount) && result.readCount >= 1,
  "ERR_VALIDATION_PROTOCOL", "The private probe observation is invalid");
  return result;
}

function runChild({ executablePath, args, workPath, request, timeoutMs,
  shutdownTimeoutMs, spawnChild, state }) {
  return new Promise((resolve, reject) => {
    let child;
    let timeout;
    let shutdownTimeout;
    let primary;
    let result;
    let ended = false;
    let closed = false;
    let exited = false;
    let settled = false;
    let exitCode;
    let exitSignal;
    let bytes = 0;
    const chunks = [];
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(shutdownTimeout);
      if (error) reject(error);
      else resolve();
    };
    const interrupt = error => {
      primary = combine(primary, error, "Disposable probe errors");
      if (!child || closed || shutdownTimeout) return;
      try {
        if (child.pid && !exited && !child.kill("SIGKILL")) {
          primary = combine(primary, failure("ERR_VALIDATION_CHILD_STOP",
            "The disposable probe child could not be stopped"), "Probe and stop failed");
        }
      } catch (killError) {
        primary = combine(primary, killError, "Probe and stop failed");
      }
      shutdownTimeout = setTimeout(() => {
        const error = combine(primary, failure("ERR_VALIDATION_CHILD_STILL_RUNNING",
          "Child exit/pipe closure is unproven; disposable work was preserved"),
        "Probe shutdown could not be verified");
        finish(error);
      }, shutdownTimeoutMs);
    };
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      delete env.NODE_PATH;
      child = spawnChild(executablePath, [...args, CHILD_ARGUMENT], {
        cwd: workPath, windowsHide: true, shell: false, env,
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      });
      // Node can return without stdio and emit a spawn error on the next tick.
      child.once("error", error => interrupt(failure("ERR_VALIDATION_SPAWN",
        "The disposable probe child could not run", error)));
      child.once("spawn", () => { state.started = true; });
      child.once("exit", (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
      });
      child.once("close", (code, signal) => {
        closed = true;
        state.closed = true;
        if (!primary && result?.status === "error") {
          primary = failure(result.code, "The disposable profile probe refused the observation");
        }
        if (state.started && (!exited || exitCode !== 0 || exitSignal ||
            code !== 0 || signal)) {
          primary = combine(primary, failure("ERR_VALIDATION_CHILD_EXIT",
            `The disposable probe did not exit successfully (${exitCode ?? code}, ${exitSignal || signal || "no signal"})`),
          "Probe and child exit failed");
        }
        if (!primary && (!ended || result?.status !== "observed")) {
          primary = failure("ERR_VALIDATION_PROTOCOL", "No complete probe observation was received");
        }
        state.successful = !primary;
        finish(primary);
      });
      state.child = child;
      state.started = !!child.pid;
      requireCondition(child.stdio?.[3] && child.stdio?.[4],
        "ERR_VALIDATION_SPAWN", "The child has no private request/result pipes");
      child.stdio[3].on("error", error => interrupt(failure("ERR_VALIDATION_PIPE",
        "The private probe request pipe failed", error)));
      child.stdio[4].on("error", error => interrupt(failure("ERR_VALIDATION_PIPE",
        "The private probe result pipe failed", error)));
      child.stdio[4].on("data", chunk => {
        if (primary) return;
        bytes += chunk.length;
        if (bytes > MAX_PACKET + 4) {
          interrupt(failure("ERR_VALIDATION_PROTOCOL", "The private result exceeds its bound"));
          return;
        }
        chunks.push(chunk);
      });
      child.stdio[4].once("end", () => {
        ended = true;
        try {
          result = validateResult(decodePacket(Buffer.concat(chunks)), request.requestId);
        } catch (error) {
          interrupt(error);
        }
      });
      timeout = setTimeout(() => interrupt(failure("ERR_VALIDATION_TIMEOUT",
        "The disposable probe child timed out")), timeoutMs);
      child.stdio[3].end(packet(request));
    } catch (error) {
      if (child) interrupt(error);
      else finish(failure("ERR_VALIDATION_SPAWN", "The disposable probe could not be spawned", error));
    }
  });
}

// The caller holds real profile/startup exclusion across this entire callback.
// The child receives only a disposable copy, never the stage/target input path.
function createLocalStorageValidator({
  executablePath, args = [], workRoot, timeoutMs = 15000,
  shutdownTimeoutMs = 5000, spawnChild = spawn,
}) {
  requireCondition(typeof executablePath === "string" && path.isAbsolute(executablePath) &&
    Array.isArray(args) && args.every(arg => typeof arg === "string" &&
      !arg.includes("\0") && arg !== CHILD_ARGUMENT) &&
    typeof spawnChild === "function" &&
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000 &&
    Number.isSafeInteger(shutdownTimeoutMs) &&
    shutdownTimeoutMs > 0 && shutdownTimeoutMs <= 10000,
  "ERR_VALIDATION_OPTIONS", "Invalid disposable validator configuration");
  physicalDirectory(workRoot);
  let active = false;
  return async ({ directory, backend }) => {
    requireCondition(!active, "ERR_VALIDATION_BUSY", "A disposable validation is already active");
    requireCondition(backend === "leveldb", "ERR_VALIDATION_BACKEND",
      "Only the reviewed LevelDB backend can be validated");
    const profilePath = databaseProfile(directory);
    const relative = path.relative(profilePath, workRoot);
    requireCondition(relative !== "" && (relative === ".." ||
      relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)),
    "ERR_VALIDATION_PATH", "Disposable work must be outside the input profile");
    active = true;
    let workPath;
    let workIdentity;
    let requestId;
    let before;
    let primary;
    const state = { started: false, closed: false, successful: false };
    try {
      rejectLeftovers(workRoot);
      before = inventory(directory);
      workPath = fs.mkdtempSync(path.join(workRoot, WORK_PREFIX));
      const stat = physicalDirectory(workPath);
      workIdentity = { dev: String(stat.dev), ino: String(stat.ino) };
      requestId = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(path.join(workPath, OWNER_FILE), ownerText(requestId),
        { flag: "wx", mode: 0o600 });
      const paths = workPaths(workPath);
      const database = path.join(paths.profilePath, "Local Storage", "leveldb");
      fs.mkdirSync(database, { recursive: true, mode: 0o700 });
      fs.mkdirSync(paths.userDataPath, { mode: 0o700 });
      fs.mkdirSync(paths.sessionDataPath, { mode: 0o700 });
      for (const file of before.files) {
        fs.copyFileSync(path.join(directory, file.name), path.join(database, file.name),
          fs.constants.COPYFILE_EXCL);
      }
      const files = portableInventory(before);
      requireCondition(same(files, portableInventory(inventory(database))),
        "ERR_VALIDATION_COPY_MISMATCH", "The disposable database copy does not match");
      verifyInput(directory, before);
      const request = { version: 1, requestId, workPath, workIdentity, files, timeoutMs };
      await runChild({
        executablePath, args, workPath, request, timeoutMs, shutdownTimeoutMs,
        spawnChild, state,
      });
    } catch (error) {
      primary = error;
    } finally {
      if (workPath) {
        if (!state.started || (state.closed && state.successful)) {
          try {
            cleanupWork(workRoot, workPath, workIdentity, requestId);
          } catch (error) {
            primary = combine(primary, failure("ERR_VALIDATION_CLEANUP",
              `Disposable cleanup failed; inspect ${workPath}`, error),
            "Validation and disposable cleanup failed");
          }
        } else {
          primary = combine(primary, failure("ERR_VALIDATION_WORK_PRESERVED",
            `Unsuccessful or unproven child run; inspect preserved work ${workPath}`),
          "Disposable validation failed; work was preserved");
        }
      }
      if (before) {
        try {
          verifyInput(directory, before);
        } catch (error) {
          primary = combine(primary, error, "Probe and unchanged-input verification failed");
        }
      }
      if (primary && workPath) primary.workPath = workPath;
      active = false;
    }
    if (primary) throw primary;
    return { status: "validated", backend: "leveldb" };
  };
}

function writeResult(fd, result) {
  const data = packet(result);
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(fd, data, offset, data.length - offset);
    requireCondition(written > 0, "ERR_VALIDATION_PIPE", "The private result pipe stopped writing");
    offset += written;
  }
  fs.closeSync(fd);
}

// Future early dispatch calls this synchronously before any normal Main import.
// Blocking request admission precedes ready; the ready continuation is registered
// and this function returns without awaiting app.whenReady().
function prepareProfileValidationChild({
  electron, requestFd = 3, resultFd = 4, probe = probeDisposableLocalStorage,
}) {
  requireCondition(Number.isSafeInteger(requestFd) && requestFd >= 3 &&
    Number.isSafeInteger(resultFd) && resultFd >= 3 && requestFd !== resultFd,
  "ERR_VALIDATION_PROTOCOL", "The probe requires separate private inherited pipes");
  const { app } = electron;
  let request;
  let paths;
  try {
    requireCondition(!app.isReady() && !preparedApps.has(app),
      "ERR_VALIDATION_BOOTSTRAP", "The private probe must be prepared before ready");
    preparedApps.add(app);
    request = readRequest(requestFd);
    paths = validateRequest(request);
    app.setPath("userData", paths.userDataPath);
    app.setPath("sessionData", paths.sessionDataPath);
    requireCondition(!app.isReady() && app.getPath("userData") === paths.userDataPath &&
      app.getPath("sessionData") === paths.sessionDataPath,
    "ERR_VALIDATION_BOOTSTRAP", "The private bootstrap paths were not bound");
  } catch (error) {
    let primary = error;
    try {
      if (typeof request?.requestId === "string" && /^[a-f0-9]{64}$/.test(request.requestId)) {
        writeResult(resultFd, {
          version: 1, requestId: request.requestId, status: "error",
          code: /^ERR_(?:PROBE|VALIDATION)_[A-Z0-9_]+$/.test(error.code)
            ? error.code : "ERR_VALIDATION_BOOTSTRAP",
        });
      } else {
        fs.closeSync(resultFd);
      }
    } catch (pipeError) {
      primary = combine(primary, pipeError, "Probe admission and private pipe cleanup failed");
    }
    throw primary;
  }
  const completion = new Promise((resolve, reject) => {
    app.once("ready", () => {
      const run = async () => {
        try {
          validateRequest(request);
          requireCondition(app.getPath("userData") === paths.userDataPath &&
            app.getPath("sessionData") === paths.sessionDataPath,
          "ERR_VALIDATION_BOOTSTRAP", "The private bootstrap paths changed before observation");
          const observed = await probe({
            electron, profilePath: paths.profilePath, timeoutMs: request.timeoutMs,
          });
          requireCondition(observed?.status === "observed" &&
            observed.storageKey === "file:///" && observed.openCount === 1 &&
            Number.isSafeInteger(observed.readCount) && observed.readCount >= 1,
          "ERR_VALIDATION_OBSERVATION", "The child did not observe the admitted database");
          validatePersistedSettings(observed.settings);
          checkWork(request.workPath, request.workIdentity, request.requestId);
          writeResult(resultFd, {
            version: 1, requestId: request.requestId, status: "observed",
            backend: "leveldb", storageKey: observed.storageKey,
            openCount: observed.openCount, readCount: observed.readCount,
          });
          resolve();
          app.exit(0);
        } catch (error) {
          let primary = error;
          try {
            const code = /^ERR_(?:PROBE|VALIDATION)_[A-Z0-9_]+$/.test(error.code)
              ? error.code : "ERR_VALIDATION_CHILD";
            writeResult(resultFd, {
              version: 1, requestId: request.requestId, status: "error", code,
            });
          } catch (pipeError) {
            primary = combine(primary, pipeError, "Probe and private result pipe failed");
          }
          reject(primary);
          app.exit(1);
        }
      };
      void run();
    });
  });
  // Dispatchers must observe completion for diagnostics without logging maps.
  return { completion };
}

module.exports = {
  CHILD_ARGUMENT,
  WORK_PREFIX,
  createLocalStorageValidator,
  prepareProfileValidationChild,
};
