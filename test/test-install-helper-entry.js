"use strict";

// Actual entry evaluation; no Electron, helper process or native provider is loaded.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const entryPath = path.join(__dirname, "..", "src", "entry.mjs");
const entry = fs.readFileSync(entryPath, "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(role = "normal", preparationError = null) {
  let resolve;
  let reject;
  const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
  const electron = { app: {} };
  const loaded = [];
  const reported = [];
  let prepared = 0;
  const startup = {
    prepareApplicationStartup(value) {
      assert.equal(value, electron);
      prepared++;
      if (preparationError) throw preparationError;
      return { role, completion };
    },
    reportStartupFailure(value, error) {
      assert.equal(value, electron);
      reported.push(error);
    },
  };
  const context = vm.createContext({});
  const shim = new vm.SyntheticModule(["createRequire"], function() {
    this.setExport("createRequire", () => name => {
      loaded.push(name);
      if (name === "electron") return electron;
      if (name === "./profile-startup.js") return startup;
      assert.fail("Unexpected entry dependency: " + name);
    });
  }, { context });
  const module = new vm.SourceTextModule(entry, {
    context,
    initializeImportMeta(meta) { meta.url = pathToFileURL(entryPath).href; },
  });
  await module.link(name => {
    assert.equal(name, "node:module");
    return shim;
  });
  return { module, resolve, reject, loaded, reported, prepared: () => prepared };
}

test("normal actual entry prepares synchronously and awaits ordinary completion", async () => {
  const f = await fixture();
  let evaluated = false;
  const evaluation = f.module.evaluate().then(() => { evaluated = true; });
  await tick();
  assert.equal(f.prepared(), 1);
  assert.equal(evaluated, false);
  assert.deepEqual(f.loaded, ["electron", "./profile-startup.js"]);
  f.resolve();
  await evaluation;
  assert.equal(evaluated, true);
  assert.deepEqual(f.reported, []);
});

test("normal completion failure reports once without loading an installer/helper fallback", async () => {
  const f = await fixture();
  const evaluation = f.module.evaluate();
  const error = new Error("ordinary startup refused");
  f.reject(error);
  await evaluation;
  assert.deepEqual(f.reported, [error]);
  assert.deepEqual(f.loaded, ["electron", "./profile-startup.js"]);
});

test("ordinary validation child finishes entry evaluation before readiness completion", async () => {
  const f = await fixture("validation-child");
  await f.module.evaluate();
  assert.equal(f.prepared(), 1);
  assert.deepEqual(f.reported, []);
  const error = new Error("validation refused after ready");
  f.reject(error);
  await tick();
  assert.deepEqual(f.reported, [error]);
  assert.deepEqual(f.loaded, ["electron", "./profile-startup.js"]);
});

test("synchronous startup refusal uses the ordinary reporter once", async () => {
  const error = new Error("malformed private role");
  const f = await fixture("normal", error);
  await f.module.evaluate();
  assert.equal(f.prepared(), 1);
  assert.deepEqual(f.reported, [error]);
  assert.deepEqual(f.loaded, ["electron", "./profile-startup.js"]);
});
