"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID, createHash } = require("crypto");
const root = path.resolve(__dirname, "..");
const batch = path.resolve(process.env.FOLIA_ZOOM_BATCH ||
  path.join(root, "tmp", "reading-zoom", randomUUID()));
if (!batch.startsWith(path.join(root, "tmp", "reading-zoom") + path.sep)) {
  throw new Error("A disposable project-local zoom batch is required");
}
const originalTmpdir = os.tmpdir;
os.tmpdir = () => path.join(batch, "isolation", process.argv[2] || "controller");
require("./test-userdata-isolation");
os.tmpdir = originalTmpdir;
const electron = require("electron");
const budgets = {
  handlerP50: { relative: 0.20, absoluteMs: 2 },
  handlerP95: { relative: 0.25, absoluteMs: 5 },
  startupP50: { relative: 0.20, absoluteMs: 50 },
  startupP95: { relative: 0.25, absoluteMs: 100 },
};
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
if (typeof electron === "string") {
  const { spawnSync } = require("child_process");
  const perf = process.argv.includes("--perf");
  const routes = {
    restore: ["controls", "restart"],
    persist: ["controls"],
    validate: ["defaults"],
    startup: ["startup"],
    sync: ["sync"],
  };
  const phases = perf ? Array.from({ length: 5 }, (_, i) => "perf-" + i) :
    routes[process.env.FOLIA_ZOOM_PROOF] ||
      ["controls", "restart", "reset-restart", "defaults", "startup", "invalid-startup", "sync"];
  fs.mkdirSync(batch, { recursive: true });
  const sources = Object.fromEntries(["renderer.js", "main.js", "custom-tabs.js", "main-preload.js"]
    .map(name => [name, hash(path.join(root, "src", name))]));
  const evidence = {
    budgets, perf, runtime: { node: process.version, electron: require("electron/package.json").version,
      platform: process.platform, arch: process.arch, cpus: os.cpus()[0]?.model },
    sources, suiteSha256: hash(__filename), phases: [],
  };
  console.log("Zoom evidence: " + batch);
  if (perf) console.log("ZOOM_FIXED_BUDGET " + JSON.stringify(budgets));
  let passed = 0, total = 0;
  for (const phase of phases) {
    const started = performance.now();
    const result = spawnSync(electron, [__filename, phase], {
      cwd: root, encoding: "utf8", timeout: 120000,
      env: { ...process.env, FOLIA_ZOOM_BATCH: batch, FOLIA_ZOOM_LAUNCH_AT: String(Date.now()) },
    });
    const elapsedMs = performance.now() - started;
    fs.writeFileSync(path.join(batch, phase + ".stdout.log"), result.stdout || "");
    fs.writeFileSync(path.join(batch, phase + ".stderr.log"), result.stderr || "");
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    const footer = result.stdout?.match(/=== zoom ([\w-]+): (\d+)\/(\d+) passed ===/);
    const count = Number(footer?.[3]), good = Number(footer?.[2]);
    const healthy = !result.error && footer?.[1] === phase && count >= 3 && good <= count &&
      result.status === (good === count ? 0 : 1);
    evidence.phases.push({ phase, elapsedMs, healthy, passed: good, total: count, exit: result.status,
      failures: (result.stdout || "").split(/\r?\n/).filter(line => line.startsWith("FAIL")),
      measurement: fs.existsSync(path.join(batch, phase + ".json"))
        ? JSON.parse(fs.readFileSync(path.join(batch, phase + ".json"), "utf8")) : null });
    fs.writeFileSync(path.join(batch, "evidence.json"), JSON.stringify(evidence, null, 2));
    if (!healthy) {
      console.error("FAIL zoom child completion  -> " + (result.error || result.status));
      process.exit(2);
    }
    passed += good;
    total += count;
  }
  const unchanged = Object.entries(sources).every(([name, digest]) =>
    hash(path.join(root, "src", name)) === digest);
  evidence.productUnchangedDuringRun = unchanged;
  if (perf) {
    const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    const startup = evidence.phases.map(row => row.measurement.startupMs);
    evidence.summary = { startup: { samples: startup, p50: quantile(startup, .5), p95: quantile(startup, .95) },
      handlers: {} };
    for (const corpus of ["plain", "tables"]) for (const split of [false, true]) {
      const rows = evidence.phases.flatMap(row => row.measurement.handlers)
        .filter(row => row.corpus === corpus && row.split === split);
      const handler = rows.flatMap(row => row.handlerMs);
      const frame = rows.flatMap(row => row.frameMs);
      evidence.summary.handlers[corpus + (split ? "-split" : "-normal")] = {
        samples: handler.length, handlerP50: quantile(handler, .5), handlerP95: quantile(handler, .95),
        frameP50: quantile(frame, .5), frameP95: quantile(frame, .95),
      };
    }
    console.log("ZOOM_PERF_SUMMARY " + JSON.stringify(evidence.summary));
  }
  fs.writeFileSync(path.join(batch, "evidence.json"), JSON.stringify(evidence, null, 2));
  if (!unchanged) {
    console.error("FAIL zoom source stayed frozen  -> comparison invalidated by concurrent product edits");
    process.exit(2);
  }
  console.log(`=== ${passed}/${total} passed ===`);
  process.exit(passed === total ? 0 : 1);
} else {
  const { app, BrowserWindow, dialog, session, net, shell } = electron;
  const { pathToFileURL } = require("url");
  const phase = process.argv[2];
  const perf = phase.startsWith("perf-");
  const started = performance.now();
  const profile = path.join(batch, perf ? "perf-profile" :
    ["controls", "restart", "reset-restart"].includes(phase) ? "persistent-profile" : phase + "-profile");
  if (perf) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  const first = path.join(batch, "zoom-first.md");
  const second = path.join(batch, "zoom-second.md");
  const fixture = "# Reading zoom fixture\n\n" +
    "A paragraph for measuring the real rendered reading scale.\n\n".repeat(35) +
    "| Left | Right |\n| --- | --- |\n| Reader | Geometry |\n\n" +
    "```mermaid\nflowchart LR\n A[Reading] --> B[Zoom]\n```\n";
  if (!fs.existsSync(first)) fs.writeFileSync(first, fixture);
  if (!fs.existsSync(second)) fs.writeFileSync(second, "# Other zoom document\n\nDifferent document.\n");
  let chosen = first, win, seed = null, sentinel = null, storageContextOnly = false;
  const results = [];
  const measurement = { startupMs: null, handlers: [] };
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  shell.openExternal = async () => { throw new Error("Zoom test must not open an external application"); };
  shell.openPath = async () => { throw new Error("Zoom test must not open an external application"); };
  const { startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const exec = (code, target = win) => target.webContents.executeJavaScript(code, true);
  const check = (name, ok, detail) => {
    results.push(!!ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
  };
  async function wait(label, expression, target = win) {
    for (let i = 0; i < 300; i++) {
      if (await exec(expression, target)) return;
      await sleep(30);
    }
    throw new Error("Timed out: " + label);
  }
  const settle = async () => {
    await sleep(200);
    await exec("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
  };
  const state = `({
    label:zoomResetBtn.textContent,level:zoomLevel,scale:Number(getComputedStyle(viewer).zoom),
    saved:localStorage.getItem('readingZoom'),writes:window.__zoomProbe.writes.slice(),
    split:isEditMode,font:(()=>{const p=viewer.querySelector('p');if(!p?.firstChild)return null;
      const r=document.createRange();r.setStart(p.firstChild,0);r.setEnd(p.firstChild,1);return r.getBoundingClientRect().height})(),
    webZoom:window.devicePixelRatio
  })`;
  async function click(id) { await exec(`document.getElementById(${JSON.stringify(id)}).click();true`); }
  async function open(file, heading) {
    chosen = file;
    await click("openFile");
    await wait("painted " + heading, `viewer.querySelector('h1')?.textContent===${JSON.stringify(heading)}&&!loadingScreen.classList.contains('active')`);
    await exec("(async()=>{await whenMermaidSettled();return true})()");
    await settle();
  }
  async function setZoom(value) {
    await click("zoomReset");
    const button = value > 100 ? "zoomIn" : "zoomOut";
    for (let n = 0; n < Math.abs(value - 100) / 10; n++) await click(button);
    await settle();
  }
  async function mode(split) {
    await exec(`if(isEditMode!==${split})document.getElementById(isEditMode ? 'exitEditBtn' : 'toggleEdit').click();true`);
    await wait("mode", `isEditMode===${split}&&!loadingScreen.classList.contains('active')`);
    await settle();
  }
  async function key(keyCode) {
    win.focus();
    await exec("document.activeElement?.blur();true");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: ["control"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers: ["control"] });
    await sleep(100);
  }
  async function wheel(deltaY) {
    win.focus();
    const point = await exec("(()=>{const r=viewer.getBoundingClientRect();return {x:Math.round(Math.min(innerWidth-40,Math.max(40,r.left+100))),y:Math.round(Math.min(innerHeight-40,Math.max(150,r.top+100)))}})()");
    win.webContents.sendInputEvent({ type: "mouseWheel", ...point, deltaX: 0, deltaY,
      modifiers: ["control"] });
    await sleep(150);
  }
  async function capture(name) {
    await settle();
    fs.writeFileSync(path.join(batch, name + ".png"), (await win.webContents.capturePage()).toPNG());
  }
  async function controls() {
    check("zoom missing preference starts at normal 100 percent", (await exec(state)).level === 100);
    await open(first, "Reading zoom fixture");
    const plain = await exec(state);
    check("zoom fixture has real prose table diagram and vertical overflow",
      await exec("!!viewer.querySelector('p')&&!!viewer.querySelector('table')&&!!viewer.querySelector('.mermaid svg')&&getViewerScroller().scrollHeight>getViewerScroller().clientHeight+100"));
    await exec("window.__zoomOriginalSvg=viewer.querySelector('.mermaid svg').outerHTML;true");
    const persisted = [];
    await click("zoomIn"); persisted.push((await exec(state)).saved === "110");
    await key("=");
    const keyboardUp = await exec(state); persisted.push(keyboardUp.saved === "120");
    await key("-");
    const keyboardDown = await exec(state); persisted.push(keyboardDown.saved === "110");
    await key("0");
    const keyboardReset = await exec(state); persisted.push(keyboardReset.saved === "100");
    check("zoom native keyboard increments decrements and resets the reading percentage",
      keyboardUp.level === 120 && keyboardDown.level === 110 && keyboardReset.level === 100,
      { keyboardUp, keyboardDown, keyboardReset });
    await wheel(120);
    const wheelUp = await exec(state); persisted.push(wheelUp.saved === "110");
    await wheel(-120);
    const wheelDown = await exec(state); persisted.push(wheelDown.saved === "100");
    check("zoom native control wheel changes only reading zoom", wheelUp.level === 110 && wheelDown.level === 100 &&
      win.webContents.getZoomFactor() === 1, { wheelUp, wheelDown, browserZoom: win.webContents.getZoomFactor() });
    await setZoom(160);
    const normal = await exec(state);
    const normalGeometry = normal.font / plain.font;
    check("zoom normal 160 percent changes actual prose geometry and the displayed percentage",
      normal.level === 160 && normal.label === "160%" && normal.scale === 1.6 &&
      Math.abs(normalGeometry - 1.6) < .1, { plain, normal, normalGeometry });
    await capture("zoom-normal-160");
    await mode(true);
    const split = await exec(state);
    check("zoom split mode keeps 160 percent and the actual reading scale",
      split.level === 160 && split.label === "160%" && split.scale === 1.6 &&
      await exec("getViewerScroller()===viewer&&getViewerScroller().scrollHeight>getViewerScroller().clientHeight"),
      split);
    await key("=");
    const splitKey = await exec(state); persisted.push(splitKey.saved === "170");
    await wheel(-120);
    const splitWheel = await exec(state); persisted.push(splitWheel.saved === "160");
    check("zoom split native keyboard and wheel use the same reading controls",
      splitKey.level === 170 && splitWheel.level === 160 && splitWheel.scale === 1.6,
      { splitKey, splitWheel });
    await capture("zoom-split-160");
    await mode(false);
    check("zoom reading steps do not rewrite diagram SVG or diagram transforms",
      await exec("viewer.querySelector('.mermaid svg').outerHTML===window.__zoomOriginalSvg"));
    const readingBeforePopup = await exec(state);
    await exec("viewer.querySelector('.mermaid-maximize-btn').click();true");
    let popup;
    for (let i = 0; i < 200; i++) {
      popup = BrowserWindow.getAllWindows().find(candidate => candidate !== win && !candidate.isDestroyed());
      if (popup && await exec("!!document.querySelector('#viewport svg')", popup).catch(() => false)) break;
      await sleep(30);
    }
    if (!popup) throw new Error("The actual diagram popup did not open");
    try {
      await wait("diagram popup controls ready", "typeof window.resetView==='function'", popup);
      const before = await exec("state.scale", popup);
      await exec("document.getElementById('svg-container-wrapper').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-100}));true", popup);
      const changed = await exec("state.scale", popup);
      await exec("document.getElementById('resetBtn').click();true", popup);
      const after = await exec("state.scale", popup);
      const readingAfterPopup = await exec(state);
      check("zoom diagram popup retains independent wheel scaling and reset without writing reading zoom",
        before > 0 && before <= 1 && Math.abs(changed / before - 1.1) < .001 && after === 1 &&
        readingBeforePopup.level === readingAfterPopup.level &&
        readingBeforePopup.saved === readingAfterPopup.saved &&
        readingBeforePopup.writes.length === readingAfterPopup.writes.length,
        { before, changed, after, readingBeforePopup, readingAfterPopup });
    } finally {
      popup.destroy();
    }
    const beforePrint = await exec(state);
    const pdf = await win.webContents.printToPDF({ printBackground: true });
    fs.writeFileSync(path.join(batch, "zoom-reading-160.pdf"), pdf);
    const afterPrint = await exec(state);
    check("zoom PDF output contains bytes and leaves the screen percentage and preference unchanged",
      pdf.subarray(0, 5).toString() === "%PDF-" && pdf.length > 1000 &&
      beforePrint.level === afterPrint.level && beforePrint.saved === afterPrint.saved &&
      beforePrint.writes.length === afterPrint.writes.length, { bytes: pdf.length, beforePrint, afterPrint });
    await open(second, "Other zoom document");
    const opened = await exec(state);
    await exec("window.CustomTabs.switchToTab(window.CustomTabs.getTabs().find(t=>t.filePath===" + JSON.stringify(first) + ").id)");
    await wait("returned first document", "viewer.querySelector('h1')?.textContent==='Reading zoom fixture'");
    const switched = await exec(state);
    await exec("(async()=>{for(const t of [...window.CustomTabs.getTabs()])await window.CustomTabs.closeTab(t.id);return true})()");
    const closed = await exec(state);
    await open(second, "Other zoom document");
    check("zoom survives another document tab switch final-tab close and subsequent open",
      [opened, switched, closed, await exec(state)].every(row => row.level === 160 && row.scale === 1.6),
      { opened, switched, closed });
    await setZoom(50);
    await click("zoomOut");
    await key("-");
    await wheel(-120);
    const minimum = await exec(state); persisted.push(minimum.saved === "50");
    await setZoom(400);
    await click("zoomIn");
    await key("=");
    await wheel(120);
    const maximum = await exec(state); persisted.push(maximum.saved === "400");
    await click("zoomReset");
    const reset = await exec(state); persisted.push(reset.saved === "100");
    check("zoom buttons preserve the 50 through 400 bounds ten-point steps and reset 100",
      minimum.level === 50 && minimum.label === "50%" && maximum.level === 400 && maximum.label === "400%" &&
      reset.level === 100 && reset.label === "100%", { minimum, maximum, reset });
    check("zoom every user input persists a canonical percentage synchronously", persisted.every(Boolean), persisted);
    const refused = await exec(`(()=>{
      const original=Storage.prototype.setItem,warn=console.warn;let attempts=0,warnings=0;
      Storage.prototype.setItem=function(k,v){if(k==='readingZoom'){attempts++;throw new Error('deliberate zoom storage refusal')}return original.call(this,k,v)};
      console.warn=(...args)=>{warnings++;warn(...args)};
      try{zoomInBtn.click();return {attempts,warnings,level:zoomLevel,label:zoomResetBtn.textContent,scale:Number(viewer.style.zoom)}}
      finally{Storage.prototype.setItem=original;console.warn=warn}
    })()`);
    check("zoom storage write refusal warns and keeps the changed UI usable",
      refused.attempts === 1 && refused.warnings >= 1 && refused.level === 110 &&
      refused.label === "110%" && refused.scale === 1.1, refused);
    await setZoom(160);
    await open(first, "Reading zoom fixture");
    await mode(false);
  }
  async function restart() {
    await wait("restored admitted document", "viewer.querySelector('h1')?.textContent==='Reading zoom fixture'&&!loadingScreen.classList.contains('active')");
    const current = await exec(state);
    const early = await exec("window.__zoomProbe.firstDocument");
    check("zoom full quit relaunch restores 160 before the first document is painted",
      current.level === 160 && current.label === "160%" && current.scale === 1.6 &&
      early?.label === "160%" && early?.scale === 1.6, { current, early });
    check("zoom relaunch really restored its previously admitted document",
      await exec("window.CustomTabs.getActiveTab()?.filePath===" + JSON.stringify(first)));
    check("zoom relaunch retains normal reading mode", !current.split);
    await click("zoomReset");
    const reset = await exec(state);
    check("zoom reset after relaunch saves 100 synchronously",
      reset.level === 100 && reset.scale === 1 && reset.saved === "100", reset);
  }
  async function resetRestart() {
    await wait("restored reset document", "viewer.querySelector('h1')?.textContent==='Reading zoom fixture'&&!loadingScreen.classList.contains('active')");
    const current = await exec(state);
    const early = await exec("window.__zoomProbe.firstDocument");
    check("zoom reset survives full quit relaunch without rewriting the preference",
      current.level === 100 && current.label === "100%" && current.scale === 1 &&
      current.saved === "100" && current.writes.length === 0 &&
      early?.label === "100%" && early?.scale === 1, { current, early });
  }
  async function defaults() {
    check("zoom default startup is genuinely missing and is not written back",
      await exec("window.__zoomProbe.initial===null&&localStorage.getItem('readingZoom')===null&&window.__zoomProbe.writes.length===0"));
    const rows = await exec(`(()=>{
      const invalid=['','160.0','0160',' 160','160 ','1.6e2','160px','NaN','Infinity','null','undefined','{}','49','401','155','-100','0','500'];
      const read=()=>typeof readReadingZoom==='function'?readReadingZoom():100;
      const original=Storage.prototype.setItem;
      const rows=invalid.map(raw=>{original.call(localStorage,'readingZoom',raw);return {raw,value:read()}});
      const canonical=['50','100','160','400'].map(raw=>{original.call(localStorage,'readingZoom',raw);return {raw,value:read()}});
      localStorage.removeItem('readingZoom');
      return {rows,canonical,missing:read()};
    })()`);
    check("zoom malformed noncanonical off-grid and out-of-range preferences default to 100",
      rows.rows.length === 18 && rows.rows.every(row => row.value === 100) && rows.missing === 100, rows.rows);
    check("zoom canonical range endpoints and interior preferences are accepted",
      rows.canonical.every(row => row.value === Number(row.raw)), rows.canonical);
    const failure = await exec(`(()=>{
      const original=Storage.prototype.getItem,warn=console.warn;let attempts=0,warnings=0;
      Storage.prototype.getItem=function(k){if(k==='readingZoom'){attempts++;throw new Error('deliberate zoom read refusal')}return original.call(this,k)};
      console.warn=(...args)=>{warnings++;warn(...args)};
      try{return {value:typeof readReadingZoom==='function'?readReadingZoom():100,get attempts(){return attempts},get warnings(){return warnings}}}
      finally{Storage.prototype.getItem=original;console.warn=warn}
    })()`);
    check("zoom storage read refusal reaches the fallback and warns without throwing",
      failure.attempts === 1 && failure.warnings >= 1 && failure.value === 100, failure);
  }
  async function startup() {
    const value = await exec(state);
    if (phase === "invalid-startup") {
      check("zoom invalid stored startup uses 100 consistently without rewriting the value",
        value.level === 100 && value.label === "100%" && value.scale === 1 &&
        value.saved === "155" && value.writes.length === 0, value);
    } else {
      check("zoom startup applies the canonical saved reading percentage", value.level === 160 && value.scale === 1.6, value);
      check("zoom startup restore never writes the preference", value.saved === "160" && value.writes.length === 0, value);
    }
    check("zoom startup keeps browser page zoom at 100 percent", win.webContents.getZoomFactor() === 1);
  }
  async function sync() {
    const old = win;
    const alive = await proveSentinelAlive(win, sentinel);
    const errors = await sentinel.stop();
    sentinel = null;
    check("zoom first reader sentinel is alive and clean before replacement",
      alive.console && alive.dom && errors.hits.length === 0, { alive, hits: errors.hits });
    // Exercise the production activate/createWindow path rather than inventing
    // a BrowserWindow with an unregistered main-preload sender.
    const allClosed = app.listeners("window-all-closed");
    for (const listener of allClosed) app.removeListener("window-all-closed", listener);
    try {
      old.destroy();
      app.emit("activate");
      for (let i = 0; i < 300; i++) {
        win = BrowserWindow.getAllWindows().find(candidate => candidate !== old && !candidate.isDestroyed());
        if (win && !win.webContents.isLoading()) break;
        await sleep(25);
      }
      await wait("new actual production main reader", "typeof updateZoom==='function'&&typeof window.CustomTabs?.getTabs==='function'&&!loadingScreen.classList.contains('active')");
    } finally {
      for (const listener of allClosed) app.on("window-all-closed", listener);
    }
    sentinel = startErrorSentinel(win, { label: "zoom replacement" });
    const initial = await exec(state);
    check("zoom new same-profile reader starts at the existing application percentage",
      win !== old && initial.level === 160 && initial.scale === 1.6 && initial.label === "160%", initial);
    storageContextOnly = true;
    const peer = new BrowserWindow({
      show: false, width: 1100, height: 760,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    try {
      await peer.loadFile(path.join(root, "src", "index.html"));
      storageContextOnly = false;
      await exec("window.__zoomEvents=[];addEventListener('storage',e=>window.__zoomEvents.push({key:e.key,value:e.newValue}));true");
      const rows = [];
      for (const [operation, expected] of [
        ["localStorage.setItem('readingZoom','230')", 230],
        ["localStorage.removeItem('readingZoom')", 100],
        ["localStorage.setItem('readingZoom','155')", 100],
        ["localStorage.setItem('readingZoom','180')", 180],
        ["localStorage.clear()", 100],
      ]) {
        await exec(operation + ";true", peer);
        await sleep(140);
        const current = await exec(state);
        rows.push({ operation, expected, actual: current.level, label: current.label, scale: current.scale });
      }
      const events = await exec("window.__zoomEvents");
      const receivedWrites = await exec("window.__zoomProbe.writes");
      check("zoom real same-profile storage changes removals invalid values and clear update the reader",
        rows.every(row => row.actual === row.expected && row.label === row.expected + "%" &&
          row.scale === row.expected / 100) && events.some(e => e.value === "230") &&
        events.some(e => e.key === null) && receivedWrites.length === 0, { rows, events, receivedWrites });
      // Establish this leg's own starting state even if the preceding listener leg failed.
      await exec("localStorage.setItem('readingZoom','160');zoomLevel=160;updateZoom({persist:false});window.__zoomProbe.writes.length=0;true");
      const filtered = await exec(`(()=>{
        const originalUpdate=updateZoom;let calls=0;
        updateZoom=function(...args){calls++;return originalUpdate(...args)};
        const emit=(key,newValue,storageArea)=>dispatchEvent(new StorageEvent('storage',{key,newValue,storageArea}));
        const rows=[];
        try{
          for(const [key,value,area] of [['otherSetting','350',localStorage],['readingZoom','350',sessionStorage],['readingZoom','350',null],['readingZoom','250',localStorage],[null,null,localStorage]]){
            emit(key,value,area);rows.push(zoomLevel);
          }
          return {rows,calls,saved:localStorage.getItem('readingZoom'),writes:window.__zoomProbe.writes.slice()};
        }finally{updateZoom=originalUpdate}
      })()`);
      check("zoom storage notifications filter other areas and keys reread current state and never echo writes",
        filtered.rows.every(value => value === 160) && filtered.calls === 0 &&
        filtered.saved === "160" && filtered.writes.length === 0,
        filtered);
      check("zoom storage probes observe real cross-context delivery", events.length >= 5, events);
    } finally {
      storageContextOnly = false;
      peer.destroy();
    }
  }
  async function performanceRun() {
    const { generate } = require("../bench/corpus");
    await open(first, "Reading zoom fixture");
    for (const corpus of ["plain", "tables"]) {
      const markdown = generate(corpus === "plain" ? "prose" : corpus, 50 * 1024);
      const file = path.join(batch, "perf-" + corpus + ".md");
      fs.writeFileSync(file, markdown);
      chosen = file;
      await click("openFile");
      const painted = corpus === "plain"
        ? `viewer.querySelector('p')?.textContent.startsWith(${JSON.stringify(markdown.slice(0, 80))})&&viewer.querySelectorAll('table').length===0`
        : "viewer.querySelector('th')?.textContent==='Flag'";
      await wait("corpus rendered", `window.CustomTabs.getActiveTab()?.filePath===${JSON.stringify(file)}&&(${painted})&&!loadingScreen.classList.contains('active')`);
      await settle();
      const shape = await exec("({paragraphs:viewer.querySelectorAll('p').length,tables:viewer.querySelectorAll('table').length,overflow:getViewerScroller().scrollHeight>getViewerScroller().clientHeight})");
      check("zoom perf " + corpus + " renders the real fixed 50 KiB corpus",
        Buffer.byteLength(markdown) >= 49 * 1024 && shape.overflow &&
        (corpus === "tables" ? shape.tables > 0 : shape.paragraphs > 0 && shape.tables === 0), shape);
      for (const split of [false, true]) {
        await mode(split);
        const values = await exec(`(async()=>{
          const handlerMs=[],frameMs=[];
          for(let i=0;i<12;i++){
            await new Promise(r=>setTimeout(r,140));
            const before=performance.now();
            (i%2===0?zoomInBtn:zoomOutBtn).click();
            const after=performance.now();
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            if(i>=2){handlerMs.push(after-before);frameMs.push(performance.now()-before)}
          }
          return {handlerMs,frameMs};
        })()`);
        measurement.handlers.push({ corpus, split, bytes: Buffer.byteLength(markdown),
          sha256: createHash("sha256").update(markdown).digest("hex"), ...values });
      }
    }
    check("zoom perf bounded repeated handler and layout-frame samples are complete",
      measurement.handlers.length === 4 && measurement.handlers.every(row =>
        row.handlerMs.length === 10 && row.frameMs.every(Number.isFinite)));
  }
  const watchdog = setTimeout(() => {
    console.error("FAIL zoom bounded child watchdog expired");
    app.exit(2);
  }, 110000);
  process.on("uncaughtException", error => { console.error(error.stack); app.exit(2); });
  process.on("unhandledRejection", error => { console.error(error?.stack || error); app.exit(2); });
  app.whenReady().then(async () => {
    try {
      const indexPath = path.join(root, "src", "index.html");
      const indexUrl = pathToFileURL(indexPath).href;
      const seeded = ["startup", "sync"].includes(phase) ? "160" :
        phase === "invalid-startup" ? "155" : perf ? "100" : null;
      if (!["restart", "reset-restart"].includes(phase)) {
        await session.defaultSession.protocol.handle("file", request => request.url === indexUrl
          ? new Response(`<html><body>Disposable zoom seed<script>localStorage.clear();${
            seeded === null ? "" : "localStorage.setItem('readingZoom'," + JSON.stringify(seeded) + ");"
          }</script></body></html>`, { headers: { "content-type": "text/html" } })
          : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
        seed = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
        await seed.loadFile(indexPath);
        await session.defaultSession.protocol.unhandle("file");
      }
      // The document's real file origin and product sources are unchanged. This
      // pre-script observer proves the first real restored DOM, not a later poll.
      const probe = `<script>
        window.__zoomProbe={initial:localStorage.getItem('readingZoom'),writes:[],firstDocument:null};
        const zoomOriginalSet=Storage.prototype.setItem;
        Storage.prototype.setItem=function(k,v){if(this===localStorage&&k==='readingZoom')window.__zoomProbe.writes.push(String(v));return zoomOriginalSet.call(this,k,v)};
        new MutationObserver(()=>{
          const v=document.getElementById('viewer'),h=v?.querySelector('h1');
          if(h?.textContent==='Reading zoom fixture'&&!window.__zoomProbe.firstDocument)window.__zoomProbe.firstDocument={
            heading:h.textContent,scale:Number(getComputedStyle(v).zoom),
            label:document.getElementById('zoomReset')?.textContent
          };
        }).observe(document,{childList:true,subtree:true});
      </script>`;
      await session.defaultSession.protocol.handle("file", request => request.url === indexUrl
        ? new Response(storageContextOnly ? "<html><body>Same-origin zoom storage writer</body></html>" :
          fs.readFileSync(indexPath, "utf8").replace("</head>", probe + "</head>"),
          { headers: { "content-type": "text/html" } })
        : net.fetch(request.url, { bypassCustomProtocolHandlers: true }));
      require("../src/main.js");
      for (let i = 0; i < 300; i++) {
        win = BrowserWindow.getAllWindows().find(candidate => candidate !== seed && !candidate.isDestroyed());
        if (win && !win.webContents.isLoading()) break;
        await sleep(25);
      }
      if (!win) throw new Error("No production main reader");
      await wait("production reader ready", "typeof updateZoom==='function'&&typeof window.CustomTabs?.getTabs==='function'&&!loadingScreen.classList.contains('active')");
      measurement.startupMs = process.env.FOLIA_ZOOM_LAUNCH_AT
        ? Date.now() - Number(process.env.FOLIA_ZOOM_LAUNCH_AT) : performance.now() - started;
      if (seed) { seed.destroy(); seed = null; }
      win.setSize(1280, 850);
      sentinel = startErrorSentinel(win, { label: "zoom" });
      check("zoom uses an isolated production reader and disposable profile",
        app.getPath("userData") === profile && profile.startsWith(batch + path.sep) &&
        await exec("typeof require==='undefined'&&typeof process==='undefined'&&Object.isFrozen(window.folia)"));
      if (perf) await performanceRun();
      else if (phase === "controls") await controls();
      else if (phase === "restart") await restart();
      else if (phase === "reset-restart") await resetRestart();
      else if (phase === "defaults") await defaults();
      else if (phase === "startup" || phase === "invalid-startup") await startup();
      else if (phase === "sync") await sync();
      else throw new Error("Unknown zoom phase " + phase);
      const alive = await proveSentinelAlive(win, sentinel);
      check("zoom " + phase + " sentinel proves console and DOM channels alive", alive.console && alive.dom, alive);
      const errors = await sentinel.stop();
      sentinel = null;
      check("zoom " + phase + " has no unexpected renderer or document errors", errors.hits.length === 0, errors.hits);
    } catch (error) {
      check("zoom " + phase + " harness reaches completion", false, error.stack || String(error));
      if (sentinel) await sentinel.stop();
      if (win && !win.isDestroyed()) await capture("FAILED-" + phase);
    }
    fs.writeFileSync(path.join(batch, phase + ".json"), JSON.stringify(measurement, null, 2));
    session.defaultSession.flushStorageData();
    const summary = `=== zoom ${phase}: ${results.filter(Boolean).length}/${results.length} passed ===`;
    app.once("quit", () => { clearTimeout(watchdog); console.log(summary); });
    app.once("will-quit", () => app.exit(results.every(Boolean) ? 0 : 1));
    app.quit();
  });
}
