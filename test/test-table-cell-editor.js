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
  "noop", "input", "click", "transaction", "adoption", "stale", "keyboard", "formatting", "many"];
const uiGroups = groups.slice(4);
const uiPartitions = { input: ["input"], remaining: uiGroups.filter(name => name !== "input") };
const partitionArgs = process.argv.filter(arg => arg === "--partition" || arg.startsWith("--partition="));
const partition = partitionArgs[0]?.slice("--partition=".length);
if (partitionArgs.length > 1 || partition !== undefined &&
    (!Object.hasOwn(uiPartitions, partition) || sourceOnly || perfOnly || baseline || dirtyOpenProbe || proof)) {
  throw new Error("Use one UI partition without source, performance, probe or proof modes");
}
const expectedUiGroups = partition ? uiPartitions[partition] : proof ? uiGroups.filter(name => name === proof) : uiGroups;
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
  if (partition && uiGroups.includes(name) && !expectedUiGroups.includes(name)) return false;
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
const richCell = "<strong>changed &#38; safe</strong><em> rich</em>";
const editedOffset = secondOffset + table.indexOf(oldCell);
const expectedEdited = original.slice(0, editedOffset) + richCell +
  original.slice(editedOffset + oldCell.length);
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12">' +
  '<rect width="12" height="12" fill="green"/></svg>';
const productFiles = [...new Set(["src/inline-formatting.js", "src/table-cell-editor.js",
  ...require("../package.json").build.files.filter(file => /^src[\\/].+\.(?:js|css|html)$/.test(file))])];
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const hashes = () => Object.fromEntries(productFiles.map(file => [file, sha(path.join(ROOT, file))]));

// This route uses the shipping helper and shipping parser, not an imitation
// lexer. It remains usable without Electron; absent vendoring fails explicitly.
async function sourceTests() {
  dialogGuardSourceTests();
  dialogCleanupSourceTests();
  const partitioned = Object.values(uiPartitions).flat();
  check("cell UI partitions cover every declared scenario exactly once",
    partitioned.length === uiGroups.length && new Set(partitioned).size === uiGroups.length &&
    uiGroups.every(name => partitioned.includes(name)));
  const context = vm.createContext({ window: {}, Node: { TEXT_NODE: 3, COMMENT_NODE: 8, ELEMENT_NODE: 1 } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "inline-formatting.js"), "utf8"), context);
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
      cells.serializeCell(input) === '<strong>safe &#124; &#42;x&#42; &#91;y&#93; &#96;z&#96; &#38; &#60; &#62;&#13;&#10;😀</strong>' +
      '<a href="https://example.invalid/a?q=1&#38;n=2">link</a><img src="cell.svg" alt="dot">');
    check("edited literal block starts stay inline instead of becoming Markdown block syntax",
      [["# heading", "&#35; heading"], ["- item", "&#45; item"], ["> quote", "&#62; quote"],
        ["1. list", "&#49;. list"], ["    indented", "&#32;&#32;&#32;&#32;indented"],
        ["---", "&#45;--"], ["!!!", "&#33;!!"]].every(([value, expected]) =>
        cells.serializeCell(element("div", [text(value)])) === expected));
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
      '<span class="noted-text" data-note-id="73" data-note-title="Title &#38; value" ' +
      'data-note-content="first&#10;second" data-note-color="#c0ffee">annotated</span> new neighbor');
  }
  if (proof === "inline") return;
  const { parseEmojis } = require("../src/emoji-parser");
  const observedEmojis = [], emojiSource = "😀 :star: :unknown-folia-emoji:";
  const observedOutput = parseEmojis(emojiSource, (alias, glyph, offset) => observedEmojis.push({ alias, glyph, offset }));
  check("emoji observation preserves existing rendering and reports original UTF16 replacement offsets only",
    observedOutput === parseEmojis(emojiSource) && observedOutput === "😀 ⭐ :unknown-folia-emoji:" &&
    JSON.stringify(observedEmojis) === JSON.stringify([{ alias: ":star:", glyph: "⭐", offset: 3 }]), observedEmojis);
  const vendor = path.join(ROOT, "libs", "vendor", "marked.min.js");
  if (!fs.existsSync(vendor)) {
    throw new Error("Missing shipping parser: libs\\vendor\\marked.min.js; restore dependencies and run npm run vendor in an authorized resource slot.");
  }
  const parserContext = vm.createContext({ exports: {}, module: { exports: {} } });
  parserContext.exports = parserContext.module.exports;
  vm.runInContext(fs.readFileSync(vendor, "utf8"), parserContext);
  const marked = parserContext.module.exports.marked || parserContext.module.exports;
  const shared = context.window.FoliaInlineFormatting;
  const caretSource = shared.attachInlineEditor.toString();
  const nativeInputHandlers = caretSource.slice(caretSource.indexOf("listen(element, 'beforeinput'"),
    caretSource.indexOf("listen(element, 'compositionstart'"));
  check("shared caret metadata retains weak native-operation edges instead of full markup history keys",
    caretSource.includes("historyCarets = new WeakMap()") &&
      caretSource.includes("beforeNode: new WeakRef(beforeNode), beforeCaret,") &&
      (caretSource.match(/historyCarets\.set\(/g) || []).length === 1 &&
      caretSource.includes("historyCarets.set(afterNode, immutable({") &&
      !/historyCarets\.(?:set|get)\((?:element\.innerHTML|before[,)]|after[,)])/.test(caretSource));
  check("native input and history handlers do not serialize markup for caret lookup or overwrite ordinary native selection",
    nativeInputHandlers.length > 0 && !nativeInputHandlers.includes(".innerHTML") &&
      !nativeInputHandlers.includes("historyCarets.set(") &&
      nativeInputHandlers.includes("operation.beforeNode.deref() === identity") &&
      nativeInputHandlers.includes("operation.beforeNode.deref() === previous?.node"));
  const definitionCount = 768;
  const definitionLines = Array.from({ length: definitionCount }, (_, at) =>
    `[ref-${at}]: https://example.invalid/${at} "😀 **hidden-${at}** \`hidden\`"\n`);
  const referencePrefix = "😀 reference controls\n\n";
  const referenceBody = "\n😀 **eligible** and *body* with `code`.\n";
  const referenceSource = referencePrefix + definitionLines.join("") + referenceBody;
  const observedLexInputs = [];
  class ObservedLexer extends marked.Lexer {
    lex(source) { observedLexInputs.push(source); return super.lex(source); }
  }
  vm.runInContext(`globalThis.__definitionPredicates = 0;
    globalThis.__originalSome = Array.prototype.some;
    Array.prototype.some = function (predicate, receiver) {
      const definitions = this.length && Number.isInteger(this[0]?.start) &&
        Number.isInteger(this[0]?.end) && Object.keys(this[0]).length === 2;
      return __originalSome.call(this, definitions ? function (...args) {
        __definitionPredicates++; return predicate.apply(receiver, args);
      } : predicate, receiver);
    };
    [{start:0,end:1}].some(() => true);`, context);
  check("definition-scan observer proves its predicate counter is live",
    vm.runInContext("__definitionPredicates", context) === 1);
  vm.runInContext("__definitionPredicates = 0", context);
  let referenceFrames, definitionPredicates;
  const referenceStart = performance.now();
  try {
    referenceFrames = shared.documentFrames(referenceSource, { ...marked, Lexer: ObservedLexer });
    definitionPredicates = vm.runInContext("__definitionPredicates", context);
  } finally {
    vm.runInContext(`Array.prototype.some = __originalSome;
      delete globalThis.__originalSome; delete globalThis.__definitionPredicates;`, context);
  }
  const referenceMs = performance.now() - referenceStart;
  console.log("REFERENCE_MASK " + JSON.stringify({
    sourceUnits: referenceSource.length, definitionCount, definitionPredicates, elapsedMsInformationalOnly: referenceMs,
  }));
  const expectedMasked = referencePrefix +
    definitionLines.join("").replace(/[^\n]/g, " ") + referenceBody;
  check("reference masking preserves every UTF16 unit and newline while definitions never gain formatting authority",
    observedLexInputs.length === 2 && observedLexInputs[1] === expectedMasked &&
      expectedMasked.length === referenceSource.length &&
      JSON.stringify(referenceFrames.map(frame => referenceSource.slice(frame.start, frame.end))) ===
        JSON.stringify(["**eligible**", "*body*", "`code`"]));
  check("definition masking does not rescan all references for each UTF16 source unit",
    definitionPredicates <= referenceSource.length + definitionCount,
    { sourceUnits: referenceSource.length, definitionCount, definitionPredicates, elapsedMsInformationalOnly: referenceMs });
  check("table source ownership operations delegate to the single shared inline core",
    ["prepareCell", "serializeCell", "codeSources", "codeDelimiters", "typingSlice"].every(key => cells[key] === shared[key]) &&
      typeof shared.attachInlineEditor === "function" && typeof shared.attachDialogContainment === "function" &&
      typeof shared.rawMarkdownPolicy === "function");
  check("shared full-document recognition sees supported inline frames but not fenced or HTML-owned stars",
    JSON.stringify(shared.documentFrames("one **bold** *em* `code`\n\n```\n**fenced**\n```\n\n<span>**html**</span>", marked)
      .map(frame => frame.type)) === JSON.stringify(["strong", "em", "codespan"]));
  check("shared full-document recognition preserves UTF16 frame coordinates",
    shared.documentFrames("😀 **bold**", marked).some(frame =>
      frame.type === "strong" && frame.start === 3 && frame.end === 11 && frame.bodyStart === 5 && frame.bodyEnd === 9));
  check("shared raw policy recognizes supported frames inside raw block syntax but never inside external CODE fences or HTML",
    ["- **bold**", "- [ ] **bold**", "> **bold**", "# **bold**", "- one\n  - **bold**"]
      .every(source => shared.documentFrames(source, marked).some(frame =>
        frame.type === "strong" && source.slice(frame.start, frame.end) === "**bold**")) &&
    [["`slot`", 1, 5], ["```\nslot\n```", 4, 8], ["<span>slot</span>", 6, 10]]
      .every(([source, start, end]) =>
        shared.rawMarkdownPolicy({ source, start, end, marked }).frames("**bold**").length === 0));
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
    const clickedBody = "\uFEFF| A | B |\r\n| - | - |\n| 😀 | last |   \r\n\r\nAfter.";
    const clickedModel = cells.index(clickedBody, marked, protect);
    const physicalLine = (text, start) => {
      const newline = text.indexOf("\n", start);
      return { start, end: newline < 0 ? text.length : newline };
    };
    for (const [label, start] of [["BOM header", 0], ["trailing-space row", clickedModel.view.text.indexOf("| 😀")]]) {
      const target = cells.resolveSourceLine(clickedModel, physicalLine(clickedModel.view.text, start));
      check("click resolver accepts a real physical " + label + " without changing source offsets",
        target.table === clickedModel.tables[0] && target.rows.length === 2);
    }
    for (const [label, line] of [
      ["blank line", physicalLine(clickedModel.view.text, clickedModel.view.text.indexOf("\n\n") + 1)],
      ["following prose", physicalLine(clickedModel.view.text, clickedModel.view.text.indexOf("After."))],
      ["partial line", { start: 2, end: clickedModel.view.text.indexOf("\n") }],
      ["multiple lines", { start: 0, end: clickedModel.view.text.lastIndexOf("\n") }],
    ]) {
      let error;
      try { cells.resolveSourceLine(clickedModel, line); }
      catch (caught) { error = caught.message; }
      check("click resolver refuses " + label + " instead of borrowing a table", error === "tableCells.click", error);
    }
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
  const evidenceBase = path.resolve(ROOT, process.env.FOLIA_CELL_EVIDENCE || path.join("screenshots", "table-cell-editor"));
  const evidence = partition ? path.join(evidenceBase, partition) : evidenceBase;
  if (evidence !== ROOT && !evidence.startsWith(ROOT + path.sep)) {
    throw new Error("FOLIA_CELL_EVIDENCE must stay inside this worktree; preserve it as a session artifact after the run");
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const product = hashes();
  const shellCalls = [], network = [], saves = [], screenshots = [], unexpectedDialogs = [], teardownErrors = [];
  let chooser, win, sentinel, fileSequence = 0, actorCleanup = null, finishing = false, shellControl = null;
  let admissionFixture = null, observedCellDialog = null, maximumLiveTabs = 0;
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
      stage, detail, proof: proof || null, partition: partition || null, perfOnly, dirtyOpenProbe,
      uiGroups: { declared: uiGroups, expected: expectedUiGroups, executed: uiGroups.filter(name => executed.has(name)) },
      fixtureCount: fileSequence, maximumLiveTabs, tabCountSampling: "after fixture admission",
      fixtureChooser: chooser || null,
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

  async function typeTrustedCell(parts, cellIndex,
    { replace = false, preserveCaret = false, eraseSelection = false, formatKey = null,
      formatModifiers = ["control"] } = {}) {
    await exec(`(() => {
      const input=tableCellSession.cells[${JSON.stringify(cellIndex)}].input;
      input.focus();
      if(!${JSON.stringify(preserveCaret)}) {
        const range=document.createRange();range.selectNodeContents(input);
        if(!${JSON.stringify(replace)})range.collapse(false);
        const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      }
      window.__cellTypedInputEvents=[];
      window.__cellTypedInput=e=>{
        const record={event:e.type,trusted:e.isTrusted,type:e.inputType,data:e.data,composing:e.isComposing,
          key:e.key,control:e.ctrlKey,meta:e.metaKey,alt:e.altKey,get prevented(){return e.defaultPrevented}};
        window.__cellTypedInputEvents.push(record);
      };
      input.addEventListener('keydown',window.__cellTypedInput);
      input.addEventListener('beforeinput',window.__cellTypedInput);
      input.addEventListener('input',window.__cellTypedInput);
      return true;
    })()`);
    const snapshots = [];
    try {
      for (const part of parts) {
        if (formatKey) await key(formatKey, formatModifiers);
        else if (eraseSelection) await key("Backspace");
        else await bounded("trusted cell typing", win.webContents.insertText(part));
        snapshots.push(await exec(`(() => {
          const input=tableCellSession.cells[${JSON.stringify(cellIndex)}].input;
          const selection=getSelection(),node=selection.anchorNode;
          return {html:input.innerHTML,text:input.textContent,
            error:tableCellError.textContent,
            codes:[...input.querySelectorAll('code')].map(code=>code.textContent),
            focused:document.activeElement===input,collapsed:selection.isCollapsed,caretInCell:input.contains(node),
            caretInCode:!!(node&&(node.nodeType===Node.ELEMENT_NODE?node:node.parentElement)?.closest('code')),
            events:window.__cellTypedInputEvents.slice()};
        })()`));
      }
      return snapshots;
    } finally {
      await bounded("trusted cell typing listener cleanup", exec(`(() => {
        const input=tableCellSession?.cells[${JSON.stringify(cellIndex)}]?.input;
        input?.removeEventListener('keydown',window.__cellTypedInput);
        input?.removeEventListener('beforeinput',window.__cellTypedInput);
        input?.removeEventListener('input',window.__cellTypedInput);
        delete window.__cellTypedInput;delete window.__cellTypedInputEvents;return true;
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
      rightClick(node, point) {
        const rect = node.getBoundingClientRect();
        node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
          clientX: point?.x ?? Math.round(rect.left + Math.min(8, rect.width / 2)),
          clientY: point?.y ?? Math.round(rect.top + Math.min(8, rect.height / 2)) }));
        return contextMenu.classList.contains("visible");
      },
      sourcePoint(offset, visualLine = 0) {
        const style=getComputedStyle(markdownEditor),rect=markdownEditor.getBoundingClientRect();
        const line=offset?markdownEditor.value.lastIndexOf('\n',offset-1)+1:0;
        const clone=markdownEditor.cloneNode(false);
        clone.removeAttribute('id');clone.setAttribute('aria-hidden','true');clone.inert=true;
        for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing',
          'paddingTop','paddingBottom','paddingLeft','paddingRight','whiteSpace','overflowWrap','wordBreak','tabSize']) {
          clone.style[key]=style[key];
        }
        Object.assign(clone.style,{position:'fixed',left:'-100000px',top:'0',height:'0',minHeight:'0',
          maxHeight:'none',width:markdownEditor.clientWidth+'px',boxSizing:'border-box',border:'0',
          visibility:'hidden',pointerEvents:'none',overflow:'hidden'});
        clone.value=markdownEditor.value.slice(0,line);
        document.body.append(clone);
        let top;
        try {top=clone.scrollHeight-parseFloat(style.paddingBottom)-parseFloat(style.lineHeight);}
        finally {clone.remove();}
        const height=parseFloat(style.lineHeight),scaleX=rect.width/markdownEditor.offsetWidth;
        top+=visualLine*height;
        const scaleY=rect.height/markdownEditor.offsetHeight;
        if(top-markdownEditor.scrollTop<parseFloat(style.paddingTop)||
            top+height-markdownEditor.scrollTop>markdownEditor.clientHeight-parseFloat(style.paddingBottom)) {
          markdownEditor.scrollTop=Math.max(0,top-markdownEditor.clientHeight/2);
        }
        markdownEditor.scrollLeft=0;
        return {x:Math.round(rect.left+(markdownEditor.clientLeft+parseFloat(style.paddingLeft)+4)*scaleX),
          y:Math.round(rect.top+(markdownEditor.clientTop+top-markdownEditor.scrollTop+height/2)*scaleY)};
      },
      source(from, to, clickAt = from) {
        getSelection().removeAllRanges();
        markdownEditor.focus();
        markdownEditor.setSelectionRange(from, to, "backward");
        return this.rightClick(markdownEditor,this.sourcePoint(clickAt));
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
  async function fresh(label, body = original, heading = lf(body).replace(/^\uFEFF?# /, "").split("\n")[0]) {
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
        viewer.querySelector('h1')?.textContent===${JSON.stringify(heading)}&&
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
    const admitted = await exec("({id:window.CustomTabs.getActiveTabId(),liveTabs:window.CustomTabs.getTabs().length})");
    maximumLiveTabs = Math.max(maximumLiveTabs, admitted.liveTabs);
    const fixture = { file, id: admitted.id, body };
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
    if (!menu || !opened.visible || !opened.opened) throw new Error("Cell grid setup failed: " + JSON.stringify(opened));
    return opened;
  }
  async function cancel() {
    if (!win || win.isDestroyed()) return;
    await page(closeObservedCellDialog, observedCellDialog, baseline && perfOnly && observedCellDialog === false);
  }
  async function pasteCode(text) {
    return page(text => {
      const input=__cells.inputs()[8],events=[];
      const listener=event=>events.push({type:event.inputType,trusted:event.isTrusted});
      input.addEventListener('input',listener);
      const transfer=new DataTransfer();transfer.setData('text/plain',text);
      const paste=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer});
      input.dispatchEvent(paste);
      input.removeEventListener('input',listener);
      return {html:input.innerHTML,text:input.textContent,codeBreaks:input.querySelectorAll('code br').length,
        prevented:paste.defaultPrevented,events};
    }, text);
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
    const viewportMatches = (targetWidth, targetHeight, widthRounding = 0) =>
      `Math.abs(innerWidth-${targetWidth})<=${widthRounding}&&Math.abs(innerHeight-${targetHeight})<=${heightRounding}`;
    // Restoring native bounds can round one CSS pixel at fractional desktop scale.
    // The measured scenario above still requires its exact requested width.
    const restoreWidthRounding = !emulated && !Number.isInteger(before.viewport.dpr) ? 1 : 0;
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
        viewportMatches(before.viewport.width, before.viewport.height, restoreWidthRounding));
      await settle();
      const restored = await observe("restored");
      check("cell " + label + " restores the native Main viewport and debugger",
        restored.viewport.dpr === before.viewport.dpr && restored.zoom === before.zoom &&
        restored.maximized === before.maximized && debuggerAPI.isAttached() &&
        Math.abs(restored.viewport.width - before.viewport.width) <= restoreWidthRounding &&
        Math.abs(restored.viewport.height - before.viewport.height) <= heightRounding,
        { before, restored, heightRounding, restoreWidthRounding, observations });
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
          const lexer=new marked.Lexer({...marked.defaults,tokenizer:null});
          lexer.tokens.links=tableCellSession.target.model.links;
          copy.innerHTML=sanitizeTableHtml(marked.Parser.parseInline(lexer.inlineTokens(serial.replaceAll(String.fromCharCode(92)+'|','|'))));
          return serializeSafeTableCell(input)===serial&&copy.textContent===input.textContent&&
            copy.querySelectorAll('code').length===input.querySelectorAll('code').length&&
            !serial.includes('data-folia-cell-');
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
        __cells.source(...range); const opened = __cells.action(true);
        out.push(opened); if (opened.opened) tableCellCancel.click();
      }
      return out;
    }, lf(prefix).length, lf(original.slice(0, secondOffset + table.length)).length);
    check("selected-row actions never fall back from a collapsed absent or multiple-table source selection",
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
      __cells.rightClick(tables[1].rows[2].cells[0]);out.push(__cells.action(true));
      range.setStartBefore(tables[0]);range.setEndAfter(tables[1]);
      selection.removeAllRanges();selection.addRange(range);
      __cells.rightClick(tables[1].rows[2].cells[0]);out.push(__cells.action(true));
      return out;
    })()`);
    check("preview selected-row caret and multi-table ranges refuse rather than falling back to the clicked duplicate",
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
      return {setup,tableCount:viewer.querySelectorAll('table').length,action:__cells.action(true)};
    })()`);
    check("mixed preview fixture selects an actual table and nontext horizontal-rule sibling",
      selected.setup && selected.tableCount === 1 && selected.action.visible, selected);
    check("preview selected rows plus horizontal rule refuses instead of silently dropping the nontext selection",
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
    await page((from, to, at) => __cells.source(from, to, at),
      lf(leading.slice(0, leading.indexOf("Leading prose"))).length,
      lf(leading + table + trailing).length, lf(leading).length);
    const opened = await page(() => __cells.action(false));
    check("source click selects the exact regular table independently of the preserved prose selection",
      opened.opened && opened.count === 12, opened);
    if (!opened.opened) return;
    await exec("__cells.inputs()[7].textContent='nested owner update';true");
    await update();
    const offset = leading.length + table.indexOf(oldCell);
    const expected = body.slice(0, offset) + "nested owner update" + body.slice(offset + oldCell.length);
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
      return __cells.action(true);
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
      const input=__cells.inputs()[3],note=input.querySelector('.noted-text');
      const walker=document.createTreeWalker(input,NodeFilter.SHOW_TEXT);
      let neighbor;
      while(walker.nextNode()) {
        if(walker.currentNode.data===' old neighbor')neighbor=walker.currentNode;
      }
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
    const expected = body.replace(note + " old neighbor", note + " new neighbor");
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
  async function input() {
    const offset = secondOffset + table.indexOf("| plain |") + 2;
    const replacePlain = text => original.slice(0, offset) + text + original.slice(offset + "plain".length);
    for (const continuation of ["undo", "redo"]) {
      const historyFixture = await fresh("repeated-history-" + continuation, replacePlain("abcd"));
      const historyBefore = await state(), historySaves = saves.length;
      await openGrid();
      await exec("window.__cellHistoryFirst=__cells.inputs()[8].firstChild;true");
      const sample = () => exec(`(() => {
        const input=__cells.inputs()[8],range=getSelection().getRangeAt(0),prefix=document.createRange();
        prefix.selectNodeContents(input);prefix.setEnd(range.startContainer,range.startOffset);
        return {source:tableCellSession.cells[8].engine.readSource(),html:input.innerHTML,
          selected:range.toString(),start:prefix.toString().length,
          end:prefix.toString().length+range.toString().length,firstSame:input.firstChild===window.__cellHistoryFirst};
      })()`);
      const initial = await sample(), changes = [];
      for (const [at, text] of [[0, "X"], [0, "a"], [3, "Y"]]) {
        await exec(`(() => {
          const input=__cells.inputs()[8],walker=document.createTreeWalker(input,NodeFilter.SHOW_TEXT);
          const node=walker.nextNode(),range=document.createRange();input.focus();
          range.setStart(node,${at});range.setEnd(node,${at + 1});
          getSelection().removeAllRanges();getSelection().addRange(range);return true;
        })()`);
        const before = await sample(), typed = await typeTrustedCell([text], 8, { preserveCaret: true });
        changes.push({ before, after: await sample(), typed });
      }
      check("table repeated native history " + continuation + " fixture revisits identical owned DOM with conflicting selections",
        changes[0].before.html === initial.html && changes[1].after.html === initial.html &&
          changes[2].before.html === initial.html && changes[0].before.start === 0 &&
          changes[2].before.start === 3 && changes.every((change, at) =>
            change.after.source === ["Xbcd", "abcd", "abcY"][at] && change.typed.at(-1).events.some(event =>
              event.event === "beforeinput" && event.trusted && event.data === ["X", "a", "Y"][at])),
        { initial, changes });
      const undone = [], redone = [], finalUndo = [];
      for (let at = 0; at < 3; at++) { await key("Z", ["control"]); undone.push(await sample()); }
      for (let at = 0; at < 3; at++) { await key("Y", ["control"]); redone.push(await sample()); }
      if (continuation === "undo") {
        for (let at = 0; at < 3; at++) { await key("Z", ["control"]); finalUndo.push(await sample()); }
      }
      check("table repeated native history " + continuation + " exposes three independent Undo and Redo entries",
        JSON.stringify(undone.map(item => item.source)) === JSON.stringify(["abcd", "Xbcd", "abcd"]) &&
          JSON.stringify(redone.map(item => item.source)) === JSON.stringify(["Xbcd", "abcd", "abcY"]),
        { undone, redone, finalUndo });
      const restored = await sample();
      await typeTrustedCell(["z"], 8, { preserveCaret: true });
      const continued = await sample(), expected = continuation === "undo" ? "zbcd" : "abcYz";
      check("table repeated native history " + continuation + " continued typing uses the correct native occurrence selection",
        continued.source === expected && JSON.stringify(await state()) === JSON.stringify(historyBefore) &&
          saves.length === historySaves && fs.readFileSync(historyFixture.file, "utf8") === replacePlain("abcd"),
        { initial, changes, undone, redone, finalUndo, restored, continued, expected });
      await cancel();
      await exec("delete window.__cellHistoryFirst;true");
    }
    {
      const body = "**abcd** and *end*";
      const fixture = await fresh("repeated-whole-surface-history", replacePlain(body));
      const before = await state(), saveCount = saves.length;
      await openGrid();
      const sample = () => exec(`(() => {
        const input=__cells.inputs()[8],range=getSelection().getRangeAt(0),prefix=document.createRange();
        prefix.selectNodeContents(input);prefix.setEnd(range.startContainer,range.startOffset);
        return {source:tableCellSession.cells[8].engine.readSource(),html:input.innerHTML,
          selected:range.toString(),start:prefix.toString().length,end:prefix.toString().length+range.toString().length};
      })()`);
      const initial = await sample(), changes = [], undone = [];
      for (const [selector, text] of [["strong", "X"], ["em", "Y"]]) {
        await exec(`(() => {
          const input=__cells.inputs()[8],range=document.createRange();input.focus();
          range.setStartAfter(input.querySelector(${JSON.stringify(selector)}));range.collapse(true);
          getSelection().removeAllRanges();getSelection().addRange(range);return true;
        })()`);
        const prior = await sample(), typed = await typeTrustedCell([text], 8, { preserveCaret: true });
        changes.push({ before: prior, after: await sample(), typed });
        await key("Z", ["control"]); undone.push(await sample());
      }
      check("table whole-surface history fixture revisits identical source and owned DOM at different semantic endpoints",
        changes.every(change => change.before.html === initial.html) &&
          changes[0].before.start === 4 && changes[1].before.start === 12 &&
          changes[0].after.source === "**abcd**X and *end*" && changes[1].after.source === body + "Y" &&
          changes.every((change, at) => change.typed.at(-1).events.some(event =>
            event.event === "beforeinput" && event.trusted && event.data === ["X", "Y"][at] && event.prevented)),
        { initial, changes });
      await key("Y", ["control"]); const redone = await sample();
      await key("Z", ["control"]); const restored = await sample();
      await typeTrustedCell(["z"], 8, { preserveCaret: true }); const continued = await sample();
      check("table whole-surface native Undo Redo and branching continuation retain the actual operation endpoint",
        undone.every(item => item.source === body) && redone.source === body + "Y" &&
          restored.source === body && restored.start === 12 && restored.end === 12 &&
          continued.source === body + "z" && JSON.stringify(await state()) === JSON.stringify(before) &&
          saves.length === saveCount && fs.readFileSync(fixture.file, "utf8") === replacePlain(body),
        { undone, redone, restored, continued });
      await cancel();
    }
    for (const [selector, marker, word, side] of [
      ...["strong", "em", "code"].flatMap((selector, at) =>
        ["before", "after"].map(side => [selector, ["**", "*", "`"][at], ["bold", "em", "code"][at], side])),
      ["code", "`", "code", "adjacent"],
    ]) {
      const body = side === "adjacent" ? "`code`**bold** tail" : "one **bold** *em* `code` two";
      const boundaryFixture = await fresh("boundary-" + selector + "-" + side, replacePlain(body));
      const boundaryBefore = await state(), boundarySaves = saves.length;
      await openGrid();
      await exec(`(() => {
        const input=__cells.inputs()[8],owner=input.querySelector(${JSON.stringify(selector)});
        input.focus();const range=document.createRange();
        range[${JSON.stringify(side === "before" ? "setStartBefore" : "setStartAfter")}](owner);
        range.collapse(true);getSelection().removeAllRanges();getSelection().addRange(range);return true;
      })()`);
      const inserted = await typeTrustedCell(["x", "y"], 8, { preserveCaret: true });
      const unit = marker + word + marker;
      const expected = body.replace(unit, side === "before" ? "xy" + unit : unit + "xy");
      const liveSource = await exec("tableCellSession.cells[8].engine.readSource()");
      check("table " + selector + " " + side + " distinct trusted typing preserves semantic-side affinity",
        liveSource === expected && inserted.at(-1).events.filter(event =>
          event.event === "beforeinput" && event.trusted && ["x", "y"].includes(event.data)).length === 2 &&
          JSON.stringify(await state()) === JSON.stringify(boundaryBefore) &&
          fs.readFileSync(boundaryFixture.file, "utf8") === replacePlain(body), { liveSource, expected, inserted });
      await key("Z", ["control"]);
      const undoSource = await exec("tableCellSession.cells[8].engine.readSource()");
      await key("Y", ["control"]);
      check("table " + selector + " " + side + " native history restores exact source without document mutation",
        undoSource !== liveSource && await exec("tableCellSession.cells[8].engine.readSource()") === liveSource &&
          JSON.stringify(await state()) === JSON.stringify(boundaryBefore) && saves.length === boundarySaves,
        { undoSource, liveSource });
      await typeTrustedCell(["z"], 8, { preserveCaret: true });
      const continued = await exec("tableCellSession.cells[8].engine.readSource()");
      check("table " + selector + " " + side + " history-restored continuation preserves its semantic side",
        continued === expected.replace("xy", "xyz") && JSON.stringify(await state()) === JSON.stringify(boundaryBefore),
        { continued, expected });
      await cancel();
    }
    const fixture = await fresh("trusted-plain-cell");
    const before = await state(), beforeSaves = saves.length;
    const prepared = await exec(`(() => {
      const model=FoliaTableCells.index(window.CustomTabs.snapshotExactEditorContent(),marked,protectTableSource);
      return model.tables[1].rows.flatMap(row=>row.cells).map(cell=>{
        const input=document.createElement('div');
        try {
          const raw=model.source.slice(model.view.offsets[cell.start],model.view.offsets[cell.end]);
          const provenance=FoliaTableCells.prepareCell(input,cell.text,raw,marked,model.links,parseEmojis,sanitizeTableHtml);
          return {text:cell.text,serialized:serializeSafeTableCell(input,provenance)};
        } catch(error) {
          return {text:cell.text,html:input.innerHTML,error:error.stack};
        }
      });
    })()`);
    check("rich cell capture round-trips every original inline cell safely",
      prepared.every(cell => !cell.error), prepared);
    if (prepared.some(cell => cell.error)) throw new Error("Original cell serialization failed: " + JSON.stringify(prepared));
    await openGrid();
    const plain = (await typeTrustedCell(["changed"], 8, { replace: true })).at(-1);
    check("plain cell regression reaches trusted native insertion before document Update",
      plain.events.some(event => event.event === "beforeinput" && event.trusted && event.type === "insertText") &&
      plain.events.some(event => event.event === "input" && event.trusted && event.type === "insertText") &&
      plain.text === "changed" && plain.focused && plain.caretInCell &&
      JSON.stringify(await state()) === JSON.stringify(before), plain);
    const completion = await update(), after = await state(), expected = replacePlain("changed");
    check("trusted plain cell Update adds no generated wrapper and preserves every other source byte",
      !completion.open && !completion.error && after.exact === expected && after.cache === expected &&
      after.value === lf(expected) && after.undo === before.undo + 1 && after.redo === 0 && after.dirty &&
      saves.length === beforeSaves && fs.readFileSync(fixture.file, "utf8") === original,
      { plain, completion, after, expected });
    await exec("historyUndo();true");
    await wait("trusted plain cell document Undo", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    check("trusted plain cell Update remains one exact document Undo without saving",
      (await state()).exact === original && saves.length === beforeSaves &&
      fs.readFileSync(fixture.file, "utf8") === original);

    const codeFixture = await fresh("trusted-inline-code"), codeBefore = await state();
    const codeSaves = saves.length;
    await openGrid();
    const typed = await typeTrustedCell(["`", "x", "`"], 8, { replace: true });
    const live = typed.at(-1);
    check("backtick regression reaches each real opening body and closing insertion",
      typed.length === 3 && typed.every(snapshot => snapshot.events.some(event =>
        event.event === "beforeinput" && event.trusted && event.type === "insertText")) &&
      typed[0].text === "`" && typed[1].text === "`x", typed);
    check("typed backticks become formatted code immediately inside the still-open cell",
      await exec("tableCellDialog.open") && live.codes.length === 1 && live.codes[0] === "x" &&
      live.text === "x" && live.focused && live.collapsed && live.caretInCell && !live.caretInCode &&
      JSON.stringify(await state()) === JSON.stringify(codeBefore) && saves.length === codeSaves, live);
    const parity = await exec(`(() => {
      const existing=__cells.inputs()[4].querySelector('code'),created=__cells.inputs()[8].querySelector('code');
      const fields=['fontFamily','fontSize','fontStyle','fontWeight','color','backgroundColor'];
      return {existing:!!existing,created:!!created,same:!!existing&&!!created&&
        fields.every(field=>getComputedStyle(existing)[field]===getComputedStyle(created)[field])};
    })()`);
    check("newly typed inline code has the same in-cell formatting as loaded backtick code",
      parity.existing && parity.created && parity.same, parity);
    await key("Z", ["control"]);
    const undone = await exec("({html:__cells.inputs()[8].innerHTML,text:__cells.inputs()[8].textContent,codes:__cells.inputs()[8].querySelectorAll('code').length})");
    check("native cell Undo reverses live formatting without changing document authority or history",
      live.codes.length === 1 && live.codes[0] === "x" &&
      undone.codes === 0 && ["`x", "`x`"].includes(undone.text) &&
      JSON.stringify(await state()) === JSON.stringify(codeBefore) && saves.length === codeSaves, undone);
    await key("Y", ["control"]);
    const redone = await exec("__cells.inputs()[8].innerHTML");
    check("native cell Redo restores the live code edit without a document transaction",
      live.codes.length === 1 && live.codes[0] === "x" &&
      redone === live.html && JSON.stringify(await state()) === JSON.stringify(codeBefore), { redone, live });
    await screenshot("live-inline-code");
    const continued = (await typeTrustedCell([" next"], 8, { preserveCaret: true })).at(-1);
    check("typing after a closing backtick stays outside code at the preserved live caret",
      continued.codes.length === 1 && continued.codes[0] === "x" && continued.text === "x next" &&
      continued.focused && continued.collapsed && continued.caretInCell && !continued.caretInCode, continued);
    const codeCompletion = await update(), codeAfter = await state(), codeExpected = replacePlain("`x` next");
    check("live inline code commits valid Markdown without generated wrappers as one guarded Update",
      !codeCompletion.open && !codeCompletion.error && codeAfter.exact === codeExpected &&
      codeAfter.cache === codeExpected && codeAfter.value === lf(codeExpected) &&
      codeAfter.undo === codeBefore.undo + 1 && codeAfter.redo === 0 &&
      saves.length === codeSaves && fs.readFileSync(codeFixture.file, "utf8") === original,
      { codeCompletion, codeAfter, codeExpected });
    await openGrid();
    const reopened = await exec(`({html:__cells.inputs()[8].innerHTML,text:__cells.inputs()[8].textContent,
      codes:[...__cells.inputs()[8].querySelectorAll('code')].map(code=>code.textContent)})`);
    check("committed typed backtick code reopens as the same formatted cell content",
      reopened.text === "x next" && reopened.codes.length === 1 && reopened.codes[0] === "x", reopened);
    await cancel();
    check("Cancel after reopening live code leaves the exact committed document unchanged",
      JSON.stringify(await state()) === JSON.stringify(codeAfter) && saves.length === codeSaves);
    await exec("historyUndo();true");
    await wait("live code document Undo", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    check("one document Undo restores the exact pre-code CRLF duplicate-table source",
      (await state()).exact === original && fs.readFileSync(codeFixture.file, "utf8") === original &&
      saves.length === codeSaves);
    for (const scenario of [
      { name: "multiple-delimiters", parts: ["`", "`", "a", "`", "b", "`", "`"], code: "a`b", source: "``a`b``" },
      { name: "code-pipe", parts: ["`", "a|b", "`"], code: "a|b", source: "`a\\|b`" },
      { name: "code-slash-pipe", parts: ["`", "a\\|b", "`"], code: "a\\|b", source: "<code>a&#92;&#124;b</code>" },
      { name: "code-html", parts: ["`", "<b>&", "`"], code: "<b>&", source: "`<b>&`" },
      { name: "code-backslash-before-close", parts: ["`", "\\", "`"], code: "\\", source: "`\\`" },
      { name: "code-boundary-spaces", parts: ["`", "  x  ", "`"], code: " x ", source: "`  x  `" },
      { name: "code-all-space", parts: ["`", " ", "`"], code: " ", source: "` `" },
      { name: "code-shortcode", parts: ["`", ":star:", "`"], code: "⭐", source: "`:star:`" },
      { name: "literal-url", parts: ["https://example.invalid/path"], code: null, text: "https://example.invalid/path",
        source: "https&#58;//example.invalid/path" },
      { name: "literal-email", parts: ["user@example.invalid"], code: null, text: "user@example.invalid",
        source: "user&#64;example.invalid" },
      { name: "literal-www", parts: ["www.example.invalid"], code: null, text: "www.example.invalid",
        source: "www&#46;example.invalid" },
      { name: "escaped-opener", parts: ["\\", "`", "x", "`"], code: null, text: "\\`x`", source: "&#92;&#96;x&#96;" },
      { name: "unmatched-opener", parts: ["`", "unclosed"], code: null, text: "`unclosed", source: "&#96;unclosed" },
    ]) {
      const fixture = await fresh(scenario.name), before = await state(), savesBefore = saves.length;
      await openGrid();
      const snapshots = await typeTrustedCell(scenario.parts, 8, { replace: true }), last = snapshots.at(-1);
      check(scenario.name + " uses trusted input and preserves incomplete delimiter runs until their actual close",
        snapshots.every(snapshot => snapshot.events.some(event => event.trusted && event.type === "insertText")) &&
        (scenario.code === null || snapshots.slice(0, -1).every(snapshot => snapshot.codes.length === 0)), snapshots);
      check(scenario.name + " has the expected live code or literal content before Update",
        last.text === (scenario.code ?? scenario.text) &&
        JSON.stringify(last.codes) === JSON.stringify(scenario.code === null ? [] : [scenario.code]) &&
        JSON.stringify(await state()) === JSON.stringify(before), last);
      const completion = await update(), after = await state(), expected = replacePlain(scenario.source);
      check(scenario.name + " preserves exact code meaning and non-target bytes in valid table Markdown",
        !completion.open && !completion.error && after.exact === expected && after.cache === expected &&
        after.undo === before.undo + 1 && saves.length === savesBefore &&
        fs.readFileSync(fixture.file, "utf8") === original, { completion, after, expected });
      await openGrid();
      const reopened = await exec("({text:__cells.inputs()[8].textContent,codes:[...__cells.inputs()[8].querySelectorAll('code')].map(code=>code.textContent)})");
      check(scenario.name + " reopens with the same visible content and code formatting",
        reopened.text === last.text && JSON.stringify(reopened.codes) === JSON.stringify(last.codes), reopened);
      if (scenario.name === "code-slash-pipe") {
        const authority = await exec(`(() => {
          const input=__cells.inputs()[8],code=input.querySelector('code');
          const provenance=tableCellSession.cells.find(cell=>cell.input===input).provenance;
          const fragment=provenance.fragments.get(code.getAttribute('data-folia-cell-part'));
          input.focus();
          const range=document.createRange(),walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
          range.setStart(walker.nextNode(),1);range.collapse(true);
          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
          return {kind:fragment.kind,generated:!!fragment.generatedCode,
            opening:fragment.opening,closing:fragment.closing,
            source:FoliaTableCells.serializeCell(input,provenance),html:input.innerHTML};
        })()`);
        check("reopened approved CODE exception takes authority from its existing HTML source, not historical metadata",
          authority.kind === "html" && !authority.generated && authority.opening === "<code>" &&
          authority.closing === "</code>" && authority.source === scenario.source, authority);
        const pasted = await pasteCode("\ntail");
        check("editing reopened approved HTML keeps its source-owned CODE and actual paste line break",
          pasted.prevented && pasted.events.some(event => event.trusted) && pasted.codeBreaks === 1 &&
          pasted.text === scenario.code.slice(0, 1) + "tail" + scenario.code.slice(1) &&
          JSON.stringify(await state()) === JSON.stringify(after), pasted);
        await key("Z", ["control"]);
        check("reopened approved HTML paste Undo restores its exact captured DOM",
          await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(authority.html)) &&
          JSON.stringify(await state()) === JSON.stringify(after));
        await key("Y", ["control"]);
        check("reopened approved HTML paste Redo restores the exact source-owned CODE",
          await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(pasted.html)) &&
          JSON.stringify(await state()) === JSON.stringify(after));
        const completion = await update(), edited = await state();
        const expected = replacePlain(scenario.source.replace("<code>a", "<code>a<br>tail"));
        check("editing reopened approved HTML retains its original CODE wrapper and every non-target source byte",
          !completion.open && !completion.error && edited.exact === expected && edited.cache === expected &&
          edited.undo === after.undo + 1 && saves.length === savesBefore &&
          fs.readFileSync(fixture.file, "utf8") === original, { completion, edited, expected });
        await openGrid();
      }
      await cancel();
    }
    for (const scenario of [
      { name: "authored-shortcodes", source: ":star: ⭐ :star: end", text: "⭐ ⭐ ⭐ end" },
      { name: "escaped-shortcode", source: "\\:star: end", text: "\\⭐ end" },
      { name: "nested-shortcodes", source: "**:star: ⭐** [a\\[ :star:](cell.svg) `:star:` end", text: "⭐ ⭐ a[ ⭐ ⭐ end" },
      { name: "shortcode-attributes",
        source: '<span title=":star:">:star:</span> ![:star:](cell.svg ":star:") end', text: "⭐  end" },
      { name: "inline-comment", source: "visible <!-- retained annotation --> end", text: "visible  end" },
    ]) {
      const body = replacePlain(scenario.source), fixture = await fresh(scenario.name, body);
      const before = await state(), beforeSaves = saves.length;
      await openGrid();
      const typed = (await typeTrustedCell([" tail"], 8)).at(-1);
      check(scenario.name + " preserves its actual loaded rendering during trusted neighbor input",
        typed.text === scenario.text + " tail" &&
        typed.events.some(event => event.trusted && event.type === "insertText") &&
        JSON.stringify(await state()) === JSON.stringify(before), typed);
      const completion = await update(), after = await state(), expected = replacePlain(scenario.source + " tail");
      check(scenario.name + " retains exact authored source atoms without extra wrappers",
        !completion.open && !completion.error && after.exact === expected &&
        after.undo === before.undo + 1 && saves.length === beforeSaves &&
        fs.readFileSync(fixture.file, "utf8") === body, { completion, after, expected });
    }
    for (const scenario of [
      { name: "loaded-unmatched", source: "`x", code: "x", expected: "`x`" },
      { name: "loaded-escaped", source: "\\`x", code: null, expected: "\\`x&#96;", masked: [0] },
      { name: "loaded-entity", source: "&#96;x", code: null, expected: "&#96;x&#96;", masked: [0] },
      { name: "loaded-entity-slash-opener", source: "&#92;`x", code: "x", expected: "&#92;`x`" },
      { name: "loaded-escaped-slash-opener", source: "\\\\`x", code: "x", expected: "\\\\`x`" },
      { name: "loaded-two-entity-slashes", source: "&#92;&#92;`x", code: "x", expected: "&#92;&#92;`x`" },
      { name: "loaded-entity-before-escaped-opener", source: "&#92;\\`x", code: null, expected: "&#92;\\`x&#96;", masked: [1] },
      { name: "loaded-pair-before-escaped-opener", source: "\\\\\\`x", code: null, expected: "\\\\\\`x&#96;", masked: [1] },
      { name: "typed-after-entity-slash", source: "&#92;", parts: ["`", "x", "`"], code: "x", expected: "&#92;`x`" },
      { name: "typed-after-escaped-slash", source: "\\\\", parts: ["`", "x", "`"], code: "x", expected: "\\\\`x`" },
      { name: "typed-escape-after-entity-slash", source: "&#92;", parts: ["\\", "`", "x", "`"],
        code: null, expected: "&#92;&#92;&#96;x&#96;" },
      { name: "loaded-multiple-after-entity-slash", source: "&#92;``x", parts: ["`", "`"],
        code: "x", expected: "&#92;`x`" },
      { name: "typed-multiple-after-entity-slash", source: "&#92;", parts: ["`", "`", "x", "`", "`"],
        code: "x", expected: "&#92;`x`" },
      { name: "loaded-entity-tick-before-opener", source: "&#96;`x", code: "x", expected: "&#96;`x`", masked: [0] },
      { name: "loaded-escaped-tick-before-opener", source: "\\``x", code: "x", expected: "\\``x`", masked: [0] },
      { name: "loaded-entity-tick-before-multiple", source: "&#96;``x", parts: ["`", "`"],
        code: "x", expected: "&#96;`x`", masked: [0] },
      { name: "loaded-escaped-tick-before-multiple", source: "\\```x", parts: ["`", "`"],
        code: "x", expected: "\\``x`", masked: [0] },
      { name: "loaded-opener-before-literal-tick", source: "`&#96;x", code: "`x", expected: "`` `x ``", masked: [1] },
      { name: "loaded-protected-ticks-at-both-edges", source: "`&#96;x&#96;",
        code: "`x`", expected: "`` `x` ``", masked: [1, 3] },
    ]) {
      const body = replacePlain(scenario.source), fixture = await fresh(scenario.name, body);
      const before = await state(), beforeSaves = saves.length;
      await openGrid();
      const projection = await exec(`(() => {
        const cell=tableCellSession.cells.find(cell=>cell.input===__cells.inputs()[8]),range=document.createRange();
        range.selectNodeContents(cell.input);range.collapse(false);
        return FoliaTableCells.codeDelimiters(cell.input,cell.provenance,range);
      })()`);
      const masked = projection.literalTicks.map(tick => tick.index);
      check(scenario.name + " projects only owned literal ticks at unchanged UTF16 positions",
        JSON.stringify(masked) === JSON.stringify(scenario.masked || []) &&
        projection.syntax.length === projection.text.length &&
        [...Array(projection.text.length).keys()].every(index => masked.includes(index)
          ? projection.text[index] === "`" && projection.syntax[index] === "x"
          : projection.text[index] === projection.syntax[index]) &&
        projection.literalTicks.every(tick => tick.origin !== undefined &&
          Number.isInteger(tick.from) && Number.isInteger(tick.to) && tick.from < tick.to), projection);
      const initialText = await exec("__cells.inputs()[8].textContent"), parts = scenario.parts || ["`"];
      const typed = (await typeTrustedCell(parts, 8)).at(-1);
      check(scenario.name + " completes only an actual unescaped source opener while the cell remains open",
        JSON.stringify(typed.codes) === JSON.stringify(scenario.code ? [scenario.code] : []) &&
        typed.events.some(event => event.trusted && event.type === "insertText") &&
        JSON.stringify(await state()) === JSON.stringify(before), typed);
      if (scenario.code) {
        await key("Z", ["control"]);
        const undone = await exec("({text:__cells.inputs()[8].textContent,codes:__cells.inputs()[8].querySelectorAll('code').length})");
        const prefix = initialText + parts.slice(0, -1).join("");
        check(scenario.name + " preserves native code Undo without changing document authority",
          typed.codes.length === 1 && undone.codes === 0 && [prefix, prefix + "`"].includes(undone.text) &&
          JSON.stringify(await state()) === JSON.stringify(before), undone);
        await key("Y", ["control"]);
        check(scenario.name + " restores exact live code DOM through native Redo",
          typed.codes.length === 1 && await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(typed.html)) &&
          JSON.stringify(await state()) === JSON.stringify(before));
      }
      const completion = await update(), after = await state();
      check(scenario.name + " keeps literal escape provenance and exact outside bytes after Update",
        !completion.open && !completion.error && after.exact === replacePlain(scenario.expected) &&
        after.undo === before.undo + 1 && saves.length === beforeSaves &&
        fs.readFileSync(fixture.file, "utf8") === body, { completion, after });
      await openGrid();
      const reopened = await exec("({text:__cells.inputs()[8].textContent,codes:[...__cells.inputs()[8].querySelectorAll('code')].map(code=>code.textContent)})");
      check(scenario.name + " reopens with the same literal text and live code ownership",
        reopened.text === typed.text && JSON.stringify(reopened.codes) === JSON.stringify(typed.codes), reopened);
      await cancel();
    }
    for (const scenario of [
      { name: "punctuation-tail", source: "a * b", typed: " tail", expected: "a * b tail" },
      { name: "punctuation-middle", source: "a * b", at: 1, typed: "x", expected: "ax * b" },
      { name: "punctuation-boundary", source: "a * b* c", at: 3, typed: "x", expected: "a &#42;x b* c" },
      { name: "emoji-inside", source: ":star: end", atom: "emoji", typed: "x", expected: ":star:x end" },
      { name: "emoji-replaced", source: ":star: end", atom: "emoji", replaceAtom: true, typed: "x", expected: "x end" },
      { name: "code-emoji-inside", source: "`:star:` end", atom: "emoji", typed: "x", expected: "`:star:x` end" },
      { name: "code-emoji-replaced", source: "`:star:` end", atom: "emoji", replaceAtom: true, typed: "x", expected: "`x` end" },
      { name: "entity-inside", source: "&NotEqualTilde; end", atom: "escape", typed: "x", expected: "&NotEqualTilde;x end" },
      { name: "scheme-completion", source: "https", typed: "://example.invalid/path", expected: "https&#58;//example.invalid/path" },
      { name: "scheme-prepend", source: "example.invalid/path", at: 0, typed: "https://", expected: "https&#58;//example.invalid/path" },
      { name: "www-completion", source: "www", typed: ".example.invalid", expected: "www&#46;example.invalid" },
      { name: "www-prepend", source: ".example.invalid", at: 0, typed: "www", expected: "www&#46;example.invalid" },
      { name: "email-prepend", source: "@example.invalid", at: 0, typed: "name", expected: "name&#64;example.invalid" },
      { name: "alias-completion", source: ":st", typed: "ar:", expected: "&#58;star:" },
      { name: "alias-prepend", source: "ar:", at: 0, typed: ":st", expected: "&#58;star:" },
      { name: "alias-delete", source: ":st ar:", at: 3, to: 4, erase: true, expected: "&#58;star:" },
      { name: "scheme-delete", source: "https ://example.invalid", at: 5, to: 6, erase: true, expected: "https&#58;//example.invalid" },
      { name: "email-delete", source: "name @example.invalid", at: 4, to: 5, erase: true, expected: "name&#64;example.invalid" },
      { name: "encoded-alias-prefix", source: "&#58;st", typed: "ar:", expected: "&#58;star:" },
      { name: "encoded-alias-suffix", source: "ar&#58;", at: 0, typed: ":st", expected: ":star&#58;" },
      { name: "authored-span-completion", source: '<span style="color: red">https</span> end', atom: "text",
        typed: "://example.invalid", expected: '<span style="color: red">https&#58;//example.invalid</span> end' },
      { name: "scheme-entity-join", source: "https&#32;://example.invalid", at: 5, to: 6, erase: true,
        expected: "https&#58;//example.invalid" },
      { name: "alias-entity-join", source: ":st&#32;ar:", at: 3, to: 4, erase: true, expected: "&#58;star:" },
      { name: "www-entity-join", source: "www&#32;.example.invalid", at: 3, to: 4, erase: true,
        expected: "www&#46;example.invalid" },
      { name: "email-entity-join", source: "name&#32;@example.invalid", at: 4, to: 5, erase: true,
        expected: "name&#64;example.invalid" },
      { name: "emoji-neighbor-entity-join", source: ":star: :st&#32;ar:", at: 5, to: 6, erase: true,
        expected: ":star: &#58;star:" },
      { name: "authored-entity-join", source: '<span style="color: red">https&#32;://example.invalid</span> end',
        at: 5, to: 6, erase: true, expected: '<span style="color: red">https&#58;//example.invalid</span> end' },
      { name: "inert-entity-join", source: ":st&#32;ar&#58;", at: 3, to: 4, erase: true, expected: ":star&#58;" },
      { name: "authored-barrier-join", source: "https&#32;<span>://example.invalid</span>", at: 5, to: 6, erase: true,
        expected: "https<span>://example.invalid</span>" },
      { name: "inline-link-destination-join", source: "[label](foo bar)", at: 11, to: 12, erase: true,
        expected: "&#91;label](foobar)" },
      { name: "inline-image-destination-join", source: "![label](foo bar)", at: 12, to: 13, erase: true,
        expected: "!&#91;label](foobar)" },
      { name: "reference-label-join", source: "[label][cell ref]", remove: " ", erase: true,
        definitions: "[cellref]: cell.svg", expected: "&#91;label]&#91;cellref]" },
      { name: "shortcut-label-join", source: "[cell ref]", remove: " ", erase: true,
        definitions: "[cellref]: cell.svg", expected: "&#91;cellref]" },
      { name: "reference-image-label-join", source: "![label][cell ref]", remove: " ", erase: true,
        definitions: "[cellref]: cell.svg", expected: "!&#91;label]&#91;cellref]" },
      { name: "entity-link-destination-join", source: "[label](foo &#32;bar)", remove: "  ", erase: true,
        expected: "&#91;label](foobar)" },
      { name: "collapsed-reference-join", source: "[cell ref][]", remove: " ", erase: true,
        definitions: "[cellref]: cell.svg", expected: "&#91;cellref]&#91;]" },
      { name: "nested-link-label-join", source: "[la[bel]](foo bar)", remove: " ", erase: true,
        expected: "&#91;la&#91;bel]](foobar)" },
      { name: "escaped-link-label-control", source: "[la\\[bel]](foo bar)", remove: " ", erase: true,
        expected: "[la\\[bel]](foobar)" },
      { name: "strong-delimiter-join", source: "** a**", remove: " ", erase: true,
        expected: "&#42;&#42;a**" },
      { name: "emphasis-delimiter-join", source: "* a*", remove: " ", erase: true,
        expected: "&#42;a*" },
      { name: "strike-delimiter-join", source: "~~ a~~", remove: " ", erase: true,
        expected: "&#126;&#126;a~~" },
      { name: "code-delimiter-tail-delete", source: "``a```", at: 5, to: 6, erase: true,
        expected: "``a&#96;&#96;" },
      { name: "escape-delimiter-join", source: "\\x*", remove: "x", erase: true,
        expected: "&#92;*" },
      { name: "angle-url-join", source: "<https ://example.invalid>", remove: " ", erase: true,
        expected: "&#60;https&#58;//example.invalid>" },
      { name: "angle-email-join", source: "<name @example.invalid>", remove: " ", erase: true,
        expected: "&#60;name&#64;example.invalid>" },
      { name: "incomplete-html-completion", source: "<sp an", typed: ">", expected: "<sp an&#62;" },
      { name: "authored-break-neighbor", source: "a<br>b * c", typed: " tail", expected: "a<br>b * c tail" },
      { name: "markdown-strong-edit", source: "**first**", atom: "text", typed: "x", expected: "**firstx**" },
      { name: "markdown-emphasis-edit", source: "*first*", atom: "text", typed: "x", expected: "*firstx*" },
      { name: "markdown-strike-edit", source: "~~first~~", atom: "text", typed: "x", expected: "~~firstx~~" },
      { name: "underscore-emphasis-leading-join", source: "a _hello_", remove: " ", erase: true,
        expected: "a*hello*" },
      { name: "underscore-strong-leading-join", source: "a __hello__", remove: " ", erase: true,
        expected: "a**hello**" },
      { name: "underscore-emphasis-trailing-join", source: "_hello_ a", remove: " ", erase: true,
        expected: "*hello*a" },
      { name: "underscore-strong-trailing-join", source: "__hello__ a", remove: " ", erase: true,
        expected: "**hello**a" },
      { name: "underscore-delimiter-spelling-control", source: "a __hello__ b", at: 0, to: 1, typed: "c",
        expected: "c __hello__ b" },
      { name: "emphasis-opening-punctuation-join", source: "a _!hello_ b", at: 1, to: 2, erase: true,
        expected: "&#97;*!hello* b" },
      { name: "strong-closing-punctuation-join", source: "a **hello!** b", at: 8, to: 9, erase: true,
        expected: "a **hello!**&#98;" },
      { name: "emphasis-closing-punctuation-join", source: "a *hello!* b", at: 8, to: 9, erase: true,
        expected: "a *hello!*&#98;" },
      { name: "strike-closing-punctuation-join", source: "a ~~hello!~~ b", at: 8, to: 9, erase: true,
        expected: "a ~~hello!~~&#98;" },
      { name: "emphasis-opening-unicode-punctuation-join", source: "a _\u00A9hello_ b", at: 1, to: 2, erase: true,
        expected: "&#97;*\u00A9hello* b" },
      { name: "emphasis-opening-supplementary-letter-join", source: "\uD801\uDC00 _!hello_ b", at: 2, to: 3, erase: true,
        expected: "&#66560;*!hello* b" },
      { name: "strong-closing-supplementary-letter-join", source: "a **hello!** \uD801\uDC00", at: 8, to: 9, erase: true,
        expected: "a **hello!**&#66560;" },
      { name: "nested-shared-delimiter-closing-join", source: "a ***x!*** b", at: 4, to: 5, erase: true, nativeHistory: true,
        expected: "a ***x!***&#98;" },
      { name: "nested-shared-delimiter-opening-join", source: "a ***!x*** b", at: 1, to: 2, erase: true, nativeHistory: true,
        expected: "&#97;***!x*** b" },
      { name: "nested-mixed-delimiter-closing-join", source: "a **_x!_** b", at: 4, to: 5, erase: true, nativeHistory: true,
        expected: "a **_x!_**&#98;" },
      { name: "nested-mixed-delimiter-opening-join", source: "a **_!x_** b", at: 1, to: 2, erase: true, nativeHistory: true,
        expected: "&#97;**_!x_** b" },
      { name: "nested-mixed-delimiter-letter-control", source: "a *__x__* b", at: 3, to: 4, erase: true, nativeHistory: true,
        expected: "a *__x__*&#98;" },
      { name: "nested-normalized-underscore-closing-join", source: "a _**x!**_ b", at: 4, to: 5, erase: true, nativeHistory: true,
        expected: "a _**x!**_&#98;" },
      { name: "nested-strong-underscore-closing-join", source: "a __*x!*__ b", at: 4, to: 5, erase: true, nativeHistory: true,
        expected: "a __*x!*__&#98;" },
      { name: "nested-strong-underscore-opening-join", source: "a __*!x*__ b", at: 1, to: 2, erase: true, nativeHistory: true,
        expected: "&#97;__*!x*__ b" },
      { name: "nested-all-underscore-closing-join", source: "a ___hello___ b", at: 7, to: 8, erase: true, nativeHistory: true,
        expected: "a ___hello___&#98;" },
      { name: "nested-all-underscore-opening-join", source: "a ___hello___ b", at: 1, to: 2, erase: true, nativeHistory: true,
        expected: "&#97;___hello___ b" },
      { name: "nested-underscore-supplementary-letter-join", source: "a ___hello___ \uD801\uDC00",
        at: 7, to: 8, erase: true, nativeHistory: true, expected: "a ___hello___&#66560;" },
      { name: "nested-underscore-unicode-letter-join", source: "\u03B1 ___hello___ b",
        at: 1, to: 2, erase: true, nativeHistory: true, expected: "&#945;___hello___ b" },
      { name: "nested-partial-body-underscore-control", source: "**_hello_ a**", at: 5, to: 6, erase: true, nativeHistory: true,
        expected: "***hello*a**", expectedStructure: [["STRONG", null, "helloa"], ["EM", null, "hello"]] },
      { name: "nested-strike-delimiter-letter-control", source: "a ***~~x!~~*** b", at: 4, to: 5, erase: true, nativeHistory: true,
        expected: "a ***~~x!~~***b" },
      { name: "nested-strike-outer-closing-join", source: "a ~~*x!*~~ b", at: 4, to: 5, erase: true, nativeHistory: true,
        expected: "a ~~*x!*~~&#98;" },
      { name: "nested-strike-outer-opening-join", source: "a ~~*!x*~~ b", at: 1, to: 2, erase: true, nativeHistory: true,
        expected: "&#97;~~*!x*~~ b" },
      { name: "nested-supplementary-letter-join", source: "a ***x!*** \uD801\uDC00", at: 4, to: 5, erase: true, nativeHistory: true,
        expected: "a ***x!***&#66560;" },
      { name: "nested-unicode-symbol-join", source: "a ***\u00A9x*** b", at: 1, to: 2, erase: true, nativeHistory: true,
        expected: "&#97;***\u00A9x*** b" },
      { name: "nested-protected-entity-control", source: "a ***x!*** &#98;", at: 4, to: 5, erase: true, nativeHistory: true,
        expected: "a ***x!***&#98;" },
      { name: "nested-authored-barrier-control", source: 'a ***x!*** <span title="keep">b</span>', at: 4, to: 5,
        erase: true, nativeHistory: true, expected: 'a ***x!***<span title="keep">b</span>' },
      { name: "nested-code-barrier-control", source: "a ***x!*** `b`", at: 4, to: 5, erase: true, nativeHistory: true,
        expected: "a ***x!***`b`" },
      { name: "sibling-emphasis-strong-punctuation-join", source: "*x!* **y**", remove: " ", erase: true,
        nativeHistory: true, expected: "*x!*__y__" },
      { name: "sibling-strong-emphasis-punctuation-join", source: "**x!** *y*", remove: " ", erase: true,
        nativeHistory: true, expected: "**x!**_y_" },
      { name: "sibling-emphasis-strong-opening-control", source: "*x* **!y**", remove: " ", erase: true,
        nativeHistory: true, expected: "*x***!y**" },
      { name: "sibling-strong-emphasis-opening-control", source: "**x** *!y*", remove: " ", erase: true,
        nativeHistory: true, expected: "**x***!y*" },
      { name: "sibling-unicode-punctuation-join", source: "*x\u00A9* **y**", remove: " ", erase: true,
        nativeHistory: true, expected: "*x\u00A9*__y__" },
      { name: "sibling-three-owner-join", source: "*x!* **y***z*", remove: " ", erase: true,
        nativeHistory: true, expected: "*x!*__y__*z*" },
      { name: "sibling-owned-label-join", source: "[*x!* **y**](one.md)", remove: " ", erase: true,
        nativeHistory: true, expected: "[*x!*__y__](<one.md>)" },
      { name: "sibling-emphasis-strike-join", source: "*x!* ~~y~~", remove: " ", erase: true,
        nativeHistory: true, expected: "_x!_~~y~~" },
      { name: "sibling-strong-strike-join", source: "**x!** ~~y~~", remove: " ", erase: true,
        nativeHistory: true, expected: "__x!__~~y~~" },
      { name: "sibling-strike-emphasis-opening-control", source: "~~x~~ *!y*", remove: " ", erase: true,
        nativeHistory: true, expected: "~~x~~*!y*" },
      { name: "sibling-strike-strong-opening-control", source: "~~x~~ **!y**", remove: " ", erase: true,
        nativeHistory: true, expected: "~~x~~**!y**" },
      { name: "sibling-fixed-nest-opening-join", source: "**x!** ***y***", remove: " ", erase: true,
        nativeHistory: true, expected: "__x!__***y***" },
      { name: "sibling-fixed-nest-closing-join", source: "***x!*** **y**", remove: " ", erase: true,
        nativeHistory: true, expected: "***x!***__y__" },
      { name: "sibling-fixed-mixed-nest-opening-control", source: "*x!* **_y_**", remove: " ", erase: true,
        nativeHistory: true, expected: "*x!***_y_**" },
      { name: "sibling-fixed-mixed-nest-closing-join", source: "**_x!_** *y*", remove: " ", erase: true,
        nativeHistory: true, expected: "**_x!_**_y_" },
      { name: "sibling-authored-barrier-control", source: '*x!* <span title="keep">y</span>', remove: " ", erase: true,
        nativeHistory: true, expected: '*x!*<span title="keep">y</span>' },
      { name: "sibling-code-barrier-control", source: "*x!* `y`", remove: " ", erase: true,
        nativeHistory: true, expected: "*x!*`y`" },
      { name: "sibling-link-barrier-control", source: "*x!* [**y**](one.md)", remove: " ", erase: true,
        nativeHistory: true, expected: "*x!*[**y**](one.md)" },
      { name: "sibling-protected-entity-barrier-control", source: "*x!* &#121;**z**", remove: " ", erase: true,
        nativeHistory: true, expected: "*x!*&#121;**z**" },
      { name: "native-bold-command", source: "hello", at: 0, to: 5, nativeFormat: "B" },
      { name: "native-italic-command", source: "hello", at: 0, to: 5, nativeFormat: "I" },
      { name: "native-underline-command", source: "hello", at: 0, to: 5, nativeFormat: "U" },
      { name: "native-meta-bold-command", source: "hello", at: 0, to: 5, nativeFormat: "B", formatModifiers: ["meta"] },
      { name: "native-meta-italic-command", source: "hello", at: 0, to: 5, nativeFormat: "I", formatModifiers: ["meta"] },
      { name: "native-meta-underline-command", source: "hello", at: 0, to: 5, nativeFormat: "U", formatModifiers: ["meta"] },
      { name: "native-bold-collapsed-command", source: "hello", at: 2, nativeFormat: "B" },
      { name: "native-bold-markdown-command", source: "**hello**", at: 1, to: 4, nativeFormat: "B" },
      { name: "native-italic-authored-command", source: '<em title="keep">hello</em>', at: 1, to: 4, nativeFormat: "I" },
      { name: "native-underline-authored-command", source: '<span title="keep">hello</span>', at: 0, to: 5, nativeFormat: "U" },
      { name: "markdown-link-edit", source: "[first](one.md)", atom: "text", at: 2, typed: "x",
        expected: "[fixrst](<one.md>)" },
      { name: "semantic-strong-adjacency", source: "**first** **last**", remove: " ", erase: true,
        expected: "**firstlast**" },
      { name: "semantic-emphasis-adjacency", source: "*first* *last*", remove: " ", erase: true,
        expected: "*firstlast*" },
      { name: "semantic-strike-adjacency", source: "~~first~~ ~~last~~", remove: " ", erase: true,
        expected: "~~firstlast~~" },
      { name: "nested-strong-scheme-join", source: "**https ://example.invalid**", remove: " ", erase: true,
        expected: "**https&#58;//example.invalid**" },
      { name: "nested-emphasis-entity-join", source: "*:st&#32;ar:*", remove: " ", erase: true,
        expected: "*&#58;star:*" },
      { name: "nested-strike-bracket-join", source: "~~[label](foo bar)~~", remove: " ", erase: true,
        expected: "~~&#91;label](foobar)~~" },
      { name: "deep-emphasis-scheme-join", source: "***https ://example.invalid***", remove: " ", erase: true,
        expected: "***https&#58;//example.invalid***" },
      { name: "nested-protected-entity-control", source: "**:st&#32;ar&#58;**", remove: " ", erase: true,
        expected: "**:star&#58;**" },
      { name: "nested-authored-neighbor", source: '**https ://example.invalid** <span title="&#58;star:">keep</span> `hold`',
        remove: " ", erase: true, expected: '**https&#58;//example.invalid** <span title="&#58;star:">keep</span> `hold`' },
      { name: "nested-link-context-control", source: "[https ://example.invalid](one.md)", remove: " ", erase: true,
        expected: "[https://example.invalid](<one.md>)" },
      { name: "link-escaped-open-atom", source: "[a\\[b](one.md)", at: 0, to: 1, typed: "c",
        expected: "[c\\[b](<one.md>)" },
      { name: "link-escaped-close-atom", source: "[a\\]b](one.md)", at: 0, to: 1, typed: "c",
        expected: "[c\\]b](<one.md>)" },
      { name: "link-escaped-utf16-atom", source: "[😀a\\[b](one.md)", at: 2, to: 3, typed: "c",
        expected: "[😀c\\[b](<one.md>)" },
      { name: "nested-link-escaped-atom", source: "**[a\\[b](one.md)**", at: 0, to: 1, typed: "c",
        expected: "**[c\\[b](<one.md>)**" },
      ...[["strong", "**", "STRONG"], ["emphasis", "*", "EM"], ["strike", "~~", "DEL"]].flatMap(
        ([name, marker, formattingTag]) => ["start", "end"].flatMap(edge =>
          [" ", "\u00a0"].map((typed, index) => ({
            name: name + "-" + edge + "-whitespace-" + index, source: marker + "hello" + marker,
            atom: "text", at: edge === "start" ? 0 : 5, typed, formattingTag,
            whitespaceEdge: edge,
            expected: marker + (edge === "start" ? "&#WS;hello" : "hello&#WS;") + marker,
          })))),
      ...[["strong", "**", "STRONG"], ["emphasis", "*", "EM"], ["strike", "~~", "DEL"]].map(
        ([name, marker, formattingTag]) => ({
          name: name + "-all-whitespace", source: marker + "hello" + marker,
          atom: "text", at: 0, to: 5, typed: "\u00a0", formattingTag, whitespaceEdge: "only",
          expected: marker + "&#WS;" + marker,
        })),
      ...[["strong", "**", "STRONG"], ["emphasis", "*", "EM"], ["strike", "~~", "DEL"]].map(
        ([name, marker, formattingTag]) => ({
          name: name + "-both-whitespace-runs", source: marker + "hello" + marker,
          atom: "text", at: 0, to: 5, typed: "  hello  ", formattingTag, whitespaceEdge: "both",
          expected: marker + "&#START;hello&#END;" + marker,
        })),
      { name: "nested-format-whitespace", source: "***hello***", atom: "text", at: 0, typed: " ",
        formattingTag: "EM", whitespaceEdge: "start", expected: "***&#WS;hello***" },
      { name: "authored-strong-replacement", source: '<strong title="keep">hello</strong>', at: 0, to: 5, typed: "changed",
        expected: '<strong title="keep">changed</strong>' },
      { name: "authored-emphasis-replacement", source: '<em title="keep">hello</em>', at: 0, to: 5, typed: "changed",
        expected: '<em title="keep">changed</em>' },
      { name: "authored-strike-replacement", source: '<del title="keep">hello</del>', at: 0, to: 5, typed: "changed",
        expected: '<del title="keep">changed</del>' },
      { name: "authored-bold-alias-replacement", source: '<b title="keep">hello</b>', at: 0, to: 5, typed: "changed",
        expected: '<b title="keep">changed</b>' },
      { name: "authored-plain-strong-replacement", source: "<strong>hello</strong>", at: 0, to: 5, typed: "  hello  ",
        expected: "<strong>  hello  </strong>" },
      { name: "authored-plain-emphasis-replacement", source: "<em>hello</em>", at: 0, to: 5, typed: "  hello  ",
        expected: "<em>  hello  </em>" },
      { name: "authored-plain-strike-replacement", source: "<del>hello</del>", at: 0, to: 5, typed: "  hello  ",
        expected: "<del>  hello  </del>" },
      { name: "authored-plain-bold-alias-replacement", source: "<b>hello</b>", at: 0, to: 5, typed: "  hello  ",
        expected: "<b>  hello  </b>" },
      { name: "nested-markdown-full-replacement", source: "***hello***", at: 0, to: 5, typed: "  hello  ",
        expected: "***&#32;&#32;hello&#32;&#32;***" },
      { name: "nested-authored-full-replacement", source: "<strong>*hello*</strong>", at: 0, to: 5, typed: "  hello  ",
        expected: "<strong>*&#32;&#32;hello&#32;&#32;*</strong>" },
      { name: "native-select-all-strong", source: "**hello**", nativeSelectAll: true, typed: "  hello  ",
        expected: "**&#32;&#32;hello&#32;&#32;**" },
      { name: "native-select-all-authored", source: "<strong>hello</strong>", nativeSelectAll: true, typed: "  hello  ",
        expected: "<strong>  hello  </strong>" },
      { name: "native-select-all-nested", source: "***hello***", nativeSelectAll: true, typed: "  hello  ",
        expected: "***&#32;&#32;hello&#32;&#32;***" },
      { name: "element-boundary-strong", source: "**hello**", elementSelection: true, typed: "  hello  ",
        expected: "**&#32;&#32;hello&#32;&#32;**" },
      { name: "element-boundary-authored", source: "<strong>hello</strong>", elementSelection: true, typed: "  hello  ",
        expected: "<strong>  hello  </strong>" },
      { name: "element-boundary-nested", source: "***hello***", elementSelection: true, typed: "  hello  ",
        expected: "***&#32;&#32;hello&#32;&#32;***" },
      { name: "repeated-markdown-replacement", source: "**hello**", elementSelection: true,
        typed: "first", repeatReplacement: "second", expected: "**second**" },
      { name: "repeated-authored-replacement", source: "<strong>hello</strong>", elementSelection: true,
        typed: "first", repeatReplacement: "second", expected: "<strong>second</strong>" },
      { name: "retained-space-atom", source: "**&#32;hello**", at: 6, typed: " tail",
        expected: "**&#32;hello tail**" },
      { name: "retained-nbsp-atom", source: "**&#160;hello**", at: 6, typed: " tail",
        expected: "**&#160;hello tail**" },
      { name: "merged-boundary-atoms", source: "**&#32;first** **last&#32;**", at: 6, to: 7, erase: true,
        expected: "**&#32;firstlast&#32;**" },
      { name: "link-delete-escaped-repeat", source: "[a\\[[b]c](one.md)", at: 1, to: 2, erase: true, atomHistory: "\\[",
        expected: "[a[b]c](<one.md>)" },
      { name: "link-retain-escaped-repeat", source: "[a\\[[b]c](one.md)", at: 2, to: 3, erase: true, atomHistory: "\\[",
        expected: "[a\\[b&#93;c](<one.md>)" },
      { name: "nested-delete-escaped-repeat", source: "**[a\\[[b]c](one.md)**", at: 1, to: 2, erase: true, atomHistory: "\\[",
        expected: "**[a[b]c](<one.md>)**" },
      { name: "nested-retain-escaped-repeat", source: "**[a\\[[b]c](one.md)**", at: 2, to: 3, erase: true, atomHistory: "\\[",
        expected: "**[a\\[b&#93;c](<one.md>)**" },
      { name: "utf16-delete-escaped-repeat", source: "[😀a\\[[b]c](one.md)", at: 3, to: 4, erase: true, atomHistory: "\\[",
        expected: "[😀a[b]c](<one.md>)" },
      { name: "link-delete-escaped-close-repeat", source: "[a[b]\\]c](one.md)", at: 4, to: 5, erase: true, atomHistory: "\\]",
        expected: "[a[b]c](<one.md>)" },
      { name: "link-retain-escaped-close-repeat", source: "[a[b]\\]c](one.md)", at: 3, to: 4, erase: true, atomHistory: "\\]",
        expected: "[a&#91;b\\]c](<one.md>)" },
      { name: "link-replace-escaped-boundary", source: "[a\\[[b]c](one.md)", at: 1, to: 3, typed: "x", atomHistory: "\\[",
        expected: "[axb&#93;c](<one.md>)" },
      { name: "link-replace-identical-opener", source: "[a\\[[b]c](one.md)", at: 1, to: 3, typed: "[", atomHistory: "\\[",
        expected: "[a&#91;b&#93;c](<one.md>)" },
      { name: "link-replace-identical-closer", source: "[a[b]\\]c](one.md)", at: 3, to: 5, typed: "]", atomHistory: "\\]",
        expected: "[a[b]c](<one.md>)" },
      { name: "adjacent-strong-scheme-control", source: "**https** **://example.invalid**", remove: " ", erase: true,
        expected: "**https****://example.invalid**" },
      { name: "merged-strong-scheme-join", source: "**http** **s://example.invalid**", remove: " ", erase: true,
        expected: "**https&#58;//example.invalid**" },
      { name: "merged-strong-reference-join", source: "**[** **label]**", remove: " ", erase: true,
        definitions: "[label]: cell.svg", expected: "**&#91;label]**" },
      { name: "semantic-link-attachment", source: "[first](foo bar)", remove: " ", erase: true,
        definitions: "[first]: first.md", expected: "[first]&#40;foobar)" },
      { name: "semantic-link-adjacency", source: "[first] [last]", remove: " ", erase: true,
        definitions: "[first]: first.md\r\n[last]: last.md",
        expected: '[first](<first.md>)[last](<last.md>)',
        targets: [["A", "first", "first.md", null], ["A", "last", "last.md", null]] },
      { name: "semantic-full-reference-control", source: "[**f\\[irst**][one] [last][two]", remove: " ", erase: true,
        definitions: '[one]: <first(1).md> "one &quot;title&quot;"\r\n[two]: <last(2).md> "two title"',
        expected: '[**f\\[irst**][one][last][two]',
        targets: [["A", "f[irst", "first(1).md", 'one "title"'], ["A", "last", "last(2).md", "two title"]] },
      { name: "semantic-link-titles", source: "[**first**] [last]", remove: " ", erase: true,
        definitions: '[**first**]: <first(1).md> "one &quot;title&quot;"\r\n[last]: <last(2).md> "two title"',
        expected: '[**first**](<first(1).md> "one &#34;title&#34;")[last](<last(2).md> "two title")',
        targets: [["A", "first", "first(1).md", 'one "title"'], ["A", "last", "last(2).md", "two title"]] },
      { name: "semantic-link-literal-attributes", source: "[first] [last]", remove: " ", erase: true,
        definitions: '[first]: <docs/first&#58;star:.md> "literal &#58;star:"\r\n[last]: <last?x=1&amp;y=2> "last"',
        expected: '[first](<docs/first&#58;star&#58;.md> "literal &#58;star&#58;")[last](<last?x=1&#38;y=2> "last")',
        targets: [["A", "first", "docs/first:star:.md", "literal :star:"], ["A", "last", "last?x=1&y=2", "last"]] },
      { name: "semantic-image-adjacency", source: "![first] [last]", remove: " ", erase: true,
        definitions: '[first]: cell.svg "image"\r\n[last]: last.md',
        expected: '![first](<cell.svg> "image")[last](<last.md>)',
        targets: [["IMG", "first", "cell.svg", "image"], ["A", "last", "last.md", null]] },
      { name: "semantic-link-delimiter-neighbor", source: "** a[first]**", remove: " ", erase: true,
        definitions: "[first]: first.md", expected: "&#42;&#42;a[first]**" },
      { name: "authored-style-delimiter-neighbor", source: '** a** <span style="color: red">keep</span> [first]',
        remove: " ", erase: true, definitions: "[first]: first.md",
        expected: '&#42;&#42;a** <span style="color: red">keep</span> [first]' },
    ]) {
      const replaceScenario = value => {
        const body = replacePlain(value);
        return scenario.definitions ? body.replace("\r\n\r\nBefore prose",
          "\r\n" + scenario.definitions + "\r\n\r\nBefore prose") : body;
      };
      const body = replaceScenario(scenario.source), fixture = await fresh(scenario.name, body);
      const before = await state(), beforeSaves = saves.length;
      await openGrid();
      const targets = () => exec(`([...__cells.inputs()[8].querySelectorAll('a,img')].map(node=>[
        node.tagName,node.tagName==='IMG'?node.getAttribute('alt'):node.textContent,
        node.tagName==='IMG'?(node.getAttribute('data-original-src')||node.getAttribute('src')):
          node.getAttribute('href'),node.getAttribute('title')]))`);
      const formattingStructure = () => exec(`([...__cells.inputs()[8].querySelectorAll('strong,em,del,code,span[title]')]
        .map(node=>[node.tagName,node.getAttribute('title'),node.textContent]))`);
      const initialStructure = scenario.nativeHistory ? await formattingStructure() : null;
      if (initialStructure) check(scenario.name + " starts with actual nested formatting before native input",
        initialStructure.length >= 2 && initialStructure.some(node => ["EM", "STRONG", "DEL"].includes(node[0])),
        initialStructure);
      if (scenario.targets) check(scenario.name + " starts with the actual intended formatted links and attributes",
        JSON.stringify(await targets()) === JSON.stringify(scenario.targets), await targets());
      if (scenario.targets?.some(target => target[0] === "IMG")) {
        const resolved = await exec("__cells.inputs()[8].querySelector('img').getAttribute('src')");
        check(scenario.name + " resolves the actual image against its real source document",
          resolved === require("url").pathToFileURL(path.join(path.dirname(fixture.file), "cell.svg")).href, resolved);
      }
      if (scenario.atom || scenario.at !== undefined || scenario.remove) {
        const setup = await page(scenario => {
          const cell=tableCellSession.cells[8],input=cell.input;
          const captured=[...input.querySelectorAll('[data-folia-cell-part]')].find(node=>
            cell.provenance.fragments.get(node.getAttribute('data-folia-cell-part'))?.kind===scenario.atom);
          const node=scenario.atom?captured?.firstChild:document.createTreeWalker(input,NodeFilter.SHOW_TEXT).nextNode();
          if(!node||node.nodeType!==Node.TEXT_NODE)throw new Error('No actual captured text node for caret setup');
          input.focus();const range=document.createRange();
          if(scenario.atom) {
            range.setStart(node,scenario.replaceAtom?0:scenario.at??node.data.length);
            range.setEnd(node,scenario.replaceAtom?node.data.length:scenario.to??scenario.at??node.data.length);
          } else {
            const point=offset=>{
              const walker=document.createTreeWalker(input,NodeFilter.SHOW_TEXT);
              for(let text;(text=walker.nextNode());) {
                if(offset<=text.data.length)return {node:text,offset};
                offset-=text.data.length;
              }
              throw new Error('Caret fixture offset lies outside actual displayed text');
            };
            const at=scenario.remove?input.textContent.indexOf(scenario.remove):scenario.at;
            if(at<0)throw new Error('Native deletion fixture does not contain its declared text');
            const from=point(at),to=point(scenario.remove?at+scenario.remove.length:scenario.to??at);
            range.setStart(from.node,from.offset);range.setEnd(to.node,to.offset);
          }
          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
          return {text:node.data,selected:selection.toString(),inside:input.contains(selection.anchorNode)};
        }, scenario);
        check(scenario.name + " places a real caret or selection inside the captured source text without replacing DOM",
          setup.inside && (scenario.remove ? setup.selected === scenario.remove :
            scenario.replaceAtom || scenario.erase || scenario.to > (scenario.at ?? 0)
              ? setup.selected.length > 0 : setup.selected === ""), setup);
      }
      const atomSnapshot = () => page(raw => {
        const cell=tableCellSession.cells[8],input=cell.input;
        return {text:input.textContent,atoms:[...input.querySelectorAll('[data-folia-cell-part]')].flatMap(node=>{
          const id=node.getAttribute('data-folia-cell-part'),fragment=cell.provenance.fragments.get(id);
          return fragment?.kind==='escape'&&fragment.raw===raw?
            [{id,text:node.textContent,retained:node.textContent===fragment.initialText}]:[];
        }),links:[...input.querySelectorAll('a')].map(node=>({text:node.textContent,href:node.getAttribute('href')}))};
      }, scenario.atomHistory);
      const initialAtoms = scenario.atomHistory ? await atomSnapshot() : null;
      if (initialAtoms) check(scenario.name + " starts with distinct escaped-atom ownership in one actual link",
        initialAtoms.atoms.length === 1 && initialAtoms.atoms[0].text === scenario.atomHistory[1] &&
        initialAtoms.links.length === 1 && initialAtoms.links[0].href === "one.md" &&
        initialAtoms.links[0].text === initialAtoms.text, initialAtoms);
      if (scenario.nativeSelectAll) {
        await exec("__cells.inputs()[8].focus();true");
        await key("A", ["control"]);
        const selected = await exec(`({
          text:getSelection().toString(),inside:__cells.inputs()[8].contains(getSelection().getRangeAt(0).commonAncestorContainer),
          start:getSelection().getRangeAt(0).startContainer.nodeName,end:getSelection().getRangeAt(0).endContainer.nodeName
        })`);
        check(scenario.name + " uses actual native Select All inside the cell before replacement",
          selected.text === "hello" && selected.inside, selected);
      }
      if (scenario.elementSelection) {
        const selected = await exec(`(() => {
          const input=__cells.inputs()[8],range=document.createRange();
          input.focus();range.selectNodeContents(input);
          getSelection().removeAllRanges();getSelection().addRange(range);
          return {text:range.toString(),start:range.startContainer===input,end:range.endContainer===input};
        })()`);
        check(scenario.name + " starts from an actual element-boundary text selection without replacing DOM",
          selected.text === "hello" && selected.start && selected.end, selected);
      }
      const replacementHistory = scenario.nativeHistory || scenario.nativeSelectAll || scenario.elementSelection || !scenario.erase &&
        (scenario.replaceAtom || scenario.to > (scenario.at ?? 0));
      const originalCellHtml = replacementHistory || scenario.nativeFormat ? await exec("__cells.inputs()[8].innerHTML") : null;
      let typed = (await typeTrustedCell([scenario.typed ?? ""], 8,
        { preserveCaret: !!scenario.atom || scenario.at !== undefined || !!scenario.remove ||
            !!scenario.nativeSelectAll || !!scenario.elementSelection,
          eraseSelection: !!scenario.erase, formatKey: scenario.nativeFormat,
          formatModifiers: scenario.formatModifiers })).at(-1);
      if (scenario.nativeFormat) {
        check(scenario.name + " blocks the actual platform-equivalent shortcut before a rich DOM mutation",
          typed.html === originalCellHtml && typed.events.some(event =>
            event.event === "keydown" && event.trusted && event.prevented &&
            event.key.toUpperCase() === scenario.nativeFormat &&
            (scenario.formatModifiers?.includes("meta") ? event.meta : event.control)) &&
          !typed.events.some(event => /^format(?:Bold|Italic|Underline)$/.test(event.type)) &&
          typed.error === "Bold, italic and underline shortcuts are not available in this popup. Existing formatting is unchanged." &&
          JSON.stringify(await state()) === JSON.stringify(before), typed);
        const edited = (await typeTrustedCell(["x"], 8, { preserveCaret: true })).at(-1);
        check(scenario.name + " still accepts actual native text input after the blocked shortcut",
          edited.events.some(event => event.event === "beforeinput" && event.trusted && event.type === "insertText") &&
          edited.html !== originalCellHtml && edited.focused && edited.caretInCell, edited);
        await key("Z", ["control"]);
        const undone = await exec("__cells.inputs()[8].innerHTML");
        check(scenario.name + " preserves one-step native cell Undo and leaves document history untouched",
          undone === originalCellHtml && JSON.stringify(await state()) === JSON.stringify(before), { originalCellHtml, undone });
        await key("Y", ["control"]);
        const redone = await exec("__cells.inputs()[8].innerHTML");
        check(scenario.name + " preserves native Redo without creating source wrappers",
          redone === edited.html, { edited, redone });
        await key("Z", ["control"]);
        const completed = await update();
        check(scenario.name + " closes an unchanged Update without a document edit or implicit Save",
          !completed.open && JSON.stringify(await state()) === JSON.stringify(before) &&
          saves.length === beforeSaves && fs.readFileSync(fixture.file, "utf8") === body, { completed, before });
        continue;
      }
      check(scenario.name + " reaches trusted native input before guarded Update",
        typed.events.some(event => event.trusted && event.type === (scenario.erase ? "deleteContentBackward" : "insertText")) &&
        JSON.stringify(await state()) === JSON.stringify(before), typed);
      let expected = scenario.expected;
      const formattingSelector = { STRONG: "strong,b", EM: "em,i", DEL: "del,s,strike" }[scenario.formattingTag];
      if (scenario.whitespaceEdge) {
        const character = scenario.whitespaceEdge === "start" ? typed.text[0] : typed.text.at(-1);
        const formatted = await exec(`__cells.inputs()[8].querySelector(${JSON.stringify(formattingSelector)})?.textContent`);
        const leading = /^[ \u00a0]+/.exec(typed.text)?.[0] || "";
        const trailing = /[ \u00a0]+$/.exec(typed.text)?.[0] || "";
        check(scenario.name + " really places the native whitespace inside its existing formatting",
          [" ", "\u00a0"].includes(character) && formatted === typed.text &&
          (scenario.whitespaceEdge === "both" ? leading.length === 2 && trailing.length === 2 &&
            formatted === leading + "hello" + trailing :
          formatted === (scenario.whitespaceEdge === "only" ? character :
            scenario.whitespaceEdge === "start" ? character + "hello" : "hello" + character)),
          { character, formatted, typed });
        expected = expected.replace("&#WS;", "&#" + character.charCodeAt(0) + ";");
        const entities = value => [...value].map(char => "&#" + char.charCodeAt(0) + ";").join("");
        expected = expected.replace("&#START;", entities(leading)).replace("&#END;", entities(trailing));
      }
      if (initialAtoms) {
        const edited = await atomSnapshot(), deleted =
          scenario.name.includes("delete-escaped") || scenario.name.includes("replace-");
        check(scenario.name + " preserves the actual surviving atom identity, not just repeated display text",
          edited.atoms.filter(atom => atom.text && atom.retained).length === (deleted ? 0 : 1) &&
          edited.atoms.every(atom => !atom.text || !atom.retained || initialAtoms.atoms.some(before =>
            atom.id === before.id && atom.text === before.text)), { initialAtoms, edited });
        await key("Z", ["control"]);
        const undone = await atomSnapshot();
        check(scenario.name + " native Undo restores the original escaped atom without a document edit",
          JSON.stringify(undone) === JSON.stringify(initialAtoms) &&
          JSON.stringify(await state()) === JSON.stringify(before), { initialAtoms, undone });
        await key("Y", ["control"]);
        const redone = await atomSnapshot();
        check(scenario.name + " native Redo restores the edited source ownership without a document edit",
          JSON.stringify(redone) === JSON.stringify(edited) &&
          JSON.stringify(await state()) === JSON.stringify(before), { edited, redone });
      }
      if (replacementHistory) {
        await key("Z", ["control"]);
        const undone = await exec("__cells.inputs()[8].innerHTML");
        check(scenario.name + " one native Undo restores exact source ownership and cell content",
          undone === originalCellHtml && JSON.stringify(await state()) === JSON.stringify(before),
          { originalCellHtml, undone });
        await key("Y", ["control"]);
        const redone = await exec(`({
          html:__cells.inputs()[8].innerHTML,inside:__cells.inputs()[8].contains(getSelection().anchorNode)
        })`);
        check(scenario.name + " one native Redo restores exact edited ownership and an in-cell caret",
          redone.html === typed.html && redone.inside && JSON.stringify(await state()) === JSON.stringify(before),
          { typed, redone });
      }
      if (scenario.repeatReplacement) {
        const first = typed;
        typed = (await typeTrustedCell([scenario.repeatReplacement], 8, { replace: true })).at(-1);
        check(scenario.name + " reaches a second trusted replacement in the same owned cell",
          typed.text === scenario.repeatReplacement && typed.events.some(event =>
            event.trusted && event.type === "insertText") &&
          JSON.stringify(await state()) === JSON.stringify(before), typed);
        await key("Z", ["control"]);
        const undone = await exec("__cells.inputs()[8].innerHTML");
        check(scenario.name + " one native Undo restores only the first replacement",
          undone === first.html && JSON.stringify(await state()) === JSON.stringify(before), { first, undone });
        await key("Y", ["control"]);
        const redone = await exec("__cells.inputs()[8].innerHTML");
        check(scenario.name + " one native Redo restores the second replacement without losing ownership",
          redone === typed.html && JSON.stringify(await state()) === JSON.stringify(before), { typed, redone });
      }
      const completion = await update(), after = await state();
      check(scenario.name + " keeps unchanged spelling and source atoms without an editor wrapper",
        !completion.open && !completion.error && after.exact === replaceScenario(expected) &&
        after.undo === before.undo + 1 && saves.length === beforeSaves &&
        fs.readFileSync(fixture.file, "utf8") === body, { completion, after, scenario });
      if (completion.open) await cancel();
      else if (scenario.targets || scenario.formattingTag || initialAtoms || replacementHistory) {
        await openGrid();
        if (replacementHistory) check(scenario.name + " reopens with the exact replacement text",
          await exec("__cells.inputs()[8].textContent===" + JSON.stringify(typed.text)), typed);
        if (initialStructure) check(scenario.name + " reopens with the same actual nested formatting and protected barriers",
          JSON.stringify(await formattingStructure()) === JSON.stringify(scenario.expectedStructure || initialStructure),
          await formattingStructure());
        if (scenario.targets) check(scenario.name + " reopens as the same actual semantic nodes after clean Markdown normalization",
          JSON.stringify(await targets()) === JSON.stringify(scenario.targets), await targets());
        if (scenario.formattingTag) {
          const formatted = await exec(`__cells.inputs()[8].querySelector(${JSON.stringify(formattingSelector)})?.textContent`);
          check(scenario.name + " reopens with the exact native whitespace and formatting",
            formatted === typed.text, { formatted, typed });
        }
        if (initialAtoms) {
          const reopened = await atomSnapshot();
          check(scenario.name + " reopens as the intended actual link and destination",
            reopened.links.length === 1 && reopened.links[0].href === "one.md" &&
            reopened.links[0].text === typed.text && reopened.text === typed.text, reopened);
        }
        await cancel();
      }
    }
    const unmatchedBody = replacePlain("`` prefix"), unmatchedFixture = await fresh("loaded-outer-run", unmatchedBody);
    const unmatchedBefore = await state(), unmatchedSaves = saves.length;
    await openGrid();
    const laterCode = (await typeTrustedCell([" ", "`", "x", "`"], 8)).at(-1);
    check("loaded unmatched delimiter does not veto a later valid code span during real typing",
      laterCode.codes.length === 1 && laterCode.codes[0] === "x" &&
      laterCode.text === "`` prefix x" &&
      JSON.stringify(await state()) === JSON.stringify(unmatchedBefore), laterCode);
    const unmatchedCompletion = await update(), unmatchedAfter = await state();
    check("later live code preserves the loaded unmatched source prefix exactly after Update",
      !unmatchedCompletion.open && !unmatchedCompletion.error &&
      unmatchedAfter.exact === replacePlain("`` prefix `x`") &&
      unmatchedAfter.undo === unmatchedBefore.undo + 1 && saves.length === unmatchedSaves &&
      fs.readFileSync(unmatchedFixture.file, "utf8") === unmatchedBody, { unmatchedCompletion, unmatchedAfter });
    if (unmatchedCompletion.open) await cancel();
    for (const navigation of ["focus", "pointer", "arrow"]) {
      const body = replacePlain(""), fixture = await fresh("abandoned-opener-" + navigation, body);
      const sourceSlot = body.lastIndexOf("|  |") + 3;
      const before = await state(), beforeSaves = saves.length;
      await openGrid();
      const started = (await typeTrustedCell(["`", "`", " prefix "], 8)).at(-1);
      check(navigation + " starts a real typed unmatched outer delimiter before any composition",
        sourceSlot >= 3 && body.slice(sourceSlot - 3, sourceSlot + 1) === "|  |" &&
        started.text === "`` prefix " && started.codes.length === 0 &&
        started.events.some(event => event.trusted && event.type === "insertText"), started);
      if (navigation === "focus") {
        await key("Tab");
        check("native Tab actually leaves the cell with the abandoned opener",
          await exec("document.activeElement===tableCellSession.cells[9].input"));
      } else if (navigation === "arrow") {
        await key("Left");
        await key("Right");
      } else {
        const point = await exec(`(() => {
          const input=tableCellSession.cells[8].input,rect=input.getBoundingClientRect();
          const point={x:Math.round(rect.left+6),y:Math.round(rect.top+rect.height/2)};
          return {...point,hit:input.contains(document.elementFromPoint(point.x,point.y))};
        })()`);
        check("native pointer reset actually targets the same cell", point.hit, point);
        win.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
        win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: point.x, y: point.y });
        win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: point.x, y: point.y });
        await settle();
      }
      const later = (await typeTrustedCell(["`", "x", "`"], 8)).at(-1);
      check(navigation + " navigation abandons the old opener and formats later code immediately",
        JSON.stringify(later.codes) === '["x"]' && later.text === "`` prefix x" &&
        JSON.stringify(await state()) === JSON.stringify(before), later);
      const completion = await update(), after = await state();
      check(navigation + " navigation keeps new code and literal abandoned ticks in one document Update",
        !completion.open && !completion.error &&
        after.exact === body.slice(0, sourceSlot) + "&#96;&#96; prefix `x`" + body.slice(sourceSlot) &&
        after.undo === before.undo + 1 && saves.length === beforeSaves &&
        fs.readFileSync(fixture.file, "utf8") === body, { completion, after });
      if (completion.open) await cancel();
    }
    for (const scenario of [
      { name: "strong-bracket", source: "**a\\[b** end", text: "a[b end" },
      { name: "emphasis-bracket", source: "*a\\[b* end", text: "a[b end" },
      { name: "strike-bracket", source: "~~a\\[b~~ end", text: "a[b end" },
    ]) {
      const body = replacePlain(scenario.source), fixture = await fresh(scenario.name, body);
      const before = await state(), beforeSaves = saves.length;
      check(scenario.name + " is an ordinary rendered table with the expected authored formatting",
        await exec("viewer.querySelectorAll('table')[1].rows[2].cells[2].textContent===" + JSON.stringify(scenario.text)));
      await openGrid();
      const typed = (await typeTrustedCell([" tail"], 8)).at(-1);
      check(scenario.name + " remains editable through actual native neighbor typing",
        typed.text === scenario.text + " tail" &&
        typed.events.some(event => event.trusted && event.type === "insertText"), typed);
      const completion = await update(), after = await state();
      check(scenario.name + " retains its exact nested bracket escapes and all non-target bytes",
        !completion.open && !completion.error &&
        after.exact === replacePlain(scenario.source + " tail") &&
        after.undo === before.undo + 1 && saves.length === beforeSaves &&
        fs.readFileSync(fixture.file, "utf8") === body, { completion, after });
    }
    for (const scenario of [
      { name: "retained-decimal-alias", source: "literal &#58;star:", text: "literal :star:",
        expected: "<code>literal &#58;star:</code>" },
      { name: "retained-hex-alias", source: "literal &#x3a;star:", text: "literal :star:",
        expected: "<code>literal &#x3a;star:</code>" },
      { name: "retained-emoji-alias", source: "literal :star:", text: "literal ⭐",
        expected: "`literal :star:`" },
      { name: "retained-markdown-escapes", source: "literal \\*star\\*", text: "literal *star*",
        expected: "`literal *star*`" },
      { name: "retained-entity-backticks", source: "literal &#96;tick&#96;", text: "literal `tick`",
        delimiter: "``", padding: true, expected: "`` literal `tick` ``" },
      { name: "retained-inner-alias-entity", source: ":st&#97;r:", text: ":star:",
        expected: "<code>:st&#97;r:</code>" },
      { name: "mixed-code-provenance", source: "&#58;star: :star: ⭐", text: ":star: ⭐ ⭐",
        expected: "<code>&#58;star: :star: ⭐</code>" },
    ]) {
      const body = replacePlain(scenario.source), fixture = await fresh(scenario.name, body);
      const before = await state(), beforeSaves = saves.length;
      await openGrid();
      const initial = await page(() => {
        const cell=tableCellSession.cells[8],input=cell.input;
        input.focus();const range=document.createRange();range.selectNodeContents(input);range.collapse(true);
        const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
        return {text:input.textContent,codes:input.querySelectorAll('code').length,
          atoms:[...cell.provenance.fragments.values()].filter(part=>['escape','emoji'].includes(part.kind)).map(part=>part.raw)};
      });
      check(scenario.name + " starts with real retained source atoms and a native insertion caret",
        initial.text === scenario.text && initial.codes === 0 && initial.atoms.length > 0, initial);
      await typeTrustedCell([(scenario.delimiter || "`") + (scenario.padding ? " " : "")],
        8, { preserveCaret: true });
      const closed = (await typeTrustedCell([(scenario.padding ? " " : "") + (scenario.delimiter || "`")], 8)).at(-1);
      check(scenario.name + " formats immediately without changing retained literal content",
        JSON.stringify(closed.codes) === JSON.stringify([scenario.text]) &&
        closed.text === scenario.text && closed.focused && closed.caretInCell && !closed.caretInCode &&
        closed.events.some(event => event.trusted && event.type === "insertText") &&
        JSON.stringify(await state()) === JSON.stringify(before), closed);
      await key("Z", ["control"]);
      const undone = await exec("({codes:tableCellSession.cells[8].input.querySelectorAll('code').length,text:tableCellSession.cells[8].input.textContent})");
      check(scenario.name + " retains native cell Undo without altering the document",
        undone.codes === 0 && undone.text.includes(scenario.text) &&
        JSON.stringify(await state()) === JSON.stringify(before), undone);
      await key("Y", ["control"]);
      const redone = await exec("({codes:[...tableCellSession.cells[8].input.querySelectorAll('code')].map(node=>node.textContent),text:tableCellSession.cells[8].input.textContent})");
      check(scenario.name + " restores the faithful live code through native Redo",
        JSON.stringify(redone.codes) === JSON.stringify([scenario.text]) && redone.text === scenario.text, redone);
      const completion = await update(), after = await state();
      check(scenario.name + " uses faithful code source in one guarded document Update",
        !completion.open && !completion.error && after.exact === replacePlain(scenario.expected) &&
        after.undo === before.undo + 1 && saves.length === beforeSaves &&
        fs.readFileSync(fixture.file, "utf8") === body, { completion, after });
      if (completion.open) await cancel();
      else {
        await openGrid();
        const reopened = await exec("({codes:[...tableCellSession.cells[8].input.querySelectorAll('code')].map(node=>node.textContent),text:tableCellSession.cells[8].input.textContent})");
        check(scenario.name + " reopens with the same immediate code display and source meaning",
          JSON.stringify(reopened.codes) === JSON.stringify([scenario.text]) && reopened.text === scenario.text, reopened);
        await cancel();
      }
    }
    await fresh("new-typed-code-alias");
    const freshCodeBefore = await state();
    await openGrid();
    const freshCode = (await typeTrustedCell(["`", ":star:", "`"], 8, { replace: true })).at(-1);
    check("newly typed code keeps the existing emoji pipeline rather than a new literal-code policy",
      JSON.stringify(freshCode.codes) === '["⭐"]' && freshCode.text === "⭐" &&
      JSON.stringify(await state()) === JSON.stringify(freshCodeBefore), freshCode);
    await cancel();
    const authored = '<span data-folia-cell-part="author">authored</span> ' +
      '<span DATA-FOLIA-CELL-PART=\'upper\'>case</span> ' +
      '<strong data-folia-cell-part="replacement">bold</strong> ' +
      '<span style="color: red" data-folia-cell-code="history-author">styled</span> ' +
      '\\`literal\\` <span class="noted-text" data-note-id="73" data-note-title="Title &amp; value" ' +
      'data-note-content="keep" data-note-color="#c0ffee">noted</span> ' +
      '<code data-folia-cell-part="code-author" data-folia-cell-code="source-code">loaded</code> end';
    const authoredBody = replacePlain(authored), authoredFixture = await fresh("authored-inline", authoredBody);
    const authoredBefore = await state(), authoredSaves = saves.length;
    const authoredCapture = await exec(`(() => {
      const model=FoliaTableCells.index(window.CustomTabs.snapshotExactEditorContent(),marked,protectTableSource);
      const cell=model.tables[1].rows[2].cells[2],input=document.createElement('div');
      try {
        const provenance=FoliaTableCells.prepareCell(input,cell.text,${JSON.stringify(authored)},marked,model.links,parseEmojis,sanitizeTableHtml);
        const refused=operation=>{
          try {operation();return false;}
          catch(error){if(error.message!=='tableCells.cellType')throw error;return true;}
        };
        const unknown=input.cloneNode(true),duplicate=input.cloneNode(true);
        unknown.querySelector('['+provenance.partAttribute+']').setAttribute(provenance.partAttribute,'unknown');
        duplicate.append(duplicate.querySelector('['+provenance.partAttribute+']').cloneNode(true));
        const duplicateSource=serializeSafeTableCell(duplicate,provenance);
        duplicate.lastElementChild.textContent='again';
        return {html:input.innerHTML,serialized:serializeSafeTableCell(input,provenance),
          privatePart:provenance.partAttribute,privateCode:provenance.codeAttribute,
          authored:input.querySelector('[data-folia-cell-part="author"]')?.textContent,
          upper:input.querySelector('[data-folia-cell-part="upper"]')?.textContent,
          unknownRefused:refused(()=>serializeSafeTableCell(unknown,provenance)),
          duplicateSource,editedRepeat:serializeSafeTableCell(duplicate,provenance)};
      } catch(error) {return {html:input.innerHTML,error:error.stack};}
    })()`);
    check("authored spans and literal escapes pass the same safe source capture as ordinary cells",
      !authoredCapture.error, authoredCapture);
    if (authoredCapture.error) throw new Error("Authored cell capture failed: " + JSON.stringify(authoredCapture));
    check("authored marker-like attributes and repeated intact source remain exact while unknown capture IDs refuse",
      authoredCapture.serialized === authored && authoredCapture.authored === "authored" &&
      authoredCapture.upper === "case" && authoredCapture.privatePart !== "data-folia-cell-part" &&
      authoredCapture.privateCode !== "data-folia-cell-code" &&
      authoredCapture.unknownRefused &&
      authoredCapture.duplicateSource === authored + '<span data-folia-cell-part="author">authored</span>' &&
      authoredCapture.editedRepeat === authored + '<span data-folia-cell-part="author">again</span>', authoredCapture);
    await openGrid();
    const neighbor = (await typeTrustedCell([" tail"], 8)).at(-1);
    check("real neighbor typing leaves authored spans notes and escaped literal backticks intact",
      neighbor.text.includes("`literal`") && neighbor.codes.length === 1 && neighbor.codes[0] === "loaded" &&
      neighbor.events.some(event => event.trusted && event.type === "insertText") &&
      JSON.stringify(await state()) === JSON.stringify(authoredBefore), neighbor);
    await screenshot("authored-inline-cell");
    const authoredCompletion = await update(), authoredAfter = await state();
    check("authored bare styled and note spans retain exact spelling without an additional editor wrapper",
      !authoredCompletion.open && !authoredCompletion.error &&
      authoredAfter.exact === replacePlain(authored + " tail") &&
      authoredAfter.undo === authoredBefore.undo + 1 && saves.length === authoredSaves &&
      fs.readFileSync(authoredFixture.file, "utf8") === authoredBody, { authoredCompletion, authoredAfter });
    await openGrid();
    await exec(`(() => {
      const input=__cells.inputs()[8];input.focus();
      const range=document.createRange();range.selectNodeContents(input.querySelector('strong'));
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      return true;
    })()`);
    const replaced = (await typeTrustedCell(["new"], 8, { preserveCaret: true })).at(-1);
    check("native replacement retains the actual authored owner despite colliding source attribute names",
      replaced.text.includes("case new styled") && replaced.events.some(event=>event.trusted) &&
      JSON.stringify(await state()) === JSON.stringify(authoredAfter), replaced);
    const liveOwned = (await typeTrustedCell([" `", "z", "`"], 8)).at(-1);
    check("live code in a collision-bearing cell shares its capture context without claiming authored code markers",
      JSON.stringify(liveOwned.codes) === '["loaded","z"]' && !liveOwned.caretInCode, liveOwned);
    await key("Z", ["control"]);
    check("collision-bearing live code Undo preserves the authored source CODE",
      await exec("JSON.stringify([...__cells.inputs()[8].querySelectorAll('code')].map(code=>code.textContent))==='[\"loaded\"]'") &&
      JSON.stringify(await state()) === JSON.stringify(authoredAfter));
    await key("Y", ["control"]);
    check("collision-bearing live code Redo restores exact DOM and the generated caret, not an authored history marker",
      await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(liveOwned.html)) &&
      await exec("!getSelection().anchorNode.parentElement.closest('code')") &&
      JSON.stringify(await state()) === JSON.stringify(authoredAfter));
    const ownedCompletion = await update(), ownedAfter = await state();
    const ownedExpected = replacePlain(authored.replace(">bold</strong>", ">new</strong>") + " tail `z`");
    check("replacement and live code preserve exact authored attributes and exclude actual private metadata from Markdown",
      !ownedCompletion.open && !ownedCompletion.error && ownedAfter.exact === ownedExpected &&
      ownedAfter.cache === ownedExpected && ownedAfter.undo === authoredAfter.undo + 1 &&
      saves.length === authoredSaves && fs.readFileSync(authoredFixture.file, "utf8") === authoredBody,
      { ownedCompletion, ownedAfter, ownedExpected });

    const imeFixture = await fresh("native-composition"), imeBefore = await state(), imeSaves = saves.length;
    await openGrid();
    await typeTrustedCell([], 8, { replace: true });
    await exec(`(() => {
      const input=__cells.inputs()[8];window.__cellComposition=[];
      window.__cellCompositionListener=e=>window.__cellComposition.push({
        type:e.type,inputType:e.inputType,data:e.data,trusted:e.isTrusted,composing:e.isComposing});
      for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input'])
        input.addEventListener(type,window.__cellCompositionListener);
      return true;
    })()`);
    try {
      await bounded("native Chromium composition update", win.webContents.debugger.sendCommand("Input.imeSetComposition",
        { text: "`ime`", selectionStart: 5, selectionEnd: 5 }));
      const composing = await exec(`({text:__cells.inputs()[8].textContent,codes:__cells.inputs()[8].querySelectorAll('code').length,
        events:window.__cellComposition.slice()})`);
      check("actual Chromium composition remains unmodified while the IME range is active",
        composing.text === "`ime`" && composing.codes === 0 &&
        composing.events.some(event => event.type === "compositionstart" && event.trusted) &&
        composing.events.some(event => event.type === "input" && event.trusted && event.composing) &&
        JSON.stringify(await state()) === JSON.stringify(imeBefore), composing);
      await bounded("native Chromium composition commit", win.webContents.debugger.sendCommand("Input.insertText", { text: "`ime`" }));
      const committed = await exec(`({html:__cells.inputs()[8].innerHTML,text:__cells.inputs()[8].textContent,
        codes:[...__cells.inputs()[8].querySelectorAll('code')].map(code=>code.textContent),
        events:window.__cellComposition.slice()})`);
      // CDP ends the trusted Chromium composition with an untrusted compositionend.
      check("committed Chromium composition formats code once before blur or document Update",
        committed.text === "ime" && JSON.stringify(committed.codes) === '["ime"]' &&
        committed.events.some(event => event.type === "compositionend" && event.data === "`ime`") &&
        JSON.stringify(await state()) === JSON.stringify(imeBefore), committed);
      await key("Z", ["control"]);
      const imeUndone = await exec("({text:__cells.inputs()[8].textContent,codes:__cells.inputs()[8].querySelectorAll('code').length})");
      check("native Undo reverses composition formatting without restarting conversion or changing the document",
        committed.codes.length === 1 && imeUndone.text === "`ime`" && imeUndone.codes === 0 &&
        JSON.stringify(await state()) === JSON.stringify(imeBefore), imeUndone);
      await key("Y", ["control"]);
      check("native Redo restores the committed composition code without a source edit",
        await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(committed.html)) &&
        JSON.stringify(await state()) === JSON.stringify(imeBefore));
      const imeContinued = (await typeTrustedCell([" tail"], 8, { preserveCaret: true })).at(-1);
      check("typing after committed composition stays outside the restored code node",
        JSON.stringify(imeContinued.codes) === '["ime"]' && imeContinued.text === "ime tail" &&
        !imeContinued.caretInCode, imeContinued);
    } finally {
      await exec(`(() => {
        const input=__cells.inputs()[8];
        for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input'])
          input.removeEventListener(type,window.__cellCompositionListener);
        delete window.__cellCompositionListener;delete window.__cellComposition;return true;
      })()`);
    }
    const imeCompletion = await update(), imeAfter = await state();
    check("native composition code updates Markdown once without saving or changing other source bytes",
      !imeCompletion.open && !imeCompletion.error && imeAfter.exact === replacePlain("`ime` tail") &&
      imeAfter.undo === imeBefore.undo + 1 && saves.length === imeSaves &&
      fs.readFileSync(imeFixture.file, "utf8") === original, { imeCompletion, imeAfter });
  }
  async function click() {
    const nativeClick = async point => {
      win.webContents.sendInputEvent({ type: "mouseMove", ...point });
      win.webContents.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, ...point });
      await wait("trusted table context menu", "contextMenu.classList.contains('visible')");
    };
    await fresh("empty-text-row-selection", "# Empty selection\n\n| | |\n| - | - |\n| | |");
    const emptyBefore = await state(), emptySaves = saves.length;
    for (const scope of ["table", "row"]) {
      const selected = await page(scope => {
        const table=viewer.querySelector('table'),range=document.createRange();
        range.selectNode(scope==='table'?table:table.rows[1]);
        getSelection().removeAllRanges();getSelection().addRange(range);
        __cells.rightClick(table.rows[1].cells[0]);
        return {collapsed:range.collapsed,text:range.toString(),action:__cells.action(true)};
      }, scope);
      check(scope + " empty-text selected-rows setup has a real noncollapsed range without selected text",
        !selected.collapsed && !selected.text.trim(), selected);
      check(scope + " empty-text selection cannot open Edit selected rows",
        !selected.action.opened && selected.action.error ===
          "Select a table or its rows first. The selection must contain exactly one table.", selected);
      if (selected.action.opened) await cancel();
    }
    check("empty-text row selection leaves source history and saves unchanged",
      JSON.stringify(await state()) === JSON.stringify(emptyBefore) && saves.length === emptySaves);
    const sourceWhitespace = await page(() => {
      const start=markdownEditor.value.lastIndexOf('| | |')+1;
      __cells.source(start,start+1);
      return {text:markdownEditor.value.slice(start,start+1),action:__cells.action(true)};
    });
    check("Markdown whitespace selection really selects a nonempty blank inside the table row",
      sourceWhitespace.text === " ", sourceWhitespace);
    check("Markdown whitespace-only selection cannot open Edit selected rows",
      !sourceWhitespace.action.opened && sourceWhitespace.action.error ===
        "Select a table or its rows first. The selection must contain exactly one table.", sourceWhitespace);
    if (sourceWhitespace.action.opened) await cancel();
    const sourceSyntax = await page(() => {
      const start=markdownEditor.value.lastIndexOf('| | |'),end=start+'| | |'.length;
      __cells.source(start,end);
      return {text:markdownEditor.value.slice(start,end),action:__cells.action(true)};
    });
    check("Markdown syntax-only row selection really contains pipes without any cell text",
      sourceSyntax.text === "| | |" && sourceSyntax.text.trim().length > 0, sourceSyntax);
    check("Markdown syntax-only row selection cannot open Edit selected rows",
      !sourceSyntax.action.opened && sourceSyntax.action.error ===
        "Select a table or its rows first. The selection must contain exactly one table.", sourceSyntax);
    if (sourceSyntax.action.opened) await cancel();
    await fresh("image-only-row-selection", '# Image selection\n\n| <img alt="header"> |\n| - |\n| <img alt="body"> |');
    const imageBefore = await state(), imageSaves = saves.length;
    const imageSelection = await page(() => {
      const table=viewer.querySelector('table'),range=document.createRange();
      range.selectNode(table.rows[1].cells[0].querySelector('img'));
      getSelection().removeAllRanges();getSelection().addRange(range);
      __cells.rightClick(table.rows[1].cells[0]);
      return {collapsed:range.collapsed,text:range.toString(),images:range.cloneContents().querySelectorAll('img').length,
        action:__cells.action(true)};
    });
    check("image-only selected-rows setup selects a real image without text",
      !imageSelection.collapsed && !imageSelection.text.trim() && imageSelection.images === 1, imageSelection);
    check("image-only selection does not substitute for the required selected text",
      !imageSelection.action.opened && imageSelection.action.error ===
        "Select a table or its rows first. The selection must contain exactly one table.", imageSelection);
    if (imageSelection.action.opened) await cancel();
    check("image-only row selection leaves source history and saves unchanged",
      JSON.stringify(await state()) === JSON.stringify(imageBefore) && saves.length === imageSaves);
    const body = "# Click\n\n| A | B |\n| - | - |\n| one | two |\n\n| C | D |\n| - | - |\n| three | four |";
    await fresh("clicked-table", body);
    const before = await state(), beforeSaves = saves.length, second = body.indexOf("| C |");
    for (const origin of ["preview", "markdown"]) {
      for (const selectionKind of ["empty", "unrelated", "multiple"]) {
        const setup = await page((origin, kind, second) => {
          hideContextMenu();
          const tables=viewer.querySelectorAll('table'),selection=getSelection();
          selection.removeAllRanges();
          if(origin==='markdown') {
            markdownEditor.focus();
            markdownEditor.setSelectionRange(0,kind==='empty'?0:kind==='multiple'?markdownEditor.value.length:3,'backward');
          } else if(kind!=='empty') {
            const range=document.createRange();
            range.setStartBefore(tables[0]);
            range.setEndAfter(tables[kind==='multiple'?1:0]);
            if(kind==='unrelated')selection.setBaseAndExtent(range.endContainer,range.endOffset,range.startContainer,range.startOffset);
            else selection.addRange(range);
          }
          window.__cellClickRange=selection.rangeCount?selection.getRangeAt(0).cloneRange():null;
          window.__cellClickDirection={anchorNode:selection.anchorNode,anchorOffset:selection.anchorOffset,
            focusNode:selection.focusNode,focusOffset:selection.focusOffset};
          const source=[markdownEditor.selectionStart,markdownEditor.selectionEnd,markdownEditor.selectionDirection];
          const target=tables[1].rows[1].cells[0],rect=target.getBoundingClientRect();
          const point=origin==='markdown'?__cells.sourcePoint(second):{
            x:Math.round(rect.left+8),y:Math.round(rect.top+rect.height/2)};
          const hit=document.elementFromPoint(point.x,point.y);
          return {point,source,hit:origin==='markdown'?hit===markdownEditor:!!tables[1].contains(hit),
            mapped:origin==='markdown'?editorScroll.sourceLineAt(point.x,point.y):null};
        }, origin, selectionKind, second);
        check(origin + " " + selectionKind + " click actor reaches the independently located second table",
          setup.hit && (origin !== "markdown" || setup.mapped?.start === second), setup);
        await nativeClick(setup.point);
        const opened = await page(() => __cells.action(false));
        check(origin + " " + selectionKind + " Edit table uses the actual clicked table without manufacturing a selection",
          opened.opened && opened.count === 4 &&
          await exec("__cells.inputs()[0].textContent==='C'&&__cells.inputs()[1].textContent==='D'") &&
          JSON.stringify(await state()) === JSON.stringify(before), opened);
        await cancel();
        const restored = await page((origin, source) => {
          if(origin==='markdown') return JSON.stringify([markdownEditor.selectionStart,markdownEditor.selectionEnd,
            markdownEditor.selectionDirection])===JSON.stringify(source);
          const selection=getSelection(),saved=window.__cellClickRange,direction=window.__cellClickDirection;
          return saved?selection.rangeCount===1&&selection.getRangeAt(0).compareBoundaryPoints(Range.START_TO_START,saved)===0&&
            selection.getRangeAt(0).compareBoundaryPoints(Range.END_TO_END,saved)===0&&
            selection.anchorNode===direction.anchorNode&&selection.anchorOffset===direction.anchorOffset&&
            selection.focusNode===direction.focusNode&&selection.focusOffset===direction.focusOffset:selection.rangeCount===0;
        }, origin, setup.source);
        check(origin + " " + selectionKind + " right-click and Cancel preserve the user's original selection", restored, setup);
      }
      const outside = await page(origin => {
        const table=viewer.querySelector('table'),selection=getSelection();
        selection.removeAllRanges();
        if(origin==='markdown')__cells.source(0,markdownEditor.value.length,0);
        else {const range=document.createRange();range.selectNode(table);selection.addRange(range);
          __cells.rightClick(viewer.querySelector('h1'));}
        return __cells.action(false);
      }, origin);
      check(origin + " outside-table click never falls back to an unrelated table selection",
        !outside.opened && outside.error === "Right-click inside a table to edit it.", outside);
      const missingPoint = await page(origin => {
        hideContextMenu();
        getSelection().removeAllRanges();
        if(origin==='markdown'){
          markdownEditor.focus();markdownEditor.setSelectionRange(0,0);
          return __cells.sourcePoint(markdownEditor.value.indexOf('| C |'));
        }
        const rect=viewer.querySelectorAll('table')[1].rows[1].cells[0].getBoundingClientRect();
        return {x:Math.round(rect.left+8),y:Math.round(rect.top+rect.height/2)};
      }, origin);
      await nativeClick(missingPoint);
      const missingRows = await page(() => __cells.action(true));
      check(origin + " Edit selected rows still requires a real nonempty text selection",
        !missingRows.opened && missingRows.error === "Select a table or its rows first. The selection must contain exactly one table.",
        missingRows);
    }
    const icon = await exec(`(() => {
      const button=document.getElementById('ctxEditSelectedRows'),icon=button.querySelector('svg'),label=button.querySelector('[data-i18n]');
      return {leading:!!icon&&icon.nextElementSibling===label,hidden:icon?.getAttribute('aria-hidden'),
        size:icon&&[icon.getAttribute('width'),icon.getAttribute('height')],label:label?.textContent};
    })()`);
    check("Edit selected rows has a decorative leading icon consistent with the context menu",
      icon.leading && icon.hidden === "true" && JSON.stringify(icon.size) === '["16","16"]' &&
      icon.label === "Edit selected rows", icon);
    check("click-target cases leave document history source and saves unchanged",
      JSON.stringify(await state()) === JSON.stringify(before) && saves.length === beforeSaves);
    await exec("delete window.__cellClickRange;delete window.__cellClickDirection;true");
    const expectedNotice = "Select a table or its rows first. The selection must contain exactly one table.";
    await wait("qualified empty-row-selection notice expires normally", `(() => {
      const toast=document.getElementById('notificationToast');
      if(document.getElementById('notificationMessage').textContent!==${JSON.stringify(expectedNotice)})
        throw new Error('Unexpected notification replaced the empty-row-selection rejection');
      return !toast.classList.contains('show')&&getComputedStyle(toast).opacity==='0'&&
        toast.getAnimations().every(animation=>!animation.pending&&animation.playState==='finished');
    })()`, 8300);
    for (const scenario of [
      { name: "BOM first header", body: "\uFEFF| A | B |\n| - | - |\n| one | two |\n\n# BOM click", heading: "BOM click", at: 0 },
      { name: "terminal trailing spaces", body: "# Trailing click\n\n| A | B |\n| - | - |\n| one | two |   ",
        heading: "Trailing click", marker: "| one |" },
      { name: "wrapped scrolled row", body: "# Wrapped click\n\n" + "Leading prose.\n".repeat(24) +
        "\n| A | B |\n| - | - |\n| " + "wide ".repeat(200) + "| two |",
        heading: "Wrapped click", marker: "| wide", visualLine: 3 },
      { name: "scaled wrapped row", body: "# Scaled click\n\n| A | B |\n| - | - |\n| " + "wide ".repeat(200) + "| two |",
        heading: "Scaled click", marker: "| wide", visualLine: 3, scale: true },
    ]) {
      const fixture = await fresh("point-" + scenario.heading, scenario.body, scenario.heading);
      const before = await state(), beforeSaves = saves.length;
      const at = scenario.at ?? lf(scenario.body).indexOf(scenario.marker);
      const setup = await page((at, visualLine, scale) => {
        const oldStyle=markdownEditor.getAttribute('style');
        if(scale){markdownEditor.style.transform='scale(.85)';markdownEditor.style.transformOrigin='top left';}
        markdownEditor.focus();markdownEditor.setSelectionRange(0,0);
        const point=__cells.sourcePoint(at,visualLine||0),style=getComputedStyle(markdownEditor);
        return {point,oldStyle,hit:document.elementFromPoint(point.x,point.y)===markdownEditor,
          mapped:editorScroll.sourceLineAt(point.x,point.y),scroll:markdownEditor.scrollTop,
          wrapped:markdownEditor.scrollHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)>
            (markdownEditor.value.split('\n').length+3)*parseFloat(style.lineHeight)};
      }, at, scenario.visualLine, scenario.scale);
      check(scenario.name + " uses an independent native-textarea point with the required actual layout",
        setup.hit && setup.mapped?.start === at && (!scenario.visualLine || setup.wrapped) &&
        (scenario.name !== "wrapped scrolled row" || setup.scroll > 0), setup);
      try {
        await nativeClick(setup.point);
        const opened = await page(() => __cells.action(false));
        check(scenario.name + " opens its exact table by native right click without a selection",
          opened.opened && opened.count === 4 && await exec("__cells.inputs()[0].textContent==='A'") &&
          JSON.stringify(await state()) === JSON.stringify(before), opened);
        await cancel();
      } finally {
        await page(style => {if(style===null)markdownEditor.removeAttribute('style');else markdownEditor.setAttribute('style',style);},
          setup.oldStyle);
      }
      const boundaries = await exec(`(() => {
        const rect=markdownEditor.getBoundingClientRect(),style=getComputedStyle(markdownEditor);
        return {left:editorScroll.sourceLineAt(rect.left+1,rect.top+50),
          right:editorScroll.sourceLineAt(rect.right-1,rect.top+50),
          top:editorScroll.sourceLineAt(rect.left+50,rect.top+1)};
      })()`);
      check(scenario.name + " excludes padding and scrollbar targets and preserves the exact document",
        Object.values(boundaries).every(value => value === null) &&
        JSON.stringify(await state()) === JSON.stringify(before) && saves.length === beforeSaves &&
        fs.readFileSync(fixture.file, "utf8") === scenario.body, boundaries);
    }
  }
  async function transaction() {
    const fixture = await fresh("transaction");
    const before = await state(), beforeSaves = saves.length;
    const sourceStart = lf(original.slice(0, secondOffset - between.length + 2)).length;
    await page((from, to, at) => __cells.source(from, to, at), sourceStart, lf(original).length, lf(original.slice(0, secondOffset)).length);
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
    const subsetExpected = original.slice(0, editedOffset) + "only &#124; row" +
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
    const edited = original.slice(0, editedOffset) + "history table" +
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
  async function formatting() {
    const offset = secondOffset + table.indexOf("| plain |") + 2;
    const replaced = source => original.slice(0, offset) + source + original.slice(offset + "plain".length);
    for (const scenario of [
      { name: "typed bold", opening: "**", body: "bold", strong: 1, em: 0 },
      { name: "typed italic", opening: "*", body: "italic", strong: 0, em: 1 },
      { name: "typed nested emphasis", opening: "***", body: "nested", strong: 1, em: 1 },
    ]) {
      const fixture = await fresh(scenario.name), before = await state(), saveCount = saves.length;
      await openGrid();
      const parts = [...scenario.opening, scenario.body, ...scenario.opening];
      const snapshots = await typeTrustedCell(parts.slice(0, -1), 8, { replace: true });
      const partial = await exec(`({text:__cells.inputs()[8].textContent,
        formatted:__cells.inputs()[8].querySelectorAll('strong,em').length})`);
      check(scenario.name + " preserves the incomplete opener and closing run through trusted typing",
        snapshots.every(snapshot => snapshot.events.some(event =>
          event.event === "beforeinput" && event.trusted && event.type === "insertText")) &&
        partial.formatted === 0 && partial.text === parts.slice(0, -1).join(""), { snapshots, partial });
      const live = (await typeTrustedCell([scenario.opening.at(-1)], 8, { preserveCaret: true })).at(-1);
      const semantics = await exec(`(() => {
        const input=__cells.inputs()[8],selection=getSelection(),node=selection.anchorNode;
        const parent=node?.nodeType===Node.ELEMENT_NODE?node:node?.parentElement;
        return {strong:input.querySelectorAll('strong').length,em:input.querySelectorAll('em').length,
          nested:!!input.querySelector('em>strong'),inside:!!parent?.closest('strong,em')};
      })()`);
      check(scenario.name + " formats immediately before blur or Update without a document transaction",
        live.text === scenario.body && semantics.strong === scenario.strong && semantics.em === scenario.em &&
        (scenario.opening.length !== 3 || semantics.nested) && live.focused && live.collapsed &&
        live.caretInCell && !semantics.inside && !live.error &&
        JSON.stringify(await state()) === JSON.stringify(before) && saves.length === saveCount,
        { live, semantics });
      if (scenario.opening.length === 3) await screenshot("immediate-typed-emphasis");
      await key("Z", ["control"]);
      const undone = await exec(`({text:__cells.inputs()[8].textContent,
        formatted:__cells.inputs()[8].querySelectorAll('strong,em').length,
        selection:getSelection().toString(),collapsed:getSelection().isCollapsed})`);
      check(scenario.name + " retains a native cell Undo without changing document history",
        undone.formatted === 0 && [parts.join(""), parts.slice(0, -1).join("")].includes(undone.text) &&
        JSON.stringify(await state()) === JSON.stringify(before), undone);
      await key("Y", ["control"]);
      check(scenario.name + " native Redo restores the exact source-owned live fragment",
        await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(live.html)) &&
        JSON.stringify(await state()) === JSON.stringify(before));
      const continued = (await typeTrustedCell([" next"], 8, { preserveCaret: true })).at(-1);
      const formattedText = await exec("[...__cells.inputs()[8].querySelectorAll('strong,em')].map(node=>node.textContent)");
      check(scenario.name + " continues outside its completed formatting at the live caret",
        continued.text === scenario.body + " next" && formattedText.length === scenario.strong + scenario.em &&
        formattedText.every(text => text === scenario.body) && !continued.error, { continued, formattedText });
      const completion = await update(), after = await state();
      const expected = replaced(scenario.opening + scenario.body + scenario.opening + " next");
      check(scenario.name + " Update saves clean Markdown once and preserves every non-target source byte",
        !completion.open && !completion.error && after.exact === expected && after.cache === expected &&
        after.undo === before.undo + 1 && after.redo === 0 && saves.length === saveCount &&
        fs.readFileSync(fixture.file, "utf8") === original, { completion, after, expected });
      await openGrid();
      const reopened = await exec(`({text:__cells.inputs()[8].textContent,
        strong:__cells.inputs()[8].querySelectorAll('strong').length,
        em:__cells.inputs()[8].querySelectorAll('em').length})`);
      check(scenario.name + " reopens with the same semantic formatting and plain continuation",
        reopened.text === scenario.body + " next" && reopened.strong === scenario.strong &&
        reopened.em === scenario.em, reopened);
      if (scenario.opening.length === 3) await screenshot("reopened-typed-emphasis");
      await cancel();
      check(scenario.name + " reopen Cancel leaves the exact committed document untouched",
        JSON.stringify(await state()) === JSON.stringify(after) && saves.length === saveCount);
      await exec("historyUndo();true");
      await wait(scenario.name + " document Undo", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
      check(scenario.name + " remains one document Undo and never writes the disposable file",
        (await state()).exact === original && saves.length === saveCount &&
        fs.readFileSync(fixture.file, "utf8") === original);
    }
    for (const scenario of [
      { name: "italic inside loaded bold", initial: "**outer**", parts: ["*", "inner", "*"], outer: "strong", inner: "em" },
      { name: "bold inside loaded italic", initial: "*outer*", parts: ["*", "*", "inner", "*", "*"], outer: "em", inner: "strong" },
    ]) {
      const body = replaced(scenario.initial), fixture = await fresh(scenario.name, body);
      const before = await state(), saveCount = saves.length;
      await openGrid();
      const owner = await exec(`__cells.inputs()[8].querySelector('${scenario.outer}')
        .getAttribute(tableCellSession.cells[8].provenance.partAttribute)`);
      const live = (await typeTrustedCell(scenario.parts, 8, { replace: true })).at(-1);
      const nested = await exec(`!!__cells.inputs()[8].querySelector('${scenario.outer} ${scenario.inner}')&&
        __cells.inputs()[8].querySelectorAll('strong,em').length===2&&
        __cells.inputs()[8].querySelector('${scenario.outer}').getAttribute(tableCellSession.cells[8].provenance.partAttribute)
          ===${JSON.stringify(owner)}`);
      check(scenario.name + " creates an owned nested frame without replacing its enclosing formatting",
        live.text === "inner" && nested && !live.error && JSON.stringify(await state()) === JSON.stringify(before), live);
      const continued = (await typeTrustedCell([" tail"], 8, { preserveCaret: true })).at(-1);
      const ancestry = await exec(`(() => {
        const outer=__cells.inputs()[8].querySelector('${scenario.outer}'),inner=outer?.querySelector('${scenario.inner}');
        return {outer:outer?.textContent,inner:inner?.textContent,
          count:__cells.inputs()[8].querySelectorAll('strong,em').length};
      })()`);
      check(scenario.name + " continues outside the new inner frame but inside its retained outer owner",
        ancestry.outer === "inner tail" && ancestry.inner === "inner" && ancestry.count === 2 &&
        !continued.error, { ancestry, continued });
      await key("Z", ["control"]);
      check(scenario.name + " one native Undo restores the nested conversion before continuation",
        await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(live.html)) &&
        JSON.stringify(await state()) === JSON.stringify(before));
      await key("Y", ["control"]);
      check(scenario.name + " native Redo restores continuation and exact owner ancestry",
        await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(continued.html)) &&
        JSON.stringify(await state()) === JSON.stringify(before));
      const completion = await update(), after = await state();
      const tail = original.slice(offset + "plain".length);
      const changedCell = after.exact.slice(offset, after.exact.length - tail.length);
      check(scenario.name + " commits Markdown without HTML and preserves exact surrounding bytes",
        !completion.open && !completion.error && after.exact.startsWith(original.slice(0, offset)) &&
        after.exact.endsWith(tail) && /^[*_]+inner[*_]+ tail[*_]+$/.test(changedCell) &&
        after.undo === before.undo + 1 && saves.length === saveCount &&
        fs.readFileSync(fixture.file, "utf8") === body, { changedCell, completion, after });
      await openGrid();
      check(scenario.name + " reopens the intended nested semantics rather than reversed delimiter ownership",
        await exec(`!!__cells.inputs()[8].querySelector('${scenario.outer} ${scenario.inner}')&&
          __cells.inputs()[8].querySelector('${scenario.outer}').textContent==='inner tail'&&
          __cells.inputs()[8].querySelector('${scenario.inner}').textContent==='inner'`));
      await cancel();
      await exec("historyUndo();true");
      await wait(scenario.name + " document Undo", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
      check(scenario.name + " document Undo restores the exact original outer Markdown spelling", (await state()).exact === body);
    }
    for (const scenario of [
      { name: "typed escaped star", initial: "plain", parts: ["\\", "*", "literal", "*"],
        replace: true, text: "\\*literal*", source: "&#92;&#42;literal&#42;" },
      { name: "captured entity star", initial: "&#42;loaded", parts: ["*"],
        text: "*loaded*", source: "&#42;loaded&#42;" },
      { name: "captured escaped star", initial: "\\*loaded", parts: ["*"],
        text: "*loaded*", source: "\\*loaded&#42;" },
      { name: "right-context punctuation flanking", initial: "right", parts: ["*", "-", "*"], atStart: true,
        text: "*-*right", source: "&#42;-&#42;right" },
      { name: "invalid whitespace flanking", initial: "plain", parts: ["*", " ", "text", "*"],
        replace: true, text: "* text*", source: "&#42; text&#42;" },
      { name: "stars inside loaded code", initial: "`literal`", parts: ["*", "x", "*"], code: true,
        text: "literal*x*", source: "`literal*x*`" },
    ]) {
      const body = replaced(scenario.initial), fixture = await fresh(scenario.name, body);
      const before = await state(), saveCount = saves.length;
      await openGrid();
      if (scenario.atStart || scenario.code) await exec(`(() => {
        const input=__cells.inputs()[8],target=${scenario.code ? "input.querySelector('code')" : "input"};
        input.focus();const range=document.createRange();range.selectNodeContents(target);
        range.collapse(${!scenario.code});getSelection().removeAllRanges();getSelection().addRange(range);return true;
      })()`);
      const live = (await typeTrustedCell(scenario.parts, 8,
        { replace: !!scenario.replace, preserveCaret: !!(scenario.atStart || scenario.code) })).at(-1);
      check(scenario.name + " preserves literal content through trusted typing without creating emphasis",
        live.text === scenario.text && !live.error &&
        await exec("__cells.inputs()[8].querySelectorAll('strong,em').length===0") &&
        live.events.some(event => event.event === "beforeinput" && event.trusted) &&
        JSON.stringify(await state()) === JSON.stringify(before), live);
      const completion = await update(), after = await state();
      check(scenario.name + " preserves exact protected source and all non-target bytes on Update",
        !completion.open && !completion.error && after.exact === replaced(scenario.source) &&
        saves.length === saveCount && fs.readFileSync(fixture.file, "utf8") === body,
        { completion, after, expected: replaced(scenario.source) });
      await exec("historyUndo();true");
      await wait(scenario.name + " document Undo", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    }
    for (const edge of ["opening", "closing"]) {
      const initial = edge === "opening" ? '*<img src="cell.svg">*word' : 'word<img src="cell.svg">tail';
      const body = replaced(initial), fixture = await fresh("zero-width " + edge + " owner", body);
      const before = await state(), saveCount = saves.length;
      await openGrid();
      check("zero-width " + edge + " setup contains the actual retained image and no emphasis",
        await exec("__cells.inputs()[8].querySelectorAll('img').length===1&&" +
          "__cells.inputs()[8].querySelectorAll('strong,em').length===0"));
      if (edge === "opening") await typeTrustedCell(["**"], 8);
      else {
        await exec(`(() => {
          const input=__cells.inputs()[8],range=document.createRange();input.focus();
          range.selectNodeContents(input);range.collapse(true);
          getSelection().removeAllRanges();getSelection().addRange(range);return true;
        })()`);
        await typeTrustedCell(["*", "*"], 8, { preserveCaret: true });
        for (const side of ["Before", "After"]) {
          await exec(`(() => {
            const range=document.createRange();range.setStart${side}(__cells.inputs()[8].querySelector('img'));
            range.collapse(true);getSelection().removeAllRanges();getSelection().addRange(range);return true;
          })()`);
          await typeTrustedCell(["*"], 8, { preserveCaret: true });
        }
      }
      const live = await exec(`({html:__cells.inputs()[8].innerHTML,text:__cells.inputs()[8].textContent,
        images:__cells.inputs()[8].querySelectorAll('img').length,
        formatted:__cells.inputs()[8].querySelectorAll('strong,em').length,error:tableCellError.textContent})`);
      check("zero-width " + edge + " owner breaks the apparent delimiter run without losing content",
        live.images === 1 && live.formatted === 0 && !live.error &&
        live.text === (edge === "opening" ? "**word**" : "**word**tail") &&
        JSON.stringify(await state()) === JSON.stringify(before), live);
      const expected = edge === "opening" ? initial + "&#42;&#42;" :
        '&#42;&#42;word&#42;<img src="cell.svg">&#42;tail';
      const completion = await update(), after = await state();
      check("zero-width " + edge + " owner retains exact image source and surrounding document on Update",
        !completion.open && !completion.error && after.exact === replaced(expected) &&
        saves.length === saveCount && fs.readFileSync(fixture.file, "utf8") === body,
        { completion, actual: after.exact, expected: replaced(expected) });
      await exec("historyUndo();true");
      await wait("zero-width " + edge + " owner document Undo", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    }
    const retained = 'head &#42;literal&#42; &amp; :smile: `code` <span title="keep">html</span><!--keep--> tail';
    const protectedBody = replaced(retained), protectedFixture = await fresh("protected emphasis body", protectedBody);
    const protectedBefore = await state(), protectedSaves = saves.length;
    await openGrid();
    const expectedText = await exec("__cells.inputs()[8].textContent");
    await exec(`(() => {
      const input=__cells.inputs()[8];input.focus();const range=document.createRange();
      range.selectNodeContents(input);range.collapse(true);
      getSelection().removeAllRanges();getSelection().addRange(range);return true;
    })()`);
    await typeTrustedCell(["*", "*"], 8, { preserveCaret: true });
    await exec(`(() => {
      const range=document.createRange();range.selectNodeContents(__cells.inputs()[8]);range.collapse(false);
      getSelection().removeAllRanges();getSelection().addRange(range);return true;
    })()`);
    const protectedLive = (await typeTrustedCell(["*", "*"], 8, { preserveCaret: true })).at(-1);
    check("new bold preserves protected atoms and whole retained code HTML and comment owners",
      protectedLive.text === expectedText && !protectedLive.error &&
      await exec(`!!__cells.inputs()[8].querySelector('strong code')&&
        __cells.inputs()[8].querySelector('strong span[title="keep"]')?.textContent==='html'`) &&
      JSON.stringify(await state()) === JSON.stringify(protectedBefore), protectedLive);
    const protectedCompletion = await update();
    check("new bold retains exact authored atom HTML and comment spelling inside clean Markdown",
      !protectedCompletion.open && !protectedCompletion.error && (await state()).exact === replaced("**" + retained + "**") &&
      saves.length === protectedSaves && fs.readFileSync(protectedFixture.file, "utf8") === protectedBody,
      { protectedCompletion, actual: (await state()).exact, expected: replaced("**" + retained + "**") });
    await exec("historyUndo();true");
    await wait("protected emphasis document Undo", "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
    const imeFixture = await fresh("emphasis composition"), imeBefore = await state(), imeSaves = saves.length;
    await openGrid();
    await exec(`(() => {
      const input=__cells.inputs()[8];input.focus();const range=document.createRange();
      window.__emphasisComposition = [];
      for (const type of ['compositionstart','input','compositionend']) input.addEventListener(type, event => {
        window.__emphasisComposition.push({ type, trusted:event.isTrusted, composing:!!event.isComposing });
      });
      range.selectNodeContents(input);getSelection().removeAllRanges();getSelection().addRange(range);return true;
    })()`);
    await bounded("native emphasis composition", win.webContents.debugger.sendCommand("Input.imeSetComposition",
      { text: "**ime**", selectionStart: 7, selectionEnd: 7 }));
    check("actual active Chromium composition does not convert an unfinished emphasis transaction",
      await exec(`__cells.inputs()[8].textContent==='**ime**' &&
        __cells.inputs()[8].querySelectorAll('strong,em').length===0 &&
        window.__emphasisComposition.some(event => event.type==='compositionstart' && event.trusted) &&
        window.__emphasisComposition.some(event => event.type==='input' && event.trusted && event.composing)`));
    await bounded("native emphasis commit", win.webContents.debugger.sendCommand("Input.insertText", { text: "**ime**" }));
    await settle();
    const imeLive = await exec(`({html:__cells.inputs()[8].innerHTML,text:__cells.inputs()[8].textContent,
      bold:__cells.inputs()[8].querySelector('strong')?.textContent,error:tableCellError.textContent})`);
    check("actual committed Chromium composition creates one owned bold frame before Update",
      imeLive.bold === "ime" && imeLive.text === "ime" && !imeLive.error &&
      JSON.stringify(await state()) === JSON.stringify(imeBefore), imeLive);
    await key("Z", ["control"]);
    check("composition Undo removes formatting without changing the document",
      await exec("__cells.inputs()[8].querySelectorAll('strong,em').length===0") &&
      JSON.stringify(await state()) === JSON.stringify(imeBefore));
    await key("Y", ["control"]);
    check("composition Redo restores its exact live semantic owner",
      await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(imeLive.html)));
    const imeCompletion = await update();
    check("composition bold commits clean Markdown once without writing the source file",
      !imeCompletion.open && !imeCompletion.error && (await state()).exact === replaced("**ime**") &&
      (await state()).undo === imeBefore.undo + 1 && saves.length === imeSaves &&
      fs.readFileSync(imeFixture.file, "utf8") === original, { imeCompletion, after: await state() });
  }
  async function keyboard() {
    for (const button of ["tableCellUpdate", "tableCellCancel"]) {
      const footerFixture = await fresh("footer-" + button), footerSaves = saves.length;
      const footerWitness = " footer source history";
      const typedFooter = await appendTrustedSource(footerWitness);
      const nativeFooterSource = await exec(`(() => {
        const undone=document.execCommand('undo'),valueAfterUndo=markdownEditor.value;
        const redone=document.execCommand('redo');
        return {undone,redone,valueAfterUndo,valueAfterRedo:markdownEditor.value};
      })()`);
      check("table footer " + button + " fixture proves trusted source typing and live native source Undo Redo",
        typedFooter.events.some(event => event.trusted && event.type === "insertText") &&
          nativeFooterSource.undone && nativeFooterSource.redone &&
          nativeFooterSource.valueAfterUndo === lf(original) &&
          nativeFooterSource.valueAfterRedo === lf(original) + footerWitness, nativeFooterSource);
      await wait("footer source history settled", "editorScroll.isCurrentSource(markdownEditor.value)&&historyDebounceTimer===null");
      const footerBefore = await state();
      await openGrid();
      await typeTrustedCell(["pending footer edit"], 8, { replace: true });
      await exec("__cells.inputs().at(-1).focus();true");
      await key("Tab");
      if (button === "tableCellCancel") await key("Tab");
      const focused = await exec("document.activeElement.id");
      check("table footer " + button + " actual Tab reaches a noneditable button with pending cell changes",
        focused === button && await exec("tableCellSession.cells[8].engine.readSource()==='pending footer edit'"), focused);
      const footerControl = () => exec(`({
        state:__cells.state(),current:tableCellSession?.selection.isCurrent(),
        timers:[historyDebounceTimer,previewDebounceTimer],owner:currentDocumentActionOwner()?.id,
        generation:renderGeneration,reload:window.getReloadRequestDiagnostics(),
        saves:window.getPendingSaveStatus(),pending:tableCellSession?.selection.isCurrent() ?
          tableCellSession.cells[8].engine.readSource() : null
      })`);
      const control = await footerControl(), keys = [];
      for (const code of ["Z", "Y", "S", "R"]) {
        await key(code, ["control"]);
        const afterKey = await footerControl().catch(error => ({ error: error.message }));
        keys.push({ code, afterKey });
        if (JSON.stringify(afterKey) !== JSON.stringify(control)) break;
      }
      check("table footer " + button + " native Undo Redo Save Reload preserve source history timers owner disk and pending edit",
        keys.length === 4 && keys.every(item => JSON.stringify(item.afterKey) === JSON.stringify(control)) &&
          JSON.stringify(await state()) === JSON.stringify(footerBefore) && saves.length === footerSaves &&
          fs.readFileSync(footerFixture.file, "utf8") === original, { focused, control, keys });
      if (keys.length === 4 && control.current) {
        await exec(`window.__cellFooterHistory = [];
          window.__cellFooterObserver = event => {
            if (!['historyUndo','historyRedo'].includes(event.inputType)) return;
            const record={type:event.inputType,trusted:event.isTrusted,target:event.target.id,
              active:document.activeElement.id,cancelable:event.cancelable};
            Object.defineProperty(record,'event',{value:event});
            window.__cellFooterHistory.push(record);
          };
          window.addEventListener('beforeinput',window.__cellFooterObserver,true);true`);
        win.webContents.undo(); await settle();
        const nativeUndo = await footerControl();
        win.webContents.redo(); await settle();
        const nativeRedo = await footerControl();
        const routed = await exec(`window.removeEventListener('beforeinput',window.__cellFooterObserver,true);
          window.__cellFooterHistory.map(record => ({...record,prevented:record.event.defaultPrevented}))`);
        check("table footer " + button + " native history routing is observed and cancelled without source or cell mutation",
          routed.some(event => event.trusted && event.prevented && event.type === "historyUndo") &&
            JSON.stringify(nativeUndo) === JSON.stringify(control) && JSON.stringify(nativeRedo) === JSON.stringify(control),
          { routed, nativeUndo, nativeRedo });
      }
      if (keys.length === 4 && button === "tableCellUpdate") {
        const completion = await update();
        const footerAfter = await state();
        await exec("historyUndo();true");
        await wait("protected footer Update document Undo",
          "!undoRedoRendering&&editorScroll.isCurrentSource(markdownEditor.value)");
        const footerUndone = await state();
        check("table footer protected pending changes still Update once without saving",
          !completion.open && !completion.error && footerAfter.exact !== footerBefore.exact &&
            footerAfter.exact.includes("pending footer edit") && footerUndone.exact === footerBefore.exact &&
            saves.length === footerSaves && fs.readFileSync(footerFixture.file, "utf8") === original,
          { completion, footerBefore, footerAfter, footerUndone });
      } else {
        await cancel();
        check("table footer Cancel remains usable after native shortcut controls",
          !await exec("tableCellDialog.open"), keys);
      }
    }
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
        isolated.serialized === "pasted<br>line" &&
        JSON.stringify(await state()) === JSON.stringify(before), isolated);
      const beforeUpdate = await mark("before-update");
      const completion = await update();
      const settlement = await mark("update-settlement");
      const offset = secondOffset + table.indexOf("**alpha**");
      const expected = original.slice(0, offset) + "pasted<br>line" +
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
    const codeOffset = original.indexOf("plain", secondOffset);
    const codeSource = original.slice(0, codeOffset) + "`ab`" + original.slice(codeOffset + "plain".length);
    const codeFixture = await fresh("markdown-code-multiline-paste", codeSource);
    await openGrid();
    const codeBefore = await state(), codeSaves = saves.length;
    const pasteSetup = await exec(`(() => {
      const input=__cells.inputs()[8],code=input.querySelector('code');
      const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT),text=walker.nextNode();
      input.focus();
      const range=document.createRange();range.setStart(text,1);range.collapse(true);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      return {html:input.innerHTML,code:code.textContent,caret:code.contains(selection.anchorNode),offset:selection.anchorOffset};
    })()`);
    check("multiline code paste starts inside a real loaded Markdown code span",
      pasteSetup.code === "ab" && pasteSetup.caret && pasteSetup.offset === 1, pasteSetup);
    const pastedCode = await pasteCode("LEFT\nRIGHT");
    check("actual Markdown-code paste immediately replaces each line break with a space in one native insertion",
      pastedCode.prevented && pastedCode.events.filter(event => event.trusted).length === 1 &&
      pastedCode.codeBreaks === 0 && pastedCode.text === "aLEFT RIGHTb" &&
      JSON.stringify(await state()) === JSON.stringify(codeBefore), pastedCode);
    await key("Z", ["control"]);
    check("normalized code paste Undo restores its exact captured DOM in one step",
      await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(pasteSetup.html)) &&
      JSON.stringify(await state()) === JSON.stringify(codeBefore));
    await key("Y", ["control"]);
    check("normalized code paste Redo restores the exact immediately visible single-line content",
      await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(pastedCode.html)) &&
      JSON.stringify(await state()) === JSON.stringify(codeBefore));
    const dispatch = await exec(`(() => {
      const input=__cells.inputs()[8],provenance=tableCellSession.cells.find(cell=>cell.input===input).provenance;
      const refused=operation=>{
        try { operation();return false; }
        catch(error) { if(error.message!=='tableCells.cellType')throw error;return true; }
      };
      const withAttribute=input.cloneNode(true),empty=input.cloneNode(true),structural=input.cloneNode(true);
      const unowned=input.cloneNode(true);
      unowned.querySelector('code').removeAttribute(provenance.partAttribute);
      let unownedSource;
      const unownedRefused=refused(()=>{unownedSource=serializeSafeTableCell(unowned,provenance);});
      const wrongOwners=['**value**','<span title="keep">value</span>'].map(source=>{
        const container=document.createElement('div');
        const captured=FoliaTableCells.prepareCell(container,source,source,marked,{},parseEmojis,sanitizeTableHtml);
        const original=container.firstElementChild,part=original.getAttribute(captured.partAttribute);
        const fragment=captured.fragments.get(part),setup=serializeSafeTableCell(container,captured);
        const replacement=document.createElement('code');
        for(const attribute of original.attributes)replacement.setAttribute(attribute.name,attribute.value);
        replacement.append(...original.childNodes);
        original.replaceWith(replacement);
        return {source,setup,kind:fragment.kind,tag:fragment.tag,
          refused:refused(()=>FoliaTableCells.serializeCell(container,captured))};
      });
      structural.querySelector('code').replaceChildren('aLEFT',document.createElement('br'),'RIGHTb');
      withAttribute.querySelector('code').textContent='ordinary';
      withAttribute.querySelector('code').className='browser-generated';
      empty.querySelector('code').replaceChildren();
      const comparison=structural.cloneNode(true);
      comparison.querySelectorAll('[data-folia-cell-part]').forEach(node=>node.removeAttribute('data-folia-cell-part'));
      const generated=document.createElement('div'),authored=document.createElement('div');
      const source='<code title="keep">a<br>b</code>';
      const authoredProvenance=FoliaTableCells.prepareCell(authored,source,source,marked,{},parseEmojis,sanitizeTableHtml);
      const generatedSource='<code>&#58;star:</code>';
      const generatedProvenance=FoliaTableCells.prepareCell(generated,generatedSource,generatedSource,marked,{},parseEmojis,sanitizeTableHtml);
      const generatedCode=generated.querySelector('code');
      generatedProvenance.fragments.get(generatedCode.getAttribute('data-folia-cell-part')).generatedCode=true;
      generatedCode.append(document.createElement('br'));
      return {unownedRefused,unownedSource,wrongOwners,unownedPart:unowned.querySelector('code').getAttribute(provenance.partAttribute),
        validCellProvenance:provenance.fragments instanceof Map&&provenance.fragments.size>0,
        structural:FoliaTableCells.codeSources(structural.querySelector('code'),provenance),
        empty:FoliaTableCells.codeSources(empty.querySelector('code'),provenance),
        attributesRefused:refused(()=>serializeSafeTableCell(withAttribute,provenance)),
        emptyRefused:refused(()=>serializeSafeTableCell(empty,provenance)),
        missingAuthorityRefused:refused(()=>serializeSafeTableCell(comparison)),
        generatedExceptionRefused:refused(()=>serializeSafeTableCell(generated,generatedProvenance)),
        comparison:FoliaTableCells.serializeCell(comparison),authored:serializeSafeTableCell(authored,authoredProvenance)};
    })()`);
    check("CODE without captured ownership refuses even with valid whole-cell provenance",
      dispatch.unownedRefused && dispatch.unownedPart === null && dispatch.validCellProvenance, dispatch);
    check("CODE cannot borrow Markdown or authored HTML authority from a captured different tag",
      dispatch.wrongOwners.length === 2 &&
      dispatch.wrongOwners.every(owner => owner.setup === owner.source && owner.refused) &&
      dispatch.wrongOwners[0].kind === "strong" &&
      dispatch.wrongOwners[1].kind === "html" && dispatch.wrongOwners[1].tag === "SPAN", dispatch.wrongOwners);
    check("CODE source dispatch keeps explicit failure reasons separate from authored and comparison HTML",
      dispatch.structural.kind === "unrepresentable" && dispatch.structural.reason === "structural-code-body" &&
      dispatch.empty.kind === "unrepresentable" && dispatch.empty.reason === "empty-code" &&
      dispatch.attributesRefused && dispatch.emptyRefused && dispatch.missingAuthorityRefused &&
      dispatch.generatedExceptionRefused && dispatch.comparison === "<code>aLEFT<br>RIGHTb</code>" &&
      dispatch.authored === '<code title="keep">a<br>b</code>', dispatch);
    const codeCompletion = await update(), codeAfter = await state();
    check("ordinary multiline Markdown-code paste cannot introduce a generated CODE wrapper on Update",
      !codeAfter.exact.includes("<code") && saves.length === codeSaves,
      { pastedCode, completion: codeCompletion, after: codeAfter });
    const pastedExpected = codeSource.replace("`ab`", "`aLEFT RIGHTb`");
    check("normalized Markdown-code paste Updates clean Markdown once without changing other bytes or disk",
      !codeCompletion.open && !codeCompletion.error && codeAfter.exact === pastedExpected &&
      codeAfter.cache === pastedExpected && codeAfter.undo === codeBefore.undo + 1 &&
      fs.readFileSync(codeFixture.file, "utf8") === codeSource,
      { codeCompletion, codeAfter, pastedExpected });
    if (!codeCompletion.open) {
      await openGrid();
      check("normalized code paste reopens with the same single-line code text",
        await exec("__cells.inputs()[8].querySelector('code').textContent==='aLEFT RIGHTb'"));
    }
    await cancel();
    for (const scenario of [
      { name: "markdown-code-single-line-paste", source: "`ab`", paste: "LEFT", text: "aLEFTb",
        breaks: 0, expected: "`aLEFTb`" },
      { name: "markdown-code-empty-line-paste", source: "`ab`", paste: "LEFT\r\n\r\nRIGHT\rEND\n",
        text: "aLEFT  RIGHT END b", breaks: 0, expected: "`aLEFT  RIGHT END b`" },
      { name: "typed-code-multiline-paste", source: "plain", typed: "`ab`", paste: "\nLEFT\r\nRIGHT\r",
        text: "a LEFT RIGHT b", breaks: 0, expected: "`a LEFT RIGHT b`" },
      { name: "markdown-code-selection-paste", source: "`ab`", paste: "LEFT\nRIGHT", replace: true,
        text: "aLEFT RIGHT", breaks: 0, expected: "`aLEFT RIGHT`" },
      { name: "markdown-code-element-range-paste", source: "`ab`", allContents: true,
        paste: "LEFT\nRIGHT", text: "LEFT RIGHT", breaks: 0, expected: "`LEFT RIGHT`" },
      { name: "outside-code-parent-paste", source: "`ab`", outside: true,
        paste: "LEFT\nRIGHT", text: "abLEFTRIGHT", breaks: 0, expected: "`ab`LEFT<br>RIGHT" },
      { name: "generated-exception-multiline-paste", source: "plain", typed: "`a\\|b`",
        paste: "\nLEFT\n", text: "a LEFT \\|b", breaks: 0,
        expected: "<code>a LEFT &#92;&#124;b</code>" },
      { name: "authored-code-multiline-paste", source: '<code title="keep">ab</code>',
        paste: "LEFT\r\n\r\nRIGHT", text: "aLEFTRIGHTb", breaks: 2,
        expected: '<code title="keep">aLEFT<br><br>RIGHTb</code>' },
      { name: "authored-code-colliding-metadata", source: '<code DATA-FOLIA-CELL-PART="author" data-folia-cell-code="history">ab</code>',
        paste: "LEFT\nRIGHT", text: "aLEFTRIGHTb", breaks: 1,
        expected: '<code DATA-FOLIA-CELL-PART="author" data-folia-cell-code="history">aLEFT<br>RIGHTb</code>' },
    ]) {
      const body = original.slice(0, codeOffset) + scenario.source + original.slice(codeOffset + "plain".length);
      const fixture = await fresh(scenario.name, body), before = await state(), saveCount = saves.length;
      await openGrid();
      if (scenario.typed) await typeTrustedCell([scenario.typed], 8, { replace: true });
      const initial = await exec(`(() => {
        const input=__cells.inputs()[8],code=input.querySelector('code');
        input.focus();
        const range=document.createRange(),walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
        const text=walker.nextNode();
        if (${!!scenario.outside}) {range.setStartAfter(code);range.collapse(true);}
        else if (${!!scenario.allContents}) range.selectNodeContents(code);
        else {
          range.setStart(text,1);
          if (${!!scenario.replace}) range.setEnd(text,2);
          else range.collapse(true);
        }
        const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
        return {html:input.innerHTML,text:code.textContent,caret:code.contains(selection.anchorNode)};
      })()`);
      check(scenario.name + " starts with its actual captured code and interior caret",
        initial.text === (scenario.name === "generated-exception-multiline-paste" ? "a\\|b" : "ab") &&
        initial.caret === !scenario.outside, initial);
      if (scenario.name === "markdown-code-single-line-paste") {
        await exec(`(() => {
          const range=document.createRange();range.selectNodeContents(__cells.inputs()[8].querySelector('code'));
          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
          return true;
        })()`);
        await key("Backspace");
        const cleared = await exec(`(() => {
          const input=__cells.inputs()[8];
          try { return {html:input.innerHTML,text:input.textContent,source:serializeSafeTableCell(input)}; }
          catch(error) { return {html:input.innerHTML,text:input.textContent,error:error.message}; }
        })()`);
        check("native code-content deletion stays editable without a generated CODE wrapper",
          cleared.text === "" && !cleared.error && !cleared.source.includes("<code") &&
          JSON.stringify(await state()) === JSON.stringify(before), cleared);
        await key("Z", ["control"]);
        check("native code-content deletion Undo restores the exact captured rich cell",
          await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(initial.html)) &&
          JSON.stringify(await state()) === JSON.stringify(before));
        await exec(`(() => {
          const code=__cells.inputs()[8].querySelector('code');
          const range=document.createRange(),walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
          range.setStart(walker.nextNode(),1);range.collapse(true);
          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
          return true;
        })()`);
      }
      const pasted = await pasteCode(scenario.paste);
      check(scenario.name + " preserves existing visible paste behavior through native editing",
        pasted.prevented && pasted.events.some(event => event.trusted) &&
        pasted.text === scenario.text && pasted.codeBreaks === scenario.breaks &&
        JSON.stringify(await state()) === JSON.stringify(before), pasted);
      await key("Z", ["control"]);
      check(scenario.name + " is one native cell Undo without changing document authority",
        await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(initial.html)) &&
        JSON.stringify(await state()) === JSON.stringify(before));
      await key("Y", ["control"]);
      check(scenario.name + " restores exact rich code through native Redo",
        await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(pasted.html)) &&
        JSON.stringify(await state()) === JSON.stringify(before));
      const completion = await update(), after = await state();
      const expected = original.slice(0, codeOffset) + scenario.expected + original.slice(codeOffset + "plain".length);
      check(scenario.name + " preserves exact source authority and authored attributes on Update",
        !completion.open && !completion.error && after.exact === expected && after.cache === expected &&
        after.undo === before.undo + 1 && saves.length === saveCount &&
        fs.readFileSync(fixture.file, "utf8") === body, { completion, after, expected });
      await openGrid();
      const reopened = await exec("({text:__cells.inputs()[8].textContent,breaks:__cells.inputs()[8].querySelectorAll('code br').length})");
      check(scenario.name + " reopens with the same code text and line breaks",
        reopened.text === scenario.text && reopened.breaks === scenario.breaks, reopened);
      await cancel();
    }
    for (const scenario of [
      { name: "mixed-code-paste-range", source: "`ab` tail", text: "aLEFTRIGHT" },
      { name: "two-code-paste-range", source: "`ab` `cd`", text: "aLEFTRIGHTd" },
    ]) {
      const body = original.slice(0, codeOffset) + scenario.source + original.slice(codeOffset + "plain".length);
      const fixture = await fresh(scenario.name, body), before = await state(), saveCount = saves.length;
      await openGrid();
      const initial = await exec(`(() => {
        const input=__cells.inputs()[8],codes=input.querySelectorAll('code');
        const texts=[],walker=document.createTreeWalker(input,NodeFilter.SHOW_TEXT);
        for(let node;node=walker.nextNode();)texts.push(node);
        const range=document.createRange(),first=document.createTreeWalker(codes[0],NodeFilter.SHOW_TEXT).nextNode();
        const last=codes.length>1?document.createTreeWalker(codes[1],NodeFilter.SHOW_TEXT).nextNode():texts.at(-1);
        range.setStart(first,1);range.setEnd(last,codes.length>1?1:last.data.length);
        input.focus();const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
        return {html:input.innerHTML,selected:selection.toString(),codes:codes.length};
      })()`);
      check(scenario.name + " establishes a real selection crossing code ownership",
        initial.selected.length > 1 && initial.codes === (scenario.name === "two-code-paste-range" ? 2 : 1), initial);
      const pasted = await pasteCode("LEFT\nRIGHT");
      check(scenario.name + " keeps its visible line break rather than applying the contents-only code policy",
        pasted.prevented && pasted.events.filter(event=>event.trusted).length === 1 &&
        pasted.text === scenario.text && await exec("__cells.inputs()[8].querySelectorAll('br').length===1") &&
        JSON.stringify(await state()) === JSON.stringify(before), pasted);
      await key("Z", ["control"]);
      check(scenario.name + " is one native Undo restoring the exact owned cell",
        await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(initial.html)));
      await key("Y", ["control"]);
      check(scenario.name + " Redo keeps exact native structure without a document transaction",
        await exec("__cells.inputs()[8].innerHTML===" + JSON.stringify(pasted.html)) &&
        JSON.stringify(await state()) === JSON.stringify(before));
      await cancel();
      check(scenario.name + " Cancel preserves all document and disk authority",
        JSON.stringify(await state()) === JSON.stringify(before) && saves.length === saveCount &&
        fs.readFileSync(fixture.file, "utf8") === body);
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
        const scenarios = { menus, provenance, noop, input, click, transaction, adoption, stale, keyboard, formatting, many };
        check("cell UI dispatcher contains exactly the declared scenarios",
          JSON.stringify(Object.keys(scenarios)) === JSON.stringify(uiGroups));
        for (const [name, run] of Object.entries(scenarios)) {
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
        check("all selected cell UI scenarios ran",
          JSON.stringify(uiGroups.filter(name => executed.has(name))) === JSON.stringify(expectedUiGroups) &&
          (!proof || executed.has(proof)));
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
