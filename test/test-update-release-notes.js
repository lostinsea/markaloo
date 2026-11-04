"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");
const { createUpdateReleaseNotes, NOTES_LIMITS: limits } = require("../src/update-release-notes");

const companion = process.argv.includes("--companion");
if (process.argv.slice(2).some(value => value !== "--companion")) {
  throw new Error("Unsupported release notes test argument");
}
const results = [];
const line = value => console.log((companion ? "[companion stdout] " : "") + value);
const watchdog = setTimeout(() => {
  line("FATAL release notes test: watchdog expired");
  process.exit(2);
}, 30000);
function check(name, ok, detail) {
  results.push(!!ok);
  line(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "  -> " + JSON.stringify(detail)}`);
}
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = (body = "notes", extra = {}) => new Response(JSON.stringify({
  tag_name: "v0.13.0", body, ...extra,
}));
function fixture() {
  const e = { offer: { id: "notice-1", version: "0.13.0", owner: "renderer-1" },
    calls: [], logs: [], timers: new Set(), elapsed: 0 };
  e.transport = () => response();
  const owner = createUpdateReleaseNotes({
    getOffer: () => e.offer,
    fetch(url, options) { e.calls.push({ url, options }); return e.transport(url, options); },
    now: () => e.elapsed,
    setTimer(callback, delay) {
      const timer = { callback, due: e.elapsed + delay };
      e.timers.add(timer);
      return timer;
    },
    clearTimer: timer => e.timers.delete(timer),
    log: (...args) => e.logs.push(args),
  });
  const load = (retry = false) => owner.load(e.offer?.id, e.offer?.version, retry);
  const advance = (ms, fire = false) => {
    e.elapsed += ms;
    if (fire) for (const timer of [...e.timers]) {
      if (timer.due <= e.elapsed) timer.callback();
    }
  };
  return { e, owner, load, advance };
}
async function failure(promise) {
  try { await promise; return ""; }
  catch (error) { return error.message; }
}

async function loader() {
  const f = fixture();
  f.owner.reconcile();
  check("release notes construction and reconciliation perform no request", f.e.calls.length === 0);
  const held = gate();
  f.e.transport = () => held.promise;
  const first = f.load();
  await settle();
  check("release notes expansion shares one pending request and one lifetime timer",
    first === f.load() && f.e.calls.length === 1 && f.e.timers.size === 1);
  const request = f.e.calls[0];
  check("release notes use only the fixed canonical exact-tag endpoint",
    request.url === "https://api.github.com/repos/lostinsea/markaloo/releases/tags/v0.13.0");
  check("release notes transport omits credentials redirects caching and document context",
    request.options.credentials === "omit" && request.options.redirect === "error" &&
    request.options.cache === "no-store" && request.options.referrerPolicy === "no-referrer" &&
    Object.keys(request.options.headers).sort().join(",") === "Accept,X-GitHub-Api-Version" &&
    request.options.signal instanceof AbortSignal);
  held.resolve(response("## Exact target"));
  const value = await first;
  check("release notes return only the offered presentation target and body",
    JSON.stringify(value) === '{"status":"loaded","presentationId":"notice-1","version":"0.13.0","body":"## Exact target"}' &&
    Object.isFrozen(value));
  check("release notes loaded cache does not fetch again and removes its timer",
    await f.load() === value && f.e.calls.length === 1 && f.e.timers.size === 0);
  const staleClick = await failure(f.owner.load("notice-1", "0.12.0"));
  check("release notes reject a stale target guard without fetching its replacement",
    !!staleClick && f.e.calls.length === 1);

  const retry = fixture();
  retry.e.transport = () => Promise.reject(new Error("Fixture is offline"));
  const rejected = retry.load();
  await failure(rejected);
  check("release notes errors remain cached until explicit retry",
    retry.load() === rejected && !!await failure(retry.load()) &&
    retry.e.calls.length === 1 && retry.e.logs.length === 1 && retry.e.timers.size === 0);
  retry.e.transport = () => response("Recovered");
  const recovered = retry.load(true);
  check("release notes duplicate retry shares the new active attempt", retry.load(true) === recovered);
  check("release notes explicit retry succeeds without updater workflow changes",
    (await recovered).body === "Recovered" && retry.e.calls.length === 2);

  for (const [name, change] of [
    ["target replacement with the same presentation", e => { e.offer = { ...e.offer, version: "0.14.0" }; }],
    ["presentation replacement with the same target", e => { e.offer = { ...e.offer, id: "notice-2" }; }],
    ["renderer replacement", e => { e.offer = { ...e.offer, owner: "renderer-2" }; }],
    ["dismissal", e => { e.offer = null; }],
  ]) {
    const stale = fixture(), old = gate();
    stale.e.transport = () => old.promise;
    const pending = stale.load();
    let rejection = "";
    const observed = failure(pending).then(error => { rejection = error; });
    await settle();
    change(stale.e);
    stale.owner.reconcile();
    await settle();
    check(`release notes abort and retire pending work on ${name}`,
      !!rejection && stale.e.calls[0].options.signal.aborted && stale.e.timers.size === 0);
    old.resolve(response("Late response"));
    await observed;
  }

  const replaced = fixture(), oldHeaders = gate(), newHeaders = gate();
  replaced.e.transport = () => replaced.e.calls.length === 1 ? oldHeaders.promise : newHeaders.promise;
  const old = replaced.load(), oldFailure = failure(old);
  await settle();
  replaced.e.offer = { ...replaced.e.offer, version: "0.14.0" };
  replaced.owner.reconcile();
  const next = replaced.load();
  await settle();
  oldHeaders.resolve(response("Retired"));
  await oldFailure;
  await settle();
  check("release notes late old finalizers cannot clear a newer request timer or cache",
    replaced.e.timers.size === 1 && replaced.load() === next && replaced.e.calls.length === 2);
  newHeaders.resolve(response("New target", { tag_name: "v0.14.0" }));
  check("release notes exact replacement target completes independently", (await next).version === "0.14.0");

  const closing = fixture(), never = gate();
  closing.e.transport = () => never.promise;
  const closingResult = failure(closing.load());
  await settle();
  closing.owner.clear();
  check("release notes final teardown aborts and clears its only active lifetime",
    !!await closingResult && closing.e.calls[0].options.signal.aborted && closing.e.timers.size === 0);
  never.resolve(response());

  const invalid = fixture();
  invalid.e.offer = { ...invalid.e.offer, version: "../latest" };
  check("release notes invalid Main target cannot become a network path",
    !!await failure(invalid.load()) && invalid.e.calls.length === 0);
}

async function boundaries() {
  const padded = size => {
    const base = JSON.stringify({ tag_name: "v0.13.0", body: "ok", padding: "" });
    return base.replace('"padding":""', `"padding":"${"x".repeat(size - base.length)}"`);
  };
  for (const delta of [0, 1]) {
    const f = fixture(), text = padded(limits.responseBytes + delta);
    f.e.transport = () => new Response(text);
    const error = await failure(f.load());
    check(`release notes response bytes ${delta ? "over" : "at"} the exact limit`,
      Buffer.byteLength(text) === limits.responseBytes + delta && !!error === !!delta &&
      f.e.timers.size === 0);
  }
  const crossing = fixture();
  let canceled = false;
  crossing.e.transport = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(limits.responseBytes - 1));
      controller.enqueue(new Uint8Array(2));
    },
    cancel() { canceled = true; },
  }));
  check("release notes reject a crossing stream chunk before collecting an oversized body",
    (await failure(crossing.load())).includes("large") && canceled &&
    crossing.e.calls[0].options.signal.aborted);
  const advertised = fixture();
  advertised.e.transport = () => new Response("{}", {
    headers: { "content-length": String(limits.responseBytes + 1) },
  });
  check("release notes reject an excessive advertised response before reading",
    (await failure(advertised.load())).includes("large") && advertised.e.calls[0].options.signal.aborted);

  for (const [label, unit] of [["ASCII", "x"], ["surrogate pair", "\u{1f642}"]]) {
    for (const delta of [0, 1]) {
      const f = fixture(), body = unit.repeat(limits.markdownChars / unit.length) + "x".repeat(delta);
      f.e.transport = () => response(body);
      check(`release notes ${label} Markdown ${delta ? "over" : "at"} the exact code-unit limit`,
        body.length === limits.markdownChars + delta && !!await failure(f.load()) === !!delta);
    }
  }
  for (const [label, body] of [["null", null], ["missing", undefined], ["whitespace", " \n\t"]]) {
    const f = fixture();
    f.e.transport = () => response(body, body === undefined ? { body: undefined } : {});
    check(`release notes ${label} body is honestly empty`, (await f.load()).body === "");
  }
  for (const [label, text] of [
    ["JSON", "not JSON"], ["array", "[]"], ["null response", "null"],
    ["wrong tag", JSON.stringify({ tag_name: "v0.12.0", body: "wrong" })],
    ["draft", JSON.stringify({ tag_name: "v0.13.0", body: "draft", draft: true })],
    ...[[], {}, 12, false].map((body, index) => [
      `body shape ${index}`, JSON.stringify({ tag_name: "v0.13.0", body }),
    ]),
  ]) {
    const f = fixture();
    f.e.transport = () => new Response(text);
    check(`release notes reject malformed ${label} without a success fallback`,
      !!await failure(f.load()) && f.e.logs.length === 1 && f.e.timers.size === 0);
  }
  const utf8 = fixture();
  utf8.e.transport = () => new Response(new Uint8Array([0xc3, 0x28]));
  check("release notes reject malformed UTF-8 rather than replacing it", !!await failure(utf8.load()));
  const redirect = fixture();
  redirect.e.transport = () => new Response("", { status: 302, headers: { location: "https://example.invalid" } });
  check("release notes do not accept a redirect as exact target content",
    !!await failure(redirect.load()) && redirect.e.calls.length === 1);

  for (const elapsed of [limits.timeoutMs - 1, limits.timeoutMs]) {
    const f = fixture(), headers = gate();
    f.e.transport = () => headers.promise;
    const result = failure(f.load());
    await settle();
    f.advance(elapsed);
    headers.resolve(response());
    check(`release notes completion ${elapsed < limits.timeoutMs ? "before" : "at"} the deadline`,
      !!await result === (elapsed >= limits.timeoutMs) && f.e.timers.size === 0);
  }
  const stream = fixture();
  let controller;
  stream.e.transport = () => new Response(new ReadableStream({ start(value) { controller = value; } }));
  const deadline = failure(stream.load());
  await settle();
  stream.advance(limits.timeoutMs, true);
  check("release notes deadline covers a stalled body after headers and aborts transport",
    (await deadline).includes("too long") && stream.e.calls[0].options.signal.aborted &&
    stream.e.timers.size === 0);
  controller.close();
  await settle();
}

async function preloadAndMain() {
  const events = new EventEmitter(), calls = [];
  let api, reply = { status: "loaded", presentationId: "notice-1", version: "0.13.0", body: "notes", url: "excluded" };
  events.invoke = async (...args) => { calls.push(args); return reply; };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "main-preload.js"), "utf8"), {
    process: { isMainFrame: true, argv: [] },
    require: () => ({ ipcRenderer: events, contextBridge: { exposeInMainWorld(_name, value) { api = value; } } }),
  });
  const value = await api.getUpdateReleaseNotes("notice-1", "0.13.0");
  check("release notes production preload sends only identity comparison guards and retry intent",
    JSON.stringify(calls) === '[["get-update-release-notes",{"presentationId":"notice-1","version":"0.13.0","retry":false}]]');
  check("release notes production preload projects a frozen bounded response without URLs",
    Object.isFrozen(value) && Object.keys(value).sort().join(",") === "body,presentationId,status,version");
  let refused = 0;
  for (const args of [[{}, "0.13.0"], ["notice-1", {}], ["notice-1", "0.13.0", "yes"]]) {
    if (await failure(api.getUpdateReleaseNotes(...args))) refused++;
  }
  check("release notes production preload rejects malformed requests before IPC",
    refused === 3 && calls.length === 1);
  for (const [label, changes] of [["target", { version: "0.14.0" }],
    ["presentation", { presentationId: "notice-2" }],
    ["shape", { body: {} }], ["size", { body: "x".repeat(limits.markdownChars + 1) }]]) {
    reply = { status: "loaded", presentationId: "notice-1", version: "0.13.0", body: "notes", ...changes };
    check(`release notes production preload rejects response ${label} mismatch`,
      !!await failure(api.getUpdateReleaseNotes("notice-1", "0.13.0")));
  }
  reply = { status: "loaded", presentationId: "notice-1", version: "0.13.0", body: "x".repeat(limits.markdownChars) };
  check("release notes production preload admits the exact Markdown length boundary",
    (await api.getUpdateReleaseNotes("notice-1", "0.13.0")).body.length === limits.markdownChars);
  reply = { status: "retired", presentationId: "notice-1", version: "0.13.0", body: { excluded: true } };
  const retiredReply = await api.getUpdateReleaseNotes("notice-1", "0.13.0");
  check("release notes production preload keeps retirement distinct from loaded or empty notes",
    retiredReply.status === "retired" && !Object.hasOwn(retiredReply, "body") && Object.isFrozen(retiredReply));

  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  let actualOptions;
  const offerState = { presentationId: "notice-1", presentationVersion: "0.15.0",
    availableVersion: "0.15.0", canShowUpdate: false, presentationDismissed: false };
  const frame = {}, sender = {};
  const binding = vm.createContext({
    createUpdateReleaseNotes(options) { actualOptions = options; return {}; },
    updateReaderWindow: () => ({ webContents: sender }),
    updateSchedule: { snapshot: () => offerState },
    updateSurface: { frame }, updateNotes: null,
    isUpdaterSender: event => event.sender === sender && event.senderFrame === frame,
    approvalRendererGeneration: 4, approvalRendererPageSession: "page-1",
    net: {}, log() {},
  });
  const bindingStart = source.indexOf("updateNotes = createUpdateReleaseNotes({");
  const bindingEnd = source.indexOf("\nfunction bindUpdateWindow", bindingStart);
  if (bindingStart < 0 || bindingEnd < 0) throw new Error("Missing actual Main notes binding");
  vm.runInContext(source.slice(bindingStart, bindingEnd), binding);
  const currentOffer = actualOptions.getOffer();
  check("release notes actual Main binds the remembered presentation target even while temporarily hidden",
    currentOffer.version === "0.15.0" && currentOffer.id === "notice-1" &&
    currentOffer.owner === '[4,"page-1"]');
  binding.approvalRendererGeneration = 5;
  check("release notes actual Main renderer generation changes cache ownership",
    actualOptions.getOffer().owner !== currentOffer.owner);
  offerState.availableVersion = "0.16.0";
  check("release notes actual Main refuses an inconsistent presentation target",
    actualOptions.getOffer() === null);
  offerState.availableVersion = "0.15.0";
  offerState.presentationDismissed = true;
  check("release notes actual Main dismissal removes cache authority", actualOptions.getOffer() === null);
  offerState.presentationDismissed = false;
  binding.updateSurface = null;
  check("release notes actual Main requires a currently authenticated document surface",
    actualOptions.getOffer() === null);
  const start = source.indexOf('ipcMain.handle("get-update-release-notes",');
  const end = source.indexOf("// Private preload observation", start);
  if (start < 0 || end < 0) throw new Error("Missing actual Main release notes port");
  let handler, accepted = true, loads = 0, loadGate = null;
  const authorized = {}, unauthorized = {};
  const state = { canShowUpdate: true, presentationDismissed: false,
    presentationId: "notice-1", presentationVersion: "0.13.0" };
  const held = gate();
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle(_channel, callback) { handler = callback; } },
    isUpdaterSender: event => event === authorized && accepted,
    updateSchedule: { snapshot: () => state },
    updateNotes: { load() {
      loads++;
      return loadGate ? loadGate.promise : Promise.resolve({
        status: "loaded", presentationId: "notice-1", version: "0.13.0", body: "notes",
      });
    } },
  });
  const request = { presentationId: "notice-1", version: "0.13.0", retry: false };
  const invalid = [
    [unauthorized, request], [authorized, { ...request, url: "https://example.invalid" }],
    [authorized, { ...request, retry: 1 }],
  ];
  for (const args of invalid) {
    if (!await failure(handler(...args))) throw new Error("Main accepted an invalid notes request");
  }
  check("release notes actual Main rejects foreign stale or URL-bearing requests before loading", loads === 0);
  const oldTarget = await handler(authorized, { ...request, version: "0.14.0" });
  check("release notes actual Main retires a stale click without requesting its replacement",
    oldTarget.status === "retired" && loads === 0);
  const beforeHidden = loads;
  state.canShowUpdate = false;
  const hidden = await handler(authorized, request);
  check("release notes actual Main admits the clicked current owner across temporary hiding",
    hidden.status === "loaded" && loads === beforeHidden + 1);
  const beforeDismissed = loads;
  state.canShowUpdate = true;
  state.presentationDismissed = true;
  const dismissed = await handler(authorized, request);
  state.presentationDismissed = false;
  check("release notes actual Main refuses new work for a dismissed presentation",
    dismissed.status === "retired" && loads === beforeDismissed);
  loadGate = held;
  const pending = handler(authorized, request);
  accepted = false;
  held.resolve({ presentationId: "notice-1", version: "0.13.0", body: "notes" });
  check("release notes actual Main reauthenticates the sender after its awaited request",
    (await pending).status === "retired" && loads === beforeDismissed + 1);
}

function toastFixture() {
  const nodes = new Map(), errors = [], events = {}, calls = [];
  const e = { nodes, errors, calls, html: "<p>notes</p>", count: 1, factoryCalls: 0,
    sanitized: [], parsed: [], fragment: null };
  const document = { activeElement: null };
  const element = id => {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set(), attributes = new Map();
    const node = {
      id, hidden: false, style: {}, textContent: "", children: [], inert: false,
      addEventListener(name, callback) { this[name] = callback; },
      setAttribute: (name, value) => attributes.set(name, value),
      getAttribute: name => attributes.get(name),
      replaceChildren(...children) { this.children = children; },
      contains: value => value === node || node.children.includes(value),
      focus() { document.activeElement = node; },
      classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
        contains: value => classes.has(value),
      },
    };
    nodes.set(id, node);
    return node;
  };
  document.getElementById = element;
  document.createTreeWalker = (fragment, filter) => {
    if (fragment !== e.fragment || filter !== 127) throw new Error("Incorrect fragment traversal");
    let remaining = e.count;
    return { nextNode: () => remaining-- > 0 ? {} : null };
  };
  const initial = { revision: 1, installedVersion: "0.12.0", availableVersion: "0.13.0",
    presentationId: "notice-1", presentationVersion: "0.13.0", canShowUpdate: true,
    canCheck: true, canDownload: true, status: "available", percent: 0 };
  let receive;
  const window = {
    folia: {
      onUpdateStatus(callback) { receive = callback; return () => {}; },
      getUpdateState: () => Promise.resolve(initial),
      dismissUpdateNotice() {},
      getUpdateReleaseNotes(...args) {
        const held = gate();
        calls.push({ args, ...held });
        return held.promise;
      },
    },
    addEventListener(name, callback) { events[name] = callback; },
  };
  const DOMPurify = target => {
    if (target !== window) throw new Error("Incorrect sanitizer window");
    e.factoryCalls++;
    return { isSupported: true, sanitize(html, config) {
      e.sanitized.push({ html, config });
      e.fragment = { fragment: true };
      return e.fragment;
    } };
  };
  DOMPurify.sanitize = () => { throw new Error("Document sanitizer must not render notes"); };
  const marked = {
    Renderer: class {},
    Marked: class {
      constructor(config) { e.parserConfig = config; }
      parse(body) { e.parsed.push(body); return e.html; }
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "app-updates.js"), "utf8"), {
    window, document, DOMPurify, marked, NodeFilter: { SHOW_ALL: 127 },
    console: { error: (...args) => errors.push(args) },
  });
  return { ...e, e, initial, events, element,
    apply: value => receive(value), click: id => element(id).click(),
    resolve: (index, body = "") => calls[index].resolve({
      status: "loaded", presentationId: calls[index].args[0], version: calls[index].args[1], body,
    }) };
}

async function disclosure() {
  const f = toastFixture();
  await settle();
  check("release notes production toast starts collapsed without an extra request",
    f.calls.length === 0 && f.element("updateNotesToggle").getAttribute("aria-expanded") === "false" &&
    f.element("updateNotesPanel").hidden && !f.element("appUpdateToast").inert);
  f.click("updateNotesToggle");
  check("release notes first expansion starts loading without disabling update actions",
    f.calls.length === 1 && !f.element("updateNotesPanel").hidden &&
    f.element("updateNotesStatus").textContent.includes("Loading") &&
    !f.element("downloadUpdateBtn").disabled && f.element("updateNotesRetry").hidden);
  f.click("updateNotesToggle");
  f.click("updateNotesToggle");
  check("release notes collapse and re-expansion share the pending UI request", f.calls.length === 1);
  f.apply({ ...f.initial, revision: 2, percent: 42, status: "downloading" });
  check("release notes progress snapshots preserve expansion and pending ownership",
    f.element("updateNotesToggle").getAttribute("aria-expanded") === "true" && f.calls.length === 1);
  f.resolve(0);
  await settle();
  f.click("updateNotesToggle"); f.click("updateNotesToggle");
  check("release notes empty result is cached honestly across re-expansion",
    f.calls.length === 1 && f.element("updateNotesStatus").textContent.includes("No release notes"));
  f.apply({ ...f.initial, revision: 3, presentationVersion: "0.14.0", availableVersion: "0.14.0" });
  check("release notes target change under the same presentation resets to collapsed",
    f.element("updateNotesToggle").getAttribute("aria-expanded") === "false" && f.calls.length === 1);
  f.click("updateNotesToggle");
  f.calls[1].reject(new Error("Expected fixture network failure"));
  await settle();
  f.click("updateNotesToggle"); f.click("updateNotesToggle");
  check("release notes UI errors are visible and do not retry on re-expansion",
    f.calls.length === 2 && !f.element("updateNotesRetry").hidden && f.errors.length === 1);
  f.click("updateNotesRetry");
  check("release notes UI retries only on its explicit control", f.calls.length === 3 && f.calls[2].args[2] === true);
  f.click("laterUpdateBtn");
  f.resolve(2, "Late notes");
  await settle();
  check("release notes dismissed toast is inert and late results cannot render or reopen it",
    f.element("appUpdateToast").inert && f.element("updateNotes").hidden &&
    f.element("updateNotesBody").children.length === 0 && f.e.parsed.length === 0);

  for (const [label, html, count, passes] of [
    ["HTML at limit", "x".repeat(limits.htmlChars), 1, true],
    ["HTML over limit", "x".repeat(limits.htmlChars + 1), 1, false],
    ["nodes at limit", "<p>notes</p>", limits.nodes, true],
    ["nodes over limit", "<p>notes</p>", limits.nodes + 1, false],
  ]) {
    const ui = toastFixture();
    ui.e.html = html; ui.e.count = count;
    await settle();
    ui.click("updateNotesToggle"); ui.resolve(0, "Notes");
    await settle();
    check(`release notes renderer gates ${label} before inserting a fragment`,
      (ui.element("updateNotesBody").children.length === 1) === passes &&
      ui.errors.length === (passes ? 0 : 1));
    if (passes) {
      const config = ui.e.sanitized[0]?.config;
      check(`release notes ${label} uses isolated parser sanitizer and inert allowlists`,
        ui.e.factoryCalls === 1 && ui.e.parsed.length === 1 &&
        config?.ALLOWED_ATTR.length === 0 && !config.ALLOW_DATA_ATTR && !config.ALLOW_ARIA_ATTR &&
        config.RETURN_DOM_FRAGMENT && !config.ALLOWED_TAGS.includes("a") &&
        !config.ALLOWED_TAGS.includes("img") && ui.e.parserConfig.async === false);
    }
  }
  const stale = toastFixture();
  await settle();
  stale.click("updateNotesToggle");
  stale.apply({ ...stale.initial, revision: 2, presentationId: "notice-2" });
  stale.resolve(0, "Wrong popup");
  await settle();
  check("release notes stale popup response never enters the Markdown parser",
    stale.e.parsed.length === 0 && stale.element("updateNotesBody").children.length === 0);
  stale.click("updateNotesToggle");
  stale.events.pagehide();
  stale.resolve(1, "Closed renderer");
  await settle();
  check("release notes page teardown invalidates renderer work without an error fallback",
    stale.e.parsed.length === 0 && stale.errors.length === 0);
  const retired = toastFixture();
  await settle();
  retired.click("updateNotesToggle");
  retired.calls[0].resolve({ status: "retired", presentationId: "notice-1", version: "0.13.0" });
  await settle();
  check("release notes retirement arriving before its state snapshot is inert and not an error",
    retired.e.parsed.length === 0 && retired.errors.length === 0 &&
    retired.element("updateNotesRetry").hidden);
  retired.apply({ ...retired.initial, revision: 2, availableVersion: "0.14.0", presentationVersion: "0.14.0" });
  check("release notes authoritative replacement resets a retired in-flight disclosure",
    retired.element("updateNotesToggle").getAttribute("aria-expanded") === "false");
}

function presentationOracle() {
  const source = fs.readFileSync(path.join(__dirname, "test-about-updates.js"), "utf8");
  const begin = source.indexOf("function popupFrameMatches(");
  const end = source.indexOf('\nif (typeof electron === "string")', begin);
  if (begin < 0 || end < 0) throw new Error("Popup presentation oracle boundary missing");
  const matches = vm.runInNewContext(source.slice(begin, end) + "\npopupFrameMatches");
  const witness = { width: 100, height: 100, backdrop: true, patches: [] };
  for (const [kind, y, color] of [
    ["panel", 20, [36, 36, 36, 1]],
    ["button", 40, [61, 189, 198, 1]],
    ["backdrop", 60, [0, 0, 0, 0.45]],
  ]) for (const x of [20, 40, 60]) witness.patches.push({ kind, x, y, color });
  function image(omitted = []) {
    const width = 125, height = 125;
    const bitmap = Buffer.alloc(width * height * 4);
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      bitmap.set([24, 24, 24, 255], offset);
    }
    for (const patch of witness.patches) {
      if (omitted.includes(patch.kind)) continue;
      const rgb = patch.kind === "backdrop" ? [13, 13, 13] : patch.color;
      const x = Math.floor(patch.x * 1.25), y = Math.floor(patch.y * 1.25);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        bitmap.set([rgb[2], rgb[1], rgb[0], 255], ((y + dy) * width + x + dx) * 4);
      }
    }
    return { getSize: () => ({ width, height }), toBitmap: () => bitmap, isEmpty: () => false };
  }
  const document = image(["panel", "button", "backdrop"]);
  check("popup presentation oracle accepts its opaque panel button and actual backdrop at fractional scale",
    matches(image(), witness, document));
  check("popup presentation oracle rejects a document without its popup",
    !matches(document, witness, document));
  check("popup presentation oracle requires the actual button fill",
    !matches(image(["button"]), witness, document));
  check("popup presentation oracle requires actual backdrop attenuation",
    !matches(image(["backdrop"]), witness, document));
  function rejects(frame, value = witness, base = document) {
    try { matches(frame, value, base); return false; }
    catch (error) { return error instanceof Error || error?.name === "Error"; }
  }
  check("popup presentation oracle rejects empty images rather than admitting them",
    rejects({ ...image(), isEmpty: () => true }));
  check("popup presentation oracle rejects incompatible capture coordinates",
    rejects(image(), { ...witness, width: 200 }));
  check("popup presentation oracle rejects missing witnesses and out of bounds patches",
    rejects(image(), { ...witness, patches: [] }) &&
    rejects(image(), { ...witness, patches: [...witness.patches, { ...witness.patches[0], x: Infinity }] }));
}

async function presentationAdmission() {
  const source = fs.readFileSync(path.join(__dirname, "test-about-updates.js"), "utf8");
  const begin = source.indexOf("function popupObservationEpoch(");
  const end = source.indexOf('\nif (typeof electron === "string")', begin);
  if (begin < 0 || end < 0) throw new Error("Popup admission boundary missing");
  const api = vm.runInNewContext(source.slice(begin, end) +
    "\n({popupObservationEpoch,createPopupFrameAdmission})");
  function fixture() {
    const e = { epoch: "target-1/state-1/viewport-1", time: 1, inspected: [] };
    e.admission = api.createPopupFrameAdmission({
      currentEpoch: () => e.epoch,
      now: () => e.time,
      matches(image) { e.inspected.push(image.id); e.time++; e.onMatch?.(); return image.matches; },
    });
    e.admission.promise.then(value => { e.result = value; }, error => { e.error = error; });
    e.frame = (id, matches = true) => e.admission.frame({ id, matches }, e.time);
    e.ready = () => e.admission.ready({ id: "witness" }, null, e.epoch);
    return e;
  }
  const early = fixture();
  early.frame("before-ready");
  await settle();
  const held = !early.result && early.inspected.length === 0;
  early.time = 10;
  early.ready();
  await settle();
  check("popup admission verifies the retained early frame without backdating prerequisites",
    held && early.result?.image.id === "before-ready" &&
    early.result.frameReceivedAt === 1 && early.result.prerequisitesReadyAt === 10 &&
    early.result.verifiedAt === 11);

  const latest = fixture();
  latest.frame("older-match");
  latest.frame("newer-negative", false);
  latest.ready();
  await settle();
  check("popup admission never falls back past the newest nonqualifying frame",
    !latest.result && latest.inspected.join(",") === "newer-negative");
  latest.frame("later-match");
  await settle();
  check("popup admission accepts a later qualifying callback after a negative latest frame",
    latest.result?.image.id === "later-match");

  for (const change of ["target", "state", "geometry"]) {
    const stale = fixture();
    stale.frame("old-" + change);
    stale.epoch = "changed-" + change;
    stale.ready();
    await settle();
    check("popup admission refuses a retained frame from another " + change,
      !stale.result && stale.inspected.length === 0);
    stale.frame("current-" + change);
    await settle();
    check("popup admission waits for the current " + change + " frame",
      stale.result?.image.id === "current-" + change);
  }
  const changed = fixture();
  changed.ready();
  changed.epoch = "new-state-after-witness";
  changed.frame("newer-state");
  await settle();
  check("popup admission rejects a state change after witness preparation",
    !changed.result && changed.error?.message.includes("changed after witness"));
  const during = fixture();
  const epoch = during.epoch;
  during.epoch = "changed-during-query";
  during.admission.ready({}, null, epoch);
  await settle();
  check("popup admission rejects stale asynchronous witness geometry",
    during.error?.message.includes("changed during witness"));
  const changedInMatch = fixture();
  changedInMatch.ready();
  changedInMatch.onMatch = () => { changedInMatch.epoch = "changed-in-matcher"; };
  changedInMatch.frame("must-not-commit");
  await settle();
  check("popup admission rechecks current ownership after pixel verification",
    !changedInMatch.result && changedInMatch.error?.message.includes("changed during pixel"));
  const failedMatch = fixture();
  failedMatch.ready();
  failedMatch.onMatch = () => { throw new Error("Controlled pixel failure"); };
  failedMatch.frame("invalid");
  await settle();
  check("popup admission reports pixel errors rather than a successful fallback",
    !failedMatch.result && failedMatch.error?.message === "Controlled pixel failure");
  const canceled = fixture();
  canceled.frame("pending");
  canceled.admission.stop(new Error("Controlled deadline"));
  canceled.ready();
  canceled.frame("after-deadline");
  await settle();
  check("popup admission deadline rejects and releases pending admission",
    !canceled.result && canceled.error?.message === "Controlled deadline" && canceled.inspected.length === 0);
  const stopped = fixture();
  stopped.frame("retained");
  stopped.admission.stop();
  stopped.ready();
  stopped.frame("too-late");
  await settle();
  check("popup admission cleanup makes retained and late callbacks inert",
    !stopped.result && !stopped.error && stopped.inspected.length === 0);
  const completed = fixture();
  completed.ready();
  completed.frame("completed");
  await settle();
  completed.frame("after-completion");
  await settle();
  check("popup admission completes once and ignores callbacks after success",
    completed.result?.image.id === "completed" && completed.inspected.length === 1);

  const value = { window: 1, contents: 2, renderer: 3, url: "file:reader",
    size: [1100, 780], zoom: 1, visible: true, minimized: false, dead: false,
    update: { revision: 1, status: "available", availableVersion: "0.13.0" },
    schedule: { revision: 8, presentationId: "offer-1", presentationVersion: "0.13.0" } };
  const contents = { get id() { return value.contents; }, isDestroyed: () => false,
    getOSProcessId: () => value.renderer, getURL: () => value.url,
    getZoomFactor: () => value.zoom };
  const win = { get id() { return value.window; }, webContents: contents, isDestroyed: () => value.dead,
    getContentSize: () => value.size, isVisible: () => value.visible, isMinimized: () => value.minimized };
  const state = { snapshot: () => value.update }, schedule = { snapshot: () => value.schedule };
  const read = lifecycle => api.popupObservationEpoch(win, state, schedule, lifecycle, true);
  const initial = read(0);
  value.update.revision++;
  check("popup epoch keeps the update revision distinct from the scheduler revision", read(0) !== initial);
  value.update.revision--;
  for (const [name, object, key, next] of [
    ["target", value.schedule, "presentationVersion", "0.14.0"],
    ["presentation", value.schedule, "presentationId", "offer-2"],
    ["window", value, "window", 5], ["WebContents", value, "contents", 6],
    ["renderer", value, "renderer", 4], ["URL", value, "url", "file:other"],
    ["viewport", value, "size", [800, 600]], ["zoom", value, "zoom", 1.5],
  ]) {
    const prior = object[key];
    object[key] = next;
    check("popup epoch records actual " + name + " changes", read(0) !== initial);
    object[key] = prior;
  }
  check("popup epoch distinguishes same-value lifecycle returns", read(1) !== initial);
  let missing = false, dead = false;
  try { api.popupObservationEpoch(win, state, null, 0, true); } catch { missing = true; }
  value.dead = true;
  try { read(0); } catch { dead = true; }
  value.dead = false;
  check("popup epoch refuses a missing candidate scheduler and a destroyed owner", missing && dead);
  for (const [name, key, next] of [["hidden", "visible", false], ["minimized", "minimized", true]]) {
    const prior = value[key];
    value[key] = next;
    let refused = false;
    try { read(0); } catch { refused = true; }
    value[key] = prior;
    check("popup epoch refuses an initially " + name + " owner", refused);
  }
  check("popup epoch explicitly supports the released reference without a scheduler",
    JSON.parse(api.popupObservationEpoch(win, state, null, 0, false)).scheduleState === null);
}

(async () => {
  await loader();
  await boundaries();
  await preloadAndMain();
  await disclosure();
  presentationOracle();
  await presentationAdmission();
  const passed = results.filter(Boolean).length;
  line(`=== ${passed}/${results.length} passed ===`);
  process.exitCode = passed === results.length ? 0 : 1;
})().catch(error => {
  line("FATAL release notes test: " + error.stack);
  process.exitCode = 2;
}).finally(() => clearTimeout(watchdog));
