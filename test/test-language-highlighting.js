"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const runtime = path.join(__dirname, ".language-highlighting-runtime");
// The shared isolation helper uses os.tmpdir(). Keep its fresh profile inside
// this suite's own work surface, never the user's profile or system temp tree.
if (process.versions.electron) {
  fs.mkdirSync(runtime, { recursive: true });
  process.env.TMP = process.env.TEMP = process.env.TMPDIR = runtime;
}
require("./test-userdata-isolation");
const fixture = require("./fixtures/language-highlighting");
const BEGIN = "/* Begin Markaloo official Prism components */";
const END = "/* End Markaloo official Prism components */";
const LEGACY_SHA256 = "b108236a10e3523d724e6982ae1c6c1ae4f88f984b033fac2901bda1c9901f11";
const normalize = text => text.replace(/\r\n/g, "\n");
const LEGACY_LANGUAGES = [
  "plain", "plaintext", "text", "txt", "markup", "html", "mathml", "svg", "xml",
  "ssml", "atom", "rss", "css", "clike", "javascript", "js", "typescript", "ts",
  "jsx", "tsx", "json", "webmanifest", "python", "py", "java", "c", "cpp",
  "csharp", "cs", "dotnet", "bash", "sh", "shell", "sql",
];
const results = [];
const receipt = { assertions: results, screenshots: [], correspondence: [], versions: process.versions };
const proof = process.env.MARKALOO_SYNTAX_PROOF || null;
const sourceOnly = process.argv.includes("--source") || !process.versions.electron;
const evidence = path.resolve(process.env.MARKALOO_SYNTAX_EVIDENCE || path.join(runtime, "evidence"));
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, ...(ok || detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const inventory = prism => Object.keys(prism.languages).filter(key =>
  prism.languages[key] && typeof prism.languages[key] === "object").sort();
function loadPrism(source) {
  const context = vm.createContext({});
  vm.runInContext(source.toString(), context, { timeout: 5000 });
  return context.Prism;
}
function decode(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#39);/g, entity =>
    ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[entity]);
}
function highlighted(prism, language, source) {
  const tokens = [];
  const wrap = env => tokens.push({ type: env.type, text: decode(env.content) });
  prism.hooks.add("wrap", wrap);
  try {
    const html = prism.highlight(source, prism.languages[language], language);
    return { html, text: decode(html), tokens };
  } catch (error) {
    return { error: String(error.message) };
  } finally {
    prism.hooks.all.wrap = prism.hooks.all.wrap.filter(callback => callback !== wrap);
  }
}
function oldSource(language) {
  if (["plain", "plaintext", "text", "txt"].includes(language)) return "<plain>& no inference";
  if (["markup", "html", "mathml", "svg", "xml", "ssml", "atom", "rss", "jsx", "tsx"].includes(language))
    return '<article class="legacy"><b title="&amp;">old &lt;text&gt;</b></article>';
  if (language === "css") return '.legacy:hover { color: #abcdef; content: "<old>&"; }';
  if (["json", "webmanifest"].includes(language)) return '{"name":"<old>&","enabled":true,"value":42}';
  if (["python", "py"].includes(language)) return '# old Python\ndef legacy(value):\n    return "<old>&" if value else None\n';
  if (["bash", "sh", "shell"].includes(language)) return '# old shell\nif [ "$name" ]; then echo "<old>&"; fi\n';
  if (language === "sql") return "-- old SQL\nSELECT name, COUNT(*) FROM records WHERE id > 42;";
  return '// old typed source\npublic class Legacy { const value = "<old>&"; return true; }\n';
}
function sourceChecks() {
  if (proof && !fixture.componentOrder.includes(proof) && proof !== "bundle")
    throw new Error("Unsupported syntax proof route: " + proof);
  const bundle = fs.readFileSync(path.join(ROOT, "libs", "prismjs", "prism-bundle.js"), "utf8");
  const boundary = bundle.indexOf(BEGIN);
  const prefix = boundary < 0 ? bundle : bundle.slice(0, boundary);
  receipt.bundle = { sha256: sha256(bundle), bytes: Buffer.byteLength(bundle), legacySha256: sha256(normalize(prefix)) };
  check("syntax legacy prefix remains byte-for-byte unchanged",
    sha256(normalize(prefix)) === LEGACY_SHA256, receipt.bundle);
  const old = loadPrism(prefix), current = loadPrism(bundle);
  check("syntax legacy runtime inventory is the measured complete baseline",
    JSON.stringify(inventory(old)) === JSON.stringify(LEGACY_LANGUAGES.slice().sort()), inventory(old));
  const regressions = LEGACY_LANGUAGES.map(language => {
    const before = highlighted(old, language, oldSource(language));
    const after = highlighted(current, language, oldSource(language));
    return { language, ok: !before.error && !after.error && before.html === after.html };
  }).filter(value => !value.ok);
  const aliasesPreserved = LEGACY_LANGUAGES.every(a => LEGACY_LANGUAGES.every(b =>
    (old.languages[a] === old.languages[b]) === (current.languages[a] === current.languages[b])));
  check("syntax every legacy grammar and alias retains its original token output",
    regressions.length === 0 && aliasesPreserved, regressions);
  check("syntax unsupported Dockerfile and invented Rust aliases remain absent",
    !current.languages.dockerfile && !current.languages.docker && !current.languages.rs);
  const selected = fixture.cases.filter(entry => !proof || proof === "bundle" ||
    entry.language === proof || (proof === "markup-templating" && entry.language === "php"));
  for (const entry of selected) {
    const observations = [entry.language, ...entry.aliases].map(language => {
      const output = highlighted(current, language, entry.source);
      return { language, output, ok: !output.error && output.text === entry.source &&
        !/<(?!\/?span\b)[^>]+>/.test(output.html) &&
        entry.probes.every(([type, text]) => output.tokens.some(token =>
          token.type === type && token.text === text)) &&
        current.languages[language] === current.languages[entry.language] };
    });
    check(`syntax ${entry.language} official tokens and aliases retain exact source`,
      observations.every(value => value.ok), observations.filter(value => !value.ok));
  }
  if (proof && proof !== "bundle") return;
  check("syntax official aliases exactly match the installed component metadata",
    fixture.cases.every(entry => {
      const official = require("prismjs/components.json").languages[entry.language].alias || [];
      return JSON.stringify([].concat(official).sort()) === JSON.stringify(entry.aliases.slice().sort());
    }));
  const expected = [...LEGACY_LANGUAGES, "markup-templating",
    ...fixture.cases.flatMap(entry => [entry.language, ...entry.aliases])].sort();
  check("syntax runtime inventory adds exactly the requested official components and aliases",
    JSON.stringify(inventory(current)) === JSON.stringify(expected), inventory(current));
  check("syntax incomplete and long Rust blocks preserve all source without injecting markup",
    fixture.rustEdges.every(({ source }) => {
      const value = highlighted(current, "rust", source);
      return !value.error && value.text === source && !/<(?!\/?span\b)[^>]+>/.test(value.html);
    }));
  const markdown = highlighted(current, "markdown", fixture.cases.find(entry => entry.language === "markdown").source);
  // Prism's Markdown wrap hook decorates embedded code in browser highlightElement,
  // while direct highlight also has to retain YAML's nested front-matter tokens.
  check("syntax Markdown front matter really uses the preloaded YAML grammar",
    !markdown.error && markdown.tokens.some(token => token.type === "key" && token.text === "title") &&
      markdown.tokens.some(token => token.type === "boolean" && token.text === "true"), markdown);
  bundleChecks(bundle, prefix);
}
function bundleChecks(bundle, prefix) {
  let helper;
  try { helper = require("../scripts/vendor-prism"); }
  catch (error) { check("syntax bundle helper is available to the normal vendor flow", false, String(error.message)); return; }
  check("syntax bundle helper exports the unique official-component boundary",
    helper.BEGIN === BEGIN && helper.END === END && helper.VERSION === "1.30.0" &&
      helper.LEGACY_SHA256 === LEGACY_SHA256 && typeof helper.createBundle === "function" &&
      JSON.stringify(helper.COMPONENTS) === JSON.stringify(fixture.componentOrder));
  let rebuilt, second;
  try {
    rebuilt = helper.createBundle(ROOT, prefix);
    second = helper.createBundle(ROOT, rebuilt);
  } catch (error) {
    check("syntax official bundle is reproducible and idempotent", false, String(error.message));
    return;
  }
  check("syntax official bundle is reproducible and idempotent",
    typeof rebuilt === "string" && typeof second === "string" && rebuilt === bundle && second === bundle);
  const lf = normalize(prefix), crlf = lf.replace(/\n/g, "\r\n");
  check("syntax bundle preserves both LF and CRLF legacy bytes when appending",
    helper.createBundle(ROOT, lf).startsWith(lf + BEGIN) &&
      helper.createBundle(ROOT, crlf).startsWith(crlf + BEGIN));
  const text = normalize(bundle), suffix = text.slice(text.indexOf(BEGIN));
  const positions = fixture.componentOrder.map(language =>
    suffix.indexOf(normalize(fs.readFileSync(path.join(ROOT, "node_modules", "prismjs", "components",
      "prism-" + language + ".min.js"), "utf8")).trimEnd()));
  check("syntax suffix contains the exact official components once in dependency order",
    text.split(BEGIN).length === 2 && text.split(END).length === 2 &&
      text.trimEnd().endsWith(END) && positions.every((position, i) => position >= 0 &&
        (i === 0 || position > positions[i - 1])) &&
      fixture.componentOrder.every(language => {
        const component = normalize(fs.readFileSync(path.join(ROOT, "node_modules", "prismjs", "components",
          "prism-" + language + ".min.js"), "utf8")).trimEnd();
        return suffix.split(component).length === 2;
      }), positions);
  const rejects = input => {
    try { helper.createBundle(ROOT, input); return false; } catch { return true; }
  };
  const invalid = [null, 42, prefix + "\n" + BEGIN, prefix + "\n" + END,
    bundle + "\n" + BEGIN + "\n" + END, bundle + "\nconsole.log('trailing source');"];
  check("syntax bundle rejects malformed incomplete duplicate and nonterminal boundaries",
    invalid.every(rejects));
  check("syntax bundle rejects altered and markerless already-expanded legacy input",
    ["", prefix + "\n// altered legacy source", bundle.replace(BEGIN, "").replace(END, "")].every(rejects));
  const root = path.join(runtime, "bundle-inputs");
  fs.rmSync(root, { recursive: true, force: true });
  try {
    const installed = path.join(root, "node_modules", "prismjs");
    fs.mkdirSync(installed, { recursive: true });
    fs.cpSync(path.join(ROOT, "node_modules", "prismjs", "components"),
      path.join(installed, "components"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "node_modules", "prismjs", "components.json"), path.join(installed, "components.json"));
    const lockFile = path.join(root, "package-lock.json"), installedFile = path.join(installed, "package.json");
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(root, "package.json"));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
    const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "prismjs", "package.json"), "utf8"));
    const write = () => {
      fs.writeFileSync(lockFile, JSON.stringify(lock));
      fs.writeFileSync(installedFile, JSON.stringify(metadata));
    };
    const invalidRootRejected = () => {
      try { helper.createBundle(root, prefix); return false; } catch { return true; }
    };
    write();
    const good = helper.createBundle(root, prefix);
    check("syntax bundle invalid-input fixture first reproduces the exact real bundle",
      good === bundle);
    metadata.version = "1.29.0"; write();
    const installedMismatch = invalidRootRejected();
    metadata.version = "1.30.0"; lock.packages["node_modules/prismjs"].version = "1.29.0"; write();
    const lockMismatch = invalidRootRejected();
    metadata.version = "1.29.0"; write();
    const coordinatedDowngrade = invalidRootRejected();
    check("syntax bundle rejects installed lock mismatch and coordinated Prism downgrade",
      installedMismatch && lockMismatch && coordinatedDowngrade,
      { installedMismatch, lockMismatch, coordinatedDowngrade });
    metadata.version = lock.packages["node_modules/prismjs"].version = "1.30.0"; write();
    const componentMetadata = path.join(installed, "components.json");
    const definitions = JSON.parse(fs.readFileSync(componentMetadata, "utf8"));
    const required = definitions.languages.php.require;
    definitions.languages.php.require = "unloaded-syntax-dependency";
    fs.writeFileSync(componentMetadata, JSON.stringify(definitions));
    check("syntax bundle refuses a component whose official dependency is not loaded first",
      invalidRootRejected());
    definitions.languages.php.require = required;
    fs.writeFileSync(componentMetadata, JSON.stringify(definitions));
    const component = path.join(installed, "components", "prism-yaml.min.js");
    fs.unlinkSync(component);
    check("syntax bundle refuses a missing required official component", invalidRootRejected());
    fs.writeFileSync(component, " \n");
    check("syntax bundle refuses an empty required official component", invalidRootRejected());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function browserChecks() {
  const { app, BrowserWindow, dialog, shell, session } = require("electron");
  const { startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");
  fs.mkdirSync(evidence, { recursive: true });
  const documentPath = path.join(runtime, "official-languages.md");
  const pdfPath = path.join(runtime, "official-languages.pdf");
  fs.writeFileSync(documentPath, fixture.markdown);
  fs.rmSync(pdfPath, { force: true });
  let win, sentinel, printing = null, openCalls = 0, saveCalls = 0;
  const external = [], network = [], exportOpens = [];
  let offlineProbe = false;
  dialog.showOpenDialog = async () => { openCalls++; return { canceled: false, filePaths: [documentPath] }; };
  dialog.showSaveDialog = async () => { saveCalls++; return { canceled: false, filePath: pdfPath }; };
  shell.openExternal = async url => { external.push(url); throw new Error("No external browser in syntax tests"); };
  shell.openPath = async file => {
    (file === pdfPath ? exportOpens : external).push(file);
    return "";
  };
  shell.showItemInFolder = file => external.push(file);
  // Linux's production PDF path first tries WSL interop. Keep that device
  // boundary local too; the real export handler and renderer handshake run.
  const childProcess = require("child_process"), execFile = childProcess.execFile;
  childProcess.execFile = (...args) => {
    const command = args[0], callback = args.at(-1);
    if (command === "wslpath" || command === "explorer.exe") {
      setImmediate(() => callback(new Error("Syntax test disables external export devices")));
      return;
    }
    return execFile(...args);
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const exec = code => win.webContents.executeJavaScript(code, true);
  async function wait(label, expression) {
    for (let i = 0; i < 350; i++) {
      if (await exec(expression)) return;
      await sleep(30);
    }
    throw new Error("Timed out waiting for " + label);
  }
  async function settle() {
    await sleep(200);
    await exec("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
  }
  async function capture(name) {
    await settle();
    const target = path.join(evidence, name + ".png");
    fs.writeFileSync(target, (await win.webContents.capturePage()).toPNG());
    receipt.screenshots.push({ file: target, viewed: false });
  }
  const watchdog = setTimeout(() => { console.error("Syntax watchdog expired"); app.exit(2); }, 120000);
  require("../src/main.js");
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      if (details.url === "https://syntax-offline.invalid/probe" && offlineProbe) offlineProbe = "observed";
      else network.push(details.url);
      callback({ cancel: true });
    });
  try {
    for (let i = 0; i < 300; i++) {
      win = BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
      if (win && !win.webContents.isLoading()) break;
      await sleep(30);
    }
    if (!win) throw new Error("Production Main did not create a reader");
    win.webContents.setBackgroundThrottling(false);
    win.setSize(1440, 920);
    await wait("production renderer", "typeof window.CustomTabs?.getTabs==='function'&&typeof window.foliaThemes?.setScheme==='function'");
    sentinel = startErrorSentinel(win, { label: "official-language-highlighting", trapExternal: false });
    const preferences = win.webContents.getLastWebPreferences();
    check("syntax UI uses production preload with sandbox isolation and no page Node",
      preferences.nodeIntegration === false && preferences.contextIsolation === true && preferences.sandbox === true &&
        !process.argv.includes("--folia-test-preload") &&
        await exec("typeof require==='undefined'&&typeof process==='undefined'&&Object.isFrozen(window.folia)&&typeof window.folia?.exportPdf==='function'"),
      preferences);
    await exec("document.getElementById('openFile').click();true");
    await wait("native admitted fixture and completed highlight", `currentFilePath===${JSON.stringify(documentPath)}&&
      viewer.querySelector('h1')?.textContent===${JSON.stringify(fixture.heading)}&&
      viewer.querySelectorAll('pre code.prism-highlighted').length===${fixture.blocks.length}&&
      viewer.querySelectorAll('.code-copy-btn').length===${fixture.blocks.length}&&!loadingScreen.classList.contains('active')`);
    check("syntax fixture really opens through Main and paints every expected fence",
      openCalls === 1 && await exec(`viewer.querySelectorAll('pre code').length===${fixture.blocks.length}`));
    await exec(`window.__syntaxIdle={original:window.requestIdleCallback,pending:[],calls:0,
      highlight:Prism.highlightElement};
      window.requestIdleCallback=function(callback,options){
        if(String(callback).includes('highlightNewElements')){
          window.__syntaxIdle.pending.push(callback);return -window.__syntaxIdle.pending.length;
        }
        return window.__syntaxIdle.original.call(this,callback,options);
      };
      Prism.highlightElement=function(...args){window.__syntaxIdle.calls++;
        return window.__syntaxIdle.highlight.apply(this,args);};
      true`);
    try {
      await exec(`(async()=>{
        await renderMarkdown('# Pending old language render\\n\\n~~~rust\\nfn stale() {}\\n~~~','full');
        await renderMarkdown('# Pending current language render\\n\\n~~~rust\\nfn current() {}\\n~~~','full');
      })()`);
      check("syntax stale idle setup holds two real unhighlighted generation callbacks",
        await exec(`window.__syntaxIdle.pending.length===2&&window.__syntaxIdle.calls===0&&
          viewer.querySelector('code.language-rust').textContent==='fn current() {}\\n'&&
          !viewer.querySelector('code.language-rust .token')&&loadingScreen.classList.contains('active')`));
      await exec("window.__syntaxIdle.pending[0]({didTimeout:true,timeRemaining:()=>0});true");
      check("syntax stale idle callback cannot highlight a newer generation or hide its overlay",
        await exec(`window.__syntaxIdle.calls===0&&!viewer.querySelector('code.language-rust .token')&&
          loadingScreen.classList.contains('active')`));
      await exec("window.__syntaxIdle.pending[1]({didTimeout:true,timeRemaining:()=>0});true");
      check("syntax current idle callback really highlights the new Rust document",
        await exec(`window.__syntaxIdle.calls===1&&viewer.querySelector('code.language-rust .token.keyword')?.textContent==='fn'&&
          !loadingScreen.classList.contains('active')`));
    } finally {
      await exec(`window.requestIdleCallback=window.__syntaxIdle.original;Prism.highlightElement=window.__syntaxIdle.highlight;
        delete window.__syntaxIdle;renderMarkdown(originalMarkdown,'full')`);
      await wait("restored native fixture", `viewer.querySelector('h1')?.textContent===${JSON.stringify(fixture.heading)}&&
        viewer.querySelectorAll('pre code.prism-highlighted').length===${fixture.blocks.length}&&!loadingScreen.classList.contains('active')`);
    }
    const blocks = await exec(`Array.from(viewer.querySelectorAll('pre code'),node=>({
      language:Prism.util.getLanguage(node),text:node.textContent,
      tokens:Array.from(node.querySelectorAll('.token'),token=>({classes:[...token.classList],text:token.textContent})),
      safe:[...node.querySelectorAll('*')].every(child=>child.tagName==='SPAN')
    }))`);
    fixture.blocks.forEach((entry, i) => {
      const value = blocks[i], source = entry.source.replace(/\n?$/, "\n");
      const tokenized = fixture.cases.some(item => item.language === entry.canonical);
      check(`syntax UI ${entry.label || entry.language || "unlabelled"} fence preserves semantic text and escaping`,
        value && value.language === (entry.language || "none") && value.text === source && value.safe &&
          (tokenized ? entry.probes.every(([type, text]) => value.tokens.some(token =>
            token.classes.includes(type) && token.text === text)) : value.tokens.length === 0), value);
    });
    check("syntax inline code stays plain and no source tag becomes a live element",
      await exec(`viewer.querySelector('p code')?.textContent===${JSON.stringify(fixture.inline)}&&
        !viewer.querySelector('p code .token')&&!viewer.querySelector('pre script,pre b,pre article')&&
        window.syntaxInjected===undefined`));
    check("syntax Markdown-labelled fence highlights nested Rust and YAML front matter",
      await exec(`(() => {
        const code=viewer.querySelector('code.language-markdown');
        return !!code.querySelector('.front-matter .token.key')&&
          [...code.querySelectorAll('.token.keyword')].some(token=>token.textContent==='fn')&&
          [...code.querySelectorAll('.token.macro')].some(token=>token.textContent==='println!');
      })()`));
    await exec(`window.__syntaxClipboard={copies:[],descriptor:Object.getOwnPropertyDescriptor(navigator.clipboard,'writeText')};
      Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>window.__syntaxClipboard.copies.push(text)});true`);
    try {
      check("syntax copy probe begins with no clipboard boundary calls",
        await exec("window.__syntaxClipboard.copies.length===0"));
      await exec("viewer.querySelector('.code-copy-btn').click();true");
      await wait("clipboard boundary completion", "viewer.querySelector('.code-copy-btn').classList.contains('copied')");
      check("syntax copy button passes exact highlighted Rust source to the clipboard boundary",
        await exec(`window.__syntaxClipboard.copies.length===1&&window.__syntaxClipboard.copies[0]===${JSON.stringify(blocks[0].text)}`));
    } finally {
      await exec(`if(window.__syntaxClipboard.descriptor)Object.defineProperty(navigator.clipboard,'writeText',window.__syntaxClipboard.descriptor);
        else delete navigator.clipboard.writeText;delete window.__syntaxClipboard;true`);
    }
    await exec(`toggleSearchPanel();
      searchInput.value='println';searchInput.dispatchEvent(new Event('input',{bubbles:true}));true`);
    await wait("search through token spans", "viewer.querySelectorAll('code.language-rust .search-highlight').length>0");
    check("syntax search finds real text inside new grammar tokens without changing source",
      await exec(`viewer.querySelector('code.language-rust').textContent===${JSON.stringify(blocks[0].text)}&&
        [...viewer.querySelectorAll('code.language-rust .search-highlight')].some(node=>node.textContent==='println')`));
    await exec("searchInput.value='';searchInput.dispatchEvent(new Event('input',{bubbles:true}));true");
    await wait("search decorations removed", "viewer.querySelectorAll('.search-highlight').length===0");
    await exec("if(searchPanel.classList.contains('visible'))toggleSearchPanel();true");
    const themeResults = [];
    for (const scheme of ["default-light", "clarity", "parchment", "default-dark", "abyss", "ember"]) {
      await exec(`window.foliaThemes.setScheme(${JSON.stringify(scheme)});true`);
      await settle();
      themeResults.push(await exec(`(() => {
        const codes=[...viewer.querySelectorAll('pre code')],tokens=codes.flatMap(code=>[...code.querySelectorAll('.token')]);
        const inks=new Set(tokens.map(token=>getComputedStyle(token).color));
        return {scheme:${JSON.stringify(scheme)},actual:window.foliaThemes.schemeFor(window.foliaThemes.storedMode()).id,
          dark:document.body.classList.contains('dark-mode'),inks:inks.size,
          exact:codes.every((code,i)=>code.textContent===${JSON.stringify(blocks.map(value => value.text))}[i]),
          visible:tokens.every(token=>getComputedStyle(token).visibility==='visible'&&getComputedStyle(token).color!=='rgba(0, 0, 0, 0)')};
      })()`));
      if (scheme === "default-light" || scheme === "default-dark") await capture("syntax-" + scheme);
    }
    check("syntax all existing light dark and named schemes keep exact readable token text",
      themeResults.length === 6 && themeResults.every(value => value.actual === value.scheme && value.exact &&
        value.visible && value.inks >= 2 && value.dark === ["default-dark", "abyss", "ember"].includes(value.scheme)), themeResults);
    receipt.themes = themeResults;
    // Exercise the real export IPC and its theme handshake. Stub only the PDF
    // device, so tests cannot launch a viewer or depend on a printer driver.
    const realPrint = win.webContents.printToPDF;
    const realPdf = Buffer.from("%PDF-1.4\n% Markaloo syntax export test device\n%%EOF\n");
    win.webContents.printToPDF = async options => {
      printing = await exec(`({light:!document.body.classList.contains('dark-mode'),
        scheme:document.body.getAttribute('data-theme'),
        texts:[...viewer.querySelectorAll('pre code')].map(code=>code.textContent),
        tokens:viewer.querySelectorAll('pre code .token').length})`);
      printing.options = options;
      return realPdf;
    };
    try {
      await exec("document.getElementById('exportPdf').click();true");
      for (let i = 0; i < 250 && !fs.existsSync(pdfPath); i++) await sleep(30);
      await wait("export preference restored", "document.body.classList.contains('dark-mode')&&document.body.getAttribute('data-theme')==='ember'");
      check("syntax native PDF export reaches highlighted content and restores the reader scheme",
        saveCalls === 1 && exportOpens.length === 1 && fs.existsSync(pdfPath) && fs.readFileSync(pdfPath).equals(realPdf) &&
          printing?.light && printing.scheme === null && printing.tokens > 0 &&
          JSON.stringify(printing.texts) === JSON.stringify(blocks.map(value => value.text)), printing);
    } finally { win.webContents.printToPDF = realPrint; }
    await exec("window.foliaThemes.setScheme('default-light');document.getElementById('openEditorBtn').click();true");
    await wait("source editor with published correspondence", "isEditMode&&getEditorScrollDiagnostics().ready&&!getEditorScrollDiagnostics().pendingGeometry");
    check("syntax source editor remains a plain textarea containing the literal fences",
      await exec(`markdownEditor.tagName==='TEXTAREA'&&markdownEditor.value===${JSON.stringify(fixture.markdown)}&&
        markdownEditor.querySelectorAll('.token').length===0`));
    await exec(`window.__syntaxIdentity={
      blocks:[...viewer.querySelectorAll('pre code')],spans:[...viewer.querySelectorAll('pre code .token')],
      highlights:0,original:Prism.highlightElement};
      Prism.highlightElement=function(...args){window.__syntaxIdentity.highlights++;return window.__syntaxIdentity.original.apply(this,args);};
      markdownEditor.focus();markdownEditor.setSelectionRange(markdownEditor.value.indexOf('Unrelated editable witness.'),
        markdownEditor.value.indexOf('Unrelated editable witness.')+'Unrelated editable witness.'.length);true`);
    await win.webContents.insertText("Native unrelated edit witness.");
    await wait("native edit really painted", "hasUnsavedChanges&&viewer.textContent.includes('Native unrelated edit witness.')&&!loadingScreen.classList.contains('active')");
    await settle();
    check("syntax native unrelated edit preserves every code block token span and highlight count",
      await exec(`(() => {
        const before=window.__syntaxIdentity,codes=[...viewer.querySelectorAll('pre code')],spans=[...viewer.querySelectorAll('pre code .token')];
        return before.blocks.length===codes.length&&before.spans.length===spans.length&&spans.length>0&&
          before.blocks.every((node,i)=>node===codes[i])&&before.spans.every((node,i)=>node===spans[i])&&
          before.highlights===0&&codes.every((node,i)=>node.textContent===${JSON.stringify(blocks.map(value => value.text))}[i]);
      })()`));
    await exec("Prism.highlightElement=window.__syntaxIdentity.original;delete window.__syntaxIdentity;true");
    await wait("edited correspondence settled", "getEditorScrollDiagnostics().ready&&!getEditorScrollDiagnostics().pendingGeometry");
    await installScrollOracle(exec);
    for (const language of ["rust", "php", "markdown"]) {
      const text = fixture.cases.find(entry => entry.language === language).source.split("\n")
        .find(line => line.includes(language === "rust" ? "println!" : language === "php" ? "$message" : "Nested markdown"));
      for (const side of ["editor", "preview"]) {
        await exec("markdownEditor.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true}));markdownEditor.scrollTop=0;true");
        await settle();
        const before = await exec(`window.__syntaxScroll.state(${JSON.stringify(language)},${JSON.stringify(text)})`);
        const state = await exec(`window.__syntaxScroll.move(${JSON.stringify(side)},${JSON.stringify(language)},${JSON.stringify(text)})`);
        await settle();
        const after = await exec(`window.__syntaxScroll.state(${JSON.stringify(language)},${JSON.stringify(text)})`);
        receipt.correspondence.push({ side, language, before: state, after });
        check(`syntax ${side} scroll retains ${language} source to token DOM correspondence`,
          state.editorMax > 100 && state.previewMax > 100 && after.editor > before.editor + 30 &&
            after.rendered > before.rendered + 30 && after.source >= -2 && after.source < 90 &&
            after.preview >= -2 && after.preview < 90 && after.error < 36, { state, after });
      }
    }
    await capture("syntax-source-preview-light");
    const sentinelAlive = await proveSentinelAlive(win, sentinel);
    check("syntax error sentinel proves both console and visible DOM channels are alive",
      sentinelAlive.console && sentinelAlive.dom, sentinelAlive);
    offlineProbe = true;
    // Renderer CSP stops fetch before webRequest sees it. A main-session probe
    // reaches this sentinel without relaxing the production connect-src policy.
    await session.defaultSession.fetch("https://syntax-offline.invalid/probe").catch(() => null);
    check("syntax offline request sentinel observes and cancels its deliberate request",
      offlineProbe === "observed");
    check("syntax rendering makes no network requests or external browser opens",
      network.length === 0 && external.length === 0, { network, external });
    const errors = await sentinel.stop();
    sentinel = null;
    check("syntax scenarios introduce no renderer visible document or sentinel stall errors",
      errors.hits.length === 0 && errors.stalls.length === 0, errors);
  } catch (error) {
    check("syntax browser harness reaches completion", false, String(error.stack || error));
  } finally {
    clearTimeout(watchdog);
    childProcess.execFile = execFile;
    if (sentinel) await sentinel.stop();
    session.defaultSession.webRequest.onBeforeRequest(null);
    fs.writeFileSync(path.join(evidence, "language-highlighting-receipt.json"), JSON.stringify(receipt, null, 2));
    if (win && !win.isDestroyed()) {
      const keepalive = new BrowserWindow({ show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
      await new Promise(resolve => { win.webContents.once("destroyed", resolve); win.destroy(); });
      await new Promise(resolve => setImmediate(resolve));
      void keepalive;
    }
    console.log(`=== ${results.filter(value => value.ok).length}/${results.length} passed ===`);
    app.exit(results.every(value => value.ok) ? 0 : 1);
  }
}
async function installScrollOracle(exec) {
  await exec(`window.__syntaxScroll={
    sourceTop(text){
      const e=markdownEditor,c=getComputedStyle(e),mirror=document.createElement('div');
      for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing',
        'paddingTop','paddingBottom','paddingLeft','paddingRight','whiteSpace','overflowWrap','wordBreak','tabSize'])
        mirror.style[key]=c[key];
      Object.assign(mirror.style,{position:'fixed',left:'-10000px',top:'0',visibility:'hidden',
        width:e.clientWidth+'px',boxSizing:'border-box',border:'0',height:'auto'});
      const index=e.value.indexOf(text);if(index<0)throw new Error('Missing source landmark');
      const span=document.createElement('span');span.textContent=text;
      mirror.append(document.createTextNode(e.value.slice(0,index)),span,document.createTextNode(e.value.slice(index+text.length)));
      document.body.append(mirror);const top=span.getClientRects()[0].top-mirror.getBoundingClientRect().top;mirror.remove();return top;
    },
    previewTop(language,text){
      const code=viewer.querySelector('code.language-'+language),index=code.textContent.indexOf(text);
      if(index<0)throw new Error('Missing highlighted landmark');
      const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);let at=0,node;
      while((node=walker.nextNode())){
        if(at+node.length>index){const range=document.createRange();range.setStart(node,index-at);range.setEnd(node,index-at+1);
          return (range.getBoundingClientRect().top-viewer.getBoundingClientRect().top)/scrollerScale(viewer)+viewer.scrollTop;}
        at+=node.length;
      }
      throw new Error('No text node for highlighted landmark');
    },
    state(language,text){
      const source=this.sourceTop(text)-markdownEditor.scrollTop,preview=this.previewTop(language,text)-viewer.scrollTop;
      return {source,preview,error:Math.abs(source-preview),editor:markdownEditor.scrollTop,rendered:viewer.scrollTop,
        editorMax:markdownEditor.scrollHeight-markdownEditor.clientHeight,previewMax:viewer.scrollHeight-viewer.clientHeight};
    },
    move(side,language,text){
      const node=side==='editor'?markdownEditor:viewer;
      node.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
      node.scrollTop=side==='editor'?this.sourceTop(text):this.previewTop(language,text);
      return this.state(language,text);
    }
  };true`);
}
try { sourceChecks(); }
catch (error) { check("syntax source harness reaches completion", false, String(error.stack || error)); }
if (sourceOnly) {
  console.log(`=== ${results.filter(value => value.ok).length}/${results.length} passed ===`);
  process.exitCode = results.every(value => value.ok) ? 0 : 1;
} else {
  browserChecks().catch(error => {
    console.error("Syntax harness could not finalize: " + String(error.stack || error));
    require("electron").app.exit(2);
  });
}
