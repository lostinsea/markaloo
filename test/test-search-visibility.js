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
const deadline = setTimeout(() => fatal(new Error("Search visibility fixture exceeded 45s")), 45000);
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
    const transform = new DOMMatrixReadOnly(getComputedStyle(searchPanel).transform);
    const targetY = searchPanel.classList.contains('visible') ? 0 : -searchPanel.getBoundingClientRect().height;
    return Math.abs(transform.m42 - targetY) < 0.1 &&
      !searchPanel.getAnimations().some(animation => animation.playState === 'running');
  })()`, "search transition completion");
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
async function stickyCase(split) {
  const label = split ? "Split" : "Reader";
  await exec(`if (searchPanel.classList.contains('visible')) toggleSearchPanel();
    contentWrapper.classList.toggle('split-view', ${split});
    contentWrapper.scrollTop = 0; viewer.scrollTop = 0;
    tableHeaderTracking.invalidate(); true`);
  await settled();
  await exec(`getViewerScroller().scrollTop = 240; true`);
  await waitFor(`(() => {
    const header = viewer.querySelector('thead');
    return getViewerScroller().scrollTop > 100 && header.getAnimations().length > 0 &&
      new DOMMatrixReadOnly(getComputedStyle(header).transform).m42 > 100;
  })()`, `${label} production sticky header`);
  await ctrlF();
  await settled();
  const overlap = await exec(`(() => {
    const header = viewer.querySelector('thead'), h = header.getBoundingClientRect();
    const input = searchInput.getBoundingClientRect();
    const left = Math.max(h.left, input.left), right = Math.min(h.right, input.right);
    const top = Math.max(h.top, input.top), bottom = Math.min(h.bottom, input.bottom);
    const x = (left + right) / 2, y = (top + bottom) / 2;
    return { width: right - left, height: bottom - top, x, y,
      top: document.elementFromPoint(x, y)?.id,
      scroll: getViewerScroller().scrollTop,
      translation: new DOMMatrixReadOnly(getComputedStyle(header).transform).m42 };
  })()`);
  check(`${label}: sticky header really overlaps the search input`,
    overlap.width > 8 && overlap.height > 8 && overlap.scroll > 100 && overlap.translation > 100,
    JSON.stringify(overlap));
  if (!(overlap.width > 8 && overlap.height > 8)) throw new Error("Sticky overlap prerequisite failed");
  check(`${label}: search paints above the sticky header`, overlap.top === "searchInput", JSON.stringify(overlap));
  await exec("document.getElementById('beforeSearch').focus(); window.fixtureClicks = []; true");
  await click(overlap.x, overlap.y);
  check(`${label}: overlap click reaches and focuses search`, await exec(`document.activeElement === searchInput &&
    window.fixtureClicks.includes('searchInput')`), await exec("JSON.stringify(window.fixtureClicks)"));
  await exec("searchInput.focus(); true");
  await win.webContents.insertText("needle");
  await waitFor("searchMatches.length > 0 && pendingSearchTerm === null", "search highlights");
  check(`${label}: visible search still highlights text`, await exec(`viewer.querySelectorAll('.search-highlight').length === 1`));
  await exec("toggleSearchPanel(); true");
  await settled();
  if (artifactArg) {
    await fs.promises.writeFile(path.join(runDir, `search-closed-${label.toLowerCase()}.png`),
      (await win.webContents.capturePage()).toPNG());
  }
  await ctrlF();
  await settled();
  if (artifactArg) {
    await fs.promises.writeFile(path.join(runDir, `search-sticky-${label.toLowerCase()}.png`),
      (await win.webContents.capturePage()).toPNG());
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
        <div class="editor-panel"><textarea aria-label="Fixture source"></textarea></div>
        <div id="viewer" class="markdown-body"><button id="afterSearch">Document control</button>
          <p>needle</p><table><thead><tr><th>Sticky table header</th><th>Details</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
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
    const readingViewport = { beginIntent() {}, isIntentCurrent() { return false; } };
    const readingHistory = { endSearch() {}, beginTyping() {}, sync() {} };
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
    ${searchSource}
    ${trackerSource}
    ${shortcuts}
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
  await stickyCase(false);
  await stickyCase(true);
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
