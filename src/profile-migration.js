"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const RECEIPT_NAME = "markaloo-profile-migration.json";
const STAGE_PREFIX = ".markaloo-migration-";
const STATE_FILES = [
  "window-state.json",
  "document-session.json",
  "document-session-import.json",
];
const MAX_SESSION_DOCUMENTS = 512;
const LEVELDB_FILE = /^(?:CURRENT|MANIFEST-\d+|\d+\.(?:log|ldb|sst))$/;
const DATABASE_DIRECTORY = path.join("Local Storage", "leveldb");

class ProfileMigrationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ProfileMigrationError";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new ProfileMigrationError(code, message);
}

function statIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function requireDirectory(directory, stat) {
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    refuse("PROFILE_INVALID_DIRECTORY", `Not a regular profile directory: ${directory}`);
  }
}

function digest(file) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(file, "r");
  let bytes = 0;
  try {
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      hash.update(buffer.subarray(0, length));
      bytes += length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function addFile(files, profile, relative) {
  const file = path.join(profile, relative);
  const stat = statIfPresent(file);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    refuse("PROFILE_INVALID_FILE", `Not a regular profile file: ${file}`);
  }
  files[relative] = digest(file);
}

function snapshot(profile, strict = false, allowReceipt = false, temporaryReceipt = null) {
  const files = Object.create(null);
  for (const name of ["LocalStorage", "LocalStorage-wal", "LocalStorage-shm", "LocalStorage-journal"]) {
    if (statIfPresent(path.join(profile, name))) {
      refuse("PROFILE_UNSUPPORTED_SQLITE", `Unsupported SQLite local settings store: ${name}`);
    }
  }
  if (strict) {
    for (const entry of fs.readdirSync(profile)) {
      if (!STATE_FILES.includes(entry) && entry !== "Local Storage" &&
          !(allowReceipt && entry === RECEIPT_NAME) && entry !== temporaryReceipt) {
        refuse("PROFILE_CHANGED", `Unexpected file in the migration profile: ${path.join(profile, entry)}`);
      }
    }
  }
  for (const relative of STATE_FILES) addFile(files, profile, relative);
  const storage = path.join(profile, "Local Storage");
  const storageStat = statIfPresent(storage);
  if (storageStat) {
    requireDirectory(storage, storageStat);
    for (const entry of fs.readdirSync(storage)) {
      if (entry !== "leveldb") {
        refuse("PROFILE_UNSUPPORTED_STORAGE", `Unsupported local settings store: ${entry}`);
      }
    }
    const database = path.join(storage, "leveldb");
    const databaseStat = statIfPresent(database);
    if (!databaseStat) {
      refuse("PROFILE_INVALID_STORAGE", "The local settings directory has no database");
    }
    requireDirectory(database, databaseStat);
    for (const entry of fs.readdirSync(database).sort()) {
      // Numeric .log files are database WALs, not diagnostic logs.
      if (entry === "LOCK" || /^LOG(?:\.old(?:\.\d+)?)?$/.test(entry)) {
        if (strict) refuse("PROFILE_CHANGED", "Validation wrote to the staged database");
        continue;
      }
      if (!LEVELDB_FILE.test(entry)) {
        refuse("PROFILE_UNSUPPORTED_STORAGE", `Unsupported local settings file: ${entry}`);
      }
      addFile(files, profile, path.join("Local Storage", "leveldb", entry));
    }
    const current = fs.readFileSync(path.join(database, "CURRENT"), "utf8");
    if (!/^MANIFEST-\d+\n$/.test(current) ||
        !files[path.join("Local Storage", "leveldb", current.trim())]) {
      refuse("PROFILE_INVALID_STORAGE", "The local settings manifest is missing or invalid");
    }
  }
  return { files, hasLocalStorage: !!storageStat };
}

function validAnchor(anchor) {
  return anchor === null || (anchor && typeof anchor === "object" &&
    !Array.isArray(anchor) && Number.isFinite(anchor.scrollTop) &&
    anchor.scrollTop >= 0 &&
    (anchor.text === null || (typeof anchor.text === "string" &&
      anchor.text.length <= 1024 * 1024)) &&
    Number.isSafeInteger(anchor.ordinal) && anchor.ordinal >= 0 &&
    Number.isFinite(anchor.delta));
}

function validEntry(entry) {
  return entry && typeof entry.id === "string" && /^[a-f0-9]{32}$/.test(entry.id) &&
    typeof entry.filePath === "string" && !entry.filePath.includes("\0") &&
    path.isAbsolute(entry.filePath) &&
    ["native-open", "native-dialog", "legacy-profile"].includes(entry.provenance) &&
    Number.isFinite(entry.scrollPosition) && entry.scrollPosition >= 0 &&
    validAnchor(entry.anchor);
}

function validateState(profile, files) {
  const read = name => JSON.parse(fs.readFileSync(path.join(profile, name), "utf8"));
  let windowState = null;
  if (files["window-state.json"]) {
    windowState = read("window-state.json");
    if (!windowState || typeof windowState !== "object" || Array.isArray(windowState)) {
      refuse("PROFILE_INVALID_STATE", "Invalid saved window and update settings");
    }
  }
  if (files["document-session-import.json"]) {
    const marker = read("document-session-import.json");
    if (!files["document-session.json"] || marker?.version !== 1 ||
        !["attempted", "completed"].includes(marker.status)) {
      refuse("PROFILE_INVALID_STATE", "The document session import is incomplete or invalid");
    }
  }
  if (!files["document-session.json"]) return windowState;
  const saved = read("document-session.json");
  if (saved?.version !== 1 || saved.importStatus !== "completed" ||
      !Array.isArray(saved.entries) || saved.entries.length > MAX_SESSION_DOCUMENTS ||
      !saved.entries.every(validEntry) ||
      new Set(saved.entries.map(entry => entry.id)).size !== saved.entries.length ||
      !Array.isArray(saved.approvedEntries) ||
      saved.approvedEntries.length > MAX_SESSION_DOCUMENTS ||
      !saved.approvedEntries.every(validEntry) ||
      new Set(saved.approvedEntries.map(entry => entry.id)).size !== saved.approvedEntries.length ||
      !saved.entries.every(entry => saved.approvedEntries.some(approved =>
        approved.id === entry.id && approved.filePath === entry.filePath &&
        approved.provenance === entry.provenance)) ||
      (saved.activeEntryId !== null &&
        !saved.entries.some(entry => entry.id === saved.activeEntryId))) {
    refuse("PROFILE_INVALID_STATE", "Invalid saved document session");
  }
  return windowState;
}

function validateReceipt(profile, current) {
  const file = path.join(profile, RECEIPT_NAME);
  const stat = statIfPresent(file);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    refuse("PROFILE_INVALID_RECEIPT", "The migration receipt is not a regular file");
  }
  const text = fs.readFileSync(file, "utf8");
  const receipt = JSON.parse(text);
  if (receipt?.version !== 1 || !["pending", "completed"].includes(receipt.status) ||
      !receipt.files || typeof receipt.files !== "object" ||
      Array.isArray(receipt.files) || Object.keys(receipt.files).length === 0) {
    refuse("PROFILE_INVALID_RECEIPT", "The migration receipt is incomplete or invalid");
  }
  let hasDatabase = false;
  for (const [relative, entry] of Object.entries(receipt.files)) {
    const databaseFile = path.dirname(relative) === DATABASE_DIRECTORY &&
      LEVELDB_FILE.test(path.basename(relative));
    if ((!STATE_FILES.includes(relative) && !databaseFile) ||
        !entry || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      refuse("PROFILE_INVALID_RECEIPT", "The migration receipt has an invalid file record");
    }
    if (databaseFile) hasDatabase = true;
    else if (!current.files[relative]) {
      refuse("PROFILE_INCOMPLETE_TARGET", `The published profile is missing ${relative}`);
    }
  }
  if (hasDatabase &&
      (!Object.hasOwn(receipt.files, path.join(DATABASE_DIRECTORY, "CURRENT")) ||
       !Object.keys(receipt.files).some(relative =>
         path.dirname(relative) === DATABASE_DIRECTORY && /^MANIFEST-\d+$/.test(path.basename(relative))))) {
    refuse("PROFILE_INVALID_RECEIPT", "The migration receipt has no complete database inventory");
  }
  if (hasDatabase && !current.hasLocalStorage) {
    refuse("PROFILE_INCOMPLETE_TARGET", "The published profile is missing its local settings database");
  }
  return { text, status: receipt.status, files: receipt.files, hasDatabase };
}

async function validateDatabase(profile, snapshotBefore, validateLocalStorage) {
  if (!snapshotBefore.hasLocalStorage) return;
  if (typeof validateLocalStorage !== "function") {
    refuse("PROFILE_STORAGE_VALIDATOR_REQUIRED", "Validation of the local settings database is required");
  }
  const validation = await validateLocalStorage({
    directory: path.join(profile, DATABASE_DIRECTORY),
    backend: "leveldb",
  });
  if (validation?.status !== "validated" || validation.backend !== "leveldb") {
    refuse("PROFILE_INVALID_STORAGE", "The local settings database was not validated");
  }
}

function verifyPendingProfile(profile, receipt, temporaryReceipt = null) {
  const current = snapshot(profile, true, true, temporaryReceipt);
  if (current.hasLocalStorage !== receipt.hasDatabase ||
      Object.keys(current.files).length !== Object.keys(receipt.files).length ||
      !Object.entries(receipt.files).every(([relative, expected]) =>
        current.files[relative]?.bytes === expected.bytes &&
        current.files[relative]?.sha256 === expected.sha256) ||
      fs.readFileSync(path.join(profile, RECEIPT_NAME), "utf8") !== receipt.text) {
    refuse("PROFILE_PENDING_CHANGED",
      `The pending profile does not match its migration receipt; it was left unchanged: ${profile}`);
  }
}

function completeReceipt(profile, receipt) {
  const temporaryName = `.${RECEIPT_NAME}.${crypto.randomUUID()}.tmp`;
  const temporary = path.join(profile, temporaryName);
  const completed = JSON.stringify({ version: 1, status: "completed", files: receipt.files });
  let fd;
  let ownedStat;
  let failure;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    ownedStat = fs.fstatSync(fd);
    fs.writeFileSync(fd, completed);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (fs.readFileSync(temporary, "utf8") !== completed) {
      refuse("PROFILE_INVALID_RECEIPT", "The completed receipt bytes could not be verified");
    }
    // Completion is the commit point. Recheck the pending data immediately
    // before replacing its receipt, while normal startup is still excluded.
    verifyPendingProfile(profile, receipt, temporaryName);
    const current = statIfPresent(temporary);
    if (!current?.isFile() || current.isSymbolicLink() ||
        current.dev !== ownedStat.dev || current.ino !== ownedStat.ino) {
      refuse("PROFILE_RECEIPT_TEMP_REPLACED", `The receipt temporary file changed ownership: ${temporary}`);
    }
    fs.renameSync(temporary, path.join(profile, RECEIPT_NAME));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
      if (ownedStat) {
        const current = statIfPresent(temporary);
        if (current) {
          if (!current.isFile() || current.isSymbolicLink() ||
              current.dev !== ownedStat.dev || current.ino !== ownedStat.ino) {
            refuse("PROFILE_RECEIPT_TEMP_REPLACED", "The receipt temporary file changed ownership");
          }
          fs.unlinkSync(temporary);
        }
      }
    } catch (cleanupError) {
      throw new ProfileMigrationError("PROFILE_RECEIPT_CLEANUP_FAILED",
        `${failure?.message || "Receipt completion finished"}; receipt cleanup failed at ${temporary}: ${cleanupError.message}`,
        { cause: failure || cleanupError });
    }
  }
}

async function validateExistingProfile(profile, validateLocalStorage) {
  const before = snapshot(profile);
  const windowState = validateState(profile, before.files);
  const receipt = validateReceipt(profile, before);
  const recognizedWindow = windowState &&
    Number.isFinite(windowState.width) && windowState.width > 0 &&
    Number.isFinite(windowState.height) && windowState.height > 0;
  if (!receipt && !before.hasLocalStorage && !before.files["document-session.json"] &&
      !recognizedWindow) {
    refuse("PROFILE_UNRECOGNIZED_TARGET", "The existing Markaloo profile is empty or unrecognized; it was left unchanged");
  }
  // Completed profiles can legitimately change settings and rotate DB files.
  // Only unfinished publication is pinned to migration-time inventory and bytes.
  if (receipt?.status === "pending") verifyPendingProfile(profile, receipt);
  await validateDatabase(profile, before, validateLocalStorage);
  if (!sameSnapshot(before, snapshot(profile)) ||
      (receipt !== null && fs.readFileSync(path.join(profile, RECEIPT_NAME), "utf8") !== receipt.text)) {
    refuse("PROFILE_CHANGED", "The existing Markaloo profile changed during validation");
  }
  if (receipt?.status === "pending") completeReceipt(profile, receipt);
}

function sameSnapshot(left, right) {
  return left.hasLocalStorage === right.hasLocalStorage &&
    JSON.stringify(left.files) === JSON.stringify(right.files);
}

function flushFile(file) {
  const fd = fs.openSync(file, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function cleanupStage(directory, ownedStat) {
  const current = statIfPresent(directory);
  if (!current) return;
  requireDirectory(directory, current);
  if (!ownedStat || current.dev !== ownedStat.dev || current.ino !== ownedStat.ino) {
    refuse("PROFILE_STAGE_REPLACED", "The migration staging directory changed ownership");
  }
  fs.rmSync(directory, { recursive: true });
}

/**
 * Windows installer-only, for default Folia/Markaloo profiles. This is not a
 * relocated/dev-profile discovery API. Never call it from ordinary startup.
 * withProfileOwnership(paths, run) must hold real legacy-profile ownership and
 * exclude normal destination startup until awaited run() settles, returning its
 * result. Neither absent profile may be precreated. A second target Electron
 * singleton is not required alongside that real gate and Windows publication.
 * validateLocalStorage({directory, backend}) receives read-only profile input.
 * Probe only a verified disposable clone, never this directory; return
 * {status: "validated", backend: "leveldb"} only after the agreed checks pass.
 * There is deliberately no default validator or ownership approximation.
 */
async function migrateWindowsProfile({ appDataPath, withProfileOwnership, validateLocalStorage }) {
  if (typeof appDataPath !== "string" || !path.isAbsolute(appDataPath)) {
    refuse("PROFILE_INVALID_PATH", "Migration requires the installing user's absolute appData path");
  }
  if (typeof withProfileOwnership !== "function") {
    refuse("PROFILE_OWNERSHIP_REQUIRED", "Legacy profile ownership and destination startup exclusion are required");
  }
  const sourcePath = path.join(appDataPath, "Folia");
  const targetPath = path.join(appDataPath, "Markaloo");
  let entered = false;
  let outcome;
  const result = await withProfileOwnership({ sourcePath, targetPath }, async () => {
    if (entered) refuse("PROFILE_OWNERSHIP_INVALID", "Migration ownership was entered more than once");
    entered = true;
    let stage = null;
    let stageStat;
    let failure;
    let phase = "inspect";
    try {
      requireDirectory(appDataPath, fs.statSync(appDataPath));
      const targetStat = statIfPresent(targetPath);
      if (targetStat) {
        requireDirectory(targetPath, targetStat);
        await validateExistingProfile(targetPath, validateLocalStorage);
        outcome = { status: "existing", targetPath };
        return outcome;
      }
      const sourceStat = statIfPresent(sourcePath);
      if (!sourceStat) {
        outcome = { status: "fresh", targetPath };
        return outcome;
      }
      requireDirectory(sourcePath, sourceStat);
      // Windows directory rename refuses an existing destination, even an empty
      // one. POSIX rename can replace an empty directory, so do not use it there.
      if (process.platform !== "win32") {
        refuse("PROFILE_UNSUPPORTED_PLATFORM", "Legacy profile migration is not available on this platform");
      }
      const before = snapshot(sourcePath);
      validateState(sourcePath, before.files);
      if (Object.keys(before.files).length === 0) {
        refuse("PROFILE_INVALID_STATE", "The legacy profile contains no recognized saved state");
      }
      if (before.hasLocalStorage && typeof validateLocalStorage !== "function") {
        refuse("PROFILE_STORAGE_VALIDATOR_REQUIRED", "Strict validation of the local settings database is required");
      }
      // Process termination bypasses cleanup. A reserved name alone does not
      // prove ownership, so preserve leftovers instead of accumulating copies.
      const leftovers = fs.readdirSync(appDataPath)
        .filter(entry => entry.toLowerCase().startsWith(STAGE_PREFIX))
        .sort()
        .map(entry => path.join(appDataPath, entry));
      if (leftovers.length !== 0) {
        refuse("PROFILE_STAGE_LEFTOVER",
          `Migration staging entries need manual inspection before retrying: ${leftovers.join(", ")}`);
      }
      phase = "copy";
      stage = fs.mkdtempSync(path.join(appDataPath, STAGE_PREFIX));
      stageStat = fs.lstatSync(stage);
      for (const [relative, expected] of Object.entries(before.files)) {
        const destination = path.join(stage, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(sourcePath, relative), destination, fs.constants.COPYFILE_EXCL);
        flushFile(destination);
        if (JSON.stringify(digest(destination)) !== JSON.stringify(expected)) {
          refuse("PROFILE_COPY_MISMATCH", `Copied profile bytes do not match: ${relative}`);
        }
      }
      phase = "validate";
      await validateDatabase(stage, before, validateLocalStorage);
      if (!sameSnapshot(before, snapshot(sourcePath)) ||
          !sameSnapshot(before, snapshot(stage, true))) {
        refuse("PROFILE_CHANGED", "Profile data changed during migration or validation");
      }
      const receipt = JSON.stringify({ version: 1, status: "pending", files: before.files });
      fs.writeFileSync(path.join(stage, RECEIPT_NAME), receipt, { flag: "wx", mode: 0o600 });
      flushFile(path.join(stage, RECEIPT_NAME));
      phase = "publish";
      fs.renameSync(stage, targetPath);
      // Never delete a published profile, including when this final check fails.
      if (statIfPresent(stage) || !sameSnapshot(before, snapshot(targetPath, true, true)) ||
          fs.readFileSync(path.join(targetPath, RECEIPT_NAME), "utf8") !== receipt) {
        refuse("PROFILE_PUBLISH_INVALID", "The published profile could not be verified");
      }
      completeReceipt(targetPath, {
        text: receipt, status: "pending", files: before.files, hasDatabase: before.hasLocalStorage,
      });
      outcome = { status: "migrated", targetPath };
      return outcome;
    } catch (error) {
      failure = new ProfileMigrationError(
        error.code?.startsWith("PROFILE_") ? error.code : "PROFILE_MIGRATION_FAILED",
        `Profile migration failed during ${phase}: ${error.message}`,
        { cause: error },
      );
      failure.phase = phase;
      throw failure;
    } finally {
      if (stage) {
        try {
          cleanupStage(stage, stageStat);
        } catch (cleanupError) {
          const error = new ProfileMigrationError(
            "PROFILE_CLEANUP_FAILED",
            `${failure?.message || "Profile migration finished"}; staging cleanup failed: ${cleanupError.message}`,
            { cause: failure || cleanupError },
          );
          error.cleanupError = cleanupError;
          error.stagePath = stage;
          throw error;
        }
      }
    }
  });
  if (!outcome || result !== outcome) {
    refuse("PROFILE_OWNERSHIP_INVALID", "The profile ownership operation did not complete migration");
  }
  return result;
}

// Ordinary startup owns destination admission. Windows holds the legacy LOCK
// while making this copy; no database is opened and the original stays intact.
async function importLegacyProfile({ appDataPath, copyClosedProfile }) {
  if (typeof appDataPath !== "string" || !path.isAbsolute(appDataPath)) {
    refuse("PROFILE_INVALID_PATH", "An absolute application data directory is required");
  }
  const sourcePath = path.join(appDataPath, "Folia");
  const targetPath = path.join(appDataPath, "Markaloo");
  const target = statIfPresent(targetPath);
  if (target) {
    requireDirectory(targetPath, target);
    if (fs.readdirSync(targetPath).length) return { status: "existing", targetPath };
  }
  const source = statIfPresent(sourcePath);
  if (!source) return { status: "fresh", targetPath };
  requireDirectory(sourcePath, source);
  const before = snapshot(sourcePath);
  validateState(sourcePath, before.files);
  if (!Object.keys(before.files).length) return { status: "fresh", targetPath };
  if (typeof copyClosedProfile !== "function") {
    refuse("PROFILE_COPY_REQUIRED", "The closed-profile copy operation is unavailable");
  }
  const stage = fs.mkdtempSync(path.join(appDataPath, STAGE_PREFIX));
  const stageStat = fs.lstatSync(stage);
  let failure = null;
  try {
    await copyClosedProfile({ sourcePath, stagePath: stage });
    const copied = snapshot(stage, true);
    validateState(stage, copied.files);
    if (!sameSnapshot(before, copied) || !sameSnapshot(before, snapshot(sourcePath))) {
      refuse("PROFILE_CHANGED", "The saved Folia settings changed or could not be copied completely");
    }
    if (target) {
      const current = fs.lstatSync(targetPath);
      if (current.dev !== target.dev || current.ino !== target.ino ||
          !current.isDirectory() || current.isSymbolicLink()) {
        refuse("PROFILE_CHANGED", "The Markaloo profile changed during copying");
      }
      // Only a still-empty original directory may be removed; never merge state.
      fs.rmdirSync(targetPath);
    } else if (statIfPresent(targetPath)) {
      refuse("PROFILE_CHANGED", "A Markaloo profile appeared during copying");
    }
    fs.renameSync(stage, targetPath);
    return { status: "copied", targetPath };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      cleanupStage(stage, stageStat);
    } catch (cleanupError) {
      throw new AggregateError(failure ? [failure, cleanupError] : [cleanupError],
        "Profile staging cleanup failed", { cause: failure || cleanupError });
    }
  }
}

module.exports = { migrateWindowsProfile, importLegacyProfile, ProfileMigrationError, RECEIPT_NAME };
