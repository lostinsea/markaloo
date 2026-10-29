"use strict";

// Actual editor-setup helper with simulated page collaborators, not an app run.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const filename = path.join(__dirname, "test-tab-refresh.js");
const source = fs.readFileSync(filename, "utf8").replace(/\r\n/g, "\n");
new vm.Script(source, { filename });
const start = source.indexOf("async function prepareTeardownEditor(");
const end = source.indexOf("\n}\n", start);
assert(start >= 0 && end > start, "complete owned editor helper exists");
let helper = source.slice(start, end + 3);
const negative = process.argv[2];
if (negative) {
  assert.equal(negative, "eager-cache", "unknown negative control");
  const before = "editor.value === baseline || tab.content !== baseline";
  assert.equal(helper.split(before).length, 2, "one exact cache-witness target");
  helper = helper.replace(before, "editor.value === baseline || false");
  console.log("NEGATIVE CONTROL eager-cache: removed only the extracted helper's independent-cache check");
}

function fixture(options = {}) {
  const text = "Physical teardown baseline\n";
  const file = "C:\\fixture\\teardown.md";
  const tab = { filePath: options.wrongPath ? "C:\\other.md" : file,
    content: options.badCache ? "unexpected cache" : text, originalContent: text,
    hasUnsavedChanges: false };
  let editing = !!options.editing;
  let clicks = 0;
  const inputs = [];
  const editor = {
    value: text,
    readOnly: !!options.readOnly,
    dispatchEvent(event) {
      inputs.push(event);
      if (options.eagerCache) tab.content = this.value;
    },
  };
  const page = vm.createContext({
    window: { markdownEditor: editor, CustomTabs: {
      __inEditMode: () => editing, getActiveTab: () => tab,
    } },
    document: {
      body: { inert: !!options.inert },
      getElementById(id) {
        assert.equal(id, "toggleEdit");
        return { click() { clicks += 1; editing = !editing; } };
      },
    },
    Event: class { constructor(type, init) { this.type = type; this.bubbles = init.bubbles; } },
  });
  const exec = async code => new vm.Script(code).runInContext(page);
  const setup = new vm.Script(`${helper}\nprepareTeardownEditor;`).runInContext(vm.createContext({
    waitForCondition: async (run, expression) => run(expression),
  }));
  return { tab, editor, inputs, text, file, clicks: () => clicks,
    run: marker => setup(exec, file, text, marker === undefined ? "\nLIVE_ONLY_EDIT\n" : marker) };
}

const cases = [
  ["the full Electron test compiles without importing or executing it", async () => {
    assert(source.includes("async function runTeardownScenario("));
  }],
  ["real helper input leaves the simulated old cache and source baseline independent", async () => {
    const f = fixture();
    const result = await f.run();
    assert.equal(f.clicks(), 1);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.inputs[0].type, "input");
    assert.equal(f.inputs[0].bubbles, true);
    assert.notEqual(result.live, f.text);
    assert.equal(result.cached, f.text);
    assert.equal(result.baseline, f.text);
    assert.equal(result.filePath, f.file);
    assert.equal(result.readOnly, false);
    assert.equal(result.bodyInert, false);
  }],
  ["an already-open editor is not toggled back to view mode", async () => {
    const f = fixture({ editing: true });
    await f.run();
    assert.equal(f.clicks(), 0);
    assert.equal(f.inputs.length, 1);
  }],
  ["a read-only or inert document cannot impersonate a writable dirty setup", async () => {
    for (const option of [{ readOnly: true }, { inert: true }]) {
      const f = fixture(option);
      await assert.rejects(f.run(), /not clean and writable/);
      assert.equal(f.editor.value, f.text);
      assert.equal(f.inputs.length, 0);
    }
  }],
  ["an unbound cache is rejected before live input", async () => {
    const f = fixture({ badCache: true });
    await assert.rejects(f.run(), /not clean and writable/);
    assert.equal(f.inputs.length, 0);
  }],
  ["an eager-folding collaborator fails rather than weakening the cache witness", async () => {
    const f = fixture({ eagerCache: true });
    await assert.rejects(f.run(), /bind live input separately/);
    assert.equal(f.inputs.length, 1);
  }],
  ["an empty marker cannot pass as a dirty editor", async () => {
    const f = fixture();
    await assert.rejects(f.run(""), /bind live input separately/);
  }],
  ["a different active path fails the editor setup gate", async () => {
    const f = fixture({ wrongPath: true });
    await assert.rejects(f.run(), /did not enter its real editor/);
    assert.equal(f.inputs.length, 0);
  }],
];

(async () => {
  let failures = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
  }
  console.log(`${cases.length - failures}/${cases.length} helper controls; Main/updater/Electron/native NOT RUN`);
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
