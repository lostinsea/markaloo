"use strict";
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createUpdateState } = require("../src/update-state");
const { createUpdateSchedule, localCalendar, validDay, validSlot } = require("../src/update-schedule");
const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}
function gate() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const dayAt = (day, time = "10:00:00") => Date.parse(`${day}T${time}Z`);
function fixture(settings = {}, initial = dayAt("2026-11-03"), zone = "UTC", platform = "win32",
  startupElapsed = 5000) {
  const e = { time: initial, elapsed: 0, zone, random: 0.5, serial: 0, checks: 0, downloads: 0,
    writes: [], logs: [], published: [], timers: new Map(), settings: structuredClone(settings),
    hasWindow: true, visible: true, modal: false, mainDialog: false, installing: false,
    version: "0.13.0", error: false, failWrite: null, checkGate: null, downloadGate: null };
  const calendar = time => {
    const previous = process.env.TZ;
    process.env.TZ = e.zone;
    try { return localCalendar(time); }
    finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  };
  const provider = new EventEmitter();
  provider.checkForUpdates = async () => {
    e.checks++;
    e.claimAtDispatch = e.settings.updateSchedule?.state;
    if (e.checkGate) await e.checkGate.promise;
    if (e.error) throw new Error("Offline fixture");
    provider.emit(e.version === "0.12.0" ? "update-not-available" : "update-available", { version: e.version });
    return { updateInfo: { version: e.version } };
  };
  provider.downloadUpdate = async () => {
    e.downloads++;
    provider.emit("download-progress", { percent: 42 });
    if (e.downloadGate) await e.downloadGate.promise;
    provider.emit("update-downloaded", { version: e.version, downloadedFile: "fixture" });
    if (e.finalizeGate) await e.finalizeGate.promise;
    return ["fixture"];
  };
  let owner;
  const state = createUpdateState({
    installedVersion: "0.12.0", platform, enabled: () => true,
    getUpdater: () => provider,
    readAvailability: () => e.settings.updateAvailability,
    writeAvailability: value => { e.settings.updateAvailability = value; },
    isInstalling: () => e.installing, canInstall: () => true,
    validateReady: () => true, onDownloadStart() {}, onDownloadReady() {}, onDownloadEnd() {},
    log: (...args) => e.logs.push(args),
    publish: () => owner?.changed(),
  });
  state.attach(provider);
  provider.on("update-available", state.observeAvailable);
  owner = createUpdateSchedule({
    now: () => e.time, monotonicNow: () => e.elapsed,
    calendar, random: () => e.random, identity: () => `fixture-${++e.serial}`,
    read: () => e.settings,
    write: patch => {
      if (Object.hasOwn(patch, e.failWrite)) throw new Error("Fixture disk refused " + e.failWrite);
      e.writes.push(structuredClone(patch));
      Object.assign(e.settings, structuredClone(patch));
    },
    getState: state.snapshot,
    check: () => {
      if (e.integrationError) throw new Error("Broken integration fixture");
      return state.check();
    },
    canJoinCheck: state.canJoinCheck,
    startup: () => state.startup(),
    hasWindow: () => e.hasWindow,
    canPresent: origin => e.visible && !e.mainDialog && (origin === "manual" || !e.modal),
    publish: value => e.published.push(value),
    log: (...args) => e.logs.push(args),
    setTimer: (callback, delay) => {
      const id = ++e.serial;
      e.timers.set(id, { callback, due: e.time + delay });
      return id;
    },
    clearTimer: id => e.timers.delete(id),
  });
  return {
    e, state, owner, provider, calendar,
    // Ordinary daily scenarios begin after startup's minimum elapsed delay.
    start() { owner.start(); e.elapsed += startupElapsed; },
    at(day, time = "10:00:00", reason = "resume") {
      e.time = dayAt(day, time); owner.reconcile(reason);
    },
    due() { e.time = e.settings.updateSchedule.dueAt; owner.reconcile("timer"); },
  };
}
const cached = () => ({ updateAvailability: { schema: 1, version: "0.13.0" } });

async function overdueRestart(slot, time) {
  const overdue = fixture({ updateSchedule: { ...slot, dueAt: time - 60000 } }, time, "UTC", "win32", 0);
  check("overdue restart fixture proves a valid pending same-day deadline",
    validSlot(overdue.e.settings.updateSchedule) &&
    overdue.e.settings.updateSchedule.dueAt < overdue.e.time);
  overdue.start();
  await settle();
  overdue.e.time += 4999;
  overdue.e.elapsed += 4999;
  overdue.owner.reconcile("timer");
  await settle();
  check("overdue restart preserves the five-second startup delay before claim or dispatch",
    overdue.e.checks === 0 && overdue.e.settings.updateSchedule.state === "pending");
  overdue.e.time += 3600000;
  overdue.owner.reconcile("focus");
  await settle();
  check("forward wall-clock correction cannot release the minimum elapsed startup delay",
    overdue.e.checks === 0 && overdue.e.settings.updateSchedule.state === "pending");
  overdue.e.time += 1;
  overdue.e.elapsed += 1;
  overdue.owner.reconcile("timer");
  await settle();
  await overdue.owner.checkStartup();
  await settle();
  check("overdue restart and startup deadlines share one provider attempt",
    overdue.e.checks === 1 && overdue.e.claimAtDispatch === "claimed" &&
    overdue.e.settings.updateSchedule.state === "claimed");
}

async function run() {
  const f = fixture();
  f.start();
  const first = structuredClone(f.e.settings.updateSchedule);
  check("daily fixture proves a future randomized persisted pending slot without provider traffic",
    validSlot(first) && first.state === "pending" && first.dueAt > f.e.time &&
    first.dueAt < f.calendar(f.e.time).nextMidnight && f.e.checks === 0 && f.e.timers.size === 1);
  f.e.random = 0.1;
  f.owner.reconcile("focus");
  f.owner.changed();
  await settle();
  check("same-day focus status and renderer reads preserve slot identity and randomized deadline",
    JSON.stringify(first) === JSON.stringify(f.e.settings.updateSchedule) && f.e.writes.length === 1);
  const restarted = fixture(f.e.settings, f.e.time);
  restarted.start();
  check("same-day restart recovers the exact pending daily slot",
    JSON.stringify(first) === JSON.stringify(restarted.e.settings.updateSchedule) && restarted.e.writes.length === 0);
  await overdueRestart(first, f.e.time);

  f.e.checkGate = gate();
  const manual = f.owner.checkManual();
  await settle();
  check("overlap fixture proves a held real provider check before scheduled due intent",
    f.e.checks === 1 && f.state.snapshot().status === "checking");
  f.due();
  check("scheduled due claims persisted intent before joining a real manual check",
    f.e.settings.updateSchedule.state === "claimed" && f.e.checks === 1);
  f.e.checkGate.resolve();
  await manual;
  await settle();
  const joined = f.owner.snapshot();
  check("manual automatic overlap has one manual presentation and no automatic reservation",
    f.e.checks === 1 && joined.presentationOrigin === "manual" && joined.canShowUpdate &&
    !f.e.settings.updateReminder);
  f.owner.dismiss(joined.presentationId);
  f.owner.reconcile("focus");
  check("same completion cannot create a separate automatic presentation after manual dismissal",
    f.owner.snapshot().presentationId === joined.presentationId &&
    f.owner.snapshot().presentationDismissed && !f.e.settings.updateReminder);
  const spent = fixture(f.e.settings, f.e.time);
  spent.start();
  await settle();
  check("same-day restart preserves a claimed slot without another scheduled network attempt",
    spent.e.settings.updateSchedule.state === "claimed" && spent.e.checks === 0);

  const auto = fixture();
  auto.start();
  auto.e.error = true;
  auto.due();
  await settle();
  const calls = auto.e.checks;
  auto.owner.reconcile("resume");
  auto.owner.reconcile("focus");
  check("offline daily check is claimed before dispatch and does not retry on resume or focus",
    auto.e.claimAtDispatch === "claimed" && calls === 1 && auto.e.checks === calls &&
    auto.e.settings.updateSchedule.state === "claimed" && auto.owner.snapshot().status === "error");
  await auto.owner.checkManual();
  check("manual errors remain explicit after a spent automatic attempt",
    auto.e.checks === 2 && auto.owner.snapshot().presentationOrigin === "manual" &&
    auto.owner.snapshot().canShowUpdate && auto.owner.snapshot().error === "Offline fixture");
  auto.e.error = false; auto.e.version = "0.12.0";
  await auto.owner.checkManual();
  check("manual no-update result is an explicit new presentation even without availability",
    auto.owner.snapshot().status === "up-to-date" && auto.owner.snapshot().canShowUpdate &&
    auto.owner.snapshot().presentationOrigin === "manual");

  const days = fixture(cached());
  days.start();
  const a = days.owner.snapshot().presentationId;
  check("cached availability reserves local day before granting a stable automatic presentation",
    !!a && days.owner.snapshot().canShowUpdate &&
    days.e.settings.updateReminder.lastReservedLocalDay === "2026-11-03" &&
    JSON.stringify(days.e.settings.updateAvailability) === '{"schema":1,"version":"0.13.0"}');
  days.owner.dismiss(a);
  days.state.fail(new Error("Fixture status revision"));
  check("existing update error publication remains synchronous without waiting for automatic permission",
    days.e.published.at(-1).status === "error" &&
    days.e.published.at(-1).error === "Fixture status revision");
  days.owner.changed();
  await settle();
  check("dismissed presentation stays dismissed across error status and renderer snapshot revisions",
    days.owner.snapshot().presentationId === a && days.owner.snapshot().presentationDismissed &&
    !days.owner.snapshot().canShowUpdate);
  days.owner.beginManualAction();
  const explicitAction = days.owner.snapshot().presentationId;
  days.state.fail(new Error("Explicit action failed"));
  check("accepted manual action after dismissal grants visible failure feedback without a new automatic reservation",
    explicitAction !== a && days.owner.snapshot().canShowUpdate &&
    days.owner.snapshot().presentationOrigin === "manual" &&
    days.owner.snapshot().error === "Explicit action failed" &&
    days.e.writes.filter(patch => patch.updateReminder).length === 1);
  days.owner.dismiss(explicitAction);
  days.at("2026-11-04");
  await settle();
  const b = days.owner.snapshot().presentationId;
  days.owner.dismiss(b);
  days.at("2026-11-03");
  await settle();
  days.at("2026-11-04");
  await settle();
  const afterRollback = days.owner.snapshot();
  days.at("2026-11-05");
  await settle();
  check("A B A B C reminder high-water never decreases and only C grants the same version again",
    !!b && b !== a && afterRollback.presentationId === b && afterRollback.presentationDismissed &&
    days.owner.snapshot().presentationId !== b && days.owner.snapshot().canShowUpdate &&
    days.e.settings.updateReminder.lastReservedLocalDay === "2026-11-05" &&
    days.e.writes.filter(patch => patch.updateReminder).map(patch =>
      patch.updateReminder.lastReservedLocalDay).join(",") === "2026-11-03,2026-11-04,2026-11-05");
  const crash = fixture(days.e.settings, days.e.time);
  crash.start();
  check("restart after reservation before paint loses the notice rather than duplicating it",
    !crash.owner.snapshot().canShowUpdate && !crash.owner.snapshot().presentationId);

  const future = fixture({ ...cached(), updateReminder: { schema: 1, lastReservedLocalDay: "2099-12-31" } });
  future.start();
  await future.owner.checkManual();
  check("valid wrong future reminder date suppresses only automatic display not manual checks",
    future.e.settings.updateReminder.lastReservedLocalDay === "2099-12-31" &&
    future.e.writes.every(patch => !patch.updateReminder) &&
    future.e.checks === 1 && future.owner.snapshot().presentationOrigin === "manual");
  check("Gregorian permission validator rejects rollover impossible unpadded and non-date metadata",
    validDay("2028-02-29") && !validDay("2026-02-29") && !validDay("2026-04-31") &&
    !validDay("2026-1-03") && !validDay("2026-11-03T00:00:00Z") && !validDay(null));
  const badReminder = fixture({ ...cached(), updateReminder: { schema: 1, lastReservedLocalDay: "2026-02-30" } });
  badReminder.start();
  await badReminder.owner.checkManual();
  check("invalid persisted permission fails closed with diagnostics but manual availability remains usable",
    badReminder.e.logs.length > 0 && badReminder.owner.snapshot().scheduleError.includes("Invalid saved") &&
    badReminder.e.writes.every(patch => !patch.updateReminder) &&
    badReminder.owner.snapshot().presentationOrigin === "manual" && badReminder.e.checks === 1);
  const corrupt = { ...first, dueAt: dayAt("2026-12-01") };
  const badSlot = fixture({ updateSchedule: corrupt });
  badSlot.start();
  check("invalid schedule deadline day and extra authority fields are rejected and diagnosed",
    !validSlot(corrupt) && !validSlot({ ...first, url: "untrusted" }) &&
    badSlot.e.settings.updateSchedule.dueAt !== corrupt.dueAt && badSlot.e.logs.length > 0);

  const failed = fixture(cached());
  failed.e.failWrite = "updateReminder";
  failed.start();
  const failedBeforeManual = failed.owner.snapshot();
  await failed.owner.checkManual();
  check("failed reservation save refuses automatic permission while preserving manual feedback",
    !failedBeforeManual.canShowUpdate && !failedBeforeManual.presentationId &&
    failedBeforeManual.scheduleError.includes("disk refused") &&
    !failed.e.settings.updateReminder && failed.owner.snapshot().presentationOrigin === "manual" &&
    failed.e.checks === 1);
  const failedClaim = fixture();
  failedClaim.start();
  failedClaim.e.failWrite = "updateSchedule";
  failedClaim.due();
  await settle();
  failedClaim.owner.reconcile("resume");
  check("failed durable schedule claim never dispatches or spins retries",
    failedClaim.e.checks === 0 && failedClaim.e.settings.updateSchedule.state === "pending" &&
    failedClaim.e.logs.length === 1 && failedClaim.owner.snapshot().scheduleError.includes("disk refused"));

  const midnight = fixture(cached(), dayAt("2026-11-03", "23:59:40"));
  midnight.e.modal = true;
  midnight.start();
  check("near-midnight fixture proves no pending deadline can fit the future minimum window",
    midnight.calendar(midnight.e.time).nextMidnight - midnight.e.time < 60000 &&
    midnight.e.settings.updateSchedule === null && midnight.e.checks === 0);
  midnight.at("2026-11-04", "00:00:00", "timer");
  const nextSlot = midnight.e.settings.updateSchedule;
  midnight.e.modal = false;
  midnight.owner.reconcile();
  check("calendar midnight chooses a future slot and final display reserves the actual new local day",
    validSlot(nextSlot) && nextSlot.dueAt > midnight.e.time &&
    midnight.e.settings.updateReminder.lastReservedLocalDay === "2026-11-04");

  const dst = [];
  for (const [date, length] of [["2026-03-08", 23], ["2026-11-01", 25]]) {
    const time = Date.parse(date + (length === 23 ? "T00:01:00-05:00" : "T00:01:00-04:00"));
    const d = fixture({}, time, "America/New_York");
    d.start();
    const before = structuredClone(d.e.settings.updateSchedule);
    const c = d.calendar(time);
    d.e.time += 3 * 60 * 60 * 1000;
    d.owner.reconcile("focus");
    dst.push({ length: (c.nextMidnight - c.midnight) / 3600000, expected: length,
      stable: JSON.stringify(before) === JSON.stringify(d.e.settings.updateSchedule) });
  }
  check("DST spring and fall days use calendar midnight and preserve the absolute same-zone slot",
    dst.every(item => item.length === item.expected && item.stable), dst);
  const zone = fixture();
  zone.start();
  const oldZone = structuredClone(zone.e.settings.updateSchedule);
  zone.e.zone = "Europe/London";
  zone.owner.reconcile("focus");
  check("same-date named timezone change replaces only a pending slot with a future deadline",
    zone.e.settings.updateSchedule.id !== oldZone.id &&
    zone.e.settings.updateSchedule.timeZone === "Europe/London" &&
    zone.e.settings.updateSchedule.dueAt > zone.e.time && zone.e.checks === 0);
  zone.due();
  await settle();
  const zoneClaim = structuredClone(zone.e.settings.updateSchedule);
  zone.e.zone = "UTC";
  zone.owner.reconcile("focus");
  check("same-date claimed slot survives timezone change without another check",
    JSON.stringify(zoneClaim) === JSON.stringify(zone.e.settings.updateSchedule) && zone.e.checks === 1);
  const cross = fixture({}, dayAt("2026-11-03", "01:00:00"));
  cross.start();
  cross.e.zone = "America/Los_Angeles";
  cross.owner.reconcile("resume");
  check("backward timezone date chooses a future current-day slot not an immediate catch-up",
    cross.e.settings.updateSchedule.localDay === "2026-11-02" &&
    cross.e.settings.updateSchedule.dueAt > cross.e.time && cross.e.checks === 0);
  const rollback = fixture();
  rollback.start();
  const rollbackId = rollback.e.settings.updateSchedule.id;
  rollback.e.time -= 3600000;
  rollback.owner.reconcile("focus");
  check("same-day clock rollback recomputes at most one future pending deadline",
    rollback.e.settings.updateSchedule.id !== rollbackId &&
    rollback.e.settings.updateSchedule.dueAt > rollback.e.time && rollback.e.checks === 0);

  const resume = fixture();
  resume.start();
  const staleCallback = [...resume.e.timers.values()][0].callback;
  resume.e.checkGate = gate();
  resume.at("2026-11-10");
  await settle();
  const resumedId = resume.e.settings.updateSchedule.id;
  resume.owner.reconcile("resume"); resume.owner.reconcile("focus");
  staleCallback();
  check("multi-day resume claims only today's catch-up and stale timers cannot claim a replacement slot",
    resume.e.checks === 1 && resume.e.settings.updateSchedule.localDay === "2026-11-10" &&
    resume.e.settings.updateSchedule.state === "claimed" &&
    resume.e.settings.updateSchedule.id === resumedId);
  resume.at("2026-11-09");
  const replacement = structuredClone(resume.e.settings.updateSchedule);
  resume.e.checkGate.resolve();
  await settle();
  check("old check completion cannot overwrite a backward replacement slot identity or claim",
    replacement.state === "pending" &&
    JSON.stringify(replacement) === JSON.stringify(resume.e.settings.updateSchedule));
  const closedDays = fixture(resume.e.settings, dayAt("2026-11-20"));
  closedDays.start();
  await closedDays.owner.checkStartup();
  check("fresh launch chooses a future current-day slot and independently retains one startup check",
    closedDays.e.settings.updateSchedule.localDay === "2026-11-20" &&
    closedDays.e.settings.updateSchedule.dueAt > closedDays.e.time && closedDays.e.checks === 1);
  await closedDays.owner.checkStartup();
  check("startup one-shot still avoids a second provider call", closedDays.e.checks === 1);

  const busy = fixture(cached());
  busy.e.modal = true; busy.start();
  busy.e.downloadGate = gate();
  const download = busy.state.download();
  await settle();
  busy.due();
  await settle();
  check("busy fixture proves a real active download and one parked unclaimed due intent",
    busy.e.downloads === 1 && busy.state.snapshot().status === "downloading" &&
    busy.e.settings.updateSchedule.state === "pending" && busy.e.checks === 1 &&
    !busy.e.settings.updateReminder);
  busy.e.downloadGate.resolve();
  await download;
  await settle();
  check("download settlement releases exactly one due check without installing or authorizing a dialog toast",
    busy.e.checks === 2 && busy.e.settings.updateSchedule.state === "claimed" &&
    !busy.owner.snapshot().canShowUpdate && !busy.e.settings.updateReminder);
  busy.e.modal = false; busy.e.mainDialog = true;
  busy.owner.reconcile();
  check("Main-owned dialog also defers automatic display without spending reminder permission",
    !busy.e.settings.updateReminder && !busy.owner.snapshot().canShowUpdate);
  busy.e.mainDialog = false;
  busy.owner.reconcile();
  check("dialog closure grants the waiting reminder exactly once",
    busy.e.settings.updateReminder.lastReservedLocalDay === "2026-11-03" &&
    busy.owner.snapshot().canShowUpdate && busy.e.checks === 2);
  const installing = fixture();
  installing.start(); installing.e.installing = true; installing.due();
  installing.owner.reconcile("resume");
  await settle();
  check("install approval parks daily intent without provider dispatch",
    installing.e.settings.updateSchedule.state === "pending" && installing.e.checks === 0);
  installing.e.installing = false;
  installing.state.publish();
  await settle();
  check("canceled install approval leaves scheduler live and releases one claimed check",
    installing.e.checks === 1 && installing.e.settings.updateSchedule.state === "claimed" &&
    installing.e.timers.size === 1);

  const parked = fixture(cached());
  parked.e.hasWindow = false; parked.start();
  check("no ordinary reader parks timers network and automatic permission",
    parked.e.timers.size === 0 && parked.e.checks === 0 && parked.e.writes.length === 0);
  parked.e.hasWindow = true; parked.owner.changed();
  await settle();
  check("ordinary reader return starts one schedule and grants cached availability",
    validSlot(parked.e.settings.updateSchedule) && parked.e.timers.size === 1 &&
    parked.owner.snapshot().canShowUpdate);
  const stopped = fixture();
  stopped.start(); stopped.e.checkGate = gate(); stopped.due();
  await settle();
  const stoppedCallback = [...stopped.e.timers.values()][0].callback;
  const beforeStop = stopped.e.published.length;
  stopped.owner.stop();
  stoppedCallback();
  stopped.e.checkGate.resolve();
  await settle();
  stopped.owner.reconcile("resume");
  check("actual teardown cancels timers and refuses late callbacks completions and publications",
    stopped.e.timers.size === 0 && stopped.e.checks === 1 && stopped.e.published.length === beforeStop);

  const crossing = fixture({}, dayAt("2026-11-03", "23:58:00"));
  crossing.start(); crossing.e.checkGate = gate(); crossing.due();
  await settle();
  crossing.e.time = dayAt("2026-11-04", "00:00:10");
  crossing.e.checkGate.resolve();
  await settle();
  check("automatic completion crossing midnight reserves display-day components not the request-start day",
    crossing.e.settings.updateReminder.lastReservedLocalDay === "2026-11-04" &&
    crossing.owner.snapshot().presentationOrigin === "automatic");
  const local = fixture(cached(), dayAt("2026-11-03", "01:00:00"), "America/Los_Angeles");
  local.start();
  check("reminder permission follows local Gregorian date when UTC already names tomorrow",
    local.e.settings.updateReminder.lastReservedLocalDay === "2026-11-02");
  const higher = fixture(cached());
  higher.start(); higher.owner.dismiss(higher.owner.snapshot().presentationId);
  const priorPresentation = higher.owner.snapshot().presentationId;
  higher.e.version = "0.14.0";
  await higher.state.check(); await settle();
  check("different available version cannot bypass the same-day automatic popup cap",
    higher.state.snapshot().availableVersion === "0.14.0" &&
    higher.owner.snapshot().presentationId === priorPresentation &&
    higher.owner.snapshot().presentationDismissed && !higher.owner.snapshot().canShowUpdate);
  const finalizing = fixture(cached());
  finalizing.e.modal = true; finalizing.start(); finalizing.e.finalizeGate = gate();
  const finalDownload = finalizing.state.download();
  await settle(); finalizing.due(); await settle();
  check("finalization fixture proves downloaded event is still busy and cannot spend scheduled intent",
    finalizing.state.snapshot().status === "finalizing" && finalizing.e.downloads === 1 &&
    finalizing.e.settings.updateSchedule.state === "pending" && finalizing.e.checks === 1);
  finalizing.e.finalizeGate.resolve(); await finalDownload; await settle();
  check("verified finalization releases one daily check without altering ready artifact authority",
    finalizing.e.checks === 2 && finalizing.e.settings.updateSchedule.state === "claimed" &&
    finalizing.state.snapshot().canInstall);
  const lateJoin = fixture();
  lateJoin.start(); lateJoin.e.checkGate = gate(); lateJoin.due(); await settle();
  const joinedManual = lateJoin.owner.checkManual();
  lateJoin.e.checkGate.resolve(); await joinedManual; await settle();
  check("manual request joining automatic provider work retains explicit feedback without an automatic duplicate",
    lateJoin.e.checks === 1 && lateJoin.owner.snapshot().presentationOrigin === "manual" &&
    !lateJoin.e.settings.updateReminder);
  const waitingStartup = fixture();
  waitingStartup.e.hasWindow = false; waitingStartup.start();
  await waitingStartup.owner.checkStartup();
  check("startup due intent parks without an ordinary reader instead of checking behind popup windows",
    waitingStartup.e.checks === 0 && waitingStartup.e.timers.size === 0);
  waitingStartup.e.hasWindow = true; waitingStartup.owner.changed(); await settle();
  check("returning reader releases independently deferred startup exactly once",
    waitingStartup.e.checks === 1 && waitingStartup.e.timers.size === 1);

  // Execute the production preload and toast, not an imitation of the public
  // projection/dismissal rules. Native Main/window qualification is separate.
  const events = new EventEmitter(), sent = [];
  events.send = (...args) => sent.push(args);
  events.invoke = async () => ({ ...days.owner.snapshot(), arbitraryUrl: "excluded", localDay: "excluded" });
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "main-preload.js"), "utf8"), {
    process: { isMainFrame: true, argv: [] },
    require: () => ({ ipcRenderer: events, contextBridge: { exposeInMainWorld(_name, value) { api = value; } } }),
  });
  const projected = await api.getUpdateState();
  let refused = false;
  try { api.dismissUpdateNotice({ version: "0.13.0" }); } catch { refused = true; }
  api.dismissUpdateNotice(projected.presentationId);
  check("production preload projects stable presentation fields and accepts only opaque dismissal identity",
    projected.presentationId === days.owner.snapshot().presentationId &&
    !Object.hasOwn(projected, "arbitraryUrl") && !Object.hasOwn(projected, "localDay") &&
    Object.isFrozen(api) && refused &&
    sent.some(args => args[0] === "dismiss-update-notice" && args[1] === projected.presentationId));
  privateSurface();
  nativeControllerBindings();
}

function nativeControllerBindings() {
  const file = path.join(__dirname, "test-about-updates.js");
  const source = fs.readFileSync(file, "utf8").replace("  const watchdog = setTimeout",
    "  globalThis.fixtureBindings = { daily: typeof daily, combined: typeof combined };\n" +
    "  const watchdog = setTimeout");
  const app = new EventEmitter();
  Object.assign(app, {
    getVersion: () => "0.12.0", setPath() {}, setAppLogsPath() {},
    whenReady: () => ({ then: () => ({ catch() {} }) }),
  });
  const context = vm.createContext({
    __dirname, __filename: file, performance, console: { log() {}, error() {} },
    process: { argv: ["electron", file, "daily"], platform: "win32", env: {} },
    setTimeout: () => 1,
    require(name) {
      if (name === "./test-userdata-isolation") return {};
      if (name === "fs") return { mkdirSync() {}, writeFileSync() {} };
      if (name === "electron") return {
        app, dialog: {}, shell: {}, ipcMain: new EventEmitter(), powerMonitor: new EventEmitter(),
      };
      if (name === "module") return { _load() {} };
      if (name === "child_process") return {};
      if (name === "./test-visual-utils" || name.endsWith(path.join("src", "main.js"))) return {};
      return require(name);
    },
  });
  vm.runInContext(source, context);
  check("real native controller declares daily and combined fixtures at executable entry scope without starting Electron",
    context.fixtureBindings?.daily === "function" && context.fixtureBindings.combined === "function");
}

function mainPorts() {
  const { pathToFileURL } = require("url");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const between = (start, end) => {
    const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
    if (first < 0 || last < 0) throw new Error("Missing actual Main update boundary");
    return source.slice(first, last);
  };
  const ports = new EventEmitter(), handles = new Map();
  ports.handle = (name, callback) => handles.set(name, callback);
  const f = fixture(cached()); f.start();
  const frame = { frameTreeNodeId: 7, parent: null, isDestroyed: () => false,
    url: pathToFileURL(path.join(__dirname, "..", "src", "index.html")).href };
  const sender = Object.assign(new EventEmitter(), { id: 11, mainFrame: frame, isDestroyed: () => false });
  const win = Object.assign(new EventEmitter(), {
    webContents: sender, isVisible: () => true, isMinimized: () => false,
  });
  const context = vm.createContext({ path, pathToFileURL, __dirname: path.join(__dirname, "..", "src"),
    shutdownOwnerWindow: () => win, updateReaderWindow: () => win,
    ownedDialogs: null, updateMainDialogDepth: 0, pendingShutdown: false, pendingShutdownCommit: false,
    ipcMain: ports, updateSchedule: f.owner, updateSurface: null, updateNotes: null });
  vm.runInContext(between("function isApprovalSender(event) {", "\nfunction addDiagnosticCount") +
    "\n" + between("function bindUpdateWindow(win) {", "// Called once by getAutoUpdater()"), context);
  context.bindUpdateWindow(win);
  const id = f.owner.snapshot().presentationId, event = { sender, senderFrame: frame };
  ports.emit("dismiss-update-notice", { sender, senderFrame: null }, id);
  ports.emit("dismiss-update-notice", { sender: { ...sender, id: 12 }, senderFrame: frame }, id);
  ports.emit("dismiss-update-notice", event, "stale-id");
  check("actual Main update dismissal rejects missing foreign and stale presentation authority",
    !f.owner.snapshot().presentationDismissed && f.owner.snapshot().canShowUpdate);
  ports.emit("update-surface-state", event, { modal: false, mainDialog: false, localDay: "forged" });
  ports.emit("update-surface-state", { sender, senderFrame: { ...frame, parent: frame } },
    { modal: false, mainDialog: false });
  check("actual Main surface port rejects extra calendar authority and child-frame observations",
    context.updateSurface === null);
  ports.emit("update-surface-state", event, { modal: true, mainDialog: false });
  ports.emit("dismiss-update-notice", event, id);
  const state = handles.get("get-update-state")(event);
  check("actual Main authenticated ports share the current presentation and bounded modal observation",
    state.presentationId === id && state.presentationDismissed &&
    context.updateSurface.frame === frame && context.updateSurface.modal);
  vm.runInContext("globalThis.actualCanPresent = ({" +
    between("  canPresent: origin => {", "\n  publish: state => {") + "}).canPresent;", context);
  const sameMainFrame = { ...frame };
  ports.emit("update-surface-state", { sender, senderFrame: sameMainFrame },
    { modal: false, mainDialog: false });
  check("actual Main accepts distinct wrappers for the same authenticated main frame",
    sameMainFrame !== sender.mainFrame && context.updateSurface.frame === sameMainFrame &&
    context.actualCanPresent("automatic") && context.actualCanPresent("manual"));
  const survivingSurface = context.updateSurface;
  sender.emit("did-start-navigation", {}, "https://example.invalid", false, true);
  check("actual Main denied navigation preserves the surviving document update surface",
    context.updateSurface === survivingSurface && context.updateSurface.frame === sameMainFrame);
  sender.emit("did-navigate", {}, frame.url);
  check("actual Main committed navigation retires the previous document update surface",
    context.updateSurface === null);
  ports.emit("update-surface-state", event, { modal: false, mainDialog: false });
  sender.emit("render-process-gone", {}, { reason: "crashed" });
  check("actual Main renderer loss retires its update surface",
    context.updateSurface === null);
  const track = between("function trackUpdateDialog(promise) {", "\nfunction mainDialogs() {");
  const tracker = vm.createContext({ updateMainDialogDepth: 0, updateSchedule: { changed() {} } });
  vm.runInContext(track, tracker);
  const work = gate();
  const task = tracker.trackUpdateDialog(work.promise);
  check("actual Main native dialog tracking preserves the original workflow promise and marks it busy",
    task === work.promise && tracker.updateMainDialogDepth === 1);
  work.resolve();
  return task.then(() => {
    check("actual Main native dialog completion releases only its own busy ownership",
      tracker.updateMainDialogDepth === 0);
  });
}

function privateSurface() {
  const events = new EventEmitter(), sent = [], documentEvents = new Map(), windowEvents = new Map();
  let mutation, disconnected = false, modal = false;
  events.send = (...args) => sent.push(args);
  events.sendSync = () => ({});
  const document = { readyState: "loading", documentElement: {},
    addEventListener: (name, callback) => documentEvents.set(name, callback),
    querySelector: () => modal ? {} : null };
  const window = { addEventListener(name, callback) {
    if (!windowEvents.has(name)) windowEvents.set(name, []);
    windowEvents.get(name).push(callback);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "main-preload.js"), "utf8"), {
    process: { isMainFrame: true, argv: ["--folia-session-bootstrap=" + "a".repeat(64)] },
    document, window, localStorage: { getItem: () => null },
    MutationObserver: class {
      constructor(callback) { mutation = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    require: () => ({ ipcRenderer: events, contextBridge: { exposeInMainWorld() {} } }),
    console,
  });
  documentEvents.get("DOMContentLoaded")();
  modal = true; mutation();
  events.emit("main-dialog-visibility", {}, true);
  mutation();
  const observed = sent.filter(args => args[0] === "update-surface-state");
  check("production isolated preload observes application and Main dialogs without exposing target authority",
    observed.length === 3 && observed.map(args => `${args[1].modal}:${args[1].mainDialog}`).join(",") ===
      "false:false,true:false,true:true" &&
    observed.every(args => Object.keys(args[1]).sort().join(",") === "mainDialog,modal"));
  for (const callback of windowEvents.get("pagehide") || []) callback();
  events.emit("main-dialog-visibility", {}, false);
  check("production isolated preload retires modal observation on renderer pagehide",
    disconnected && sent.filter(args => args[0] === "update-surface-state").length === observed.length);
}

function toastFixture(initial) {
  const nodes = new Map(), callbacks = {};
  const element = id => {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set();
    const node = { style: {}, hidden: false, textContent: "", disabled: false,
      addEventListener(event, callback) { this[event] = callback; },
      setAttribute() {},
      replaceChildren() {},
      classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
        contains: value => classes.has(value),
      } };
    nodes.set(id, node);
    return node;
  };
  let received, dismissed;
  const window = {
    folia: {
      onUpdateStatus(callback) { received = callback; return () => {}; },
      getUpdateState() { return Promise.resolve(initial); },
      dismissUpdateNotice(id) { dismissed = id; },
    },
    addEventListener(event, callback) { callbacks[event] = callback; },
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "app-updates.js"), "utf8");
  vm.runInNewContext(source, { window, document: { getElementById: element }, console });
  received(initial);
  const visible = element("appUpdateToast").classList.contains("show");
  element("laterUpdateBtn").click();
  received({ ...initial, revision: initial.revision + 1, status: "downloading", percent: 42 });
  received({ ...initial, revision: initial.revision + 2, status: "error", error: "Fixture progress tail" });
  check("production toast dismissal follows stable presentation not status or error revisions",
    visible && dismissed === initial.presentationId && !element("appUpdateToast").classList.contains("show"));
  received({ ...initial, revision: initial.revision + 3, presentationId: "fresh-day", presentationDismissed: false });
  check("production toast permits a fresh later presentation of the same version",
    element("appUpdateToast").classList.contains("show"));
}

const proofGroups = ["high-water", "reservation", "metadata", "claim", "join", "stale-timer",
  "claimed-zone", "startup-park", "teardown", "toast", "projection", "slot-stability", "main-ports",
  "download-preflight", "manual-failure", "startup-delay", "manual-action", "manual-target", "release-failure",
  "automatic-target"];
async function proofRun(group) {
  if (!proofGroups.includes(group)) throw new Error("Unknown daily proof group: " + group);
  // Every isolated proof has a surviving real-provider control, independent of
  // the branch being reverted. A setup failure cannot masquerade as detection.
  const control = fixture();
  await control.state.check();
  check(`daily ${group} control resolves real provider availability without download authority`,
    control.e.checks === 1 && control.e.downloads === 0 &&
    control.state.snapshot().availableVersion === "0.13.0" && !control.state.snapshot().canInstall);
  if (group === "high-water") {
    const f = fixture({ ...cached(), updateReminder: { schema: 1, lastReservedLocalDay: "2026-11-04" } });
    f.start();
    const a = f.owner.snapshot().presentationId;
    f.at("2026-11-04"); await settle();
    const b = f.owner.snapshot().presentationId;
    f.at("2026-11-03"); await settle();
    f.at("2026-11-04"); await settle();
    const revisited = f.owner.snapshot().presentationId;
    f.at("2026-11-05"); await settle();
    check("daily proof high-water refuses reserved and revisited days then admits C",
      !a && !b && !revisited && f.owner.snapshot().canShowUpdate &&
      f.e.writes.filter(patch => patch.updateReminder).map(patch =>
        patch.updateReminder.lastReservedLocalDay).join(",") === "2026-11-05");
  } else if (group === "reservation") {
    const f = fixture(cached());
    f.e.failWrite = "updateReminder"; f.start();
    check("daily proof failed reservation cannot authorize automatic display",
      !f.owner.snapshot().canShowUpdate && !f.owner.snapshot().presentationId &&
      f.owner.snapshot().scheduleError.includes("disk refused"));
    await f.owner.checkManual();
    check("daily proof failed reservation preserves explicit manual feedback",
      f.e.checks === 1 && f.owner.snapshot().presentationOrigin === "manual" && f.owner.snapshot().canShowUpdate);
  } else if (group === "metadata") {
    const f = fixture({ ...cached(), updateReminder: { schema: 1, lastReservedLocalDay: "2026-02-30" } });
    f.start();
    check("daily proof impossible persisted reminder dates are diagnosed and fail closed",
      f.owner.snapshot().scheduleError.includes("Invalid saved update reminder") &&
      !f.owner.snapshot().canShowUpdate && !f.e.writes.some(patch => patch.updateReminder));
  } else if (group === "claim") {
    const f = fixture();
    f.start(); f.e.error = true; f.due(); await settle();
    f.owner.reconcile("focus");
    check("daily proof durable claim precedes dispatch and survives an offline result",
      f.e.claimAtDispatch === "claimed" && f.e.settings.updateSchedule.state === "claimed" &&
      f.e.checks === 1 && f.owner.snapshot().status === "error");
  } else if (group === "join") {
    const f = fixture();
    f.start(); f.e.checkGate = gate(); f.due(); await settle();
    const manual = f.owner.checkManual();
    f.e.checkGate.resolve(); await manual; await settle();
    check("daily proof manual join owns one shared completion presentation",
      f.e.checks === 1 && f.owner.snapshot().presentationOrigin === "manual" &&
      f.owner.snapshot().canShowUpdate && !f.e.settings.updateReminder);
  } else if (group === "stale-timer") {
    const f = fixture();
    f.start();
    const old = [...f.e.timers.values()][0].callback;
    f.e.time -= 3600000; f.owner.reconcile("focus");
    f.e.time = f.e.settings.updateSchedule.dueAt;
    old(); await settle();
    check("daily proof old timer cannot spend a replacement slot at its new deadline",
      f.e.checks === 0 && f.e.settings.updateSchedule.state === "pending");
    f.owner.reconcile("timer"); await settle();
    check("daily proof replacement deadline remains independently dispatchable",
      f.e.checks === 1 && f.e.settings.updateSchedule.state === "claimed");
  } else if (group === "claimed-zone") {
    const f = fixture();
    f.start(); f.due(); await settle();
    const claimed = JSON.stringify(f.e.settings.updateSchedule);
    f.e.zone = "Europe/London"; f.owner.reconcile("focus"); await settle();
    check("daily proof same-date timezone changes retain an already claimed absolute slot",
      JSON.stringify(f.e.settings.updateSchedule) === claimed && f.e.checks === 1);
  } else if (group === "startup-park") {
    const f = fixture();
    f.e.hasWindow = false; f.start(); await f.owner.checkStartup(); await settle();
    const before = f.e.checks;
    f.e.hasWindow = true; f.owner.changed(); await settle();
    check("daily proof deferred startup waits for ordinary reader ownership",
      before === 0 && f.e.checks === 1 && f.e.timers.size === 1);
  } else if (group === "teardown") {
    const f = fixture();
    f.start(); f.owner.stop();
    check("daily proof actual teardown cancels the owned calendar timer", f.e.timers.size === 0);
  } else if (group === "toast") {
    const f = fixture(cached()); f.start();
    toastFixture(f.owner.snapshot());
  } else if (group === "projection") {
    const events = new EventEmitter();
    events.invoke = async () => ({ revision: 1, installedVersion: "0.12.0", status: "available",
      presentationId: "main-owned", presentationVersion: "0.13.0", canShowUpdate: true,
      localDay: "untrusted", arbitraryUrl: "untrusted" });
    let api;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "main-preload.js"), "utf8"), {
      process: { isMainFrame: true, argv: [] },
      require: () => ({ ipcRenderer: events, contextBridge: { exposeInMainWorld(_name, value) { api = value; } } }),
    });
    const value = await api.getUpdateState();
    check("daily proof production preload preserves Main presentation identity", value.presentationId === "main-owned");
    check("daily proof production preload excludes raw calendar and URL authority",
      !Object.hasOwn(value, "localDay") && !Object.hasOwn(value, "arbitraryUrl"));
  } else if (group === "slot-stability") {
    const f = fixture();
    f.start();
    const first = JSON.stringify(f.e.settings.updateSchedule);
    f.e.random = 0.1; f.owner.reconcile("focus");
    check("daily proof ordinary same-day focus cannot reroll a pending slot",
      JSON.stringify(f.e.settings.updateSchedule) === first && f.e.writes.length === 1);
  } else if (group === "main-ports") {
    await mainPorts();
  } else if (group === "startup-delay") {
    const seed = fixture();
    seed.start();
    await overdueRestart(seed.e.settings.updateSchedule, seed.e.time);
  } else if (group === "manual-action") {
    const f = fixture(cached());
    f.start();
    const prior = f.owner.snapshot().presentationId;
    f.owner.dismiss(prior);
    check("manual action setup proves a dismissed reserved presentation",
      f.owner.snapshot().presentationDismissed && !f.owner.snapshot().canShowUpdate &&
      f.e.settings.updateReminder.lastReservedLocalDay === f.calendar(f.e.time).day);
    f.owner.beginManualAction();
    f.state.fail(new Error("Explicit action failed"));
    check("manual action failure has fresh visible feedback after prior dismissal",
      f.owner.snapshot().presentationId !== prior && f.owner.snapshot().canShowUpdate &&
      f.owner.snapshot().presentationOrigin === "manual" &&
      f.owner.snapshot().error === "Explicit action failed");
  } else if (group === "automatic-target") {
    const f = fixture(cached());
    f.start();
    const prior = f.owner.snapshot().presentationId;
    check("automatic target setup proves one live reserved presentation",
      !!prior && f.owner.snapshot().canShowUpdate &&
      f.owner.snapshot().presentationOrigin === "automatic" &&
      f.e.writes.filter(patch => patch.updateReminder).length === 1);
    f.e.version = "0.14.0";
    await f.state.check(); await settle();
    check("live automatic presentation follows a newer offer without spending another reminder",
      f.owner.snapshot().presentationId === prior && f.owner.snapshot().canShowUpdate &&
      f.owner.snapshot().presentationVersion === "0.14.0" &&
      f.e.writes.filter(patch => patch.updateReminder).length === 1);
    f.owner.dismiss(prior);
    f.e.version = "0.15.0";
    await f.state.check(); await settle();
    check("automatic target change preserves a dismissed presentation and the daily reservation",
      f.owner.snapshot().presentationId === prior && f.owner.snapshot().presentationDismissed &&
      !f.owner.snapshot().canShowUpdate && f.owner.snapshot().presentationVersion === "0.15.0" &&
      f.e.writes.filter(patch => patch.updateReminder).length === 1);
  } else if (group === "manual-target") {
    const f = fixture(cached());
    f.start();
    const prior = f.owner.snapshot().presentationId;
    f.owner.dismiss(prior);
    f.owner.beginManualAction();
    const accepted = f.owner.snapshot().presentationId;
    f.e.version = "0.14.0";
    f.e.downloadGate = gate();
    const downloading = f.state.download();
    await settle();
    check("manual target setup proves provider preflight superseded cached availability during an accepted download",
      f.e.checks === 1 && f.e.downloads === 1 &&
      f.state.snapshot().availableVersion === "0.14.0" && f.state.snapshot().status === "downloading");
    check("manual download presentation follows confirmed target without changing identity or hiding",
      accepted !== prior && f.owner.snapshot().presentationId === accepted &&
      f.owner.snapshot().presentationVersion === "0.14.0" && f.owner.snapshot().canShowUpdate);
    f.owner.dismiss(accepted);
    f.e.downloadGate.resolve();
    await downloading;
    await settle();
    check("manual target settlement preserves dismissal and verified artifact authority",
      f.owner.snapshot().presentationId === accepted && f.owner.snapshot().presentationDismissed &&
      !f.owner.snapshot().canShowUpdate && f.state.snapshot().readyVersion === "0.14.0" &&
      f.state.snapshot().canInstall);
  } else if (group === "release-failure") {
    const f = fixture(cached(), dayAt("2026-11-03"), "UTC", "darwin");
    f.start();
    const prior = f.owner.snapshot().presentationId;
    f.owner.dismiss(prior);
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const start = source.indexOf('ipcMain.on("open-update-release", event => {');
    const end = source.indexOf("\n// Installing an update", start);
    if (start < 0 || end < 0) throw new Error("Missing actual release fallback boundary");
    const ports = new EventEmitter(), urls = [];
    vm.runInNewContext(source.slice(start, end), {
      ipcMain: ports, isUpdaterSender: event => event.accepted === true,
      updateSchedule: f.owner, updateState: f.state,
      shell: { openExternal(url) { urls.push(url); return Promise.reject(new Error("Fixture browser refused")); } },
    });
    ports.emit("open-update-release", { accepted: false });
    check("release fallback rejects unauthorized requests without opening or spending presentation",
      f.state.snapshot().manualOnly && urls.length === 0 && f.owner.snapshot().presentationId === prior &&
      f.owner.snapshot().presentationDismissed);
    ports.emit("open-update-release", { accepted: true });
    await settle();
    check("explicit release fallback failure has fresh visible manual feedback after dismissal",
      urls.join(",") === "https://github.com/lostinsea/markaloo/releases/latest" &&
      f.owner.snapshot().presentationId !== prior && f.owner.snapshot().canShowUpdate &&
      f.owner.snapshot().presentationOrigin === "manual" &&
      f.owner.snapshot().error === "Fixture browser refused");
  } else if (group === "download-preflight") {
    const f = fixture(cached());
    f.e.modal = true; f.start(); f.e.checkGate = gate(); f.e.downloadGate = gate();
    const downloading = f.state.download(); await settle();
    check("daily download preflight setup proves a held provider check owned by the download latch",
      f.e.checks === 1 && f.e.downloads === 0 && f.state.snapshot().status === "checking" &&
      !f.state.snapshot().canCheck);
    f.due(); await settle();
    check("daily proof download metadata checking cannot spend the parked scheduled intent",
      f.e.settings.updateSchedule.state === "pending" && f.e.checks === 1);
    f.e.checkGate.resolve(); await settle();
    f.e.downloadGate.resolve(); await downloading; await settle();
    check("daily download preflight control preserves verified artifact authority without installation",
      f.e.downloads === 1 && f.state.snapshot().canInstall);
  } else if (group === "manual-failure") {
    const f = fixture(cached());
    f.start(); f.owner.dismiss(f.owner.snapshot().presentationId);
    check("daily manual failure setup proves a reserved and dismissed automatic presentation",
      f.e.settings.updateReminder.lastReservedLocalDay === f.calendar(f.e.time).day &&
      f.owner.snapshot().presentationDismissed && !f.owner.snapshot().canShowUpdate);
    f.e.integrationError = true;
    const cause = await f.owner.checkManual().catch(error => { f.state.fail(error); return error; });
    await settle();
    const value = f.owner.snapshot();
    check("daily proof unexpected manual check rejection remains explicit after automatic permission is spent",
      cause?.message === "Broken integration fixture" && value.presentationOrigin === "manual" &&
      value.canShowUpdate && value.status === "error" && value.error.includes(cause.message));
  }
}

const selectedProof = process.env.MARKALOO_UPDATE_PROOF;
(selectedProof ? proofRun(selectedProof) : run().then(async () => {
  for (const group of proofGroups) await proofRun(group);
})).then(() => {
  const passed = results.filter(Boolean).length;
  console.log(`=== ${passed}/${results.length} passed ===`);
  process.exitCode = passed === results.length ? 0 : 1;
}, error => {
  console.error(error);
  process.exitCode = 1;
});
