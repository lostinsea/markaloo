"use strict";

// Whole production preload with VM-local transport, not Main or desktop proof.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function run(report = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}) {
  const page = {};
  const transport = new EventEmitter();
  for (const method of ["send", "sendSync", "invoke"]) {
    transport[method] = channel => {
      throw new Error("Unexpected owned contract transport: " + method + " " + channel);
    };
  }
  const context = vm.createContext({
    window: page, transport,
    process: { isMainFrame: true, argv: [] },
    require(name) {
      if (name !== "electron") throw new Error("Unexpected owned contract import: " + name);
      return {
        ipcRenderer: transport,
        contextBridge: { exposeInMainWorld(name, api) {
          if (name !== "folia" || Object.hasOwn(page, name) || !Object.isFrozen(api)) {
            throw new Error("Owned contract requires one actual frozen preload API");
          }
          Object.defineProperty(page, name, { value: api, enumerable: true });
        } },
      };
    },
  }, { microtaskMode: "afterEvaluate" });
  const filename = path.join(__dirname, "..", "src", "main-preload.js");
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename, timeout: 1000 });
  vm.runInContext(`
    const outcome = { completed: false, error: null, results: [] };
    const verify = (name, ok, detail = '') => outcome.results.push({
      name: 'METADATA contract ' + name, ok: !!ok, detail: String(detail),
    });
    (async () => {
      const api = window.folia;
      verify('publishes the whole production preload as one frozen API',
        Object.isFrozen(api) && typeof api.refreshOwnedTabDiskSnapshot === 'function' &&
        Object.getOwnPropertyDescriptor(window, 'folia').writable === false);
      const owner = {
        pageSession: 'metadata-contract-page', rendererGeneration: 2,
        tabId: 7, documentGeneration: 3, pathKey: 'metadata-contract-key',
        documentRef: 'a'.repeat(64),
      };
      const diskVersion = { dev: 1, ino: 2, size: 31, mtimeMs: 100, ctimeMs: 101 };
      const request = {
        filePath: 'C:\\\\metadata-contract.md', pageSession: owner.pageSession,
        rendererGeneration: owner.rendererGeneration, owner, diskVersion,
      };
      let response = { status: 'changed', pathKey: owner.pathKey,
        content: '# Actual preload contract', modifiedTime: 102,
        diskVersion: { ...diskVersion, mtimeMs: 102 }, ignored: true };
      const normalRequests = [];
      transport.invoke = function (channel, payload) {
        normalRequests.push({ channel, payload });
        return Promise.resolve(response);
      };
      const original = Object.getOwnPropertyDescriptor(transport, 'invoke');
      const calls = [];
      const controlled = new Error('controlled metadata transport rejection');
      let reject = false;
      const replacement = function (channel, payload) {
        calls.push({ channel, payload });
        if (reject) return Promise.reject(controlled);
        return Promise.resolve(response);
      };
      Object.defineProperty(transport, 'invoke', { ...original, value: replacement });
      try {
        const rejected = [];
        for (const input of [
          { ...request, filePath: 'bad\\0path' },
          { ...request, owner: { ...owner, documentRef: undefined } },
          { ...request, diskVersion: undefined },
          { ...request, diskVersion: { ...diskVersion, size: Infinity } },
          { ...request, diskVersion: [] },
        ]) {
          try { await api.refreshOwnedTabDiskSnapshot(input); rejected.push(false); }
          catch (error) { rejected.push(error instanceof TypeError && /Invalid/.test(error.message)); }
        }
        verify('rejects all five malformed envelopes before any transport',
          rejected.length === 5 && rejected.every(Boolean) && calls.length === 0,
          JSON.stringify({ rejected, calls }));
        const changed = await api.refreshOwnedTabDiskSnapshot({
          ...request, ignored: true, owner: { ...owner, ignored: true },
          diskVersion: { ...diskVersion, ignored: true },
        });
        const sent = calls[0];
        verify('sends one exact qualified request with only fixed fields',
          calls.length === 1 && sent.channel === 'refresh-owned-tab-disk-snapshot' &&
          JSON.stringify(sent.payload) === JSON.stringify(request),
          JSON.stringify(calls));
        verify('copies changed content and freezes only the documented snapshot fields',
          changed !== response && changed.content === response.content &&
          changed.modifiedTime === response.modifiedTime &&
          changed.pathKey === owner.pathKey && changed.status === 'changed' &&
          Object.keys(changed).sort().join(',') === 'content,diskVersion,modifiedTime,pathKey,status' &&
          Object.isFrozen(changed) && Object.isFrozen(changed.diskVersion),
          JSON.stringify(changed));
        response = { status: 'unchanged', pathKey: owner.pathKey,
          diskVersion: { ...diskVersion, ctimeMs: diskVersion.ctimeMs + 1 } };
        const unchanged = await api.refreshOwnedTabDiskSnapshot(request);
        verify('accepts finite ctime-only drift without inventing content',
          unchanged.status === 'unchanged' && unchanged.pathKey === owner.pathKey &&
          unchanged.diskVersion.ctimeMs === response.diskVersion.ctimeMs &&
          Object.keys(unchanged).sort().join(',') === 'diskVersion,pathKey,status' &&
          Object.isFrozen(unchanged) && Object.isFrozen(unchanged.diskVersion));
        const unavailable = [];
        for (const reason of ['missing', 'binding']) {
          response = { status: 'unavailable', pathKey: owner.pathKey, reason, ignored: true };
          const result = await api.refreshOwnedTabDiskSnapshot(request);
          unavailable.push(result.status === 'unavailable' && result.reason === reason &&
            result.pathKey === owner.pathKey && Object.isFrozen(result) &&
            Object.keys(result).sort().join(',') === 'pathKey,reason,status');
        }
        verify('preserves both unavailable reasons without document or body authority',
          unavailable.length === 2 && unavailable.every(Boolean));
        response = null;
        verify('preserves an actual transport null as refusal',
          await api.refreshOwnedTabDiskSnapshot(request) === null);
        const rejectedResponses = [];
        for (const invalid of [
          undefined, [], { status: 'changed', pathKey: 'foreign' },
          { status: 'unavailable', pathKey: owner.pathKey, reason: 'missing', diskVersion },
          { status: 'unchanged', pathKey: owner.pathKey, diskVersion, content: 'leak' },
          { status: 'changed', pathKey: owner.pathKey, diskVersion, content: 'new',
            modifiedTime: diskVersion.mtimeMs + 1 },
          { status: 'unchanged', pathKey: owner.pathKey,
            diskVersion: { ...diskVersion, ctimeMs: Infinity } },
          { status: 'unknown', pathKey: owner.pathKey },
        ]) {
          response = invalid;
          try { await api.refreshOwnedTabDiskSnapshot(request); rejectedResponses.push(false); }
          catch (error) {
            rejectedResponses.push(error instanceof TypeError &&
              error.message === 'Invalid conditional tab disk refresh response');
          }
        }
        verify('rejects all eight malformed or body-leaking refresh receipts',
          rejectedResponses.length === 8 && rejectedResponses.every(Boolean),
          JSON.stringify(rejectedResponses));
        reject = true;
        const before = calls.length;
        let failure;
        try { await api.refreshOwnedTabDiskSnapshot(request); }
        catch (error) { failure = error; }
        verify('propagates the identical valid-send transport rejection, not validation failure',
          failure === controlled && calls.length === before + 1 &&
          calls.at(-1).channel === 'refresh-owned-tab-disk-snapshot' &&
          JSON.stringify(calls.at(-1).payload) === JSON.stringify(request));
      } finally {
        if (transport.invoke !== replacement) throw new Error('Owned contract lost transport ownership');
        Object.defineProperty(transport, 'invoke', original);
      }
      response = { status: 'unchanged', pathKey: owner.pathKey, diskVersion };
      const restored = await api.refreshOwnedTabDiskSnapshot(request);
      verify('restores the original transport descriptor and actual preload remains usable',
        transport.invoke === original.value &&
        Object.getOwnPropertyDescriptor(transport, 'invoke').writable === original.writable &&
        Object.getOwnPropertyDescriptor(transport, 'invoke').configurable === original.configurable &&
        Object.getOwnPropertyDescriptor(transport, 'invoke').enumerable === original.enumerable &&
        normalRequests.length === 1 && restored.status === 'unchanged' &&
        Object.isFrozen(api));
    })().then(
      () => { outcome.completed = true; },
      error => { outcome.error = String(error.stack || error); outcome.completed = true; },
    );
    void 0;
  `, context, { filename: __filename, timeout: 1000 });
  const outcome = JSON.parse(vm.runInContext("JSON.stringify(outcome)", context, { timeout: 1000 }));
  if (outcome.completed !== true || outcome.error || outcome.results.length !== 10) {
    throw new Error("Owned preload contract did not complete all ten checks: " + JSON.stringify(outcome));
  }
  for (const result of outcome.results) report(result.name, result.ok, result.detail);
  const failures = outcome.results.filter(result => !result.ok);
  if (failures.length) throw new Error(JSON.stringify(failures));
  return outcome.results.length;
}

module.exports = { run };
if (require.main === module) {
  try { run(); }
  catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
