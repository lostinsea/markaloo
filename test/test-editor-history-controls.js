// Document history controls: production functions without an Electron window.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const companion = process.argv[2] === "--companion";
if (process.argv.length !== (companion ? 3 : 2))
  throw new Error("Usage: node test-editor-history-controls.js [--companion]");
const output = message => console.log((companion ? "[companion stdout] " : "") + message);
const root = path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, "src", name), "utf8");
const renderer = read("renderer.js"), html = read("index.html"), tabs = read("custom-tabs.js");
const scrollSource = read("editor-scroll.js").replace(/\r\n/g, "\n");
const cellContext = vm.createContext({ window: {} });
for (const name of ["inline-formatting.js", "table-cell-editor.js"])
  vm.runInContext(read(name), cellContext);
const cells = cellContext.window.MarkalooTableCells;
let passed = 0, failed = 0;
const cases = [];
function check(name, run) {
  cases.push([name, run]);
}
function between(source, first, last) {
  const start = source.indexOf(first), end = source.indexOf(last, start + first.length);
  assert(start >= 0 && end > start, "Production slice anchors must resolve");
  return source.slice(start, end);
}
function fixture() {
  const listeners = new Map(), timers = new Map(), microtasks = [], renderCompletions = [];
  const dirtyUpdates = [], revisionNotifications = [], scrollIntents = [];
  const menuClasses = new Set();
  const noteMenuClasses = new Set();
  let nextTimer = 0;
  const context = {
    isEditMode: true, owner: true, frozen: false, permissions: 0, renders: 0,
    ownerToken: { id: 1 }, fileOpenSequence: 1, editorModeRevision: 1,
    editorInteractionRevision: 0, pendingEditorScrollRestore: null,
    tableCellSession: null, editSessionBaseline: null, MarkalooTableCells: cells,
    undoButton: { disabled: true, addEventListener(_name, run) { this.click = run; } },
    redoButton: { disabled: true, addEventListener(_name, run) { this.click = run; } },
    markdownEditor: { value: "after", selectionStart: 5, selectionEnd: 5,
      addEventListener(name, run) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(run);
      } }, originalMarkdown: "after",
    contentWrapper: { scrollTop: 12 }, previewDebounceTimer: null,
    contextMenu: { classList: {
      add: name => menuClasses.add(name), remove: name => menuClasses.delete(name),
      contains: name => menuClasses.has(name),
    } },
    notesPanelContextMenu: { classList: {
      add: name => noteMenuClasses.add(name), remove: name => noteMenuClasses.delete(name),
      contains: name => noteMenuClasses.has(name),
    } }, notesPanelContextNoteId: "owned-note",
    setTimeout(run) { const id = ++nextTimer; timers.set(id, run); return id; },
    clearTimeout(id) { timers.delete(id); },
    queueMicrotask(run) { microtasks.push(run); },
    console, Event, exactSource: "after", hasUnsavedChanges: false,
    updateUnsavedIndicator() {
      dirtyUpdates.push({ dirty: context.hasUnsavedChanges, owner: context.ownerToken });
    },
  };
  let editorValue = "after";
  Object.defineProperty(context.markdownEditor, "value", {
    get: () => editorValue,
    set: value => { editorValue = cells.normalise(value); },
  });
  context.mayMutateRendererDocument = () => {
    context.permissions++;
    return context.owner && !context.frozen;
  };
  context.frozenForShutdown = () => context.frozen;
  context.currentDocumentActionOwner = () => context.owner ? context.ownerToken : null;
  context.renderMarkdown = (_content, _force, viewport) => {
    context.renders++;
    context.readingViewport.invalidate();
    if (viewport) viewport.permit = context.readingViewport.capturePermit();
    const completion = new Promise(resolve => { renderCompletions.push(resolve); });
    if (viewport) viewport.completion = completion;
    return Promise.resolve();
  };
  context.window = { CustomTabs: {
    snapshotExactEditorContent: () => {
      if (cells.normalise(context.exactSource) !== context.markdownEditor.value)
        context.exactSource = context.markdownEditor.value;
      return context.exactSource;
    },
    adoptExactEditorContent: source => { context.exactSource = source; return true; },
    noteActiveContentMutation: () => { revisionNotifications.push(context.ownerToken); },
  }, dispatchEvent(event) {
    if (event.type === "editor-scroll-intent") scrollIntents.push(event.type);
    return true;
  } };
  context.window.CustomTabs.getActiveTab = () => context.ownerToken;
  vm.createContext(context);
  vm.runInContext(read("reading-viewport.js") +
    between(renderer, "function createReadingViewportLifecycle(", "\nconst readingViewport =") +
    "\nvar readingViewport = createReadingViewportLifecycle();", context);
  context.window.readingViewport = context.readingViewport;
  vm.runInContext(read("context-menu-utils.js"), context);
  context.hideContextMenuHelper = context.window.MarkalooContextMenu.hideContextMenu;
  vm.runInContext(between(renderer, "function hideContextMenu(event)", "\n// Show context menu on right-click"), context);
  vm.runInContext(between(renderer, "function hideNotesPanelContextMenu(event)", "\ndocument.addEventListener('click'"), context);
  context.window.hideDocumentContextMenus = context.hideDocumentContextMenus;
  const scroll = vm.runInContext(`(() => {
    let owner = null, pendingSource = false, committed = null, anchors = [], dirty = false, frame = 0;
    let lastReadingCaptureFailure = null;
    const scrollPoints = { editor: [], preview: [] }, editor = markdownEditor;
    const active = () => isEditMode, frozen = () => frozenForShutdown();
    const identity = () => currentDocumentActionOwner();
    const stats = { builds: 0, scrolls: 0, writes: 0, callbacks: [] };
    ${between(scrollSource, "  function clearGeometry()", "\n  function upperBound(")}
    ${between(scrollSource, "  function usable()", "\n  function sealTextSource(")}
    ${between(scrollSource, "  function claim(side)", "\n  function nestedScroller(")}
    const api = {
      ${between(scrollSource, "    start() {", "\n    commit(")}
      ${between(scrollSource, "    changed() {", "\n    reset(")}
      ${between(scrollSource, "    diagnostics() {", "\n  };\n};")}
    };
    return { api, claim, seed(side) {
      pendingSource = false; dirty = false; frame = 0;
      committed = { source: markdownEditor.value, selection: identity(), textGroups: [], warnings: [] };
      anchors = [{ editor: 0, preview: 0 }, { editor: 100, preview: 200 }];
      scrollPoints.editor = anchors.slice(); scrollPoints.preview = anchors.slice();
      claim(side);
    }, geometry: () => ({ editor: scrollPoints.editor.length, preview: scrollPoints.preview.length }) };
  })()`, context);
  context.editorScroll = scroll.api;
  vm.runInContext(between(renderer, "function normaliseReloadSnapshot(", "\nfunction fileTrackingPathKey("), context);
  vm.runInContext(between(renderer, "function setDocumentDirtyState(", "\nfunction withFileTrackingResumeHeld("), context);
  vm.runInContext(between(renderer, "function setDocumentDirtyFromContent(", "\nfunction currentReloadSnapshot("), context);
  vm.runInContext(between(renderer, "const TIMING = {", "\n};") + "\n};", context);
  vm.runInContext(between(renderer, "const MAX_UNDO_HISTORY = 100;", "\nlet isEditMode"), context);
  vm.runInContext(between(renderer, "function captureDocumentEditor()", "\nfunction cancelEditorDeferredWork()"), context);
  vm.runInContext(between(renderer, "function cancelEditorDeferredWork()", "\nfunction retainCurrentDocumentEditor()"), context);
  vm.runInContext(between(renderer, "function captureExactInput(", "\n// Live preview with fast debounce"), context);
  vm.runInContext(between(renderer, "// Live preview with fast debounce",
    "\n// Sync editor textarea content with originalMarkdown"), context);
  vm.runInContext(between(renderer, "undoButton.addEventListener('click'", "\nwindow.updateEditorHistoryControls ="), context);
  const run = script => vm.runInContext(script, context);
  const emit = (name, event = {}) => listeners.get(name)?.forEach(listener => listener(event));
  function seed(source) {
    run("historyClear()");
    context.exactSource = context.originalMarkdown = source;
    context.markdownEditor.value = cells.normalise(source);
    run("exactTypingSource = window.CustomTabs.snapshotExactEditorContent()");
  }
  function input(value, witness = true) {
    context.markdownEditor.selectionStart = context.markdownEditor.selectionEnd = context.markdownEditor.value.length;
    if (witness) emit("beforeinput", { inputType: "insertText" });
    context.markdownEditor.value = cells.normalise(value);
    emit("input");
  }
  function expire() {
    const timer = run("historyDebounceTimer"), callback = timers.get(timer);
    assert(callback, "A real idle callback is pending");
    timers.delete(timer);
    callback();
  }
  return { context, run, seed, input, emit, expire, timers, scroll,
    dirtyUpdates, revisionNotifications, scrollIntents,
    async finishRenders() {
      while (renderCompletions.length) renderCompletions.shift()();
      await new Promise(setImmediate);
    },
    flushMicrotasks() { while (microtasks.length) microtasks.shift()(); } };
}

for (const [id, label, shortcut] of [
  ["undoButton", "Undo", "Ctrl+Z"], ["redoButton", "Redo", "Ctrl+Y"],
]) {
  check(id + " is an initially disabled named button with a decorative icon", () => {
    const markup = html.match(new RegExp('<button\\b[^>]*\\bid="' + id + '"[^>]*>[\\s\\S]*?</button>'))?.[0];
    assert(markup, "Button exists");
    for (const token of ['type="button"', "disabled", 'class="nav-btn editor-history-btn"',
      'aria-label="' + label + " (" + shortcut + ')"', 'title="' + label + " (" + shortcut + ')"',
      'aria-hidden="true"']) assert(markup.includes(token), token);
  });
}
check("the mini toolbar orders history before Save and separates Exit", () => {
  const positions = ["undoButton", "redoButton", "saveButton", "exitEditBtn"]
    .map(id => html.indexOf('id="' + id + '"'));
  assert(positions.every((value, i) => value >= 0 && (!i || value > positions[i - 1])));
  const toolbar = between(html, '<div class="editor-controls">', '\n            <textarea');
  const separators = [...toolbar.matchAll(/<span class="editor-toolbar-separator" aria-hidden="true">(\|+)<\/span>/g)]
    .map(match => match[1]);
  assert.deepEqual(separators, ["|", "|", "||"]);
  const styles = read("styles.css");
  assert(styles.includes(".editor-toolbar-group") && styles.includes("flex-wrap: wrap"));
});
check("paint is observational and stack pushes update availability synchronously", () => {
  const { context: c, run } = fixture();
  run("updateEditorHistoryControls()");
  assert(c.undoButton.disabled && c.redoButton.disabled);
  assert.equal(c.permissions, 0);
  run("historyPush('before')");
  assert(!c.undoButton.disabled && c.redoButton.disabled);
  const permissions = c.permissions;
  run("updateEditorHistoryControls()");
  assert.equal(c.permissions, permissions);
});
check("document buttons use the existing history and clear redo on a fresh push", () => {
  const { context: c, run } = fixture();
  run("historyPush('before')");
  c.undoButton.click();
  assert.equal(c.markdownEditor.value, "before");
  assert(c.undoButton.disabled && !c.redoButton.disabled);
  c.redoButton.click();
  assert.equal(c.markdownEditor.value, "after");
  assert(!c.undoButton.disabled && c.redoButton.disabled);
  c.undoButton.click();
  run("historyPush('fresh')");
  assert(!c.undoButton.disabled && c.redoButton.disabled);
});
for (const action of ["Undo", "Redo"]) {
  for (const editing of [true, false]) {
    check(action + " " + (editing ? "editor" : "Reader") + " continuation yields only viewport work to newer intent", async () => {
      const f = fixture(), { context: c, run } = f;
      c.isEditMode = editing;
      run("historyPush('before')");
      if (action === "Redo") { run("historyUndo()"); await f.finishRenders(); }
      const ticket = c.readingViewport.beginIntent();
      run(action === "Undo" ? "historyUndo()" : "historyRedo()");
      assert(run("undoRedoRendering"), "The actual render continuation is pending");
      assert(c.readingViewport.isIntentCurrent(ticket), "A source render is not genuine intent");
      c.contentWrapper.scrollTop = 67;
      c.readingViewport.beginIntent();
      await f.finishRenders();
      assert.equal(c.contentWrapper.scrollTop, 67);
      assert(!run("undoRedoRendering"), "Cleanup must not depend on the viewport permit");
      assert.equal(editing ? c.markdownEditor.value : c.originalMarkdown, action === "Undo" ? "before" : "after");
      assert.equal(run("undoHistory.length"), action === "Undo" ? 0 : 1);
      assert.equal(run("redoHistory.length"), action === "Undo" ? 1 : 0);
    });
  }
  for (const owner of ["preview", "editor"]) {
    check(action + " preserves the " + owner + " scroll owner and invalidates source and both geometry maps", async () => {
      const f = fixture(), { context: c, run, seed, input, scroll } = f;
      seed("before"); input("after");
      if (action === "Redo") { c.undoButton.click(); await f.finishRenders(); }
      scroll.seed(owner);
      const before = scroll.api.diagnostics();
      assert.equal(before.owner, owner, "The driving pane must already own the current source");
      assert(before.ready && !before.pendingSource && before.anchors === 2);
      assert.deepEqual(scroll.geometry(), { editor: 2, preview: 2 });
      const dirtyCount = f.dirtyUpdates.length, revisionCount = f.revisionNotifications.length;
      const intents = f.scrollIntents.length;
      c[action === "Undo" ? "undoButton" : "redoButton"].click();
      const after = scroll.api.diagnostics();
      assert.equal(after.owner, before.owner);
      assert.equal(after.pendingSource, true);
      assert.equal(after.ready, false);
      assert.equal(after.anchors, 0);
      assert.deepEqual(scroll.geometry(), { editor: 0, preview: 0 });
      assert.equal(f.scrollIntents.length, intents, "History must not fabricate a new scroll intent");
      assert.equal(c.exactSource, action === "Undo" ? "before" : "after");
      assert.equal(c.markdownEditor.value, c.exactSource);
      assert.equal(c.hasUnsavedChanges, action === "Redo");
      assert.equal(f.dirtyUpdates.length, dirtyCount + 1);
      assert.equal(f.dirtyUpdates.at(-1).dirty, action === "Redo");
      assert.strictEqual(f.dirtyUpdates.at(-1).owner, c.ownerToken);
      assert.equal(f.revisionNotifications.length, revisionCount + 1);
      assert.strictEqual(f.revisionNotifications.at(-1), c.ownerToken);
      assert.equal(run("undoHistory.length"), action === "Undo" ? 0 : 1);
      assert.equal(run("redoHistory.length"), action === "Undo" ? 1 : 0);
    });
  }
}
check("ordinary editor input still claims the editor and invalidates current source and geometry", () => {
  const f = fixture(), { context: c, seed, input, scroll } = f;
  seed("before"); scroll.seed("preview");
  assert.equal(scroll.api.diagnostics().owner, "preview");
  assert.equal(scroll.api.diagnostics().ready, true);
  const intents = f.scrollIntents.length;
  input("after");
  const after = scroll.api.diagnostics();
  assert.equal(after.owner, "editor");
  assert.equal(after.pendingSource, true);
  assert.equal(after.ready, false);
  assert.deepEqual(scroll.geometry(), { editor: 0, preview: 0 });
  assert.equal(f.scrollIntents.length, intents + 1);
  assert.equal(f.scrollIntents.at(-1), "editor-scroll-intent");
  assert.equal(c.hasUnsavedChanges, true);
  assert.equal(f.dirtyUpdates.at(-1).dirty, true);
  assert.strictEqual(f.revisionNotifications.at(-1), c.ownerToken);
});
for (const action of ["Undo", "Redo"]) {
  check("new editor input during " + action + " rendering keeps its newer scroll ownership after completion", async () => {
    const f = fixture(), { context: c, run, seed, input, scroll } = f;
    seed("before"); input("after");
    if (action === "Redo") { c.undoButton.click(); await f.finishRenders(); }
    scroll.seed("preview");
    assert.equal(scroll.api.diagnostics().owner, "preview");
    c[action === "Undo" ? "undoButton" : "redoButton"].click();
    assert.equal(run("undoRedoRendering"), true, "The original history render is genuinely unfinished");
    const revisions = f.revisionNotifications.length, dirtyCount = f.dirtyUpdates.length;
    input("newer input");
    assert.equal(run("undoRedoRendering"), true, "A later real input must not use the history flag as intent");
    assert.equal(scroll.api.diagnostics().owner, "editor");
    assert.equal(f.revisionNotifications.length, revisions + 1);
    assert.equal(f.dirtyUpdates.length, dirtyCount + 1);
    await f.finishRenders();
    assert.equal(run("undoRedoRendering"), false);
    assert.equal(scroll.api.diagnostics().owner, "editor");
    assert.equal(c.exactSource, "newer input");
    assert.equal(c.hasUnsavedChanges, true);
  });
  check("new preview intent during " + action + " rendering keeps its newer scroll ownership after completion", async () => {
    const f = fixture(), { context: c, run, seed, input, scroll } = f;
    seed("before"); input("after");
    if (action === "Redo") { c.undoButton.click(); await f.finishRenders(); }
    scroll.seed("editor");
    assert.equal(scroll.api.diagnostics().owner, "editor");
    c[action === "Undo" ? "undoButton" : "redoButton"].click();
    assert.equal(run("undoRedoRendering"), true);
    scroll.claim("preview");
    assert.equal(scroll.api.diagnostics().owner, "preview");
    await f.finishRenders();
    assert.equal(run("undoRedoRendering"), false);
    assert.equal(scroll.api.diagnostics().owner, "preview");
  });
}
check("source mutation retires viewport writes before deferred preview without minting genuine intent", () => {
  const f = fixture(), { context: c, seed, input } = f;
  seed("before");
  const ticket = c.readingViewport.beginIntent(), permit = c.readingViewport.capturePermit();
  input("after");
  assert(!c.readingViewport.isPermitCurrent(permit));
  assert(c.readingViewport.isIntentCurrent(ticket));
  assert.equal(c.renders, 0);
  assert.equal(c.markdownEditor.value, "after");
});
check("exact transactions retain source spelling through button Undo and Redo", () => {
  const { context: c, run } = fixture();
  run("historyPushExact('before\\r\\n'); exactSource = 'after\\r\\n'; markdownEditor.value = 'after\\n'");
  c.undoButton.click();
  assert.equal(c.exactSource, "before\r\n");
  assert(c.undoButton.disabled && !c.redoButton.disabled);
  c.redoButton.click();
  assert.equal(c.exactSource, "after\r\n");
  assert(!c.undoButton.disabled && c.redoButton.disabled);
});
check("restoring and clearing the real stacks refresh both controls", () => {
  const { context: c, run } = fixture();
  run("historyPush('before'); savedHistory = historySnapshot(); historyClear()");
  assert(c.undoButton.disabled && c.redoButton.disabled);
  run("historyRestore(savedHistory)");
  assert(!c.undoButton.disabled && c.redoButton.disabled);
  c.undoButton.click();
  run("savedHistory = historySnapshot(); historyClear(); historyRestore(savedHistory)");
  assert(c.undoButton.disabled && !c.redoButton.disabled);
});
check("owner, edit-mode and freeze guards survive forced button dispatch", () => {
  for (const flag of ["owner", "isEditMode", "frozen"]) {
    const { context: c, run } = fixture();
    run("historyPush('before')");
    c[flag] = flag === "frozen";
    run("updateEditorHistoryControls()");
    assert(c.undoButton.disabled && c.redoButton.disabled, flag);
    c.undoButton.click();
    assert.equal(c.markdownEditor.value, "after", flag);
    assert.equal(run("undoHistory.length"), 1, flag);
    c[flag] = flag !== "frozen";
    run("updateEditorHistoryControls()");
    assert(!c.undoButton.disabled && c.redoButton.disabled, flag);
  }
});
check("owner selection repaints after both active-owner assignments", () => {
  assert(/activeTabId = tabId;\s*activeTabForMutations = tab;\s*window\.updateEditorHistoryControls\?\.\(\);/.test(tabs));
});
check("closing the active owner disables controls before replacement can pause or refuse", () => {
  const { context: c, run } = fixture();
  c.tab = { id: 1 };
  c.tabs = [c.tab];
  c.activeTabId = 1;
  c.activeTabForMutations = c.tab;
  c.tabIndex = 0;
  c.dismissUpdatePrompt = () => {};
  c.currentDocumentActionOwner = () => c.tabs.find(tab => tab.id === c.activeTabId);
  c.window.updateEditorHistoryControls = run("updateEditorHistoryControls");
  run("historyPush('before')");
  assert(!c.undoButton.disabled);
  vm.runInContext(between(tabs, "      tabs.splice(tabIndex, 1);", "\n      bumpDocumentRevision();"), c);
  assert(c.undoButton.disabled && c.redoButton.disabled);
  assert.equal(c.activeTabForMutations, null);
  assert.equal(run("undoHistory.length"), 1);
});
check("committed owner removal dismisses menus before replacement can pause or refuse", () => {
  const close = between(tabs, "  async function closeTab(", "\n  function updateTabContent(");
  const commit = close.indexOf("tabs.splice(tabIndex, 1);");
  const dismiss = close.indexOf("window.hideDocumentContextMenus?.();");
  const replace = close.indexOf("await switchToTab(");
  assert(commit >= 0 && dismiss > commit && replace > dismiss);
  assert(!close.slice(0, commit).includes("window.hideDocumentContextMenus"), "Refusal paths do not execute the committed dismissal");
  for (const active of [true, false]) {
    const { context: c, run } = fixture();
    c.tab = { id: 1 }; const remaining = { id: 2 };
    c.tabs = [c.tab, remaining]; c.tabIndex = 0;
    c.activeTabId = active ? 1 : 2;
    c.activeTabForMutations = active ? c.tab : remaining;
    c.currentDocumentActionOwner = () => c.tabs.find(tab => tab.id === c.activeTabId);
    c.dismissUpdatePrompt = () => {};
    c.window.updateEditorHistoryControls = run("updateEditorHistoryControls");
    c.tableMenuSelection = {}; c.savedRange = {}; c.rightClickTarget = c.markdownEditor;
    const selection = c.tableMenuSelection, range = c.savedRange, target = c.rightClickTarget;
    run("historyPush('before')");
    c.contextMenu.classList.add("visible"); c.notesPanelContextMenu.classList.add("visible");
    assert(c.contextMenu.classList.contains("visible") && c.notesPanelContextMenu.classList.contains("visible"));
    vm.runInContext(between(tabs, "      tabs.splice(tabIndex, 1);", "\n      bumpDocumentRevision();"), c);
    assert.equal(c.contextMenu.classList.contains("visible"), !active);
    assert.equal(c.notesPanelContextMenu.classList.contains("visible"), !active);
    assert.equal(c.notesPanelContextNoteId, active ? null : "owned-note");
    assert.equal(c.undoButton.disabled, active); assert(c.redoButton.disabled);
    assert.equal(run("undoHistory.length"), 1);
    assert.strictEqual(c.tableMenuSelection, selection);
    assert.strictEqual(c.savedRange, range); assert.strictEqual(c.rightClickTarget, target);
    assert.deepEqual(c.tabs, [remaining], "A replacement owner remains but has not been selected");
  }
});
check("freeze and thaw repaint through their existing state transitions", () => {
  const freeze = between(tabs, "function freezeDocument(", "\n  function thawDocument(");
  const thaw = between(tabs, "function thawDocument(", "\n  function ");
  assert(freeze.indexOf("window.updateEditorHistoryControls?.()") > freeze.indexOf("shutdownFreeze = {"));
  assert(thaw.indexOf("window.updateEditorHistoryControls?.()") > thaw.indexOf("replayFrozenDocumentOperations()"));
});
check("compact controls wrap without hiding Save or Exit", () => {
  const css = read("styles.css");
  assert(/\.editor-header\s*\{[^}]*flex-wrap:\s*wrap/s.test(css));
  assert(/\.editor-controls\s*\{[^}]*flex-wrap:\s*wrap/s.test(css));
  assert(/\.editor-history-btn:focus-visible\s*\{[^}]*var\(--primary-color\)/s.test(css));
});

check("first document Undo reverses fresh typing before the idle deadline", () => {
  const { context: c, seed, input } = fixture();
  seed("before"); input("before typed");
  assert(!c.undoButton.disabled && c.redoButton.disabled);
  c.undoButton.click();
  assert.equal(c.markdownEditor.value, "before");
  c.redoButton.click();
  assert.equal(c.markdownEditor.value, "before typed");
});
check("accepted editor input dismisses its actual menu without losing the fresh Undo step", () => {
  const { context: c, seed, input, run } = fixture();
  seed("before");
  c.contextMenu.classList.add("visible");
  assert(c.contextMenu.classList.contains("visible"), "The menu is actually open");
  input("before typed");
  assert(!c.contextMenu.classList.contains("visible"));
  assert.equal(run("undoHistory.length"), 1);
  c.undoButton.click();
  assert.equal(c.markdownEditor.value, "before");
});
check("idle expiry never adds the already-current typing state", () => {
  const { context: c, seed, input, expire, run } = fixture();
  seed("before"); input("before typed"); expire();
  assert.equal(run("undoHistory.length"), 1);
  c.undoButton.click();
  assert.equal(c.markdownEditor.value, "before");
});
check("typing after Undo clears Redo before idle expiry", () => {
  const { context: c, seed, input } = fixture();
  seed("before"); input("before old"); c.undoButton.click();
  assert(!c.redoButton.disabled, "The old branch really has Redo");
  input("before new");
  assert(c.redoButton.disabled);
  c.redoButton.click();
  assert.equal(c.markdownEditor.value, "before new");
  c.undoButton.click();
  assert.equal(c.markdownEditor.value, "before");
});
check("typing within the idle window remains one source change", () => {
  const { context: c, seed, input, run } = fixture();
  seed("base"); input("base a"); input("base ab");
  assert.equal(run("undoHistory.length"), 1);
  c.undoButton.click();
  assert.equal(c.markdownEditor.value, "base");
  c.redoButton.click();
  assert.equal(c.markdownEditor.value, "base ab");
});
check("separate idle groups undo and redo actual source in order", () => {
  const { context: c, seed, input, expire } = fixture();
  seed("base"); input("base a"); expire(); input("base ab");
  c.undoButton.click(); assert.equal(c.markdownEditor.value, "base a");
  c.undoButton.click(); assert.equal(c.markdownEditor.value, "base");
  c.redoButton.click(); assert.equal(c.markdownEditor.value, "base a");
  c.redoButton.click(); assert.equal(c.markdownEditor.value, "base ab");
});
check("beforeinput-less changes use the initialized pre-edit checkpoint", () => {
  const { context: c, seed, input } = fixture();
  seed("base"); input("base programmatic", false);
  c.undoButton.click(); assert.equal(c.markdownEditor.value, "base");
  c.redoButton.click(); assert.equal(c.markdownEditor.value, "base programmatic");
});
check("exact beforeinput preserves CRLF through typing Undo and Redo", () => {
  const { context: c, seed, input } = fixture();
  seed("base\r\n"); input("base\r\ntail");
  assert.equal(c.exactSource, "base\r\ntail");
  c.undoButton.click();
  assert.equal(c.exactSource, "base\r\n");
  c.redoButton.click();
  assert.equal(c.exactSource, "base\r\ntail");
});
check("unchanged input neither creates Undo nor consumes available Redo", () => {
  const { context: c, seed, input, run } = fixture();
  seed("base"); input("changed"); c.undoButton.click();
  const before = run("JSON.stringify(historySnapshot())");
  input("base");
  assert.equal(run("JSON.stringify(historySnapshot())"), before);
  assert(!c.redoButton.disabled);
});
check("snapshots retain only the pre-state and restoration retires the idle timer", () => {
  const { context: c, seed, input, run } = fixture();
  seed("base"); input("changed");
  run("savedHistory=historyForEditorState(captureDocumentEditor()); historyRestore(savedHistory)");
  assert.equal(run("historyDebounceTimer"), null);
  assert.equal(run("undoHistory.length"), 1);
  c.undoButton.click(); assert.equal(c.markdownEditor.value, "base");
});
check("stale idle callbacks cannot end a replacement owner's typing group", () => {
  const { context: c, seed, input, run, timers } = fixture();
  seed("alpha"); input("alpha changed");
  const stale = timers.get(run("historyDebounceTimer"));
  c.ownerToken = { id: 2 }; c.fileOpenSequence++;
  seed("beta"); input("beta one");
  const current = run("historyDebounceTimer");
  stale();
  assert.equal(run("historyDebounceTimer"), current);
  input("beta two");
  c.undoButton.click(); assert.equal(c.markdownEditor.value, "beta");
});
check("typing followed by an exact transaction keeps two real Undo steps", () => {
  const { context: c, seed, input, run } = fixture();
  seed("base"); input("typed");
  run("cancelEditorDeferredWork(); historyPushExact('typed'); window.CustomTabs.adoptExactEditorContent('transaction'); markdownEditor.value='transaction'; exactTypingSource='transaction'");
  c.undoButton.click(); assert.equal(c.markdownEditor.value, "typed");
  c.undoButton.click(); assert.equal(c.markdownEditor.value, "base");
  c.redoButton.click(); assert.equal(c.markdownEditor.value, "typed");
  c.redoButton.click(); assert.equal(c.markdownEditor.value, "transaction");
});
check("composition retains one burst and blocks history until final input settles", () => {
  const f = fixture(), { context: c, seed, input, emit, expire, run } = f;
  seed("base"); emit("compositionstart"); input("base a"); expire();
  assert.notEqual(run("historyDebounceTimer"), null);
  input("base ab"); emit("compositionend");
  c.undoButton.click(); assert.equal(c.markdownEditor.value, "base ab");
  assert(c.undoButton.disabled);
  f.flushMicrotasks();
  c.undoButton.click(); assert.equal(c.markdownEditor.value, "base");
  c.redoButton.click(); assert.equal(c.markdownEditor.value, "base ab");
});
check("old composition completion cannot release a replacement owner's guard", () => {
  const f = fixture(), { context: c, seed, input, emit, run } = f;
  seed("alpha"); emit("compositionstart"); input("alpha a"); emit("compositionend");
  c.ownerToken = { id: 2 }; c.fileOpenSequence++;
  seed("beta"); emit("compositionstart"); input("beta b");
  f.flushMicrotasks();
  assert(run("editorHistoryComposing()"));
  assert(c.undoButton.disabled && c.redoButton.disabled);
});
check("incoming editor seeds its own source before its owner becomes active", () => {
  const { context: c, seed, input, run } = fixture();
  seed("outgoing"); input("outgoing changed");
  c.openedContent = "incoming\r\n";
  c.incomingEditor = { open: true, rendererMarkdown: c.openedContent, baseline: null };
  c.setEditorPresentation = open => { c.isEditMode = open; };
  const snapshot = c.window.CustomTabs.snapshotExactEditorContent;
  c.window.CustomTabs.snapshotExactEditorContent = () => { throw Error("The outgoing owner must not supply the incoming checkpoint"); };
  run("historyRestore(historyForEditorState({history:{undo:[],redo:[]}}))");
  vm.runInContext(between(renderer,
    "  originalMarkdown = incomingEditor?.open ? incomingEditor.rendererMarkdown : openedContent;",
    "\n  const selection = incomingEditor?.selection;"), c);
  assert.equal(run("exactTypingSource"), c.openedContent);
  c.window.CustomTabs.snapshotExactEditorContent = snapshot;
  c.exactSource = c.openedContent;
  c.ownerToken = { id: 2 }; c.fileOpenSequence++;
  input("incoming\r\ntyped", false);
  c.undoButton.click();
  assert.equal(c.exactSource, "incoming\r\n");
});
check("accepted reload clears old history and seeds the next pre-input source", () => {
  const { context: c, seed, input, run } = fixture();
  seed("old"); input("old changed"); c.undoButton.click();
  assert(!c.redoButton.disabled, "Reload begins with a real old Redo branch");
  Object.assign(c, { data: { content: "reloaded\r\n" }, currentFilePath: "reload.md",
    acceptedStateKey: "reload", failedSaves: new Set(["reload"]),
    unresolvedEvidence: false, trackingConflict: false,
    withFileTrackingResumeHeld: run => run(), setDocumentDirtyState() {},
    captureEditSessionBaseline() { c.baselineSource = run("exactTypingSource"); } });
  vm.runInContext(between(renderer,
    "    originalMarkdown = data.content;",
    "\n    // Re-render the markdown"), c);
  assert(c.undoButton.disabled && c.redoButton.disabled);
  assert.equal(c.baselineSource, "reloaded\r\n");
  assert.equal(run("historyDebounceTimer"), null);
  c.exactSource = c.data.content;
  input("reloaded\r\ntyped", false);
  c.undoButton.click();
  assert.equal(c.exactSource, "reloaded\r\n");
});

(async () => {
  for (const [name, run] of cases) {
    try { await run(); passed++; output("PASS " + name); }
    catch (error) { failed++; output("FAIL " + name + "  -> " + JSON.stringify(error.message)); }
  }
  output(`=== ${passed}/${passed + failed} passed ===`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
