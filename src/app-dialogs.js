(function () {
  "use strict";

  const themes = new Set([
    "default-light", "default-dark", "clarity", "parchment", "abyss", "ember",
  ]);
  const queue = [];
  let active = null;
  let blocked = false;
  let disposed = false;
  let poll = null;
  let messageSurface = null;
  const reloadRoot = document.getElementById("reloadDocumentDialog");
  const reloadSurface = reloadRoot && {
    dialog: reloadRoot,
    title: reloadRoot.querySelector("#reloadDocumentTitle"),
    name: reloadRoot.querySelector("#reloadDocumentName"),
    message: reloadRoot.querySelector("#reloadDocumentReason"),
    close: reloadRoot.querySelector("#reloadDocumentClose"),
    footer: reloadRoot.querySelector(".note-dialog-footer"),
    cancel: reloadRoot.querySelector("#reloadDocumentCancel"),
    confirm: reloadRoot.querySelector("#reloadDocumentConfirm"),
  };

  function element(tag, className, text, id) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (id) node.id = id;
    return node;
  }

  function defaultSurface() {
    if (!messageSurface) {
      const dialog = element("dialog", "note-dialog reload-document-dialog app-message-dialog", undefined, "appMessageDialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("role", "alertdialog");
      const header = element("div", "note-dialog-header");
      const title = element("h2", "", "", "appMessageTitle");
      const close = element("button", "reload-document-close", "\u00d7", "appMessageClose");
      close.type = "button";
      close.setAttribute("aria-label", "Close dialog");
      header.append(title, close);
      const body = element("div", "note-dialog-body");
      const name = element("p", "reload-document-name", "", "appMessageName");
      const message = element("p", "app-dialog-message", "", "appMessageText");
      const detail = element("p", "app-dialog-detail", "", "appMessageDetail");
      const footer = element("div", "note-dialog-footer", undefined, "appMessageButtons");
      body.append(name, message, detail);
      dialog.append(header, body, footer);
      document.body.append(dialog);
      messageSurface = { dialog, title, name, message, detail, close, footer };
    }
    return messageSurface;
  }

  function surfaceFor(spec) {
    if (spec.surface !== "reload") return defaultSurface();
    return reloadSurface;
  }

  function reportFailure(error, spec) {
    console.error("[Dialogs] Could not display message:", error);
    const host = active?.surface?.dialog || document.body;
    if (!host || disposed) return;
    let notice = host.querySelector(".app-dialog-failure");
    if (!notice) {
      notice = element("p", "app-dialog-failure");
      notice.setAttribute("role", "alert");
      host.append(notice);
    }
    notice.textContent = `A message could not be opened. ${spec.title}: ${spec.message}`;
  }

  function current(job) {
    try {
      return !disposed &&
        (!job.spec.expiresAt || Date.now() < job.spec.expiresAt) &&
        (!job.spec.isCurrent || job.spec.isCurrent() === true);
    } catch (error) {
      reportFailure(error, job.spec);
      return false;
    }
  }

  function restoreFocus(job) {
    if (blocked || disposed || queue.length) return;
    const previous = job.previousFocus;
    const restore = current(job) &&
      previous?.isConnected &&
      previous.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      !previous.closest("[inert], .file-update-toast:not(.show)")
      ? previous : document.getElementById("refreshBtn");
    restore?.focus({ preventScroll: true });
  }

  function updatePolling() {
    const needsPoll = [active, ...queue].some(job =>
      job && (job.spec.isCurrent || job.spec.expiresAt));
    if (!needsPoll && poll) {
      clearInterval(poll);
      poll = null;
    } else if (needsPoll && !poll) {
      poll = setInterval(() => {
        for (const job of [...queue]) {
          if (!current(job)) settle(job, job.spec.cancelId, "stale");
        }
        if (active && !current(active)) settle(active, active.spec.cancelId, "stale");
      }, 100);
    }
  }

  function detach(job) {
    job.listeners?.abort();
    if (job.surface?.dialog.open) job.surface.dialog.close();
  }

  function settle(job, choice, cause = "choice", error = null) {
    if (job.settled) return;
    job.settled = true;
    job.abortCleanup?.();
    const wasActive = active === job;
    if (wasActive) {
      detach(job);
      active = null;
    } else {
      const index = queue.indexOf(job);
      if (index !== -1) queue.splice(index, 1);
    }
    if (wasActive) restoreFocus(job);
    if (error) job.reject(error);
    else job.resolve(Object.freeze({ choice, cause }));
    updatePolling();
    queueMicrotask(pump);
  }

  function pump() {
    if (active || blocked || disposed) return;
    const job = queue.shift();
    if (!job) return;
    if (!current(job) || job.spec.signal?.aborted) {
      settle(job, job.spec.cancelId, job.spec.signal?.aborted ? "aborted" : "stale");
      return;
    }
    active = job;
    job.previousFocus ||= document.activeElement;
    const spec = job.spec;
    try {
      const surface = surfaceFor(spec);
      job.surface = surface;
      if (!surface || Object.values(surface).some(node => !node)) {
        throw new Error("The dialog surface is unavailable");
      }
      const { dialog, title, name, message, detail, close, footer } = surface;
      close.setAttribute("aria-label", spec.buttons.find(button => button.id === spec.cancelId).label);
      dialog.setAttribute("role", "alertdialog");
      dialog.dataset.dialogTitle = spec.title;
      title.textContent = spec.title;
      name.textContent = spec.fileName || "";
      name.hidden = !spec.fileName;
      message.textContent = spec.message;
      if (detail) {
        detail.textContent = spec.detail || "";
        detail.hidden = !spec.detail;
      }
      // Element references cannot resolve to duplicate IDs in document content.
      dialog.ariaLabelledByElements = [title];
      dialog.ariaDescribedByElements = [name, message, detail].filter(node => node && !node.hidden);
      const listeners = new AbortController();
      job.listeners = listeners;
      const options = { signal: listeners.signal };
      const choose = (id, cause = "choice") => current(job)
        ? settle(job, id, cause) : settle(job, spec.cancelId, "stale");
      if (spec.surface !== "reload") footer.replaceChildren();
      for (const button of spec.buttons) {
        const node = spec.surface === "reload"
          ? (button.id === spec.cancelId ? surface.cancel : surface.confirm)
          : element("button", `note-dialog-btn ${button.style || "secondary"}`, button.label);
        if (!node) throw new Error("A dialog action is unavailable");
        node.type = "button";
        node.textContent = button.label;
        node.dataset.dialogChoice = button.id;
        if (spec.surface !== "reload") footer.append(node);
        node.addEventListener("click", () => choose(button.id), options);
      }
      close.addEventListener("click", () => choose(spec.cancelId, "cancel"), options);
      dialog.addEventListener("cancel", event => {
        event.preventDefault();
        choose(spec.cancelId, "cancel");
      }, options);
      // A queued close event from the preceding presentation must not close
      // a new question that has already reused this same element.
      dialog.addEventListener("close", () => {
        if (!dialog.open) choose(spec.cancelId, "cancel");
      }, options);
      dialog.addEventListener("click", event => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right ||
            event.clientY < bounds.top || event.clientY > bounds.bottom) {
          choose(spec.cancelId, "cancel");
        }
      }, options);
      document.addEventListener("keydown", event => {
        event.stopImmediatePropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          choose(spec.cancelId, "cancel");
        } else if ((event.ctrlKey || event.metaKey || event.altKey) &&
            !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c")) {
          event.preventDefault();
        }
      }, { ...options, capture: true });
      document.addEventListener("wheel", event => {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, { ...options, capture: true, passive: false });
      dialog.showModal();
      footer.querySelector(`[data-dialog-choice="${CSS.escape(spec.defaultId)}"]`)?.focus();
      updatePolling();
    } catch (error) {
      reportFailure(error, spec);
      settle(job, spec.cancelId, "cancel", error);
    }
  }

  function show(spec) {
    if (!spec || typeof spec.title !== "string" || typeof spec.message !== "string" ||
        (spec.detail !== undefined && typeof spec.detail !== "string") ||
        (spec.fileName !== undefined && typeof spec.fileName !== "string") ||
        (spec.isCurrent !== undefined && typeof spec.isCurrent !== "function") ||
        (spec.expiresAt !== undefined && (!Number.isSafeInteger(spec.expiresAt) || spec.expiresAt <= 0)) ||
        ![undefined, "reload"].includes(spec.surface) ||
        !Array.isArray(spec.buttons) || spec.buttons.length < 1 || spec.buttons.length > 4 ||
        spec.buttons.some(button => !button || typeof button.id !== "string" ||
          !button.id || button.id.length > 64 || typeof button.label !== "string" ||
          !["primary", "secondary", "danger", undefined].includes(button.style)) ||
        new Set(spec.buttons.map(button => button.id)).size !== spec.buttons.length ||
        !spec.buttons.some(button => button.id === spec.defaultId) ||
        !spec.buttons.some(button => button.id === spec.cancelId)) {
      return Promise.reject(new TypeError("Invalid dialog presentation"));
    }
    spec = Object.freeze({
      ...spec,
      buttons: Object.freeze(spec.buttons.map(button => Object.freeze({ ...button }))),
    });
    if (disposed) return Promise.resolve(Object.freeze({ choice: spec.cancelId, cause: "pagehide" }));
    if (queue.length >= 64) {
      const error = new Error("Too many dialogs are waiting");
      reportFailure(error, spec);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const job = { spec, resolve, reject, settled: false };
      queue.push(job);
      if (spec.signal) {
        const cancel = () => settle(job, spec.cancelId, "aborted");
        spec.signal.addEventListener("abort", cancel, { once: true });
        job.abortCleanup = () => spec.signal.removeEventListener("abort", cancel);
      }
      if (blocked && spec.buttons.length > 1) settle(job, spec.cancelId, "blocked");
      else {
        pump();
        updatePolling();
      }
    });
  }

  function setMainDialogActive(value) {
    blocked = value === true;
    if (blocked) {
      for (const job of [...queue]) {
        if (job.spec.buttons.length > 1) settle(job, job.spec.cancelId, "blocked");
      }
      if (active) {
        const job = active;
        if (job.spec.buttons.length > 1) settle(job, job.spec.cancelId, "blocked");
        else {
          detach(job);
          active = null;
          queue.unshift(job);
        }
      }
    } else {
      pump();
    }
    updatePolling();
  }

  function applyTheme(themeId) {
    if (!themes.has(themeId)) throw new TypeError("Unknown dialog theme");
    document.body.classList.toggle("dark-mode",
      ["default-dark", "abyss", "ember"].includes(themeId));
    if (themeId.startsWith("default-")) document.body.removeAttribute("data-theme");
    else document.body.dataset.theme = themeId;
  }

  window.addEventListener("pagehide", () => {
    disposed = true;
    for (const job of [active, ...queue]) {
      if (job) settle(job, job.spec.cancelId, "pagehide");
    }
    updatePolling();
  });
  window.MarkalooDialogs = Object.freeze({ show, applyTheme, setMainDialogActive });
  if (typeof window.folia?.onMainDialogVisibility === "function") {
    window.folia.onMainDialogVisibility(setMainDialogActive);
  }
})();
