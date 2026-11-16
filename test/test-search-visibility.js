// Owned renderer fixture: no application entry, Main, preload, or saved profile.
// Run: electron test/test-search-visibility.js [--artifacts=<existing directory>]
const fs = require("fs");
const os = require("os");
const path = require("path");
let app;
let win;
let finished = false;
const results = [];
function fatal(error) {
  finished = true;
  fs.writeSync(2, `${error.stack || error}\n`);
  if (app?.isReady()) fs.writeSync(2, `Owned process IDs: ${app.getAppMetrics().map(metric => metric.pid).join(",")}\n`);
  process.exitCode = 1;
  if (win && !win.isDestroyed()) win.destroy();
  if (app) app.exit(1);
  else process.exit(1);
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
const deadline = setTimeout(() => fatal(new Error("Search visibility fixture exceeded 90s")), 90000);
const { app: electronApp, BrowserWindow, session } = require("electron");
app = electronApp;
const root = path.join(__dirname, "..");
const artifactArg = process.argv.find(arg => arg.startsWith("--artifacts="));
const runDir = fs.mkdtempSync(path.join(artifactArg ? artifactArg.slice(12) : os.tmpdir(),
  "markaloo-search-visibility-"));
const profile = path.join(runDir, "profile");
fs.mkdirSync(profile);
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.disableHardwareAcceleration();

function between(source, first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start + first.length);
  if (start < 0 || end < 0 || source.indexOf(first, start + first.length) >= 0 ||
      source.indexOf(last, end + last.length) >= 0) {
    throw new Error(`Missing or ambiguous source slice: ${first}`);
  }
  return source.slice(start, end);
}
const renderer = fs.readFileSync(path.join(root, "src", "renderer.js"), "utf8").replace(/\r\n/g, "\n");
const index = fs.readFileSync(path.join(root, "src", "index.html"), "utf8").replace(/\r\n/g, "\n");
const styles = ["styles.css", "custom-styles.css"]
  .map(name => fs.readFileSync(path.join(root, "src", name), "utf8")).join("\n");
const searchMarkup = between(index, '      <div class="search-anchor">', '      <div class="main-content">');
const searchSource = between(renderer, "// Search functionality\n", "// Index/TOC functionality");
const scrollSource = between(renderer, "function getViewerScroller() {", "// Scroll a rendered element into view.");
const navigationSource = between(renderer, "function captureReadingJump(target) {", "// Current file tracking");
const viewportSource = fs.readFileSync(path.join(root, "src", "reading-viewport.js"), "utf8");
const lifecycleSource = between(renderer, "function createReadingViewportLifecycle() {",
  "window.readingViewport = readingViewport;");
const trackerSource = between(renderer, "const tableHeaderTracking = (() => {", "// Collapsed state, persisted");
const shortcuts = between(renderer, "document.addEventListener('keydown', (e) => {\n  if (handleReadingHistoryShortcut(e))",
  "// Mouse wheel zoom");

function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + detail}`);
}
async function exec(code) {
  if (!win || win.isDestroyed()) throw new Error("Owned fixture window is unavailable");
  return win.webContents.executeJavaScript(code, true);
}
async function waitFor(code, label) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    if (await exec(code)) return;
    await new Promise(resolve => setTimeout(resolve, 16));
  }
  throw new Error(`Timed out: ${label}`);
}
async function settled() {
  await waitFor(`(() => {
    return ![searchPanel, document.getElementById('indexPanel')].some(element =>
      element.getAnimations().some(animation => animation.playState === 'running'));
  })()`, "search transition completion");
  await exec("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await exec("true");
}
async function ctrlF() {
  const wasVisible = await exec("searchPanel.classList.contains('visible')");
  await key("f", ["control"]);
  await waitFor(`searchPanel.classList.contains('visible') === ${!wasVisible}`, "Ctrl+F toggle delivery");
}
async function click(x, y) {
  win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(x), y: Math.round(y),
    button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(x), y: Math.round(y),
    button: "left", clickCount: 1 });
  await exec("true");
}
async function centerClick(id) {
  const point = await exec(`(() => {
    const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await click(point.x, point.y);
}
async function closedCase(route) {
  await exec(`if (searchPanel.classList.contains('visible')) toggleSearchPanel(); true`);
  await ctrlF();
  await settled();
  check(`${route}: opening focuses search`, await exec("document.activeElement === searchInput"));
  await win.webContents.insertText("needle");
  const setup = await exec(`searchInput.value === 'needle' && pendingSearchTerm === 'needle' &&
    window.fixtureInputs > 0`);
  check(`${route}: native typing arms a pending search`, setup);
  if (!setup) throw new Error(`${route}: typing prerequisite failed`);
  if (route === "Ctrl+F") await ctrlF();
  else if (route === "Escape") await key("Escape");
  else await centerClick("searchClose");
  const closed = await exec(`({
    hidden: !searchPanel.classList.contains('visible'),
    focusOutside: !searchPanel.contains(document.activeElement),
    empty: searchInput.value === '',
    cancelled: pendingSearchTerm === null && searchDebounceTimer === null && searchMatches.length === 0
  })`);
  check(`${route}: close clears and cancels search`, closed.hidden && closed.empty && closed.cancelled,
    JSON.stringify(closed));
  check(`${route}: closing releases panel focus`, closed.focusOutside, JSON.stringify(closed));
  const before = await exec("window.fixtureInputs");
  await win.webContents.insertText("ghost");
  await new Promise(resolve => setTimeout(resolve, 220));
  check(`${route}: hidden search cannot receive typing`, await exec(`searchInput.value === '' &&
    window.fixtureInputs === ${before} && pendingSearchTerm === null && searchMatches.length === 0`));
  await exec("searchInput.focus(); true");
  check(`${route}: hidden input cannot regain focus`, await exec("document.activeElement !== searchInput"));
  await settled();
  await exec("document.getElementById('beforeSearch').focus(); true");
  await key("Tab");
  check(`${route}: Tab skips closed search`, await exec("document.activeElement.id === 'afterSearch'"),
    await exec("document.activeElement.id"));
  await key("Tab", ["shift"]);
  check(`${route}: Shift+Tab skips closed search`, await exec("document.activeElement.id === 'beforeSearch'"),
    await exec("document.activeElement.id"));
}
async function geometry() {
  return exec(`(() => {
    const box = element => {
      const r = element.getBoundingClientRect();
      return { top:r.top, bottom:r.bottom, left:r.left, right:r.right, height:r.height, width:r.width };
    };
    const s = getViewerScroller(), header = viewer.querySelector('thead');
    return { panel:box(searchPanel), main:box(document.querySelector('.main-content')),
      toolbar:box(document.querySelector('.header')), port:box(s), header:box(header),
      table:box(viewer.querySelector('table')), host:box(document.querySelector('.search-anchor')),
      input:box(searchInput), scroll:s.scrollTop, owner:s===viewer?'viewer':'wrapper',
      translation:new DOMMatrixReadOnly(getComputedStyle(header).transform).m42,
      sameHeader:header===window.fixtureOriginalHeader };
  })()`);
}
async function capture(name) {
  if (artifactArg) await fs.promises.writeFile(path.join(runDir, `${name}.png`),
    (await win.webContents.capturePage()).toPNG());
}
async function stickyCase(split, zoom) {
  const label = `${split ? "Split" : "Reader"} ${zoom}%`;
  await exec(`if (searchPanel.classList.contains('visible')) toggleSearchPanel();
    contentWrapper.classList.toggle('split-view', ${split});
    viewer.style.zoom = ${zoom / 100};
    contentWrapper.scrollTop = 0; viewer.scrollTop = 0;
    tableHeaderTracking.invalidate(); true`);
  await settled();
  const natural = await geometry();
  check(`${label}: natural header and actual scroll owner are established`,
    natural.translation === 0 && natural.header.top > natural.port.top &&
    natural.owner === (split ? "viewer" : "wrapper"), JSON.stringify(natural));
  await exec(`getViewerScroller().scrollTop = 600; true`);
  await waitFor(`(() => {
    const header = viewer.querySelector('thead');
    return getViewerScroller().scrollTop > 100 && header.getAnimations().length > 0 &&
      new DOMMatrixReadOnly(getComputedStyle(header).transform).m42 > 100;
  })()`, `${label} production sticky header`);
  await ctrlF();
  await settled();
  const pinned = await geometry();
  check(`${label}: original sticky header is active at the real scrollport`,
    pinned.scroll > 100 && pinned.translation > 100 && pinned.sameHeader &&
    Math.abs(pinned.header.top - pinned.port.top) < 2, JSON.stringify(pinned));
  check(`${label}: readable viewport and sticky header start below search`,
    Math.abs(pinned.main.top - pinned.panel.bottom) < 1 &&
    pinned.port.top >= pinned.panel.bottom - 1 && pinned.header.top >= pinned.panel.bottom - 1,
    JSON.stringify(pinned));
  await capture(`search-sticky-${split ? "split" : "reader"}-${zoom}`);
  const padding = await exec(`({
    top:parseFloat(getComputedStyle(searchPanel).paddingTop),
    bottom:parseFloat(getComputedStyle(searchPanel).paddingBottom),
    input:searchInput.getBoundingClientRect().height,
    buttons:[searchPrevBtn,searchNextBtn,searchCloseBtn].map(button=>button.getBoundingClientRect().height)
  })`);
  check(`${label}: compact bar reduces outer padding without shrinking controls`,
    padding.top <= 6 && padding.bottom <= 6 && padding.input >= 34 &&
    padding.buttons.every(height => height >= 30), JSON.stringify(padding));
  check(`${label}: search and sticky header are independently hit-testable`, await exec(`(() => {
    const input=searchInput.getBoundingClientRect(), h=viewer.querySelector('thead').getBoundingClientRect();
    return document.elementFromPoint(input.left+input.width/2,input.top+input.height/2)===searchInput &&
      !!document.elementFromPoint(Math.max(h.left,getViewerScroller().getBoundingClientRect().left)+20,
        h.top+h.height/2)?.closest('thead');
  })()`));
  const aligned = await exec(`(() => {
    const wrap=viewer.querySelector('.table-container');wrap.scrollLeft=80;
    const h=viewer.querySelector('th').getBoundingClientRect(), d=viewer.querySelector('td').getBoundingClientRect();
    return {offset:wrap.scrollLeft,overflow:wrap.scrollWidth>wrap.clientWidth,
      delta:Math.abs(h.left-d.left),width:Math.abs(h.width-d.width)};
  })()`);
  check(`${label}: horizontal overflow keeps original header and cells aligned`,
    aligned.overflow && aligned.offset > 0 && aligned.delta < 1 && aligned.width < 1, JSON.stringify(aligned));
  await exec("viewer.querySelector('.table-container').scrollLeft=0; true");
  const work = await exec(`(async () => {
    const original=Element.prototype.getBoundingClientRect, query=Element.prototype.querySelectorAll;
    let geometry=0,scans=0;
    Element.prototype.getBoundingClientRect=function(...args){geometry++;return original.apply(this,args)};
    Element.prototype.querySelectorAll=function(...args){if(this===viewer)scans++;return query.apply(this,args)};
    try { for(let i=0;i<12;i++){
      getViewerScroller().scrollTop=620+i*10;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    } return {geometry,scans}; }
    finally {Element.prototype.getBoundingClientRect=original;Element.prototype.querySelectorAll=query;}
  })()`);
  check(`${label}: settled scrolling adds no geometry reads or viewer scans`,
    work.geometry === 0 && work.scans === 0, JSON.stringify(work));
  await exec("document.getElementById('beforeSearch').focus(); window.fixtureClicks = []; true");
  await centerClick("searchInput");
  check(`${label}: click reaches and focuses search`, await exec(`document.activeElement === searchInput &&
    window.fixtureClicks.includes('searchInput')`), await exec("JSON.stringify(window.fixtureClicks)"));
  await exec("searchInput.focus(); true");
  await win.webContents.insertText("needle");
  await waitFor("searchMatches.length > 0 && pendingSearchTerm === null", "search highlights");
  check(`${label}: visible search still highlights text`, await exec(`viewer.querySelectorAll('.search-highlight').length === 1`));
  const navigation = await exec(`(() => {
    const s=getViewerScroller(), r=s.getBoundingClientRect(), hit=searchMatches[0].getBoundingClientRect();
    return {portTop:r.top,portBottom:r.bottom,hitTop:hit.top,hitBottom:hit.bottom,
      panelBottom:searchPanel.getBoundingClientRect().bottom,jumps:window.fixtureJumps};
  })()`);
  check(`${label}: shipping search navigation centers inside the readable viewport`,
    navigation.jumps > 0 && navigation.hitTop >= navigation.panelBottom &&
    Math.abs((navigation.hitTop+navigation.hitBottom)/2 -
      (navigation.portTop+navigation.portBottom+20*(split ? zoom/100 : 1))/2) < 2,
    JSON.stringify(navigation));
  await exec("scrollElementIntoView(document.getElementById('destination')); true");
  const destination = await exec(`(() => {
    const s=getViewerScroller(), h=document.getElementById('destination').getBoundingClientRect();
    return {top:h.top,port:s.getBoundingClientRect().top,panel:searchPanel.getBoundingClientRect().bottom};
  })()`);
  check(`${label}: shipping heading navigation respects the same readable top and gap`,
    destination.top >= destination.panel &&
    Math.abs(destination.top-destination.port-20*(split ? zoom/100 : 1)) < 2, JSON.stringify(destination));
  await exec(`getViewerScroller().scrollTop=600; true`);
  await settled();
  await exec("toggleSearchPanel(); true");
  await settled();
  const hidden = await geometry();
  check(`${label}: closing while scrolled restores the full viewport without a gap`,
    hidden.scroll === 600 && hidden.host.height === 0 &&
    Math.abs(hidden.main.top-hidden.toolbar.bottom) < 1 &&
    Math.abs(hidden.header.top-hidden.port.top) < 2, JSON.stringify(hidden));
  await capture(`search-closed-${split ? "split" : "reader"}-${zoom}`);
  await exec(`toggleSearchPanel(); toggleSearchPanel(); toggleSearchPanel(); true`);
  await settled();
  const reopened = await geometry();
  check(`${label}: rapid reopen updates the pinned readable boundary`,
    Math.abs(reopened.header.top-reopened.panel.bottom) < 2, JSON.stringify(reopened));
  await exec(`{ const s=getViewerScroller(), head=viewer.querySelector('thead').getBoundingClientRect();
    s.scrollTop+=(viewer.querySelector('table').getBoundingClientRect().bottom-
      s.getBoundingClientRect().top-head.height/2)/scrollerScale(s); } true`);
  await settled();
  const edge = await geometry();
  check(`${label}: lower table edge pushes the sticky header out without overrun`,
    edge.translation > 0 && edge.header.top < edge.port.top &&
    Math.abs(edge.header.bottom-edge.table.bottom) < 2, JSON.stringify(edge));
  await exec(`{ const s=getViewerScroller();
    s.scrollTop+=(viewer.querySelector('table').getBoundingClientRect().bottom-
      s.getBoundingClientRect().top)/scrollerScale(s)+50; } true`);
  await settled();
  const end = await geometry();
  check(`${label}: sticky header releases after the table bottom`,
    end.table.bottom < end.port.top && end.translation === 0 && end.header.bottom < end.port.top,
    JSON.stringify(end));
  await exec("getViewerScroller().scrollTop=0; true");
  await settled();
  check(`${label}: returning above the table restores its natural header`, (await geometry()).translation === 0);
}

async function responsiveCases() {
  await exec(`contentWrapper.classList.remove('split-view'); viewer.style.zoom=1;
    if(!searchPanel.classList.contains('visible'))toggleSearchPanel();
    getViewerScroller().scrollTop=600; true`);
  await settled();
  const wide = await geometry();
  win.setContentSize(240, 600);
  await settled();
  const narrow = await geometry();
  check("narrow layout wraps controls and moves the real readable boundary",
    narrow.panel.height > wide.panel.height && narrow.port.height > 100 &&
    Math.abs(narrow.panel.bottom-narrow.port.top) < 1 &&
    Math.abs(narrow.header.top-narrow.port.top) < 2, JSON.stringify({wide,narrow}));
  await capture("search-narrow");
  await exec("document.getElementById('indexPanel').classList.add('visible'); true");
  await settled();
  await exec("document.getElementById('indexPanel').classList.remove('visible'); toggleSearchPanel(); true");
  const midClose = await exec(`new Promise(resolve=>requestAnimationFrame(()=>{
    toggleSearchPanel();
    const drawer=document.getElementById('indexPanel'), animation=drawer.getAnimations()[0];
    resolve({running:animation?.playState==='running',
      inset:searchPanel.getBoundingClientRect().left,edge:drawer.getBoundingClientRect().right});
  }))`);
  check("search reopening during a real drawer close retains its live horizontal inset",
    midClose.running && midClose.inset >= midClose.edge - 1, JSON.stringify(midClose));
  await settled();
  check("drawer closure releases its search inset without leaving a vertical gap", await exec(`(() => {
    const p=searchPanel.getBoundingClientRect(), main=document.querySelector('.main-content').getBoundingClientRect();
    return p.left===0 && Math.abs(main.top-p.bottom)<1;
  })()`));
  await exec("contentWrapper.classList.add('split-view'); true");
  await settled();
  check("source controls and textarea start below the actual search bar", await exec(`(() => {
    const p=searchPanel.getBoundingClientRect(), editor=document.querySelector('.editor-panel');
    editor.querySelector('textarea').focus();
    return editor.getBoundingClientRect().top>=p.bottom &&
      editor.querySelector('.editor-header').getBoundingClientRect().top>=p.bottom &&
      document.activeElement===editor.querySelector('textarea');
  })()`));
  win.setContentSize(240, 90);
  await settled();
  const short = await exec(`({
    height:searchPanel.clientHeight,overflow:searchPanel.scrollHeight>searchPanel.clientHeight,
    bottom:searchPanel.getBoundingClientRect().bottom,viewport:innerHeight
  })`);
  check("very short windows keep search overflow inside the available workspace",
    short.height >= 37 && short.overflow && short.bottom <= short.viewport + 1, JSON.stringify(short));
  const reached = [];
  for (const id of ["searchInput", "searchPrev", "searchNext", "searchClose"]) {
    reached.push(await exec(`(() => {
      const el=document.getElementById(${JSON.stringify(id)}), r=el.getBoundingClientRect(),
        p=searchPanel.getBoundingClientRect();
      const before=[contentWrapper.scrollTop,viewer.scrollTop,scrollY];
      searchPanel.scrollTop+=r.top<p.top?r.top-p.top:r.bottom>p.bottom?r.bottom-p.bottom:0;
      const box=el.getBoundingClientRect(), port=searchPanel.getBoundingClientRect();
      return box.top>=port.top-1 && box.bottom<=port.bottom+1 &&
        before.every((value,i)=>value===[contentWrapper.scrollTop,viewer.scrollTop,scrollY][i]) &&
        el.contains(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2));
    })()`));
  }
  check("short-window local search scrolling reaches every complete control", reached.every(Boolean), JSON.stringify(reached));
  win.setContentSize(1000, 720);
  await settled();
  win.webContents.debugger.attach("1.3");
  try {
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media:"print" });
    check("print retains the non-grid shell and hides search chrome", await exec(`(() => {
      return getComputedStyle(document.querySelector('body > .container')).display==='flex' &&
        getComputedStyle(searchPanel).display==='none' &&
        document.querySelector('.search-anchor').getBoundingClientRect().height===0;
    })()`));
  } finally {
    await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media:"" });
    win.webContents.debugger.detach();
  }
}

app.whenReady().then(async () => {
  const privateSession = session.fromPartition(`search-visibility-${process.pid}`);
  let fixtureURL = "";
  privateSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== fixtureURL }));
  const errors = [];
  console.log(`Owned Electron PID: ${process.pid}`);
  win = new BrowserWindow({ width: 1000, height: 720, show: false,
    title: "Markaloo owned search fixture", webPreferences: {
      session: privateSession, contextIsolation: true, sandbox: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false,
    } });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  win.webContents.on("render-process-gone", (_event, details) => fatal(new Error(details.reason)));
  win.on("closed", () => { if (!finished) fatal(new Error("Owned search fixture closed early")); });
  win.webContents.on("console-message", details => {
    if (details.level === "error") errors.push(details.message);
  });
  const rows = Array.from({ length: 60 }, (_, i) => `<tr><td>Row ${i}</td><td>Table text ${i}</td></tr>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><style>${styles}</style>
    <div class="container">
      <div class="header"><button id="beforeSearch">Owned fixture toolbar</button></div>
      ${searchMarkup}
      <div class="main-content"><div class="content-wrapper">
        <aside id="indexPanel" class="index-panel"></aside>
        <div class="editor-panel"><div class="editor-header">Source controls</div><textarea aria-label="Fixture source"></textarea></div>
        <div id="viewer" class="markdown-body"><button id="afterSearch">Document control</button>
          <p>Owned synthetic document</p><div class="table-container"><table style="min-width:1200px">
          <thead><tr><th>Sticky table header</th><th>Details</th></tr></thead>
          <tbody>${rows}</tbody></table></div><h2 id="destination">Navigation destination</h2>
          <p>needle</p><div style="height:1200px">Document end</div></div>
      </div></div>
    </div>`;
  // No scripts, links, app preload or production Main can run in this document.
  fixtureURL = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  await win.loadURL(fixtureURL);
  await exec(`
    const viewer = document.getElementById('viewer');
    const contentWrapper = document.querySelector('.content-wrapper');
    const searchPanel = document.getElementById('searchPanel');
    const searchInput = document.getElementById('searchInput');
    const searchCounter = document.getElementById('searchCounter');
    const searchPrevBtn = document.getElementById('searchPrev');
    const searchNextBtn = document.getElementById('searchNext');
    const searchCloseBtn = document.getElementById('searchClose');
    const TIMING = { searchDebounceDelay: 150 };
    ${viewportSource}
    ${lifecycleSource}
    const editorScroll = { previewNavigation() {} };
    window.fixtureJumps = 0;
    const readingHistory = { endSearch() {}, beginTyping() {}, sync() {},
      async jump(target, block, intent) {
        window.fixtureJumps++;
        const request=scrollElementIntoView(target,block,intent);
        if(request?.completion) await request.completion;
      }
    };
    const tableColumnSizing = { refresh() {} };
    function handleReadingHistoryShortcut() { return false; }
    function reportReadingHistoryError(error) { throw error; }
    function i18n(key, args) { return args ? args.current + ' of ' + args.total : '0 of 0'; }
    function escapeRegex(value) { return value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); }
    window.fixtureInputs = 0;
    window.fixtureClicks = [];
    searchInput.addEventListener('input', () => window.fixtureInputs++);
    document.addEventListener('click', event => window.fixtureClicks.push(event.target.id));
    ${scrollSource}
    ${navigationSource}
    ${searchSource}
    ${trackerSource}
    ${shortcuts}
    window.fixtureOriginalHeader=viewer.querySelector('thead');
    true;
  `);
  win.webContents.focus();
  await exec(`console.error('search-visibility-sentinel'); true`);
  check("renderer error sentinel is live", errors.includes("search-visibility-sentinel"));
  errors.length = 0;
  check("owned fixture uses a private profile and ephemeral session",
    app.getPath("userData") === profile && privateSession.isPersistent() === false);
  await exec("document.getElementById('beforeSearch').focus(); true");
  await key("Tab");
  check("initially closed search is skipped by Tab", await exec("document.activeElement.id === 'afterSearch'"),
    await exec("document.activeElement.id"));
  await exec("searchInput.focus(); true");
  check("initially closed search rejects focus", await exec("document.activeElement !== searchInput"));
  for (const route of ["Ctrl+F", "Escape", "Close button"]) await closedCase(route);
  await exec(`if (searchPanel.classList.contains('visible')) toggleSearchPanel();
    toggleSearchPanel(); toggleSearchPanel(); toggleSearchPanel(); true`);
  check("rapid reopen leaves visible search focused", await exec(`searchPanel.classList.contains('visible') &&
    !searchPanel.inert && document.activeElement === searchInput`));
  await exec("toggleSearchPanel(); toggleSearchPanel(); toggleSearchPanel(); true");
  check("rapid final close releases search focus", await exec(`!searchPanel.classList.contains('visible') &&
    !searchPanel.contains(document.activeElement)`));
  await exec(`toggleSearchPanel(); document.getElementById('beforeSearch').focus(); true`);
  await ctrlF();
  check("closing search preserves focus outside its panel", await exec(`!searchPanel.classList.contains('visible') &&
    document.activeElement === document.getElementById('beforeSearch')`));
  for (const split of [false, true]) for (const zoom of [100, 200]) await stickyCase(split, zoom);
  await responsiveCases();
  check("fixture has no unexpected renderer errors", errors.length === 0, JSON.stringify(errors));
  await fs.promises.writeFile(path.join(runDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Artifacts: ${runDir}`);
  console.log(`Owned process IDs: ${app.getAppMetrics().map(metric => metric.pid).join(",")}`);
  console.log(`=== ${results.filter(result => result.ok).length} passed, ${results.filter(result => !result.ok).length} failed ===`);
  finished = true;
  clearTimeout(deadline);
  win.destroy();
  app.exit(results.every(result => result.ok) ? 0 : 1);
}).catch(fatal);
