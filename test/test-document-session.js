let stage = "startup";
let phase = "coordinator";
let cleanup = () => {};
let terminating = false;
let handlingFatal = false;
const testDestroyedContents = new WeakSet();
function errorMetadata(error) {
  const errorType = ["Error", "TypeError", "SyntaxError", "RangeError"].includes(error?.name)
    ? error.name : "unknown";
  const code = ["ENOENT", "EEXIST", "EPERM", "EACCES", "ENOTDIR", "ELOOP",
    "EIO", "ENOSPC", "ENOTEMPTY", "ETIMEDOUT", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_URL"].includes(error?.code)
    ? error.code : undefined;
  return { errorType, code };
}
// Never print exception messages/stacks: a capture failure can contain stored text.
function fatal(reason, error) {
  if (handlingFatal) process.exit(1);
  handlingFatal = true;
  terminating = true;
  try {
    require("fs").writeSync(2, `FAIL document-session harness  -> ${JSON.stringify({
      phase, stage, reason, ...errorMetadata(error),
    })}\n`);
  } catch {}
  try { cleanup(); } catch {}
  process.exit(1);
}
process.prependListener("uncaughtException", error => fatal("uncaught-exception", error));
process.prependListener("unhandledRejection", error => fatal("unhandled-rejection", error));

const electron = require("electron");
const child = typeof electron !== "string";
const watchdog = child
  ? setTimeout(() => fatal("bounded-child-watchdog-expired"), 45000) : null;
if (child) {
  // These guards precede even batch validation and the isolation helper.
  for (const method of ["showErrorBox", "showMessageBox", "showMessageBoxSync",
    "showOpenDialog", "showOpenDialogSync", "showSaveDialog", "showSaveDialogSync"]) {
    electron.dialog[method] = () => fatal(`unexpected-${method}`);
  }
  electron.app.on("render-process-gone", (_event, contents) => {
    if (!terminating && !testDestroyedContents.has(contents)) fatal("renderer-process-gone");
  });
  electron.app.on("child-process-gone", (_event, details) => {
    if (!terminating && details.reason !== "clean-exit") fatal("child-process-gone");
  });
}
const phases = [
  "legacy", "empty", "corrupt-state", "missing-state",
  "corrupt-legacy", "oversized-legacy", "corrupt-unmarked",
];
stage = "phase-validation";
if (child) {
  if (!phases.includes(process.argv[2])) fatal("invalid-child-phase");
  phase = process.argv[2];
} else if (process.argv.length !== 2) {
  fatal("unexpected-coordinator-arguments");
}

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { isDeepStrictEqual } = require("util");
const root = path.resolve(__dirname, "..");
stage = "batch-validation";
const physicalRoot = fs.realpathSync.native(root);
if (fs.lstatSync(root).isSymbolicLink() || path.relative(root, physicalRoot) !== "") {
  fatal("worktree-root-is-redirected");
}
const evidenceRoot = path.join(root, "files", "admission-session-tests");
const batchRoot = child ? process.env.FOLIA_SESSION_TEST_BATCH
  : path.join(evidenceRoot, `batch-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`);
if (typeof batchRoot !== "string" || !path.isAbsolute(batchRoot) ||
    path.normalize(batchRoot) !== batchRoot ||
    path.relative(evidenceRoot, path.dirname(batchRoot)) !== "" ||
    !/^batch-\d+-[a-f0-9]{16}$/.test(path.basename(batchRoot))) {
  fatal("invalid-owned-batch");
}
// Check each physical ancestor before mkdir or the helper's recursive wipe.
// Prefix checks alone accept junctions; realpath on only the final target also
// misses nonexistent targets below a redirected ancestor.
function ownedDirectory(target, create = false) {
  const relative = path.relative(physicalRoot, target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    fatal("directory-outside-worktree");
  }
  let current = physicalRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      if (!create) return null;
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
        path.relative(current, fs.realpathSync.native(current)) !== "") {
      fatal("owned-directory-is-redirected");
    }
  }
  return fs.realpathSync.native(target);
}
const ownerToken = child ? process.env.FOLIA_SESSION_TEST_OWNER
  : crypto.randomBytes(32).toString("hex");
if (typeof ownerToken !== "string" || !/^[a-f0-9]{64}$/.test(ownerToken)) {
  fatal("invalid-batch-owner-token");
}
const ownerFile = path.join(batchRoot, ".document-session-test-owner.json");
if (child) {
  if (!ownedDirectory(batchRoot)) fatal("missing-owned-batch");
  const stat = fs.lstatSync(ownerFile);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 ||
      JSON.parse(fs.readFileSync(ownerFile, "utf8")).token !== ownerToken) {
    fatal("batch-owner-mismatch");
  }
} else {
  ownedDirectory(evidenceRoot, true);
  if (fs.lstatSync(batchRoot, { throwIfNoEntry: false })) fatal("batch-target-already-exists");
  fs.mkdirSync(batchRoot);
  ownedDirectory(batchRoot);
  fs.writeFileSync(ownerFile, JSON.stringify({ token: ownerToken }), { encoding: "utf8", flag: "wx" });
}
const profile = child ? path.join(batchRoot, phase) : null;
const helperProfile = child ? path.join(profile, "folia-test-userdata", "test-document-session") : null;
if (child) {
  stage = "profile-isolation";
  ownedDirectory(batchRoot);
  // A phase is single-use, including after a killed run; never wipe a reused
  // target merely because somebody supplied the right lexical batch prefix.
  if (fs.lstatSync(profile, { throwIfNoEntry: false })) fatal("phase-target-already-exists");
  fs.mkdirSync(profile);
  ownedDirectory(profile);
  // Materialize and check the entire wipe target, not just the last ancestor
  // that happened to exist when a nullable lookup stopped walking.
  if (!ownedDirectory(helperProfile, true)) fatal("helper-profile-directory-missing");
  if (electron.app.isReady()) fatal("profile-setup-after-ready");
  // Even the isolation helper's saved "previous" path must be test-owned.
  electron.app.setPath("userData", profile);
  electron.app.setPath("sessionData", profile);
}
const originalTmpdir = os.tmpdir;
if (child) os.tmpdir = () => profile;
const isolation = require("./test-userdata-isolation");
os.tmpdir = originalTmpdir;
if (child) {
  const actual = isolation.USER_DATA_DIR;
  if (typeof actual !== "string" || !path.isAbsolute(actual) ||
      path.relative(helperProfile, actual) !== "" || !ownedDirectory(actual) ||
      path.relative(actual, electron.app.getPath("userData")) !== "") {
    fatal("actual-helper-profile-is-not-the-checked-owned-target");
  }
}

if (typeof electron === "string") {
  const { spawnSync } = require("child_process");
  console.log(`Retained document-session batch: ${ownedDirectory(batchRoot)}`);
  let assertions = 0;
  let passed = 0;
  for (const phase of phases) {
    stage = `child-${phase}`;
    const result = spawnSync(electron, [__filename, phase], {
      cwd: root, encoding: "utf8", timeout: 60000,
      env: { ...process.env, FOLIA_SESSION_TEST_BATCH: batchRoot,
        FOLIA_SESSION_TEST_OWNER: ownerToken },
    });
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    const footers = [...(result.stdout || "").matchAll(
      /^=== document session ([a-z-]+): (\d+)\/(\d+) passed ===$/gm)];
    const footer = footers.length === 1 ? footers[0] : null;
    const phasePassed = Number(footer?.[2]);
    const phaseTotal = Number(footer?.[3]);
    if (result.error || result.signal || !footer || footer[1] !== phase ||
        !Number.isSafeInteger(phaseTotal) || !Number.isSafeInteger(phasePassed) ||
        phaseTotal < 6 || phasePassed > phaseTotal ||
        result.status !== (phasePassed === phaseTotal ? 0 : 1)) {
      fatal("no-single-matching-nonvacuous-phase-verdict", result.error);
    }
    assertions += phaseTotal;
    passed += phasePassed;
  }
  console.log(`=== ${passed}/${assertions} passed ===`);
  process.exit(passed === assertions ? 0 : 1);
} else {
  const { app, BrowserWindow, dialog, ipcMain, session, shell } = electron;
  const { pathToFileURL } = require("url");
  const report = console.log.bind(console);
  if (app.isReady()) fatal("profile-setup-after-ready");
  // The helper chose a nested profile. Pin both final paths; userData alone
  // does not prove which Chromium store backs the default session.
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  let defaultSession = null;
  function storageBoundary() {
    ownedDirectory(batchRoot);
    if (!ownedDirectory(profile)) fatal("owned-profile-disappeared");
    const paths = {};
    for (const name of ["userData", "sessionData"]) {
      const value = app.getPath(name);
      if (typeof value !== "string" || !path.isAbsolute(value) ||
          path.relative(profile, value) !== "") fatal("app-storage-outside-phase-profile");
      paths[name] = ownedDirectory(value);
      if (!paths[name]) fatal("app-storage-directory-missing");
    }
    if (defaultSession) {
      const value = defaultSession.getStoragePath();
      if (typeof value !== "string" || !path.isAbsolute(value) ||
          path.relative(profile, value) !== "") {
        fatal("default-session-storage-outside-phase-profile");
      }
      paths.defaultSession = ownedDirectory(value);
      if (!paths.defaultSession) fatal("default-session-directory-missing");
    }
    return paths;
  }
  storageBoundary();
  const { OwnedDialogs } = require("../src/owned-dialogs");
  OwnedDialogs.prototype.show = () => fatal("unexpected-owned-dialog");
  for (const method of ["openExternal", "openPath", "showItemInFolder"]) {
    shell[method] = () => fatal(`unexpected-shell-${method}`);
  }
  let shutdown = null;
  const initialBootstraps = new Map();
  let observeInitialBootstrap = null;
  let replayPreloadId = null;
  let stopModalGuard = () => {};
  let nativeObserversInstalled = false;
  let stopInitialNativeObservation = () => {};
  const destroyWindow = candidate => {
    if (!candidate.isDestroyed()) {
      testDestroyedContents.add(candidate.webContents);
      candidate.destroy();
    }
  };
  cleanup = () => {
    clearTimeout(watchdog);
    stopInitialNativeObservation();
    stopModalGuard();
    if (observeInitialBootstrap) {
      ipcMain.removeListener("bootstrap-legacy-document-session", observeInitialBootstrap);
    }
    if (replayPreloadId !== null) defaultSession.unregisterPreloadScript(replayPreloadId);
    shutdown?.reset();
    // Destroying the last test window must not enter Main's app.quit protocol.
    app.removeAllListeners("window-all-closed");
    for (const candidate of BrowserWindow.getAllWindows()) {
      destroyWindow(candidate);
    }
  };
  let assertions = 0;
  let failures = 0;
  const check = (name, condition, detail = "") => {
    assertions += 1;
    if (!condition) failures += 1;
    report(`${condition ? "PASS" : "FAIL"} ${phase}: ${name}${condition ? "" : `  -> ${detail}`}`);
  };
  const finish = () => {
    if (terminating) fatal("duplicate-child-finish");
    if (nativeObserversInstalled) fatal("finish-with-native-observers-installed");
    stage = "cleanup";
    terminating = true;
    cleanup();
    fs.writeSync(1, `=== document session ${phase}: ${assertions - failures}/${assertions} passed ===\n`);
    app.exit(failures ? 1 : 0);
  };
  const fingerprint = (value, present = true) => ({
    present, type: typeof value, isNull: value === null,
    lengthUTF16: typeof value === "string" ? value.length : null,
    encoding: "UTF8",
    sha256: typeof value === "string"
      ? crypto.createHash("sha256").update(value, "utf8").digest("hex") : null,
  });
  const fields = value => Object.fromEntries(["openTabs", "activeTabPath", "captureError"]
    .map(name => [name, fingerprint(value?.[name],
      value != null && Object.prototype.hasOwnProperty.call(value, name))]));
  const diagnostic = (point, value) => {
    report(`DIAGNOSTIC ${phase}: ${point} ${JSON.stringify({
      paths: storageBoundary(), fields: fields(value),
    })}`);
  };

  app.whenReady().then(async () => {
    stage = "session-boundary";
    storageBoundary();
    // Do not acquire Chromium's default session until BOTH App paths are owned.
    defaultSession = session.defaultSession;
    report(`DIAGNOSTIC ${phase}: owned storage ${JSON.stringify(storageBoundary())}`);
    stage = "synthetic-seed";
    const first = path.join(profile, "first.md");
    const second = path.join(profile, "second.md");
    const missing = path.join(profile, "missing.md");
    const forged = path.join(profile, "never-admitted.md");
    const firstContent = "# First restored\n\nFIRST_RESTORED\n";
    fs.writeFileSync(first, firstContent, { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(second, "# Second restored\n\nSECOND_RESTORED\n", { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(forged, "# Never admitted\n\nMUST_NOT_IMPORT\n", { encoding: "utf8", flag: "wx" });
    const anchor = { scrollTop: 20, text: "First restored", ordinal: 0, delta: 0 };
    const legacy = phase === "legacy" ? JSON.stringify([
      { filePath: first, scrollPosition: 20, anchor },
      { filePath: missing, scrollPosition: 0, anchor: null },
      { filePath: second, scrollPosition: 0, anchor: null },
    ]) : phase === "empty" ? "[]" :
      phase === "corrupt-legacy" ? "{broken" :
      phase === "oversized-legacy" ? " ".repeat(1024 * 1024 + 1) :
        JSON.stringify([{ filePath: forged, scrollPosition: 0, anchor: null }]);
    const active = phase === "legacy" ? second : forged;
    if (phase === "corrupt-state" || phase === "missing-state") {
      ownedDirectory(path.join(batchRoot, "legacy"));
      const completed = path.join(batchRoot, "legacy", "document-session-import.json");
      const stat = fs.lstatSync(completed);
      if (stat.isSymbolicLink() || !stat.isFile()) fatal("prior-marker-is-not-owned-regular-file");
      const marker = JSON.parse(fs.readFileSync(completed, "utf8"));
      check("the refusal starts from a genuinely completed prior import", marker.status === "completed");
      fs.writeFileSync(path.join(profile, "document-session-import.json"),
        JSON.stringify(marker), "utf8");
      if (phase === "corrupt-state") {
        fs.writeFileSync(path.join(profile, "document-session.json"), "{corrupt", "utf8");
      }
    } else {
      for (const name of ["document-session.json", "document-session-import.json"]) {
        const file = path.join(profile, name);
        if (fs.existsSync(file)) throw new Error("The phase profile is not fresh");
      }
      if (phase === "corrupt-unmarked") {
        fs.writeFileSync(path.join(profile, "document-session.json"), "{corrupt", "utf8");
        check("corrupt new state genuinely predates any marker",
          fs.existsSync(path.join(profile, "document-session.json")) &&
            !fs.existsSync(path.join(profile, "document-session-import.json")));
      }
    }

    const indexPath = path.join(root, "src", "index.html");
    const indexUrl = pathToFileURL(indexPath).href;
    const expectedSeed = { openTabs: legacy, activeTabPath: active };
    diagnostic("expected synthetic constants", expectedSeed);
    await defaultSession.protocol.handle("file", request => {
      if (request.url !== indexUrl) throw new Error("Unexpected legacy seed request");
      return new Response(`<html><body>Legacy seed<script>
        localStorage.setItem("openTabs", ${JSON.stringify(legacy)});
        localStorage.setItem("activeTabPath", ${JSON.stringify(active)});
      </script></body></html>`, { headers: { "content-type": "text/html" } });
    });
    const seed = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const seedContents = seed.webContents;
    await seed.loadFile(indexPath);
    const seeded = await seed.webContents.executeJavaScript(`({
      openTabs: localStorage.getItem("openTabs"),
      activeTabPath: localStorage.getItem("activeTabPath"),
    })`);
    diagnostic("actual seed readback", seeded);
    check("the exact app origin genuinely has its legacy state before production preload",
      seed.webContents.getURL() === indexUrl &&
        seeded.openTabs === legacy && seeded.activeTabPath === active,
      JSON.stringify({ expected: fields(expectedSeed), actual: fields(seeded) }));
    await defaultSession.protocol.unhandle("file");
    let win = null;
    let tracingReplay = false;
    let replayTrace = null;
    observeInitialBootstrap = (event, data) => {
      storageBoundary();
      if (tracingReplay) {
        replayTrace = {
          mainWindow: event.sender === win.webContents,
          mainFrame: event.senderFrame === event.sender.mainFrame,
          url: event.senderFrame.url,
          nonceMatches: initialBootstraps.get(event.sender)?.nonce === data?.nonce,
        };
      }
      if (initialBootstraps.has(event.sender)) return;
      // Keep exact values and the private nonce in Main only. Observation must
      // not change returnValue, payload, listener order, or execute page JS.
      initialBootstraps.set(event.sender, {
        nonce: data?.nonce,
        openTabs: data?.openTabs,
        activeTabPath: data?.activeTabPath,
        fingerprints: fields(data),
        captureErrorAbsent: data != null &&
          !Object.prototype.hasOwnProperty.call(data, "captureError"),
        mainFrame: event.senderFrame === event.sender.mainFrame,
        url: event.senderFrame.url,
      });
      diagnostic("actual FIRST bootstrap", data);
    };
    ipcMain.on("bootstrap-legacy-document-session", observeInitialBootstrap);
    const replayPreload = path.join(profile, "bootstrap-replay-preload.js");
    fs.writeFileSync(replayPreload, `
      const { contextBridge, ipcRenderer } = require("electron");
      const argument = process.argv.find(value =>
        value.startsWith("--folia-session-bootstrap="));
      if (process.isMainFrame && argument) {
        const payload = Object.freeze({
          nonce: argument.slice("--folia-session-bootstrap=".length),
          openTabs: ${JSON.stringify(JSON.stringify([{ filePath: forged, scrollPosition: 0, anchor: null }]))},
          activeTabPath: ${JSON.stringify(forged)},
        });
        contextBridge.exposeInMainWorld("__foliaBootstrapReplayTest", Object.freeze({
          replay() {
            return ipcRenderer.sendSync("bootstrap-legacy-document-session", payload);
          },
        }));
      }
    `, "utf8");
    replayPreloadId = defaultSession.registerPreloadScript({ type: "frame", filePath: replayPreload });
    let chooserExpectation = null;
    let chooserCalls = 0;
    const armChooser = leg => {
      if (chooserExpectation) fatal("unconsumed-native-chooser-expectation");
      chooserExpectation = leg;
    };
    dialog.showOpenDialog = (...args) => {
      try {
        const options = {
          properties: ["openFile", "multiSelections"],
          filters: [
            { name: "Markdown Files", extensions: ["md", "markdown", "mdown", "mkd", "mkdn"] },
            { name: "Mermaid Files", extensions: ["mmd", "mermaid"] },
            { name: "All Files", extensions: ["*"] },
          ],
        };
        storageBoundary();
        if (phase !== "corrupt-unmarked" || !chooserExpectation ||
            args.length !== 2 || !win || win.isDestroyed() || args[0] !== win ||
            win.webContents.isDestroyed() || win.webContents.getURL() !== indexUrl ||
            !isDeepStrictEqual(args[1], options)) {
          fatal("unexpected-native-chooser-owner-or-options");
        }
        const stat = fs.lstatSync(first);
        if (stat.isSymbolicLink() || !stat.isFile() ||
            path.relative(first, fs.realpathSync.native(first)) !== "" ||
            !fs.readFileSync(first).equals(Buffer.from(firstContent, "utf8"))) {
          fatal("native-chooser-fixture-is-not-exact-owned-regular-file");
        }
        chooserExpectation = null;
        chooserCalls++;
        return Promise.resolve({ canceled: false, filePaths: [first] });
      } catch (error) {
        fatal("native-chooser-validation-failed", error);
      }
    };
    stage = "production-main-import";
    storageBoundary();
    // Main's caught errors bypass fatal(), and even JSON.parse messages can
    // quote legacy text. Keep one metadata event per log, never format its args.
    const categories = new Map([
      ["Could not restore the main-owned document session:", "document-session-bootstrap-failed"],
      ["Could not persist the failed session import marker:", "document-session-marker-failed"],
      ["Session persistence worker failed:", "document-session-persistence-failed"],
      ["Session write cleanup failed:", "document-session-write-cleanup-failed"],
      ["Could not persist native document admission:", "document-admission-persistence-failed"],
      ["Approved document open refused:", "approved-document-open-refused"],
      ["ERROR: Error reading file:", "document-read-failed"],
      ["Error opening file:", "native-document-open-failed"],
    ]);
    for (const level of ["log", "info", "debug", "warn", "error"]) {
      const write = console[level].bind(console);
      console[level] = (...args) => {
        const errors = args.filter(value => value instanceof Error);
        const category = errors.some(error =>
          error.message === "Controlled approved reopen result delivery refusal")
          ? "controlled-approved-reopen-delivery-refusal"
          : categories.get(args[0]) || "production-diagnostic";
        write(`PRODUCTION ${level}: ${JSON.stringify({
          phase, stage, category, errors: errors.map(errorMetadata),
        })}`);
      };
    }
    // Console redaction cannot protect Main's separately opted-in raw file sink.
    if (process.env.FOLIA_DIAGNOSTIC_LOG === "1") fatal("raw-file-diagnostics-not-supported");
    const modalTripwire = `document-session-unexpected-modal-${crypto.randomBytes(16).toString("hex")}`;
    const modalSelectors = [
      "#appMessageDialog[open]", "#reloadDocumentDialog[open]", "#aboutDialog[open]",
      "#noteDialogOverlay.visible", "#findNoteOverlay.visible", "#editTextOverlay.visible",
      "#mermaidTemplateOverlay.visible", "#tableInsertOverlay.visible",
    ];
    let guardedMain = null;
    let mainContents = null;
    let modalGuardReady = false;
    let modalGuardEpoch = 0;
    let modalGuardTimer = null;
    const guardEvidence = {
      candidateCount: 0, candidates: [], armCount: 0, domReadyCount: 0,
      installStarts: 0, acceptedACKs: 0, staleCompletions: 0, acceptedEpoch: null,
    };
    const retainedMainLive = () => guardedMain !== null && win === guardedMain &&
      !guardedMain.isDestroyed() && mainContents !== null && !mainContents.isDestroyed() &&
      guardedMain.webContents === mainContents;
    const currentGuardACK = () => modalGuardReady &&
      guardEvidence.acceptedEpoch === modalGuardEpoch;
    const guardMainPage = (_event, candidate) => {
      const contents = candidate.webContents;
      const bootstrapArgumentPresent = !!contents.getLastWebPreferences().additionalArguments?.some(
        argument => argument.startsWith("--folia-session-bootstrap="));
      guardEvidence.candidateCount++;
      if (guardEvidence.candidates.length < 8) {
        guardEvidence.candidates.push({
          candidateNumber: guardEvidence.candidateCount, isSeed: candidate === seed,
          bootstrapArgumentPresent,
          selectedAsGuardedMain: candidate !== seed && guardedMain === null,
        });
      }
      if (candidate === seed) return;
      if (guardedMain) fatal("unexpected-second-main-page");
      guardedMain = candidate;
      mainContents = contents;
      win = candidate;
      candidate.once("closed", () => {
        if (!terminating) fatal("retained-main-window-destroyed");
      });
      contents.once("destroyed", () => {
        if (!terminating) fatal("retained-main-webcontents-destroyed");
      });
      const armInstallation = () => {
        modalGuardReady = false;
        modalGuardEpoch++;
        guardEvidence.armCount++;
        clearTimeout(modalGuardTimer);
        modalGuardTimer = setTimeout(() => {
          stage = "renderer-html-guard-install";
          fatal("renderer-html-guard-install-timeout");
        }, 5000);
      };
      armInstallation();
      contents.on("did-start-navigation", details => {
        if (details.isMainFrame && !details.isSameDocument) armInstallation();
      });
      contents.on("console-message", details => {
        if (!terminating && details.frame === contents.mainFrame &&
            details.message === modalTripwire) {
          stage = "renderer-html-modal";
          fatal("unexpected-renderer-html-dialog");
        }
      });
      contents.on("dom-ready", () => {
        guardEvidence.domReadyCount++;
        const epoch = modalGuardEpoch;
        if (!retainedMainLive() || contents !== mainContents || contents.getURL() !== indexUrl) {
          fatal("unexpected-renderer-html-guard-page");
        }
        // No scenario expects an embedded modal: refuse before presentation.
        // Scanning separately detects pre-existing or non-showModal surfaces.
        guardEvidence.installStarts++;
        contents.executeJavaScript(`(() => {
          const prototype = HTMLDialogElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "showModal");
          if (!descriptor || typeof descriptor.value !== "function") {
            throw new Error("Renderer HTML modal guard cannot be installed");
          }
          const refuseShowModal = function () {
            console.error(${JSON.stringify(modalTripwire)});
            throw new Error("Document-session test refused an unexpected embedded modal");
          };
          Object.defineProperty(prototype, "showModal", {
            ...descriptor, value: refuseShowModal, writable: false, configurable: false,
          });
          const selectors = ${JSON.stringify(modalSelectors)};
          const scan = () => {
            if (!selectors.some(selector => document.querySelector(selector))) return true;
            console.error(${JSON.stringify(modalTripwire)});
            return false;
          };
          const observer = new MutationObserver(scan);
          observer.observe(document, {
            subtree: true, childList: true, attributes: true,
            attributeFilter: ["open", "class"],
          });
          window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
          return prototype.showModal === refuseShowModal && scan();
        })()`).then(installed => {
          if (epoch !== modalGuardEpoch) guardEvidence.staleCompletions++;
          if (terminating || epoch !== modalGuardEpoch) return;
          if (installed !== true) fatal("unexpected-renderer-html-dialog-at-install");
          if (!retainedMainLive() || contents !== mainContents || contents.getURL() !== indexUrl) {
            fatal("renderer-html-guard-ack-document-changed");
          }
          clearTimeout(modalGuardTimer);
          modalGuardReady = true;
          guardEvidence.acceptedACKs++;
          guardEvidence.acceptedEpoch = epoch;
        }).catch(error => {
          if (epoch !== modalGuardEpoch) guardEvidence.staleCompletions++;
          if (!terminating && epoch === modalGuardEpoch) {
            stage = "renderer-html-guard-install";
            fatal("renderer-html-guard-install-failed", error);
          }
        });
      });
    };
    const beforeMain = BrowserWindow.getAllWindows().filter(candidate => !candidate.isDestroyed());
    if (beforeMain.length !== 1 || beforeMain[0] !== seed || seed.isDestroyed() ||
        seedContents.isDestroyed() || seed.webContents !== seedContents) {
      fatal("unexpected-pre-main-window-topology");
    }
    app.on("browser-window-created", guardMainPage);
    stopModalGuard = () => {
      clearTimeout(modalGuardTimer);
      app.removeListener("browser-window-created", guardMainPage);
    };
    const { __shutdown } = require("../src/main.js");
    shutdown = __shutdown;
    const requireCurrentDocument = () => {
      if (!retainedMainLive() || mainContents.getURL() !== indexUrl || !currentGuardACK()) {
        fatal("retained-main-document-not-current");
      }
    };
    const ownedExec = async (code, userGesture = true) => {
      requireCurrentDocument();
      const epoch = modalGuardEpoch;
      const owner = __shutdown.state();
      if (owner.renderer !== "ready" || !Number.isSafeInteger(owner.rendererGeneration) ||
          owner.rendererGeneration <= 0) fatal("retained-main-owner-not-ready");
      const requireSameScope = () => {
        requireCurrentDocument();
        const currentOwner = __shutdown.state();
        if (epoch !== modalGuardEpoch || currentOwner.renderer !== "ready" ||
            currentOwner.rendererGeneration !== owner.rendererGeneration) {
          fatal("retained-main-owner-or-epoch-changed-during-exec");
        }
        return currentOwner;
      };
      // The existing bridge authenticates the actual document owner in Main;
      // preference visibility is diagnostic, not an ownership oracle.
      let generation;
      try {
        generation = await mainContents.executeJavaScript(
          "window.folia.getQuitApprovalGeneration()", userGesture);
      } catch (error) {
        requireSameScope();
        fatal("retained-main-owner-bridge-failed", error);
      }
      const currentOwner = requireSameScope();
      if (!Number.isSafeInteger(generation) || generation <= 0 ||
          generation !== currentOwner.rendererGeneration) {
        fatal("retained-main-owner-bridge-generation-mismatch");
      }
      try {
        const result = await mainContents.executeJavaScript(code, userGesture);
        requireSameScope();
        return result;
      } catch (error) {
        requireSameScope();
        throw error;
      }
    };
    const startupTopologyMatches = live => retainedMainLive() &&
      !seed.isDestroyed() && !seedContents.isDestroyed() && seed.webContents === seedContents &&
      live.length === 2 && live.includes(seed) && live.includes(guardedMain);
    const until = async predicate => {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return false;
    };
    stage = "production-startup";
    let reachedPredicateStage = "not-polled";
    let liveNonseedWindowCount = 0;
    let rendererReadiness = null;
    const ready = await until(async () => {
      reachedPredicateStage = "live-nonseed-window";
      rendererReadiness = null;
      const live = BrowserWindow.getAllWindows().filter(candidate => !candidate.isDestroyed());
      liveNonseedWindowCount = live.filter(candidate => candidate !== seed).length;
      if (!guardedMain) return false;
      reachedPredicateStage = "guarded-main-match";
      if (!retainedMainLive()) return false;
      reachedPredicateStage = "startup-window-topology";
      if (!startupTopologyMatches(live)) return false;
      reachedPredicateStage = "exact-index-document";
      if (mainContents.getURL() !== indexUrl) return false;
      reachedPredicateStage = "first-bootstrap-owner";
      const firstBootstrap = initialBootstraps.get(mainContents);
      if (!firstBootstrap?.mainFrame || firstBootstrap.url !== indexUrl) return false;
      reachedPredicateStage = "modal-guard-ack";
      if (!currentGuardACK()) return false;
      reachedPredicateStage = "main-owner-ready";
      if (__shutdown.state().renderer !== "ready") return false;
      reachedPredicateStage = "owner-bridge-and-renderer-predicate";
      rendererReadiness = await ownedExec(`(() => {
        const customTabs = !!window.CustomTabs;
        let tabCount = null, viewerPresent = null, expectedMarker = null;
        let ready = customTabs;
        if (ready && ${phase === "legacy"}) {
          const count = window.CustomTabs.getTabs().length;
          tabCount = Number.isSafeInteger(count) && count >= 0 ? count : null;
          ready = count === 2;
          if (ready) {
            const viewer = document.getElementById("viewer");
            viewerPresent = viewer !== null;
            expectedMarker = viewer.textContent.includes("SECOND_RESTORED");
            ready = expectedMarker;
          }
        }
        return { customTabs, tabCount, viewerPresent, expectedMarker, ready };
      })()`, false);
      if (!startupTopologyMatches(
        BrowserWindow.getAllWindows().filter(candidate => !candidate.isDestroyed()))) {
        fatal("startup-window-topology-changed-during-readiness");
      }
      return rendererReadiness.ready;
    });
    const ownerReadiness = __shutdown.state();
    check("the actual production window and owner handshake became ready", ready, JSON.stringify({
      guard: { ...guardEvidence, epoch: modalGuardEpoch, currentACK: currentGuardACK() },
      liveNonseedWindowCount, selectedWindowExists: !!win,
      selectedGuardedMatch: !!win && win === guardedMain,
      retainedMainLive: retainedMainLive(),
      exactIndexDocument: retainedMainLive() && mainContents.getURL() === indexUrl,
      firstBootstrapSeen: mainContents !== null && initialBootstraps.has(mainContents),
      mainRenderer: ["loading", "ready", "unusable"].includes(ownerReadiness.renderer)
        ? ownerReadiness.renderer : "unexpected",
      mainRendererGeneration: Number.isSafeInteger(ownerReadiness.rendererGeneration)
        ? ownerReadiness.rendererGeneration : null,
      reachedPredicateStage, rendererReadiness,
    }));
    destroyWindow(seed);
    if (!ready) return finish();
    const remainingWindows = BrowserWindow.getAllWindows().filter(candidate => !candidate.isDestroyed());
    const soleRetainedMain = seed.isDestroyed() && remainingWindows.length === 1 &&
      remainingWindows[0] === guardedMain && retainedMainLive();
    check("seed cleanup leaves exactly the retained live Main window and WebContents", soleRetainedMain,
      JSON.stringify({
        seedDestroyed: seed.isDestroyed(), liveWindowCount: remainingWindows.length,
        retainedWindowOnly: remainingWindows.length === 1 && remainingWindows[0] === guardedMain,
        retainedContentsLive: retainedMainLive(),
      }));
    if (!soleRetainedMain) return finish();
    stage = "first-production-observation";
    storageBoundary();
    const initial = initialBootstraps.get(mainContents);
    check("the FIRST production bootstrap captures both exact seeded fields without a capture error",
      retainedMainLive() && initial?.mainFrame && initial.url === indexUrl && initial.captureErrorAbsent &&
        initial.openTabs === legacy && initial.activeTabPath === active &&
        typeof initial.nonce === "string" && initial.nonce.length > 0,
      JSON.stringify({ expected: fields(expectedSeed), actual: initial?.fingerprints || fields(null) }));
    // A matching diagnostic is not evidence that the original preservation or
    // fail-closed regression is repaired; those assertions below stay intact.
    const exec = code => ownedExec(code);
    const preferences = win.webContents.getLastWebPreferences();
    check("the bootstrap replay uses an isolated fixed test capability without page Node access",
      preferences.nodeIntegration === false && preferences.contextIsolation === true &&
        preferences.sandbox === true && await exec(
          "typeof process === 'undefined' && typeof require === 'undefined' && " +
          "typeof window.ipcRenderer === 'undefined' && " +
          "typeof window.__foliaBootstrapReplayTest?.replay === 'function'"));
    await exec("window.CustomTabs.__loadSavedTabs()");
    let layoutRefused = false;
    try {
      await exec("window.CustomTabs.settleSessionLayout()");
    } catch (error) {
      layoutRefused = true;
    }
    const storedAfter = await exec(`({
      openTabs: localStorage.getItem("openTabs"),
      activeTabPath: localStorage.getItem("activeTabPath"),
    })`);
    diagnostic("after migration", storedAfter);
    const legacyAfter = storedAfter.openTabs;
    check("migration preserves the exact legacy value without erasing or rewriting it", legacyAfter === legacy,
      JSON.stringify({ expected: fields(expectedSeed), after: fields(storedAfter) }));
    const marker = JSON.parse(fs.readFileSync(path.join(profile, "document-session-import.json"), "utf8"));
    const result = await exec("window.folia.restoreSession({ filePath: 'caller-path-is-not-an-input' })");
    if (phase === "legacy") {
      const state = JSON.parse(fs.readFileSync(path.join(profile, "document-session.json"), "utf8"));
      const view = await exec(`({
        paths: window.CustomTabs.getTabs().map(tab => tab.filePath),
        active: window.CustomTabs.getActiveTab()?.filePath,
        text: document.getElementById('viewer').textContent,
        first: window.CustomTabs.getTabs().find(tab =>
          tab.filePath === ${JSON.stringify(first)})?.scrollPosition,
      })`);
      check("private before-page import retains explicit legacy provenance and coherent complete state",
        marker.status === "completed" && state.importStatus === "completed" &&
          state.entries.length === 3 && state.entries.every(entry => entry.provenance === "legacy-profile"),
        JSON.stringify({ markerStatus: fingerprint(marker.status),
          importStatus: fingerprint(state.importStatus), entries: state.entries?.length }));
      check("actual restore preserves order, background creation, active selection and scroll metadata",
        JSON.stringify(view.paths) === JSON.stringify([first, second]) &&
          view.active === second && view.text.includes("SECOND_RESTORED") && view.first === 20,
        JSON.stringify({ paths: view.paths?.map(value => fingerprint(value)),
          active: fingerprint(view.active), text: fingerprint(view.text), first: view.first }));
      check("the unavailable document is reported and retained through the next ordinary layout save",
        !fs.existsSync(missing) && result.entries.length === 3 && result.entries.some(entry =>
          entry.filePath === missing && typeof entry.error === "string") &&
          state.entries.some(entry => entry.filePath === missing),
        JSON.stringify({ entries: result.entries?.length, error: fingerprint(result.error) }));
    } else if (phase === "empty") {
      check("a completed empty import is distinct from never attempted", marker.status === "completed" &&
        result.entries.length === 0 && result.error === undefined && !layoutRefused);
    } else {
      const expectedMarker = ["corrupt-state", "missing-state"].includes(phase)
        ? "completed" : "failed-corrupt";
      check("corrupt or missing state fails closed rather than reimporting page paths",
        marker.status === expectedMarker && result.entries.length === 0 && layoutRefused &&
          typeof result.error === "string",
        JSON.stringify({ markerStatus: fingerprint(marker.status), entries: result.entries?.length,
          error: fingerprint(result.error), layoutRefused, after: fields(storedAfter) }));
    }
    const nonce = initial?.nonce;
    if (typeof nonce !== "string" || !nonce) throw new Error("Initial native bootstrap was not observed");
    let replay;
    try {
      tracingReplay = true;
      replay = await exec("window.__foliaBootstrapReplayTest.replay()");
    } finally {
      tracingReplay = false;
    }
    check("the exact nonce replay genuinely reaches the allowed Main frame",
      replayTrace?.mainWindow && replayTrace.mainFrame && replayTrace.url === indexUrl &&
        replayTrace.nonceMatches, JSON.stringify({
          mainWindow: replayTrace?.mainWindow, mainFrame: replayTrace?.mainFrame,
          urlMatches: replayTrace?.url === indexUrl, nonceMatches: replayTrace?.nonceMatches,
        }));
    check("even the exact live bootstrap nonce cannot import again after page startup", replay === false);
    await exec(`localStorage.setItem('openTabs', ${JSON.stringify(JSON.stringify([
      { filePath: forged, scrollPosition: 0, anchor: null },
    ]))}); null`);
    const afterForgery = await exec("window.folia.restoreSession()");
    check("post-page localStorage changes never admit the forged fixture",
      !afterForgery.entries.some(entry => entry.filePath === forged));
    if (phase === "corrupt-unmarked") {
      const originalOpen = fs.promises.open;
      const originalReveal = shell.showItemInFolder;
      const reveals = [];
      let bodyOpens = 0;
      shell.showItemInFolder = target => { reveals.push(target); };
      fs.promises.open = function (target) {
        if (target === first) bodyOpens++;
        return originalOpen.apply(this, arguments);
      };
      try {
        stage = "initial-native-admission";
        const absent = await exec(`window.currentFilePath !== ${JSON.stringify(first)} &&
          !document.getElementById('viewer').textContent.includes('FIRST_RESTORED') &&
          window.CustomTabs.getTabs().length === 0 &&
          window.CustomTabs.getDocumentDescriptor() === null`);
        const fresh = absent && __shutdown.documentSessionState().admissions === 0 &&
          __shutdown.documentSessionState().history === undefined;
        check("the initial native chooser starts without a painted or admitted fixture", fresh);
        if (!fresh) fatal("initial-native-fixture-is-not-absent");
        const observedContents = mainContents;
        const observedFrame = observedContents.mainFrame;
        const observedOwner = __shutdown.state();
        const observedEpoch = modalGuardEpoch;
        const preparationChannel = "prepare-document-disk-adoption";
        const preparationHandlers = ipcMain._invokeHandlers;
        const originalPreparation = preparationHandlers?.get(preparationChannel);
        const originalNativeSend = observedContents.send;
        if (!(preparationHandlers instanceof Map) || typeof originalPreparation !== "function" ||
            typeof originalNativeSend !== "function" ||
            typeof observedOwner.rendererPageSession !== "string" ||
            !observedOwner.rendererPageSession) fatal("initial-native-observer-setup-invalid");
        let observationFailed = false;
        let deliveries = 0;
        let preparations = 0;
        let delivered = null;
        let proposedOwner = null;
        let preparationReply = null;
        let preparationSettled = false;
        let native = false;
        const nativeScopeCurrent = () => {
          const current = __shutdown.state();
          return nativeObserversInstalled && retainedMainLive() && mainContents === observedContents &&
            observedContents.getURL() === indexUrl && observedContents.mainFrame === observedFrame &&
            !observedFrame.isDestroyed() && observedFrame.url === indexUrl &&
            currentGuardACK() && modalGuardEpoch === observedEpoch &&
            current.renderer === "ready" &&
            current.rendererGeneration === observedOwner.rendererGeneration &&
            current.rendererPageSession === observedOwner.rendererPageSession &&
            preparationHandlers.get(preparationChannel) === observedPreparation &&
            observedContents.send === observedNativeSend;
        };
        // Never throw observer faults into safeSendFileOpen's product-failure catch.
        const failObservation = (reason, error) => {
          if (observationFailed) return;
          observationFailed = true;
          queueMicrotask(() => fatal(reason, error));
        };
        const observe = action => {
          if (observationFailed) return;
          try {
            if (!nativeScopeCurrent()) {
              failObservation("initial-native-observer-scope-changed");
              return;
            }
            action();
          } catch (error) {
            failObservation("initial-native-observer-failed", error);
          }
        };
        // Only fixed refusal codes enter evidence; continuation grants are not terminal.
        const refusalReasons = new Set([
          "invalid-adoption-sender", "invalid-adoption-identity", "unapproved-adoption-source",
          "disk-bytes-or-target-moved", "disk-read-failed", "adoption-moved-during-read",
          "matched-owner-deletion-evidence", "invalid-overflow-provenance",
          "ambiguous-multiple-physical-deletions", "live-sibling-deletion-evidence",
          "ambiguous-or-full-adoption-capacity",
        ]);
        const observeReply = reply => observe(() => {
          if (preparationSettled || !reply || typeof reply !== "object" || Array.isArray(reply) ||
              (reply.known !== true && reply.known !== false) ||
              (reply.known === false && !refusalReasons.has(reply.why)) ||
              (reply.known === true && (reply.pathKey !== delivered.pathKey ||
                reply.versionMatches !== true || !Number.isSafeInteger(reply.revision) ||
                reply.revision < 0 || typeof reply.capability !== "string" ||
                !/^[a-f0-9]{32}$/.test(reply.capability)))) {
            failObservation("initial-native-preparation-reply-invalid-or-incomplete");
            return;
          }
          preparationReply = reply;
          preparationSettled = true;
        });
        function observedPreparation(...args) {
          observe(() => {
            const [event, data] = args;
            const proposed = data?.proposedOwner;
            preparations++;
            if (preparations !== 1 || deliveries !== 1 || !delivered || args.length !== 2 ||
                event?.sender !== observedContents || event.senderFrame !== observedFrame ||
                event.senderFrame.url !== indexUrl || data?.filePath !== first ||
                data.ownerFilePath !== first || data.tabId !== null ||
                data.pageSession !== observedOwner.rendererPageSession ||
                data.rendererGeneration !== observedOwner.rendererGeneration ||
                proposed?.documentRef !== delivered.ref || proposed.pathKey !== delivered.pathKey ||
                proposed.pageSession !== observedOwner.rendererPageSession ||
                proposed.rendererGeneration !== observedOwner.rendererGeneration ||
                !Number.isSafeInteger(proposed.tabId) || proposed.tabId <= 0 ||
                !Number.isSafeInteger(proposed.documentGeneration) || proposed.documentGeneration <= 0) {
              failObservation("initial-native-preparation-not-correlated");
              return;
            }
            proposedOwner = { ...proposed };
          });
          let result;
          try {
            result = Reflect.apply(originalPreparation, this, args);
          } catch (error) {
            failObservation("initial-native-preparation-threw", error);
            throw error;
          }
          // Observe settlement, but return the exact original promise/value to Electron.
          observe(() => {
            if (result instanceof Promise) {
              Promise.prototype.then.call(result, observeReply,
                error => failObservation("initial-native-preparation-rejected", error));
            } else {
              observeReply(result);
            }
          });
          return result;
        }
        function observedNativeSend(...args) {
          let result;
          try {
            result = Reflect.apply(originalNativeSend, this, args);
          } catch (error) {
            if (args[0] === "file-opened") failObservation("initial-native-delivery-threw", error);
            throw error;
          }
          if (args[0] === "file-opened") observe(() => {
            const data = args[1];
            const descriptor = data?.document;
            deliveries++;
            if (this !== observedContents || deliveries !== 1 || args.length !== 2 ||
                data?.path !== first || data.content !== firstContent ||
                !isDeepStrictEqual(data.allPaths, [first]) ||
                descriptor?.logicalPath !== first || descriptor.documentUrl !== pathToFileURL(first).href ||
                typeof descriptor.ref !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.ref) ||
                typeof descriptor.pathKey !== "string" || !descriptor.pathKey) {
              failObservation("initial-native-delivery-not-correlated");
              return;
            }
            delivered = descriptor;
          });
          return result;
        }
        stopInitialNativeObservation = () => {
          if (!nativeObserversInstalled) return;
          try {
            observedContents.send = originalNativeSend;
          } finally {
            preparationHandlers.set(preparationChannel, originalPreparation);
          }
          nativeObserversInstalled = false;
        };
        nativeObserversInstalled = true;
        try {
          preparationHandlers.set(preparationChannel, observedPreparation);
          observedContents.send = observedNativeSend;
          armChooser("initial-admission");
          await exec("window.folia.openFileDialog(); null;");
          const outcome = await until(async () => {
            if (observationFailed) fatal("initial-native-observation-failed");
            if (!nativeScopeCurrent()) fatal("initial-native-observer-scope-changed");
            if (!delivered || !preparationSettled) return false;
            const painted = await exec(`({
              current: window.currentFilePath === ${JSON.stringify(first)} &&
                document.getElementById('viewer').textContent.includes('FIRST_RESTORED') &&
                window.CustomTabs.getDocumentDescriptor()?.ref === ${JSON.stringify(delivered.ref)} &&
                window.CustomTabs.getDocumentDescriptor()?.logicalPath === ${JSON.stringify(first)},
              identity: window.CustomTabs.getActiveDocumentIdentity(null, window.getReloadRequestSession()),
            })`);
            native = painted.current && painted.identity?.documentRef === delivered.ref &&
              painted.identity.pathKey === delivered.pathKey &&
              painted.identity.pageSession === proposedOwner.pageSession &&
              painted.identity.rendererGeneration === proposedOwner.rendererGeneration &&
              painted.identity.tabId === proposedOwner.tabId &&
              painted.identity.documentGeneration === proposedOwner.documentGeneration;
            if (!nativeScopeCurrent()) fatal("initial-native-outcome-scope-changed");
            if (preparationReply.known === false && painted.current) {
              fatal("initial-native-refusal-painted-a-document");
            }
            return preparationReply.known === false || native;
          });
          if (!outcome || deliveries !== 1 || preparations !== 1 || !preparationSettled) {
            fatal("initial-native-outcome-incomplete");
          }
        } finally {
          stopInitialNativeObservation();
        }
        const oldRef = delivered.ref;
        check("the initial native chooser delivers one genuine current admission while durable history is unavailable",
          deliveries === 1 && __shutdown.documentAdmissionIsCurrent(oldRef) &&
            __shutdown.documentSessionState().history === undefined);
        check("the initial admission consumes exactly its one-shot native chooser expectation",
          chooserExpectation === null && chooserCalls === 1);
        check("native chooser admits a current painted document while durable history is unavailable",
          native && __shutdown.documentSessionState().history === undefined,
          native ? "" : JSON.stringify([{
            kind: "native-adoption-refusal", detail: preparationReply.why, shot: null,
          }]));
        if (!native) {
          const skipped = [
            "admission-only approved reopen retains native provenance without importing a corrupt manifest",
            "the browser-approved reopen does not consume a native chooser expectation",
            ...["browser", "native"].flatMap(kind => [
              `the admission-only ${kind} refusal fixture reaches a newly issued real result without replacing the live tab`,
              `undelivered ${kind} result admission is discarded while the existing live reference remains usable`,
              `the ${kind} delivery-refusal leg consumes only its own chooser expectation`,
            ]),
            "retiring the only native admission removes its browser reopen permission",
            "both separately armed native chooser expectations were consumed exactly once",
          ];
          for (const name of skipped) report(`SKIP ${phase}: ${name}  -> initial native adoption was refused`);
        } else {
          const callsBeforeReopen = chooserCalls;
          await exec(`window.folia.openApprovedDocument({ filePath: ${JSON.stringify(first)} }); null;`);
          const reopened = await until(() => exec(`window.currentFilePath === ${JSON.stringify(first)} &&
            window.CustomTabs.getDocumentDescriptor()?.ref !== ${JSON.stringify(oldRef)} &&
            !!window.CustomTabs.getDocumentDescriptor()?.ref`));
          check("admission-only approved reopen retains native provenance without importing a corrupt manifest",
            reopened && bodyOpens >= 2 && __shutdown.documentSessionState().history === undefined);
          check("the browser-approved reopen does not consume a native chooser expectation",
            chooserExpectation === null && chooserCalls === callsBeforeReopen);
          if (reopened) {
            const originalSend = win.webContents.send;
            let refused = null;
            const deliveredRef = await exec("window.CustomTabs.getDocumentDescriptor().ref");
            win.webContents.send = function (channel, data) {
              if (channel === "file-opened") {
                refused = data;
                throw new Error("Controlled approved reopen result delivery refusal");
              }
              return originalSend.apply(this, arguments);
            };
            try {
              for (const [kind, request] of [
                ["browser", `window.folia.openApprovedDocument({ filePath: ${JSON.stringify(first)} }); null;`],
                ["native", "window.folia.openFileDialog(); null;"],
              ]) {
                stage = `${kind}-delivery-refusal`;
                if (kind === "native") armChooser("native-delivery-refusal");
                const callsBeforeRefusal = chooserCalls;
                refused = null;
                await exec(request);
                const refusedDelivery = await until(() => refused !== null);
                check(`the admission-only ${kind} refusal fixture reaches a newly issued real result without replacing the live tab`,
                  refusedDelivery && refused.document.ref !== deliveredRef &&
                    await exec("window.CustomTabs.getDocumentDescriptor().ref") === deliveredRef);
                check(`undelivered ${kind} result admission is discarded while the existing live reference remains usable`,
                  refusedDelivery && __shutdown.documentSessionState().admissions === 1 &&
                    await exec("window.CustomTabs.getDocumentDescriptor().ref") === deliveredRef);
                check(`the ${kind} delivery-refusal leg consumes only its own chooser expectation`,
                  chooserExpectation === null &&
                    chooserCalls === callsBeforeRefusal + (kind === "native" ? 1 : 0));
              }
            } finally { win.webContents.send = originalSend; }
          }
          await exec("(async () => { await window.CustomTabs.closeTab(window.CustomTabs.getActiveTabId()); })()");
          await exec("window.folia.getVersion()");
          const beforeRetired = bodyOpens;
          await exec(`window.folia.openApprovedDocument({ filePath: ${JSON.stringify(first)} }); null;`);
          await exec(`window.folia.revealApprovedDocument({ filePath: ${JSON.stringify(first)} }); null;`);
          await exec("window.folia.getVersion()");
          check("retiring the only native admission removes its browser reopen permission",
            bodyOpens === beforeRetired && reveals.length === 0 &&
              __shutdown.documentSessionState().history === undefined);
          if (reopened) {
            check("both separately armed native chooser expectations were consumed exactly once",
              chooserExpectation === null && chooserCalls === 2);
          }
        }
      } finally {
        fs.promises.open = originalOpen;
        shell.showItemInFolder = originalReveal;
      }
    }
    finish();
  }).catch(error => fatal("phase-execution-failed", error));
}
