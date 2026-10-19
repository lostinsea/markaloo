const { BrowserWindow, ipcMain, session } = require("electron");
const crypto = require("crypto");
const path = require("path");
const { pathToFileURL } = require("url");

const SCHEMES = new Set([
  "default-light", "default-dark", "clarity", "parchment", "abyss", "ember",
]);
const READY_MS = 10000;
const MAX_QUEUE = 8;

function ownerRendererAvailable(sender) {
  if (!sender || sender.isDestroyed() || sender.isCrashed()) return false;
  const frame = sender.mainFrame;
  return !!frame && !frame.isDestroyed() && !frame.detached;
}

// This host has no document bridge or default-session preload. Its only reply
// selects one of Main's retained buttons; the operation still validates itself.
class OwnedDialogs {
  constructor() {
    this.owners = new Map();
    this.requests = new Map();
    this.themes = new WeakMap();
    this.url = pathToFileURL(path.join(__dirname, "owned-dialog.html")).href;
    this.partition = session.fromPartition(`owned-dialogs-${crypto.randomBytes(16).toString("hex")}`);
    const resources = new Set([
      "owned-dialog.html", "owned-dialog-preload.js", "owned-dialog-renderer.js",
      "app-dialogs.js", "styles.css",
    ].map(name => pathToFileURL(path.join(__dirname, name)).href));
    for (const name of ["Regular", "Bold", "Light", "Medium", "SemiBold"]) {
      resources.add(pathToFileURL(path.join(__dirname, "..", "fonts", `FiraCode-${name}.ttf`)).href);
    }
    this.partition.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: details.resourceType === "subFrame" || !resources.has(details.url) });
    });
    this.partition.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.partition.setPermissionCheckHandler(() => false);
    this.partition.on("will-download", event => event.preventDefault());
    ipcMain.on("owned-dialog-ready", (event, data) => {
      const request = this.authenticated(event, data);
      if (!request || request.ready || !this.current(request)) return;
      request.ready = true;
      request.window.webContents.send("owned-dialog-present", {
        id: request.id, themeId: this.theme(request.owner), options: request.presentation,
      });
    });
    ipcMain.on("owned-dialog-displayed", (event, data) => {
      const request = this.authenticated(event, data);
      if (!request?.ready || request.displayed || !this.current(request)) return;
      request.displayed = true;
      clearTimeout(request.readyTimer);
      request.window.show();
      request.options.onDisplayed?.();
    });
    ipcMain.on("owned-dialog-response", (event, data) => {
      const request = this.authenticated(event, data);
      if (!request?.ready || !request.displayed ||
          !Number.isSafeInteger(data.response) || data.response < 0 ||
          data.response >= request.presentation.buttons.length ||
          !["choice", "cancel", "stale", "aborted", "pagehide", "blocked"].includes(data.cause)) return;
      const current = this.current(request);
      this.finish(request, current && data.cause === "choice" ? data.response : request.cancelId,
        false, current ? data.cause : "stale");
    });
    ipcMain.on("owned-dialog-failed", (event, data) => {
      const request = this.authenticated(event, data);
      if (request) this.finish(request, request.cancelId, true);
    });
  }

  theme(owner) { return this.themes.get(owner) || "default-light"; }

  publishTheme(owner, themeId) {
    if (!SCHEMES.has(themeId) || !owner || owner.isDestroyed()) return false;
    this.themes.set(owner, themeId);
    const active = this.owners.get(owner)?.active;
    if (active?.ready && !active.window.isDestroyed()) {
      active.window.webContents.send("owned-dialog-theme", { id: active.id, themeId });
    }
    return true;
  }

  authenticated(event, data) {
    const request = this.requests.get(data?.id);
    if (!request || request.done || data.nonce !== request.nonce ||
        !request.window || request.window.isDestroyed()) return null;
    const wc = request.window.webContents;
    return event.sender === wc && event.senderFrame === wc.mainFrame &&
      event.senderFrame.url === this.url ? request : null;
  }

  current(request) {
    try {
      return !request.owner.isDestroyed() && !request.sender.isDestroyed() &&
        request.owner.webContents === request.sender &&
        (request.options.allowUnavailableRenderer ||
          (request.sender.mainFrame === request.frame &&
            !request.frame.isDestroyed() && request.frame.url === request.ownerUrl)) &&
        !request.options.signal?.aborted &&
        (!request.options.isCurrent || request.options.isCurrent());
    } catch { return false; }
  }

  busy(owner, value) {
    try {
      if (!owner.isDestroyed() && ownerRendererAvailable(owner.webContents)) {
        owner.webContents.send("main-dialog-visibility", value);
      }
    } catch { /* Closing the owner already cancels its requests. */ }
  }

  show(owner, options) {
    const buttons = options.buttons;
    if (!Array.isArray(buttons) || !buttons.length || buttons.length > 4) {
      return Promise.resolve({ response: 0, cause: "cancel", failed: true });
    }
    const cancelId = Number.isSafeInteger(options.cancelId) &&
      options.cancelId >= 0 && options.cancelId < buttons.length ? options.cancelId : buttons.length - 1;
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) {
      return Promise.resolve({ response: cancelId, cause: "cancel", failed: true });
    }
    let state = this.owners.get(owner);
    if (state && state.queue.length + (state.active ? 1 : 0) >= MAX_QUEUE) {
      return Promise.resolve({ response: cancelId, cause: "cancel", failed: true });
    }
    if (!state) {
      state = { active: null, queue: [] };
      const sender = owner.webContents;
      const cancelRequests = retainIndependent => {
        state.cancelling = true;
        for (const pending of [state.active, ...state.queue]) {
          if (pending && !pending.done &&
              !(retainIndependent && pending.options.allowUnavailableRenderer && this.current(pending))) {
            this.finish(pending, pending.cancelId, false, "stale");
          }
        }
        state.cancelling = false;
        this.next(owner, state);
      };
      state.cancel = () => cancelRequests(false);
      // Losing the document process does not revoke a still-current Main
      // question. Navigation and destruction do revoke the whole owner queue.
      state.rendererGone = () => cancelRequests(true);
      state.removeListeners = () => {
        sender.removeListener("did-navigate", state.cancel);
        sender.removeListener("render-process-gone", state.rendererGone);
        owner.removeListener("closed", state.cancel);
      };
      // A committed reload can retain both URL and WebFrameMain identity.
      // A cancelled navigation attempt is deliberately not a lifecycle change.
      sender.on("did-navigate", state.cancel);
      sender.on("render-process-gone", state.rendererGone);
      owner.on("closed", state.cancel);
      this.owners.set(owner, state);
      this.busy(owner, true);
    }
    return new Promise(resolve => {
      const sender = owner.webContents;
      const request = {
        id: crypto.randomBytes(32).toString("hex"),
        nonce: crypto.randomBytes(32).toString("hex"),
        owner, sender,
        frame: options.allowUnavailableRenderer ? null : sender.mainFrame,
        ownerUrl: options.allowUnavailableRenderer ? null : sender.mainFrame.url,
        state, options, cancelId, resolve,
        presentation: {
          title: String(options.title || "Markaloo"),
          message: String(options.message || ""), detail: String(options.detail || ""),
          buttons: buttons.map(String),
          defaultId: Number.isSafeInteger(options.defaultId) ? options.defaultId : cancelId,
          cancelId,
        },
      };
      state.queue.push(request);
      request.abort = () => this.finish(request, cancelId, false, "aborted");
      options.signal?.addEventListener("abort", request.abort, { once: true });
      // A question has no answer deadline. This checks authority, not elapsed
      // user time, and also cleans queued requests when the owning page changes.
      request.currentTimer = setInterval(() => {
        if (!this.current(request)) this.finish(request, cancelId, false, "stale");
      }, 200);
      request.currentTimer.unref?.();
      this.next(owner, state);
    });
  }

  next(owner, state) {
    if (state.active || state.cancelling) return;
    const request = state.queue.shift();
    if (!request) {
      state.removeListeners();
      this.owners.delete(owner);
      this.busy(owner, false);
      return;
    }
    state.active = request;
    if (!this.current(request)) {
      this.finish(request, request.cancelId, false, "stale");
      return;
    }
    this.requests.set(request.id, request);
    try {
      request.window = new BrowserWindow({
        parent: owner, modal: true, show: false, frame: false,
        width: 660, height: 480, minWidth: 320, minHeight: 240,
        autoHideMenuBar: true, title: request.presentation.title,
        backgroundColor: "#242424",
        webPreferences: {
          sandbox: true, contextIsolation: true, nodeIntegration: false,
          session: this.partition,
          preload: path.join(__dirname, "owned-dialog-preload.js"),
          additionalArguments: [
            `--owned-dialog-id=${request.id}`, `--owned-dialog-nonce=${request.nonce}`,
          ],
        },
      });
      const child = request.window;
      child.setMenu(null);
      child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      child.webContents.on("will-navigate", event => event.preventDefault());
      child.webContents.on("will-frame-navigate", event => event.preventDefault());
      child.webContents.on("will-attach-webview", event => event.preventDefault());
      child.webContents.on("render-process-gone", () => this.finish(request, request.cancelId, true));
      child.on("unresponsive", () => this.finish(request, request.cancelId, true));
      child.on("closed", () => this.finish(request, request.cancelId, !request.displayed));
      request.readyTimer = setTimeout(() => this.finish(request, request.cancelId, true), READY_MS);
      child.loadFile(path.join(__dirname, "owned-dialog.html"))
        .catch(() => this.finish(request, request.cancelId, true));
    } catch {
      this.finish(request, request.cancelId, true);
    }
  }

  finish(request, response, failed = false, cause = "cancel") {
    if (request.done) return;
    request.done = true;
    clearTimeout(request.readyTimer);
    clearInterval(request.currentTimer);
    request.options.signal?.removeEventListener("abort", request.abort);
    this.requests.delete(request.id);
    const state = request.state;
    state.queue = state.queue.filter(candidate => candidate !== request);
    if (request.window && !request.window.isDestroyed()) request.window.destroy();
    const result = { response, cause, failed, displayed: !!request.displayed };
    const settle = finalResult => {
      if (state.active === request) state.active = null;
      request.resolve(finalResult);
      this.next(request.owner, state);
    };
    // Keep the owner's queue and busy indication held until an eligible
    // emergency fallback settles. The failed child is already destroyed.
    if (failed && typeof request.options.onFailure === "function") {
      Promise.resolve().then(() => request.options.onFailure(result))
        .then(settle, () => settle(result));
    } else {
      settle(result);
    }
  }
}

module.exports = { OwnedDialogs, SCHEMES, ownerRendererAvailable };
