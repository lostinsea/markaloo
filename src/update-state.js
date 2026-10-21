"use strict";

// Startup validates versions, but does not need the package's range parser.
const valid = require("semver/functions/valid");
const gt = require("semver/functions/gt");

function validVersion(value) {
  return typeof value === "string" && value.length <= 128 &&
    /^\d/.test(value) && valid(value) ? value : null;
}

// Availability is durable knowledge, not a downloaded installer or permission.
function createUpdateState(options) {
  const installedVersion = validVersion(options.installedVersion);
  if (!installedVersion) throw new TypeError("Invalid installed version");
  let revision = 0;
  let availableVersion = null;
  let offerVersion = null;
  let ready = null;
  let phase = "idle";
  let error = "";
  let storageError = "";
  let percent = 0;
  let checking = null;
  let downloading = null;
  let downloadEvent = null;
  let checked = false;
  let lastCheck = "";
  const attached = new WeakSet();
  const manualOnly = options.platform === "darwin";

  function persist() {
    try {
      options.writeAvailability(availableVersion
        ? { schema: 1, version: availableVersion } : null);
      storageError = "";
    } catch (cause) {
      storageError = "The update notice could not be saved. It may be missing after restarting.";
      options.log("Could not save update availability:", cause.message);
    }
  }

  const cached = options.readAvailability();
  if (cached !== undefined && cached !== null) {
    if (cached && typeof cached === "object" && !Array.isArray(cached) &&
        Object.keys(cached).length === 2 && cached.schema === 1 &&
        validVersion(cached.version) && gt(cached.version, installedVersion)) {
      availableVersion = cached.version;
      phase = "available";
    } else {
      persist();
    }
  }

  function snapshot() {
    const busy = !!checking || !!downloading || options.isInstalling();
    const readyValid = !!ready && options.validateReady(ready);
    return Object.freeze({
      revision, installedVersion, availableVersion,
      readyVersion: readyValid ? ready.version : null,
      status: options.isInstalling() && phase !== "error" ? "installing" : phase,
      error, storageError, percent, manualOnly, lastCheck,
      canCheck: !busy,
      canDownload: !!availableVersion && !busy && !manualOnly &&
        !(readyValid && ready.version === availableVersion),
      canInstall: readyValid && ready.version === availableVersion &&
        !busy && !manualOnly && options.canInstall(),
    });
  }

  function publish() {
    revision += 1;
    options.publish(snapshot());
  }

  function fail(cause) {
    error = typeof cause?.message === "string"
      ? cause.message.replace(/[\u0000-\u001f]/g, " ").slice(0, 500)
      : "The update request failed. Please try again.";
    phase = "error";
    options.log("Update request failed:", error);
    publish();
  }

  function remember(version) {
    if (!validVersion(version) || !gt(version, installedVersion)) {
      throw new Error("The update provider returned an invalid newer version.");
    }
    if (!availableVersion || gt(version, availableVersion)) {
      availableVersion = version;
      persist();
    } else if (storageError) {
      persist();
    }
    return version;
  }

  function attach(updater) {
    if (attached.has(updater)) return;
    attached.add(updater);
    updater.on("download-progress", progress => {
      if (!downloading) return;
      percent = Number.isFinite(progress?.percent)
        ? Math.min(100, Math.max(0, progress.percent)) : 0;
      phase = "downloading";
      publish();
    });
    updater.on("update-downloaded", info => {
      if (!downloading || info?.version !== offerVersion ||
          typeof info.downloadedFile !== "string") return;
      downloadEvent = { version: info.version, path: info.downloadedFile };
      phase = "finalizing";
      publish();
    });
  }

  function check(forDownload = false) {
    if (checking) return checking;
    if ((downloading && !forDownload) || options.isInstalling()) return Promise.resolve(snapshot());
    checked = true;
    error = "";
    if (!options.enabled()) {
      phase = "disabled";
      publish();
      return Promise.resolve(snapshot());
    }
    phase = "checking";
    // Set the latch before calling provider code, including synchronous events.
    checking = Promise.resolve().then(async () => {
      try {
        const updater = options.getUpdater();
        if (!updater) throw new Error("The updater is unavailable. Please try again.");
        const result = await updater.checkForUpdates();
        const version = result?.updateInfo?.version;
        if (!validVersion(version)) throw new Error("The update provider returned an invalid version.");
        if (gt(version, installedVersion)) {
          // update-not-available can describe a gated/channel-ineligible offer.
          // Only the provider's actual availability event grants a live offer.
          if (liveCheckOffer !== version) {
            offerVersion = null;
            lastCheck = "not-available";
            phase = availableVersion ? "available" : "up-to-date";
          } else {
            offerVersion = remember(version);
            lastCheck = offerVersion === availableVersion ? "available" : "not-available";
            phase = "available";
          }
        } else {
          offerVersion = null;
          lastCheck = "not-available";
          phase = availableVersion ? "available" : "up-to-date";
        }
      } catch (cause) {
        offerVersion = null;
        lastCheck = "error";
        fail(cause);
      } finally {
        checking = null;
        liveCheckOffer = null;
        publish();
      }
      return snapshot();
    });
    liveCheckOffer = null;
    publish();
    return checking;
  }

  let liveCheckOffer = null;
  function observeAvailable(info) {
    if (checking && validVersion(info?.version)) liveCheckOffer = info.version;
  }

  function download() {
    if (downloading) return downloading;
    if (ready && ready.version === availableVersion && options.validateReady(ready)) {
      return Promise.resolve(snapshot());
    }
    if (options.isInstalling() || manualOnly || !availableVersion) {
      return Promise.resolve(snapshot());
    }
    downloading = Promise.resolve().then(async () => {
      try {
        // A restored version has no provider-owned file metadata. Resolve it
        // afresh only after an explicit Download action.
        if (checking) await checking;
        if (!offerVersion || offerVersion !== availableVersion) {
          await check(true);
        }
        if (!offerVersion || offerVersion !== availableVersion) {
          throw new Error("This update is not available from the provider right now. Please try again later.");
        }
        const updater = options.getUpdater();
        ready = null;
        downloadEvent = null;
        options.onDownloadStart();
        phase = "downloading";
        error = "";
        percent = 0;
        publish();
        const paths = await updater.downloadUpdate();
        if (!downloadEvent || !Array.isArray(paths) ||
            !paths.includes(downloadEvent.path) || !options.validateReady(downloadEvent)) {
          throw new Error("The downloaded update could not be verified. Please download it again.");
        }
        ready = downloadEvent;
        options.onDownloadReady(ready.path);
        phase = "ready";
      } catch (cause) {
        ready = null;
        options.onDownloadReady(null);
        fail(cause);
      } finally {
        options.onDownloadEnd();
        downloading = null;
        publish();
      }
      return snapshot();
    });
    const task = downloading;
    publish();
    return task;
  }

  return Object.freeze({
    snapshot, attach, observeAvailable, check, download, fail, publish,
    beginInstall() {
      error = "";
      phase = "ready";
      publish();
    },
    startup() { return checked ? Promise.resolve(snapshot()) : check(); },
    ready() {
      return ready && options.validateReady(ready) ? { ...ready } : null;
    },
  });
}

module.exports = { createUpdateState, validVersion };
