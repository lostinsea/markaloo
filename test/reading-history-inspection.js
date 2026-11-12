"use strict";

const { randomUUID } = require("crypto");
const HOLD_MS = 30000;
const CLEANUP_MS = 1000;
const FLAG = "--reader-inspection-holds";
const CHECKPOINTS = ["initial", "toc-beta", "back-alpha", "forward-gamma"];

function installReaderInspection(token, checkpoint, deadline) {
  const id = "reader-inspection-controls";
  if (Date.now() >= deadline || window.__readerInspectionRetired === token ||
      window.__readerInspectionHold || document.getElementById(id)) {
    throw new Error("Reader inspection is expired or already installed");
  }
  return new Promise(resolve => {
    const panel = document.createElement("section");
    panel.id = id;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Reader inspection " + checkpoint);
    panel.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;" +
      "max-width:22rem;padding:10px;border:2px solid currentColor;background:Canvas;" +
      "color:CanvasText;font:13px system-ui";
    const text = document.createElement("p");
    text.textContent = "Reader inspection: " + checkpoint + ". Inspect the document text, loading state " +
      "and TOC. Do not scroll or navigate. Each checkpoint expires after 30 seconds. " +
      "Continue only advances; record visual observations separately.";
    panel.appendChild(text);
    let done = false;
    const buttons = [];
    const preserveFocus = event => event.preventDefault();
    const dispose = action => {
      if (done) return;
      done = true;
      for (const { button, click } of buttons) {
        button.removeEventListener("mousedown", preserveFocus);
        button.removeEventListener("click", click);
      }
      panel.remove();
      window.__readerInspectionRetired = token;
      delete window.__readerInspectionHold;
      resolve({ token, checkpoint, action, removed: true });
    };
    for (const action of ["continue", "cancel"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action === "continue" ? "Continue" : "Cancel";
      const click = event => {
        if (event.isTrusted && Date.now() < deadline) dispose(action);
      };
      button.addEventListener("mousedown", preserveFocus);
      button.addEventListener("click", click);
      buttons.push({ button, click });
      panel.appendChild(button);
    }
    window.__readerInspectionHold = { token, dispose: () => dispose("aborted") };
    document.body.appendChild(panel);
  });
}

function removeReaderInspection(token) {
  const current = window.__readerInspectionHold;
  if (current && current.token !== token) throw new Error("Reader inspection owner changed");
  // Cleanup can overtake a renderer installation that has not executed yet.
  window.__readerInspectionRetired = token;
  if (current) current.dispose();
  if (document.getElementById("reader-inspection-controls")) {
    throw new Error("Reader inspection controls were not removed");
  }
  return true;
}

class ReaderInspection {
  constructor(argv) {
    const options = argv.filter(value => value.startsWith("--reader-inspection"));
    if (options.length && (options.length !== 1 || options[0] !== FLAG)) {
      throw new Error("Reader inspection requires exactly " + FLAG);
    }
    this.enabled = options.length === 1;
    this.checkpoints = [];
    this.active = false;
  }

  async hold(owner, checkpoint) {
    if (!this.enabled || this.active || this.checkpoints.some(record => record.error) ||
        checkpoint !== CHECKPOINTS[this.checkpoints.length]) {
      throw new Error("Reader inspection is disabled, active, previously failed or out of order");
    }
    const contents = owner.webContents;
    const record = { checkpoint, token: randomUUID(), startedUtc: new Date().toISOString(),
      endedUtc: null, operatorAction: null, terminalReason: "pending", cleanup: null, error: null };
    this.checkpoints.push(record);
    this.active = true;
    let timer, cleanupTimer, failure = null, removed = false;
    const listeners = [];
    const deadline = Date.now() + HOLD_MS;
    try {
      if (owner.isDestroyed() || contents.isDestroyed()) throw new Error("Reader inspection owner is destroyed");
      const interrupted = new Promise((_, reject) => {
        const stop = reason => {
          record.terminalReason = reason;
          reject(new Error("Reader inspection " + checkpoint + ": " + reason));
        };
        timer = setTimeout(() => stop("timeout"), HOLD_MS);
        for (const [target, event, reason] of [
          [owner, "close", "window-close"], [owner, "closed", "owner-destroyed"],
          [contents, "destroyed", "contents-destroyed"],
          [contents, "render-process-gone", "renderer-gone"],
        ]) {
          const listener = eventValue => {
            if (event === "close") eventValue.preventDefault();
            stop(reason);
          };
          target.on(event, listener);
          listeners.push([target, event, listener]);
        }
      });
      const reply = await Promise.race([
        contents.executeJavaScript("(" + installReaderInspection.toString() + ")(" +
          [record.token, checkpoint, deadline].map(value => JSON.stringify(value)).join(",") + ")", true),
        interrupted,
      ]);
      if (reply?.token !== record.token || reply.checkpoint !== checkpoint || reply.removed !== true ||
          !["continue", "cancel"].includes(reply.action) || Date.now() >= deadline) {
        throw new Error("Invalid or late Reader inspection action");
      }
      removed = true;
      record.operatorAction = reply.action;
      record.terminalReason = reply.action === "continue" ? "continued" : "canceled";
      if (reply.action === "cancel") throw new Error("Reader inspection canceled at " + checkpoint);
    } catch (error) {
      failure = error;
      record.holdError = String(error.stack || error);
      if (record.terminalReason === "pending") record.terminalReason = "error";
    } finally {
      clearTimeout(timer);
      for (const [target, event, listener] of listeners) target.removeListener(event, listener);
      try {
        if (removed) record.cleanup = "removed-before-action-return";
        else if (contents.isDestroyed()) record.cleanup = "contents-destroyed";
        else {
          const cleaned = await Promise.race([
            contents.executeJavaScript("(" + removeReaderInspection.toString() + ")(" +
              JSON.stringify(record.token) + ")", true),
            new Promise((_, reject) => {
              cleanupTimer = setTimeout(() => reject(new Error("Reader inspection cleanup timed out")), CLEANUP_MS);
            }),
          ]);
          if (cleaned !== true) throw new Error("Reader inspection cleanup was not confirmed");
          record.cleanup = "removed-after-interruption";
        }
      } catch (error) {
        record.cleanup = "failed";
        record.cleanupError = String(error.stack || error);
        failure = failure ? new AggregateError([failure, error], "Reader inspection and cleanup failed") : error;
      } finally {
        clearTimeout(cleanupTimer);
        this.active = false;
        record.endedUtc = new Date().toISOString();
        record.error = failure ? String(failure.stack || failure) : null;
      }
    }
    if (failure) throw failure;
    return record;
  }
}

module.exports = { ReaderInspection, HOLD_MS, CLEANUP_MS };
