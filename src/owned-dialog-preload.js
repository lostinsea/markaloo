const { contextBridge, ipcRenderer } = require("electron");
const argument = key => process.argv.find(value => value.startsWith(key))?.slice(key.length);
const id = argument("--owned-dialog-id=");
const nonce = argument("--owned-dialog-nonce=");
let received = false;
let responded = false;
contextBridge.exposeInMainWorld("ownedDialog", Object.freeze({
  ready(present, theme) {
    if (received || typeof present !== "function" || typeof theme !== "function") return;
    received = true;
    ipcRenderer.on("owned-dialog-present", (_event, data) => {
      if (data?.id === id && !responded) present(data.options, data.themeId);
    });
    ipcRenderer.on("owned-dialog-theme", (_event, data) => {
      if (data?.id === id && !responded) theme(data.themeId);
    });
    ipcRenderer.send("owned-dialog-ready", { id, nonce });
  },
  displayed() {
    if (!responded) ipcRenderer.send("owned-dialog-displayed", { id, nonce });
  },
  failed() {
    if (responded) return;
    responded = true;
    ipcRenderer.send("owned-dialog-failed", { id, nonce });
  },
  respond(response, cause) {
    if (responded || !Number.isSafeInteger(response) || response < 0 || response > 7 ||
        !["choice", "cancel", "stale", "aborted", "pagehide", "blocked"].includes(cause)) return;
    responded = true;
    ipcRenderer.send("owned-dialog-response", { id, nonce, response, cause });
  },
}));
