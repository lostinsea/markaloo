"use strict";
const { app, BrowserWindow, dialog, shell } = require("electron");
const fs = require("fs");
const path = require("path");
require("./test-userdata-isolation");
const { startErrorSentinel, proveSentinelAlive } = require("./test-visual-utils");
const { generate } = require("../bench/corpus");
const directory = path.resolve(__dirname, "..", "tmp", "editor-scroll");
const evidence = path.resolve(process.env.FOLIA_SCROLL_EVIDENCE || directory);
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
const baseline = process.argv.includes("--baseline");
const perfOnly = process.argv.includes("--perf");
const proof = process.env.FOLIA_SCROLL_PROOF;
if (proof && !["core", "blocks", "input", "layout", "edits", "cost", "transitions", "save", "rich", "html", "mapping", "bounds", "empty", "mirror"].includes(proof)) {
  console.error("Unsupported editor-scroll proof route: " + proof);
  app.exit(2);
}
const coreProof = proof === "core";
const executedScenarios = new Set();
const scenario = name => {
  const selected = !proof || proof === name;
  if (selected) executedScenarios.add(name);
  return selected;
};
const receipt = { baseline, budgets: { callbackP95Ms: 4, openAndSplit: { relative: .2, absoluteMs: 50 } },
  runtime: { node: process.version, electron: process.versions.electron, platform: process.platform,
    cpu: require("os").cpus()[0]?.model }, measurements: [], correspondence: [] };
receipt.sources = Object.fromEntries(["main.js", "renderer.js", "editor-scroll.js", "index.html", "styles.css",
  "custom-styles.css", "custom-tabs.js"].map(name =>
  [name, require("crypto").createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "src", name))).digest("hex")]));
receipt.suiteSha256 = require("crypto").createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
const parts = ["# Scroll correspondence"];
for (let i = 0; i < 25; i++) parts.push(`Before diagram paragraph ${i}. ` + "Reading a separate source block. ".repeat(8));
parts[parts.length - 1] += "\n```mermaid\nflowchart TD\n" +
  Array.from({ length: 14 }, (_, i) => ` N${i}[Stage ${i}] --> N${i + 1}[Stage ${i + 1}]`).join("\n") + "\n```";
parts.push("After diagram landmark. " + "This paragraph follows the expanded diagram. ".repeat(8));
const imageSource = height => "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="${height}"><rect width="180" height="${height}" fill="#4f7d92"/></svg>`);
parts.push(`<img id="scroll-image" src="${imageSource(900)}" alt="Layout witness" width="300" height="900">`);
for (let i = 0; i < 35; i++) {
  parts.push(`Middle paragraph ${i}. ` + "Repeated content must keep its source position. ".repeat(10));
  if (i % 12 === 0) parts.push("Repeated identical paragraph. " + "The occurrence matters. ".repeat(12));
}
parts.push("| Left | Right |\n| --- | --- |\n" +
  Array.from({ length: 35 }, (_, i) => `| Row ${i} | Unequal table height |`).join("\n"));
parts.push("After table landmark. " + "This paragraph follows the large table. ".repeat(10));
parts.push("```javascript\n" + Array.from({ length: 60 }, (_, i) => `const value${i} = ${i};`).join("\n") + "\n```");
parts.push("![Tall](short.svg)");
parts.push("After short source image. " + "A separate content landmark follows the one-line image source. ".repeat(8));
parts.push("Prelude. ![Small](short.svg) Tail.");
parts.push("[](hidden)![Hidden](short.svg)");
parts.push("Inline image prelude. " + "Some prose precedes this picture. ".repeat(4) +
  `![Inline layout witness](${imageSource(1600)}) ` +
  Array.from({ length: 90 }, (_, i) => `Inline image sentence ${i} follows the tall picture inside one source paragraph.`).join(" "));
parts.push("Single wrapped paragraph. " + Array.from({ length: 100 }, (_, i) =>
  `Single sentence ${i} explains content-based correspondence across differently wrapped source and preview text.`).join(" "));
parts.push("Wrapped prose starts here.\n" + Array.from({ length: 80 }, (_, i) =>
  `Sentence ${i} describes a long paragraph with a separate source line and wrapping in the preview.`).join("\n"));
for (let i = 0; i < 45; i++) parts.push(`Ending paragraph ${i}. ` + "A stable source and preview landmark. ".repeat(10));
const mixed = parts.join("\n\n");
const first = path.join(directory, "mixed.md"), second = path.join(directory, "short.md"),
  plain = path.join(directory, "plain50k.md"), syntax = path.join(directory, "syntax.md"),
  rich = path.join(directory, "rich.md");
fs.writeFileSync(first, mixed);
fs.writeFileSync(path.join(directory, "short.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="1600"><rect width="180" height="1600" fill="#4f7d92"/></svg>');
fs.writeFileSync(second, "# Short document\n\nShort body.");
fs.writeFileSync(plain, "# Plain corpus\n\n" + generate("prose", 50 * 1024));
fs.writeFileSync(syntax, ("\uFEFF# Syntax correspondence\n\n" +
  "[reference]: https://example.invalid/\n\n" +
  Array.from({ length: 18 }, (_, i) => `Syntax paragraph ${i}. :star: A [reference link][reference] has **formatting** and \`code\`. ` +
    "Source syntax is not rendered character count. ".repeat(8)).join("\n\n") +
  "\n\n@@@html\n<div style=\"height:900px;background:#4f7d92\">Sandboxed layout</div>\n@@@\n\n" +
  Array.from({ length: 28 }, (_, i) => `- List item ${i}. ` + "An individually located list occurrence. ".repeat(8)).join("\n") +
  "\n\n" + Array.from({ length: 25 }, (_, i) => `Syntax tail ${i}. ` +
    "A matching paragraph follows emoji reference definitions and raw HTML. ".repeat(8)).join("\n\n")).replace(/\n/g, "\r\n"));
fs.writeFileSync(rich, [
  "# Rich inline correspondence",
  "Prelude. " + "A separate source block. ".repeat(80),
  "[Compact link](https://example.invalid/" + "hidden-destination-".repeat(400) + ") " +
    Array.from({ length: 90 }, (_, i) => `Hidden destination sentence ${i}. ` +
      "Visible text follows syntax that has no preview height. ".repeat(2)).join(" "),
  Array.from({ length: 90 }, (_, i) => `Uneven sentence ${i}. ` + (i < 45 ? "a ".repeat(60) :
    "averylongunbrokentexttokenlength ".repeat(8))).join(" "),
  "> Quoted prelude before an inline picture.\n> " +
    `![Quoted picture](${imageSource(1600)})\n` +
    Array.from({ length: 25 }, (_, i) => `> Quoted after image ${i}. ` + "Prefix stripping preserves this source occurrence. ".repeat(5)).join("\n"),
  "- List prelude before an inline picture.\n  " +
    `![List picture](${imageSource(1600)})\n` +
    Array.from({ length: 25 }, (_, i) => `  List after image ${i}. ` + "Indent stripping preserves this source occurrence. ".repeat(5)).join("\n"),
  Array.from({ length: 75 }, (_, i) => `Inline syntax sentence ${i}. ` +
    "**Bold words** and _emphasis_ with &amp; &#x1F680; \\*literal stars\\*, " +
    "[repeated label][shared] and [repeated label](https://example.invalid/repeated-label/" +
    (i < 30 ? "" : "hidden-inline-destination-".repeat(50)) + "), " +
    "` code words ` and a literal \uD83D\uDE80. ").join(" "),
  "- [x] Task item before nested content.\n  Lazy continuation stays in this item.\n\n" +
    "  > A nested quote starts here.\n  > " +
    Array.from({ length: 35 }, (_, i) => `Task quote sentence ${i}. ` +
      "A checked task and two stripped prefixes retain the exact source position. ").join(" "),
  "[shared]: https://example.invalid/reference-destination",
  "Tail. " + "A separate ending source block. ".repeat(80),
].join("\n\n"));
receipt.fixtures = Object.fromEntries([first, plain, syntax, rich].map(file => [path.basename(file), {
  bytes: fs.statSync(file).size,
  sha256: require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
}]));
let chosen = first, win, sentinel;
const results = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
shell.openExternal = async () => { throw new Error("Scroll suite must not open external applications"); };
shell.openPath = async () => { throw new Error("Scroll suite must not open external applications"); };
require("../src/main.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = code => win.webContents.executeJavaScript(code, true);
const frames = () => exec("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
const settle = async () => { await sleep(180); await frames(); };
const check = (name, ok, detail) => {
  results.push(!!ok);
  receipt.assertions ||= [];
  receipt.assertions.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
};
async function wait(label, expression) {
  for (let i = 0; i < 300; i++) {
    if (await exec(expression)) return;
    await sleep(30);
  }
  throw new Error("Timed out waiting for " + label);
}
async function open(file, heading) {
  chosen = file;
  heading ||= fs.readFileSync(file, "utf8").match(/^#{1,6} (.+)$/m)[1];
  const start = performance.now();
  await exec("document.getElementById('openFile').click();true");
  await wait("painted " + heading, `viewer.querySelector('h1,h2,h3,h4,h5,h6')?.textContent===${JSON.stringify(heading)}&&!loadingScreen.classList.contains('active')`);
  const elapsed = performance.now() - start;
  await exec("(async()=>{await whenMermaidSettled();return true})()");
  await settle();
  return elapsed;
}
async function mode(edit) {
  const before = baseline ? null : await exec("getEditorScrollDiagnostics()");
  const measured = await exec(`new Promise((resolve,reject)=>{
    const start=performance.now();
    if(isEditMode!==${edit})document.getElementById(${baseline ? "'toggleEdit'" : "isEditMode ? 'exitEditBtn' : 'toggleEdit'"}).click();
    let layoutMs=null,last=null,stable=0;
    const tick=()=>{
      const now=performance.now();
      if(now-start>9000){reject(new Error('Split readiness timed out'));return;}
      const e=markdownEditor.getBoundingClientRect(),p=viewer.getBoundingClientRect();
      const laidOut=isEditMode===${edit}&&!loadingScreen.classList.contains('active')&&
        (${edit} ? e.width>100&&p.width>100&&e.height>100&&p.height>100 : e.width===0);
      if(laidOut&&layoutMs===null)layoutMs=now-start;
      const d=${baseline ? "null" : "getEditorScrollDiagnostics()"};
      const ready=laidOut&&(${baseline ? "true" : edit ? "d.ready&&!d.pendingGeometry" : "!d.ready"});
      const signature=[e.width,e.height,p.width,p.height,viewer.scrollHeight,markdownEditor.scrollHeight,d?.builds].join('|');
      stable=ready&&last===signature?stable+1:0;last=signature;
      if(stable>=2)resolve({layoutMs,completeMs:performance.now()-start,after:d});
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })`);
  if (!baseline) receipt.modeDiagnostics = { before, after: measured.after };
  receipt.lastModeTiming = measured;
  await settle();
  return measured.completeMs;
}
async function capture(name) {
  await settle();
  fs.writeFileSync(path.join(evidence, name + ".png"), (await win.webContents.capturePage()).toPNG());
}
async function installOracle() {
  await exec(`window.__scrollOracle={
    sourceTop(text,occurrence=0) {
      const e=markdownEditor,c=getComputedStyle(e),m=document.createElement('div');
      for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing',
        'paddingTop','paddingBottom','paddingLeft','paddingRight','whiteSpace','overflowWrap','wordBreak','tabSize'])
        m.style[key]=c[key];
      Object.assign(m.style,{position:'fixed',left:'-10000px',top:'0',visibility:'hidden',
        width:e.clientWidth+'px',boxSizing:'border-box',border:'0',height:'auto'});
      let index=-1;
      for(let i=0;i<=occurrence;i++)index=e.value.indexOf(text,index+1);
      if(index<0)throw new Error('Missing source landmark '+text);
      const span=document.createElement('span');span.textContent=e.value.slice(index,index+text.length);
      m.append(document.createTextNode(e.value.slice(0,index)),span,document.createTextNode(e.value.slice(index+text.length)));
      document.body.append(m);
      const y=span.getClientRects()[0].top-m.getBoundingClientRect().top;m.remove();return y;
    },
    previewTop(text,occurrence=0) {
      const root=[...viewer.querySelectorAll('p,td,code,li')].filter(p=>p.textContent.includes(text))[occurrence];
      if(!root)throw new Error('Missing preview landmark '+text);
      const at=root.textContent.indexOf(text),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
      let offset=0,node,box;
      while((node=walker.nextNode())){
        if(offset+node.length>at){const r=document.createRange();r.setStart(node,at-offset);
          r.setEnd(node,Math.min(node.length,at-offset+1));box=r.getBoundingClientRect();break;}
        offset+=node.length;
      }
      return (box.top-viewer.getBoundingClientRect().top)/scrollerScale(viewer)+viewer.scrollTop;
    },
    state(text,occurrence=0,previewOccurrence=occurrence) {
      const source=this.sourceTop(text,occurrence)-markdownEditor.scrollTop;
      const preview=this.previewTop(text,previewOccurrence)-viewer.scrollTop;
      return {text,source,preview,error:Math.abs(source-preview),editor:markdownEditor.scrollTop,
        rendered:viewer.scrollTop,editorMax:markdownEditor.scrollHeight-markdownEditor.clientHeight,
        previewMax:viewer.scrollHeight-viewer.clientHeight};
    },
    sharedRow(text) {
      const match=/^(.*sentence )(\\d+)\\./.exec(text);
      if(!match||Number(match[2])===0)return null;
      const previous=match[1]+(Number(match[2])-1)+'.';
      const start=this.sourceTop(previous),end=this.sourceTop(text),top=markdownEditor.scrollTop;
      const root=[...viewer.querySelectorAll('p,li')].find(p=>p.textContent.includes(text));
      let at=root.textContent.indexOf(text)-1;
      while(at>=0&&/\\s/.test(root.textContent[at]))at--;
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
      let cursor=0,node,previousTop;
      while((node=walker.nextNode())){
        if(cursor+node.length>at){
          const range=document.createRange();range.setStart(node,at-cursor);range.setEnd(node,at-cursor+1);
          previousTop=(range.getBoundingClientRect().top-viewer.getBoundingClientRect().top)/scrollerScale(viewer)+viewer.scrollTop;
          break;
        }
        cursor+=node.length;
      }
      return {sourceWithinPreviousSentence:top>=start-1&&top<=end+1,
        sharedContentVisible:(()=>{
          const height=markdownEditor.clientHeight-parseFloat(getComputedStyle(markdownEditor).lineHeight);
          if(end-top>=-1&&end-top<height)return true;
          if(!text.startsWith('Inline syntax sentence '))return false;
          const key='repeated label](https://example.invalid/repeated-label/';
          const from=markdownEditor.value.indexOf(previous),index=markdownEditor.value.indexOf(key,from);
          if(index<0||index>=markdownEditor.value.indexOf(text))return false;
          const occurrence=markdownEditor.value.slice(0,index).split(key).length-1;
          const source=this.sourceTop(key,occurrence)-top;
          let rendered=root.textContent.indexOf('repeated label',root.textContent.indexOf(previous));
          rendered=root.textContent.indexOf('repeated label',rendered+1);
          const labelWalker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
          let offset=0,leaf;
          while((leaf=labelWalker.nextNode())){
            if(offset+leaf.length>rendered){
              const range=document.createRange();range.setStart(leaf,rendered-offset);range.setEnd(leaf,rendered-offset+1);
              const y=(range.getBoundingClientRect().top-viewer.getBoundingClientRect().top)/scrollerScale(viewer)+viewer.scrollTop;
              return source>=-1&&source<height&&Math.abs(y-this.previewTop(text))<1;
            }
            offset+=leaf.length;
          }
          return false;
        })(),
        sameRenderedRow:Math.abs(previousTop-this.previewTop(text))<1};
    }
  };true`);
}
async function correspondence(direction, text, name, occurrence = 0, allowSharedRow = false, previewOccurrence = occurrence) {
  await exec(`(() => {
    const o=window.__scrollOracle;
    (${direction === "editor"}?markdownEditor:viewer).dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
    if(${direction === "editor"}) markdownEditor.scrollTop=o.sourceTop(${JSON.stringify(text)},${occurrence});
    else viewer.scrollTop=o.previewTop(${JSON.stringify(text)},${previewOccurrence});
    return true;
  })()`);
  await settle();
  const value = await exec(`window.__scrollOracle.state(${JSON.stringify(text)},${occurrence},${previewOccurrence})`);
  if (allowSharedRow && direction === "preview" && value.error >= 36) {
    value.sharedRow = await exec(`window.__scrollOracle.sharedRow(${JSON.stringify(text)})`);
  }
  receipt.correspondence.push({ direction, ...value });
  if (baseline) check(name + " baseline mismatch is reproduced", value.error > 200, value);
  else check(name, value.error < 36 || (value.sharedRow?.sourceWithinPreviousSentence &&
    value.sharedRow.sharedContentVisible && value.sharedRow.sameRenderedRow), value);
  return value;
}
async function nativeWheel(side, deltaY, selector = null) {
  const point = await exec(`(() => {
    const r=(${selector ? `viewer.querySelector(${JSON.stringify(selector)})` : side === "editor" ? "markdownEditor" : "viewer"}).getBoundingClientRect();
    return {x:Math.round(r.left+Math.min(150,r.width/2)),y:Math.round(r.top+${selector ? "Math.min(60,r.height/2)" : "100"})};
  })()`);
  win.focus();
  win.webContents.sendInputEvent({ type: "mouseWheel", ...point, deltaX: 0, deltaY });
  await settle();
}
async function nativeClick(selector) {
  const point = await exec(`(() => {
    const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();
    const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);
    if(!el.contains(document.elementFromPoint(x,y)))throw new Error('Navigation control is not exposed');
    return {x,y};
  })()`);
  win.focus();
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
}
async function restorationNavigation() {
  await exec(`(() => {
    let prototype=viewer,descriptor;
    while(prototype&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(prototype,'scrollTop');prototype=Object.getPrototypeOf(prototype);}
    if(!descriptor?.get||!descriptor?.set)throw new Error('Missing native scrollTop accessor');
    const w=window.__restoreNavigation={own:Object.getOwnPropertyDescriptor(viewer,'scrollTop'),
      width:editorPanel.style.width,phase:'setup',writes:[]};
    Object.defineProperty(viewer,'scrollTop',{configurable:true,get(){return descriptor.get.call(this);},
      set(value){descriptor.set.call(this,value);w.writes.push({phase:w.phase,value,stack:new Error().stack});}});
    w.position=()=>{
      const {ready,pendingGeometry,owner,matchesSource,selection,mappedSelection}=getEditorScrollDiagnostics();
      return {top:viewer.scrollTop,path:currentFilePath,sequence:fileOpenSequence,generation:renderGeneration,
        source:originalMarkdown===markdownEditor.value,
        sourceHeading:window.__scrollOracle.sourceTop('# Scroll correspondence')-markdownEditor.scrollTop,
        previewHeading:(viewer.querySelector('h1').getBoundingClientRect().top-viewer.getBoundingClientRect().top)/scrollerScale(viewer),
        ready,pendingGeometry,owner,matchesSource,selection,mappedSelection};
    };
    w.resize=()=>{w.phase='resize';w.pendingAtResize=window.CustomTabs.__scrollRestorePending();
      w.withinWindow=performance.now()<w.deadline;w.beforeWidth=viewer.getBoundingClientRect().width;
      editorPanel.style.width=(editorPanel.getBoundingClientRect().width+32)+'px';};
    w.observer=new ResizeObserver(()=>{if(w.phase==='resize')w.resized=true;});
    w.observer.observe(viewer);
    return true;
  })()`);
  const legs = [];
  try {
    for (const navigate of [false, "TOC", "search"]) {
      await exec(`editorPanel.style.width=window.__restoreNavigation.width;
        if(searchPanel.classList.contains('visible'))toggleSearchPanel();
        ${navigate === "search" ? "toggleSearchPanel();" : ""}
        true`);
      await nativeWheel("preview", -1);
      await exec("viewer.scrollTop=400;true");
      await frames();
      const saved = await exec("viewer.scrollTop");
      await exec(`(async()=>{
        const w=window.__restoreNavigation;w.deadline=performance.now()+1100;
        const tabs=window.CustomTabs.getTabs();
        await window.CustomTabs.switchToTab(tabs.find(t=>t.filePath===${JSON.stringify(second)}).id);
        await window.CustomTabs.switchToTab(tabs.find(t=>t.filePath===${JSON.stringify(first)}).id);
        return true;
      })()`);
      await wait("controlled tab restoration", `currentFilePath===${JSON.stringify(first)}&&
        viewer.querySelector('h1')?.textContent==='Scroll correspondence'&&isEditMode&&
        getEditorScrollDiagnostics().ready&&!getEditorScrollDiagnostics().pendingGeometry&&
        window.CustomTabs.__scrollRestorePending()&&Math.abs(viewer.scrollTop-${saved})<1`);
      const setup = await exec(`({pending:window.CustomTabs.__scrollRestorePending(),
        scroller:window.CustomTabs.__getScroller()===viewer,...window.__restoreNavigation.position()})`);
      const armed = saved > 300 && setup.pending && setup.scroller && setup.source &&
        setup.matchesSource && setup.selection === setup.mappedSelection && Math.abs(setup.top - saved) < 1;
      check(`controlled ${navigate || "restoration"} leg has the real current-source restore armed`, armed, setup);
      if (!armed) throw new Error("Controlled restoration setup was not reached");
      await exec(`(() => {
        const w=window.__restoreNavigation;w.writes=[];w.resized=false;w.stopped=false;w.phase='navigation';
        w.completed=false;w.reached=null;w.current=false;w.pendingAfterNavigation=null;
        w.heading=viewer.querySelector('h1');w.start=w.position();w.progress=false;w.trustedClick=false;
        w.target=${navigate === "search" ? "searchNextBtn" : "indexList.querySelector('.index-item')"};
        w.beforeClick=()=>{w.pendingBeforeNavigation=window.CustomTabs.__scrollRestorePending();};
        w.clicked=event=>{w.trustedClick=event.isTrusted;w.pendingAfterNavigation=window.CustomTabs.__scrollRestorePending();};
        w.moved=event=>{if(event.target===viewer&&event.isTrusted)w.progress=true;};
        w.ended=event=>{
          if(event.target!==viewer||!event.isTrusted)return;
          const finish=()=>{
            if(w.stopped)return;
            const position=w.position();
            if(!position.ready||position.pendingGeometry){requestAnimationFrame(finish);return;}
            w.reached=position;
            w.current=w.heading.isConnected&&w.heading===viewer.querySelector('h1')&&
              w.start.sequence===fileOpenSequence&&w.start.generation===renderGeneration&&
              w.start.path===currentFilePath&&(${navigate === "search"}
                ?searchMatches.length===1&&currentMatchEl?.closest('h1')===w.heading
                :indexList.querySelector('.index-item.active')?.dataset.headerId===w.heading.id);
            w.resize();w.completed=true;
          };
          requestAnimationFrame(finish);
        };
        if(${!!navigate}){
          w.target.addEventListener('click',w.beforeClick,{once:true,capture:true});
          w.target.addEventListener('click',w.clicked,{once:true});
          viewer.addEventListener('scroll',w.moved);
          viewer.addEventListener('scrollend',w.ended,{once:true});
          if(${navigate === "search"}){
            searchInput.value='Scroll correspondence';searchInput.dispatchEvent(new Event('input',{bubbles:true}));
          }
        }else w.resize();
        return true;
      })()`);
      if (navigate) {
        await nativeClick(navigate === "search" ? "#searchNext" : "#indexList .index-item");
        await wait("native current navigation completion", "window.__restoreNavigation.completed");
      }
      await wait("controlled actual resize", "window.__restoreNavigation.resized&&getEditorScrollDiagnostics().ready&&!getEditorScrollDiagnostics().pendingGeometry");
      await frames();
      const result = await exec(`(() => {const w=window.__restoreNavigation;return {
        beforeWidth:w.beforeWidth,afterWidth:viewer.getBoundingClientRect().width,withinWindow:w.withinWindow,
        pendingAtResize:w.pendingAtResize,pendingAfterNavigation:w.pendingAfterNavigation,
        pendingBeforeNavigation:w.pendingBeforeNavigation,
        progress:w.progress,trustedClick:w.trustedClick,current:w.current,reached:w.reached,
        writes:w.writes,position:w.position()};})()`);
      const restoreWrites = result.writes.filter(write => write.phase === "resize" &&
        /custom-tabs\.js/.test(write.stack) && /\bapply\b/.test(write.stack));
      legs.push({ navigate, saved, setup, ...result, restoreWrites });
      check(`controlled ${navigate || "restoration"} leg changes the actual viewer box inside the restore window`,
        result.withinWindow && Math.abs(result.afterWidth - result.beforeWidth) > 10, result);
      check(`controlled ${navigate || "restoration"} leg retains current source and geometry`,
        result.position.source && result.position.path === first && result.position.ready &&
        result.position.matchesSource && result.position.selection === result.position.mappedSelection &&
        result.position.sequence === setup.sequence && result.position.generation === setup.generation, result.position);
      if (navigate) {
        const reached = result.reached;
        check(`${navigate} navigation completes native travel to its current-source heading before resize`,
          result.pendingBeforeNavigation && result.trustedClick && result.progress && result.current && reached.source &&
          reached.path === first && reached.owner === "preview" && reached.matchesSource &&
          reached.selection === reached.mappedSelection &&
          Math.abs(reached.top - saved) > 200 &&
          (navigate === "search" ? reached.top < 1 && Math.abs(reached.sourceHeading - reached.previewHeading) < 36
            : reached.top < 120 && Math.abs(reached.previewHeading) < 36 && Math.abs(reached.sourceHeading) < 36), result);
        check(`explicit ${navigate} navigation immediately retires the old tab restoration`,
          result.pendingAfterNavigation === false, result);
        const destination = navigate === "search"
          ? result.position.top < 1 && Math.abs(result.position.sourceHeading - result.position.previewHeading) < 36
          : result.position.top < 120 && Math.abs(result.position.sourceHeading) < 36 && Math.abs(result.position.previewHeading) < 36;
        check(`a real resize after completed ${navigate} navigation cannot restore the old reading position`,
          restoreWrites.length === 0 && result.position.owner === "preview" && destination, result);
        await capture("restore-navigation-" + navigate.toLowerCase());
      } else {
        check("a real resize still runs ordinary tab restoration at its saved reading position",
          result.pendingAtResize && restoreWrites.length > 0 && Math.abs(result.position.top - saved) < 1, result);
      }
      await exec(`(() => {const w=window.__restoreNavigation;
        w.stopped=true;w.target.removeEventListener('click',w.clicked);viewer.removeEventListener('scroll',w.moved);
        w.target.removeEventListener('click',w.beforeClick,true);
        viewer.removeEventListener('scrollend',w.ended);return true;})()`);
    }
  } finally {
    receipt.restorationNavigation = legs;
    await exec(`(() => {const w=window.__restoreNavigation;w.stopped=true;w.observer.disconnect();
      w.target?.removeEventListener('click',w.clicked);viewer.removeEventListener('scroll',w.moved);
      w.target?.removeEventListener('click',w.beforeClick,true);
      viewer.removeEventListener('scrollend',w.ended);
      if(searchPanel.classList.contains('visible'))toggleSearchPanel();editorPanel.style.width=w.width;
      if(w.own)Object.defineProperty(viewer,'scrollTop',w.own);else delete viewer.scrollTop;
      delete window.__restoreNavigation;return true;})()`);
    await nativeWheel("preview", -1);
  }
}
async function mirrorRetention() {
  const saved = await exec(`({
    source:markdownEditor.value,history:historySnapshot(),
    start:markdownEditor.selectionStart,end:markdownEditor.selectionEnd,direction:markdownEditor.selectionDirection,
    width:editorPanel.style.width,editorTop:markdownEditor.scrollTop,previewTop:viewer.scrollTop,
    selection:getEditorScrollDiagnostics().selection,pendingHistory:historyDebounceTimer!==null
  })`);
  check("mirror probe starts with settled original history", !saved.pendingHistory);
  if (saved.pendingHistory) throw new Error("Mirror proof cannot discard pending original history");
  const repeated = ("Mirror repeated paragraph. " + "Combining e\u0301 and a rocket \uD83D\uDE80 keep positions current. ".repeat(5)).trimEnd();
  const long = "x".repeat(511) + "\uD83D\uDE80" + "x".repeat(1200);
  const body = [
    "# Mirror retention fixture",
    "Mirror edit anchor. Small edits keep the rest of this document unchanged.",
    long,
    ...Array.from({ length: 8 }, (_, i) => (`Mirror before ${i}. ` + "A source and preview landmark. ".repeat(10)).trimEnd()),
    ...Array(6).fill(repeated),
    ...Array.from({ length: 12 }, (_, i) => (`Mirror after ${i}. ` + "A separate ending landmark. ".repeat(10)).trimEnd()),
    "Terminal line.\n\u200b",
  ].join("\n\n");
  const partition = source => {
    const slices = [], blocks = source.split("\n\n");
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block === long) {
        slices.push(block.slice(0, 511), block.slice(511, 1023), block.slice(1023, 1535), block.slice(1535));
      } else if (block === "Terminal line.\n\u200b") {
        slices.push("Terminal line.\n", "\u200b");
      } else {
        if (block.length > 512 || block.includes("\n") || block !== block.trimEnd())
          throw new Error("Mirror fixture escaped its independently defined simple partition");
        slices.push(block);
      }
      if (i < blocks.length - 1) slices.push("\n\n");
    }
    slices.push("");
    let offset = 0;
    const offsets = slices.map(slice => { const from = offset; offset += slice.length; return from; });
    return { slices, offsets };
  };
  const current = source => `markdownEditor.value===${JSON.stringify(source)}&&
    viewer.querySelector('h1')?.textContent==='Mirror retention fixture'&&
    getEditorScrollDiagnostics().ready&&getEditorScrollDiagnostics().matchesSource&&
    !getEditorScrollDiagnostics().pendingSource&&!getEditorScrollDiagnostics().pendingGeometry`;
  try {
    await exec(`markdownEditor.value=${JSON.stringify(body)};
      markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true`);
    await wait("mirror fixture current geometry", current(body));
    const setup = await exec(`(() => {
      const mirrors=[...document.body.children].filter(node=>node.tagName==='DIV'&&node.inert&&
        node.getAttribute('aria-hidden')==='true'&&node.style.left==='-100000px'&&node.style.visibility==='hidden');
      if(mirrors.length!==1)throw new Error('Expected one current source mirror');
      const mirror=mirrors[0],changes=[];
      let deliveries=0;
      const observer=new MutationObserver(records=>{deliveries++;changes.push(...records);});
      observer.observe(mirror,{childList:true});
      const parts=()=>[...mirror.children],offsets=nodes=>{
        let offset=0;return nodes.map((node,i)=>{const from=offset;
          if(i<nodes.length-1)offset+=node.textContent.length;return from;});
      };
      const initial=parts(),at=offsets(initial),source=markdownEditor.value;
      const start=source.indexOf(${JSON.stringify(long)}),split=start+512;
      window.__mirrorProof={mirror,observer,changes,parts,offsets,deliveries:()=>deliveries,begin(){
        observer.takeRecords();changes.length=0;this.before=parts();this.beforeDeliveries=deliveries;
        this.beforeText=new Map(this.before.map(node=>[node,node.textContent]));
        this.builds=getEditorScrollDiagnostics().builds;
      },finish(expected,partition){
        const after=parts(),from=offsets(after),d=getEditorScrollDiagnostics();
        const records=[...changes,...observer.takeRecords()],removed=new Set(records.flatMap(r=>[...r.removedNodes]));
        const retained=after.slice(0,-1).filter(node=>this.before.includes(node)&&
          node.textContent.replace(/[\\s\\u200b]/g,'').length>0);
        const actual=after.slice(0,-1).map(node=>node.textContent).concat('');
        return {sourceExact:markdownEditor.value===expected&&after.slice(0,-1).map(n=>n.textContent).join('')===expected,
          partitionExact:JSON.stringify(actual)===JSON.stringify(partition.slices)&&JSON.stringify(from)===JSON.stringify(partition.offsets),
          sentinel:after.at(-1)?.textContent==='\\u200b'&&from.at(-1)===expected.length,
          safeBoundaries:from.every(offset=>!/[\\uDC00-\\uDFFF]/.test(expected[offset]||'')),
          current:d.ready&&d.matchesSource&&!d.pendingSource&&!d.pendingGeometry&&d.builds>this.builds&&
            d.selection===${JSON.stringify(saved.selection)}&&d.mappedSelection===d.selection,
          callbackDeliveries:deliveries-this.beforeDeliveries,records:records.length,removed:removed.size,
          retained:retained.length,neverRemoved:retained.every(node=>node.isConnected&&!removed.has(node)&&
            node.textContent===this.beforeText.get(node))};
      }};
      return {splitRelative:split-start,high:/[\\uD800-\\uDBFF]/.test(source[split-1]),
        low:/[\\uDC00-\\uDFFF]/.test(source[split]),bindingStart:at.includes(start),
        backedOff:at.includes(split-1)&&!at.includes(split),
        terminalAuthored:initial.at(-2)?.textContent==='\\u200b'&&at.at(-2)===source.length-1&&
          initial.at(-1)?.textContent==='\\u200b'&&at.at(-1)===source.length,
        editorOverflow:markdownEditor.scrollHeight>markdownEditor.clientHeight+500,
        previewOverflow:viewer.scrollHeight>viewer.clientHeight+500,
        partitionExact:JSON.stringify(initial.slice(0,-1).map(node=>node.textContent).concat(''))===
          JSON.stringify(${JSON.stringify(partition(body).slices)})&&
          JSON.stringify(at)===JSON.stringify(${JSON.stringify(partition(body).offsets)})};
    })()`);
    check("mirror fixture proves the artificial split crosses a surrogate pair inside its binding",
      setup.splitRelative === 512 && setup.high && setup.low && setup.bindingStart && setup.backedOff, setup);
    check("mirror fixture separates authored terminal zero-width text from the artificial sentinel",
      setup.terminalAuthored, setup);
    check("mirror fixture really overflows both panes", setup.editorOverflow && setup.previewOverflow, setup);
    check("mirror fixture has independently defined ordered source spans", setup.partitionExact, setup);
    receipt.mirrorProof = { setup, edits: [] };
    const sentinelAlive = await exec(`(async() => {
      const p=window.__mirrorProof,last=p.parts().at(-1),before=p.deliveries();
      last.remove();p.mirror.append(last);await Promise.resolve();
      return {deliveries:p.deliveries()-before,removed:p.changes.some(record=>[...record.removedNodes].includes(last))};
    })()`);
    check("mirror removal observer detects a real detach and reinsert through its callback",
      sentinelAlive.deliveries > 0 && sentinelAlive.removed, sentinelAlive);
    receipt.mirrorProof.observerControl = sentinelAlive;
    const inserted = body.replace("Mirror edit anchor.", "Mirror edit anchor. Inserted.");
    const deleted = inserted.replace("Mirror edit anchor. Inserted.", "Mirror edit.");
    const appended = deleted + "\n\nMirror appended.";
    for (const [kind, source] of [["insert", inserted], ["delete", deleted], ["append", appended]]) {
      await exec("window.__mirrorProof.begin();true");
      await exec(`markdownEditor.value=${JSON.stringify(source)};
        markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true`);
      await wait("mirror " + kind + " current geometry", current(source));
      const observed = await exec(`window.__mirrorProof.finish(${JSON.stringify(source)},${JSON.stringify(partition(source))})`);
      check(`mirror ${kind} keeps current text partition, UTF-16 boundaries, sentinel and owner`,
        observed.sourceExact && observed.partitionExact && observed.sentinel && observed.safeBoundaries && observed.current &&
        observed.callbackDeliveries > 0 && observed.records > 0, observed);
      check(`mirror ${kind} retains attached unchanged source spans`,
        observed.retained > 1 && observed.neverRemoved, observed);
      const position = await correspondence("editor", "Mirror repeated paragraph.",
        `mirror ${kind} aligns the interior repeated occurrence after shifted offsets`, 2);
      check(`mirror ${kind} correspondence is interior and unclamped in both panes`,
        position.editor > 36 && position.editor < position.editorMax - 36 &&
        position.rendered > 36 && position.rendered < position.previewMax - 36, position);
      receipt.mirrorProof.edits.push({ kind, utf16Units: source.length, observed, position });
    }
    const beforeWidth = await exec(`(() => {
      const p=window.__mirrorProof;p.beforeWidth=p.parts();p.observer.takeRecords();p.changes.length=0;
      return {width:markdownEditor.clientWidth,height:markdownEditor.scrollHeight,builds:getEditorScrollDiagnostics().builds};
    })()`);
    await exec("applyEditorSplitRatio(.25);applyTableBreakout();true");
    await wait("mirror width invalidation", `getEditorScrollDiagnostics().ready&&
      !getEditorScrollDiagnostics().pendingGeometry&&getEditorScrollDiagnostics().builds>${beforeWidth.builds}`);
    const resized = await exec(`(() => {
      const p=window.__mirrorProof,nodes=p.parts(),
        removed=new Set([...p.changes,...p.observer.takeRecords()].flatMap(r=>[...r.removedNodes]));
      return {width:markdownEditor.clientWidth,height:markdownEditor.scrollHeight,
        same:nodes.length===p.beforeWidth.length&&nodes.every((node,i)=>node===p.beforeWidth[i]&&!removed.has(node)),
        sourceExact:markdownEditor.value===${JSON.stringify(appended)},
        partitionExact:JSON.stringify(nodes.slice(0,-1).map(node=>node.textContent).concat(''))===
          JSON.stringify(${JSON.stringify(partition(appended).slices)})&&
          JSON.stringify(p.offsets(nodes))===JSON.stringify(${JSON.stringify(partition(appended).offsets)}),
        sentinel:nodes.at(-1)?.textContent==='\\u200b'&&p.offsets(nodes).at(-1)===${appended.length},
        current:getEditorScrollDiagnostics().matchesSource&&!getEditorScrollDiagnostics().pendingSource};
    })()`);
    check("mirror width change proves fresh wrapping without replacing unchanged source spans",
      resized.width !== beforeWidth.width && resized.height !== beforeWidth.height && resized.same && resized.current &&
      resized.sourceExact && resized.partitionExact && resized.sentinel,
      { beforeWidth, resized });
    const resizedPosition = await correspondence("preview", "Mirror repeated paragraph.",
      "mirror resized preview aligns the interior repeated occurrence using fresh geometry", 2);
    check("mirror resized correspondence is interior and unclamped in both panes",
      resizedPosition.editor > 36 && resizedPosition.editor < resizedPosition.editorMax - 36 &&
      resizedPosition.rendered > 36 && resizedPosition.rendered < resizedPosition.previewMax - 36, resizedPosition);
    receipt.mirrorProof.width = { before: beforeWidth, after: resized, position: resizedPosition };
    await capture("mirror-retention");
  } finally {
    await exec(`window.__mirrorProof?.observer.disconnect();delete window.__mirrorProof;
      editorPanel.style.width=${JSON.stringify(saved.width)};applyTableBreakout();
      markdownEditor.value=${JSON.stringify(saved.source)};
      markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true`);
    await wait("mirror probe restores current original geometry", `markdownEditor.value===${JSON.stringify(saved.source)}&&
      viewer.querySelector('h1')?.textContent==='Scroll correspondence'&&getEditorScrollDiagnostics().ready&&
      getEditorScrollDiagnostics().matchesSource&&!getEditorScrollDiagnostics().pendingSource&&
      !getEditorScrollDiagnostics().pendingGeometry&&!hasUnsavedChanges`);
    await exec(`clearTimeout(historyDebounceTimer);historyDebounceTimer=null;historyRestore(${JSON.stringify(saved.history)});
      markdownEditor.setSelectionRange(${saved.start},${saved.end},${JSON.stringify(saved.direction)});
      markdownEditor.scrollTop=${saved.editorTop};viewer.scrollTop=${saved.previewTop};true`);
    await settle();
    await exec("retainCurrentDocumentEditor();true");
    check("mirror probe restores original source, history, selection and clean current ownership",
      await exec(`markdownEditor.value===${JSON.stringify(saved.source)}&&!hasUnsavedChanges&&
        historyDebounceTimer===null&&JSON.stringify(historySnapshot())===${JSON.stringify(JSON.stringify(saved.history))}&&
        editorPanel.style.width===${JSON.stringify(saved.width)}&&
        markdownEditor.selectionStart===${saved.start}&&markdownEditor.selectionEnd===${saved.end}&&
        markdownEditor.selectionDirection===${JSON.stringify(saved.direction)}&&
        getEditorScrollDiagnostics().ready&&getEditorScrollDiagnostics().matchesSource&&
        getEditorScrollDiagnostics().selection===${JSON.stringify(saved.selection)}`));
  }
}

async function run() {
  await wait("production renderer", "typeof window.CustomTabs?.getTabs==='function'&&typeof renderMarkdown==='function'");
  win.setSize(1440, 920);
  sentinel = startErrorSentinel(win, { label: "editor-scroll", trapExternal: false });
  for (let i = 0; !proof && i < 6; i++) {
    const openMs = await open(i % 2 ? plain : first, i % 2 ? null : "Scroll correspondence");
    const splitMs = await mode(true);
    receipt.measurements.push({ fixture: i % 2 ? "plain50k" : "mixed", openMs, splitMs,
      layoutMs: receipt.lastModeTiming.layoutMs,
      diagnostics: baseline ? null : receipt.modeDiagnostics });
    await mode(false);
  }
  await open(first, "Scroll correspondence");
  await exec("setIndexVisible(false);zoomLevel=100;updateZoom();true");
  await mode(true);
  await settle();
  check("scroll fixture has live isolated production preload and overflowing source and expanded diagram",
    await exec("window.require===undefined&&!!viewer.querySelector('.mermaid svg')&&markdownEditor.scrollHeight>markdownEditor.clientHeight+1000&&viewer.scrollHeight>viewer.clientHeight+1000&&viewer.querySelector('.mermaid').getBoundingClientRect().height>700"));
  await installOracle();
  await correspondence("editor", "After diagram landmark.", "editor aligns content after a tall Mermaid");
  await capture("editor-after-diagram");
  await correspondence("preview", "Middle paragraph 25.", "preview aligns content inside a long section");
  await capture("preview-middle-section");
  if (!baseline && !perfOnly && !coreProof) {
    await wait("published scroll geometry", "getEditorScrollDiagnostics().ready");
    if (scenario("mirror")) await mirrorRetention();
    if (scenario("empty")) {
      const vm = require("vm");
      const markedModule = await import(require("url").pathToFileURL(require.resolve("marked")).href);
      const context = vm.createContext({
        window: {}, document: {}, crypto: require("crypto").webcrypto,
        ResizeObserver: class {}, MutationObserver: class {},
        console: { warn() {} }, marked: markedModule,
      });
      vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "editor-scroll.js"), "utf8") +
        `\nwindow.mapping=window.createEditorScroll({
          editor:{addEventListener(){}},preview:{addEventListener(){}},
          active:()=>false,frozen:()=>false,identity:()=>1,scale:()=>1
        });`, context);
      const emptyCases = ["-", "- ", "+", "*", "1.", "1. ", "1)", "> -", "- [ ] "];
      const controls = emptyCases.map(body => {
        context.body = body;
        try {
          const html = vm.runInContext("window.mapping.source(body).parse(marked)", context, { timeout: 500 });
          return { body, completed: html === markedModule.parse(body) };
        } catch (error) {
          if (error.code !== "ERR_SCRIPT_EXECUTION_TIMEOUT") throw error;
          return { body, completed: false };
        }
      });
      receipt.emptyListControls = controls;
      const bounded = controls.every(value => value.completed);
      check("empty list metadata parsing terminates within a bounded real-parser control",
        bounded, controls);
      const rowWork = vm.runInContext(`(() => {
        const matchAll=String.prototype.matchAll;
        let scans=0;
        String.prototype.matchAll=function(regex){
          if(regex.source==='[^\\\\n]+')scans++;
          return matchAll.call(this,regex);
        };
        try {
          window.mapping.source('# Plain\\n\\nA **formatted** paragraph.\\n\\nAnother paragraph.').parse(marked);
          const prose=scans;
          window.mapping.source('| A | B |\\n| --- | --- |\\n| 1 | 2 |').parse(marked);
          return {prose,tables:scans-prose};
        } finally {String.prototype.matchAll=matchAll;}
      })()`, context, { timeout: 1000 });
      receipt.metadataRowWork = rowWork;
      check("metadata parsing constructs physical row descriptors only for table tokens",
        rowWork.prose === 0 && rowWork.tables === 1, rowWork);
      const verification = await exec(`(() => {
        const source=editorScroll.source('# One verification\\n\\nA **real** paragraph.');
        const root=document.createElement('div');root.innerHTML=sanitizeHtml(source.parse(marked));
        const equal=root.isEqualNode;
        let calls=0;
        root.isEqualNode=function(other){calls++;return equal.call(this,other);};
        const bindings=source.detach(root,sanitizeHtml);
        return {calls,bound:bindings.has(root.querySelector('p')),warnings:[...source.warnings]};
      })()`);
      check("verified metadata compares each unchanged canonical tree only once",
        verification.calls === 1 && verification.bound && verification.warnings.length === 0, verification);
      // A rejecting control must not send the known synchronous loop to a live renderer.
      if (bounded) {
        for (const [index, body] of emptyCases.entries()) {
          const text = `# Empty list ${index}\n\n${body}\n`;
          const file = path.join(directory, `empty-${index}.md`);
          fs.writeFileSync(file, text);
          await open(file, `Empty list ${index}`);
          check(`empty list ${index} opens a responsive canonical reading preview`,
            await exec(`!isEditMode&&viewer.querySelectorAll('li').length===1&&
              viewer.querySelector('h1')?.textContent===${JSON.stringify("Empty list " + index)}&&
              viewer.querySelector('li').textContent.trim()===${JSON.stringify(body === "- [ ] " ? "[ ]" : "")}`));
          await mode(true);
          for (const renderMode of ["full", "light-format"]) {
            const result = await exec(`(async()=>{
              await renderMarkdown(${JSON.stringify(text)},${JSON.stringify(renderMode)});
              const expected=document.createElement('div');
              expected.innerHTML=sanitizeHtml(marked.parse(${JSON.stringify(text)}));
              return {edit:isEditMode,items:viewer.querySelectorAll('li').length,
                actual:viewer.querySelector('li')?.textContent,
                expected:expected.querySelector('li')?.textContent,
                heading:viewer.querySelector('h1')?.textContent,
                mapped:getEditorScrollDiagnostics().matchesSource};
            })()`);
            check(`empty list ${index} ${renderMode} editing keeps canonical text and current mapping`,
              result.edit && result.items === 1 && result.actual === result.expected &&
              result.heading === `Empty list ${index}` && result.mapped, result);
          }
          await exec(`markdownEditor.value=${JSON.stringify(text + "\nTyping after the empty item.")};
            markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true`);
          await wait("typing after empty item", "viewer.textContent.includes('Typing after the empty item.')&&hasUnsavedChanges");
          await exec(`markdownEditor.value=${JSON.stringify(text)};
            markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true`);
          await wait("empty item restored after typing", `!viewer.textContent.includes('Typing after the empty item.')&&
            getEditorScrollDiagnostics().matchesSource&&!loadingScreen.classList.contains('active')`);
          check(`empty list ${index} remains responsive through live preview editing`,
            await exec("isEditMode&&viewer.querySelectorAll('li').length===1"));
          await exec("saveMarkdownFile();true");
          await wait("empty-item editor saved", "!hasUnsavedChanges");
          await mode(false);
        }
      }
      await open(first, "Scroll correspondence");
      await mode(true);
    }
    if (scenario("blocks")) {
      for (const direction of ["editor", "preview"]) {
        await correspondence(direction, "Row 20", `${direction} aligns an interior table row`);
        await correspondence(direction, "const value40 = 40;", `${direction} aligns an interior code line`);
        await correspondence(direction, "Sentence 40 describes", `${direction} aligns a physical line inside wrapped prose`);
        await correspondence(direction, "Single sentence 60 explains", `${direction} stays within a multi-screen single source paragraph`);
        await correspondence(direction, "Inline image sentence 40 follows", `${direction} aligns prose after a tall inline image`);
        await correspondence(direction, "Repeated identical paragraph.", `${direction} distinguishes repeated paragraph occurrences`, 2);
      }
      const atomic = await exec(`(async()=>{
        const o=window.__scrollOracle,s=markdownEditor,p=viewer,m=p.querySelector('.mermaid');
        const start=s.value.indexOf('\`\`\`mermaid'),end=s.value.indexOf('\`\`\`',start+3)+3;
        const sourceText=s.value.slice(start,end),line=sourceText.split('\\n')[7];
        s.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
        s.scrollTop=o.sourceTop(line);
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const rect=m.getBoundingClientRect(),port=p.getBoundingClientRect();
        const fraction=(s.scrollTop-o.sourceTop('\`\`\`mermaid'))/
          (o.sourceTop('\`\`\`',1)+parseFloat(getComputedStyle(s).lineHeight)-o.sourceTop('\`\`\`mermaid'));
        return {inside:rect.top<port.top&&rect.bottom>port.top,sourceLine:line,
          error:Math.abs((rect.top+fraction*rect.height-port.top)/scrollerScale(p)),
          height:rect.height,owner:getEditorScrollDiagnostics().owner};
      })()`);
      check("inside a tall diagram maps to that diagram rather than a neighboring section",
        atomic.inside && atomic.height > 700 && atomic.error < 36, atomic);
      const reverseAtomic = await exec(`(async()=>{
        const m=viewer.querySelector('.mermaid'),r=m.getBoundingClientRect(),p=viewer.getBoundingClientRect();
        viewer.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
        viewer.scrollTop+=(r.top+r.height/2-p.top)/scrollerScale(viewer);
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const o=window.__scrollOracle;
        const start=o.sourceTop('\`\`\`mermaid'),end=o.sourceTop('\`\`\`',1)+parseFloat(getComputedStyle(markdownEditor).lineHeight);
        return {start:start-markdownEditor.scrollTop,error:Math.abs(markdownEditor.scrollTop-(start+end)/2),
          end:o.sourceTop(' N13[Stage 13]')-markdownEditor.scrollTop,owner:getEditorScrollDiagnostics().owner};
      })()`);
      check("preview pixels inside a tall diagram map back inside its source fence",
        reverseAtomic.owner === "preview" && reverseAtomic.start < 0 && reverseAtomic.end > 0 &&
        reverseAtomic.error < 36, reverseAtomic);
      await capture("expanded-mermaid");
      for (const side of ["editor", "preview"]) {
        const image = await exec(`(async()=>{
          const o=window.__scrollOracle,s=markdownEditor,p=viewer,img=p.querySelector('img[alt="Inline layout witness"]');
          const begin=s.value.indexOf('![Inline layout witness]('),end=s.value.indexOf(') ',begin)+1;
          const start=o.sourceTop(s.value.slice(begin,end)),stop=o.sourceTop(s.value.slice(end,end+30));
          const r=img.getBoundingClientRect(),v=p.getBoundingClientRect();
          const center=(r.top+r.height/2-v.top)/scrollerScale(p)+p.scrollTop;
          const driver=${side === "editor"}?s:p;
          driver.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
          driver.scrollTop=${side === "editor"}?(start+stop)/2:center;
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          return {height:r.height,sourceSpan:stop-start,
            error:${side === "editor"}?Math.abs(p.scrollTop-center):Math.abs(s.scrollTop-(start+stop)/2)};
        })()`);
        check(`${side} maps inside a tall inline image rather than its adjacent prose`,
          image.height > 700 && image.sourceSpan > 20 && image.error < 36, image);
      }
      await capture("expanded-inline-image");
      await wait("short-source tall image", "viewer.querySelector('img[alt=\"Tall\"]')?.naturalHeight===1600");
      for (const side of ["editor", "preview"]) {
        const image = await exec(`(async()=>{
          const o=window.__scrollOracle,s=markdownEditor,p=viewer,img=p.querySelector('img[alt="Tall"]');
          const start=o.sourceTop('![Tall](short.svg)'),end=o.sourceTop('short.svg)');
          const r=img.getBoundingClientRect(),v=p.getBoundingClientRect();
          const top=(r.top-v.top)/scrollerScale(p)+p.scrollTop;
          const driver=${side === "editor"}?s:p;
          driver.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
          driver.scrollTop=${side === "editor"}?start:top+r.height/scrollerScale(p)/2;
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          return {height:r.height,sourceSpan:end-start,
            error:${side === "editor"}?Math.abs(p.scrollTop-top):Math.abs(s.scrollTop-start)};
        })()`);
        check(`${side} keeps a one-line image source at its corresponding tall image`,
          image.height > 700 && image.sourceSpan === 0 && image.error < 36, image);
      }
      await exec("viewer.querySelector('img[alt=\"Small\"]').style.margin='0';true");
      await settle();
      const shortInline = await exec(`(async()=>{
        const o=window.__scrollOracle,s=markdownEditor,p=viewer,img=p.querySelector('img[alt="Small"]');
        const top=o.sourceTop('Prelude. ![Small](short.svg) Tail.');
        s.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));s.scrollTop=top;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const r=img.getBoundingClientRect(),v=p.getBoundingClientRect();
        return {height:r.height,sourceSpan:o.sourceTop('Tail.')-top,
          boundaryDelta:Math.abs(r.top-img.closest('p').getBoundingClientRect().top),
          error:Math.abs((r.top-v.top)/scrollerScale(p))};
      })()`);
      check("editor aligns a short inline image before its adjacent prose",
        shortInline.height > 700 && shortInline.sourceSpan === 0 &&
        shortInline.boundaryDelta < .1 && shortInline.error < 36, shortInline);
      await exec("viewer.querySelector('img[alt=\"Hidden\"]').style.margin='0';true");
      await settle();
      const hiddenPrefix = await exec(`(async()=>{
        const o=window.__scrollOracle,s=markdownEditor,p=viewer,img=p.querySelector('img[alt="Hidden"]');
        s.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
        s.scrollTop=o.sourceTop('![Hidden](short.svg)');
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const r=img.getBoundingClientRect(),v=p.getBoundingClientRect();
        return {height:r.height,emptyLink:img.closest('p').querySelector('a')?.textContent==='',
          boundaryDelta:Math.abs(r.top-img.closest('p').getBoundingClientRect().top),
          error:Math.abs((r.top-v.top)/scrollerScale(p))};
      })()`);
      check("editor keeps an image edge after hidden empty-link syntax",
        hiddenPrefix.height > 700 && hiddenPrefix.emptyLink &&
        hiddenPrefix.boundaryDelta < .1 && hiddenPrefix.error < 36, hiddenPrefix);
    }

    if (scenario("input")) {
      await correspondence("editor", "Middle paragraph 25.", "editor long-section return aligns content");
      const originalState = await exec(`(() => {
        markdownEditor.focus({preventScroll:true});markdownEditor.setSelectionRange(11,23,'backward');
        return {value:markdownEditor.value,source:originalMarkdown,dirty:hasUnsavedChanges,
          history:JSON.stringify(historySnapshot()),start:markdownEditor.selectionStart,end:markdownEditor.selectionEnd,
          direction:markdownEditor.selectionDirection,focus:document.activeElement.id};
      })()`);
      const ownership = [];
      for (const side of ["editor", "preview", "editor", "preview"]) {
        const before = await exec(`({top:(${side === "editor"}?markdownEditor:viewer).scrollTop,writes:getEditorScrollDiagnostics().writes})`);
        await nativeWheel(side, -100);
        ownership.push({ side, before, after: await exec(`({top:(${side === "editor"}?markdownEditor:viewer).scrollTop,...getEditorScrollDiagnostics()})`) });
      }
      check("native wheel reversals immediately give the directly scrolled pane ownership",
        ownership.every(row => row.after.owner === row.side && row.after.top > row.before.top + 5 &&
          row.after.writes > row.before.writes), ownership);
      const preserved = await exec(`({value:markdownEditor.value,source:originalMarkdown,dirty:hasUnsavedChanges,
        history:JSON.stringify(historySnapshot()),start:markdownEditor.selectionStart,end:markdownEditor.selectionEnd,
        direction:markdownEditor.selectionDirection,focus:document.activeElement.id})`);
      check("scroll-only actions preserve exact text selection focus undo and dirty state",
        JSON.stringify(originalState) === JSON.stringify(preserved), { originalState: { ...originalState, value: undefined, source: undefined }, preserved: { ...preserved, value: undefined, source: undefined } });
      const idleBefore = await exec("getEditorScrollDiagnostics()");
      await sleep(700);
      const idleAfter = await exec("getEditorScrollDiagnostics()");
      check("follower events settle without feedback bounce or an idle write loop",
        idleAfter.writes === idleBefore.writes && idleAfter.scrolls === idleBefore.scrolls, { idleBefore, idleAfter });
      await correspondence("editor", "Middle paragraph 10.", "scrollbar drag starts at a matching content landmark");
      const thumb = await exec(`(() => {
        const e=markdownEditor,r=e.getBoundingClientRect(),track=e.clientHeight;
        const height=Math.max(20,track*track/e.scrollHeight);
        return {x:Math.round(r.right-6),y:Math.round(r.top+(track-height)*e.scrollTop/(e.scrollHeight-e.clientHeight)+height/2)};
      })()`);
      const beforeDrag = await exec("markdownEditor.scrollTop");
      win.webContents.sendInputEvent({ type: "mouseMove", ...thumb });
      win.webContents.sendInputEvent({ type: "mouseDown", ...thumb, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseMove", x: thumb.x, y: thumb.y + 8, movementY: 8 });
      win.webContents.sendInputEvent({ type: "mouseUp", x: thumb.x, y: thumb.y + 8, button: "left", clickCount: 1 });
      await settle();
      const drag = await exec(`(() => {
        const o=window.__scrollOracle;
        let text='Middle paragraph 0.';
        for(let i=0;i<35;i++)if(o.sourceTop('Middle paragraph '+i+'.')<=markdownEditor.scrollTop+1)text='Middle paragraph '+i+'.';
        const p=[...viewer.querySelectorAll('p')].find(p=>p.textContent.startsWith(text));
        const r=p.getBoundingClientRect(),v=viewer.getBoundingClientRect();
        return {text,top:markdownEditor.scrollTop,owner:getEditorScrollDiagnostics().owner,
          previewTop:(r.top-v.top)/scrollerScale(viewer),previewBottom:(r.bottom-v.top)/scrollerScale(viewer)};
      })()`);
      check("native scrollbar dragging follows the same visible content occurrence",
        drag.top > beforeDrag + 30 && drag.owner === "editor" && drag.previewTop < 36 && drag.previewBottom > -36, drag);
      await correspondence("preview", "Middle paragraph 10.", "keyboard setup leaves the preview as scroll owner");
      await exec("markdownEditor.focus({preventScroll:true});markdownEditor.setSelectionRange(markdownEditor.value.indexOf('Middle paragraph 10.'),markdownEditor.value.indexOf('Middle paragraph 10.'));true");
      await settle();
      const keyboardBefore = await exec("({top:markdownEditor.scrollTop,writes:getEditorScrollDiagnostics().writes})");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "PageDown" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "PageDown" });
      await settle();
      const keyboardAfter = await exec("({top:markdownEditor.scrollTop,...getEditorScrollDiagnostics()})");
      check("native keyboard scrolling transfers ownership and moves the follower",
        keyboardAfter.owner === "editor" && keyboardAfter.top > keyboardBefore.top + 100 &&
        keyboardAfter.writes > keyboardBefore.writes, { keyboardBefore, keyboardAfter });
      await exec(`(() => {
        const p=viewer.querySelector('pre:not(.mermaid)'),code=p.querySelector('code');
        p.style.cssText+=';overflow:auto;max-height:120px;overscroll-behavior:auto';code.style.cssText+=';display:block;width:3000px';
        return true;
      })()`);
      await settle();
      const independent = await exec(`(async()=>{
        const before={editor:markdownEditor.scrollTop,preview:viewer.scrollTop,owner:getEditorScrollDiagnostics().owner};
        const p=viewer.querySelector('pre:not(.mermaid)');
        p.dispatchEvent(new WheelEvent('wheel',{deltaX:90,deltaY:0,bubbles:true}));p.scrollLeft=90;
        p.dispatchEvent(new WheelEvent('wheel',{deltaY:90,bubbles:true}));p.scrollTop=90;
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        return {before,after:{editor:markdownEditor.scrollTop,preview:viewer.scrollTop,
          owner:getEditorScrollDiagnostics().owner},left:p.scrollLeft,top:p.scrollTop,
          overflows:p.scrollWidth>p.clientWidth&&p.scrollHeight>p.clientHeight};
      })()`);
      check("horizontal and nested vertical scrollports remain independent",
        independent.overflows && Math.abs(independent.left - 90) < 1 && Math.abs(independent.top - 90) < 1 &&
        JSON.stringify(independent.before) === JSON.stringify(independent.after), independent);
      for (const bottom of [true, false]) {
        await exec(`(() => {
          const p=viewer.querySelector('pre:not(.mermaid)'),r=p.getBoundingClientRect(),v=viewer.getBoundingClientRect();
          p.scrollTop=${bottom ? "p.scrollHeight" : "0"};
          viewer.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
          viewer.scrollTop+=(r.top-v.top)/scrollerScale(viewer)-60;return true;
        })()`);
        await settle();
        await exec("markdownEditor.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));true");
        const before = await exec("({editor:markdownEditor.scrollTop,preview:viewer.scrollTop,owner:getEditorScrollDiagnostics().owner})");
        await nativeWheel("preview", bottom ? -70 : 70, "pre:not(.mermaid)");
        const after = await exec("({editor:markdownEditor.scrollTop,preview:viewer.scrollTop,...getEditorScrollDiagnostics()})");
        check(`native wheel chaining at the nested ${bottom ? "bottom" : "top"} follows direct preview intent`,
          before.owner === "editor" && after.owner === "preview" &&
          (after.preview - before.preview) * (bottom ? 1 : -1) > 5 &&
          (after.editor - before.editor) * (bottom ? 1 : -1) > 5, { before, after });
      }
      for (const behavior of ["contain", "none"]) {
        await exec(`(() => {
          const p=viewer.querySelector('pre:not(.mermaid)');
          p.style.overscrollBehavior=${JSON.stringify(behavior)};p.scrollTop=p.scrollHeight;
          markdownEditor.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));return true;
        })()`);
        await settle();
        const before = await exec("({editor:markdownEditor.scrollTop,preview:viewer.scrollTop,owner:getEditorScrollDiagnostics().owner})");
        await nativeWheel("preview", -70, "pre:not(.mermaid)");
        const after = await exec("({editor:markdownEditor.scrollTop,preview:viewer.scrollTop,owner:getEditorScrollDiagnostics().owner})");
        check(`nested overscroll ${behavior} preserves outer position and ownership`,
          before.owner === "editor" && JSON.stringify(before) === JSON.stringify(after), { before, after });
      }
      await exec("viewer.querySelector('pre:not(.mermaid)').removeAttribute('style');viewer.querySelector('pre:not(.mermaid) code').removeAttribute('style');true");
      await settle();
    }

    if (scenario("layout")) {
      await correspondence("editor", "Middle paragraph 25.", "stationary editor owns the late image setup");
      const lateBefore = await exec("({editor:markdownEditor.scrollTop,height:viewer.querySelector('#scroll-image').getBoundingClientRect().height,builds:getEditorScrollDiagnostics().builds})");
      await exec(`(() => {
        const img=viewer.querySelector('#scroll-image');window.__scrollImageLoaded=false;
        img.addEventListener('load',()=>{img.removeAttribute('height');window.__scrollImageLoaded=true;},{once:true});
        img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="2200"><rect width="300" height="2200" fill="#4f7d92"/></svg>');
        return true;
      })()`);
      await wait("late real image", "window.__scrollImageLoaded&&viewer.querySelector('#scroll-image').naturalHeight===2200");
      await settle();
      const lateAfter = await exec("({editor:markdownEditor.scrollTop,height:viewer.querySelector('#scroll-image').getBoundingClientRect().height,builds:getEditorScrollDiagnostics().builds,state:window.__scrollOracle.state('Middle paragraph 25.')})");
      check("late image sizing rebuilds correspondence without moving the editor driver",
        lateAfter.height > lateBefore.height + 500 && Math.abs(lateAfter.editor - lateBefore.editor) < 1 &&
        lateAfter.state.error < 36 && lateAfter.builds > lateBefore.builds, { lateBefore, lateAfter });
      await correspondence("editor", "Middle paragraph 15.", "editor correspondence follows freshly resized image");

      await exec("zoomLevel=160;updateZoom();true");
      await settle();
      await correspondence("editor", "After table landmark.", "editor correspondence survives reading zoom");
      await correspondence("preview", "Middle paragraph 10.", "preview correspondence survives reading zoom");
      await exec("applyEditorSplitRatio(.35);applyTableBreakout();setIndexVisible(true);true");
      await settle();
      await correspondence("editor", "Middle paragraph 25.", "editor correspondence survives splitter and TOC resize");
      await correspondence("preview", "Middle paragraph 10.", "preview correspondence survives splitter and TOC resize");
      await exec("zoomLevel=100;updateZoom();applyEditorSplitRatio(.5);setIndexVisible(false);true");
      await settle();
    }

    if (scenario("edits")) {
      const beforeEdit = await exec("markdownEditor.value");
      await exec(`(() => {
        markdownEditor.value='# Inserted heading\\n\\nInserted prose above all reused blocks.\\n\\n'+markdownEditor.value;
        markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));
        markdownEditor.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
        markdownEditor.scrollTop=window.__scrollOracle.sourceTop('Middle paragraph 25.');
        return true;
      })()`);
      const stale = await exec("({diagnostics:getEditorScrollDiagnostics(),preview:viewer.scrollTop})");
      await frames();
      check("new editor input suspends mapping while the preview still holds old source",
        stale.diagnostics.pendingSource && !stale.diagnostics.ready &&
        Math.abs(await exec("viewer.scrollTop") - stale.preview) < 1, stale);
      await wait("current edited preview and geometry", "viewer.querySelector('h1')?.textContent==='Inserted heading'&&getEditorScrollDiagnostics().ready");
      await correspondence("editor", "Repeated identical paragraph.", "insertion updates the source position of reused repeated blocks", 2);
      const edited = await exec("markdownEditor.value");
      await exec(`historyRestore({undo:[${JSON.stringify(beforeEdit)}],redo:[]});clearTimeout(historyDebounceTimer);historyUndo();true`);
      await wait("undo geometry", "viewer.querySelector('h1')?.textContent==='Scroll correspondence'&&getEditorScrollDiagnostics().ready");
      await correspondence("preview", "Middle paragraph 25.", "undo rebuilds mapping for the restored source");
      await exec("historyRedo();true");
      await wait("redo geometry", "viewer.querySelector('h1')?.textContent==='Inserted heading'&&getEditorScrollDiagnostics().ready");
      check("redo restores the exact edited body through the real history path", await exec(`markdownEditor.value===${JSON.stringify(edited)}`));
      await correspondence("editor", "Middle paragraph 25.", "redo rebuilds mapping for the edited source");
      await exec(`markdownEditor.value=${JSON.stringify(beforeEdit)};markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true`);
      await wait("clean original preview", "viewer.querySelector('h1')?.textContent==='Scroll correspondence'&&getEditorScrollDiagnostics().ready&&!hasUnsavedChanges");
    }

    if (scenario("cost")) {
      const cost = await exec(`(async()=>{
        const before=getEditorScrollDiagnostics(),rect=Range.prototype.getBoundingClientRect;
        let rangeReads=0;Range.prototype.getBoundingClientRect=function(...args){rangeReads++;return rect.apply(this,args);};
        try {
          for(let i=0;i<40;i++){
            const pane=i%2?viewer:markdownEditor;
            pane.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
            pane.scrollTop=(pane.scrollHeight-pane.clientHeight)*((i%9)+1)/11;
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          }
          return {before,after:getEditorScrollDiagnostics(),rangeReads};
        }finally{Range.prototype.getBoundingClientRect=rect;}
      })()`);
      receipt.scrollCost = cost;
      const samples = cost.after.callbacks.slice(-40).sort((a, b) => a - b);
      check("settled scrolling uses cached geometry without rebuilding or source range reads",
        cost.after.builds === cost.before.builds && cost.rangeReads === 0, cost);
      check("settled sync callback p95 stays within the fixed four millisecond budget",
        samples.length >= 30 && samples[Math.ceil(samples.length * .95) - 1] <= 4, samples);
      check("scroll writes remain bounded by driver frames rather than echo events",
        cost.after.writes - cost.before.writes >= 30 && cost.after.writes - cost.before.writes <= 42 &&
        cost.after.scrolls - cost.before.scrolls >= 30 && cost.after.scrolls - cost.before.scrolls <= 42, cost);
    }
    if (scenario("transitions")) {
      const endpoint = [];
      for (const side of ["editor", "preview"]) for (const end of [true, false]) {
        await exec(`(() => {const p=${side === "editor"}?markdownEditor:viewer;
          p.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));
          p.scrollTop=${end ? "p.scrollHeight" : "0"};return true;})()`);
        await settle();
        endpoint.push(await exec(`({editor:markdownEditor.scrollTop,preview:viewer.scrollTop,
          editorMax:markdownEditor.scrollHeight-markdownEditor.clientHeight,previewMax:viewer.scrollHeight-viewer.clientHeight,end:${end}})`));
      }
      check("both genuine document endpoints align in both directions",
        endpoint.every(row => row.end ? Math.abs(row.editor - row.editorMax) < 1 && Math.abs(row.preview - row.previewMax) < 1 :
          row.editor < 1 && row.preview < 1), endpoint);
      await mode(false);
      const hiddenTop = await exec("markdownEditor.scrollTop");
      await exec("contentWrapper.scrollTop=1200;true");
      await settle();
      check("normal reading leaves the hidden editor independent", await exec(`markdownEditor.scrollTop===${hiddenTop}&&!getEditorScrollDiagnostics().ready`));
      await mode(true);
      await wait("mode reentry", "getEditorScrollDiagnostics().ready");
      await correspondence("preview", "Middle paragraph 25.", "mode reentry uses current source correspondence");
      await open(second, "Short document");
      check("a newly opened document does not inherit another document's editor",
        await exec("!isEditMode&&!getEditorScrollDiagnostics().ready"));
      await mode(true);
      check("short document retires old mapping without inventing scroll travel",
        await exec("markdownEditor.value.includes('Short body.')&&markdownEditor.scrollTop===0&&viewer.scrollTop===0&&markdownEditor.scrollHeight<=markdownEditor.clientHeight&&viewer.scrollHeight<=viewer.clientHeight"));
      await open(first, "Scroll correspondence");
      check("tab return really has an armed bounded restore before editor input",
        await exec("window.CustomTabs.__scrollRestorePending()"));
      await nativeWheel("editor", -150);
      check("editor wheel retires the outstanding tab restore immediately",
        await exec("!window.CustomTabs.__scrollRestorePending()"));
      const restorePosition = await exec("markdownEditor.scrollTop");
      await sleep(1300);
      const restored = await exec("({editor:markdownEditor.scrollTop,owner:getEditorScrollDiagnostics().owner})");
      check("editor input cancels the old tab restoration window", restorePosition > 0 &&
        restored.owner === "editor" && Math.abs(restored.editor - restorePosition) < 1, restored);
      await correspondence("editor", "After diagram landmark.", "tab return maps the admitted document not the previous short tab");
      await capture("final-editor-after-diagram");
      await open(syntax, "Syntax correspondence");
      await mode(true);
      await wait("syntax correspondence geometry", "getEditorScrollDiagnostics().ready");
      const syntaxSetup = await exec("({first:markdownEditor.value.charCodeAt(0),cr:markdownEditor.value.includes('\\r'),emoji:viewer.textContent.includes('⭐'),link:!!viewer.querySelector('a'),sandbox:viewer.querySelector('iframe.raw-html-block')?.getAttribute('sandbox')})");
      check("syntax fixture retains normalized CRLF emoji links and sandboxed raw HTML",
        fs.readFileSync(syntax, "utf8").charCodeAt(0) === 0xFEFF && !syntaxSetup.cr &&
        syntaxSetup.emoji && syntaxSetup.link && syntaxSetup.sandbox === "allow-scripts", syntaxSetup);
      for (const side of ["editor", "preview"]) {
        await correspondence(side, "Syntax tail 10.", `${side} preserves provenance through BOM CRLF emoji and raw HTML transforms`);
        await correspondence(side, "List item 18.", `${side} follows individual list items after raw HTML`);
      }
      check("temporary mapping attributes never remain in the preview or its block hashes",
        await exec("!viewer.querySelector('[data-folia-scroll]')&&[...viewer.querySelectorAll('[data-block-hash]')].every(e=>!e.dataset.blockHash.includes('data-folia-scroll'))"));
      await mode(false);
      await open(first, "Scroll correspondence");
      await mode(true);
      await exec("setIndexVisible(true);true");
      await settle();
      await exec(`(() => {
        window.__tocCompletion={sequence:fileOpenSequence,generation:renderGeneration,
          heading:viewer.querySelector('h1'),source:originalMarkdown,path:currentFilePath,progress:false};
        const w=window.__tocCompletion;
        w.moved=event=>{if(event.target===viewer&&event.isTrusted)w.progress=true;};
        w.ended=event=>{if(event.target===viewer&&event.isTrusted)w.completed=true;};
        viewer.addEventListener('scroll',w.moved);viewer.addEventListener('scrollend',w.ended,{once:true});
        return true;
      })()`);
      await nativeClick("#indexList .index-item");
      await wait("TOC native completion and current-source geometry", `(() => {
        const w=window.__tocCompletion,d=getEditorScrollDiagnostics();
        return w.completed&&d.ready&&!d.pendingGeometry&&d.matchesSource&&d.selection===d.mappedSelection;
      })()`);
      const tocCompletion = await exec(`(() => {const w=window.__tocCompletion;
        viewer.removeEventListener('scroll',w.moved);viewer.removeEventListener('scrollend',w.ended);
        return {progress:w.progress,current:w.sequence===fileOpenSequence&&w.generation===renderGeneration&&
          w.heading.isConnected&&w.heading===viewer.querySelector('h1')&&w.source===originalMarkdown&&
          w.source===markdownEditor.value&&w.path===currentFilePath};})()`);
      const tocNavigation = await exec("({owner:getEditorScrollDiagnostics().owner,top:viewer.scrollTop,sourceHeading:window.__scrollOracle.sourceTop('# Scroll correspondence')-markdownEditor.scrollTop,previewHeading:(viewer.querySelector('h1').getBoundingClientRect().top-viewer.getBoundingClientRect().top)/scrollerScale(viewer)})");
      check("TOC navigation completes real preview travel for the same admitted heading",
        tocCompletion.progress && tocCompletion.current, tocCompletion);
      check("TOC navigation takes preview ownership without an old editor frame undoing the jump",
        tocNavigation.owner === "preview" && tocNavigation.top < 120 &&
        Math.abs(tocNavigation.sourceHeading) < 36 && Math.abs(tocNavigation.previewHeading) < 36, tocNavigation);
      await restorationNavigation();
      await exec("indexList.querySelector('.index-item').click();true");
      await wait("TOC cleanup destination", "viewer.scrollTop<120&&getEditorScrollDiagnostics().ready&&!getEditorScrollDiagnostics().pendingGeometry");
      await exec("viewer.querySelector('h1').click();true");
      await settle();
      await exec("markdownEditor.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true}));markdownEditor.scrollTop=2000;true");
      await settle();
      check("collapsed content maps to its visible boundary without expanding sections",
        await exec("viewer.querySelector('.collapsible-section')?.classList.contains('collapsed')&&viewer.scrollTop===0"));
      await exec("viewer.querySelector('h1').click();true");
      await settle();
      await correspondence("preview", "After diagram landmark.", "expanding a section refreshes its source correspondence");
      const refused = await exec(`(() => {
        const snapshot=()=>({value:markdownEditor.value,source:originalMarkdown,path:currentFilePath,
          edit:isEditMode,history:JSON.stringify(historySnapshot()),dirty:hasUnsavedChanges,
          start:markdownEditor.selectionStart,end:markdownEditor.selectionEnd,
          direction:markdownEditor.selectionDirection,sequence:fileOpenSequence,
          generation:renderGeneration,editor:markdownEditor.scrollTop,preview:viewer.scrollTop});
        markdownEditor.setSelectionRange(17,31,'backward');
        const before=snapshot();
        const result=beginFileOpen({path:${JSON.stringify(second)},content:'# Rejected incoming\\n\\nWrong source.'},
          {ownerTabId:Number.MAX_SAFE_INTEGER,source:'editor-scroll-admission-refusal'});
        return {refused:result===null,before,after:snapshot(),diagnostics:getEditorScrollDiagnostics()};
      })()`);
      check("a refused incoming owner restores the live editor history selection source and scroll map",
        refused.refused && JSON.stringify(refused.before) === JSON.stringify(refused.after) &&
        refused.diagnostics.ready && refused.diagnostics.matchesSource, refused);
      await correspondence("editor", "Middle paragraph 25.", "editor correspondence survives refused document admission");
      await correspondence("preview", "Middle paragraph 10.", "preview correspondence survives refused document admission");
    }
    if (scenario("save")) {
      await exec("markdownEditor.value+='\\n\\nSaved scrolling witness.\\n';markdownEditor.dispatchEvent(new Event('input',{bubbles:true}));true");
      await wait("edited source before saving", "getEditorScrollDiagnostics().ready&&hasUnsavedChanges");
      const saveBefore = await exec("({watcher:activeFileSelectionGeneration,render:renderGeneration,value:markdownEditor.value})");
      await exec("saveButton.click();true");
      await wait("real save result", "!hasPendingSaveFor(currentFilePath)&&!hasUnsavedChanges");
      const saveAfter = await exec("({watcher:activeFileSelectionGeneration,render:renderGeneration,...getEditorScrollDiagnostics()})");
      check("save setup writes the edited fixture and resumes watching without another render",
        fs.readFileSync(first, "utf8") === saveBefore.value && saveAfter.watcher > saveBefore.watcher &&
        saveAfter.render === saveBefore.render, { saveBefore: { ...saveBefore, value: undefined }, saveAfter });
      check("successful save keeps the committed scroll geometry ready", saveAfter.ready, saveAfter);
      await correspondence("editor", "Middle paragraph 20.", "editor correspondence survives successful save");
      await correspondence("preview", "Middle paragraph 10.", "preview correspondence survives successful save");
    }
    if (scenario("rich")) {
      await open(rich, "Rich inline correspondence");
      await mode(true);
      await wait("rich inline images", "viewer.querySelectorAll('blockquote img').length===1&&viewer.querySelectorAll('li img').length===1&&[...viewer.querySelectorAll('img')].every(img=>img.complete&&img.naturalHeight===1600)");
      await exec("applyEditorSplitRatio(.32);applyTableBreakout();true");
      await settle();
      check("rich fixture has wrapped hidden syntax and prefix-stripped nested media",
        await exec("markdownEditor.value.includes('hidden-destination-'.repeat(400))&&viewer.querySelector('a')?.textContent==='Compact link'&&viewer.querySelector('blockquote img').getBoundingClientRect().height>700&&viewer.querySelector('li img').getBoundingClientRect().height>700&&viewer.clientWidth>markdownEditor.clientWidth*1.8"));
      for (const direction of ["editor", "preview"]) {
        await correspondence(direction, "Hidden destination sentence 40.", `${direction} aligns prose after a long hidden link destination`, 0, true);
        await correspondence(direction, "Uneven sentence 60.", `${direction} aligns uneven wrapping inside one source paragraph`, 0, true);
        await correspondence(direction, "Quoted after image 10.", `${direction} aligns nested quote content after a tall image`);
        await correspondence(direction, "List after image 10.", `${direction} aligns nested list content after a tall image`);
        await correspondence(direction, "Inline syntax sentence 45.", `${direction} preserves inline entities escapes repeated link labels and code`, 0, true);
        await correspondence(direction, "Task quote sentence 20.", `${direction} preserves checked task and nested quote provenance`, 0, true);
      }
      check("rich inline mapping verifies all parser transformations without a fallback",
        await exec("getEditorScrollDiagnostics().mappingWarnings.length===0"),
        await exec("getEditorScrollDiagnostics().mappingWarnings"));
      await capture("rich-inline-correspondence");
      await exec("applyEditorSplitRatio(.5);applyTableBreakout();true");
      await settle();
    }
    if (scenario("html")) {
      const cases = [
        ["svg", 'Before <svg width="120" height="80"><text x="0" y="30">SVG label</text></svg> after.'],
        ["math", 'Before <math><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow></math> after.'],
        ["textarea", '<textarea>\nInitial line\nSecond line</textarea>'],
        ["textarea-inline", 'Before <textarea>\nInitial line\nSecond line</textarea> after.'],
        ["pre", '<pre>\nInitial line\nSecond line</pre>'],
        ["select", 'Before <select><option>First option</option><option>Second option</option></select> after.'],
        ["table", '<table>Fostered text<tr><td>Table cell</td></tr></table>'],
        ["template", '<template><div>Template text</div><svg><text>Hidden label</text></svg></template>'],
        ["formatting", '<b><i>Recovered formatting</b> following text</i>'],
        ["removed", 'Before <script>window.__unexpectedScrollScript=true</script> after.'],
        ["xmp", '<xmp>\nOpaque raw text\n\nLiteral **source**</xmp>'],
        ["plaintext", '<plaintext>\nLiteral raw text **source**'],
        ["authored-attribute", '<div data-folia-scroll="authored-value">Authored attribute</div>'],
      ];
      for (const [name, body] of cases) {
        const text = `# HTML correspondence ${name}\n\n` +
          "Repeated transport paragraph.\n\n" + body + "\n\n" +
          "Repeated transport paragraph.\n\n" +
          Array.from({ length: 18 }, (_, i) => `Verified tail ${i}. ` + "A separate source occurrence. ".repeat(15)).join("\n\n");
        const file = path.join(directory, `html-${name}.md`);
        fs.writeFileSync(file, text);
        await open(file, `HTML correspondence ${name}`);
        for (const edit of [false, true]) {
          await mode(edit);
          for (const forceMode of ["full", "light-format"]) {
            const value = await exec(`(async()=>{
              const content=${JSON.stringify(text)};
              const prepared=editorScroll.source(content);prepared.prepare(parseEmojis);
              const canonical=sanitizeHtml(marked.parse(prepared.text));
              const expected=document.createElement('template');expected.innerHTML=canonical;
              const patch=patchViewerDOM;
              let observed=null;
              patchViewerDOM=function(html,source){
                const detach=source.detach;
                source.detach=function(root,sanitize){
                  const before=root.cloneNode(true),bindings=detach.call(this,root,sanitize);
                  const same=(a,b)=>a.isEqualNode(b)&&[...a.querySelectorAll('template')].every((t,i)=>
                    same(t.content,b.querySelectorAll('template')[i].content));
                  observed={canonical:html===canonical,untouched:same(root,before),
                    svg:root.querySelector('svg text')?.textContent,
                    textarea:root.querySelector('textarea')?.value,
                    expectedTextarea:expected.content.querySelector('textarea')?.value,
                    hasNonce:root.innerHTML.includes(this.nonce)};
                  return bindings;
                };
                try{return patch(html,source);}finally{source.detach=detach;}
              };
              try{await renderMarkdown(content,${JSON.stringify(forceMode)});}
              finally{patchViewerDOM=patch;}
              return {...observed,script:window.__unexpectedScrollScript===true,
                warnings:getEditorScrollDiagnostics().mappingWarnings};
            })()`);
            check(`${edit ? "edit" : "reading"} ${forceMode} preserves canonical ${name} HTML without mapping mutations`,
              value.canonical && value.untouched && !value.hasNonce && !value.script &&
              (name !== "svg" || value.svg === "SVG label") &&
              (!name.startsWith("textarea") || (value.textarea === value.expectedTextarea &&
                value.textarea.includes("Initial line") && value.textarea.includes("Second line"))), value);
          }
        }
        if (name === "svg" || name === "textarea" || name === "table" || name === "formatting") {
          await wait("verified HTML tail geometry", "getEditorScrollDiagnostics().ready&&!getEditorScrollDiagnostics().pendingGeometry");
          for (const side of ["editor", "preview"]) {
            await correspondence(side, "Verified tail 10.", `${side} retains precise ordinary content after opaque ${name}`);
            await correspondence(side, "Repeated transport paragraph.", `${side} retains the correct repeated occurrence around ${name}`, 1);
          }
        }
      }
      await open(first, "Scroll correspondence");
      await mode(true);
    }
    if (scenario("mapping")) {
      const guard = await exec(`(() => {
        const cases=['control','mismatch','duplicate','owner','order'];
        return cases.map(kind=>{
          const source=editorScroll.source('# Guard mapping\\n\\nsame<em>same</em>\\n\\nsame<em>same</em>');
          const root=document.createElement('div');root.innerHTML=sanitizeHtml(source.parse(marked));
          const before=root.cloneNode(true),copy=document.createElement('template');
          copy.innerHTML=source.mappingHtml;
          const leaves=[...copy.content.querySelectorAll('['+source.attribute+']')].filter(node=>{
            const id=Number(node.getAttribute(source.attribute).split(':')[1]);
            return source.descriptors[id]?.kind==='text'&&node.textContent==='same';
          });
          const ids=leaves.map(node=>Number(node.getAttribute(source.attribute).split(':')[1]));
          if(kind==='mismatch')source.mappingHtml=source.mappingHtml.replace('Guard mapping','Wrong mapping');
          if(kind==='duplicate'){
            leaves[0].setAttribute(source.attribute,leaves[1].getAttribute(source.attribute));
            source.mappingHtml=copy.innerHTML;
          }
          if(kind==='owner')source.descriptors[ids[0]]={...source.descriptors[ids[2]]};
          if(kind==='order'){
            const first=source.descriptors[ids[0]];
            source.descriptors[ids[0]]=source.descriptors[ids[1]];
            source.descriptors[ids[1]]=first;
          }
          if(kind!=='control'){const rejected=source.mappingHtml;source.renderMapping=()=>rejected;}
          const bindings=source.detach(root,sanitizeHtml);
          for(const child of root.children)source.adopt(child,child,bindings);
          return {kind,leaves:leaves.length,unchanged:root.isEqualNode(before),
            bindings:source.bindings.length,groups:source.textGroups.length,warnings:[...source.warnings]};
        });
      })()`);
      check("mapping rejection controls really contain independently owned repeated text leaves",
        guard.every(value => value.leaves === 4 && value.unchanged), guard);
      check("verified mapping accepts the unchanged repeated-content control",
        guard[0].bindings >= 3 && guard[0].groups === 3 && guard[0].warnings.length === 0, guard[0]);
      for (const value of guard.slice(1)) {
        check(`mapping rejects ${value.kind} metadata instead of retargeting repeated source occurrences`,
          value.bindings === 0 && value.groups === 0 &&
          value.warnings.includes("unverified authored HTML structure"), value);
      }
      const inert = await exec(`(() => {
        const source=editorScroll.source('# Inert metadata\\n\\nA metadata resource boundary.');
        const root=document.createElement('div');root.innerHTML=sanitizeHtml(source.parse(marked));
        const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML'),reads=[];
        Object.defineProperty(Element.prototype,'innerHTML',{...descriptor,set(value){
          if(typeof value==='string'&&value.includes(source.nonce))reads.push(this.ownerDocument!==document);
          descriptor.set.call(this,value);
        }});
        try{source.detach(root,sanitizeHtml);}finally{
          Object.defineProperty(Element.prototype,'innerHTML',descriptor);
        }
        return reads;
      })()`);
      check("mapping HTML is parsed only in an inert document rather than a live resource context",
        inert.length > 0 && inert.every(Boolean), inert);
      const opaque = await exec(`(() => {
        const source=editorScroll.source('# Opaque roots\\n\\n<div>First root</div><div>Second root</div>\\n\\nOrdinary tail.');
        const root=document.createElement('div');root.innerHTML=sanitizeHtml(source.parse(marked));
        const bindings=source.detach(root,sanitizeHtml);
        for(const child of root.children)source.adopt(child,child,bindings);
        return {roots:root.querySelectorAll('div').length,
          ordinary:source.bindings.filter(binding=>binding.kind!=='html').length,
          html:source.bindings.filter(binding=>binding.kind==='html').length,warnings:[...source.warnings]};
      })()`);
      check("a multi-root opaque HTML token never assigns its entire source to the first surviving element",
        opaque.roots === 2 && opaque.ordinary >= 2 && opaque.html === 0 &&
        opaque.warnings.includes("opaque multi-root HTML block"), opaque);
      const dollarBody = "flowchart TD\n A[\"$& $" + String.fromCharCode(96) + " $' $$\"]";
      const placeholders = await exec(`(() => {
        const body=${JSON.stringify(dollarBody)};
        return [false,true].map(unwrap=>{
          const input='# Literal restoration\\n\\n'+String.fromCharCode(96).repeat(3)+'mermaid\\n'+body+
            '\\n'+String.fromCharCode(96).repeat(3)+'\\n\\nRestoration tail.';
          const source=editorScroll.source(input),blocks=createBlockPlaceholders('MERMAID_BLOCK_');
          source.replaceSpecial('mermaid',/\`\`\`mermaid\\n([\\s\\S]*?)\`\`\`/g,
            (match,code)=>blocks.take(code));
          let builds=0;
          const html=source.restore(blocks,'mermaid',source.parse(marked),code=>{
            builds++;return mermaidPreMarkup(code);
          },unwrap);
          const root=document.createElement('template'),metadata=document.createElement('template');
          root.innerHTML=sanitizeHtml(html);metadata.innerHTML=sanitizeHtml(source.mappingHtml);
          return {unwrap,builds,count:blocks.count,
            canonical:root.content.querySelector('pre')?.textContent,
            metadata:metadata.content.querySelector('pre')?.textContent};
        });
      })()`);
      check("placeholder builders execute once per occurrence while metadata replays the result",
        placeholders.every(value => value.builds === 1 && value.count === 1), placeholders);
      for (const value of placeholders) for (const kind of ["canonical", "metadata"]) {
        check(`${kind} placeholder restoration keeps literal dollar sequences (${value.unwrap ? "unwrapped" : "wrapped"})`,
          value[kind] === dollarBody + "\n", value);
      }
    }
    if (scenario("bounds")) {
      const url = "https://example.invalid/" + "a".repeat(4096);
      const nested = "# Nested reference correspondence\n\n" +
        parts.slice(1, 18).join("\n\n") + "\n\n> [r]: " + url + "\n>\n> " + url + "\n>\n> Nested tail.\n\n" +
        parts.slice(-18).join("\n\n");
      const nestedFile = path.join(directory, "nested-reference.md");
      fs.writeFileSync(nestedFile, nested);
      await open(nestedFile, "Nested reference correspondence");
      await mode(true);
      const provenance = await exec(`(() => {
        const text=${JSON.stringify(nested)},url=${JSON.stringify(url)},source=editorScroll.source(text);
        const root=document.createElement('div');root.innerHTML=sanitizeHtml(source.parse(marked));
        const bindings=source.detach(root,sanitizeHtml);
        for(const child of root.children)source.adopt(child,child,bindings);
        const visible=source.bindings.find(b=>b.kind==='paragraph'&&b.element.textContent===url);
        return {actual:visible?.start,expected:text.indexOf('\\n> '+url)+3,
          count:[...viewer.querySelectorAll('blockquote p')].filter(p=>p.textContent===url).length};
      })()`);
      check("nested reference definitions cannot steal the repeated visible paragraph source",
        provenance.count === 1 && provenance.actual === provenance.expected, provenance);
      for (const side of ["editor", "preview"]) {
        await correspondence(side, url, `${side} maps the visible nested reference occurrence rather than its hidden definition`, 1, false, 0);
      }
      const lineCount = 1200;
      const physical = "# Linear physical line geometry\n\n" +
        Array.from({ length: lineCount }, (_, i) => `Physical sample ${i}. One bounded range measures this line.`).join("\n") +
        "\n\nEnding source block.";
      const physicalFile = path.join(directory, "physical-lines.md");
      fs.writeFileSync(physicalFile, physical);
      await open(physicalFile, "Linear physical line geometry");
      await mode(true);
      const work = await exec(`(async()=>{
        const before=getEditorScrollDiagnostics(),rect=Range.prototype.getBoundingClientRect,
          rects=Range.prototype.getClientRects;
        let rectangles=0,reads=0;
        Range.prototype.getBoundingClientRect=function(...args){reads++;return rect.apply(this,args);};
        Range.prototype.getClientRects=function(...args){
          const result=rects.apply(this,args);reads++;rectangles+=result.length;return result;
        };
        try{
          applyEditorSplitRatio(.4);applyTableBreakout();
          for(let i=0;i<120;i++){
            await new Promise(r=>requestAnimationFrame(r));
            if(getEditorScrollDiagnostics().builds>before.builds&&!getEditorScrollDiagnostics().pendingGeometry)break;
          }
          return {before:before.builds,after:getEditorScrollDiagnostics().builds,reads,rectangles,
            lines:viewer.querySelector('p').querySelectorAll('br').length+1};
        }finally{
          Range.prototype.getBoundingClientRect=rect;Range.prototype.getClientRects=rects;
        }
      })()`);
      receipt.physicalLineWork = work;
      check("physical-line stress setup really rebuilds an overflowing single paragraph",
        work.lines === lineCount && work.after > work.before && work.reads >= lineCount, work);
      check("physical-line rebuild geometry work grows linearly rather than enumerating paragraph suffixes",
        work.reads + work.rectangles <= 32 * lineCount, work);
      await correspondence("editor", "Physical sample 800.", "editor aligns an interior physical line after a bounded geometry rebuild");
      await correspondence("preview", "Physical sample 600.", "preview aligns an interior physical line after a bounded geometry rebuild");
      await exec("applyEditorSplitRatio(.5);applyTableBreakout();true");
      await open(first, "Scroll correspondence");
      await mode(true);
    }
  }
  const requiredScenarios = baseline || perfOnly || coreProof ? [] :
    proof ? [proof] : ["blocks", "input", "layout", "edits", "cost", "transitions", "save", "rich", "html", "mapping", "bounds", "empty", "mirror"];
  receipt.scenarios = [...executedScenarios];
  check("all required scrolling scenarios were executed",
    requiredScenarios.every(name => executedScenarios.has(name)), { requiredScenarios, executed: receipt.scenarios });
  const alive = await proveSentinelAlive(win, sentinel);
  check("scroll error sentinel detects both deliberately provoked channels", alive.console && alive.dom, alive);
  const errors = await sentinel.stop();
  check("scroll scenarios introduce no renderer or visible document errors", errors.hits.length === 0, errors.hits);
  check("scroll product source remains unchanged throughout this run", Object.entries(receipt.sources).every(([name, digest]) =>
    require("crypto").createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "src", name))).digest("hex") === digest));
}
app.whenReady().then(async () => {
  await sleep(1600);
  win = BrowserWindow.getAllWindows()[0];
  // Apply the same frame scheduling to baseline and candidate observations.
  win.webContents.setBackgroundThrottling(false);
  try { await run(); }
  catch (error) { check("scroll harness reaches completion", false, String(error.stack || error)); }
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  const summary = `=== ${results.filter(Boolean).length}/${results.length} passed ===`;
  app.once("quit", () => console.log(summary));
  app.once("will-quit", () => app.exit(results.every(Boolean) ? 0 : 1));
  app.quit();
});
setTimeout(() => { console.error("Scroll watchdog expired"); app.exit(2); }, 180000);
