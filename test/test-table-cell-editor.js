"use strict";

const fs = require("fs");
const sourceOnly = process.argv.includes("--source");
const earlyElectron = sourceOnly ? null : createEarlyElectronSafety(require("electron"));
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const perfOnly = process.argv.includes("--perf");
const baseline = process.argv.includes("--baseline");
const dirtyOpenProbe = process.argv.includes("--probe-dirty-open");
const proof = process.env.FOLIA_CELL_PROOF;
const groups = ["selection", "rows", "splice", "inline", "menus", "provenance",
  "noop", "transaction", "adoption", "stale", "keyboard", "many"];
if (proof && !groups.includes(proof)) throw new Error("Unknown FOLIA_CELL_PROOF: " + proof);
if (baseline && !perfOnly) throw new Error("--baseline requires --perf");
if (dirtyOpenProbe && (sourceOnly || perfOnly || proof || process.argv.some(arg => arg.startsWith("--app-root=")))) {
  throw new Error("--probe-dirty-open requires the ordinary local UI suite without other modes");
}
const results = [];
const transcript = [];
const executed = new Set();
const selected = name => {
  if (proof && proof !== name) return false;
  executed.add(name);
  return true;
};
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  const line = `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`;
  transcript.push(line);
  console.log(line);
}
function summary() {
  const failed = results.filter(result => !result.ok).length;
  const line = `=== ${results.length - failed}/${results.length} passed ===`;
  transcript.push(line);
  console.log(line);
  return failed ? 1 : 0;
}
const lf = text => text.replace(/\r\n|\r/g, "\n");
const table = [
  "| Name | Detail | Reference |",
  "| :--- | ---: | :---: |",
  "| **alpha** | `code` and *emphasis* | [same][r] ![dot](cell.svg) |",
  "| second | emoji 😀 and escaped \\| pipe | plain |",
  "| third | unchanged _spelling_ | [same][r] |",
].join("\r\n");
const prefix = "# Cells\r\n\r\n[r]: https://example.invalid/reference\r\n\r\nBefore prose\r\n\r\n";
const between = "\r\n\r\nMiddle prose (identical tables are intentional)\r\n\r\n";
const suffix = "\n\nAfter prose\rTail 😀 without an ending";
const original = prefix + table + between + table + suffix;
const secondOffset = prefix.length + table.length + between.length;
const oldCell = "emoji 😀 and escaped \\| pipe";
const richCell = "<span><strong>changed &#38; safe</strong><em> rich</em></span>";
const editedOffset = secondOffset + table.indexOf(oldCell);
const expectedEdited = original.slice(0, editedOffset) + richCell +
  original.slice(editedOffset + oldCell.length);
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12">' +
  '<rect width="12" height="12" fill="green"/></svg>';
const productFiles = [...new Set(["src/table-cell-editor.js",
  ...require("../package.json").build.files.filter(file => /^src[\\/].+\.(?:js|css|html)$/.test(file))])];
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const hashes = () => Object.fromEntries(productFiles.map(file => [file, sha(path.join(ROOT, file))]));

// This route uses the shipping helper and shipping parser, not an imitation
// lexer. It remains usable without Electron; absent vendoring fails explicitly.
async function sourceTests() {
  dialogGuardSourceTests();
  dialogCleanupSourceTests();
  const context = vm.createContext({ window: {}, Node: { TEXT_NODE: 3, COMMENT_NODE: 8, ELEMENT_NODE: 1 } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "table-cell-editor.js"), "utf8"), context);
  const cells = context.window.FoliaTableCells;
  check("cell source helper exports the production operations",
    ["index", "resolveSource", "resolvePreview", "replaceCells", "spliceInput", "serializeCell"].every(key => typeof cells[key] === "function"));
  if (selected("inline")) {
    const text = data => ({ nodeType: 3, data });
    const element = (tag, children, attributes = []) => ({ nodeType: 1, tagName: tag.toUpperCase(),
      localName: tag, childNodes: children, attributes,
      getAttribute: name => attributes.find(attribute => attribute.name === name)?.value ?? null });
    const input = element("div", [element("strong", [text("safe | *x* [y] `z` & < >\r\n😀")]),
      element("a", [text("link")], [{ name: "href", value: "https://example.invalid/a?q=1&n=2" }]),
      element("img", [], [{ name: "src", value: "cell.svg" }, { name: "alt", value: "dot" }])]);
    check("cell serializer keeps formatting while encoding Markdown structure and attributes",
      cells.serializeCell(input) === '<span><strong>safe &#124; &#42;x&#42; &#91;y&#93; &#96;z&#96; &#38; &#60; &#62;&#13;&#10;😀</strong>' +
      '<a href="https://example.invalid/a?q=1&#38;n=2">link</a><img src="cell.svg" alt="dot"></span>');
    check("edited literal block starts stay inline instead of becoming Markdown block syntax",
      ["# heading", "- item", "> quote", "1. list", "    indented", "---", "!!!"].every(value =>
        cells.serializeCell(element("div", [text(value)])) === "<span>" + value.replace(">", "&#62;") + "</span>"));
    let rejected;
    try { cells.serializeCell(element("div", [element("table", [])])); }
    catch (error) { rejected = error.message; }
    check("cell serializer rejects nested table structure", rejected === "tableCells.cellType", rejected);
    let handlerError;
    try { cells.serializeCell(element("div", [element("strong", [text("unsafe")],
      [{ name: "onClick", value: "not allowed" }])])); }
    catch (error) { handlerError = error.message; }
    check("cell serializer refuses inline event handlers", handlerError === "tableCells.cellType", handlerError);
    const note = element("span", [text("annotated")], [
      { name: "class", value: "noted-text" }, { name: "data-note-id", value: "73" },
      { name: "data-note-title", value: "Title & value" },
      { name: "data-note-content", value: "first\nsecond" }, { name: "data-note-color", value: "#c0ffee" },
    ]);
    check("cell serializer preserves note identity title content and color beside changed text",
      cells.serializeCell(element("div", [note, text(" new neighbor")])) ===
      '<span><span class="noted-text" data-note-id="73" data-note-title="Title &#38; value" ' +
      'data-note-content="first&#10;second" data-note-color="#c0ffee">annotated</span> new neighbor</span>');
  }
  if (proof === "inline") return;
  const vendor = path.join(ROOT, "libs", "vendor", "marked.min.js");
  if (!fs.existsSync(vendor)) {
    throw new Error("Missing shipping parser: libs\\vendor\\marked.min.js; restore dependencies and run npm run vendor in an authorized resource slot.");
  }
  const parserContext = vm.createContext({ exports: {}, module: { exports: {} } });
  parserContext.exports = parserContext.module.exports;
  vm.runInContext(fs.readFileSync(vendor, "utf8"), parserContext);
  const marked = parserContext.module.exports.marked || parserContext.module.exports;
  const defaultTokenizer = marked.defaults.tokenizer;
  const protect = (source, mask) => source
    .replace(/@@@html(?:\([^)\r\n]*\))?[ \t]*[\r\n]+([\s\S]*?)[\r\n][ \t]*@@@[ \t]*/g, mask)
    .replace(/```mermaid[\r\n]+([\s\S]*?)```/g, mask);
  const model = cells.index("\uFEFF" + original, marked, protect);
  const start = lf("\uFEFF" + original.slice(0, secondOffset)).length;
  const tableEnd = start + lf(table).length;
  check("cell parser fixture contains two independently located identical writable tables",
    model.tables.length === 2 && model.tables.every(item => item.writable) &&
    model.tables[0].start === lf("\uFEFF" + prefix).length && model.tables[1].start === start &&
    model.tables[1].rows.length === 4 && model.tables[1].rows[2].cells[1].text === "emoji 😀 and escaped | pipe",
    model.tables.map(item => ({ start: item.start, writable: item.writable, rows: item.rows.length })));
  function failure(from, to, rowsOnly) {
    try { cells.resolveSource(model, from, to, rowsOnly); return "accepted"; }
    catch (error) { return error.message; }
  }
  if (selected("selection")) {
    check("collapsed caret inside a real table is not an explicit table selection",
      failure(start + 3, start + 3, false) === "tableCells.select");
    check("source resolver refuses none and multiple actual tables",
      failure(0, 2, false) === "tableCells.select" &&
      failure(model.tables[0].start, tableEnd, false) === "tableCells.multiple");
    const target = cells.resolveSource(model, start - 25, lf("\uFEFF" + original).length, false);
    check("source prose around one duplicate resolves its exact owning table",
      target.table === model.tables[1] && target.rows.length === 4);
    for (const [label, body] of [
      ["ragged", "| A | B |\n| - | - |\n| one |\n"],
    ]) {
      let error;
      try { const m = cells.index(body, marked, protect); cells.resolveSource(m, 0, body.length, false); }
      catch (caught) { error = caught.message; }
      check("source resolver rejects unsupported " + label + " table", error === "tableCells.unsupported", error);
    }
    const masked = "```mermaid\nflowchart LR\nA --> B\n```\n\n@@@html\n<div>not a table</div>\n@@@\n\n" + table;
    const protectedModel = cells.index(masked, marked, protect);
    check("protected blocks do not borrow the following table offsets",
      protectedModel.tables.length === 1 && protectedModel.tables[0].start === lf(masked).indexOf("| Name"));
    const definitions = "[r]: https://example.invalid/first\n\n[r]: https://example.invalid/second\n\n" +
      lf(table) + "\n\n[r]: https://example.invalid/third\n\n" + lf(table) + "\n\n[r]: https://example.invalid/fourth\n";
    let duplicates;
    try { duplicates = cells.index(definitions, marked, protect); }
    catch (error) { duplicates = { error: error.message }; }
    check("duplicate reference definitions never shift a later identical table or its effective reference",
      duplicates.tables?.length === 2 &&
      duplicates.tables[0].start === definitions.indexOf("| Name") &&
      duplicates.tables[1].start === definitions.lastIndexOf("| Name") &&
      duplicates.links.r.href === "https://example.invalid/first", duplicates.error);
    const isolated = ["first", "second", "third"].map(label => {
      const source = "[r]: https://example.invalid/" + label + "\n\n" + lf(table);
      const indexed = cells.index(source, marked, protect);
      return indexed.tables.length === 1 && indexed.tables[0].writable &&
        indexed.tables[0].start === source.indexOf("| Name") &&
        indexed.links.r.href === "https://example.invalid/" + label;
    });
    check("independent table lexers preserve parser defaults and subsequent ordinary parsing",
      isolated.every(Boolean) && marked.defaults.tokenizer === defaultTokenizer &&
      marked.parse("[own][r]\n\n[r]: https://example.invalid/ordinary\n") ===
        '<p><a href="https://example.invalid/ordinary">own</a></p>\n',
      { isolated, defaultTokenizerUnchanged: marked.defaults.tokenizer === defaultTokenizer });
  }
  if (selected("rows")) {
    const rows = model.tables[1].rows;
    let partial;
    try { partial = cells.resolveSource(model, rows[0].start + 3, rows[1].start + 4, true); }
    catch (error) { partial = { error: error.message }; }
    check("partial source boundaries include the intersected header and data rows",
      partial.rows?.length === 2 && partial.rows[0] === rows[0] && partial.rows[1] === rows[1], partial.error);
    const delimiter = start + lf(table).indexOf("| :---");
    check("delimiter-only selection has no editable row",
      failure(delimiter, delimiter + "| :--- | ---: | :---: |".length, true) === "tableCells.rows");
    const full = cells.resolveSource(model, rows[2].start + 2, rows[2].end - 2, false);
    check("full action from a source row subset loads its entire owning table",
      full.table === model.tables[1] && full.rows.length === 4);
  }
  if (selected("splice")) {
    const target = cells.resolveSource(model, start, tableEnd, false);
    const candidate = cells.replaceCells(target, [{ cell: target.rows[2].cells[1], text: richCell }], marked, protect);
    check("source splice preserves all other exact bytes including BOM Unicode mixed endings and EOF",
      candidate === "\uFEFF" + expectedEdited, { expectedHash: crypto.createHash("sha256").update("\uFEFF" + expectedEdited).digest("hex"),
        actualHash: crypto.createHash("sha256").update(candidate).digest("hex") });
    check("empty cell replacement is an exact no-op",
      cells.replaceCells(target, [], marked, protect) === "\uFEFF" + original);
    const endingCases = [];
    for (const ending of ["\n", "\r\n", "\r"]) {
      for (const bom of ["", "\uFEFF"]) {
        for (const terminal of ["", ending]) {
          const before = bom + ["| Header | Value |", "| - | - |", "| same | keep |",
            "| target | old |"].join(ending) + terminal;
          const expected = bom + ["| Header | Value |", "| - | - |", "| same | keep |",
            "| target | <span>new</span> |"].join(ending) + terminal;
          const indexed = cells.index(before, marked, protect);
          const owner = cells.resolveSource(indexed, 0, lf(before).length, false);
          endingCases.push(cells.replaceCells(owner, [{ cell: owner.rows[2].cells[1],
            text: "<span>new</span>" }], marked, protect) === expected);
        }
      }
    }
    check("cell source splice keeps every native ending BOM and terminal-table EOF case exact",
      endingCases.length === 12 && endingCases.every(Boolean), endingCases);
    let rejected;
    try { cells.replaceCells(target, [{ cell: model.tables[0].rows[0].cells[0], text: "wrong owner" }], marked, protect); }
    catch (error) { rejected = error.message; }
    check("cell source splice rejects a cell belonging to another duplicate", rejected === "tableCells.invalid");
    const repeated = "same\r\nsame\nsame\rEND";
    for (const [label, source, from, to, inserted, expected] of [
      ["first repeated CRLF line deletion", repeated, 0, 5, "", "same\nsame\rEND"],
      ["middle repeated LF line deletion", repeated, 5, 10, "", "same\r\nsame\rEND"],
      ["last repeated CR line deletion", repeated, 10, 15, "", "same\r\nsame\nEND"],
      ["insertion between repeated lines", repeated, 5, 5, "added\n", "same\r\nadded\r\nsame\nsame\rEND"],
      ["first insertion uses following CRLF", repeated, 0, 0, "😀\r\nnew\rline\n",
        "😀\r\nnew\r\nline\r\nsame\r\nsame\nsame\rEND"],
      ["insertion uses preceding bare CR", "one\rtwo\nthree\r\nfour", 4, 4, "next\r\n", "one\rnext\rtwo\nthree\r\nfour"],
      ["UTF16 emoji replacement with BOM", "\uFEFFA😀\r\nB😀\nC", 2, 4, "Ω", "\uFEFFAΩ\r\nB😀\nC"],
      ["UTF16 replacement after mixed newline", "\uFEFFA😀\r\nB😀\nC", 5, 8, "β", "\uFEFFA😀\r\nβ\nC"],
      ["UTF16 insertion preserves following LF", "\uFEFFA😀\r\nB😀\nC", 5, 5, "🙂\n",
        "\uFEFFA😀\r\n🙂\r\nB😀\nC"],
      ["no existing newline defaults to LF", "\uFEFF😀tail", 3, 3, "\nline", "\uFEFF😀\nlinetail"],
    ]) {
      const actual = cells.spliceInput(source, from, to, inserted);
      check("native source splice preserves exact outside bytes for " + label,
        actual === expected, { from, to, expected, actual });
    }
    const invalidSplices = [[-1, 0], [1, 0], [0, lf(repeated).length + 1], [.5, 1], [NaN, 1]].map(([from, to]) => {
      try { cells.spliceInput(repeated, from, to, "x"); return "accepted"; }
      catch (error) { return error.message; }
    });
    check("native source splice rejects invalid normalized UTF16 bounds",
      invalidSplices.every(error => error === "tableCells.invalid"), invalidSplices);
  }
}

function dialogGuardSourceTests() {
  const messages = [], calls = [];
  const document = { readyState: "loading", getElementById: () => cell };
  class Dialog {
    constructor(id, text) {
      this.id = id; this.textContent = text; this.ownerDocument = document; this.isConnected = true;
      this.open = false;
    }
    querySelector() { return { textContent: this.id === "appMessageDialog" ? "Discard unsaved changes?" : "Edit table" }; }
    matches() { return false; }
    show() { calls.push(this.id + ":show"); }
    showModal() { calls.push(this.id + ":showModal"); }
  }
  const cell = new Dialog("tableCellDialog", "Edit table");
  const dirtyOpen = new Dialog("appMessageDialog",
    "You have unsaved changes. Discard them and open another file?");
  const window = {}, context = vm.createContext({ window, top: window, document,
    location: { href: "file:///owned/src/index.html" }, HTMLDialogElement: Dialog,
    console: { info() {}, error(message) { messages.push(message); } } });
  const script = rendererDialogGuardScript(731, "CELL_GUARD_REFUSED:", "CELL_GUARD_STAGE:");
  vm.runInContext(script, context);
  const guard = window.__cellDialogGuard;
  const refuses = action => {
    const before = calls.length;
    try { action(); } catch (error) {
      return error.message.startsWith("CELL_GUARD_REFUSED:") && calls.length === before;
    }
    return false;
  };
  check("guard script refuses the dirty-Open HTML surface before its original showModal",
    refuses(() => dirtyOpen.showModal()) && messages.some(message =>
      message.includes('"id":"appMessageDialog"') &&
      message.includes("Discard them and open another file?") &&
      message.includes('"phase":"before-original"') && message.includes('"originalCalls":0') &&
      message.includes('"open":false') && message.includes('"modal":false')));
  check("dialog guard refuses nonmodal HTML presentation and unarmed cell presentation",
    refuses(() => dirtyOpen.show()) && refuses(() => cell.showModal()));
  guard.runCellDialog(() => cell.showModal());
  check("dialog guard permits only the exact explicitly armed feature dialog once",
    calls.length === 1 && calls[0] === "tableCellDialog:showModal" &&
    refuses(() => cell.showModal()) &&
    refuses(() => guard.runCellDialog(() => new Dialog("tableCellDialog", "clone").showModal())) &&
    refuses(() => guard.runCellDialog(() => dirtyOpen.showModal())));
  guard.runCellDialog(() => {});
  check("unused feature-dialog allowance cannot leak into a later action",
    refuses(() => cell.showModal()));
  vm.runInContext(script, context);
  check("dialog guard repeated installation preserves its exact functions and marker",
    window.__cellDialogGuard === guard &&
    Dialog.prototype.showModal.cellGuardContentsId === 731 &&
    refuses(() => dirtyOpen.showModal()));
  Dialog.prototype.showModal = function () { calls.push("unguarded"); };
  let conflict = false;
  try { vm.runInContext(script, context); } catch (error) {
    conflict = error.message === "Conflicting document prompt guard";
  }
  check("dialog guard refuses a conflicting HTML guard instead of silently repairing it", conflict);
}

if (sourceOnly) {
  const sourceProduct = hashes();
  sourceTests().catch(error => check("cell source suite completed", false, error.stack))
    .finally(() => {
      process.exitCode = summary();
      const evidence = path.resolve(ROOT, process.env.FOLIA_CELL_EVIDENCE || path.join("screenshots", "table-cell-editor"));
      if (evidence !== ROOT && !evidence.startsWith(ROOT + path.sep)) {
        throw new Error("FOLIA_CELL_EVIDENCE must stay inside this worktree");
      }
      fs.mkdirSync(evidence, { recursive: true });
      const label = "source" + (proof ? "-" + proof : "");
      fs.writeFileSync(path.join(evidence, label + ".log"), transcript.join("\n") + "\n");
      fs.writeFileSync(path.join(evidence, label + ".json"), JSON.stringify({
        proof: proof || null, runtime: process.version, suiteSha256: sha(__filename),
        productBefore: sourceProduct, productAfter: hashes(), results, exitCode: process.exitCode,
      }, null, 2));
    });
} else {
  // Column zero is deliberate: the packaging oracle requires pre-ready
  // isolation, even though this file also has an entirely plain-Node route.
  startElectron();
}

function rendererDialogGuardScript(id, marker, guardStage) {
  return `(() => {
    const report=phase=>console.info(${JSON.stringify(guardStage)}+JSON.stringify({
      phase,contentsId:${id},documentURL:location.href,readyState:document.readyState,topFrame:window===top
    }));
    try {
      report('entered');
      const existing=Object.getOwnPropertyDescriptor(window,'__cellDialogGuard');
      if(existing) {
        const value=existing.value;
        if(!value||value.contentsId!==${id}||value.documentURL!==location.href||!value.executed||
            typeof value.runCellDialog!=='function'||
            !['alert','confirm','prompt'].every(kind=>window[kind]?.cellGuardContentsId===${id})||
            !['show','showModal'].every(kind=>HTMLDialogElement.prototype[kind]?.cellGuardContentsId===${id})) {
          throw new Error('Conflicting document prompt guard');
        }
        report('reused');
        return;
      }
      const refuse=detail=>{
        const message=${JSON.stringify(marker)}+detail;
        console.error(message);
        throw new Error(message);
      };
      for(const kind of ['alert','confirm','prompt']) {
        const guarded=function(){return refuse(kind)};
        Object.defineProperty(guarded,'cellGuardContentsId',{value:${id}});
        Object.defineProperty(window,kind,{configurable:true,writable:true,value:guarded});
      }
      let expectedDialog=null,originalCalls=0;
      for(const kind of ['show','showModal']) {
        const original=HTMLDialogElement.prototype[kind];
        const guarded=function(...args) {
          if(this!==expectedDialog) {
            return refuse('html:'+JSON.stringify({method:kind,id:this.id,
              title:this.querySelector('h2')?.textContent??null,text:this.textContent.slice(0,500),
              phase:'before-original',originalCalls,open:this.open,modal:this.matches(':modal')}));
          }
          expectedDialog=null;
          originalCalls++;
          return original.apply(this,args);
        };
        Object.defineProperty(guarded,'cellGuardContentsId',{value:${id}});
        Object.defineProperty(HTMLDialogElement.prototype,kind,{configurable:true,writable:true,value:guarded});
      }
      const runCellDialog=action=>{
        const dialog=document.getElementById('tableCellDialog');
        if(expectedDialog||typeof action!=='function'||!(dialog instanceof HTMLDialogElement)||
            !dialog.isConnected||dialog.ownerDocument!==document) {
          return refuse('invalid-cell-dialog-authorization');
        }
        expectedDialog=dialog;
        try{return action()}finally{expectedDialog=null}
      };
      Object.defineProperty(window,'__cellDialogGuard',{value:Object.freeze({
        contentsId:${id},documentURL:location.href,executed:true,runCellDialog
      })});
      report('installed');
    } catch(error) {
      console.error(${JSON.stringify(marker)}+'installation:'+error.message);
      throw error;
    }
  })()`;
}

function closeObservedCellDialog(expectedPresent, allowAbsent) {
  const dialog = document.getElementById("tableCellDialog");
  if (typeof expectedPresent !== "boolean") throw new Error("Cell dialog presence was not established");
  if (!dialog) {
    if (expectedPresent || !allowAbsent) throw new Error("Expected cell dialog is missing");
  } else {
    const button = document.getElementById("tableCellCancel");
    if (!expectedPresent || !(dialog instanceof HTMLDialogElement) ||
        !(button instanceof HTMLButtonElement) || !dialog.contains(button)) {
      throw new Error("Cell dialog or Cancel control changed");
    }
    if (dialog.open) button.click();
    if (dialog.open) throw new Error("Cell dialog did not close");
  }
  if (document.querySelector("dialog[open]")) throw new Error("An unexpected document dialog remains open");
  return true;
}

function dialogCleanupSourceTests() {
  function run({ present = true, open = true, closes = true, button = true, other = false,
    expected = true, allowAbsent = false } = {}) {
    class Dialog {}
    class Button {}
    const dialog = Object.assign(new Dialog(), { open, contains: node => node === cancel });
    const cancel = button ? Object.assign(new Button(), { click() { if (closes) dialog.open = false; } }) : null;
    const document = {
      getElementById: id => id === "tableCellDialog" ? present ? dialog : null : cancel,
      querySelector: () => other || present && dialog.open ? {} : null,
    };
    const context = vm.createContext({ document, HTMLDialogElement: Dialog, HTMLButtonElement: Button });
    try {
      return vm.runInContext(`(${closeObservedCellDialog})(${JSON.stringify(expected)},${allowAbsent})`, context);
    } catch { return false; }
  }
  check("cell cleanup closes its previously observed real dialog", run());
  check("cell cleanup permits confirmed feature-absent baseline without an open dialog",
    run({ present: false, expected: false, allowAbsent: true }));
  for (const [label, options] of [
    ["unobserved presence", { expected: null }],
    ["unexpected disappearance", { present: false, allowAbsent: true }],
    ["unapproved baseline absence", { present: false, expected: false }],
    ["unexpected appearance", { expected: false, allowAbsent: true }],
    ["missing Cancel", { button: false }],
    ["unsuccessful closure", { closes: false }],
    ["another open document dialog", { present: false, expected: false, allowAbsent: true, other: true }],
  ]) check("cell cleanup refuses " + label, !run(options));
}

function createEarlyElectronSafety(electron) {
  const { app, dialog } = electron;
  let detailedFailure = null;
  let stageSink = null, bootstrapTimer = null, tearingDown = false, failureStarted = false;
  const stages = [], guards = new Map(), startedAt = performance.now();
  const write = message => {
    try { fs.writeSync(2, message + "\n"); }
    catch { /* Exit must not depend on the diagnostic pipe. */ }
  };
  function fail(label, detail) {
    if (failureStarted || tearingDown) {
      write("SECONDARY " + label + " -> " + String(detail?.stack || detail));
      return;
    }
    failureStarted = true;
    try {
      if (detailedFailure) detailedFailure(label, detail);
      else write("FAIL " + label + "  -> " + String(detail?.stack || detail));
    } catch (error) {
      write("FAIL cell safety diagnostics failed  -> " + String(error?.stack || error));
    } finally {
      app.exit(1);
    }
  }
  function stage(name, detail) {
    const entry = { name, elapsedMs: Math.round(performance.now() - startedAt), ...detail };
    stages.push(entry);
    write("CELL_BOOTSTRAP " + JSON.stringify(entry));
    if (stageSink) stageSink(entry);
  }
  const watchdog = setTimeout(() => fail("cell suite completes within its finite watchdog",
    "180000ms elapsed"), 180000);
  process.on("uncaughtException", error => fail("cell suite catches an unexpected Main exception", error));
  process.on("unhandledRejection", error => fail("cell suite catches an unexpected rejected operation", error));
  for (const name of ["showOpenDialog", "showSaveDialog", "showMessageBox"]) {
    dialog[name] = async (...args) => fail("unexpected native " + name, args.at(-1));
    dialog[name + "Sync"] = (...args) => fail("unexpected native " + name + "Sync", args.at(-1));
  }
  dialog.showErrorBox = (...args) => fail("unexpected native showErrorBox", args);
  const marker = "CELL_TEST_UNEXPECTED_JS_DIALOG:";
  const guardStage = "CELL_TEST_JS_GUARD_STAGE:";
  const rendererGuard = id => rendererDialogGuardScript(id, marker, guardStage);
  const hostFile = file => typeof file === "string" && /(?:^|[\\/])owned-dialog\.html$/i.test(file);
  const hostURL = value => {
    try { const url = new URL(value); return url.protocol === "file:" && hostFile(decodeURIComponent(url.pathname)); }
    catch { return false; }
  };
  const hostPreferences = preferences =>
    /(?:^|[\\/])owned-dialog-preload\.js$/i.test(preferences?.preload || "") &&
    (preferences.additionalArguments || []).some(argument => /^--owned-dialog-id=/.test(argument));
  app.on("browser-window-created", (_event, window) => {
    try {
      stage("window-created", { windowId: window.id, contentsId: window.webContents.id });
      window.on("show", () => stage("window-shown", {
        windowId: window.id, contentsId: window.webContents.id, url: window.webContents.getURL(),
      }));
      if (hostPreferences(window.webContents.getLastWebPreferences())) {
        fail("unexpected Main owned-dialog host window", { id: window.id });
      }
    } catch (error) { fail("cell owned-dialog host monitor failed", error); }
  });
  app.on("web-contents-created", (_event, contents) => {
    try {
      const identity = { contentsId: contents.id, contentsType: contents.getType() };
      const state = { ...identity, acknowledged: false, finishedURL: null, timer: null };
      guards.set(contents.id, state);
      stage("contents-created", identity);
      contents.on("console-message", (...args) => {
        const detail = args.find(value => value && typeof value.message === "string");
        const message = detail?.message || args.find(value => typeof value === "string" && value.startsWith(marker));
        if (message?.startsWith(marker)) fail("unexpected renderer window dialog", message);
        if (message?.startsWith(guardStage)) {
          stage("guard-script-execution", { ...identity, ...JSON.parse(message.slice(guardStage.length)) });
        }
      });
      contents.on("did-start-navigation", (_event, url) => {
        if (hostURL(url)) fail("unexpected Main owned-dialog host navigation", url);
      });
      contents.on("did-finish-load", () => {
        state.finishedURL = contents.getURL();
        stage("navigation-finished", { ...identity, url: state.finishedURL });
      });
      contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
        if (!isMainFrame || tearingDown) return;
        stage("navigation-failed", { ...identity, code, description, url });
        fail("cell initial or subsequent Main navigation failed", { ...identity, code, description, url });
      });
      contents.on("render-process-gone", (_event, detail) => {
        if (!tearingDown) fail("cell renderer process was lost", { ...identity, ...detail });
      });
      contents.on("destroyed", () => {
        if (!tearingDown) fail("cell owned web contents was destroyed unexpectedly", identity);
      });
      contents.debugger.on("detach", (_event, reason) => {
        if (!tearingDown) fail("cell renderer dialog guard detached unexpectedly", { ...identity, reason });
      });
      contents.debugger.on("message", (_event, method, parameters) => {
        if (method === "Page.javascriptDialogOpening") {
          // A native-dialog race is a failure, never a request to answer it.
          fail("unexpected renderer JavaScript dialog opening", parameters);
        }
      });
      contents.debugger.attach("1.3");
      // Chromium stores both browser-side commands before replying from its
      // renderer. Waiting for those replies before loadFile deadlocks startup.
      const enabled = contents.debugger.sendCommand("Page.enable");
      const installed = contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument",
        { source: rendererGuard(contents.id), runImmediately: true });
      stage("guard-commands-issued", identity);
      state.timer = setTimeout(() => fail("cell dialog guard initialization exceeded 10000ms", identity), 10000);
      Promise.all([
        enabled.then(() => stage("guard-enable-acknowledged", identity)),
        installed.then(result => stage("guard-script-acknowledged", { ...identity, identifier: result.identifier })),
      ]).then(() => {
        state.acknowledged = true;
        clearTimeout(state.timer);
        stage("guard-acknowledged", identity);
      }).catch(error => fail("cell renderer dialog guard could not initialize", { ...identity, error: error.stack }));
      for (const name of ["loadFile", "loadURL"]) {
        const load = contents[name];
        contents[name] = function (...args) {
          if ((name === "loadFile" && hostFile(args[0])) || (name === "loadURL" && hostURL(args[0]))) {
            fail("unexpected Main owned-dialog host load", args[0]);
            return Promise.reject(new Error("Unexpected owned dialog"));
          }
          stage("navigation-dispatched", { ...identity, method: name, target: args[0] });
          const loading = load.apply(this, args);
          loading?.catch(error => {
            if (!tearingDown) fail("cell navigation load promise rejected",
              { ...identity, target: args[0], error: error.stack });
          });
          return loading;
        };
      }
    } catch (error) { fail("cell renderer dialog guard failed before navigation", error); }
  });
  return {
    electron, fail, stages, guards, stage,
    setDetailedFailure(handler) { detailedFailure = handler; },
    setStageSink(handler) { stageSink = handler; },
    beginBootstrap(expectedURL) {
      stage("main-bootstrap-started", { expectedURL, deadlineMs: 10000 });
      bootstrapTimer = setTimeout(() => fail("cell actual Main readiness exceeded 10000ms",
        { expectedURL, stages }), 10000);
    },
    mainReady(window, witness) {
      clearTimeout(bootstrapTimer);
      stage("main-ready", { windowId: window.id, contentsId: window.webContents.id,
        url: window.webContents.getURL(), visible: window.isVisible(), witness });
    },
    beginTeardown() {
      tearingDown = true;
      clearTimeout(bootstrapTimer);
      for (const state of guards.values()) clearTimeout(state.timer);
    },
    disarmWatchdog() { clearTimeout(watchdog); },
  };
}

function startElectron() {
  const { app, BrowserWindow, dialog, shell, ipcMain, session } = earlyElectron.electron;
  const profileBase = path.join(ROOT, "screenshots", "table-cell-editor-profile");
  fs.mkdirSync(profileBase, { recursive: true });
  for (const key of ["TEMP", "TMP", "TMPDIR"]) process.env[key] = profileBase;
require("./test-userdata-isolation");
  const { captureScreenshot, proveSentinelAlive, startErrorSentinel } = require("./test-visual-utils");
  const directory = path.join(ROOT, "screenshots", "table-cell-editor");
  const evidence = path.resolve(ROOT, process.env.FOLIA_CELL_EVIDENCE || path.join("screenshots", "table-cell-editor"));
  if (evidence !== ROOT && !evidence.startsWith(ROOT + path.sep)) {
    throw new Error("FOLIA_CELL_EVIDENCE must stay inside this worktree; preserve it as a session artifact after the run");
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const product = hashes();
  const shellCalls = [], network = [], saves = [], screenshots = [], unexpectedDialogs = [], teardownErrors = [];
  let chooser, win, sentinel, fileSequence = 0, actorCleanup = null, finishing = false, shellControl = null;
  let admissionFixture = null, observedCellDialog = null;
  const performanceSources = new Map();
  const fixtures = [];
  const rawFile = path.join(evidence, "raw-ui" + (proof ? "-" + proof : "") + ".log");
  fs.writeFileSync(rawFile, "");
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    stream.write = function (...args) {
      try { fs.appendFileSync(rawFile, args[0]); }
      catch { /* Failure reporting must still reach the parent's output pipe. */ }
      return write.apply(this, args);
    };
  }
  function receipt(stage, detail) {
    let ownedPids = [process.pid];
    try { ownedPids = [...new Set([process.pid, ...app.getAppMetrics().map(metric => metric.pid)])]; }
    catch { /* Main has not reached readiness. */ }
    fs.writeFileSync(path.join(evidence, "last-run.json"), JSON.stringify({
      stage, detail, proof: proof || null, perfOnly, dirtyOpenProbe, fixtureChooser: chooser || null,
      product, suiteSha256: sha(__filename),
      packageSha256: sha(path.join(ROOT, "package.json")), ownedPids,
      bootstrapStages: earlyElectron.stages, teardownErrors,
      environment: { node: process.version, electron: process.versions.electron, chrome: process.versions.chrome,
        platform: process.platform, appRoot, expectedMainURL, profileBase, evidence,
        temp: process.env.TEMP, tmp: process.env.TMP, tmpdir: process.env.TMPDIR },
      results, screenshots, screenshotsRequireViewing: true, rawFile,
    }, null, 2));
  }
  function finish(code, reason) {
    if (finishing) return;
    finishing = true;
    try {
      earlyElectron.beginTeardown();
      earlyElectron.disarmWatchdog();
      actorCleanup = null;
      for (const file of [...fixtures, path.join(directory, "cell.svg")]) {
        try { fs.rmSync(file, { force: true }); }
        catch (error) {
          code = 1;
          teardownErrors.push({ label: "owned fixture cleanup", file, detail: error.message });
          try { fs.writeSync(2, "Cannot clean owned cell fixture: " + file + ": " + error.message + "\n"); }
          catch { /* Every remaining owned fixture must still get its cleanup attempt. */ }
        }
      }
      try { receipt("exit", { code, reason }); }
      catch (error) {
        code = 1;
        try { fs.writeSync(2, "Cannot preserve cell receipt: " + error.message + "\n"); }
        catch { /* Exit still runs when both evidence and stderr are unavailable. */ }
      }
    } catch (error) {
      try { fs.writeSync(2, "Cannot complete owned cell teardown: " + error.message + "\n"); }
      catch { /* The process still has to exit if its output pipe is gone. */ }
      code = 1;
    } finally {
      // app.quit negotiates dirty tabs with Main. A test must never leave its
      // failure path waiting for that human consent.
      app.exit(code);
    }
  }
  function fatal(label, error) {
    earlyElectron.fail(label, error);
  }
  function teardownFailure(label, error) {
    const detail = error?.stack || String(error);
    teardownErrors.push({ label, detail });
    if (results.some(result => !result.ok)) console.error("SECONDARY " + label + " -> " + detail);
    else check(label, false, detail);
  }
  earlyElectron.setDetailedFailure((label, error) => {
    try {
      if (label.startsWith("unexpected ")) unexpectedDialogs.push({ label, detail: error });
      check(label, false, error?.stack || error);
    }
    finally { finish(1, label); }
  });
  dialog.showOpenDialog = async () => {
    const file = chooser;
    chooser = null;
    if (!file || !fixtures.includes(file) || !fs.existsSync(file)) {
      fatal("cell file chooser only returns an explicitly owned fixture", "An unowned file chooser was requested");
      return { canceled: true, filePaths: [] };
    }
    return { canceled: false, filePaths: [file] };
  };
  function recordShell(kind, value) {
    shellCalls.push([kind, value]);
    const authorization = shellControl;
    shellControl = null;
    if (!authorization || authorization.kind !== kind || authorization.value !== value) {
      fatal("cell scenario attempted an unauthorized operating-system handoff", { kind, value });
    }
  }
  const guardedExternal = async value => { recordShell("external", value); };
  const guardedPath = async value => { recordShell("path", value); return ""; };
  shell.openExternal = guardedExternal;
  shell.openPath = guardedPath;
  const appArg = process.argv.find(arg => arg.startsWith("--app-root="));
  const appRoot = appArg ? path.resolve(appArg.slice("--app-root=".length)) : ROOT;
  const expectedMainURL = require("url").pathToFileURL(path.join(appRoot, "src", "index.html")).href;
  earlyElectron.setStageSink(entry => {
    fs.appendFileSync(rawFile, "CELL_BOOTSTRAP " + JSON.stringify(entry) + "\n");
    receipt("bootstrap", entry);
  });
  receipt("pre-main", { watchdogMs: 180000, appRoot });
  earlyElectron.beginBootstrap(expectedMainURL);
  try { require(path.join(appRoot, "src", "main.js")); }
  catch (error) { fatal("cell production Main bootstraps unattended", error); }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const exec = code => bounded("cell renderer command", win.webContents.executeJavaScript(code, true));
  const page = (fn, ...args) => exec(`(${fn.toString()})(...${JSON.stringify(args)})`);
  async function wait(label, expression, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await bounded(label + " DOM probe", exec(expression), Math.min(2000, deadline - Date.now()))) return;
      await sleep(25);
    }
    throw new Error("Timed out waiting for " + label);
  }
  async function settle() {
    await exec("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
  }
  async function waitMain(label, predicate) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(10);
    }
    throw new Error("Timed out waiting for " + label);
  }
  const positiveSafe = value => Number.isSafeInteger(value) && value > 0;
  const ownerFields = ["pageSession", "rendererGeneration", "tabId", "documentGeneration", "pathKey", "documentRef"];
  const sameOwner = (left, right) => !!left && !!right &&
    ownerFields.every(key => left[key] === right[key]);
  const ownedMainFrame = event => !!win && !win.isDestroyed() &&
    event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  async function documentWitness(fixture) {
    const witness = await exec(`(() => {
      const tab=window.CustomTabs.getActiveTab(),session=window.getReloadRequestSession();
      return {tabId:tab?.id??null,path:tab?.filePath??null,session,
        owner:tab?window.CustomTabs.getDocumentIdentityForTab(tab.id,tab.filePath,session):null,
        selection:window.getActiveFileSelectionGeneration(),
        sequence:window.getReloadRequestDiagnostics().sequence,
        latest:window.getLatestReloadRequestSequence(currentFilePath),
        snapshot:currentReloadSnapshot(),mode:isEditMode,state:__cells.${perfOnly ? "commonState" : "state"}(),
        save:window.getPendingSaveStatus(),freeze:window.CustomTabs.__shutdownFreeze()};
    })()`);
    const owner = witness.owner;
    const valid = !!owner && witness.tabId === fixture.id && witness.path === fixture.file &&
      witness.state.owner === fixture.id && witness.state.path === fixture.file &&
      owner.tabId === fixture.id && owner.pageSession === witness.session &&
      typeof witness.session === "string" && witness.session.length > 0 &&
      positiveSafe(owner.documentGeneration) && positiveSafe(owner.rendererGeneration) &&
      typeof owner.pathKey === "string" && owner.pathKey.length > 0 &&
      typeof owner.documentRef === "string" && /^[a-f0-9]{64}$/.test(owner.documentRef) &&
      positiveSafe(witness.selection) && witness.mode && !witness.save.pending && !witness.freeze.frozen &&
      witness.state.value === lf(fixture.body) &&
      (perfOnly || witness.state.exact === fixture.body) && witness.state.cache === fixture.body &&
      witness.snapshot === lf(fixture.body);
    check("cell actor has the exact admitted fixture tab session reference and live source", valid, witness);
    if (!valid) throw new Error("Missing qualified document actor identity");
    return { ...witness, expectedSource: fixture.body };
  }
  function observeMainDeliveries(matches, hold = false) {
    const target = win.webContents;
    const descriptor = Object.getOwnPropertyDescriptor(target, "send");
    const original = target.send;
    const records = [];
    let restored = false, released = false;
    const replacement = function (...args) {
      if (!matches(...args)) return Reflect.apply(original, this, args);
      const record = { receiver: this, args, forwarded: false };
      records.push(record);
      if (hold) return;
      record.forwarded = true;
      return Reflect.apply(original, this, args);
    };
    Object.defineProperty(target, "send", {
      configurable: true, enumerable: descriptor?.enumerable ?? false, writable: true, value: replacement,
    });
    function restore() {
      if (restored) return;
      if (Object.getOwnPropertyDescriptor(target, "send")?.value !== replacement) {
        throw new Error("Owned Main send observer was replaced");
      }
      if (descriptor) Object.defineProperty(target, "send", descriptor);
      else delete target.send;
      restored = true;
      const actual = Object.getOwnPropertyDescriptor(target, "send");
      if (descriptor ? !actual || Reflect.ownKeys(descriptor).some(key => actual[key] !== descriptor[key]) : actual) {
        throw new Error("Main send descriptor did not restore exactly");
      }
    }
    return { records, restore, release() {
      restore();
      if (released) return;
      released = true;
      // Main can retry an unacknowledged Save. Preserve every genuine attempt;
      // only production decides which acknowledgement is still current.
      let failure = null;
      for (const record of records) {
        if (record.forwarded) continue;
        record.forwarded = true;
        try { Reflect.apply(original, record.receiver, record.args); }
        catch (error) { failure ||= error; }
      }
      if (failure) throw failure;
    } };
  }
  function matchesSaveRequest(request, witness) {
    return !!request && request.filePath === witness.path && request.content === witness.expectedSource &&
      request.saveRequestSession === witness.session && positiveSafe(request.requestId) &&
      request.saveRequest?.requestId === request.requestId &&
      positiveSafe(request.saveRequest?.sequence) &&
      request.saveRequest?.selectionGeneration === witness.selection &&
      sameOwner(request.saveRequest, witness.owner);
  }
  function matchesSaveResult(result, request) {
    return !!result && !!request && result.path === request.filePath &&
      result.requestId === request.requestId && result.saveRequestSession === request.saveRequestSession &&
      JSON.stringify(result.saveRequest) === JSON.stringify(request.saveRequest) &&
      positiveSafe(result.saveResultAttempt);
  }
  async function proveOwnedSaveObserver() {
    const fixture = await fresh("save-observer-control", "# Save observer control\r\n\r\nUnchanged exact fixture bytes.");
    const witness = await documentWitness(fixture), beforeSaves = saves.length;
    const disk = fs.readFileSync(fixture.file);
    const delivery = observeMainDeliveries((channel, result) => channel === "save-markdown-result" &&
      saves.slice(beforeSaves).some(request => matchesSaveRequest(request, witness) && matchesSaveResult(result, request)));
    try {
      await exec("saveButton.click();true");
      await waitMain("actual explicit Save request and successful Main result", () =>
        saves.length === beforeSaves + 1 && delivery.records.some(record => record.args[1]?.success === true));
      await wait("positive-control Save settlement", "!window.getPendingSaveStatus().pending");
      const request = saves[beforeSaves], result = delivery.records.find(record => record.args[1]?.success === true)?.args[1];
      const after = await (perfOnly ? commonState() : state()), status = await exec("window.getPendingSaveStatus()");
      const valid = saves.length === beforeSaves + 1 && matchesSaveRequest(request, witness) &&
        matchesSaveResult(result, request) && result.success === true && result.savedContent === fixture.body &&
        !status.pending && status.revision > witness.save.revision &&
        after.value === lf(fixture.body) && (perfOnly || after.exact === fixture.body) &&
        after.cache === fixture.body && after.history === witness.state.history && after.owner === fixture.id &&
        after.path === fixture.file && !after.dirty && fs.readFileSync(fixture.file).equals(disk);
      check("actual explicit unchanged Save proves the qualified request observer and correlated successful settlement", valid,
        { beforeSaves, request, result, status, after });
      if (!valid) throw new Error("Actual Save observer positive control failed");
    } finally { delivery.restore(); }
  }
  function matchesReloadRequest(request, witness) {
    return !!request && request.filePath === witness.path && request.reloadRequestPath === witness.owner.pathKey &&
      request.reloadRequestSequence === witness.sequence + 1 &&
      request.reloadRequestSnapshot === witness.snapshot && request.reloadRequestSession === witness.session &&
      request.reloadRequestTabId === witness.owner.tabId &&
      request.reloadRequestDocumentGeneration === witness.owner.documentGeneration &&
      request.reloadRequestDocumentPathKey === witness.owner.pathKey &&
      request.reloadRequestDocumentRef === witness.owner.documentRef &&
      request.reloadRequestRendererGeneration === witness.owner.rendererGeneration &&
      request.reloadRequestSelectionGeneration === witness.selection;
  }
  function matchesReloadResult(result, request) {
    const identity = result?.reloadRequest;
    return !!identity && !!request && result.path === request.filePath &&
      result.reloadSession?.pageSession === request.reloadRequestSession &&
      result.reloadSession?.rendererGeneration === request.reloadRequestRendererGeneration &&
      identity.sequence === request.reloadRequestSequence && identity.path === request.reloadRequestPath &&
      identity.snapshot === request.reloadRequestSnapshot && identity.session === request.reloadRequestSession &&
      identity.tabId === request.reloadRequestTabId && identity.documentGeneration === request.reloadRequestDocumentGeneration &&
      identity.pathKey === request.reloadRequestDocumentPathKey && identity.documentRef === request.reloadRequestDocumentRef &&
      identity.rendererGeneration === request.reloadRequestRendererGeneration &&
      identity.selectionGeneration === request.reloadRequestSelectionGeneration;
  }
  function observeOwnedReload(witness, hold) {
    const channel = "reload-file", listeners = ipcMain.listeners(channel);
    if (listeners.length !== 1) throw new Error("Reload actor requires the unique registered production listener");
    const original = listeners[0], requests = [];
    let restored = false, released = false;
    const deliver = record => {
      if (record.called) return record.completion;
      record.called = true;
      record.completion = Reflect.apply(original, record.receiver, record.args);
      return record.completion;
    };
    const replacement = function (...args) {
      if (!ownedMainFrame(args[0]) || !matchesReloadRequest(args[1], witness)) {
        return Reflect.apply(original, this, args);
      }
      const record = { receiver: this, args, called: false, completion: null };
      requests.push(record);
      if (!hold) return deliver(record);
    };
    const delivery = observeMainDeliveries((name, result) => name === "file-reload-result" &&
      requests.some(record => matchesReloadResult(result, record.args[1])));
    ipcMain.removeListener(channel, original);
    ipcMain.on(channel, replacement);
    function restore() {
      if (restored) return;
      const current = ipcMain.listeners(channel);
      if (current.length !== 1 || current[0] !== replacement) throw new Error("Owned Reload listener changed");
      ipcMain.removeListener(channel, replacement);
      ipcMain.on(channel, original);
      restored = true;
      if (ipcMain.listeners(channel)[0] !== original) throw new Error("Original Reload listener did not restore");
    }
    async function awaitResult() {
      await waitMain("correlated genuine Reload result", () => delivery.records.some(record => record.args[1]?.success === true));
      const request = requests[0]?.args[1], result = delivery.records.find(record => record.args[1]?.success === true)?.args[1];
      const valid = requests.length === 1 && requests[0].called && matchesReloadRequest(request, witness) &&
        matchesReloadResult(result, request) && result.success === true && result.content === witness.state.exact;
      check("cell Reload actor observes the correlated successful production result", valid, { request, result });
      if (!valid) throw new Error("Actual Reload result did not correlate");
      await wait("genuine Reload result adopted by its owner", `window.CustomTabs.__reloadState().acceptedSequence===${request.reloadRequestSequence}&&
        currentFilePath===${JSON.stringify(witness.path)}&&editorScroll.isCurrentSource(markdownEditor.value)`);
      return result;
    }
    return { requests, delivery, awaitResult, async cleanup() {
      if (released) return;
      try {
        restore();
        released = true;
        if (hold && requests.length) {
          await cancel();
          const current = await exec(`(() => {
            const tab=window.CustomTabs.getActiveTab();
            return {path:tab?.filePath??null,owner:tab?
              window.CustomTabs.getDocumentIdentityForTab(tab.id,tab.filePath,window.getReloadRequestSession()):null,
              open:tableCellDialog.open,state:__cells.state(),mode:isEditMode};
          })()`);
          if (current.path !== witness.path || !sameOwner(current.owner, witness.owner) ||
              current.open || !current.mode || JSON.stringify(current.state) !== JSON.stringify(witness.state)) {
            throw new Error("Cannot release held Reload outside its unchanged current fixture owner: " + JSON.stringify(current));
          }
          for (const record of requests) await bounded("original Reload handler completion", deliver(record));
          await awaitResult();
        }
      } finally { delivery.restore(); }
    } };
  }
  async function bounded(label, operation, milliseconds = 4000) {
    let timeout;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(label + " exceeded " + milliseconds + "ms")), milliseconds);
      })]);
    } finally { clearTimeout(timeout); }
  }
  async function awaitMainReady() {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const candidates = BrowserWindow.getAllWindows().filter(candidate =>
        !candidate.isDestroyed() && candidate.webContents.getURL() === expectedMainURL);
      if (candidates.length > 1) throw new Error("More than one window loaded the actual Main index.html");
      win = candidates[0];
      const guard = win && earlyElectron.guards.get(win.webContents.id);
      if (guard?.acknowledged && guard.finishedURL === expectedMainURL && win.isVisible()) {
        const witness = await bounded("initial Main document guard witness", exec(`(() => ({
          contentsId:window.__cellDialogGuard?.contentsId??null,
          documentURL:window.__cellDialogGuard?.documentURL??null,
          executed:window.__cellDialogGuard?.executed??null,
          complete:document.readyState==='complete',
          shell:!!document.getElementById('viewer'),
          guarded:['alert','confirm','prompt'].every(kind=>
            window[kind].cellGuardContentsId===${win.webContents.id})&&
            ['show','showModal'].every(kind=>HTMLDialogElement.prototype[kind].cellGuardContentsId===${win.webContents.id})&&
            typeof window.__cellDialogGuard?.runCellDialog==='function'
        }))()`));
        if (witness.contentsId !== win.webContents.id || witness.documentURL !== expectedMainURL ||
            !witness.executed || !witness.complete || !witness.shell || !witness.guarded) {
          throw new Error("Actual Main document did not execute every prompt guard: " + JSON.stringify(witness));
        }
        earlyElectron.stage("guard-executed-in-main-document", { contentsId: win.webContents.id, witness });
        earlyElectron.mainReady(win, witness);
        return;
      }
      await sleep(25);
    }
    throw new Error("Actual Main document, guard acknowledgements and visible window were not ready within 10000ms");
  }
  function shellGuardsInstalled() {
    return shell.openExternal === guardedExternal && shell.openPath === guardedPath;
  }
  async function proveOwnedShellGuards() {
    check("cell Main retains the exact owned operating-system guard functions after bootstrap", shellGuardsInstalled());
    if (!shellGuardsInstalled()) throw new Error("Main replaced an owned shell guard; no click is permitted");
    const localFile = path.join(directory, "shell-control.txt");
    fixtures.push(localFile);
    fs.writeFileSync(localFile, "Owned shell-open liveness fixture.", "utf8");
    await fresh("shell-controls", "# Shell controls\n\n" +
      "[External control](https://example.invalid/cell-trap-control)\n\n[Local control](shell-control.txt)");
    for (const control of [
      { kind: "external", href: "https://example.invalid/cell-trap-control", value: "https://example.invalid/cell-trap-control" },
      { kind: "path", href: "shell-control.txt", value: fs.realpathSync.native(localFile) },
    ]) {
      if (!shellGuardsInstalled()) throw new Error("An owned shell guard changed before a trusted link click");
      const before = shellCalls.length;
      const point = await page(href => {
        const anchor = [...viewer.querySelectorAll("a")].find(node => node.getAttribute("href") === href);
        if (!anchor) throw new Error("Missing actual shell-control link");
        anchor.scrollIntoView({ block: "center" });
        const box = anchor.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) throw new Error("Shell-control link is not visible");
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
      }, control.href);
      try {
        shellControl = control;
        win.focus();
        win.webContents.sendInputEvent({ type: "mouseMove", ...point });
        win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
        await bounded("trusted renderer link reaches the owned Main " + control.kind + " guard",
          (async () => {
            const deadline = Date.now() + 4000;
            while (shellCalls.length === before && Date.now() < deadline) await sleep(25);
            if (shellCalls.length === before) throw new Error("No Main shell-control acknowledgement");
          })());
        check("trusted renderer link proves the owned Main " + control.kind + " guard is alive",
          shellGuardsInstalled() && shellControl === null && shellCalls.length === before + 1 &&
          shellCalls.at(-1)[0] === control.kind && shellCalls.at(-1)[1] === control.value, shellCalls.at(-1));
        if (!shellGuardsInstalled()) throw new Error("An owned shell guard changed during the positive control");
      } finally { shellControl = null; }
    }
    shellCalls.length = 0;
  }
  async function appendTrustedSource(text) {
    await exec(`(() => {
      markdownEditor.focus();markdownEditor.setSelectionRange(markdownEditor.value.length,markdownEditor.value.length);
      window.__cellTrustedInputs=[];
      window.__cellTrustedInput=e=>window.__cellTrustedInputs.push({trusted:e.isTrusted,type:e.inputType});
      markdownEditor.addEventListener('input',window.__cellTrustedInput);
      return true;
    })()`);
    try {
      await bounded("trusted document typing", win.webContents.insertText(text));
      return await exec(`({events:window.__cellTrustedInputs,pending:historyDebounceTimer!==null,
        value:markdownEditor.value,exact:window.CustomTabs.snapshotExactEditorContent()})`);
    } finally {
      await bounded("trusted typing listener cleanup", exec(`(() => {
        markdownEditor.removeEventListener('input',window.__cellTrustedInput);
        delete window.__cellTrustedInput;delete window.__cellTrustedInputs;return true;
      })()`));
    }
  }
  async function observeSourceAction(action) {
    await exec(`(() => {
      window.__cellSourceEvents=[];
      window.__cellSourceObserver=event=>window.__cellSourceEvents.push({
        type:event.type,trusted:event.isTrusted,inputType:event.inputType||null,key:event.key||null,
        start:markdownEditor.selectionStart,end:markdownEditor.selectionEnd,value:markdownEditor.value
      });
      for(const type of ['keydown','beforeinput','input'])
        markdownEditor.addEventListener(type,window.__cellSourceObserver,true);
      return true;
    })()`);
    try {
      await action();
      return await exec("window.__cellSourceEvents");
    } finally {
      await bounded("native source event observer cleanup", exec(`(() => {
        for(const type of ['keydown','beforeinput','input'])
          markdownEditor.removeEventListener(type,window.__cellSourceObserver,true);
        delete window.__cellSourceObserver;delete window.__cellSourceEvents;return true;
      })()`));
    }
  }
  function installKeyboardWitness() {
    if (window.__cellKeyboardWitness) throw new Error("Keyboard witness already installed");
    const strings = [], stringIds = new Map(), sourceEvents = [], cellEvents = [], phases = [];
    const pendingEvents = new WeakMap(), sessionIds = new WeakMap();
    let phase = "native-source-typing", sequence = 0, baselineSequence = null, lastSession = null, dropped = 0, sessionSequence = 0;
    const ref = value => {
      if (typeof value !== "string") return null;
      if (!stringIds.has(value)) { stringIds.set(value, strings.length); strings.push(value); }
      return stringIds.get(value);
    };
    const history = value => value ? { undo: value.undo.map(entry =>
      typeof entry === "string" ? { text: ref(entry) } : { source: ref(entry.source) }),
    redo: value.redo.map(entry => typeof entry === "string" ? { text: ref(entry) } : { source: ref(entry.source) }),
    exactTypingSource: ref(value.exactTypingSource) } : null;
    const editor = value => value ? { open: value.open, rendererMarkdown: ref(value.rendererMarkdown),
      pendingHistory: ref(value.pendingHistory), history: history(value.history), selection: value.selection,
      baseline: value.baseline ? { document: ref(value.baseline.document), dirty: value.baseline.dirty,
        history: history(value.baseline.history) } : null } : null;
    const target = node => ({ tag: node?.tagName || null, id: node?.id || null,
      editable: !!node?.isContentEditable, source: node === markdownEditor,
      cell: tableCellSession?.cells.findIndex(cell => cell.input === node || cell.input.contains(node)) ?? -1 });
    function read(includeCells = false) {
      const tab = window.CustomTabs.getActiveTab(), pageSession = window.getReloadRequestSession();
      const current = tableCellSession;
      if (current) lastSession = current;
      const session = current || lastSession, selection = session?.selection;
      if (session && !sessionIds.has(session)) sessionIds.set(session, ++sessionSequence);
      const freeze = window.CustomTabs.__shutdownFreeze(), reload = window.getReloadRequestDiagnostics();
      const value = { phase, time: performance.now(), open: tableCellDialog.open, error: tableCellError.textContent,
        disabled: tableCellUpdate.disabled, session: session ? {
          observedReferenceId: sessionIds.get(session), present: !!current, retainedAfterClose: !current,
          submitting: session.submitting, applied: session.applied,
          selectionCurrent: selection.isCurrent(), selectionTabCurrent: selection.tab === tab,
          selection: { tabId: selection.tab.id, origin: selection.origin, mode: selection.mode,
            openSequence: selection.sequence, start: selection.start, end: selection.end, direction: selection.direction },
        } : null,
        menuCurrent: tableMenuSelection?.isCurrent() ?? null,
        source: { captured: ref(session?.exact), capturedLive: ref(selection?.source), live: ref(markdownEditor.value),
          exact: ref(window.CustomTabs.snapshotExactEditorContent()), cache: ref(tab?.content),
          originalMarkdown: ref(originalMarkdown), originalContent: ref(tab?.originalContent),
          exactTypingSource: ref(exactTypingSource),
          inputWitness: exactInputWitness ? { source: ref(exactInputWitness.source), value: ref(exactInputWitness.value),
            start: exactInputWitness.start, end: exactInputWitness.end, type: exactInputWitness.type } : null },
        revision: { interaction: editorInteractionRevision, mode: editorModeRevision, open: fileOpenSequence,
          mutation: tab ? window.CustomTabs.__documentState(tab).mutationRevision : null, document: freeze.revision },
        timer: { history: historyDebounceTimer, preview: previewDebounceTimer, undoRedoRendering },
        owner: tab ? window.CustomTabs.getDocumentIdentityForTab(tab.id, tab.filePath, pageSession) : null,
        actionOwnerCurrent: currentDocumentActionOwner() === tab, pageSession, path: currentFilePath,
        selectionGeneration: window.getActiveFileSelectionGeneration(),
        reload: { sequence: reload.sequence, latest: window.getLatestReloadRequestSequence(currentFilePath), session: reload.session },
        save: window.getPendingSaveStatus(), freeze, history: history(historySnapshot()),
        liveEditor: editor(captureDocumentEditor()), dirty: hasUnsavedChanges, editMode: isEditMode,
        activeElement: target(document.activeElement),
        sourceCaret: { start: markdownEditor.selectionStart, end: markdownEditor.selectionEnd, direction: markdownEditor.selectionDirection },
        previewCurrent: editorScroll.isCurrentSource(markdownEditor.value) };
      if (includeCells) {
        value.retainedEditor = editor(window.CustomTabs.getDocumentEditorState(tab?.id));
        value.changedCells = (session?.cells || []).filter(cell => cell.input.innerHTML !== cell.initial).map(cell => {
          const changed = { row: cell.row, column: cell.column, initial: ref(cell.initial), html: ref(cell.input.innerHTML) };
          try { changed.serialized = ref(serializeSafeTableCell(cell.input)); }
          catch (error) { changed.serializationError = error.message; }
          return changed;
        });
      }
      return value;
    }
    const types = ["keydown", "beforeinput", "input", "pointerdown", "wheel", "paste",
      "compositionstart", "compositionend", "focusin", "focusout"];
    const before = event => {
      const kind = event.target === markdownEditor ? "source" :
        event.target instanceof Node && tableCellDialog.contains(event.target) ? "cell" : null;
      if (!kind) return;
      if (sourceEvents.length + cellEvents.length >= 256) { dropped++; return; }
      const record = { sequence: ++sequence, phase, kind, type: event.type, trusted: event.isTrusted,
        cancelable: event.cancelable, inputType: event.inputType || null,
        key: event.key || null, composing: event.isComposing || false,
        target: target(event.target), before: read() };
      Object.defineProperty(record, "defaultPrevented", { enumerable: true, get: () => event.defaultPrevented });
      (kind === "source" ? sourceEvents : cellEvents).push(record);
      pendingEvents.set(event, record);
      // Bubble is the exact post-handler observation when reached. A stopped
      // event gets a separately labelled microtask sample, not that claim.
      queueMicrotask(() => { record.afterDispatchMicrotask = read(); });
    };
    const after = event => {
      const record = pendingEvents.get(event);
      if (record) record.afterPropagation = read();
    };
    const mark = (name, baseline = false) => {
      phase = name;
      if (baseline) baselineSequence = sequence;
      const sample = { sequence, name, state: read(true), sourceEvents: sourceEvents.length, cellEvents: cellEvents.length,
        sourceInputControl: sourceEvents.some(event => event.type === "input" && event.trusted && event.inputType === "insertText"),
        sourceHistoryInputs: sourceEvents.filter(event => event.sequence > baselineSequence &&
          event.type === "input" && ["historyUndo", "historyRedo"].includes(event.inputType)).length,
        canceledSourceHistory: sourceEvents.filter(event => event.sequence > baselineSequence &&
          event.type === "beforeinput" && event.trusted && event.cancelable && event.defaultPrevented &&
          ["historyUndo", "historyRedo"].includes(event.inputType)).map(event => event.inputType),
        trustedCellHistoryKeys: cellEvents.filter(event => event.sequence > baselineSequence &&
          event.type === "keydown" && event.trusted && ["z", "y"].includes(event.key?.toLowerCase())).length,
        trustedCellHistoryInputs: cellEvents.filter(event => event.sequence > baselineSequence &&
          event.type === "input" && event.trusted && ["historyUndo", "historyRedo"].includes(event.inputType))
          .map(event => event.inputType),
        cellInputControl: cellEvents.some(event => event.type === "input" && event.trusted), dropped };
      phases.push(sample);
      return sample;
    };
    const stop = () => {
      for (const type of types) {
        window.removeEventListener(type, before, true);
        window.removeEventListener(type, after);
      }
    };
    for (const type of types) {
      window.addEventListener(type, before, true);
      window.addEventListener(type, after);
    }
    window.__cellKeyboardWitness = { mark, finish() {
      try {
        mark("before-cleanup");
        const postBaseline = sourceEvents.filter(event => baselineSequence !== null && event.sequence > baselineSequence);
        return { strings, phases, sourceEvents, cellEvents, baselineSequence, dropped,
          firstPostBaselineSourceEvent: postBaseline[0] || null,
          firstPostBaselineSourceInput: postBaseline.find(event => event.type === "input") || null,
          interpretation: "Read-only authority/event observations; no captureDialogContext call, authority reset or product repair." };
      } finally { stop(); delete window.__cellKeyboardWitness; }
    } };
    return true;
  }
  function installHelpers() {
    window.__cells = {
      rightClick(node) {
        const rect = node.getBoundingClientRect();
        node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
          clientX: Math.round(rect.left + Math.min(8, rect.width / 2)),
          clientY: Math.round(rect.top + Math.min(8, rect.height / 2)) }));
        return contextMenu.classList.contains("visible");
      },
      source(from, to) {
        getSelection().removeAllRanges();
        markdownEditor.focus();
        markdownEditor.setSelectionRange(from, to, "backward");
        return this.rightClick(markdownEditor);
      },
      preview(index, first, last) {
        const table = viewer.querySelectorAll("table")[index];
        const range = document.createRange();
        if (first === undefined) range.selectNode(table);
        else {
          const texts = cell => {
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT), nodes = [];
            for (let node; (node = walker.nextNode());) nodes.push(node);
            return nodes;
          };
          const from = texts(table.rows[first].cells[0])[0];
          const to = texts(table.rows[last].cells[table.rows[last].cells.length - 1]).at(-1);
          range.setStart(from, Math.min(1, from.textContent.length));
          range.setEnd(to, Math.max(1, to.textContent.length - 1));
        }
        const selection = getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        return this.rightClick(table.rows[first || 0].cells[0]);
      },
      action(rowsOnly) {
        const button = document.getElementById(rowsOnly ? "ctxEditSelectedRows" : "ctxEditTable");
        const visible = button.getClientRects().length > 0 && getComputedStyle(button).display !== "none";
        window.__cellDialogGuard.runCellDialog(() => button.click());
        return { visible, opened: tableCellDialog.open, count: this.inputs().length,
          error: document.getElementById("notificationMessage").textContent };
      },
      inputs() { return [...tableCellGrid.querySelectorAll('[contenteditable="true"]')]; },
      commonState() {
        const tab = window.CustomTabs.getActiveTab(), editor = captureDocumentEditor();
        const session = window.getReloadRequestSession();
        return { value: markdownEditor.value, cache: tab?.content,
          history: JSON.stringify(historyForEditorState(editor)), editor,
          dirty: hasUnsavedChanges, owner: tab?.id, path: currentFilePath,
          identity: tab ? window.CustomTabs.getDocumentIdentityForTab(tab.id, tab.filePath, session) : null };
      },
      state() {
        return { value: markdownEditor.value, exact: window.CustomTabs.snapshotExactEditorContent(),
          cache: window.CustomTabs.getActiveTab().content,
          history: JSON.stringify(historySnapshot()), undo: historySnapshot().undo.length,
          redo: historySnapshot().redo.length, dirty: hasUnsavedChanges,
          owner: window.CustomTabs.getActiveTabId(), path: currentFilePath };
      },
    };
    return true;
  }
  async function fresh(label, body = original) {
    let retained = null;
    const before = await exec(`({
      dirty:hasUnsavedWork(),owner:window.CustomTabs.getActiveTabId(),path:currentFilePath,
      guarded:window.__cellDialogGuard?.executed&&
        ['show','showModal'].every(kind=>HTMLDialogElement.prototype[kind].cellGuardContentsId===${win.webContents.id}),
      frozen:!!window.CustomTabs.isDocumentFrozen?.(),save:window.getPendingSaveStatus(),
      dialogs:[...document.querySelectorAll('dialog[open]')].map(node=>({id:node.id,text:node.textContent.slice(0,500)}))
    })`);
    if (!before.guarded || before.dialogs.length || before.frozen || before.save.pending || chooser) {
      throw new Error("Unsafe fixture admission before " + label + ": " + JSON.stringify(before));
    }
    if (before.dirty) {
      if (!admissionFixture || before.owner === admissionFixture.id) {
        throw new Error("No independently clean fixture-admission tab: " + JSON.stringify(before));
      }
      retained = await exec(`(() => {
        const editor=captureDocumentEditor();
        return {state:__cells.${perfOnly ? "commonState" : "state"}(),editor,
          history:JSON.stringify(historyForEditorState(editor))};
      })()`);
      if (perfOnly) {
        const expected = performanceSources.get(retained.state.owner);
        if (!expected || expected.file !== retained.state.path || expected.source !== lf(expected.source) ||
            retained.state.value !== expected.source || !sameOwner(retained.state.identity, expected.identity)) {
          throw new Error("Dirty performance owner lacks its independently authored LF source and identity");
        }
        retained.expectedSource = expected.source;
      } else retained.expectedSource = retained.state.exact;
      retained.disk = fs.readFileSync(retained.state.path);
      retained.saves = saves.length;
      await page(id => window.CustomTabs.switchToTab(id), admissionFixture.id);
      const mapped = perfOnly
        ? "(()=>{const d=editorScroll.diagnostics();return d.matchesSource&&!d.pendingSource&&" +
          "Number.isSafeInteger(d.selection)&&d.selection>0&&d.mappedSelection===d.selection})()"
        : "editorScroll.isCurrentSource(markdownEditor.value)";
      await wait("clean fixture-admission tab", `currentFilePath===${JSON.stringify(admissionFixture.file)}&&
        isEditMode&&${mapped}&&!undoRedoRendering&&!window.CustomTabs.isDocumentFrozen()`);
      const parked = await (perfOnly ? commonState() : state());
      const clean = parked.owner === admissionFixture.id && (perfOnly || parked.exact === admissionFixture.body) &&
        parked.cache === admissionFixture.body && parked.value === lf(admissionFixture.body) &&
        !await exec("hasUnsavedWork()") && fs.readFileSync(admissionFixture.file, "utf8") === admissionFixture.body;
      check("fixture " + label + " admits from its independently clean tab without discarding the dirty owner", clean, parked);
      if (!clean) throw new Error("Fixture-admission tab is not clean");
    }
    const file = prepareFixture(label, body);
    await exec("document.getElementById('openFile').click();true");
    try {
      await wait(label + " DOM paint", `currentFilePath===${JSON.stringify(file)}&&
        viewer.querySelector('h1')?.textContent===${JSON.stringify(lf(body).replace(/^\uFEFF?# /, "").split("\n")[0])}&&
        !loadingScreen.classList.contains('active')`);
    } catch (error) {
      const actual = await exec(`({path:currentFilePath,owner:window.CustomTabs.getActiveTabId(),
        dirty:hasUnsavedWork(),heading:viewer.querySelector('h1')?.textContent,
        dialogs:[...document.querySelectorAll('dialog[open]')].map(node=>({id:node.id,text:node.textContent.slice(0,500)}))})`);
      throw new Error(error.message + "; chooserConsumed=" + (chooser === null) + "; state=" + JSON.stringify(actual));
    }
    if (chooser !== null) throw new Error("Fixture chooser was not consumed for " + label);
    if (!await exec("isEditMode")) await exec("openEditorBtn.click();true");
    await wait("editable source ownership", "isEditMode&&contentWrapper.classList.contains('split-view')&&editorScroll.diagnostics().matchesSource&&!editorScroll.diagnostics().pendingSource");
    await page(installHelpers);
    const present = await exec(`(() => {
      const dialog=document.getElementById('tableCellDialog'),button=document.getElementById('tableCellCancel');
      if(dialog&&(!(dialog instanceof HTMLDialogElement)||!(button instanceof HTMLButtonElement)||!dialog.contains(button))) {
        throw new Error('Malformed cell dialog or Cancel control');
      }
      return !!dialog;
    })()`);
    if (observedCellDialog === null) {
      if (!present && !(baseline && perfOnly)) throw new Error("Candidate cell dialog is missing");
      observedCellDialog = present;
    } else if (present !== observedCellDialog) throw new Error("Observed cell dialog presence changed");
    await settle();
    if (retained) {
      const parkedOwner = await page(id => {
        const tab = window.CustomTabs.getTabs().find(tab => tab.id === id);
        const editor = window.CustomTabs.getDocumentEditorState(id);
        return tab ? { id: tab.id, path: tab.filePath, content: tab.content,
          dirty: tab.hasUnsavedChanges, editor,
          history: editor ? JSON.stringify(historyForEditorState(editor)) : null } : null;
      }, retained.state.owner);
      const preserved = parkedOwner?.id === retained.state.owner && parkedOwner.path === retained.state.path &&
        parkedOwner.content === retained.expectedSource &&
        parkedOwner.dirty === retained.state.dirty && parkedOwner.editor?.open === retained.editor.open &&
        parkedOwner.history === retained.history &&
        saves.length === retained.saves && fs.readFileSync(retained.state.path).equals(retained.disk);
      check("fixture " + label + " preserves the parked dirty owner's exact source history state and disk", preserved, parkedOwner);
      if (!preserved) throw new Error("Fixture admission changed the parked dirty owner");
    }
    const fixture = { file, id: await exec("window.CustomTabs.getActiveTabId()"), body };
    if (perfOnly) {
      const observed = await commonState();
      if (observed.owner !== fixture.id || observed.path !== file ||
          observed.value !== lf(body) || observed.cache !== body || !observed.identity) {
        throw new Error("Performance fixture source or identity was not established");
      }
      performanceSources.set(fixture.id, { file, source: body, identity: observed.identity });
    }
    return fixture;
  }
  function prepareFixture(label, body) {
    if (chooser) throw new Error("An earlier owned fixture chooser is still pending");
    const file = path.join(directory, ++fileSequence + "-" + label + ".md");
    fixtures.push(file);
    fs.writeFileSync(file, body, "utf8");
    fs.writeFileSync(path.join(directory, "cell.svg"), image);
    chooser = file;
    return file;
  }
  async function proveDirtyOpenRefusal() {
    const body = "# Dirty Open refusal\n\nOwned source must not be discarded.";
    const fixture = await fresh("dirty-open-refusal", body);
    const witness = " unsaved guard witness", typed = await appendTrustedSource(witness);
    await wait("dirty Open witness paints", "editorScroll.isCurrentSource(markdownEditor.value)");
    const before = await state();
    const guarded = await exec(`!!window.__cellDialogGuard?.executed&&
      ['show','showModal'].every(kind=>HTMLDialogElement.prototype[kind].cellGuardContentsId===${win.webContents.id})&&
      !document.querySelector('dialog[open]')&&hasUnsavedWork()`);
    const setup = guarded && shellGuardsInstalled() && before.owner === fixture.id &&
      before.path === fixture.file && before.dirty && before.value === body + witness &&
      before.exact === body + witness && typed.events.some(event => event.trusted && event.type === "insertText") &&
      saves.length === 0 && fs.readFileSync(fixture.file, "utf8") === body;
    check("dirty Open negative probe proves its guarded owned unsaved source before Open", setup, { before, guarded, typed });
    if (!setup) throw new Error("Dirty Open negative probe setup was not established");
    const next = prepareFixture("dirty-open-unreached", "# Must not open\n\nThe confirmation must be refused first.");
    earlyElectron.stage("dirty-open-negative-armed", { owner: fixture.id, path: fixture.file,
      nextFixture: next, expectedDialog: "appMessageDialog", source: before.exact,
      diskUnchanged: true, noSave: true });
    await exec("document.getElementById('openFile').click();true");
    await sleep(1500);
    throw new Error("Dirty Open did not reach the expected before-original fatal refusal");
  }
  const state = () => exec("__cells.state()");
  const commonState = () => exec("__cells.commonState()");
  async function openGrid(index = 1, rowsOnly = false, first, last) {
    const menu = first === undefined
      ? await page(index => __cells.preview(index), index)
      : await page((index, first, last) => __cells.preview(index, first, last), index, first, last);
    const opened = await page(rows => __cells.action(rows), rowsOnly);
    check("cell dialog setup has a real selected table and visible menu action", menu && opened.visible && opened.opened, opened);
    return opened;
  }
  async function cancel() {
    if (!win || win.isDestroyed()) return;
    await page(closeObservedCellDialog, observedCellDialog, baseline && perfOnly && observedCellDialog === false);
  }
  async function cleanupActors() {
    if (!win || win.isDestroyed()) return;
    let failure = null;
    const attempt = async operation => {
      try { await operation(); }
      catch (error) { failure ||= error; }
    };
    await attempt(cancel);
    await attempt(async () => {
      if (await bounded("freeze cleanup read", exec("!!window.CustomTabs?.isDocumentFrozen?.()"))) {
        win.webContents.send("quit-approval-thaw");
        await wait("test-owned freeze cleanup", "!window.CustomTabs.isDocumentFrozen()");
      }
    });
    if (actorCleanup) {
      const cleanup = actorCleanup;
      actorCleanup = null;
      await attempt(cleanup);
    }
    await attempt(() => bounded("renderer actor cleanup", exec(`(async () => {
      const restore=window.__cellStaleRestore;
      delete window.__cellStaleRestore;
      if(restore)await restore();
      return true;
    })()`)));
    if (failure) throw failure;
  }
  async function screenshot(name) {
    const readiness = await dialogCaptureReadiness();
    if (readiness) {
      check("cell screenshot waits for enabled settled readable Cancel colors for " + name, readiness.ready, readiness);
      if (!readiness.ready) throw new Error("Cell dialog capture is not ready: " + JSON.stringify(readiness));
    }
    const captureName = process.env.FOLIA_CELL_EVIDENCE
      ? path.relative(ROOT, evidence) + "-" + name : "table-cell-editor-" + name;
    const file = await captureScreenshot(win, captureName);
    const valid = !!file && fs.existsSync(file) && fs.statSync(file).size > 100;
    check("cell screenshot is freshly captured for " + name, valid, file);
    const preserved = path.join(evidence, name + ".png");
    if (valid && path.resolve(file) !== preserved) fs.copyFileSync(file, preserved);
    screenshots.push({ name, file: valid ? preserved : file, sha256: valid ? sha(file) : null, readiness, viewed: false });
  }
  async function dialogCaptureReadiness() {
    return exec(`(async () => {
      if(!tableCellDialog.open)return null;
      const button=tableCellCancel,probe=document.createElement('span');
      probe.style.display='none';button.append(probe);
      const resolve=token=>{probe.style.color='var('+token+')';return getComputedStyle(probe).color};
      const luminance=color=>{
        const match=/^rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)$/.exec(color);
        if(!match)return null;
        const rgb=match.slice(1).map(Number).map(value=>{
          value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;
        });
        return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
      };
      const deadline=performance.now()+2500;
      let result;
      try {
        do {
          const hover=button.matches(':hover'),style=getComputedStyle(button);
          const expectedBackground=resolve(hover?'--border-color':'--bg-tertiary');
          const expectedText=resolve(hover?'--text-primary':'--text-secondary');
          const animations=button.getAnimations().filter(animation=>
            ['background-color','color','opacity','transform','box-shadow','all'].includes(animation.transitionProperty))
            .map(animation=>({property:animation.transitionProperty,state:animation.playState,pending:animation.pending}));
          const bg=luminance(style.backgroundColor),fg=luminance(style.color);
          const contrast=bg===null||fg===null?0:(Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05);
          const disabled=button.disabled||button.matches(':disabled')||button.getAttribute('aria-disabled')==='true';
          const updateDisabled=tableCellUpdate.disabled||tableCellUpdate.matches(':disabled');
          const visible=button.getClientRects().length>0&&style.visibility==='visible'&&style.opacity==='1';
          // The existing light tokens are 4.47:1. This guards transitional
          // contrast, not a new accessibility-compliance claim.
          result={hover,disabled,updateDisabled,visible,background:style.backgroundColor,text:style.color,
            expectedBackground,expectedText,contrast,animations,
            ready:!disabled&&!updateDisabled&&visible&&!document.body.inert&&
              style.backgroundColor===expectedBackground&&style.color===expectedText&&contrast>=4&&
              animations.every(animation=>!animation.pending&&animation.state==='finished')};
          if(result.ready)return result;
          await new Promise(resolve=>requestAnimationFrame(resolve));
        } while(performance.now()<deadline);
        return result;
      } finally {probe.remove()}
    })()`);
  }
  async function dialogSurface() {
    return exec(`(() => {
      const probe=document.createElement('span');probe.style.display='none';tableCellDialog.append(probe);
      let background,text;
      try {
        probe.style.color='var(--bg-secondary)';background=getComputedStyle(probe).color;
        probe.style.color='var(--text-primary)';text=getComputedStyle(probe).color;
      } finally {probe.remove()}
      const style=getComputedStyle(tableCellDialog),head=getComputedStyle(tableCellGrid.querySelector('thead'));
      const rect=tableCellDialog.getBoundingClientRect();
      return {background:style.backgroundColor,header:head.backgroundColor,text:style.color,
        opaque:/^rgb\\(/.test(style.backgroundColor)&&style.backgroundColor===background&&head.backgroundColor===background,
        themedText:style.color===text,
        centered:Math.abs(rect.left-(innerWidth-rect.right))<=2&&Math.abs(rect.top-(innerHeight-rect.bottom))<=2,
        contained:rect.width>0&&rect.height>0&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight};
    })()`);
  }
  async function update() {
    await exec("tableCellUpdate.click();true");
    await wait("cell update settled", "!tableCellDialog.open||!!tableCellError.textContent");
    await settle();
    return exec(`({open:tableCellDialog.open,error:tableCellError.textContent,disabled:tableCellUpdate.disabled,
      sessionPresent:!!tableCellSession,submitting:tableCellSession?.submitting??null,applied:tableCellSession?.applied??null})`);
  }
  async function gridLinkStyles(theme) {
    const debuggerAPI = win.webContents.debugger;
    const command = (name, args) => bounded("owned grid " + name, debuggerAPI.sendCommand(name, args));
    const snapshot = () => exec(`(() => {
      const probe=document.createElement('span');probe.style.color='var(--accent-main)';tableCellGrid.append(probe);
      let expectedColor;
      try {expectedColor=getComputedStyle(probe).color} finally {probe.remove()}
      return {expectedColor,links:[...tableCellGrid.querySelectorAll('a')].map(link=>{
        const style=getComputedStyle(link);
        return {href:link.getAttribute('href'),text:link.textContent,color:style.color,
          pointerEvents:style.pointerEvents,decoration:style.textDecorationLine};
      })};
    })()`);
    const matched = async nodeId => {
      const [styles, computed] = await Promise.all([
        command("CSS.getMatchedStylesForNode", { nodeId }),
        command("CSS.getComputedStyleForNode", { nodeId }),
      ]);
      return { nodeId, computed: Object.fromEntries(computed.computedStyle
        .filter(property => ["color", "pointer-events", "text-decoration-line"].includes(property.name))
        .map(property => [property.name, property.value])),
      rules: (styles.matchedCSSRules || []).filter(match =>
        match.rule.selectorList?.selectors?.some(selector => selector.text.startsWith(".table-cell-grid a")))
        .map(match => ({ selectors: match.rule.selectorList.selectors.map(selector => selector.text),
          matchingSelectors: match.matchingSelectors,
          declarations: match.rule.style.cssProperties.filter(property => !property.disabled &&
            ["color", "text-decoration", "text-decoration-line", "pointer-events"].includes(property.name))
            .map(property => ({ name: property.name, value: property.value.trim() })) })) };
    };
    const hasSelector = (entry, selector) => entry.rules.some(rule =>
      rule.matchingSelectors.some(index => rule.selectors[index] === selector));
    const hasRoleRule = (entry, selector) => entry.rules.some(rule =>
      rule.matchingSelectors.some(index => rule.selectors[index] === selector) &&
      rule.declarations.some(property => property.name === "color" && property.value === "var(--accent-main)") &&
      rule.declarations.some(property => ["text-decoration", "text-decoration-line"].includes(property.name) && property.value === "none") &&
      rule.declarations.some(property => property.name === "pointer-events" && property.value === "none"));
    const correctStyles = state => !!state?.links.length && state.links.every(link =>
      link.color === state.expectedColor && link.pointerEvents === "none" && link.decoration === "none");
    const evidence = { theme, method: "forced Chromium :visited rendering; not browsing history",
      privacyNote: "DOM computed color alone cannot establish :visited; require the newly matched forced selector and capture.",
      normal: await snapshot(), normalRules: [], forcedVisited: null, visitedRules: [], restored: null, constraint: null };
    await screenshot("rich-grid-" + theme);
    screenshots.at(-1).linkStyles = { theme, state: "normal", observation: evidence.normal };
    const forcedNodes = [];
    try {
      if (!debuggerAPI.isAttached()) throw new Error("Existing guarded debugger is not attached");
      await command("DOM.enable");
      await command("CSS.enable");
      const { root } = await command("DOM.getDocument", { depth: 0 });
      const { nodeIds } = await command("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "#tableCellGrid a" });
      if (!nodeIds.length || nodeIds.length !== evidence.normal.links.length) throw new Error("Owned grid link node set did not match");
      evidence.normalRules = await Promise.all(nodeIds.map(matched));
      for (const nodeId of nodeIds) {
        forcedNodes.push(nodeId);
        await command("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["visited"] });
      }
      await settle();
      evidence.forcedVisited = await snapshot();
      evidence.visitedRules = await Promise.all(nodeIds.map(matched));
      evidence.visitedForcingSupported = evidence.normalRules.every(entry =>
        !hasSelector(entry, ".table-cell-grid a:visited")) &&
        evidence.visitedRules.every(entry => hasSelector(entry, ".table-cell-grid a:visited"));
      if (!evidence.visitedForcingSupported) {
        evidence.constraint = "Chromium did not demonstrate a newly matched forced :visited selector; visited rendering is unproven.";
      } else {
        await screenshot("rich-grid-" + theme + "-forced-chromium-visited");
        screenshots.at(-1).linkStyles = { theme, state: evidence.method, observation: evidence.forcedVisited,
          matchedRules: evidence.visitedRules };
      }
    } catch (error) {
      evidence.constraint = error.stack || String(error);
    } finally {
      const restoreErrors = [];
      for (const nodeId of forcedNodes) {
        try { await command("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }); }
        catch (error) { restoreErrors.push(error.message); }
      }
      await settle();
      evidence.restored = await snapshot();
      evidence.restoreErrors = restoreErrors;
      evidence.restoredRules = await Promise.all(forcedNodes.map(matched));
    }
    check("cell grid forced visited selector is observable and restored in " + theme,
      !evidence.constraint && !evidence.restoreErrors.length && evidence.visitedForcingSupported &&
      evidence.restoredRules.length === evidence.normal.links.length &&
      evidence.restoredRules.every(entry => !hasSelector(entry, ".table-cell-grid a:visited")), evidence);
    const valid = !evidence.constraint && !evidence.restoreErrors.length && evidence.visitedForcingSupported &&
      correctStyles(evidence.normal) && correctStyles(evidence.forcedVisited) && correctStyles(evidence.restored) &&
      evidence.normalRules.every(entry => hasRoleRule(entry, ".table-cell-grid a")) &&
      evidence.restoredRules.every(entry => hasRoleRule(entry, ".table-cell-grid a") &&
        !hasRoleRule(entry, ".table-cell-grid a:visited")) &&
      evidence.visitedRules.every(entry => entry.computed.color === evidence.forcedVisited.expectedColor &&
        entry.computed["pointer-events"] === "none" && entry.computed["text-decoration-line"] === "none");
    check("cell grid links use theme color in " + theme + " normal and visited states", valid, evidence);
  }
  async function key(keyCode, modifiers = []) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await settle();
  }
  async function withCellViewport(label, width, height, emulated, run) {
    const observations = [];
    const observe = async phase => {
      const state = { phase, bounds: win.getBounds(), content: win.getContentSize(),
        maximized: win.isMaximized(), zoom: win.webContents.getZoomFactor(),
        viewport: await page(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })) };
      observations.push(state);
      return state;
    };
    const before = await observe("before");
    const normalBounds = win.getNormalBounds();
    const debuggerAPI = win.webContents.debugger;
    const command = (name, args) => bounded("cell viewport " + name, debuggerAPI.sendCommand(name, args));
    // Width drives help wrapping; native height can round at fractional OS scale.
    const heightRounding = emulated ? 0 : 2;
    const viewportMatches = (targetWidth, targetHeight) =>
      `innerWidth===${targetWidth}&&Math.abs(innerHeight-${targetHeight})<=${heightRounding}`;
    let overrideAttempted = false;
    const errors = [];
    try {
      if (emulated) {
        // The reference must run even when the hosted desktop is narrower.
        overrideAttempted = true;
        await command("Emulation.setDeviceMetricsOverride", {
          width, height, deviceScaleFactor: before.viewport.dpr, mobile: false,
        });
      } else {
        if (before.maximized) {
          win.unmaximize();
          await waitMain(label + " unmaximizes", () => !win.isMaximized());
        }
        win.setContentSize(width, height);
      }
      await settle();
      await observe("after requested size");
      await wait(label + " content viewport", viewportMatches(width, height));
      await exec("document.fonts.ready.then(()=>true)");
      await settle();
      const actual = await page(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
      check("cell " + label + " viewport renders " +
        (emulated ? "its exact reference size" : "its exact width and measured native height"),
        actual.width === width && Math.abs(actual.height - height) <= heightRounding && debuggerAPI.isAttached(),
        { requested: { width, height }, mode: emulated ? "CDP-emulated reference" : "native content size",
          heightRounding, actual, nativeContentSize: win.getContentSize() });
      await run();
    } catch (error) {
      errors.push({ phase: "setup or scenario", error: error.stack });
    }
    try {
      if (overrideAttempted) await command("Emulation.clearDeviceMetricsOverride");
      if (!emulated) {
        win.setBounds(before.maximized ? normalBounds : before.bounds);
        if (before.maximized) {
          win.maximize();
          await waitMain(label + " restores maximized state", () => win.isMaximized());
        }
      }
      await settle();
      await observe("after restoration request");
      await wait(label + " restores the original content viewport",
        viewportMatches(before.viewport.width, before.viewport.height));
      await settle();
      const restored = await observe("restored");
      check("cell " + label + " restores the native Main viewport and debugger",
        restored.viewport.dpr === before.viewport.dpr && restored.zoom === before.zoom &&
        restored.maximized === before.maximized && debuggerAPI.isAttached(),
        { before, restored, heightRounding, observations });
    } catch (error) {
      errors.push({ phase: "restoration", error: error.stack });
    }
    if (errors.length) throw new Error(label + " viewport failure: " + JSON.stringify({ errors, observations }));
  }
  async function cellLayout() {
    return page(() => {
      const rect = node => node.getBoundingClientRect().toJSON();
      const header = tableCellDialog.querySelector('.note-dialog-header');
      const footer = tableCellDialog.querySelector('.note-dialog-footer');
      const copy = footer.querySelector('.table-cell-footer-copy');
      const actions = footer.querySelector('.table-cell-footer-actions');
      const text = node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const style = getComputedStyle(node);
        return { content: node.textContent, bounds: rect(node),
          visible: style.visibility === 'visible' && style.opacity === '1' && style.display !== 'none',
          rects: [...range.getClientRects()].map(box => box.toJSON()) };
      };
      const buttons = [tableCellUpdate, document.getElementById('tableCellCancel')];
      return { dialog: rect(tableCellDialog), header: rect(header), grid: rect(tableCellGrid),
        footer: rect(footer), copy: rect(copy), actions: rect(actions),
        buttons: buttons.map(rect),
        usableButtons: buttons.every(button => {
          const box = button.getBoundingClientRect(), style = getComputedStyle(button);
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return !button.disabled && style.visibility === 'visible' && style.opacity === '1' &&
            style.pointerEvents !== 'none' && !!hit && button.contains(hit);
        }),
        scopeText: text(document.getElementById('tableCellScope')),
        helpText: text(document.getElementById('tableCellHelp')),
        viewport: { width: innerWidth, height: innerHeight },
        scopeInCopy: copy.contains(document.getElementById('tableCellScope')),
        helpInCopy: copy.contains(document.getElementById('tableCellHelp')),
        scopeFont: parseFloat(getComputedStyle(document.getElementById('tableCellScope')).fontSize),
        helpFont: parseFloat(getComputedStyle(document.getElementById('tableCellHelp')).fontSize),
        resize: getComputedStyle(tableCellDialog).resize };
    });
  }
  function readableCellFooter(layout, expectedScope, inline) {
    const inside = (box, outer) => box.width > 0 && box.height > 0 &&
      box.left >= outer.left - 1 && box.right <= outer.right + 1 &&
      box.top >= outer.top - 1 && box.bottom <= outer.bottom + 1;
    const viewport = { left: 0, top: 0, right: layout.viewport.width, bottom: layout.viewport.height };
    const separated = layout.copy.right <= layout.actions.left - 4 ||
      (!inline && layout.copy.bottom <= layout.actions.top - 4);
    const expectedHelp = "Tab: next cell. Enter / Shift+Enter: next / previous row. Ctrl+Enter: update. Escape: cancel.";
    return layout.scopeInCopy && layout.helpInCopy && layout.scopeFont === 12 && layout.helpFont === 12 &&
      layout.scopeText.content === expectedScope && layout.helpText.content === expectedHelp &&
      [layout.scopeText, layout.helpText].every(text => text.visible && text.rects.length > 0 &&
        text.rects.every(box => inside(box, text.bounds) && inside(box, layout.copy) &&
          inside(box, layout.footer) && inside(box, layout.dialog) && inside(box, viewport))) &&
      separated && layout.usableButtons && inside(layout.copy, layout.footer) &&
      inside(layout.actions, layout.footer) && inside(layout.footer, layout.dialog) && inside(layout.dialog, viewport) &&
      layout.buttons.every(button => inside(button, layout.actions) && button.height >= 32) &&
      layout.buttons[0].width >= 192 && layout.buttons[1].width >= 88 &&
      Math.abs(layout.buttons[0].top - layout.buttons[1].top) <= 1 &&
      layout.grid.top >= layout.header.bottom && layout.grid.top - layout.header.bottom <= 12;
  }
  async function resizeCellDialog(dx, dy) {
    const layout = await cellLayout();
    const start = { x: Math.floor(layout.dialog.right - 5), y: Math.floor(layout.dialog.bottom - 5) };
    const end = { x: Math.max(1, Math.min(layout.viewport.width - 2, start.x + dx)),
      y: Math.max(1, Math.min(layout.viewport.height - 2, start.y + dy)) };
    win.webContents.sendInputEvent({ type: "mouseMove", ...start });
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...start });
    let previous = start;
    try {
      await settle();
      for (let step = 1; step <= 4; step++) {
        const point = { x: Math.round(start.x + (end.x - start.x) * step / 4),
          y: Math.round(start.y + (end.y - start.y) * step / 4) };
        win.webContents.sendInputEvent({ type: "mouseMove", ...point,
          movementX: point.x - previous.x, movementY: point.y - previous.y });
        previous = point;
      }
    } finally {
      win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...previous });
    }
    await settle();
    return cellLayout();
  }
  async function pureInRenderer() {
    // Parse-only coverage is shared with the plain Node route; DOM authority
    // and the real menu/dialog must still pass below.
    check("cell fixtures prove independently authored source and exact duplicate boundaries",
      original.slice(secondOffset, secondOffset + table.length) === table &&
      original.indexOf(table) === prefix.length && original.lastIndexOf(table) === secondOffset);
  }
  async function menus() {
    await fresh("menus");
    const mode = await exec(`(() => {
      __cells.preview(0);
      const edit=[ctxEditTable,ctxEditSelectedRows].every(e=>e.getClientRects().length);
      hideContextMenu(); exitEditBtn.click();
      __cells.rightClick(viewer.querySelector('td'));
      const view=[ctxEditTable,ctxEditSelectedRows].every(e=>!e.getClientRects().length);
      hideContextMenu(); openEditorBtn.click(); return {edit,view};
    })()`);
    check("cell menus are offered in edit mode and hidden in reading mode", mode.edit && mode.view, mode);
    for (const origin of ["preview", "source"]) {
      for (const rowsOnly of [false, true]) {
        if (origin === "preview") await page(() => __cells.preview(1, 2, 2));
        else await page((from, to) => __cells.source(from, to),
          lf(original.slice(0, secondOffset + table.indexOf("| second"))).length + 2,
          lf(original.slice(0, secondOffset + table.indexOf("| third"))).length - 2);
        const opened = await page(rows => __cells.action(rows), rowsOnly);
        check(origin + " actual menu " + (rowsOnly ? "selected rows" : "full table") + " uses its owning table",
          opened.visible && opened.opened && opened.count === (rowsOnly ? 3 : 12), opened);
        await cancel();
      }
    }
    await openGrid();
    const rich = await exec(`(async () => {
      const inputs=__cells.inputs(), cell=inputs[3], ref=inputs[5];
      const image=ref.querySelector('img');
      for(let i=0;i<50&&!image?.naturalWidth;i++)await new Promise(r=>setTimeout(r,20));
      return {count:inputs.length,strong:cell.querySelector('strong')?.textContent,
        code:inputs[4].querySelector('code')?.textContent,
        emphasis:inputs[4].querySelector('em')?.textContent,link:ref.querySelector('a')?.textContent,
        image:!!image,imageVisible:image?.complete&&image.naturalWidth===12,
        source:tableCellDialog.querySelectorAll('textarea').length,
        focus:document.activeElement===inputs[0],native:tableCellDialog.matches(':modal'),
        safe:inputs.every(input=>{
          const serial=serializeSafeTableCell(input),copy=document.createElement('div');
          copy.innerHTML=serial;
          return serializeSafeTableCell(copy.firstElementChild)===serial&&serializeSafeTableCell(input)===serial;
        })};
    })()`);
    check("cell dialog is a native focused formatted grid with links code images and no raw-source editor",
      rich.count === 12 && rich.strong === "alpha" && rich.code === "code" && rich.emphasis === "emphasis" &&
      rich.link === "same" && rich.image && rich.imageVisible && rich.source === 0 && rich.focus && rich.native, rich);
    check("real DOM rich-cell safety validation is repeatedly idempotent", rich.safe);
    const originalTheme = await exec("({dark:document.body.classList.contains('dark-mode'),scheme:document.body.getAttribute('data-theme')})");
    try {
      await withCellViewport("wide reference", 1188, 770, true, async () => {
        for (const theme of ["light", "dark"]) {
          await page(dark => {
            document.body.removeAttribute("data-theme");
            document.body.classList.toggle("dark-mode", dark);
          }, theme === "dark");
          await settle();
          const surface = await dialogSurface();
          check("cell dialog has an opaque themed centered contained surface in " + theme + " mode",
            surface.opaque && surface.themedText && surface.centered && surface.contained, surface);
          const layout = await cellLayout();
          check("cell reference dialog actually reaches its qualified wide width in " + theme + " mode",
            Math.abs(layout.dialog.width - 1100) <= 1, layout);
          check("cell help shares the compact button bar and leaves the grid directly below the header in " + theme + " mode",
            layout.scopeInCopy && layout.helpInCopy && layout.copy.right <= layout.actions.left - 4 &&
            layout.copy.height <= layout.actions.height + 2 &&
            layout.scopeFont === 12 && layout.helpFont === 12 &&
            layout.grid.top >= layout.header.bottom && layout.grid.top - layout.header.bottom <= 12, layout);
          await gridLinkStyles(theme);
        }
      });
      await withCellViewport("hosted narrow", 1008, 681, false, async () => {
        for (const theme of ["light", "dark"]) {
          await page(dark => {
            document.body.removeAttribute("data-theme");
            document.body.classList.toggle("dark-mode", dark);
          }, theme === "dark");
          await settle();
          const layout = await cellLayout();
          check("hosted-size cell footer keeps complete readable help beside usable actions in " + theme + " mode",
            readableCellFooter(layout, "4 rows, 3 columns. Only these cells will be updated.", true), layout);
          await screenshot("hosted-grid-" + theme);
        }
      });
    } finally {
      await page(theme => {
        document.body.classList.toggle("dark-mode", theme.dark);
        if (theme.scheme === null) document.body.removeAttribute("data-theme");
        else document.body.setAttribute("data-theme", theme.scheme);
      }, originalTheme);
      await settle();
    }
    await exec(`(() => {
      const link=tableCellGrid.querySelector('a');
      link.click();link.dispatchEvent(new MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}));
      return true;
    })()`);
    await screenshot("rich-grid");
    const unsafeBefore = await state();
    await exec(`__cells.inputs()[3].innerHTML='<a href="javascript:alert(1)">unsafe</a>';tableCellUpdate.click();true`);
    check("unsafe rich cell URLs are refused without changing the source or history",
      await exec("tableCellDialog.open&&tableCellError.textContent==='This cell contains content that cannot be edited safely here. The document has not changed.'") &&
      JSON.stringify(await state()) === JSON.stringify(unsafeBefore));
    await cancel();
    const invalid = await page((from, to) => {
      const out = [];
      for (const range of [[from + 4, from + 4], [0, 3], [0, to]]) {
        __cells.source(...range); const opened = __cells.action(false);
        out.push(opened); if (opened.opened) tableCellCancel.click();
      }
      return out;
    }, lf(prefix).length, lf(original.slice(0, secondOffset + table.length)).length);
    check("both-pane actions never fall back from a collapsed absent or multiple-table source selection",
      invalid.every((item, i) => !item.opened && item.error === (i === 2
        ? "More than one table is selected. Select just one table."
        : "Select a table or its rows first. The selection must contain exactly one table.")), invalid);
    const delimiter = lf(original.slice(0, secondOffset)).length + lf(table).indexOf("| :---");
    const separator = await page((from, to) => {
      __cells.source(from, to); return __cells.action(true);
    }, delimiter, delimiter + "| :--- | ---: | :---: |".length);
    check("textarea delimiter-only menu reports the exact missing-row error", !separator.opened &&
      separator.error === "Select at least one header or data row, not only the separator line.", separator);
    const previewInvalid = await exec(`(() => {
      const tables=viewer.querySelectorAll('table'),range=document.createRange(),selection=getSelection(),out=[];
      range.selectNodeContents(tables[0].rows[2].cells[0]);range.collapse(true);
      selection.removeAllRanges();selection.addRange(range);
      __cells.rightClick(tables[1].rows[2].cells[0]);out.push(__cells.action(false));
      range.setStartBefore(tables[0]);range.setEndAfter(tables[1]);
      selection.removeAllRanges();selection.addRange(range);
      __cells.rightClick(tables[1].rows[2].cells[0]);out.push(__cells.action(false));
      return out;
    })()`);
    check("preview caret and multi-table ranges refuse rather than falling back to the clicked duplicate",
      previewInvalid.every((item, i) => !item.opened && item.error === (i
        ? "More than one table is selected. Select just one table."
        : "Select a table or its rows first. The selection must contain exactly one table.")), previewInvalid);
    for (const [label, source] of [
      ["ragged", "| A | B |\n| - | - |\n| one |\n"],
      ["nested", "> | A | B |\n> | - | - |\n> | one | two |\n"],
      ["html", "<table><tr><td>one</td><td>two</td></tr></table>\n"],
    ]) {
      await fresh("unsupported-" + label, "# Unsupported\n\n" + source);
      const refused = await page(() => {
        __cells.source("# Unsupported\n\n".length, markdownEditor.value.length);
        return __cells.action(false);
      });
      check("actual textarea menu rejects unsupported " + label + " structure", !refused.opened &&
        refused.error === "This table cannot be edited as cells. Use a regular Markdown table with the same number of cells in every row.", refused);
    }
    const commented = await page(table => {
      const source="<!-- <table><tr><td>not actual HTML</td></tr></table> -->\n\n"+table;
      const model=FoliaTableCells.index(source,marked,protectTableSource);
      const resolved=FoliaTableCells.resolveSource(model,0,source.length,false);
      return {others:model.otherTables.length,tables:model.tables.length,rows:resolved.rows.length};
    }, lf(table));
    check("commented HTML table text does not count as another actual table",
      commented.others === 0 && commented.tables === 1 && commented.rows === 4, commented);
    await mixedPreviewSelection();
    await splitHtmlSelection();
    await nestedSourceSelection();
    await noteMetadata();
  }
  async function mixedPreviewSelection() {
    const body = "# Mixed preview\n\n" + lf(table) + "\n\n---\n\nAfter the selected rule.";
    const fixture = await fresh("mixed-preview-rule", body), before = await state();
    const selected = await exec(`(() => {
      const table=viewer.querySelector('table'),rule=viewer.querySelector('hr');
      if(!table||!rule)throw new Error('Missing actual mixed-selection table or horizontal rule');
      const range=document.createRange();range.setStartBefore(table);range.setEndAfter(rule);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      const setup=range.intersectsNode(table)&&range.intersectsNode(rule)&&
        !!range.cloneContents().querySelector('hr');
      __cells.rightClick(table.rows[1].cells[0]);
      return {setup,tableCount:viewer.querySelectorAll('table').length,action:__cells.action(false)};
    })()`);
    check("mixed preview fixture selects an actual table and nontext horizontal-rule sibling",
      selected.setup && selected.tableCount === 1 && selected.action.visible, selected);
    check("preview table plus horizontal rule refuses instead of silently dropping the nontext selection",
      !selected.action.opened &&
      selected.action.error === "Select a table or its rows first. The selection must contain exactly one table." &&
      JSON.stringify(await state()) === JSON.stringify(before) && fs.readFileSync(fixture.file, "utf8") === body, selected);
    await cancel();
  }
  async function nestedSourceSelection() {
    const leading = "# Nested context\r\n\r\n> | Nested | Context |\r\n> | - | - |\r\n> | not | selected |\r\n\r\n" +
      "Leading prose outside the nested table.\r\n\r\n";
    const trailing = "\r\n\r\nTrailing prose stays byte-exact 😀.\r\n\r\n";
    const following = "| Following | Untouched |\r\n| - | - |\r\n| final | _spelling_ |";
    const body = leading + table + trailing + following;
    const fixture = await fresh("nested-source-context", body);
    const setup = await exec(`(() => {
      const tables=[...viewer.querySelectorAll('table')];
      return {count:tables.length,nested:!!tables[0]?.closest('blockquote'),
        target:editorScroll.tableSource(tables[1]),following:tables[2]?.rows[0].cells[0].textContent.trim()};
    })()`);
    check("nested-source fixture has an actual unselected nested table target and following regular table",
      setup.count === 3 && setup.nested && setup.following === "Following" &&
      setup.target?.start === lf(leading).length, setup);
    await page((from, to) => __cells.source(from, to),
      lf(leading.slice(0, leading.indexOf("Leading prose"))).length,
      lf(leading + table + trailing).length);
    const opened = await page(() => __cells.action(false));
    check("source prose selection excludes the nested and following tables and opens its exact owner",
      opened.opened && opened.count === 12, opened);
    if (!opened.opened) return;
    await exec("__cells.inputs()[7].textContent='nested owner update';true");
    await update();
    const offset = leading.length + table.indexOf(oldCell);
    const expected = body.slice(0, offset) + "<span>nested owner update</span>" + body.slice(offset + oldCell.length);
    const after = await state();
    check("nested-context source Update preserves both other tables prose mixed bytes and owning cache",
      after.exact === expected && after.cache === expected && after.value === lf(expected) &&
      fs.readFileSync(fixture.file, "utf8") === body, after);
  }
  async function splitHtmlSelection() {
    const opening = "# Split raw HTML\n\n<table>\n\n";
    const rows = "<tr><td>raw one</td><td>raw two</td></tr>\n\n</table>\n\n";
    const body = opening + rows + lf(table) + "\n\nTrailing prose.";
    const fixture = await fresh("split-html-selection", body), before = await state();
    const setup = await exec(`(() => {
      const tables=[...viewer.querySelectorAll('table')];
      const tokens=marked.lexer(markdownEditor.value);
      return {count:tables.length,first:tables[0]?.textContent.includes('raw one'),
        second:tables[1]?.rows[0].cells[0].textContent.trim(),
        split:tokens.some(token=>token.type==='html'&&token.raw.trim()==='<table>')&&
          tokens.some(token=>token.raw.includes('<tr>')&&!token.raw.includes('<table>'))};
    })()`);
    check("split-HTML fixture proves a real raw table split across Marked tokens followed by a Markdown table",
      setup.count === 2 && setup.first && setup.second === "Name" && setup.split, setup);
    const action = await page((from, to) => {
      __cells.source(from, to);
      return __cells.action(false);
    }, opening.length, opening.length + rows.length + lf(table).length);
    check("source selection inside a split raw table through a Markdown table cannot silently admit only the latter",
      action.visible && !action.opened &&
      ["More than one table is selected. Select just one table.",
        "The table could not be matched safely to the current document. Wait for the preview, then select it again."].includes(action.error) &&
      JSON.stringify(await state()) === JSON.stringify(before) && fs.readFileSync(fixture.file, "utf8") === body, action);
    await cancel();
  }
  async function noteMetadata() {
    const note = '<span class="noted-text" data-note-id="73" data-note-title="A&#38;B/&#95;/O&#39;Reilly" ' +
      'data-note-content="body &#38; &#95; &#39;quote&#39;&#10;second" data-note-color="#c0ffee">annotated</span>';
    const body = "# Note metadata\r\n\r\nBefore note 😀\r\n\r\n| Name | Detail |\r\n| - | - |\r\n" +
      "| first | " + note + " old neighbor |\r\n| second | _untouched_ |\r\n\r\nAfter note without ending";
    const fixture = await fresh("note-metadata", body), beforeSaves = saves.length;
    await openGrid(0);
    const change = await exec(`(() => {
      const input=__cells.inputs()[3],note=input.querySelector('.noted-text'),neighbor=input.lastChild;
      const metadata=note&&Object.fromEntries(['data-note-id','data-note-title','data-note-content','data-note-color']
        .map(key=>[key,note.getAttribute(key)]));
      const setup=neighbor?.nodeType===Node.TEXT_NODE&&neighbor.data===' old neighbor';
      if(setup)neighbor.data=' new neighbor';
      return {metadata,setup};
    })()`);
    const expectedMetadata = { "data-note-id": "73", "data-note-title": "A&B/_/O'Reilly",
      "data-note-content": "body & _ 'quote'\nsecond", "data-note-color": "#c0ffee" };
    check("note-cell fixture exposes all authored metadata and a distinct neighboring text node",
      change.setup && JSON.stringify(change.metadata) === JSON.stringify(expectedMetadata), change);
    await update();
    const expected = body.replace(note + " old neighbor", "<span>" + note + " new neighbor</span>");
    const observed = await exec(`(() => {
      const note=viewer.querySelector('.noted-text');
      return note&&Object.fromEntries(['data-note-id','data-note-title','data-note-content','data-note-color']
        .map(key=>[key,note.getAttribute(key)]));
    })()`);
    const after = await state();
    check("actual cell Update retains note id title content and color after a neighboring text edit",
      !await exec("tableCellDialog.open") && JSON.stringify(observed) === JSON.stringify(expectedMetadata) &&
      after.exact === expected && after.cache === expected && after.value === lf(expected) &&
      saves.length === beforeSaves && fs.readFileSync(fixture.file, "utf8") === body, { observed, after });
    const lookup = await exec(`(() => {
      const note=viewer.querySelector('.noted-text'),wrongTitle=note.cloneNode(true),wrongClass=note.cloneNode(true);
      const exact=findNoteSpanInSource(window.CustomTabs.snapshotExactEditorContent(),note);
      const editor=findNoteSpanInSource(markdownEditor.value,note);
      wrongTitle.setAttribute('data-note-title','different title');
      wrongClass.className='note-label';
      return {exact:exact&&{index:exact.index,span:exact[0],inner:exact[1]},
        editor:editor&&{index:editor.index,span:editor[0],inner:editor[1]},
        wrongTitle:findNoteSpanInSource(markdownEditor.value,wrongTitle)===null,
        wrongClass:findNoteSpanInSource(markdownEditor.value,wrongClass)===null};
    })()`);
    check("actual note edit-delete lookup resolves the numeric-entity note with special metadata at its exact span",
      lookup.exact?.index === expected.indexOf(note) && lookup.exact.span === note && lookup.exact.inner === "annotated" &&
      lookup.editor?.index === lf(expected).indexOf(note) && lookup.editor.span === note &&
      lookup.editor.inner === "annotated" && lookup.wrongTitle && lookup.wrongClass, lookup);
    await exec("historyUndo();true");
    await wait("noted table Undo paints", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    const clean = await state();
    check("noted-table Undo establishes a clean editor before leaving without consent",
      !clean.dirty && clean.exact === body && clean.cache === body, clean);
    if (clean.dirty || clean.exact !== body) throw new Error("Do not exit an unexpectedly dirty test editor");
    await exec("exitEditBtn.click();true");
    await wait("clean noted editor exit", "!isEditMode&&!contentWrapper.classList.contains('split-view')");
    const readingHistory = await exec(`(() => {
      const before=historySnapshot().undo.length;
      const note=viewer.querySelector('.noted-text');
      if(!note)throw new Error('Missing actual reading-mode note');
      historyPush(originalMarkdown);
      return {edit:isEditMode,added:historySnapshot().undo.length===before+1,
        noteFound:!!findNoteSpanInSource(originalMarkdown,note)};
    })()`);
    check("reading-mode note history works after table Update Undo and a clean editor exit",
      !readingHistory.edit && readingHistory.added && readingHistory.noteFound &&
      fs.readFileSync(fixture.file, "utf8") === body, readingHistory);
  }
  async function provenance() {
    const fixture = await fresh("provenance");
    const receipts = await exec(`(() => {
      const tables=[...viewer.querySelectorAll('table')];
      return {same:tables[0].innerHTML===tables[1].innerHTML,
        positions:tables.map(t=>editorScroll.tableSource(t))};
    })()`);
    check("cell provenance setup has identical DOM tables with distinct exact source receipts",
      receipts.same && receipts.positions[0]?.start === lf(prefix).length &&
      receipts.positions[1]?.start === lf(original.slice(0, secondOffset)).length, receipts);
    const forged = await exec(`(() => {
      const table=viewer.querySelectorAll('table')[1], body=table.innerHTML;
      table.rows[1].cells[0].textContent='forged visual value';
      const noReceipt=editorScroll.tableSource(table)===null;
      __cells.preview(1); const opened=__cells.action(false);
      if(opened.opened)tableCellCancel.click();
      table.innerHTML=body;
      return {noReceipt,opened};
    })()`);
    check("changed preview DOM cannot borrow an old receipt or authorize a cell grid",
      forged.noReceipt && !forged.opened.opened &&
      forged.opened.error === "The table could not be matched safely to the current document. Wait for the preview, then select it again.", forged);
    await exec("renderMarkdown(markdownEditor.value)");
    await wait("restored table provenance", "!!editorScroll.tableSource(viewer.querySelectorAll('table')[1])");
    const clone = await exec(`(() => {
      const original=viewer.querySelectorAll('table')[1], clone=original.cloneNode(true);
      original.replaceWith(clone); __cells.preview(1); const result=__cells.action(false);
      if(result.opened)tableCellCancel.click(); clone.replaceWith(original); return result;
    })()`);
    check("text-identical cloned table has no edit authority from text or ordinal", !clone.opened &&
      clone.error.includes("could not be matched safely"), clone);
    const expectedNotice = "The table could not be matched safely to the current document. Wait for the preview, then select it again.";
    const notice = await exec(`({message:document.getElementById('notificationMessage').textContent,
      shown:document.getElementById('notificationToast').classList.contains('show'),
      inline:tableCellError.textContent,state:__cells.state(),open:tableCellDialog.open})`);
    const expectedRejection = !clone.opened && clone.error === expectedNotice && notice.message === expectedNotice &&
      notice.shown && !notice.open && notice.state.exact === fixture.body &&
      notice.state.owner === fixture.id && notice.state.path === fixture.file;
    check("cloned-table rejection owns the exact expected transient notification and unchanged source", expectedRejection, notice);
    if (!expectedRejection) throw new Error("Cannot wait away an unqualified notification");
    // This toast has no dismiss control. Let only the asserted negative case
    // expire normally, including its opacity transition; never hide an error.
    // Allow 6000 ms for the notice, 300 ms to fade, and one 2000 ms renderer probe.
    await wait("expected cloned-table notice expires normally", `(() => {
      const toast=document.getElementById('notificationToast');
      if(document.getElementById('notificationMessage').textContent!==${JSON.stringify(expectedNotice)})
        throw new Error('Unexpected notification replaced the cloned-table rejection');
      return !toast.classList.contains('show')&&getComputedStyle(toast).opacity==='0'&&
        toast.getAnimations().every(animation=>!animation.pending&&animation.playState==='finished');
    })()`, 8300);
  }
  async function noop() {
    const fixture = await fresh("noop");
    const before = await state(), beforeSaves = saves.length, disk = fs.readFileSync(fixture.file);
    await openGrid();
    await update();
    const after = await state();
    check("unchanged cell Update closes without mutation history dirty state or Save",
      !await exec("tableCellDialog.open") && JSON.stringify(after) === JSON.stringify(before) &&
      saves.length === beforeSaves && fs.readFileSync(fixture.file).equals(disk), { before, after });
    await openGrid();
    await exec("__cells.inputs()[3].textContent='cancelled';tableCellCancel.click();true");
    check("cell Cancel discards edits without any document transaction", JSON.stringify(await state()) === JSON.stringify(after));
    await openGrid();
    await key("Escape");
    check("native Escape cancels the cell dialog and restores preview focus",
      await exec("!tableCellDialog.open&&document.activeElement===viewer") &&
      JSON.stringify(await state()) === JSON.stringify(after));
  }
  async function transaction() {
    const fixture = await fresh("transaction");
    const before = await state(), beforeSaves = saves.length;
    const sourceStart = lf(original.slice(0, secondOffset - between.length + 2)).length;
    await page((from, to) => __cells.source(from, to), sourceStart, lf(original).length);
    const opened = await page(() => __cells.action(false));
    check("cell transaction setup resolves prose plus just the second duplicate through the textarea menu",
      opened.opened && opened.count === 12 && before.exact === original && before.value === lf(original), opened);
    await exec("__cells.inputs()[7].innerHTML='<strong>changed &amp; safe</strong><em> rich</em>';true");
    await update();
    const after = await state();
    check("cell transaction splices only changed cells and retains every non-table and unchanged-cell byte",
      after.exact === expectedEdited && after.value === lf(expectedEdited) && after.dirty &&
      after.undo === before.undo + 1 && after.redo === 0 &&
      saves.length === beforeSaves && fs.readFileSync(fixture.file, "utf8") === original, after);
    const captureState = await exec(`({state:__cells.state(),inline:tableCellError.textContent,
      open:tableCellDialog.open,toast:document.getElementById('notificationToast').classList.contains('show'),
      toastOpacity:getComputedStyle(document.getElementById('notificationToast')).opacity,
      message:document.getElementById('notificationMessage').textContent})`);
    const cleanCapture = captureState.state.exact === expectedEdited && captureState.state.owner === fixture.id &&
      captureState.state.path === fixture.file && !captureState.open && !captureState.inline &&
      !captureState.toast && captureState.toastOpacity === "0";
    check("successful table transaction capture has exact expected source and no visible toast or inline error", cleanCapture, captureState);
    if (!cleanCapture) throw new Error("Successful table transaction is not clean for capture");
    await screenshot("updated-cell");
    await exec("historyUndo();true");
    await wait("cell Undo render settled", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    const undone = await state();
    await exec("historyRedo();true");
    await wait("cell Redo render settled", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    const redone = await state();
    check("one document Undo and Redo restore the independently expected exact source bytes",
      undone.exact === original && redone.exact === expectedEdited &&
      undone.undo === before.undo && redone.undo === before.undo + 1 &&
      fs.readFileSync(fixture.file, "utf8") === original, { undone, redone });
    const owner = after.owner;
    await fresh("transaction-other", "# Other\n\nA separate tab.");
    await page(id => window.CustomTabs.switchToTab(id), owner);
    await wait("exact updated tab restored", "currentFilePath===" + JSON.stringify(fixture.file) + "&&isEditMode&&editorScroll.isCurrentSource(markdownEditor.value)");
    const restored = await state();
    check("cell transaction survives a real tab round trip without newline or history damage",
      restored.exact === expectedEdited && restored.value === lf(expectedEdited) &&
      restored.history === redone.history && fs.readFileSync(fixture.file, "utf8") === original, restored);
    // Hold the actual render promise, not the transaction, so two synchronous
    // keyboard submissions reach the real latch before paint can finish.
    await openGrid();
    const latched = await exec(`(async () => {
      const before=__cells.state(), originalRender=renderMarkdown;
      let release, calls=0;
      const barrier=new Promise(r=>release=r);
      renderMarkdown=async function(...args){calls++;await barrier;return originalRender(...args)};
      try {
        __cells.inputs()[0].textContent='Once only';
        const cell=__cells.inputs()[0];
        cell.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
        cell.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
        const during=__cells.state(), disabled=tableCellUpdate.disabled;
        release();for(let i=0;i<200&&tableCellDialog.open;i++)await new Promise(r=>setTimeout(r,10));
        return {calls,delta:during.undo-before.undo,disabled,error:tableCellError.textContent,closed:!tableCellDialog.open};
      } finally {release();renderMarkdown=originalRender;}
    })()`);
    check("cell repeated Ctrl Enter submits once while a real preview render is pending",
      latched.calls === 1 && latched.delta === 1 && latched.disabled && latched.closed && !latched.error, latched);
    const subset = await fresh("row-subset");
    await openGrid(1, true, 2, 2);
    await exec("__cells.inputs()[1].textContent='only | row';true");
    await update();
    const subsetExpected = original.slice(0, editedOffset) + "<span>only &#124; row</span>" +
      original.slice(editedOffset + oldCell.length);
    check("selected-row Update changes only the intersected row of the correct duplicate",
      (await state()).exact === subsetExpected && fs.readFileSync(subset.file, "utf8") === original);
    await typingHistoryBoundary(false);
    await typingHistoryBoundary(true);
    await repeatedLineDeletion();
    await formattingInputBoundary(false);
    await formattingInputBoundary(true);
    await formattingInputBoundary(false, true);
  }
  async function freshUpdatedTable(label, tail = "") {
    const fixture = await fresh(label, original + tail), beforeSaves = saves.length;
    await openGrid();
    await exec("__cells.inputs()[7].innerHTML='<strong>changed &amp; safe</strong><em> rich</em>';true");
    await update();
    const expected = expectedEdited + tail, after = await state();
    const correct = after.exact === expected && after.cache === expected && !await exec("tableCellDialog.open");
    check(label + " starts from its exact independently expected table transaction", correct, after);
    if (!correct) throw new Error(label + " did not establish the required table transaction");
    return { ...fixture, expected, beforeSaves };
  }
  async function repeatedLineDeletion() {
    const tail = "\r\n\r\nrepeat\r\nrepeat\nrepeat\r\nTail repeated ending 😀";
    const fixture = await freshUpdatedTable("native-repeated-delete", tail);
    const start = lf(expectedEdited + "\r\n\r\nrepeat\r\n").length, end = start + "repeat\n".length;
    const selected = await page((from, to) => {
      markdownEditor.focus();markdownEditor.setSelectionRange(from,to);
      return markdownEditor.value.slice(markdownEditor.selectionStart,markdownEditor.selectionEnd);
    }, start, end);
    check("repeated-line native deletion selects only the middle LF spelling between identical CRLF lines",
      selected === "repeat\n" && fixture.expected.endsWith(tail), { start, end, selected });
    const events = await observeSourceAction(() => key("Backspace"));
    check("repeated-line deletion reaches trusted Chromium beforeinput and input with the intended selection",
      events.some(event => event.type === "beforeinput" && event.trusted &&
        event.inputType === "deleteContentBackward" && event.start === start && event.end === end) &&
      events.some(event => event.type === "input" && event.trusted && event.inputType === "deleteContentBackward"), events);
    const expected = expectedEdited + "\r\n\r\nrepeat\r\nrepeat\r\nTail repeated ending 😀";
    const deleted = await state();
    check("native repeated-line selection deletion retains all other mixed newline bytes and exact cache",
      deleted.exact === expected && deleted.cache === expected && deleted.value === lf(expected), deleted);
    await exec("historyUndo();true");
    await wait("native repeated-line Undo paints", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    const undone = await state();
    check("native repeated-line Undo restores the selected LF line without undoing the table transaction",
      undone.exact === fixture.expected && undone.cache === fixture.expected && undone.value === lf(fixture.expected), undone);
    await exec("historyRedo();true");
    await wait("native repeated-line Redo paints", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    const redone = await state();
    check("native repeated-line Redo restores exact deletion bytes without an implicit disk write",
      redone.exact === expected && redone.cache === expected && redone.value === lf(expected) &&
      saves.length === fixture.beforeSaves && fs.readFileSync(fixture.file, "utf8") === fixture.body, redone);
  }
  async function formattingInputBoundary(priorBurst, repeated = false) {
    const label = repeated ? "Tab after formatting one repeated mixed-ending line" :
      priorBurst ? "native typing after Bold during a prior timer" : "programmatic Tab after Bold";
    const fixture = await freshUpdatedTable(repeated ? "format-repeated-mixed" :
      priorBurst ? "format-prior-typing" : "format-tab", repeated ? "\r\n\r\nrepeat\r\nrepeat\n" : "");
    const prior = priorBurst ? " prior format burst" : "";
    if (priorBurst) {
      const typed = await appendTrustedSource(prior);
      check("formatting boundary starts with a real trusted pending source burst",
        typed.events.some(event => event.trusted && event.type === "insertText") && typed.pending &&
        typed.exact === fixture.expected + prior, typed);
    }
    const needle = repeated ? "repeat" : "Before prose";
    const beforeBold = fixture.expected + prior, from = lf(beforeBold).indexOf(needle);
    const action = await page((from, to) => {
      const shown=__cells.source(from,to),visible=ctxBold.getClientRects().length>0;
      const selected=savedSelection,enabled=!ctxBold.classList.contains('disabled');
      const pendingBefore=historyDebounceTimer!==null;
      ctxBold.click();
      return {shown,visible,selected,enabled,pendingBefore,pendingAfter:historyDebounceTimer!==null};
    }, from, from + needle.length);
    const formatted = beforeBold.replace(needle, "**" + needle + "**");
    const afterBold = await state();
    check(label + " invokes the real source context Bold command and ends the prior typing timer",
      action.shown && action.visible && action.enabled && action.selected === needle &&
      action.pendingBefore === priorBurst && !action.pendingAfter &&
      afterBold.exact === formatted && afterBold.cache === formatted && afterBold.value === lf(formatted),
      { action, afterBold });
    const inserted = priorBurst ? " after bold" : "  ";
    if (priorBurst) {
      const typed = await appendTrustedSource(inserted);
      check("first native typing after formatting has its own live history boundary before 800ms",
        typed.events.some(event => event.trusted && event.type === "insertText") &&
        typed.pending && typed.exact === formatted + inserted, typed);
    } else {
      await exec("markdownEditor.focus();markdownEditor.setSelectionRange(markdownEditor.value.length,markdownEditor.value.length);true");
      const events = await observeSourceAction(() => key("Tab"));
      check("native Tab proves trusted key capture followed by programmatic input without beforeinput",
        events.some(event => event.type === "keydown" && event.key === "Tab" && event.trusted) &&
        events.some(event => event.type === "input" && !event.trusted) &&
        !events.some(event => event.type === "beforeinput"), events);
      const tabbed = await state();
      check("post-format Tab inserts exactly two spaces while retaining the formatted exact source",
        tabbed.exact === formatted + inserted && tabbed.cache === formatted + inserted &&
        tabbed.value === lf(formatted + inserted), tabbed);
    }
    check(label + " Undo runs while the actual typing debounce is pending", await exec("historyDebounceTimer!==null"));
    await exec("historyUndo();true");
    await wait(label + " Undo paints", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    const undone = await state();
    check(label + " Undo removes only the new input and keeps Bold and all exact source bytes",
      undone.exact === formatted && undone.cache === formatted && undone.value === lf(formatted), undone);
    await exec("historyRedo();true");
    await wait(label + " Redo paints", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    const redone = await state();
    check(label + " Redo restores only that input and never implicitly saves",
      redone.exact === formatted + inserted && redone.cache === formatted + inserted &&
      redone.value === lf(formatted + inserted) && saves.length === fixture.beforeSaves &&
      fs.readFileSync(fixture.file, "utf8") === fixture.body, redone);
  }
  async function typingHistoryBoundary(afterDebounce) {
    const label = afterDebounce ? "after" : "before";
    const fixture = await fresh("typing-" + label + "-debounce"), beforeSaves = saves.length;
    await openGrid();
    await exec("__cells.inputs()[7].textContent='history table';true");
    await update();
    const edited = original.slice(0, editedOffset) + "<span>history table</span>" +
      original.slice(editedOffset + oldCell.length);
    check("typing-" + label + " setup commits the independently expected table-only transaction",
      (await state()).exact === edited && !await exec("tableCellDialog.open"));
    const witness = " typed source " + label;
    const typed = await appendTrustedSource(witness);
    check("typing-" + label + " setup is trusted source input with an actual pending history debounce",
      typed.events.some(event => event.trusted && event.type === "insertText") && typed.pending &&
      typed.value === lf(edited) + witness && typed.exact === edited + witness, typed);
    if (afterDebounce) await wait("the actual 800ms history debounce fires", "historyDebounceTimer===null");
    const boundary = await exec("historyDebounceTimer!==null");
    check("typing-" + label + " Undo reaches the requested side of the 800ms history boundary",
      boundary === !afterDebounce, { pending: boundary });
    await exec("historyUndo();true");
    await wait("typed source Undo paints", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    const first = await state();
    check("first typing Undo " + label + " debounce removes only the source typing not the table Update",
      first.exact === edited && first.cache === edited && first.value === lf(edited), first);
    await exec("historyUndo();true");
    await wait("table transaction Undo paints", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    const second = await state();
    check("second typing Undo " + label + " debounce restores the exact original table bytes",
      second.exact === original && second.cache === original && second.value === lf(original), second);
    await exec("historyRedo();true");
    await wait("table transaction Redo paints", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    check("typing history keeps the table Redo separate and never implicitly saves " + label + " debounce",
      (await state()).exact === edited && saves.length === beforeSaves &&
      fs.readFileSync(fixture.file, "utf8") === original);
  }
  async function adoption() {
    const fixture = await fresh("adoption");
    const exact = "\uFEFF" + original;
    const result = await page(async exact => {
      const before=__cells.state();
      const adopted=window.CustomTabs.adoptExactEditorContent(exact);
      markdownEditor.value=exact;
      await renderMarkdown(markdownEditor.value);
      return {adopted,before,after:__cells.state()};
    }, exact);
    check("exact editor adoption retains BOM and mixed newline spelling instead of refitting repeated rows",
      result.adopted && result.after.exact === exact && result.after.cache === exact &&
      result.after.value === lf(exact) && result.after.history === result.before.history &&
      fs.readFileSync(fixture.file, "utf8") === original, result);
  }
  async function stale() {
    const other = await fresh("stale-other", "# Other\n\nOther source.");
    for (const reason of ["source-input", "undo-samebytes", "tab-back", "mode", "reload", "reload-result",
      "save-request", "save-result", "ownership", "freeze", "freeze-thaw", "caret-key"]) {
      await cancel();
      const fixture = await fresh("stale-" + reason);
      await openGrid();
      const before = await state();
      await exec("__cells.inputs()[3].textContent='MUST NOT COMMIT';true");
      let saveActor = null;
      try {
        const transition = await page(async (reason, otherId) => {
          const start={interaction:editorInteractionRevision,mode:editorModeRevision,
            open:fileOpenSequence,save:window.getPendingSaveStatus().revision};
          let restore=()=>{}, intermediateOwner=null;
          if(reason==='source-input') {
            markdownEditor.value+='\\nTyped source input witness';
            markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));
          } else if(reason==='undo-samebytes') {
            historyPush(markdownEditor.value); markdownEditor.value+='x';
            markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));
            historyUndo();
          } else if(reason==='tab-back') {
            const id=window.CustomTabs.getActiveTabId();
            await window.CustomTabs.switchToTab(otherId);
            intermediateOwner=window.CustomTabs.getActiveTabId();
            await window.CustomTabs.switchToTab(id);
          } else if(reason==='mode') {
            exitEditBtn.click(); openEditorBtn.click();
          } else if(reason==='ownership') {
            const id=window.CustomTabs.getActiveTabId(); await window.CustomTabs.switchToTab(otherId);
            restore=()=>window.CustomTabs.switchToTab(id);
          } else if(reason==='caret-key') {
            markdownEditor.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
          }
          window.__cellStaleRestore=restore;
          return {start,now:{interaction:editorInteractionRevision,mode:editorModeRevision,
            open:fileOpenSequence,save:window.getPendingSaveStatus().revision},
            intermediateOwner,source:markdownEditor.value,owner:window.CustomTabs.getActiveTabId()};
        }, reason, other.id);
        if (reason === "reload" || reason === "reload-result") {
          const witness = await documentWitness(fixture);
          const actor = observeOwnedReload(witness, reason === "reload");
          actorCleanup = () => actor.cleanup();
          const admitted = await exec("window.CustomTabs.requestReloadWithConfirmation()");
          await waitMain("qualified actual Main Reload request", () => actor.requests.length > 0);
          const request = actor.requests[0]?.args[1];
          if (reason === "reload-result") await actor.awaitResult();
          const observed = await exec(`(() => {
            const tab=window.CustomTabs.getActiveTab();
            return {state:__cells.state(),mode:isEditMode,selection:window.getActiveFileSelectionGeneration(),
              owner:tab?window.CustomTabs.getDocumentIdentityForTab(tab.id,tab.filePath,window.getReloadRequestSession()):null,
              sequence:window.getReloadRequestDiagnostics().sequence,
              latest:window.getLatestReloadRequestSequence(currentFilePath)};
          })()`);
          const valid = admitted === true && actor.requests.length === 1 && matchesReloadRequest(request, witness) &&
            observed.sequence > witness.sequence && observed.sequence === request.reloadRequestSequence &&
            observed.latest > witness.latest && observed.latest === request.reloadRequestSequence &&
            (reason === "reload-result" ? actor.requests[0].called &&
              actor.delivery.records.some(record => record.args[1]?.success === true) :
              !actor.requests[0].called && actor.delivery.records.length === 0 &&
              sameOwner(observed.owner, witness.owner) && observed.selection === witness.selection &&
              observed.mode === witness.mode && JSON.stringify(observed.state) === JSON.stringify(before)) &&
            fs.readFileSync(fixture.file, "utf8") === fixture.body;
          transition.reload = { valid, admitted, request, observed,
            originalCalls: actor.requests.filter(record => record.called).length, results: actor.delivery.records.length };
          check("cell stale " + reason + " setup uses its qualified real request and production transport", valid, transition.reload);
          if (!valid) throw new Error("Actual Reload boundary was not established");
        }
        if (reason === "freeze" || reason === "freeze-thaw") {
          await exec("window.CustomTabs.settleSessionLayout()");
          const witness = await documentWitness(fixture);
          if (!Number.isSafeInteger(witness.freeze.revision) || witness.freeze.revision < 0) {
            throw new Error("Invalid actual shutdown revision");
          }
          const request = { id: 910000 + fileSequence, gen: witness.owner.rendererGeneration,
            revision: witness.freeze.revision };
          const acknowledgements = [];
          const onCommitted = (event, data) => {
            if (ownedMainFrame(event) && data?.id === request.id) acknowledgements.push(data);
          };
          ipcMain.on("quit-approval-committed", onCommitted);
          try {
            // Only deliver the production commit message. Main has no pending
            // quit approval, so the genuine acknowledgement cannot quit.
            win.webContents.send("quit-approval-commit", request);
            await waitMain("actual owned freeze acknowledgement", () => acknowledgements.length > 0);
            transition.freeze = await exec("window.CustomTabs.__shutdownFreeze()");
            transition.acknowledgement = acknowledgements[0];
            transition.freezeRequest = request;
            transition.frozen = acknowledgements.length === 1 && transition.acknowledgement.id === request.id &&
              transition.acknowledgement.gen === request.gen && transition.acknowledgement.revision === request.revision &&
              transition.acknowledgement.committed === true && transition.freeze.frozen &&
              transition.freeze.id === request.id && transition.freeze.revision === request.revision;
            if (!transition.frozen) throw new Error("Actual freeze commit was not correlated: " + JSON.stringify(transition));
            if (reason === "freeze-thaw") {
              win.webContents.send("quit-approval-thaw");
              await wait("real shutdown thaw", "!window.CustomTabs.__shutdownFreeze().frozen");
              transition.thaw = await exec("window.CustomTabs.__shutdownFreeze()");
              transition.thawed = !transition.thaw.frozen && !transition.thaw.editorReadOnly && !transition.thaw.bodyInert;
              const intent = { before: witness.freeze.dialogDecisionIntent,
                frozen: transition.freeze.dialogDecisionIntent, thawed: transition.thaw.dialogDecisionIntent };
              check("shutdown freeze advances dialog intent without restoring it on thaw",
                transition.thawed && Number.isSafeInteger(intent.before) && intent.before >= 0 &&
                Number.isSafeInteger(intent.frozen) && intent.frozen > intent.before &&
                intent.thawed === intent.frozen, intent);
            }
          } finally { ipcMain.removeListener("quit-approval-committed", onCommitted); }
        }
        if (reason === "save-request" || reason === "save-result") {
          const witness = await documentWitness(fixture), beforeSaves = saves.length;
          const delivery = observeMainDeliveries((channel, result) => channel === "save-markdown-result" &&
            saves.slice(beforeSaves).some(request => matchesSaveRequest(request, witness) && matchesSaveResult(result, request)), true);
          const assertSaveOwner = async phase => {
            const current = await exec(`(() => {
              const tab=window.CustomTabs.getActiveTab(),session=window.getReloadRequestSession();
              return {path:tab?.filePath??null,session,owner:tab?
                window.CustomTabs.getDocumentIdentityForTab(tab.id,tab.filePath,session):null,
                state:__cells.state(),mode:isEditMode};
            })()`);
            const valid = current.path === witness.path && current.session === witness.session &&
              sameOwner(current.owner, witness.owner) && current.mode === witness.mode &&
              JSON.stringify(current.state) === JSON.stringify(witness.state);
            check("cell stale " + reason + " Save " + phase + " retains its admitted fixture owner and document",
              valid, current);
            if (!valid) throw new Error("Held Save lost its admitted fixture " + phase);
            return current.state;
          };
          saveActor = { delivery, beforeSaves, assertOwner: assertSaveOwner };
          actorCleanup = async () => {
            try {
              await assertSaveOwner("before release");
              delivery.release();
              await wait("owned held Save settlement", "!window.getPendingSaveStatus().pending");
              await assertSaveOwner("after settlement");
            } finally { delivery.restore(); }
          };
          await exec("saveMarkdownFile();true");
          await wait("real save pending", "window.getPendingSaveStatus().pending");
          await waitMain("genuine held Save result", () => delivery.records.length > 0);
          const held = delivery.records[0]?.args[1], request = saves[beforeSaves];
          const correlated = saves.length === beforeSaves + 1 && matchesSaveRequest(request, witness) &&
            matchesSaveResult(held, request) && held.success === true && held.savedContent === fixture.body &&
            delivery.records.every(record => matchesSaveResult(record.args[1], request) && !record.forwarded) &&
            fs.readFileSync(fixture.file, "utf8") === fixture.body;
          check("cell stale save setup holds a real correlated result", correlated,
            { reason, beforeSaves, request, held, attempts: delivery.records.length });
          if (!correlated) throw new Error("Actual Save correlation was not established before Update");
          if (reason === "save-result") {
            await actorCleanup();
            actorCleanup = null;
          }
          transition.now.save = await exec("window.getPendingSaveStatus().revision");
          transition.save = { request, result: held, pending: await exec("window.getPendingSaveStatus().pending") };
        }
        const setup = reason === "source-input" || reason === "undo-samebytes" || reason === "caret-key"
          ? transition.now.interaction > transition.start.interaction &&
            (reason === "source-input" ? transition.source.endsWith("Typed source input witness") :
              reason !== "undo-samebytes" || transition.source === before.value)
          : reason === "mode" ? transition.now.mode > transition.start.mode
          : reason === "reload" || reason === "reload-result" ? transition.reload.valid
          : reason.startsWith("save-") ? transition.now.save > transition.start.save &&
            transition.save.pending === (reason === "save-request")
          : reason === "freeze" || reason === "freeze-thaw"
            ? transition.frozen && transition.freeze.editorReadOnly && transition.freeze.bodyInert &&
              (reason !== "freeze-thaw" || transition.thawed)
          : reason === "ownership" ? transition.owner !== before.owner
          : transition.intermediateOwner === other.id && transition.owner === before.owner;
        check("cell stale " + reason + " setup reaches the intended lifecycle boundary", setup, transition);
        if (!setup) throw new Error("Stale " + reason + " setup was not established before Update");
        const justBefore = saveActor ? await saveActor.assertOwner("before Update") : await state();
        const diskBefore = fs.readFileSync(justBefore.path);
        await exec("tableCellUpdate.click();true");
        const after = await state(), error = await exec("tableCellError.textContent");
        check("cell stale " + reason + " refuses without source cache history or disk mutation",
          after.exact === justBefore.exact && after.cache === justBefore.cache &&
          after.history === justBefore.history && !after.exact.includes("MUST NOT COMMIT") &&
          fs.readFileSync(justBefore.path).equals(diskBefore) &&
          error === "The document changed while this editor was open. Cancel and select the table again. Nothing was updated.",
          { after, error });
        if (reason === "save-request") {
          const pending = await exec("window.getPendingSaveStatus()");
          const request = transition.save.request;
          check("stale Save remains genuinely pending through the refused Update", pending.pending &&
            saves.length === saveActor.beforeSaves + 1 && saves.at(-1) === request &&
            saveActor.delivery.records.length > 0 && saveActor.delivery.records.every(record =>
              !record.forwarded && matchesSaveResult(record.args[1], request)),
            { pending, request, heldAttempts: saveActor.delivery.records.map(record => record.args[1]) });
        }
      } finally {
        await cleanupActors();
      }
    }
  }
  async function keyboard() {
    const fixture = await fresh("keyboard");
    const beforeSaves = saves.length;
    await page(installKeyboardWitness);
    const mark = name => page(name => window.__cellKeyboardWitness.mark(name), name);
    try {
      const witness = " native source witness";
      const typed = await appendTrustedSource(witness);
      await mark("native-source-Undo-Redo");
      const nativeSource = await exec(`(() => {
        const undone=document.execCommand('undo'),valueAfterUndo=markdownEditor.value;
        const redone=document.execCommand('redo');
        return {undone,redone,valueAfterUndo,valueAfterRedo:markdownEditor.value};
      })()`);
      check("native-Undo fixture proves real trusted textarea typing and live Chromium source Undo and Redo",
        typed.events.some(event => event.trusted && event.type === "insertText") &&
        typed.exact === original + witness && nativeSource.undone && nativeSource.redone &&
        nativeSource.valueAfterUndo === lf(original) && nativeSource.valueAfterRedo === lf(original) + witness,
        { typed, nativeSource });
      await mark("awaiting-settled-baseline");
      await wait("trusted source typing has painted and established its document history",
        "editorScroll.isCurrentSource(markdownEditor.value)&&historyDebounceTimer===null");
      const baseline = await exec(`({state:__cells.state(),
        witness:window.__cellKeyboardWitness.mark('settled-baseline',true)})`);
      const observerAlive = baseline.witness.sourceInputControl && baseline.witness.dropped === 0;
      check("cell keyboard diagnostic observer sees the actual trusted textarea setup input", observerAlive, baseline.witness);
      if (!observerAlive) throw new Error("Keyboard diagnostic source event observer was not proven alive");
      const before = baseline.state;
      const sourceHistoryIsolated = sample => sample.sourceHistoryInputs === 0 && sample.dropped === 0 &&
        sample.state.session?.selectionCurrent && sample.state.actionOwnerCurrent && sample.state.previewCurrent &&
        JSON.stringify(sample.state.revision) === JSON.stringify(baseline.witness.state.revision) &&
        JSON.stringify(sample.state.sourceCaret) === JSON.stringify(baseline.witness.state.sourceCaret) &&
        sample.state.timer.history === null && sample.state.timer.preview === null;
      await mark("before-menu");
      const menu = await page(() => __cells.preview(1));
      await mark("menu");
      await mark("opening-grid");
      const opened = await page(() => __cells.action(false));
      await mark("open");
      check("cell dialog setup has a real selected table and visible menu action", menu && opened.visible && opened.opened, opened);
      await mark("untouched-cell-Undo");
      await exec("__cells.inputs()[3].focus();true");
      const untouchedCell = await exec("__cells.inputs()[3].innerHTML");
      await key("Z", ["control"]);
      const untouchedUndo = await mark("untouched-cell-Undo-result");
      check("Ctrl Z in a fresh untouched cell cannot reach Chromium textarea Undo",
        await exec("__cells.inputs()[3].innerHTML===" + JSON.stringify(untouchedCell)) &&
        sourceHistoryIsolated(untouchedUndo) && untouchedUndo.trustedCellHistoryKeys === 1 &&
        untouchedUndo.canceledSourceHistory.includes("historyUndo") &&
        JSON.stringify(await state()) === JSON.stringify(before), untouchedUndo);
      await mark("untouched-cell-Redo");
      await key("Y", ["control"]);
      const untouchedRedo = await mark("untouched-cell-Redo-result");
      check("trusted Undo and Redo in an untouched cell preserve source authority caret revisions and timers",
        sourceHistoryIsolated(untouchedRedo) && untouchedRedo.trustedCellHistoryKeys === 2 &&
        await exec("__cells.inputs()[3].innerHTML===" + JSON.stringify(untouchedCell)) &&
        JSON.stringify(await state()) === JSON.stringify(before), untouchedRedo);
      await mark("navigation-Enter");
      await key("Enter");
      await mark("navigation-Enter-result");
      check("cell Enter moves to the next actual row in the same column",
        await exec("document.activeElement===__cells.inputs()[6]"));
      await mark("navigation-Shift-Enter");
      await key("Enter", ["shift"]);
      await mark("navigation-Shift-Enter-result");
      check("cell Shift Enter returns to the preceding actual row",
        await exec("document.activeElement===__cells.inputs()[3]"));
      await mark("navigation-Tab");
      await key("Tab");
      await mark("navigation-Tab-result");
      check("native Tab advances to the next editable cell", await exec("document.activeElement===__cells.inputs()[4]"));
      await mark("cell-local-typing");
      await exec("__cells.inputs()[3].focus();true");
      await bounded("trusted rich-cell typing", win.webContents.insertText("local edit"));
      const localBefore = await exec("__cells.inputs()[3].textContent");
      await mark("cell-local-typing-result");
      await mark("cell-local-Undo");
      await key("Z", ["control"]);
      const localAfter = await exec("__cells.inputs()[3].textContent");
      const localUndo = await mark("cell-local-Undo-result");
      check("native cell Undo is live and independent of document history", localBefore.includes("local edit") &&
        localBefore !== localAfter && await exec("__cells.inputs()[3].innerHTML===" + JSON.stringify(untouchedCell)) &&
        sourceHistoryIsolated(localUndo) && localUndo.trustedCellHistoryInputs.includes("historyUndo") &&
        JSON.stringify(await state()) === JSON.stringify(before), { localBefore, localAfter, localUndo });
      await mark("cell-local-Redo");
      await key("Y", ["control"]);
      const localRedo = await mark("cell-local-Redo-result");
      check("native cell Redo restores its real edit without source history or authority changes",
        await exec("__cells.inputs()[3].textContent===" + JSON.stringify(localBefore)) &&
        sourceHistoryIsolated(localRedo) && localRedo.trustedCellHistoryInputs.includes("historyRedo") &&
        JSON.stringify(await state()) === JSON.stringify(before), localRedo);
      await mark("cell-exhausted-Undo");
      await key("Z", ["control"]);
      await key("Z", ["control"]);
      const exhaustedUndo = await mark("cell-exhausted-Undo-result");
      check("exhausted cell Undo cannot escape into source history",
        sourceHistoryIsolated(exhaustedUndo) &&
        await exec("__cells.inputs()[3].innerHTML===" + JSON.stringify(untouchedCell)) &&
        JSON.stringify(await state()) === JSON.stringify(before), exhaustedUndo);
      await mark("shortcuts-and-IME");
      const commands = await exec(`(() => {
        const reached=[], listener=e=>reached.push(e.key);
        document.addEventListener('keydown',listener);
        const input=__cells.inputs()[3];
        for(const key of ['s','f','h','z','y','ArrowLeft','ArrowRight','ArrowUp','ArrowDown']) {
          input.dispatchEvent(new KeyboardEvent('keydown',{key,ctrlKey:!key.startsWith('Arrow'),bubbles:true,cancelable:true}));
        }
        document.removeEventListener('keydown',listener);
        const event=new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true});
        input.dispatchEvent(event);
        return {reached,ime:tableCellDialog.open&&!event.defaultPrevented,focus:tableCellDialog.contains(document.activeElement)};
      })()`);
      await mark("shortcuts-and-IME-result");
      check("cell keyboard commands and IME cannot reach document Undo Save search or arrows",
        commands.reached.length === 0 && commands.ime && commands.focus &&
        JSON.stringify(await state()) === JSON.stringify(before) && saves.length === beforeSaves, commands);
      const isolated = await exec(`(() => {
        window.__cellKeyboardWitness.mark('source-focus-attempt');
        markdownEditor.focus(); const trapped=tableCellDialog.contains(document.activeElement);
        window.__cellKeyboardWitness.mark('source-focus-result');
        const input=__cells.inputs()[3], transfer=new DataTransfer();
        const before=__cells.inputs().map(cell=>cell.innerHTML);
        input.focus();
        const range=document.createRange();range.selectNodeContents(input);
        const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
        transfer.setData('text/plain','pasted\\nline');
        window.__cellKeyboardWitness.mark('before-paste');
        input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));
        window.__cellKeyboardWitness.mark('paste');
        const structure=[...input.childNodes].map(node=>node.nodeType===Node.TEXT_NODE?node.data:node.nodeName);
        const paste=JSON.stringify(structure)===JSON.stringify(['pasted','BR','line'])&&input.textContent==='pastedline';
        const drop=new Event('drop',{bubbles:true,cancelable:true});input.dispatchEvent(drop);
        return {trapped,paste,structure,serialized:serializeSafeTableCell(input),
          others:__cells.inputs().every((cell,index)=>index===3||cell.innerHTML===before[index]),
          drop:drop.defaultPrevented};
      })()`);
      check("native modal paste preserves its BR text structure safe serialization and other cell DOM",
        isolated.trapped && isolated.paste && isolated.drop && isolated.others &&
        isolated.serialized === "<span>pasted<br>line</span>" &&
        JSON.stringify(await state()) === JSON.stringify(before), isolated);
      const beforeUpdate = await mark("before-update");
      const completion = await update();
      const settlement = await mark("update-settlement");
      const offset = secondOffset + table.indexOf("**alpha**");
      const expected = original.slice(0, offset) + "<span>pasted<br>line</span>" +
        original.slice(offset + "**alpha**".length) + witness;
      const after = await state(), priorHistory = JSON.parse(before.history), afterHistory = JSON.parse(after.history);
      const previous = priorHistory.undo.at(-1), previousText = typeof previous === "string" ? previous : previous?.source;
      const expectedUndo = previousText && lf(previousText) === lf(original + witness)
        ? priorHistory.undo.slice(0, -1) : priorHistory.undo.slice();
      expectedUndo.push({ source: original + witness });
      check("clipboard Update splices only its exact cell and leaves trusted source typing other bytes and disk untouched",
        !completion.open && !completion.error && !completion.sessionPresent &&
        after.exact === expected && after.cache === expected && after.value === lf(expected) && after.dirty &&
        afterHistory.exactTypingSource === expected && afterHistory.redo.length === 0 &&
        JSON.stringify(afterHistory.undo) === JSON.stringify(expectedUndo) &&
        saves.length === beforeSaves && fs.readFileSync(fixture.file, "utf8") === original,
        { after, completion, beforeUpdate, settlement, diagnosticFile: path.join(evidence, "keyboard-witness.json") });
    } finally {
      // Persist the real refusal/session before outer cleanup closes the modal
      // or the next fixture parks its editor state.
      const diagnostic = await exec("window.__cellKeyboardWitness.finish()");
      fs.writeFileSync(path.join(evidence, "keyboard-witness.json"), JSON.stringify({
        suiteSha256: sha(__filename), fixture, diagnostic,
      }, null, 2));
    }
    await cancel();
    const canceledFixture = await fresh("keyboard-cancel");
    const canceledWitness = " source history after Cancel";
    await page(installKeyboardWitness);
    try {
      const canceledTyping = await appendTrustedSource(canceledWitness);
      const seeded = await exec(`(() => {
        const undone=document.execCommand('undo'),valueAfterUndo=markdownEditor.value;
        return {undone,valueAfterUndo};
      })()`);
      const seededRedo = canceledTyping.events.some(event => event.trusted && event.type === "insertText") &&
        canceledTyping.exact === original + canceledWitness && seeded.undone && seeded.valueAfterUndo === lf(original);
      check("untouched-cell Redo control starts with actual undone native source typing",
        seededRedo, { canceledTyping, seeded });
      if (!seededRedo) throw new Error("Native source Redo entry was not established");
      await wait("Cancel source typing has settled",
        "editorScroll.isCurrentSource(markdownEditor.value)&&historyDebounceTimer===null");
      const redoBaseline = await exec("window.__cellKeyboardWitness.mark('redo-baseline',true)");
      await openGrid();
      await exec("__cells.inputs()[3].focus();window.__cellKeyboardWitness.mark('untouched-cell-seeded-Redo');true");
      await key("Y", ["control"]);
      const redo = await exec("window.__cellKeyboardWitness.mark('untouched-cell-seeded-Redo-result')");
      check("trusted untouched-cell Redo cancels actual source history before input without consuming it",
        redo.sourceHistoryInputs === 0 && redo.canceledSourceHistory.includes("historyRedo") &&
        redo.trustedCellHistoryKeys === 1 && redo.dropped === 0 &&
        redo.state.session?.selectionCurrent && redo.state.actionOwnerCurrent && redo.state.previewCurrent &&
        JSON.stringify(redo.state.revision) === JSON.stringify(redoBaseline.state.revision) &&
        JSON.stringify(redo.state.sourceCaret) === JSON.stringify(redoBaseline.state.sourceCaret) &&
        redo.state.timer.history === null && redo.state.timer.preview === null, redo);
      await cancel();
      const sourceHistory = await exec(`(() => {
        markdownEditor.focus();
        const firstRedo=document.execCommand('redo'),valueAfterFirstRedo=markdownEditor.value;
        const undone=document.execCommand('undo'),valueAfterUndo=markdownEditor.value;
        const redone=document.execCommand('redo');
        return {firstRedo,valueAfterFirstRedo,undone,redone,valueAfterUndo,valueAfterRedo:markdownEditor.value};
      })()`);
      check("Cancel restores normal source native Undo and Redo without saving",
        sourceHistory.firstRedo && sourceHistory.valueAfterFirstRedo === lf(original) + canceledWitness &&
        sourceHistory.undone && sourceHistory.redone && sourceHistory.valueAfterUndo === lf(original) &&
        sourceHistory.valueAfterRedo === lf(original) + canceledWitness &&
        saves.length === beforeSaves &&
        fs.readFileSync(canceledFixture.file, "utf8") === original, sourceHistory);
      await wait("restored source native history has settled",
        "editorScroll.isCurrentSource(markdownEditor.value)&&historyDebounceTimer===null");
    } finally {
      const diagnostic = await exec("window.__cellKeyboardWitness.finish()");
      fs.writeFileSync(path.join(evidence, "keyboard-cancel-witness.json"), JSON.stringify({
        suiteSha256: sha(__filename), fixture: canceledFixture, diagnostic,
      }, null, 2));
    }
  }
  async function many() {
    const manySource = "# Many rows\n\n| A | B | C |\n| - | - | - |\n" +
      Array.from({ length: 80 }, (_, i) => `| row ${i} | code ${i} | value ${i} |`).join("\n");
    await fresh("many", manySource);
    await openGrid(0);
    const geometry = await exec(`(() => {
      const cells=__cells.inputs(),grid=tableCellGrid;
      const initiallyOverflowing=grid.scrollHeight>grid.clientHeight+100;
      const before=grid.scrollTop;
      cells.at(-1).focus();
      const g=grid.getBoundingClientRect(), c=cells.at(-1).getBoundingClientRect();
      const footer=tableCellUpdate.getBoundingClientRect();
      return {count:cells.length,initiallyOverflowing,before,scroll:grid.scrollTop,
        lastVisible:c.top>=g.top&&c.bottom<=g.bottom+1,
        updateVisible:footer.top>=0&&footer.bottom<=innerHeight};
    })()`);
    check("many-row cell grid scrolls the focused final cell while keeping Update usable",
      geometry.count === 243 && geometry.initiallyOverflowing && geometry.before === 0 && geometry.scroll > geometry.before &&
      geometry.lastVisible && geometry.updateVisible, geometry);
    const originalLayout = await cellLayout(), sourceBefore = await state();
    check("hosted-size many-row footer keeps complete readable help and usable actions",
      readableCellFooter(originalLayout, "81 rows, 3 columns. Only these cells will be updated.", true), originalLayout);
    const narrow = await resizeCellDialog(-480, -220);
    const contained = layout => layout.header.top >= layout.dialog.top &&
      layout.footer.bottom <= layout.dialog.bottom + 1 && layout.grid.height >= 80 &&
      layout.dialog.left >= 0 && layout.dialog.right <= layout.viewport.width &&
      layout.dialog.top >= 0 && layout.dialog.bottom <= layout.viewport.height &&
      layout.buttons.every(button => button.left >= layout.dialog.left &&
        button.right <= layout.dialog.right && button.top >= layout.dialog.top && button.bottom <= layout.dialog.bottom);
    check("native corner dragging shrinks both popup dimensions while retaining its header grid and actions",
      narrow.resize === "both" && originalLayout.dialog.width - narrow.dialog.width >= 100 &&
      originalLayout.dialog.height - narrow.dialog.height >= 80 && contained(narrow), { originalLayout, narrow });
    check("resized narrow footer retains complete readable help and usable actions",
      readableCellFooter(narrow, "81 rows, 3 columns. Only these cells will be updated.", false), narrow);
    await screenshot("resized-grid-narrow");
    const grown = await resizeCellDialog(180, 140);
    check("native corner dragging grows the grid rather than wasting popup space",
      grown.dialog.width - narrow.dialog.width >= 60 && grown.dialog.height - narrow.dialog.height >= 40 &&
      grown.grid.height - narrow.grid.height >= 40 && contained(grown), { narrow, grown });
    check("popup resizing preserves source history and captured table authority",
      JSON.stringify(await state()) === JSON.stringify(sourceBefore) &&
      await exec("tableCellSession.selection.isCurrent()"), await state());
    const finalCell = await exec(`(() => {
      const cells=__cells.inputs();cells[0].focus();cells.at(-1).focus();
      const grid=tableCellGrid.getBoundingClientRect(),cell=cells.at(-1).getBoundingClientRect();
      return cell.top>=grid.top&&cell.bottom<=grid.bottom+1;
    })()`);
    check("resized grid still scrolls the final editable row into view", finalCell);
    await screenshot("many-rows-bottom");
    await cancel();
  }
  async function performanceUnit() {
    const { generate } = require("../bench/corpus");
    // These are the existing editor-scroll budgets, fixed before collection.
    // No invented CPU or dialog-latency SLO is used to declare acceptance.
    const sampleArg = process.argv.find(arg => arg.startsWith("--sample="));
    const sample = sampleArg ? Number(sampleArg.slice("--sample=".length)) : null;
    if (sampleArg && (!Number.isInteger(sample) || sample < 0 || sample > 2)) {
      throw new Error("--sample must be 0, 1 or 2; use all three alternating pairs for comparison");
    }
    if (baseline && (!appArg || appRoot === ROOT)) throw new Error("--baseline requires --app-root pointing to the released checkout");
    const receipt = { baseline, sample, budgets: { callbackP95Ms: 4,
      openAndSplit: { relative: .2, absoluteMs: 50 } }, previewDelayMs: 400,
    runtime: { node: process.version, electron: process.versions.electron,
      cpu: require("os").cpus()[0]?.model, platform: process.platform },
    appRoot, sources: Object.fromEntries(productFiles.map(file => [file,
      fs.existsSync(path.join(appRoot, file)) ? sha(path.join(appRoot, file)) : null])),
    suiteSha256: sha(__filename), samples: [] };
    const label = (baseline ? "baseline" : "candidate") + (sample === null ? "" : "-" + sample);
    fs.writeFileSync(path.join(evidence, label + "-contract.json"),
      JSON.stringify(receipt, null, 2));
    for (const profile of ["tables", "wide"]) {
      const body = "# Cells " + profile + "\n\n" + generate(profile, 50 * 1024);
      if (body !== lf(body)) throw new Error("Performance fixtures require independently authored LF source");
      for (const rep of sample === null ? [0, 1, 2] : [sample]) {
        const start = performance.now();
        const fixture = await fresh("perf-" + profile + "-" + rep, body);
        const openAndSplitMs = performance.now() - start;
        const expected = body + "\n\nFixed performance witness 😀.";
        const begin = performance.now();
        await page(expected => {
          markdownEditor.value=expected;
          markdownEditor.dispatchEvent(new Event("input",{bubbles:true}));
          return true;
        }, expected);
        await wait("finite performance edit paint", `viewer.textContent.includes('Fixed performance witness 😀.')&&
          editorScroll.diagnostics().matchesSource&&!editorScroll.diagnostics().pendingSource`);
        const inputToPaintMs = performance.now() - begin;
        const observed = await exec(`({value:markdownEditor.value,cache:window.CustomTabs.getActiveTab().content,
          callbacks:editorScroll.diagnostics().callbacks})`);
        const preserved = observed.value === expected && observed.cache === expected &&
          fs.readFileSync(fixture.file, "utf8") === body;
        check("finite " + profile + " sample " + rep + " preserves its independently authored complete source", preserved);
        if (!preserved) throw new Error("Performance edit did not preserve its authored source cache and disk");
        const owner = await commonState(), previous = performanceSources.get(fixture.id);
        if (!previous || !owner.dirty || owner.owner !== fixture.id || owner.path !== fixture.file ||
            !sameOwner(owner.identity, previous.identity)) {
          throw new Error("Performance edit changed its owning document or did not leave it dirty");
        }
        performanceSources.set(fixture.id, { ...previous, source: expected });
        receipt.samples.push({ profile, rep, openAndSplitMs, inputToPaintMs, callbacks: observed.callbacks });
      }
    }
    receipt.screenshots = screenshots;
    receipt.acceptance = "UNASSESSED: compare alternating baseline/candidate receipts in one exclusive host slot; no candidate-vs-itself acceptance";
    fs.writeFileSync(path.join(evidence, label + "-performance.json"),
      JSON.stringify(receipt, null, 2));
  }
  const saveListener = (event, request) => {
    if (ownedMainFrame(event)) saves.push(request);
  };
  app.whenReady().then(async () => {
    try {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
        (details, callback) => { network.push(details.url); callback({ cancel: true }); });
      ipcMain.prependListener("save-markdown-file", saveListener);
      await bounded("actual Main bootstrap", awaitMainReady(), 10000);
      receipt("ready", { watchdogMs: 180000, appRoot });
      admissionFixture = await fresh("fixture-admission", "# Fixture admission\n\nThis unchanged tab admits owned fixtures.");
      if (dirtyOpenProbe) await bounded("dirty Open negative probe", proveDirtyOpenRefusal(), 10000);
      await proveOwnedSaveObserver();
      await proveOwnedShellGuards();
      try { await session.defaultSession.fetch("https://example.invalid/cell-network-control"); }
      catch { /* The session interceptor must refuse before any network I/O. */ }
      check("cell network trap is alive before actions", network.length === 1 &&
        network[0] === "https://example.invalid/cell-network-control", network);
      network.length = 0;
      sentinel = startErrorSentinel(win, { trapExternal: false });
      if (!perfOnly) {
        const boot = await exec(`typeof window.FoliaTableCells?.index==='function'&&
          typeof window.CustomTabs?.snapshotExactEditorContent==='function'&&
          typeof window.CustomTabs?.adoptExactEditorContent==='function'&&
          typeof editorScroll?.tableSource==='function'&&!!document.getElementById('tableCellDialog')`);
        check("cell renderer bootstraps the actual helper provenance dialog and exact-source APIs", boot);
        if (!boot) throw new Error("Cell editor production bootstrap is incomplete");
      }
      const alive = await proveSentinelAlive(win, sentinel);
      check("cell error sentinel detects both deliberately provoked channels", alive.console && alive.dom, alive);
      if (!alive.console || !alive.dom) throw new Error("Both actual cell sentinel channels must be proven before scenarios");
      if (perfOnly) await performanceUnit();
      else {
        await pureInRenderer();
        for (const [name, run] of Object.entries({ menus, provenance, noop, transaction, adoption, stale, keyboard, many })) {
          if (!selected(name)) continue;
          try {
            if (name === "many") await withCellViewport("hosted many-row", 1008, 681, false, run);
            else await run();
          }
          catch (error) { check("cell " + name + " scenario completed", false, error.stack); throw error; }
          finally {
            try { await cleanupActors(); }
            catch (error) { teardownFailure("cell scenario actors restore their actual ownership", error); throw error; }
            try { await bounded("cell scenario dialog cleanup", cancel()); }
            catch (error) { teardownFailure("cell scenario dialog closes after failure", error); throw error; }
          }
          check("cell owned Main shell guards remain installed after " + name, shellGuardsInstalled());
          if (!shellGuardsInstalled()) throw new Error("Main shell guard replacement prevents further scenarios");
        }
        check("all selected cell UI scenarios ran", proof ? executed.has(proof) :
          ["menus", "provenance", "noop", "transaction", "adoption", "stale", "keyboard", "many"].every(name => executed.has(name)));
      }
    } catch (error) {
      if (results.some(result => !result.ok)) {
        console.error("SECONDARY suite termination -> " + error.stack);
      } else check("cell Electron suite completed", false, error.stack);
    } finally {
      let code = 1;
      try {
        try { await cleanupActors(); }
        catch (error) { teardownFailure("cell actors clean up after failure", error); }
        try { await bounded("final cell dialog cleanup", cancel()); }
        catch (error) { teardownFailure("cell dialog cleanup completes", error); }
        actorCleanup = shellControl = null;
        ipcMain.removeListener("save-markdown-file", saveListener);
        if (sentinel) {
          try {
            const errors = await bounded("final cell sentinel", sentinel.stop(), 12000);
            check("cell scenarios introduce no renderer or visible document errors",
              errors.hits.length === 0 && errors.stalls.length === 0, errors);
          } catch (error) { teardownFailure("cell final sentinel completed", error); }
        }
        if (win && !win.isDestroyed()) {
          check("cell editor never opens external content applications or network requests",
            shellGuardsInstalled() && !shellCalls.length && !network.length,
            { guardsInstalled: shellGuardsInstalled(), shellCalls, network });
        }
        check("cell product source remains unchanged throughout the run", JSON.stringify(hashes()) === JSON.stringify(product));
        check("cell scenarios require no unexpected native JavaScript or HTML dialog", unexpectedDialogs.length === 0, unexpectedDialogs);
        code = summary();
      } catch (error) {
        try { teardownFailure("cell final diagnostics completed", error); }
        catch { /* finish remains unconditional when both diagnostics channels fail. */ }
      } finally {
        finish(code, "completed");
      }
    }
  });
}
