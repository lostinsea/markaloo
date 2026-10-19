"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const root = path.resolve(__dirname, "..");
const batch = process.env.MARKALOO_DIALOG_EVIDENCE ||
  path.join(root, "tmp", "app-dialogs-" + randomUUID());
fs.mkdirSync(batch, { recursive: true });
const originalTmpdir = os.tmpdir;
os.tmpdir = () => path.join(batch, "isolation");
require("./test-userdata-isolation");
os.tmpdir = originalTmpdir;
const { app, BrowserWindow, dialog } = require("electron");
fs.mkdirSync(path.join(batch, "crash-dumps"), { recursive: true });
fs.mkdirSync(path.join(batch, "logs"), { recursive: true });
app.setPath("crashDumps", path.join(batch, "crash-dumps"));
app.setAppLogsPath(path.join(batch, "logs"));
const fixtures = path.join(batch, "fixtures");
fs.mkdirSync(fixtures, { recursive: true });
let chosen;
const nativeMessages = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  nativeMessages.push(options);
  return { response: options.cancelId ?? options.buttons.length - 1 };
};
dialog.showMessageBoxSync = (...args) => {
  const options = args.at(-1);
  nativeMessages.push(options);
  return options.cancelId ?? options.buttons.length - 1;
};
require("../src/main.js");
const { startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
let keepalive;
const messages = [];
const exec = code => win.webContents.executeJavaScript(code);
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}
async function wait(label, predicate) {
  for (let i = 0; i < 250; i++) {
    if (await predicate()) return;
    await sleep(40);
  }
  throw new Error("Timed out: " + label);
}
const pageWait = (label, code) => wait(label, () => exec(code));
async function settle() {
  await sleep(160);
  await exec("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
}
async function rootChoice(id) {
  await exec(`document.querySelector('#appMessageDialog [data-dialog-choice="${id}"]').click();true`);
}
async function rootQuestion(title) {
  await pageWait("root question " + title,
    `document.getElementById('appMessageDialog')?.open&&document.getElementById('appMessageTitle').textContent===${JSON.stringify(title)}`);
}
async function open(name, body) {
  chosen = path.join(fixtures, name);
  fs.writeFileSync(chosen, body);
  await exec(`document.getElementById('openFile').click();
    if(document.getElementById('appMessageDialog')?.open&&
        document.getElementById('appMessageTitle').textContent==='Discard unsaved changes?'){
      document.querySelector('#appMessageDialog [data-dialog-choice="proceed"]').click();
    }true`);
  await pageWait("opened " + name, `currentFilePath===${JSON.stringify(chosen)}&&
    currentReloadSnapshot()===${JSON.stringify(body)}&&
    viewer.querySelector('h1')?.textContent===${JSON.stringify(body.split("\n")[0].slice(2))}`);
  await settle();
  return chosen;
}
async function edit(body) {
  await exec(`if(!isEditMode)document.getElementById('toggleEdit').click();
    markdownEditor.value=${JSON.stringify(body)};
    markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true`);
  await pageWait("edited document", `hasUnsavedChanges&&currentReloadSnapshot()===${JSON.stringify(body)}`);
}
async function screenshot(name, target = win) {
  await sleep(200);
  fs.writeFileSync(path.join(batch, name + ".png"), (await target.webContents.capturePage()).toPNG());
}
async function accessibleDialogs(selector) {
  const client = win.webContents.debugger;
  client.attach("1.3");
  try {
    await client.sendCommand("Accessibility.enable");
    const { root } = await client.sendCommand("DOM.getDocument");
    const { nodeId } = await client.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) return [];
    const { node: target } = await client.sendCommand("DOM.describeNode", { nodeId });
    const { nodes } = await client.sendCommand("Accessibility.getFullAXTree");
    return nodes.filter(node => !node.ignored && node.backendDOMNodeId === target.backendNodeId &&
      node.role?.value === "alertdialog")
      .map(node => ({ name: node.name?.value, description: node.description?.value }));
  } finally {
    client.detach();
  }
}
async function ownedQuestion() {
  let target;
  await wait("Main-owned themed question", async () => {
    target = BrowserWindow.getAllWindows().find(candidate =>
      !candidate.isDestroyed() && candidate.webContents.getURL().includes("owned-dialog.html"));
    return target && target.webContents.executeJavaScript(
      "document.getElementById('appMessageDialog')?.open===true");
  });
  return target;
}
async function ownedChoice(target, id) {
  await target.webContents.executeJavaScript(
    `document.querySelector('[data-dialog-choice="${id}"]').click();true`);
}
async function captureRootMatrix(kind, show, close) {
  for (const scheme of ["clarity", "abyss"]) {
    await exec(`window.foliaThemes.setScheme(${JSON.stringify(scheme)});true`);
    await settle();
    await show();
    await screenshot(`${kind}-${scheme}`);
    win.setMinimumSize(400, 400);
    win.setSize(520, 620);
    win.webContents.setZoomFactor(1.5);
    await settle();
    const bounds = await exec(`(()=>{
      const d=document.querySelector('dialog[open],.note-dialog-overlay.visible > .note-dialog');
      const r=d.getBoundingClientRect();
      return {inside:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,
        actions:[...d.querySelectorAll('.note-dialog-footer button')].every(button=>{
          const b=button.getBoundingClientRect();return b.left>=0&&b.top>=0&&b.right<=innerWidth+1&&b.bottom<=innerHeight+1;
        }),font:getComputedStyle(d).fontFamily};
    })()`);
    check(`${kind} ${scheme} keeps its card and actions reachable at narrow 150% zoom`,
      bounds.inside && bounds.actions && bounds.font.includes("Fira"), bounds);
    await screenshot(`${kind}-${scheme}-narrow-150`);
    win.webContents.setZoomFactor(1);
    win.setSize(1100, 780);
    await close();
    await settle();
  }
}
async function run() {
  check("app dialogs use the frozen production bridge without Node in the page",
    await exec("typeof require==='undefined'&&typeof process==='undefined'&&Object.isFrozen(window.folia)&&Object.isFrozen(window.MarkalooDialogs)"));
  const sentinel = startErrorSentinel(win, { label: "app-dialogs" });
  const alive = await proveSentinelAlive(win, sentinel);
  check("app dialog sentinel proves both error channels alive", alive.console && alive.dom, alive);
  for (const surface of ["message", "reload"]) {
    await sentinel.mute("Measuring document-supplied dialog ID collisions");
    await exec(`window.__dialogCollisionFixture=document.createElement('div');
      for(const id of ['appMessageDialog','appMessageTitle','appMessageName','appMessageText',
        'appMessageDetail','appMessageButtons','appMessageClose','reloadDocumentDialog',
        'reloadDocumentTitle','reloadDocumentName','reloadDocumentReason','reloadDocumentClose',
        'reloadDocumentCancel','reloadDocumentConfirm']){
        const node=document.createElement('div');node.id=id;node.textContent='Document text';
        window.__dialogCollisionFixture.append(node);
      }
      document.getElementById('viewer').prepend(window.__dialogCollisionFixture);
      window.__collisionAnswer=null;
      window.MarkalooDialogs.show({
        ${surface === "reload" ? "surface:'reload'," : ""}
        title:'App-owned ${surface}',message:'A real app question.',
        buttons:[{id:'cancel',label:'Cancel',style:'secondary'},
          {id:'proceed',label:'Continue',style:'primary'}],
        defaultId:'cancel',cancelId:'cancel'
      }).then(value=>window.__collisionAnswer=value,error=>window.__collisionAnswer={error:error.message});true`);
    const selector = surface === "reload" ? "body > dialog#reloadDocumentDialog" : "body > dialog.app-message-dialog";
    await pageWait("collision probe settled or shown",
      `window.__collisionAnswer||document.querySelector(${JSON.stringify(selector)})?.open`);
    const collisionSafe = await exec(`(()=>{
      const dialog=document.querySelector(${JSON.stringify(selector)});
      return dialog?.open&&dialog.querySelector('h2').textContent==='App-owned ${surface}'&&
        [...window.__dialogCollisionFixture.children].every(node=>node.textContent==='Document text');
    })()`);
    await sentinel.drain();
    check(`${surface} dialog uses app-owned controls despite document ID collisions`,
      collisionSafe && sentinel.currentMute().suppressed.length === 0, sentinel.currentMute().suppressed);
    const announcements = await accessibleDialogs(selector);
    check(`${surface} dialog announces its real warning despite document ID collisions`,
      announcements.some(node => node.name === "App-owned " + surface &&
        node.description === "A real app question."), announcements);
    if (collisionSafe) await exec(`document.querySelector(${JSON.stringify(selector)}).querySelector('[data-dialog-choice=cancel]').click();true`);
    await exec(`window.__dialogCollisionFixture.remove();
      document.querySelector('body > .app-dialog-failure')?.remove();true`);
    await sentinel.unmute();
  }
  await exec(`window.alert=window.confirm=window.prompt=()=>{throw new Error('Unexpected browser dialog')};
    window.__dialogResults={};
    const question=title=>({title,message:'Literal <b>text</b> & details',fileName:'literal & filename',
      buttons:[{id:'cancel',label:'Cancel',style:'secondary'},{id:'proceed',label:'Continue',style:'primary'}],
      defaultId:'cancel',cancelId:'cancel'});
    window.MarkalooDialogs.show(question('First queued question')).then(result=>window.__dialogResults.first=result);
    const queued=question('Second queued question');
    window.MarkalooDialogs.show(queued).then(result=>window.__dialogResults.second=result);
    queued.message='Changed after enqueue';queued.buttons[1].label='Changed after enqueue';
    window.__question=question;true`);
  await rootQuestion("First queued question");
  check("queued dialog renders text literally and starts on its safe action",
    await exec(`document.getElementById('appMessageText').textContent==='Literal <b>text</b> & details'&&
      document.getElementById('appMessageText').children.length===0&&document.activeElement.dataset.dialogChoice==='cancel'&&
      document.getElementById('appMessageDialog').getAttribute('role')==='alertdialog'`));
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await rootQuestion("Second queued question");
  await settle();
  check("a queued presentation keeps the validated descriptor it received",
    await exec("document.getElementById('appMessageText').textContent==='Literal <b>text</b> & details'&&document.querySelector('#appMessageDialog [data-dialog-choice=proceed]').textContent==='Continue'"));
  check("one cancelled question cannot consume the queued question's answer",
    await exec("window.__dialogResults.first.cause==='cancel'&&!window.__dialogResults.second&&document.getElementById('appMessageDialog').open"));
  await rootChoice("proceed");
  await pageWait("second answer", "window.__dialogResults.second");
  check("the second queued question receives only its own explicit action",
    await exec("window.__dialogResults.second.cause==='choice'&&window.__dialogResults.second.choice==='proceed'"));
  await exec(`window.__decisionCurrent=true;
    window.MarkalooDialogs.show({...window.__question('Stale local decision'),isCurrent:()=>window.__decisionCurrent})
      .then(result=>window.__dialogResults.stale=result);true`);
  await rootQuestion("Stale local decision");
  await exec("window.__decisionCurrent=false;true");
  await pageWait("stale cancellation", "window.__dialogResults.stale");
  check("a changed local decision is cancelled without pretending to be a user answer",
    await exec("window.__dialogResults.stale.cause==='stale'&&window.__dialogResults.stale.choice==='cancel'"));
  await exec(`window.__abort=new AbortController();
    window.MarkalooDialogs.show({...window.__question('Aborted local decision'),signal:window.__abort.signal})
      .then(result=>window.__dialogResults.abort=result);true`);
  await rootQuestion("Aborted local decision");
  await exec("window.__abort.abort();true");
  await pageWait("abort result", "window.__dialogResults.abort");
  check("an aborted local decision never becomes affirmative",
    await exec("window.__dialogResults.abort.cause==='aborted'&&window.__dialogResults.abort.choice==='cancel'"));
  await captureRootMatrix("error", async () => {
    await exec("document.getElementById('exportPdf').click();true");
    await rootQuestion("Open a document first");
  }, () => rootChoice("close"));
  const baseline = "# Dialog document\n\nSaved text.\n";
  const file = await open("dialog-document.md", baseline);
  await edit("# Dialog document\n\nUnsaved text.\n");
  await captureRootMatrix("action", async () => {
    await exec("document.getElementById('toggleEdit').click();true");
    await rootQuestion("Discard unsaved changes?");
  }, () => rootChoice("cancel"));
  check("cancelling exit-edit keeps genuine unsaved edits and edit mode",
    await exec("isEditMode&&hasUnsavedChanges&&currentReloadSnapshot().includes('Unsaved text.')"));
  await exec("document.getElementById('toggleEdit').click();true");
  await rootQuestion("Discard unsaved changes?");
  await edit("# Dialog document\n\nNewer edit during the question.\n");
  await sleep(180);
  const staleExitClosed = await exec("!document.getElementById('appMessageDialog').open");
  check("editing during async exit consent preserves the newer text",
    staleExitClosed && await exec("isEditMode&&hasUnsavedChanges&&currentReloadSnapshot().includes('Newer edit during')"));
  if (!staleExitClosed) await rootChoice("cancel");
  await settle();
  await exec("document.getElementById('toggleEdit').click();true");
  await rootQuestion("Discard unsaved changes?");
  await rootChoice("proceed");
  await pageWait("explicit edit discard", `!isEditMode&&!hasUnsavedChanges&&currentReloadSnapshot()===${JSON.stringify(baseline)}`);
  check("explicit exit-edit discard restores the saved baseline", fs.readFileSync(file, "utf8") === baseline);
  await captureRootMatrix("input", async () => {
    await exec("openNoteDialog();noteTitleInput.value='A note about this document';noteContentInput.value='This is only a disposable input preview.';true");
    await pageWait("themed input editor", "document.getElementById('noteDialogOverlay').classList.contains('visible')");
  }, () => exec("closeNoteDialog();true"));
  check("cancelling the input preview does not change the document",
    await exec(`currentReloadSnapshot()===${JSON.stringify(baseline)}&&!hasUnsavedChanges`));
  const bitmap = Buffer.alloc(240 * 140 * 4);
  for (let y = 0; y < 140; y++) {
    for (let x = 0; x < 240; x++) {
      const offset = (y * 240 + x) * 4;
      bitmap[offset] = 170;
      bitmap[offset + 1] = x < 120 ? 160 : 90;
      bitmap[offset + 2] = y < 70 ? 35 : 80;
      bitmap[offset + 3] = 255;
    }
  }
  const sampleImagePath = path.join(fixtures, "popout-sample.png");
  fs.writeFileSync(sampleImagePath, require("electron").nativeImage.createFromBitmap(bitmap,
    { width: 240, height: 140 }).toPNG());
  const sampleImage = require("url").pathToFileURL(sampleImagePath).href;
  const popoutRequests = [
    ["image", `window.folia.openImagePopup(${JSON.stringify({
      src: sampleImage, alt: "Disposable image preview", isDarkMode: false,
    })})`],
    ["mermaid", `window.folia.openMermaidPopup(${JSON.stringify({
      svgContent: '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="160" viewBox="0 0 420 160"><rect x="20" y="30" width="170" height="90" rx="12" fill="#397db5"/><rect x="230" y="30" width="170" height="90" rx="12" fill="#587d4d"/><text x="65" y="82" fill="white" font-size="20">Document</text><text x="280" y="82" fill="white" font-size="20">Preview</text></svg>',
      isDarkMode: false,
    })})`],
    ["table", `window.folia.openTablePopup(${JSON.stringify({
      tableData: {
        columns: [{ title: "Document", field: "col0", headerFilter: "input" },
          { title: "Status", field: "col1", headerFilter: "input" }],
        data: [{ col0: "Disposable sample", col1: "Ready" }, { col0: "Another sample", col1: "Unchanged" }],
      }, isDarkMode: false,
    })})`],
  ];
  for (const scheme of ["clarity", "abyss"]) {
    await exec(`window.foliaThemes.setScheme(${JSON.stringify(scheme)});true`);
    await settle();
    const expectedBackground = await exec("getComputedStyle(document.body).getPropertyValue('--bg-primary').trim()");
    for (const [kind, request] of popoutRequests) {
      const previousWindows = new Set(BrowserWindow.getAllWindows());
      await exec(request + ";true");
      let popup;
      await wait(kind + " production popout", async () => {
        popup = BrowserWindow.getAllWindows().find(candidate =>
          !previousWindows.has(candidate) && !candidate.isDestroyed());
        return popup && popup.webContents.getURL().endsWith("/" + kind + ".html") &&
          popup.webContents.executeJavaScript(kind === "image"
            ? "document.readyState==='complete'&&document.getElementById('the-img')?.complete&&document.getElementById('the-img').naturalWidth>0"
            : "document.readyState==='complete'");
      });
      const appearance = await popup.webContents.executeJavaScript(`({
        background:getComputedStyle(document.body).getPropertyValue('--bg-primary').trim(),
        font:getComputedStyle(document.body).fontFamily,
        node:typeof require
      })`);
      check(`${kind} popout ${scheme} uses the app palette and font without page Node`,
        expectedBackground.length > 0 && appearance.background === expectedBackground && appearance.font.includes("Fira") &&
          appearance.node === "undefined", appearance);
      await screenshot(`popout-${kind}-${scheme}`, popup);
      popup.close();
      await sleep(80);
    }
  }
  await edit("# Dialog document\n\nClose protection.\n");
  const tabId = await exec("window.CustomTabs.getActiveTabId()");
  await exec(`window.__closeDone=false;window.CustomTabs.closeTab(${tabId}).then(()=>window.__closeDone=true);true`);
  await rootQuestion("Close without saving?");
  await rootChoice("cancel");
  await pageWait("cancelled close settled", "window.__closeDone");
  check("cancelled tab close preserves its exact unsaved document",
    await exec(`window.CustomTabs.getTabs().some(t=>t.id===${tabId})&&hasUnsavedChanges&&currentReloadSnapshot().includes('Close protection.')`));
  await exec(`window.__closeDone=false;window.CustomTabs.closeTab(${tabId}).then(()=>window.__closeDone=true);true`);
  await rootQuestion("Close without saving?");
  await edit("# Dialog document\n\nEdit during close question.\n");
  await sleep(180);
  const staleCloseSettled = await exec("window.__closeDone===true");
  check("async tab close cannot discard text added while its question was open",
    staleCloseSettled && await exec(`window.CustomTabs.getTabs().some(t=>t.id===${tabId})&&currentReloadSnapshot().includes('Edit during close')`));
  if (!staleCloseSettled) await rootChoice("cancel");
  await pageWait("stale close settled", "window.__closeDone");
  await exec(`window.__closeDone=false;window.CustomTabs.closeTab(${tabId}).then(()=>window.__closeDone=true);true`);
  await rootQuestion("Close without saving?");
  await rootChoice("proceed");
  await pageWait("explicit tab close completed", "window.__closeDone");
  check("explicit tab discard closes only the confirmed tab",
    await exec(`!window.CustomTabs.getTabs().some(t=>t.id===${tabId})`));
  const deletedBody = "# Deleted close\n\nKeep this copy until the reader confirms.\n";
  const deletedPath = await open("deleted-close.md", deletedBody);
  const deletedId = await exec("window.CustomTabs.getActiveTabId()");
  fs.unlinkSync(deletedPath);
  await pageWait("authoritative deletion before close", `(()=>{
    const tab=window.CustomTabs.getActiveTab();
    const owner=window.CustomTabs.getDocumentIdentityForTab(tab.id,tab.filePath,window.getReloadRequestSession());
    return window.folia.queryDocumentDeletionState({...owner,filePath:tab.filePath}).unresolved===true;
  })()`);
  await settle();
  await sentinel.mute("Measuring the exact production deletion-close acknowledgement");
  await exec(`window.__deletedCloseDone=false;window.CustomTabs.closeTab(${deletedId}).then(()=>window.__deletedCloseDone=true);true`);
  await rootQuestion("Close this copy?");
  await rootChoice("proceed");
  await pageWait("deletion close settled", "window.__deletedCloseDone");
  await sentinel.drain();
  check("themed deletion close carries its exact evidence revision through the production preload",
    await exec(`!window.CustomTabs.getTabs().some(t=>t.id===${deletedId})`) &&
      sentinel.currentMute().suppressed.length === 0, sentinel.currentMute().suppressed);
  await sentinel.unmute();
  await open("main-dialog-document.md", "# Main dialog\n\nA clean document.\n");
  await exec(`window.__largeAnswer=null;
    window.folia.confirmLargeRender({name:'Large disposable document.md',seconds:12}).then(value=>window.__largeAnswer=value);true`);
  const large = await ownedQuestion();
  const isolated = large.webContents.getLastWebPreferences();
  check("Main-owned dialog has its own sandboxed renderer and production preload",
    isolated.sandbox === true && isolated.contextIsolation === true && isolated.nodeIntegration === false &&
    large.webContents.getProcessId() !== win.webContents.getProcessId() &&
    await large.webContents.executeJavaScript("typeof require==='undefined'&&typeof process==='undefined'"));
  check("Main-owned large-document question starts on Cancel",
    await large.webContents.executeJavaScript("document.activeElement.textContent.trim()==='Cancel'"));
  for (const scheme of ["clarity", "abyss"]) {
    await exec(`window.foliaThemes.setScheme(${JSON.stringify(scheme)});true`);
    await wait("Main theme " + scheme, () => large.webContents.executeJavaScript(
      `document.body.dataset.theme===${JSON.stringify(scheme)}`));
    await screenshot("main-question-" + scheme, large);
    large.setMinimumSize(400, 400);
    large.setSize(520, 620);
    large.webContents.setZoomFactor(1.5);
    await sleep(180);
    check(`Main ${scheme} keeps its question and actions reachable at narrow 150% zoom`,
      await large.webContents.executeJavaScript(`(()=>{
        const dialog=document.getElementById('appMessageDialog');
        return [dialog,...dialog.querySelectorAll('.note-dialog-footer button')].every(node=>{
          const b=node.getBoundingClientRect();return b.left>=0&&b.top>=0&&b.right<=innerWidth+1&&b.bottom<=innerHeight+1;
        });
      })()`));
    await screenshot("main-question-" + scheme + "-narrow-150", large);
    large.webContents.setZoomFactor(1);
    large.setSize(660, 480);
  }
  await exec("showMessageDialog('Queued save error','The file was not saved. Your edits are still available.');true");
  check("a Main modal postpones rather than overlaps a local error acknowledgment",
    !await exec("document.getElementById('appMessageDialog')?.open===true"));
  await ownedChoice(large, "1");
  await pageWait("large cancel result", "window.__largeAnswer===false");
  await rootQuestion("Queued save error");
  await rootChoice("close");
  check("cancelling the Main warning neither opens the document nor loses the queued error",
    await exec("window.__largeAnswer===false&&currentReloadSnapshot().includes('A clean document.')"));
  await exec(`window.__largeAnswer=null;
    window.folia.confirmLargeRender({name:'Approved disposable document.md',seconds:12}).then(value=>window.__largeAnswer=value);true`);
  const approvedLarge = await ownedQuestion();
  await ownedChoice(approvedLarge, "0");
  await pageWait("large explicit result", "window.__largeAnswer===true");
  check("only an explicit Main large-document action returns permission", await exec("window.__largeAnswer===true"));
  const largeBody = "# Pending native open\n\n| A | B | C |\n| --- | --- | --- |\n" +
    "| one | two | three |\n".repeat(50000);
  const verdict = require("../src/file-helpers-core").isLargeDocument(largeBody);
  check("native-large fixture really crosses the production render-cost guard", verdict.large, verdict);
  const largePath = path.join(fixtures, "native-large.md");
  fs.writeFileSync(largePath, largeBody);
  chosen = largePath;
  await exec("document.getElementById('openFile').click();true");
  const nativeLarge = await ownedQuestion();
  await ownedChoice(nativeLarge, "1");
  await sleep(250);
  check("cancelling a real guarded file read leaves its document unadmitted",
    await exec(`!window.CustomTabs.getTabs().some(t=>t.filePath===${JSON.stringify(largePath)})&&
      currentReloadSnapshot().includes('A clean document.')`));
  await exec("document.getElementById('openFile').click();true");
  const staleLarge = await ownedQuestion();
  fs.writeFileSync(largePath, "# Different disk snapshot\n\nChanged while its question was open.\n");
  await ownedChoice(staleLarge, "0");
  await sleep(400);
  check("Main refuses a disk snapshot changed during its large-file question",
    await exec(`!window.CustomTabs.getTabs().some(t=>t.filePath===${JSON.stringify(largePath)})&&
      currentReloadSnapshot().includes('A clean document.')`));
  const faultBody = "# Save refusal\n\nSaved original.\n";
  const faultFile = await open("save-refusal.md", faultBody);
  const faultEdit = "# Save refusal\n\nKeep this unsaved edit.\n";
  await edit(faultEdit);
  const backup = faultFile + ".backup";
  fs.renameSync(faultFile, backup);
  fs.mkdirSync(faultFile);
  await sentinel.mute("Intentional disposable save destination replacement");
  await captureRootMatrix("save-error", async () => {
    await exec("document.getElementById('saveButton').click();true");
    await rootQuestion("File could not be saved");
  }, () => rootChoice("close"));
  await sentinel.drain();
  const refusalErrors = sentinel.currentMute().suppressed;
  check("save-error scenario really reaches the production refusal and error channel",
    refusalErrors.some(entry => /Save failed|Refusing save/.test(JSON.stringify(entry.detail))), refusalErrors);
  check("save refusal preserves unsaved text and never writes into the replacement directory",
    await exec(`hasUnsavedChanges&&currentReloadSnapshot()===${JSON.stringify(faultEdit)}`) &&
      fs.readFileSync(backup, "utf8") === faultBody && fs.readdirSync(faultFile).length === 0);
  fs.rmdirSync(faultFile);
  fs.renameSync(backup, faultFile);
  await sentinel.unmute();
  await open("main-close-document.md", "# Main dialog\n\nA clean document for closing.\n");
  await edit("# Main dialog\n\nUnsaved app-close protection.\n");
  win.close();
  const closing = await ownedQuestion();
  await ownedChoice(closing, "1");
  await wait("cancelled app close", () => !win.isDestroyed() &&
    exec("hasUnsavedChanges&&currentReloadSnapshot().includes('Unsaved app-close')"));
  check("cancelling Main close keeps the window and unsaved document", !win.isDestroyed());
  await settle();
  const clean = await sentinel.stop();
  check("normal dialog journeys have no unexpected renderer errors", clean.hits.length === 0, clean.hits);
  check("normal app dialogs do not use native message boxes", nativeMessages.length === 0, nativeMessages);
  win.close();
  const duringCrash = await ownedQuestion();
  win.webContents.forcefullyCrashRenderer();
  await sleep(250);
  const retainedDuringCrash = !duringCrash.isDestroyed() &&
    await duringCrash.webContents.executeJavaScript("document.getElementById('appMessageDialog').open");
  check("an already visible Main question survives document-renderer loss", retainedDuringCrash);
  if (retainedDuringCrash) await ownedChoice(duringCrash, "1");
  await sleep(200);
  check("cancelling the retained question after renderer loss keeps its owner", !win.isDestroyed());
  win.close();
  const unavailable = await ownedQuestion();
  check("renderer-unavailable close still uses an independent themed dialog",
    !unavailable.isDestroyed() &&
    await unavailable.webContents.executeJavaScript("document.getElementById('appMessageDialog').open&&document.body.dataset.theme==='abyss'") &&
    nativeMessages.length === 0);
  await screenshot("renderer-unavailable-themed", unavailable);
  await ownedChoice(unavailable, "1");
  await sleep(200);
  check("renderer-unavailable cancellation does not close the owner", !win.isDestroyed());
}
app.whenReady().then(async () => {
  await sleep(1200);
  win = BrowserWindow.getAllWindows()[0];
  keepalive = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true,
  } });
  win.webContents.on("console-message", event => messages.push(event.message));
  try {
    console.log("App dialog evidence: " + batch);
    await pageWait("production ready", "typeof window.CustomTabs?.captureDialogContext==='function'");
    win.setSize(1100, 780);
    await run();
  } catch (error) {
    check("app dialog harness reaches completion", false, error.stack || String(error));
    console.log("DIALOG_FAILURE_MESSAGES " + JSON.stringify(messages.slice(-30)));
    console.log("DIALOG_NATIVE_MESSAGES " + JSON.stringify(nativeMessages));
    console.log("DIALOG_WINDOWS " + JSON.stringify(await Promise.all(
      BrowserWindow.getAllWindows().map(async target => ({
        url: target.webContents.getURL(),
        args: target.webContents.getLastWebPreferences().additionalArguments,
        state: !target.webContents.getURL() ? { ready: "unloaded" } :
          await target.webContents.executeJavaScript(`({
          ready:document.readyState,title:document.title,
          image:document.getElementById('the-img')?.naturalWidth,
          text:document.body?.innerText.slice(0,150)
        })`).catch(failure => ({ error: failure.message })),
      })))));
    if (win && !win.isDestroyed() && !win.webContents.isCrashed()) await screenshot("app-dialog-FAILED");
  }
  const passed = results.filter(result => result.ok).length;
  fs.writeFileSync(path.join(batch, "results.json"), JSON.stringify(results, null, 2));
  console.log(`=== ${passed}/${results.length} passed ===`);
  app.exit(passed === results.length ? 0 : 1);
});
setTimeout(() => {
  console.error("App dialog watchdog expired");
  app.exit(2);
}, 180000);
