"use strict";
// Exercise the real startup, but never load Electron, Main or profile helpers.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const companion = process.argv[2] === "--companion";
if (process.argv.length !== (companion ? 3 : 2))
  throw new Error("Usage: node test-document-editor-fixture-controls.js [--companion]");
const output = message => console.log((companion ? "[companion stdout] " : "") + message);
const sourcePath = path.join(__dirname, "test-document-editor.js");
const script = new vm.Script(fs.readFileSync(sourcePath, "utf8"), { filename: sourcePath });
const workspace = fs.mkdtempSync(path.join(__dirname, "editor-fixture-controls-"));
const productFiles = ["src/main.js", "src/renderer.js", "src/custom-tabs.js",
  "src/editor-scroll.js", "src/index.html", "src/custom-styles.css"];
const protectedImports = ["electron", "./test-userdata-isolation", "./test-visual-utils", "../src/main.js"];
const cases = [];
const parentEnv = { ...process.env };
let passed = 0, failed = 0, skipped = 0;
const check = (name, run) => cases.push([name, run]);
const caseRoot = name => {
  const root = path.join(workspace, name);
  fs.mkdirSync(root);
  return root;
};

function snapshot(root) {
  const entries = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file);
      if (entry.isSymbolicLink()) entries.push([relative, "link", fs.readlinkSync(file)]);
      else if (entry.isDirectory()) { entries.push([relative, "directory"]); visit(file); }
      else entries.push([relative, "file", fs.readFileSync(file).toString("hex")]);
    }
  }
  visit(root);
  return entries;
}

function startup(root, env = {}, beforeMkdir = () => {}) {
  const events = [], stop = Object.freeze({});
  const products = new Map(productFiles.map(file =>
    [path.resolve(root, file), Buffer.from("synthetic product: " + file)]));
  const owned = file => {
    const resolved = path.resolve(file), relative = path.relative(workspace, resolved);
    assert(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative),
      "Startup filesystem operations must stay inside the owned workspace");
    return resolved;
  };
  const controlledFs = {
    mkdirSync(file, options) {
      file = owned(file);
      events.push({ op: "mkdir", file, recursive: options?.recursive === true });
      beforeMkdir(file, options);
      return fs.mkdirSync(file, options);
    },
    writeFileSync(file, data) {
      file = owned(file);
      events.push({ op: "write", file });
      return fs.writeFileSync(file, data);
    },
    readFileSync(file) {
      file = owned(file);
      assert(products.has(file), "Only synthetic product-hash reads are allowed: " + file);
      events.push({ op: "product-read", file });
      return products.get(file);
    },
  };
  const unused = () => { throw new Error("Native/profile/UI activity is not allowed in fixture controls"); };
  const context = vm.createContext({
    __dirname: path.join(root, "test"),
    process: { env: { ...env } },
    require(name) {
      events.push({ op: "require", name });
      if (name === "fs") return controlledFs;
      if (name === "path") return path;
      if (name === "crypto") return crypto;
      if (name === "electron") return { app: { exit: unused }, BrowserWindow: unused, dialog: {}, shell: {} };
      if (name === "./test-userdata-isolation") return {};
      if (name === "./test-visual-utils") return { startErrorSentinel: unused, proveSentinelAlive: unused };
      if (name === "../src/main.js") throw stop;
      throw new Error("Unexpected startup import: " + name);
    },
  });
  let error = null, reachedMain = false, bindings = null;
  try { script.runInContext(context, { timeout: 1000 }); }
  catch (caught) {
    if (caught === stop) reachedMain = true;
    else error = caught;
  }
  if (reachedMain) bindings = JSON.parse(vm.runInContext(
    "JSON.stringify({ directory, evidence, files, bodies, product })", context, { timeout: 1000 }));
  return { root, events, error, reachedMain, bindings };
}

function admitted(result, directory, evidence = directory) {
  assert.ifError(result.error);
  assert(result.reachedMain, "Real startup must reach the private Main stop");
  assert.strictEqual(result.bindings.directory, directory);
  assert.strictEqual(result.bindings.evidence, evidence);
  assert.deepStrictEqual(result.bindings.files, ["alpha.md", "beta.md"].map(file => path.join(directory, file)));
  result.bindings.files.forEach((file, index) =>
    assert.strictEqual(fs.readFileSync(file, "utf8"), result.bindings.bodies[index]));
  assert.deepStrictEqual(result.events.filter(event => event.op === "product-read").map(event => event.file),
    productFiles.map(file => path.resolve(result.root, file)));
  for (const file of productFiles) assert.strictEqual(result.bindings.product[file],
    crypto.createHash("sha256").update("synthetic product: " + file).digest("hex"));
  assert.deepStrictEqual(result.events.filter(event => event.op === "require" && protectedImports.includes(event.name))
    .map(event => event.name), protectedImports);
}

function refused(result, directory, root, before, evidence) {
  assert.deepStrictEqual({
    refused: !!result.error, reachedMain: result.reachedMain,
    imports: result.events.filter(event => event.op === "require" && protectedImports.includes(event.name)).map(event => event.name),
    writes: result.events.filter(event => event.op === "write").map(event => event.file),
    productReads: result.events.filter(event => event.op === "product-read").map(event => event.file),
    evidenceAttempts: result.events.filter(event => event.op === "mkdir" && event.file === evidence).length,
    tree: snapshot(root),
  }, { refused: true, reachedMain: false, imports: [], writes: [], productReads: [], evidenceAttempts: 0, tree: before });
  assert.match(result.error.message, /MARKALOO_EDITOR_FIXTURE_ROOT.*new directory/);
  assert(result.error.message.includes(directory), "Refusal must name the exact supplied root");
}

function existing(name, seed) {
  const root = caseRoot(name), directory = path.join(root, "fixtures"), evidence = path.join(root, "separate-evidence");
  seed(directory, root);
  const before = snapshot(root);
  refused(startup(root, { MARKALOO_EDITOR_FIXTURE_ROOT: directory, MARKALOO_EDITOR_EVIDENCE: evidence }),
    directory, root, before, evidence);
}

check("default startup resets Alpha and Beta on repeated runs, including an empty override", () => {
  const root = caseRoot("default"), directory = path.join(root, "tmp", "document-editor");
  const first = startup(root);
  admitted(first, directory);
  first.bindings.files.forEach(file => fs.writeFileSync(file, "changed default fixture"));
  const later = path.join(directory, "empty.md");
  fs.writeFileSync(later, "keep unrelated default data");
  admitted(startup(root, { MARKALOO_EDITOR_FIXTURE_ROOT: "" }), directory);
  assert.strictEqual(fs.readFileSync(later, "utf8"), "keep unrelated default data");
});
check("fresh explicit roots retain the exact supplied path, fixture names and implicit evidence", () => {
  const root = caseRoot("fresh"), directory = path.join(root, "missing-parent", "deeper", "exact-fixtures");
  const result = startup(root, { MARKALOO_EDITOR_FIXTURE_ROOT: directory });
  admitted(result, directory);
  assert.deepStrictEqual(fs.readdirSync(directory).sort(), ["alpha.md", "beta.md"]);
  const allocation = result.events.findIndex(event => event.op === "mkdir" && event.file === directory && !event.recursive);
  const firstImport = result.events.findIndex(event => event.op === "require" && protectedImports.includes(event.name));
  assert(allocation >= 0 && allocation < firstImport, "Exclusive root creation must precede protected imports");
});
check("relative explicit roots resolve normally without relocating fixtures", () => {
  const root = caseRoot("relative"), directory = path.join(root, "tmp", "document-editor");
  admitted(startup(root, { MARKALOO_EDITOR_FIXTURE_ROOT: path.relative(process.cwd(), directory) }), directory);
});
check("separate evidence is created at its exact configured path", () => {
  const root = caseRoot("separate-new"), directory = path.join(root, "tmp", "document-editor");
  const evidence = path.join(root, "proof", "images");
  admitted(startup(root, { MARKALOO_EDITOR_FIXTURE_ROOT: directory, MARKALOO_EDITOR_EVIDENCE: evidence }), directory, evidence);
  assert(fs.statSync(evidence).isDirectory());
  assert.deepStrictEqual(fs.readdirSync(evidence), []);
});
check("existing independent evidence remains allowed without adopting an existing fixture root", () => {
  const root = caseRoot("separate-existing"), directory = path.join(root, "tmp", "document-editor");
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(evidence);
  const receipt = path.join(evidence, "receipt.json"), image = path.join(evidence, "alpha-editor-restored.png");
  fs.writeFileSync(receipt, "existing separate receipt"); fs.writeFileSync(image, Buffer.from([0, 255, 13, 10]));
  const before = snapshot(evidence);
  admitted(startup(root, { MARKALOO_EDITOR_FIXTURE_ROOT: directory, MARKALOO_EDITOR_EVIDENCE: evidence }), directory, evidence);
  assert.deepStrictEqual(snapshot(evidence), before);
});
check("an existing empty directory is refused before imports or separate evidence creation", () =>
  existing("empty-directory", directory => fs.mkdirSync(directory)));
check("an existing populated directory retains every original byte", () =>
  existing("populated-directory", directory => {
    fs.mkdirSync(directory);
    for (const name of ["alpha.md", "beta.md", "unrelated.bin"])
      fs.writeFileSync(path.join(directory, name), Buffer.from([0, 255, 13, 10, 65]));
  }));
for (const name of ["empty.md", "receipt.json", "alpha-editor-restored.png"])
  check("an existing root containing only " + name + " is never adopted", () =>
    existing("later-" + name, directory => {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, name), Buffer.from([0, 255, 13, 10, 66]));
    }));
check("an existing file is refused without changing its bytes", () =>
  existing("existing-file", directory => fs.writeFileSync(directory, "existing file witness")));
check("an existing junction or directory link and its owned target stay unchanged", () => {
  const root = caseRoot("existing-link"), directory = path.join(root, "fixtures");
  const target = path.join(root, "target"), evidence = path.join(root, "separate-evidence");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "alpha.md"), "owned link-target witness");
  try { fs.symlinkSync(target, directory, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error.code)) throw error;
    return "Owned junction/directory-link creation is unsupported: " + error.code + " " + error.message;
  }
  assert(fs.lstatSync(directory).isSymbolicLink(), "The negative fixture must really be a link");
  const before = snapshot(root);
  refused(startup(root, { MARKALOO_EDITOR_FIXTURE_ROOT: directory, MARKALOO_EDITOR_EVIDENCE: evidence }),
    directory, root, before, evidence);
});
check("reusing an explicit root is refused while a different fresh root still works", () => {
  const root = caseRoot("reuse"), directory = path.join(root, "tmp", "document-editor");
  const env = { MARKALOO_EDITOR_FIXTURE_ROOT: directory }, evidence = path.join(root, "unused-evidence");
  admitted(startup(root, env), directory);
  for (const name of ["alpha.md", "beta.md", "empty.md", "receipt.json", "alpha-editor-restored.png"])
    fs.writeFileSync(path.join(directory, name), "previous run: " + name);
  const before = snapshot(root);
  refused(startup(root, { ...env, MARKALOO_EDITOR_EVIDENCE: evidence }), directory, root, before, evidence);
  const different = path.join(root, "another-exact-root");
  admitted(startup(root, { MARKALOO_EDITOR_FIXTURE_ROOT: different }), different);
});
check("a competing creation at exclusive mkdir is refused without adopting its data", () => {
  const root = caseRoot("creation-race"), directory = path.join(root, "tmp", "document-editor");
  const evidence = path.join(root, "separate-evidence");
  let before = null;
  const result = startup(root, { MARKALOO_EDITOR_FIXTURE_ROOT: directory, MARKALOO_EDITOR_EVIDENCE: evidence }, (file, options) => {
    if (file !== directory || options?.recursive) return;
    assert.strictEqual(before, null, "The allocation race is injected once");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "receipt.json"), "competing creator owns these bytes");
    before = snapshot(root);
  });
  assert(before, "Actual startup must attempt exclusive final-directory creation");
  refused(result, directory, root, before, evidence);
});
check("controlled startup leaves the parent environment untouched", () =>
  assert.deepStrictEqual({ ...process.env }, parentEnv));

try {
  for (const [name, run] of cases) {
    try {
      const skip = run();
      if (skip) { skipped++; output("SKIP " + name + "  -> " + skip); }
      else { passed++; output("PASS " + name); }
    } catch (error) { failed++; output("FAIL " + name + "  -> " + JSON.stringify(error.message)); }
  }
} finally {
  // Only the exact directory allocated by this invocation is removed.
  fs.rmSync(workspace, { recursive: true, force: true });
}
if (skipped) output("Skipped fixture controls: " + skipped);
output(`=== ${passed}/${passed + failed} passed ===`);
process.exitCode = failed ? 1 : 0;
