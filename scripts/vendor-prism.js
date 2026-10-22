"use strict";

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

const BEGIN = "/* Begin Markaloo official Prism components */";
const END = "/* End Markaloo official Prism components */";
const VERSION = "1.30.0";
const LEGACY_SHA256 = "b108236a10e3523d724e6982ae1c6c1ae4f88f984b033fac2901bda1c9901f11";
const COMPONENTS = [
  "rust", "go", "markup-templating", "php", "ruby", "swift", "kotlin",
  "dart", "r", "powershell", "yaml", "toml", "markdown",
];
const normalize = text => text.replace(/\r\n/g, "\n");

function createBundle(root, original) {
  const start = original.indexOf(BEGIN);
  const end = original.indexOf(END);
  if ((start === -1) !== (end === -1) ||
      (start !== -1 && (original.indexOf(BEGIN, start + BEGIN.length) !== -1 ||
        original.indexOf(END, end + END.length) !== -1 ||
        end < start || original.slice(end + END.length).trim() !== ""))) {
    throw new Error("vendor-prism: malformed generated component boundaries");
  }
  const prefix = start === -1 ? original : original.slice(0, start);
  // The legacy bundle contains repeated registrations. Rebuilding it from npm
  // could change existing output; keep its bytes and append only this unit.
  if (createHash("sha256").update(normalize(prefix)).digest("hex") !== LEGACY_SHA256) {
    throw new Error("vendor-prism: legacy bundle changed; review its provenance before regenerating");
  }
  const prism = path.join(root, "node_modules", "prismjs");
  const installed = JSON.parse(fs.readFileSync(path.join(prism, "package.json"), "utf8")).version;
  const locked = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
    .packages["node_modules/prismjs"].version;
  if (installed !== VERSION || locked !== VERSION) {
    throw new Error(`vendor-prism: expected installed and locked Prism ${VERSION}; got ${installed}/${locked}`);
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(prism, "components.json"), "utf8")).languages;
  const loaded = new Set(["markup", "clike"]);
  const sections = [BEGIN, `// PrismJS ${VERSION}, official npm components, MIT. See THIRD-PARTY-NOTICES.md.`];
  for (const id of COMPONENTS) {
    for (const dependency of [].concat(metadata[id].require || [])) {
      if (!loaded.has(dependency)) {
        throw new Error(`vendor-prism: ${id} requires ${dependency} before it`);
      }
    }
    const source = normalize(fs.readFileSync(path.join(prism, "components", `prism-${id}.min.js`), "utf8")).trimEnd();
    if (!source) throw new Error(`vendor-prism: empty official component ${id}`);
    sections.push(`/* prism-${id}.min.js */`, source);
    loaded.add(id);
  }
  sections.push(END, "");
  const eol = prefix.includes("\r\n") ? "\r\n" : "\n";
  return prefix + sections.join("\n").replace(/\n/g, eol);
}

module.exports = { createBundle, BEGIN, END, COMPONENTS, VERSION, LEGACY_SHA256 };
