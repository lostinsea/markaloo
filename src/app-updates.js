(function () {
  "use strict";

  let state = null;
  let about = null;
  let dismissed = "";
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
  const actionable = value => value.availableVersion || value.status === "error";
  const key = value => `${value.availableVersion || ""}:${value.status}:${value.error}`;

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
      : state.readyVersion ? "Update ready" : "Update available";
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
    toast.classList.toggle("show", !!actionable(state) && dismissed !== key(state));
  }

  function apply(value) {
    if (!Number.isSafeInteger(value?.revision) ||
        (state && value.revision < state.revision)) return;
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
    if (state) dismissed = key(state);
    toast.classList.remove("show");
  }
  later.addEventListener("click", dismiss);
  close.addEventListener("click", dismiss);
  toast.setAttribute("role", "status");
  close.setAttribute("aria-label", "Dismiss update notice");
  const unsubscribe = window.folia.onUpdateStatus(apply);
  window.addEventListener("pagehide", unsubscribe, { once: true });
  window.folia.getUpdateState().then(apply, error => {
    message.textContent = "Update status could not be read. Reopen the window to try again.";
    title.textContent = "Update status unavailable";
    toast.classList.add("show");
    console.error("Could not read update state:", error);
  });
})();
