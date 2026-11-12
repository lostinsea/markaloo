"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const marked = require("marked");
let source = fs.readFileSync(path.join(__dirname, "..", "src", "editor-scroll.js"), "utf8");
const inlineSource = fs.readFileSync(path.join(__dirname, "..", "src", "inline-formatting.js"), "utf8");
const tableSource = fs.readFileSync(path.join(__dirname, "..", "src", "table-cell-editor.js"), "utf8");
const firstTextOnly = process.argv.includes("--first-text");
if (process.argv.includes("--original-first-text")) {
  assert.ok(firstTextOnly, "the lookup revert is limited to the focused controls");
  const lookup = [
    "        const child = run.node.firstChild;",
    "        const first = child?.nodeType === Node.TEXT_NODE ? child :",
    "          document.createTreeWalker(run.node, NodeFilter.SHOW_TEXT).nextNode();",
  ].join(source.includes("\r\n") ? "\r\n" : "\n");
  assert.equal(source.split(lookup).length, 2, "the exact production lookup occurs once");
  source = source.replace(lookup,
    "        const walker = document.createTreeWalker(run.node, NodeFilter.SHOW_TEXT), first = walker.nextNode();");
}

// These fixtures model only the DOM/Range operations used below, not layout.
// Marked and the Source/view/detachAnnotations/adopt code are production code.
class Text {
  constructor(data) { this.nodeType = 3; this.data = data; this.parentNode = null; }
  get length() { return this.data.length; }
  get textContent() { return this.data; }
  get parentElement() { return this.parentNode; }
  get isConnected() { return !!this.parentNode?.isConnected; }
}
class Box {
  constructor(tagName = "DIV", children = []) {
    this.nodeType = 1; this.tagName = tagName; this.parentNode = null; this.childNodes = [];
    this.attrs = new Map(); this.listeners = new Map();
    this.clientLeft = this.clientTop = 0;
    this.offsetWidth = this.clientWidth = this.scrollWidth = 100;
    this.offsetHeight = this.clientHeight = 100; this.scrollHeight = 500;
    this.scrollTop = this.scrollLeft = 0; this.value = "";
    this.box = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    this.style = { overflowY: "visible", overflowX: "visible", visibility: "visible", opacity: "1",
      display: "block", transform: "none", perspective: "none", clipPath: "none", clip: "auto",
      maskImage: "none", contain: "none", contentVisibility: "visible", writingMode: "horizontal-tb",
      position: "static", borderTopLeftRadius: "0px", borderTopRightRadius: "0px",
      borderLeftWidth: "0px", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px",
      borderBottomLeftRadius: "0px", borderBottomRightRadius: "0px" };
    this.append(...children);
  }
  append(...children) {
    for (const child of children) {
      if (child.parentNode) {
        const siblings = child.parentNode.childNodes, at = siblings.indexOf(child);
        assert.ok(at >= 0, "fixture parent actually owns its child");
        siblings.splice(at, 1);
      }
      this.childNodes.push(child); child.parentNode = this;
    }
  }
  get firstChild() { return this.childNodes[0] || null; }
  get parentElement() { return this.parentNode; }
  get ownerDocument() { return this.doc || this.parentNode?.ownerDocument; }
  get isConnected() { return this.root || !!this.parentNode?.isConnected; }
  get textContent() { return this.childNodes.map(node => node.textContent).join(""); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get classList() { return { contains: name => (this.attrs.get("class") || "").split(" ").includes(name) }; }
  get innerHTML() { return this.childNodes.map(node => node instanceof Text ? node.data : node.outerHTML).join(""); }
  get outerHTML() { return `<${this.tagName}${JSON.stringify([...this.attrs])}>${this.innerHTML}</${this.tagName}>`; }
  getBoundingClientRect() { if (this.ownerDocument?.metrics) this.ownerDocument.metrics.boxes++; return { ...this.box }; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  contains(other) { return this === other || this.childNodes.some(child => child === other || child.contains?.(other)); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.tagName.toLowerCase() === selector) return node;
    return null;
  }
  querySelectorAll(selector) {
    const result = [], attr = /^\[([^\]]+)\]$/.exec(selector);
    const visit = parent => { for (const child of parent.childNodes) if (child instanceof Box) {
      if (selector === "*" || (attr ? child.attrs.has(attr[1]) : child.tagName.toLowerCase() === selector.toLowerCase())) result.push(child);
      visit(child);
    } };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  isEqualNode(other) { return this.outerHTML === other.outerHTML; }
  replaceWith(...children) {
    const parent = this.parentNode, at = parent.childNodes.indexOf(this);
    parent.childNodes.splice(at, 1, ...children);
    for (const child of children) child.parentNode = parent;
    this.parentNode = null;
  }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
}
const walk = root => root.childNodes.flatMap(node => node instanceof Text ? [node] : walk(node));

function fixture({ bound = true, sourceIdentity = true, active = false, implementation = source, rendererCallbacks = false,
  onWalker = null } = {}) {
  const effects = { frames: 0, observers: 0, selections: 0, scrolls: 0, focuses: 0 };
  const metrics = { ranges: 0, rects: 0, boxes: 0, styles: 0 };
  const reads = {};
  const admissionWork = { admissions: 0, comparisons: 0, lookups: 0, presentations: 0 };
  let admitted = null, nextKey = 0;
  const admit = (source, key) => {
    if (key === undefined) {
      admissionWork.comparisons++;
      key = admitted?.source.source === source.source ? admitted.key : "content-" + ++nextKey;
    }
    admissionWork.admissions++;
    admitted = { source, key, witness: Object.freeze({}) };
    return admitted;
  };
  let context = { owner: "tab-A", revision: 1 }, selection = 7, frozen = false;
  const body = new Box("BODY"), preview = new Box(), editor = new Box("TEXTAREA");
  body.root = true; body.append(preview); preview.style.overflowY = "auto";
  const doc = {
    metrics,
    defaultView: { innerWidth: 200, innerHeight: 200, frameElement: null, visualViewport: { scale: 1 } },
    fonts: { addEventListener() {} },
    createTreeWalker(root, mask, filter) {
      onWalker?.(root, filter);
      const nodes = walk(root).filter(node => !filter || filter.acceptNode(node) !== 2);
      let at = 0;
      return { nextNode: () => nodes[at++] || null };
    },
    createElement(tag) {
      assert.equal(tag, "textarea", "only production entity decoding needs an element in these fixtures");
      return { set innerHTML(html) {
        this.value = decode(html);
      } };
    },
    createRange() {
      metrics.ranges++;
      return {
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
        toString() {
          const nodes = walk(preview), from = nodes.indexOf(this.startContainer), to = nodes.indexOf(this.endContainer);
          assert.ok(from >= 0 && to >= from, "range endpoints belong to the current fixture");
          return nodes.slice(from, to + 1).map((node, i) => node.data.slice(
            i === 0 ? this.startOffset : 0, i === to - from ? this.endOffset : node.length)).join("");
        },
        getClientRects() {
          metrics.rects++;
          const rects = [];
          const nodes = walk(preview), first = nodes.indexOf(this.startContainer), last = nodes.indexOf(this.endContainer);
          assert.ok(first >= 0 && last >= first, "range geometry uses connected ordered endpoints");
          for (let n = first; n <= last; n++) {
            const node = nodes[n], geometry = node.geometry || node.parentElement.textGeometry;
            assert.equal(typeof geometry, "function", "every character geometry is explicitly supplied");
            for (let from = n === first ? this.startOffset : 0; from < (n === last ? this.endOffset : node.length);) {
              const to = from + (node.data.codePointAt(from) > 0xFFFF ? 2 : 1);
              for (const rect of geometry(from, to, node)) {
                const previous = rects.at(-1);
                if (previous && previous.top === rect.top && previous.bottom === rect.bottom &&
                    rect.left <= previous.right && rect.right >= previous.left) {
                  previous.left = Math.min(previous.left, rect.left); previous.right = Math.max(previous.right, rect.right);
                  previous.width = previous.right - previous.left;
                } else rects.push({ ...rect });
              }
              from = to;
            }
          }
          return rects;
        },
      };
    },
    getSelection() { effects.selections++; throw new Error("reading must not use selection"); },
  };
  body.doc = doc;
  for (const pane of [editor, preview]) {
    pane.focus = () => { effects.focuses++; };
    pane.scrollTo = () => { effects.scrolls++; };
    pane.scrollIntoView = () => { effects.scrolls++; };
  }
  class Observer { observe() { effects.observers++; } disconnect() {} }
  const sandbox = vm.createContext({ window: { dispatchEvent() {} }, document: doc,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    Element: Box, Event: class {}, ResizeObserver: Observer, MutationObserver: Observer,
    crypto: require("node:crypto"), performance: { now: () => 0 },
    getComputedStyle: (node, pseudo) => { metrics.styles++; return pseudo ? { content: "none" } : node.style; },
    requestAnimationFrame: () => ++effects.frames, cancelAnimationFrame() {},
  });
  vm.runInContext(inlineSource, sandbox);
  vm.runInContext(tableSource, sandbox);
  vm.runInContext(implementation, sandbox);
  const controller = sandbox.window.createEditorScroll({ editor, preview,
    active: () => active, frozen: () => { reads.frozen?.(); return frozen; },
    identity: () => { reads.identity?.(); return selection; },
    scale: () => { reads.scale?.(); return 1; },
    ...(bound ? { presentation: () => { admissionWork.presentations++; reads.presentation?.(); return context; } } : {}),
    ...(sourceIdentity === false ? {} : { readingSourceIdentity: sourceIdentity === true || typeof sourceIdentity === "function" ?
      exactSource => {
        admissionWork.lookups++; reads.sourceIdentity?.(exactSource);
        return typeof sourceIdentity === "function" ? sourceIdentity(exactSource) :
          admitted?.source === exactSource ? admitted.key : null;
      } : sourceIdentity }),
    ...(rendererCallbacks ? { presentation: () => sandbox.readingPresentationContext(),
      readingSourceIdentity: exactSource => sandbox.readingSourceIdentity(exactSource) } : {}) });
  const rect = (left = 10, top = 10, width = 8, height = 16) =>
    ({ left, top, right: left + width, bottom: top + height, width, height });
  const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39|#x1f600|#128512|fjlig);/gi, entity =>
    ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
      "&#x1f600;": "\u{1f600}", "&#128512;": "\u{1f600}", "&fjlig;": "fj" })[entity.toLowerCase()]);
  function render(text, { emoji = value => value, duplicate = false, retained = null, beforeReplace = null,
    beforeDetach = null } = {}) {
    const mapped = controller.source(text);
    mapped.prepare(emoji);
    const html = mapped.parse(marked);
    const textDescriptors = mapped.descriptors.filter(descriptor => descriptor.kind === "text");
    for (const descriptor of textDescriptors) assert.ok(mapped.mappingHtml.includes(
      `${mapped.nonce}:${mapped.descriptors.indexOf(descriptor)}`), "real mapping HTML carries this text annotation");
    const rootDescriptors = mapped.descriptors.filter(descriptor => descriptor.root && descriptor.kind !== "text");
    assert.ok(rootDescriptors.length, "real Marked emitted a block owner");
    // Read only the explicit Marked fixture subset. Unknown or repaired markup
    // is a test error, not a pretend browser parse.
    const detached = new Box(), stack = [detached];
    for (const piece of mapped.mappingHtml.match(/<[^>]*>|[^<]+/g) || []) {
      if (!piece.startsWith("<")) {
        const node = new Text(decode(piece)), parent = stack.at(-1);
        if (/^\s+$/.test(node.data) && ["DIV", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR"].includes(parent.tagName)) node.geometry = () => [];
        parent.append(node); continue;
      }
      const closing = /^<\/([a-z0-9]+)>$/i.exec(piece);
      if (closing) { assert.equal(stack.pop().tagName, closing[1].toUpperCase()); continue; }
      const opening = /^<([a-z0-9]+)((?: [\w-]+="[^"]*")*)>$/i.exec(piece);
      assert.ok(opening, "fixture only accepts explicit quoted Marked markup: " + piece);
      const tag = opening[1].toUpperCase();
      assert.ok(["P", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "CODE", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD",
        "SPAN", "EM", "STRONG", "DEL", "A", "BR", "IMG", "UL", "OL", "LI"].includes(tag), tag);
      const node = new Box(tag);
      for (const attr of opening[2].matchAll(/ ([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], decode(attr[2]));
      stack.at(-1).append(node);
      if (tag !== "BR" && tag !== "IMG") stack.push(node);
    }
    assert.equal(stack.length, 1, "fixture markup closes every container");
    const blocks = rootDescriptors.map(descriptor => detached.querySelectorAll("*").find(node =>
      node.getAttribute(mapped.attribute) === `${mapped.nonce}:${mapped.descriptors.indexOf(descriptor)}`));
    assert.ok(blocks.every(Boolean), "real mapping HTML owns every block");
    const fresh = blocks[0];
    beforeDetach?.({ mapped, detached, blocks });
    const bindings = mapped.detachAnnotations(detached, new Set(), value => value);
    assert.equal(mapped.invalidAnnotations, undefined, "actual annotation ownership/order verification accepts fixture");
    for (const block of blocks) if (mapped.textSpecs.has(block)) {
      assert.equal(mapped.textSpecs.get(block).text, block.textContent, "production detachAnnotations verified ordered rendered text");
    }
    beforeReplace?.(mapped);
    for (const child of preview.childNodes) child.parentNode = null;
    preview.childNodes = [];
    if (retained) assert.equal(blocks.length, 1, "retained fixture provides one explicit owned body");
    const adopted = retained ? [retained] : blocks;
    preview.append(...adopted);
    for (let i = 0; i < blocks.length; i++) {
      const block = adopted[i];
      block.textGeometry = (from, to) => [rect(10 + from * 8, 10, (to - from) * 8)];
      for (const element of block.querySelectorAll("*")) element.textGeometry = block.textGeometry;
      mapped.adopt(blocks[i], block, bindings);
    }
    if (duplicate) mapped.adopt(fresh, fresh, bindings);
    const associations = blocks.map((block, i) => ({ fresh: block, body: adopted[i], owners: [block, ...block.querySelectorAll("*")]
      .filter(node => bindings.get(node)?.readingCode || bindings.get(node)?.readingTable)
      .map(node => {
        const target = node === block ? adopted[i] : node;
        return { fresh: node, body: target, wrapper: null, controls: [], decorations: [],
          code: bindings.get(node).readingCode ? target.querySelectorAll("code")[0] : null };
      }) }));
    admit(mapped);
    return { mapped, fresh, blocks: adopted, html, textDescriptors, bindings, associations, codes: preview.querySelectorAll("code") };
  }
  const bind = rendered => controller.bindReadingPresentation(rendered.mapped, context, rendered.associations);
  const publish = rendered => {
    if (rendered.associations.some(pair => pair.owners.length)) {
      const result = bind(rendered);
      if (result.status !== "bound") return result;
    }
    return controller.publishTextSource(rendered.mapped, context);
  };
  return { controller, editor, preview, body, doc, effects, metrics, render, publish, bind, rect, sandbox,
    admit: (rendered, key) => admit(rendered.mapped, key), admission: () => admitted, admissionWork,
    clearAdmission: () => { admitted = null; },
    onRead: (kind, callback) => { reads[kind] = callback; },
    tableIndex: text => sandbox.window.MarkalooTableCells.index(text, marked, value => value),
    capture: () => controller.captureVisibleText(preview),
    resolve: value => controller.resolveVisibleText(value, preview, context),
    bump: () => { context = { ...context, revision: context.revision + 1 }; },
    setOwner: owner => { context = { ...context, owner }; },
    setIdentity: value => { selection = value; }, freeze: () => { frozen = true; },
    context: () => context };
}
let passed = 0, total = 0;
function test(name, run) {
  if (firstTextOnly && !name.startsWith("first-text:")) return;
  total++;
  try { run(); passed++; console.log("PASS " + name); }
  catch (error) { console.log("FAIL " + name + "  -> " + error.stack); }
}
function captured(f) {
  const result = f.capture();
  assert.equal(result.status, "captured", JSON.stringify({ status: result.status, reason: result.reason }));
  assert.ok(result.value.end > result.value.start);
  assert.equal(result.receipt.range.toString(), result.value.display);
  return result;
}

test("first-text: the original wide corpus block needs no per-cell lookup walkers", () => {
  const text = require("../bench/corpus").generate("wide", 1), walkers = [], cells = [];
  const f = fixture({ onWalker: (root, filter) => walkers.push({ root, filter }) });
  const rendered = f.render(text, { beforeDetach({ mapped, detached }) {
    for (const node of detached.querySelectorAll(`[${mapped.attribute}]`)) {
      const descriptor = mapped.descriptors[Number(node.getAttribute(mapped.attribute).split(":")[1])];
      if (descriptor.kind === "text") {
        assert.equal(descriptor.readingOnly, true);
        assert.equal(node.firstChild.nodeType, 3);
        assert.equal(node.childNodes.length, 1);
        cells.push({ node, text: node.firstChild, descriptor });
      }
    }
  } });
  assert.equal(rendered.fresh.querySelectorAll("th").length, 10);
  assert.equal(rendered.fresh.querySelectorAll("td").length, 50);
  assert.equal(cells.length, 60, "the actual parser and reading callbacks expand all sixty cell runs");
  assert.equal(walkers.filter(read => read.filter).length, 1, "the separate whole-block text walk remains");
  const spec = rendered.mapped.readingTextSpecs.get(rendered.fresh);
  assert.equal(spec.runs.length, 60);
  const nodes = walk(rendered.fresh), bodyText = nodes.map(node => node.data).join("");
  for (const [index, cell] of cells.entries()) {
    assert.ok(nodes.includes(cell.text), "unwrapping retains the exact original text node");
    const run = spec.runs[index], before = nodes.slice(0, nodes.indexOf(cell.text)).map(node => node.data).join("").length;
    assert.equal(run.view, cell.descriptor.view, "adoption retains the exact verified source view");
    assert.equal(run.from, before);
    assert.equal(bodyText.slice(run.from, run.from + run.display.length), run.display);
    assert.equal(text.slice(run.view.at(0), run.view.at(run.display.length)), run.display);
    assert.equal(run.view.exact(0), true);
    assert.equal(run.view.exact(run.display.length), true);
  }
  assert.equal(rendered.bindings.get(rendered.fresh).kind, "table");
  assert.equal(rendered.mapped.textSpecs.has(rendered.fresh), false);
  const lookups = walkers.filter(read => cells.some(cell => cell.node === read.root)).length;
  console.log("OBSERVE first-text wide " + JSON.stringify({ cellRuns: cells.length, lookupWalkers: lookups,
    blockWalkers: walkers.filter(read => read.filter).length }));
  assert.equal(lookups, 0, "direct first Text avoids all sixty per-run lookup walkers");
});
for (const bound of [false, true]) for (const kind of [
  "text-siblings", "empty-text", "comment-first", "empty-element-first", "nested-element-first", "no-text",
]) test("first-text: exact node and source offsets " + kind + " reading=" + bound, () => {
  const walkers = [], f = fixture({ bound, sourceIdentity: bound, onWalker: (root, filter) => walkers.push({ root, filter }) });
  let leaf, original, first, descriptor, mappedSource, mappedBlock;
  const render = () => f.render("alpha", { beforeDetach({ mapped, detached, blocks }) {
    mappedSource = mapped; mappedBlock = blocks[0];
    leaf = detached.querySelectorAll(`[${mapped.attribute}]`).find(node => {
      const value = mapped.descriptors[Number(node.getAttribute(mapped.attribute).split(":")[1])];
      if (value.kind !== "text") return false;
      descriptor = value; return true;
    });
    assert.ok(leaf);
    original = leaf.firstChild;
    assert.equal(original.data, "alpha");
    if (kind === "text-siblings") { original.data = "al"; leaf.append(new Text("pha")); }
    if (kind === "empty-text") {
      const empty = new Text(""); empty.parentNode = leaf; leaf.childNodes.unshift(empty);
    }
    if (kind === "comment-first") leaf.childNodes.unshift({
      nodeType: 8, childNodes: [], textContent: "", outerHTML: "<!--comment-->", parentNode: leaf,
    });
    if (kind === "empty-element-first") {
      const empty = new Box("EM"); empty.parentNode = leaf; leaf.childNodes.unshift(empty);
    }
    if (kind === "nested-element-first") leaf.append(new Box("EM", [original]));
    if (kind === "no-text") { leaf.childNodes = []; original.parentNode = null; }
    first = leaf.firstChild;
    if (kind === "empty-text") { assert.equal(first.nodeType, 3); assert.equal(first.length, 0); }
  } });
  if (bound && kind === "comment-first") {
    // Reading adoption already refuses a Comment; this lookup change must not hide it.
    assert.throws(render, /root.attributes is not iterable/);
    assert.equal(mappedSource.textSpecs.get(mappedBlock).runs[0].view, descriptor.view);
    assert.equal(walkers.filter(read => read.root === leaf && !read.filter).length, 1);
    return;
  }
  const rendered = render();
  const block = rendered.fresh, spec = rendered.mapped.textSpecs.get(block), reading = rendered.mapped.readingTextSpecs.get(block);
  const unavailable = kind === "empty-text" || kind === "no-text";
  assert.equal(spec.runs.length, unavailable ? 0 : 1);
  assert.equal(bound ? reading.runs.length : reading, bound ? spec.runs.length : undefined);
  assert.equal(rendered.mapped.warnings.size, 0, "a missing position does not invent an inline transformation warning");
  assert.equal(rendered.bindings.get(block).kind, "paragraph");
  assert.equal(walkers.filter(read => read.filter).length, 1);
  const fallback = first?.nodeType !== 3;
  assert.equal(walkers.filter(read => read.root === leaf && !read.filter).length, fallback ? 1 : 0,
    "only a non-Text first child uses the original fallback");
  if (!unavailable) {
    assert.ok(walk(block).includes(original), "adoption retains the original text node");
    assert.equal(spec.runs[0].view, descriptor.view);
    assert.equal(spec.runs[0].from, 0);
    assert.equal(spec.runs[0].view.at(0), 0);
    assert.equal(spec.runs[0].view.at(5), 5);
    assert.equal(spec.runs[0].display, "alpha");
    assert.equal(rendered.mapped.textGroups[0].element, block);
    if (bound) {
      assert.equal(f.publish(rendered).status, "published");
      assert.equal(captured(f).value.start, 0);
    }
  } else {
    assert.equal(spec.runs.length, 0, "an empty first Text is not skipped to a later positioned Text");
    if (bound) { f.publish(rendered); assert.notEqual(f.capture().status, "captured"); }
  }
});
for (const bound of [false, true]) test("first-text: entity and code spans preserve exact source boundaries reading=" + bound, () => {
  const f = fixture({ bound, sourceIdentity: bound }), text = "&amp; `code`";
  const rendered = f.render(text), spec = rendered.mapped.textSpecs.get(rendered.fresh);
  assert.equal(rendered.fresh.textContent, "& code");
  assert.deepEqual(Array.from(spec.runs, run => [run.from, run.display, run.view.at(0), run.view.at(run.display.length)]),
    [[0, "& ", 0, 6], [2, "code", 7, 11]]);
  assert.equal(spec.runs[0].view.at(1), 5, "the decoded entity ends at its original source boundary");
  assert.equal(spec.runs[0].view.exact(1), true);
  assert.equal(rendered.mapped.textGroups[0].element, rendered.fresh);
  assert.equal(rendered.mapped.warnings.size, 0);
  if (bound) {
    assert.equal(f.publish(rendered).status, "published");
    assert.equal(captured(f).value.atom, "&amp;");
  }
});
test("first-text: a fallback walker preserves the original thrown error", () => {
  const failure = new Error("focused fallback walker failure");
  let leaf, reached = 0;
  const f = fixture({ onWalker(root, filter) { if (root === leaf && !filter) { reached++; throw failure; } } });
  assert.throws(() => f.render("alpha", { beforeDetach({ mapped, detached }) {
    leaf = detached.querySelectorAll(`[${mapped.attribute}]`).find(node =>
      mapped.descriptors[Number(node.getAttribute(mapped.attribute).split(":")[1])].kind === "text");
    leaf.append(new Box("EM", [leaf.firstChild]));
    assert.equal(leaf.firstChild.nodeType, 1);
  } }), error => error === failure);
  assert.equal(reached, 1, "the actual Source fallback reached the injected walker failure");
});

test("unused default APIs are unavailable and construction adds no observers or work", () => {
  const f = fixture({ bound: false }), before = JSON.stringify(f.effects);
  assert.equal(f.capture().status, "unavailable");
  assert.equal(f.controller.publishTextSource(f.controller.source("text"), { owner: "tab-A", revision: 1 }).status, "unavailable");
  assert.equal(JSON.stringify(f.effects), before);
  assert.deepEqual(f.effects, { frames: 0, observers: 0, selections: 0, scrolls: 0, focuses: 0 });
});
test("real Marked provenance captures an actual noncollapsed character with bounded plain values", () => {
  const f = fixture(), rendered = f.render("alpha ".repeat(1000));
  assert.equal(f.publish(rendered).status, "published");
  const result = captured(f), encoded = JSON.stringify(result.value);
  assert.equal(result.value.atom, "a");
  assert.equal(result.value.start, 0);
  assert.ok(encoded.length < 700, encoded.length);
  assert.deepEqual(Object.keys(result.value).sort(),
    ["version", "sourceKey", "start", "end", "atom", "display", "before", "after", "blockKind", "runKind", "alignment"].sort());
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.alignment), true);
  assert.equal(f.controller.isTextLocationCurrent(result.receipt), true);
});
test("Reader publication uses displayed source, not pending editor.value or Split active()", () => {
  const f = fixture(), rendered = f.render("Displayed");
  f.editor.value = "pending edit";
  assert.equal(f.controller.isCurrentSource("Displayed"), false);
  assert.equal(f.publish(rendered).status, "published");
  assert.equal(captured(f).value.atom, "D");
  f.editor.value = "a newer pending edit";
  assert.equal(captured(f).value.atom, "D");
  assert.equal(f.controller.captureTextRange({ collapsed: false }), null);
});
test("CRLF offsets are normalized and surrogate pairs remain whole", () => {
  const f = fixture(), rendered = f.render("a\r\n\u{1f600}b");
  f.publish(rendered);
  rendered.fresh.textGeometry = from => [from < 2 ? f.rect(10, -50) : f.rect(10, 10)];
  const result = captured(f);
  assert.equal(result.value.atom, "\u{1f600}");
  assert.equal(result.value.display, "\u{1f600}");
  assert.equal(result.value.start, 2);
  assert.equal(result.value.end, 4);
});
test("decoded entity captures the entire exact source atom", () => {
  const f = fixture(), rendered = f.render("&#x1f600; next");
  f.publish(rendered);
  const result = captured(f);
  assert.equal(result.value.atom, "&#x1f600;");
  assert.equal(result.value.display, "\u{1f600}");
  assert.equal(result.value.end, 9);
  assert.equal(f.resolve(result.value).status, "resolved");
});
test("escaped punctuation retains its backslash source boundary", () => {
  const f = fixture(), rendered = f.render("\\* next");
  f.publish(rendered);
  const result = captured(f);
  assert.equal(result.value.atom, "\\*");
  assert.equal(result.value.display, "*");
});
test("emoji preprocessing captures a bounded whole transformed atom", () => {
  const f = fixture(), rendered = f.render(":smile: next", { emoji: () => "\u{1f600}" });
  f.publish(rendered);
  const result = captured(f);
  assert.equal(result.value.atom, ":smile:");
  assert.equal(result.value.display, "\u{1f600}");
});
test("oversized transformed atoms refuse instead of truncating", () => {
  const f = fixture(), name = ":" + "a".repeat(300) + ":";
  const rendered = f.render(name, { emoji: () => "Z" });
  f.publish(rendered);
  assert.equal(f.capture().status, "unsupported");
});
test("inline code uses verified code-body provenance, not fence interpolation", () => {
  const f = fixture(), rendered = f.render("`a\nb`");
  f.publish(rendered);
  const result = captured(f);
  assert.equal(result.value.atom, "a");
  assert.equal(result.value.start, 1);
});
test("fenced code gets exact character provenance without granting legacy editing authority", () => {
  const f = fixture(), rendered = f.render("```\ncode\n```\n\nparagraph");
  assert.ok(rendered.mapped.bindings.some(binding => binding.codeLines?.length), "fixture really has production code-line anchors");
  assert.equal(f.publish(rendered).status, "published");
  const result = captured(f);
  assert.equal(result.value.atom, "c");
  assert.equal(result.value.start, 4);
  assert.equal(result.value.runKind, "code");
  assert.equal(rendered.mapped.editableText.some(group => group.element.tagName === "PRE"), false);
  assert.equal(rendered.mapped.textGroups.some(group => group.element.tagName === "PRE"), false);
});
for (const text of ["```\na\n```", "~~~lang\na\n~~~", "```\na", "```\na\n",
  "```\na\n\n```", "  ```\n  a\n b\n  ```", "```\na\n```\n\n```\na\n```"]) {
  test("real fenced token/body verification accepts " + JSON.stringify(text), () => {
    const f = fixture(), rendered = f.render(text);
    assert.equal(f.publish(rendered).status, "published");
    const result = captured(f);
    assert.equal(result.value.atom, "a");
    assert.equal(result.value.start, text.indexOf("a\n") >= 0 ? text.indexOf("a\n") : text.indexOf("a"));
    assert.equal(result.value.runKind, "code");
    assert.equal(f.resolve(result.value).status, "resolved");
  });
}
test("code characters keep CRLF, emoji, literal entity and repeated-line provenance", () => {
  const text = "```\r\nsame\r\nsame &lt; \u{1f600}\r\n```";
  const f = fixture(), rendered = f.render(text), code = rendered.codes[0];
  assert.equal(code.textContent, "same\nsame &lt; \u{1f600}\n");
  code.textGeometry = from => [from === 11 ? f.rect() : f.rect(250, 10)];
  f.publish(rendered);
  const entity = captured(f);
  assert.equal(entity.value.atom, "l");
  assert.equal(entity.value.start, text.replace(/\r\n/g, "\n").indexOf("&lt;") + 1);
  code.textGeometry = from => [from === 15 ? f.rect() : f.rect(250, 10)];
  const emoji = captured(f);
  assert.equal(emoji.value.atom, "\u{1f600}");
  assert.equal(emoji.value.end - emoji.value.start, 2);
});
test("indented code and generated terminal newlines do not borrow code-line authority", () => {
  const f = fixture(), rendered = f.render("    code\n\nparagraph");
  assert.equal(f.publish(rendered).status, "published");
  assert.equal(f.capture().status, "unsupported");
  const fenced = f.render("```\na\n```");
  f.publish(fenced);
  fenced.codes[0].textGeometry = from => [from === 1 ? f.rect() : f.rect(250, 10)];
  assert.equal(f.capture().status, "unsupported");
});
test("a forged rendered code body cannot publish a real token's character map", () => {
  const f = fixture(), rendered = f.render("```\ncode\n```");
  rendered.codes[0].childNodes[0].data = "fake\n";
  assert.equal(f.publish(rendered).status, "unsupported");
});
test("duplicate adopted mapping owners cannot publish as unique current text", () => {
  const f = fixture(), rendered = f.render("alpha", { duplicate: true });
  assert.equal(rendered.mapped.textGroups.length, 2);
  assert.equal(f.publish(rendered).status, "unsupported");
});
test("a stale prepublication seal and reordered blocks cannot be rebound as current", () => {
  const f = fixture(), rendered = f.render("alpha\n\nbeta");
  rendered.fresh.childNodes[0].data = "omega";
  assert.equal(f.publish(rendered).status, "unsupported");
  const current = f.render("alpha\n\nbeta");
  f.preview.childNodes.reverse();
  assert.equal(f.publish(current).status, "unsupported");
});
test("same source republication keeps its key but retires ephemeral receipts", () => {
  const f = fixture(), first = f.render("alpha");
  f.publish(first);
  const before = captured(f), second = f.render("alpha");
  f.bump(); f.publish(second);
  const after = captured(f);
  assert.equal(after.value.sourceKey, before.value.sourceKey);
  assert.equal(f.controller.isTextLocationCurrent(before.receipt), false);
  assert.equal(f.resolve(before.value).status, "resolved");
  const bad = { ...before.value, atom: "Z" };
  assert.equal(f.resolve(bad).status, "missing");
  assert.equal(f.resolve({ ...before.value, start: 99, end: 100 }).status, "missing");
});
test("a stale caller cannot retire a newer valid publication", () => {
  const f = fixture(), oldContext = f.context();
  f.publish(f.render("alpha"));
  f.bump(); const latest = f.render("alpha"); f.publish(latest);
  const result = captured(f);
  assert.equal(f.controller.resolveVisibleText(result.value, f.preview, oldContext).status, "unavailable");
  assert.equal(f.controller.publishTextSource(latest.mapped, oldContext).status, "unavailable");
  assert.equal(f.controller.publishTextSource(null, oldContext).status, "unavailable");
  assert.equal(f.controller.isTextLocationCurrent(result.receipt), true);
  assert.equal(captured(f).value.sourceKey, result.value.sourceKey);
});
test("changed source requires unique atom and complete bounded context, not nearest old offset", () => {
  const f = fixture(), text = "a".repeat(40) + "TARGET" + "b".repeat(40);
  let rendered = f.render(text);
  rendered.fresh.textGeometry = from => [from === 40 ? f.rect() : f.rect(10, -100)];
  f.publish(rendered);
  const before = captured(f);
  assert.equal(before.value.atom, "T");
  rendered = f.render("prefix ".repeat(10) + text);
  rendered.fresh.textGeometry = () => [f.rect(10, 300)];
  f.bump(); f.publish(rendered);
  const resolved = f.resolve(before.value);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.receipt.range.toString(), "T");
  assert.equal(resolved.receipt.range.startOffset, 110);
  assert.ok(resolved.receipt.range.getClientRects()[0].top > f.preview.box.bottom);
  assert.equal(f.controller.isTextLocationCurrent(resolved.receipt), true);
});
test("duplicate context and deleted text explicitly refuse resolution", () => {
  const f = fixture(), text = "a".repeat(40) + "TARGET" + "b".repeat(40);
  let rendered = f.render(text);
  rendered.fresh.textGeometry = from => [from === 40 ? f.rect() : f.rect(10, -100)];
  f.publish(rendered);
  const before = captured(f);
  rendered = f.render(text + "\n\n" + text);
  f.bump(); f.publish(rendered);
  assert.equal(f.resolve(before.value).status, "ambiguous");
  rendered = f.render("all removed");
  f.bump(); f.publish(rendered);
  assert.equal(f.resolve(before.value).status, "missing");
});
test("returning to retired source does not recover its old source key", () => {
  const f = fixture();
  f.publish(f.render("alpha")); const first = captured(f);
  f.bump(); f.publish(f.render("beta"));
  f.bump(); f.publish(f.render("alpha"));
  assert.notEqual(captured(f).value.sourceKey, first.value.sourceKey);
  f.controller.publishTextSource(null, f.context());
  assert.equal(f.capture().status, "unavailable");
  f.publish(f.render("alpha"));
  assert.notEqual(captured(f).value.sourceKey, first.value.sourceKey);
});
test("saved JSON is portable and retains neither a Source nor a historical source snapshot", () => {
  const f = fixture(), first = f.render("a".repeat(5000));
  f.publish(first);
  const saved = JSON.parse(JSON.stringify(captured(f).value));
  f.bump(); f.publish(f.render("b".repeat(5000)));
  assert.equal(f.resolve(saved).status, "missing");
  assert.ok(JSON.stringify(saved).length < 700);
  const visit = value => {
    if (value && typeof value === "object") {
      assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
      for (const part of Object.values(value)) visit(part);
    } else assert.ok(["string", "number"].includes(typeof value));
  };
  visit(saved);
  f.bump(); f.publish(f.render("a".repeat(5000)));
  assert.equal(f.resolve(saved).status, "ambiguous", "an unknown content key cannot use the old document edge as identity");
});
test("unknown source keys still require unique verified context", () => {
  const f = fixture(), rendered = f.render("alpha");
  f.publish(rendered); const result = captured(f);
  assert.equal(f.resolve({ ...result.value, sourceKey: "unknown", start: 100, end: 101 }).status, "resolved");
  assert.equal(f.resolve({ ...result.value, sourceKey: "unknown", after: "wrong" }).status, "missing");
});
test("oversized and malformed history values refuse explicitly", () => {
  const f = fixture();
  f.publish(f.render("alpha")); const result = captured(f);
  for (const bad of [null, {}, { ...result.value, sourceKey: "" }, { ...result.value, atom: "x".repeat(300), end: 300 },
    { ...result.value, before: "x".repeat(33) }, { ...result.value, alignment: { top: Infinity } },
    { ...result.value, source: "forbidden snapshot" }, { ...result.value, alignment: { top: 0, nested: new Array(1) } }]) {
    assert.equal(f.resolve(bad).status, "unsupported");
  }
});
for (const state of ["revision", "owner", "selection", "frozen", "structure", "text", "replacement"]) {
  test("stale publication rejects " + state + " independently of matching source", () => {
    const f = fixture(), rendered = f.render("alpha");
    f.publish(rendered); const before = captured(f);
    if (state === "revision") f.bump();
    if (state === "owner") f.setOwner("tab-B");
    if (state === "selection") f.setIdentity(8);
    if (state === "frozen") f.freeze();
    if (state === "structure") rendered.fresh.setAttribute("class", "changed");
    if (state === "text") rendered.fresh.childNodes[0].data = "omega";
    if (state === "replacement") f.render("alpha");
    assert.equal(f.capture().status, "unavailable");
    assert.equal(f.resolve(before.value).status, "unavailable");
    assert.equal(f.controller.isTextLocationCurrent(before.receipt), false);
  });
}
test("search highlighting and normalization rebind current ordered text without edit authority", () => {
  const f = fixture(), rendered = f.render("alpha");
  f.publish(rendered); const before = captured(f);
  const highlight = new Box("SPAN", [new Text("al")]);
  highlight.setAttribute("class", "search-highlight current");
  rendered.fresh.childNodes[0].parentNode = null;
  rendered.fresh.childNodes = [];
  rendered.fresh.append(highlight, new Text("pha"));
  highlight.textGeometry = () => [f.rect()];
  assert.equal(captured(f).value.sourceKey, before.value.sourceKey);
  assert.equal(f.resolve(before.value).status, "resolved");
  assert.equal(f.controller.isTextLocationCurrent(before.receipt), false);
  rendered.fresh.childNodes.forEach(node => { node.parentNode = null; });
  rendered.fresh.childNodes = [];
  rendered.fresh.append(new Text("alpha"));
  assert.equal(f.resolve(before.value).status, "resolved");
  assert.equal(f.controller.captureTextRange({ collapsed: false }), null);
});
test("search-shaped wrappers with extra attributes are structural changes, not transparent highlights", () => {
  const f = fixture(), rendered = f.render("alpha");
  f.publish(rendered);
  const highlight = new Box("SPAN", [new Text("alpha")]);
  highlight.setAttribute("class", "search-highlight");
  highlight.setAttribute("style", "display:none");
  rendered.fresh.childNodes[0].parentNode = null; rendered.fresh.childNodes = [];
  rendered.fresh.append(highlight);
  assert.equal(f.capture().status, "unavailable");
});
test("a producer-invalidated mutated Source cannot retain matching-key authority", () => {
  const f = fixture(), rendered = f.render("alpha");
  f.publish(rendered); const result = captured(f);
  rendered.mapped.source = "omega";
  f.clearAdmission();
  assert.equal(f.resolve(result.value).status, "unavailable");
  assert.equal(f.controller.isTextLocationCurrent(result.receipt), false);
});
test("identical-looking structural replacement is stale even when ordered text stays equal", () => {
  const f = fixture(), rendered = f.render("```\ncode\n```");
  f.publish(rendered); const result = captured(f);
  const old = rendered.codes[0], replacement = new Box("CODE", [new Text(old.textContent)]);
  assert.equal(replacement.outerHTML, old.outerHTML);
  replacement.textGeometry = old.textGeometry;
  old.replaceWith(replacement);
  assert.equal(f.resolve(result.value).status, "unavailable");
});
test("actual character exposure respects horizontal ancestor clipping and signed alignment", () => {
  const f = fixture(), rendered = f.render("alpha");
  f.preview.style.overflowX = "hidden"; f.preview.clientWidth = 30;
  rendered.fresh.textGeometry = from => [f.rect(from === 0 ? 50 : 10, -3)];
  f.publish(rendered);
  const result = captured(f);
  assert.equal(result.value.atom, "l");
  assert.equal(result.value.alignment.top, -3);
});
test("a block intersection cannot substitute for a visible character", () => {
  const f = fixture(), rendered = f.render("alpha");
  assert.ok(rendered.fresh.getBoundingClientRect().right > 0);
  rendered.fresh.textGeometry = () => [f.rect(250, 10)];
  f.publish(rendered);
  assert.equal(f.capture().status, "missing");
});
test("clipping above the actual scroller also limits character exposure", () => {
  const f = fixture(), rendered = f.render("alpha");
  f.body.style.overflowX = "hidden"; f.body.clientWidth = 15;
  rendered.fresh.textGeometry = from => [f.rect(from === 0 ? 20 : 10, 10)];
  f.publish(rendered);
  assert.equal(captured(f).value.atom, "l");
});
for (const style of [{ transform: "matrix(1,0,0,1,0,0)" }, { clipPath: "circle(40%)" },
  { opacity: "0" }, { overflowY: "hidden", borderTopLeftRadius: "8px" }]) {
  test("unsupported clipping/style refuses " + JSON.stringify(style), () => {
    const f = fixture(), rendered = f.render("alpha");
    Object.assign(rendered.fresh.style, style);
    f.publish(rendered);
    assert.equal(f.capture().status, "unsupported");
  });
}
test("verified nested vertical scrollers use bounded source-addressed owners", () => {
  const f = fixture(), rendered = f.render("alpha");
  rendered.fresh.style.overflowY = "auto";
  f.publish(rendered);
  assert.ok(rendered.fresh.scrollHeight > rendered.fresh.clientHeight);
  const result = captured(f);
  assert.equal(result.value.alignment.nested.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.value.alignment.nested[0])),
    { start: 0, end: 5, kind: "paragraph", tag: "P", role: "body", top: 10 });
  assert.equal(f.resolve(result.value).status, "resolved");
  assert.equal(result.receipt.nested[0].scroller, rendered.fresh);
});
test("nested code owners resolve offscreen vertically without writing either horizontal offset", () => {
  const f = fixture(), text = "```\ncode\n```";
  let rendered = f.render(text);
  rendered.fresh.style.overflowY = "auto";
  rendered.fresh.scrollLeft = 13; f.preview.scrollLeft = 7;
  f.publish(rendered); const result = captured(f);
  assert.equal(result.value.alignment.nested[0].kind, "code");
  rendered = f.render(text); f.bump();
  rendered.fresh.style.overflowY = "auto"; rendered.fresh.box.top = 300; rendered.fresh.box.bottom = 400;
  rendered.fresh.scrollLeft = 29;
  rendered.codes[0].textGeometry = () => [f.rect(10, 500)];
  const emptySibling = new Box(); emptySibling.parentNode = f.preview;
  f.preview.childNodes.unshift(emptySibling);
  f.publish(rendered);
  const resolved = f.resolve(result.value);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.receipt.nested[0].scroller, rendered.fresh);
  assert.equal(resolved.receipt.nested[0].top, result.value.alignment.nested[0].top);
  assert.equal(rendered.fresh.scrollLeft, 29);
  assert.equal(f.preview.scrollLeft, 7);
  assert.equal(f.controller.isTextLocationCurrent(resolved.receipt), true);
});
test("verified nested chains return inner-to-outer owners, never DOM ordinals", () => {
  const f = fixture(), rendered = f.render("> ```\n> code\n> ```");
  const pre = rendered.codes[0].parentNode;
  pre.style.overflowY = rendered.fresh.style.overflowY = "auto";
  pre.box.top = 2; rendered.fresh.box.top = 1;
  f.publish(rendered);
  const result = captured(f);
  assert.equal(result.value.alignment.nested.length, 2);
  assert.equal(result.receipt.nested[0].scroller, pre);
  assert.equal(result.receipt.nested[1].scroller, rendered.fresh);
  assert.equal(result.value.alignment.nested[0].kind, "code");
  assert.equal(result.value.alignment.nested[1].kind, "blockquote");
  assert.equal(f.resolve(result.value).status, "resolved");
});
test("nested owner extent changes and changed atom context both refuse", () => {
  const f = fixture(), rendered = f.render("alpha");
  rendered.fresh.style.overflowY = "auto"; f.publish(rendered);
  const result = captured(f);
  assert.equal(f.resolve({ ...result.value, alignment: { ...result.value.alignment,
    nested: [{ ...result.value.alignment.nested[0], end: 4 }] } }).status, "unsupported");
  f.bump(); const changed = f.render("alpha suffix"); changed.fresh.style.overflowY = "auto"; f.publish(changed);
  assert.equal(f.resolve(result.value).status, "unsupported");
  assert.equal(f.resolve(result.value).reason, "nested-owner-chain-changed");
});
for (const kind of ["code", "table"]) {
  const content = "The source owner contains this one uniquely identifiable bounded landmark after enough leading padding. This suffix keeps all context inside the owner text.";
  const body = kind === "code" ? "```\n" + content + "\n```" :
    "| header |\n| --- |\n| " + content + " |\n";
  function nestedSetup(f, text) {
    const rendered = f.render(text);
    const owner = kind === "code" ? rendered.codes[0].parentNode : f.preview.querySelectorAll("table")[0];
    owner.style.overflowY = "auto";
    const node = walk(owner).find(node => node.data.includes("landmark"));
    exposeOnly(f, node, node.data.indexOf("landmark"));
    assert.equal(f.publish(rendered).status, "published");
    return { rendered, owner, node };
  }
  test("changed-source " + kind + " survives insertion before its complete owner", () => {
    const f = fixture(); nestedSetup(f, body);
    const before = captured(f);
    assert.equal(before.value.alignment.nested.length, 1, "the owner really scrolls");
    f.bump();
    const after = nestedSetup(f, "A new independent prefix paragraph.\n\n" + body);
    const resolved = f.resolve(before.value);
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.receipt.nested[0].scroller, after.owner);
    assert.notEqual(f.admission().key, before.value.sourceKey, "this is not same-key resolution");
    assert.equal(f.controller.isTextLocationCurrent(before.receipt), false);
    for (const change of [{ kind: "paragraph" }, { tag: "DIV" }, { role: "scroller" }, { start: 999 }, { end: 999 }]) {
      const saved = { ...before.value, alignment: { ...before.value.alignment,
        nested: [{ ...before.value.alignment.nested[0], ...change }] } };
      assert.equal(f.resolve(saved).status, "unsupported", JSON.stringify(change));
    }
    assert.equal(f.resolve({ ...before.value, alignment: { ...before.value.alignment, nested: [] } }).status, "unsupported");
  });
  test("changed-source " + kind + " survives a prefix when the atom was at the document boundary", () => {
    const f = fixture();
    const first = f.render(body), owner = kind === "code" ? first.codes[0].parentNode : first.fresh;
    owner.style.overflowY = "auto";
    const node = kind === "code" ? walk(first.codes[0])[0] : walk(first.fresh.querySelectorAll("th")[0])[0];
    exposeOnly(f, node, 0); f.publish(first);
    const before = captured(f);
    assert.ok(before.value.before.length < 32, "the saved preceding context actually reaches the document boundary");
    f.bump();
    const next = f.render("A new prefix before the complete owner.\n\n" + body);
    const afterOwner = kind === "code" ? next.codes[0].parentNode : f.preview.querySelectorAll("table")[0];
    afterOwner.style.overflowY = "auto";
    exposeOnly(f, walk(afterOwner).find(node => node.data.includes(kind === "code" ? "The source" : "header")), 0);
    assert.equal(f.publish(next).status, "published");
    assert.equal(f.resolve(before.value).status, "resolved");
    f.bump();
    const duplicate = f.render(body + "\n\n" + body);
    for (const owner of f.preview.querySelectorAll(kind === "code" ? "pre" : "table")) owner.style.overflowY = "auto";
    exposeOnly(f, walk(duplicate.fresh).find(node => node.data.includes(kind === "code" ? "The source" : "header")), 0);
    f.publish(duplicate);
    assert.equal(f.resolve(before.value).status, "ambiguous", "boundary context never selects the first duplicate");
  });
  test("changed-source " + kind + " refuses edits inside its owner before the surviving atom", () => {
    const f = fixture(); nestedSetup(f, body);
    const before = captured(f);
    f.bump(); nestedSetup(f, body.replace(content, "Inserted inside the owner. " + content));
    const result = f.resolve(before.value);
    assert.equal(result.status, "unsupported");
    assert.equal(result.reason, "nested-owner-chain-changed");
  });
  test("changed-source " + kind + " refuses duplicate, deleted and reparented targets", () => {
    for (const change of ["duplicate", "deleted", "reparented"]) {
      const f = fixture(); nestedSetup(f, body);
      const before = captured(f); f.bump();
      if (change === "deleted") {
        f.publish(f.render("The old target is gone."));
        assert.equal(f.resolve(before.value).status, "missing");
      } else {
        const next = change === "duplicate" ? body + "\n\n" + body :
          body.split("\n").map(line => "> " + line).join("\n");
        const rendered = f.render(next);
        for (const owner of f.preview.querySelectorAll(kind === "code" ? "pre" : "table")) owner.style.overflowY = "auto";
        if (change === "reparented") rendered.fresh.style.overflowY = "auto";
        exposeOnly(f, walk(f.preview).find(node => node.data.includes("landmark")), content.indexOf("landmark"));
        assert.equal(f.publish(rendered).status, "published");
        const refused = f.resolve(before.value);
        assert.equal(refused.status, change === "duplicate" ? "ambiguous" : "missing");
        assert.equal(refused.reason, "verified-text-match", "a changed provenance block cannot be reused");
      }
    }
  });
}
for (const kind of ["code", "table", "nested"]) {
  const content = "p".repeat(80) + "Z" + "s".repeat(50);
  const body = kind === "table" ? "| header |\n| --- |\n| " + content + " |\n" :
    kind === "nested" ? "> Leading paragraph.\n>\n> ```\n> " + content + "\n> ```\n" :
    "```\n" + content + "\n```";
  function exposeModeOwners(f, rendered) {
    for (const owner of f.preview.querySelectorAll(kind === "table" ? "table" : "pre"))
      owner.style.overflowY = "auto";
    if (kind === "nested") {
      rendered.fresh.style.overflowY = "auto";
      for (const pre of f.preview.querySelectorAll("pre")) pre.style.overflowY = "auto";
    }
    const node = walk(f.preview).find(node => node.data.includes("Z"));
    exposeOnly(f, node, node.data.indexOf("Z"));
  }
  for (const removal of [false, true]) test("mode correspondence maps every " + kind + " owner boundary, removal=" + removal, () => {
    const at = kind === "nested" ? body.indexOf("Leading") + 3 : body.indexOf(content) + 10;
    const inserted = body.slice(0, at) + "unique-prefix!" + body.slice(at);
    const old = removal ? inserted : body, nextText = removal ? body : inserted;
    const f = fixture(), first = f.render(old); exposeModeOwners(f, first); f.publish(first);
    const saved = captured(f).value;
    assert.equal(saved.atom, "Z");
    assert.ok(saved.alignment.nested.length >= (kind === "nested" ? 2 : 1), "real authenticated owners are captured");
    let prepared;
    const next = f.render(nextText, { beforeReplace(source) {
      prepared = f.controller.prepareModeTextCorrespondence(saved, source, "mode-target", f.context());
      assert.equal(prepared.status, "prepared");
      f.controller.publishTextSource(null, f.context());
    } });
    exposeModeOwners(f, next); f.admit(next, "mode-target"); f.bump(); f.publish(next);
    const map = prepared.correspondence;
    assert.equal(Object.keys(map).sort().join(","), "at,fromKey,newEnd,oldEnd,toKey");
    assert.equal(Object.isFrozen(map), true);
    assert.ok(Object.values(map).every(value => typeof value === "string" || Number.isSafeInteger(value)));
    assert.equal(f.resolve(saved).status, "unsupported", "strict history resolution still refuses these changed owner intervals");
    const resolved = f.controller.resolveVisibleText(saved, f.preview, f.context(), map);
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.receipt.range.startContainer.data[resolved.receipt.range.startOffset], "Z");
    assert.equal(f.controller.isTextLocationCurrent(resolved.receipt), true);
    assert.equal(f.controller.resolveVisibleText(saved, f.preview, f.context(), { ...map, toKey: "wrong" }).status, "unsupported");
    assert.equal(f.controller.resolveVisibleText(saved, f.preview, f.context(), { ...map, extra: true }).status, "unsupported");
    const incomplete = { ...saved, alignment: { ...saved.alignment, nested: saved.alignment.nested.slice(1) } };
    assert.equal(f.controller.resolveVisibleText(incomplete, f.preview, f.context(), map).status, "unsupported");
    for (const change of [{ kind: "paragraph" }, { tag: "DIV" }, { start: saved.alignment.nested[0].start + 1 },
      { end: saved.alignment.nested[0].end + 1 }, { role: saved.alignment.nested[0].role === "body" ? "scroller" : "body" }]) {
      const altered = { ...saved, alignment: { ...saved.alignment,
        nested: [{ ...saved.alignment.nested[0], ...change }, ...saved.alignment.nested.slice(1)] } };
      assert.equal(f.controller.resolveVisibleText(altered, f.preview, f.context(), map).status, "unsupported");
    }
  });
}
for (const change of ["repeated-seam", "context", "boundary", "removal-boundary", "replacement", "changed-atom", "deleted-atom",
  "multiple", "old-duplicate", "new-duplicate", "reparent"]) {
  test("mode correspondence refuses unsafe endpoint case: " + change, () => {
    const body = "p".repeat(80) + "Z" + "s".repeat(50);
    let old = "```\n" + body + "\n```", nextText;
    if (change === "repeated-seam") {
      old = "```\n" + "a".repeat(80) + "q".repeat(10) + "Z" + "b".repeat(40) + "\n```";
      nextText = old.slice(0, 10) + "a" + old.slice(10);
    } else if (change === "context") nextText = old.replace("Z", "new Z");
    else if (change === "boundary") nextText = "prefix\n\n" + old;
    else if (change === "removal-boundary") { nextText = old; old = "prefix\n\n" + old; }
    else if (change === "replacement") nextText = old.replace("p", "x");
    else if (change === "changed-atom") nextText = old.replace("Z", "Q");
    else if (change === "deleted-atom") nextText = old.replace("Z", "");
    else if (change === "multiple") nextText = old.slice(0, 10) + "first!" + old.slice(10).replace("Z", "Zsecond!");
    else if (change === "reparent") nextText = old.split("\n").map(line => "> " + line).join("\n");
    else if (change === "old-duplicate") { old += "\n\n" + old; nextText = old.replace("p", "unique!p"); }
    else nextText = old.slice(0, 10) + "p".repeat(32) + "Z" + "s".repeat(32) + "!" + old.slice(10);
    const f = fixture(), first = f.render(old);
    for (const pre of first.codes.map(code => code.parentElement)) pre.style.overflowY = "auto";
    exposeOnly(f, walk(first.codes[0])[0], walk(first.codes[0])[0].data.indexOf("Z")); f.publish(first);
    const saved = captured(f).value;
    let prepared;
    const next = f.render(nextText, { beforeReplace(source) {
      prepared = f.controller.prepareModeTextCorrespondence(saved, source, "target", f.context());
      f.controller.publishTextSource(null, f.context());
    } });
    for (const pre of f.preview.querySelectorAll("pre")) pre.style.overflowY = "auto";
    f.admit(next, "target"); f.bump(); f.publish(next);
    if (change === "new-duplicate") {
      assert.equal(prepared.status, "prepared", "the old side really has unique context and a safe insertion");
      assert.equal(f.controller.resolveVisibleText(saved, f.preview, f.context(), prepared.correspondence).status, "ambiguous");
    } else assert.notEqual(prepared.status, "prepared");
  });
}
function nativeTableDepartureFixture(zoom = 1) {
  const f = fixture(), target = new Box(), table = new Box("TABLE"), head = new Box("THEAD");
  const cell = new Box("TD", [new Text(Array.from({ length: 12 }, (_, index) => "t2c0q" + index + "_body").join(" "))]);
  const headers = Array.from({ length: 6 }, (_, index) => new Box("TH", [new Text("Column " + index)]));
  f.preview.append(target); target.append(table); table.append(head, new Box("TBODY", [new Box("TR", [cell])]));
  head.append(new Box("TR", headers)); table.tHead = head;
  target.box = f.preview.box = f.rect(20, 40, 100 * zoom, 100 * zoom);
  target.clientWidth = 100; target.clientHeight = 100; target.scrollWidth = 3000;
  target.scrollTop = 120; target.scrollLeft = 400; f.preview.scrollTop = 3000;
  const entry = (block, base, top, width) => {
    walk(block)[0].geometry = () => [f.rect(20 + (base - target.scrollLeft) * zoom, top, width * zoom, 16 * zoom)];
    const range = f.doc.createRange(), node = walk(block)[0];
    range.setStart(node, 0); range.setEnd(node, node.length);
    return { block, range };
  };
  const body = entry(cell, 0, 60, cell.textContent.length * 8);
  const mappedHeaders = headers.map((header, index) => entry(header, 450 + index * 400, 50, 64));
  const native = fs.readFileSync(path.join(__dirname, "test-document-editor.js"), "utf8");
  const start = native.indexOf("function positionNativeTableDeparture("), end = native.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start, "the native table departure body is present");
  Object.assign(f.sandbox, { innerWidth: 1000, innerHeight: 1000, scrollerScale: () => zoom });
  vm.runInContext(native.slice(start, end + 2), f.sandbox);
  return { f, target, table, body, headers: mappedHeaders,
    run: () => f.sandbox.positionNativeTableDeparture(target, f.preview, body, mappedHeaders) };
}
for (const zoom of [1, 1.25, 2]) {
  test("native table departure places its body between exact header text at scale " + zoom, () => {
    const a = nativeTableDepartureFixture(zoom), before = [a.target.scrollTop, a.f.preview.scrollTop, a.f.preview.scrollLeft];
    a.run();
    assert.ok(a.target.scrollLeft > 400, "the fixture really needs horizontal placement");
    const first = a.headers[0].range.getClientRects()[0], next = a.headers[1].range.getClientRects()[0];
    assert.ok(first.right <= 20 && next.left >= 20 + 100 * zoom, "the measured viewport excludes both header labels");
    assert.deepEqual([a.target.scrollTop, a.f.preview.scrollTop, a.f.preview.scrollLeft], before);
  });
}
test("native table departure reuses exact source and DOM materialization before its fresh capture", () => {
  const a = nativeTableDepartureFixture(), f = a.f, cell = a.body.block;
  const text = "# Alpha\n\nUnsaved witness native reading modes.\n\n## Mode table\n\n| " +
    a.headers.map(header => header.block.textContent).join(" | ") + " |\n| " + Array(6).fill("---").join(" | ") +
    " |\n| " + cell.textContent + " | other | other | other | other | other |\n";
  const native = fs.readFileSync(path.join(__dirname, "test-document-editor.js"), "utf8");
  const marker = "const rangeProbe = `", start = native.indexOf(marker), end = native.indexOf("}`;", start);
  const functions = native.slice(start + marker.length, end + 1);
  const query = f.preview.querySelectorAll.bind(f.preview), closest = cell.closest.bind(cell);
  f.preview.querySelectorAll = selector => query(selector === "tbody td" ? "td" : selector === "thead th" ? "th" : selector);
  cell.closest = selector => selector === ".table-container" ? a.target : closest(selector);
  Object.assign(f.sandbox, { viewer: f.preview, currentReloadSnapshot: () => text, getViewerScroller: () => f.preview });
  vm.runInContext(functions, f.sandbox);
  const at = text.indexOf(cell.textContent) + 58;
  const reference = f.sandbox.fixtureReference({ start: at, end: at + 1, display: text[at],
    before: text.slice(at - 48, at), after: text.slice(at + 1, at + 49) }, "table");
  const actionMarker = 'if (kind === "table") await nativeExec("position:table history departure", `';
  const actionStart = native.indexOf(actionMarker), actionEnd = native.indexOf("})()`);", actionStart);
  assert.ok(start >= 0 && end > start && actionStart >= 0 && actionEnd > actionStart, "the actual native departure expression is present");
  const expression = native.slice(actionStart + actionMarker.length, actionEnd + 4)
    .replace("${rangeProbe}", functions)
    .replace("${positionNativeTableDeparture.toString()}", f.sandbox.positionNativeTableDeparture.toString())
    .replace("${JSON.stringify(reader.reference)}", JSON.stringify(reference));
  assert.equal(vm.runInContext(expression, f.sandbox), true);
  assert.ok(a.target.scrollLeft > 400, "the actual native expression performed its calculated placement");
  walk(cell)[0].data += " changed";
  let writes = 0;
  Object.defineProperty(a.target, "scrollLeft", { get: () => 400, set() { writes++; } });
  assert.throws(() => vm.runInContext(expression, f.sandbox), /body text is not exact/);
  assert.equal(writes, 0, "source/DOM disagreement refuses before any departure scroll");
});
for (const failure of ["header-text", "header-owner", "missing-header", "nonfinite", "wrapped", "no-gap", "range", "body-hidden", "clamped"]) {
  test("native table departure refuses unsupported setup without retry: " + failure, () => {
    const a = nativeTableDepartureFixture();
    if (failure === "header-text") walk(a.headers[1].block)[0].data = "changed";
    if (failure === "header-owner") a.f.preview.append(a.headers[1].block);
    if (failure === "missing-header") a.headers.pop();
    const rect = a.headers[1].range.getClientRects.bind(a.headers[1].range);
    if (failure === "nonfinite") a.headers[1].range.getClientRects = () => [{ ...rect()[0], left: NaN }];
    if (failure === "wrapped") a.headers[1].range.getClientRects = () => [...rect(), a.f.rect()];
    if (failure === "no-gap") a.headers[1].range.getClientRects = () => [a.f.rect(100, 50, 64, 16)];
    if (failure === "range") a.target.scrollWidth = a.target.clientWidth;
    if (failure === "body-hidden") walk(a.body.block)[0].geometry = () => [a.f.rect(20, 500)];
    let writes = 0, left = a.target.scrollLeft;
    Object.defineProperty(a.target, "scrollLeft", { get: () => left,
      set(value) { writes++; if (failure !== "clamped") left = value; } });
    assert.throws(a.run, /Native table departure/);
    assert.equal(writes, failure === "clamped" ? 1 : 0, "one calculated placement only; no capture or alternate-gap retry");
  });
}
function nativeCodePositionFixture(zoom = 1) {
  const f = fixture(), text = Array.from({ length: 32 }, (_, row) =>
    Array.from({ length: 48 }, (_, column) => "r" + row + "c" + column + "_").join(" ")).join("\n");
  const rendered = f.render("```\n" + text + "\n```"), target = rendered.fresh, block = rendered.codes[0];
  target.box = f.rect(20, 40, 400 * zoom, 240 * zoom);
  target.clientHeight = 200; target.clientWidth = 400; target.scrollHeight = 1000; target.scrollWidth = 2000;
  target.clientTop = target.clientLeft = 1;
  for (const corner of ["TopLeft", "TopRight", "BottomLeft", "BottomRight"]) target.style["border" + corner + "Radius"] = "4px";
  target.style.borderTopWidth = "1px";
  block.textGeometry = from => {
    const row = block.textContent.slice(0, from).split("\n").length - 1;
    return [f.rect(20 - target.scrollLeft * zoom, 40 + (16 + row * 20 - target.scrollTop) * zoom, 1000 * zoom, 13.6 * zoom)];
  };
  const native = fs.readFileSync(path.join(__dirname, "test-document-editor.js"), "utf8");
  const start = native.indexOf("function positionNativeCodeFixture("), end = native.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start, "the native fixture positioning body is present");
  Object.assign(f.sandbox, { innerHeight: 600, scrollerScale: element => element === target ? zoom : 1 });
  vm.runInContext(native.slice(start, end + 2), f.sandbox);
  return { f, target, block, run: () => f.sandbox.positionNativeCodeFixture(target, f.preview) };
}
for (const zoom of [1, 1.25, 2]) {
  test("native code fixture positions an exact interline gap at scale " + zoom, () => {
    const a = nativeCodePositionFixture(zoom);
    a.run();
    assert.ok(a.target.scrollTop > 80 && a.target.scrollLeft === 400, "both axes still travel");
    const text = a.block.textContent;
    const previous = a.block.textGeometry(text.indexOf("\nr8c0_ ") + 1)[0];
    const next = a.block.textGeometry(text.indexOf("\nr9c0_ ") + 1)[0];
    assert.ok(previous.bottom < 40 + zoom && next.top > 40 + 4 * zoom, "the actual line gap clears both clip and corner");
    assert.equal(a.f.metrics.ranges, 2);
    assert.equal(a.f.metrics.rects, 4, "only the same two lines are reread after one placement");
  });
}
for (const failure of ["wrapped", "no-gap", "nonfinite", "radius", "missing-line", "clamped", "range"]) {
  test("native code fixture refuses unsupported setup without retry: " + failure, () => {
    const a = nativeCodePositionFixture(), original = a.block.textGeometry;
    if (failure === "wrapped") a.block.textGeometry = from => [...original(from), a.f.rect(20, 90)];
    if (failure === "no-gap") a.block.textGeometry = from => original(from).map(rect => ({ ...rect, bottom: rect.top + 21 }));
    if (failure === "nonfinite") a.block.textGeometry = from => original(from).map(rect => ({ ...rect, top: NaN }));
    if (failure === "radius") a.target.style.borderTopLeftRadius = "20%";
    if (failure === "missing-line") walk(a.block)[0].data = a.block.textContent.replace("r9c0_", "changed");
    if (failure === "range") a.target.scrollHeight = a.target.clientHeight;
    let writes = 0, top = a.target.scrollTop;
    Object.defineProperty(a.target, "scrollTop", { get: () => top, set(value) { writes++; top = failure === "clamped" ? 0 : value; } });
    assert.throws(a.run, /Native code fixture|Native code positioning/);
    assert.equal(writes, failure === "clamped" ? 1 : 0, "there is no alternate-line or capture-until-success attempt");
  });
}
test("ordinary rounded PRE captures padded text but refuses an actually clipped corner", () => {
  const f = fixture(), rendered = f.render("```\ncode\n```"), pre = rendered.fresh;
  pre.style.overflowY = pre.style.overflowX = "auto";
  pre.style.borderTopLeftRadius = "20px";
  pre.clientLeft = pre.clientTop = 2; pre.clientWidth = pre.clientHeight = 83;
  pre.style.borderLeftWidth = pre.style.borderTopWidth = "2px";
  assert.equal(f.publish(rendered).status, "published");
  assert.equal(captured(f).value.runKind, "code", "ordinary padding clears the corner");
  rendered.codes[0].textGeometry = () => [f.rect(2, 2, 2, 2)];
  assert.equal(f.capture().status, "unsupported", "text inside the rectangular clip can still be corner-clipped");
  const reads = { ...f.metrics }, failure = f.controller.diagnostics().lastReadingCaptureFailure;
  assert.deepEqual(f.metrics, reads, "reading failure diagnostics adds no geometry work");
  assert.equal(failure.stage, "rounded-corner");
  assert.equal(failure.runKind, "code");
  assert.equal(failure.rectCount, 1);
  assert.equal(failure.fragment.left, 2);
  assert.ok(Object.isFrozen(failure) && Object.isFrozen(failure.fragment) &&
    Object.isFrozen(failure.clip) && Object.isFrozen(failure.corner));
  assert.deepEqual(Object.keys(failure).sort(),
    ["blockKind", "clip", "corner", "fragment", "rectCount", "runKind", "stage"]);
  rendered.codes[0].textGeometry = () => [f.rect(20, 20)];
  assert.equal(f.capture().status, "captured", "padded text still succeeds after the refused capture");
  assert.equal(f.controller.diagnostics().lastReadingCaptureFailure, null, "the next capture clears stale failure detail");
  rendered.codes[0].textGeometry = () => [f.rect(4, 11, 0.1, 0.1)];
  assert.equal(f.capture().status, "unsupported", "the inner border-edge arc is tighter than the outer arc");
  rendered.codes[0].textGeometry = () => [f.rect(90, 40, 2, 2)];
  assert.equal(f.capture().status, "missing", "the real scrollbar/client bound excludes this atom");
  pre.style.borderTopLeftRadius = "calc(1px + 1%)";
  rendered.codes[0].textGeometry = () => [f.rect(20, 20)];
  assert.equal(f.capture().status, "unsupported", "unsupported corner shapes remain closed");
});
test("unbound nested scroll containers and excessive depth are unrecordable", () => {
  const f = fixture(), rendered = f.render("```\ncode\n```");
  rendered.codes[0].style.overflowY = "auto";
  f.publish(rendered);
  assert.equal(f.capture().status, "unsupported");
  const simple = f.render("alpha"); f.publish(simple);
  const result = captured(f), nested = Array.from({ length: 5 }, () => ({ start: 0, end: 5, kind: "paragraph", tag: "P", top: 0 }));
  assert.equal(f.resolve({ ...result.value, alignment: { top: 0, nested } }).status, "unsupported");
});
test("geometry and horizontal scroll changes retire ephemeral authority", () => {
  const f = fixture(), rendered = f.render("alpha");
  f.publish(rendered); const result = captured(f);
  f.preview.scrollLeft = 2;
  assert.equal(f.controller.isTextLocationCurrent(result.receipt), false);
  f.preview.scrollLeft = 0; rendered.fresh.box.top = 1;
  assert.equal(f.controller.isTextLocationCurrent(result.receipt), false);
  assert.equal(f.controller.isTextLocationCurrent({ ...result.receipt }), false);
});
test("capture and resolution never schedule, scroll, focus or change editor state", () => {
  const f = fixture(), rendered = f.render("alpha");
  f.editor.value = "pending"; f.editor.selectionStart = 2; f.editor.selectionEnd = 4;
  f.editor.scrollLeft = 19; f.editor.scrollTop = 23; f.editor.dirty = true;
  f.editor.undo = ["old"]; f.preview.scrollLeft = 7;
  for (const [object, properties] of [[f.editor, ["value", "selectionStart", "selectionEnd", "scrollTop", "scrollLeft", "dirty", "undo"]],
    [f.preview, ["scrollTop", "scrollLeft"]]]) {
    for (const property of properties) {
      const value = object[property];
      Object.defineProperty(object, property, { get: () => value,
        set() { throw new Error("read-only API wrote " + property); } });
    }
  }
  const before = JSON.stringify({ effects: f.effects, value: f.editor.value, start: f.editor.selectionStart,
    end: f.editor.selectionEnd, left: f.editor.scrollLeft, top: f.editor.scrollTop, dirty: f.editor.dirty,
    undo: f.editor.undo, previewLeft: f.preview.scrollLeft, previewTop: f.preview.scrollTop });
  f.publish(rendered); const result = captured(f);
  f.resolve(result.value); f.controller.isTextLocationCurrent(result.receipt);
  const after = JSON.stringify({ effects: f.effects, value: f.editor.value, start: f.editor.selectionStart,
    end: f.editor.selectionEnd, left: f.editor.scrollLeft, top: f.editor.scrollTop, dirty: f.editor.dirty,
    undo: f.editor.undo, previewLeft: f.preview.scrollLeft, previewTop: f.preview.scrollTop });
  assert.equal(after, before);
});
test("legacy editing source seals still reject mismatched editor text", () => {
  const f = fixture({ active: true }), rendered = f.render("alpha");
  f.editor.value = "alpha";
  f.controller.commit(rendered.mapped);
  assert.equal(f.controller.sealTextSource(rendered.mapped), true);
  f.editor.value = "pending";
  f.publish(rendered);
  assert.equal(captured(f).value.atom, "a");
  assert.equal(f.controller.sealTextSource(rendered.mapped), false);
  assert.equal(f.controller.captureTextRange({ collapsed: false }), null);
});
test("review: a transformed atom with competing line fragments refuses consistently", () => {
  const f = fixture(), rendered = f.render("&fjlig;");
  assert.equal(rendered.fresh.textContent, "fj");
  rendered.fresh.textGeometry = (from, to) => [
    ...(from < 1 ? [f.rect(10, -30)] : []), ...(to > 1 ? [f.rect(10, 10)] : []),
  ];
  f.publish(rendered);
  const result = f.capture();
  console.log("OBSERVE fragment " + JSON.stringify({ status: result.status, top: result.value?.alignment.top,
    current: result.receipt && f.controller.isTextLocationCurrent(result.receipt) }));
  assert.equal(result.status, "unsupported");
  const reads = { ...f.metrics }, failure = f.controller.diagnostics().lastReadingCaptureFailure;
  assert.deepEqual(f.metrics, reads);
  assert.equal(failure.stage, "multiple-fragments");
  assert.equal(failure.rectCount, 2);
});
for (const overflow of [false, true]) test("review: nested overflow-chain changes retire authority " + overflow, () => {
  const f = fixture(), rendered = f.render("alpha");
  rendered.fresh.style.overflowY = "auto";
  rendered.fresh.scrollHeight = overflow ? 500 : 100;
  f.publish(rendered); const result = captured(f);
  assert.equal(result.value.alignment.nested.length, 1, "the potential auto scroller remains source-addressed");
  rendered.fresh.scrollHeight = overflow ? 100 : 500;
  assert.equal(captured(f).value.alignment.nested.length, 1, "rewrap does not invent or remove the saved owner");
  assert.equal(f.controller.isTextLocationCurrent(result.receipt), false);
});
test("review: calibrated scale preserves exact fractional-height local alignment", () => {
  const f = fixture(), rendered = f.render("alpha");
  f.preview.offsetHeight = f.preview.clientHeight = 1007;
  f.preview.box.height = f.preview.box.bottom = 1007 + 1 / 3;
  f.doc.defaultView.innerHeight = 2000;
  rendered.fresh.textGeometry = () => [f.rect(10, 100)];
  f.publish(rendered);
  assert.equal(captured(f).value.alignment.top, 100);
});
test("review: a hidden preceding branch cannot mask later verified visible text", () => {
  const f = fixture(), rendered = f.render("hidden\n\nvisible");
  rendered.fresh.style.display = "none";
  rendered.fresh.offsetWidth = rendered.fresh.offsetHeight = 0;
  rendered.fresh.box.width = rendered.fresh.box.height = 0;
  rendered.fresh.textGeometry = () => [];
  f.publish(rendered);
  const result = captured(f);
  assert.equal(result.value.atom, "v");
  assert.equal(result.value.start, 8);
});
test("review: visible unsupported geometry still refuses before a supported survivor", () => {
  const f = fixture(), rendered = f.render("unknown\n\nvisible");
  rendered.fresh.style.transform = "matrix(1,0,0,1,0,0)";
  f.publish(rendered);
  assert.equal(f.capture().status, "unsupported");
});
test("review: long deep offscreen text uses interval exclusion rather than scalar probing", () => {
  const f = fixture(), length = 100001, rendered = f.render("a".repeat(length));
  let parent = f.body;
  f.body.childNodes = []; f.preview.parentNode = null;
  for (let depth = 0; depth < 8; depth++) { const next = new Box(); parent.append(next); parent = next; }
  parent.append(f.preview);
  rendered.fresh.textGeometry = (from, to) => [
    ...(from < length - 1 ? [f.rect(10, -100)] : []),
    ...(to > length - 1 ? [f.rect(10, 10)] : []),
  ];
  f.publish(rendered);
  Object.keys(f.metrics).forEach(key => { f.metrics[key] = 0; });
  const result = captured(f);
  console.log("OBSERVE long-text " + JSON.stringify(f.metrics));
  assert.equal(result.value.start, length - 1);
  assert.ok(f.metrics.rects <= 2 * Math.ceil(Math.log2(length)) + 8, "range work " + f.metrics.rects);
  assert.ok(f.metrics.boxes < 100, "ancestor geometry work " + f.metrics.boxes);
});
function exposeOnly(f, node, from = 0, left = 10) {
  for (const text of walk(f.preview)) text.geometry = () => [];
  node.geometry = at => [at === from ? f.rect(left, 10) : f.rect(250, -100)];
}
const tableText = "| A | B |\n| --- | --- |\n| same | same |\n";
test("a source-backed header is a legitimate table atom, not a body-cell reference", () => {
  const f = fixture(), text = "| Column 0 | Column 1 |\n| --- | --- |\n| t2c0q0_ body | t2c1q0_ body |\n";
  const rendered = f.render(text), header = rendered.fresh.querySelectorAll("th")[1];
  exposeOnly(f, walk(header)[0]);
  assert.equal(f.publish(rendered).status, "published");
  const result = captured(f), cell = f.tableIndex(text).tables[0].rows[0].cells[1];
  assert.equal(result.value.runKind, "table");
  assert.equal(result.value.start, cell.start);
  assert.equal(result.value.display, "C");
  const native = fs.readFileSync(path.join(__dirname, "test-document-editor.js"), "utf8");
  const marker = "const rangeProbe = `", start = native.indexOf(marker), end = native.indexOf("}`;", start);
  assert.ok(start >= 0 && end > start, "the actual native reference functions are present");
  Object.assign(f.sandbox, { currentReloadSnapshot: () => text });
  vm.runInContext(native.slice(start + marker.length, end + 1), f.sandbox);
  const prefix = "# Alpha\n\nUnsaved witness native reading modes.\n\n";
  f.sandbox.currentReloadSnapshot = () => prefix + text;
  assert.throws(() => f.sandbox.fixtureReference({ ...result.value,
    start: result.value.start + prefix.length, end: result.value.end + prefix.length }, "table"),
  /has no table body cell/, "the body-only locator still rejects a genuine header instead of relabeling it");
});
test("real table index and original repeated-cell tokens retain distinct exact intervals", () => {
  const f = fixture(), rendered = f.render(tableText), model = f.tableIndex(tableText);
  assert.deepEqual(JSON.parse(JSON.stringify(model.tables[0].rows[1].cells.map(({ start, end }) => [start, end]))), [[26, 30], [33, 37]]);
  const cells = rendered.fresh.querySelectorAll("td");
  assert.equal(cells.length, 2);
  assert.equal(cells[0].parentElement.tagName, "TR");
  assert.equal(cells[0].parentElement.parentElement.tagName, "TBODY");
  assert.equal(cells[0].textContent, cells[1].textContent);
  exposeOnly(f, walk(cells[1])[0]);
  assert.equal(f.publish(rendered).status, "published");
  const result = captured(f);
  assert.equal(result.value.start, 33);
  assert.equal(result.value.end, 34);
  assert.equal(result.value.runKind, "table");
  assert.equal(f.resolve(result.value).status, "resolved");
  assert.equal(rendered.mapped.textSpecs.has(rendered.fresh), false);
  assert.equal(rendered.mapped.editableText.length, 0);
  assert.equal(rendered.mapped.textGroups.length, 0);
  assert.equal(rendered.mapped.captureOwners.some(owner => owner.readingOnly || owner.kind === "cell"), false);
  assert.equal(rendered.mapped.bindings.some(owner => owner.readingOnly || owner.kind === "cell"), false);
  assert.equal(rendered.mapped.bindings.some(owner => Object.hasOwn(owner, "readingTable") || Object.hasOwn(owner, "readingCode")), false);
});
for (const [label, row, cell, offset, start, end, atom, display] of [
  ["escaped pipe", String.raw`| a\|b | x |`, 0, 1, 27, 29, "\\|", "|"],
  ["backslashes before pipe", String.raw`| a\\\|b | x |`, 0, 1, 27, 29, "\\\\", "\\"],
  ["pipe after backslashes", String.raw`| a\\\|b | x |`, 0, 2, 29, 31, "\\|", "|"],
  ["strong", "| **bold** | `code` |", 0, 0, 28, 29, "b", "b"],
  ["inline code", "| **bold** | `code` |", 1, 0, 38, 39, "c", "c"],
  ["emphasis", "| *em* | [go](https://x) |", 0, 0, 27, 28, "e", "e"],
  ["link", "| *em* | [go](https://x) |", 1, 0, 34, 35, "g", "g"],
  ["entity", "| x | &amp; |", 1, 0, 30, 35, "&amp;", "&"],
  ["emoji CRLF", "| x | \u{1f600} |", 1, 0, 30, 32, "\u{1f600}", "\u{1f600}"],
]) test("real table inline provenance: " + label, () => {
  const text = ("| A | B |\n| --- | --- |\n" + row + "\n").replace(/\n/g, label === "emoji CRLF" ? "\r\n" : "\n");
  const f = fixture(), rendered = f.render(text), nodes = walk(rendered.fresh.querySelectorAll("td")[cell]);
  let local = offset;
  const target = nodes.find(node => {
    if (local < node.length) return true;
    local -= node.length; return false;
  });
  assert.ok(target, "the expected displayed character exists in the real parsed cell");
  assert.equal(text.replace(/\r\n/g, "\n").slice(start, end), atom, "literal expected source interval");
  exposeOnly(f, target, local);
  assert.equal(f.publish(rendered).status, "published");
  const result = captured(f);
  assert.equal(result.value.start, start); assert.equal(result.value.end, end);
  assert.equal(result.value.atom, atom); assert.equal(result.value.display, display);
  assert.equal(f.resolve(result.value).status, "resolved");
});
test("table traversal keeps original reference-link tokens from the complete document", () => {
  const text = "| A | B |\n| --- | --- |\n| [go][ref] | x |\n\n[ref]: https://example.invalid/ref\n";
  const f = fixture(), rendered = f.render(text), link = rendered.fresh.querySelectorAll("a")[0];
  assert.equal(link.getAttribute("href"), "https://example.invalid/ref");
  exposeOnly(f, walk(link)[0]);
  f.publish(rendered);
  const result = captured(f);
  assert.equal(result.value.start, 27); assert.equal(result.value.atom, "g");
  assert.equal(result.value.runKind, "table");
});
for (const prefix of ["> ", "  "]) test("table intervals compose through real nested token provenance " + JSON.stringify(prefix), () => {
  const text = prefix === "> " ? tableText.trimEnd().split("\n").map(line => "> " + line).join("\n") + "\n" :
    "- " + tableText.trimEnd().split("\n").join("\n  ") + "\n";
  const f = fixture(), rendered = f.render(text), cells = rendered.fresh.querySelectorAll("td");
  assert.equal(cells.length, 2);
  exposeOnly(f, walk(cells[1])[0]);
  assert.equal(f.publish(rendered).status, "published");
  assert.equal(captured(f).value.start, 39);
});
test("ragged source-backed cells read without promoting synthetic padding or table editability", () => {
  const text = "| A | B |\n| --- | --- |\n| real |\n";
  const f = fixture(), rendered = f.render(text), cells = rendered.fresh.querySelectorAll("td");
  assert.equal(f.tableIndex(text).tables[0].writable, false);
  assert.equal(cells.length, 2); assert.equal(cells[1].textContent, "");
  assert.equal(rendered.mapped.descriptors.some(item => item.kind === "cell" && item.row === 1 && item.column === 1), false);
  exposeOnly(f, walk(cells[0])[0]);
  assert.equal(f.publish(rendered).status, "published");
  const result = captured(f);
  assert.equal(result.value.start, 26); assert.equal(result.value.atom, "r");
  assert.equal(rendered.mapped.textSpecs.has(rendered.fresh), false);
  assert.equal(rendered.mapped.captureOwners.some(item => item.kind === "cell"), false);
  const padding = new Text("fake");
  cells[1].append(padding); padding.geometry = () => [f.rect()];
  assert.equal(f.capture().status, "unavailable");
});
function decorateCode(rendered) {
  const pair = rendered.associations[0].owners[0], code = pair.code, text = code.textContent;
  for (const child of code.childNodes) child.parentNode = null;
  code.childNodes = [];
  const span = new Box("SPAN", [new Text(text.slice(0, 2))]);
  span.setAttribute("class", "token keyword"); span.textGeometry = code.textGeometry;
  code.append(span, new Text(text.slice(2)));
  const button = new Box("BUTTON", [new Text("Copy")]);
  pair.body.append(button); pair.controls = [button]; pair.decorations = [span];
  return { pair, span, button };
}
test("final code binding verifies explicit Prism/control associations before publication", () => {
  const f = fixture(), rendered = f.render("```js\ncode\n```"), { pair } = decorateCode(rendered);
  assert.equal(f.controller.publishTextSource(rendered.mapped, f.context()).reason, "final-binding-required");
  assert.equal(f.bind(rendered).status, "bound");
  assert.equal(f.controller.publishTextSource(rendered.mapped, f.context()).status, "published");
  const result = captured(f);
  assert.equal(result.value.start, 6); assert.equal(result.value.atom, "c");
  assert.equal(f.controller.isTextLocationCurrent(result.receipt), true);
  assert.equal(rendered.mapped.editableText.length, 0);
  pair.code.childNodes[0].childNodes[0].data = "xx";
  assert.equal(f.capture().status, "unavailable");
});
test("retained decorated code bodies require fresh source/context binding and grant no edit seal", () => {
  const f = fixture(), first = f.render("```\ncode\n```"), decoration = decorateCode(first);
  assert.equal(f.bind(first).status, "bound");
  f.controller.publishTextSource(first.mapped, f.context());
  const saved = captured(f).value, retained = first.fresh;
  f.bump();
  const next = f.render("```\ncode\n```", { retained });
  const pair = next.associations[0].owners[0];
  pair.controls = [decoration.button]; pair.decorations = [decoration.span];
  assert.equal(f.controller.publishTextSource(next.mapped, f.context()).reason, "final-binding-required");
  assert.equal(f.bind(next).status, "bound");
  assert.equal(f.controller.publishTextSource(next.mapped, f.context()).status, "published");
  assert.equal(f.resolve(saved).status, "resolved");
  assert.equal(next.mapped.editableText.length, 0);
  assert.equal(next.mapped.textGroups.length, 0);
});
test("actual code-wrapper ownership authenticates its sibling control, not its class", () => {
  const f = fixture(), rendered = f.render("```\ncode\n```"), { pair, button } = decorateCode(rendered), wrapper = new Box();
  button.replaceWith();
  pair.body.replaceWith(wrapper); wrapper.append(pair.body, button);
  pair.wrapper = wrapper; wrapper.style.overflowY = "auto";
  assert.equal(f.publish(rendered).status, "published");
  const result = captured(f);
  assert.equal(result.value.start, 4);
  assert.equal(result.value.alignment.nested[0].role, "scroller");
  assert.equal(result.receipt.nested[0].scroller, wrapper);
  assert.equal(f.resolve(result.value).status, "resolved");
});
test("retained table bodies verify rows and cells against the incoming source, not a prior ordinal", () => {
  const f = fixture(), first = f.render(tableText);
  for (const cell of first.fresh.querySelectorAll("td")) cell.setAttribute("class", "nowrap-col");
  f.publish(first);
  const retained = first.fresh;
  f.bump();
  const next = f.render(tableText, { retained });
  exposeOnly(f, walk(retained.querySelectorAll("td")[1])[0]);
  assert.equal(f.publish(next).status, "published");
  assert.equal(captured(f).value.start, 33);
  assert.equal(next.mapped.editableText.length, 0);
});
test("whole transformed atoms remain exact across an equivalent adjacent text split", () => {
  const f = fixture(), rendered = f.render("&fjlig;");
  f.publish(rendered);
  const old = captured(f), parent = rendered.fresh;
  for (const child of parent.childNodes) child.parentNode = null;
  parent.childNodes = [];
  const first = new Text("f"), second = new Text("j");
  first.geometry = () => [f.rect(10)]; second.geometry = () => [f.rect(18)];
  parent.append(first, second);
  const result = captured(f);
  assert.equal(result.value.atom, "&fjlig;");
  assert.equal(result.value.display, "fj");
  assert.equal(f.resolve(old.value).status, "resolved");
  assert.equal(f.controller.isTextLocationCurrent(result.receipt), true);
});
for (const defect of ["text", "body", "code", "wrapper", "unclaimed-decoration", "unclaimed-control", "stale-context"]) {
  test("final binding refuses " + defect + " without inventing final ownership", () => {
    const f = fixture(), rendered = f.render("```\ncode\n```"), { pair } = decorateCode(rendered), context = f.context();
    if (defect === "text") pair.code.childNodes[1].data = "wrong\n";
    if (defect === "body") pair.body = new Box("PRE", [new Box("CODE", [new Text("code\n")])]);
    if (defect === "code") pair.code = new Box("CODE", [new Text("code\n")]);
    if (defect === "wrapper") { const wrong = new Box(); f.preview.append(wrong); pair.wrapper = wrong; }
    if (defect === "unclaimed-decoration") pair.decorations = [];
    if (defect === "unclaimed-control") pair.controls = [];
    if (defect === "stale-context") f.bump();
    assert.notEqual(f.controller.bindReadingPresentation(rendered.mapped, context, rendered.associations).status, "bound");
    assert.notEqual(f.controller.publishTextSource(rendered.mapped, f.context()).status, "published");
  });
}
function tableWrapper(f, rendered) {
  const pair = rendered.associations[0].owners.find(pair => pair.body.tagName === "TABLE"), wrapper = new Box();
  pair.body.replaceWith(wrapper); wrapper.append(pair.body);
  const button = new Box("BUTTON", [new Box("SVG", [new Box("PATH")])]);
  wrapper.append(button); pair.controls = [button];
  for (const cell of [...pair.body.querySelectorAll("th"), ...pair.body.querySelectorAll("td")]) cell.setAttribute("class", "nowrap-col");
  wrapper.style.overflowY = "auto"; wrapper.style.overflowX = "auto"; wrapper.scrollLeft = 29;
  pair.wrapper = wrapper;
  return { pair, wrapper };
}
for (const claimed of [false, true]) test("only the exact produced breakout table admits its ordinary translation: " + claimed, () => {
  const f = fixture(), rendered = f.render(tableText), { pair, wrapper } = tableWrapper(f, rendered);
  wrapper.style.transform = "matrix(1, 0, 0, 1, -50, 0)";
  if (claimed) pair.breakout = wrapper;
  assert.equal(f.publish(rendered).status, "published");
  assert.equal(f.capture().status, claimed ? "captured" : "unsupported");
  if (claimed) {
    wrapper.style.transform = "matrix(0, 1, -1, 0, 0, 0)";
    assert.equal(f.capture().status, "unsupported", "a table association cannot authorize a rotated owner");
  }
});
test("generated table scroller gets a unique value-addressed role and preserves horizontal offsets", () => {
  const f = fixture(), rendered = f.render(tableText), { wrapper } = tableWrapper(f, rendered);
  const cell = rendered.fresh.querySelectorAll("td")[1];
  wrapper.clientWidth = 30; f.preview.scrollLeft = 7;
  for (const node of walk(f.preview)) node.geometry = () => [];
  walk(cell)[0].geometry = from => [f.rect(from === 0 ? 50 : 10, 10)];
  assert.equal(f.controller.publishTextSource(rendered.mapped, f.context()).reason, "final-binding-required");
  assert.equal(f.bind(rendered).status, "bound");
  assert.equal(f.controller.publishTextSource(rendered.mapped, f.context()).status, "published");
  const result = captured(f);
  assert.equal(result.value.start, 34); assert.equal(result.value.atom, "a");
  assert.equal(result.value.alignment.nested.length, 1);
  assert.equal(result.value.alignment.nested[0].role, "scroller");
  assert.equal(result.value.alignment.nested[0].kind, "table");
  assert.equal(result.receipt.nested[0].scroller, wrapper);
  assert.equal(f.resolve(result.value).status, "resolved");
  assert.equal(wrapper.scrollLeft, 29); assert.equal(f.preview.scrollLeft, 7);
  assert.equal(Object.keys(result.value.alignment.nested[0]).includes("left"), false);
  const row = cell.parentElement, other = row.childNodes.find(node => node.tagName === "TD");
  assert.notEqual(cell, other);
  const at = row.childNodes.indexOf(cell), otherAt = row.childNodes.indexOf(other);
  row.childNodes[at] = other; row.childNodes[otherAt] = cell;
  assert.equal(f.capture().status, "unavailable", "post-bind equal-looking cell reordering invalidates exact node order");
});
test("final table binding rejects wrong row/cell structure before it can create a mapping", () => {
  const f = fixture(), rendered = f.render("| A | B |\n| --- | --- |\n| first | second |\n");
  const cells = rendered.fresh.querySelectorAll("td"), a = cells[0].childNodes, b = cells[1].childNodes;
  cells[0].childNodes = b; cells[1].childNodes = a;
  b.forEach(node => { node.parentNode = cells[0]; }); a.forEach(node => { node.parentNode = cells[1]; });
  assert.equal(f.bind(rendered).status, "unsupported");
  assert.equal(f.controller.publishTextSource(rendered.mapped, f.context()).reason, "final-binding-required");
});
test("binding seals wrapper identity before publication instead of resnapshotting a replacement", () => {
  const f = fixture(), rendered = f.render(tableText), { wrapper } = tableWrapper(f, rendered);
  assert.equal(f.bind(rendered).status, "bound");
  const replacement = new Box();
  for (const child of [...wrapper.childNodes]) replacement.append(child);
  wrapper.childNodes = []; wrapper.replaceWith(replacement);
  assert.equal(f.controller.publishTextSource(rendered.mapped, f.context()).reason, "final-presentation-changed");
});
test("nested table wrappers remain source-addressed inside a verified quote body", () => {
  const f = fixture(), text = tableText.trimEnd().split("\n").map(line => "> " + line).join("\n") + "\n";
  const rendered = f.render(text), { wrapper, pair } = tableWrapper(f, rendered);
  exposeOnly(f, walk(pair.body.querySelectorAll("td")[1])[0]);
  assert.equal(f.publish(rendered).status, "published");
  const result = captured(f);
  assert.equal(result.value.start, 39);
  assert.equal(result.receipt.nested[0].scroller, wrapper);
  assert.equal(f.resolve(result.value).status, "resolved");
});
test("display-none ancestors stay invisible even when mapped descendants have their own display", () => {
  const f = fixture(), rendered = f.render("**hidden**\n\nvisible");
  rendered.fresh.style.display = "none";
  const strong = rendered.fresh.querySelectorAll("strong")[0];
  assert.equal(strong.style.display, "block");
  strong.style.transform = "matrix(1,0,0,1,0,0)";
  f.publish(rendered);
  assert.equal(captured(f).value.atom, "v");
});
test("nested local alignment also uses the supplied calibrated scale", () => {
  const f = fixture(), rendered = f.render("alpha");
  rendered.fresh.style.overflowY = "auto";
  rendered.fresh.offsetHeight = rendered.fresh.clientHeight = 1007;
  rendered.fresh.scrollHeight = 2000;
  rendered.fresh.box.height = rendered.fresh.box.bottom = 1007 + 1 / 3;
  f.preview.box.height = f.preview.clientHeight = f.preview.box.bottom = 2000;
  f.doc.defaultView.innerHeight = 2000;
  rendered.fresh.textGeometry = () => [f.rect(10, 100)];
  f.publish(rendered);
  assert.equal(captured(f).value.alignment.nested[0].top, 100);
});
test("binding, publication and nested capture remain read-only", () => {
  const f = fixture(), rendered = f.render(tableText), { wrapper } = tableWrapper(f, rendered);
  exposeOnly(f, walk(rendered.fresh.querySelectorAll("td")[0])[0]);
  const before = JSON.stringify(f.effects);
  for (const element of [f.preview, wrapper, f.editor]) for (const key of ["scrollTop", "scrollLeft", "value"]) {
    const value = element[key];
    Object.defineProperty(element, key, { get: () => value, set() { throw new Error("forbidden write " + key); } });
  }
  assert.equal(f.publish(rendered).status, "published");
  const result = captured(f);
  assert.equal(f.resolve(result.value).status, "resolved");
  assert.equal(f.controller.isTextLocationCurrent(result.receipt), true);
  assert.equal(JSON.stringify(f.effects), before);
});
for (const text of [tableText, "| A | B |\n| --- | --- |\n| **bold** | `code` |\n", "> | A | B |\n> | --- | --- |\n> | x | y |\n"]) {
  test("reading-only table traversal leaves the existing editing model unchanged " + JSON.stringify(text), () => {
    const disabled = fixture({ bound: false }).render(text), enabled = fixture().render(text);
    const editing = mapped => ({
      bindings: mapped.bindings.map(({ start, end, kind, inline, root, captureBody, codeLines, lines, rows }) =>
        ({ start, end, kind, inline, root, captureBody, codeLines, lines, rows })),
      gaps: mapped.captureGaps,
      captures: mapped.captureOwners.map(({ start, end, kind, captureBody }) => ({ start, end, kind, captureBody })),
      text: mapped.textGroups.map(group => ({ tag: group.element.tagName, text: group.text,
        runs: group.runs.map(run => ({ from: run.from, display: run.display, start: run.view.at(0), end: run.view.at(run.display.length) })) })),
      editable: mapped.editableText.map(group => group.element.tagName),
      tables: [...mapped.editableTables.values()],
    });
    assert.equal(enabled.html, disabled.html);
    assert.equal(JSON.stringify(editing(enabled.mapped)), JSON.stringify(editing(disabled.mapped)));
  });
}
function computedVisibility(f, declarations) {
  const visit = (node, inherited) => {
    const value = declarations.has(node) ? declarations.get(node) : inherited;
    node.style.visibility = value;
    for (const child of node.childNodes) if (child.nodeType === 1) visit(child, value);
  };
  visit(f.body, "visible");
}
test("review: inherited hidden text does not mask a later visible mapped paragraph", () => {
  const f = fixture(), rendered = f.render("**hidden**\n\nvisible"), strong = rendered.fresh.querySelectorAll("strong")[0];
  computedVisibility(f, new Map([[rendered.fresh, "hidden"]]));
  assert.equal(strong.style.visibility, "hidden", "computed visibility is inherited, not the fixture's default");
  assert.equal(rendered.blocks[1].style.visibility, "visible");
  f.publish(rendered);
  const result = captured(f);
  assert.equal(result.value.start, 12); assert.equal(result.value.atom, "v");
});
test("review: an explicitly visible descendant overrides its hidden ancestor", () => {
  const f = fixture(), rendered = f.render("**shown**"), strong = rendered.fresh.querySelectorAll("strong")[0];
  computedVisibility(f, new Map([[rendered.fresh, "hidden"], [strong, "visible"]]));
  assert.equal(rendered.fresh.style.visibility, "hidden");
  assert.equal(strong.style.visibility, "visible");
  f.publish(rendered);
  const result = captured(f);
  assert.equal(result.value.start, 2); assert.equal(result.value.atom, "s");
  assert.equal(f.resolve(result.value).status, "resolved");
  assert.equal(f.controller.isTextLocationCurrent(result.receipt), true);
});
test("review: skip only hidden text, not visible descendants in the same source block", () => {
  const f = fixture(), rendered = f.render("hidden **shown**"), strong = rendered.fresh.querySelectorAll("strong")[0];
  computedVisibility(f, new Map([[rendered.fresh, "hidden"], [strong, "visible"]]));
  assert.equal(rendered.fresh.childNodes[0].nodeType, 3, "the hidden direct text precedes the visible descendant");
  assert.equal(rendered.mapped.source.slice(9, 10), "s");
  f.publish(rendered);
  assert.equal(captured(f).value.start, 9);
});
test("review: a fully hidden source is missing, not unverifiable visible geometry", () => {
  const f = fixture(), rendered = f.render("**hidden**");
  computedVisibility(f, new Map([[rendered.fresh, "hidden"]]));
  f.publish(rendered);
  assert.equal(f.capture().status, "missing");
});
test("review: descendant visibility does not override display-none ancestry", () => {
  const f = fixture(), rendered = f.render("**shown**"), strong = rendered.fresh.querySelectorAll("strong")[0];
  computedVisibility(f, new Map([[rendered.fresh, "hidden"], [strong, "visible"]]));
  rendered.fresh.style.display = "none"; strong.textGeometry = () => [];
  f.publish(rendered);
  assert.equal(f.capture().status, "missing");
});
test("review: visible-under-hidden descendants still validate ancestor transforms and clipping", () => {
  const f = fixture(), rendered = f.render("**shown**"), strong = rendered.fresh.querySelectorAll("strong")[0];
  computedVisibility(f, new Map([[rendered.fresh, "hidden"], [strong, "visible"]]));
  rendered.fresh.style.transform = "matrix(1,0,0,1,0,0)";
  f.publish(rendered);
  assert.equal(f.capture().status, "unsupported");
});
function claimedPrismSpan(rendered) {
  const pair = rendered.associations[0].owners[0], code = pair.code, span = new Box("SPAN", [...code.childNodes]);
  span.setAttribute("class", "token keyword"); span.textGeometry = code.textGeometry;
  code.append(span); pair.decorations = [span];
}
for (const operation of ["bind", "publish"]) for (const callback of ["identity", "presentation", "frozen", "sourceIdentity"]) {
  for (const phase of ["entry", "final"]) test("review: " + operation + " " + phase + " " + callback + " cannot overwrite a successor binding", () => {
    const f = fixture(), text = "```\ncode\n```", rendered = f.render(text);
    if (operation === "publish") assert.equal(f.bind(rendered).status, "bound");
    const target = phase === "entry" ? 1 : 2;
    let calls = 0, successor;
    f.onRead(callback, () => {
      if (++calls !== target) return;
      f.onRead(callback, null);
      claimedPrismSpan(rendered);
      successor = f.bind(rendered);
    });
    const obsolete = operation === "bind" ? f.bind(rendered) :
      f.controller.publishTextSource(rendered.mapped, f.context());
    f.onRead(callback, null);
    assert.equal(calls, target, "the callback really reached the intended read");
    assert.equal(successor?.status, "bound", "the newer binding really completed without publication");
    assert.equal(rendered.mapped.source, text, "source identity and text did not change");
    assert.equal(rendered.codes[0].textContent, "code\n");
    const publication = f.controller.publishTextSource(rendered.mapped, f.context()), capture = f.capture();
    assert.equal(publication.status, "published", "the successor's final mapping survives the obsolete call");
    assert.equal(capture.status, "captured", "successor publication is usable, not just a success-shaped response");
    assert.equal(capture.value.start, 4); assert.equal(capture.value.atom, "c");
    assert.equal(f.controller.isTextLocationCurrent(capture.receipt), true);
    assert.equal(f.resolve(capture.value).status, "resolved");
    assert.equal(obsolete.status, "unavailable");
    assert.equal(rendered.mapped.editableText.length, 0);
  });
}
for (const operation of ["bind", "publish"]) for (const callback of ["identity", "presentation", "frozen", "sourceIdentity"]) {
  test("review: " + operation + "'s final " + callback + " read cannot disturb an already published successor", () => {
    const f = fixture(), rendered = f.render("```\ncode\n```");
    if (operation === "publish") assert.equal(f.bind(rendered).status, "bound");
    let calls = 0, successor, publication, receipt;
    f.onRead(callback, () => {
      if (++calls !== 2) return;
      f.onRead(callback, null);
      claimedPrismSpan(rendered);
      successor = f.bind(rendered);
      publication = f.controller.publishTextSource(rendered.mapped, f.context());
      receipt = captured(f).receipt;
    });
    const obsolete = operation === "bind" ? f.bind(rendered) :
      f.controller.publishTextSource(rendered.mapped, f.context());
    f.onRead(callback, null);
    assert.equal(calls, 2, "the newer publication happened inside the final callback");
    assert.equal(successor?.status, "bound"); assert.equal(publication?.status, "published");
    assert.equal(obsolete.status, "unavailable");
    assert.equal(f.controller.isTextLocationCurrent(receipt), true);
    assert.equal(captured(f).value.atom, "c");
  });
}
test("review: an older retirement cannot clear a valid publication after a newer binding", () => {
  const f = fixture(), rendered = f.render("```\ncode\n```");
  assert.equal(f.publish(rendered).status, "published");
  const before = captured(f);
  let successor;
  f.onRead("presentation", () => {
    f.onRead("presentation", null);
    successor = f.bind(rendered);
  });
  const obsolete = f.controller.publishTextSource(null, f.context());
  assert.equal(successor?.status, "bound");
  assert.equal(obsolete.status, "unavailable");
  assert.equal(f.controller.isTextLocationCurrent(before.receipt), true);
  assert.equal(f.controller.publishTextSource(rendered.mapped, f.context()).status, "published");
  assert.equal(captured(f).value.sourceKey, before.value.sourceKey);
});
for (const operation of ["capture", "resolve", "current"]) for (const callback of ["identity", "presentation", "frozen", "sourceIdentity", "scale"]) {
  test("review: " + operation + " survives newer publication from its " + callback + " callback", () => {
    const f = fixture(), rendered = f.render("alpha");
    assert.equal(f.publish(rendered).status, "published");
    const previous = captured(f);
    let publication, successor;
    f.onRead(callback, () => {
      f.onRead(callback, null);
      publication = f.controller.publishTextSource(rendered.mapped, f.context());
      successor = captured(f);
    });
    const obsolete = operation === "capture" ? f.capture() :
      operation === "resolve" ? f.resolve(previous.value) : f.controller.isTextLocationCurrent(previous.receipt);
    f.onRead(callback, null);
    assert.equal(publication?.status, "published", "callback really published the newer generation");
    assert.equal(successor?.status, "captured");
    assert.equal(operation === "current" ? obsolete : obsolete.status, operation === "current" ? false : "unavailable");
    assert.equal(f.controller.isTextLocationCurrent(successor.receipt), true, "obsolete read cannot retire the new publication");
    assert.equal(captured(f).value.sourceKey, successor.value.sourceKey);
  });
}
for (const options of [{ bound: false }, { sourceIdentity: false }, { sourceIdentity: null },
  { sourceIdentity: {} }, { sourceIdentity: "not-a-function" }]) {
  test("continuity: both callbacks are required without partial reading metadata " + JSON.stringify(options), () => {
    const disabled = fixture({ bound: false, sourceIdentity: false }), f = fixture(options);
    assert.equal(f.admissionWork.lookups, 0, "construction does not invoke identity");
    assert.equal(f.admissionWork.presentations, 0, "construction does not invoke presentation");
    const text = "```\ncode\n```\n\n" + tableText, rendered = f.render(text), baseline = disabled.render(text);
    assert.equal(rendered.mapped.mappingHtml.replaceAll(rendered.mapped.nonce, "NONCE"),
      baseline.mapped.mappingHtml.replaceAll(baseline.mapped.nonce, "NONCE"));
    assert.equal(rendered.mapped.descriptors.some(item => item.readingCode || item.readingTable || item.readingOnly), false);
    assert.equal(rendered.blocks.some(block => rendered.mapped.readingTextSpecs.has(block)), false);
    assert.equal(f.bind(rendered).status, "unavailable");
    assert.equal(f.controller.publishTextSource(rendered.mapped, f.context()).status, "unavailable");
    assert.equal(f.capture().status, "unavailable");
    assert.equal(f.admissionWork.lookups, 0, "partial activation never calls the provider");
  });
}
for (const key of ["x", " ".repeat(128), "\u{1f600}".repeat(64)]) {
  test("continuity: exact primitive label boundary is accepted " + key.length, () => {
    const f = fixture(), rendered = f.render("alpha");
    f.admit(rendered, key);
    assert.equal(f.publish(rendered).sourceKey, key);
    assert.equal(captured(f).value.sourceKey, key);
  });
}
for (const key of [null, undefined, "", "x".repeat(129), 0, 7, NaN, true, Symbol("label"), [], {}, new String("boxed"), Promise.resolve("async"),
  { then() { throw new Error("thenable must not be used"); } }]) {
  test("continuity: malformed label refuses without a fallback " + Object.prototype.toString.call(key) + ":" + String(key).length, () => {
    const f = fixture({ sourceIdentity: () => key }), rendered = f.render("```\ncode\n```");
    assert.equal(f.bind(rendered).status, "unavailable");
    assert.equal(f.controller.publishTextSource(rendered.mapped, f.context()).status, "unavailable");
    assert.equal(f.capture().status, "unavailable");
  });
}
test("continuity: provider receives the exact Source and never null on retirement", () => {
  const f = fixture(), rendered = f.render("alpha"), seen = new Set();
  f.onRead("sourceIdentity", actual => { assert.equal(actual, rendered.mapped); seen.add(actual); });
  assert.equal(f.publish(rendered).status, "published"); captured(f);
  assert.equal(seen.size, 1, "provider was really invoked with this Source");
  const calls = f.admissionWork.lookups;
  assert.equal(f.controller.publishTextSource(null, f.context()).status, "retired");
  assert.equal(f.admissionWork.lookups, calls);
  assert.equal(f.capture().status, "unavailable");
});
test("continuity: a provider failure is explicit and cannot mint a fallback key", () => {
  const f = fixture(), rendered = f.render("alpha");
  f.onRead("sourceIdentity", () => { throw new Error("injected provider failure"); });
  assert.equal(f.bind(rendered).status, "unavailable");
  assert.equal(f.publish(rendered).status, "unavailable");
  assert.equal(f.capture().status, "unavailable");
});
for (const invalidation of ["missing", "stale-source", "key-change", "throw"]) {
  test("continuity: current publication revalidates " + invalidation + " despite unchanged presentation", () => {
    const f = fixture(), rendered = f.render("alpha");
    assert.equal(f.publish(rendered).status, "published");
    const before = captured(f), context = f.context();
    if (invalidation === "missing") f.clearAdmission();
    if (invalidation === "stale-source") {
      f.admit({ mapped: f.controller.source("alpha") }, before.value.sourceKey);
    }
    for (const invalidation of ["missing", "key-change", "throw"]) {
      test("continuity: restoring a provider after " + invalidation + " cannot resurrect publication authority", () => {
        const f = fixture(), rendered = f.render("alpha");
        assert.equal(f.publish(rendered).status, "published");
        const before = captured(f);
        if (invalidation === "missing") f.clearAdmission();
        if (invalidation === "key-change") f.admit(rendered, "unknown");
        if (invalidation === "throw") f.onRead("sourceIdentity", () => { throw new Error("provider unavailable"); });
        assert.equal(f.capture().status, "unavailable");
        f.onRead("sourceIdentity", null); f.admit(rendered, before.value.sourceKey);
        assert.equal(f.capture().status, "unavailable", "a label is not a new publication");
        assert.equal(f.controller.isTextLocationCurrent(before.receipt), false);
        assert.equal(f.publish(rendered).status, "published");
        assert.equal(f.resolve(before.value).status, "resolved");
        assert.equal(f.controller.isTextLocationCurrent(before.receipt), false);
      });
    }
    test("continuity: current admission cannot authorize another controller Source or a stale Source", () => {
      const f = fixture(), old = f.render("alpha");
      assert.equal(f.bind(old).status, "bound");
      const fresh = f.render("alpha");
      assert.equal(f.bind(old).status, "unavailable");
      assert.equal(f.controller.publishTextSource(old.mapped, f.context()).status, "unavailable");
      const foreign = fixture().render("alpha");
      let calls = 0;
      f.onRead("sourceIdentity", () => { calls++; });
      assert.equal(f.bind(foreign).status, "unavailable");
      assert.equal(f.controller.publishTextSource(foreign.mapped, f.context()).status, "unavailable");
      assert.equal(calls, 0, "foreign Sources never reach the provider");
      assert.equal(f.publish(fresh).status, "published");
    });
    test("continuity: an unchanged label still rejects a changed interval atom and display", () => {
      const f = fixture(), rendered = f.render("alpha");
      f.publish(rendered); const before = captured(f), key = f.admission().key;
      rendered.mapped.source = "omega";
      assert.equal(f.admission().key, key, "this deliberately violates the producer's immutable-source obligation");
      assert.equal(f.resolve(before.value).status, "missing");
      assert.equal(f.controller.isTextLocationCurrent(before.receipt), false);
    });
    if (invalidation === "key-change") f.admit(rendered, "replacement-label");
    if (invalidation === "throw") f.onRead("sourceIdentity", () => { throw new Error("provider unavailable"); });
    assert.equal(f.context(), context);
    assert.equal(f.capture().status, "unavailable");
    assert.equal(f.resolve(before.value).status, "unavailable");
    assert.equal(f.controller.isTextLocationCurrent(before.receipt), false);
  });
}
test("continuity: bind admission and final key must agree", () => {
  const f = fixture(), rendered = f.render("```\ncode\n```");
  let calls = 0;
  f.onRead("sourceIdentity", () => { if (++calls === 2) f.admit(rendered, "changed-at-final"); });
  assert.equal(f.bind(rendered).status, "unavailable");
  assert.equal(calls, 2);
  f.onRead("sourceIdentity", null);
  assert.equal(f.bind(rendered).status, "bound");
  assert.equal(f.publish(rendered).status, "published");
});
test("continuity: publication must match the key sealed by final binding", () => {
  const f = fixture(), rendered = f.render("```\ncode\n```");
  assert.equal(f.bind(rendered).status, "bound");
  f.admit(rendered, "replacement-label");
  assert.equal(f.controller.publishTextSource(rendered.mapped, f.context()).status, "unavailable");
  assert.equal(f.bind(rendered).status, "bound");
  assert.equal(f.controller.publishTextSource(rendered.mapped, f.context()).sourceKey, "replacement-label");
});
test("continuity: publication admission and final key must agree without changing presentation", () => {
  const f = fixture(), rendered = f.render("alpha");
  let calls = 0;
  f.onRead("sourceIdentity", () => { if (++calls === 2) f.admit(rendered, "changed-at-final"); });
  assert.equal(f.publish(rendered).status, "unavailable");
  assert.equal(calls, 2);
  f.onRead("sourceIdentity", null);
  assert.equal(f.capture().status, "unavailable");
  assert.equal(f.publish(rendered).sourceKey, "changed-at-final");
});
const continuityText = "a".repeat(90) + "\n\n" + "a".repeat(90);
function admittedLocation(f, kind, key) {
  const text = kind === "duplicate" ? continuityText : kind === "code" ? "```\n" + "a".repeat(90) + "\n```" : tableText;
  const rendered = f.render(text);
  if (key !== undefined) f.admit(rendered, key);
  if (kind !== "duplicate") rendered.fresh.style.overflowY = "auto";
  const node = kind === "duplicate" ? walk(rendered.blocks[1])[0] :
    kind === "code" ? walk(rendered.codes[0])[0] : walk(rendered.fresh.querySelectorAll("td")[1])[0];
  exposeOnly(f, node, kind === "table" ? 0 : 40);
  assert.equal(f.publish(rendered).status, "published");
  return captured(f);
}
for (const route of ["retire", "rebind", "A-B-A"]) for (const kind of ["duplicate", "code", "table"]) {
  test("continuity: admitted label preserves " + kind + " through fresh Source " + route, () => {
    const f = fixture(), before = admittedLocation(f, kind, "tab-A-cache");
    assert.equal(before.value.start, kind === "duplicate" ? 132 : kind === "code" ? 44 : 33);
    if (route === "retire") {
      assert.equal(f.controller.publishTextSource(null, f.context()).status, "retired");
      assert.equal(f.capture().status, "unavailable");
    }
    if (route === "A-B-A") {
      f.bump(); f.setOwner("tab-B");
      assert.equal(f.publish(f.render("other tab")).status, "published");
      f.setOwner("tab-A");
    }
    f.bump();
    const after = admittedLocation(f, kind, "tab-A-cache"), resolved = f.resolve(before.value);
    assert.equal(after.value.sourceKey, before.value.sourceKey);
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.receipt.range.startContainer, after.receipt.range.startContainer);
    assert.equal(resolved.receipt.range.startOffset, after.receipt.range.startOffset);
    assert.equal(f.controller.isTextLocationCurrent(before.receipt), false);
    assert.equal(f.controller.isTextLocationCurrent(resolved.receipt), true);
    assert.equal(f.resolve({ ...before.value, atom: "Z" }).status, "missing");
    assert.equal(f.resolve({ ...before.value, display: "Z" }).status, "missing");
    assert.equal(f.resolve({ ...before.value, start: 9999, end: 10000 }).status, "missing");
  });
}
for (const kind of ["duplicate", "code", "table"]) {
  test("continuity: an unknown return does not resurrect " + kind + " identity", () => {
    const f = fixture(), before = admittedLocation(f, kind, "known-A");
    f.bump(); f.publish(f.render("other admitted content"));
    f.bump(); const after = admittedLocation(f, kind);
    assert.notEqual(after.value.sourceKey, before.value.sourceKey);
    assert.equal(f.resolve(before.value).status, kind === "table" ? "resolved" : "ambiguous");
    assert.equal(f.controller.isTextLocationCurrent(before.receipt), false);
  });
}
test("continuity: rollback-shaped X/Y/X transfers an admitted label with a fresh witness", () => {
  const f = fixture(), before = admittedLocation(f, "duplicate", "X");
  const originalWitness = f.admission().witness;
  f.bump(); f.publish(f.render("Y"));
  const yWitness = f.admission().witness;
  f.bump(); const after = admittedLocation(f, "duplicate", "X");
  assert.notEqual(f.admission().witness, originalWitness);
  assert.notEqual(f.admission().witness, yWitness);
  assert.equal(after.value.sourceKey, before.value.sourceKey);
  assert.equal(f.resolve(before.value).status, "resolved");
  assert.equal(f.controller.isTextLocationCurrent(before.receipt), false);
});
test("continuity: displayed X remains admitted while pending editor/cache is Y", () => {
  const f = fixture(), rendered = f.render("Displayed X");
  f.admit(rendered, "display-X");
  assert.equal(f.publish(rendered).status, "published");
  const displayedWitness = f.admission().witness;
  const pendingCache = { key: "cache-Y", witness: Object.freeze({}) };
  f.editor.value = "Pending Y";
  const pendingSource = f.controller.source("Pending Y");
  assert.notEqual(pendingCache.witness, displayedWitness);
  assert.notEqual(pendingSource, rendered.mapped);
  f.onRead("sourceIdentity", exact => assert.equal(exact, rendered.mapped));
  assert.equal(captured(f).value.sourceKey, "display-X");
  assert.equal(f.admission().witness, displayedWitness);
});
test("continuity: lookup and capture do not compare or normalize full source text", () => {
  const f = fixture(), rendered = f.render("alpha ".repeat(20000));
  f.admit(rendered, "long-current");
  assert.equal(f.publish(rendered).status, "published");
  const normalized = rendered.mapped.source, reads = { fullComparisons: 0 }, before = { ...f.admissionWork };
  const bounded = {
    get length() { return normalized.length; },
    slice: (start, end) => normalized.slice(start, end),
    [Symbol.toPrimitive]() { reads.fullComparisons++; throw new Error("full source coercion"); },
  };
  Object.defineProperty(rendered.mapped, "source", { get: () => bounded });
  const result = captured(f);
  assert.equal(f.controller.isTextLocationCurrent(result.receipt), true);
  assert.equal(f.resolve(result.value).status, "resolved");
  assert.equal(reads.fullComparisons, 0);
  assert.equal(f.admissionWork.comparisons, before.comparisons);
  assert.equal(f.admissionWork.admissions, before.admissions);
  assert.ok(f.admissionWork.lookups > before.lookups);
  assert.ok(JSON.stringify(result.value).length < 700);
  assert.deepEqual(f.effects, { frames: 0, observers: 0, selections: 0, scrolls: 0, focuses: 0 });
});
for (const operation of ["bind", "publish"]) for (const phase of ["entry", "final"]) {
  for (const callback of ["presentation", "identity", "frozen", "sourceIdentity"]) {
    for (const publishes of [false, true]) test("continuity: " + operation + " " + phase + " " + callback +
      " throw preserves a " + (publishes ? "published" : "binding-only") + " successor", () => {
      const f = fixture(), rendered = f.render("```\ncode\n```");
      if (operation === "publish") assert.equal(f.bind(rendered).status, "bound");
      let calls = 0, binding, publication;
      f.onRead(callback, () => {
        if (++calls !== (phase === "entry" ? 1 : 2)) return;
        f.onRead(callback, null);
        claimedPrismSpan(rendered);
        binding = f.bind(rendered);
        if (publishes) publication = f.controller.publishTextSource(rendered.mapped, f.context());
        throw new Error("injected failure after successor");
      });
      const result = operation === "bind" ? f.bind(rendered) : f.controller.publishTextSource(rendered.mapped, f.context());
      assert.equal(binding?.status, "bound");
      if (publishes) assert.equal(publication?.status, "published");
      assert.equal(result.status, "unavailable");
      if (!publishes) assert.equal(f.controller.publishTextSource(rendered.mapped, f.context()).status, "published");
      assert.equal(captured(f).value.atom, "c");
    });
  }
}
for (const operation of ["capture", "resolve", "current"]) {
  for (const callback of ["presentation", "identity", "frozen", "sourceIdentity", "scale"]) {
    for (const phase of ["entry", "final"]) {
      if (callback === "scale" && phase === "final") continue;
      for (const throws of callback === "scale" ? [false] : [false, true]) {
        test("continuity: " + operation + " " + phase + " " + callback + " binding-only" + (throws ? " then throw" : ""), () => {
          const f = fixture(), rendered = f.render("alpha");
          assert.equal(f.publish(rendered).status, "published");
          const before = captured(f);
          let calls = 0, successor;
          f.onRead(callback, () => {
            if (++calls !== (phase === "entry" ? 1 : 2)) return;
            f.onRead(callback, null);
            successor = f.bind(rendered);
            if (throws) throw new Error("injected failure after binding-only successor");
          });
          const result = operation === "capture" ? f.capture() :
            operation === "resolve" ? f.resolve(before.value) : f.controller.isTextLocationCurrent(before.receipt);
          f.onRead(callback, null);
          assert.equal(successor?.status, "bound", "callback really completed a newer binding without publication");
          assert.equal(operation === "current" ? result : result.status, operation === "current" ? false : "unavailable");
          assert.equal(f.controller.isTextLocationCurrent(before.receipt), true, "obsolete read cannot clear the inspected publication");
          assert.equal(captured(f).value.sourceKey, before.value.sourceKey);
        });
      }
    }
  }
}
for (const operation of ["bind", "publish", "capture", "resolve", "current"]) {
  for (const phase of ["entry", "final"]) for (const action of ["retire", "switch"]) for (const throws of [false, true]) {
    test("continuity: " + operation + " " + phase + " identity " + action + (throws ? " then throw" : ""), () => {
      const f = fixture(), rendered = f.render("```\ncode\n```");
      if (operation === "publish") assert.equal(f.bind(rendered).status, "bound");
      let before;
      if (!["bind", "publish"].includes(operation)) {
        assert.equal(f.publish(rendered).status, "published"); before = captured(f);
      }
      let calls = 0, successor, next;
      f.onRead("sourceIdentity", () => {
        if (++calls !== (phase === "entry" ? 1 : 2)) return;
        f.onRead("sourceIdentity", null);
        if (action === "retire") {
          const reads = f.admissionWork.lookups;
          successor = f.controller.publishTextSource(null, f.context());
          assert.equal(f.admissionWork.lookups, reads, "retirement never asks for null's identity");
        } else {
          f.bump(); next = f.render("successor");
          successor = f.publish(next);
        }
        if (throws) throw new Error("provider failed after " + action);
      });
      const result = operation === "bind" ? f.bind(rendered) :
        operation === "publish" ? f.controller.publishTextSource(rendered.mapped, f.context()) :
        operation === "capture" ? f.capture() : operation === "resolve" ? f.resolve(before.value) :
          f.controller.isTextLocationCurrent(before.receipt);
      f.onRead("sourceIdentity", null);
      assert.equal(calls, phase === "entry" ? 1 : 2);
      assert.equal(successor?.status, action === "retire" ? "retired" : "published");
      assert.equal(operation === "current" ? result : result.status, operation === "current" ? false : "unavailable");
      if (action === "retire") {
        assert.equal(f.capture().status, "unavailable");
        assert.equal(f.publish(rendered).status, "published");
      } else {
        const current = captured(f);
        assert.equal(current.value.atom, "s");
        assert.equal(f.admission().source, next.mapped);
        assert.equal(f.controller.isTextLocationCurrent(current.receipt), true);
      }
    });
  }
}
for (const operation of ["capture", "resolve", "current"]) for (const phase of ["entry", "final"]) {
  test("continuity: " + operation + " " + phase + " malformed result after binding cannot clear a successor", () => {
    const f = fixture(), rendered = f.render("alpha");
    assert.equal(f.publish(rendered).status, "published"); const before = captured(f);
    let calls = 0, successor;
    f.onRead("sourceIdentity", () => {
      if (++calls !== (phase === "entry" ? 1 : 2)) return;
      f.onRead("sourceIdentity", null);
      successor = f.bind(rendered);
      f.admit(rendered, null);
    });
    const result = operation === "capture" ? f.capture() :
      operation === "resolve" ? f.resolve(before.value) : f.controller.isTextLocationCurrent(before.receipt);
    assert.equal(successor?.status, "bound");
    assert.equal(operation === "current" ? result : result.status, operation === "current" ? false : "unavailable");
    f.admit(rendered, before.value.sourceKey);
    assert.equal(f.controller.isTextLocationCurrent(before.receipt), true);
    assert.equal(captured(f).value.sourceKey, before.value.sourceKey);
  });
}
for (const publishes of [false, true]) for (const throws of [false, true]) {
  test("continuity: retirement preserves a " + (publishes ? "published" : "binding-only") +
    " successor from presentation" + (throws ? " then throw" : ""), () => {
    const f = fixture(), rendered = f.render("alpha");
    assert.equal(f.publish(rendered).status, "published"); const before = captured(f);
    let binding, publication;
    f.onRead("presentation", () => {
      f.onRead("presentation", null);
      binding = f.bind(rendered);
      if (publishes) publication = f.controller.publishTextSource(rendered.mapped, f.context());
      if (throws) throw new Error("presentation failed after successor");
    });
    assert.equal(f.controller.publishTextSource(null, f.context()).status, "unavailable");
    assert.equal(binding?.status, "bound");
    if (publishes) assert.equal(publication?.status, "published");
    assert.equal(captured(f).value.sourceKey, before.value.sourceKey);
    assert.equal(f.controller.isTextLocationCurrent(before.receipt), !publishes);
  });
}
function producerDeclaration(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "actual producer exists: " + name);
  const indent = source.slice(source.lastIndexOf("\n", start) + 1, start);
  const end = source.indexOf("\n" + indent + "}", start);
  assert.ok(end > start, "actual producer closes: " + name);
  return source.slice(start, end + indent.length + 2);
}

// Extra DOM facts needed by the actual producers. Geometry remains explicit,
// not a browser/layout or compositor claim.
Object.defineProperties(Box.prototype, {
  id: { get() { return this.getAttribute("id") || ""; }, set(value) { this.setAttribute("id", value); } },
  className: { get() { return this.getAttribute("class") || ""; }, set(value) { this.setAttribute("class", value); } },
  dataset: { get() { return new Proxy({}, {
    get: (_target, key) => this.getAttribute("data-" + key.replace(/[A-Z]/g, c => "-" + c.toLowerCase())),
    set: (_target, key, value) => (this.setAttribute("data-" + key.replace(/[A-Z]/g, c => "-" + c.toLowerCase()), value), true),
  }); } },
  nextElementSibling: { get() {
    const siblings = this.parentNode?.childNodes.filter(node => node instanceof Box) || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  } },
  classList: { get() {
    const names = () => (this.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    const toggle = (name, force) => {
      const current = names(), next = force === undefined ? !current.includes(name) : !!force;
      if (next && !current.includes(name)) current.push(name);
      if (this.attrs.has("class") || current.length) this.setAttribute("class", current.filter(n => n !== name || next).join(" "));
      return next;
    };
    return { contains: name => names().includes(name), toggle,
      add: name => toggle(name, true), remove: name => toggle(name, false) };
  } },
  innerHTML: {
    get() { return (this.markup || "") + this.childNodes.map(n => n instanceof Text ? n.data : n.outerHTML).join(""); },
    set(value) { this.markup = value; },
  },
});
Box.prototype.appendChild = function(node) { this.append(node); return node; };
Box.prototype.insertBefore = function(node, before) {
  const previous = node.parentNode;
  if (previous) previous.childNodes.splice(previous.childNodes.indexOf(node), 1);
  this.childNodes.splice(this.childNodes.indexOf(before), 0, node); node.parentNode = this;
};
Box.prototype.after = function(node) {
  const parent = this.parentNode, at = parent.childNodes.indexOf(this);
  parent.childNodes.splice(at + 1, 0, node); node.parentNode = parent;
};
Box.prototype.querySelectorAll = function(selector) {
  const matches = (node, value) => {
    if (value === "*") return true;
    const tag = /^[a-z][a-z0-9]*/i.exec(value)?.[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    for (const entry of value.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(entry[1])) return false;
    for (const entry of value.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g))
      if (entry[2] === undefined ? !node.attrs.has(entry[1]) : node.getAttribute(entry[1]) !== entry[2]) return false;
    return !!tag || value.startsWith(".") || value.startsWith("[");
  };
  const result = [];
  const visit = parent => { for (const child of parent.childNodes) if (child instanceof Box) {
    if (selector.split(",").some(value => matches(child, value.trim()
      .replace(/^#viewer /, "").replace(/^\.markdown-body /, "")))) result.push(child);
    visit(child);
  } };
  visit(this); return result;
};
Box.prototype.closest = function(selector) {
  for (let node = this; node; node = node.parentElement)
    if (selector.split(",").some(tag => node.tagName.toLowerCase() === tag.trim())) return node;
  return null;
};

function producerFixture({ tables = false, markdown = null, beforeImages = null, expectedPublication = true } = {}) {
  const f = fixture({ rendererCallbacks: true }), s = f.sandbox;
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  const collapse = fs.readFileSync(path.join(__dirname, "..", "src", "custom-collapse.js"), "utf8");
  const oldCreate = f.doc.createElement;
  f.doc.createElement = tag => {
    if (tag === "textarea") return oldCreate(tag);
    const node = new Box(tag.toUpperCase());
    node.style.removeProperty = name => { delete node.style[name]; };
    return node;
  };
  f.doc.createDocumentFragment = () => new Box("FRAGMENT");
  f.doc.getElementById = id => id === "viewer" ? f.preview :
    f.preview.querySelectorAll("*").find(node => node.id === id) || null;
  f.doc.querySelector = () => null;
  let publications = 0, mutations = 0;
  s.window.dispatchEvent = () => { publications++; };
  const style = s.getComputedStyle;
  s.getComputedStyle = (node, pseudo) => {
    const result = style(node, pseudo);
    return !pseudo && node.classList.contains("collapsible-section") && node.classList.contains("collapsed")
      ? { ...result, display: "none" } : result;
  };
  Object.assign(s, { viewer: f.preview, editorScroll: f.controller,
    fileOpenSequence: 7, renderGeneration: 4, readingPresentationRevision: 1,
    readingDisplay: null, readingAttributeRecords: new WeakMap(),
    readingGeneratedContainers: new WeakMap(), readingPatchBodies: new WeakMap(),
    readingPseudoRecords: new WeakMap(), readingCollapsibleSections: new WeakMap(),
    collapsedHeaders: new Map(), currentFilePath: "producer.md", tableBreakoutCoalesceTimer: null,
    CSS: { escape: value => value }, clearTimeout() {}, noteViewerMutation() { mutations++; },
    tableColumnSizing: { isDragging: () => false }, markShortColumns() {},
    // The branch and widths are fixture inputs, not measured browser results.
    publishBreakoutBudget: () => ({ splitView: true, available: 100, zoomFactor: 1 }),
  });
  const tab = { id: "tab-A" };
  s.window.CustomTabs = { getActiveTab: () => tab };
  for (const name of ["readingPresentationContext", "readingSourceIdentity", "noteReadingAttribute", "readingAttributeSignature",
    "readingBodyAssociation", "publishReadingPresentation", "refreshReadingPresentation",
    "_collapseKey", "setHeadersCollapsed", "flattenCollapsibleSections", "makeHeadersCollapsible", "expandToHeader",
    "addTableMaximizeButtons", "applyTableBreakout", "applyWideContentLayout", "applyMermaidBreakout", "initImageZoom"])
    vm.runInContext(producerDeclaration(renderer, name), s);
  for (const name of ["collapseAll", "expandAll"])
    vm.runInContext(producerDeclaration(collapse, name), s);
  const delegated = renderer.slice(renderer.indexOf("viewer.addEventListener('click', (e) => {", renderer.indexOf("function makeHeadersCollapsible(")),
    renderer.indexOf("// Auto-expand collapsed sections when navigating via TOC"));
  assert.ok(delegated.startsWith("viewer.addEventListener"), "actual delegated producer exists");
  vm.runInContext(delegated, s);
  const rendered = f.render(markdown || "# Title\n\nSurviving text.\n\n## Section\n\nSection text.\n" +
    (tables ? "\n| One | Two |\n| --- | --- |\n| alpha | beta |\n" : ""));
  for (const [index, header] of f.preview.querySelectorAll("h1,h2,h3,h4,h5,h6").entries()) {
    header.id = "heading-" + index;
    s.noteReadingAttribute(header, "id");
  }
  s.readingDisplay = { tab, source: rendered.mapped, key: f.admission().key,
    selection: 7, generation: 4, finalized: false, published: false,
    associations: rendered.blocks.map(body => s.readingBodyAssociation(body, body, rendered.bindings)) };
  s.makeHeadersCollapsible();
  if (tables) s.addTableMaximizeButtons();
  beforeImages?.(f);
  s.initImageZoom();
  assert.equal(s.publishReadingPresentation(rendered.mapped), expectedPublication, "actual publisher checks actual producer output");
  assert.equal(f.capture().status, expectedPublication ? "captured" : "unavailable", "actual publication controls availability");
  return { ...f, s, rendered, publications: () => publications, mutations: () => mutations,
    republish: () => s.publishReadingPresentation(rendered.mapped) };
}
for (const tables of [false, true]) {
  for (const operation of ["collapseAll", "expandAll"]) {
    test("producer: actual " + operation + " republishes " + (tables ? "tables" : "prose") + " once", () => {
      const f = producerFixture({ tables });
      if (operation === "expandAll") f.s.collapseAll();
      const before = f.publications();
      f.s[operation]();
      assert.equal(f.preview.querySelector("h2").classList.contains("collapsed"), operation === "collapseAll");
      assert.equal(f.preview.querySelector("h1").classList.contains("collapsed"), false, "title survives Collapse All");
      assert.equal(f.s.readingDisplay.published, true);
      assert.equal(f.capture().status, "captured", "surviving visible text still captures");
      assert.equal(f.publications() - before, 1, "one final publication, not one per header or table pass");
      assert.equal(f.s.collapsedHeaders.get(f.s._collapseKey("heading-1")), operation === "collapseAll");
    });
  }
}
test("producer: all-hidden tables still get a final bulk publication", () => {
  const f = producerFixture({ tables: true }), container = f.preview.querySelector(".table-container");
  container.clientWidth = 0;
  const before = f.publications();
  f.s.collapseAll();
  assert.equal(f.s.readingDisplay.published, true);
  assert.equal(f.capture().status, "captured");
  assert.equal(f.publications() - before, 1);
});
test("producer: individual heading and TOC share current ownership and publication", () => {
  const f = producerFixture({ markdown: "# Title\n\nVisible.\n\n## Outer\n\nOuter.\n\n### Inner\n\nInner.\n" });
  const outer = f.preview.querySelector("h2"), inner = f.preview.querySelector("h3");
  const click = f.preview.listeners.get("click");
  assert.equal(click.length, 1, "exact production delegated listener installed");
  click[0]({ target: outer });
  assert.equal(outer.classList.contains("collapsed"), true);
  assert.equal(f.capture().status, "captured");
  const before = f.publications();
  f.s.expandToHeader(inner.id);
  assert.equal(outer.classList.contains("collapsed"), false);
  assert.equal(f.s.collapsedHeaders.get(f.s._collapseKey(outer.id)), false);
  assert.equal(f.capture().status, "captured");
  assert.equal(f.publications() - before, 1);
});
test("producer: bodyless headings retain bulk state without inventing a section", () => {
  const f = producerFixture({ markdown: "# Title\n\nVisible.\n\n## Empty\n" }), header = f.preview.querySelector("h2");
  assert.equal(f.s.readingCollapsibleSections.has(header), false);
  f.s.collapseAll();
  assert.equal(header.classList.contains("collapsed"), true);
  assert.equal(f.s.collapsedHeaders.get(f.s._collapseKey(header.id)), true);
  assert.equal(f.capture().status, "captured");
  f.s.expandAll();
  assert.equal(header.classList.contains("collapsed"), false);
  assert.equal(f.capture().status, "captured");
});
for (const changed of ["header-class", "section-class", "section-attribute", "section-identity"]) {
  test("producer: bulk mutation never authorizes foreign " + changed, () => {
    const f = producerFixture(), header = f.preview.querySelector("h2");
    const section = f.s.readingCollapsibleSections.get(header).section;
    if (changed === "header-class") header.classList.add("foreign");
    if (changed === "section-class") section.classList.add("foreign");
    if (changed === "section-attribute") section.setAttribute("title", "foreign");
    if (changed === "section-identity") {
      const foreign = new Box("DIV");
      for (const { name, value } of section.attributes) foreign.setAttribute(name, value);
      foreign.append(...section.childNodes);
      section.replaceWith(foreign);
    }
    f.s.collapseAll();
    assert.equal(f.s.readingDisplay.published, false);
    assert.equal(f.capture().status, "unavailable");
  });
}
const imageMarkdown = "Unrelated target text.\n\nBefore ![logo](logo.png) after";
function imageProducerFixture() {
  const f = producerFixture({ markdown: imageMarkdown });
  const image = f.preview.querySelector("img"), paragraph = image.closest("p");
  paragraph.box = f.rect(0, 1000, 100, 30);
  paragraph.textGeometry = (from, to) => [f.rect(10 + from * 8, 1000, (to - from) * 8)];
  assert.equal(f.capture().status, "captured", "unrelated text is visible with the image paragraph offscreen");
  assert.equal(f.capture().value.start, 0);
  return { ...f, image, paragraph, produced: f.s.readingGeneratedContainers.get(image) };
}
test("producer: offscreen inline image keeps adjacent source and unrelated destinations available", () => {
  const f = imageProducerFixture();
  assert.equal(f.image.parentElement, f.produced.wrapper);
  assert.equal(f.produced.wrapper.childNodes[1], f.produced.control);
  assert.equal(f.paragraph.textContent, "Before  after");
  const mutations = f.mutations();
  f.s.initImageZoom();
  assert.equal(f.mutations(), mutations, "repeat producer pass preserves exact registered identities");
  assert.equal(f.republish(), true);
  assert.equal(f.capture().status, "captured");
  assert.equal(f.capture().value.start, 0);
});
test("producer: unregistered same-class image wrapper never gains producer authority", () => {
  const f = producerFixture({ markdown: imageMarkdown, expectedPublication: false, beforeImages(current) {
    const image = current.preview.querySelector("img"), foreign = new Box("DIV"), button = new Box("BUTTON");
    foreign.className = "img-zoom-container"; button.className = "img-zoom-btn";
    image.parentNode.insertBefore(foreign, image);
    foreign.append(image, button);
  } });
  assert.equal(f.s.readingGeneratedContainers.has(f.preview.querySelector("img")), false);
  assert.equal(f.s.readingDisplay.published, false);
});
for (const changed of ["wrapper", "control", "wrapper-attribute", "control-attribute",
  "control-content", "surrounding-text", "src", "alt"]) {
  test("producer: image translation refuses foreign or changed " + changed, () => {
    const f = imageProducerFixture(), { wrapper, control } = f.produced;
    if (changed === "wrapper") {
      const foreign = new Box("DIV", [f.image, control]);
      for (const { name, value } of wrapper.attributes) foreign.setAttribute(name, value);
      wrapper.replaceWith(foreign);
    }
    if (changed === "control") {
      const foreign = new Box("BUTTON");
      for (const { name, value } of control.attributes) foreign.setAttribute(name, value);
      foreign.innerHTML = control.innerHTML;
      control.replaceWith(foreign);
    }
    if (changed === "wrapper-attribute") wrapper.setAttribute("title", "foreign");
    if (changed === "control-attribute") control.setAttribute("title", "foreign");
    if (changed === "control-content") control.innerHTML += "foreign";
    if (changed === "surrounding-text") f.paragraph.childNodes[0].data = "Changed ";
    if (changed === "src" || changed === "alt") f.image.setAttribute(changed, "foreign");
    f.s.initImageZoom();
    assert.equal(f.republish(), false);
    assert.equal(f.capture().status, "unavailable");
  });
}
test("producer: control mutations invalidate an already-published image before republishing", () => {
  const f = imageProducerFixture();
  f.produced.control.setAttribute("title", "changed");
  assert.equal(f.capture().status, "unavailable");
});
test("producer: image publication keeps exact owner and selection admission", () => {
  const f = imageProducerFixture();
  f.s.window.CustomTabs.getActiveTab = () => ({ id: "different-owner" });
  assert.equal(f.republish(), false);
  assert.equal(f.capture().status, "unavailable");
});
console.log(`=== ${passed}/${total} passed ===`);
process.exitCode = passed === total ? 0 : 1;
