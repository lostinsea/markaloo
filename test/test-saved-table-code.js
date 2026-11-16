"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "..");
const output = process.env.MARKALOO_SAVED_CELL_RUN;
function fatal(error) {
  const message = (error?.stack || String(error)) + "\n";
  if (output) fs.appendFileSync(path.join(output, "fatal.log"), message);
  fs.writeSync(2, message);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exit(1);
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
process.stdout.on("error", fatal);
process.stderr.on("error", fatal);
if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(process.env.MARKALOO_SAVED_CELL_OUTPUT || os.tmpdir(), "saved-cell-"));
  const stdout = fs.openSync(path.join(directory, "stdout.log"), "wx");
  const stderr = fs.openSync(path.join(directory, "stderr.log"), "wx");
  const env = { ...process.env, MARKALOO_SAVED_CELL_RUN: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawnSync(require("electron"), [__filename], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", stdout, stderr], timeout: 80000,
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  fs.writeFileSync(path.join(directory, "parent.json"), JSON.stringify({
    pid: child.pid, status: child.status, signal: child.signal, error: child.error?.stack,
  }, null, 2));
  console.log("SAVED_CELL_EVIDENCE=" + directory);
  console.log(fs.readFileSync(path.join(directory, "stdout.log"), "utf8"));
  const errors = fs.readFileSync(path.join(directory, "stderr.log"), "utf8");
  if (errors) console.error(errors);
  if (child.error) fatal(child.error);
  process.exit(child.status === 0 ? 0 : 1);
}
if (!output || !path.isAbsolute(output)) fatal(new Error("Missing owned fixture output"));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = output;
require("./test-userdata-isolation");

const absolute = file => path.join(root, ...file.split(/[\\/]/));
const read = file => fs.readFileSync(absolute(file), "utf8").replace(/\r\n/g, "\n");
const renderer = read("src\\renderer.js");
function section(start, end) {
  const from = renderer.indexOf(start), to = renderer.indexOf(end, from + start.length);
  if (from < 0 || to < 0 || renderer.indexOf(start, from + 1) !== -1)
    throw new Error("Missing or nonunique shipping anchor: " + start);
  return renderer.slice(from, to);
}
const original = "# Owned saved cell\r\n\r\n| Name | Payload | Control |\r\n| :--- | --- | ---: |\r\n" +
  "| sample | replace me | escaped \\| neighbor |\r\n| untouched | **unchanged** | tail\\\\ |\r\n\r\nOutside stays exact.\r\n";
const json = [
  "{", '  "id": "synthetic-42",', '  "roles": ["engineer", "reviewer"],', "",
  '  "active": true,', '  "path": "C:\\\\owned\\\\file",',
  '  "literal": "a|b \\\\| \\\\\\\\| <script>not executable</script> & &#10; ` * [x]",',
  '  "escaped": "first\\nsecond :smile: :star:"', "}",
].join("\n");
const fence = "```json\n" + json + "\n```";
const encoded = "<br>&#96;&#96;&#96;json<br>&#123;<br>&#125;<br>&#96;&#96;&#96;";
const program = [
  section("const SANITIZE_CONFIG = {", "\n// DOMPurify's default URI"),
  section("function sanitizeHtml(html) {", "// The table dialogs"),
  section("const TABLE_SANITIZE_CONFIG = {", "\n// The @@@html fence"),
  section("const RAW_HTML_FENCE = ", "\n"),
  section("const UI_STRINGS = {", "\nconst TIMING = "),
  `
const markdownEditor = document.getElementById('editor'), viewer = document.getElementById('viewer');
const tab = Object.freeze({id:'owned-saved-cell'});
let exact = ${JSON.stringify(original)}, tableCellSession = null, tableMenuSelection = null;
let isEditMode = true, editorModeRevision = 1, fileOpenSequence = 1, editorInteractionRevision = 1;
let exactTypingSource = '', rightClickTarget = markdownEditor;
const history = [], notifications = [], readingGeneratedContainers = new WeakMap(), attributes = new Map();
const {parseEmojis} = window.MarkalooEmoji;
markdownEditor.value = MarkalooTableCells.normalise(exact);
window.CustomTabs = {
  snapshotExactEditorContent: () => exact,
  captureDialogContext: () => () => isEditMode,
  adoptExactEditorContent: candidate => {exact = candidate; return true;},
};
const currentDocumentActionOwner = () => tab;
const mayMutateRendererDocument = () => isEditMode;
const editorHistoryComposing = () => false, tableColumnSizing = {cancel() {}};
const hideContextMenu = () => {}, showNotification = text => notifications.push(text);
const cancelEditorDeferredWork = () => {}, historyPushExact = source => history.push(source);
const setDocumentDirtyFromContent = () => {}, retainCurrentDocumentEditor = () => {};
const ctxEditTable = null, ctxEditSelectedRows = null;
const searchMatches = [], searchInput = {value:''};
function clearSearchHighlights() {throw new Error('Unexpected search work');}
function highlightSearchTerm() {throw new Error('Unexpected search work');}
function noteReadingAttribute(body, name) {
  if (!attributes.has(body)) attributes.set(body, new Map());
  attributes.get(body).set(name, body.getAttribute(name));
}
const editorScroll = createEditorScroll({
  editor:markdownEditor, preview:viewer, active:() => isEditMode, frozen:() => false,
  identity:() => 1, scale:() => 1,
  presentation:() => ({owner:'owned-saved-cell',revision:1}),
  readingSourceIdentity:() => 'owned-saved-cell-source',
});
`,
  section("function bundledTableCodeLanguage(", "// Smart render dispatcher"),
  `
async function renderMarkdown(content, _mode, viewport = {}) {
  const source = editorScroll.source(content), fresh = document.createElement('div');
  source.prepare(parseEmojis);
  fresh.innerHTML = sanitizeHtml(source.parse(marked));
  const bindings = source.detach(fresh, sanitizeHtml), bodies = [...fresh.children];
  viewer.replaceChildren(...bodies);
  for (const body of bodies) source.adopt(body, body, bindings);
  const tables = [...viewer.querySelectorAll('table')];
  for (const table of tables)
    readingGeneratedContainers.set(table, {wrapper:null, controls:[], decorations:[], code:null});
  editorScroll.commit(source);
  highlightNewElements(source);
  const associations = bodies.filter(body => source.readingTextSpecs.has(body)).map(body => ({
    fresh:body, body,
    owners:tables.filter(table => body === table || body.contains(table)).map(table => ({
      fresh:table, body:table, ...readingGeneratedContainers.get(table), header:table.tHead, breakout:null,
    })),
    attributes:[...attributes].filter(([node]) => body.contains(node)).flatMap(([node,names]) =>
      [...names].map(([name,value]) => ({body:node,name,value}))),
  }));
  window.readerReceipt = editorScroll.bindReadingPresentation(source,
    {owner:'owned-saved-cell',revision:1}, associations).status;
  viewport.completion = Promise.resolve();
}
`,
  section("function skipPastCodeBlock(", "\n// Save file"),
  section("let nextTableSizingId = 0;", "\nconst tableColumnSizing = createTableColumnSizing("),
  section("const TableCellMode = ", "\n// Delete Mermaid"),
  `
window.fixture = {
  async load(source = ${JSON.stringify(original)}) {
    closeTableCellEditor(); isEditMode = true; exact = source;
    markdownEditor.value = MarkalooTableCells.normalise(source); history.length = 0;
    await renderMarkdown(markdownEditor.value);
  },
  open() {
    isEditMode = true;
    const source = markdownEditor.value, start = source.indexOf('| Name');
    tableMenuSelection = {tab,source,mode:editorModeRevision,sequence:fileOpenSequence,
      sourceLine:{start,end:source.indexOf('\\n',start)}, origin:'markdown', start,end:start,
      direction:'none',isCurrent:() => isEditMode && markdownEditor.value === source};
    openTableCellEditor(TableCellMode.UPDATE_TABLE);
    if (!tableCellDialog.open || !tableCellSession?.ready) throw new Error('Shipping popup did not open');
  },
  input(column = 1) {return tableCellSession.rows[1].cells[column].input;},
  paste(text, column = 1) {
    const input = this.input(column); input.focus();
    const range = document.createRange(); range.selectNodeContents(input);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const data = new DataTransfer(); data.setData('text/plain',text);
    input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
    return {html:input.innerHTML,text:input.innerText,code:!!input.querySelector('code')};
  },
  editText(before, after, insideCode = false) {
    const input = this.input(), scope = insideCode ? input.querySelector('code') : input;
    if (!scope) return false;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && !node.data.includes(before)) {}
    if (!node) throw new Error('Reopened cell edit target missing');
    input.focus();
    const range = document.createRange(), start = node.data.indexOf(before);
    range.setStart(node,start); range.setEnd(node,start+before.length);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const data = new DataTransfer(); data.setData('text/plain',after);
    input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
    return true;
  },
  async update() {
    await updateTableCells();
    if (tableCellDialog.open) throw new Error('Shipping Update failed: '+tableCellError.textContent);
    return {exact,history:history.slice()};
  },
  async reader(source) {
    closeTableCellEditor(); isEditMode = false; exact = source;
    markdownEditor.value = MarkalooTableCells.normalise(source);
    await renderMarkdown(markdownEditor.value);
    return this.state();
  },
  state() {
    const table = viewer.querySelector('table'), cell = table?.tBodies[0]?.rows[0]?.cells[1];
    const code = cell?.querySelector('code'), token = code?.querySelector('.token');
    return {exact,edit:isEditMode,open:tableCellDialog.open,receipt:window.readerReceipt,
      rows:table?.rows.length,columns:table?.rows[0].cells.length,html:cell?.innerHTML,text:cell?.textContent,
      code:code?.textContent,language:code?.className,tokens:code?.querySelectorAll('.token').length || 0,
      color:token && getComputedStyle(token).color,baseColor:code && getComputedStyle(code).color,
      whiteSpace:code && getComputedStyle(code).whiteSpace,notifications:notifications.slice(),
      script:!!viewer.querySelector('script'),neighbor:table?.tBodies[0]?.rows[0]?.cells[2].textContent};
  },
};
`,
].join("\n");
new vm.Script(program, {filename:"shipping-saved-cell.js"});
const { app, BrowserWindow, session } = require("electron");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
const results = [], errors = [], blocked = [];
const check = (name, ok, detail) => {
  results.push({name,ok:!!ok,detail});
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " " + JSON.stringify(detail)));
};
let win;
const watchdog = setTimeout(() => fatal(new Error("Saved-cell fixture exceeded 65 seconds")), 65000);
async function run() {
  await app.whenReady();
  const page = path.join(output,"index.html"), script = path.join(output,"page.js");
  fs.writeFileSync(script, program);
  const index = read("src\\index.html"), start = index.indexOf('<dialog id="tableCellDialog"');
  const end = index.indexOf("</dialog>",start);
  if (start < 0 || end < 0) throw new Error("Missing shipping Table dialog");
  const dependencies = ["libs\\vendor\\marked.min.js","libs\\vendor\\purify.min.js","libs\\prismjs\\prism-bundle.js",
    "src\\utils.js","src\\emoji-map.js","src\\emoji-parser.js","src\\inline-formatting.js",
    "src\\table-cell-editor.js","src\\editor-scroll.js"];
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>Owned saved table cell</title>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src file:; ' +
    'style-src file: \'unsafe-inline\'; font-src file:; img-src data:">' +
    `<link rel="stylesheet" href="${pathToFileURL(path.join(root,"src","styles.css")).href}">` +
    '<style>body{display:block;padding:24px}#editor{position:fixed;left:-10000px}' +
    '#viewer{display:block;position:static;height:820px;overflow:auto}</style>' +
    '<textarea id="editor"></textarea><div id="viewer" class="markdown-body"></div>' +
    index.slice(start,end+"</dialog>".length) +
    dependencies.map(file => `<script src="${pathToFileURL(absolute(file)).href}"></script>`).join("") +
    '<script src="page.js"></script>');
  const guest = session.fromPartition("saved-table-cell");
  guest.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
  const allowed = new Set([page,script,path.join(root,"src","styles.css"),
    ...dependencies.map(absolute),
    ...["Regular","Bold","Light","Medium","SemiBold"].map(weight => path.join(root,"fonts","FiraCode-"+weight+".ttf"))]
    .map(file => pathToFileURL(file).href.toLowerCase()));
  guest.webRequest.onBeforeRequest((details,callback) => {
    const permitted = allowed.has(details.url.toLowerCase()) || details.url.startsWith("data:");
    if (!permitted) blocked.push(details.url);
    callback({cancel:!permitted});
  });
  win = new BrowserWindow({width:1280,height:960,show:false,
    webPreferences:{partition:"saved-table-cell",offscreen:true,backgroundThrottling:false,
      nodeIntegration:false,contextIsolation:true,sandbox:true}});
  win.webContents.setWindowOpenHandler(() => ({action:"deny"}));
  win.webContents.on("console-message",event => {if (event.level === "error") errors.push(event.message);});
  const execute = code => win.webContents.executeJavaScript(code);
  await win.loadFile(page);
  await execute("console.error('saved-cell-sentinel')");
  check("saved cell console sentinel is alive",errors.includes("saved-cell-sentinel"),errors.slice());
  errors.length = 0;
  await execute("fixture.load()");
  await execute("fixture.open()");
  const pasted = await execute("fixture.paste("+JSON.stringify(fence)+")");
  check("saved cell raw paste reaches shipping popup as multiline literal",
    pasted.html.includes("<br>") && !pasted.code && pasted.text.replace(/\r\n/g,"\n") === fence,pasted);
  const updated = await execute("fixture.update()");
  fs.writeFileSync(path.join(output,"saved.md"),updated.exact);
  const disk = fs.readFileSync(path.join(output,"saved.md"),"utf8");
  const state = await execute("fixture.reader("+JSON.stringify(disk)+")");
  fs.writeFileSync(path.join(output,"reader.json"),JSON.stringify(state,null,2));
  const image = await win.webContents.capturePage({stayHidden:true,stayAwake:true});
  if (image.isEmpty()) throw new Error("Empty saved Reader image");
  fs.writeFileSync(path.join(output,"saved-reader.png"),image.toPNG());
  check("saved cell Update keeps outside bytes table shape and one undo",
    updated.history.length === 1 && updated.history[0] === original &&
    disk.startsWith(original.slice(0,original.indexOf("replace me"))) &&
    disk.endsWith(original.slice(original.indexOf("replace me")+"replace me".length)) &&
    state.rows === 3 && state.columns === 3 && state.neighbor === "escaped | neighbor",state);
  check("saved cell reader has explicit JSON tokens after disk readback",
    !state.edit && !state.open && state.code === json && state.tokens > 0 &&
    state.color !== state.baseColor && /language-json/.test(state.language),state);
  check("saved cell reader preserves multiline code whitespace and source authority",
    state.code === json && state.whiteSpace === "pre-wrap" && state.receipt === "bound",state);
  check("saved cell never executes code payload",!state.script && !blocked.length,{state,blocked});
  await execute("fixture.open()");
  const reopened = await execute("fixture.update()");
  check("saved cell reopened unchanged Update keeps exact saved bytes",reopened.exact === disk,reopened);
  await execute("fixture.open()");
  await execute("fixture.paste('changed neighbor',2)");
  const second = await execute("fixture.update()");
  const after = await execute("fixture.reader("+JSON.stringify(second.exact)+")");
  check("saved cell neighbor edit does not reescape code or lose linebreaks",
    after.code === json && after.tokens > 0 && second.exact === disk.replace("escaped \\| neighbor","changed neighbor"),after);
  await execute("fixture.open()");
  const edited = await execute("fixture.editText('synthetic-42','synthetic-43',true)");
  const third = await execute("fixture.update()");
  const editedState = await execute("fixture.reader("+JSON.stringify(third.exact)+")");
  check("saved cell reopened code edit preserves literal payload and source authority",
    edited && editedState.code === json.replace("synthetic-42","synthetic-43") && editedState.tokens > 0 &&
    editedState.receipt === "bound" && third.exact === second.exact.replace("synthetic-42","synthetic-43"),editedState);
  for (const [label, body] of [["JS","const value = 42;"], ["rust","let value = 42;"]]) {
    await execute("fixture.load()");
    await execute("fixture.open()");
    await execute("fixture.paste("+JSON.stringify("```"+label+"\r\n"+body+"\r\n```")+")");
    const saved = await execute("fixture.update()");
    const observed = await execute("fixture.reader("+JSON.stringify(saved.exact)+")");
    check("saved cell bundled language and alias "+label+" survive CRLF input",
      observed.code === body && observed.tokens > 0 && observed.receipt === "bound",observed);
  }
  const controls = [
    ["unknown","```not-supported\n{}\n```"], ["unlabelled","```\n{}\n```"],
    ["unclosed","```json\n{}"], ["mixed","prefix\n```json\n{}\n```"],
    ["multiple","```json\n{}\n```\n```json\n{}\n```"],
    ["padded","  ```json\n{}\n```  "],
    ["trailing-break","```json\n{}\n```\n"],
  ];
  for (const [label, text] of controls) {
    await execute("fixture.load()");
    await execute("fixture.open()");
    await execute("fixture.paste("+JSON.stringify(text)+")");
    const saved = await execute("fixture.update()");
    const observed = await execute("fixture.reader("+JSON.stringify(saved.exact)+")");
    check("saved cell "+label+" fence stays literal",
      !observed.code && observed.text === text.replace(/\n/g,""),observed);
  }
  const escapedFence = "\\`\\`\\`json<br>{}<br>\\`\\`\\`";
  await execute("fixture.load("+JSON.stringify(original.replace("replace me",escapedFence))+")");
  await execute("fixture.open()");
  await execute("fixture.editText('{}','{ }')");
  const escapedUpdate = await execute("fixture.update()");
  const escapedState = await execute("fixture.reader("+JSON.stringify(escapedUpdate.exact)+")");
  check("saved cell escaped literal fence stays literal after an edit",
    !escapedState.code && escapedState.text === "```json{ }```",escapedState);
  await execute("fixture.load()");
  await execute("fixture.open()");
  await execute("fixture.paste("+JSON.stringify(encoded)+")");
  const literal = await execute("fixture.update()");
  const literalState = await execute("fixture.reader("+JSON.stringify(literal.exact)+")");
  check("saved cell already encoded literal input is not decoded as markup or a fence",
    literalState.text === encoded && !literalState.code && !literalState.script,literalState);
  check("saved cell guest has no external requests or unexpected errors",!blocked.length && !errors.length,{blocked,errors});
}
run().then(() => finish(), error => {
  check("saved cell fixture completes all required boundaries",false,error.stack);
  finish();
});
function finish() {
  clearTimeout(watchdog);
  const pids = app.getAppMetrics().map(metric => metric.pid);
  if (win && !win.isDestroyed()) win.destroy();
  const windows = BrowserWindow.getAllWindows().length;
  check("saved cell owned windows are closed",windows === 0,windows);
  fs.writeFileSync(path.join(output,"results.json"),JSON.stringify({results,pids,windows},null,2));
  console.log("OWNED_ELECTRON_PIDS="+JSON.stringify(pids));
  console.log(results.filter(result => result.ok).length+" passed, "+results.filter(result => !result.ok).length+" failed");
  app.exit(results.every(result => result.ok) ? 0 : 1);
}
