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

      const committedCheck = (name, ok, detail = '') => outcome.results.push({
        name: 'COMMITTED contract ' + name, ok: !!ok, detail: String(detail),
      });
      const committedRequest = {
        capability: 'b'.repeat(32), pageSession: 'committed-contract-page',
        rendererGeneration: 2,
      };
      const committedPositive = { valid: true, pathKey: 'committed-contract-key', version: diskVersion };
      const normalCommittedSends = [];
      transport.sendSync = function (channel, payload) {
        normalCommittedSends.push({ channel, payload });
        return committedPositive;
      };
      const syncDescriptor = Object.getOwnPropertyDescriptor(transport, 'sendSync');
      const committedSends = [];
      let committedResponse = committedPositive;
      const syncReplacement = function (channel, payload) {
        committedSends.push({ channel, payload });
        return committedResponse;
      };
      Object.defineProperty(transport, 'sendSync', { ...syncDescriptor, value: syncReplacement });
      try {
        const rejected = [];
        for (const input of [
          null, [], { ...committedRequest, capability: 'bad' },
          { ...committedRequest, pageSession: '' },
          { ...committedRequest, rendererGeneration: Infinity },
        ]) {
          try { api.checkCommittedDiskAdoption(input); rejected.push(false); }
          catch (error) { rejected.push(error.message.includes('Invalid')); }
        }
        committedCheck('rejects all five malformed capability envelopes before transport',
          rejected.length === 5 && rejected.every(Boolean) && committedSends.length === 0,
          JSON.stringify({ rejected, calls: committedSends }));
        const positive = api.checkCommittedDiskAdoption({
          ...committedRequest, filePath: 'not-authority', ignored: true,
        });
        committedCheck('copies only capability fields and preserves the valid metadata receipt',
          committedSends.length === 1 &&
          committedSends[0].channel === 'check-committed-disk-adoption' &&
          Object.keys(committedSends[0].payload).sort().join(',') ===
            'capability,pageSession,rendererGeneration' &&
          Object.keys(committedRequest).every(key =>
            committedSends[0].payload[key] === committedRequest[key]) &&
          JSON.stringify(positive) === JSON.stringify(committedPositive) &&
          positive !== committedPositive && Object.isFrozen(positive) &&
          Object.isFrozen(positive.version), JSON.stringify({ committedSends, positive }));
        const badResponses = [];
        for (const response of [
          undefined, [], { ...committedPositive, valid: 'true' },
          { ...committedPositive, pathKey: 'bad\\0path' },
          { ...committedPositive, version: { ...committedPositive.version, size: Infinity } },
          { ...committedPositive, content: 'body-must-not-cross' },
          { valid: false }, { valid: false, why: 'refused', version: committedPositive.version },
        ]) {
          committedResponse = response;
          try { api.checkCommittedDiskAdoption(committedRequest); badResponses.push(false); }
          catch (error) {
            badResponses.push(error.message.includes('Invalid committed disk adoption response'));
          }
        }
        committedCheck('rejects all eight malformed receipts and metadata body leakage',
          badResponses.length === 8 && badResponses.every(Boolean), JSON.stringify(badResponses));
      } finally {
        if (transport.sendSync !== syncReplacement) throw new Error('Committed contract lost transport ownership');
        Object.defineProperty(transport, 'sendSync', syncDescriptor);
      }
      const afterRestore = api.checkCommittedDiskAdoption(committedRequest);
      const restoredSync = Object.getOwnPropertyDescriptor(transport, 'sendSync');
      committedCheck('restores the exact sync transport descriptor and remains usable',
        Reflect.ownKeys(syncDescriptor).every(key => restoredSync[key] === syncDescriptor[key]) &&
        normalCommittedSends.length === 1 && afterRestore.valid === true && Object.isFrozen(api));

      const dialogCheck = (name, ok, detail = '') => outcome.results.push({
        name: 'DIALOG contract ' + name, ok: !!ok, detail: String(detail),
      });
      const dialogRequest = {
        grant: '1'.repeat(64), pageSession: 'dialog-bridge-probe', rendererGeneration: 1,
      };
      const dialogSnapshot = {
        path: 'C:\\\\dialog-contract.md', content: '# Bridge snapshot', modifiedTime: 123,
        diskVersion: { dev: 1, ino: 2, size: 17, mtimeMs: 123, ctimeMs: 124 },
      };
      response = dialogSnapshot;
      const dialogDescriptor = Object.getOwnPropertyDescriptor(transport, 'invoke');
      const normalBeforeDialog = normalRequests.length;
      const dialogCalls = [];
      let dialogResponse = dialogSnapshot;
      let rejectDialog = false;
      const dialogFailure = new Error('controlled authorized read failure');
      const dialogTransport = function (channel, payload) {
        dialogCalls.push({ channel, payload });
        return rejectDialog ? Promise.reject(dialogFailure) : Promise.resolve(dialogResponse);
      };
      Object.defineProperty(transport, 'invoke', { ...dialogDescriptor, value: dialogTransport });
      try {
        const rejected = [];
        for (const input of [
          null, [], { ...dialogRequest, grant: '' },
          { ...dialogRequest, grant: 'bad\\0grant' },
          { ...dialogRequest, grant: 'x'.repeat(129) },
          { ...dialogRequest, pageSession: '' },
          { ...dialogRequest, pageSession: 'x'.repeat(129) },
          { ...dialogRequest, rendererGeneration: 0 },
          { ...dialogRequest, rendererGeneration: 1.5 },
        ]) {
          try { await api.readDialogExtra(input); rejected.push(false); }
          catch (error) { rejected.push(error.message.includes('Invalid dialog extra request')); }
        }
        dialogCheck('rejects all nine malformed envelopes before transport',
          rejected.length === 9 && rejected.every(Boolean) && dialogCalls.length === 0,
          JSON.stringify({ rejected, dialogCalls }));
        const positive = await api.readDialogExtra({
          ...dialogRequest, path: 'unapproved-path', ignored: true,
        });
        dialogCheck('forwards only the grant envelope and preserves the valid snapshot',
          dialogCalls.length === 1 && dialogCalls[0].channel === 'read-dialog-extra' &&
          Object.keys(dialogCalls[0].payload).sort().join(',') === 'grant,pageSession,rendererGeneration' &&
          Object.keys(dialogRequest).every(key =>
            dialogCalls[0].payload[key] === dialogRequest[key]) &&
          positive.path === dialogSnapshot.path && positive.content === dialogSnapshot.content &&
          positive.modifiedTime === dialogSnapshot.modifiedTime &&
          JSON.stringify(positive.diskVersion) === JSON.stringify(dialogSnapshot.diskVersion) &&
          Object.isFrozen(positive) && Object.isFrozen(positive.diskVersion),
          JSON.stringify({ dialogCalls, positive }));
        const rejectedResponses = [];
        for (const candidate of [
          null, undefined, { ...dialogSnapshot, path: '' },
          { ...dialogSnapshot, path: 'bad\\0path' }, { ...dialogSnapshot, content: 3 },
          { ...dialogSnapshot, diskVersion: { ...dialogSnapshot.diskVersion, size: Infinity } },
        ]) {
          dialogResponse = candidate;
          try { await api.readDialogExtra(dialogRequest); rejectedResponses.push(false); }
          catch (error) {
            rejectedResponses.push(error.message.includes('Invalid dialog extra snapshot response'));
          }
        }
        dialogCheck('rejects all six malformed snapshot responses',
          rejectedResponses.length === 6 && rejectedResponses.every(Boolean),
          JSON.stringify(rejectedResponses));
        rejectDialog = true;
        let receivedFailure = null;
        try { await api.readDialogExtra(dialogRequest); }
        catch (error) { receivedFailure = error; }
        dialogCheck('preserves the original authorized-read transport rejection',
          receivedFailure === dialogFailure &&
          receivedFailure.message === 'controlled authorized read failure');
      } finally {
        if (transport.invoke !== dialogTransport) throw new Error('Dialog contract lost transport ownership');
        Object.defineProperty(transport, 'invoke', dialogDescriptor);
      }
      const restoredDialog = await api.readDialogExtra(dialogRequest);
      const restoredInvoke = Object.getOwnPropertyDescriptor(transport, 'invoke');
      dialogCheck('restores the exact invoke descriptor and remains usable',
        Reflect.ownKeys(dialogDescriptor).every(key => restoredInvoke[key] === dialogDescriptor[key]) &&
        normalRequests.length === normalBeforeDialog + 1 &&
        restoredDialog.path === dialogSnapshot.path && restoredDialog.content === dialogSnapshot.content &&
        Object.isFrozen(api));
    })().then(
      () => { outcome.completed = true; },
      error => { outcome.error = String(error.stack || error); outcome.completed = true; },
    );
    void 0;
  `, context, { filename: __filename, timeout: 1000 });
  const outcome = JSON.parse(vm.runInContext("JSON.stringify(outcome)", context, { timeout: 1000 }));
  if (outcome.completed !== true || outcome.error || outcome.results.length !== 19) {
    throw new Error("Owned preload contract did not complete all nineteen checks: " + JSON.stringify(outcome));
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
