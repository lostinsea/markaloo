"use strict";

// Whole production scripts with VM-local collaborators; not Main/native proof.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function run(report = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}) {
  const context = vm.createContext({}, { microtaskMode: "afterEvaluate" });
  vm.runInContext(`
    globalThis.window = globalThis;
    const fixture = {
      results: [], sends: [], errors: [], registrations: [],
      generation: 23, generationQueries: 0, pendingScans: 0,
      forbidScan: false, editMode: false, sendFailure: null,
      scanFailure: new Error('controlled unexpected dirty scan'),
      complete: false,
    };
    const fail = name => () => { throw new Error('Unexpected shutdown collaborator: ' + name); };
    const subscriptions = new Map();
    const transport = {
      on(channel, listener) {
        const listeners = subscriptions.get(channel) || [];
        listeners.push(listener);
        subscriptions.set(channel, listeners);
      },
      removeListener(channel, listener) {
        const listeners = subscriptions.get(channel) || [];
        const index = listeners.lastIndexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      },
      invoke(channel) {
        if (channel !== 'quit-approval-generation') {
          throw new Error('Unexpected shutdown invoke: ' + channel);
        }
        fixture.generationQueries++;
        return Promise.resolve(fixture.generation);
      },
      send(channel, payload) {
        if (!['quit-approval-ready', 'quit-approval-response'].includes(channel)) {
          throw new Error('Unexpected shutdown send: ' + channel);
        }
        if (channel === 'quit-approval-response' && fixture.sendFailure) {
          throw fixture.sendFailure;
        }
        fixture.sends.push({ channel, payload });
      },
      sendSync: fail('sendSync'),
    };
    const preloadImports = {
      process: { isMainFrame: true, argv: [], platform: ${JSON.stringify(process.platform)} },
      require(name) {
        if (name !== 'electron') throw new Error('Unexpected shutdown import: ' + name);
        return { ipcRenderer: transport, contextBridge: {
          exposeInMainWorld(name, api) {
            if (name !== 'folia' || Object.hasOwn(window, name) || !Object.isFrozen(api)) {
              throw new Error('Expected the actual frozen production preload API');
            }
            Object.defineProperty(window, name, { value: api, enumerable: true });
          },
        } };
      },
    };
    const wrapper = { classList: {
      contains(name) {
        if (name !== 'split-view') throw new Error('Unexpected mode query: ' + name);
        return fixture.editMode;
      },
    } };
    window.document = {
      readyState: 'loading',
      getElementById() { return null; },
      querySelector(selector) {
        if (selector !== '.content-wrapper') throw new Error('Unexpected selector: ' + selector);
        return wrapper;
      },
      addEventListener(name, callback) {
        fixture.registrations.push({ target: 'document', name, callback });
      },
    };
    window.navigator = {
      platform: ${JSON.stringify(process.platform === "win32" ? "Win32" : process.platform)},
    };
    window.addEventListener = (name, callback) => {
      fixture.registrations.push({ target: 'window', name, callback });
    };
    window.console = {
      log() {},
      warn: fail('console.warn'),
      error(...args) { fixture.errors.push(args); },
    };
    window.setTimeout = fail('setTimeout');
    window.setInterval = fail('setInterval');
    window.getReloadRequestSession = () => 'shutdown-contract-page';
    window.getPendingSaveStatus = () => {
      fixture.pendingScans++;
      if (fixture.forbidScan) throw fixture.scanFailure;
      return { pending: false };
    };
    for (const name of [
      'rendererFileOpenHandler', 'beginFileOpen', 'completeFileOpen',
      'preflightFileOpen', 'renderMarkdown', 'registerDocumentOwner',
    ]) window[name] = fail(name);
    window.originalMarkdown = '';
    window.markdownEditor = null;
  `, context, { filename: "shutdown-contract-fixture.js", timeout: 1000 });

  const sourceRoot = path.join(__dirname, "..", "src");
  const preload = path.join(sourceRoot, "main-preload.js");
  // Keep the preload's CommonJS scope separate from the page's classic scripts.
  vm.compileFunction(fs.readFileSync(preload, "utf8"), ["require", "process"], {
    parsingContext: context, filename: preload,
  })(vm.runInContext("preloadImports.require", context),
    vm.runInContext("preloadImports.process", context));
  for (const file of [
    "file-helpers-core.js", "context-menu-utils.js",
    "document-events.js", "custom-tabs.js",
  ]) {
    if (file === "custom-tabs.js") {
      vm.runInContext(`
        window.FoliaDocumentEvents.on('file-opened', window.rendererFileOpenHandler);
        for (const channel of [
          'file-reload-result', 'save-markdown-result', 'file-changed-externally',
        ]) window.FoliaDocumentEvents.on(channel, fail('renderer event ' + channel));
      `, context, { filename: "shutdown-renderer-collaborators.js", timeout: 1000 });
    }
    const filename = path.join(sourceRoot, file);
    vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename, timeout: 1000 });
  }

  vm.runInContext(`
    const verify = (name, ok, detail = '') => fixture.results.push({
      name: 'SHUTDOWN contract ' + name, ok: !!ok, detail: String(detail),
    });
    const replies = () => fixture.sends.filter(item => item.channel === 'quit-approval-response');
    const cache = () => window.CustomTabs.__shutdownReplayCache();
    const request = id => ({ id, gen: fixture.generation, reason: 'window-close' });
    const listeners = subscriptions.get('quit-approval-request') || [];
    verify('loads whole scripts with one listener and the actual generation handshake',
      Object.isFrozen(window.folia) && listeners.length === 1 &&
      fixture.generationQueries === 1 && fixture.errors.length === 0 &&
      JSON.stringify(fixture.sends) === JSON.stringify([{
        channel: 'quit-approval-ready',
        payload: { gen: fixture.generation, pageSession: 'shutdown-contract-page' },
      }]) &&
      fixture.registrations.some(item => item.name === 'DOMContentLoaded') &&
      window.FoliaDocumentEvents.listeners('file-opened').length === 1);
    if (listeners.length !== 1) throw new Error('Actual shutdown transport listener missing');
    const deliver = data => listeners[0]({}, data);
    verify('starts with an empty clean unfrozen document and no retained answer',
      window.CustomTabs.getTabs().length === 0 &&
      window.CustomTabs.__shutdownFreeze().frozen === false &&
      JSON.stringify(cache()) === JSON.stringify({ retained: 0, id: 0, highestRequestId: 0 }));

    // Capture these witnesses before afterEvaluate can drain microtasks.
    let before = replies().length;
    let scans = fixture.pendingScans;
    const firstReturn = deliver(request(1));
    const first = replies().at(-1)?.payload;
    verify('answers a fresh request exactly once before the listener returns',
      firstReturn === undefined && replies().length === before + 1 &&
      fixture.pendingScans === scans + 1 &&
      JSON.stringify(first) === JSON.stringify({
        id: 1, gen: fixture.generation, dirtyFiles: [],
        revision: window.CustomTabs.__shutdownFreeze().revision,
      }), JSON.stringify(first));

    fixture.editMode = true;
    before = replies().length;
    scans = fixture.pendingScans;
    deliver(request(2));
    const unreadable = replies().at(-1)?.payload;
    verify('logs the actual unreadable-editor error and synchronously returns dirtyFiles:null',
      window.CustomTabs.__inEditMode() === true && !window.markdownEditor &&
      replies().length === before + 1 && fixture.pendingScans === scans &&
      fixture.errors.length === 1 &&
      fixture.errors[0][0] === '[CustomTabs] Could not check for unsaved changes:' &&
      fixture.errors[0][1] instanceof Error &&
      fixture.errors[0][1].message === 'edit mode is active but the editor is unavailable' &&
      JSON.stringify(unreadable) === JSON.stringify({
        id: 2, gen: fixture.generation, dirtyFiles: null, revision: first.revision,
      }), JSON.stringify(unreadable));
    fixture.editMode = false;
    fixture.forbidScan = true;
    before = replies().length;
    deliver(request(2));
    verify('replays the exact unreadable answer after recovery without rescanning',
      replies().length === before + 1 && fixture.pendingScans === scans &&
      JSON.stringify(replies().at(-1).payload) === JSON.stringify(unreadable));
    fixture.forbidScan = false;
    before = replies().length;
    deliver(request(3));
    verify('a fresh request scans again and answers clean after editor recovery',
      replies().length === before + 1 && fixture.pendingScans === scans + 1 &&
      Array.isArray(replies().at(-1).payload.dirtyFiles) &&
      replies().at(-1).payload.dirtyFiles.length === 0);

    const invalid = [
      null, {}, { id: '4', gen: fixture.generation },
      { id: Number.MAX_SAFE_INTEGER + 1, gen: fixture.generation },
      { id: 4, gen: fixture.generation + 1 },
      { id: 4, gen: String(fixture.generation) },
      { id: 4, gen: NaN }, { id: 2, gen: fixture.generation },
    ];
    const cacheBefore = JSON.stringify(cache());
    before = replies().length;
    scans = fixture.pendingScans;
    fixture.forbidScan = true;
    for (const payload of invalid) deliver(payload);
    verify('malformed foreign-generation and stale requests change no response scan or cache',
      invalid.length === 8 && replies().length === before &&
      fixture.pendingScans === scans && fixture.errors.length === 1 &&
      JSON.stringify(cache()) === cacheBefore);
    fixture.forbidScan = false;

    let everyFillAnswered = true;
    before = replies().length;
    scans = fixture.pendingScans;
    for (let id = 4; id < 54; id++) {
      const count = replies().length;
      deliver(request(id));
      everyFillAnswered = everyFillAnswered &&
        replies().length === count + 1 &&
        replies().at(-1).payload.id === id &&
        Array.isArray(replies().at(-1).payload.dirtyFiles) &&
        replies().at(-1).payload.dirtyFiles.length === 0;
    }
    const newest = replies().at(-1).payload;
    verify('fifty cancelled shutdowns retain one replayable answer with the newest highest id',
      everyFillAnswered && replies().length === before + 50 &&
      fixture.pendingScans === scans + 50 &&
      JSON.stringify(cache()) === JSON.stringify({
        retained: 1, id: 53, highestRequestId: 53,
      }), JSON.stringify(cache()));
    fixture.forbidScan = true;
    before = replies().length;
    scans = fixture.pendingScans;
    deliver(request(53));
    verify('the newest id replays its exact recorded answer without another scan',
      replies().length === before + 1 && fixture.pendingScans === scans &&
      JSON.stringify(replies().at(-1).payload) === JSON.stringify(newest));
    before = replies().length;
    deliver(request(52));
    verify('the older duplicate stays silent without a scan or cache change',
      replies().length === before && fixture.pendingScans === scans &&
      fixture.errors.length === 1 &&
      JSON.stringify(cache()) === JSON.stringify({
        retained: 1, id: 53, highestRequestId: 53,
      }));
    before = replies().length;
    deliver(request(54));
    verify('the no-rescan sentinel is live on a fresh request and fails closed synchronously',
      replies().length === before + 1 && fixture.pendingScans === scans + 1 &&
      replies().at(-1).payload.dirtyFiles === null &&
      fixture.errors.length === 2 && fixture.errors[1][1] === fixture.scanFailure);
    fixture.forbidScan = false;
    fixture.sendFailure = new Error('controlled shutdown transport send failure');
    let thrown = null;
    before = replies().length;
    scans = fixture.pendingScans;
    try { deliver(request(55)); } catch (error) { thrown = error; }
    verify('an actual transport send failure escapes the original listener synchronously',
      thrown === fixture.sendFailure && replies().length === before &&
      fixture.pendingScans === scans + 1 && cache().id === 55);
    fixture.sendFailure = null;
    before = replies().length;
    deliver(request(55));
    verify('a retry after send failure replays the cached clean response without rescanning',
      replies().length === before + 1 && fixture.pendingScans === scans + 1 &&
      replies().at(-1).payload.id === 55 &&
      Array.isArray(replies().at(-1).payload.dirtyFiles) &&
      replies().at(-1).payload.dirtyFiles.length === 0);
    fixture.terminalSends = fixture.sends.length;
    fixture.terminalScans = fixture.pendingScans;
    fixture.complete = true;
  `, context, { filename: "shutdown-production-protocol-checks.js", timeout: 1000 });
  vm.runInContext(`
    verify('finishes every immediate witness with no late response or scan after microtask drain',
      fixture.complete && fixture.sends.length === fixture.terminalSends &&
      fixture.pendingScans === fixture.terminalScans && fixture.errors.length === 2);
  `, context, { timeout: 1000 });
  const results = vm.runInContext("fixture.results", context);
  for (const result of results) report(result.name, result.ok, result.detail);
  if (results.length !== 14 || results.some(result => !result.ok)) {
    throw new Error("Shutdown production-code contract failed or did not complete");
  }
  return results.length;
}

module.exports = { run };
if (require.main === module) {
  try { run(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
