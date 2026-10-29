"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const ACK_FIELDS = [
  "eventId", "consumed", "why", "pageSession", "rendererGeneration", "tabId",
  "documentGeneration", "pathKey", "selectionGeneration", "watcherGeneration", "attempt",
];

// These browser facts do not qualify CustomTabs, Main, native IPC, or real timers.
// The receiver, classifier, consumed set, ACK builder, and preload stay unchanged.
function createFixture() {
  const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  const noteColors = [...html.matchAll(/class="note-color-option(?: selected)?"\s+data-color="([^"]+)"/g)]
    .map(match => ({ color: match[1], selected: /\bselected\b/.test(match[0]) }));
  const templates = [...html.matchAll(/class="mermaid-tpl-btn"\s+data-tpl="([^"]+)"/g)].map(match => match[1]);
  const slides = [...html.matchAll(/class="welcome-slide(?: active)?"/g)].map(match => /\bactive\b/.test(match[0]));
  const dots = [...html.matchAll(/class="welcome-dot(?: active)?"/g)].map(match => /\bactive\b/.test(match[0]));
  assert(noteColors.length > 0 && templates.length > 0 && slides.length > 0 && slides.length === dots.length,
    "actual HTML selector facts must exist");
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const context = vm.createContext({}, { microtaskMode: "afterEvaluate" });
  const execute = source => vm.runInContext(source, context, { timeout: 1000 });
  const snapshot = source => JSON.parse(execute("JSON.stringify(" + source + ")"));

  execute(`
    globalThis.window = globalThis;
    const __fixture = { unexpected: [], registrations: [], sends: [], subscriptions: new Map(),
      timers: [], hooks: [], versionQueries: 0, logs: [], writes: [], shows: [],
      phase: 'load', constructed: [], dropped: [], forwarded: [], tombstones: [], getterCalls: [],
      wrapperCalls: [], mutationCalls: [] };
    const __copy = value => JSON.parse(JSON.stringify(value));
    const __fail = name => (...args) => {
      __fixture.unexpected.push({ name, args: args.map(String) });
      throw new Error('Unexpected deletion contract collaborator: ' + name);
    };
    const __node = id => {
      const classes = new Set();
      let text = '';
      return { id, tagName: id === 'markdownEditor' ? 'TEXTAREA' : 'DIV',
        value: '', innerHTML: '', style: {
          setProperty(name, value) { this[name] = String(value); },
          getPropertyValue(name) { return this[name] ?? ''; },
        }, dataset: {}, children: [],
        get textContent() { return text; },
        set textContent(value) {
          text = String(value);
          if (id === 'notificationMessage') __fixture.writes.push(text);
        },
        scrollTop: 0, scrollLeft: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0,
        selectionStart: 0, selectionEnd: 0, offsetHeight: 0, offsetWidth: 0,
        classList: {
          add(...names) {
            if (id === 'notificationToast' && names.includes('show')) __fixture.shows.push(names);
            names.forEach(name => classes.add(name));
          },
          remove: (...names) => names.forEach(name => classes.delete(name)),
          contains: name => classes.has(name),
          toggle(name, force) {
            const add = force === undefined ? !classes.has(name) : force;
            if (add) classes.add(name); else classes.delete(name);
            return add;
          },
        },
        addEventListener(name, callback) { __fixture.registrations.push({ id, name, callback }); },
        removeEventListener() {},
        contains(node) { return node === this || this.children.some(child => child.contains(node)); },
        querySelector(selector) {
          if (id === 'reloadDocumentDialog' && selector.startsWith('#reloadDocument') &&
              __nodes.has(selector.slice(1))) return __nodes.get(selector.slice(1));
          if (id === 'reloadDocumentDialog' && selector === '.note-dialog-footer') return __footer;
          return __fail(id + '.querySelector')(selector);
        },
        querySelectorAll(selector) {
          if (id === 'welcomeSlidesTrack' && selector === '.welcome-slide') return __slides;
          if (id === 'welcomeDots' && selector === '.welcome-dot') return __dots;
          if (id === 'mermaidTemplateOverlay' && selector === '.mermaid-tpl-btn') return __templates;
          return __fail(id + '.querySelectorAll')(selector);
        },
        getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }),
        getAttribute: () => null, setAttribute() {}, removeAttribute() {},
        appendChild: __fail(id + '.appendChild'),
        focus: __fail(id + '.focus'), blur: __fail(id + '.blur'),
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      };
    };
    const __nodes = new Map(${JSON.stringify(ids)}.map(id => [id, __node(id)]));
    const __wrapper = __node('content-wrapper');
    const __footer = __node('reload-dialog-footer');
    const __colors = ${JSON.stringify(noteColors)}.map((fact, index) => {
      const node = __node('note-color-' + index);
      node.tagName = 'BUTTON'; node.dataset.color = fact.color;
      if (fact.selected) node.classList.add('selected');
      return node;
    });
    const __templates = ${JSON.stringify(templates)}.map((tpl, index) => {
      const node = __node('mermaid-template-' + index);
      node.tagName = 'BUTTON'; node.dataset.tpl = tpl;
      return node;
    });
    const __slides = ${JSON.stringify(slides)}.map((active, index) => {
      const node = __node('welcome-slide-' + index);
      if (active) node.classList.add('active');
      return node;
    });
    const __dots = ${JSON.stringify(dots)}.map((active, index) => {
      const node = __node('welcome-dot-' + index);
      if (active) node.classList.add('active');
      return node;
    });
    globalThis.document = {
      readyState: 'loading', body: __node('body'), documentElement: __node('html'),
      fonts: { ready: Promise.resolve(), addEventListener(name, callback) {
        __fixture.registrations.push({ id: 'fonts', name, callback });
      } },
      getElementById: id => __nodes.get(id) || null,
      querySelector(selector) {
        if (selector === '.content-wrapper') return __wrapper;
        return __fail('document.querySelector')(selector);
      },
      querySelectorAll(selector) {
        if (selector === '.note-color-option') return __colors;
        return __fail('document.querySelectorAll')(selector);
      },
      addEventListener(name, callback) { __fixture.registrations.push({ id: 'document', name, callback }); },
      createElement: __fail('document.createElement'),
    };
    globalThis.navigator = { platform: ${JSON.stringify(process.platform === "win32" ? "Win32" : process.platform)} };
    globalThis.crypto = { randomUUID() {
      __fixture.uuidCalls = (__fixture.uuidCalls || 0) + 1;
      if (__fixture.uuidCalls !== 1) return __fail('crypto.randomUUID repeated')();
      return '00000000-0000-4000-8000-000000000001';
    } };
    const __storage = new Map([['themeMode', 'light']]);
    globalThis.localStorage = { getItem: key => __storage.get(key) ?? null,
      setItem(key, value) { __storage.set(key, String(value)); },
      removeItem(key) { __storage.delete(key); } };
    globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
    globalThis.getComputedStyle = () => ({ fontSize: '16px', lineHeight: '24px', getPropertyValue: () => '' });
    globalThis.addEventListener = (name, callback) => __fixture.registrations.push({ id: 'window', name, callback });
    globalThis.removeEventListener = () => {};
    globalThis.requestAnimationFrame = callback => { __fixture.timers.push({ raf: callback }); return __fixture.timers.length; };
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setTimeout = (callback, delay) => { __fixture.timers.push({ callback, delay }); return __fixture.timers.length; };
    globalThis.clearTimeout = () => {};
    globalThis.setInterval = (callback, delay) => { __fixture.timers.push({ interval: callback, delay }); return __fixture.timers.length; };
    globalThis.clearInterval = () => {};
    globalThis.MutationObserver = class { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} };
    globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} };
    globalThis.BroadcastChannel = class {
      constructor(name) { if (name !== 'folia-export') return __fail('BroadcastChannel')(name); }
      postMessage = __fail('BroadcastChannel.postMessage');
    };
    globalThis.console = { log: (...args) => __fixture.logs.push(args.map(String)),
      warn: __fail('console.warn'), error: __fail('console.error') };
    globalThis.marked = { setOptions(options) { __fixture.hooks.push({ marked: options }); }, parse: __fail('marked.parse') };
    globalThis.DOMPurify = { addHook(name, callback) { __fixture.hooks.push({ name, callback }); }, sanitize: __fail('DOMPurify.sanitize') };
    const __transport = {
      on(channel, callback) {
        const callbacks = __fixture.subscriptions.get(channel) || [];
        callbacks.push(callback); __fixture.subscriptions.set(channel, callbacks); return this;
      },
      removeListener: __fail('transport.removeListener'),
      send(channel, payload) {
        __fixture.sends.push({ channel, payload: __copy(payload) });
        if (__fixture.phase === 'selection' &&
            ['set-active-file', 'resume-file-watching'].includes(channel)) return;
        if (__fixture.phase === 'delivery' && channel === 'file-deleted-ack') {
          const packet = __copy(payload);
          __fixture.constructed.push(packet);
          if (__fixture.dropRemaining > 0) {
            __fixture.dropRemaining--;
            __fixture.dropped.push(packet);
          } else {
            __fixture.forwarded.push(packet);
          }
          return;
        }
        return __fail('transport.send')(channel);
      },
      sendSync: __fail('transport.sendSync'),
      invoke(channel) {
        if (channel === 'get-version') { __fixture.versionQueries++; return Promise.resolve(${JSON.stringify(version)}); }
        if (channel === 'quit-approval-generation') return Promise.resolve(23);
        return __fail('transport.invoke')(channel);
      },
    };
    const __imports = {
      process: { isMainFrame: true, argv: [], platform: ${JSON.stringify(process.platform)} },
      require(name) {
        if (name !== 'electron') return __fail('preload.require')(name);
        return { ipcRenderer: __transport, contextBridge: { exposeInMainWorld(name, api) {
          if (name !== 'folia' || Object.hasOwn(window, name) || !Object.isFrozen(api)) {
            return __fail('contextBridge.exposeInMainWorld')(name);
          }
          Object.defineProperty(window, name, { value: api, enumerable: true });
        } } };
      },
    };
  `);
  const preload = path.join(SRC, "main-preload.js");
  vm.compileFunction(fs.readFileSync(preload, "utf8"), ["require", "process"], {
    parsingContext: context, filename: preload,
  })(execute("__imports.require"), execute("__imports.process"));
  for (const name of ["editor-scroll.js", "emoji-map.js", "emoji-parser.js", "utils.js",
    "mermaid-config.js", "context-menu-utils.js", "file-helpers-core.js", "document-events.js",
    "app-dialogs.js", "inline-formatting.js", "table-cell-editor.js", "reload-request.js", "renderer.js"]) {
    const file = path.join(SRC, name);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file, timeout: 1000 });
  }
  const startup = snapshot(`({
    exported: typeof window.renderMarkdown === 'function' && typeof window.getReloadRequestSession === 'function',
    frozen: Object.isFrozen(window.folia), subscriptions: (__fixture.subscriptions.get('file-deleted') || []).length,
    versionQueries: __fixture.versionQueries, uuidCalls: __fixture.uuidCalls,
    versionText: __nodes.get('welcomeVersion').textContent, unexpected: __fixture.unexpected, sends: __fixture.sends,
    writes: __fixture.writes, shows: __fixture.shows
  })`);
  assert.deepEqual(startup, {
    exported: true, frozen: true, subscriptions: 1, versionQueries: 1, uuidCalls: 1,
    versionText: "v" + version, unexpected: [], sends: [], writes: [], shows: [],
  }, "whole production code must load without unexpected work");

  const ownedPath = path.join(path.parse(ROOT).root, "folia-deletion-contract", "owned.md");
  const otherPath = path.join(path.parse(ROOT).root, "folia-deletion-contract", "other.md");
  execute(`
    const __ownedPath = ${JSON.stringify(ownedPath)};
    const __otherPath = ${JSON.stringify(otherPath)};
    const __owner = Object.freeze({ pageSession: window.getReloadRequestSession(),
      rendererGeneration: 23, tabId: 7, documentGeneration: 9,
      pathKey: fileTrackingPathKey(__ownedPath), documentRef: 'a'.repeat(64) });
    const __ownerTab = { id: __owner.tabId, filePath: __ownedPath };
    const __tabs = [__ownerTab];
    window.CustomTabs = {
      mayMutateDocument(source) {
        if (source !== 'current-file-path-setter') return __fail('CustomTabs.mayMutateDocument')(source);
        __fixture.mutationCalls.push(source);
        return true;
      },
      isDocumentFrozen: () => false,
      getTabs: () => __tabs,
      getActiveTabId: () => __owner.tabId,
      getDocumentIdentityForTab(id, filePath, session) {
        if (id !== __owner.tabId || filePath !== __ownedPath || session !== __owner.pageSession) {
          return __fail('CustomTabs.getDocumentIdentityForTab')(id, filePath, session);
        }
        return __owner;
      },
      getActiveDocumentIdentity(filePath, session) {
        if (this !== window.CustomTabs || filePath !== __ownedPath || session !== __owner.pageSession) {
          return __fail('CustomTabs.getActiveDocumentIdentity')(filePath, session);
        }
        __fixture.getterCalls.push({ filePath, session, receiver: this === window.CustomTabs });
        return __owner;
      },
      retainDeletionTombstone(owner, filePath, delivery) {
        __fixture.tombstones.push(__copy({ owner, filePath, delivery }));
      },
    };
    window.currentFilePath = __ownedPath;
    __fixture.phase = 'selection';
    const __selected = window.assertFileTrackingOwnership(__ownedPath, true, {
      adoptBaseline: false, adoptPathIdentity: false, returnDecision: false,
      expectedDocumentGeneration: __owner.documentGeneration, expectedPathKey: __owner.pathKey,
    });
    if (__selected !== true) throw new Error('Actual renderer selection failed');
    __fixture.phase = 'delivery';
    __fixture.dropRemaining = 0;
  `);
  const selection = snapshot(`({ sends: __fixture.sends, generation: window.getActiveFileSelectionGeneration(),
    owner: __owner, currentPath: window.currentFilePath })`);
  assert.deepEqual(selection.sends.map(entry => entry.channel), ["set-active-file", "resume-file-watching"]);
  assert.equal(selection.generation, 1);
  assert.equal(selection.currentPath, ownedPath);
  const tracking = {
    filePath: ownedPath, pageSession: selection.owner.pageSession,
    rendererGeneration: selection.owner.rendererGeneration,
    owner: { ...selection.owner, selectionGeneration: selection.generation },
  };
  assert.deepEqual(selection.sends[0].payload, {
    ...tracking, adoptBaseline: false, adoptPathIdentity: false, trackingActive: true,
    modifiedTime: null, diskVersion: null,
  });
  assert.deepEqual(selection.sends[1].payload, tracking);

  return {
    execute, snapshot, owner: selection.owner, selectionGeneration: selection.generation,
    deliver(input) {
      execute(`__fixture.subscriptions.get('file-deleted')[0](
        Object.freeze({ nativeOnly: 'must-not-cross' }), ${JSON.stringify(input)});`);
    },
    result() {
      return snapshot(`({
        constructed: __fixture.constructed, dropped: __fixture.dropped, forwarded: __fixture.forwarded,
        writes: __fixture.writes, shows: __fixture.shows,
        warningTimers: __fixture.timers.filter(timer => timer.callback && timer.delay === 5000).length,
        tombstones: __fixture.tombstones, getterCalls: __fixture.getterCalls, unexpected: __fixture.unexpected,
        wrapperCalls: __fixture.wrapperCalls, mutationCalls: __fixture.mutationCalls,
        currentPath: window.currentFilePath, tabPath: __ownerTab.filePath,
        selectionGeneration: window.getActiveFileSelectionGeneration(),
        sends: __fixture.sends.map(entry => entry.channel)
      })`);
    },
    ownedPath,
  };
}

function deliveryFor(fixture, eventId, attempt) {
  return {
    path: fixture.ownedPath,
    nativeOnly: "must-not-cross",
    delivery: {
      eventId, pageSession: fixture.owner.pageSession, rendererGeneration: fixture.owner.rendererGeneration,
      owner: { ...fixture.owner, nativeOnly: "must-not-cross" },
      selectionGeneration: fixture.selectionGeneration, watcherGeneration: 17, attempt,
      nativeOnly: "must-not-cross",
    },
  };
}

function expectedAck(input, consumed, why) {
  return {
    eventId: input.delivery.eventId, consumed, why, pageSession: input.delivery.pageSession,
    rendererGeneration: input.delivery.rendererGeneration, tabId: input.delivery.owner.tabId,
    documentGeneration: input.delivery.owner.documentGeneration, pathKey: input.delivery.owner.pathKey,
    selectionGeneration: input.delivery.selectionGeneration,
    watcherGeneration: input.delivery.watcherGeneration, attempt: input.delivery.attempt,
  };
}

function run(check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}) {
  const verify = (name, exercise) => {
    try { exercise(); check(name, true); }
    catch (error) { check(name, false, error.stack || String(error)); }
  };
  let fixture;
  let result;
  let expected;
  verify("whole-renderer deletion construction starts from an original preload listener and genuine renderer selection", () => {
    fixture = createFixture();
    assert.equal(fixture.selectionGeneration, 1);
  });
  verify("whole-renderer replay constructs every complete ACK before the recording transport drops the first two", () => {
    assert(fixture, "whole-renderer setup must complete first");
    fixture.execute("__fixture.dropRemaining = 2;");
    const deliveries = [1, 2, 3].map(attempt => deliveryFor(fixture, 101, attempt));
    deliveries.forEach(input => fixture.deliver(input));
    result = fixture.result();
    expected = deliveries.map((input, index) =>
      expectedAck(input, true, index === 0 ? "consumed" : "already-consumed"));
    assert.deepEqual(result.constructed, expected);
    assert(result.constructed.every(packet =>
      JSON.stringify(Object.keys(packet).sort()) === JSON.stringify([...ACK_FIELDS].sort())));
  });
  verify("whole-renderer construction records exactly two drops and one forwarding, not Main acceptance", () => {
    assert(result, "actual delivery must complete first");
    assert.deepEqual(result.dropped, expected.slice(0, 2));
    assert.deepEqual(result.forwarded, expected.slice(2));
    assert.deepEqual(result.sends, [
      "set-active-file", "resume-file-watching", "file-deleted-ack", "file-deleted-ack", "file-deleted-ack",
    ]);
    assert.deepEqual(result.unexpected, []);
  });
  verify("whole-renderer consumed delivery replay produces exactly one notification write, show, and warning timer", () => {
    assert(result, "actual delivery must complete first");
    assert.equal(result.writes.length, 1);
    assert.equal(result.shows.length, 1);
    assert.equal(result.warningTimers, 1);
    assert.match(result.writes[0], /deleted from disk/i);
    assert.equal(result.tombstones.length, 3);
    assert.equal(result.selectionGeneration, fixture.selectionGeneration);
  });

  for (const [index, why] of ["foreign-session", "owner-path-moved", "replacement-owner", "not-active"].entries()) {
    verify("whole-renderer original deletion callback emits one complete exclusive refusal ACK: " + why, () => {
      const refused = createFixture();
      const input = deliveryFor(refused, 201 + index, 1);
      refused.execute(`
        const __originalPath = window.currentFilePath;
        const __originalTabPath = __ownerTab.filePath;
        const __originalIdentity = Object.getOwnPropertyDescriptor(window.CustomTabs, 'getActiveDocumentIdentity');
      `);
      if (why === "foreign-session") {
        input.delivery.pageSession += "-foreign";
        input.delivery.owner.pageSession = input.delivery.pageSession;
      }
      if (why === "owner-path-moved") refused.execute("__ownerTab.filePath = __otherPath;");
      if (why === "replacement-owner") {
        refused.execute(`
          window.CustomTabs.getActiveDocumentIdentity = function (...args) {
            const original = __originalIdentity.value.apply(this, args);
            return { ...original, documentGeneration: original.documentGeneration + 1 };
          };
        `);
      }
      if (why === "not-active") {
        // Keep the strict original getter; only this controlled wrapper redirects its path.
        // This is a classifier input, not a naturally reached tab journey.
        refused.execute(`
          window.CustomTabs.getActiveDocumentIdentity = function (...args) {
            __fixture.wrapperCalls.push({ path: args[0], session: args[1], receiver: this === window.CustomTabs });
            return __originalIdentity.value.call(this, __originalPath, ...args.slice(1));
          };
          window.currentFilePath = __otherPath;
        `);
      }
      const getterStart = refused.result().getterCalls.length;
      let response;
      try {
        refused.deliver(input);
        response = refused.result();
      } finally {
        refused.execute(`
          Object.defineProperty(window.CustomTabs, 'getActiveDocumentIdentity', __originalIdentity);
          __ownerTab.filePath = __originalTabPath;
          window.currentFilePath = __originalPath;
          if (window.CustomTabs.getActiveDocumentIdentity !== __originalIdentity.value ||
              window.currentFilePath !== __originalPath || __ownerTab.filePath !== __originalTabPath) {
            throw new Error('Controlled deletion facts did not restore');
          }
        `);
      }
      assert.deepEqual(response.constructed, [expectedAck(input, false, why)]);
      assert.deepEqual(response.forwarded, response.constructed);
      assert.deepEqual(response.dropped, []);
      assert.deepEqual(response.writes, []);
      assert.deepEqual(response.shows, []);
      assert.equal(response.warningTimers, 0);
      assert.equal(response.tombstones.length, why === "not-active" ? 1 : 0);
      assert.deepEqual(response.unexpected, []);
      assert.deepEqual(response.sends, ["set-active-file", "resume-file-watching", "file-deleted-ack"]);
      assert.equal(response.selectionGeneration, refused.selectionGeneration);
      const originalCalls = response.getterCalls.slice(getterStart);
      assert(originalCalls.length > 0);
      assert(originalCalls.every(call =>
        call.filePath === refused.ownedPath && call.session === refused.owner.pageSession && call.receiver));
      if (why === "not-active") {
        assert.notEqual(response.currentPath, refused.ownedPath);
        assert.equal(response.tabPath, refused.ownedPath);
        assert.equal(response.wrapperCalls.length, originalCalls.length);
        assert(response.wrapperCalls.every(call =>
          call.path === response.currentPath && call.session === refused.owner.pageSession && call.receiver));
      }

      // A refused event must remain unconsumed: the first valid retry still warns.
      const retry = deliveryFor(refused, input.delivery.eventId, 2);
      refused.deliver(retry);
      const afterRetry = refused.result();
      assert.deepEqual(afterRetry.constructed, [
        expectedAck(input, false, why), expectedAck(retry, true, "consumed"),
      ]);
      assert.deepEqual(afterRetry.forwarded, afterRetry.constructed);
      assert.deepEqual(afterRetry.unexpected, []);
      assert.equal(afterRetry.writes.length, 1);
      assert.equal(afterRetry.shows.length, 1);
      assert.equal(afterRetry.warningTimers, 1);
    });
  }
}

module.exports = { run };

if (require.main === module) {
  let passed = 0;
  let failed = 0;
  try {
    run((name, ok, detail) => {
      if (ok) { passed++; console.log("  PASS  " + name); }
      else { failed++; console.error("  FAIL  " + name + "  -> " + detail); }
    });
  } catch (error) {
    failed++;
    console.error(error.stack || error);
  }
  console.log("Deletion delivery contract: " + passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
}
