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
const cellContext = vm.createContext({ window: {} });
for (const name of ["inline-formatting.js", "table-cell-editor.js"])
  vm.runInContext(read(name), cellContext);
const cells = cellContext.window.FoliaTableCells;
let passed = 0, failed = 0;
function check(name, run) {
  try { run(); passed++; output("PASS " + name); }
  catch (error) { failed++; output("FAIL " + name + "  -> " + JSON.stringify(error.message)); }
}
function between(source, first, last) {
  const start = source.indexOf(first), end = source.indexOf(last, start + first.length);
  assert(start >= 0 && end > start, "Production slice anchors must resolve");
  return source.slice(start, end);
}
function fixture() {
  const listeners = new Map(), timers = new Map(), microtasks = [];
  const menuClasses = new Set();
  const noteMenuClasses = new Set();
  let nextTimer = 0;
  const context = {
    isEditMode: true, owner: true, frozen: false, permissions: 0, renders: 0,
    ownerToken: { id: 1 }, fileOpenSequence: 1, editorModeRevision: 1,
    editorInteractionRevision: 0, pendingEditorScrollRestore: null,
    tableCellSession: null, editSessionBaseline: null, FoliaTableCells: cells,
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
    console, exactSource: "after", setDocumentDirtyFromContent() {},
    noteActiveContentMutation() {},
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
  context.renderMarkdown = async () => { context.renders++; };
  context.sameReloadDocument = (a, b) => a === b;
  context.window = { CustomTabs: {
    snapshotExactEditorContent: () => {
      if (cells.normalise(context.exactSource) !== context.markdownEditor.value)
        context.exactSource = context.markdownEditor.value;
      return context.exactSource;
    },
    adoptExactEditorContent: source => { context.exactSource = source; return true; },
  } };
  vm.createContext(context);
  vm.runInContext(read("context-menu-utils.js"), context);
  context.hideContextMenuHelper = context.window.FoliaContextMenu.hideContextMenu;
  vm.runInContext(between(renderer, "function hideContextMenu(event)", "\n// Show context menu on right-click"), context);
  vm.runInContext(between(renderer, "function hideNotesPanelContextMenu(event)", "\ndocument.addEventListener('click'"), context);
  context.window.hideDocumentContextMenus = context.hideDocumentContextMenus;
  vm.runInContext(between(renderer, "const MAX_UNDO_HISTORY = 100;", "\nlet isEditMode"), context);
  vm.runInContext(between(renderer, "function captureDocumentEditor()", "\nfunction cancelEditorDeferredWork()"), context);
  vm.runInContext(between(renderer, "function cancelEditorDeferredWork()", "\nfunction retainCurrentDocumentEditor()"), context);
  vm.runInContext(between(renderer, "function captureExactInput(", "\n// Live preview with fast debounce"), context);
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
  return { context, run, seed, input, emit, expire, timers,
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

output(`=== ${passed}/${passed + failed} passed ===`);
process.exitCode = failed ? 1 : 0;
