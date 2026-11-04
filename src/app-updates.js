(function () {
  "use strict";

  let state = null;
  let about = null;
  let dismissed = null;
  const toast = document.getElementById("appUpdateToast");
  const title = document.getElementById("updateTitle");
  const message = document.getElementById("updateMessage");
  const progress = document.getElementById("updateProgress");
  const fill = document.getElementById("progressFill");
  const progressText = document.getElementById("progressText");
  const download = document.getElementById("downloadUpdateBtn");
  const install = document.getElementById("installUpdateBtn");
  const later = document.getElementById("laterUpdateBtn");
  const close = document.getElementById("closeUpdateToast");
  const menu = document.getElementById("aboutMenuItem");
  const notesRoot = document.getElementById("updateNotes");
  const notesToggle = document.getElementById("updateNotesToggle");
  const notesPanel = document.getElementById("updateNotesPanel");
  const notesStatus = document.getElementById("updateNotesStatus");
  const notesBody = document.getElementById("updateNotesBody");
  const notesRetry = document.getElementById("updateNotesRetry");
  let notes = null;
  let notesParser = null;
  let notesPurifier = null;

  function resetNotes() {
    notes = null;
    notesBody.replaceChildren();
    notesBody.hidden = true;
    notesPanel.hidden = true;
    notesRetry.hidden = true;
    notesStatus.textContent = "";
    notesToggle.setAttribute("aria-expanded", "false");
    notesToggle.textContent = "See what is new";
  }

  function renderNotes(visible) {
    notesRoot.hidden = !visible || !notes;
    if (!notes) return;
    notesToggle.setAttribute("aria-expanded", String(notes.expanded));
    notesToggle.textContent = notes.expanded ? "What is new" : "See what is new";
    notesPanel.hidden = !notes.expanded;
    notesBody.hidden = notes.status !== "loaded";
    notesRetry.hidden = notes.status !== "error";
    notesBody.setAttribute("aria-busy", String(notes.status === "loading"));
    notesStatus.textContent = notes.status === "loading" ? "Loading release notes..."
      : notes.status === "empty" ? "No release notes were provided for this version."
      : notes.status === "error" ? "Release notes could not be shown. Please try again."
      : "";
  }

  function renderNotesMarkdown(body) {
    if (typeof body !== "string" || body.length > 65536) {
      throw new Error("The release notes are too large to show here.");
    }
    if (!notesParser) {
      const escape = text => text.replace(/[&<>"']/g, value =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]);
      const renderer = new marked.Renderer();
      renderer.link = function (token) { return this.parser.parseInline(token.tokens); };
      renderer.image = token => escape(token.text);
      renderer.html = token => escape(token.text);
      const parser = new marked.Marked({ renderer, gfm: true, breaks: false, async: false });
      // The document sanitizer has local-image and iframe hooks. This factory
      // call owns separate hooks and settings, not just different call options.
      const purifier = DOMPurify(window);
      if (purifier === DOMPurify || !purifier?.isSupported) {
        throw new Error("The release notes renderer is unavailable.");
      }
      notesParser = parser;
      notesPurifier = purifier;
    }
    const html = notesParser.parse(body);
    if (typeof html !== "string" || html.length > 262144) {
      throw new Error("The rendered release notes are too large to show here.");
    }
    const fragment = notesPurifier.sanitize(html, {
      ALLOWED_TAGS: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
        "em", "strong", "del", "s", "code", "pre", "blockquote", "br", "hr"],
      ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
      RETURN_DOM_FRAGMENT: true,
    });
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_ALL);
    let count = 0;
    while (walker.nextNode()) {
      if (++count > 2048) throw new Error("The release notes have too many items to show here.");
    }
    return fragment;
  }

  async function loadNotes(retry = false) {
    const owner = notes;
    if (!owner || owner.status === "loading" || (!retry && owner.status !== "idle")) return;
    owner.status = "loading";
    if (document.activeElement === notesRetry) notesToggle.focus();
    renderNotes(toast.classList.contains("show"));
    try {
      const value = await window.folia.getUpdateReleaseNotes(owner.id, owner.version, retry);
      if (notes !== owner || value.status === "retired") return;
      const fragment = value.body ? renderNotesMarkdown(value.body) : null;
      owner.status = value.body ? "loaded" : "empty";
      notesBody.replaceChildren(...(fragment ? [fragment] : []));
    } catch (error) {
      if (notes !== owner) return;
      owner.status = "error";
      console.error("Could not show release notes:", error);
    } finally {
      if (notes === owner) renderNotes(toast.classList.contains("show"));
    }
  }

  notesToggle.addEventListener("click", () => {
    if (!notes) return;
    notes.expanded = !notes.expanded;
    if (!notes.expanded && notesPanel.contains(document.activeElement)) notesToggle.focus();
    renderNotes(toast.classList.contains("show"));
    if (notes.expanded) void loadNotes();
  });
  notesRetry.addEventListener("click", () => { void loadNotes(true); });

  function description(value) {
    const lines = [];
    if (value.availableVersion) lines.push(`Version ${value.availableVersion} is available.`);
    switch (value.status) {
      case "checking": lines.push("Checking for updates\u2026"); break;
      case "up-to-date": lines.push("You are up to date."); break;
      case "downloading": lines.push(`Downloading\u2026 ${Math.round(value.percent)}%`); break;
      case "finalizing": lines.push("Verifying the download\u2026"); break;
      case "installing": lines.push("Waiting for installation and shutdown approval\u2026"); break;
      case "ready":
        lines.push(value.readyVersion
          ? `Version ${value.readyVersion} is ready to install.`
          : "The downloaded file is no longer available. Download it again.");
        break;
      case "error": lines.push(`Could not complete the update request. ${value.error}`); break;
      case "disabled": lines.push("Update checks are disabled in development builds."); break;
    }
    if (value.availableVersion && value.lastCheck === "not-available") {
      lines.push("The last check did not confirm this remembered update.");
    }
    if (value.manualOnly) lines.push("Automatic installation is unavailable on macOS. Download the release and install it manually.");
    if (value.storageError) lines.push(value.storageError);
    if (value.scheduleError) lines.push(value.scheduleError);
    return lines.join("\n");
  }

  function downloadAction() {
    if (state?.manualOnly) window.folia.openUpdateRelease();
    else window.folia.downloadUpdate();
  }

  function installAction() {
    window.MarkalooDialogs.closeAbout();
    window.folia.installUpdate();
  }

  function render() {
    if (!state) return;
    const text = description(state);
    const inProgress = ["downloading", "finalizing"].includes(state.status);
    if (about) {
      about.version.textContent = `Version ${state.installedVersion}`;
      about.check.disabled = !state.canCheck;
      about.check.textContent = state.status === "checking" ? "Checking\u2026" : "Check for updates";
      about.status.textContent = text;
      about.progress.hidden = !inProgress;
      about.progress.value = state.percent;
      about.download.hidden = !state.availableVersion ||
        (!state.canDownload && !state.manualOnly);
      about.download.disabled = !state.canCheck;
      about.download.textContent = state.manualOnly ? "Open release downloads" : "Download";
      about.install.hidden = !state.canInstall;
    }
    title.textContent = state.status === "error" ? "Update request failed"
      : state.readyVersion ? "Update ready" : state.availableVersion ? "Update available" : "Update status";
    message.textContent = text;
    progress.hidden = !inProgress;
    progress.style.display = inProgress ? "flex" : "none";
    fill.style.width = `${state.percent}%`;
    progressText.textContent = `${Math.round(state.percent)}%`;
    download.hidden = !state.availableVersion || (!state.canDownload && !state.manualOnly);
    download.style.display = "";
    download.disabled = !state.canCheck;
    download.textContent = state.manualOnly ? "Open release downloads" : "Download";
    install.hidden = !state.canInstall;
    install.style.display = "";
    later.textContent = "Later";
    const visible = !!state.canShowUpdate && !!state.presentationId &&
      !state.presentationDismissed && dismissed !== state.presentationId;
    toast.classList.toggle("show", visible);
    toast.inert = !visible;
    renderNotes(visible);
  }

  function apply(value) {
    if (!Number.isSafeInteger(value?.revision) ||
        (state && value.revision < state.revision)) return;
    const target = value.presentationId && value.presentationVersion &&
      value.presentationVersion === value.availableVersion &&
      !value.presentationDismissed && dismissed !== value.presentationId;
    if (!target || notes?.id !== value.presentationId ||
        notes?.version !== value.presentationVersion) {
      resetNotes();
      if (target) notes = { id: value.presentationId, version: value.presentationVersion,
        expanded: false, status: "idle" };
    }
    state = value;
    render();
  }

  window.MarkalooUpdates = Object.freeze({
    bindAbout(surface) {
      about = surface;
      surface.check.addEventListener("click", () => window.folia.checkForUpdates());
      surface.download.addEventListener("click", downloadAction);
      surface.install.addEventListener("click", installAction);
      render();
    },
  });
  menu.addEventListener("click", () => {
    closeAllDropdowns();
    // This local snapshot revalidates a download; opening About never checks
    // the provider or trusts the renderer's previous ready display.
    window.folia.getUpdateState().then(apply, error => {
      if (about) about.status.textContent = "Update status could not be read. Please reopen About to try again.";
      console.error("Could not refresh update state:", error);
    });
    window.MarkalooDialogs.showAbout().catch(error => {
      console.error("Could not open About:", error);
    });
  });
  download.addEventListener("click", downloadAction);
  install.addEventListener("click", installAction);
  function dismiss() {
    if (state?.presentationId) {
      dismissed = state.presentationId;
      window.folia.dismissUpdateNotice(state.presentationId);
    }
    toast.classList.remove("show");
    toast.inert = true;
    resetNotes();
    renderNotes(false);
  }
  later.addEventListener("click", dismiss);
  close.addEventListener("click", dismiss);
  toast.setAttribute("role", "region");
  toast.setAttribute("aria-label", "Application update");
  close.setAttribute("aria-label", "Dismiss update notice");
  const unsubscribe = window.folia.onUpdateStatus(apply);
  window.addEventListener("pagehide", () => { unsubscribe(); resetNotes(); }, { once: true });
  window.folia.getUpdateState().then(apply, error => {
    message.textContent = "Update status could not be read. Reopen the window to try again.";
    title.textContent = "Update status unavailable";
    toast.classList.add("show");
    toast.inert = false;
    console.error("Could not read update state:", error);
  });
})();
