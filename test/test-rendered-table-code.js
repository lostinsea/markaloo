"use strict";
const fs = require("fs");
const path = require("path");
const runtime = path.join(__dirname, ".rendered-table-code-runtime");
function fatal(error) {
  let message = (error?.stack || String(error)) + "\n";
  if (process.versions.electron) {
    const { app } = require("electron");
    const pids = app.isReady() ? app.getAppMetrics().map(metric => metric.pid) : [process.pid];
    message += "OWNED_ELECTRON_PIDS=" + JSON.stringify(pids) + "\n";
  }
  try {
    fs.appendFileSync(path.join(runtime, "fatal-" + process.pid + ".log"), message);
  } catch (writeError) {
    message += "Could not record fixture failure: " + writeError.message + "\n";
  }
  try { fs.writeSync(2, message); } finally {
    if (process.versions.electron) require("electron").app.exit(1);
    else process.exit(1);
  }
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
process.stdout.on("error", fatal);
process.stderr.on("error", fatal);
fs.mkdirSync(runtime, { recursive: true });
if (!process.versions.electron) {
  const child = require("child_process").spawnSync(require("electron"),
    [__filename, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true, timeout: 60000 });
  if (child.pid) console.log("OWNED_ELECTRON_LAUNCH_PID=" + child.pid);
  if (child.error) fatal(child.error);
  if (!Number.isInteger(child.status)) fatal(new Error("Electron child exited without a status: " + child.signal));
  process.exit(child.status);
}
process.env.TMP = process.env.TEMP = process.env.TMPDIR = runtime;
require("./test-userdata-isolation");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, ...file.split("/")), "utf8");
const renderer = read("src/renderer.js");
function slice(from, to) {
  const start = renderer.indexOf(from), end = renderer.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error("Missing renderer test boundary: " + from);
  return renderer.slice(start, end);
}
const functions = slice("function explicitTableCodeLanguage(", "// Smart render dispatcher");
const searchFunctions = slice("// Search functionality", "function toggleSearchPanel()");
const sanitizer = slice("const SANITIZE_CONFIG = {", "// DOMPurify's default URI") +
  slice("function sanitizeHtml(html) {", "// The table dialogs");
const fixture = require("./fixtures/language-highlighting");
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " -> " + JSON.stringify(detail)}`);
}

async function run() {
  const { app, BrowserWindow, session } = require("electron");
  console.log("OWNED_ELECTRON_PID=" + process.pid);
  app.disableHardwareAcceleration();
  await app.whenReady();
  let win;
  const blocked = [], errors = [];
  try {
    const page = path.join(runtime, "fixture.html");
    const pageUrl = require("url").pathToFileURL(page).href;
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>Owned table code fixture</title>' +
      '<textarea id="editor"></textarea><div id="viewer" class="markdown-body"></div>');
    const guest = session.fromPartition("rendered-table-code-fixture");
    guest.webRequest.onBeforeRequest((details, callback) => {
      if (details.url === pageUrl && details.resourceType === "mainFrame") callback({});
      else if (/^(?:https?|file):/i.test(details.url)) {
        blocked.push(details.url);
        callback({ cancel: true });
      } else callback({});
    });
    guest.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win = new BrowserWindow({ width: 1100, height: 800, show: false,
      webPreferences: { partition: "rendered-table-code-fixture",
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        offscreen: true, backgroundThrottling: false } });
    win.webContents.on("console-message", event => {
      if (event.level === "error") errors.push(event.message);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await win.loadFile(page);
    await win.webContents.executeJavaScript("console.error('owned-table-sentinel')");
    check("table code console sentinel is alive", errors.includes("owned-table-sentinel"), errors);
    errors.length = 0;
    await win.webContents.insertCSS(read("src/styles.css").replace(/@font-face\s*\{[^}]*\}/g, "") +
      "\nbody {display:block;padding:24px;} #editor {display:none;} #viewer {overflow:auto;height:700px;}");
    for (const file of ["libs/vendor/marked.min.js", "libs/vendor/purify.min.js",
      "src/utils.js", "src/inline-formatting.js", "src/table-cell-editor.js", "src/editor-scroll.js"]) {
      await win.webContents.executeJavaScript(read(file) + "\n; void 0;");
    }
    await win.webContents.executeJavaScript("window.Prism = {manual:true};\n" +
      read("libs/prismjs/prism-bundle.js") + "\n; void 0;");
    const observed = await win.webContents.executeJavaScript(`(() => {
      const observations = [];
      try {
      if (!window.isSecureContext || typeof crypto.randomUUID !== 'function')
        throw new Error('Owned fixture must provide native secure-context crypto.randomUUID');
      const viewer = document.getElementById('viewer'), editor = document.getElementById('editor');
      const readingGeneratedContainers = new WeakMap(), attributes = new Map();
      const {escapeRegex} = window.MarkalooUtils;
      const searchInput = document.createElement('input'), searchCounter = document.createElement('span');
      const searchPrevBtn = document.createElement('button'), searchNextBtn = document.createElement('button');
      const intent = {}, jumps = [];
      const readingViewport = {isIntentCurrent: value => value === intent};
      const readingHistory = {jump: (...args) => {jumps.push(args); return Promise.resolve();}};
      const reportReadingHistoryError = error => {throw error;};
      const i18n = (key, values) => values ? values.current + '/' + values.total : '0';
      let selection = 1;
      ${sanitizer}
      function noteReadingAttribute(body, name) {
        if (!attributes.has(body)) attributes.set(body, new Map());
        attributes.get(body).set(name, body.getAttribute(name));
      }
      const editorScroll = window.createEditorScroll({
        editor, preview: viewer, active: () => true, frozen: () => false,
        identity: () => selection, scale: () => 1,
        presentation: () => ({owner: 'owned-fixture', revision: 1}),
        readingSourceIdentity: () => 'owned-table-source',
      });
      ${searchFunctions}
      ${functions}
      const test = (name, ok, detail) => observations.push({name, ok: !!ok, detail});
      const encode = value => value.replace(/[^a-zA-Z0-9 ]/gu,
        character => '&#' + character.codePointAt(0) + ';');
      const added = ${JSON.stringify(fixture.cases)};
      const legacy = [
        ['markup', '<b title="ok">text</b>'], ['html', '<b>text</b>'], ['css', 'a { color: red; }'],
        ['clike', 'int number = 42;'], ['javascript', 'const answer = 42;'],
        ['typescript', 'const answer: number = 42;'], ['jsx', 'const el = <b>text</b>;'],
        ['tsx', 'const el: Element = <b>text</b>;'], ['json', '{"ok": true}'],
        ['python', 'def answer(): return True'], ['java', 'public class Test {}'],
        ['c', 'int main() { return 0; }'], ['cpp', 'class Test { public: int answer = 42; };'],
        ['csharp', 'public class Test { string value = "text"; }'],
        ['bash', 'if [ "$name" ]; then echo "text"; fi'], ['sql', 'SELECT name FROM items WHERE id = 42;'],
      ];
      const samples = new Map(legacy);
      for (const entry of added) samples.set(entry.language, entry.source);
      const entries = Object.keys(Prism.languages).filter(language =>
        Prism.languages[language] && typeof Prism.languages[language] === 'object').map(language => {
          let canonical = [...samples.keys()].find(key => Prism.languages[key] === Prism.languages[language]);
          return {language, source: canonical ? samples.get(canonical) : 'plain source <text> & 42',
            tokenized: !!canonical};
        });
      const rows = entries.map(entry =>
        '| ' + entry.language + ' | <code class="language-' + entry.language + '">' + encode(entry.source) + '</code> |');
      rows.push('| plain | \`const answer = 42;\` |',
        '| unknown | <code class="language-not-supported">const answer = 42;</code> |',
        '| inherited | <span class="language-rust"><code>fn plain() {}</code></span> |',
        '| conflict | <code class="language-rust language-json">{"ok":true}</code> |',
        '| alias | <code class="lang-js">const alias = 42; const alias = 42;</code> |',
        '| mixed | const alias = 42; |');
      editor.value = '# Table code\\n\\n| Language | Code |\\n| --- | --- |\\n' + rows.join('\\n') + '\\n';
      const source = editorScroll.source(editor.value);
      source.prepare(text => text);
      const fresh = document.createElement('div');
      fresh.innerHTML = sanitizeHtml(source.parse(marked));
      const bindings = source.detach(fresh, sanitizeHtml);
      const bodies = [...fresh.children];
      viewer.replaceChildren(...bodies);
      for (const body of bodies) source.adopt(body, body, bindings);
      const table = viewer.querySelector('table');
      readingGeneratedContainers.set(table, {wrapper: null, controls: [], decorations: [], code: null});
      searchInput.value = 'const alias = 42;';
      highlightSearchTerm(searchInput.value, {navigate: false});
      editorScroll.commit(source, {textPending: true});
      test('table code fixture has real source-bound table and unprocessed candidates',
        !!editorScroll.tableSource(table) && pendingTableCodeElements().length === entries.length + 1,
        {candidates: pendingTableCodeElements().length, entries: entries.length});
      const authoredCodes = [...table.querySelectorAll('tbody tr')].slice(0, entries.length).map(row => row.querySelector('code'));
      test('table code fixture literals survive Markdown parsing',
        authoredCodes.every((code, index) => code.textContent === entries[index].source),
        entries.filter((entry, index) => authoredCodes[index].textContent !== entry.source).map(entry => entry.language));
      const originalSource = editor.value, originalText = table.textContent;
      highlightNewElements(source);
      test('table code deferred Prism restores existing search without navigation',
        searchMatches.length === 3 && jumps.length === 0 &&
        viewer.querySelectorAll('.search-highlight').length > 2);
      clearSearchHighlights();
      const codes = [...table.querySelectorAll('tbody tr')].slice(0, entries.length).map(row => row.querySelector('code'));
      test('table code every loaded grammar and alias preserves exact source text',
        codes.every((code, index) => code.textContent === entries[index].source),
        entries.filter((entry, index) => codes[index].textContent !== entry.source).map(entry => entry.language));
      test('table code supported language witnesses produce Prism tokens',
        codes.every((code, index) => !entries[index].tokenized || code.querySelector('.token')),
        entries.filter((entry, index) => entry.tokenized && !codes[index].querySelector('.token')).map(e => e.language));
      const controls = [...table.querySelectorAll('tbody tr')].slice(entries.length).map(row => row.querySelector('code'));
      test('table code never guesses plain unknown inherited or conflicting language',
        controls.slice(0, 4).every(code => !code.classList.contains('prism-highlighted') && !code.querySelector('.token')));
      test('table code explicit lang alias is supported', !!controls[4].querySelector('.token'));
      const colored = codes[entries.findIndex(entry => entry.language === 'json')];
      const colorToken = colored.querySelector('.token');
      test('table code uses token colors and keeps cell wrapping',
        colorToken && getComputedStyle(colorToken).color !== getComputedStyle(colored).color &&
        getComputedStyle(colored).whiteSpace === 'normal');
      test('table code highlighting leaves Markdown and copy text unchanged',
        editor.value === originalSource && table.textContent === originalText);
      test('table code exact edit correspondence survives deferred highlighting', !!editorScroll.tableSource(table));
      const spans = [...table.querySelectorAll('.token')];
      highlightNewElements(source);
      test('table code repeat highlight keeps existing token nodes',
        spans.length > 0 && spans.every(span => span.isConnected) && pendingTableCodeElements().length === 0);
      const associations = bodies.filter(body => source.readingTextSpecs.has(body)).map(body => ({
        fresh: body, body, owners: [...body.querySelectorAll('table')].concat(body.tagName === 'TABLE' ? [body] : [])
          .filter(target => bindings.get(target)?.readingTable).map(target => ({fresh: target, body: target,
            ...readingGeneratedContainers.get(target), header: target.tHead, breakout: null})),
        attributes: [...attributes].filter(([body]) => body.isConnected).flatMap(([body, names]) =>
          [...names].map(([name, value]) => ({body, name, value}))),
      }));
      // Attributes belong to their exact block, not to another block in the same fixture.
      for (const association of associations)
        association.attributes = association.attributes.filter(entry => association.body.contains(entry.body));
      const bound = editorScroll.bindReadingPresentation(source, {owner:'owned-fixture', revision:1}, associations);
      test('table code Reader binding accepts only registered decoration text', bound.status === 'bound',
        {status: bound.status, reason: bound.reason});
      const visualTable = table.cloneNode(true);
      for (const row of visualTable.querySelectorAll('tbody tr')) {
        if (!['javascript', 'json', 'rust', 'powershell', 'plain'].includes(row.cells[0].textContent))
          row.remove();
      }
      searchInput.value = 'const alias = 42;';
      highlightSearchTerm(searchInput.value, {intent});
      const firstMatch = searchMatches[0], secondMatch = searchMatches[1];
      test('table code search counts logical matches across Prism tokens',
        searchMatches.length === 3 && viewer.querySelectorAll('.search-highlight').length > 3 &&
        searchCounter.textContent === '1/3');
      test('table code search includes ordinary cell matches in document order',
        searchMatches.length === 3 && !searchMatches[2].closest('code') &&
        searchMatches[2].textContent === searchInput.value);
      const firstParts = tableCodeSearchParts.get(firstMatch) || [];
      test('table code search marks all parts of one current match',
        firstParts.length > 1 && firstParts.every(part => part.classList.contains('current')) &&
        jumps.length === 1 && jumps[0][0] === firstMatch);
      nextMatch(intent);
      const secondParts = tableCodeSearchParts.get(secondMatch) || [];
      test('table code next search navigates once and clears previous fragments',
        currentMatchIndex === 1 && firstParts.every(part => !part.classList.contains('current')) &&
        secondParts.every(part => part.classList.contains('current')) &&
        jumps.length === 2 && jumps[1][0] === secondMatch);
      previousMatch(intent);
      test('table code previous search restores first logical match',
        currentMatchIndex === 0 && jumps.length === 3 && jumps[2][0] === firstMatch);
      test('table code active search preserves edit and Reader correspondence',
        !!editorScroll.tableSource(table) &&
        editorScroll.bindReadingPresentation(source, {owner:'owned-fixture', revision:1}, associations).status === 'bound');
      clearSearchHighlights();
      test('table code search clear restores text tokens and exact source receipt',
        searchMatches.length === 0 && !table.querySelector('.search-highlight') &&
        table.textContent === originalText && spans.every(span => span.isConnected) &&
        !!editorScroll.tableSource(table));
      const produced = readingGeneratedContainers.get(table), removed = produced.decorations.pop();
      test('table code Reader rejects an unregistered Prism span',
        editorScroll.bindReadingPresentation(source, {owner:'owned-fixture', revision:1}, associations).status !== 'bound');
      produced.decorations.push(removed);
      const before = table.innerHTML;
      table.querySelector('td').textContent = 'unexpected document mutation';
      test('table code edited DOM loses source authority', editorScroll.tableSource(table) === null);
      test('table code cannot reseal from stale pre-highlight markup',
        editorScroll.sealTableDecoration(source, table, 'not the sealed markup') === false);
      table.innerHTML = before;
      selection++;
      test('table code replaced selection cannot reseal an old source',
        editorScroll.sealTableDecoration(source, table, before) === false);
      editor.value = '| Example |\\n| --- |\\n| <code class="language-rust">let light = 42;</code> |\\n';
      const lightSource = editorScroll.source(editor.value), lightFresh = document.createElement('div');
      lightSource.prepare(text => text);
      lightFresh.innerHTML = sanitizeHtml(lightSource.parse(marked));
      const lightBindings = lightSource.detach(lightFresh, sanitizeHtml);
      const lightTable = lightFresh.querySelector('table');
      viewer.replaceChildren(...lightFresh.childNodes);
      lightSource.adopt(lightTable, lightTable, lightBindings);
      readingGeneratedContainers.set(lightTable, {wrapper:null, controls:[], decorations:[], code:null});
      highlightNewElements(lightSource);
      editorScroll.commit(lightSource);
      test('table code light-format ordering seals post-Prism source authority',
        !!lightTable.querySelector('.token') && !!editorScroll.tableSource(lightTable));
      editor.value = '| Example |\\n| --- |\\n| <code class="language-rust">let deferred = 42;</code> |\\n';
      const lateSource = editorScroll.source(editor.value), lateFresh = document.createElement('div');
      lateSource.prepare(text => text);
      lateFresh.innerHTML = sanitizeHtml(lateSource.parse(marked));
      const lateBindings = lateSource.detach(lateFresh, sanitizeHtml);
      const lateTable = lateFresh.querySelector('table');
      viewer.replaceChildren(...lateFresh.childNodes);
      lateSource.adopt(lateTable, lateTable, lateBindings);
      readingGeneratedContainers.set(lateTable, {wrapper:null, controls:[], decorations:[], code:null});
      editorScroll.commit(lateSource);
      searchInput.value = 'deferred = 42';
      highlightSearchTerm(searchInput.value, {navigate: false});
      test('table code late-search setup exists after source commit',
        searchMatches.length === 1 && !!editorScroll.tableSource(lateTable));
      highlightNewElements(lateSource);
      clearSearchHighlights();
      test('table code commit then search then deferred Prism retains source authority',
        !!lateTable.querySelector('.token') && !!editorScroll.tableSource(lateTable));
      const block = document.createElement('table');
      block.innerHTML = '<tr><td><pre><code class="language-python">def value():\\n    return 42</code></pre></td></tr>';
      viewer.append(block);
      const blockCode = block.querySelector('code');
      highlightNewElements(lateSource);
      test('table code leaves nested preformatted block whitespace unchanged',
        getComputedStyle(blockCode).whiteSpace === 'pre' && blockCode.textContent === 'def value():\\n    return 42');
      const blockToken = blockCode.querySelector('.token');
      highlightNewElements(lateSource);
      test('table code preserves existing block highlight-once behavior', !!blockToken && blockToken.isConnected);
      editorScroll.leave();
      viewer.replaceChildren(visualTable, block);
      return {ok: true, observations};
      } catch (error) {
        return {ok: false, observations, error: error.stack || String(error)};
      }
    })()`);
    for (const result of observed.observations) check(result.name, result.ok, result.detail);
    if (!observed.ok) throw new Error(observed.error);
    check("table code guest blocks external and file requests", blocked.length === 0, blocked);
    check("table code guest has no unexpected console errors", errors.length === 0, errors);
    if (process.argv.includes("--capture")) {
      const image = await win.webContents.capturePage();
      const file = path.join(runtime, "explicit-table-code.png");
      fs.writeFileSync(file, image.toPNG());
      console.log("OWNED_FIXTURE_IMAGE=" + file);
    }
  } finally {
    for (const error of errors) console.error("RENDERER_ERROR=" + error);
    console.log("OWNED_ELECTRON_PIDS=" + JSON.stringify(app.getAppMetrics().map(metric => metric.pid)));
    if (win && !win.isDestroyed()) win.destroy();
  }
}

const watchdog = setTimeout(() => {
  fatal(new Error("Rendered table code fixture exceeded its 45 second safety limit"));
}, 45000);
run().then(() => {
  clearTimeout(watchdog);
  const failed = results.filter(result => !result.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  require("electron").app.exit(failed ? 1 : 0);
}, error => {
  clearTimeout(watchdog);
  fatal(error);
});
