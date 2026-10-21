"use strict";
require("./test-userdata-isolation");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const electron = require("electron");
const root = path.resolve(__dirname, "..");
const batch = path.resolve(process.env.MARKALOO_UPDATE_BATCH ||
  path.join(root, "tmp", "about-updates", randomUUID()));
if (!batch.startsWith(path.join(root, "tmp", "about-updates") + path.sep)) {
  throw new Error("A disposable project-local update batch is required");
}
fs.mkdirSync(batch, { recursive: true });

const combinedRequired = [
  "combined fixture admits two real documents with independent dirty editors selection and history",
  "combined actual TOC toolbar and reading zoom change geometry without changing either editor",
  "combined About opening and reopening do not check download or launch",
  "combined About traps native keyboard focus and blocks background editor shortcuts",
  "combined Escape restores visible toolbar focus and the owning draft",
  "combined pending manual check survives About close tab switch TOC toggle and reading zoom",
  "combined manual result remains shared after reopening on the other dirty document",
  "combined restored histories perform real Undo and Redo without crossing documents",
  "combined dialogs preserve both owning drafts selections histories and untouched disk",
  "combined scenarios introduce no unexpected renderer errors or stalls",
  "About sentinel proves both error channels alive",
  "About uses frozen production preload without Node or raw IPC",
  ...["clarity", "abyss"].flatMap(theme => ["normal", "narrow web zoom"].map(size =>
    `combined themed About ${theme} ${size} keeps actions and document context visible`)),
];

if (typeof electron === "string") {
  const { spawnSync } = require("child_process");
  const perf = process.argv.includes("--perf");
  const portablePhases = process.platform === "win32" ? ["portable-failure", "portable-throw",
    "portable-cancel", "portable-ambiguous"] : [];
  if (process.argv.includes("--portable") && portablePhases.length === 0) {
    throw new Error("Portable updater fixtures require Windows");
  }
  const phases = perf ? Array.from({ length: 5 }, (_, i) => "perf-" + i)
    : process.argv.includes("--ui") ? ["discover"]
    : process.argv.includes("--portable") ? portablePhases
    : process.argv.includes("--combined") ? ["combined"]
    : ["combined", "discover", "offline", "equal", "newer", "malformed", "current",
      ...portablePhases];
  console.log("About update evidence: " + batch);
  let passed = 0, total = 0;
  for (const phase of phases) {
    const result = spawnSync(electron, [__filename, phase], {
      cwd: root, encoding: "utf8", timeout: 120000,
      env: { ...process.env, MARKALOO_UPDATE_BATCH: batch },
    });
    fs.writeFileSync(path.join(batch, phase + ".stdout.log"), result.stdout || "");
    fs.writeFileSync(path.join(batch, phase + ".stderr.log"), result.stderr || "");
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    const footers = [...(result.stdout || "").matchAll(/^=== updates ([\w-]+): (\d+)\/(\d+) passed ===$/gm)];
    const footer = footers[0];
    const assertions = (result.stdout || "").split(/\r?\n/).filter(line => /^(PASS|FAIL) /.test(line));
    const assertionNames = assertions.map(line => line.slice(5).split("  ->")[0]);
    const failures = assertions.filter(line => line.startsWith("FAIL ")).length;
    const good = Number(footer?.[2]), count = Number(footer?.[3]);
    const complete = phase !== "combined" || combinedRequired.every(name =>
      assertionNames.filter(actual => actual === name).length === 1);
    if (result.error || footers.length !== 1 || footer[1] !== phase || count < 3 ||
        assertions.length !== count || failures !== count - good || !complete ||
        result.status !== (failures ? 1 : 0)) {
      console.error("FAIL update child completed  -> " + (result.error || result.status));
      process.exit(2);
    }
    passed += good;
    total += count;
  }
  console.log(`=== ${passed}/${total} passed ===`);
  if (perf) {
    const measurements = phases.map(phase => JSON.parse(fs.readFileSync(path.join(batch, phase + ".json"), "utf8")).measurement);
    const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    const summary = {};
    for (const name of ["startup", "open"]) {
      const values = measurements.map(row => row[name]);
      summary[name] = { samples: values, p50: quantile(values, 0.5), p95: quantile(values, 0.95) };
    }
    fs.writeFileSync(path.join(batch, "performance.json"), JSON.stringify({
      runtime: { node: process.version, electron: require("electron/package.json").version,
        cpu: os.cpus()[0]?.model, platform: process.platform },
      source: process.env.MARKALOO_UPDATE_SOURCE_ROOT || root, summary,
    }, null, 2));
    console.log("UPDATE_PERF " + JSON.stringify(summary));
  }
  process.exit(passed === total ? 0 : 1);
} else {
  const { app, BrowserWindow, dialog, ipcMain, shell } = electron;
  const { EventEmitter } = require("events");
  const Module = require("module");
  const phase = process.argv[2];
  if (!["combined", "discover", "offline", "equal", "newer", "malformed", "current",
    "portable-failure", "portable-throw", "portable-cancel", "portable-ambiguous",
    ...Array.from({ length: 5 }, (_, i) => "perf-" + i)].includes(phase)) {
    console.error("Unsupported update fixture phase: " + phase);
    app.exit(2);
  }
  const perf = phase.startsWith("perf-");
  const portable = phase.startsWith("portable-");
  if (portable) {
    process.env.PORTABLE_EXECUTABLE_DIR = path.join(batch, "portable-fixture");
    const temp = path.join(batch, "portable-temp");
    fs.mkdirSync(temp, { recursive: true });
    os.tmpdir = () => temp;
  } else {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  }
  const started = performance.now();
  const measurement = {};
  if (perf) {
    measurement.stages = {};
    measurement.modules = [];
    app.once("ready", () => { measurement.stages.appReady = performance.now() - started; });
    app.on("browser-window-created", (_event, target) => {
      measurement.stages.windowCreated = performance.now() - started;
      target.once("ready-to-show", () => { measurement.stages.readyToShow = performance.now() - started; });
      for (const [event, name] of [["dom-ready", "domReady"], ["did-finish-load", "didFinishLoad"]]) {
        target.webContents.once(event, () => { measurement.stages[name] = performance.now() - started; });
      }
    });
  }
  const profile = path.join(batch, ["discover", "offline"].includes(phase) ? "persistent-profile" : phase + "-profile");
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  fs.mkdirSync(path.join(batch, "crash-dumps"), { recursive: true });
  app.setPath("crashDumps", path.join(batch, "crash-dumps"));
  app.setAppLogsPath(path.join(batch, "logs"));
  const settingsFile = path.join(profile, "window-state.json");
  if (["equal", "newer", "malformed"].includes(phase)) {
    fs.writeFileSync(settingsFile, JSON.stringify({ width: 1100, height: 780,
      updateAvailability: phase === "malformed"
        ? { schema: 1, version: "<img onerror=alert(1)>", ready: true, path: "untrusted.exe" }
        : { schema: 1, version: "0.10.0" } }));
  }
  const runtimeVersion = phase === "equal" ? "0.10.0" : phase === "newer" ? "0.11.0" : "0.9.0";
  app.getVersion = () => runtimeVersion;
  const provider = new EventEmitter();
  const counts = { checks: 0, downloads: 0, launches: 0, installs: 0, kills: 0, external: [] };
  let releaseHeldLaunch;
  const installAttempts = () => counts.launches + counts.installs;
  let checkGate = null, checkMode = phase === "offline" ? "error" : "available";
  let downloadGate = null;
  const artifact = path.join(batch, "fixture-installer.exe");
  provider.quitAndInstallCalled = false;
  provider.installerPath = artifact;
  provider.autoRunAppAfterInstall = true;
  provider.checkForUpdates = async () => {
    counts.checks++;
    if (checkGate) await checkGate;
    if (checkMode === "error") throw new Error("Fixture is offline");
    const version = checkMode === "current" ? runtimeVersion : "0.10.0";
    provider.emit(checkMode === "current" ? "update-not-available" : "update-available", { version });
    return { updateInfo: { version } };
  };
  provider.downloadUpdate = async () => {
    counts.downloads++;
    provider.emit("download-progress", { percent: 42 });
    if (downloadGate) await downloadGate;
    fs.writeFileSync(artifact, "Not an executable. Controlled update fixture only.");
    provider.downloadedUpdateHelper = { file: artifact, versionInfo: { version: "0.10.0" },
      downloadedFileInfo: { sha512: "fixture-only", isAdminRightsRequired: false } };
    provider.emit("update-downloaded", { version: "0.10.0", downloadedFile: artifact });
    await new Promise(resolve => setTimeout(resolve, 150));
    return [artifact];
  };
  provider.quitAndInstall = () => {
    if (process.platform !== "linux") throw new Error("Unexpected updater installation route");
    counts.installs++;
    provider.emit("error", new Error("Fixture launch refused"));
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron-updater") return { autoUpdater: provider };
    if (perf) {
      const start = performance.now();
      try { return originalLoad.call(this, request, parent, isMain); }
      finally {
        const elapsed = performance.now() - start;
        if (elapsed >= 1) measurement.modules.push({ request, ms: elapsed });
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const childProcess = require("child_process");
  childProcess.spawn = (command, args) => {
    if (command !== artifact && !(portable && command === "cmd.exe")) {
      throw new Error("Unexpected child launch: " + command);
    }
    counts.launches++;
    if (phase === "portable-throw") throw new Error("Fixture synchronous launch refused");
    const child = new EventEmitter();
    child.unref = () => {};
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      counts.kills++;
      if (portable) counts.releasedAtCancel =
        fs.existsSync(path.join(path.dirname(args[1]), "release"));
      child.exitCode = 1;
      setImmediate(() => { child.emit("exit", 1); child.emit("close", 1); });
      return true;
    };
    if (portable) {
      counts.batchPath = args[1];
      process.nextTick(() => {
        if (phase === "portable-failure") {
          const fail = () => child.emit("error",
            Object.assign(new Error("Fixture portable launch refused"), { code: "ENOENT" }));
          if (counts.launches === 1) fail();
          else releaseHeldLaunch = fail;
        } else child.emit("spawn");
      });
    } else {
      process.nextTick(() => child.emit("error", Object.assign(new Error("Fixture launch refused"), { code: "ENOENT" })));
    }
    return child;
  };
  shell.openExternal = async url => { counts.external.push(url); };
  shell.openPath = async () => { throw new Error("No external app may run"); };
  const fixture = path.join(batch, "protected-document.md");
  const originalBody = "# Protected update fixture\n\nThis is a disposable document.\n";
  fs.writeFileSync(fixture, originalBody);
  let chosen = fixture;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  dialog.showMessageBoxSync = () => { throw new Error("Unexpected native modal"); };
  if (perf) measurement.stages.beforeMainRequire = performance.now() - started;
  const main = require(path.join(process.env.MARKALOO_UPDATE_SOURCE_ROOT || root, "src", "main.js"));
  if (perf) measurement.stages.afterMainRequire = performance.now() - started;
  if (!perf) Object.defineProperty(app, "isPackaged", { get: () => true });
  const { startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");
  const results = [];
  let win, sentinel;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const exec = code => win.webContents.executeJavaScript(code, true);
  const check = (name, ok, detail) => {
    results.push(!!ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
  };
  async function wait(label, predicate) {
    for (let i = 0; i < 300; i++) {
      if (await predicate()) return;
      await sleep(30);
    }
    throw new Error("Timed out: " + label);
  }
  const pageWait = (label, code) => wait(label, () => exec(code));
  const snapshot = () => exec("window.folia.getUpdateState()");
  const click = id => exec(`document.getElementById(${JSON.stringify(id)}).click();true`);
  async function openAbout() {
    await click("menuBtn");
    await click("fileBtn");
    await click("aboutMenuItem");
    await pageWait("About is open", "document.querySelector('body > #aboutDialog')?.open");
  }
  async function closeAbout() {
    await exec("window.MarkalooDialogs.closeAbout();true");
    await sleep(30);
  }
  async function question() {
    let target;
    await wait("Main-owned shutdown question", async () => {
      target = BrowserWindow.getAllWindows().find(candidate =>
        !candidate.isDestroyed() && candidate.webContents.getURL().includes("owned-dialog.html"));
      return target && target.webContents.executeJavaScript("document.querySelector('dialog')?.open===true");
    });
    return target;
  }
  async function choose(target, choice) {
    await target.webContents.executeJavaScript(
      `document.querySelector('[data-dialog-choice="${choice}"]').click();true`);
  }
  async function combined() {
    await closeAbout();
    await openAbout();
    await closeAbout();
    await openAbout();
    check(combinedRequired[2], counts.checks === 0 && counts.downloads === 0 && installAttempts() === 0);
    // Start the manual check before the packaged startup timer; keeping it held
    // proves that scheduled startup coalesces without a timing-sensitive count.
    let releaseCheck;
    checkGate = new Promise(resolve => { releaseCheck = resolve; });
    await click("aboutCheckUpdates");
    await wait("combined one held manual check", () => counts.checks === 1);
    await closeAbout();
    win.setSize(1280, 850);
    const files = ["alpha", "beta"].map(name => path.join(batch, "combined-" + name + ".md"));
    const bodies = ["Alpha", "Beta"].map(name => "# Combined " + name + "\n\n" +
      Array.from({ length: 18 }, (_, i) =>
        (i % 6 === 0 ? "## " + name + " section " + i + "\n\n" : "") +
        name + " paragraph " + i + ". " + "Independent editor and outline witness. ".repeat(5)).join("\n\n"));
    files.forEach((file, i) => fs.writeFileSync(file, bodies[i]));
    const tabs = [], drafts = [], undoTargets = [];
    const state = () => exec(`({
      edit:isEditMode,value:markdownEditor.value,start:markdownEditor.selectionStart,
      end:markdownEditor.selectionEnd,direction:markdownEditor.selectionDirection,
      history:JSON.stringify(historySnapshot()),dirty:hasUnsavedChanges
    })`);
    const panel = () => exec(`({
      toc:indexPanel.classList.contains('visible'),notes:notesPanel.classList.contains('visible'),
      pressed:toggleTocBtn.getAttribute('aria-pressed'),expanded:toggleTocBtn.getAttribute('aria-expanded'),
      saved:localStorage.getItem('readingSidePanel'),zoom:zoomLevel,
      label:zoomResetBtn.textContent,scale:Number(getComputedStyle(viewer).zoom)
    })`);
    async function settle() {
      await sleep(180);
      await exec("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
    }
    async function select(index) {
      await exec(`window.CustomTabs.switchToTab(${tabs[index]})`);
      await pageWait("combined selected document " + index, `window.CustomTabs.getActiveTabId()===${tabs[index]}&&
        viewer.querySelector('h1')?.textContent===${JSON.stringify("Combined " + (index ? "Beta" : "Alpha"))}&&
        !loadingScreen.classList.contains('active')`);
      await settle();
    }
    async function key(keyCode, modifiers = []) {
      win.focus();
      win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await sleep(40);
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (let i = 0; i < files.length; i++) {
      chosen = files[i];
      await click("openFile");
      await pageWait("combined admitted document " + i, `currentFilePath===${JSON.stringify(chosen)}&&
        viewer.querySelector('h1')?.textContent===${JSON.stringify("Combined " + (i ? "Beta" : "Alpha"))}&&
        !loadingScreen.classList.contains('active')`);
      tabs.push(await exec("window.CustomTabs.getActiveTabId()"));
    }
    // Admit both clean files through the real dialog before dirtying either.
    // Opening over unsaved work correctly asks for consent; bypassing that
    // question here would test the wrong admission lifecycle.
    for (let i = 0; i < files.length; i++) {
      await select(i);
      await click("openEditorBtn");
      await pageWait("combined split editor", "isEditMode&&contentWrapper.classList.contains('split-view')");
      const text = bodies[i] + "\n\nUnsaved combined " + (i ? "Beta" : "Alpha") + " witness.\n";
      undoTargets.push(text);
      await exec(`markdownEditor.value=${JSON.stringify(text)};
        markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true`);
      await sleep(900);
      const second = text + "\nSecond independent revision.\n";
      await exec(`markdownEditor.value=${JSON.stringify(second)};
        markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));
        markdownEditor.setSelectionRange(${12 + i},${28 + i},'backward');true`);
      await pageWait("combined edited preview", `viewer.textContent.includes(${JSON.stringify("Unsaved combined " + (i ? "Beta" : "Alpha") + " witness.")})&&
        viewer.textContent.includes('Second independent revision.')&&currentReloadSnapshot()===${JSON.stringify(second)}&&
        !loadingScreen.classList.contains('active')`);
      await sleep(900);
      drafts.push(await state());
    }
    // Switching captures the active draft into its tab before the cache oracle.
    await select(0);
    check(combinedRequired[0], tabs[0] !== tabs[1] && drafts[0].value !== drafts[1].value &&
      drafts.every((draft, i) => draft.edit && draft.dirty && draft.start < draft.end &&
        JSON.parse(draft.history).undo.includes(undoTargets[i]) &&
        JSON.parse(draft.history).undo.includes(draft.value)) &&
      await exec(`window.CustomTabs.getTabs().filter(t=>${JSON.stringify(tabs)}.includes(t.id)).length===2&&
        window.CustomTabs.getTabs().filter(t=>${JSON.stringify(tabs)}.includes(t.id)).every(t=>t.hasUnsavedChanges)`), drafts);
    if (!(await panel()).toc) await click("toggleTocBtn");
    await click("zoomReset");
    const before = await exec("getViewerScroller().getBoundingClientRect().width");
    await click("toggleTocBtn");
    await settle();
    const closed = await panel();
    const wider = await exec("getViewerScroller().getBoundingClientRect().width");
    await click("toggleTocBtn");
    for (let i = 0; i < 5; i++) await click("zoomIn");
    await settle();
    const opened = await panel();
    check(combinedRequired[1], !closed.toc && closed.pressed === "false" && wider > before + 10 &&
      opened.toc && !opened.notes && opened.pressed === "true" && opened.expanded === "true" &&
      opened.saved === "toc" && opened.zoom === 150 && opened.scale === 1.5 && opened.label.includes("150") &&
      same(await state(), drafts[0]) &&
      await exec("indexList.querySelector('.index-item')?.textContent==='Combined Alpha'"), { before, wider, closed, opened });
    await openAbout();
    await closeAbout();
    await openAbout();
    const keyboardBefore = await state();
    const backgroundBefore = await panel();
    let trapped = true, traversed = new Set();
    for (let i = 0; i < 9; i++) {
      await key("Tab", i > 5 ? ["shift"] : []);
      const focus = await exec(`({inside:aboutDialog.contains(document.activeElement),id:document.activeElement.id,
        choice:document.activeElement.dataset.dialogChoice})`);
      trapped = trapped && focus.inside;
      traversed.add(focus.id || focus.choice);
    }
    await key("z", ["control"]);
    await key("e", ["control"]);
    await key("=", ["control"]);
    check(combinedRequired[3], trapped && traversed.size > 1 &&
      await exec("aboutDialog.open&&aboutDialog.contains(document.activeElement)") &&
      same(await state(), keyboardBefore) && same(await panel(), backgroundBefore), [...traversed]);
    await key("Escape");
    await pageWait("combined Escape dismisses About", "!document.getElementById('aboutDialog').open");
    check(combinedRequired[4], await exec("document.activeElement.id==='menuBtn'") &&
      same(await state(), drafts[0]));
    await openAbout();
    await click("aboutCheckUpdates");
    await wait("combined one held manual check", () => counts.checks === 1);
    await pageWait("combined checking button", "aboutCheckUpdates.disabled&&window.folia.getUpdateState().then(s=>s.status==='checking')");
    await closeAbout();
    await select(1);
    await click("toggleTocBtn");
    await click("zoomOut");
    await settle();
    const pendingPanel = await panel();
    await openAbout();
    check(combinedRequired[5], counts.checks === 1 && counts.downloads === 0 &&
      (await snapshot()).status === "checking" &&
      await exec("aboutDialog.open&&aboutCheckUpdates.disabled") &&
      !pendingPanel.toc && pendingPanel.pressed === "false" && pendingPanel.zoom === 140 &&
      same(await state(), drafts[1]), pendingPanel);
    releaseCheck();
    checkGate = null;
    await pageWait("combined manual result", "aboutUpdateStatus.textContent.includes('0.10.0')&&!aboutCheckUpdates.disabled");
    await closeAbout();
    await select(0);
    await click("toggleTocBtn");
    await click("zoomIn");
    await openAbout();
    check(combinedRequired[6], counts.checks === 1 && counts.downloads === 0 && installAttempts() === 0 &&
      await exec("aboutUpdateStatus.textContent===updateMessage.textContent&&aboutUpdateStatus.textContent.includes('0.10.0')&&aboutInstallUpdate.hidden") &&
      same(await state(), drafts[0]) && (await panel()).toc);
    for (const theme of ["clarity", "abyss"]) {
      await exec(`window.foliaThemes.setScheme(${JSON.stringify(theme)});true`);
      for (const narrow of [false, true]) {
        win.setMinimumSize(400, 400);
        win.setSize(narrow ? 680 : 1280, narrow ? 720 : 850);
        win.webContents.setZoomFactor(narrow ? 1.25 : 1);
        await settle();
        const layout = await exec(`(()=>{
          const d=document.getElementById('aboutDialog'),r=d.getBoundingClientRect();
          const body=d.querySelector('.note-dialog-body').getBoundingClientRect();
          return {width:innerWidth,theme:document.body.dataset.theme,open:d.open,
            inside:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,
            actions:['aboutCheckUpdates','aboutUpdateStatus','aboutDownloadUpdate'].every(id=>{
              const a=document.getElementById(id).getBoundingClientRect();
              return a.width>0&&a.top>=body.top&&a.bottom<=body.bottom+1;
            }),close:[...d.querySelectorAll('.note-dialog-footer button')].every(b=>{
              const a=b.getBoundingClientRect();return a.width>0&&a.bottom<=innerHeight+1;
            }),editor:isEditMode&&contentWrapper.classList.contains('split-view'),
            toc:indexPanel.classList.contains('visible'),zoom:zoomLevel};
        })()`);
        check(`combined themed About ${theme} ${narrow ? "narrow web zoom" : "normal"} keeps actions and document context visible`,
          layout.theme === theme && layout.open && layout.inside && layout.actions && layout.close &&
          layout.editor && layout.toc && layout.zoom === 150 && (!narrow || layout.width < 600), layout);
        fs.writeFileSync(path.join(batch, `combined-about-${theme}-${narrow ? "narrow-125" : "normal"}.png`),
          (await win.webContents.capturePage()).toPNG());
      }
    }
    win.webContents.setZoomFactor(1);
    win.setSize(1280, 850);
    await closeAbout();
    let historyWorks = true;
    for (let i = 0; i < 2; i++) {
      await select(i);
      // The history stores settled input snapshots, including the current one.
      // Consume that entry before requiring a real transition to the first edit.
      await exec("historyUndo();true");
      await settle();
      await exec("historyUndo();true");
      await pageWait("combined real Undo " + i, `markdownEditor.value===${JSON.stringify(undoTargets[i])}&&
        !viewer.textContent.includes('Second independent revision.')`);
      await exec("historyRedo();true");
      await settle();
      await exec("historyRedo();true");
      await pageWait("combined real Redo " + i, `markdownEditor.value===${JSON.stringify(drafts[i].value)}`);
      historyWorks = historyWorks && await exec(`hasUnsavedChanges&&
        !markdownEditor.value.includes(${JSON.stringify("Unsaved combined " + (i ? "Alpha" : "Beta") + " witness.")})`);
      // Undo/Redo moves the caret by design; restore the original witness before
      // comparing the independently owned selection and history snapshots.
      await exec(`markdownEditor.setSelectionRange(${drafts[i].start},${drafts[i].end},${JSON.stringify(drafts[i].direction)});true`);
    }
    check(combinedRequired[7], historyWorks);
    const restored = [];
    for (let i = 0; i < 2; i++) {
      await select(i);
      restored.push(await state());
    }
    check(combinedRequired[8], restored.every((value, i) => same(value, drafts[i])) &&
      files.every((file, i) => fs.readFileSync(file, "utf8") === bodies[i]) &&
      !main.__shutdown.state().authorized && counts.downloads === 0 && counts.external.length === 0, restored);
    const observation = await sentinel.stop();
    check(combinedRequired[9], observation.hits.length === 0 && observation.stalls.length === 0, observation);
  }
  async function finish(error) {
    if (error) check("About update harness completed", false, error.stack);
    clearTimeout(watchdog);
    const passed = results.filter(Boolean).length;
    const receipt = { phase, runtimeVersion, counts, results, profile, measurement };
    fs.writeFileSync(path.join(batch, phase + ".json"), JSON.stringify(receipt, null, 2));
    const text = `=== updates ${phase}: ${passed}/${results.length} passed ===\n`;
    fs.writeSync(1, text);
    app.exit(error || passed !== results.length ? 1 : 0);
  }
  const watchdog = setTimeout(() => finish(new Error("Watchdog")), 105000);
  app.whenReady().then(async () => {
    await wait("reader window", () => {
      win = BrowserWindow.getAllWindows().find(candidate =>
        candidate.webContents.getURL().endsWith("index.html"));
      return !!win;
    });
    if (perf) {
      await pageWait("painted reader", "!!document.getElementById('viewer')&&typeof window.CustomTabs?.getTabs==='function'");
      measurement.stages.readerObserved = performance.now() - started;
      measurement.frames = await exec(`new Promise(resolve=>{
        const start=performance.now();
        requestAnimationFrame(first=>requestAnimationFrame(second=>resolve({
          start,first,second,visibility:document.visibilityState,focused:document.hasFocus(),
          navigation:performance.getEntriesByType('navigation').map(entry=>({
            responseEnd:entry.responseEnd,domInteractive:entry.domInteractive,
            domContentLoaded:entry.domContentLoadedEventEnd,load:entry.loadEventEnd
          }))
        })));
      })`);
      measurement.startup = performance.now() - started;
      measurement.window = { visible: win.isVisible(), focused: win.isFocused(),
        backgroundThrottling: win.webContents.getBackgroundThrottling() };
      const { generate } = require("../bench/corpus");
      const body = "# Update performance fixture\n\n" + generate("prose", 64 * 1024);
      fs.writeFileSync(fixture, body);
      const openStarted = performance.now();
      await click("openFile");
      await pageWait("representative prose painted", "viewer.querySelector('h1')?.textContent==='Update performance fixture'&&!loadingScreen.classList.contains('active')");
      await exec("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
      measurement.open = performance.now() - openStarted;
      check("performance sample uses a real representative prose document", await exec("originalMarkdown.length>65536&&viewer.querySelectorAll('p').length>150"));
      check("performance sample runs without updater network calls", counts.checks === 0 && counts.downloads === 0);
      check("performance sample records startup and painted document", measurement.startup > 0 && measurement.open > 0);
      await finish();
      return;
    }
    await pageWait("production updater bridge", "!!window.MarkalooUpdates&&!!window.folia?.getUpdateState");
    await pageWait("shutdown renderer registered", "typeof window.CustomTabs?.getTabs==='function'");
    sentinel = startErrorSentinel(win, { label: "about-updates" });
    const alive = await proveSentinelAlive(win, sentinel);
    check("About sentinel proves both error channels alive", alive.console && alive.dom, alive);
    check("About uses frozen production preload without Node or raw IPC",
      await exec("Object.isFrozen(window.folia)&&typeof require==='undefined'&&typeof window.folia.invoke==='undefined'"));
    await openAbout();
    check("About follows the actual Edit Mode menu item",
      await exec("document.getElementById('toggleEdit').nextElementSibling===document.getElementById('aboutMenuItem')"));
    check("About displays Main runtime version rather than package version",
      await exec(`document.getElementById('aboutVersion').textContent===${JSON.stringify("Version " + runtimeVersion)}`));
    check("About status and update actions follow Check for updates",
      await exec(`(()=>{
        const check=document.getElementById('aboutCheckUpdates');
        return ['aboutUpdateStatus','aboutDownloadUpdate','aboutInstallUpdate'].every(id=>
          !!(check.compareDocumentPosition(document.getElementById(id))&Node.DOCUMENT_POSITION_FOLLOWING));
      })()`));
    check("opening About performs no provider check or download", counts.checks === 0 && counts.downloads === 0);
    if (phase === "combined") {
      await combined();
    } else if (portable) {
      await click("aboutCheckUpdates");
      await pageWait("portable available", "document.getElementById('aboutDownloadUpdate').hidden===false");
      await click("aboutDownloadUpdate");
      await pageWait("portable verified ready", "window.folia.getUpdateState().then(s=>s.canInstall)");
      check("portable fixture uses a verified download without any process launch", counts.downloads === 1 && counts.launches === 0);
      if (phase === "portable-cancel") {
        await closeAbout();
        await click("openFile");
        await pageWait("portable fixture painted", "viewer.querySelector('h1')?.textContent==='Protected update fixture'");
        await click("toggleEdit");
        await exec("markdownEditor.value='# Portable fixture\\n\\nKeep these unsaved edits.\\n';markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true");
        await pageWait("portable dirty", "hasUnsavedChanges===true");
        await openAbout();
      }
      await click("aboutInstallUpdate");
      if (phase === "portable-cancel") {
        await choose(await question(), "0");
        await wait("portable child intercepted", () => counts.launches === 1);
        await choose(await question(), "1");
        await pageWait("portable safe cancellation", "window.folia.getUpdateState().then(s=>s.canInstall)");
        check("portable commit cancellation is not reported as failure",
          (await snapshot()).status === "ready" && !(await snapshot()).error);
        check("portable commit cancellation preserves genuine unsaved edits and disk",
          await exec("hasUnsavedChanges&&currentReloadSnapshot().includes('Keep these unsaved edits.')") &&
          fs.readFileSync(fixture, "utf8") === originalBody && !main.__shutdown.state().authorized);
      } else {
        await wait("portable child intercepted", () => counts.launches === 1);
        if (phase === "portable-throw") {
          await pageWait("portable synchronous failure safe retry", "window.folia.getUpdateState().then(s=>s.canInstall)");
        } else {
          await wait("portable cancellation reached the intercepted child", () => counts.kills === 1);
          await sleep(60);
          check("portable fixture proves the release boundary before cancellation",
            counts.releasedAtCancel === (phase === "portable-ambiguous"));
        }
        const state = await snapshot();
        if (phase === "portable-failure" || phase === "portable-throw") {
          await pageWait("portable failure safe retry", "window.folia.getUpdateState().then(s=>s.canInstall)");
          check(`portable ${phase === "portable-throw" ? "synchronous " : ""}launch failure is visible and safely retryable`,
            state.status === "error" && state.error?.includes("could not be started") && state.canInstall);
        } else {
          check("portable ambiguous handoff requires restart and forbids retry",
            state.status === "error" && state.error?.includes("Restart Markaloo") && !state.canInstall && !state.canCheck);
          await exec("window.folia.installUpdate();true");
          check("portable ambiguous handoff cannot launch a second child", counts.launches === 1);
        }
        check("portable failures retain availability and revoke shutdown approval",
          state.availableVersion === "0.10.0" && !main.__shutdown.state().authorized);
        if (phase === "portable-failure") {
          await openAbout();
          await click("aboutInstallUpdate");
          await wait("portable retry launch held", () => counts.launches === 2 && !!releaseHeldLaunch);
          const retryState = await snapshot();
          check("portable accepted retry clears the previous failure while pending",
            retryState.status === "installing" && !retryState.error && !retryState.canInstall);
          releaseHeldLaunch();
          await wait("portable retry child stopped", () => counts.kills === 2);
          await pageWait("portable retry safely refused", "window.folia.getUpdateState().then(s=>s.canInstall)");
        }
      }
      check("portable fixtures never ran a real installer or external application", counts.external.length === 0);
    } else if (phase === "discover") {
      let releaseCheck;
      checkGate = new Promise(resolve => { releaseCheck = resolve; });
      await click("aboutCheckUpdates");
      await wait("one pending check", () => counts.checks === 1);
      await pageWait("checking UI", "document.getElementById('aboutCheckUpdates').disabled");
      await exec("window.folia.checkForUpdates();window.folia.checkForUpdates();true");
      check("checking disables the button and coalesces duplicate commands",
        counts.checks === 1 && (await snapshot()).status === "checking");
      releaseCheck();
      checkGate = null;
      await pageWait("available update", "document.getElementById('aboutUpdateStatus').textContent.includes('0.10.0')");
      check("About and startup notice show the same available version",
        await exec("document.getElementById('updateMessage').textContent===document.getElementById('aboutUpdateStatus').textContent&&document.getElementById('appUpdateToast').classList.contains('show')"));
      check("checking availability never downloads automatically", counts.downloads === 0);
      check("profile stores only validated version metadata",
        JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, "utf8")).updateAvailability) ===
        '{"schema":1,"version":"0.10.0"}');
      await closeAbout();
      await openAbout();
      check("reopening About preserves status without another check", counts.checks === 1 &&
        await exec("document.getElementById('aboutUpdateStatus').textContent.includes('0.10.0')"));
      await sleep(5200);
      check("scheduled startup coalesces with the earlier manual check", counts.checks === 1);
      const beforeForged = counts.checks;
      ipcMain.emit("check-for-updates", { sender: win.webContents, senderFrame: null });
      check("missing-frame updater command is refused", counts.checks === beforeForged);
      check("updater has one event handler per live download event",
        provider.listenerCount("download-progress") === 1 && provider.listenerCount("update-downloaded") === 1);
      check("Download and Later cannot enable ordinary-quit installation",
        provider.autoDownload === false && provider.autoInstallOnAppQuit === false);
      checkMode = "error";
      await click("aboutCheckUpdates");
      await pageWait("check error", "document.getElementById('aboutUpdateStatus').textContent.includes('Fixture is offline')&&!document.getElementById('aboutCheckUpdates').disabled");
      check("failed manual check keeps availability and enables retry",
        (await snapshot()).availableVersion === "0.10.0" && (await snapshot()).status === "error");
      checkMode = "current";
      await click("aboutCheckUpdates");
      await pageWait("no-update retains knowledge", "document.getElementById('aboutUpdateStatus').textContent.includes('did not confirm')");
      check("later no-update cannot erase remembered newer availability", (await snapshot()).availableVersion === "0.10.0");
      checkMode = "available";
      await click("aboutCheckUpdates");
      await pageWait("retry successful", "document.getElementById('aboutCheckUpdates').disabled===false&&document.getElementById('aboutDownloadUpdate').hidden===false");
      for (const theme of ["clarity", "abyss"]) {
        await exec(`window.foliaThemes.setScheme(${JSON.stringify(theme)});true`);
        await sleep(150);
        fs.writeFileSync(path.join(batch, `about-${theme}.png`), (await win.webContents.capturePage()).toPNG());
        win.setMinimumSize(400, 400);
        win.setSize(520, 650);
        win.webContents.setZoomFactor(1.5);
        await sleep(180);
        const layout = await exec(`(()=>{
          const d=document.getElementById('aboutDialog'),r=d.getBoundingClientRect();
          return {inside:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,
            scroll:d.querySelector('.note-dialog-body').scrollHeight>d.querySelector('.note-dialog-body').clientHeight,
            font:getComputedStyle(d).fontFamily,
            close:[...d.querySelectorAll('.note-dialog-footer button')].every(b=>b.getBoundingClientRect().bottom<=innerHeight),
            actions:['aboutCheckUpdates','aboutUpdateStatus','aboutDownloadUpdate'].every(id=>{
              const b=document.getElementById(id).getBoundingClientRect();
              const body=d.querySelector('.note-dialog-body').getBoundingClientRect();
              return b.top>=body.top&&b.bottom<=body.bottom+1;
            })};
        })()`);
        check(`About ${theme} fits narrow high zoom with reachable actions`,
          layout.inside && layout.close && layout.actions && layout.font.includes("Fira"), layout);
        fs.writeFileSync(path.join(batch, `about-${theme}-narrow-150.png`), (await win.webContents.capturePage()).toPNG());
        win.webContents.setZoomFactor(1);
        win.setSize(1100, 780);
      }
      await exec("document.getElementById('aboutCheckUpdates').focus();true");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await pageWait("Escape closes About", "!document.getElementById('aboutDialog').open");
      check("About keyboard dismissal restores a visible toolbar control",
        await exec("document.activeElement.id==='menuBtn'"), await exec("document.activeElement.id"));
      await openAbout();
      if (process.platform === "darwin") {
        await click("aboutDownloadUpdate");
        await wait("fixed manual release fallback", () => counts.external.length === 1);
        check("macOS opens only the official release page without downloading or installing",
          counts.external[0] === "https://github.com/lostinsea/markaloo/releases/latest" &&
          counts.downloads === 0 && installAttempts() === 0 &&
          !(await snapshot()).canInstall &&
          await exec("document.getElementById('aboutInstallUpdate').hidden"));
      } else {
        let releaseDownload;
        downloadGate = new Promise(resolve => { releaseDownload = resolve; });
        await click("aboutDownloadUpdate");
        await wait("download entered", () => counts.downloads === 1);
        await exec("window.folia.downloadUpdate();true");
        await pageWait("progress shared", "document.getElementById('aboutUpdateStatus').textContent.includes('42%')&&document.getElementById('updateMessage').textContent.includes('42%')");
        check("download progress is shared and duplicate downloads coalesce",
          counts.downloads === 1 && !(await snapshot()).canInstall);
        releaseDownload();
        await pageWait("finalizing", "document.getElementById('aboutUpdateStatus').textContent.includes('Verifying')");
        check("downloaded event does not grant early install authority", !(await snapshot()).canInstall);
        await pageWait("real artifact ready", "!document.getElementById('aboutInstallUpdate').hidden");
        check("only completed provider download grants ready status", (await snapshot()).readyVersion === "0.10.0");
        await closeAbout();
        await click("openFile");
        await pageWait("protected fixture painted", "viewer.querySelector('h1')?.textContent==='Protected update fixture'");
        await click("toggleEdit");
        const edited = "# Protected update fixture\n\nUnsaved changes must survive Cancel.\n";
        await exec(`markdownEditor.value=${JSON.stringify(edited)};markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true`);
        await pageWait("genuine unsaved changes", "hasUnsavedChanges===true");
        check("install fixture has genuine dirty document content",
          await exec(`hasUnsavedChanges&&currentReloadSnapshot()===${JSON.stringify(edited)}`));
        await openAbout();
        await click("aboutInstallUpdate");
        const firstQuestion = await question();
        await exec("window.folia.installUpdate();window.folia.installUpdate();true");
        check("duplicate Install keeps one Main question and no launch",
          BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes("owned-dialog.html")).length === 1 &&
          installAttempts() === 0);
        await choose(firstQuestion, "1");
        await pageWait("install cancellation releases UI", "window.folia.getUpdateState().then(s=>s.canInstall)");
        check("canceling install preserves dirty content disk and shutdown protection",
          installAttempts() === 0 && await exec(`hasUnsavedChanges&&currentReloadSnapshot()===${JSON.stringify(edited)}`) &&
          fs.readFileSync(fixture, "utf8") === originalBody && !main.__shutdown.state().authorized);
        await openAbout();
        await click("aboutInstallUpdate");
        const secondQuestion = await question();
        const choices = await secondQuestion.webContents.executeJavaScript(
          "[...document.querySelectorAll('[data-dialog-choice]')].map(b=>({id:b.dataset.dialogChoice,label:b.textContent}))");
        const discard = choices.find(item => /discard/i.test(item.label));
        if (!discard) throw new Error("No genuine discard action: " + JSON.stringify(choices));
        await choose(secondQuestion, discard.id);
        await wait("controlled launch refusal", () => installAttempts() === 1);
        await pageWait("failed installer retry honest", "window.folia.getUpdateState().then(s=>s.status==='error'&&s.canInstall)");
        check("discard delegates only to Main launcher and failed launch restores protection",
          installAttempts() === 1 && !main.__shutdown.state().authorized &&
          fs.readFileSync(fixture, "utf8") === originalBody);
        await exec("saveMarkdownFile();true");
        await pageWait("genuine save completed", "!hasUnsavedChanges");
        check("saving after canceled or failed installation still uses genuine document authority",
          fs.readFileSync(fixture, "utf8") === edited && installAttempts() === 1);
        check("no real browser or external application was opened", counts.external.length === 0);
      }
      const observation = await sentinel.stop();
      check("About interaction produces no unexpected renderer errors",
        observation.hits.length === 0 && observation.stalls.length === 0, observation);
    } else if (phase === "offline") {
      check("full restart restores availability and startup notice before any check",
        (await snapshot()).availableVersion === "0.10.0" && counts.checks === 0 &&
        await exec("document.getElementById('appUpdateToast').classList.contains('show')"));
      check("restart cache is never trusted as a downloaded installer",
        !(await snapshot()).canInstall && (await snapshot()).readyVersion === null && counts.downloads === 0);
      await closeAbout();
      win.webContents.reload();
      await pageWait("new renderer bridge", "!!window.MarkalooUpdates");
      await openAbout();
      check("new reader renderer restores shared Main state without checking",
        counts.checks === 0 && await exec("document.getElementById('aboutUpdateStatus').textContent.includes('0.10.0')"));
      await closeAbout();
      const closedHandlers = app.listeners("window-all-closed");
      closedHandlers.forEach(listener => app.off("window-all-closed", listener));
      win.destroy();
      app.emit("activate");
      closedHandlers.forEach(listener => app.on("window-all-closed", listener));
      await wait("recreated reader window", () => {
        win = BrowserWindow.getAllWindows().find(candidate =>
          candidate.webContents.getURL().endsWith("index.html"));
        return !!win;
      });
      await pageWait("recreated reader updater", "!!window.MarkalooUpdates");
      await openAbout();
      check("new reader window receives the same Main availability without checking",
        counts.checks === 0 && (await snapshot()).availableVersion === "0.10.0");
      await click("aboutCheckUpdates");
      await pageWait("offline failure after restart", "document.getElementById('aboutUpdateStatus').textContent.includes('Fixture is offline')");
      check("offline check cannot hide restored availability", (await snapshot()).availableVersion === "0.10.0");
      await click("aboutDownloadUpdate");
      await wait("cached Download rechecks metadata", () => counts.checks === 2);
      check("offline cached Download cannot use old installer bytes", counts.downloads === 0 && !(await snapshot()).canInstall);
    } else {
      if (phase === "current") {
        checkMode = "current";
        await click("aboutCheckUpdates");
        await pageWait("up to date", "document.getElementById('aboutUpdateStatus').textContent.includes('up to date')");
        check("current version check reports success below the button", (await snapshot()).status === "up-to-date");
      }
      check(`${phase} profile cannot restore obsolete or malformed availability`,
        !(await snapshot()).availableVersion && !(await snapshot()).canInstall);
      check(`${phase} profile hides the startup availability notice`,
        await exec("!document.getElementById('appUpdateToast').classList.contains('show')"));
    }
    await finish();
  }).catch(finish);
}
