"use strict";

// Mapping markup lives only in a detached metadata copy. The displayed HTML is
// unchanged, and bindings cross over only after complete DOM verification.
window.createEditorScroll = function ({ editor, preview, active, frozen, identity, scale }) {
  const attribute = 'data-folia-scroll';
  let committed = null, owner = null, anchors = [], frame = 0, dirty = false;
  let mirror = null, mirrorText = null, mirrorKey = null, mirrorOffsets = null, observing = false;
  let sourceMarkers = [];
  const scrollPoints = { editor: [], preview: [] };
  const measuredSizes = new WeakMap();
  let pendingSource = false, lastEditor = 0, lastPreview = 0;
  const stats = { builds: 0, scrolls: 0, writes: 0, callbacks: [] };

  function clearGeometry() {
    anchors = [];
    scrollPoints.editor = [];
    scrollPoints.preview = [];
  }

  function upperBound(rows, value, key) {
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid][key] <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function sliceView(view, from, to = view.text.length) {
    return { text: view.text.slice(from, to), at: offset => view.at(from + offset) };
  }

  function replaceView(view, regex, replacement) {
    const pieces = [];
    let cursor = 0, output = 0;
    const copy = end => {
      if (end > cursor) pieces.push({ from: output, to: output + end - cursor, start: cursor, end });
      output += end - cursor;
      cursor = end;
    };
    const text = view.text.replace(regex, (...args) => {
      const start = args[args.length - 2], value = replacement(...args);
      copy(start);
      if (value.length) pieces.push({ from: output, to: output + value.length, start, end: start + args[0].length });
      output += value.length;
      cursor = start + args[0].length;
      return value;
    });
    copy(view.text.length);
    return { text, at(offset) {
      if (!pieces.length) return view.at(view.text.length);
      const part = pieces[Math.max(0, Math.min(pieces.length - 1, upperBound(pieces, offset, 'from') - 1))];
      const fraction = part.to > part.from ? (offset - part.from) / (part.to - part.from) : 0;
      return view.at(Math.round(part.start + fraction * (part.end - part.start)));
    } };
  }

  // Marked owns tokenization. This only verifies the copied characters in its
  // dequoted/deindented child input, one physical source line at a time.
  function childView(view, text, kind, task = false) {
    const sourceLines = view.text.split('\n'), childLines = text.split('\n'), rows = [];
    if (childLines.length > sourceLines.length) return null;
    let sourceOffset = 0, childOffset = 0;
    for (let line = 0; line < childLines.length; line++) {
      const raw = sourceLines[line], child = childLines[line];
      let expanded = '', columns = [];
      for (let i = 0; i < raw.length; i++) {
        const width = raw[i] === '\t' ? (kind === 'list' && line > 0 ? 4 : 4 - expanded.length % 4) : 1;
        expanded += raw[i] === '\t' ? ' '.repeat(width) : raw[i];
        for (let j = 0; j < width; j++) columns.push(i);
      }
      columns.push(raw.length);
      const allowedPrefix = prefix => kind === 'quote'
        ? /^(?: {0,3}>[ \t]?)?$/.test(prefix)
        : line > 0 ? /^[ \t]*$/.test(prefix)
        : (task ? /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?$/ :
          /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+$/).test(prefix);
      let generated = 0, retained = child, at = -1;
      const find = value => {
        let position = expanded.indexOf(value);
        while (position >= 0) {
          if (allowedPrefix(expanded.slice(0, position)) && /^[ \t]*$/.test(expanded.slice(position + value.length))) return position;
          // indexOf('', length + 1) clamps back to length instead of failing.
          if (position === expanded.length) return -1;
          position = expanded.indexOf(value, position + 1);
        }
        return -1;
      };
      at = find(retained);
      // Marked protects unquoted setext-looking continuation lines with spaces.
      if (at < 0 && kind === 'quote' && child.startsWith('    ')) {
        generated = 4;
        retained = child.slice(4);
        at = find(retained);
      }
      if (at < 0) return null;
      rows.push({ from: childOffset, sourceOffset, columns, at, generated, length: child.length });
      sourceOffset += raw.length + 1;
      childOffset += child.length + 1;
    }
    return { text, at(offset) {
      const row = rows[Math.max(0, upperBound(rows, offset, 'from') - 1)];
      const column = Math.max(0, Math.min(row.length, offset - row.from) - row.generated);
      return view.at(row.sourceOffset + row.columns[row.at + column]);
    } };
  }

  function textNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    let node, text = '';
    while ((node = walker.nextNode())) {
      if (!node.length) continue;
      nodes.push({ node, start: text.length });
      text += node.data;
    }
    return { nodes, text };
  }

  class Source {
    constructor(text) {
      this.original = text;
      this.source = text.replace(/\r\n?/g, '\n');
      this.text = text;
      this.segments = [{ from: 0, to: text.length, start: 0, end: text.length }];
      this.cr = [];
      for (let i = 0; i < text.length; i++) if (text[i] === '\r' && text[i + 1] === '\n') this.cr.push({ offset: i });
      this.nonce = crypto.randomUUID();
      this.attribute = attribute + '-' + this.nonce;
      this.descriptors = [];
      this.bindings = [];
      this.textSpecs = new WeakMap();
      this.textGroups = [];
      this.warnings = new Set();
      this.specials = { mermaid: [], raw: [] };
      this.selection = identity();
    }
    originalOffset(position) {
      const i = Math.min(this.segments.length - 1, upperBound(this.segments, position, 'from') - 1);
      const s = this.segments[Math.max(0, i)];
      const fraction = s.to > s.from ? (position - s.from) / (s.to - s.from) : 0;
      return Math.round(s.start + fraction * (s.end - s.start));
    }
    offset(position) {
      const original = this.originalOffset(position);
      return original - upperBound(this.cr, original - 1, 'offset');
    }
    replace(regex, replacer) {
      const edits = [];
      const next = this.text.replace(regex, (...args) => {
        const match = args[0], from = args[args.length - 2];
        const text = replacer(...args);
        edits.push({ from, to: from + match.length, text });
        return text;
      });
      if (!edits.length) return this.text;
      const segments = [];
      let cursor = 0, output = 0, index = 0;
      const copy = end => {
        while (cursor < end) {
          while (index < this.segments.length - 1 && this.segments[index].to <= cursor) index++;
          const s = this.segments[index], stop = Math.min(end, s.to);
          segments.push({ from: output, to: output + stop - cursor,
            start: this.originalOffset(cursor), end: this.originalOffset(stop) });
          output += stop - cursor;
          cursor = stop;
        }
      };
      for (const edit of edits) {
        copy(edit.from);
        if (edit.text.length) segments.push({ from: output, to: output + edit.text.length,
          start: this.originalOffset(edit.from), end: this.originalOffset(edit.to) });
        output += edit.text.length;
        cursor = edit.to;
      }
      copy(this.text.length);
      this.text = next;
      this.segments = segments.length ? segments : [{ from: 0, to: 0, start: 0, end: 0 }];
      return next;
    }
    prepare(parseEmoji) {
      this.replace(/^\uFEFF/, () => '');
      this.replace(/:([a-zA-Z0-9_+-]+):/g, match => parseEmoji(match));
      return this.text;
    }
    replaceSpecial(kind, regex, replacer) {
      return this.replace(regex, (...args) => {
        const from = args[args.length - 2];
        this.specials[kind].push({ start: this.offset(from),
          end: this.offset(from + args[0].length), lines: [] });
        return replacer(...args);
      });
    }
    mark(html, descriptor) {
      const index = this.descriptors.push(descriptor) - 1;
      return html.replace(/<([a-z][\w-]*)(?=[\s>])/i,
        match => `${match} ${this.attribute}="${this.nonce}:${index}"`);
    }
    warn(reason) {
      if (this.warnings.has(reason)) return;
      this.warnings.add(reason);
      console.warn('Editor scroll mapping kept container boundaries: ' + reason);
    }
    parse(marked) {
      // Marked normalizes newlines before lexing; the offset map must do so too.
      this.replace(/\r\n?/g, () => '\n');
      const spans = new WeakMap();
      const containsHtml = token => token.type === 'html' ||
        [...(token.tokens || []), ...(token.items || [])].some(containsHtml);
      const locate = (items, view, topLevel = false, inline = false, opaque = false, owner = null) => {
        let cursor = 0;
        for (const token of items || []) {
          if (!token.raw || token.type === 'checkbox') continue;
          let at = view.text.indexOf(token.raw, cursor);
          while (topLevel && token.type !== 'space' && at > 0 && view.text[at - 1] !== '\n') at = view.text.indexOf(token.raw, at + 1);
          if (at < 0) {
            this.warn('unmatched ' + token.type + ' child input');
            // An uncertain subtree must not borrow a later repeated occurrence.
            const lines = token.raw.split('\n').length - 1;
            for (let i = 0; i < lines && cursor < view.text.length; i++) {
              const next = view.text.indexOf('\n', cursor);
              cursor = next < 0 ? view.text.length : next + 1;
            }
            continue;
          }
          const tokenView = sliceView(view, at, at + token.raw.length);
          const end = token.raw.trimEnd().length;
          const tokenOwner = topLevel ? {} : owner;
          const rows = token.type === 'table' ? [...token.raw.trimEnd().matchAll(/[^\n]+/g)].map(match => ({
            start: tokenView.at(match.index), end: tokenView.at(match.index + match[0].length),
          })) : [];
          let codeOffset = 0;
          const codeStart = token.type === 'code' ? token.raw.indexOf(token.text) : -1;
          spans.set(token, { start: tokenView.at(0), end: tokenView.at(end), kind: token.type, inline, opaque,
            owner: tokenOwner, root: topLevel, view: tokenView,
            rows: token.type === 'table' ? [rows[0], ...rows.slice(2)] : [],
            codeLines: codeStart >= 0
              ? token.text.split('\n').map(line => {
                const entry = { offset: tokenView.at(codeStart + codeOffset), textOffset: codeOffset };
                codeOffset += line.length + 1;
                return entry;
              }) : [],
            lines: token.type === 'paragraph' ? [...token.raw.trimEnd().matchAll(/\n/g)]
              .map(match => tokenView.at(match.index + 1)) : [] });
          cursor = at + token.raw.length;
          const opaqueChildren = opaque || (this.coarseHtml && topLevel && containsHtml(token));
          if (token.items) locate(token.items, tokenView, false, false, opaqueChildren, tokenOwner);
          if (!token.tokens || token.type === 'image') continue;
          let children = tokenView;
          if (token.type === 'blockquote') {
            children = childView(tokenView, token.text, 'quote') ||
              replaceView(tokenView, /^ {0,3}>[ \t]?/gm, () => '');
          } else if (token.type === 'list_item') {
            let text = token.text;
            // Task rendering removes the checkbox from text but retains it in
            // the child block's raw input. It is real source, not a new token.
            const raw = token.tokens.find(child => child.type !== 'checkbox' && child.type !== 'space')?.raw;
            const checkbox = token.task && raw && /^\[[ xX]\][ \t]+/.exec(raw)?.[0];
            if (checkbox && raw.startsWith(checkbox + text.split('\n')[0])) text = checkbox + text;
            children = childView(tokenView, text, 'list', token.task);
          } else if (['strong', 'em', 'del'].includes(token.type)) {
            const width = token.type === 'em' ? 1 : 2;
            children = sliceView(tokenView, width, token.raw.length - width);
          } else if (token.type === 'link' && token.raw[0] === '[') {
            let depth = 1, close = 1;
            for (; close < token.raw.length; close++) {
              if (token.raw[close] === '\\') { close++; continue; }
              if (token.raw[close] === '[') depth++;
              if (token.raw[close] === ']' && --depth === 0) break;
            }
            children = replaceView(sliceView(tokenView, 1, close), /\\([[\]])/g, (match, char) => char);
          }
          if (children) locate(token.tokens, children, false,
            inline || !['list_item', 'blockquote'].includes(token.type), opaqueChildren, tokenOwner);
          else this.warn('unverified ' + token.type + ' prefix removal');
        }
      };
      const hooks = new marked.Hooks();
      hooks.processAllTokens = tokens => { locate(tokens, { text: this.text, at: offset => this.offset(offset) }, true); return tokens; };
      const renderer = new marked.Renderer();
      for (const name of ['heading', 'paragraph', 'code', 'list', 'listitem', 'blockquote', 'table', 'html', 'hr', 'image']) {
        const render = renderer[name];
        renderer[name] = function (token) {
          let html = render.call(this, token);
          const descriptor = spans.get(token);
          if (!descriptor || descriptor.opaque) return html;
          if (descriptor.root && name === 'html') descriptor.html = html;
          if (name === 'table') {
            let row = 0;
            html = html.replace(/<tr>/g, tag => {
              const span = descriptor.rows[row++];
              return span ? source.mark(tag, { ...span, kind: 'row', lines: [], owner: descriptor.owner }) : tag;
            });
          }
          const special = /^(MERMAID_BLOCK_|RAWHTML_BLOCK_)[A-Za-z0-9_]+$/.exec(token.text?.trim() || '');
          if (special) return html;
          return source.mark(html, descriptor);
        };
      }
      for (const name of ['text', 'codespan']) {
        const render = renderer[name];
        renderer[name] = function (token) {
          const html = render.call(this, token), descriptor = spans.get(token);
          if (!descriptor || descriptor.opaque || token.tokens?.length || !html ||
              /(?:MERMAID_BLOCK_|RAWHTML_BLOCK_)[A-Za-z0-9_]+/.test(token.raw)) return html;
          let view = descriptor.view;
          if (token.type === 'escape') view = sliceView(view, 1);
          if (name === 'codespan') {
            const width = /^`+/.exec(token.raw)[0].length;
            view = replaceView(sliceView(view, width, token.raw.length - width), /\n/g, () => ' ');
            if (/^ .* $/.test(view.text) && /[^ ]/.test(view.text)) view = sliceView(view, 1, view.text.length - 1);
          }
          return source.mark(name === 'text' ? `<span>${html}</span>` : html,
            { ...descriptor, kind: 'text', view, temporary: name === 'text' });
        };
      }
      const source = this;
      this.renderMapping = coarseHtml => {
        this.coarseHtml = coarseHtml;
        this.descriptors = [];
        return marked.parse(this.text, { renderer, hooks });
      };
      const html = marked.parse(this.text);
      try {
        this.mappingHtml = this.renderMapping(false);
      } catch (error) {
        this.warn('metadata render failed: ' + error.message);
        this.mappingHtml = null;
      }
      this.restorations = [];
      return html;
    }
    restoreMapping(html, { blocks, kind, replacements, unwrap }) {
      return blocks.restore(html, (code, index) => {
        const descriptor = this.specials[kind][index], replacement = replacements[index];
        return descriptor ? this.mark(replacement, { ...descriptor, kind, lines: [], root: true, owner: {} }) : replacement;
      }, unwrap);
    }
    restore(blocks, kind, html, build, unwrap) {
      const replacements = [];
      const output = blocks.restore(html, (code, index) => {
        const replacement = build(code);
        replacements[index] = replacement;
        return replacement;
      }, unwrap);
      const restoration = { blocks, kind, replacements, unwrap };
      this.restorations.push(restoration);
      if (this.mappingHtml !== null) {
        try {
          this.mappingHtml = this.restoreMapping(this.mappingHtml, restoration);
        } catch (error) {
          this.warn('metadata replacement failed: ' + error.message);
          this.mappingHtml = null;
        }
      }
      return output;
    }
    detach(root, sanitize) {
      if (this.mappingHtml === null) return new WeakMap();
      try {
        return this.verifyMapping(root, sanitize);
      } catch (error) {
        this.textSpecs = new WeakMap();
        this.warn('metadata verification failed: ' + error.message);
        return new WeakMap();
      }
    }
    verifyMapping(root, sanitize) {
      const read = html => {
        const template = document.createElement('template');
        const copy = document.createElement('div');
        template.content.append(copy);
        copy.innerHTML = sanitize(html);
        this.textSpecs = new WeakMap();
        this.invalidAnnotations = false;
        const bindings = this.detachAnnotations(copy, new Set(), sanitize);
        copy.normalize();
        return { copy, bindings, valid: !this.invalidAnnotations };
      };
      const equal = (a, b) => {
        if (!a.isEqualNode(b)) return false;
        const left = a.querySelectorAll('template'), right = b.querySelectorAll('template');
        return [...left].every((node, i) => equal(node.content, right[i].content));
      };
      let metadata = read(this.mappingHtml);
      let verified = metadata.valid && equal(root, metadata.copy);
      if (!verified) {
        // Foreign/raw-text HTML can parse an inserted span as authored content.
        // Keep those token subtrees opaque in the metadata copy, not in the UI.
        this.mappingHtml = this.renderMapping(true);
        for (const restoration of this.restorations) {
          this.mappingHtml = this.restoreMapping(this.mappingHtml, restoration);
        }
        metadata = read(this.mappingHtml);
        verified = metadata.valid && equal(root, metadata.copy);
      }
      const bindings = new WeakMap(), specs = this.textSpecs;
      this.textSpecs = new WeakMap();
      if (!verified) {
        this.warn('unverified authored HTML structure');
        return bindings;
      }
      const actual = [root, ...root.querySelectorAll('*')];
      const copies = [metadata.copy, ...metadata.copy.querySelectorAll('*')];
      for (let i = 0; i < actual.length; i++) {
        const descriptor = metadata.bindings.get(copies[i]);
        if (descriptor) bindings.set(actual[i], descriptor);
        const text = specs.get(copies[i]);
        if (text) this.textSpecs.set(actual[i], text);
      }
      return bindings;
    }
    detachAnnotations(root, consumed, sanitize) {
      const bindings = new WeakMap();
      const runs = [];
      for (const node of root.querySelectorAll(`[${this.attribute}]`)) {
        const value = node.getAttribute(this.attribute);
        if (!value.startsWith(this.nonce + ':')) continue;
        const index = Number(value.slice(this.nonce.length + 1));
        const descriptor = this.descriptors[index];
        if (!Number.isSafeInteger(index) || !descriptor || consumed.has(index)) {
          this.invalidAnnotations = true;
          continue;
        }
        consumed.add(index);
        node.removeAttribute(this.attribute);
        if (descriptor.kind !== 'text') {
          if (descriptor.root && descriptor.kind === 'html') {
            const expected = document.createElement('template');
            expected.innerHTML = sanitize(descriptor.html);
            const nodes = [...expected.content.childNodes].filter(child =>
              child.nodeType !== Node.TEXT_NODE || child.data.trim());
            if (nodes.length !== 1 || !node.isEqualNode(nodes[0])) {
              this.warn('opaque multi-root HTML block');
              continue;
            }
          }
          bindings.set(node, descriptor);
          continue;
        }
        let block = node;
        while (block.parentNode !== root) block = block.parentNode;
        runs.push({ node, block, descriptor, display: node.textContent });
      }
      const owners = new Map();
      for (const node of root.querySelectorAll('*')) {
        const descriptor = bindings.get(node);
        if (descriptor?.root) owners.set(descriptor.owner, node);
      }
      const positions = new Map();
      const leaves = new WeakMap(runs.map(run => [run.node, run.descriptor]));
      for (const node of root.querySelectorAll('*')) {
        const descriptor = bindings.get(node) || leaves.get(node);
        if (descriptor && !descriptor.root && !owners.get(descriptor.owner)?.contains(node)) {
          this.invalidAnnotations = true;
        }
        if (descriptor && ['text', 'image', 'mermaid', 'raw'].includes(descriptor.kind)) {
          const previous = positions.get(descriptor.owner) ?? -1;
          if (descriptor.start < previous) this.invalidAnnotations = true;
          positions.set(descriptor.owner, descriptor.start);
        }
      }
      const blocks = new Map();
      for (const run of runs) {
        if (!blocks.has(run.block)) {
          const content = textNodes(run.block);
          blocks.set(run.block, new Map(content.nodes.map(entry => [entry.node, entry.start])));
          this.textSpecs.set(run.block, { text: content.text, runs: [] });
        }
        const walker = document.createTreeWalker(run.node, NodeFilter.SHOW_TEXT), first = walker.nextNode();
        const from = blocks.get(run.block).get(first);
        let view = run.descriptor.view;
        if (view.text !== run.display && /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i.test(view.text)) {
          const decoder = document.createElement('textarea');
          view = replaceView(view, /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/gi, match => {
            decoder.innerHTML = match;
            return decoder.value;
          });
        }
        if (from !== undefined && view.text === run.display) {
          this.textSpecs.get(run.block).runs.push({ from, display: run.display, view });
        } else if (from !== undefined) {
          this.warn('unverified inline text transformation');
        }
        if (run.descriptor.temporary) run.node.replaceWith(...run.node.childNodes);
      }
      for (const template of root.querySelectorAll('template')) this.detachAnnotations(template.content, consumed, sanitize);
      return bindings;
    }
    adopt(fresh, adopted, bindings) {
      const nodes = [fresh, ...fresh.querySelectorAll('*')];
      const counts = new Map(), adoptedTags = new Map();
      for (const node of nodes) {
        const tag = node.tagName, ordinal = counts.get(tag) || 0;
        counts.set(tag, ordinal + 1);
        const descriptor = bindings.get(node);
        if (!descriptor) continue;
        let target = node;
        if (fresh !== adopted) {
          if (!adoptedTags.has(tag)) adoptedTags.set(tag,
            [...(adopted.tagName === tag ? [adopted] : []), ...adopted.querySelectorAll(tag)]);
          target = adoptedTags.get(tag)[ordinal];
        }
        if (target) this.bindings.push({ ...descriptor, element: target, block: adopted });
      }
      const specs = this.textSpecs.get(fresh);
      if (specs) this.textGroups.push({ element: adopted, ...specs });
    }
  }

  function usable() {
    return active() && !frozen() && !pendingSource && committed &&
      committed.selection === identity();
  }
  function schedule() {
    if (!active() || frame) return;
    frame = requestAnimationFrame(flush);
  }
  function invalidate() {
    dirty = true;
    schedule();
  }
  const resize = new ResizeObserver(entries => {
    if (entries.some(entry => {
      const previous = measuredSizes.get(entry.target), size = entry.borderBoxSize[0];
      return !previous || !size || Math.abs(previous.width - size.inlineSize) > 1 ||
        Math.abs(previous.height - size.blockSize) > 1;
    })) invalidate();
  });
  const mutations = new MutationObserver(invalidate);
  function observe() {
    resize.disconnect();
    if (!active()) return;
    resize.observe(editor);
    resize.observe(preview);
    const elements = new Set([...(committed?.bindings || []), ...(committed?.textGroups || [])].map(binding => binding.element));
    for (const element of elements) {
      if (element.isConnected) resize.observe(element);
    }
    if (!observing) {
      mutations.observe(preview, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'src', 'width', 'height'] });
      observing = true;
    }
  }
  function sourceGeometry() {
    const started = performance.now();
    const style = getComputedStyle(editor);
    const keys = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
      'lineHeight', 'letterSpacing', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
      'whiteSpace', 'overflowWrap', 'wordBreak', 'tabSize', 'textIndent', 'textTransform'];
    const key = [editor.clientWidth, ...keys.map(name => style[name])].join('|');
    const styled = performance.now();
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.setAttribute('aria-hidden', 'true');
      mirror.inert = true;
      Object.assign(mirror.style, { position: 'fixed', left: '-100000px', top: '0',
        visibility: 'hidden', pointerEvents: 'none', height: 'auto', border: '0', boxSizing: 'border-box' });
      document.body.append(mirror);
    }
    if (key !== mirrorKey) {
      for (const name of keys) mirror.style[name] = style[name];
      mirror.style.width = editor.clientWidth + 'px';
      mirrorKey = key;
    }
    const boundaries = [...new Set([0, committed.source.length, ...committed.bindings.flatMap(binding =>
      [binding.start, binding.end, ...binding.lines, ...(binding.codeLines || []).map(line => line.offset)])])]
      .sort((a, b) => a - b);
    const offsets = [];
    for (let i = 0; i < boundaries.length; i++) {
      let from = boundaries[i], end = boundaries[i + 1] ?? committed.source.length;
      offsets.push(from);
      while (end - from > 512) {
        let stop = from + 512;
        while (stop > from && !/\s/.test(committed.source[stop - 1])) stop--;
        if (stop === from) stop = from + 512;
        if (/[\uDC00-\uDFFF]/.test(committed.source[stop])) stop--;
        offsets.push(stop);
        from = stop;
      }
    }
    const offsetKey = offsets.join(',');
    if (mirrorText !== committed.source || mirrorOffsets !== offsetKey) {
      const previous = sourceMarkers;
      const matches = (before, after) => {
        const oldFrom = previous[before].from, newFrom = offsets[after];
        return (oldFrom === mirrorText.length) === (newFrom === committed.source.length) &&
          mirrorText.slice(oldFrom, previous[before + 1]?.from ?? mirrorText.length) ===
            committed.source.slice(newFrom, offsets[after + 1] ?? committed.source.length);
      };
      let prefix = 0, suffix = 0;
      while (prefix < previous.length && prefix < offsets.length && matches(prefix, prefix)) prefix++;
      while (suffix < previous.length - prefix && suffix < offsets.length - prefix &&
        matches(previous.length - suffix - 1, offsets.length - suffix - 1)) suffix++;
      const retainsContent = (prefix > 0 && previous[0].from < mirrorText.length) ||
        (suffix > 0 && previous[previous.length - suffix].from < mirrorText.length);
      if (!retainsContent) prefix = suffix = 0;
      const fragment = document.createDocumentFragment();
      const markers = [];
      for (let i = 0; i < offsets.length; i++) {
        let span;
        if (i < prefix) span = previous[i].span;
        else if (i >= offsets.length - suffix) span = previous[i - offsets.length + previous.length].span;
        else {
          span = document.createElement('span');
          span.textContent = committed.source.slice(offsets[i], offsets[i + 1] ?? committed.source.length) ||
            (offsets[i] === committed.source.length ? '\u200b' : '');
          fragment.append(span);
        }
        markers.push({ from: offsets[i], span });
      }
      if (prefix || suffix) {
        for (let i = prefix; i < previous.length - suffix; i++) previous[i].span.remove();
        mirror.insertBefore(fragment, suffix ? previous[previous.length - suffix].span : null);
      } else {
        mirror.replaceChildren(fragment);
      }
      sourceMarkers = markers;
      mirrorText = committed.source;
      mirrorOffsets = offsetKey;
    }
    const written = performance.now();
    const top = mirror.getBoundingClientRect().top, positions = new Map(), range = document.createRange();
    stats.lastBuildPhases = { editorLayoutMs: styled - started, mirrorWriteMs: written - styled,
      mirrorLayoutMs: performance.now() - written };
    return offset => {
      if (!positions.has(offset)) {
        const marker = sourceMarkers[Math.max(0, upperBound(sourceMarkers, offset, 'from') - 1)];
        const text = marker.span.firstChild, at = offset - marker.from;
        range.setStart(text, at);
        range.setEnd(text, at + 1);
        positions.set(offset, range.getBoundingClientRect().top - top);
      }
      return positions.get(offset);
    };
  }
  function rebuild() {
    const started = performance.now();
    dirty = false;
    clearGeometry();
    if (!usable() || editor.value !== committed.source) return;
    const sourceY = sourceGeometry(), rect = preview.getBoundingClientRect(), zoom = scale(preview);
    measuredSizes.set(editor, { width: editor.offsetWidth, height: editor.offsetHeight });
    measuredSizes.set(preview, { width: rect.width / zoom, height: rect.height / zoom });
    const previewTop = preview.scrollTop - preview.clientTop;
    const previewY = y => (y - rect.top) / zoom + previewTop;
    const pairs = [];
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight);
    const add = (offset, y, end = false, priority = 0, block = null) => pairs.push({
      offset, editor: sourceY(offset) + (end ? lineHeight : 0), preview: previewY(y), priority, block,
    });
    const geometryStarted = performance.now();
    for (const binding of committed.bindings) {
      const { element, start, end, lines } = binding;
      if (!preview.contains(element) || !element.getClientRects().length) continue;
      const box = element.getBoundingClientRect();
      measuredSizes.set(element, { width: box.width / zoom, height: box.height / zoom });
      if (!box.height) continue;
      const atomic = ['image', 'mermaid', 'raw'].includes(binding.kind), priority = atomic ? 3 : 0;
      add(start, box.top, false, priority, binding.block);
      // Physical prose lines have exact rendered counterparts with breaks:true.
      // Other pixels interpolate only inside their own semantic block.
      if (lines.length) {
        const breaks = element.querySelectorAll('br');
        if (breaks.length === lines.length) {
          const range = document.createRange(), walker = document.createTreeWalker(element,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
          let node, line = 0, offset;
          while ((node = walker.nextNode())) {
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') offset = lines[line++];
            else if (offset !== undefined && node.nodeType === Node.TEXT_NODE && node.length) {
              range.setStart(node, 0);
              range.setEnd(node, 1);
              const box = range.getBoundingClientRect();
              if (box.height) {
                add(offset, box.top);
                offset = undefined;
              }
            }
          }
        }
      }
      if (binding.codeLines?.length) {
        const code = element.querySelector('code');
        if (code) {
          const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT), nodes = [];
          let textOffset = 0, node;
          while ((node = walker.nextNode())) {
            nodes.push({ node, start: textOffset });
            textOffset += node.length;
          }
          const range = document.createRange();
          for (const line of binding.codeLines) {
            const i = Math.max(0, upperBound(nodes, line.textOffset, 'start') - 1), entry = nodes[i];
            if (!entry || !entry.node.length) continue;
            const at = Math.min(entry.node.length - 1, line.textOffset - entry.start);
            range.setStart(entry.node, at);
            range.setEnd(entry.node, at + 1);
            add(line.offset, range.getBoundingClientRect().top);
          }
        }
      }
      add(end, box.bottom, !binding.inline, priority, binding.block);
    }
    const range = document.createRange();
    for (const group of committed.textGroups) {
      if (!preview.contains(group.element) || !group.element.getClientRects().length) continue;
      const content = textNodes(group.element);
      if (content.text !== group.text) {
        committed.warn('changed reused text shape');
        continue;
      }
      const style = getComputedStyle(group.element);
      const renderedLine = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      for (const run of group.runs) {
        const samples = new Map();
        const sample = requested => {
          let i = requested;
          if (i > 0 && /[\uDC00-\uDFFF]/.test(run.display[i])) i--;
          if (samples.has(i)) return samples.get(i);
          const position = run.from + i;
          const entry = content.nodes[Math.max(0, upperBound(content.nodes, position, 'start') - 1)];
          const at = position - entry.start, width = run.display.codePointAt(i) > 0xFFFF ? 2 : 1;
          range.setStart(entry.node, at);
          range.setEnd(entry.node, at + width);
          const box = range.getBoundingClientRect();
          const point = box.height ? { index: i, offset: run.view.at(i), preview: previewY(box.top),
            editor: sourceY(run.view.at(i)), priority: 2, block: group.element } : null;
          samples.set(i, point);
          return point;
        };
        const subdivide = (a, b) => {
          if (!a || !b || b.index - a.index <= 1 ||
              (Math.abs(b.editor - a.editor) <= lineHeight * 1.1 &&
               Math.abs(b.preview - a.preview) <= renderedLine * 1.1)) return;
          const middle = sample((a.index + b.index) >>> 1);
          if (!middle || middle.index <= a.index || middle.index >= b.index) return;
          subdivide(a, middle);
          subdivide(middle, b);
        };
        if (!run.display.length) continue;
        subdivide(sample(0), sample(run.display.length - 1));
        for (const point of samples.values()) if (point) pairs.push(point);
      }
    }
    stats.lastBuildPhases.bindingGeometryMs = performance.now() - geometryStarted;
    pairs.sort((a, b) => a.offset - b.offset || b.priority - a.priority || a.preview - b.preview);
    let previous = { editor: 0, preview: 0, priority: 0 };
    anchors.push(previous);
    for (const pair of pairs) {
      while (anchors.length > 1 && pair.block === previous.block && pair.priority > previous.priority &&
          (pair.editor < previous.editor || pair.preview < previous.preview)) {
        anchors.pop();
        previous = anchors[anchors.length - 1];
      }
      if (pair.editor < previous.editor || pair.preview < previous.preview) continue;
      if (pair.editor === previous.editor && pair.preview === previous.preview) {
        if (pair.priority > previous.priority) anchors[anchors.length - 1] = previous = pair;
        continue;
      }
      anchors.push(pair);
      previous = pair;
    }
    for (const side of ['editor', 'preview']) {
      const points = [];
      for (const point of anchors) {
        const last = points[points.length - 1];
        if (!last || point[side] !== last[side]) points.push(point);
        // A collapsed source/image or preview/text row has no unique inverse.
        // Keep its leading precise boundary, not the last character on it.
        else if (point.priority > last.priority) points[points.length - 1] = point;
      }
      scrollPoints[side] = points;
    }
    editorMax = Math.max(0, editor.scrollHeight - editor.clientHeight);
    previewMax = Math.max(0, preview.scrollHeight - preview.clientHeight);
    stats.builds++;
    stats.lastBuildMs = performance.now() - started;
    stats.buildMs ||= [];
    stats.buildMs.push(stats.lastBuildMs);
    if (stats.buildMs.length > 32) stats.buildMs.shift();
  }
  let editorMax = 0, previewMax = 0;
  function sync() {
    if (!anchors.length || !owner) return;
    const from = owner, to = from === 'editor' ? 'preview' : 'editor';
    const driver = from === 'editor' ? editor : preview, follower = to === 'editor' ? editor : preview;
    const max = from === 'editor' ? editorMax : previewMax, otherMax = to === 'editor' ? editorMax : previewMax;
    if (max <= 1) return;
    const position = driver.scrollTop;
    let target;
    if (position <= 1) target = 0;
    else if (position >= max - 1) target = otherMax;
    else {
      const points = scrollPoints[from];
      const i = Math.max(0, upperBound(points, position, from) - 1);
      const a = points[i], b = points[Math.min(i + 1, points.length - 1)];
      const fraction = b[from] > a[from] ? Math.min(1, (position - a[from]) / (b[from] - a[from])) : 0;
      target = a[to] + fraction * (b[to] - a[to]);
    }
    target = Math.min(otherMax, Math.max(0, target));
    if (Math.abs(follower.scrollTop - target) > .75) {
      follower.scrollTop = target;
      stats.writes++;
    }
    lastEditor = editor.scrollTop;
    lastPreview = preview.scrollTop;
  }
  function flush() {
    frame = 0;
    if (!usable()) return;
    if (dirty) rebuild();
    const start = performance.now();
    sync();
    stats.callbacks.push(performance.now() - start);
    if (stats.callbacks.length > 256) stats.callbacks.shift();
  }
  function claim(side) {
    if (!active() || frozen()) return;
    owner = side;
    if (side === 'editor') {
      window.dispatchEvent(new Event('editor-scroll-intent'));
    }
  }
  function nestedScroller(target, pane, direction = 0) {
    for (let node = target instanceof Element ? target : target.parentElement; node && node !== pane; node = node.parentElement) {
      const max = node.scrollHeight - node.clientHeight;
      if (max <= 1) continue;
      const style = getComputedStyle(node);
      if (!/auto|scroll/.test(style.overflowY)) continue;
      if (!direction || (direction < 0 ? node.scrollTop > 1 : node.scrollTop < max - 1) ||
          /contain|none/.test(style.overscrollBehaviorY)) return true;
    }
    return false;
  }
  for (const [side, pane] of [['editor', editor], ['preview', preview]]) {
    pane.addEventListener('wheel', event => {
      if (event.ctrlKey || event.metaKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
          event.defaultPrevented || nestedScroller(event.target, pane, event.deltaY)) return;
      claim(side);
    }, { passive: true });
    pane.addEventListener('pointerdown', event => {
      if (!nestedScroller(event.target, pane)) claim(side);
    }, { passive: true });
    pane.addEventListener('keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) claim(side);
    });
    pane.addEventListener('scroll', event => {
      if (event.target !== pane || !usable()) return;
      const last = side === 'editor' ? lastEditor : lastPreview;
      if (Math.abs(pane.scrollTop - last) < .5) return; // Horizontal scrolling is independent.
      if (!owner) owner = side;
      if (side !== owner) return; // A follower never takes ownership from a scroll event.
      stats.scrolls++;
      schedule();
    }, { passive: true });
  }
  document.fonts?.addEventListener('loadingdone', invalidate);
  return {
    source: text => new Source(text),
    start() { pendingSource = true; clearGeometry(); },
    commit(source) {
      if (committed?.selection !== source.selection) owner = 'preview';
      committed = source;
      pendingSource = false;
      observe();
      invalidate();
    },
    changed() { pendingSource = true; clearGeometry(); claim('editor'); },
    reset() {
      pendingSource = true;
      committed = null;
      clearGeometry();
      owner = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
    enter() {
      owner = 'preview';
      lastEditor = lastPreview = 0;
      observe();
      invalidate();
      return !!committed && committed.source === editor.value && committed.selection === identity() && !pendingSource;
    },
    leave() {
      owner = null;
      clearGeometry();
      resize.disconnect();
      mutations.disconnect();
      observing = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      mirror?.remove();
      mirror = null;
      mirrorText = mirrorKey = mirrorOffsets = null;
      sourceMarkers = [];
    },
    previewNavigation() { claim('preview'); schedule(); },
    invalidate,
    diagnostics() {
      return { ready: !!usable() && anchors.length > 0, pendingGeometry: dirty || !!frame, owner, anchors: anchors.length,
        pendingSource, builds: stats.builds, scrolls: stats.scrolls, writes: stats.writes,
        matchesSource: committed?.source === editor.value, selection: identity(),
        mappedSelection: committed?.selection ?? null,
        lastBuildMs: stats.lastBuildMs,
        lastBuildPhases: stats.lastBuildPhases,
        textGroups: committed?.textGroups.length || 0,
        mappingWarnings: committed ? [...committed.warnings] : [],
        buildMs: stats.buildMs?.slice() || [],
        callbacks: stats.callbacks.slice() };
    },
  };
};
