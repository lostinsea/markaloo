"use strict";
const isolation = require("./test-userdata-isolation");
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// This route never loads Main, a preload, saved documents or the user's profile.
const storage = isolation.USER_DATA_DIR;
const redirectedPaths = ["appData", "sessionData", "temp", "logs", "crashDumps"];
for (const name of redirectedPaths) {
  const directory = path.join(storage, name);
  fs.mkdirSync(directory);
  if (name === "logs") app.setAppLogsPath(directory);
  else app.setPath(name, directory);
}
app.disableHardwareAcceleration();
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
let renderer = read("src/renderer.js");
const withoutModePosition = process.argv.includes("--without-mode-position");
const withoutSavedRestore = process.argv.includes("--without-saved-restore");
if (withoutModePosition) {
  const anchor = "    restoreModeCharacter();";
  assert.equal(renderer.split(anchor).length - 1, 2, "Both mode-only restore calls must resolve");
  renderer = renderer.replaceAll(anchor, "");
}
const tabsSource = read("src/custom-tabs.js");
function section(start, end) {
  const from = renderer.indexOf(start), to = renderer.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return renderer.slice(from, to);
}
function declaration(name, source = renderer, indent = "") {
  const start = source.indexOf("function " + name + "(");
  const end = source.indexOf("\n" + indent + "}", start);
  assert.ok(start >= 0 && end > start, name);
  return (source.slice(start - 6, start) === "async " ? "async " : "") +
    source.slice(start, end + 2 + indent.length);
}
const savedPositionDeclaration = declaration("restorePosition", tabsSource, "  ");
const receipt = {
  pid: process.pid, storage, withoutModePosition, withoutSavedRestore,
  bootstrap: {
    ready: app.isReady(),
    userDataDir: isolation.USER_DATA_DIR,
    postWipeEntries: isolation.POST_WIPE_ENTRIES,
    paths: Object.fromEntries(["userData", ...redirectedPaths].map(name => [name, app.getPath(name)])),
  },
  assertions: [], observations: [], errors: [], notRun: [],
  executedRendererHash: crypto.createHash("sha256").update(renderer).digest("hex"),
  executedSavedPositionHash: crypto.createHash("sha256").update(
    withoutSavedRestore ? "function restorePosition() {}" : savedPositionDeclaration).digest("hex"),
  sources: Object.fromEntries(["src/renderer.js", "src/editor-scroll.js", "src/reading-viewport.js",
    "src/custom-tabs.js", "src/styles.css", "src/custom-styles.css", "src/table-source.js",
    "src/table-marked.js", "src/inline-formatting.js", "libs/vendor/marked.min.js",
    "test/test-edit-mode-position.js", "test/test-userdata-isolation.js"].map(file =>
    [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")])),
};
const check = (name, ok, detail) => {
  receipt.assertions.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
};
let win;
const exec = code => win.webContents.executeJavaScript(code, true);
async function run() {
  win = new BrowserWindow({ width: 1200, height: 900, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true } });
  win.webContents.on("console-message", event => {
    if (event.level === "error") receipt.errors.push(event.message);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const css = read("src/styles.css") + read("src/custom-styles.css");
  const htmlFile = path.join(storage, "fixture.html");
  fs.writeFileSync(htmlFile, `<!doctype html>
    <style>${css}</style><div class="container"><div class="header">
    <button id="openEditorBtn">Edit</button><button id="toggleEdit">Open editor</button>
    <button id="refreshBtn">Reload</button></div><div class="search-anchor"></div>
    <div class="main-content"><div class="content-wrapper"><div class="editor-panel">
    <div class="editor-header"><button id="exitEditBtn">Exit</button></div>
    <textarea id="markdownEditor"></textarea></div><div class="editor-splitter"></div>
    <div id="viewer" class="markdown-body"></div></div></div></div>`);
  await win.loadFile(htmlFile);
  for (const file of ["libs/vendor/marked.min.js", "src/table-source.js", "src/table-marked.js",
    "src/inline-formatting.js", "src/editor-scroll.js", "src/reading-viewport.js"]) {
    await exec(read(file) + "\n;true");
  }
  await exec(`
    const viewer = document.getElementById('viewer'), markdownEditor = document.getElementById('markdownEditor');
    const contentWrapper = document.querySelector('.content-wrapper');
    const toggleEditBtn = document.getElementById('toggleEdit'), openEditorBtn = document.getElementById('openEditorBtn');
    const exitEditBtn = document.getElementById('exitEditBtn'), refreshBtn = document.getElementById('refreshBtn');
    const fileMenu = document.createElement('div');
    let isEditMode = false, fileOpenSequence = 1, renderGeneration = 0, editorModeRevision = 0;
    let editorExitOperation = null, editSessionBaseline = null, previewDebounceTimer = null;
    let hasUnsavedChanges = false, exactTypingSource = null;
    let originalMarkdown = '# Position fixture\\n\\n' + Array.from({length: 100}, (_, i) =>
      'Passage ' + String(i).padStart(3, '0') + '. ' +
      Array.from({length: i === 50 ? 160 : 9}, (_, j) =>
        'Sentence ' + String(j).padStart(3, '0') + ' in this passage must survive the real Edit button and its narrower preview. '
      ).join('')).join('\\n\\n');
    const markdownFixture = originalMarkdown;
    const currentFilePath = 'C:\\\\synthetic\\\\position.md';
    const tab = { id: 1, filePath: currentFilePath, content: originalMarkdown };
    let readingSourceRevision = 1;
    const readingKey = () => 'synthetic-source-' + readingSourceRevision;
    window.CustomTabs = {
      getActiveTab: () => tab,
      admitReadingSource: (candidate, source) =>
        candidate === tab && source?.source === tab.content ? readingKey() : null,
      hasReadingSource: (candidate, source, key) =>
        candidate === tab && key === readingKey() && source?.source === tab.content,
      snapshotExactEditorContent: () => markdownEditor.value,
    };
    const mayMutateRendererDocument = () => true, frozenForShutdown = () => false;
    const currentDocumentActionOwner = () => tab, currentSaveDocumentIdentity = () => ({documentGeneration: 1});
    const pendingSaveFor = () => null, hasPendingSaveFor = () => false;
    const hideDocumentContextMenus = () => {}, tableColumnSizing = { cancel() {} }, tableCellSession = null;
    let modeBoundaryHook = null;
    const updateEditorHistoryControls = () => {};
    const applyTableBreakout = () => {
      const hook = modeBoundaryHook;
      modeBoundaryHook = null;
      hook?.();
    };
    const captureEditSessionBaseline = () => {}, saveFailedFor = () => false, reloadConflictFor = () => false;
    const setDocumentDirtyState = value => { hasUnsavedChanges = value; };
    const retainCurrentDocumentEditor = () => {}, assertFileTrackingOwnership = () => {};
    const cancelEditorDeferredWork = () => { previewDebounceTimer = null; };
    const noteViewerMutation = () => {}, resyncSearchAfterRender = () => {};
    const sanitizeHtml = html => html;
    ${section("let readingDisplay = null;", "const editorScroll = window.createEditorScroll(")}
    ${declaration("createReadingViewportLifecycle")}
    const readingViewport = createReadingViewportLifecycle();
    ${declaration("getViewerScroller")}
    ${declaration("scrollerScale")}
    ${declaration("snapScrollerScale")}
    const editorScroll = window.createEditorScroll({
      editor: markdownEditor, preview: viewer, active: () => isEditMode, frozen: frozenForShutdown,
      identity: () => fileOpenSequence, scale: scrollerScale,
      presentation: readingPresentationContext, readingSourceIdentity,
    });
    ${declaration("setEditorPresentation")}
    let modeOperation = Promise.resolve();
    const changeMode = window.changeCurrentDocumentEditor;
    window.changeCurrentDocumentEditor = (...args) => modeOperation = changeMode(...args);
    ${section("toggleEditBtn.addEventListener('click'", "// Editor/viewer splitter")}
    ${section("function _blockHash(", "// Longest common subsequence")}
    ${declaration("_lcsPairs")}
    ${declaration("slugifyHeading")}
    ${declaration("assignHeadingIds")}
    const collapsedHeaders = new Map();
    ${declaration("_collapseKey")}
    ${declaration("makeHeadersCollapsible")}
    const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';
    const getScroller = getViewerScroller, mayMutateDocument = () => true;
    ${declaration("offsetWithin", tabsSource, "  ")}
    ${declaration("captureAnchor", tabsSource, "  ")}
    ${declaration("resolveAnchorTop", tabsSource, "  ")}
    ${withoutSavedRestore ? "function restorePosition() {}" : savedPositionDeclaration}
    let cancelActiveRestore = null;
    window.readingViewport = readingViewport;
    window.addEventListener('reading-viewport-invalidated', () => cancelActiveRestore?.());
    async function renderMarkdown(value, _force, viewport = {}) {
      renderGeneration++;
      const source = editorScroll.source(value), admission = captureReadingAdmission(source, renderGeneration);
      source.prepare(value => value, marked, '@@@');
      const html = source.parse(marked);
      patchViewerDOM(html, source, readingViewport.capturePermit(), admission, viewport.modeReading);
      assignHeadingIds(viewer.querySelectorAll(HEADING_SELECTOR));
      makeHeadersCollapsible();
      editorScroll.commit(source);
      publishReadingPresentation(source);
      viewport.completion = Promise.resolve();
    }
    let interior = null;
    window.fixture = {
      async initialize() {
        setEditorPresentation(false);
        markdownEditor.value = originalMarkdown;
        await renderMarkdown(originalMarkdown);
      },
      async document(kind) {
        originalMarkdown = kind === 'markdown' || kind === 'markdown-offscreen' ? markdownFixture
          : markdownFixture.replace(/^(Passage[^\\n]+)$/gm, '<p>$1</p>');
        if (kind === 'html-only' || kind === 'html-offscreen') {
          originalMarkdown = originalMarkdown.replace(/^# Position fixture/, '<h1>Position fixture</h1>');
        }
        if (kind.endsWith('-offscreen')) {
          const heading = kind === 'html-offscreen' ? '</h1>' : '# Position fixture';
          originalMarkdown = originalMarkdown.replace(heading, heading + '\\n\\n' +
            '<pre style="height:120px;overflow:auto">' + 'Earlier clipped line.\\n'.repeat(60) + '</pre>');
        }
        if (tab.content !== originalMarkdown) readingSourceRevision++;
        tab.content = originalMarkdown;
        readingViewport.beginIntent();
        await this.initialize();
      },
      async settle() {
        await modeOperation;
        const start = performance.now();
        let last = '', stable = 0;
        while (performance.now() - start < 6000) {
          await new Promise(requestAnimationFrame);
          const d = editorScroll.diagnostics();
          const signature = [isEditMode, getViewerScroller().scrollTop, markdownEditor.scrollTop, d.builds].join('|');
          stable = signature === last && (!isEditMode || d.ready && !d.pendingGeometry) ? stable + 1 : 0;
          last = signature;
          if (stable >= 3) return;
        }
        throw new Error('Mode geometry did not settle');
      },
      locate(index) {
        interior = null;
        if (index === 0) { getViewerScroller().scrollTop = 0; return; }
        const text = 'Passage ' + String(index).padStart(3, '0') + '.';
        const paragraph = [...viewer.querySelectorAll('p')].find(p => p.textContent.startsWith(text));
        if (!paragraph) throw new Error('Missing fixture passage');
        const scroller = getViewerScroller();
        scroller.scrollTop += paragraph.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 35;
      },
      async rememberAndReload(index) {
        const anchor = captureAnchor();
        await this.initialize();
        this.locate(index === 0 ? 96 : 0);
        const displaced = this.capture();
        restorePosition(anchor, readingViewport.capturePermit());
        return displaced;
      },
      locateInterior() {
        const paragraph = [...viewer.querySelectorAll('p')].find(p => p.textContent.startsWith('Passage 050.'));
        const node = paragraph.firstChild, offset = node.data.indexOf('Sentence 080');
        if (offset < 0 || node.nodeType !== Node.TEXT_NODE) throw new Error('Interior text setup is missing');
        const range = document.createRange();
        range.setStart(node, offset); range.setEnd(node, offset + 'Sentence 080'.length);
        const scroller = getViewerScroller();
        scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 35;
        const top = scroller.getBoundingClientRect().top + scroller.clientTop;
        let low = 0, high = offset;
        while (low < high) {
          const middle = (low + high) >>> 1;
          range.setStart(node, middle); range.setEnd(node, middle + 1);
          if (range.getBoundingClientRect().bottom > top) high = middle;
          else low = middle + 1;
        }
        interior = { node, offset: low };
      },
      forceEntryRender() { editorScroll.changed(); },
      locateNestedBlock() {
        const pre = viewer.querySelector('pre'), scroller = getViewerScroller();
        scroller.scrollTop += pre.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 35;
      },
      escapeNestedText() {
        viewer.querySelector('pre').innerHTML = '<span style="position:fixed;top:80px">Escaping visible text</span>' +
          'Earlier clipped line.\\n'.repeat(60);
      },
      probeModeCapture() {
        let calls = 0;
        const ordinary = editorScroll.captureVisibleText(getViewerScroller());
        const result = editorScroll.captureVisibleText(getViewerScroller(), () => calls++,
          node => readingPseudoRecords.get(node));
        return { calls, status: result.status, reason: result.reason,
          ordinary: { status: ordinary.status, reason: ordinary.reason } };
      },
      supersedeEntry() {
        modeBoundaryHook = () => { readingViewport.beginIntent(); this.locate(96); };
      },
      capture() {
        const scroller = getViewerScroller(), bounds = scroller.getBoundingClientRect();
        const offscreenBlock = viewer.querySelector('pre');
        let nestedTextVisible = false;
        if (offscreenBlock) {
          const range = document.createRange(), box = offscreenBlock.getBoundingClientRect();
          range.setStart(offscreenBlock.firstChild, 0); range.setEnd(offscreenBlock.firstChild, 1);
          const rect = range.getBoundingClientRect();
          nestedTextVisible = rect.bottom > Math.max(bounds.top, box.top) &&
            rect.top < Math.min(bounds.bottom, box.bottom);
        }
        const escaping = offscreenBlock?.querySelector('span')?.getBoundingClientRect();
        const visible = [...viewer.querySelectorAll('p')].filter(p => {
          const box = p.getBoundingClientRect();
          return box.bottom > bounds.top && box.top < bounds.bottom;
        });
        let interiorVisible = null, interiorTop = null, interiorLineHeight = null;
        if (interior?.node.isConnected) {
          const range = document.createRange();
          range.setStart(interior.node, interior.offset);
          range.setEnd(interior.node, interior.offset + 1);
          interiorVisible = [...range.getClientRects()].some(rect => rect.bottom > bounds.top && rect.top < bounds.bottom);
          interiorTop = range.getBoundingClientRect().top - bounds.top;
          interiorLineHeight = parseFloat(getComputedStyle(interior.node.parentElement).lineHeight);
        }
        const reading = captureReadingLocation(), atom = reading.location?.text;
        let exactLiteral = false;
        if (atom?.blockKind === "P" && atom.runKind === "text") {
          const from = originalMarkdown.lastIndexOf("<p>", atom.start) + 3;
          const to = originalMarkdown.indexOf("</p>", atom.start);
          const paragraph = visible[0], text = paragraph?.firstChild;
          if (from >= 3 && atom.start >= from && atom.end <= to &&
              originalMarkdown.slice(atom.start, atom.end) === atom.display &&
              paragraph?.childNodes.length === 1 && text?.nodeType === Node.TEXT_NODE &&
              text.data === originalMarkdown.slice(from, to)) {
            const range = document.createRange();
            range.setStart(text, atom.start - from);
            range.setEnd(text, atom.end - from);
            const rect = range.getBoundingClientRect();
            exactLiteral = rect.bottom > bounds.top && rect.top < bounds.bottom &&
              Math.abs(rect.top - bounds.top - scroller.clientTop - atom.alignment.top) <= 1;
          }
        }
        return { mode: isEditMode, top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight,
          interiorVisible, interiorTop, interiorLineHeight, interiorOffset: interior?.offset, renderGeneration,
          earlierBlockOffscreen: offscreenBlock ? offscreenBlock.getBoundingClientRect().bottom < bounds.top : null,
          nestedTextVisible, nestedOverflowing: offscreenBlock ? offscreenBlock.scrollHeight > offscreenBlock.clientHeight : null,
          escapingTextVisible: escaping ? escaping.bottom > bounds.top && escaping.top < bounds.bottom : null,
          visible: visible.map(p => p.textContent.slice(0, 12)), reading, exactLiteral,
          diagnostics: editorScroll.diagnostics(), failure: lastReadingRestoreFailure };
      },
    };
    fixture.initialize().then(()=>true);
  `);
  for (const kind of ["markdown", "html", "html-only", "html-offscreen", "html-mixed-offscreen", "markdown-offscreen"]) {
    await exec(`fixture.document(${JSON.stringify(kind)}).then(()=>true)`);
    for (const remembered of [false, true]) for (const index of kind.endsWith("-offscreen") ? [50, 96] : [50, 96, 0]) {
      const label = `${kind} ${remembered ? "restoration producer" : "manual position"} passage ${index}`;
      await exec(`fixture.locate(${index});true`);
      if (remembered) {
        const displaced = await exec(`fixture.rememberAndReload(${index})`);
        check(`${label}: restoration starts away from target`, !displaced.visible.includes(
          `Passage ${String(index).padStart(3, "0")}.`), displaced);
      }
      await exec("fixture.settle().then(()=>true)");
      const before = await exec("fixture.capture()");
      const setup = before.max > 10000 && before.visible.includes(`Passage ${String(index).padStart(3, "0")}.`);
      check(`${label}: overflowing Reader setup`, setup, before);
      if (!setup) {
        receipt.notRun.push(`${label}: mode switches blocked by failed Reader setup`);
        continue;
      }
      if (kind.endsWith("-offscreen")) {
        check(`${label}: earlier nested block is wholly offscreen`, before.earlierBlockOffscreen === true, before);
        if (kind !== "html-offscreen") check(`${label}: mixed Source publication setup`,
          before.diagnostics.textGroups > 0, before);
        const probe = await exec("fixture.probeModeCapture()");
        check(`${label}: offscreen owner permits mode-only character`, probe.calls === 1 &&
          probe.status === probe.ordinary.status && probe.reason === probe.ordinary.reason &&
          probe.reason === before.reading.reason, probe);
      }
      const exactCaptureExpected = kind === "markdown" || kind === "html";
      check(`${label}: capture authority control`, exactCaptureExpected
        ? before.reading.status === "captured" && (kind !== "html" || index === 0 || before.exactLiteral)
        : before.reading.status === "unavailable" &&
          before.reading.reason === "unverifiable-clipping-chain", before);
      for (const [step, id] of ["openEditorBtn", "exitEditBtn", "toggleEdit", "exitEditBtn"].entries()) {
        await exec(`document.getElementById(${JSON.stringify(id)}).click();true`);
        await exec("fixture.settle().then(()=>true)");
        const after = await exec("fixture.capture()");
        const switchLabel = `${label}: switch ${step + 1} ${id}`;
        receipt.observations.push({ kind, remembered, index, step, id, before, after });
        check(`${switchLabel} preserves visible passage`, after.visible.includes(
          `Passage ${String(index).padStart(3, "0")}.`), after);
        check(`${switchLabel} changes mode`, after.mode === (id !== "exitEditBtn"), after);
        if (index === 0) check(`${switchLabel} keeps intentional top`, after.top === 0, after);
        if (!after.visible.includes(`Passage ${String(index).padStart(3, "0")}.`)) {
          await exec(`fixture.locate(${index});true`);
          await exec("fixture.settle().then(()=>true)");
          const reset = await exec("fixture.capture()");
          check(`${switchLabel}: failed case resets safely`, reset.visible.includes(
            `Passage ${String(index).padStart(3, "0")}.`), reset);
          if (!reset.visible.includes(`Passage ${String(index).padStart(3, "0")}.`)) {
            throw new Error("Cannot safely reset the failed mode case");
          }
        }
      }
    }
  }
  await exec("fixture.document('html-offscreen').then(()=>true)");
  await exec("fixture.locateNestedBlock();fixture.settle().then(()=>true)");
  const nested = await exec("fixture.capture()");
  check("visible nested text setup", nested.nestedTextVisible && nested.nestedOverflowing, nested);
  const nestedProbe = await exec("fixture.probeModeCapture()");
  check("visible unsupported nested text refuses mode-only character", nestedProbe.calls === 0 &&
    nestedProbe.status === "unsupported" && nestedProbe.reason === "unverifiable-clipping-chain" &&
    nestedProbe.status === nestedProbe.ordinary.status && nestedProbe.reason === nestedProbe.ordinary.reason, nestedProbe);
  await exec("fixture.locate(50);fixture.escapeNestedText();true");
  const escaping = await exec("fixture.capture()");
  check("escaping nested text setup", escaping.earlierBlockOffscreen && escaping.escapingTextVisible &&
    escaping.nestedOverflowing, escaping);
  const escapingProbe = await exec("fixture.probeModeCapture()");
  check("escaping positioned text refuses mode-only character", escapingProbe.calls === 0 &&
    escapingProbe.status === "unavailable", escapingProbe);
  await exec("fixture.document('html-only').then(()=>true)");
  await exec("fixture.locateInterior();fixture.settle().then(()=>true)");
  const interiorBefore = await exec("fixture.capture()");
  check("HTML first-visible interior character setup", interiorBefore.interiorVisible === true &&
    interiorBefore.interiorOffset > 1000 && interiorBefore.reading.status === "unavailable", interiorBefore);
  const interiorProbe = await exec("fixture.probeModeCapture()");
  check("partial HTML publication permits mode-only character without history authority", interiorProbe.calls === 1 &&
    interiorProbe.status === "unsupported" && interiorProbe.reason === "unverifiable-clipping-chain" &&
    interiorProbe.status === interiorProbe.ordinary.status && interiorProbe.reason === interiorProbe.ordinary.reason, interiorProbe);
  await exec("fixture.forceEntryRender();document.getElementById('openEditorBtn').click();true");
  await exec("fixture.settle().then(()=>true)");
  const interiorAfter = await exec("fixture.capture()");
  check("forced entry really renders", interiorAfter.renderGeneration > interiorBefore.renderGeneration, interiorAfter);
  check("forced entry keeps exact interior character", interiorAfter.interiorVisible === true, interiorAfter);
  check("forced entry keeps interior character alignment", Math.abs(
    interiorAfter.interiorTop - interiorBefore.interiorTop) <= 1, interiorAfter);
  if (!interiorAfter.interiorVisible) {
    await exec("fixture.locateInterior();fixture.settle().then(()=>true)");
    const reset = await exec("fixture.capture()");
    check("failed interior case resets safely", reset.interiorVisible === true, reset);
    if (!reset.interiorVisible) throw new Error("Cannot safely reset the failed interior case");
  }
  const provenance = await exec("fixture.capture()");
  check("DOM position does not grant history provenance", provenance.reading.status === "unavailable" &&
    provenance.reading.reason === "unverifiable-clipping-chain", provenance);
  await exec("document.getElementById('exitEditBtn').click();true");
  await exec("fixture.settle().then(()=>true)");
  await exec("fixture.locate(50);fixture.supersedeEntry();document.getElementById('openEditorBtn').click();true");
  await exec("fixture.settle().then(()=>true)");
  const superseded = await exec("fixture.capture()");
  check("newer navigation beats mode restoration", superseded.visible.includes("Passage 096."), superseded);
}
app.whenReady().then(run).catch(error => {
  receipt.errors.push(error.stack);
  console.error(error.stack);
}).finally(() => {
  if (win && !win.isDestroyed()) win.destroy();
  receipt.windowsAfterCleanup = BrowserWindow.getAllWindows().length;
  receipt.passed = receipt.errors.length === 0 && receipt.assertions.length > 0 &&
    receipt.assertions.every(assertion => assertion.ok) && receipt.notRun.length === 0 && receipt.windowsAfterCleanup === 0;
  const output = process.env.MARKALOO_EDIT_POSITION_RECEIPT;
  if (output) fs.writeFileSync(output, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ passed: receipt.passed, assertions: receipt.assertions.length,
    errors: receipt.errors, notRun: receipt.notRun, windowsAfterCleanup: receipt.windowsAfterCleanup, storage }));
  if (receipt.errors.length || receipt.notRun.length || receipt.windowsAfterCleanup !== 0) {
    console.error("FAIL harness did not complete cleanly");
  } else {
    console.log(`=== ${receipt.assertions.filter(assertion => assertion.ok).length}/${receipt.assertions.length} passed ===`);
  }
  app.exit(receipt.passed ? 0 : 1);
});
