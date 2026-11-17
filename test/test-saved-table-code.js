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
  const child = require("node:child_process").spawnSync(require("electron"), [__filename,...process.argv.slice(2)], {
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
const asset = file => path.join(process.env.MARKALOO_SAVED_CELL_ASSETS || root, ...file.split(/[\\/]/));
const pastePaddingCases = [
  {name:"lf",before:"\n",after:"",eol:"\n"},
  {name:"crlf",before:"\r\n",after:"\r\n",eol:"\r\n"},
  {name:"blank-lf",before:"\n \t\n",after:"\n\n",eol:"\n"},
  {name:"mixed-blank",before:" \t\r\n\r\n",after:"\r\n \t\r\n",eol:"\n"},
];
const paddedMalformedPastes = [
  ["unclosed","\n```json\n{}"],
  ["incomplete-opener","\r\n \t\r\n```rust"],
  ["second-block","\n```json\n{}\n```\n\n```json\n{}\n```"],
  ["closer-collision","\r\n```sql\nSELECT 1;\n```| data\n```"],
];
const reverts = {
  "copy-feedback-authority": {
    file:"src\\renderer.js",
    from:"if (table) editorScroll.sealTableDecoration(codeBlockCopySources.get(pre), table, previous);",
    to:"void previous;",
    expect:[
      ...require("./fixtures/table-code-literals").cases.flatMap(sample => ["\n","\r\n"].map(eol =>
        "raw render "+sample.id+" "+JSON.stringify(eol)+" copy feedback preserves model authority")),
      "raw render copy feedback reset preserves model authority",
      ...["reuse","search"].flatMap(mode => ["raw feedback "+mode+" preserves authority",
        "raw feedback "+mode+" reset uses current source and canonical markup"]),
    ],
    mustPass:["raw render ordinary table keeps native source and Reader authority",
      "raw render json-escapes \"\\n\" copy receives only literal body"],
  },
  "copy-current-source": {
    file:"src\\renderer.js",
    from:"codeBlockCopySources.set(pre, scrollSource);",
    to:"if (!codeBlockCopySources.has(pre)) codeBlockCopySources.set(pre, scrollSource);",
    expect:["raw feedback reuse preserves authority",
      ...["reuse","search"].map(mode => "raw feedback "+mode+" reset uses current source and canonical markup")],
    mustPass:["raw feedback search preserves authority",
      "raw render json-escapes \"\\n\" copy receives only literal body"],
  },
  "copy-canonical-presentation": {
    file:"src\\editor-scroll.js",
    from:"captureTableDecoration(table) { return tablePresentation(table); },",
    to:"captureTableDecoration(table) { return table.innerHTML; },",
    expect:["raw feedback search preserves authority",
      "raw feedback search reset uses current source and canonical markup"],
    mustPass:["raw feedback reuse preserves authority",
      "raw feedback reuse reset uses current source and canonical markup"],
  },
  "raw-paste-opener": {
    file:"src\\inline-formatting.js",
    from:"/^(?:[ \\t]|\\r?\\n)*`{3,}[ \\t]*(?:[^\\s`]+[ \\t]*)?(?:\\r?\\n|$)/.test(plain)",
    to:"/^(?:[ \\t]|\\r?\\n)*`{3}/.test(plain)",
    expect:["```inline```","```rust extra"].flatMap(text => [
      "ordinary whole-cell paste "+text+" keeps semantic input",
      "ordinary whole-cell paste "+text+" can Update"]),
    mustPass:["genuine incomplete raw opener stays a repairable rejected draft",
      "saved cell native local undo restores exact mixed endings without a dirty transaction"],
  },
  "raw-paste-leading-padding": {
    file:"src\\inline-formatting.js",
    from:"/^(?:[ \\t]|\\r?\\n)*`{3,}[ \\t]*(?:[^\\s`]+[ \\t]*)?(?:\\r?\\n|$)/.test(plain)",
    to:"/^[ \\t]*`{3,}[ \\t]*(?:[^\\s`]+[ \\t]*)?(?:\\r?\\n|$)/.test(plain)",
    expect:[
      ...pastePaddingCases.flatMap(({name}) => [
        "ordinary padded raw paste "+name+" preserves exact draft",
        "ordinary padded raw paste "+name+" keeps exact Update and reopen"]),
      ...paddedMalformedPastes.map(([name]) =>
        "ordinary padded malformed paste "+name+" keeps draft and unchanged Source"),
    ],
    mustPass:["```inline```","```rust extra"].flatMap(text => [
      "ordinary whole-cell paste "+text+" keeps semantic input",
      "ordinary whole-cell paste "+text+" can Update"]).concat([
      "genuine incomplete raw opener stays a repairable rejected draft",
      "ordinary partial-cell padded paste stays semantic",
      ...["nbsp","bom","bare-cr"].map(name =>
        "ordinary disallowed-padding control "+name+" stays semantic"),
    ]),
  },
  "raw-paste-exact-endings": {
    file:"src\\renderer.js",
    from:"cell.literalSource = text;",
    to:"cell.literalSource = MarkalooInlineFormatting.normalise(text).replace(/\\n/g, lineEnding);",
    expect:pastePaddingCases.filter(({name}) => name !== "crlf").flatMap(({name}) => [
      "ordinary padded raw paste "+name+" preserves exact draft",
      "ordinary padded raw paste "+name+" keeps exact Update and reopen"]),
    mustPass:[
      "ordinary padded raw paste crlf preserves exact draft",
      "ordinary padded raw paste crlf keeps exact Update and reopen",
      "ordinary whole-cell paste ```inline``` keeps semantic input",
      "ordinary whole-cell paste ```inline``` can Update",
      "genuine incomplete raw opener stays a repairable rejected draft",
      ...paddedMalformedPastes.map(([name]) =>
        "ordinary padded malformed paste "+name+" keeps draft and unchanged Source"),
    ],
  },
  "ordinary-row-width": {
    file:"src\\table-marked.js",
    from:["const rows = rowsOf(table).map((row, r) => {",
      "          const cells = row.cells.slice(0, width).map((cell, c) => cellToken(cell, r, c));",
      "          // Native GFM pads ordinary rows; padding has no source receipt.",
      "          while (cells.length < width) cells.push(null);",
      "          return cells;",
      "        });"].join("\n"),
    to:"const rows = rowsOf(table).map((row, r) => row.cells.map((cell, c) => cellToken(cell, r, c)));",
    expect:[...["| only |","| first | second | EXTRA_ONLY |"].map(row =>
      "raw render ordinary row retains native width "+row),
      "raw render ragged row keeps document metadata and real-cell authority | only |"],
    mustPass:["raw render ordinary table keeps native source and Reader authority",
      "raw render json-escapes \"\\n\" decorated table keeps exact model authority"],
  },
  "composition-raw-paste": {
    file:"src\\inline-formatting.js",
    from:"if (cell.composing) { reportError(new Error('tableCells.composing')); return; }",
    to:"void cell.composing;",
    expect:["saved cell composing semantic surface cannot be replaced by a raw paste"],
    mustPass:["saved cell native local undo restores exact mixed endings without a dirty transaction",
      "saved cell escaped literal fence stays literal after an edit"],
  },
  "native-boundary-opacity": {
    file:"src\\table-marked.js",
    from:"if (!table || table.end !== read.next) {",
    to:"if (false) {",
    expect:['# Heading | boundary','- list | boundary','<div data-value="a|b">'].map(boundary =>
      "raw refusal "+boundary+" preserves literal source across full light and metadata paths"),
    mustPass:["raw render ordinary table keeps native source and Reader authority",
      "raw render json-escapes \"\\n\" copy receives only literal body"],
  },
  "padded-cell-metadata": {
    file:"src\\editor-scroll.js",
    from:"if (cell === null) continue;",
    to:"void cell;",
    expect:["raw render ragged row keeps document metadata and real-cell authority | only |"],
    mustPass:["raw render ragged row keeps document metadata and real-cell authority | first | second | EXTRA_ONLY |",
      "raw render ordinary table keeps native source and Reader authority"],
  },
  "literal-exact-history": {
    file:"src\\inline-formatting.js",
    from:"versions.push({ visible: next, exact });",
    to:"for (const version of versions) if (version.visible === next) version.exact = exact;\n" +
      "        versions.push({ visible: next, exact });",
    expect:["saved cell repeated visible native Undo restores original exact endings",
      "saved cell synthetic same-visible history resolves before no-change shortcut"],
    mustPass:["saved cell repeated visible native Redo restores each exact version",
      "saved cell native local undo restores exact mixed endings without a dirty transaction"],
  },
  "literal-history-refusal": {
    file:"src\\inline-formatting.js",
    from:"historyFailed = true;",
    to:"historyFailed = false;",
    expect:["ambiguous","missing"].map(mode =>
      "saved cell synthetic "+mode+" history blocks structural change and Update without guessing"),
    mustPass:["saved cell repeated visible native Undo restores original exact endings",
      "saved cell synthetic same-visible history resolves before no-change shortcut"],
  },
  "literal-history-same-visible": {
    file:"src\\inline-formatting.js",
    from:"if (/^history(?:Undo|Redo)$/.test(event?.inputType || '')) {",
    to:"if (next === visible) return;\n      if (/^history(?:Undo|Redo)$/.test(event?.inputType || '')) {",
    expect:["saved cell synthetic same-visible history resolves before no-change shortcut"],
    mustPass:["saved cell repeated visible native Undo restores original exact endings",
      "saved cell synthetic ambiguous history blocks structural change and Update without guessing"],
  },
  "literal-history-structural": {
    file:"src\\renderer.js",
    from:"for (const cell of session.cells) cell.engine.validateHistory?.();",
    to:"void session.cells;",
    expect:["ambiguous","missing"].map(mode =>
      "saved cell synthetic "+mode+" history blocks structural change and Update without guessing"),
    mustPass:["saved cell raw row movement proves a valid unchanged-source setup",
      "saved cell raw row movement Update preserves exact raw bytes and one document change",
      "saved cell repeated visible native Undo restores original exact endings",
      "saved cell synthetic same-visible history resolves before no-change shortcut"],
  },
};
const proofName = process.env.MARKALOO_SAVED_CELL_REVERT, proof = proofName && reverts[proofName];
if (proofName && !proof) fatal(new Error("Unknown bounded saved-cell revert"));
let reverted = false;
const read = file => {
  const text = fs.readFileSync(absolute(file), "utf8").replace(/\r\n/g, "\n");
  if (proof?.file !== file) return text;
  if (text.split(proof.from).length !== 2) throw new Error("Bounded revert anchor is missing or ambiguous");
  reverted = true;
  return text.replace(proof.from,() => proof.to);
};
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
  section("marked.setOptions({", "\n\n// ============================================"),
  section("const SANITIZE_CONFIG = {", "\n// DOMPurify's default URI"),
  section("function sanitizeHtml(html) {", "// The table dialogs"),
  section("const TABLE_SANITIZE_CONFIG = {", "\n// The @@@html fence"),
  section("const RAW_HTML_FENCE = ", "\n"),
  section("function eachRawHtmlBlock(", "\n\n\n// author HTML"),
  section("function createBlockPlaceholders(", "\n// Light-format render:"),
  section("const UI_STRINGS = {", "\nconst TIMING = "),
  `
const markdownEditor = document.getElementById('editor'), viewer = document.getElementById('viewer');
const tab = Object.freeze({id:'owned-saved-cell'});
let exact = ${JSON.stringify(original)}, tableCellSession = null, tableMenuSelection = null;
let isEditMode = true, editorModeRevision = 1, fileOpenSequence = 1, editorInteractionRevision = 1;
let exactTypingSource = '', rightClickTarget = markdownEditor;
const history = [], notifications = [], copied = [], readingGeneratedContainers = new WeakMap(),
  readingPatchBodies = new WeakMap(), attributes = new Map();
const noteViewerMutation = () => {}, copyTextToClipboard = async text => {copied.push(text); return true;};
let rawHtmlDocuments = new Map();
const mintPlaceholderNonce = () => crypto.randomUUID().replace(/-/g,'');
const rawHtmlIframeMarkup = () => {throw new Error('Raw body escaped preprocessing protection');};
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
  section("const codeBlockCopySources = ", "// Extract table data as structured JSON"),
  `
async function renderMarkdown(content, _mode, viewport = {}) {
  const source = editorScroll.source(content), fresh = document.createElement('div');
  const full = fullPreprocess(content, source), light = lightPreprocess(content, editorScroll.source(content));
  if (full !== light) throw new Error('Shipping full/light preprocessing differs');
  fresh.innerHTML = full;
  const bindings = source.detach(fresh, sanitizeHtml), bodies = [...fresh.children];
  window.fixtureMetadata = {
    blocks:bodies.map(node => ({tag:node.tagName,mapped:!!bindings.get(node)})),
    cells:[...fresh.querySelectorAll('tr')].map(row => [...row.cells].map(cell => !!bindings.get(cell))),
  };
  viewer.replaceChildren(...bodies);
  for (const body of bodies) source.adopt(body, body, bindings);
  const tables = [...viewer.querySelectorAll('table')];
  for (const table of tables)
    readingGeneratedContainers.set(table, {wrapper:null, controls:[], decorations:[], code:null});
  editorScroll.commit(source);
  highlightNewElements(source);
  addCodeBlockCopyButtons(source);
  const associations = bodies.filter(body => source.readingTextSpecs.has(body)).map(body => ({
    fresh:body, body,
    owners:[body,...body.querySelectorAll('*')].filter(node =>
      bindings.get(node)?.readingCode || bindings.get(node)?.readingTable).map(node => ({
      fresh:node, body:node, wrapper:null, controls:[], decorations:[], code:node.querySelector('code'),
      ...readingGeneratedContainers.get(node), header:node.tagName === 'TABLE' ? node.tHead : null, breakout:null,
    })),
    attributes:[...attributes].filter(([node]) => body.contains(node)).flatMap(([node,names]) =>
      [...names].map(([name,value]) => ({body:node,name,value}))),
  }));
  window.readerReceipt = editorScroll.bindReadingPresentation(source,
    {owner:'owned-saved-cell',revision:1}, associations).status;
  viewport.completion = Promise.resolve();
}
`,
  "function fullPreprocess(content, scrollSource) {\n" +
    section("    // Keep source positions while removing the BOM and expanding emoji.",
      "\n  // Sanitize last, once everything") + "\nreturn sanitizeHtml(html);\n}",
  "function lightPreprocess(content, scrollSource) {\n" +
    section("  // Both render paths protect complete raw cells before any text transforms.",
      "\n  if (generation !== renderGeneration) return;\n\n  patchViewerDOM") + "\nreturn html;\n}",
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
    const source = markdownEditor.value, start = source.indexOf('| Name'),
      lineStart = source.lastIndexOf('\\n',start-1)+1;
    tableMenuSelection = {tab,source,mode:editorModeRevision,sequence:fileOpenSequence,
      sourceLine:{start:lineStart,end:source.indexOf('\\n',start)}, origin:'markdown', start,end:start,
      direction:'none',isCurrent:() => isEditMode && markdownEditor.value === source};
    openTableCellEditor(TableCellMode.UPDATE_TABLE);
    if (!tableCellDialog.open || !tableCellSession?.ready)
      throw new Error('Shipping popup did not open: '+JSON.stringify(notifications.slice(-1)));
  },
  input(column = 1) {return tableCellSession.rows[1].cells[column].input;},
  paste(text, column = 1, whole = true) {
    const input = this.input(column); input.focus();
    const range = document.createRange(); range.selectNodeContents(input);
    if (!whole) range.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const data = new DataTransfer(); data.setData('text/plain',text);
    input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
    const current = this.input(column);
    return {html:current.innerHTML,text:current.value ?? current.innerText,
      literal:current.tagName === 'TEXTAREA',code:!!current.querySelector('code')};
  },
  editText(before, after, insideCode = false) {
    const input = this.input(), scope = insideCode ? input.querySelector('code') : input;
    if (input.tagName === 'TEXTAREA') {
      const start = input.value.indexOf(before);
      if (start < 0) throw new Error('Literal draft edit target missing');
      input.focus(); input.setSelectionRange(start,start+before.length);
      if (!document.execCommand('insertText',false,after)) throw new Error('Literal draft input failed');
      return true;
    }
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
  async rejectedUpdate() {
    const before = exact, undo = history.length, input = this.input();
    await updateTableCells();
    return {open:tableCellDialog.open,error:tableCellError.textContent,
      unchanged:exact === before && history.length === undo,draft:input.value};
  },
  literalState() {
    const cell = tableCellSession.rows[1].cells[1];
    return {source:cell.engine.readSource(),dirty:cell.engine.isDirty(),value:cell.input.value};
  },
  history(command) {this.input().focus(); return document.execCommand(command);},
  historyInput(inputType, value) {
    const input = this.input();
    input.value = value;
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType}));
  },
  moveLiteralRow() {
    const session = tableCellSession, before = session.rows.slice();
    selectTableCell(session,session.rows[1].cells[1]);
    moveTableCell('row',1);
    return {unchanged:before.every((row,index) => session.rows[index] === row),
      exact,error:tableCellError.textContent};
  },
  compose(type) {this.input().dispatchEvent(new CompositionEvent(type,{bubbles:true,data:''}));},
  async copy() {
    copied.length = 0;
    viewer.querySelector('td .code-copy-btn').click();
    await Promise.resolve();
    return copied.slice();
  },
  waitCopyReset() {
    const button = viewer.querySelector('td .code-copy-btn');
    return new Promise((resolve,reject) => {
      const observer = new MutationObserver(() => {
        if (button.classList.contains('copied')) return;
        observer.disconnect(); clearTimeout(timeout); resolve();
      });
      observer.observe(button,{attributes:true,attributeFilter:['class']});
      const timeout = setTimeout(() => {
        observer.disconnect(); reject(new Error('Copy feedback did not reset'));
      },5000);
    });
  },
  bodies() {
    return [...viewer.querySelectorAll('pre.table-fenced-code-block > code')].map(code => code.textContent);
  },
  rowWidths() {return [...viewer.querySelectorAll('tbody tr')].map(row => row.cells.length);},
  authority(tamper = false) {
    const previous = isEditMode; isEditMode = true;
    try {
      const table = viewer.querySelector('table');
      const model = MarkalooTableCells.index(exact,marked,protectTableSource), target = model.tables[0];
      if (tamper) table.querySelector('code').append(document.createTextNode('unowned'));
      return {receipt:editorScroll.tableSource(table),start:target?.start,end:target?.end};
    } finally {isEditMode = previous;}
  },
  async reader(source) {
    closeTableCellEditor(); isEditMode = false; exact = source;
    markdownEditor.value = MarkalooTableCells.normalise(source);
    await renderMarkdown(markdownEditor.value);
    return this.state();
  },
  reuseTable() {
    const table = viewer.querySelector('table'), button = table.querySelector('.code-copy-btn');
    const before = exact;
    exact += '\\nFixture-only outside change.\\n';
    markdownEditor.value = MarkalooTableCells.normalise(exact);
    const source = editorScroll.source(markdownEditor.value), fresh = document.createElement('div');
    fresh.innerHTML = fullPreprocess(markdownEditor.value,source);
    const bindings = source.detach(fresh,sanitizeHtml), nodes = [...fresh.children];
    const adopted = nodes.map(node => node.tagName === 'TABLE' ? table : node);
    nodes.forEach((node,index) => source.adopt(node,adopted[index],bindings));
    viewer.replaceChildren(...adopted);
    addCodeBlockCopyButtons(source);
    editorScroll.commit(source);
    return {changed:exact !== before,preserved:viewer.querySelector('table') === table &&
      table.querySelector('.code-copy-btn') === button,copied:button.classList.contains('copied'),
      authority:this.authority()};
  },
  searchCode() {
    const code = viewer.querySelector('td pre code');
    const node = document.createTreeWalker(code,NodeFilter.SHOW_TEXT).nextNode();
    const span = document.createElement('span'); span.className = 'search-highlight';
    node.replaceWith(span); span.append(node);
    return {wrapped:!!code.querySelector('span.search-highlight'),authority:this.authority()};
  },
  async refusal(source) {
    await this.reader(source);
    return {exact, literal:viewer.querySelector('.table-source-warning pre code')?.textContent,
      warning:viewer.querySelector('.table-source-warning p')?.textContent,
      tables:viewer.querySelectorAll('table').length, heading:viewer.querySelector('h1')?.textContent,
      script:!!viewer.querySelector('script')};
  },
  state() {
    const table = viewer.querySelector('table'), cell = table?.tBodies[0]?.rows[0]?.cells[1];
    const code = cell?.querySelector('code'), token = code?.querySelector('.token');
    return {exact,edit:isEditMode,open:tableCellDialog.open,receipt:window.readerReceipt,
      rows:table?.rows.length,columns:table?.rows[0].cells.length,html:cell?.innerHTML,text:cell?.textContent,
      code:code?.textContent,language:code?.className,tokens:code?.querySelectorAll('.token').length || 0,
      color:token && getComputedStyle(token).color,baseColor:code && getComputedStyle(code).color,
      whiteSpace:code && getComputedStyle(code).whiteSpace,notifications:notifications.slice(),
      script:!!viewer.querySelector('script'),neighbor:table?.tBodies[0]?.rows[0]?.cells[2]?.textContent,
      warning:viewer.querySelector('.table-source-warning')?.textContent,allText:viewer.textContent};
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
    "src\\utils.js","src\\emoji-map.js","src\\emoji-parser.js","src\\table-source.js","src\\table-marked.js","src\\inline-formatting.js",
    "src\\table-cell-editor.js","src\\editor-scroll.js"];
  const dependency = file => {
    if (file !== proof?.file) return file.startsWith("libs") ? asset(file) : absolute(file);
    const target = path.join(output,"reverted-"+path.basename(file));
    fs.writeFileSync(target,read(file));
    return target;
  };
  const dependencyPaths = dependencies.map(dependency);
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>Owned saved table cell</title>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src file:; ' +
    'style-src file: \'unsafe-inline\'; font-src file:; img-src data:">' +
    `<link rel="stylesheet" href="${pathToFileURL(path.join(root,"src","styles.css")).href}">` +
    '<style>body{display:block;padding:24px}#editor{position:fixed;left:-10000px}' +
    '#viewer{display:block;position:static;height:820px;overflow:auto}</style>' +
    '<textarea id="editor"></textarea><div id="viewer" class="markdown-body"></div>' +
    index.slice(start,end+"</dialog>".length) +
    dependencyPaths.map(file => `<script src="${pathToFileURL(file).href}"></script>`).join("") +
    '<script src="page.js"></script>');
  const guest = session.fromPartition("saved-table-cell");
  guest.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
  const allowed = new Set([page,script,path.join(root,"src","styles.css"),
    ...dependencyPaths,
    ...["Regular","Bold","Light","Medium","SemiBold"].flatMap(weight =>
      [asset("fonts\\FiraCode-"+weight+".ttf"),absolute("fonts\\FiraCode-"+weight+".ttf")])]
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
  const execute = async code => {
    const result = await win.webContents.executeJavaScript(
      "(async()=>{try{return {ok:true,value:await ("+code+")};}"+
      "catch(error){return {ok:false,stack:error.stack || String(error)};}})()");
    if (!result.ok) throw new Error(result.stack);
    return result.value;
  };
  await win.loadFile(page);
  await execute("console.error('saved-cell-sentinel')");
  check("saved cell console sentinel is alive",errors.includes("saved-cell-sentinel"),errors.slice());
  errors.length = 0;
  if (process.argv.includes("--raw-render-only")) {
    for (const sample of require("./fixtures/table-code-literals").cases) {
      for (const eol of ["\n","\r\n"]) {
        const source = original.replace(/\r\n/g,eol).replace("replace me", () =>
          "````"+sample.language+eol+sample.body.replace(/\n/g,eol)+eol+"````");
        try {
          const observed = await execute("fixture.reader("+JSON.stringify(source)+")");
          check("raw render "+sample.id+" "+JSON.stringify(eol)+" keeps source, literal body and Reader binding",
            observed.exact === source && observed.code === sample.body && observed.tokens > 0 &&
            observed.receipt === "bound" && !observed.script && observed.rows === 3 && observed.columns === 3,observed);
          const authority = await execute("fixture.authority()");
          check("raw render "+sample.id+" "+JSON.stringify(eol)+" decorated table keeps exact model authority",
            authority.receipt?.start === authority.start && authority.receipt?.end === authority.end,authority);
          const copies = await execute("fixture.copy()");
          check("raw render "+sample.id+" "+JSON.stringify(eol)+" copy receives only literal body",
            copies.length === 1 && copies[0] === sample.body,copies);
          const afterCopy = await execute("fixture.authority()");
          check("raw render "+sample.id+" "+JSON.stringify(eol)+" copy feedback preserves model authority",
            afterCopy.receipt?.start === afterCopy.start && afterCopy.receipt?.end === afterCopy.end,afterCopy);
          if (sample.id === "json-escapes" && eol === "\n") {
            await execute("fixture.waitCopyReset()");
            const reset = await execute("fixture.authority()");
            check("raw render copy feedback reset preserves model authority",
              reset.receipt?.start === reset.start && reset.receipt?.end === reset.end,reset);
          }
          if (eol === "\n") {
            const image = await win.webContents.capturePage({stayHidden:true,stayAwake:true});
            if (image.isEmpty()) throw new Error('Empty raw Reader image');
            fs.writeFileSync(path.join(output,sample.id+".png"),image.toPNG());
          }
          const unowned = await execute("fixture.authority(true)");
          check("raw render "+sample.id+" "+JSON.stringify(eol)+" rejects altered table ownership",
            unowned.receipt === null,unowned);
        } catch (error) { check("raw render "+sample.id+" "+JSON.stringify(eol),false,error.stack); }
      }
    }
    for (const header of ['| Only |','Only']) for (const eol of ['\n','\r\n']) {
      const body = ':smile: | 😀\n@@@html\n<script>literal</script>\n@@@';
      const source = '\uFEFF# Before 😀\n\n'.replace(/\n/g,eol) +
        [header,'| --- |','plain before','| ```rust',body,'``` |','plain after'].join('\n').replace(/\n/g,eol);
      const observed = await execute("fixture.reader("+JSON.stringify(source)+")");
      const literal = await execute("fixture.bodies()");
      check("raw native body "+header+" "+JSON.stringify(eol)+" preserves rendering and Reader metadata",
        observed.exact === source && observed.rows === 4 && observed.columns === 1 &&
        observed.receipt === "bound" && !observed.warning && !observed.script &&
        literal.length === 1 && literal[0] === body,{observed,literal});
      const authority = await execute("fixture.authority()");
      check("raw native body "+header+" "+JSON.stringify(eol)+" retains exact editor authority",
        authority.receipt?.start === authority.start && authority.receipt?.end === authority.end,authority);
    }
    for (const boundary of ['# Heading | boundary','- list | boundary','<div data-value="a|b">']) {
      const prefix = '# Before\n\n';
      const candidate = '| Name | Payload | Other |\n| --- | --- | --- |\n' +
        '| first | ```rust\n:smile:\n@@@html\n<script>literal</script>\n@@@\n``` | outside |\n' +
        boundary + '\n\n| ```rust\nlater\n``` |\n';
      const source = prefix + candidate;
      const observed = await execute("fixture.refusal("+JSON.stringify(source)+")");
      check("raw refusal "+boundary+" preserves literal source across full light and metadata paths",
        observed.exact === source && observed.literal === candidate &&
        observed.warning?.includes("Markdown block boundary") && observed.tables === 0 &&
        observed.heading === "Before" && !observed.script,observed);
    }
    const feedbackSource = original.replace("replace me",() => fence.replace(/\n/g,"\r\n"));
    for (const gap of ["\n","\n\n"]) {
      const source = "# Heading" + gap +
        "| Name | Code |\n| --- | --- |\n| demo | ```text\n:smile:\n``` |\n";
      const observed = await execute("fixture.reader("+JSON.stringify(source)+")");
      const bodies = await execute("fixture.bodies()");
      const eligible = gap === "\n\n";
      check("raw render heading separation "+JSON.stringify(gap)+" follows frozen standalone eligibility",
        observed.exact === source && (eligible
          ? bodies.length === 1 && bodies[0] === ":smile:" && observed.receipt === "bound"
          : bodies.length === 0 && observed.allText.includes("\uD83D\uDE04")),
        {source,observed,bodies});
    }
    for (const row of ["| only |","| first | second | EXTRA_ONLY |"]) {
      const source = "# Before\n\n| Left | Right |\n| --- | ---: |\n" +
        row + "\n| raw | ```rust\nbody\n``` |\n\nAfter stays mapped.\n";
      const observed = await execute("fixture.reader("+JSON.stringify(source)+")");
      const widths = await execute("fixture.rowWidths()");
      check("raw render ordinary row retains native width "+row,
        widths.length === 2 && widths.every(width => width === 2) &&
        !observed.allText.includes("EXTRA_ONLY"),{observed,widths});
      const metadata = await execute("fixtureMetadata"), authority = await execute("fixture.authority()");
      check("raw render ragged row keeps document metadata and real-cell authority "+row,
        observed.receipt === "bound" && authority.receipt?.start === source.indexOf("| Left") &&
        authority.receipt?.end === source.indexOf("\n\nAfter") &&
        JSON.stringify(metadata.blocks) === JSON.stringify(["H1","TABLE","P"].map(tag => ({tag,mapped:true}))) &&
        metadata.cells[1][0] && metadata.cells[1][1] === row.includes("EXTRA_ONLY") &&
        metadata.cells[2].every(Boolean),{metadata,authority,observed});
    }
    for (const mode of ["reuse","search"]) {
      await execute("fixture.reader("+JSON.stringify(feedbackSource)+")");
      const setup = await execute(mode === "reuse" ? "fixture.reuseTable()" : "fixture.searchCode()");
      check("raw feedback "+mode+" proves current source-bound setup",
        (mode === "reuse" ? setup.changed && setup.preserved : setup.wrapped) &&
        !!setup.authority.receipt,setup);
      const copied = await execute("fixture.copy()"), authority = await execute("fixture.authority()");
      check("raw feedback "+mode+" preserves authority",
        copied.length === 1 && copied[0] === json && !!authority.receipt,{copied,authority});
      const pending = await execute("fixture.reuseTable()");
      check("raw feedback "+mode+" preserves pending feedback through source replacement",
        pending.changed && pending.preserved && pending.copied, pending);
      await execute("fixture.waitCopyReset()");
      const reset = await execute("fixture.authority()");
      check("raw feedback "+mode+" reset uses current source and canonical markup",!!reset.receipt,reset);
    }
    const ordinary = await execute("fixture.reader("+JSON.stringify(original)+")");
    check("raw render ordinary table keeps native source and Reader authority",
      ordinary.exact === original && ordinary.rows === 3 && ordinary.columns === 3 &&
      ordinary.receipt === "bound" && ordinary.neighbor === "escaped | neighbor" && !ordinary.script,ordinary);
    check("raw render guest has no external requests or unexpected errors",!blocked.length && !errors.length,{blocked,errors});
    return;
  }
  for (const plain of ["```inline```","```rust extra"]) {
    await execute("fixture.load()");
    await execute("fixture.open()");
    const pasted = await execute("fixture.paste("+JSON.stringify(plain)+")");
    check("ordinary whole-cell paste "+plain+" keeps semantic input",!pasted.literal,pasted);
    const updated = await execute("fixture.rejectedUpdate()");
    check("ordinary whole-cell paste "+plain+" can Update",!updated.open && !updated.unchanged,updated);
  }
  await execute("fixture.load()");
  await execute("fixture.open()");
  const incomplete = await execute('fixture.paste("```rust")');
  const refused = await execute("fixture.rejectedUpdate()");
  check("genuine incomplete raw opener stays a repairable rejected draft",
    incomplete.literal && refused.open && refused.unchanged && refused.draft === "```rust",{incomplete,refused});
  for (const {name,before,after,eol} of pastePaddingCases) {
    const text = before + fence.replace(/\n/g,eol) + after;
    await execute("fixture.load()");
    await execute("fixture.open()");
    const pasted = await execute("fixture.paste("+JSON.stringify(text)+")");
    const draft = pasted.literal ? await execute("fixture.literalState()") : null;
    check("ordinary padded raw paste "+name+" preserves exact draft",
      pasted.literal && draft.source === text && draft.dirty,{pasted,draft});
    if (!pasted.literal) {
      check("ordinary padded raw paste "+name+" keeps exact Update and reopen",false,
        {blocked:"Paste did not promote to the literal editor",pasted});
      continue;
    }
    try {
      const saved = await execute("fixture.update()");
      const observed = await execute("fixture.reader("+JSON.stringify(saved.exact)+")");
      await execute("fixture.open()");
      const reopened = await execute("fixture.update()");
      check("ordinary padded raw paste "+name+" keeps exact Update and reopen",
        saved.exact === original.replace("replace me",() => text) &&
        saved.history.length === 1 && saved.history[0] === original &&
        observed.code === json && observed.rows === 3 && observed.columns === 3 &&
        observed.neighbor === "escaped | neighbor" && observed.receipt === "bound" &&
        reopened.exact === saved.exact && reopened.history.length === 1,
        {saved,observed,reopened});
    } catch (error) {
      check("ordinary padded raw paste "+name+" keeps exact Update and reopen",false,error.stack);
    }
  }
  for (const [name,text] of paddedMalformedPastes) {
    await execute("fixture.load()");
    await execute("fixture.open()");
    const pasted = await execute("fixture.paste("+JSON.stringify(text)+")");
    const rejected = pasted.literal ? await execute("fixture.rejectedUpdate()") : null;
    check("ordinary padded malformed paste "+name+" keeps draft and unchanged Source",
      pasted.literal && rejected.open && rejected.unchanged && !!rejected.error &&
      rejected.draft === text.replace(/\r\n/g,"\n"),{pasted,rejected});
  }
  for (const [name,before] of [["nbsp","\u00a0"],["bom","\uFEFF"],["bare-cr","\r"]]) {
    await execute("fixture.load()");
    await execute("fixture.open()");
    const pasted = await execute("fixture.paste("+JSON.stringify(before+fence)+")");
    check("ordinary disallowed-padding control "+name+" stays semantic",!pasted.literal,pasted);
  }
  await execute("fixture.load()");
  await execute("fixture.open()");
  const partial = await execute("fixture.paste("+JSON.stringify("\n"+fence)+",1,false)");
  check("ordinary partial-cell padded paste stays semantic",
    !partial.literal && partial.text.startsWith("replace me"),partial);
  if (process.argv.includes("--raw-paste-only")) {
    check("raw paste guest has no external requests or unexpected errors",!blocked.length && !errors.length,{blocked,errors});
    return;
  }
  await execute("fixture.load()");
  await execute("fixture.open()");
  const pasted = await execute("fixture.paste("+JSON.stringify(fence)+")");
  check("saved cell raw paste reaches shipping popup as multiline literal",
    pasted.literal && !pasted.code && pasted.text.replace(/\r\n/g,"\n") === fence,pasted);
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
  for (const sample of require("./fixtures/table-code-literals").cases) {
    for (const eol of ["\n", "\r\n"]) {
      const name = sample.id + (eol === "\n" ? "-lf" : "-crlf");
      const body = sample.body;
      const text = "````" + sample.language + eol + body.replace(/\n/g,eol) + eol + "````";
      await execute("fixture.load()");
      await execute("fixture.open()");
      const setup = await execute("fixture.paste("+JSON.stringify(text)+")");
      check("saved cell "+name+" literal language setup reaches the popup",
        body.includes("|") && body.includes("```") && body.includes("\n\n") &&
        body.includes("\t") && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(body) &&
        setup.text.replace(/\r\n/g,"\n") === text.replace(/\r\n/g,"\n") && !setup.code,setup);
      const saved = await execute("fixture.update()");
      const observed = await execute("fixture.reader("+JSON.stringify(saved.exact)+")");
      check("saved cell "+name+" keeps literal body safe and outside bytes exact",
        observed.code === body && observed.tokens > 0 && observed.receipt === "bound" &&
        observed.rows === 3 && observed.columns === 3 && observed.neighbor === "escaped | neighbor" &&
        !observed.script && !blocked.length && saved.history.length === 1 &&
        saved.history[0] === original &&
        saved.exact.startsWith(original.slice(0,original.indexOf("replace me"))) &&
        saved.exact.endsWith(original.slice(original.indexOf("replace me")+"replace me".length)),observed);
      await execute("fixture.open()");
      const noop = await execute("fixture.update()");
      check("saved cell "+name+" reopened no-op keeps exact saved source",
        noop.exact === saved.exact,noop);
      await execute("fixture.open()");
      const changed = await execute("fixture.editText('owned-before','owned-after',true)");
      const edited = await execute("fixture.update()");
      const final = await execute("fixture.reader("+JSON.stringify(edited.exact)+")");
      check("saved cell "+name+" reopened code edit changes only its marker",
        changed && final.code === body.replace("owned-before","owned-after") &&
        final.tokens > 0 && final.receipt === "bound" &&
        edited.exact === saved.exact.replace("owned-before","owned-after"),final);
    }
  }
  const paddedBody = '\n\t{\n  "padded": true  \n}\t \n\n';
  const paddedCases = [
    ["leading-space", " ", json, ""],
    ["trailing-break", "", json, "\n"],
    ["padded", " \t", paddedBody, ""],
  ];
  for (const [label, before, body, after] of paddedCases) {
    const text = before + "```json\n" + body + "\n```" + after;
    await execute("fixture.load()");
    await execute("fixture.open()");
    const setup = await execute("fixture.paste("+JSON.stringify(text)+")");
    check("saved cell "+label+" paste preserves its whitespace setup",
      setup.text.replace(/\r\n/g,"\n") === text && !setup.code,setup);
    const saved = await execute("fixture.update()");
    const observed = await execute("fixture.reader("+JSON.stringify(saved.exact)+")");
    fs.writeFileSync(path.join(output,label+"-saved.md"),saved.exact);
    fs.writeFileSync(path.join(output,label+"-reader.json"),JSON.stringify(observed,null,2));
    check("saved cell "+label+" raw fence preserves body and outside table bytes",
      observed.code === body &&
      observed.tokens > 0 && observed.receipt === "bound" &&
      observed.rows === 3 && observed.columns === 3 &&
      saved.history.length === 1 && saved.history[0] === original &&
      saved.exact.startsWith(original.slice(0,original.indexOf("replace me"))) &&
      saved.exact.endsWith(original.slice(original.indexOf("replace me")+"replace me".length)),observed);
    await execute("fixture.open()");
    const reopened = await execute("fixture.update()");
    check("saved cell "+label+" converted fence reopens without source changes",
      reopened.exact === saved.exact,reopened);
    await execute("fixture.open()");
    const changed = await execute("fixture.editText("+JSON.stringify(body === json ? "synthetic-42" : "true")+","+
      JSON.stringify(body === json ? "synthetic-43" : "false")+",true)");
    const edited = await execute("fixture.update()");
    const final = await execute("fixture.reader("+JSON.stringify(edited.exact)+")");
    const expected = body.replace(body === json ? "synthetic-42" : "true",body === json ? "synthetic-43" : "false");
    check("saved cell "+label+" reopened code edit preserves padding and table bytes",
      changed && final.code === expected &&
      final.tokens > 0 && edited.exact === saved.exact.replace(
        body === json ? "synthetic-42" : "true",body === json ? "synthetic-43" : "false"),final);
  }
  const controls = [
    ["unknown","```not-supported\n{}\n```"], ["unlabelled","```\n{}\n```"],
    ["mermaid","```mermaid\nA --> B\n```"],
    ["padded-unknown"," ```not-supported\n{}\n```\n"],
  ];
  for (const [label, text] of controls) {
    await execute("fixture.load()");
    await execute("fixture.open()");
    await execute("fixture.paste("+JSON.stringify(text)+")");
    const saved = await execute("fixture.update()");
    const observed = await execute("fixture.reader("+JSON.stringify(saved.exact)+")");
    const body = label === "mermaid" ? "A --> B" : "{}";
    check("saved cell "+label+" body stays plain literal code",
      observed.code === body && observed.tokens === 0 && observed.receipt === "bound",observed);
  }
  for (const [label,text] of [
    ["unclosed","```json\n{}"],["single-line incomplete","```json"],
    ["multiple","```json\n{}\n```\n```json\n{}\n```"],
    ["closer collision","```sql\nSELECT 1;\n```| data\n```"],
  ]) {
    await execute("fixture.load()");
    await execute("fixture.open()");
    const setup = await execute("fixture.paste("+JSON.stringify(text)+")");
    const rejected = await execute("fixture.rejectedUpdate()");
    check("saved cell "+label+" Update retains the raw draft and exact source",
      setup.literal && rejected.open && rejected.unchanged && !!rejected.error &&
      rejected.draft === text,rejected);
  }
  const protectedBody = ":smile:\n\n```mermaid\nA --> B\n```\n\n@@@html\n<script>literal only</script>\n@@@\n\tend";
  const protectedSource = original.replace("# Owned saved cell", "# :smile: outside")
    .replace("replace me", "````text\r\n"+protectedBody.replace(/\n/g,"\r\n")+"\r\n````");
  const protectedState = await execute("fixture.reader("+JSON.stringify(protectedSource)+")");
  check("saved cell shipping full and light preprocessing protect raw specials but expand outside emoji",
    protectedState.code === protectedBody && protectedState.allText.includes("\uD83D\uDE04 outside") &&
    !protectedState.script && protectedState.receipt === "bound",protectedState);
  const incompleteSource = original.replace("replace me", "````json\r\n:smile:\r\n@@@html\r\n<script>literal</script>");
  const incompleteState = await execute("fixture.reader("+JSON.stringify(incompleteSource)+")");
  check("saved cell missing closer shows an unchanged literal remainder and warning",
    !!incompleteState.warning && incompleteState.warning.includes(":smile:\n@@@html\n<script>literal</script>") &&
    !incompleteState.script && incompleteState.exact === incompleteSource,incompleteState);
  const mixedFence = "````rust\r\nlet marker = \"owned-before\";\n\tlet pipe = \"|\";\r\n\r\n````";
  const mixedSource = "\uFEFF"+original.replace("replace me",() => mixedFence);
  await execute("fixture.load("+JSON.stringify(mixedSource)+")");
  await execute("fixture.open()");
  const mixedInitial = await execute("fixture.literalState()");
  check("saved cell BOM and mixed-ending raw editor retains the exact initial envelope",
    mixedInitial.source === mixedFence && !mixedInitial.dirty,mixedInitial);
  await execute("fixture.editText('owned-before','owned-after')");
  const mixedEdit = await execute("fixture.literalState()");
  const undone = await execute("fixture.history('undo')");
  const mixedUndo = await execute("fixture.literalState()");
  check("saved cell native local undo restores exact mixed endings without a dirty transaction",
    undone && mixedEdit.dirty && mixedUndo.source === mixedFence && !mixedUndo.dirty,mixedUndo);
  const redone = await execute("fixture.history('redo')");
  const mixedRedo = await execute("fixture.literalState()");
  check("saved cell native local redo restores the exact changed envelope",
    redone && mixedRedo.dirty && mixedRedo.source === mixedFence.replace("owned-before","owned-after"),mixedRedo);
  const repeatedFence = "````text\r\nleft\nright\r\n````";
  const repeatedSource = original.replace("replace me",() => repeatedFence);
  await execute("fixture.load("+JSON.stringify(repeatedSource)+")");
  await execute("fixture.open()");
  await execute("fixture.editText('left\\nright','leftright')");
  const deletedEnding = await execute("fixture.literalState()");
  await execute("fixture.editText('leftright','left\\nright')");
  const reinsertedEnding = await execute("fixture.literalState()");
  check("saved cell repeated visible history has different exact newline versions",
    deletedEnding.source === repeatedFence.replace("left\nright","leftright") &&
    reinsertedEnding.source === repeatedFence.replace("left\nright","left\r\nright") &&
    reinsertedEnding.dirty,{deletedEnding,reinsertedEnding});
  const repeatedUndo1 = await execute("fixture.history('undo')");
  const repeatedMiddle = await execute("fixture.literalState()");
  const repeatedUndo2 = await execute("fixture.history('undo')");
  const repeatedOriginal = await execute("fixture.literalState()");
  check("saved cell repeated visible native Undo restores original exact endings",
    repeatedUndo1 && repeatedUndo2 && repeatedMiddle.source === deletedEnding.source &&
    repeatedOriginal.source === repeatedFence && !repeatedOriginal.dirty,{repeatedMiddle,repeatedOriginal});
  const repeatedRedo1 = await execute("fixture.history('redo')");
  const repeatedRedoMiddle = await execute("fixture.literalState()");
  const repeatedRedo2 = await execute("fixture.history('redo')");
  const repeatedChanged = await execute("fixture.literalState()");
  check("saved cell repeated visible native Redo restores each exact version",
    repeatedRedo1 && repeatedRedo2 && repeatedRedoMiddle.source === deletedEnding.source &&
    repeatedChanged.source === reinsertedEnding.source && repeatedChanged.dirty,{repeatedRedoMiddle,repeatedChanged});
  await execute("fixture.load("+JSON.stringify(repeatedSource)+")");
  await execute("fixture.open()");
  const validMove = await execute("fixture.moveLiteralRow()");
  check("saved cell raw row movement proves a valid unchanged-source setup",
    !validMove.unchanged && validMove.exact === repeatedSource && !validMove.error,validMove);
  const movedRaw = await execute("fixture.update()");
  const firstRow = "| sample | " + repeatedFence + " | escaped \\| neighbor |\r\n";
  const secondRow = "| untouched | **unchanged** | tail\\\\ |\r\n";
  check("saved cell raw row movement Update preserves exact raw bytes and one document change",
    movedRaw.exact === repeatedSource.replace(firstRow + secondRow,secondRow + firstRow) &&
    movedRaw.history.length === 1 && movedRaw.history[0] === repeatedSource,movedRaw);
  for (const mode of ["same-visible","ambiguous","missing"]) {
    await execute("fixture.load("+JSON.stringify(repeatedSource)+")");
    await execute("fixture.open()");
    await execute("fixture.editText('left\\nright','leftright')");
    await execute("fixture.editText('leftright','left\\nright')");
    if (mode === "ambiguous") await execute("fixture.editText('right','RIGHT')");
    const value = mode === "missing" ? "````text\nunrecorded\n````" : repeatedFence.replace(/\r\n/g,"\n");
    await execute("fixture.historyInput('historyUndo',"+JSON.stringify(value)+")");
    if (mode === "same-visible") {
      const restored = await execute("fixture.literalState()");
      check("saved cell synthetic same-visible history resolves before no-change shortcut",
        restored.source === repeatedFence && !restored.dirty,restored);
    } else {
      const moved = await execute("fixture.moveLiteralRow()");
      const rejected = await execute("fixture.rejectedUpdate()");
      check("saved cell synthetic "+mode+" history blocks structural change and Update without guessing",
        moved.unchanged && moved.error.includes("Undo or Redo") && rejected.open &&
        rejected.unchanged && rejected.error.includes("Undo or Redo") &&
        rejected.draft === value,{moved,rejected});
    }
  }
  await execute("fixture.load("+JSON.stringify(mixedSource)+")");
  await execute("fixture.open()");
  await execute("fixture.editText('owned-before','owned-after')");
  await execute("fixture.compose('compositionstart')");
  const composing = await execute("fixture.rejectedUpdate()");
  check("saved cell active raw composition rejects Update without changing source or draft",
    composing.open && composing.unchanged && !!composing.error &&
    composing.draft === mixedRedo.value,composing);
  await execute("fixture.compose('compositionend')");
  await execute("fixture.editText('owned-after','owned-after\\ninserted')");
  const newline = await execute("fixture.update()");
  check("saved cell inserted newline uses the row ending while preserving BOM and mixed untouched endings",
    newline.exact === mixedSource.replace("owned-before","owned-after\r\ninserted") &&
    newline.history.length === 1 && newline.history[0] === mixedSource,newline);
  await execute("fixture.load()");
  await execute("fixture.open()");
  await execute("fixture.compose('compositionstart')");
  const composingPaste = await execute("fixture.paste("+JSON.stringify(fence)+")");
  const composingState = await execute("fixture.state()");
  check("saved cell composing semantic surface cannot be replaced by a raw paste",
    !composingPaste.literal && composingPaste.text === "replace me" &&
    composingState.exact === original && composingState.open,composingPaste);
  await execute("fixture.compose('compositionend')");
  const samples = require("./fixtures/table-code-literals").cases;
  const raw = sample => "````"+sample.language+"\r\n"+sample.body.replace(/\n/g,"\r\n")+"\r\n````";
  const [csharp,rust,,sql] = samples;
  const multiSource = original.replace("Payload",() => raw(rust))
    .replace("| sample | replace me | escaped \\| neighbor |",() =>
      "| "+raw(csharp)+" | "+fence.replace(/\n/g,"\r\n")+" | "+raw(sql)+" |");
  const multiState = await execute("fixture.reader("+JSON.stringify(multiSource)+")");
  const multiBodies = await execute("fixture.bodies()");
  check("saved cell raw header and multiple raw body cells bind the same production table",
    multiState.receipt === "bound" && multiState.rows === 3 && multiState.columns === 3 &&
    JSON.stringify(multiBodies) === JSON.stringify([rust.body,csharp.body,json,sql.body]),multiBodies);
  await execute("fixture.open()");
  await execute("fixture.editText('synthetic-42','synthetic-43')");
  const multiEdited = await execute("fixture.update()");
  check("saved cell raw-header multi-cell Update preserves all other literal cells and bytes",
    multiEdited.exact === multiSource.replace("synthetic-42","synthetic-43") &&
    multiEdited.history.length === 1 && multiEdited.history[0] === multiSource,multiEdited);
  const bomTable = "\uFEFF"+original.slice(original.indexOf("| Name")).replace("replace me",() => mixedFence);
  await execute("fixture.load("+JSON.stringify(bomTable)+")");
  const bomAuthority = await execute("fixture.authority()");
  await execute("fixture.open()");
  const bomNoop = await execute("fixture.update()");
  check("saved cell document-initial BOM table has absolute authority and unchanged no-op Update",
    bomAuthority.receipt?.start === 1 && bomAuthority.receipt.end === bomAuthority.end &&
    bomNoop.exact === bomTable && bomNoop.history.length === 0,bomAuthority);
  const escapedFence = "\\`\\`\\`json<br>{}<br>\\`\\`\\`";
  await execute("fixture.load("+JSON.stringify(original.replace("replace me",escapedFence))+")");
  await execute("fixture.open()");
  const escapedNoop = await execute("fixture.update()");
  check("saved cell escaped saved representation reopens without source changes",
    escapedNoop.exact === original.replace("replace me",escapedFence),escapedNoop);
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
  check("saved cell fixture completes all required boundaries",false,{stack:error.stack,errors,blocked});
  finish();
});
function finish() {
  clearTimeout(watchdog);
  const pids = app.getAppMetrics().map(metric => metric.pid);
  if (win && !win.isDestroyed()) win.destroy();
  const windows = BrowserWindow.getAllWindows().length;
  check("saved cell owned windows are closed",windows === 0,windows);
  const failures = results.filter(result => !result.ok).map(result => result.name).sort();
  const proved = proof && reverted &&
    JSON.stringify(failures) === JSON.stringify(proof.expect.slice().sort()) &&
    proof.mustPass.every(name => results.some(result => result.name === name && result.ok));
  fs.writeFileSync(path.join(output,"results.json"),JSON.stringify({
    results,pids,windows,proof:proof && {name:proofName,reverted,proved:!!proved,expect:proof.expect,mustPass:proof.mustPass},
  },null,2));
  console.log("OWNED_ELECTRON_PIDS="+JSON.stringify(pids));
  console.log(results.filter(result => result.ok).length+" passed, "+results.filter(result => !result.ok).length+" failed");
  if (proof) console.log("BOUNDED_REVERT="+proofName+" "+(proved ? "PROVEN" : "FAILED"));
  app.exit(proof ? proved ? 0 : 1 : failures.length ? 1 : 0);
}
