// Regression harness for PERF-01: heavy optional modules must not be required
// during startup.
//
// docs/PERF-AUDIT.md measured require("html-to-docx") at 370.1ms and
// require("electron-updater") at 174.7ms — 544.8ms of main-thread work before
// the window could even be created, paid by every launch regardless of whether
// the session ever exported a DOCX or checked for an update. html-to-docx has
// since been removed outright along with Word export, which retires the larger
// of the two costs by deletion rather than by deferral. electron-updater remains
// optional, and startup must not eagerly load it or semver's unused range API.
//
// This harness IS the Electron main script. It requires ./main.js, so main.js
// runs in this very process and shares this process's module registry. That
// makes require.cache a direct, non-vacuous observation of what startup loaded
// — not a grep over source text, which would pass the moment someone moved the
// require behind an alias.
//
// The module must remain genuinely loadable, otherwise "not in the cache" would
// be trivially satisfiable by deleting the dependency — which is exactly what
// happened to html-to-docx, and is why that pair of assertions was removed
// together rather than leaving a load check standing over a deleted package.
// Section 2 loads it explicitly and checks the shape the call sites depend on.

// Isolation must be established before ../src/main.js is required and before the
// app becomes ready: main.js registers the ipcMain "confirm-large-render"
// handler and creates a real window, so running against the developer's real
// profile let a restored session containing a large document open a
// main-process modal that no test can dismiss.
//
// RETRACTED: this comment used to say "this suite is the ONLY one that requires
// ../src/main.js". That is false and was false when written - MEASURED, nine
// suites require it (mermaid, popups, security, patch, search, startup, tabs,
// tables, theme), which is exactly why one poisoned shared profile blocked the
// whole chain rather than one suite. `.github/copilot-instructions.md` already
// carries the correction; the claim is retracted here too because it is the
// stated rationale for the isolation assertions below.
const admission = require("./test-startup-admission");
const isolation = require("./test-userdata-isolation");
admission.acceptIsolation(isolation);

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const results = [];
let failed = 0;

function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failed++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : "  -> " + detail}`);
}

function cachedModulePaths(needle) {
  return Object.keys(require.cache).filter((p) =>
    p.split(path.sep).includes(needle),
  );
}

let finishing = false;
let feedServer = null;
async function closeFeed() {
  if (!feedServer) return;
  const server = feedServer;
  if (server.listening) {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    admission.closedFeed(server);
  }
  feedServer = null;
}
async function finish(error) {
  if (finishing) return;
  finishing = true;
  if (error) check("startup harness completed", false, String(error.stack || error));
  await closeFeed();
  await admission.destroyWindows();
  results.push(`=== ${results.length - failed}/${results.length} passed ===`);
  const text = results.join("\n") + "\n";
  // Electron drops buffered stdout on app.exit() when redirected, so the file
  // is the authoritative record; the console copy is a convenience only.
  admission.writeReport(text);
  console.log(text);
  admission.exit(failed === 0 ? 0 : 1);
}

// Loading main.js starts the real application in this process.
const { __shutdown } = require("../src/main.js");

async function run() {
  await app.whenReady();
  await admission.ready(__shutdown);
  // Let the ready handlers, window creation and any deferred startup work run.
  // checkForUpdatesOnStartup() is on app.on("ready"); if it ever regressed to
  // loading electron-updater eagerly in dev, it would have done so by now.
  await new Promise((r) => setTimeout(r, 3000));

  // --- 0. This suite must not be touching the developer's profile ----------
  // main.js registers ipcMain "confirm-large-render" and creates a real window,
  // so run against the real profile, a restored session holding an expensive
  // document reaches dialog.showMessageBoxSync(), which is modal IN THE MAIN
  // PROCESS: the watchdog above cannot fire, because the process that would run
  // its timer is the process that is blocked. Measured A/B: seeded profile hung
  // indefinitely with zero assertions; empty profile finished 7/7 in 8s. Nine
  // suites require main.js, so that is nine suites, not one.
  //
  // These assertions exist so that losing isolation fails FAST and BY NAME
  // instead of hanging, which is the only failure mode a harness can act on.
  const activeUserData = app.getPath("userData");
  check(
    "the suite runs against an isolated userData directory",
    isolation.USER_DATA_DIR !== null &&
      path.resolve(activeUserData) === path.resolve(isolation.USER_DATA_DIR),
    activeUserData,
  );
  check(
    "the suite is not using the developer's real profile",
    isolation.REAL_USER_DATA !== null &&
      path.resolve(activeUserData) !== path.resolve(isolation.REAL_USER_DATA) &&
      path.resolve(activeUserData) !== path.resolve(admission.originalUserData),
    `real=${admission.originalUserData}; helperPrevious=${isolation.REAL_USER_DATA}`,
  );
  // Pins the WIPE rather than the redirect. Isolation alone still lets a killed
  // run poison its own next run - a tab is persisted by saveTabs() the moment it
  // is created, long before any scenario cleanup closes it.
  check(
    "the suite booted from a profile with no inherited session",
    isolation.POST_WIPE_ENTRIES === 0 && !fs.existsSync(admission.witness),
    `entries=${isolation.POST_WIPE_ENTRIES}`,
  );
  // Observe actual post-isolation selections. Guessing a sibling from
  // app.getName() misses Main's retained Folia profile name after the rebrand.
  const profileRedirects = admission.mainProfileRedirects();
  check(
    "main.js's dev-profile redirect declined an already-relocated userData directory",
    profileRedirects.length === 0 &&
      path.resolve(activeUserData) === path.resolve(isolation.USER_DATA_DIR),
    `userData=${activeUserData} redirects=${JSON.stringify(profileRedirects)}`,
  );

  // --- 1. The heavy module is not loaded by startup ------------------------
  const updaterCached = cachedModulePaths("electron-updater");
  check(
    "startup loads the actual focused semantic version validators",
    ["semver/functions/valid", "semver/functions/gt"].every(name =>
      Object.hasOwn(require.cache, require.resolve(name))),
  );
  check(
    "startup does not load unused semantic range utilities or the full package entry",
    ["semver", "semver/classes/range", "semver/ranges/subset"].every(name =>
      !Object.hasOwn(require.cache, require.resolve(name))),
  );
  check(
    "electron-updater is not required during startup",
    updaterCached.length === 0,
    JSON.stringify(updaterCached.slice(0, 3)),
  );

  // Sanity: the probe can see modules that ARE loaded, so a zero above means
  // "absent", not "the probe is broken".
  check(
    "the require.cache probe detects a module that is loaded",
    cachedModulePaths("marked").length > 0 ||
      Object.keys(require.cache).some((p) => p.endsWith("main.js")),
    String(Object.keys(require.cache).length),
  );

  // --- 2. The module is still loadable and still the right shape -----------
  // Guards against "optimising" startup by breaking the feature outright.
  let updaterOk = false;
  let updaterDetail = "";
  try {
    const { autoUpdater } = require("electron-updater");
    // Call sites use .on/.checkForUpdates/.downloadUpdate/.quitAndInstall
    updaterOk =
      autoUpdater &&
      typeof autoUpdater.on === "function" &&
      typeof autoUpdater.checkForUpdates === "function" &&
      typeof autoUpdater.downloadUpdate === "function" &&
      typeof autoUpdater.quitAndInstall === "function";
    updaterDetail = autoUpdater ? Object.keys(autoUpdater).length + " keys" : "null";
  } catch (e) {
    updaterDetail = e.message;
  }
  check(
    "electron-updater still loads and exposes the used API",
    updaterOk,
    updaterDetail,
  );

  // --- 3. Requiring it really is expensive --------------------------------
  // Not an optimisation check — it is the evidence that section 1 is worth
  // asserting at all. It is in the cache now, so this measures a warm
  // re-require and is deliberately NOT compared against a threshold; the
  // number is recorded for the reader.
  const t0 = Date.now();
  require("electron-updater");
  results.push(`INFO  warm re-require of electron-updater: ${Date.now() - t0}ms`);

  // --- 4. The update check must not carry a persistent identifier ----------
  // electron-updater mints a random UUID, persists it to userData/.updaterId
  // and sends it as `x-user-staging-id` on every check. It is for staged
  // rollouts, which this project does not use, and it makes every check from
  // one machine linkable to every other one. main.js blanks it in
  // configureAutoUpdater().
  //
  // The oracle is the WIRE, not the source and not the configured object: a
  // real HTTP server stands in for the feed and reports the headers as
  // received. A source regex would pass the moment the assignment moved, and
  // reading `requestHeaders` back would only confirm the value was stored,
  // not that it reached the request. R169 proves it fails when reverted.
  const http = require("http");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ ...req.headers });
    res.writeHead(200, { "content-type": "text/yaml" });
    res.end("version: 99.0.0\npath: x.exe\nsha512: aaa\nreleaseDate: '2026-01-01'\n");
  });
  feedServer = server;
  await new Promise((resolve, reject) => {
    const failed = error => {
      server.removeListener("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.removeListener("error", failed);
      server.on("error", admission.fatal);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(0, "127.0.0.1");
  });
  const feedURL = admission.allowFeed(server);

  const { autoUpdater } = require("electron-updater");
  autoUpdater.logger = null;
  autoUpdater.forceDevUpdateConfig = true; // dev builds have no app-update.yml
  autoUpdater.setFeedURL({
    provider: "generic",
    url: feedURL,
  });
  let checkDetail = "";
  const packagedDescriptor = Object.getOwnPropertyDescriptor(app, "isPackaged");
  let onAvailable, onError;
  const completed = new Promise(resolve => {
    onAvailable = resolve;
    onError = error => {
      checkDetail = error.message.slice(0, 120);
      resolve();
    };
    autoUpdater.once("update-available", onAvailable);
    autoUpdater.once("error", onError);
  });
  try {
    // Exercise the real document frame and production preload. A synthetic
    // ipcMain event has no sender identity and must be refused.
    Object.defineProperty(app, "isPackaged", { configurable: true, get: () => true });
    await admission.execute("window.folia.checkForUpdates();true");
    await completed;
  } finally {
    if (packagedDescriptor) Object.defineProperty(app, "isPackaged", packagedDescriptor);
    else delete app.isPackaged;
    autoUpdater.removeListener("update-available", onAvailable);
    autoUpdater.removeListener("error", onError);
  }
  if (autoUpdater.autoDownload !== false || autoUpdater.autoInstallOnAppQuit !== false) {
    throw new Error("Production updater did not retain manual download/install");
  }
  await closeFeed();

  // Vacuity guard: an empty header set proves nothing if no request was made.
  check(
    "the update check really reached the stand-in feed",
    seen.length > 0,
    `${seen.length} requests; ${checkDetail}`,
  );

  const stagingIds = seen.map((h) => h["x-user-staging-id"]);
  check(
    "no update request carries a staging-id value",
    seen.length > 0 && stagingIds.every((v) => !v),
    JSON.stringify(stagingIds),
  );

  // The identifier is the payload; a bare empty header name is inert. Recorded
  // rather than asserted absent, because `computeFinalHeaders` can only
  // override the value and not remove the key.
  results.push(
    `INFO  update request headers: user-agent=${seen[0] ? seen[0]["user-agent"] : "n/a"}, ` +
      `x-user-staging-id present=${seen[0] ? "x-user-staging-id" in seen[0] : "n/a"}`,
  );

}
run().then(() => finish(), error => finish(error)).catch(admission.fatal);
