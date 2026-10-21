"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID, createHash } = require("crypto");
const root = path.resolve(__dirname, "..");
const batch = path.resolve(process.env.MARKALOO_TOC_TOOLBAR_BATCH ||
  path.join(root, "screenshots", "toc-toolbar-" + randomUUID()));
if (!batch.startsWith(path.join(root, "screenshots") + path.sep)) {
  throw new Error("Project-local TOC toolbar batch required");
}
const originalTmpdir = os.tmpdir;
os.tmpdir = () => path.join(batch, "isolation", process.argv[2] || "controller");
require("./test-userdata-isolation");
os.tmpdir = originalTmpdir;
const electron = require("electron");
const proof = process.env.MARKALOO_TOC_TOOLBAR_PROOF;
const routes = ["handler", "state", "owner", "grouping", "welcome"];
if (proof && !routes.includes(proof)) {
  console.error("Unsupported TOC toolbar proof route: " + proof);
  process.exit(2);
}
const evidence = path.resolve(process.env.MARKALOO_TOC_TOOLBAR_EVIDENCE || batch);
if (typeof electron === "string") {
  const { spawnSync } = require("child_process");
  fs.mkdirSync(batch, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const phases = !proof || proof === "owner" ? ["behavior", "savedToc", "savedClosed"] : ["behavior"];
  const completed = [];
  let passed = 0, total = 0;
  console.log("TOC toolbar evidence: " + evidence);
  for (const phase of phases) {
    const run = spawnSync(electron, [__filename, phase], {
      cwd: root, encoding: "utf8", timeout: 180000,
      env: { ...process.env, MARKALOO_TOC_TOOLBAR_BATCH: batch },
    });
    process.stdout.write(run.stdout || "");
    process.stderr.write(run.stderr || "");
    const footers = [...(run.stdout || "").matchAll(/=== toc toolbar (\w+): (\d+)\/(\d+) passed ===/g)];
    const footer = footers[0];
    const assertions = (run.stdout || "").split(/\r?\n/).filter(line => /^(PASS|FAIL) /.test(line));
    const failures = assertions.filter(line => line.startsWith("FAIL ")).length;
    if (run.error || footers.length !== 1 || footer[1] !== phase || Number(footer[3]) < 4 ||
        assertions.length !== Number(footer[3]) || failures !== Number(footer[3]) - Number(footer[2]) ||
        run.status !== (failures ? 1 : 0)) {
      console.error("FAIL TOC toolbar child completion  -> " + (run.error || run.status));
      process.exit(2);
    }
    completed.push(phase);
    passed += Number(footer[2]);
    total += Number(footer[3]);
  }
  if (!total || JSON.stringify(completed) !== JSON.stringify(phases)) process.exit(2);
  console.log(`=== ${passed}/${total} passed ===`);
  process.exit(passed === total ? 0 : 1);
} else {
  const { app, BrowserWindow, dialog, shell, session } = electron;
  const { startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");
  const phase = process.argv[2];
  if (!["behavior", "savedToc", "savedClosed"].includes(phase)) process.exit(2);
  fs.mkdirSync(evidence, { recursive: true });
  const profile = path.join(batch, "profile");
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  const files = ["alpha", "beta"].map(name => path.join(batch, name + ".md"));
  const bodies = ["Alpha", "Beta"].map(name => {
    const paragraphs = ["# " + name];
    for (let i = 0; i < 64; i++) {
      if (i % 12 === 0) paragraphs.push("## " + name + " section " + i);
      paragraphs.push(name + " landmark " + i + ". " +
        "Wrapping changes source and rendered geometry independently. ".repeat(4 + i % 6));
      if (i === 8) paragraphs.push('<img alt="Unequal height witness" width="180" height="900" src="data:image/svg+xml,' +
        encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="900"><rect width="180" height="900" fill="#4f7d92"/></svg>') + '">');
    }
    return paragraphs.join("\n\n");
  });
  if (phase === "behavior") files.forEach((file, index) => fs.writeFileSync(file, bodies[index]));
  let chosen = files[0], win, sentinel;
  const results = [], executed = new Set();
  const selected = name => !proof || proof === name;
  const products = ["main.js", "main-preload.js", "renderer.js", "custom-tabs.js",
    "editor-scroll.js", "index.html", "custom-styles.css"];
  const hashes = () => Object.fromEntries(products.map(file => [file,
    createHash("sha256").update(fs.readFileSync(path.join(root, "src", file))).digest("hex")]));
  const sourceHashes = hashes();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const exec = code => win.webContents.executeJavaScript(code, true);
  function check(name, ok, detail) {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
  }
  async function wait(label, expression) {
    for (let i = 0; i < 300; i++) {
      if (await exec(expression)) return;
      await sleep(30);
    }
    throw new Error("Timed out waiting for " + label);
  }
  async function settle() {
    await sleep(220);
    await exec("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
  }
  async function click(id) {
    await exec(`document.getElementById(${JSON.stringify(id)}).click();true`);
    await settle();
  }
  async function key(keyCode) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    if (keyCode === "Enter") {
      win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    }
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await settle();
  }
  async function open(index) {
    chosen = files[index];
    await click("openFile");
    await wait("painted document " + index, `currentFilePath===${JSON.stringify(chosen)}&&
      viewer.querySelector('h1')?.textContent===${JSON.stringify(index ? "Beta" : "Alpha")}&&
      !loadingScreen.classList.contains('active')`);
    await settle();
    return exec("window.CustomTabs.getActiveTabId()");
  }
  async function select(id, name) {
    await exec(`window.CustomTabs.switchToTab(${id})`);
    await wait("selected " + name, `window.CustomTabs.getActiveTabId()===${id}&&
      viewer.querySelector('h1')?.textContent===${JSON.stringify(name)}&&!loadingScreen.classList.contains('active')`);
    await settle();
  }
  const state = () => exec(`({
    toc:indexPanel.classList.contains('visible'),notes:notesPanel.classList.contains('visible'),
    inertToc:indexPanel.inert,inertNotes:notesPanel.inert,saved:localStorage.getItem('readingSidePanel'),
    pressed:toggleTocBtn.getAttribute('aria-pressed'),expanded:toggleTocBtn.getAttribute('aria-expanded'),
    menu:toggleIndexBtn.getAttribute('aria-expanded'),notesExpanded:toggleNotesBtn.getAttribute('aria-expanded')
  })`);
  const agrees = value => value.pressed === String(value.toc) && value.expanded === String(value.toc) &&
    value.menu === String(value.toc) && value.notesExpanded === String(value.notes) &&
    value.inertToc === !value.toc && value.inertNotes === !value.notes && !(value.toc && value.notes);
  const snapshot = () => exec(`({
    edit:isEditMode,value:markdownEditor.value,start:markdownEditor.selectionStart,
    end:markdownEditor.selectionEnd,direction:markdownEditor.selectionDirection,
    history:JSON.stringify(historySnapshot()),dirty:hasUnsavedChanges
  })`);
  async function capture(name) {
    fs.writeFileSync(path.join(evidence, name + ".png"), (await win.webContents.capturePage()).toPNG());
  }
  async function welcome() {
    await click("toggleTocBtn");
    const opened = await state();
    await click("toggleTocBtn");
    const closed = await state();
    check("Welcome toolbar choice really opens then closes and saves the global drawer",
      opened.toc && !opened.notes && opened.saved === "toc" &&
      !closed.toc && !closed.notes && closed.saved === "closed", { opened, closed });
    executed.add("welcome");
  }
  async function handler(alpha, beta) {
    if (!(await state()).toc) await click("toggleIndex");
    await click("toggleTocBtn");
    const closed = await state();
    await select(alpha, "Alpha");
    const alphaClosed = await state();
    await click("toggleTocBtn");
    const opened = await state();
    await select(beta, "Beta");
    const betaOpen = await state();
    check("toolbar click toggles shared TOC visibility in both directions across existing tabs",
      !closed.toc && !alphaClosed.toc && opened.toc && betaOpen.toc &&
      await exec("indexList.querySelector('.index-item')?.textContent==='Beta'"),
      { closed, alphaClosed, opened, betaOpen });
    executed.add("handler");
  }
  async function commonState() {
    if ((await state()).toc) await click("closeIndex");
    const samples = [await state()];
    await click("toggleIndex");
    samples.push(await state());
    await exec("closeIndexBtn.focus();true");
    await key("Escape");
    samples.push(await state());
    await click("toggleNotes");
    samples.push(await state());
    await click("toggleTocBtn");
    samples.push(await state());
    await click("closeIndex");
    samples.push(await state());
    await click("toggleNotes");
    await click("closeNotes");
    samples.push(await state());
    check("TOC toolbar pressed expanded and exclusive panel state agree after every entry and exit",
      samples.every(agrees) && samples.map(value => value.toc ? "toc" : value.notes ? "notes" : "closed")
        .join("|") === "closed|toc|closed|notes|toc|closed|closed", samples);
    executed.add("state");
  }
  async function editors(alpha, beta) {
    await select(alpha, "Alpha");
    await click("openEditorBtn");
    await wait("Alpha split editor", "isEditMode&&contentWrapper.classList.contains('split-view')");
    await select(beta, "Beta");
    check("Open editor remains scoped to Alpha rather than enabling every document",
      await exec("!isEditMode&&!contentWrapper.classList.contains('split-view')"));
    const drafts = {};
    for (const [id, name, index] of [[beta, "Beta", 1], [alpha, "Alpha", 0]]) {
      await select(id, name);
      await click("openEditorBtn");
      await exec(`markdownEditor.value=${JSON.stringify(bodies[index] + "\n\nUnsaved " + name + " witness.\n")};
        markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));
        markdownEditor.setSelectionRange(${11 + index},${29 + index},'backward');true`);
      await wait("painted " + name + " draft", `viewer.textContent.includes(${JSON.stringify("Unsaved " + name + " witness.")})`);
      await sleep(900);
      drafts[name] = await snapshot();
    }
    check("TOC scope probe really owns two different dirty editors with selection and undo history",
      Object.values(drafts).every(value => value.edit && value.dirty && value.start < value.end &&
        JSON.parse(value.history).undo.length > 0) && drafts.Alpha.value !== drafts.Beta.value, drafts);
    const samples = [];
    for (const expected of [false, true, false, true]) {
      if ((await state()).toc === expected) await click("toggleTocBtn");
      await click("toggleTocBtn");
      for (const [id, name] of [[beta, "Beta"], [alpha, "Alpha"]]) {
        await select(id, name);
        samples.push({ name, expected, panel: await state(), draft: await snapshot(),
          heading: await exec("indexList.querySelector('.index-item')?.textContent") });
      }
    }
    check("repeat global TOC toggles preserve both owning drafts selection undo dirty state and headings",
      samples.every(value => value.panel.toc === value.expected &&
        JSON.stringify(value.draft) === JSON.stringify(drafts[value.name]) && value.heading === value.name), samples);
    // Deliberately save using the toolbar, not the menu or a direct storage write.
    if ((await state()).toc) await click("toggleTocBtn");
    await click("toggleTocBtn");
    const persisted = await state();
    check("toolbar writes the common reading panel preference after repeated multi-document choices",
      persisted.toc && persisted.saved === "toc", persisted);
    executed.add("owner");
    return drafts;
  }
  async function grouping() {
    const samples = [];
    for (const width of [1280, 420, 100]) {
      win.setContentSize(width, 720);
      await wait("toolbar width " + width, `Math.abs(innerWidth-${win.getContentSize()[0]})<=1`);
      await settle();
      samples.push(await exec(`(() => {
        const buttons=['refreshBtn','openEditorBtn','toggleTocBtn','menuBtn'].map(id=>{
          const b=document.getElementById(id),r=b.getBoundingClientRect();
          const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          return {id,width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,
            bottom:r.bottom,reachable:!!hit&&b.contains(hit)};
        });
        const d=document.querySelector('.header-document-actions'),a=document.querySelector('.header-app-actions');
        const separator=a?.querySelector('.nav-separator'),r=separator?.getBoundingClientRect(),
          toc=document.getElementById('toggleTocBtn').getBoundingClientRect();
        return {width:innerWidth,buttons,grouped:d?.getAttribute('role')==='group'&&
          d.getAttribute('aria-label')==='Current document'&&a?.getAttribute('role')==='group'&&
          a.getAttribute('aria-label')==='All documents'&&d.contains(document.getElementById('refreshBtn'))&&
          d.contains(document.getElementById('openEditorBtn'))&&a.contains(document.getElementById('toggleTocBtn')),
          separator:!!separator&&separator.getAttribute('aria-hidden')==='true'&&separator.tabIndex<0&&
            !separator.matches('button,a,input,select,textarea,[contenteditable="true"]')&&r.width>=1&&r.height>0&&
            r.right<=toc.left&&r.top<toc.bottom&&r.bottom>toc.top};
      })()`));
    }
    check("toolbar groups keep a visible noninteractive separator beside the global TOC at every width",
      samples.every(value => value.grouped && value.separator), samples);
    check("normal narrow and minimum-width toolbar buttons remain inside the viewport and hit-testable",
      samples.every(value => value.buttons.every(button => button.width > 0 && button.height > 0 &&
        button.left >= 0 && button.right <= value.width + 1 && button.reachable)), samples);
    check("minimum-width grouping probe actually wraps the document and app action rows",
      samples.at(-1).buttons[0].top !== samples.at(-1).buttons[2].top, samples.at(-1));
    win.setContentSize(1280, 800);
    await wait("normal toolbar restored", "innerWidth===1280");
    await settle();
    executed.add("grouping");
  }
  async function keyboard() {
    if ((await state()).toc) await click("closeIndex");
    await exec("document.getElementById('refreshBtn').focus();true");
    const focus = [];
    for (let i = 0; i < 3; i++) {
      await key("Tab");
      focus.push(await exec("document.activeElement.id"));
    }
    check("native Tab order runs Reload Open editor TOC menu without stopping on the separator",
      focus.join("|") === "openEditorBtn|toggleTocBtn|menuBtn", focus);
    await exec("toggleTocBtn.focus();true");
    const before = await state();
    await key("Enter");
    const enter = await state();
    const enterFocused = await exec("document.activeElement===toggleTocBtn");
    await key("Space");
    const space = await state();
    check("native Enter and Space activate the TOC button and retain toolbar keyboard focus",
      !before.toc && agrees(before) && enter.toc && enterFocused && !space.toc &&
      agrees(enter) && agrees(space) && await exec("document.activeElement===toggleTocBtn"),
      { before, enter, enterFocused, space });
    executed.add("keyboard");
  }
  async function geometry() {
    await exec(`window.__toolbarLandmarks={
      sourceTop(text) {
        const e=markdownEditor,c=getComputedStyle(e),m=document.createElement('div');
        for(const k of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing',
          'paddingTop','paddingBottom','paddingLeft','paddingRight','whiteSpace','overflowWrap','wordBreak','tabSize'])m.style[k]=c[k];
        Object.assign(m.style,{position:'fixed',left:'-10000px',top:'0',visibility:'hidden',
          width:e.clientWidth+'px',boxSizing:'border-box',border:'0',height:'auto'});
        const at=e.value.indexOf(text);if(at<0)throw new Error('Missing source landmark');
        const span=document.createElement('span');span.textContent=text;
        m.append(document.createTextNode(e.value.slice(0,at)),span,document.createTextNode(e.value.slice(at+text.length)));
        document.body.append(m);const y=span.getClientRects()[0].top-m.getBoundingClientRect().top;m.remove();return y;
      },
      previewTop(text) {
        const p=[...viewer.querySelectorAll('p')].find(p=>p.textContent.startsWith(text));
        if(!p)throw new Error('Missing rendered landmark');
        const r=document.createRange();r.setStart(p.firstChild,0);r.setEnd(p.firstChild,1);
        return (r.getBoundingClientRect().top-viewer.getBoundingClientRect().top)/scrollerScale(viewer)+viewer.scrollTop;
      }
    };true`);
    const measurements = [];
    for (const zoom of [100, 180]) {
      await exec(`zoomLevel=${zoom};updateZoom();applyEditorSplitRatio(.45);true`);
      for (const panel of ["toc", "notes", "closed", "toc-resized"]) {
        if (panel === "notes") await click("toggleNotes");
        else if (panel === "closed") await click("closeNotes");
        else {
          if (!(await state()).toc) await click("toggleTocBtn");
          if (panel === "toc-resized") await exec("document.documentElement.style.setProperty('--toc-width','420px');true");
        }
        await wait("rebuilt split correspondence", "getEditorScrollDiagnostics().ready&&!getEditorScrollDiagnostics().pendingGeometry");
        await settle();
        for (const driver of ["editor", "preview"]) {
          // Reusing the editor's target would make the reverse drive a no-op.
          const landmark = driver === "editor" ? "Alpha landmark 24." : "Alpha landmark 42.";
          const before = await exec(`(() => {
            const o=window.__toolbarLandmarks,e=${driver === "editor" ? "markdownEditor" : "viewer"};
            const before={editor:markdownEditor.scrollTop,rendered:viewer.scrollTop};
            e.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
            e.scrollTop=o.${driver === "editor" ? "sourceTop" : "previewTop"}(${JSON.stringify(landmark)});
            return before;
          })()`);
          await settle();
          measurements.push(await exec(`(() => {
            const o=window.__toolbarLandmarks,source=o.sourceTop(${JSON.stringify(landmark)})-markdownEditor.scrollTop,
              preview=o.previewTop(${JSON.stringify(landmark)})-viewer.scrollTop;
            return {zoom:${zoom},panel:${JSON.stringify(panel)},driver:${JSON.stringify(driver)},
              landmark:${JSON.stringify(landmark)},before:${JSON.stringify(before)},
              error:Math.abs(source-preview),source,preview,editor:markdownEditor.scrollTop,rendered:viewer.scrollTop,
              editorMax:markdownEditor.scrollHeight-markdownEditor.clientHeight,
              previewMax:viewer.scrollHeight-viewer.clientHeight,tocWidth:indexPanel.getBoundingClientRect().width,
              toc:indexPanel.classList.contains('visible'),notes:notesPanel.classList.contains('visible')};
          })()`));
        }
        await exec("document.documentElement.style.removeProperty('--toc-width');true");
        await settle();
      }
    }
    check("toolbar geometry probe has real split overflow unequal-height content and a resized TOC",
      measurements.length === 16 && measurements.every(value => value.editorMax > 1000 &&
        value.previewMax > 1000 && value.editor > 100 && value.rendered > 100 &&
        Math.abs(value.editor - value.before.editor) > 100 &&
        Math.abs(value.rendered - value.before.rendered) > 100 &&
        value.landmark === (value.driver === "editor" ? "Alpha landmark 24." : "Alpha landmark 42.")) &&
      measurements.filter(value => value.panel === "toc-resized").every(value => value.tocWidth > 400) &&
      await exec("isEditMode&&viewer.querySelector('img').getBoundingClientRect().height>800"), measurements);
    check("TOC Notes closed and resized transitions preserve bidirectional content landmarks at normal and high reading zoom",
      measurements.every(value => value.error < 36 &&
        value.toc === value.panel.startsWith("toc") && value.notes === (value.panel === "notes")), measurements);
    fs.writeFileSync(path.join(evidence, "toc-toolbar-geometry.json"), JSON.stringify(measurements, null, 2));
    executed.add("geometry");
  }
  async function captures() {
    const captures = [];
    for (const dark of [false, true]) for (const width of [1280, 480]) for (const zoom of [100, 180]) {
      win.setContentSize(width, 800);
      await wait("capture width", `innerWidth===${width}`);
      await exec(`if(document.body.classList.contains('dark-mode')!==${dark})document.getElementById('darkModeToggle').click();
        zoomLevel=${zoom};updateZoom();getViewerScroller().scrollTop=0;true`);
      if (!(await state()).toc) await click("toggleTocBtn");
      await settle();
      const name = `toc-toolbar-${dark ? "dark" : "light"}-${width}-${zoom}`;
      await capture(name);
      captures.push(name);
    }
    check("toolbar capture matrix writes light dark normal narrow and high-reading-zoom evidence",
      captures.length === 8 && captures.every(name => fs.statSync(path.join(evidence, name + ".png")).size > 1000));
    win.setContentSize(1280, 800);
    await wait("capture layout restored", "innerWidth===1280");
    executed.add("captures");
  }
  async function saveEditors(alpha, beta) {
    for (const [id, name] of [[alpha, "Alpha"], [beta, "Beta"]]) {
      await select(id, name);
      await click("saveButton");
      await wait("saved " + name, "!hasUnsavedChanges&&!hasPendingSaveFor(currentFilePath)");
    }
    check("toolbar test saves both fixture drafts without touching nonfixture documents",
      files.every((file, index) => fs.readFileSync(file, "utf8") === bodies[index] +
        "\n\nUnsaved " + (index ? "Beta" : "Alpha") + " witness.\n"));
    executed.add("save");
  }
  async function behavior() {
    const initial = await state();
    check("fresh toolbar uses the isolated production preload and a genuinely empty Welcome",
      await exec(`typeof require==='undefined'&&typeof process==='undefined'&&Object.isFrozen(window.folia)&&
        window.CustomTabs.getTabs().length===0&&!!viewer.querySelector('.welcome')&&localStorage.getItem('readingSidePanel')===null`));
    check("fresh Welcome TOC toolbar starts unpressed unexpanded and with both drawers closed",
      !initial.toc && !initial.notes && agrees(initial), initial);
    check("global TOC toolbar is a named native button controlling the real outline",
      await exec(`toggleTocBtn.tagName==='BUTTON'&&toggleTocBtn.type==='button'&&
        toggleTocBtn.getAttribute('aria-controls')==='indexPanel'&&
        /table of contents.*all documents/i.test(toggleTocBtn.getAttribute('aria-label'))`));
    executed.add("initial");
    if (selected("welcome")) await welcome();
    const alpha = await open(0);
    if (selected("welcome")) {
      const after = await state();
      check("explicit Welcome toolbar close cancels the pending first-document TOC default",
        !after.toc && !after.notes && after.saved === "closed", after);
    }
    const beta = await open(1);
    check("toolbar scope fixture really has two admitted documents and the current document outline",
      await exec(`window.CustomTabs.getTabs().length===2&&viewer.querySelector('h1').textContent==='Beta'&&
        indexList.querySelectorAll('.index-item').length===7&&indexList.querySelector('.index-item').textContent==='Beta'`));
    executed.add("documents");
    if (selected("handler")) await handler(alpha, beta);
    if (selected("state")) await commonState();
    if (selected("owner")) await editors(alpha, beta);
    if (selected("grouping")) await grouping();
    if (!proof) {
      await keyboard();
      await select(alpha, "Alpha");
      await geometry();
      await captures();
    }
    if (selected("owner")) {
      await saveEditors(alpha, beta);
      if ((await state()).toc) await click("toggleTocBtn");
      await click("toggleTocBtn");
    }
  }
  async function restart() {
    await wait("real two-document restoration", `window.CustomTabs.getTabs().length===2&&
      viewer.querySelector('h1')?.textContent==='Beta'&&!loadingScreen.classList.contains('active')`);
    const value = await state(), open = phase === "savedToc";
    check(open ? "toolbar-open preference and pressed state survive actual process restart" :
      "toolbar-closed preference and pressed state survive actual process restart",
    value.toc === open && !value.notes && value.saved === (open ? "toc" : "closed") && agrees(value), value);
    check(phase + " restart restores both actual fixture tabs rather than a synthetic drawer",
      await exec(`window.CustomTabs.getTabs().every(t=>${JSON.stringify(files)}.includes(t.filePath))&&
        viewer.textContent.includes('Unsaved Beta witness.')`));
    if (open) await click("toggleTocBtn");
    executed.add("restart");
  }
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  shell.openExternal = async () => { throw new Error("TOC toolbar suite must not open external applications"); };
  shell.openPath = async () => { throw new Error("TOC toolbar suite must not open external applications"); };
  require("../src/main.js");
  app.whenReady().then(async () => {
    await sleep(1400);
    win = BrowserWindow.getAllWindows()[0];
    win.webContents.setBackgroundThrottling(false);
    win.setContentSize(1280, 800);
    try {
      await wait("production renderer", "typeof window.CustomTabs?.getTabs==='function'&&typeof renderMarkdown==='function'");
      sentinel = startErrorSentinel(win, { label: "toc-toolbar" });
      if (phase === "behavior") await behavior();
      else await restart();
      const required = phase !== "behavior" ? ["restart"] : proof ?
        ["initial", "documents", proof, ...(proof === "owner" ? ["save"] : [])] :
        ["initial", "welcome", "documents", "handler", "state", "owner", "grouping", "keyboard", "geometry", "captures", "save"];
      check("all required TOC toolbar scenarios executed",
        required.length > 0 && required.every(name => executed.has(name)), { required, executed: [...executed] });
      const alive = await proveSentinelAlive(win, sentinel);
      check("TOC toolbar sentinel proves both error channels are alive", alive.console && alive.dom, alive);
      const errors = await sentinel.stop();
      check("TOC toolbar scenarios introduce no renderer or visible document errors", errors.hits.length === 0, errors.hits);
      check("TOC toolbar product sources remain unchanged during the run",
        JSON.stringify(sourceHashes) === JSON.stringify(hashes()));
    } catch (error) {
      check("TOC toolbar harness reaches completion", false, error.stack || String(error));
    }
    fs.writeFileSync(path.join(evidence, "toc-toolbar-" + phase + "-receipt.json"),
      JSON.stringify({ proof, phase, executed: [...executed], sourceHashes, assertions: results }, null, 2));
    session.defaultSession.flushStorageData();
    const summary = `=== toc toolbar ${phase}: ${results.filter(value => value.ok).length}/${results.length} passed ===`;
    app.once("quit", () => console.log(summary));
    app.once("will-quit", () => app.exit(results.length && results.every(value => value.ok) ? 0 : 1));
    app.quit();
  }).catch(error => {
    fs.writeSync(2, "TOC toolbar fatal: " + String(error.stack || error) + "\n");
    app.exit(2);
  });
  setTimeout(() => { fs.writeSync(2, "TOC toolbar watchdog expired\n"); app.exit(2); }, 160000);
}
