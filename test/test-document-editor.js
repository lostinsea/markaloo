"use strict";
const { app, BrowserWindow, dialog, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("./test-userdata-isolation");
const { startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");
const directory = path.resolve(__dirname, "..", "tmp", "document-editor");
const evidence = path.resolve(process.env.MARKALOO_EDITOR_EVIDENCE || directory);
fs.mkdirSync(directory, { recursive: true });
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
let chosen = files[0], win, sentinel;
const results = [];
const proof = process.env.MARKALOO_EDITOR_PROOF;
if (proof && !["toolbar", "modes", "sessions", "baseline", "admission", "deferred", "visible-save", "save", "reload", "clean-exit", "reopen-exit", "lastclose"].includes(proof)) {
  console.error("Unsupported document-editor proof route: " + proof);
  app.exit(2);
}
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
shell.openExternal = async () => { throw new Error("Editor suite must not open external applications"); };
shell.openPath = async () => { throw new Error("Editor suite must not open external applications"); };
require("../src/main.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = code => win.webContents.executeJavaScript(code, true);
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
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
async function finish() {
  check("document editor product source remains unchanged throughout the run",
    JSON.stringify(hashes()) === JSON.stringify(product));
  const alive = await proveSentinelAlive(win, sentinel);
  check("document editor error sentinel proves both channels are live", alive.console && alive.dom, alive);
  const errors = await sentinel.stop();
  check("document editor scenarios introduce no renderer or visible document errors", errors.hits.length === 0, errors.hits);
}
async function run() {
  await wait("production renderer", "typeof window.CustomTabs?.getTabs==='function'");
  win.setSize(1440, 920);
  sentinel = startErrorSentinel(win, { label: "document-editor" });
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
    JSON.stringify(await snapshot()) === JSON.stringify(alphaState), refusal);
  if (proof === "admission") return finish();
  if (proof === "baseline") {
    await exitQuestion();
    await choice("proceed");
    await wait("baseline discard renders", `!isEditMode&&currentReloadSnapshot()===${JSON.stringify(bodies[0])}`);
    check("discard restores the owning document's clean flag rather than the other tab's dirty flag",
      await exec("!hasUnsavedChanges"));
    check("undo cannot resurrect edits discarded after returning to their owning document",
      await exec(`!historySnapshot().undo.includes(${JSON.stringify(alphaText)})`));
    return finish();
  }
  await capture("alpha-editor-restored");
  await select(beta, "Beta");
  check("returning to Beta restores its different open editor draft selection and undo",
    JSON.stringify(await snapshot()) === JSON.stringify(betaState), await snapshot());
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
      historySnapshot().undo.at(-1)===${JSON.stringify(rapidAlpha)}&&
      !JSON.stringify(historySnapshot()).includes('Unsaved witness Beta')`));
  if (proof === "deferred") return finish();
  await exec("historyUndo();historyUndo();true");
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
      await exec(`!historySnapshot().undo.includes(${JSON.stringify(secondDraft)})&&!hasUnsavedChanges`));
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
  await finish();
}
app.whenReady().then(async () => {
  await sleep(1600);
  win = BrowserWindow.getAllWindows()[0];
  // Frame-based assertions must not depend on desktop window occlusion.
  win.webContents.setBackgroundThrottling(false);
  try { await run(); }
  catch (error) { check("document editor harness reaches completion", false, String(error.stack || error)); }
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify({
    product, platform: process.platform, arch: process.arch, versions: process.versions, proof, results,
  }, null, 2));
  console.log(`=== ${results.filter(result => result.ok).length}/${results.length} passed ===`);
  win.destroy();
  app.exit(results.every(result => result.ok) ? 0 : 1);
});
setTimeout(() => { console.error("Document editor watchdog expired"); app.exit(2); }, 90000);
