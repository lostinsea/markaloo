(function () {
  "use strict";

  function createReadingViewport({ readIntent, readViewport, stopMotion, changed }) {
    for (const callback of [readIntent, readViewport, stopMotion, changed]) {
      if (typeof callback !== "function") {
        throw new TypeError("Reading viewport ownership requires identity and cancellation callbacks.");
      }
    }

    let intentEpoch = {}, viewportEpoch = {}, transition = {}, motion = null;
    const intents = new WeakMap(), permits = new WeakMap();
    const refused = reason => Object.freeze({ accepted: false, reason });

    function snapshot(read) {
      const identity = read();
      if (!Array.isArray(identity) || identity.length === 0) {
        throw new TypeError("Reading viewport identities must be nonempty ownership tuples.");
      }
      return Object.freeze([...identity]);
    }

    function matches(identity, read) {
      const current = snapshot(read);
      return identity.length === current.length &&
        identity.every((value, index) => Object.is(value, current[index]));
    }

    function capturePermit() {
      const permit = Object.freeze({});
      permits.set(permit, { epoch: viewportEpoch, identity: snapshot(readViewport) });
      return permit;
    }

    function isPermitCurrent(permit) {
      const captured = permits.get(permit);
      return !!captured && captured.epoch === viewportEpoch &&
        matches(captured.identity, readViewport) && captured.epoch === viewportEpoch;
    }

    function isIntentCurrent(ticket) {
      const captured = intents.get(ticket);
      return !!captured && captured.epoch === intentEpoch &&
        matches(captured.identity, readIntent) && captured.epoch === intentEpoch;
    }

    function cancelMotion(receipt) {
      if (!receipt || motion?.receipt !== receipt) return false;
      const previous = motion;
      motion = null;
      const cancellation = transition = {}, epoch = viewportEpoch;
      // Check before every native write: a callback can already have a successor.
      stopMotion(previous.chain,
        () => transition === cancellation && viewportEpoch === epoch && motion === null);
      return true;
    }

    function invalidate() {
      const epoch = viewportEpoch = {};
      cancelMotion(motion?.receipt);
      if (viewportEpoch === epoch) changed();
      return epoch;
    }

    function beginIntent() {
      const ticket = Object.freeze({});
      const epoch = intentEpoch = {};
      viewportEpoch = {};
      intents.set(ticket, { epoch, identity: snapshot(readIntent) });
      if (isIntentCurrent(ticket)) invalidate();
      return ticket;
    }

    function trackMotion(ticket, chain) {
      const requestEpoch = viewportEpoch, requestTransition = transition;
      if (!isIntentCurrent(ticket)) return refused("stale-intent");
      if (viewportEpoch !== requestEpoch || transition !== requestTransition) return refused("superseded");
      if (!Array.isArray(chain) || chain.length === 0) {
        throw new TypeError("A reading movement requires its complete scrolling-box chain.");
      }
      const boxes = Object.freeze([...new Set(chain)]);
      if (boxes.some(box => !box || typeof box !== "object")) {
        throw new TypeError("A reading movement requires its complete scrolling-box chain.");
      }
      if (!isIntentCurrent(ticket) || viewportEpoch !== requestEpoch ||
          transition !== requestTransition) return refused("superseded");
      const epoch = invalidate();
      if (!isIntentCurrent(ticket) || viewportEpoch !== epoch) return refused("superseded");
      const cancellation = transition;
      const receipt = Object.freeze({});
      const permit = capturePermit();
      if (!isIntentCurrent(ticket) || viewportEpoch !== epoch ||
          transition !== cancellation) return refused("superseded");
      transition = {};
      motion = { receipt, chain: boxes, permit };
      return Object.freeze({ accepted: true, receipt });
    }

    function isMotionCurrent(receipt) {
      const captured = motion;
      return !!receipt && captured?.receipt === receipt &&
        isPermitCurrent(captured.permit) && motion === captured;
    }

    return Object.freeze({
      beginIntent, isIntentCurrent, capturePermit, isPermitCurrent,
      invalidate, trackMotion, isMotionCurrent, cancelMotion,
    });
  }

  const readingViewport = Object.freeze({ createReadingViewport });
  if (typeof module !== "undefined" && module.exports) module.exports = readingViewport;
  if (typeof window !== "undefined") window.FoliaReadingViewport = readingViewport;
})();
