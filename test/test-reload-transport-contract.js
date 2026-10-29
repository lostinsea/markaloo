"use strict";

// Actual shipping modules with transport/DOM stand-ins, not Electron or UI proof.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function run(report = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}) {
  let count = 0;
  const failures = [];
  const verify = (name, ok, detail = "") => {
    report(name, !!ok, detail);
    if (!ok) failures.push(name + ": " + detail);
    count++;
  };
  const transport = new EventEmitter();
  for (const method of ["send", "sendSync", "invoke"]) {
    transport[method] = channel => {
      throw new Error("Unexpected contract transport: " + method + " " + channel);
    };
  }
  const page = {};
  const context = vm.createContext({
    window: page,
    process: { isMainFrame: true, argv: [] },
    require(name) {
      if (name !== "electron") throw new Error("Unexpected contract import: " + name);
      return {
        ipcRenderer: transport,
        contextBridge: { exposeInMainWorld(name, api) {
          if (name !== "folia" || Object.hasOwn(page, name) || !Object.isFrozen(api)) {
            throw new Error("Contract requires one actual frozen preload API");
          }
          Object.defineProperty(page, name, { value: api, enumerable: true });
        } },
      };
    },
    verify, transport,
  });
  for (const file of ["main-preload.js", "reload-request.js"]) {
    const filename = path.join(__dirname, "..", "src", file);
    vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename, timeout: 1000 });
  }
  vm.runInContext(`
    const nodes = new Map();
    for (const id of ['fileUpdateToast', 'notificationToast', 'notificationMessage', 'markdownEditor']) {
      const classes = new Set();
      nodes.set(id, { textContent: '', value: '# Contract snapshot',
        classList: { add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name) } });
    }
    const document = { getElementById(id) {
      if (!nodes.has(id)) throw new Error('Unexpected contract DOM access: ' + id);
      return nodes.get(id);
    } };
    const errors = [], timers = [], requests = [], ordering = [];
    const logger = { error(...args) { errors.push(args); } };
    logger.error('collector-alive');
    verify('RELOAD contract console collector is alive', errors.length === 1);
    errors.length = 0;
    const state = { sequence: 0, latestByPath: new Map(), promptShown: false };
    const session = 'reload-contract-session';
    const input = {
      filePath: 'C:\\\\reload-contract.md', requestPath: 'contract-path',
      tabId: 7, documentGeneration: 3, documentPathKey: 'contract-path',
      documentRef: 'a'.repeat(64), rendererGeneration: 2, selectionGeneration: 4,
    };
    const controlled = new Error('controlled reload dispatch failure');
    let fail = false, reenter = false, nestedSequence = 0, controller;
    const normalSends = [];
    transport.send = (channel, payload) => {
      if (channel !== 'reload-file' || !Number.isSafeInteger(payload.reloadRequestSequence)) {
        throw new Error('Unexpected restored transport request');
      }
      normalSends.push(payload);
    };
    const original = Object.getOwnPropertyDescriptor(transport, 'send');
    const replacement = function (channel, payload) {
      const expected = {
        filePath: input.filePath, reloadRequestSequence: state.sequence,
        reloadRequestPath: input.requestPath,
        reloadRequestSnapshot: nodes.get('markdownEditor').value,
        reloadRequestSession: session, reloadRequestTabId: input.tabId,
        reloadRequestDocumentGeneration: input.documentGeneration,
        reloadRequestDocumentPathKey: input.documentPathKey,
        reloadRequestDocumentRef: input.documentRef,
        reloadRequestRendererGeneration: input.rendererGeneration,
        reloadRequestSelectionGeneration: input.selectionGeneration,
      };
      if (channel !== 'reload-file' ||
          JSON.stringify(payload) !== JSON.stringify(expected)) {
        throw new Error('Invalid qualified send setup: ' + JSON.stringify({ channel, payload, expected }));
      }
      requests.push(payload);
      if (fail) {
        fail = false;
        ordering.push('outer-send');
        if (reenter) {
          const nested = controller.dispatch(input);
          if (!nested) throw new Error('Nested valid dispatch failed');
          nestedSequence = state.sequence;
          ordering.push('nested-return');
        }
        ordering.push('outer-throw');
        throw controlled;
      }
      return Reflect.apply(original.value, this, [channel, payload]);
    };
    transport.send = replacement;
    const create = suppliedState => window.FoliaReloadRequest.create({
      state: suppliedState, session, document,
      readSnapshot: () => document.getElementById('markdownEditor').value,
      requestReload: request => window.folia.requestReload(request),
      i18n: key => {
        if (key !== 'notif.reloadFailed') throw new Error('Unexpected translation');
        return 'Reload failed: ';
      },
      console: logger, setTimeout: (callback, duration) => timers.push({ callback, duration }),
    });
    const descriptor = Object.getOwnPropertyDescriptor(window, 'folia');
    verify('RELOAD contract uses one immutable actual preload API',
      Object.isFrozen(window.folia) && descriptor.writable === false && descriptor.configurable === false);
    controller = create(state);
    try {
      const sent = controller.dispatch(input), prior = state.sequence;
      controller.showFileUpdateNotification();
      verify('RELOAD contract prompt setup is visible and authoritative',
        state.promptShown && nodes.get('fileUpdateToast').classList.contains('show'));
      fail = true;
      const refused = controller.dispatch(input);
      verify('SEC-08 reload contract setup reaches two qualified valid sends and the production delivery exception',
        sent && prior > 0 && requests.length === 2 &&
        requests[0].reloadRequestSequence === 1 && requests[1].reloadRequestSequence === 2 &&
        errors.length === 1 && errors[0][0] === 'Reload request delivery failed:' &&
        errors[0][1] === controlled);
      verify('SEC-08 an unsent reload preserves its earlier authoritative request and visible update prompt',
        refused === false && state.latestByPath.get(input.requestPath) === prior &&
        state.promptShown && nodes.get('fileUpdateToast').classList.contains('show') &&
        nodes.get('notificationMessage').textContent === 'Reload failed: ' + controlled.message &&
        nodes.get('notificationToast').classList.contains('show'));
      verify('RELOAD contract actual notification uses the failure duration',
        timers.length === 1 && timers[0].duration === 4000);
      timers.shift().callback();
      verify('RELOAD contract actual notification timer dismisses the toast',
        !nodes.get('notificationToast').classList.contains('show'));
      ordering.length = 0;
      fail = true; reenter = true;
      const reentrantRefused = controller.dispatch(input);
      verify('SEC-08 a newer reentrant reload retains its authority and successful prompt dismissal',
        reentrantRefused === false && nestedSequence > prior &&
        state.latestByPath.get(input.requestPath) === nestedSequence &&
        !state.promptShown && !nodes.get('fileUpdateToast').classList.contains('show'));
      verify('RELOAD contract nested valid send returns before outer synchronous throw',
        ordering.join(',') === 'outer-send,nested-return,outer-throw' &&
        requests.length === 4 && nestedSequence === 4 &&
        errors.length === 2 && errors[1][1] === controlled);
      const empty = { sequence: 0, latestByPath: new Map(), promptShown: false };
      const emptyController = create(empty);
      // The independent instance has no previous authority to restore.
      const ownedSend = transport.send;
      let emptySendCalls = 0;
      const beforeEmptyErrors = errors.length;
      const emptySend = (channel, payload) => {
        if (channel !== 'reload-file' || payload.reloadRequestSequence !== 1) {
          throw new Error('Invalid empty-authority setup');
        }
        emptySendCalls++;
        throw controlled;
      };
      transport.send = emptySend;
      try {
        verify('RELOAD contract an unsent first request removes its reservation',
          emptyController.dispatch(input) === false && empty.latestByPath.size === 0 &&
          emptySendCalls === 1 && errors.length === beforeEmptyErrors + 1 &&
          errors.at(-1)[1] === controlled);
      } finally {
        if (transport.send !== emptySend) throw new Error('Empty-authority transport ownership lost');
        transport.send = ownedSend;
      }
    } finally {
      if (transport.send !== replacement) throw new Error('Contract transport ownership lost');
      Object.defineProperty(transport, 'send', original);
    }
    verify('RELOAD contract restores the exact original transport descriptor',
      Reflect.ownKeys(original).every(key =>
        Object.getOwnPropertyDescriptor(transport, 'send')[key] === original[key]));
    const beforeRecovery = normalSends.length;
    verify('RELOAD contract ordinary dispatch remains usable after a refused transport dispatch',
      controller.dispatch(input) && normalSends.length === beforeRecovery + 1 &&
      normalSends.at(-1).reloadRequestSequence === state.sequence &&
      state.latestByPath.get(input.requestPath) === state.sequence &&
      state.sequence > nestedSequence);
    verify('RELOAD contract frozen API is unchanged after transport restoration',
      window.folia === descriptor.value && Object.isFrozen(window.folia));
  `, context, { filename: __filename, timeout: 1000 });
  if (failures.length) throw new Error(failures.join("\n"));
  return count;
}

module.exports = { run };
if (require.main === module) {
  try { run(); }
  catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
