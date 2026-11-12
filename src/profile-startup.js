"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const admission = require("./profile-startup-admission");
const validation = require("./profile-migration-validation");

const DEV_PROFILE_SUFFIX = "-dev";
const ACTIVE_PROFILE_NAME = "Markaloo";

function devProfileDecision(app) {
  const appData = app.getPath("appData");
  const name = app.getName();
  const standard = path.join(appData, name);
  if (path.resolve(app.getPath("userData")) !== path.resolve(standard)) {
    return { target: null, reason: "already-relocated" };
  }
  const target = path.join(
    appData,
    ACTIVE_PROFILE_NAME + (app.isPackaged ? "" : DEV_PROFILE_SUFFIX),
  );
  if (path.resolve(target) === path.resolve(standard)) {
    return { target: null, reason: "existing-profile" };
  }
  return {
    target,
    reason: app.isPackaged ? "packaged" : "dev",
  };
}

function applyDevProfile(app) {
  const decision = devProfileDecision(app);
  if (!decision.target) return decision;
  fs.mkdirSync(decision.target, { recursive: true });
  app.setPath("userData", decision.target);
  if (path.resolve(app.getPath("userData")) !== path.resolve(decision.target)) {
    if (app.isPackaged) {
      throw new Error("Cannot select the existing application profile");
    }
    throw new Error("Cannot select the isolated development profile");
  }
  return decision;
}

// ENTRY STARTUP
const contexts = new WeakMap();
const preparedApps = new WeakSet();

function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function reportStartupFailure(electron, error) {
  if (contexts.get(electron.app)?.handleRuntimeFailure(error)) return;
  // A probe error may retain private settings in its cause. Report only a code.
  const code = /^ERR_[A-Z0-9_]+$/.test(error?.code)
    ? error.code : "ERR_APPLICATION_STARTUP";
  console.error(`Markaloo startup refused: ${code}`);
  if (code === "ERR_LEGACY_PROFILE_IMPORT") {
    try {
      electron.dialog?.showErrorBox("Folia settings were not copied",
        "Markaloo has not opened a new profile. Your Folia settings are still available. " +
        "Close Folia and other Markaloo windows, then try again. " +
        "If this keeps happening, keep using Folia until the saved settings can be checked.");
    } catch (warningError) {
      console.error("The profile import warning could not be displayed:", warningError);
    }
  }
  electron.app.exit(1);
}

function classifyRole(args, isPackaged) {
  const privateArgs = args.filter(arg => arg.startsWith("--markaloo-"));
  const child = privateArgs.filter(arg => arg === validation.CHILD_ARGUMENT);
  if (child.length === 1 && privateArgs.length === 1 &&
      args.at(-1) === validation.CHILD_ARGUMENT) return "validation-child";
  if (child.length || privateArgs.some(arg =>
    isPackaged || arg !== "--markaloo-test-preload")) {
    refuse("ERR_STARTUP_ROLE", "Unknown or malformed private startup role");
  }
  return "normal";
}

function startupRequest(args, cwd) {
  if (process.platform === "win32") return admission.createStartupRequest({ args, cwd });
  if (!Array.isArray(args) || args.length > 4096 ||
      args.some(arg => typeof arg !== "string" || arg.includes("\0")) ||
      typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0") ||
      Buffer.byteLength(JSON.stringify({ args, cwd })) > 256 * 1024) {
    refuse("ERR_STARTUP_REQUEST", "Invalid startup document request");
  }
  return Object.freeze({
    requestId: crypto.randomBytes(32).toString("hex"),
    args: Object.freeze([...args]), cwd,
  });
}

function localQueue() {
  const owner = new EventEmitter();
  const queue = [];
  let phase = "starting";
  let accepted = 0;
  owner.enqueue = request => {
    if (!["starting", "running"].includes(phase)) {
      refuse("ERR_ADMISSION_BUSY", "The application is closing");
    }
    if (queue.length >= admission.MAX_QUEUE || accepted >= admission.MAX_REQUESTS) {
      refuse("ERR_ADMISSION_CAPACITY", "The startup document queue is full");
    }
    queue.push(request);
    accepted++;
    owner.emit("queued", request.requestId);
  };
  owner.takeQueued = () => queue.splice(0);
  owner.pendingCount = () => queue.length;
  owner.setPhase = next => {
    if (phase === "closing" && next !== "closing") {
      refuse("ERR_ADMISSION_PHASE", "Closing cannot be reversed");
    }
    phase = next;
  };
  owner.close = async () => { owner.setPhase("closing"); };
  return owner;
}

function makeContext(app, owner, profileDecision) {
  const retained = [];
  let consumer = null;
  let mainHasPendingRequests = null;
  let draining = false;
  let errorHandler = null;
  let admissionClosed = false;
  let updatePause = null;
  let updatePauseGeneration = 0;
  function stopAdmission() {
    admissionClosed = true;
    updatePause = null;
    owner.setPhase("closing");
  }
  const notices = new Map();
  function flushNotices() {
    if (!errorHandler) return;
    for (const [kind, message] of notices) {
      try {
        if (errorHandler(message) === true) notices.delete(kind);
      } catch (error) {
        console.error(`Markaloo startup notice failed: ${error.code || "ERR_STARTUP_NOTICE"}`);
      }
    }
  }
  const context = {
    owner, profileDecision, gotTheLock: false,
    setConsumer(next, pendingMainRequests = null) {
      if (consumer) refuse("ERR_STARTUP_CONSUMER", "The startup queue already has a consumer");
      consumer = next;
      mainHasPendingRequests = pendingMainRequests;
    },
    setErrorHandler(next) {
      if (errorHandler || typeof next !== "function") {
        refuse("ERR_STARTUP_CONSUMER", "The startup error handler must be bound once");
      }
      // Main now owns the session, even while its renderer is still loading.
      errorHandler = next;
      flushNotices();
    },
    hasPendingRequests() {
      return retained.length > 0 || owner.pendingCount() > 0 ||
        mainHasPendingRequests?.() === true;
    },
    pauseForUpdate() {
      if (admissionClosed || updatePause) {
        refuse("ERR_ADMISSION_BUSY", "Startup admission cannot be paused for another update");
      }
      owner.setPhase("migration");
      updatePause = Object.freeze({ generation: ++updatePauseGeneration });
      return updatePause;
    },
    isUpdatePauseCurrent(pause) {
      return !!pause && !admissionClosed && updatePause === pause;
    },
    resumeAfterUpdate(pause) {
      if (!context.isUpdatePauseCurrent(pause)) return false;
      owner.setPhase("running");
      updatePause = null;
      return true;
    },
    handleRuntimeFailure(error) {
      if (!errorHandler) return false;
      stopAdmission();
      const code = /^ERR_[A-Z0-9_]+$/.test(error?.code)
        ? error.code : "ERR_APPLICATION_STARTUP";
      console.error(`Markaloo startup admission stopped: ${code}`);
      notices.set("admission",
        `Opening more files has stopped (${code}). Save your work, then quit and reopen Markaloo.`);
      flushNotices();
      return true;
    },
    holdClosing() {
      if (!context.hasPendingRequests()) return false;
      console.error("Markaloo closing delayed: ERR_STARTUP_PENDING");
      notices.set("pending",
        "Some file opens are still pending. Finish opening them, then choose Close or Quit again.");
      flushNotices();
      return true;
    },
    drain() {
      if (!consumer || draining) return;
      draining = true;
      try {
        for (;;) {
          if (!retained.length) retained.push(...owner.takeQueued());
          if (!retained.length || consumer(retained[0]) !== true) return;
          retained.shift();
        }
      } catch (error) {
        reportStartupFailure({ app }, error);
      } finally {
        draining = false;
        flushNotices();
      }
    },
  };
  const fail = error => {
    stopAdmission();
    reportStartupFailure({ app }, error);
  };
  owner.on("queued", () => {
    try { context.drain(); } catch (error) { fail(error); }
  });
  owner.on("client-error", error => {
    console.error(`Markaloo startup request refused: ${error.code || "ERR_STARTUP_REQUEST"}`);
  });
  owner.on("error", fail);
  app.on("second-instance", (_event, args, cwd) => {
    try { owner.enqueue(startupRequest(args, cwd)); } catch (error) {
      console.error(`Markaloo startup request refused: ${error.code || "ERR_STARTUP_REQUEST"}`);
    }
  });
  app.on("will-quit", event => {
    if (context.holdClosing()) {
      event.preventDefault();
      return;
    }
    if (event.defaultPrevented) return;
    // Keep the durable owner record. Only actual PID exit admits the next owner.
    async function closeOwner() {
      stopAdmission();
      await owner.close();
    }
    void closeOwner().catch(error => {
      console.error(`Markaloo startup cleanup failed: ${error.code || "ERR_STARTUP_CLEANUP"}`);
    });
  });
  contexts.set(app, context);
  return context;
}

function collectFinderRequests(app, enqueue) {
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    try {
      enqueue(startupRequest([process.execPath, filePath], process.cwd()));
    } catch (error) {
      console.error(`Markaloo file-open request refused: ${error.code || "ERR_STARTUP_REQUEST"}`);
    }
  });
}

function verifiedDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      path.relative(directory, fs.realpathSync.native(directory)) !== "") {
    refuse("ERR_STARTUP_DIRECTORY", "The startup directory is redirected");
  }
}

function ownerRecordRoot(app, profile) {
  const appData = path.resolve(app.getPath("appData"));
  verifiedDirectory(appData);
  const root = path.join(appData, ".markaloo-startup");
  const relative = path.relative(profile, root);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." && !path.isAbsolute(relative))) {
    refuse("ERR_ADMISSION_METADATA", "Owner metadata must be outside the selected profile");
  }
  try { fs.mkdirSync(root); } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  verifiedDirectory(root);
  return root;
}

function verifyProfileLocation(profile) {
  let existing = profile;
  for (;;) {
    try {
      verifiedDirectory(existing);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

function prepareHostedMain(app) {
  // Existing Electron suites host CJS Main with an already isolated profile.
  // The actual application entry, including relocation, must use admission.
  const profileDecision = devProfileDecision(app);
  if (app.isPackaged || profileDecision.reason !== "already-relocated") {
    refuse("ERR_STARTUP_ENTRY", "Start the application through its pre-ready entry");
  }
  const owner = localQueue();
  owner.enqueue(startupRequest(process.argv, process.cwd()));
  const context = makeContext(app, owner, profileDecision);
  collectFinderRequests(app, request => owner.enqueue(request));
  context.gotTheLock = app.requestSingleInstanceLock();
  return context;
}

function getMainStartup(app) {
  return contexts.get(app) || prepareHostedMain(app);
}

function prepareApplicationStartup(electron) {
  const { app } = electron;
  if (app.isReady() || preparedApps.has(app)) {
    refuse("ERR_STARTUP_PREPARATION", "Startup must be prepared once before ready");
  }
  preparedApps.add(app);
  const role = classifyRole(process.argv, app.isPackaged);
  if (role === "validation-child") {
    return { role, ...validation.prepareProfileValidationChild({ electron }) };
  }
  const profileDecision = devProfileDecision(app);
  const profile = path.resolve(profileDecision.target || app.getPath("userData"));
  const initial = startupRequest(process.argv, process.cwd());
  const early = [];
  let owner = null;
  collectFinderRequests(app, request => {
    if (owner) owner.enqueue(request);
    else {
      if (early.length >= admission.MAX_QUEUE - 1) {
        refuse("ERR_ADMISSION_CAPACITY", "The early file-open queue is full");
      }
      early.push(request);
    }
  });
  const completion = (async () => {
    let context = null;
    try {
      if (process.platform === "win32") {
        const result = await admission.admitStartup({
          canonicalProfilePath: profile, ownerRecordRoot: ownerRecordRoot(app, profile),
          request: initial,
        });
        if (result.role === "forwarded") {
          app.exit(0);
          return;
        }
        owner = result.owner;
      } else {
        owner = localQueue();
        owner.enqueue(initial);
      }
      context = makeContext(app, owner, profileDecision);
      for (const request of early.splice(0)) owner.enqueue(request);
      // Canonical identity is lexical before admission. Reject redirected
      // ancestors before any profile creation or browser storage access.
      verifyProfileLocation(profile);
      const defaultWindowsProfile = process.platform === "win32" && app.isPackaged &&
        profileDecision.reason !== "already-relocated";
      if (defaultWindowsProfile) {
        try {
          const { importLegacyProfile } = require("./profile-migration");
          const { copyClosedProfile } = require("./legacy-install");
          await importLegacyProfile({ appDataPath: app.getPath("appData"), copyClosedProfile });
        } catch (cause) {
          const error = new Error("Folia settings were not imported; the original was kept.", { cause });
          error.code = "ERR_LEGACY_PROFILE_IMPORT";
          throw error;
        }
      }
      if (profileDecision.target) applyDevProfile(app);
      if (path.resolve(app.getPath("userData")) !== profile) {
        refuse("ERR_STARTUP_PROFILE", "The selected profile changed during admission");
      }
      context.gotTheLock = app.requestSingleInstanceLock();
      if (!context.gotTheLock) {
        owner.setPhase("closing");
        await owner.close();
        app.quit();
        return;
      }
      require("./main");
      owner.setPhase("running");
    } catch (error) {
      if (owner) {
        owner.setPhase("closing");
        try { await owner.close(); } catch (cleanup) {
          const failure = new AggregateError([error, cleanup], "Startup and admission cleanup failed",
            { cause: error });
          failure.code = error.code;
          throw failure;
        }
      }
      throw error;
    }
  })();
  return { role, completion };
}

module.exports = {
  devProfileDecision, applyDevProfile, getMainStartup,
  prepareApplicationStartup, reportStartupFailure,
};
