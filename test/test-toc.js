"use strict";
const { app, BrowserWindow, dialog, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("util");
let directory = null;
let registeredTempDirs = null;
let win = null;
let observedMain = null;
let observedContents = null;
let sentinel = null;
let chooserAllowance = null;
let chooserCalls = 0;
let openFixtures = [];
let completed = false;
let finishing = false;
let fatalExiting = false;
let ordinaryExiting = false;
let cleanExit = false;
let summaryWritten = false;
const results = [];

function failUnattended(error) {
  // A fatal during ordinary finish must exit now, not disappear behind its latch.
  if (fatalExiting) process.exit(2);
  fatalExiting = true;
  chooserAllowance = null;
  if (directory) registeredTempDirs?.delete(directory);
  try {
    fs.writeSync(2, "FAIL  TOC fatal error  -> " + String(error?.stack || error) + "\n");
    if (directory) fs.writeSync(2, "TOC fixture retained without confirmed teardown: " + directory + "\n");
  } catch (_) { /* A broken diagnostic pipe must not postpone a nonzero exit. */ }
  try {
    if (observedMain && !observedMain.isDestroyed()) observedMain.destroy();
  } catch (_) { /* No asynchronous evidence or unsafe fixture release on this path. */ }
  try { app.exit(2); } finally { process.exit(2); }
}
process.on("uncaughtException", failUnattended);
process.on("unhandledRejection", failUnattended);
process.once("exit", () => {
  if ((!ordinaryExiting || !cleanExit) && !process.exitCode) process.exitCode = 1;
});
const watchdog = setTimeout(() => failUnattended(new Error("TOC watchdog expired")), 180000);

const nativeDialogGuards = {};
for (const method of ["showMessageBox", "showMessageBoxSync", "showOpenDialog",
  "showOpenDialogSync", "showSaveDialog", "showSaveDialogSync", "showErrorBox"]) {
  const guard = method === "showOpenDialog" ? (...args) => {
    const allowance = chooserAllowance;
    chooserAllowance = null;
    const expected = {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Markdown Files", extensions: ["md", "markdown", "mdown", "mkd", "mkdn"] },
        { name: "Mermaid Files", extensions: ["mmd", "mermaid"] },
        { name: "All Files", extensions: ["*"] },
      ],
    };
    if (!allowance || allowance.consumed || args.length !== 2 ||
        args[0] !== observedMain || args[0] !== allowance.win || !isLiveMain() ||
        allowance.fixture !== openFixtures[chooserCalls] ||
        !isDeepStrictEqual(args[1], expected) || !guardsIntact()) {
      return failUnattended(new Error("Unexpected native dialog: " + method));
    }
    allowance.consumed = true;
    chooserCalls++;
    return Promise.resolve({ canceled: false, filePaths: [allowance.fixture] });
  } : () => failUnattended(new Error("Unexpected native dialog: " + method));
  nativeDialogGuards[method] = guard;
  if (method === "showOpenDialog") {
    Object.defineProperty(dialog, method, { value: guard, writable: false, configurable: false });
  } else {
    dialog[method] = guard;
  }
}
const blockExternal = () => failUnattended(new Error("TOC suite must not call shell.openExternal"));
const blockPath = () => failUnattended(new Error("TOC suite must not call shell.openPath"));
Object.defineProperty(shell, "openExternal", { value: blockExternal, writable: false, configurable: false });
Object.defineProperty(shell, "openPath", { value: blockPath, writable: false, configurable: false });

require("./test-userdata-isolation");
const {
  tempDir, releaseTempDir, captureScreenshot, startErrorSentinel, proveSentinelAlive,
  LIVENESS_MUTE_REASON, REGISTERED_TEMP_DIRS,
} = require("./test-visual-utils");
registeredTempDirs = REGISTERED_TEMP_DIRS;
const exitWithSharedSweep = app.exit.bind(app);
const guardedExit = code => {
  if (!ordinaryExiting && !fatalExiting) {
    return failUnattended(new Error("Unexpected app.exit before TOC terminal accounting"));
  }
  return exitWithSharedSweep(fatalExiting ? 2 : cleanExit && code === 0 ? 0 : 1);
};
Object.defineProperty(app, "exit", { value: guardedExit, writable: false, configurable: false });
app.on("before-quit", event => {
  event.preventDefault();
  if (!fatalExiting) failUnattended(new Error("Unexpected app.quit before TOC terminal exit"));
});
const { OwnedDialogs } = require("../src/owned-dialogs");
const blockOwnedDialog = () => failUnattended(new Error("Unexpected Main-owned dialog"));
OwnedDialogs.prototype.show = blockOwnedDialog;
const guardsIntact = () =>
  Object.entries(nativeDialogGuards).every(([method, guard]) => dialog[method] === guard) &&
  Object.getOwnPropertyDescriptor(dialog, "showOpenDialog").writable === false &&
  OwnedDialogs.prototype.show === blockOwnedDialog &&
  shell.openExternal === blockExternal && shell.openPath === blockPath &&
  Object.getOwnPropertyDescriptor(shell, "openExternal").writable === false &&
  Object.getOwnPropertyDescriptor(shell, "openPath").writable === false &&
  app.exit === guardedExit;
function isLiveMain() {
  return !!observedMain && win === observedMain && !!observedContents &&
    !observedMain.isDestroyed() && !observedContents.isDestroyed() &&
    observedMain.webContents === observedContents;
}
const noPreexistingWindows = BrowserWindow.getAllWindows().length === 0;
if (!noPreexistingWindows) failUnattended(new Error("A window existed before Main observation"));
app.once("browser-window-created", (_event, created) => {
  observedMain = created;
  observedContents = created.webContents;
  sentinel = startErrorSentinel(created, { label: "toc", trapExternal: false });
});
require("../src/main.js");

directory = tempDir("folia-toc-");
// Both shared sweeps run too early for a still-watched fixture. Re-register
// only after the observed owner and its webContents are verifiably destroyed.
registeredTempDirs.delete(directory);
if (registeredTempDirs.has(directory)) failUnattended(new Error("TOC fixture remains exposed to shared exit sweeps"));
const first = path.join(directory, "outline.md");
const second = path.join(directory, "other.md");
const tailFile = path.join(directory, "tail.md");
const nestedFile = path.join(directory, "nested.md");
openFixtures = [first, second, nestedFile, tailFile];
const parts = ["# TOC Alpha", "Opening paragraph."];
for (let i = 0; i < 64; i++) {
  parts.push(`## Section ${i}`);
  parts.push(("A readable paragraph explains document navigation and rendering. ").repeat(30));
  if (i === 2) parts.push("```mermaid\nflowchart LR\n A[Read] --> B[Render] --> C[Scroll]\n```");
  if (i === 20) parts.push('<img id="toc-reflow-image" alt="Reflow witness" style="display:block">');
  if (i % 8 === 0) parts.push(`### Nested ${i}`, "Nested content.\n\n".repeat(12));
}
const markdown = parts.join("\n\n");
fs.writeFileSync(first, markdown);
fs.writeFileSync(second, "# TOC Other\n\n" + parts.slice(2, 32).join("\n\n"));
fs.writeFileSync(tailFile, "# End fixture\n\n" + "A long paragraph.\n\n".repeat(90) + "## Before tail\n\nShort.\n\n## Final tail\n\nEnd.");
const nestedHeadings = [
  "# Multi outline", "## Parent", "### Nested child", "#### Deep section",
  "##### Deeper section", "###### Deepest section", "## Second branch",
  "##### Skipped levels", "###### Skipped child", "### Return to child", "# Ending",
];
fs.writeFileSync(nestedFile, nestedHeadings.map(h =>
  h + "\n\n" + ("A long nested section keeps its heading above the viewport while reading.\n\n").repeat(35)).join("\n\n"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = code => {
  if (!isLiveMain() || !guardsIntact()) throw new Error("TOC driver lost the observed Main or its guards");
  return win.webContents.executeJavaScript(code);
};
const frames = () => exec("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))");
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}
async function withChooser(fixture, action) {
  if (!isLiveMain() || !guardsIntact() || chooserAllowance !== null ||
      fixture !== openFixtures[chooserCalls]) {
    throw new Error("TOC chooser scope does not match the next exact Main fixture");
  }
  const allowance = { win, fixture, consumed: false };
  chooserAllowance = allowance;
  try {
    await action();
    check("TOC scoped Main chooser consumes " + path.basename(fixture), allowance.consumed);
    if (!allowance.consumed) throw new Error("TOC fixture bypassed its scoped Main chooser");
  } finally {
    chooserAllowance = null;
  }
}
async function wait(label, expression) {
  for (let i = 0; i < 300; i++) {
    if (await exec(expression)) return;
    await sleep(50);
  }
  throw new Error("Timed out waiting for " + label);
}
async function settle() { await sleep(200); await frames(); }
async function setView(split, zoom) {
  await exec(`if(isEditMode!==${split}) document.getElementById(isEditMode ? 'exitEditBtn' : 'toggleEdit').click();true`);
  await wait("real view mode", `isEditMode===${split} && contentWrapper.classList.contains('split-view')===${split} && !loadingScreen.classList.contains('active')`);
  await exec(`zoomLevel=${zoom};updateZoom();true`);
  await sleep(600);
}
const ORACLE = `(() => {
  const s=getViewerScroller(),scale=scrollerScale(s),line=s.getBoundingClientRect().top+20*scale;
  const hs=[...viewer.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .filter(h=>h.checkVisibility({visibilityProperty:true,opacityProperty:true}))
    .map((h,i)=>({h,i,top:h.getBoundingClientRect().top})).sort((a,b)=>a.top-b.top||a.i-b.i);
  let expected=hs[0]?.h;
  for(const h of hs) if(h.top<=line+scale) expected=h.h;
  if(s.scrollHeight>s.clientHeight&&s.scrollTop>=s.scrollHeight-s.clientHeight-2) expected=hs.at(-1)?.h;
  const active=[...indexList.querySelectorAll('.index-item.active')];
  return {expected:expected?.id||null,active:active[0]?.dataset.headerId||null,
    count:active.length,current:active[0]?.getAttribute('aria-current'),top:s.scrollTop,
    max:s.scrollHeight-s.clientHeight,focus:document.activeElement?.id};
})()`;
async function oracle() { await settle(); return exec(ORACLE); }
const matches = value => value.expected === value.active && value.count === (value.expected ? 1 : 0) &&
  (!value.expected || value.current === "location");

async function run() {
  await wait("production renderer", "typeof window.CustomTabs?.getTabs === 'function' && typeof renderMarkdown === 'function'");
  win.setSize(1280, 850);
  win.focus();
  win.webContents.focus();
  await withChooser(first, async () => {
    await exec("document.getElementById('openFile').click(); true");
    await wait("actual admitted document", "viewer.querySelector('h1')?.textContent==='TOC Alpha' && viewer.querySelectorAll('.mermaid svg').length===1 && !loadingScreen.classList.contains('active')");
    await sleep(1300);
  });
  await exec("setIndexVisible(false);document.getElementById('toggleIndex').click(); true");
  let state = await oracle();
  check("TOC opens with exactly one current heading before any outline click", matches(state), state);
  const layout = await exec(`(() => {
    const p=indexPanel.getBoundingClientRect(),s=getViewerScroller().getBoundingClientRect();
    const hit=document.elementFromPoint(s.right-4,s.top+s.height/2);
    return {left:p.left,right:p.right,scrollerLeft:s.left,hitPanel:indexPanel.contains(hit),
      buttons:[...indexList.children].every(e=>e.tagName==='BUTTON'),inert:indexPanel.inert,
      expanded:toggleIndexBtn.getAttribute('aria-expanded'),label:indexPanel.getAttribute('aria-labelledby')};
  })()`);
  check("TOC is on the left beside the document with the scrollbar exposed",
    layout.left >= -1 && layout.right <= layout.scrollerLeft + 1 && !layout.hitPanel, layout);
  check("TOC exposes keyboard buttons a named navigation region and expanded state",
    layout.buttons && !layout.inert && layout.expanded === "true" && layout.label === "indexTitle", layout);

  const scrollCases = [];
  for (const split of [false, true]) {
    for (const zoom of [100, 200]) {
      await setView(split, zoom);
      for (const fraction of [0, .12, .8, .35, 1, .01]) {
        await exec(`getViewerScroller().scrollTop=(getViewerScroller().scrollHeight-getViewerScroller().clientHeight)*${fraction}; true`);
        const value = await oracle();
        scrollCases.push({ split, zoom, fraction, ...value });
      }
    }
  }
  check("TOC tracks forward backward fast jumps long sections top and end in both scrollers and zooms",
    scrollCases.every(matches) && scrollCases.every(c => c.max > 1000) &&
      scrollCases.filter(c => c.fraction === .8).every(c => c.top > 1000), scrollCases);

  await setView(false, 100);
  const work = await exec(`(async () => {
    const original=Element.prototype.getBoundingClientRect,rects=Element.prototype.getClientRects;
    let reads=0;
    function counted(el){return /^H[1-6]$/.test(el.tagName)||el.classList.contains('index-item');}
    Element.prototype.getBoundingClientRect=function(...args){if(counted(this))reads++;return original.apply(this,args);};
    Element.prototype.getClientRects=function(...args){if(counted(this))reads++;return rects.apply(this,args);};
    const focus=document.activeElement,s=getViewerScroller();
    try {
      for(let i=0;i<24;i++){
        s.scrollTop=(s.scrollHeight-s.clientHeight)*(i%8)/7;
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      }
      return {reads,sameFocus:document.activeElement===focus,top:s.scrollTop,max:s.scrollHeight-s.clientHeight};
    } finally {Element.prototype.getBoundingClientRect=original;Element.prototype.getClientRects=rects;}
  })()`);
  check("settled TOC scrolling reads no heading or outline row geometry and never moves focus",
    work.reads === 0 && work.sameFocus && work.top > work.max - 2, work);

  const clickCases = [];
  for (const split of [false, true]) {
    await setView(split, 160);
    win.focus();
    win.webContents.focus();
    await exec("indexList.querySelector('[data-header-id=\"section-35\"]').focus({preventScroll:true});true");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await sleep(900);
    clickCases.push(await oracle());
  }
  check("native Enter on a TOC button navigates and the scrolled section becomes current",
    clickCases.every(c => matches(c) && c.active === "section-35"), clickCases);

  const collapsed = await exec(`(async () => {
    const header=viewer.querySelector('#section-32');header.click();
    await new Promise(r=>setTimeout(r,250));
    const nested=viewer.querySelector('#nested-32');
    const hidden=!nested.checkVisibility();
    indexList.querySelector('[data-header-id="nested-32"]').click();
    await new Promise(r=>setTimeout(r,900));
    return {hidden,visible:nested.checkVisibility()};
  })()`);
  state = await oracle();
  check("TOC navigation expands a genuinely hidden descendant and tracks its heading",
    collapsed.hidden && collapsed.visible && matches(state) && state.active === "nested-32", { collapsed, state });

  await setView(true, 100);
  await exec(`(() => {
    const s=getViewerScroller(),h=viewer.querySelector('#section-40');
    s.scrollTop+=(h.getBoundingClientRect().top-s.getBoundingClientRect().top)/scrollerScale(s)+40;
    s.style.overflowAnchor='none';
    return true;
  })()`);
  const beforeImage = await oracle();
  await exec(`(() => {
    const img=viewer.querySelector('#toc-reflow-image');
    window.__tocImageLoaded=false;img.addEventListener('load',()=>{window.__tocImageLoaded=true;},{once:true});
    img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="3000"><rect width="300" height="3000" fill="#7a9db0"/></svg>');
    return true;
  })()`);
  await wait("real late image load", "window.__tocImageLoaded===true && viewer.querySelector('#toc-reflow-image').naturalHeight===3000");
  const afterImage = await oracle();
  check("stationary split-view image reflow changes the expected heading and refreshes the highlight",
    beforeImage.expected !== afterImage.expected && matches(afterImage), { beforeImage, afterImage });

  const equalHeight = await exec(`(async () => {
    const s=getViewerScroller(),before=viewer.querySelector('#section-8').nextElementSibling;
    const after=viewer.querySelector('#section-56').nextElementSibling;
    after.style.paddingBottom='2500px';
    await new Promise(r=>setTimeout(r,300));
    const h=viewer.querySelector('#section-40');
    s.scrollTop+=(h.getBoundingClientRect().top-s.getBoundingClientRect().top)/scrollerScale(s)+40;
    await new Promise(r=>setTimeout(r,300));
    window.__tocBeforeEqual=${ORACLE};
    const height=s.scrollHeight,client=s.clientHeight;
    after.style.paddingBottom='';before.style.paddingBottom='2500px';
    await new Promise(r=>setTimeout(r,300));
    return {height,afterHeight:s.scrollHeight,client,afterClient:s.clientHeight};
  })()`);
  const afterEqual = await oracle();
  const beforeEqual = await exec("window.__tocBeforeEqual");
  check("equal-total-height split-view reflow changes the expected heading without changing either extent",
    Math.abs(equalHeight.height - equalHeight.afterHeight) <= 1 &&
      equalHeight.client === equalHeight.afterClient &&
      beforeEqual.expected !== afterEqual.expected && matches(afterEqual), { equalHeight, beforeEqual, afterEqual });

  await exec("viewer.style.overflowAnchor='';contentWrapper.style.overflowAnchor='';true");
  const anchorCases = [];
  for (const split of [false, true]) {
    await setView(split, 130);
    await exec(`(() => {
      const s=getViewerScroller(),p=viewer.querySelector('#section-44').nextElementSibling.querySelector('p');
      const r=p.getBoundingClientRect(),sr=s.getBoundingClientRect();
      s.scrollTop+=(r.top+r.height/2-(sr.top+sr.height/2))/scrollerScale(s);
      window.__tocReadingParagraph=p;return true;
    })()`);
    await settle();
    await exec("document.getElementById('closeIndex').click();true");
    await settle();
    const closed = await exec(`(() => {
      const r=window.__tocReadingParagraph.getBoundingClientRect(),s=getViewerScroller().getBoundingClientRect();
      return Math.abs(r.top+r.height/2-(s.top+s.height/2));
    })()`);
    await exec("document.getElementById('toggleIndex').click();true");
    await settle();
    const opened = await exec(`(() => {
      const r=window.__tocReadingParagraph.getBoundingClientRect(),s=getViewerScroller().getBoundingClientRect();
      return Math.abs(r.top+r.height/2-(s.top+s.height/2));
    })()`);
    anchorCases.push({ split, closed, opened });
  }
  check("opening and closing the left drawer preserves a mid-paragraph reading position",
    anchorCases.every(c => c.closed < 24 && c.opened < 24), anchorCases);

  await exec("document.getElementById('toggleNotes').click();true");
  await settle();
  const notes = await exec("({notes:notesPanel.classList.contains('visible'),toc:indexPanel.classList.contains('visible'),inert:indexPanel.inert})");
  await exec("document.getElementById('toggleIndex').click();true");
  await settle();
  const toc = await exec("({notes:notesPanel.classList.contains('visible'),toc:indexPanel.classList.contains('visible')})");
  check("TOC and All Notes use the confirmed one-left-drawer-at-a-time behavior",
    notes.notes && !notes.toc && notes.inert && toc.toc && !toc.notes, { notes, toc });
  await exec("closeNotesPanel();setIndexVisible(true);true");

  await setView(false, 100);
  await withChooser(second, async () => {
    await exec("document.getElementById('openFile').click();true");
    await wait("other tab", "viewer.querySelector('h1')?.textContent==='TOC Other'");
  });
  state = await oracle();
  check("opening another real admitted tab replaces old TOC membership", matches(state) &&
    await exec("indexList.children.length===viewer.querySelectorAll('h1,h2,h3,h4,h5,h6').length"), state);
  await exec(`(() => {
    const tab=window.CustomTabs.getTabs().find(t=>t.filePath===${JSON.stringify(first)});
    document.querySelector('[data-tab-id="'+tab.id+'"]').click();
    return true;
  })()`);
  await wait("restored first tab DOM", "viewer.querySelector('h1')?.textContent==='TOC Alpha'");
  await sleep(1300);
  state = await oracle();
  check("returning to a tab recomputes its highlight after reading-position restoration", matches(state), state);
  fs.writeFileSync(first, markdown.replace("# TOC Alpha", "# TOC Reloaded"));
  await exec("document.getElementById('refreshBtn').click();true");
  await wait("actual reload DOM", "viewer.querySelector('h1')?.textContent==='TOC Reloaded'");
  state = await oracle();
  check("real reload refreshes heading labels and the current section", matches(state) &&
    await exec("indexList.firstElementChild.textContent==='TOC Reloaded'"), state);

  await setView(false, 100);
  win.setMinimumSize(400, 300);
  win.setSize(600, 650);
  await sleep(600);
  state = await oracle();
  const narrow = await exec(`(() => {
    const p=indexPanel.getBoundingClientRect(),s=getViewerScroller().getBoundingClientRect();
    return {width:innerWidth,panel:p.width,document:s.width,separate:p.right<=s.left+1};
  })()`);
  check("a narrow window keeps the left outline and document usable without overlap",
    narrow.separate && narrow.panel <= narrow.width * .4 + 1 && narrow.document > 200 && matches(state), { narrow, state });
  await captureScreenshot(win, "toc-left-narrow");
  win.setSize(1280, 850);
  await exec("getViewerScroller().scrollTop=0;true");
  await settle();
  await captureScreenshot(win, "toc-left-top");
  await exec("getViewerScroller().scrollTop=(getViewerScroller().scrollHeight-getViewerScroller().clientHeight)*.45;true");
  await settle();
  const visibleActive = await exec(`(() => {
    const item=indexList.querySelector('.active'),r=item?.getBoundingClientRect(),l=indexList.getBoundingClientRect();
    return {active:item?.textContent,top:r?.top,bottom:r?.bottom,listTop:l.top,listBottom:l.bottom};
  })()`);
  check("the active TOC row is revealed inside its own scrollport", visibleActive.top >= visibleActive.listTop - 1 &&
    visibleActive.bottom <= visibleActive.listBottom + 1, visibleActive);
  const beforeHeight = await oracle();
  win.setSize(1280, 550);
  await sleep(600);
  const afterHeight = await oracle();
  const afterHeightRow = await exec(`(() => {
    const item=indexList.querySelector('.active'),r=item?.getBoundingClientRect(),l=indexList.getBoundingClientRect();
    return {top:r?.top,bottom:r?.bottom,listTop:l.top,listBottom:l.bottom};
  })()`);
  check("height-only resizing keeps the same active row visible with refreshed outline bounds",
    matches(afterHeight) && beforeHeight.active === afterHeight.active &&
    afterHeightRow.top >= afterHeightRow.listTop - 1 && afterHeightRow.bottom <= afterHeightRow.listBottom + 1,
    {beforeHeight,afterHeight,afterHeightRow});
  win.setSize(1280, 850);
  await settle();
  await captureScreenshot(win, "toc-left-scrolled");
  await exec("document.getElementById('darkModeToggle').click();true");
  await sleep(800);
  await captureScreenshot(win, "toc-left-other-theme");

  await exec("indexList.querySelector('.active').focus({preventScroll:true});true");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await settle();
  const closed = await exec("({inert:indexPanel.inert,visible:indexPanel.classList.contains('visible'),focus:document.activeElement.id,expanded:toggleIndexBtn.getAttribute('aria-expanded')})");
  check("Escape closes the outline makes it inert and returns focus to the visible menu button",
    closed.inert && !closed.visible && closed.focus === "menuBtn" && closed.expanded === "false", closed);
  const hiddenWork = await exec(`(async () => {
    const original=Element.prototype.getBoundingClientRect;let reads=0;
    Element.prototype.getBoundingClientRect=function(...args){if(/^H[1-6]$/.test(this.tagName)||this.classList.contains('index-item'))reads++;return original.apply(this,args);};
    try {for(let i=0;i<12;i++){getViewerScroller().scrollTop=i*150;await new Promise(r=>requestAnimationFrame(r));}return reads;}
    finally{Element.prototype.getBoundingClientRect=original;}
  })()`);
  check("a hidden TOC performs no heading or row geometry work while scrolling", hiddenWork === 0, hiddenWork);
  await exec("document.getElementById('toggleIndex').click();true");
  state = await oracle();
  check("reopening the TOC calculates a fresh highlight at the current position", matches(state), state);
  await withChooser(nestedFile, async () => {
    await exec("document.getElementById('openFile').click();true");
    await wait("admitted mixed-level fixture", "viewer.querySelector('h1')?.textContent==='Multi outline' && !loadingScreen.classList.contains('active')");
    await sleep(1300);
  });
  const hierarchy = await exec(`Array.from({length:6},(_,i)=>{
    const level=i+1,headers=[...viewer.querySelectorAll('h'+level)],rows=[...indexList.querySelectorAll('.level-'+level)];
    return {level,headers:headers.length,rows:rows.length,padding:rows.map(r=>parseFloat(getComputedStyle(r).paddingLeft))};
  })`);
  check("mixed-level TOC preserves every H1-H6 heading and its hierarchy indentation",
    hierarchy.every(h=>h.headers>0 && h.headers===h.rows && h.padding.every(p=>p===h.level*12)), hierarchy);
  const nestedCases = [];
  for (const split of [false, true]) {
    for (const zoom of [100, 200]) {
      await setView(split, zoom);
      for (const id of ["multi-outline","parent","nested-child","deep-section","deeper-section","deepest-section",
        "skipped-levels","skipped-child","return-to-child","parent","deepest-section","nested-child"]) {
        await exec(`(() => {
          const h=viewer.querySelector('#'+${JSON.stringify(id)}),s=getViewerScroller();
          s.scrollTop+=(h.getBoundingClientRect().top-s.getBoundingClientRect().top)/scrollerScale(s)-18;
          return true;
        })()`);
        nestedCases.push({split,zoom,id,...await oracle()});
      }
      const gap = await exec(`(() => {
        const h=viewer.querySelector('#deepest-section'),s=getViewerScroller();
        s.scrollTop+=(h.getBoundingClientRect().top-s.getBoundingClientRect().top)/scrollerScale(s)+250;
        return {headingTop:h.getBoundingClientRect().top,scrollerTop:s.getBoundingClientRect().top};
      })()`);
      nestedCases.push({split,zoom,id:"deepest-section",longGap:gap,...await oracle()});
    }
  }
  check("mixed-level tracking follows actual H1-H6 headings forward backward and by jumps across skipped levels and long sections",
    nestedCases.every(c=>matches(c) && c.active===c.id) && nestedCases.filter(c=>c.longGap).length===4 &&
    nestedCases.filter(c=>c.longGap).every(c=>c.longGap.headingTop<c.longGap.scrollerTop), nestedCases);
  await setView(false, 100);
  const nestedClicks = [];
  for (const id of ["multi-outline","parent","nested-child","deep-section","deeper-section","deepest-section","skipped-levels","skipped-child"]) {
    await exec(`indexList.querySelector('[data-header-id="${id}"]').click();true`);
    nestedClicks.push({id,...await oracle()});
  }
  check("mixed-level TOC clicks keep H1-H6 and skipped-level targets current",
    nestedClicks.every(c=>matches(c) && c.active===c.id), nestedClicks);
  await withChooser(tailFile, async () => {
    await exec("document.getElementById('openFile').click();true");
    await wait("admitted tail fixture", "viewer.querySelector('h1')?.textContent==='End fixture' && !loadingScreen.classList.contains('active')");
    await sleep(1300);
  });
  const tailCases = [];
  for (const split of [false, true]) {
    for (const zoom of [100, 200]) {
      await setView(split, zoom);
      await exec("getViewerScroller().scrollTop=getViewerScroller().scrollHeight;true");
      tailCases.push({split,zoom,...await oracle()});
    }
  }
  check("a short final section becomes current at the actual bottom in both scrollers and zooms",
    tailCases.every(c => matches(c) && c.active === "final-tail" && c.max > 1000), tailCases);
  await setView(false, 100);
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "print" });
  const print = await exec("({margin:getComputedStyle(contentWrapper).marginLeft,panel:getComputedStyle(indexPanel).display})");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "" });
  win.webContents.debugger.detach();
  check("printing with the TOC open hides the drawer without reserving blank left space",
    print.margin === "0px" && print.panel === "none", print);
  await exec("renderMarkdown('Plain document without headings.','full')");
  await settle();
  check("a no-heading render clears stale TOC entries and current state",
    await exec("indexList.querySelectorAll('.index-item,.active,[aria-current]').length===0 && !!indexList.querySelector('.index-empty')"));
  await exec("renderMarkdown('# Short\\n\\nShort body.','full')");
  state = await oracle();
  check("a short nonoverflowing document still has one correct current heading", matches(state), state);
  await exec("viewer.replaceChildren(document.createTextNode('Unavailable preview'));true");
  await settle();
  check("direct error-style DOM replacement retires old headings without a render handoff",
    await exec("!indexList.querySelector('.index-item,.active,[aria-current]')"));
  const alive = await proveSentinelAlive(win, sentinel);
  check("TOC error sentinel detects both deliberately provoked channels", alive.console && alive.dom, alive);
}

async function bounded(action, label, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function finish(error) {
  if (finishing) return failUnattended(new Error("TOC ordinary finish was entered twice"));
  finishing = true;
  if (!guardsIntact()) return failUnattended(new Error("TOC terminal path lost an unattended guard"));
  let keepalive = null;
  let destructionConfirmed = false;
  let sentinelReported = false;
  let released = false;
  try {
    check("TOC harness reaches completion", completed && !error,
      error ? String(error.stack || error) : "scenario sequence did not complete");
    if (error) {
      try {
        console.log("TOC diagnostic", await bounded(() => exec("({heading:viewer.querySelector('h1')?.textContent,edit:contentWrapper.className,active:window.CustomTabs.getActiveTabId(),tabs:window.CustomTabs.getTabs().map(t=>({id:t.id,name:t.filename,dirty:t.hasUnsavedChanges}))})"),
          "TOC failure diagnostic", 1500));
      } catch (diagnosticError) {
        check("TOC failure diagnostic completed", false, String(diagnosticError.stack || diagnosticError));
      }
      try {
        if (win && !win.isDestroyed()) {
          await bounded(() => captureScreenshot(win, "toc-FAILED"), "TOC failure capture", 1500);
        }
      } catch (captureError) {
        check("TOC failure capture completed", false, String(captureError.stack || captureError));
      }
    }
  } finally {
    // Leave the listener alive across destruction; queued teardown errors belong
    // to this run, not to a clean transcript printed before its owner disappears.
    try {
      if (!sentinel || !isLiveMain()) throw new Error("TOC lost its live observed Main sentinel");
      await bounded(() => sentinel.drain(), "TOC live sentinel drain", 12000);
    } catch (drainError) {
      check("TOC live sentinel drain completed", false, String(drainError.stack || drainError));
    }
    try {
      if (!observedMain || !observedContents) throw new Error("TOC Main destruction cannot be verified");
      keepalive = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      const windowGone = observedMain.isDestroyed() ? Promise.resolve() :
        new Promise(resolve => observedMain.once("closed", resolve));
      const contentsGone = observedContents.isDestroyed() ? Promise.resolve() :
        new Promise(resolve => observedContents.once("destroyed", resolve));
      if (!observedMain.isDestroyed()) observedMain.destroy();
      await bounded(() => Promise.all([windowGone, contentsGone]), "TOC Main destruction", 5000);
      await bounded(() => new Promise(resolve => setImmediate(resolve)), "TOC queued teardown diagnostics", 1500);
      destructionConfirmed = observedMain.isDestroyed() && observedContents.isDestroyed();
      if (keepalive.isDestroyed()) throw new Error("TOC teardown keepalive was lost");
    } catch (destructionError) {
      check("TOC owned Main teardown completed", false, String(destructionError.stack || destructionError));
    }
    check("TOC observed Main and webContents are destroyed before fixture release", destructionConfirmed);
    try {
      if (!destructionConfirmed || !sentinel) throw new Error("TOC sentinel cannot report after unconfirmed Main destruction");
      const errors = await bounded(() => sentinel.stop(), "TOC sentinel stop after destruction", 12000);
      check("TOC scenarios introduce no renderer or visible document errors", errors.hits.length === 0, errors.hits);
      check("TOC error sentinel has zero stalls", errors.stalls.length === 0, errors.stalls);
      const mute = errors.mutes[0];
      check("TOC error sentinel mutes only its exact console and DOM liveness probes",
        errors.mutes.length === 1 && mute.reason === LIVENESS_MUTE_REASON &&
        mute.suppressed.length === 2 &&
        mute.suppressed.some(hit => hit.kind === "console-error" &&
          /^sentinel-liveness-probe-\d+ @ /.test(hit.detail)) &&
        mute.suppressed.some(hit => hit.kind === "error-text-on-screen" &&
          hit.detail === "top: Syntax error in text") && sentinel.currentMute() === null, errors.mutes);
      sentinelReported = true;
    } catch (sentinelError) {
      check("TOC sentinel reports through owned Main destruction", false, String(sentinelError.stack || sentinelError));
    }
    try {
      if (destructionConfirmed) {
        registeredTempDirs.add(directory);
        released = releaseTempDir(directory) === true;
        if (released) directory = null;
      } else {
        registeredTempDirs.delete(directory);
      }
      check("TOC watched fixture is released only after confirmed owner destruction", released,
        destructionConfirmed ? "releaseTempDir returned false; safe shared sweeps may retry: " + directory :
          "retained unsafe fixture outside both shared sweeps: " + directory);
    } catch (releaseError) {
      check("TOC watched fixture release completed", false, String(releaseError.stack || releaseError));
    }
    check("TOC retains native, Main-owned and shell guards through teardown", guardsIntact());
    check("TOC consumes only the four scoped fixture choosers and leaves none armed",
      chooserCalls === openFixtures.length && chooserAllowance === null, { chooserCalls });
    cleanExit = completed && !error && destructionConfirmed && sentinelReported && released &&
      !!keepalive && !keepalive.isDestroyed() && results.length > 0 && results.every(r => r.ok);
    if (summaryWritten) return failUnattended(new Error("TOC terminal summary was already written"));
    summaryWritten = true;
    console.log(`=== ${results.filter(r => r.ok).length}/${results.length} passed ===`);
    ordinaryExiting = true;
    clearTimeout(watchdog);
    app.exit(cleanExit ? 0 : 1);
  }
}

app.whenReady().then(async () => {
  let error = null;
  try {
    await sleep(1800);
    win = BrowserWindow.getAllWindows()[0];
    check("TOC observes the actual live Main window from creation",
      noPreexistingWindows && isLiveMain() && !!sentinel);
    if (!isLiveMain() || !sentinel) throw new Error("TOC Main window was not observed from creation");
    check("TOC retains its unattended guards before scenarios", guardsIntact());
    if (!guardsIntact()) throw new Error("TOC unattended guards were replaced");
    await run();
    completed = true;
  } catch (caught) {
    error = caught;
  }
  await finish(error);
}).catch(failUnattended);
