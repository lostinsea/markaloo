"use strict";

// Payload for Parent's serialized, owned real-app driver, not a standalone
// suite. The driver owns preflight, fresh profile/file, deadlines, sentinels,
// screenshots, raw stdout/exit, actual window destruction and file cleanup.
const fixtureMarkdown = [
  "# Instant request fixture",
  "[Fragment target](#instant-focus-target)",
  ...Array.from({ length: 28 }, (_, i) => "Before target " + i + ". " + "Owned fixture prose. ".repeat(18)),
  "## Instant focus target",
  "instantuniquewitness",
  '<span class="noted-text" data-note-id="1" data-note-title="Instant note" data-note-content="Owned fixture">Instant note witness</span>',
  ...Array.from({ length: 28 }, (_, i) => "After target " + i + ". " + "Owned fixture tail. ".repeat(18)),
].join("\n\n");
const instrumentationEnvironment = "INSTRUMENTED/DIAGNOSTIC-ONLY";

function expectedSearchTarget(viewer) {
  const heading = viewer.querySelector("#instant-focus-target");
  const section = heading?.nextElementSibling;
  if (!section?.classList.contains("collapsible-section") ||
      section.dataset.mvCollapsible !== "1" || section.dataset.forHeader !== heading.id) return null;
  const matches = section.querySelectorAll(".search-highlight");
  if (matches.length !== 1 || viewer.querySelectorAll(".search-highlight").length !== 1) return null;
  const target = matches[0];
  return target.parentElement?.tagName === "P" && target.textContent === "instantuniquewitness" ? target : null;
}

function qualifyNativeRoute(jumps, calls, outcomes, expected) {
  if (!Number.isSafeInteger(expected.count) || expected.count <= 0 ||
      expected.targets.length !== expected.count || jumps.length !== expected.count ||
      calls.length !== expected.count || outcomes.length !== expected.count) return false;
  return jumps.every((jump, index) => {
    const call = calls[index], outcome = outcomes[index];
    if (!expected.targets[index] || jump.target !== expected.targets[index] ||
        call.target !== jump.target || jump.native !== call ||
        jump.receipt?.request !== call.request || call.nativePromise !== true ||
        call.options?.behavior !== "instant" || call.options.block !== expected.block ||
        call.options.inline !== "nearest") return false;
    if (index < expected.count - 1) {
      return typeof call.rawResult?.interrupted === "boolean" &&
        outcome.status === "unrecordable" && outcome.reason === "superseded";
    }
    if (call.rawError !== undefined || call.rawResult?.interrupted !== false) return false;
    const pulsing = [call.beforePulse, call.afterPulse, call.completionPulse]
      .some(pulse => pulse?.active === true && typeof pulse.transform === "string" &&
        pulse.transform.length > 0 && pulse.transform !== "none");
    if (expected.record === "note-pulse" && pulsing) {
      return outcome.status === "unrecordable" && outcome.reason === "unsupported-clip";
    }
    return outcome.status === "completed";
  });
}

function instrumentReadingJumpRecord(original, identity, records) {
  const encode = value => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return { type: Number.isNaN(value) ? "nan" : "unbounded", sign: value < 0 ? -1 : 1 };
    }
    if (Object.is(value, -0)) return { type: "negative-zero" };
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encode(item)]));
    return value;
  };
  const frame = value => ({
    root: [...value.root], rootLayout: [...value.rootLayout], text: value.text,
    visual: identity(value.visual), scrollingElement: identity(value.scrollingElement),
    elements: value.elements.map(item => ({
      node: identity(item.node), layout: [...item.layout], offset: [...item.offset],
      shape: [...item.shape], clip: item.clip && [...item.clip],
    })),
    witness: value.witness.map(box => [...box]),
  });
  const derive = value => {
    const root = value.root, size = value.rootLayout;
    const rootClip = [Math.max(1, root[2]), Math.max(1, root[3]),
      Math.min(size[0], size[5]) - 1, Math.min(size[1], size[6]) - 1];
    rootClip[2] = Math.min(rootClip[2], root[2] + size[2]);
    rootClip[3] = Math.min(rootClip[3], root[3] + size[3]);
    const constraints = [{ owner: "captured-root", clip: rootClip }];
    value.elements.forEach((item, index) => {
      if (item.clip) constraints.push({ owner: identity(item.node), chainIndex: index, clip: [...item.clip] });
    });
    const intersection = [...rootClip], steps = [];
    for (const constraint of constraints) {
      intersection[0] = Math.max(intersection[0], constraint.clip[0]);
      intersection[1] = Math.max(intersection[1], constraint.clip[1]);
      intersection[2] = Math.min(intersection[2], constraint.clip[2]);
      intersection[3] = Math.min(intersection[3], constraint.clip[3]);
      steps.push({ ...constraint, intersection: [...intersection] });
    }
    const clearance = (box, clip) => [box[0] - clip[0], box[1] - clip[1], clip[2] - box[2], clip[3] - box[3]];
    return {
      edgeOrder: ["left", "top", "right", "bottom"], positiveMeans: "interior clearance",
      steps, intersection, intersectionSize: [intersection[2] - intersection[0], intersection[3] - intersection[1]],
      limitingOwners: intersection.map((edge, index) =>
        constraints.filter(item => Object.is(item.clip[index], edge)).map(item => item.owner)),
      fragments: value.witness.map((box, index) => ({
        index, box: [...box], size: [box[2] - box[0], box[3] - box[1]],
        signedClearance: clearance(box, intersection),
        perConstraint: constraints.map(item => ({ owner: item.owner, signedClearance: clearance(box, item.clip) })),
      })),
    };
  };
  return function (...args) {
    let entry;
    try {
      // Only already-captured arrays/scalars and opaque object identities are
      // read here. This boundary must not sample layout a second time.
      entry = { observedAt: performance.now(), argumentCount: args.length, frameOrder: ["before", "after", "final"],
        frames: encode(args.map(frame)),
        finalClipDerivation: encode(derive(args[2])) };
    } catch (error) {
      entry = { observationError: String(error.stack || error) };
    }
    const retain = detail => {
      try { records.push({ ...entry, ...detail }); } catch { /* Logging cannot replace the original result or error. */ }
    };
    let result;
    try { result = Reflect.apply(original, this, args); }
    catch (error) { retain({ threw: String(error?.stack || error) }); throw error; }
    retain({ result });
    return result;
  };
}

async function run({ execute, capture, check }) {
  if (typeof execute !== "function" || typeof capture !== "function" || typeof check !== "function") {
    throw new TypeError("Owned driver execute/capture/check callbacks are required");
  }
  const token = require("crypto").randomUUID();
  const receipts = [];
  async function control(name, code) {
    try {
      const result = await execute(code);
      receipts.push({ name, result, environment: instrumentationEnvironment });
      check(name, result.ok, result);
      return result;
    } catch (error) {
      const result = { ok: false, error: error.stack || String(error) };
      receipts.push({ name, result, environment: instrumentationEnvironment }); check(name, false, result);
      return result;
    }
  }
  try {
    await execute(`(() => {
    if (window.__readingInstantControl) throw Error('A previous native control still owns this window');
    if (!viewer.querySelector('#instant-focus-target') ||
        !viewer.querySelector('.noted-text[data-note-id="1"]')) throw Error('Open the exact owned fixture first');
    const state = window.__readingInstantControl = {
      token: ${JSON.stringify(token)}, helper: scrollElementIntoView,
      environment: ${JSON.stringify(instrumentationEnvironment)},
      instrumentationLimit: 'Observed Event attribution, not native packet identity or unchanged production qualification',
      native: Element.prototype.scrollIntoView, jumps: [], calls: [],
      diagnosticOnly: true, record: readingJumpRecord, recordDiagnostics: [], nodes: {},
      originalScrollBehavior: getComputedStyle(getViewerScroller()).scrollBehavior
    };
    const identities = new WeakMap(); let nextIdentity = 0;
    state.identity = value => {
      if (!identities.has(value)) identities.set(value, 'identity-' + (++nextIdentity));
      return identities.get(value);
    };
    state.recordWrapper = (${instrumentReadingJumpRecord.toString()})(state.record, state.identity, state.recordDiagnostics);
    readingJumpRecord = state.recordWrapper;
    const pulse = target => ({ active: target.classList.contains('note-highlight'),
      transform: getComputedStyle(target).transform });
    Element.prototype.scrollIntoView = function (options) {
      const issuedAt = performance.now();
      const beforePulse = pulse(this);
      const request = Reflect.apply(state.native, this, [options]);
      const call = { target: this, options, request, issuedAt, returnedAt: performance.now(),
        targetIdentity: state.identity(this),
        beforePulse, afterPulse: pulse(this), returnType: Object.prototype.toString.call(request) };
      state.calls.push(call);
      try {
        Promise.prototype.then.call(request, result => {
          call.rawResult = result; call.promiseObservedAt = performance.now(); call.completionPulse = pulse(this);
        }, error => {
          call.rawError = error?.stack || String(error); call.promiseObservedAt = performance.now();
        });
        call.nativePromise = true;
      } catch (error) { call.rawError = error?.stack || String(error); }
      return request;
    };
    scrollElementIntoView = function (...args) {
      const receipt = Reflect.apply(state.helper, this, args);
      for (let node = args[0]; node; node = node.parentElement) {
        state.nodes[state.identity(node)] = { name: node.nodeName, id: node.id, className: node.className };
      }
      state.jumps.push({ target: args[0], receipt, native: state.calls.at(-1) }); return receipt;
    };
    state.finish = async jump => {
      if (!jump?.receipt?.completion) return { status: 'unrecordable', reason: jump?.receipt?.reason || 'missing-helper-call' };
      let timeout;
      try {
        return await Promise.race([jump.receipt.completion, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Error('exact native request exceeded the existing 9s wait bound')), 9000);
        })]);
      } finally { clearTimeout(timeout); }
    };
    state.qualify = ${qualifyNativeRoute.toString()};
    state.expectedSearchTarget = ${expectedSearchTarget.toString()};
    state.route = async (contract, actor) => {
      const first = state.jumps.length, firstCall = state.calls.length, firstRecord = state.recordDiagnostics.length;
      actor();
      const expected = { ...contract, targets: typeof contract.targets === 'function' ? contract.targets() : contract.targets };
      const jumps = state.jumps.slice(first), calls = state.calls.slice(firstCall);
      const outcomes = await Promise.all(jumps.map(state.finish));
      return { ok: state.qualify(jumps, calls, outcomes, expected),
        expected: { ...expected, targets: expected.targets.map(target => target?.id || target?.textContent) },
        diagnosticOnly: true, recordDiagnostics: state.recordDiagnostics.slice(firstRecord), identities: { ...state.nodes },
        outcomes, requests: jumps.map(jump => ({ target: jump.target.id || jump.target.textContent,
          targetIdentity: jump.native?.targetIdentity,
          nativeTarget: jump.native?.target.id || jump.native?.target.textContent,
          exactNative: jump.receipt.request === jump.native?.request, options: jump.native?.options,
          returnType: jump.native?.returnType, nativePromise: jump.native?.nativePromise,
          rawResult: jump.native?.rawResult, rawError: jump.native?.rawError,
          beforePulse: jump.native?.beforePulse, afterPulse: jump.native?.afterPulse,
          completionPulse: jump.native?.completionPulse,
          issuedAt: jump.native?.issuedAt, returnedAt: jump.native?.returnedAt,
          promiseObservedAt: jump.native?.promiseObservedAt })) };
    };
    return true;
  })()`);
    await control("owned fixture really overflows and its target begins outside the reading viewport", `(() => {
      const scroller = getViewerScroller(); scroller.scrollTop = 0;
      const target = viewer.querySelector('#instant-focus-target').getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      return { ok: scroller.scrollHeight > scroller.clientHeight && target.top > viewport.bottom,
        target: target.toJSON(), viewport: viewport.toJSON() };
    })()`);
    await control("actual TOC route uses an exact instant native completion", `__readingInstantControl.route({
      targets:[viewer.querySelector('#instant-focus-target')],block:'start',count:1
    }, () => {
      const item = indexList.querySelector('[data-header-id="instant-focus-target"]');
      if (!item) throw Error('Missing actual TOC button'); item.click();
    })`);
    await capture("instant-toc");
    await control("actual fragment route preserves its native destination", `__readingInstantControl.route({
      targets:[viewer.querySelector('#instant-focus-target')],block:'start',count:1
    }, () => {
      getViewerScroller().scrollTop = 0;
      const link = viewer.querySelector('a[href="#instant-focus-target"]');
      if (!link) throw Error('Missing actual fragment link'); link.click();
    })`);
    await control("actual Search Enter retains both request origins and only the final owner", `(async () => {
      searchInput.value = 'instantuniquewitness';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      const result = await __readingInstantControl.route({
        targets:()=>Array(2).fill(__readingInstantControl.expectedSearchTarget(viewer)),
        block:'center',count:2
      }, () =>
        searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      return { ...result, ok: result.ok && result.requests.length === 2 &&
        result.outcomes[0].reason === 'superseded' };
    })()`);
    await capture("instant-search");
    await control("actual Notes document-target route remains active", `__readingInstantControl.route({
      targets:[viewer.querySelector('.noted-text[data-note-id="1"]')],block:'center',count:1,record:'note-pulse'
    }, () => {
      updateNotesList();
      const item = notesList.querySelector('[data-note-id="1"]');
      if (!item) throw Error('Missing actual Notes item'); item.click();
    })`);
    await control("actual Find Note document-target route remains active", `__readingInstantControl.route({
      targets:[viewer.querySelector('.noted-text[data-note-id="1"]')],block:'center',count:1,record:'note-pulse'
    }, () => {
      findNoteInput.value = '#1'; findNoteBtn.click();
    })`);
    await control("real nested instant request moves both axes without a root-stop claim", `(async () => {
      const host = document.createElement('div');
      host.dataset.instantControl = 'nested';
      host.style.cssText = 'width:240px;height:160px;overflow:auto;position:relative';
      host.innerHTML = '<div style="width:1400px;height:1200px"><span style="display:inline-block;margin-left:700px;margin-top:900px">Nested instant witness</span></div>';
      viewer.appendChild(host); const target = host.querySelector('span');
      const before = [host.scrollLeft, host.scrollTop];
      target.style.scrollMarginRight = '16px';
      try {
        const result = await __readingInstantControl.route({targets:[target],block:'center',count:1}, () =>
          scrollElementIntoView(target, 'center', readingViewport.beginIntent()));
        return { ...result, ok: result.ok && before.every(value => value === 0) &&
          host.scrollLeft > 0 && host.scrollTop > 0, before, after: [host.scrollLeft, host.scrollTop] };
      } finally { target.style.removeProperty('scroll-margin-right'); }
    })()`);
    await capture("instant-nested");
    await control("a real clipping-only ancestor refuses the record but does not suppress the jump", `(async () => {
      const host = viewer.querySelector('[data-instant-control="nested"]');
      host.style.overflow = 'clip'; host.scrollLeft = 0; host.scrollTop = 0;
      const state = __readingInstantControl, before = state.calls.length;
      const receipt = scrollElementIntoView(host.querySelector('span'), 'center', readingViewport.beginIntent());
      const outcome = await state.finish(state.jumps.at(-1));
      return { ok: !!receipt && state.calls.length === before + 1 &&
        outcome.status === 'unrecordable' && outcome.reason === 'target-clipped', outcome };
    })()`);
    await control("old native Promise cleanup cannot affect a synchronous successor", `(async () => {
      const state = __readingInstantControl;
      const old = scrollElementIntoView(viewer.querySelector('#instant-focus-target'), 'center', readingViewport.beginIntent());
      const oldJump = state.jumps.at(-1);
      const current = scrollElementIntoView(viewer.querySelector('#instant-request-fixture'), 'start', readingViewport.beginIntent());
      const currentJump = state.jumps.at(-1), permit = readingViewport.capturePermit();
      const outcomes = await Promise.all([state.finish(oldJump), state.finish(currentJump)]);
      return { ok: old.request === oldJump.native.request && current.request === currentJump.native.request &&
        outcomes[0].reason === 'superseded' && outcomes[1].status === 'completed' &&
        readingViewport.isPermitCurrent(permit), outcomes };
    })()`);
    await control("real current instant no-travel still has a completed native request", `(async () => {
      const state = __readingInstantControl, target = viewer.querySelector('#instant-request-fixture');
      scrollElementIntoView(target, 'start', readingViewport.beginIntent());
      const outcome = await state.finish(state.jumps.at(-1));
      return { ok: outcome.status === 'completed' && outcome.travel === 'no-observed-travel', outcome };
    })()`);
    await control("request-local behavior did not change the app scroll style", `(() => ({
      ok: getComputedStyle(getViewerScroller()).scrollBehavior === __readingInstantControl.originalScrollBehavior
    }))()`);
  } finally {
    await control("owned native instrumentation restores originals and retains raw request results", `(() => {
      const state = window.__readingInstantControl;
      if (!state || state.token !== ${JSON.stringify(token)}) return { ok: false, reason: 'not-owned' };
      const calls = state.calls.map(call => ({ target: call.target.id || call.target.textContent,
        targetIdentity: call.targetIdentity,
        options: call.options, returnType: call.returnType, nativePromise: call.nativePromise,
        rawResult: call.rawResult, rawError: call.rawError,
        beforePulse: call.beforePulse, afterPulse: call.afterPulse, completionPulse: call.completionPulse,
        issuedAt: call.issuedAt, returnedAt: call.returnedAt, promiseObservedAt: call.promiseObservedAt }));
      const ownsRecordWrapper = readingJumpRecord === state.recordWrapper;
      if (ownsRecordWrapper) readingJumpRecord = state.record;
      scrollElementIntoView = state.helper; Element.prototype.scrollIntoView = state.native;
      readingViewport.invalidate();
      viewer.querySelector('[data-instant-control="nested"]')?.remove();
      delete window.__readingInstantControl;
      return { ok: scrollElementIntoView === state.helper && Element.prototype.scrollIntoView === state.native &&
          ownsRecordWrapper && readingJumpRecord === state.record,
        diagnosticOnly: true, recordRestored: readingJumpRecord === state.record, ownsRecordWrapper,
        calls, recordDiagnostics: state.recordDiagnostics, identities: state.nodes };
    })()`);
  }
  return receipts;
}

if (require.main === module) throw new Error("Run only inside Parent's owned real-app driver; this payload is not a native qualification entrypoint");
module.exports = Object.freeze({ fixtureMarkdown, expectedSearchTarget, qualifyNativeRoute, instrumentReadingJumpRecord, run });
