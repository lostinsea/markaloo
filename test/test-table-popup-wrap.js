// Run with node test/test-table-popup-wrap.js. Main/app startup is never loaded.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");

let app;
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
process.stdout.on("error", fatal);
process.stderr.on("error", fatal);
function fatal(error) {
  try {
    fs.writeSync(2, String(error.stack || error) + "\n");
    if (app?.isReady())
      fs.writeSync(2, "OWNED_ELECTRON_PIDS=" + JSON.stringify(app.getAppMetrics().map(metric => metric.pid)) + "\n");
  } finally {
    if (app) app.exit(1);
    else process.exit(1);
  }
}

if (!process.versions.electron) {
  const runtime = fs.mkdtempSync(path.join(__dirname, ".popup-wrap-"));
  const result = spawnSync(require("electron"), [__filename, ...process.argv.slice(2)], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 90000,
    env: { ...process.env, TEMP: runtime, TMP: runtime, TMPDIR: runtime },
  });
  console.log(`Popup child PID ${result.pid}: exit=${result.status}, signal=${result.signal || "none"}`);
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.error || result.signal) {
    console.error("Popup child did not exit normally; runtime retained:", runtime, result.error || result.signal);
    process.exit(1);
  }
  if (result.status === 0)
    fs.rmSync(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.exit(result.status === 0 ? 0 : 1);
}

const electron = require("electron");
({ app } = electron);
const { BrowserWindow, session } = electron;
require("./test-userdata-isolation");
const isolation = require("./test-userdata-isolation");
app.setPath("sessionData", isolation.USER_DATA_DIR);
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});
const watchdog = setTimeout(() => fatal(new Error("Popup wrap test exceeded 60 seconds")), 60000);
let passed = 0, failed = 0;
const errors = [];
let sentinelMessages = 0;
const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

function between(text, start, end) {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, "Popup source anchors resolve: " + start);
  assert.equal(text.indexOf(start, first + start.length), -1, "Unique popup source anchor");
  return text.slice(first, last);
}

function check(name, condition, evidence) {
  console.log((condition ? "PASS " : "FAIL ") + name +
    (condition ? "" : "  -> " + JSON.stringify(evidence)));
  if (condition) passed++;
  else failed++;
}

function html(themeId, disableWrap = false) {
  const { popupTheme } = require("../src/popup-theme");
  const theme = popupTheme(themeId);
  const helpers = between(source, "function escapeHtml(", "// A CSP nonce") +
    between(source, "function popupCsp(", "// Defence in depth") +
    between(source, "function normaliseTablePayload(", "// Handle Table popup request") +
    between(source, "const popupViewerControlsCss = `", 'ipcMain.on("open-mermaid-popup"');
  const popup = source.slice(source.indexOf('ipcMain.on("open-table-popup"'));
  let template = between(popup, "  const htmlContent = `<!DOCTYPE html>", "  // Write temp HTML file");
  if (disableWrap) {
    const anchor = /classList\.toggle\("table-word-wrap", (?:checkbox\.checked|false)\)/g;
    assert.equal([...template.matchAll(anchor)].length, 1, "Wrap mutation has one exact anchor");
    template = template.replace(anchor, 'classList.toggle("table-word-wrap", false)');
  }
  const columns = ["ID", "Description", "Token"].map((title, index) => ({ title, field: "col" + index }));
  const data = Array.from({ length: 120 }, (_, index) => ({
    col0: String(index).padStart(3, "0"),
    col1: (index % 2 ? "odd " : "even ") + "Words <literal> & text remain unchanged. ".repeat(9).trimEnd(),
    col2: "token-" + index + "-" + "x".repeat(220),
  }));
  return vm.compileFunction(
    helpers + "\nconst safeTableData = normaliseTablePayload(payload);\n" +
      template + "\nreturn htmlContent;",
    ["payload", "theme", "isDarkMode", "nonce", "tabulatorJs", "tabulatorCss"],
  )({ columns, data }, theme, theme.dark, randomBytes(16).toString("base64"),
    fs.readFileSync(path.join(__dirname, "..", "libs", "tabulator", "tabulator.min.js"), "utf8"),
    fs.readFileSync(path.join(__dirname, "..", "libs", "tabulator", "tabulator.min.css"), "utf8"));
}

async function openPopup(themeId, disableWrap, width = 1000) {
  const file = path.join(process.env.TEMP, "table-" + themeId + "-" + width + (disableWrap ? "-control" : "") + ".html");
  fs.writeFileSync(file, html(themeId, disableWrap), { flag: "wx" });
  const win = new BrowserWindow({
    width, height: 700, useContentSize: true, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  win.webContents.on("console-message", details => {
    if (details.message === "popup-wrap-sentinel") sentinelMessages++;
    else if (details.level === "error" || details.level === "warning") errors.push(details.message);
  });
  try {
    await win.loadFile(file);
    await until(win, "document.querySelector('#tableWordWrap') && table.getRows('visible').length > 0");
    return win;
  } catch (error) {
    win.destroy();
    throw error;
  }
}

async function evaluate(win, code) {
  return win.webContents.executeJavaScript(code);
}

async function until(win, condition) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await evaluate(win, condition)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Popup condition timed out: " + condition);
}

const readGeometry = `(() => {
  const row = table.getRows('visible')[0];
  const rowStyle = getComputedStyle(row.getElement());
  const cells = row.getCells().filter(cell => cell.getElement().offsetWidth > 0);
  return {
    height: row.getElement().getBoundingClientRect().height,
    border: rowStyle.borderBottomWidth,
    cells: cells.map(cell => {
      const el = cell.getElement(), style = getComputedStyle(el);
      const range = document.createRange(); range.selectNodeContents(el);
      return { text: el.textContent, whiteSpace: getComputedStyle(el).whiteSpace,
        height: el.clientHeight, width: el.clientWidth, scrollWidth: el.scrollWidth,
        inlineHeight: el.style.height, textHeight: range.getBoundingClientRect().height,
        font: style.font, padding: [style.paddingTop, style.paddingBottom], border: style.borderBottomWidth };
    })
  };
})()`;

async function toggle(win, checked) {
  await evaluate(win, `(() => {
    const checkbox = document.getElementById('tableWordWrap');
    checkbox.checked = ${checked};
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function exercise(themeId) {
  const win = await openPopup(themeId, false);
  try {
    const sentinelBefore = sentinelMessages;
    await evaluate(win, "console.warn('popup-wrap-sentinel')");
    assert.equal(sentinelMessages, sentinelBefore + 1, "Popup console sentinel is alive");
    const initial = await evaluate(win, `(() => {
      const checkbox = document.getElementById('tableWordWrap');
      const selector = document.querySelector('.tabulator-page-size');
      checkbox.focus();
      return { checked: checkbox.checked, label: checkbox.labels[0].textContent.trim(),
        focus: document.activeElement === checkbox, beside: selector.nextElementSibling === checkbox.labels[0],
        color: getComputedStyle(checkbox.labels[0]).color,
        footerColor: getComputedStyle(document.querySelector('.tabulator-footer')).color,
        controls: checkbox.getAttribute('aria-controls'), pageSize: table.getPageSize(),
        data: JSON.stringify(table.getData()) };
    })()`);
    const plain = await evaluate(win, readGeometry);
    check(themeId + " default is no-wrap with accessible footer control",
      !initial.checked && initial.label === "Word wrap" && initial.focus && initial.beside &&
      initial.color === initial.footerColor &&
      initial.controls === "data-table" && initial.pageSize === 50 &&
      plain.cells.every(cell => cell.whiteSpace === "nowrap") &&
      plain.cells.some(cell => cell.scrollWidth > cell.width), { initial, plain });
    await evaluate(win, "table.setPage(2)");
    await evaluate(win, "table.setPage(1)");
    const cachedPlain = await evaluate(win, readGeometry);
    await toggle(win, true);
    const wrapped = await evaluate(win, readGeometry);
    check(themeId + " wrapping grows rows and contains long tokens",
      wrapped.height > plain.height * 2 && wrapped.cells.every(cell =>
        cell.whiteSpace === "normal" && cell.scrollWidth <= cell.width + 1), { plain, wrapped });

    await evaluate(win, `table.setPage(2)`);
    const nextPage = await evaluate(win, readGeometry);
    check(themeId + " subsequent pages inherit wrapping",
      await evaluate(win, "table.getPage() === 2 && document.getElementById('tableWordWrap').checked") &&
      nextPage.cells[0].text === "050" && nextPage.height > plain.height * 2, nextPage);
    await toggle(win, false);
    await evaluate(win, "table.setPage(1)");
    const shrunk = await evaluate(win, readGeometry);
    await toggle(win, true);
    const repeatedWrap = await evaluate(win, readGeometry);
    await toggle(win, false);
    const repeatedNoWrap = await evaluate(win, readGeometry);
    console.log("INFO " + themeId + " row-height evidence " + JSON.stringify({
      plain, cachedPlain, wrapped, shrunk, repeatedWrap, repeatedNoWrap,
    }, (key, value) => key === "text" ? undefined : value));
    // An inert redraw also normalizes first-paint heights; content and repeated geometry must stay exact.
    const contentMetrics = geometry => JSON.stringify(geometry,
      (key, value) => key === "height" || key === "inlineHeight" ? undefined : value);
    check(themeId + " disabling wrap shrinks cached pages",
      contentMetrics(shrunk) === contentMetrics(cachedPlain) && shrunk.height < wrapped.height &&
      shrunk.cells.every(cell => cell.whiteSpace === "nowrap") &&
      shrunk.cells.some(cell => cell.scrollWidth > cell.width), { plain, cachedPlain, wrapped, shrunk });
    check(themeId + " repeated toggles preserve stable row geometry",
      JSON.stringify(shrunk) === JSON.stringify(repeatedNoWrap) &&
      JSON.stringify(wrapped) === JSON.stringify(repeatedWrap),
      { wrapped, shrunk, repeatedWrap, repeatedNoWrap });

    await evaluate(win, `(() => {
      const selector = document.querySelector('.tabulator-page-size');
      selector.value = '25'; selector.dispatchEvent(new Event('change', { bubbles: true }));
      table.setSort('col0', 'desc');
      table.setHeaderFilterValue('col1', 'even');
    })()`);
    await until(win, "table.getPageSize() === 25 && table.getDataCount('active') === 60");
    await evaluate(win, "table.setPage(2)");
    const state = await evaluate(win, `JSON.stringify({page:table.getPage(), size:table.getPageSize(),
      filters:table.getHeaderFilters(), sort:table.getSorters().map(s=>[s.field,s.dir]),
      rows:table.getData('active')})`);
    await toggle(win, true);
    check(themeId + " toggling preserves page size filters sort and active rows",
      state === await evaluate(win, `JSON.stringify({page:table.getPage(), size:table.getPageSize(),
        filters:table.getHeaderFilters(), sort:table.getSorters().map(s=>[s.field,s.dir]),
        rows:table.getData('active')})`), state);

    const content = await evaluate(win, `(async () => {
      const cell = table.getRows('visible')[0].getCells()[1].getElement();
      const range = document.createRange(); range.selectNodeContents(cell);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const selected = selection.toString(); selection.removeAllRanges();
      const downloads = [];
      const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
      const click = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = blob => { downloads.push(blob); return 'blob:fixture'; };
      URL.revokeObjectURL = () => {};
      HTMLAnchorElement.prototype.click = function() {};
      try {
        document.getElementById('exportCsvBtn').click();
        document.getElementById('exportJsonBtn').click();
      } finally {
        URL.createObjectURL = create; URL.revokeObjectURL = revoke;
        HTMLAnchorElement.prototype.click = click;
      }
      return { data: JSON.stringify(table.getData()), selected, text: cell.textContent,
        csv: await downloads[0].text(), json: JSON.parse(await downloads[1].text()),
        active: table.getData('active') };
    })()`);
    check(themeId + " wrap preserves source text selection search and exports",
      content.data === initial.data && content.selected === content.text &&
      content.text.includes("<literal> &") && content.csv.includes(content.text) &&
      JSON.stringify(content.json) === JSON.stringify(content.active) &&
      content.json.length === 60, { selected: content.selected, exported: content.json.length });
    await evaluate(win, "document.getElementById('clearFiltersBtn').click()");
    check(themeId + " clear filters retains wrap and original rows",
      await evaluate(win, "table.getDataCount('active') === 120 && document.getElementById('tableWordWrap').checked"));

    await evaluate(win, `(() => {
      const column = table.getColumns()[1], handle = column.getElement().nextElementSibling;
      if (!handle.classList.contains('tabulator-col-resize-handle')) throw new Error('Missing header resize handle');
      const x = handle.getBoundingClientRect().x;
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, clientX:x, button:0 }));
      document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, clientX:x + 160 - column.getWidth(), buttons:1 }));
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, clientX:x, button:0 }));
    })()`);
    const resized = await evaluate(win, readGeometry);
    check(themeId + " header resizing recalculates wrapped row heights",
      resized.cells[1].width <= 160 && resized.cells[1].scrollWidth <= resized.cells[1].width + 1 &&
      resized.height > wrapped.height, { wrapped, resized });

  } finally {
    win.destroy();
  }
}

async function exerciseNarrow(themeId) {
  const win = await openPopup(themeId, false, 520);
  try {
    const bounds = win.getBounds(), contentBounds = win.getContentBounds();
    const viewport = await evaluate(win, "({width:innerWidth,height:innerHeight,scale:devicePixelRatio})");
    console.log("INFO " + themeId + " narrow sizing " + JSON.stringify({
      bounds, contentBounds, viewport,
    }));
    assert.equal(contentBounds.width, 520, "Narrow fixture has the requested owned content width");
    assert([bounds.width, contentBounds.width].includes(viewport.width), "Viewport matches owned native sizing");
    await until(win, "document.querySelector('.container').getBoundingClientRect().width === innerWidth");
    await toggle(win, true);
    const footer = await evaluate(win, `(() => {
      const checkbox = document.getElementById('tableWordWrap'), label = checkbox.labels[0];
      const box = label.getBoundingClientRect(), footer = document.querySelector('.tabulator-footer').getBoundingClientRect();
      return { count:document.querySelectorAll('#tableWordWrap').length, checked:checkbox.checked,
        disabled:checkbox.disabled, left:box.left, right:box.right, top:box.top, bottom:box.bottom,
        footerLeft:footer.left, footerRight:footer.right, footerTop:footer.top, footerBottom:footer.bottom };
    })()`);
    check(themeId + " narrow footer keeps one visible enabled toggle",
      footer.count === 1 && footer.checked && !footer.disabled &&
      footer.left >= footer.footerLeft && footer.left >= 0 &&
      footer.right <= footer.footerRight && footer.right <= viewport.width &&
      footer.top >= footer.footerTop && footer.bottom <= footer.footerBottom &&
      footer.bottom <= viewport.height, footer);
    await evaluate(win, `table.getColumns()[0].setWidth(260)`);
    await until(win, "document.querySelector('.tabulator-responsive-collapse td') !== null");
    const collapsed = await evaluate(win, `(() => {
      const cells = [...document.querySelectorAll('.tabulator-responsive-collapse td')];
      return cells.map(el => ({ text:el.textContent, whiteSpace:getComputedStyle(el).whiteSpace,
        width:el.clientWidth, scrollWidth:el.scrollWidth }));
    })()`);
    check(themeId + " responsive collapsed values also wrap within their cells",
      collapsed.some(cell => cell.text.includes("token-")) &&
      collapsed.every(cell => cell.width > 0 && cell.whiteSpace === "normal" &&
        cell.scrollWidth <= cell.width + 1), collapsed);
  } finally {
    win.destroy();
  }
}

async function mutationControl() {
  const win = await openPopup("default-light", true);
  try {
    await evaluate(win, "table.setPage(2)");
    await evaluate(win, "table.setPage(1)");
    const plain = await evaluate(win, readGeometry);
    await toggle(win, true);
    const broken = await evaluate(win, readGeometry);
    await toggle(win, true);
    const repeated = await evaluate(win, readGeometry);
    check("wrap geometry oracle rejects an inert toggle while data control stays live",
      broken.height < plain.height * 2 && broken.cells.every(cell => cell.whiteSpace === "nowrap") &&
      broken.cells.some(cell => cell.scrollWidth > cell.width) &&
      JSON.stringify(broken) === JSON.stringify(repeated) &&
      await evaluate(win, "table.getData().length === 120 && document.getElementById('tableWordWrap').checked"),
      { plain, broken });
  } finally {
    win.destroy();
  }
}

app.whenReady().then(async () => {
  assert.equal(session.defaultSession.storagePath, isolation.USER_DATA_DIR);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith("file:") || details.url.startsWith("data:");
    if (!allowed) errors.push("Unexpected request: " + details.url);
    callback({ cancel: !allowed });
  });
  session.defaultSession.on("will-download", (event) => {
    event.preventDefault();
    errors.push("Unexpected native download");
  });
  for (const [name, run] of [
    ["default-light", () => exercise("default-light")],
    ["default-light narrow", () => exerciseNarrow("default-light")],
    ["default-dark", () => exercise("default-dark")],
    ["default-dark narrow", () => exerciseNarrow("default-dark")],
    ["inert-toggle control", mutationControl],
  ]) {
    try {
      await run();
    } catch (error) {
      check(name + " scenario completed", false, String(error.stack || error));
    }
  }
  check("popup wrap produces no renderer warnings errors or external requests", errors.length === 0, errors);
  clearTimeout(watchdog);
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log("OWNED_ELECTRON_PIDS=" + JSON.stringify(app.getAppMetrics().map(metric => metric.pid)));
  app.exit(failed ? 1 : 0);
}).catch(fatal);
