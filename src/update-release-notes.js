"use strict";

const { validVersion } = require("./update-state");

const NOTES_LIMITS = Object.freeze({
  responseBytes: 262144,
  markdownChars: 65536,
  timeoutMs: 10000,
  htmlChars: 262144,
  nodes: 2048,
});

function retiredError() {
  const error = new Error("This update notice is no longer current.");
  error.code = "UPDATE_NOTES_RETIRED";
  return error;
}

function createUpdateReleaseNotes(options) {
  const now = options.now || (() => performance.now());
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let current = null;

  function sameOffer(left, right) {
    return !!left && !!right && left.owner === right.owner &&
      left.id === right.id && left.version === right.version;
  }

  function clear() {
    const retired = current;
    current = null;
    if (retired?.status === "loading") {
      retired.cancel(retiredError());
      retired.controller.abort();
    }
  }

  function reconcile() {
    const offer = options.getOffer();
    if (current && !sameOffer(current.offer, offer)) clear();
    return offer;
  }

  function load(id, version, retry = false) {
    const offer = reconcile();
    if (!offer || offer.id !== id || offer.version !== version ||
        typeof offer.owner !== "string" || !validVersion(offer.version) ||
        typeof retry !== "boolean") {
      return Promise.reject(retiredError());
    }
    if (current && (!retry || current.status === "loading")) return current.promise;

    const entry = {
      offer: { ...offer }, status: "loading", controller: new AbortController(),
      started: now(), cancel: null, promise: null,
    };
    current = entry;
    const canceled = new Promise((_resolve, reject) => { entry.cancel = reject; });
    const expired = new Promise((_resolve, reject) => {
      entry.timer = setTimer(() => {
        entry.controller.abort();
        reject(new Error("Loading release notes took too long. Please try again."));
      }, NOTES_LIMITS.timeoutMs);
      entry.timer?.unref?.();
    });

    function assertCurrent() {
      if (current !== entry || !sameOffer(entry.offer, options.getOffer())) {
        throw retiredError();
      }
      if (now() - entry.started >= NOTES_LIMITS.timeoutMs) {
        throw new Error("Loading release notes took too long. Please try again.");
      }
    }

    async function read() {
      const tag = `v${entry.offer.version}`;
      const response = await options.fetch(
        `https://api.github.com/repos/lostinsea/markaloo/releases/tags/${encodeURIComponent(tag)}`,
        {
          credentials: "omit", redirect: "error", cache: "no-store",
          referrerPolicy: "no-referrer", signal: entry.controller.signal,
          headers: { Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28" },
        },
      );
      assertCurrent();
      if (response.status !== 200 || !response.body) {
        throw new Error("The release notes are not available. Please try again.");
      }
      const advertised = response.headers.get("content-length");
      if (advertised !== null && (!/^\d+$/.test(advertised) ||
          Number(advertised) > NOTES_LIMITS.responseBytes)) {
        throw new Error("The release response is too large to show here.");
      }
      const chunks = [];
      let bytes = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const part = await reader.read();
          assertCurrent();
          if (part.done) break;
          if (!(part.value instanceof Uint8Array)) {
            throw new Error("The release response has an invalid encoding.");
          }
          bytes += part.value.byteLength;
          if (bytes > NOTES_LIMITS.responseBytes) {
            void reader.cancel().catch(error =>
              options.log("Could not close the release notes stream:", error.message));
            throw new Error("The release response is too large to show here.");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
      const release = JSON.parse(text);
      if (!release || typeof release !== "object" || Array.isArray(release) ||
          release.tag_name !== tag || release.draft === true) {
        throw new Error("The release response did not match this update.");
      }
      const body = release.body ?? "";
      if (typeof body !== "string") {
        throw new Error("The release notes have an invalid format.");
      }
      if (body.length > NOTES_LIMITS.markdownChars) {
        throw new Error("The release notes are too large to show here.");
      }
      assertCurrent();
      return Object.freeze({ status: "loaded", presentationId: id, version, body: body.trim() ? body : "" });
    }

    // Publish the promise before entering the transport, including test or
    // proxy implementations that can synchronously re-enter this boundary.
    entry.promise = Promise.race([Promise.resolve().then(read), canceled, expired])
      .then(value => {
        assertCurrent();
        entry.status = "loaded";
        return value;
      })
      .catch(error => {
        if (current === entry) {
          entry.status = "error";
          entry.controller.abort();
          options.log("Could not load release notes:", error.message);
        }
        throw error;
      })
      .finally(() => clearTimer(entry.timer));
    return entry.promise;
  }

  return Object.freeze({ load, reconcile, clear });
}

module.exports = { createUpdateReleaseNotes, NOTES_LIMITS };
