"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const fixtureRoot = process.env.MARKALOO_EDITOR_FIXTURE_ROOT;
const directory = path.resolve(fixtureRoot || path.resolve(__dirname, "..", "tmp", "document-editor"));
const evidence = path.resolve(process.env.MARKALOO_EDITOR_EVIDENCE || directory);
// Explicit roots may contain user data. Each run must create its exact root.
if (fixtureRoot) {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  try { fs.mkdirSync(directory); }
  catch (error) {
    throw new Error("MARKALOO_EDITOR_FIXTURE_ROOT must be a new directory for each run: " + directory, { cause: error });
  }
} else fs.mkdirSync(directory, { recursive: true });
const { app, BrowserWindow, dialog, shell } = require("electron");
require("./test-userdata-isolation");
const { startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");
fs.mkdirSync(evidence, { recursive: true });
const files = ["alpha", "beta"].map(name => path.join(directory, name + ".md"));
const productFiles = ["src/main.js", "src/renderer.js", "src/custom-tabs.js",
  "src/editor-scroll.js", "src/index.html", "src/custom-styles.css"];
const hashes = () => Object.fromEntries(productFiles.map(file => [file,
  crypto.createHash("sha256").update(fs.readFileSync(path.resolve(__dirname, "..", file))).digest("hex")]));
const product = hashes();
const bodies = ["Alpha", "Beta"].map(name => "# " + name + "\n\n" +
  Array.from({ length: 60 }, (_, i) => name + " paragraph " + i + ". " + "A separate document owns this editor. ".repeat(6)).join("\n\n"));
files.forEach((file, i) => fs.writeFileSync(file, bodies[i]));
let chosen = files[0], win, sentinel, cancelNextOpen = false, chooserCalls = 0;
const results = [];
const failures = [];
const nativeObservations = [];
const proof = process.env.MARKALOO_EDITOR_PROOF;
const modeGate = proof === "mode-gate";
const nativeScenarios = ["mode:text", "mode:code", "mode:table", "discard:code", "discard:table", "discard:refused"]
  .concat(modeGate ? ["zoom-width:text", "zoom-width:code", "zoom-width:table",
    "fallback:unavailable", "pending:render", "pending:owner"] : [])
  .map(name => ({ name, status: "NOT RUN", reason: "Shared editor setup has not completed" }));
let scenario = "shared editor sequence", finalChecksAttempted = false, nativeUnsafe = false, sentinelReport = null;
if (proof && !["toolbar", "modes", "mode-gate", "sessions", "baseline", "admission", "deferred", "visible-save", "save", "reload", "clean-exit", "reopen-exit", "lastclose", "commands", "noop"].includes(proof)) {
  console.error("Unsupported document-editor proof route: " + proof);
  app.exit(2);
}
dialog.showOpenDialog = async () => {
  chooserCalls++;
  const canceled = cancelNextOpen;
  cancelNextOpen = false;
  return { canceled, filePaths: canceled ? [] : [chosen] };
};
shell.openExternal = async () => { throw new Error("Editor suite must not open external applications"); };
shell.openPath = async () => { throw new Error("Editor suite must not open external applications"); };
require("../src/main.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = code => win.webContents.executeJavaScript(code, true);
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
  if (!ok) failures.push({ scenario, phase: "assertion", occurrence: results.length, name, detail });
}
function recordError(phase, error) {
  const failure = { scenario, phase, afterExecutedOccurrence: results.length, error: String(error?.stack || error) };
  failures.push(failure);
  console.error(JSON.stringify(failure));
}
function positionNativeTableDeparture(target, outer, body, headers) {
  const fail = reason => { throw new Error("Native table departure " + reason); };
  const table = body.block.closest("table"), head = table?.tHead;
  if (!target || !table || !target.contains(table) || body.block.tagName !== "TD" ||
      !body.block.isConnected || headers.length !== 6 || !head ||
      headers.some((header, index) => !header.block.isConnected ||
        header.block.closest("table") !== table || header.block.closest("thead") !== head || header.block.tagName !== "TH" ||
        header.block.textContent !== "Column " + index)) fail("has no exact body/header owners");
  const scale = scrollerScale(target), outerScale = scrollerScale(outer);
  if (![scale, outerScale].every(value => Number.isFinite(value) && value > 0)) fail("has no finite scale");
  const offsets = [target.scrollTop, outer.scrollTop, outer.scrollLeft];
  if (!offsets.every(Number.isFinite)) fail("has no finite scroll position");
  const clip = () => {
    const bounds = [target, outer].map((element, index) => {
      const rect = element.getBoundingClientRect(), zoom = index ? outerScale : scale;
      const left = rect.left + element.clientLeft * zoom, top = rect.top + element.clientTop * zoom;
      return { left, top, right: left + element.clientWidth * zoom, bottom: top + element.clientHeight * zoom };
    });
    const value = { left: Math.max(0, ...bounds.map(rect => rect.left)),
      right: Math.min(innerWidth, ...bounds.map(rect => rect.right)),
      top: Math.max(0, ...bounds.map(rect => rect.top)),
      bottom: Math.min(innerHeight, ...bounds.map(rect => rect.bottom)) };
    if (!Object.values(value).every(Number.isFinite) || value.left >= value.right || value.top >= value.bottom)
      fail("has no finite effective clip");
    return value;
  };
  const rectangle = entry => {
    const rects = [...entry.range.getClientRects()];
    if (rects.length !== 1 || entry.range.toString() !== entry.block.textContent) fail("lost its exact text range");
    const rect = rects[0];
    if (![rect.left, rect.right, rect.top, rect.bottom, rect.width, rect.height].every(Number.isFinite) ||
        rect.width <= 0 || rect.height <= 0 || rect.left >= rect.right || rect.top >= rect.bottom)
      fail("has no finite text rectangle");
    return rect;
  };
  const before = clip(), headerRects = headers.map(rectangle), bodyRect = rectangle(body);
  if (headerRects.some((rect, index) => index && headerRects[index - 1].right >= rect.left) ||
      bodyRect.top >= before.bottom || bodyRect.bottom <= before.top) fail("has no ordered visible body/header gap");
  const lower = headerRects[0].right - before.left, upper = headerRects[1].left - before.right;
  if (!(lower < upper)) fail("header gap cannot contain the viewport");
  const requested = target.scrollLeft + (lower + (upper - lower) / 2) / scale;
  const maximum = target.scrollWidth - target.clientWidth;
  if (!Number.isFinite(requested) || !Number.isFinite(maximum) || maximum < 0 || requested < 0 || requested > maximum)
    fail("header gap is outside the scroll range");
  target.scrollLeft = requested;
  const after = clip(), placed = rectangle(body);
  if (!body.block.isConnected || !target.contains(table) || body.block.closest("table") !== table || table.tHead !== head ||
      headers.some(header => !header.block.isConnected || header.block.closest("table") !== table || header.block.closest("thead") !== head) ||
      headers.map(rectangle).some(rect => rect.left < after.right && rect.right > after.left) ||
      placed.left >= after.right || placed.right <= after.left || placed.top >= after.bottom || placed.bottom <= after.top ||
      offsets.some((value, index) => value !== [target.scrollTop, outer.scrollTop, outer.scrollLeft][index]))
    fail("single placement did not expose the body without header text");
}

function positionNativeCodeFixture(target, outer) {
  const block = target.querySelector("code"), text = block?.textContent;
  if (!text?.startsWith("r0c0_ ")) throw new Error("Native code positioning requires its synthetic fixture");
  const starts = [8, 9].map(row => text.indexOf("\nr" + row + "c0_ ") + 1);
  const ends = starts.map(start => text.indexOf("\n", start));
  if (starts.some((start, index) => start <= 0 ||
      text.lastIndexOf("\nr" + (8 + index) + "c0_ ") !== start - 1) ||
      ends.some(end => end < 0) || ends[0] + 1 !== starts[1]) {
    throw new Error("Native code positioning requires its exact adjacent fixture lines");
  }
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT), nodes = [];
  let node, offset = 0;
  while (node = walker.nextNode()) { nodes.push({ node, start: offset }); offset += node.length; }
  const ranges = starts.map((start, index) => {
    const end = ends[index], first = nodes.find(entry => start >= entry.start && start < entry.start + entry.node.length);
    const last = nodes.find(entry => end > entry.start && end <= entry.start + entry.node.length);
    if (!first?.node.isConnected || !last?.node.isConnected) throw new Error("Native code fixture line is disconnected");
    const range = document.createRange();
    range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
    if (range.toString() !== text.slice(start, end)) throw new Error("Native code fixture line is not exact");
    return range;
  });
  const measure = () => {
    const lines = ranges.map(range => [...range.getClientRects()]);
    const bounds = target.getBoundingClientRect(), outerBounds = outer.getBoundingClientRect();
    const scale = scrollerScale(target), outerScale = scrollerScale(outer), style = getComputedStyle(target);
    const pixels = value => /^\d+(?:\.\d+)?px$/.test(value) ? parseFloat(value) : NaN;
    const radii = [style.borderTopLeftRadius, style.borderTopRightRadius,
      style.borderBottomLeftRadius, style.borderBottomRightRadius].map(pixels);
    const border = pixels(style.borderTopWidth);
    if (lines.some(rects => rects.length !== 1 || ![rects[0].left, rects[0].right, rects[0].top, rects[0].bottom].every(Number.isFinite) ||
        !(rects[0].right > rects[0].left && rects[0].bottom > rects[0].top)) ||
        ![scale, outerScale, bounds.top, bounds.width, bounds.height, outerBounds.top, border, ...radii].every(Number.isFinite) ||
        !(scale > 0 && outerScale > 0) || radii.some(radius => radius !== radii[0])) {
      throw new Error("Native code fixture line or circular corner geometry is unsupported");
    }
    const clipTop = Math.max(0, bounds.top + target.clientTop * scale, outerBounds.top + outer.clientTop * outerScale);
    const clipBottom = Math.min(innerHeight, bounds.top + (target.clientTop + target.clientHeight) * scale,
      outerBounds.top + (outer.clientTop + outer.clientHeight) * outerScale);
    const radius = Math.min(radii[0] * scale, bounds.width / 2, bounds.height / 2);
    const cornerBottom = radius > border * scale ? Math.max(clipTop, bounds.top + radius) : clipTop;
    return { previous: lines[0][0], next: lines[1][0], clipTop, clipBottom, cornerBottom, scale };
  };
  target.scrollLeft = 400;
  const before = measure(), lower = before.previous.bottom - before.clipTop;
  const upper = before.next.top - before.cornerBottom;
  if (!(lower < upper)) throw new Error("Native code fixture has no clear interline placement");
  // Place the clip inside this known line gap, not through the first visible glyph.
  const requestedTop = target.scrollTop + (lower + (upper - lower) / 2) / before.scale;
  if (!Number.isFinite(requestedTop) || requestedTop < 0 || requestedTop > target.scrollHeight - target.clientHeight) {
    throw new Error("Native code fixture interline placement is outside its scroll range");
  }
  target.scrollTop = requestedTop;
  const after = measure();
  if (!(after.previous.bottom < after.clipTop && after.next.top > after.cornerBottom &&
      after.next.bottom < after.clipBottom) || target.scrollLeft !== 400) {
    throw new Error("Native code fixture did not reach its clear interline placement");
  }
}
async function wait(label, expression) {
  for (let i = 0; i < 250; i++) {
    if (await exec(expression)) return;
    await sleep(30);
  }
  throw new Error("Timed out waiting for " + label);
}
async function settle() {
  await sleep(180);
  await exec("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
}
async function open(index) {
  chosen = files[index];
  await exec("document.getElementById('openFile').click();true");
  await wait("document " + index, `currentFilePath===${JSON.stringify(chosen)}&&viewer.querySelector('h1')?.textContent===${JSON.stringify(index ? "Beta" : "Alpha")}&&!loadingScreen.classList.contains('active')`);
  await settle();
  return exec("window.CustomTabs.getActiveTabId()");
}
async function select(id, heading) {
  await exec(`window.CustomTabs.switchToTab(${id})`);
  await wait("selected " + heading, `window.CustomTabs.getActiveTabId()===${id}&&viewer.querySelector('h1')?.textContent===${JSON.stringify(heading)}&&!loadingScreen.classList.contains('active')`);
  await settle();
}
const snapshot = () => exec(`({
  edit:isEditMode,value:markdownEditor.value,start:markdownEditor.selectionStart,
  end:markdownEditor.selectionEnd,direction:markdownEditor.selectionDirection,
  history:JSON.stringify(historySnapshot()),dirty:hasUnsavedChanges
})`);
async function input(text, start, end) {
  await exec(`markdownEditor.value=${JSON.stringify(text)};
    markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));
    markdownEditor.setSelectionRange(${start},${end},'backward');true`);
  await wait("edited preview", `currentReloadSnapshot()===${JSON.stringify(text)}&&viewer.textContent.includes('Unsaved witness')&&!loadingScreen.classList.contains('active')`);
  await sleep(900);
  await settle();
}
async function choice(id) {
  await exec(`document.querySelector('#appMessageDialog [data-dialog-choice="${id}"]').click();true`);
  await settle();
}
async function exitQuestion() {
  await exec("document.getElementById('exitEditBtn').click();true");
  await wait("explicit editor exit question", "document.getElementById('appMessageDialog')?.open&&document.getElementById('appMessageTitle').textContent==='Discard unsaved changes?'");
}
async function capture(name) {
  fs.writeFileSync(path.join(evidence, name + ".png"), (await win.webContents.capturePage()).toPNG());
}
function modeGateStatePreserved(before, after) {
  return ["source", "original", "value", "start", "end", "direction", "dirty", "undoRedo",
    "tab", "path", "generation", "selection", "edit", "cached", "saved"].every(key =>
    Object.hasOwn(before, key) && Object.hasOwn(after, key) && before[key] === after[key]);
}
function holdNativeModeRenderFinalizer() {
  const idle = window.requestIdleCallback;
  if (typeof idle !== "function") throw new Error("Native idle finalization is unavailable");
  const gate = { generation: renderGeneration + 1, held: false, settled: false, callback: null, released: false,
    restore() { window.requestIdleCallback = idle; },
    release() {
      if (this.callback && !this.released) { this.released = true; this.callback(); }
    } };
  window.requestIdleCallback = function (callback, options) {
    if (!gate.callback && renderGeneration === gate.generation && options?.timeout === 1000) {
      gate.callback = callback;
      return idle.call(window, () => { gate.held = true; }, options);
    }
    return idle.call(window, callback, options);
  };
  return gate;
}
async function finish() {
  finalChecksAttempted = true;
  scenario = "final checks";
  try {
    const unchanged = JSON.stringify(hashes()) === JSON.stringify(product);
    check("document editor product source remains unchanged throughout the run", unchanged);
    if (!unchanged) nativeUnsafe = true;
  } catch (error) {
    nativeUnsafe = true;
    recordError("source preservation", error);
  }
  if (sentinel && !nativeUnsafe && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    try {
      const alive = await proveSentinelAlive(win, sentinel);
      check("document editor error sentinel proves both channels are live", alive.console && alive.dom, alive);
    } catch (error) {
      recordError("sentinel liveness", error);
      const mute = sentinel.currentMute();
      if (mute) failures.push({ scenario, phase: "unfinished sentinel mute", detail: mute });
    }
  } else {
    failures.push({ scenario, phase: "BLOCKED", reason: "Sentinel liveness has no safe live renderer" });
  }
  if (sentinel) {
    try {
      sentinelReport = await sentinel.stop();
      check("document editor scenarios introduce no renderer or visible document errors",
        sentinelReport.hits.length === 0, sentinelReport.hits);
      if (sentinelReport.stalls.length) {
        failures.push({ scenario, phase: "sentinel stalls", detail: sentinelReport.stalls });
      }
    } catch (error) { recordError("sentinel shutdown", error); }
  } else {
    failures.push({ scenario, phase: "BLOCKED", reason: "Error sentinel was not started" });
  }
}
async function noDocumentCommands() {
  const states = [], effects = [], panels = [];
  async function probe(label) {
    const before = await exec(`({
      sequence:fileOpenSequence,render:renderGeneration,reloads:reloadRequestSequence,
      mode:isEditMode,value:markdownEditor.value,history:JSON.stringify(historySnapshot()),
      path:currentFilePath,tab:window.CustomTabs.getActiveTabId()
    })`);
    states.push(await exec(`({
      label:${JSON.stringify(label)},disabled:['refreshBtn','openEditorBtn','toggleEdit']
        .every(id=>document.getElementById(id).disabled),
      tocEnabled:!toggleTocBtn.disabled,owner:currentSaveDocumentIdentity(),
      count:window.CustomTabs.getTabs().length,welcome:!!viewer.querySelector('.welcome')
    })`));
    for (const id of ["refreshBtn", "openEditorBtn"]) {
      const point = await exec(`(() => {
        toggleTocBtn.focus();
        const b=document.getElementById(${JSON.stringify(id)});b.focus();
        const r=b.getBoundingClientRect();
        return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
          skipped:document.activeElement!==b};
      })()`);
      states.at(-1).focusSkipped = (states.at(-1).focusSkipped ?? true) && point.skipped;
      win.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
    }
    const rejected = await exec(`(async () => {
      refreshBtn.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      openEditorBtn.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      await changeCurrentDocumentEditor(true);
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'r',ctrlKey:true,bubbles:true,cancelable:true}));
      return {reload:reloadCurrentFile(),confirmed:await window.CustomTabs.requestReloadWithConfirmation()};
    })()`);
    await settle();
    const after = await exec(`({
      sequence:fileOpenSequence,render:renderGeneration,reloads:reloadRequestSequence,
      mode:isEditMode,value:markdownEditor.value,history:JSON.stringify(historySnapshot()),
      path:currentFilePath,tab:window.CustomTabs.getActiveTabId()
    })`);
    effects.push({ label, before, after, rejected,
      dialog: await exec("!!document.getElementById('appMessageDialog')?.open") });
    const wasOpen = await exec("indexPanel.classList.contains('visible')");
    await exec("toggleTocBtn.click();true");
    await settle();
    const toggled = await exec(`indexPanel.classList.contains('visible')===${!wasOpen}&&
      toggleTocBtn.getAttribute('aria-pressed')===${JSON.stringify(String(!wasOpen))}`);
    await exec("toggleTocBtn.click();true");
    await settle();
    panels.push({ label, toggled, restored: await exec(`indexPanel.classList.contains('visible')===${wasOpen}`) });
  }
  await probe("fresh Welcome");
  cancelNextOpen = true;
  const beforeChooser = chooserCalls;
  await exec("document.getElementById('openFile').click();true");
  await settle();
  check("cancelled initial admission really reaches the controlled native chooser",
    chooserCalls === beforeChooser + 1 && !cancelNextOpen);
  await probe("cancelled initial admission");
  const refusal = await exec(`(() => {
    const sequence=fileOpenSequence;
    const result=beginFileOpen({path:${JSON.stringify(files[0])},content:${JSON.stringify(bodies[0])}},
      {ownerTabId:Number.MAX_SAFE_INTEGER,source:'initial-owner-refusal'});
    return {refused:result===null,restored:fileOpenSequence===sequence,tab:window.CustomTabs.getActiveTabId()};
  })()`);
  check("initial admission refusal really rejects an unknown owner and restores Welcome",
    refusal.refused && refusal.restored && refusal.tab === null, refusal);
  await probe("refused initial admission");
  await exec(`updateFileInfo(${JSON.stringify(files[0])});true`);
  try {
    const staleRefusal = await exec(`(() => {
      const result=beginFileOpen({path:${JSON.stringify(files[1])},content:${JSON.stringify(bodies[1])}},
        {ownerTabId:Number.MAX_SAFE_INTEGER,source:'stale-path-owner-refusal'});
      return result===null&&currentFilePath===${JSON.stringify(files[0])}&&
        !window.CustomTabs.getActiveTab()&&currentSaveDocumentIdentity()===null;
    })()`);
    check("stale-path admission is refused without creating an action owner", staleRefusal);
    await probe("stale path after refused admission without an owner");
  }
  finally { await exec("updateFileInfo(null);true"); }
  const empty = path.join(directory, "empty.md");
  fs.writeFileSync(empty, "");
  chosen = empty;
  await exec("document.getElementById('openFile').click();true");
  await wait("admitted empty document", `currentFilePath===${JSON.stringify(empty)}&&
    !!currentSaveDocumentIdentity()&&!loadingScreen.classList.contains('active')`);
  await settle();
  check("an admitted empty document enables both document actions without content heuristics",
    await exec(`originalMarkdown===''&&currentReloadSnapshot()===''&&
      !refreshBtn.disabled&&!openEditorBtn.disabled&&!toggleEditBtn.disabled&&
      currentSaveDocumentIdentity().tabId===window.CustomTabs.getActiveTabId()`));
  const beforeReload = await exec("reloadRequestSequence");
  const beforeRender = await exec("renderGeneration");
  await exec("refreshBtn.click();true");
  await wait("completed empty document reload", `reloadRequestSequence>${beforeReload}&&
    renderGeneration>${beforeRender}&&!loadingScreen.classList.contains('active')&&
    document.body.textContent.includes('File reloaded successfully')`);
  check("enabled Reload really dispatches an owned empty-document request",
    await exec(`reloadRequestSequence===${beforeReload + 1}&&currentReloadSnapshot()===''`));
  await exec("openEditorBtn.click();true");
  await wait("empty document editor", "isEditMode");
  check("enabled Open editor opens a valid empty admitted document",
    await exec("markdownEditor.value===''&&!hasUnsavedChanges&&contentWrapper.classList.contains('split-view')"));
  await input("# Unsaved witness in an originally empty document.\n", 3, 15);
  const emptyOwner = await exec("window.CustomTabs.getActiveTabId()");
  await exec("window.CustomTabs.closeTab(window.CustomTabs.getActiveTabId());true");
  await wait("unsaved last-tab close question", "!!document.getElementById('appMessageDialog')?.open");
  await choice("cancel");
  check("cancelling last-tab close preserves the admitted editor and enabled document actions",
    await exec(`window.CustomTabs.getActiveTabId()===${emptyOwner}&&isEditMode&&hasUnsavedChanges&&
      !refreshBtn.disabled&&!openEditorBtn.disabled&&currentSaveDocumentIdentity().tabId===${emptyOwner}`));
  await exitQuestion();
  await choice("proceed");
  await wait("empty draft restored through explicit discard", `!isEditMode&&currentReloadSnapshot()===''&&!hasUnsavedChanges&&
    !viewer.querySelector('h1')&&!loadingScreen.classList.contains('active')`);
  await exec("window.CustomTabs.closeTab(window.CustomTabs.getActiveTabId())");
  await wait("empty document retired", "window.CustomTabs.getTabs().length===0&&!!viewer.querySelector('.welcome')");
  await probe("last tab closed");
  check("document actions are natively disabled throughout the no-document lifecycle",
    states.every(value => value.disabled && value.focusSkipped && value.owner === null &&
      value.count === 0 && value.welcome), states);
  check("disabled native input and direct no-document commands cannot mutate or reload the reader",
    effects.every(value => JSON.stringify(value.before) === JSON.stringify(value.after) &&
      value.rejected.reload === false && value.rejected.confirmed === false && !value.dialog), effects);
  check("the global TOC remains enabled and functional throughout the no-document lifecycle",
    states.every(value => value.tocEnabled) && panels.every(value => value.toggled && value.restored), panels);
  await capture("welcome-disabled-document-actions");
}
async function repeatedEditorNoop() {
  await exec(`markdownEditor.style.whiteSpace='pre';
    markdownEditor.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
    markdownEditor.scrollTop=1200;markdownEditor.scrollLeft=55;true`);
  await settle();
  await wait("settled repeated editor geometry", "getEditorScrollDiagnostics().ready&&!getEditorScrollDiagnostics().pendingGeometry");
  await exec("toggleTocBtn.focus();true");
  const before = await exec(`({
    editor:captureDocumentEditor(),dirty:hasUnsavedChanges,render:renderGeneration,mode:editorModeRevision,
    geometry:getEditorScrollDiagnostics().builds,focus:document.activeElement.id
  })`);
  check("repeated Edit probe owns a settled dirty draft selection history and two overflowing scroll axes",
    before.editor.open && before.dirty && before.editor.selection.start < before.editor.selection.end &&
    before.editor.history.undo.length > 0 && before.editor.scrollTop > 500 &&
    before.editor.scrollLeft > 20 && before.geometry > 0 && before.render > 0 &&
    before.focus === "toggleTocBtn", before);
  await exec(`(async () => {
    for(let i=0;i<3;i++){toggleEditBtn.click();openEditorBtn.click();await changeCurrentDocumentEditor(true);}
  })()`);
  await settle();
  const after = await exec(`({
    editor:captureDocumentEditor(),dirty:hasUnsavedChanges,render:renderGeneration,mode:editorModeRevision,
    geometry:getEditorScrollDiagnostics().builds,focus:document.activeElement.id
  })`);
  check("repeated toolbar menu and direct Edit are exact application no-ops without programmatic refocus",
    JSON.stringify(before) === JSON.stringify(after), { before, after });
  await exec("openEditorBtn.focus();true");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await settle();
  check("native repeated Edit keeps button focus without resetting its open dirty document",
    await exec(`document.activeElement===openEditorBtn&&isEditMode&&
      renderGeneration===${before.render}&&markdownEditor.scrollTop===${before.editor.scrollTop}&&
      markdownEditor.scrollLeft===${before.editor.scrollLeft}`));
  await exec("markdownEditor.style.whiteSpace='';true");
  await settle();
}
async function runNativeReadingModePositionCases() {
  const original = fs.readFileSync(files[0]);
  const warnings = [];
  let recovering = false, fixtureTab = null, historyOrigin, blockedReason = null;
  const recoveryObservations = [];
  const onConsole = details => {
    if (details?.level === "warning" &&
        details.message.startsWith("Reading position could not be preserved after the mode change:")) {
      warnings.push(details.message);
      nativeObservations.push({ scenario, phase: "mode preservation warning", recovering,
        afterExecutedOccurrence: results.length, message: details.message });
    }
  };
  const need = (name, ok, detail) => {
    if (recovering) recoveryObservations.push({ name, ok: !!ok, detail });
    else check(name, ok, detail);
    if (!ok) throw new Error(name);
  };
  const prose = Array.from({ length: 24 }, (_, row) => "Mode reading paragraph " + row + ". " +
    Array.from({ length: 48 }, (_, column) => `p${row}w${column}`).join(" ")).join("\n\n");
  const code = Array.from({ length: 32 }, (_, row) =>
    Array.from({ length: 48 }, (_, column) => `r${row}c${column}_`).join(" ")).join("\n");
  const table = "| " + Array.from({ length: 6 }, (_, column) => "Column " + column).join(" | ") + " |\n" +
    "| " + Array(6).fill("---").join(" | ") + " |\n" +
    Array.from({ length: 20 }, (_, row) => "| " + Array.from({ length: 6 }, (_, column) =>
      Array.from({ length: 24 }, (_, part) => `t${row}c${column}q${part}_`).join("")).join(" | ") + " |").join("\n");
  const tail = Array.from({ length: 12 }, (_, row) => "Trailing mode paragraph " + row + ". " +
    "Ordinary trailing prose keeps the table reachable. ".repeat(8)).join("\n\n");
  const baseline = "# Alpha\n\nUnsaved witness native reading modes.\n\n[Mode code](#mode-code)\n\n" +
    "## Mode prose\n\n" + prose + "\n\n## Mode code\n\n```\n" + code + "\n```\n\n## Mode table\n\n" + table + "\n\n" + tail + "\n" +
    (modeGate ? "\n---\n\nFallback trailing control.\n" : "");
  const offsets = `({
    outer:contentWrapper.scrollTop,preview:viewer.scrollTop,
    codeTop:viewer.querySelector('pre')?.scrollTop??null,codeLeft:viewer.querySelector('pre')?.scrollLeft??null,
    tableTop:viewer.querySelector('.table-container')?.scrollTop??null,
    tableLeft:viewer.querySelector('.table-container')?.scrollLeft??null
  })`;
  const boundaryState = `function nativeBoundaryState() {
    const d=getEditorScrollDiagnostics();
    const ids=window.__nativeModeOwnerIds||={map:new WeakMap(),next:0};
    const identify=element=>{
      if(!element)return null;
      if(!ids.map.has(element))ids.map.set(element,++ids.next);
      return ids.map.get(element);
    };
    const outer=getViewerScroller(),code=viewer.querySelector('pre'),table=viewer.querySelector('.table-container');
    return {edit:isEditMode,render:renderGeneration,presentation:readingPresentationRevision,
      selection:fileOpenSequence,displayKey:readingDisplay?.key??null,published:readingDisplay?.published??null,
      publication:{...readingPublicationObservation},
      diagnostics:{ready:d.ready,pendingGeometry:d.pendingGeometry,pendingSource:d.pendingSource,
        matchesSource:d.matchesSource,selection:d.selection,mappedSelection:d.mappedSelection,
        owner:d.owner,anchors:d.anchors,builds:d.builds,textGroups:d.textGroups},
      captureFailure:d.lastReadingCaptureFailure,
      restoreFailure:d.lastReadingRestoreFailure,
      owners:{outer:identify(outer),code:identify(code),table:identify(table)},
      offsets:{outer:outer?.scrollTop??null,wrapperLeft:contentWrapper.scrollLeft,previewLeft:viewer.scrollLeft,
        codeTop:code?.scrollTop??null,codeLeft:code?.scrollLeft??null,
        tableTop:table?.scrollTop??null,tableLeft:table?.scrollLeft??null}};
  }`;
  let boundarySequence = 0;
  const nativeExec = async (step, expression) => {
    const id = ++boundarySequence;
    try {
      const observed = await exec(`(async()=>{
        ${boundaryState}
        delete window.__nativeModePayloadError;
        let before=null;
        try {
          before=nativeBoundaryState();
          const value=await (${expression});
          return {value,before,after:nativeBoundaryState()};
        } catch(error) {
          window.__nativeModePayloadError={id:${id},before,name:String(error.name),
            message:String(error.message),stack:String(error.stack||error)};
          throw error;
        }
      })()`);
      const value = observed.value;
      nativeObservations.push({ scenario, step, id, recovering, afterExecutedOccurrence: results.length,
        before: observed.before, after: observed.after,
        capture: value?.status ? { status: value.status, reason: value.reason,
          sourceKey: value.location?.text.sourceKey, kind: value.location?.text.runKind,
          start: value.location?.text.start, end: value.location?.text.end,
          horizontal: value.location?.horizontal } : null });
      return value;
    } catch (error) {
      try {
        const original = await exec(`(() => {
          const error=window.__nativeModePayloadError;delete window.__nativeModePayloadError;
          if(!error||error.id!==${id})throw new Error('Native payload error detail is unavailable');
          return error;
        })()`);
        failures.push({ scenario, phase: "renderer payload exception", step, id, original });
        console.error(JSON.stringify(failures.at(-1)));
      } catch (collectionError) { recordError("renderer payload detail collection: " + step, collectionError); }
      throw error;
    }
  };
  const rangeProbe = `function fixtureReference(text,kind) {
    const source=currentReloadSnapshot(),nl=String.fromCharCode(10),fence=String.fromCharCode(96).repeat(3);
    if(!source.startsWith('# Alpha'+nl+nl+'Unsaved witness native reading modes.'+nl+nl))
      throw new Error('Native fixture reference is not the synthetic fixture');
    const fail=reason=>{throw new Error('Native fixture reference '+reason+' '+JSON.stringify({
      kind,start:text.start,end:text.end,display:text.display.slice(0,96)}));};
    let from,to,selector,prefix;
    if(kind==='text'){
      from=source.lastIndexOf(nl+nl,text.start)+2;
      to=source.indexOf(nl+nl,text.end);
      const match=source.slice(from,to).match(/^Mode reading paragraph [0-9]+[.] /);
      if(!match)fail('has no prose block');
      selector='p';prefix=match[0];
    }else if(kind==='code'){
      const marker='## Mode code'+nl+nl+fence+nl,heading=source.indexOf(marker);
      if(heading<0)fail('has no code block');
      from=heading+marker.length;to=source.indexOf(nl+fence,from);
      selector='pre code';prefix='r0c0_ ';
    }else{
      from=source.lastIndexOf('|',text.start)+1;to=source.indexOf('|',text.end);
      while(source[from]===' ')from++;
      while(source[to-1]===' ')to--;
      const match=source.slice(from,to).match(/^t[0-9]+c[0-9]+q0_/);
      if(!match)fail('has no table body cell');
      selector='tbody td';prefix=match[0];
    }
    if(from<0||to<from||text.start<from||text.end>to||
        source.slice(text.start,text.end)!==text.display)fail('has no exact plain-text source atom');
    // Clip source context to this known plain-text fixture block, not Markdown boundaries.
    const left=Math.max(from,text.start-Math.min(text.before.length,48));
    const right=Math.min(to,text.end+Math.min(text.after.length,48));
    const needle=source.slice(left,right);
    if(!needle||needle.length>256)fail('context is outside its bound');
    return {needle,before:text.start-left,display:text.display,kind,block:{selector,prefix}};
  }
  function materializeNativeReference(reference) {
    const fail=(reason,detail)=>{throw new Error('Native mode '+reason+' '+JSON.stringify({
      kind:reference.kind,block:reference.block,reference:reference.needle.slice(0,256),...detail}));};
    const blocks=[...viewer.querySelectorAll(reference.block.selector)]
      .filter(element=>element.textContent.startsWith(reference.block.prefix));
    if(blocks.length!==1)fail(blocks.length?'fixture-block-multiple-matches':'fixture-block-zero-matches',{matches:blocks.length});
    const block=blocks[0],walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT),nodes=[];
    let node,text='';
    while(node=walker.nextNode()){nodes.push({node,start:text.length});text+=node.data;}
    const from=text.indexOf(reference.needle);
    if(from<0)fail('context-zero-matches',{characters:text.length});
    const second=text.indexOf(reference.needle,from+1);
    if(second>=0)fail('context-multiple-matches',{first:from,second});
    const start=from+reference.before,end=start+reference.display.length;
    const first=nodes.find(entry=>start>=entry.start&&start<entry.start+entry.node.length);
    const last=nodes.find(entry=>end>entry.start&&end<=entry.start+entry.node.length);
    if(!first||!last)throw new Error('Native mode atom has no exact DOM interval');
    const range=document.createRange();
    range.setStart(first.node,start-first.start);range.setEnd(last.node,end-last.start);
    const rects=[...range.getClientRects()];
    if(rects.length!==1||range.toString()!==reference.display)throw new Error('Native mode atom is not one exact fragment');
    return {block,range,rect:rects[0],fail};
  }
  function rangeProbe(reference) {
    const {block,range,rect,fail}=materializeNativeReference(reference),outer=getViewerScroller();
    const inner=reference.kind==='code'?block.closest('pre'):
      reference.kind==='table'?block.closest('.table-container'):null;
    if(reference.kind!=='text'&&!inner)fail('fixture-inner-owner-missing',{});
    const top=element=>{
      const bounds=element.getBoundingClientRect(),scale=scrollerScale(element);
      return (rect.top-bounds.top)/scale-element.clientTop;
    };
    const exposed=[outer,...(inner?[inner]:[])].every(element=>{
      const bounds=element.getBoundingClientRect(),scale=scrollerScale(element);
      const left=bounds.left+element.clientLeft*scale,right=left+element.clientWidth*scale;
      const top=bounds.top+element.clientTop*scale,bottom=top+element.clientHeight*scale;
      return rect.width>0&&rect.height>0&&rect.left<right&&rect.right>left&&rect.top<bottom&&rect.bottom>top;
    })&&rect.left<innerWidth&&rect.right>0&&rect.top<innerHeight&&rect.bottom>0;
    return {outerTop:top(outer),innerTop:inner?top(inner):null,exposed,
      bodyCell:!!range.startContainer.parentElement.closest('td'),
      innerLeft:inner?.scrollLeft??null,innerScroll:inner?.scrollTop??null,
      wrapperLeft:contentWrapper.scrollLeft,previewLeft:viewer.scrollLeft,
      overflow:inner?{x:inner.scrollWidth-inner.clientWidth,y:inner.scrollHeight-inner.clientHeight}:null};
  }`;
  const state = () => exec(`(() => {
    const history=historySnapshot();
    return {source:currentReloadSnapshot(),original:originalMarkdown,value:markdownEditor.value,
      start:markdownEditor.selectionStart,end:markdownEditor.selectionEnd,direction:markdownEditor.selectionDirection,
      dirty:hasUnsavedChanges,undoRedo:JSON.stringify([history.undo,history.redo]),
      tab:window.CustomTabs.getActiveTabId(),path:currentFilePath,edit:isEditMode,
      generation:currentSaveDocumentIdentity()?.documentGeneration,selection:fileOpenSequence,
      cached:window.CustomTabs.getActiveTab()?.content,saved:window.CustomTabs.getActiveTab()?.originalContent,
      observableHistory:window.readingHistoryControls.availability()};
  })()`);
  const gateCapture = async (name, source, edit) => {
    if (!modeGate) return;
    await settle();
    need("mode gate capture owns the exact visible document and mode: " + name,
      await exec(`currentFilePath===${JSON.stringify(files[0])}&&
        currentSaveDocumentIdentity()?.tabId===window.CustomTabs.getActiveTabId()&&
        currentReloadSnapshot()===${JSON.stringify(source)}&&isEditMode===${edit}&&
        viewer.querySelector('h1')?.textContent==='Alpha'&&
        !loadingScreen.classList.contains('active')&&readingRenderCompletion===null&&
        window.displayedReadingKeyForContent(window.CustomTabs.getActiveTab(),${JSON.stringify(source)})!==null`));
    const filename = "mode-gate-" + name;
    await capture(filename);
    nativeObservations.push({ scenario, phase: "saved screenshot", file: filename + ".png",
      viewed: false, state: await state() });
  };
  const exactGateState = async (label, before) => {
    const after = await state();
    need(label + " preserves exact owner source cache selection dirty state and Undo/Redo",
      modeGateStatePreserved(before, after), { before, after });
  };
  const ready = async text => {
    let reachedTimeout = false;
    // Only wait's own timeout coerces its label; renderer errors pass through.
    const label = { toString() { reachedTimeout = true; return "native mode final displayed Source"; } };
    try {
      await wait(label, `(() => {
        const d=window.__nativeModeReadyObservation||={
          poll:0,lastCapturePoll:null,lastCaptureStatus:null,lastCaptureReason:null,
          lastCaptureKeyEqual:null,stringsTruncated:false
        };
        d.poll++;
        d.renderPending=d.previewPending=d.loadingActive=d.adapterAvailable=null;
        d.displayPresent=d.activeTabMatches=d.selectionMatches=d.published=null;
        d.capture='skipped';d.captureStatus=d.captureReason=d.keyEqual=null;
        if((d.renderPending=readingRenderCompletion!==null)||
            (d.previewPending=previewDebounceTimer!==null)||
            (d.loadingActive=loadingScreen.classList.contains('active'))||
            !(d.adapterAvailable=window.readingLocationAdapter.available())){
          if(d.adapterAvailable===false){
            d.displayPresent=!!readingDisplay;
            if(d.displayPresent){
              // One extra read of the read-only getter explains this failed gate.
              d.activeTabMatches=window.CustomTabs?.getActiveTab()===readingDisplay.tab;
              d.selectionMatches=readingDisplay.selection===fileOpenSequence;
              d.published=readingDisplay.published===true;
            }
          }
          return false;
        }
        const captured=window.readingLocationAdapter.capture(),status=captured.status;
        const bounded=value=>{
          if(typeof value!=='string')return null;
          if(value.length>96)d.stringsTruncated=true;
          return value.slice(0,96);
        };
        d.capture='returned';d.captureStatus=bounded(status);d.captureReason=bounded(captured.reason);
        const accepted=status==='captured'&&
          (d.keyEqual=window.displayedReadingKeyForContent(window.CustomTabs.getActiveTab(),${JSON.stringify(text)})===captured.location.text.sourceKey);
        d.lastCapturePoll=d.poll;d.lastCaptureStatus=d.captureStatus;
        d.lastCaptureReason=d.captureReason;d.lastCaptureKeyEqual=d.keyEqual;
        if(accepted)delete window.__nativeModeReadyObservation;
        return accepted;
      })()`);
    } catch (error) {
      if (!reachedTimeout) throw error;
      try {
        const observation = await exec(`(() => {
          const d=window.__nativeModeReadyObservation;
          delete window.__nativeModeReadyObservation;
          if(!d)throw new Error('native-ready-observation-missing');
          d.publication=typeof readingPublicationObservation==='undefined'?null:{...readingPublicationObservation};
          if(d.publication){
            const primitive=Object.values(d.publication).every(value=>value===null||
              typeof value==='boolean'||(typeof value==='number'&&Number.isSafeInteger(value))||
              (typeof value==='string'&&value.length<=96&&/^[a-z0-9_-]+$/i.test(value)));
            if(!primitive)d.publication={diagnosticInvalid:true,collection:'invalid-observation'};
            else if(JSON.stringify(d.publication).length>1024){
              d.publication={diagnosticInvalid:true,collection:'observation-over-bound'};
            }
          }
          const value=JSON.stringify(d);
          if(value.length>4096)throw new Error('native-ready-observation-over-bound');
          return value;
        })()`);
        if (typeof observation !== "string" || observation.length > 4096) {
          throw new Error("native-ready-observation-invalid");
        }
        console.error("Native mode ready timeout operands: " + observation);
      } catch {
        console.error("Native mode ready timeout operand collection failed");
      }
      throw error;
    }
  };
  const capturePoint = async kind => {
    const captured = await nativeExec("capture:" + kind, "window.readingLocationAdapter.capture()");
    need("native " + kind + " setup captures actual displayed text", captured.status === "captured", captured);
    need("native " + kind + " setup owns the expected text and nested chain",
      kind === "text" ? captured.location.text.runKind === "text" :
        captured.location.text.runKind === kind && captured.location.text.alignment.nested.some(owner => owner.kind === kind), captured);
    const text = captured.location.text;
    const { reference, geometry } = await nativeExec("locate:" + kind, `(() => {
      ${rangeProbe}
      const reference=fixtureReference(${JSON.stringify(text)},${JSON.stringify(kind)});
      return {reference,geometry:rangeProbe(reference)};
    })()`);
    need("native " + kind + " setup exposes its independently located DOM fragment", geometry.exposed, geometry);
    if (kind === "table") need("native table setup reads a body cell rather than a fixed header", geometry.bodyCell, geometry);
    return { reference, geometry, captured };
  };
  const probe = reference => nativeExec("probe:" + reference.kind,
    `(() => {${rangeProbe};return rangeProbe(${JSON.stringify(reference)});})()`);
  const position = async (kind, proseRow = 12) => {
    const setup = await nativeExec("position:" + kind, `(() => {
      const outer=getViewerScroller();
      const target=${kind === "text"
        ? "[...viewer.querySelectorAll('p')].find(element=>element.textContent.startsWith(" +
          JSON.stringify("Mode reading paragraph " + proseRow + ".") + "))"
        : kind === "code" ? "viewer.querySelector('pre')" : "viewer.querySelector('.table-container')"};
      if(!target)throw new Error('Native mode fixture target is missing');
      outer.scrollTop+=(target.getBoundingClientRect().top-outer.getBoundingClientRect().top)/scrollerScale(outer)-outer.clientTop;
      if(${JSON.stringify(kind)}==='text')outer.scrollTop+=40;
      else if(${JSON.stringify(kind)}==='code'){
        ${positionNativeCodeFixture.toString()}
        positionNativeCodeFixture(target,outer);
      }else {target.scrollTop=120;target.scrollLeft=400;}
      return {outer:outer.scrollTop,overflow:outer.scrollHeight-outer.clientHeight,
        targetTop:(target.getBoundingClientRect().top-outer.getBoundingClientRect().top)/scrollerScale(outer)-outer.clientTop,
        innerTop:target.scrollTop,innerLeft:target.scrollLeft,
        x:target.scrollWidth-target.clientWidth,y:target.scrollHeight-target.clientHeight};
    })()`);
    need("native " + kind + " setup really travels inside an overflowing document",
      setup.outer > 500 && setup.overflow > 500, setup);
    if (kind !== "text") need("native " + kind + " setup really travels on both inner axes",
      setup.innerTop > 80 && setup.innerLeft > 300 && setup.x > 500 && setup.y > 150 &&
      Math.abs(setup.targetTop) <= 1, setup);
  };
  const samePoint = async (label, before) => {
    const after = await probe(before.reference), close = (a, b) => Math.abs(a - b) <= 1;
    check(label + " preserves the same visible native text fragment", after.exposed &&
      close(after.outerTop, before.geometry.outerTop) &&
      (after.innerTop === null || close(after.innerTop, before.geometry.innerTop)), { before: before.geometry, after });
    check(label + " preserves each scroller's horizontal position",
      close(after.wrapperLeft, before.geometry.wrapperLeft) && close(after.previewLeft, before.geometry.previewLeft) &&
      (after.innerLeft === null || close(after.innerLeft, before.geometry.innerLeft)), { before: before.geometry, after });
  };
  const sameState = (label, before, after, selection) => {
    need(label + " preserves source dirty state and document Undo/Redo",
      before.source === after.source && before.original === after.original &&
      before.dirty === after.dirty && before.undoRedo === after.undoRedo, { before, after });
    if (selection) check(label + " preserves the source selection and caret",
      before.value === after.value && before.start === after.start && before.end === after.end &&
      before.direction === after.direction, { before, after });
  };
  const focusReader = async () => {
    need("native history checkpoint is a real eligible Reader", await exec(
      "!isEditMode&&editorExitOperation===null&&!document.querySelector('dialog[open], .note-dialog-overlay.visible, [aria-modal=\"true\"].visible')"));
    await exec("toggleTocBtn.focus();true");
  };
  const transition = async open => {
    await nativeExec(open ? "enter Split" : "enter Reader",
      `(async()=>{await changeCurrentDocumentEditor(${open});return true;})()`);
    await wait("native mode operation completes", `isEditMode===${open}&&editorExitOperation===null&&readingRenderCompletion===null`);
    await ready(baseline);
    if (!open) await focusReader();
    await sentinel.drain();
  };
  const starting = await exec(`({tab:window.CustomTabs.getActiveTabId(),path:currentFilePath,
    clean:!hasUnsavedChanges&&!hasPendingSaveFor(currentFilePath),reader:!isEditMode,count:window.CustomTabs.getTabs().length})`);
  nativeUnsafe = !(starting.path === files[0] && starting.clean && starting.reader &&
    starting.count === 1 && Number.isSafeInteger(starting.tab));
  need("native mode group starts with only the current clean Alpha reader",
    !nativeUnsafe, starting);
  need("native mode group requires the real assembled reading interfaces", await exec(`[
    window.readingHistoryControls?.navigate,window.readingHistoryControls?.availability,window.readingHistoryControls?.subscribe,
    window.readingLocationAdapter?.capture,window.readingLocationAdapter?.available,window.displayedReadingKeyForContent
  ].every(method=>typeof method==='function')`));
  const seedFixture = async () => {
    await wait("native mode fixture owns Welcome", "window.CustomTabs.getTabs().length===0&&!!viewer.querySelector('.welcome')");
    fs.writeFileSync(files[0], baseline);
    fixtureTab = await open(0);
    await exec(`(() => {
      const style=document.createElement('style');style.id='native-reading-mode-fixture';
      style.textContent='#viewer pre,#viewer .table-container{max-height:240px;overflow:auto}' +
        ${JSON.stringify(modeGate ? "#viewer hr{height:2400px;margin:0}" : "")};
      document.head.append(style);return true;
    })()`);
    await ready(baseline);
    await focusReader();
    await position("text", 8);
    historyOrigin = await capturePoint("text");
    await exec("viewer.querySelector('a[href=\"#mode-code\"]').click();true");
    await wait("native fixture seeds a real reading jump", "window.readingHistoryControls.availability().back");
  };
  const cleanupFixture = async () => {
    try {
      if (nativeUnsafe || win.isDestroyed() || win.webContents.isDestroyed()) {
        throw new Error("Native cleanup cannot use an unsafe renderer");
      }
      const owned = await exec(`(() => {
        const tabs=window.CustomTabs.getTabs();
        return tabs.length===0||(tabs.length===1&&window.CustomTabs.getActiveTabId()===${fixtureTab ?? starting.tab}&&
          currentFilePath===${JSON.stringify(files[0])}&&
          currentSaveDocumentIdentity()?.tabId===${fixtureTab ?? starting.tab}&&!hasPendingSaveFor(currentFilePath));
      })()`);
      if (!owned) {
        nativeUnsafe = true;
        throw new Error("Native cleanup lost its exclusive Alpha owner");
      }
      await exec("document.getElementById('native-reading-mode-fixture')?.remove();delete window.__nativeModeOwnerIds;delete window.__nativeModePayloadError;true");
      if (await exec("!!document.getElementById('appMessageDialog')?.open")) {
        if (!await exec("document.getElementById('appMessageTitle').textContent==='Discard unsaved changes?'")) {
          nativeUnsafe = true;
          throw new Error("Native cleanup found an unrelated dialog");
        }
        await choice("proceed");
      }
      await wait("native mode cleanup completes any exit", "editorExitOperation===null");
      if (await exec("isEditMode")) {
        const dirty = await exec("hasUnsavedChanges");
        const closing = exec("(async()=>{await changeCurrentDocumentEditor(false);return true;})()");
        if (dirty) {
          await Promise.race([
            wait("native mode cleanup Discard question", "!!document.getElementById('appMessageDialog')?.open"),
            closing.then(() => { throw new Error("Native cleanup Discard completed without its confirmation"); }),
          ]);
          await choice("proceed");
        }
        await closing;
      }
      await exec(`(async()=> {
        const tab=window.CustomTabs.getActiveTab();
        if(tab&&!hasUnsavedChanges)await window.CustomTabs.closeTab(tab.id);
        return true;
      })()`);
      await wait("native mode fixture tab retires before restoring its file", "window.CustomTabs.getTabs().length===0");
    } finally {
      fs.writeFileSync(files[0], original);
    }
    if (!fs.readFileSync(files[0]).equals(original)) throw new Error("Native fixture byte restoration failed");
  };
  const runScenario = async (name, body) => {
    const entry = nativeScenarios.find(value => value.name === name);
    if (blockedReason) {
      entry.status = "BLOCKED";
      entry.reason = blockedReason;
      return;
    }
    scenario = name;
    entry.status = "RUNNING";
    delete entry.reason;
    entry.firstExecutedOccurrence = results.length + 1;
    const failureStart = failures.length;
    try {
      await body();
      entry.status = failures.length === failureStart ? "PASS" : "FAIL";
    } catch (error) {
      entry.status = "FAIL";
      entry.unexecutedRemainder = { status: "NOT RUN", reason: String(error?.stack || error) };
      recordError("scenario exception", error);
      if (entry !== nativeScenarios.at(-1)) {
        recovering = true;
        try {
          if (JSON.stringify(hashes()) !== JSON.stringify(product)) {
            nativeUnsafe = true;
            throw new Error("Product source changed before native recovery");
          }
          await cleanupFixture();
          const retired = fixtureTab;
          await seedFixture();
          const fresh = await state();
          need("native recovery re-establishes the owned source and empty document history",
            fixtureTab !== retired && fs.readFileSync(files[0], "utf8") === baseline &&
            fresh.source === baseline && fresh.original === baseline && !fresh.dirty &&
            fresh.undoRedo === JSON.stringify([[], []]) &&
            await exec(`!isEditMode&&window.CustomTabs.getTabs().length===1&&
              currentSaveDocumentIdentity()?.tabId===${fixtureTab}`), fresh);
        } catch (recoveryError) {
          blockedReason = String(recoveryError?.stack || recoveryError);
          nativeUnsafe = true;
          recordError("recovery or cleanup exception", recoveryError);
        } finally {
          failures.push({ scenario, phase: "recovery observations", observations: recoveryObservations.splice(0) });
          recovering = false;
        }
      }
    } finally { entry.lastExecutedOccurrence = results.length; }
  };
  win.webContents.on("console-message", onConsole);
  try {
    await exec(`window.CustomTabs.closeTab(${starting.tab})`);
    await seedFixture();
    const traverseBranch = async (label, departure) => {
      const originHere = await probe(historyOrigin.reference);
      need(label + " departure really differs from its seeded Back target",
        Math.abs(originHere.outerTop - historyOrigin.geometry.outerTop) > 50,
        { origin: historyOrigin.geometry, originHere, departure: departure.geometry });
      need(label + " really traverses Back", await exec("window.readingHistoryControls.navigate(-1)"));
      await ready(baseline);
      await samePoint(label + " Back returns to the seeded origin", historyOrigin);
      need(label + " really traverses Forward", await exec("window.readingHistoryControls.navigate(1)"));
      await ready(baseline);
      await samePoint(label + " Forward returns to the actual departure", departure);
    };
    const modeCases = ["text", "code", "table"].map(kind => ({ kind, name: "mode:" + kind }));
    if (modeGate) modeCases.push(...["text", "code", "table"].map(kind => ({ kind, name: "zoom-width:" + kind })));
    const normalSize = win.getSize();
    for (const { kind, name } of modeCases) {
      await runScenario(name, async () => {
      const varied = name.startsWith("zoom-width:");
      if (varied) {
        win.setContentSize(1100, 760);
        await exec("document.getElementById('zoomReset').click();document.getElementById('zoomIn').click();document.getElementById('zoomIn').click();true");
        await wait("nondefault native reading zoom and width", "innerWidth===1100&&zoomLevel===120&&parseFloat(getComputedStyle(viewer).zoom)===1.2");
        await settle();
        await ready(baseline);
        need("mode gate really changes native content width and reading zoom", await exec(
          "innerWidth===1100&&zoomLevel===120&&scrollerScale(viewer)>1"), await state());
      }
      const image = (varied ? "zoom-width-" : "") + kind;
      await position(kind);
      const reader = await capturePoint(kind), before = await state(), warningStart = warnings.length;
      const readerWidth = modeGate ? await exec("viewer.getBoundingClientRect().width") : null;
      await gateCapture(image + "-reader-before", baseline, false);
      await transition(true);
      await samePoint("Reader to Split " + kind, reader);
      sameState("Reader to Split " + kind, before, await state(), false);
      if (modeGate) {
        const after = await state();
        need("mode gate Split really narrows the native viewer at the requested zoom",
          await exec(`viewer.getBoundingClientRect().width>0&&
            viewer.getBoundingClientRect().width<${readerWidth}&&zoomLevel===${varied ? 120 : 100}`));
        need("mode gate Reader to Split keeps exact cached and saved document bytes",
          after.source === baseline && after.original === baseline && after.value === baseline &&
          after.cached === baseline && after.saved === baseline &&
          fs.readFileSync(files[0], "utf8") === baseline, after);
      }
      await exec("markdownEditor.setSelectionRange(7,19,'backward');true");
      const split = await capturePoint(kind), selected = await state();
      await gateCapture(image + "-split", baseline, true);
      await transition(false);
      await samePoint("Split to Reader " + kind, split);
      const completedState = await state();
      sameState("Split to Reader " + kind, selected, completedState, true);
      await gateCapture(image + "-reader-after", baseline, false);
      check("native " + kind + " mode cycle preserves Reader-checkpoint Back/Forward availability",
        JSON.stringify(before.observableHistory) === JSON.stringify(completedState.observableHistory), { before, completedState });
      check("native " + kind + " round trip completes without a preservation refusal", warnings.length === warningStart, warnings);
      if (kind === "table") await nativeExec("position:table history departure", `(() => {
        ${rangeProbe}
        ${positionNativeTableDeparture.toString()}
        const reference=${JSON.stringify(reader.reference)},source=currentReloadSnapshot();
        const at=source.indexOf(reference.needle);
        if(reference.kind!=='table'||reference.block.selector!=='tbody td'||at<0||
            source.indexOf(reference.needle,at+1)>=0)throw new Error('Native table departure source context is not unique');
        const start=at+reference.before,end=start+reference.display.length;
        const current=fixtureReference({start,end,display:reference.display,
          before:reference.needle.slice(0,reference.before),
          after:reference.needle.slice(reference.before+reference.display.length)},'table');
        if(JSON.stringify(current)!==JSON.stringify(reference))throw new Error('Native table departure source reference changed');
        const cell=materializeNativeReference(reference).block;
        let from=source.lastIndexOf('|',start)+1,to=source.indexOf('|',end);
        while(source[from]===' ')from++;
        while(source[to-1]===' ')to--;
        const cellText=source.slice(from,to);
        if(!cellText||cellText.length>256||cell.textContent!==cellText)
          throw new Error('Native table departure body text is not exact');
        const body=materializeNativeReference({...reference,needle:cellText,before:0,display:cellText});
        const labels=Array.from({length:6},(_,column)=>'Column '+column),nl=String.fromCharCode(10);
        const header='| '+labels.join(' | ')+' |'+nl,headerAt=source.indexOf(header);
        const marker='## Mode table'+nl+nl;
        if(headerAt<marker.length||source.indexOf(header,headerAt+1)>=0||
            source.slice(headerAt-marker.length,headerAt)!==marker)
          throw new Error('Native table departure header source is not exact');
        const headers=labels.map(label=>materializeNativeReference({
          kind:'table',needle:label,before:0,display:label,block:{selector:'thead th',prefix:label}}));
        positionNativeTableDeparture(body.block.closest('.table-container'),getViewerScroller(),body,headers);
        return true;
      })()`);
      await traverseBranch("native " + kind + " mode cycle", await capturePoint(kind));
      if (varied) {
        await exec("document.getElementById('zoomReset').click();true");
        win.setSize(...normalSize);
        await wait("mode gate restores normal reading zoom", "zoomLevel===100&&parseFloat(getComputedStyle(viewer).zoom)===1");
        await settle();
        await ready(baseline);
      }
      });
    }
    for (const kind of ["code", "table", "refused"]) {
      await runScenario("discard:" + kind, async () => {
      await transition(true);
      const baselineState = await state();
      const token = kind === "table" ? "t0c0q3_" : "r1c3_";
      const at = baseline.indexOf(token) + token.length;
      need("native Discard edit point belongs to its real fixture", at >= token.length && baseline.includes(token));
      const edited = kind === "refused"
        ? baseline.replace("## Mode prose", "First separated insertion.\n\n## Mode prose")
          .replace("## Mode code", "Second separated insertion.\n\n## Mode code")
        : baseline.slice(0, at) + "inserted-safe-native-token-" + baseline.slice(at);
      await input(edited, at, at + 5);
      await ready(edited);
      need("native " + kind + " edit really reaches its rendered fixture block", await exec(kind === "refused"
        ? "[...viewer.querySelectorAll('p')].some(p=>p.textContent==='First separated insertion.')&&[...viewer.querySelectorAll('p')].some(p=>p.textContent==='Second separated insertion.')"
        : `viewer.querySelector(${JSON.stringify(kind === "table" ? "tbody" : "pre code")}).textContent.includes(${JSON.stringify(token + "inserted-safe-native-token-")})`));
      await position(kind === "table" ? "table" : "code");
      const point = await capturePoint(kind === "table" ? "table" : "code"), dirty = await state();
      need("native " + kind + " Discard really owns an edited dirty Undo state",
        dirty.dirty && dirty.source === edited && dirty.value === edited && dirty.start < dirty.end &&
        dirty.undoRedo !== baselineState.undoRedo, dirty);
      if (kind !== "refused") need("native " + kind + " insertion is before intact captured context and inside its owner",
        at < point.captured.location.text.start - point.captured.location.text.before.length &&
        point.captured.location.text.alignment.nested.every(owner => at > owner.start && at < owner.end), point);
      const warningStart = warnings.length;
      await gateCapture("discard-" + kind + "-split-dirty", edited, true);
      const leaving = nativeExec("Discard exit", `(async()=> {
        ${rangeProbe}
        let publication=null;
        const published=()=>{
          if(!publication&&window.readingLocationAdapter.available()&&
              window.displayedReadingKeyForContent(window.CustomTabs.getActiveTab(),${JSON.stringify(baseline)})!==null){
            publication={offsets:${offsets},point:rangeProbe(${JSON.stringify(point.reference)}),
              observation:nativeBoundaryState()};
          }
        };
        window.addEventListener('reading-location-availability-changed',published);
        try {
          await changeCurrentDocumentEditor(false);
          return {publication,offsets:${offsets}};
        } finally {window.removeEventListener('reading-location-availability-changed',published);}
      })()`);
      await Promise.race([
        wait("native mode Discard question", "document.getElementById('appMessageDialog')?.open&&document.getElementById('appMessageTitle').textContent==='Discard unsaved changes?'"),
        leaving.then(() => { throw new Error("Native Discard completed without reaching its confirmation"); }),
      ]);
      await choice("proceed");
      const completed = await leaving;
      await ready(baseline);
      await sentinel.drain();
      need("native " + kind + " Discard observes the real target publication", !!completed.publication, completed);
      check("native " + kind + " Discard removes the actual rendered edits",
        await exec("!viewer.textContent.includes('inserted-safe-native-token-')&&!viewer.textContent.includes('First separated insertion.')&&!viewer.textContent.includes('Second separated insertion.')"));
      const after = await state();
      need("native " + kind + " Discard restores baseline source dirty state and Undo/Redo",
        after.source === baseline && after.original === baseline && after.value === baseline &&
        after.dirty === baselineState.dirty && after.undoRedo === baselineState.undoRedo &&
        !await exec("isEditMode||editorExitOperation!==null"), after);
      if (modeGate) need("mode gate " + kind + " Discard leaves exact tab and disk baselines",
        after.cached === baseline && after.saved === baseline &&
        fs.readFileSync(files[0], "utf8") === baseline && fs.readFileSync(files[1], "utf8") === bodies[1], after);
      await gateCapture("discard-" + kind + "-reader-after", baseline, false);
      if (kind === "refused") {
        need("native refusal setup would require real outer restoration travel",
          Math.abs(completed.publication.point.outerTop - point.geometry.outerTop) > 50, completed);
        check("native separated changes explicitly refuse without observed fallback travel",
          warnings.length === warningStart + 1 &&
          warnings.at(-1).includes("mode-source-correspondence-unavailable") &&
          Object.keys(completed.offsets).every(key => Math.abs(completed.offsets[key] - completed.publication.offsets[key]) <= 1),
          { warnings: warnings.slice(warningStart), completed });
      } else {
        await samePoint("Later Discard " + kind, point);
        check("native safe " + kind + " Discard completes without a preservation refusal", warnings.length === warningStart, warnings);
      }
      });
    }
    if (modeGate) await runScenario("fallback:unavailable", async () => {
      need("unavailable fallback starts from a genuinely capturable published Source",
        (await exec("window.readingLocationAdapter.capture()")).status === "captured");
      try {
        for (const open of [true, false]) {
          const setup = await nativeExec("position real text-free viewport", `(() => {
            const outer=getViewerScroller(),rule=viewer.querySelector('hr');
            if(!rule||viewer.querySelectorAll('hr').length!==1)throw new Error('Missing unique fixture rule');
            const scale=scrollerScale(outer),bounds=outer.getBoundingClientRect();
            outer.scrollTop+=(rule.getBoundingClientRect().top-bounds.top)/scale+
              rule.getBoundingClientRect().height/scale/2-outer.clientHeight/2-outer.clientTop;
            const r=rule.getBoundingClientRect(),b=outer.getBoundingClientRect();
            const top=Math.max(0,b.top+outer.clientTop*scale);
            const bottom=Math.min(innerHeight,b.top+(outer.clientTop+outer.clientHeight)*scale);
            const walker=document.createTreeWalker(viewer,NodeFilter.SHOW_TEXT);
            let node,visibleText=false;
            while(node=walker.nextNode()){
              if(!node.data.trim())continue;
              const range=document.createRange();range.selectNodeContents(node);
              if([...range.getClientRects()].some(rect=>rect.width>0&&rect.height>0&&
                  rect.top<bottom&&rect.bottom>top&&rect.left<innerWidth&&rect.right>0))visibleText=true;
            }
            return {fills:r.top<top&&r.bottom>bottom,bounded:bottom>top,
              offset:outer.scrollTop,visibleText,capture:window.readingLocationAdapter.capture()};
          })()`);
          need("fallback viewport really contains a nontext rule and no visible text",
            setup.fills && setup.bounded && setup.offset > 500 && !setup.visibleText &&
            setup.capture.status === "unavailable" && setup.capture.reason === "no-visible-text", setup);
          await exec(`(() => {
            const top=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop'),calls=[],restore=[];
            for(const element of [contentWrapper,viewer]){
              const ownTop=Object.getOwnPropertyDescriptor(element,'scrollTop');
              const ownTo=Object.getOwnPropertyDescriptor(element,'scrollTo'),to=element.scrollTo;
              Object.defineProperty(element,'scrollTop',{configurable:true,get(){return top.get.call(this);},
                set(value){calls.push({kind:'scrollTop',value});top.set.call(this,value);}});
              element.scrollTo=function(...args){calls.push({kind:'scrollTo',args});return to.apply(this,args);};
              restore.push(()=>{delete element.scrollTop;delete element.scrollTo;
                if(ownTop)Object.defineProperty(element,'scrollTop',ownTop);
                if(ownTo)Object.defineProperty(element,'scrollTo',ownTo);});
            }
            window.__modeGateNoText={calls,restore(){restore.forEach(callback=>callback());}};
            return true;
          })()`);
          const before = await state(), warningStart = warnings.length;
          await nativeExec("unavailable capture changes mode", `(async()=>{await changeCurrentDocumentEditor(${open});return true;})()`);
          await wait("unavailable capture mode completion",
            `isEditMode===${open}&&editorExitOperation===null&&readingRenderCompletion===null`);
          await settle();
          const after = await state(), writes = await exec("window.__modeGateNoText.calls");
          need("unavailable capture does not invent a native text-restoration request",
            writes.length === 0 && warnings.length === warningStart, { writes, warnings: warnings.slice(warningStart) });
          need("unavailable capture changes only mode and preserves exact document data",
            modeGateStatePreserved({ ...before, edit: open }, after) &&
            fs.readFileSync(files[0], "utf8") === baseline, { before, after });
          await exec("window.__modeGateNoText.restore();delete window.__modeGateNoText;true");
          await gateCapture("fallback-unavailable-" + (open ? "split" : "reader"), baseline, open);
        }
      } finally {
        await exec("window.__modeGateNoText?.restore();delete window.__modeGateNoText;true");
        await position("text");
        await ready(baseline);
      }
    });
    if (modeGate) for (const pending of ["render", "owner"]) await runScenario("pending:" + pending, async () => {
      const saving = pending === "owner", image = "pending-" + pending;
      const beta = await open(1);
      let release = () => {}, leaving = null;
      const realOpen = fs.promises.open;
      try {
        await exec("document.getElementById('openEditorBtn').click();true");
        await wait("pending-owner Beta editor", "isEditMode");
        const betaDraft = bodies[1] + "\n\nUnsaved witness pending-owner Beta.\n";
        await input(betaDraft, 11, 27);
        await ready(betaDraft);
        const betaDraftState = await state();
        need("pending-owner successor really has its own unsaved source selection and Undo",
          betaDraftState.source === betaDraft && betaDraftState.dirty &&
          betaDraftState.start === 11 && betaDraftState.end === 27 &&
          betaDraftState.undoRedo !== JSON.stringify([[], []]), betaDraftState);
        await select(fixtureTab, "Alpha");
        await ready(baseline);
        await transition(true);
        const savedAlpha = saving ? baseline + "\n\nUnsaved witness pending-owner Alpha Save.\n" :
          baseline.replace("r1c3_", "r1c3_native-pending-render_");
        if (saving) {
          await input(savedAlpha, 9, 23);
          await ready(savedAlpha);
          let held = false;
          const gate = new Promise(resolve => { release = resolve; });
          fs.promises.open = async function (...args) {
            const handle = await realOpen.apply(this, args);
            if (!held && path.resolve(String(args[0])) === files[0] && args[1] === "r+") {
              held = true;
              await gate;
            }
            return handle;
          };
          await exec("document.getElementById('saveButton').click();true");
          const deadline = Date.now() + 5000;
          while (!held && Date.now() < deadline) await sleep(15);
          need("pending-owner gate holds a real Main Save before its disposable file changes",
            held && fs.readFileSync(files[0], "utf8") === baseline &&
            await exec("hasPendingSaveFor(currentFilePath)"));
        } else {
          release = () => exec(`(async()=> {
            const gate=window.__modeGateRender;if(!gate)return true;
            gate.restore();gate.release();await gate.rendering;return true;
          })()`);
          await exec(`(() => {
            const gate=(${holdNativeModeRenderFinalizer.toString()})();
            window.__modeGateRender=gate;
            markdownEditor.value=${JSON.stringify(savedAlpha)};
            markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));
            markdownEditor.setSelectionRange(9,23,'backward');
            cancelEditorDeferredWork();
            gate.rendering=renderMarkdown(markdownEditor.value,'full',{preservePosition:true})
              .then(()=>{gate.settled=true;});
            return true;
          })()`);
          await wait("real full render reaches its native idle finalization boundary",
            "window.__modeGateRender.held&&readingRenderCompletion!==null&&!window.__modeGateRender.settled");
          await exec("window.__modeGateRender.restore();true");
          need("pending-render setup holds actual changed code before final Source publication",
            await exec(`viewer.querySelector('pre code').textContent.includes('r1c3_native-pending-render_')&&
              !window.readingLocationAdapter.available()&&isEditMode&&hasUnsavedChanges&&
              currentReloadSnapshot()===${JSON.stringify(savedAlpha)}`) &&
            fs.readFileSync(files[0], "utf8") === baseline);
        }
        const alphaDraftState = await state();
        leaving = nativeExec("pending " + pending + " mode exit", `(async()=> {
          window.__modeGateExitSettled=false;
          await changeCurrentDocumentEditor(false);
          window.__modeGateExitSettled=true;return true;
        })()`);
        if (!saving) {
          await wait("pending-render exit obtains real Discard consent",
            "document.getElementById('appMessageDialog')?.open&&document.getElementById('appMessageTitle').textContent==='Discard unsaved changes?'");
          await choice("proceed");
        }
        await wait("mode exit really waits for its pending " + pending,
          `editorExitOperation?.tab.id===${fixtureTab}&&isEditMode&&
            ${saving ? "hasPendingSaveFor(currentFilePath)" : "readingRenderCompletion!==null&&!window.__modeGateRender.settled"}&&
            window.__modeGateExitSettled===false`);
        if (saving) await gateCapture(image + "-alpha-wait", savedAlpha, true);
        await select(beta, "Beta");
        await ready(betaDraft);
        sameState("pending-owner selection restores Beta's actual draft", betaDraftState, await state(), true);
        const successor = await state(), geometry = await exec(offsets);
        const publication = await exec("({generation:renderGeneration,key:readingDisplay?.key,published:readingDisplay?.published})");
        need("pending-owner wait really crosses to a distinct document generation",
          successor.tab === beta && successor.path === files[1] && successor.edit &&
          Number.isSafeInteger(successor.generation) && successor.generation !== alphaDraftState.generation &&
          successor.selection !== alphaDraftState.selection &&
          await exec(`${saving ? `hasPendingSaveFor(${JSON.stringify(files[0])})` :
            "!window.__modeGateRender.settled"}&&window.__modeGateExitSettled===false`), successor);
        await capture("mode-gate-" + image + "-beta-before");
        nativeObservations.push({ scenario, phase: "saved screenshot",
          file: "mode-gate-" + image + "-beta-before.png", viewed: false, state: successor });
        await release();
        await leaving;
        await wait("real pending-owner Save completes", `!hasPendingSaveFor(${JSON.stringify(files[0])})`);
        await settle();
        await exactGateState("an old mode exit after " + pending + " completion", successor);
        need("old pending " + pending + " completion cannot replace the successor's actual final publication",
          await exec(`renderGeneration===${publication.generation}&&
            readingDisplay?.key===${JSON.stringify(publication.key)}&&readingDisplay.published===true&&
            viewer.querySelector('h1')?.textContent==='Beta'&&readingRenderCompletion===null`) &&
          publication.published === true);
        need("old pending mode completion does not move the successor viewport",
          JSON.stringify(await exec(offsets)) === JSON.stringify(geometry), { geometry, after: await exec(offsets) });
        need("pending " + pending + " completion preserves each document's exact disk authority",
          fs.readFileSync(files[0], "utf8") === (saving ? savedAlpha : baseline) &&
          fs.readFileSync(files[1], "utf8") === bodies[1]);
        await capture("mode-gate-" + image + "-beta-after");
        nativeObservations.push({ scenario, phase: "saved screenshot",
          file: "mode-gate-" + image + "-beta-after.png", viewed: false, state: await state() });
        await select(fixtureTab, "Alpha");
        await ready(savedAlpha);
        const returned = await state();
        need("retired pending mode exit cannot close or erase its original " + pending + " editor session",
          returned.edit && returned.dirty === !saving && returned.source === savedAlpha &&
          returned.original === (saving ? savedAlpha : baseline) && returned.value === savedAlpha &&
          returned.cached === savedAlpha && returned.saved === (saving ? savedAlpha : baseline) &&
          returned.undoRedo === alphaDraftState.undoRedo &&
          returned.start === alphaDraftState.start && returned.end === alphaDraftState.end &&
          returned.direction === alphaDraftState.direction, returned);
        await gateCapture(image + "-alpha-return", savedAlpha, true);
        if (saving) await exec("(async()=>{await changeCurrentDocumentEditor(false);return true;})()");
        else {
          await exitQuestion();
          await choice("proceed");
        }
        await ready(saving ? savedAlpha : baseline);
      } finally {
        await release();
        fs.promises.open = realOpen;
        try {
          if (leaving) await leaving;
        } finally {
          await wait("pending-owner write drains before fixture cleanup",
            `!hasPendingSaveFor(${JSON.stringify(files[0])})`);
          await exec("window.__modeGateRender?.restore();delete window.__modeGateRender;delete window.__modeGateExitSettled;true");
          await select(beta, "Beta");
          if (await exec("isEditMode&&hasUnsavedChanges")) {
            await exitQuestion();
            await choice("proceed");
          }
          await wait("pending-owner Beta cleanup restores its baseline",
            `!hasUnsavedChanges&&currentReloadSnapshot()===${JSON.stringify(bodies[1])}&&editorExitOperation===null`);
          await exec(`window.CustomTabs.closeTab(${beta})`);
          await select(fixtureTab, "Alpha");
        }
      }
    });
  } finally {
    win.webContents.removeListener("console-message", onConsole);
    try { await cleanupFixture(); }
    catch (error) {
      nativeUnsafe = true;
      recordError("final native cleanup exception", error);
    } finally {
      check("native mode group restores the exact original Alpha fixture bytes", fs.readFileSync(files[0]).equals(original));
    }
  }
}
async function run() {
  await wait("production renderer", "typeof window.CustomTabs?.getTabs==='function'");
  win.setSize(1440, 920);
  sentinel = startErrorSentinel(win, { label: "document-editor", trapExternal: false, screenshotDirectory: evidence });
  if (modeGate) {
    await open(0);
    try { await runNativeReadingModePositionCases(); }
    catch (error) {
      recordError("native shared setup exception", error);
      for (const entry of nativeScenarios.filter(value => value.status === "NOT RUN")) {
        entry.status = "BLOCKED";
        entry.reason = String(error?.stack || error);
      }
    }
    return finish();
  }
  if (!proof || proof === "commands") await noDocumentCommands();
  if (proof === "commands") return finish();
  const alpha = await open(0), beta = await open(1);
  await select(alpha, "Alpha");
  check("new documents begin in reading mode through the isolated production preload",
    await exec("!isEditMode&&!contentWrapper.classList.contains('split-view')&&window.require===undefined"));
  const toolbar = await exec("!!document.getElementById('openEditorBtn')");
  check("toolbar exposes an accessible current-document Open editor button",
    toolbar && await exec(`(() => {
      const b=document.getElementById('openEditorBtn');
      return b.tagName==='BUTTON'&&b.getAttribute('aria-controls')==='editorPanel'&&
        /open editor/i.test(b.getAttribute('aria-label')||b.title);
    })()`));
  win.setContentSize(100, 340);
  await wait("narrow toolbar layout", `Math.abs(innerWidth-${win.getContentSize()[0]})<=1`);
  await settle();
  const narrowToolbar = await exec(`(() => {
    const header=document.querySelector('.header'),style=getComputedStyle(header);
    const buttons=['refreshBtn','openEditorBtn','menuBtn'].map(id=>{
      const b=document.getElementById(id),r=b?.getBoundingClientRect();
      const hit=r&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      return {id,left:r?.left,right:r?.right,top:r?.top,width:r?.width,
        reachable:!!(b&&hit&&b.contains(hit))};
    });
    return {width:innerWidth,available:header.clientWidth-parseFloat(style.paddingLeft)-
      parseFloat(style.paddingRight),required:buttons.reduce((n,b)=>n+(b.width||0),0)+
      parseFloat(style.columnGap)*2,buttons};
  })()`);
  check("narrow toolbar probe really needs more space than a single button row",
    narrowToolbar.required > narrowToolbar.available, narrowToolbar);
  check("narrow toolbar keeps Reload Open editor and the menu visible and hit-testable",
    narrowToolbar.buttons.every(button => button.width > 0 && button.left >= 0 &&
      button.right <= narrowToolbar.width + 1 && button.reachable), narrowToolbar);
  await capture("narrow-current-document-toolbar");
  win.setSize(1440, 920);
  await wait("normal toolbar layout", `Math.abs(innerWidth-${win.getContentSize()[0]})<=1`);
  await settle();
  if (proof === "toolbar") return finish();
  await exec("document.getElementById('toggleEdit').click();true");
  await wait("Alpha editor", "isEditMode&&contentWrapper.classList.contains('split-view')");
  const alphaText = bodies[0] + "\n\nUnsaved witness Alpha.\n";
  await input(alphaText, 12, 29);
  let alphaState = await snapshot();
  await exec("document.getElementById('toggleEdit').click();true");
  await settle();
  check("menu only opens the current editor and repeated activation preserves its exact draft",
    !await exec("document.getElementById('appMessageDialog')?.open") &&
    JSON.stringify(await snapshot()) === JSON.stringify(alphaState));
  if (await exec("document.getElementById('appMessageDialog')?.open")) await choice("cancel");
  await select(beta, "Beta");
  check("switching to an unopened editor keeps that document in reading mode",
    await exec(`!isEditMode&&!contentWrapper.classList.contains('split-view')&&
      currentReloadSnapshot()===${JSON.stringify(bodies[1])}&&!viewer.textContent.includes('Unsaved witness Alpha')`));
  if (proof === "modes") return finish();
  await exec("document.getElementById('openEditorBtn')?.click();true");
  if (!toolbar) await exec("if(!isEditMode)document.getElementById('toggleEdit').click();true");
  await wait("Beta editor", "isEditMode");
  const betaText = bodies[1] + "\n\nUnsaved witness Beta.\n";
  await input(betaText, 7, 19);
  const betaState = await snapshot();
  await exec("document.getElementById('openEditorBtn')?.click();true");
  await settle();
  check("toolbar only opens the current editor without resetting text selection undo or dirty state",
    toolbar && JSON.stringify(await snapshot()) === JSON.stringify(betaState) &&
    !await exec("document.getElementById('appMessageDialog')?.open"));
  if (!proof || proof === "noop") await repeatedEditorNoop();
  if (proof === "noop") return finish();
  await select(alpha, "Alpha");
  check("returning to Alpha restores its own open editor draft selection and undo",
    JSON.stringify(await snapshot()) === JSON.stringify(alphaState), await snapshot());
  check("both edited documents remain protected instead of forcing one editor closed",
    await exec(`window.CustomTabs.getTabs().filter(t=>[${alpha},${beta}].includes(t.id)).every(t=>t.hasUnsavedChanges)&&
      viewer.textContent.includes('Unsaved witness Alpha')&&!viewer.textContent.includes('Unsaved witness Beta')`));
  const refusal = await exec(`(() => {
    const before={baseline:JSON.stringify(editSessionBaseline),sequence:fileOpenSequence,
      modeRevision:editorModeRevision,render:renderGeneration,tab:window.CustomTabs.getActiveTabId()};
    const result=beginFileOpen({path:${JSON.stringify(files[1])},content:${JSON.stringify(betaText)}},
      {ownerTabId:Number.MAX_SAFE_INTEGER,source:'document-editor-refused-owner'});
    return {refused:result===null,before,after:{baseline:JSON.stringify(editSessionBaseline),
      sequence:fileOpenSequence,modeRevision:editorModeRevision,render:renderGeneration,
      tab:window.CustomTabs.getActiveTabId()}};
  })()`);
  await settle();
  check("refused admission preserves the dirty owning editor selection history and discard checkpoint",
    refusal.refused && JSON.stringify(refusal.before) === JSON.stringify(refusal.after) &&
    JSON.stringify(await snapshot()) === JSON.stringify(alphaState) &&
    await exec("!refreshBtn.disabled&&!openEditorBtn.disabled"), refusal);
  if (proof === "admission") return finish();
  if (proof === "baseline") {
    await exitQuestion();
    await choice("proceed");
    await wait("baseline discard renders", `!isEditMode&&currentReloadSnapshot()===${JSON.stringify(bodies[0])}`);
    check("discard restores the owning document's clean flag rather than the other tab's dirty flag",
      await exec("!hasUnsavedChanges"));
    check("undo cannot resurrect edits discarded after returning to their owning document",
      await exec(`!historySnapshot().undo.concat(historySnapshot().redo).some(entry=>(typeof entry==='string'?entry:entry.source)===${JSON.stringify(alphaText)})`));
    return finish();
  }
  await capture("alpha-editor-restored");
  await select(beta, "Beta");
  check("returning to Beta restores its different open editor draft selection and undo",
    JSON.stringify(await snapshot()) === JSON.stringify(betaState), await snapshot());
  if (!proof) {
    await exec("markdownEditor.style.whiteSpace='pre';true");
    const positions = {};
    for (const [id, name, top, left] of [[alpha, "Alpha", 1300, 45], [beta, "Beta", 2500, 110]]) {
      await select(id, name);
      await exec(`markdownEditor.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
        markdownEditor.scrollTop=${top};markdownEditor.scrollLeft=${left};true`);
      await settle();
      positions[name] = await exec("({top:markdownEditor.scrollTop,left:markdownEditor.scrollLeft})");
    }
    check("independent editor scroll probe really parks different overflowing vertical and horizontal positions",
      positions.Alpha.top > 500 && positions.Beta.top > positions.Alpha.top + 500 &&
      positions.Alpha.left > 10 && positions.Beta.left > positions.Alpha.left + 30, positions);
    const restored = [];
    for (const [id, name] of [[alpha, "Alpha"], [beta, "Beta"], [alpha, "Alpha"], [beta, "Beta"]]) {
      await select(id, name);
      await sleep(900);
      restored.push({ name, top: await exec("markdownEditor.scrollTop"), left: await exec("markdownEditor.scrollLeft") });
    }
    check("tab switches and late rendering retain each editor's separate vertical and horizontal scroll",
      restored.every(value => Math.abs(value.top - positions[value.name].top) <= 1 &&
        Math.abs(value.left - positions[value.name].left) <= 1), { positions, restored });
    await exec("markdownEditor.style.whiteSpace='';true");
    await settle();
  }
  if (proof === "sessions") return finish();
  await select(alpha, "Alpha");
  const rapidAlpha = alphaText + "\n\nUnsaved witness rapid Alpha switch.\n";
  const deferredSetup = await exec(`(async () => {
    markdownEditor.value=${JSON.stringify(rapidAlpha)};
    markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));
    const scheduled=previewDebounceTimer!==null&&historyDebounceTimer!==null;
    window.CustomTabs.switchToTab(${beta});
    for(let frame=0;frame<120;frame++){
      if(viewer.querySelector('h1')?.textContent==='Beta'&&
        !loadingScreen.classList.contains('active'))break;
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
    return {scheduled,generation:renderGeneration,heading:viewer.querySelector('h1')?.textContent};
  })()`);
  check("rapid switch starts with both editor timers pending and admits the other document",
    deferredSetup.scheduled && deferredSetup.heading === "Beta", deferredSetup);
  await sleep(950);
  await settle();
  check("pending editor callbacks cannot re-render or change the newly selected document",
    JSON.stringify(await snapshot()) === JSON.stringify(betaState) &&
    await exec(`renderGeneration===${deferredSetup.generation}&&!viewer.textContent.includes('rapid Alpha switch')`));
  await select(alpha, "Alpha");
  check("returning restores the owning draft and its pending history without a cross-tab undo entry",
    await exec(`markdownEditor.value===${JSON.stringify(rapidAlpha)}&&
      (typeof historySnapshot().undo.at(-1)==='string'?historySnapshot().undo.at(-1):historySnapshot().undo.at(-1)?.source)===${JSON.stringify(alphaText)}&&
      !JSON.stringify(historySnapshot()).includes('Unsaved witness Beta')`));
  if (proof === "deferred") return finish();
  await exec("historyUndo();true");
  await wait("real restored Undo", `markdownEditor.value===${JSON.stringify(alphaText)}`);
  await exec("historyRedo();true");
  await wait("real restored Redo", `markdownEditor.value===${JSON.stringify(rapidAlpha)}`);
  check("restored per-document history performs real Undo and Redo on the owning source",
    await exec(`markdownEditor.value===${JSON.stringify(rapidAlpha)}&&hasUnsavedChanges&&isEditMode`));
  alphaState = await snapshot();
  await select(beta, "Beta");
  await exitQuestion();
  await choice("cancel");
  check("cancelling explicit editor exit keeps this document and its draft intact",
    JSON.stringify(await snapshot()) === JSON.stringify(betaState));
  await exitQuestion();
  await select(alpha, "Alpha");
  await wait("stale exit question retires", "!document.getElementById('appMessageDialog')?.open");
  check("an exit question cannot close a different document after tab selection changes",
    JSON.stringify(await snapshot()) === JSON.stringify(alphaState));
  await select(beta, "Beta");
  check("the original editor stays open when its exit question becomes stale",
    JSON.stringify(await snapshot()) === JSON.stringify(betaState));
  await exec("document.getElementById('saveButton').click();true");
  await wait("Beta save", "!hasPendingSaveFor(currentFilePath)&&!hasUnsavedChanges");
  check("saving the current editor writes only its own document",
    fs.readFileSync(files[1], "utf8") === betaText && fs.readFileSync(files[0], "utf8") === bodies[0]);
  await exec("document.getElementById('exitEditBtn').click();true");
  await wait("clean Beta editor exit", "!isEditMode&&!contentWrapper.classList.contains('split-view')");
  await select(alpha, "Alpha");
  check("closing Beta's editor does not close or reset Alpha's unsaved editor",
    JSON.stringify(await snapshot()) === JSON.stringify(alphaState));
  await exitQuestion();
  await choice("proceed");
  await wait("Alpha discard", "!isEditMode&&!hasUnsavedChanges&&currentReloadSnapshot()===" + JSON.stringify(bodies[0]));
  check("explicit discard restores only Alpha and leaves Beta's saved document intact",
    fs.readFileSync(files[0], "utf8") === bodies[0] && fs.readFileSync(files[1], "utf8") === betaText &&
    await exec(`!viewer.textContent.includes('Unsaved witness')&&originalMarkdown===${JSON.stringify(bodies[0])}`));
  await select(beta, "Beta");
  check("a document explicitly left in reading mode remains closed on return",
    await exec("!isEditMode&&!contentWrapper.classList.contains('split-view')"));
  await select(alpha, "Alpha");
  await exec("document.getElementById('openEditorBtn').click();true");
  let savedAlpha = bodies[0] + "\n\nUnsaved witness sent in Alpha Save.\n";
  await input(savedAlpha, 9, 17);
  const realOpen = fs.promises.open;
  let release, held = false;
  let gate = new Promise(resolve => { release = resolve; });
  fs.promises.open = async function (...args) {
    const handle = await realOpen.apply(this, args);
    if (!held && path.resolve(String(args[0])) === files[0] && args[1] === "r+") {
      held = true;
      await gate;
    }
    return handle;
  };
  let newerAlpha = savedAlpha + "\n\nUnsaved witness newer than Alpha Save.\n";
  try {
    await exec("document.getElementById('saveButton').click();true");
    const deadline = Date.now() + 5000;
    while (!held && Date.now() < deadline) await sleep(15);
    check("late Save setup holds a real admitted write before it touches the disposable file",
      held && fs.readFileSync(files[0], "utf8") === bodies[0] &&
      await exec("hasPendingSaveFor(currentFilePath)"));
    if (!held) throw new Error("The real Save did not reach its held write handle");
    await input(newerAlpha, 14, 31);
    release();
    await wait("foreground Alpha Save settles", "!hasPendingSaveFor(currentFilePath)");
    check("foreground Save keeps the renderer baseline on the bytes actually written",
      await exec(`originalMarkdown===${JSON.stringify(savedAlpha)}`));
    check("foreground Save still reports newer editor keystrokes as unsaved",
      await exec("hasUnsavedChanges"));
    check("foreground Save keeps the newer tab source and the independently saved disk baseline",
      fs.readFileSync(files[0], "utf8") === savedAlpha && fs.readFileSync(files[1], "utf8") === betaText &&
      await exec(`window.CustomTabs.getActiveTab().content===${JSON.stringify(newerAlpha)}&&
        window.CustomTabs.getActiveTab().originalContent===${JSON.stringify(savedAlpha)}`));
    if (proof === "visible-save") return finish();
    const earlierSave = savedAlpha;
    savedAlpha = newerAlpha;
    newerAlpha += "\n\nUnsaved witness newer than the background Alpha Save.\n";
    held = false;
    gate = new Promise(resolve => { release = resolve; });
    await exec("document.getElementById('saveButton').click();true");
    const backgroundDeadline = Date.now() + 5000;
    while (!held && Date.now() < backgroundDeadline) await sleep(15);
    check("background Save setup holds another real write with a different dispatch checkpoint",
      held && fs.readFileSync(files[0], "utf8") === earlierSave &&
      await exec("hasPendingSaveFor(currentFilePath)"));
    if (!held) throw new Error("The background Save did not reach its held write handle");
    await input(newerAlpha, 14, 31);
    await exec("document.getElementById('exitEditBtn').click();true");
    await sleep(5300);
    check("an unresolved Save timeout keeps the editor open without offering discard",
      await exec(`isEditMode&&hasPendingSaveFor(currentFilePath)&&
        markdownEditor.value===${JSON.stringify(newerAlpha)}&&!document.getElementById('appMessageDialog')?.open`));
    await exec("document.getElementById('exitEditBtn').click();true");
    await select(beta, "Beta");
    release();
    await wait("background Alpha Save settles", `!hasPendingSaveFor(${JSON.stringify(files[0])})`);
    await settle();
    check("an Exit awaiting Alpha Save cannot open or close Beta after switching tabs",
      await exec(`!isEditMode&&currentReloadSnapshot()===${JSON.stringify(betaText)}&&!hasUnsavedChanges&&
        !document.getElementById('appMessageDialog')?.open`));
    await select(alpha, "Alpha");
    check("background Save preserves the newer owning draft and its open editor",
      fs.readFileSync(files[0], "utf8") === savedAlpha &&
      await exec(`isEditMode&&hasUnsavedChanges&&markdownEditor.value===${JSON.stringify(newerAlpha)}`));
    await exitQuestion();
    await choice("proceed");
    await wait("saved Alpha checkpoint restored", "!isEditMode&&!loadingScreen.classList.contains('active')");
    check("discard after a background Save restores saved bytes and its history checkpoint",
      await exec(`!hasUnsavedChanges&&originalMarkdown===${JSON.stringify(savedAlpha)}&&
        !JSON.stringify(historySnapshot()).includes('newer than the background Alpha Save')`));
  } finally {
    release();
    fs.promises.open = realOpen;
  }
  if (proof === "save") return finish();
  await exec("document.getElementById('openEditorBtn').click();true");
  await select(beta, "Beta");
  const freshAlpha = bodies[0] + "\n\nFresh disk replacement for Alpha.\n";
  fs.writeFileSync(files[0], freshAlpha);
  await select(alpha, "Alpha");
  await wait("fresh Alpha disk source", `markdownEditor.value===${JSON.stringify(freshAlpha)}`);
  check("clean disk replacement retains only that document's editor intent and retires old undo",
    await exec(`isEditMode&&!hasUnsavedChanges&&historySnapshot().undo.length===0&&historySnapshot().redo.length===0`));
  await input(freshAlpha + "\n\nUnsaved witness after replacement.\n", 5, 13);
  await exitQuestion();
  await choice("proceed");
  await wait("replacement discard baseline", "!isEditMode&&!loadingScreen.classList.contains('active')");
  check("discard after disk replacement cannot resurrect an earlier document version",
    await exec(`!hasUnsavedChanges&&!viewer.textContent.includes('Unsaved witness')&&
      currentReloadSnapshot()===${JSON.stringify(freshAlpha)}`) &&
    fs.readFileSync(files[0], "utf8") === freshAlpha);
  if (proof === "reload") return finish();
  await exec("document.getElementById('openEditorBtn').click();true");
  await input(freshAlpha + "\n\nUnsaved witness transient preview.\n", 4, 9);
  const cleanExitSetup = await exec(`(() => {
    markdownEditor.value=${JSON.stringify(freshAlpha)};
    markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));
    const setup={clean:!hasUnsavedChanges,pending:previewDebounceTimer!==null,
      intermediate:viewer.textContent.includes('Unsaved witness transient preview')};
    document.getElementById('exitEditBtn').click();
    return setup;
  })()`);
  check("clean exit probe really has a clean buffer and a stale pending preview",
    cleanExitSetup.clean && cleanExitSetup.pending && cleanExitSetup.intermediate, cleanExitSetup);
  await wait("clean exit render", "!isEditMode&&!loadingScreen.classList.contains('active')");
  await settle();
  check("clean editor exit flushes the final source instead of leaving the intermediate preview",
    await exec(`currentReloadSnapshot()===${JSON.stringify(freshAlpha)}&&
      !viewer.textContent.includes('Unsaved witness transient preview')`));
  if (proof === "clean-exit") return finish();
  await select(beta, "Beta");
  await select(alpha, "Alpha");
  await exec("document.getElementById('openEditorBtn').click();true");
  await input(freshAlpha + "\n\nUnsaved witness first discarded session.\n", 4, 9);
  await exec(`(() => {
    const render=renderMarkdown;
    let release;
    const gate=new Promise(resolve=>release=resolve);
    let held=false;
    window.__editorExitGate={release,restore:()=>renderMarkdown=render,held:false};
    renderMarkdown=function(...args){
      const result=render(...args);
      if(!held&&args[0]===${JSON.stringify(freshAlpha)}){
        held=true;window.__editorExitGate.held=true;
        return Promise.all([result,gate]).then(values=>values[0]);
      }
      return result;
    };
  })()`);
  try {
    await exitQuestion();
    await choice("proceed");
    check("reopen race holds a real discard render after the editor closes",
      await exec("window.__editorExitGate.held&&!isEditMode&&editorExitOperation!==null"));
    await exec("document.getElementById('openEditorBtn').click();true");
    const reopenedBaseline = await exec(`isEditMode&&
      editSessionBaseline?.document===${JSON.stringify(freshAlpha)}`);
    check("reopening during discard establishes a separate live session baseline", reopenedBaseline);
    await exec("window.__editorExitGate.release();true");
    await wait("older Exit completes", "editorExitOperation===null");
    check("an older Exit completion cannot clear the reopened editor's baseline",
      await exec(`isEditMode&&editSessionBaseline?.document===${JSON.stringify(freshAlpha)}`));
    const secondDraft = freshAlpha + "\n\nUnsaved witness second discarded session.\n";
    await input(secondDraft, 4, 9);
    await exitQuestion();
    await choice("proceed");
    await wait("second discard", `!isEditMode&&currentReloadSnapshot()===${JSON.stringify(freshAlpha)}`);
    check("discard after an older Exit completes restores the new session's undo checkpoint",
      await exec(`!historySnapshot().undo.concat(historySnapshot().redo).some(entry=>(typeof entry==='string'?entry:entry.source)===${JSON.stringify(secondDraft)})&&!hasUnsavedChanges`));
  } finally {
    await exec("window.__editorExitGate.release();window.__editorExitGate.restore();delete window.__editorExitGate;true");
  }
  if (proof === "reopen-exit") return finish();
  await select(beta, "Beta");
  await exec("document.getElementById('openEditorBtn')?.click();true");
  await wait("reopened Beta editor", "isEditMode");
  await capture("beta-current-editor");
  await exec("document.getElementById('exitEditBtn').click();true");
  await wait("Beta closed before removing its tab", "!isEditMode");
  await exec(`window.CustomTabs.closeTab(${beta})`);
  const reopened = await open(1);
  check("closing and reopening a document does not inherit a retired tab's edit session",
    reopened !== beta && await exec("!isEditMode&&!hasUnsavedChanges"));
  await exec(`window.CustomTabs.closeTab(${reopened})`);
  await select(alpha, "Alpha");
  await exec("document.getElementById('openEditorBtn').click();true");
  await exec(`window.CustomTabs.closeTab(${alpha})`);
  await wait("last tab Welcome", "window.CustomTabs.getTabs().length===0&&!!viewer.querySelector('.welcome')");
  check("closing the last editor clears its source history mode and Open controls over Welcome",
    await exec(`!isEditMode&&markdownEditor.value===''&&originalMarkdown===''&&
      historySnapshot().undo.length===0&&historySnapshot().redo.length===0&&
      document.getElementById('openEditorBtn').disabled&&document.getElementById('toggleEdit').disabled`));
  const freshTab = await open(0);
  check("reopening after Welcome starts a new reading session rather than reviving the closed editor",
    freshTab !== alpha && await exec("!isEditMode&&!hasUnsavedChanges"));
  if (!proof) {
    try { await runNativeReadingModePositionCases(); }
    catch (error) {
      recordError("native shared setup exception", error);
      for (const entry of nativeScenarios.filter(value => value.status === "NOT RUN")) {
        entry.status = "BLOCKED";
        entry.reason = String(error?.stack || error);
      }
    }
  }
  await finish();
}
app.whenReady().then(async () => {
  await sleep(1600);
  win = BrowserWindow.getAllWindows()[0];
  // Frame-based assertions must not depend on desktop window occlusion.
  win.webContents.setBackgroundThrottling(false);
  try { await run(); }
  catch (error) {
    check("document editor harness reaches completion", false, String(error?.stack || error));
    recordError("shared editor sequence exception", error);
    nativeUnsafe = true;
  }
  if (!finalChecksAttempted) await finish();
  const nativeComplete = nativeScenarios.every(entry => entry.status === "PASS" || entry.status === "FAIL");
  const complete = modeGate ? nativeComplete : !!proof || (results.length === 198 && nativeComplete);
  const passed = complete && failures.length === 0 && results.every(result => result.ok) &&
    (!modeGate || nativeScenarios.every(entry => entry.status === "PASS"));
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify({
    product, platform: process.platform, arch: process.arch, versions: process.versions, proof, results,
    failures, nativeScenarios, nativeObservations, sentinelReport, complete, passed, requiredFullCount: 198,
  }, null, 2));
  // Keep the process alive until destruction diagnostics precede the terminal footer.
  const keepalive = new BrowserWindow({ show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await new Promise(resolve => { win.webContents.once("destroyed", resolve); win.destroy(); });
  await new Promise(resolve => setImmediate(resolve));
  console.log(`=== ${results.filter(result => result.ok).length}/${results.length} passed ===`);
  if (!passed) console.log("Document editor OVERALL FAIL: exceptions, failed assertions or blocked/missing required coverage remain.");
  app.exit(passed ? 0 : 1);
});
setTimeout(() => { console.error("Document editor watchdog expired"); app.exit(2); }, 90000);
