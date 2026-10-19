"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const root = path.resolve(__dirname, "..");
const batch = process.env.MARKALOO_RELOAD_EVIDENCE ||
  path.join(root, "tmp", "reload-dialog-" + randomUUID());
fs.mkdirSync(batch, { recursive: true });
const originalTmpdir = os.tmpdir;
os.tmpdir = () => path.join(batch, "isolation");
require("./test-userdata-isolation");
os.tmpdir = originalTmpdir;
const { app, BrowserWindow, dialog } = require("electron");
const fixtures = path.join(batch, "fixtures");
fs.mkdirSync(fixtures, { recursive: true });
let chosen;
const nativeQuestions = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
dialog.showMessageBoxSync = (_window, options) => {
  nativeQuestions.push(options);
  return options.cancelId ?? 1;
};
require("../src/main.js");
const { startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const rendererMessages = [];
const exec = code => win.webContents.executeJavaScript(code);
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}
async function wait(label, expression, required = true) {
  for (let i = 0; i < 200; i++) {
    if (await exec(expression)) return true;
    await sleep(40);
  }
  if (required) throw new Error("Timed out: " + label);
  return false;
}
async function settle() {
  await sleep(150);
  await exec("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
}
async function capture(name) {
  await settle();
  fs.writeFileSync(path.join(batch, name + ".png"), (await win.webContents.capturePage()).toPNG());
}
async function open(name, body) {
  chosen = path.join(fixtures, name);
  fs.writeFileSync(chosen, body);
  await exec(`document.getElementById('openFile').click();
    if(document.getElementById('appMessageDialog')?.open &&
        document.getElementById('appMessageTitle').textContent==='Discard unsaved changes?'){
      document.querySelector('#appMessageDialog [data-dialog-choice="proceed"]').click();
    }true`);
  await wait("admitted " + name, `currentFilePath===${JSON.stringify(chosen)}&&
    originalMarkdown===${JSON.stringify(body)}&&viewer.querySelector('h1')?.textContent===${JSON.stringify(body.split("\n")[0].slice(2))}&&
    !loadingScreen.classList.contains('active')`);
  await settle();
  return chosen;
}
const stateExpression = `(()=>{
  const tab=window.CustomTabs.getActiveTab();
  return {id:tab?.id,content:tab?.content,original:tab?.originalContent,
    dirty:tab?.hasUnsavedChanges,live:currentReloadSnapshot(),
    viewer:viewer.textContent,open:document.getElementById('reloadDocumentDialog')?.open,
    focused:document.activeElement?.id};
})()`;
async function deletionState() {
  return exec(`(()=>{
    const tab=window.CustomTabs.getActiveTab();
    const owner=window.CustomTabs.getDocumentIdentityForTab(tab.id,tab.filePath,window.getReloadRequestSession());
    return window.folia.queryDocumentDeletionState({...owner,filePath:tab.filePath});
  })()`);
}
async function recreate(file, body) {
  fs.unlinkSync(file);
  const missing = await deletionState();
  if (missing?.known !== true || missing.ownDeletion !== true) {
    throw new Error("Missing-file setup did not retain real deletion evidence: " + JSON.stringify(missing));
  }
  fs.writeFileSync(file, body);
  return missing;
}
async function prompt() {
  await exec("showFileUpdateNotification();document.getElementById('reloadFileBtn').focus();document.getElementById('reloadFileBtn').click();true");
  await wait("themed reload confirmation", "document.getElementById('reloadDocumentDialog')?.open===true");
  return exec(`({
    title:document.getElementById('reloadDocumentTitle').textContent,
    reason:document.getElementById('reloadDocumentReason').textContent,
    name:document.getElementById('reloadDocumentName').textContent,
    focused:document.activeElement?.id
  })`);
}
async function cancel(button = "reloadDocumentCancel") {
  await exec(`document.getElementById(${JSON.stringify(button)}).click();true`);
  await wait("dialog closed", "!document.getElementById('reloadDocumentDialog').open");
  await settle();
}
async function accept(body) {
  await exec("document.getElementById('reloadDocumentConfirm').click();true");
  await wait("approved disk document painted", `originalMarkdown===${JSON.stringify(body)}&&
    viewer.textContent.includes(${JSON.stringify(body.trim().split("\n").at(-1))})&&
    window.CustomTabs.getActiveTab()?.content===${JSON.stringify(body)}`);
  await settle();
}
async function edit(body) {
  await exec(`if(!isEditMode)document.getElementById('toggleEdit').click();
    markdownEditor.value=${JSON.stringify(body)};
    markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true`);
  await wait("genuine unsaved edit", `hasUnsavedChanges&&currentReloadSnapshot()===${JSON.stringify(body)}`);
}
async function checkPreDialogSnapshot() {
  const body = "# Pre-dialog check\n\nEarlier content.\n";
  const file = await open("pre-dialog-check.md", body);
  await recreate(file, "# Pre-dialog check\n\nRecreated content.\n");
  const prepare = () => exec(`(async()=>{
    const tab=window.CustomTabs.getActiveTab();
    const owner=window.CustomTabs.getDocumentIdentityForTab(tab.id,tab.filePath,window.getReloadRequestSession());
    const snapshot=await window.folia.readOwnedTabDiskSnapshot({
      filePath:tab.filePath,pageSession:owner.pageSession,
      rendererGeneration:owner.rendererGeneration,owner,
    });
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(snapshot.content));
    const request={...owner,filePath:tab.filePath,ownerFilePath:tab.filePath,
      oldOwner:owner,proposedOwner:owner,replaceDocument:false,
      contentDigest:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join(''),
      modifiedTime:snapshot.modifiedTime,diskVersion:snapshot.diskVersion};
    const state=await window.folia.prepareDocumentDiskAdoption(request);
    return {state,request:{...request,capability:state.capability,revision:state.revision}};
  })()`);
  const prepared = await prepare();
  check("SEC-08 pre-dialog check setup retains actual deletion evidence and attests the restored file",
    prepared.state.known && prepared.state.ownDeletion && prepared.state.versionMatches, prepared.state);
  const asked = await exec(`window.folia.commitDocumentDiskAdoption(${JSON.stringify(prepared.request)})`);
  const positive = asked.confirmation && await exec(`window.folia.respondToDocumentReplacementConsent(${JSON.stringify({
    id: asked.confirmation.id, pageSession: asked.confirmation.pageSession,
    rendererGeneration: asked.confirmation.rendererGeneration, approved: true,
  })})`);
  check("SEC-08 pre-dialog positive control reaches the actual replacement confirmation",
    asked.why === "confirmation-required" && asked.confirmation?.reason === "file-reappeared" &&
    positive?.accepted && positive.confirmed, { asked, positive });
  const capability = { capability: prepared.state.capability,
    pageSession: prepared.request.pageSession, rendererGeneration: prepared.request.rendererGeneration };
  fs.writeFileSync(file, "# Pre-dialog check\n\nChanged after approval.\n");
  const late = await exec(`window.folia.checkCommittedDiskAdoption(${JSON.stringify(capability)})`);
  check("SEC-08 committed check refuses real disk changes after approval",
    late.valid === false && late.why === "disk-version-or-target-moved", late);
  await exec(`window.folia.abandonDocumentDiskAdoption(${JSON.stringify(capability)});true`);
  const stale = await prepare();
  fs.writeFileSync(file, "# Pre-dialog check\n\nChanged before the question.\n");
  const refused = await exec(`window.folia.commitDocumentDiskAdoption(${JSON.stringify(stale.request)})`);
  check("SEC-08 Main refuses a stale prepared snapshot before asking replacement consent",
    refused.accepted === false && refused.why === "disk-version-or-target-moved" &&
    !Object.hasOwn(refused, "confirmation"), refused);
  if (refused.confirmation) {
    await exec(`window.folia.respondToDocumentReplacementConsent(${JSON.stringify({
      id: refused.confirmation.id, pageSession: refused.confirmation.pageSession,
      rendererGeneration: refused.confirmation.rendererGeneration, approved: false,
    })})`);
  }
}
async function run() {
  check("reload dialog production bridge remains isolated and frozen",
    await exec("typeof require==='undefined'&&typeof process==='undefined'&&Object.isFrozen(window.folia)"));
  const sentinel = startErrorSentinel(win, { label: "reload-dialog" });
  await exec(`window.__reloadConfirmations=[];
    const showReplacement=window.CustomTabs.confirmDocumentReplacement;
    window.CustomTabs.confirmDocumentReplacement=request=>{
      window.__reloadConfirmations.push(request);return showReplacement(request);
    };true`);
  const alive = await proveSentinelAlive(win, sentinel);
  check("reload dialog error sentinel proves both channels alive", alive.console && alive.dom, alive);
  const original = "# Reload example\n\nOriginal document.\n";
  const updated = "# Reload example\n\nRecreated document.\n";
  const file = await open("reload-example.md", original);
  const times = [];
  for (let i = 0; i < 9; i++) {
    const body = "# Reload example\n\nOrdinary update " + i + ".\n";
    fs.writeFileSync(file, body);
    const start = performance.now();
    await exec("window.CustomTabs.requestReloadWithConfirmation();true");
    await wait("ordinary reload", `originalMarkdown===${JSON.stringify(body)}&&viewer.textContent.includes(${JSON.stringify("Ordinary update " + i + ".")})`);
    times.push(performance.now() - start);
    await settle();
  }
  fs.writeFileSync(path.join(batch, "ordinary-reload-times.json"), JSON.stringify(times, null, 2));
  check("ordinary external writes reload without a replacement question",
    nativeQuestions.length === 0 && !await exec("document.getElementById('reloadDocumentDialog')?.open"));
  const before = await exec(stateExpression);
  await recreate(file, updated);
  const text = await prompt();
  check("known disappearance uses truthful plain English without an unsaved-edit claim",
    text.title === "Reload document?" &&
    text.reason === "The file disappeared and later reappeared with the same name. Are you sure you want to reload it?" &&
    !/in.memory|unresolved|file target|unsaved|owner/i.test(text.reason), text);
  check("reload dialog starts on Cancel and labels its document and reason",
    text.focused === "reloadDocumentCancel" &&
    await exec(`(()=>{
      const d=document.getElementById('reloadDocumentDialog');
      return d.ariaLabelledByElements?.includes(document.getElementById('reloadDocumentTitle'))&&
        d.ariaDescribedByElements?.includes(document.getElementById('reloadDocumentReason'))&&
        document.getElementById('reloadDocumentConfirm').textContent.trim()==='Reload from disk';
    })()`), text);
  const focusCycle = [];
  for (let i = 0; i < 4; i++) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await sleep(30);
    focusCycle.push(await exec("document.activeElement?.id"));
  }
  const shortcut = await exec(`(()=>{
    const before=window.getLatestReloadRequestSequence(currentFilePath);
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'r',ctrlKey:true,bubbles:true,cancelable:true}));
    return before===window.getLatestReloadRequestSequence(currentFilePath);
  })()`);
  check("reload dialog contains real Tab focus and blocks underlying reload shortcuts",
    focusCycle.every(id => ["reloadDocumentClose", "reloadDocumentCancel", "reloadDocumentConfirm"].includes(id)) &&
    new Set(focusCycle).size === 3 && shortcut, focusCycle);
  for (const dark of [false, true]) {
    await exec(`if(document.body.classList.contains('dark-mode')!==${dark})document.getElementById('darkModeToggle').click();true`);
    win.setMinimumSize(400, 400);
    win.setSize(1100, 780);
    await capture(dark ? "reload-dark" : "reload-light");
    win.setSize(520, 620);
    win.webContents.setZoomFactor(1.5);
    await settle();
    const bounds = await exec(`(()=>{
      const d=document.getElementById('reloadDocumentDialog').getBoundingClientRect();
      const buttons=[...document.querySelectorAll('#reloadDocumentDialog button')].map(e=>e.getBoundingClientRect());
      return {inside:d.left>=0&&d.top>=0&&d.right<=innerWidth+1&&d.bottom<=innerHeight+1,
        buttons:buttons.every(b=>b.left>=0&&b.right<=innerWidth+1&&b.top>=0&&b.bottom<=innerHeight+1)};
    })()`);
    check(`reload ${dark ? "dark" : "light"} dialog and actions fit a narrow zoomed window`, bounds.inside && bounds.buttons, bounds);
    await capture(dark ? "reload-dark-narrow-150" : "reload-light-narrow-150");
    win.webContents.setZoomFactor(1);
  }
  win.setSize(1100, 780);
  await exec("dismissFileUpdateNotification();true");
  await wait("initiating toast finishes fading out", `!document.getElementById('fileUpdateToast').classList.contains('show')&&
    getComputedStyle(document.getElementById('fileUpdateToast')).opacity==='0'`);
  check("focus restoration fixture has a connected but invisible initiating Reload button",
    await exec(`document.getElementById('reloadFileBtn').isConnected&&
      !document.getElementById('reloadFileBtn').checkVisibility({opacityProperty:true})`));
  await cancel();
  const canceled = await exec(stateExpression);
  check("Cancel preserves the exact clean document and deletion protection",
    canceled.live === before.live && canceled.content === before.content &&
    canceled.original === before.original && !canceled.dirty &&
    (await deletionState()).ownDeletion === true, canceled);
  check("reload cancellation restores visible keyboard focus",
    canceled.focused === "refreshBtn" &&
    await exec("document.activeElement.checkVisibility({opacityProperty:true,visibilityProperty:true})"), canceled);
  await prompt();
  await cancel("reloadDocumentClose");
  check("closing the reload dialog preserves the document",
    (await exec(stateExpression)).live === before.live);
  await prompt();
  win.webContents.sendInputEvent({ type: "mouseDown", x: 5, y: 5, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: 5, y: 5, button: "left", clickCount: 1 });
  await wait("backdrop cancellation", "!document.getElementById('reloadDocumentDialog').open");
  await settle();
  check("clicking the backdrop cancels without replacing the document",
    (await exec(stateExpression)).live === before.live && (await deletionState()).ownDeletion === true);
  await prompt();
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await wait("Escape cancellation", "!document.getElementById('reloadDocumentDialog').open");
  await settle();
  check("Escape cancels without granting replacement approval",
    (await exec(stateExpression)).live === before.live && (await deletionState()).ownDeletion === true);
  await prompt();
  await accept(updated);
  const loaded = await exec(stateExpression);
  check("approved recreated-file reload adopts only the requested disk document",
    loaded.content === updated && loaded.original === updated && loaded.live === updated &&
    !loaded.dirty && (await deletionState()).ownDeletion === false, loaded);
  const edited = "# Reload example\n\nA genuine unsaved edit.\n";
  await edit(edited);
  await exec("window.CustomTabs.requestReloadWithConfirmation();true");
  await wait("genuine unsaved themed warning", "document.getElementById('appMessageDialog')?.open===true");
  const editQuestions = await exec("[document.getElementById('appMessageText').textContent]");
  await exec(`document.querySelector('#appMessageDialog [data-dialog-choice="cancel"]').click();true`);
  await settle();
  check("a genuine unsaved edit still has its separate discard warning",
    editQuestions.length === 1 && editQuestions[0] === "You have unsaved changes. Reload from disk and discard them?" &&
    (await exec(stateExpression)).live === edited &&
    !await exec("document.getElementById('reloadDocumentDialog').open"), editQuestions);
  await exec("window.CustomTabs.requestReloadWithConfirmation();true");
  await wait("second genuine unsaved warning", "document.getElementById('appMessageDialog')?.open===true");
  await exec(`document.querySelector('#appMessageDialog [data-dialog-choice="proceed"]').click();true`);
  await wait("confirmed genuine edit discarded", `currentReloadSnapshot()===${JSON.stringify(updated)}&&
    window.CustomTabs.getActiveTab()?.content===${JSON.stringify(updated)}&&!hasUnsavedChanges`);
  check("confirmed genuine edit reload does not add a spurious replacement question",
    !await exec("document.getElementById('reloadDocumentDialog').open"));
  await edit("# Reload example\n\nSaved normally.\n");
  await exec("document.getElementById('saveButton').click();true");
  await wait("ordinary save completes", "!hasUnsavedChanges&&window.CustomTabs.getActiveTab()?.hasUnsavedChanges===false");
  await exec("window.CustomTabs.requestReloadWithConfirmation();true");
  await settle();
  check("an ordinary editor save does not ask for replacement consent",
    fs.readFileSync(file, "utf8").includes("Saved normally.") &&
    !await exec("document.getElementById('reloadDocumentDialog').open"));
  for (const split of [false, true]) {
    const mode = split ? "split" : "normal";
    const earlier = "# Zoom consent " + mode + "\n\nEarlier document.\n";
    const later = "# Zoom consent " + mode + "\n\nRecreated document.\n";
    const zoomFile = await open("zoom-consent-" + mode + ".md", earlier);
    await exec(`document.getElementById('zoomReset').click();
      for(let i=0;i<6;i++)document.getElementById('zoomIn').click();
      if(isEditMode!==${split})document.getElementById('toggleEdit').click();true`);
    await settle();
    check(`${mode} zoom consent fixture has real 160 percent reading scale`,
      await exec(`zoomLevel===160&&localStorage.getItem('readingZoom')==='160'&&
        Number(getComputedStyle(viewer).zoom)===1.6&&isEditMode===${split}`));
    await recreate(zoomFile, later);
    await prompt();
    const point = await exec(`(()=>{
      const d=document.getElementById('reloadDocumentDialog');
      const r=d.getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
    })()`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "+", modifiers: ["control"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "+", modifiers: ["control"] });
    win.webContents.sendInputEvent({ type: "mouseWheel", ...point, deltaX: 0, deltaY: 120,
      modifiers: ["control"] });
    await sleep(180);
    check(`${mode} reload question blocks underlying reading zoom shortcuts`,
      await exec(`zoomLevel===160&&localStorage.getItem('readingZoom')==='160'&&
        !viewer.contains(document.getElementById('reloadDocumentDialog'))`));
    await capture("reload-reading-160-" + mode);
    // Restore the fixture if a shortcut regression changed its scale.
    await exec("zoomLevel=160;updateZoom();true");
    await cancel();
    check(`${mode} reload cancellation preserves content and reading zoom`,
      (await exec(stateExpression)).live === earlier &&
      await exec("zoomLevel===160&&localStorage.getItem('readingZoom')==='160'"));
    await prompt();
    await accept(later);
    check(`${mode} approved reload keeps the persisted reading zoom`,
      await exec("zoomLevel===160&&localStorage.getItem('readingZoom')==='160'&&Number(getComputedStyle(viewer).zoom)===1.6"));
    await exec("if(isEditMode)document.getElementById('toggleEdit').click();true");
    await settle();
  }
  await checkPreDialogSnapshot();
  for (const change of ["disk", "edit", "selection", "closed"]) {
    const oldBody = "# Stale " + change + "\n\nEarlier document.\n";
    const newBody = "# Stale " + change + "\n\nApproved candidate.\n";
    const raceFile = await open("stale-" + change + ".md", oldBody);
    const raceId = await exec("window.CustomTabs.getActiveTabId()");
    await recreate(raceFile, newBody);
    await prompt();
    const question = await exec("window.__reloadConfirmations.at(-1)");
    if (change === "disk") {
      fs.writeFileSync(raceFile, "# Stale disk\n\nChanged again after the question.\n");
    } else if (change === "edit") {
      await edit("# Stale edit\n\nNew edit while the question was open.\n");
    } else if (change === "selection") {
      await open("other-selected.md", "# Other selection\n\nA different document.\n");
    } else {
      await exec(`(async()=>{
        const answer=setInterval(()=>{
          if(document.getElementById('appMessageDialog')?.open &&
              document.getElementById('appMessageTitle').textContent.startsWith('Close')){
            document.querySelector('#appMessageDialog [data-dialog-choice="proceed"]').click();
          }
        },20);
        try{await window.CustomTabs.closeTab(${raceId})}finally{clearInterval(answer)}
        return true;
      })()`);
      const closedReply = await exec(`window.folia.respondToDocumentReplacementConsent(${JSON.stringify({
        id: question.id, pageSession: question.pageSession,
        rendererGeneration: question.rendererGeneration, approved: true,
      })})`);
      check("Main refuses affirmative consent after the document owner has closed", closedReply.accepted === false, closedReply);
    }
    await exec("if(document.getElementById('reloadDocumentDialog').open)document.getElementById('reloadDocumentConfirm').click();true");
    await wait("stale dialog dismissed", "!document.getElementById('reloadDocumentDialog').open");
    await settle();
    const after = await exec(`(()=>{
      const tab=window.CustomTabs.getTabs().find(tab=>tab.id===${raceId});
      return {exists:!!tab,content:tab?.content,live:currentReloadSnapshot(),active:window.CustomTabs.getActiveTabId()};
    })()`);
    check(`a ${change} change while confirmation is open cannot adopt the stale candidate`,
      change === "closed" ? !after.exists :
      change === "selection" ? after.active !== raceId && after.content === oldBody :
      change === "edit" ? after.live.includes("New edit while") && after.content !== newBody :
      after.content === oldBody && after.live === oldBody, after);
  }
  const backgroundBody = "# Background document\n\nEarlier content.\n";
  const backgroundNew = "# Background document\n\nRecreated content.\n";
  const background = await open("background-reopen.md", backgroundBody);
  const backgroundId = await exec("window.CustomTabs.getActiveTabId()");
  await recreate(background, backgroundNew);
  await open("background-control.md", "# Foreground control\n\nKeep this selected until approval.\n");
  const foregroundId = await exec("window.CustomTabs.getActiveTabId()");
  chosen = background;
  await exec("document.getElementById('openFile').click();true");
  const backgroundAsked = await wait("background-owner confirmation", "document.getElementById('reloadDocumentDialog').open", false);
  check("reopening a protected background tab asks about that document before selecting it",
    backgroundAsked && await exec(`window.CustomTabs.getActiveTabId()===${foregroundId}&&
      document.getElementById('reloadDocumentName').textContent==='background-reopen.md'`));
  if (backgroundAsked) await cancel();
  check("cancelling background reopening preserves both documents and the selection",
    await exec(`window.CustomTabs.getActiveTabId()===${foregroundId}&&
      window.CustomTabs.getTabs().find(t=>t.id===${backgroundId}).content===${JSON.stringify(backgroundBody)}`));
  await exec("document.getElementById('openFile').click();true");
  const backgroundApproved = await wait("second background-owner confirmation", "document.getElementById('reloadDocumentDialog').open", false);
  if (backgroundApproved) await accept(backgroundNew);
  check("approving background reopening selects only the approved updated document",
    await exec(`window.CustomTabs.getActiveTabId()===${backgroundId}`));

  for (const change of ["evidence", "expiry", "competing"]) {
    const control = await open("evidence-control-" + change + ".md", "# Evidence control " + change + "\n\nControl.\n");
    const controlId = await exec("window.CustomTabs.getActiveTabId()");
    const body = "# Consent " + change + "\n\nEarlier content.\n";
    const replacement = "# Consent " + change + "\n\nReplacement content.\n";
    const held = await open("consent-" + change + ".md", body);
    await recreate(held, replacement);
    await prompt();
    const request = await exec("window.__reloadConfirmations.at(-1)");
    if (change === "competing") {
      await exec("window.CustomTabs.requestReloadWithConfirmation();true");
      await wait("competing reload cancels obsolete question", "!document.getElementById('reloadDocumentDialog').open");
      await settle();
    } else if (change === "evidence") {
      const beforeRevision = (await deletionState()).revision;
      fs.unlinkSync(control);
      const other = await exec(`(()=>{
        const tab=window.CustomTabs.getTabs().find(tab=>tab.id===${controlId});
        const owner=window.CustomTabs.getDocumentIdentityForTab(tab.id,tab.filePath,window.getReloadRequestSession());
        return window.folia.queryDocumentDeletionState({...owner,filePath:tab.filePath});
      })()`);
      check("held consent evidence change is a real new missing-file episode",
        other.known && other.ownDeletion && other.revision > beforeRevision, other);
    }
    const realNow = Date.now;
    let reply;
    try {
      if (change === "expiry") Date.now = () => realNow() + 60000;
      reply = await exec(`window.folia.respondToDocumentReplacementConsent(${JSON.stringify({
        id: request.id, pageSession: request.pageSession,
        rendererGeneration: request.rendererGeneration, approved: true,
      })})`);
    } finally { Date.now = realNow; }
    await exec("if(document.getElementById('reloadDocumentDialog').open)document.getElementById('reloadDocumentCancel').click();true");
    await settle();
    check(`Main refuses ${change} state changes without trusting a forced affirmative reply`,
      reply.accepted === false && (await exec(stateExpression)).live === body &&
      (await deletionState()).ownDeletion === true, reply);
    const replay = await exec(`window.folia.respondToDocumentReplacementConsent(${JSON.stringify({
      id: request.id, pageSession: request.pageSession,
      rendererGeneration: request.rendererGeneration, approved: true,
    })})`);
    check(`a ${change} consent cannot be replayed`, replay.accepted === false, replay);
  }
  const longName = "safe &amp; literal " + "long-document-name-".repeat(4) + ".md";
  const named = await open(longName, "# Filename safety\n\nOriginal.\n");
  await recreate(named, "# Filename safety\n\nNew.\n");
  const namedPrompt = await prompt();
  check("filenames are displayed as literal text rather than HTML",
    namedPrompt.name === longName && await exec("document.getElementById('reloadDocumentName').children.length===0"), namedPrompt);
  win.setSize(520, 620);
  win.webContents.setZoomFactor(1.5);
  await capture("reload-long-name-narrow-150");
  win.webContents.setZoomFactor(1);
  win.setSize(1100, 780);
  await cancel();
  await reasonScenarios(sentinel);
  check("protected reload uses no native replacement dialog", nativeQuestions.length === 0, nativeQuestions);
}

async function reasonScenarios(sentinel) {
    const first = path.join(fixtures, "first-target");
    const second = path.join(fixtures, "second-target");
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    const body = "# Linked file\n\nFirst physical file.\n";
    const newer = "# Linked file\n\nSecond physical file.\n";
    fs.writeFileSync(path.join(first, "document.md"), body);
    fs.writeFileSync(path.join(second, "document.md"), newer);
    const alias = path.join(fixtures, "linked-location");
    fs.symlinkSync(first, alias, process.platform === "win32" ? "junction" : "dir");
    chosen = path.join(alias, "document.md");
    await exec("document.getElementById('openFile').click();true");
    await wait("first linked file admitted", `originalMarkdown===${JSON.stringify(body)}`);
    await settle();
    fs.unlinkSync(alias);
    fs.symlinkSync(second, alias, process.platform === "win32" ? "junction" : "dir");
    await exec("document.getElementById('openFile').click();true");
    await wait("retarget confirmation", "document.getElementById('reloadDocumentDialog').open");
    const changed = await exec("document.getElementById('reloadDocumentReason').textContent");
    check("a retargeted location does not falsely claim that the file disappeared",
      changed === "This location now opens a different file. Reload that file from disk?", changed);
    await cancel();
    check("cancelling a retarget keeps the earlier document",
      (await exec(stateExpression)).live === body && fs.readFileSync(chosen, "utf8") === newer);
    const orphanAlias = path.join(fixtures, "missing-location");
    fs.symlinkSync(first, orphanAlias, process.platform === "win32" ? "junction" : "dir");
    chosen = path.join(orphanAlias, "document.md");
    await exec("document.getElementById('openFile').click();true");
    await wait("older alias admitted", `currentFilePath===${JSON.stringify(chosen)}&&
      window.CustomTabs.getActiveTab()?.filePath===${JSON.stringify(chosen)}&&
      window.CustomTabs.getActiveTab()?.content===${JSON.stringify(body)}`);
    await settle();
    const olderId = await exec("window.CustomTabs.getActiveTabId()");
    fs.unlinkSync(path.join(first, "document.md"));
    const missing = await deletionState();
    fs.writeFileSync(path.join(first, "document.md"), body);
    fs.unlinkSync(orphanAlias);
    check("related-copy fixture retains a real deletion while the physical file stays readable",
      missing.ownDeletion && fs.readFileSync(path.join(first, "document.md"), "utf8") === body, missing);
    await exec(`(async()=>{
      const answer=setInterval(()=>{
        if(document.getElementById('appMessageDialog')?.open &&
            document.getElementById('appMessageTitle').textContent.startsWith('Close')){
          document.querySelector('#appMessageDialog [data-dialog-choice="proceed"]').click();
        }
      },20);
      try{
        for(const tab of window.CustomTabs.getTabs().slice()){
          if(tab.id!==${olderId})await window.CustomTabs.closeTab(tab.id);
        }
      }finally{clearInterval(answer)}
      return true;
    })()`);
    await settle();
    const errors = await sentinel.stop();
    check("reload journeys produce no renderer or document errors", errors.hits.length === 0, errors.hits);
    const oldSession = await exec("window.getReloadRequestSession()");
    const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
    win.webContents.reload();
    await loaded;
    await wait("replacement page handshake", `typeof window.CustomTabs?.getTabs==='function'&&
      window.getReloadRequestSession()!==${JSON.stringify(oldSession)}`);
    await sleep(700);
    await exec("window.confirm=()=>{throw new Error('Unexpected native renderer confirmation')};true");
    const afterNavigation = startErrorSentinel(win, { label: "reload-dialog-navigation" });
    const alive = await proveSentinelAlive(win, afterNavigation);
    check("replacement-page error sentinel proves both channels alive", alive.console && alive.dom, alive);
    chosen = path.join(first, "document.md");
    await exec("document.getElementById('openFile').click();true");
    await wait("protected earlier copy confirmation", "document.getElementById('reloadDocumentDialog').open");
    const protectedReason = await exec("document.getElementById('reloadDocumentReason').textContent");
    check("an unrelated protected older copy is not described as a disappearing current file",
      missing.ownDeletion && protectedReason === "An earlier copy of this file is still protected. Reload this document from disk? The earlier copy will stay protected.", protectedReason);
    await exec("document.getElementById('reloadDocumentConfirm').click();true");
    await wait("direct physical copy admitted", `currentFilePath===${JSON.stringify(chosen)}&&
      currentReloadSnapshot()===${JSON.stringify(body)}&&!document.getElementById('reloadDocumentDialog').open`);
    await exec("document.getElementById('openFile').click();true");
    await wait("earlier copy remains protected", "document.getElementById('reloadDocumentDialog').open");
    check("opening a related file leaves the earlier protection in place",
      await exec("document.getElementById('reloadDocumentReason').textContent") === protectedReason &&
      !fs.existsSync(orphanAlias) && fs.readFileSync(chosen, "utf8") === body);
    await cancel();
    const clean = await afterNavigation.stop();
    check("replacement-page journeys produce no renderer or document errors", clean.hits.length === 0, clean.hits);
    fs.unlinkSync(alias);
    await exec(`const original=window.CustomTabs.confirmDocumentReplacement;
      window.CustomTabs.confirmDocumentReplacement=request=>{
        window.__navigationConsent=request;return original(request);
      };true`);
    const navigationFile = await open("navigation-pending.md", "# Navigation\n\nEarlier content.\n");
    await recreate(navigationFile, "# Navigation\n\nRecreated content.\n");
    await prompt();
    const navigationConsent = await exec("window.__navigationConsent");
    const nextLoaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
    win.webContents.reload();
    await nextLoaded;
    await wait("next replacement-page handshake", `typeof window.CustomTabs?.getTabs==='function'&&
      window.getReloadRequestSession()!==${JSON.stringify(navigationConsent.pageSession)}`);
    const oldPageReply = await exec(`window.folia.respondToDocumentReplacementConsent(${JSON.stringify({
      id: navigationConsent.id, pageSession: navigationConsent.pageSession,
      rendererGeneration: navigationConsent.rendererGeneration, approved: true,
    })})`);
    check("navigation cancels an open question and refuses its old page approval",
      oldPageReply.accepted === false, oldPageReply);
}
app.whenReady().then(async () => {
  await sleep(1200);
  win = BrowserWindow.getAllWindows()[0];
  win.webContents.on("console-message", event => rendererMessages.push(event.message));
  let failed = false;
  try {
    await wait("production ready", "typeof window.CustomTabs?.getTabs==='function'");
    await exec("window.confirm=()=>{throw new Error('Unexpected native renderer confirmation')};true");
    win.setSize(1100, 780);
    console.log("Reload dialog evidence: " + batch);
    await run();
  } catch (error) {
    failed = true;
    check("reload dialog harness reaches completion", false, error.stack || String(error));
    console.log("RELOAD_FAILURE_DIAGNOSTIC " + JSON.stringify({
      messages: rendererMessages.slice(-25),
      state: win && !win.isDestroyed() ? await exec(stateExpression) : null,
    }));
    if (win && !win.isDestroyed()) await capture("reload-FAILED");
  }
  console.log(`=== ${results.filter(result => result.ok).length}/${results.length} passed ===`);
  app.exit(failed || results.some(result => !result.ok) ? 1 : 0);
});
setTimeout(() => { console.error("Reload dialog watchdog expired"); app.exit(2); }, 120000);
