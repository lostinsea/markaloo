"use strict";

const { randomUUID } = require("crypto");
const { performance } = require("perf_hooks");

const MIN_SLOT = 60 * 1000;
const CLOCK_POLL = 60 * 1000;
const STARTUP_DELAY = 5 * 1000;
function localCalendar(now) {
  const date = new Date(now);
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0")).join("-");
  return {
    day, zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    midnight: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(),
    nextMidnight: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(),
  };
}

function validDay(day) {
  if (typeof day !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(day + "T12:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

function exact(value, fields) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...fields].sort().join(",");
}

function validSlot(value) {
  if (!exact(value, ["schema", "id", "localDay", "timeZone", "dueAt", "state"]) ||
      value.schema !== 1 || typeof value.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) || !validDay(value.localDay) ||
      typeof value.timeZone !== "string" || value.timeZone.length > 100 ||
      !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value.timeZone) ||
      !Number.isSafeInteger(value.dueAt) ||
      !["pending", "claimed"].includes(value.state)) return false;
  try {
    const format = new Intl.DateTimeFormat("en-CA", {
      timeZone: value.timeZone, calendar: "gregory", year: "numeric", month: "2-digit", day: "2-digit",
    });
    const parts = Object.fromEntries(format.formatToParts(value.dueAt)
      .filter(part => ["year", "month", "day"].includes(part.type))
      .map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}` === value.localDay;
  } catch { return false; }
}

// Main is the only owner. The injected boundaries also let Node exercise the
// actual calendar, provider latch and failed settings writes without Electron.
function createUpdateSchedule(options) {
  const now = options.now || Date.now;
  const monotonicNow = options.monotonicNow || (() => performance.now());
  const calendar = options.calendar || localCalendar;
  const random = options.random || Math.random;
  const identity = options.identity || randomUUID;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let slot = null;
  let lastReservedLocalDay = null;
  let reminderInvalid = false;
  let scheduleFailed = false;
  let reminderFailed = false;
  const diagnostics = new Map();
  let timer = null, timerGeneration = 0;
  let running = false, stopped = false, queued = false;
  let observed = null;
  let flight = null;
  let presentation = null;
  let manualDay = null;
  let startupDue = false;
  let startupNotBefore = null;
  let startupReleased = false;
  let waitingMidnight = null;
  let revision = 0, lastPublished = "";

  function diagnose(key, error) {
    const message = error instanceof Error ? error.message : String(error);
    if (diagnostics.get(key) !== message) options.log("Update scheduling:", key, message);
    diagnostics.set(key, message);
  }
  try {
    const stored = options.read();
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      throw new Error("Invalid saved update settings. Automatic notices are disabled.");
    }
    const savedSlot = stored?.updateSchedule;
    if (savedSlot !== undefined && savedSlot !== null) {
      if (validSlot(savedSlot)) slot = { ...savedSlot };
      else diagnose("schedule", "Invalid saved daily update slot; choosing a new future slot.");
    }
    const reminder = stored?.updateReminder;
    if (reminder !== undefined && reminder !== null) {
      if (exact(reminder, ["schema", "lastReservedLocalDay"]) && reminder.schema === 1 &&
          validDay(reminder.lastReservedLocalDay)) {
        lastReservedLocalDay = reminder.lastReservedLocalDay;
      } else {
        reminderInvalid = true;
        diagnose("reminder", "Invalid saved update reminder permission. Automatic notices are disabled.");
      }
    }
  } catch (error) {
    reminderInvalid = true;
    scheduleFailed = true;
    diagnose("settings", error);
  }

  function saveSlot(value) {
    slot = value;
    try {
      options.write({ updateSchedule: value });
      return true;
    } catch (error) {
      // Do not repeatedly hit a broken disk or dispatch an unpersisted claim.
      scheduleFailed = true;
      diagnose("schedule-save", error);
      return false;
    }
  }
  function cancelTimer() {
    timerGeneration += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function snapshot() {
    const state = options.getState();
    const visible = !stopped && !!presentation && !presentation.dismissed && options.hasWindow() &&
      options.canPresent(presentation.origin) &&
      (!presentation.target || state.availableVersion === presentation.target);
    return Object.freeze({
      ...state, revision,
      presentationId: presentation?.id || null,
      presentationVersion: presentation?.target || null,
      presentationOrigin: presentation?.origin || null,
      presentationDismissed: !!presentation?.dismissed,
      canShowUpdate: visible,
      scheduleError: [...diagnostics.values()].join(" "),
    });
  }
  function publish() {
    if (presentation) {
      presentation.target = options.getState().availableVersion;
    }
    const value = snapshot();
    const serial = JSON.stringify({ ...value, revision: 0, stateRevision: options.getState().revision });
    if (serial === lastPublished) return;
    lastPublished = serial;
    revision += 1;
    options.publish(snapshot());
  }
  function present(origin, target) {
    presentation = { id: identity(), origin, target, dismissed: false };
  }
  function completeManual(current) {
    if (!current.manual) return;
    manualDay = calendar(now()).day;
    present("manual", options.getState().availableVersion);
  }
  function automaticNotice(clock) {
    const state = options.getState();
    if (!state.availableVersion || !state.canCheck || flight || manualDay === clock.day ||
        reminderInvalid || reminderFailed ||
        (lastReservedLocalDay && clock.day <= lastReservedLocalDay) ||
        !options.hasWindow() || !options.canPresent("automatic")) return;
    // Revalidate at the final permission boundary, not the request-start date.
    const finalClock = calendar(now());
    const target = options.getState().availableVersion;
    if (!validDay(finalClock.day) || !target || target !== state.availableVersion ||
        (lastReservedLocalDay && finalClock.day <= lastReservedLocalDay) ||
        !options.hasWindow() || !options.canPresent("automatic")) return;
    try {
      options.write({ updateReminder: { schema: 1, lastReservedLocalDay: finalClock.day } });
    } catch (error) {
      reminderFailed = true;
      diagnose("reminder-save", error);
      return;
    }
    // A crash between this durable reservation and paint loses a notice, not
    // the day's cap. Dismissal, version changes and clock rollback never reset it.
    lastReservedLocalDay = finalClock.day;
    present("automatic", target);
  }
  function check(origin, startup = false) {
    const state = options.getState();
    if (stopped || (!state.canCheck && !options.canJoinCheck())) return Promise.resolve(state);
    if (flight) {
      if (origin === "manual") flight.manual = true;
      return flight.promise;
    }
    const current = { manual: origin === "manual", promise: null };
    flight = current;
    // Install our ownership before provider code can publish synchronous events.
    current.promise = Promise.resolve().then(() =>
      startup ? options.startup() : options.check()).then(result => {
      if (!stopped && flight === current) {
        flight = null;
        completeManual(current);
        reconcile("completion");
      }
      return result;
    }, error => {
      if (flight === current) flight = null;
      if (!stopped) {
        diagnose("check", error);
        completeManual(current);
        reconcile("completion");
      }
      // The update-state boundary normally handles provider errors. A broken
      // integration is not a successful check and must remain observable.
      throw error;
    });
    return current.promise;
  }
  function futureSlot(clock, time, catchUp) {
    if (!catchUp && clock.nextMidnight - time <= MIN_SLOT) {
      if (waitingMidnight !== clock.nextMidnight) saveSlot(null);
      waitingMidnight = clock.nextMidnight;
      return;
    }
    waitingMidnight = null;
    const fraction = random();
    if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) {
      scheduleFailed = true;
      diagnose("random", "Invalid random daily update slot.");
      return;
    }
    const dueAt = catchUp ? time : time + MIN_SLOT +
      Math.floor(fraction * (clock.nextMidnight - time - MIN_SLOT));
    saveSlot({ schema: 1, id: identity(), localDay: clock.day, timeZone: clock.zone,
      dueAt, state: "pending" });
  }
  function arm(clock, time) {
    cancelTimer();
    if (!running || stopped || !options.hasWindow()) return;
    let delay = Math.min(CLOCK_POLL, Math.max(1, clock.nextMidnight - time));
    if (!scheduleFailed && slot?.state === "pending" && slot.dueAt > time) {
      delay = Math.min(delay, slot.dueAt - time);
    }
    if (!startupReleased && startupNotBefore !== null && startupNotBefore > monotonicNow()) {
      delay = Math.min(delay, Math.max(1, startupNotBefore - monotonicNow()));
    }
    const generation = timerGeneration, slotId = slot?.id;
    timer = setTimer(() => {
      if (stopped || generation !== timerGeneration || slotId !== slot?.id) return;
      timer = null;
      reconcile("timer");
    }, delay);
    timer?.unref?.();
  }
  function reconcile(reason = "state") {
    if (stopped) return;
    const time = now(), clock = calendar(time);
    if (running && options.hasWindow()) {
      const backwards = !!observed && time < observed.time;
      const zoneChanged = !!observed && clock.zone !== observed.zone;
      const sameClaim = slot?.localDay === clock.day && slot.state === "claimed";
      const changedDay = slot?.localDay !== clock.day;
      const replace = !slot || changedDay ||
        (!sameClaim && (backwards || zoneChanged || slot.timeZone !== clock.zone));
      if (replace && !scheduleFailed) {
        const catchUp = !!observed && clock.day > observed.day && !zoneChanged && !backwards &&
          (reason === "resume" || time - observed.nextMidnight >= MIN_SLOT);
        futureSlot(clock, time, catchUp);
      }
      observed = { ...clock, time };
      const state = options.getState();
      if (!scheduleFailed && slot?.state === "pending" && slot.localDay === clock.day &&
          (startupReleased || (startupNotBefore !== null && monotonicNow() >= startupNotBefore)) &&
          slot.dueAt <= time && (state.canCheck || options.canJoinCheck())) {
        // Claim BEFORE dispatch OR joining. A failed/offline check spends the
        // slot, and its completion never writes to a replacement day's identity.
        if (saveSlot({ ...slot, state: "claimed" })) {
          startupReleased = true;
          void check("automatic").catch(error => options.log("Scheduled update check failed:", error.message));
        }
      }
      if (startupDue && (state.canCheck || options.canJoinCheck())) {
        startupDue = false;
        void check("automatic", true).catch(error => options.log("Startup update check failed:", error.message));
      }
    }
    automaticNotice(clock);
    publish();
    arm(clock, time);
  }
  function changed() {
    if (stopped) return;
    // Keep existing Main status/error publication synchronous. Permission and
    // provider reconciliation run separately, after the state latch settles.
    publish();
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!stopped) reconcile();
    });
  }
  return Object.freeze({
    start() {
      if (!stopped && !running) {
        running = true;
        startupNotBefore = monotonicNow() + STARTUP_DELAY;
        reconcile("launch");
      }
    },
    reconcile, changed, snapshot,
    checkManual() { return check("manual"); },
    checkStartup() {
      startupReleased = true;
      startupDue = true;
      reconcile("startup");
      return flight?.promise || Promise.resolve(options.getState());
    },
    beginManualAction() {
      if (stopped) return;
      manualDay = calendar(now()).day;
      present("manual", options.getState().availableVersion);
      publish();
    },
    dismiss(id) {
      if (typeof id !== "string" || !presentation || id !== presentation.id) return;
      presentation.dismissed = true;
      publish();
    },
    stop() {
      stopped = true;
      running = false;
      cancelTimer();
    },
  });
}

module.exports = { createUpdateSchedule, localCalendar, validDay, validSlot };
