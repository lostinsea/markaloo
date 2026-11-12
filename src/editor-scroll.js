"use strict";

// Mapping markup lives only in a detached metadata copy. The displayed HTML is
// unchanged, and bindings cross over only after complete DOM verification.
window.createEditorScroll = function ({ editor, preview, active, frozen, identity, scale, presentation, readingSourceIdentity }) {
  const readingEnabled = typeof presentation === 'function' && typeof readingSourceIdentity === 'function';
  const attribute = 'data-markaloo-scroll';
  let committed = null, owner = null, anchors = [], frame = 0, dirty = false;
  let mirror = null, mirrorText = null, mirrorKey = null, mirrorOffsets = null, observing = false;
  let sourceMarkers = [];
  const scrollPoints = { editor: [], preview: [] };
  const measuredSizes = new WeakMap();
  const tableReceipts = new WeakMap();
  const textReceipts = new WeakMap(), sourceTextReceipts = new WeakMap();
  const readingAdoptions = new WeakMap(), readingOwners = new WeakMap(), readingBodies = new WeakMap(), readingFinal = new WeakMap(), readingReceipts = new WeakMap();
  let publishedText = null, readingEpoch = 0, bindingEpoch = 0;
  let lastReadingCaptureFailure = null;
  let pendingSource = false, lastEditor = 0, lastPreview = 0;
  let pendingNestedWheel = null;
  const stats = { builds: 0, scrolls: 0, writes: 0, callbacks: [] };

  function clearGeometry() {
    pendingNestedWheel = null;
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
    return { text: view.text.slice(from, to), at: offset => view.at(from + offset),
      exact: offset => Number.isInteger(offset) && offset >= 0 && offset <= to - from &&
        view.exact(from + offset) };
  }

  function replaceView(view, regex, replacement) {
    const pieces = [];
    let cursor = 0, output = 0;
    const copy = end => {
      if (end > cursor) pieces.push({ from: output, to: output + end - cursor,
        start: cursor, end, linear: true });
      output += end - cursor;
      cursor = end;
    };
    const text = view.text.replace(regex, (...args) => {
      const start = args[args.length - 2], value = replacement(...args);
      copy(start);
      if (value === args[0]) { copy(start + value.length); return value; }
      if (value.length) pieces.push({ from: output, to: output + value.length,
        start, end: start + args[0].length, linear: false });
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
    }, exact(offset) {
      if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
      if (!pieces.length) return view.exact(view.text.length);
      const part = pieces[Math.max(0, Math.min(pieces.length - 1, upperBound(pieces, offset, 'from') - 1))];
      if (offset === part.from) return view.exact(part.start);
      if (offset === part.to) return view.exact(part.end);
      return part.linear && view.exact(part.start + offset - part.from);
    } };
  }

  // Marked owns tokenization. This only verifies the copied characters in its
  // dequoted/deindented child input, one physical source line at a time.
  function childView(view, text, kind, task = false) {
    const sourceLines = view.text.split('\n'), childLines = text.split('\n'), rows = [], omissions = [];
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
      const prefixEnd = sourceOffset + columns[at];
      if (prefixEnd > sourceOffset && view.exact(sourceOffset) && view.exact(prefixEnd)) {
        omissions.push({ start: view.at(sourceOffset), end: view.at(prefixEnd) });
      }
      rows.push({ from: childOffset, sourceOffset, columns, at, generated, length: child.length });
      sourceOffset += raw.length + 1;
      childOffset += child.length + 1;
    }
    return { text, omissions, at(offset) {
      const row = rows[Math.max(0, upperBound(rows, offset, 'from') - 1)];
      const column = Math.max(0, Math.min(row.length, offset - row.from) - row.generated);
      return view.at(row.sourceOffset + row.columns[row.at + column]);
    }, exact(offset) {
      if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
      const row = rows[Math.max(0, upperBound(rows, offset, 'from') - 1)];
      const column = offset - row.from;
      if (column < row.generated || column > row.length) return false;
      const expanded = row.at + column - row.generated, original = row.columns[expanded];
      // Interior tab columns and Marked-generated spaces are not source boundaries.
      if (original === undefined || (expanded > 0 && original === row.columns[expanded - 1])) return false;
      return view.exact(row.sourceOffset + original);
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
      this.segments = [{ from: 0, to: text.length, start: 0, end: text.length,
        linear: true, exactStart: true, exactEnd: true }];
      this.cr = [];
      for (let i = 0; i < text.length; i++) if (text[i] === '\r' && text[i + 1] === '\n') this.cr.push({ offset: i });
      this.nonce = crypto.randomUUID();
      this.attribute = attribute + '-' + this.nonce;
      this.descriptors = [];
      this.bindings = [];
      this.editableTables = new Map();
      this.textSpecs = new WeakMap();
      this.readingTextSpecs = new WeakMap();
      this.textGroups = [];
      this.editableText = [];
      this.captureOwners = [];
      this.captureGaps = [];
      this.warnings = new Set();
      this.specials = { mermaid: [], raw: [] };
      this.selection = identity();
    }
    originalOffset(position, segments = this.segments) {
      const i = Math.min(segments.length - 1, upperBound(segments, position, 'from') - 1);
      const s = segments[Math.max(0, i)];
      const fraction = s.to > s.from ? (position - s.from) / (s.to - s.from) : 0;
      return Math.round(s.start + fraction * (s.end - s.start));
    }
    exactOriginalOffset(position, segments = this.segments) {
      if (!Number.isInteger(position) || position < 0 || position > segments[segments.length - 1].to) return false;
      const s = segments[Math.max(0, upperBound(segments, position, 'from') - 1)];
      if (position === s.from) return s.exactStart;
      if (position === s.to) return s.exactEnd;
      return s.linear;
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
            start: this.originalOffset(cursor), end: this.originalOffset(stop), linear: s.linear,
            exactStart: this.exactOriginalOffset(cursor), exactEnd: this.exactOriginalOffset(stop) });
          output += stop - cursor;
          cursor = stop;
        }
      };
      for (const edit of edits) {
        copy(edit.from);
        if (edit.text === this.text.slice(edit.from, edit.to)) { copy(edit.to); continue; }
        if (edit.text.length) segments.push({ from: output, to: output + edit.text.length,
          start: this.originalOffset(edit.from), end: this.originalOffset(edit.to), linear: false,
          exactStart: this.exactOriginalOffset(edit.from), exactEnd: this.exactOriginalOffset(edit.to) });
        output += edit.text.length;
        cursor = edit.to;
      }
      copy(this.text.length);
      this.text = next;
      this.segments = segments.length ? segments : [{ from: 0, to: 0, start: 0, end: 0,
        linear: false, exactStart: false, exactEnd: false }];
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
      const segments = this.segments.map(segment => ({ ...segment })), cr = [...this.cr];
      const rootView = { text: this.text, at: offset => {
        const original = this.originalOffset(offset, segments);
        return original - upperBound(cr, original - 1, 'offset');
      }, exact: offset => this.exactOriginalOffset(offset, segments) };
      const codeBody = (token, view) => {
        const width = /^`+/.exec(token.raw)[0].length;
        let body = replaceView(sliceView(view, width, token.raw.length - width), /\n/g, () => ' ');
        if (/^ .* $/.test(body.text) && /[^ ]/.test(body.text)) body = sliceView(body, 1, body.text.length - 1);
        return body;
      };
      const fencedReadingCode = (token, view) => {
        const opening = /^( {0,3})(`{3,}|~{3,})[^\n]*\n/.exec(token.raw);
        if (!opening || token.codeBlockStyle === 'indented') return null;
        const delimiter = opening[2][0], width = opening[2].length, start = opening[0].length;
        const closing = new RegExp('(?:^|\\n) {0,3}' + delimiter + '{' + width + ',}[ \\t]*(?:\\n)?$')
          .exec(token.raw.slice(start));
        const stop = closing ? start + closing.index + (closing[0][0] === '\n' ? 1 : 0) : token.raw.length;
        const rawLines = token.raw.slice(start, stop).split('\n'), rows = [];
        let sourceOffset = start, output = 0;
        const lines = rawLines.map(raw => {
          const indentation = opening[1].length && raw.startsWith(opening[1]) ? opening[1].length : 0;
          const text = raw.slice(indentation);
          rows.push({ from: output, view: sliceView(view, sourceOffset + indentation, sourceOffset + raw.length), text });
          sourceOffset += raw.length + 1; output += text.length + 1;
          return text;
        });
        const body = lines.join('\n').replace(/\n$/, '');
        if (body !== token.text) return null;
        const retained = token.text.replace(/\n$/, ''), display = retained + '\n';
        const runs = rows.filter(row => row.text.length && row.from < retained.length).map(row => ({
          from: row.from, display: row.text, view: row.view, kind: 'code',
        }));
        return runs.every(run => run.from + run.display.length <= retained.length &&
          run.view.text === run.display && run.view.exact(0) && run.view.exact(run.display.length)) ? { display, runs } : null;
      };
      const captureBody = (descriptor, view) => {
        if (descriptor.view.exact(0) && descriptor.view.exact(descriptor.view.text.length) &&
            view.exact(0) && view.exact(view.text.length)) {
          descriptor.captureBody = { start: view.at(0), end: view.at(view.text.length) };
        }
      };
      const containsHtml = token => token.type === 'html' ||
        [...(token.tokens || []), ...(token.items || [])].some(containsHtml);
      const locate = (items, view, topLevel = false, inline = false, opaque = false, owner = null, readingOnly = false) => {
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
          if (!readingOnly && topLevel && at > cursor && /^\s*$/.test(view.text.slice(cursor, at)) &&
              view.exact(cursor) && view.exact(at)) {
            this.captureGaps.push({ start: view.at(cursor), end: view.at(at) });
          }
          if (!readingOnly && ['space', 'br'].includes(token.type) && tokenView.exact(0) &&
              tokenView.exact(token.raw.length)) {
            this.captureGaps.push({ start: tokenView.at(0), end: tokenView.at(token.raw.length) });
          }
          const end = token.raw.trimEnd().length;
          const tokenOwner = topLevel ? {} : owner;
          const rows = token.type === 'table' ? [...token.raw.trimEnd().matchAll(/[^\n]+/g)].map(match => ({
            start: tokenView.at(match.index), end: tokenView.at(match.index + match[0].length),
          })) : [];
          let codeOffset = 0;
          const codeStart = token.type === 'code' ? token.raw.indexOf(token.text) : -1;
          spans.set(token, { start: tokenView.at(0), end: tokenView.at(end), kind: token.type, inline, opaque,
            owner: tokenOwner, root: topLevel, view: tokenView, ...(readingOnly ? { readingOnly: true } : {}),
            rows: token.type === 'table' ? [rows[0], ...rows.slice(2)] : [],
            codeLines: codeStart >= 0
              ? token.text.split('\n').map(line => {
                const entry = { offset: tokenView.at(codeStart + codeOffset), textOffset: codeOffset };
                codeOffset += line.length + 1;
                return entry;
              }) : [],
            ...(token.type === 'code' && readingEnabled ? { readingCode: fencedReadingCode(token, tokenView) } : {}),
            lines: token.type === 'paragraph' ? [...token.raw.trimEnd().matchAll(/\n/g)]
              .map(match => tokenView.at(match.index + 1)) : [] });
          if (!readingOnly && token.type === 'codespan') captureBody(spans.get(token), codeBody(token, tokenView));
          cursor = at + token.raw.length;
          const opaqueChildren = opaque || (this.coarseHtml && topLevel && containsHtml(token));
          if (token.type === 'table' && readingEnabled && !opaqueChildren) {
            const index = window.MarkalooTableCells?.index;
            if (typeof index !== 'function') this.warn('reading table parser unavailable');
            else {
              const model = index(tokenView.text, marked, value => value), table = model.tables[0];
              const expected = [token.header, ...token.rows];
              if (model.tables.length === 1 && !model.otherTables.length && table.start === 0 &&
                  table.end === token.raw.trimEnd().length && table.token.raw.trimEnd() === token.raw.trimEnd() &&
                  table.rows.length === expected.length &&
                  [table.token.header, ...table.token.rows].every((row, r) => row.length === expected[r].length &&
                    row.every((cell, c) => cell.text === expected[r][c].text))) {
                const cells = expected.map((row, r) => row.map((cell, c) => {
                  const actual = table.rows[r].cells[c];
                  if (!actual) return { text: cell.text, synthetic: true };
                  const view = replaceView(sliceView(tokenView, actual.start, actual.end), /\\\|/g, () => '|');
                  if (view.text !== cell.text || !view.exact(0) || !view.exact(view.text.length)) return null;
                  return { text: cell.text, start: view.at(0), end: view.at(view.text.length), view, token: cell };
                }));
                if (cells.every(row => row.every(Boolean))) {
                  spans.get(token).readingTable = cells;
                  for (let r = 0; r < cells.length; r++) for (let c = 0; c < cells[r].length; c++) {
                    const cell = cells[r][c];
                    if (cell.synthetic) continue;
                    spans.set(cell.token, { ...cell, kind: 'cell', row: r, column: c, readingOnly: true,
                      owner: tokenOwner, root: false, inline: true });
                    locate(cell.token.tokens, cell.view, false, true, false, tokenOwner, true);
                  }
                } else this.warn('unverified reading table cell projection');
              } else this.warn('unverified reading table structure');
            }
          }
          if (token.items) locate(token.items, tokenView, false, false, opaqueChildren, tokenOwner, readingOnly);
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
          } else if (token.type === 'link' && token.raw.startsWith('<') && token.raw.endsWith('>')) {
            children = sliceView(tokenView, 1, token.raw.length - 1);
          }
          if (!readingOnly && children?.omissions) this.captureGaps.push(...children.omissions);
          if (!readingOnly && children && ['strong', 'em', 'del', 'link'].includes(token.type)) {
            captureBody(spans.get(token), children);
          }
          if (children) locate(token.tokens, children, false,
            inline || !['list_item', 'blockquote'].includes(token.type), opaqueChildren, tokenOwner, readingOnly);
          else this.warn('unverified ' + token.type + ' prefix removal');
        }
      };
      const hooks = new marked.Hooks();
      hooks.processAllTokens = tokens => {
        this.captureGaps = [];
        locate(tokens, rootView, true);
        return tokens;
      };
      const renderer = new marked.Renderer();
      for (const name of ['heading', 'paragraph', 'code', 'list', 'listitem', 'blockquote',
        'table', 'tablecell', 'html', 'hr', 'image', 'strong', 'em', 'del', 'link']) {
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
          if (token.type === 'escape') view = replaceView(view, /^\\([\s\S])$/, (match, char) => char);
          if (name === 'codespan') {
            view = codeBody(token, view);
            const body = source.mark(`<span>${html.slice(6, -7)}</span>`,
              { ...descriptor, kind: 'text', view, temporary: true });
            return source.mark(`<code>${body}</code>`, descriptor);
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
        this.readingTextSpecs = new WeakMap();
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
        this.readingTextSpecs = new WeakMap();
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
      const bindings = new WeakMap(), specs = this.textSpecs, readingSpecs = this.readingTextSpecs;
      this.textSpecs = new WeakMap();
      this.readingTextSpecs = new WeakMap();
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
        const reading = readingSpecs.get(copies[i]);
        if (reading) this.readingTextSpecs.set(actual[i], reading);
      }
      return bindings;
    }
    detachAnnotations(root, consumed, sanitize) {
      const bindings = new WeakMap();
      const runs = [], codeRuns = [];
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
          if (descriptor.readingCode) codeRuns.push({ node, descriptor });
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
      const blocks = new Map(), editingBlocks = new Set();
      for (const run of runs) {
        if (!blocks.has(run.block)) {
          const content = textNodes(run.block);
          blocks.set(run.block, { positions: new Map(content.nodes.map(entry => [entry.node, entry.start])), text: content.text });
          if (readingEnabled) this.readingTextSpecs.set(run.block, { text: content.text, runs: [] });
        }
        if (!run.descriptor.readingOnly && !editingBlocks.has(run.block)) {
          this.textSpecs.set(run.block, { text: blocks.get(run.block).text, runs: [] });
          editingBlocks.add(run.block);
        }
        const child = run.node.firstChild;
        const first = child?.nodeType === Node.TEXT_NODE ? child :
          document.createTreeWalker(run.node, NodeFilter.SHOW_TEXT).nextNode();
        const from = blocks.get(run.block).positions.get(first);
        let view = run.descriptor.view;
        if (view.text !== run.display && /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i.test(view.text)) {
          const decoder = document.createElement('textarea');
          view = replaceView(view, /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/gi, match => {
            decoder.innerHTML = match;
            return decoder.value;
          });
        }
        if (from !== undefined && view.text === run.display) {
          if (!run.descriptor.readingOnly) this.textSpecs.get(run.block).runs.push({ from, display: run.display, view });
          if (readingEnabled) this.readingTextSpecs.get(run.block).runs.push({
            from, display: run.display, view, ...(run.descriptor.readingOnly ? { kind: 'table' } : {}),
          });
        } else if (from !== undefined) {
          this.warn('unverified inline text transformation');
        }
        if (run.descriptor.temporary) run.node.replaceWith(...run.node.childNodes);
      }
      if (readingEnabled) {
        for (const { node, descriptor } of codeRuns) {
          const codes = node.querySelectorAll('code'), code = codes[0];
          if (node.tagName !== 'PRE' || codes.length !== 1 || code.parentNode !== node ||
              code.textContent !== descriptor.readingCode.display ||
              [...code.childNodes].some(child => child.nodeType !== Node.TEXT_NODE)) continue;
          let block = node;
          while (block.parentNode !== root) block = block.parentNode;
          const content = textNodes(block), codeContent = textNodes(code);
          const from = content.nodes.find(entry => entry.node === codeContent.nodes[0]?.node)?.start;
          if (from === undefined) continue;
          const specs = this.readingTextSpecs.get(block) || { text: content.text, runs: [] };
          specs.runs.push(...descriptor.readingCode.runs.map(run => ({ ...run, from: from + run.from })));
          specs.runs.sort((a, b) => a.from - b.from);
          this.readingTextSpecs.set(block, specs);
        }
      }
      for (const template of root.querySelectorAll('template')) this.detachAnnotations(template.content, consumed, sanitize);
      return bindings;
    }
    adopt(fresh, adopted, bindings) {
      const table = bindings?.get(fresh);
      if (fresh.tagName === 'TABLE' && table?.kind === 'table' && table.root) {
        const target = fresh === adopted ? fresh :
          adopted.tagName === 'TABLE' ? adopted :
          adopted.classList.contains('table-container') ? adopted.querySelector(':scope > table') : null;
        const previous = target && tableReceipts.get(target);
        // Hash/LCS matching is a rendering optimization, not edit authority.
        if (target && (target === fresh || (previous?.canonical === fresh.innerHTML &&
            previous.presented === target.innerHTML))) {
          this.editableTables.set(target, { start: table.start, end: table.end,
            canonical: fresh.innerHTML });
        }
      }
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
        if (target && !descriptor.readingOnly) {
          const editingDescriptor = { ...descriptor, element: target, block: adopted };
          if (readingEnabled) {
            delete editingDescriptor.readingCode;
            delete editingDescriptor.readingTable;
          }
          if (descriptor.captureBody) this.captureOwners.push(editingDescriptor);
          else this.bindings.push(editingDescriptor);
        }
        if (readingEnabled && descriptor.view &&
            (fresh === adopted || (node === fresh && fresh.isEqualNode(adopted))) &&
            descriptor.view.exact(0) && descriptor.view.exact(descriptor.view.text.trimEnd().length)) {
          const owners = readingOwners.get(this) || [];
          owners.push({ element: fresh === adopted ? node : adopted, start: descriptor.start, end: descriptor.end,
            kind: descriptor.kind, tag: (fresh === adopted ? node : adopted).tagName, role: 'body' });
          readingOwners.set(this, owners);
        }
      }
      const specs = this.textSpecs.get(fresh);
      if (specs) {
        this.textGroups.push({ element: adopted, ...specs });
        const previous = textReceipts.get(adopted);
        if (fresh === adopted || fresh.isEqualNode(adopted) ||
            (fresh.tagName === adopted.tagName && previous?.canonical === fresh.outerHTML &&
             previous.presented === adopted.innerHTML)) {
          this.editableText.push({ element: adopted, canonical: fresh.outerHTML, ...specs });
        }
      }
      const reading = this.readingTextSpecs.get(fresh);
      if (readingEnabled && reading) {
        const bodies = readingBodies.get(this) || [];
        bodies.push({ fresh, adopted, specs: reading, tree: readingTree(fresh),
          bindings: nodes.map(node => ({ node, descriptor: bindings.get(node) })).filter(entry => entry.descriptor) });
        readingBodies.set(this, bodies);
      }
      if (readingEnabled && reading &&
          (fresh === adopted || fresh.isEqualNode(adopted))) {
        const groups = readingAdoptions.get(this) || [];
        groups.push({ element: adopted, ...reading, shape: readingShape(adopted), elements: readingElements(adopted) });
        readingAdoptions.set(this, groups);
      }
    }
  }

  function usable() {
    return active() && !frozen() && !pendingSource && committed &&
      committed.selection === identity();
  }
  // Reading publication is opt-in and independent of pending editor text.
  // Renderer lifecycle/revision binding and all restoration are still unwired.
  const readingLimits = { atom: 256, display: 128, context: 32, nested: 4 };
  function readingTree(root) {
    if (root.nodeType === Node.TEXT_NODE) return root.data;
    return { node: root, tag: root.tagName, attributes: [...root.attributes].map(attr => [attr.name, attr.value]).sort(),
      children: [...root.childNodes].map(readingTree) };
  }
  function readingHighlight(node) {
    const attributes = [...node.attributes];
    return node.tagName === 'SPAN' && attributes.length === 1 && attributes[0].name === 'class' &&
      /^(?:search-highlight(?: current)?|current search-highlight)$/.test(attributes[0].value);
  }
  function readingElements(root, controls = new Set()) {
    return [root, ...root.querySelectorAll('*')].filter(node => {
      if (readingHighlight(node)) return false;
      for (let parent = node.parentElement; parent && parent !== root.parentElement; parent = parent.parentElement) {
        if (controls.has(parent)) return false;
      }
      return true;
    });
  }
  function sameReadingElements(elements, root, controls) {
    const current = readingElements(root, controls);
    return current.length === elements.length && current.every((node, index) => node === elements[index]);
  }
  function readingShape(root, controls = new Set()) {
    const parts = [];
    let text = '';
    const flush = () => { if (text) { parts.push(text); text = ''; } };
    const visit = node => {
      if (node.nodeType === Node.TEXT_NODE) { text += node.data; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) { flush(); parts.push(['other', node.nodeType]); return; }
      if (controls.has(node)) { flush(); parts.push(['control', node.tagName]); return; }
      const attributes = [...node.attributes].map(attr => [attr.name, attr.value]).sort();
      const transparent = readingHighlight(node);
      if (!transparent) { flush(); parts.push(['open', node.tagName, attributes]); }
      for (const child of node.childNodes) visit(child);
      if (!transparent) { flush(); parts.push(['close']); }
    };
    visit(root); flush();
    return JSON.stringify(parts);
  }
  function readingContext() {
    if (!readingEnabled) return null;
    const value = presentation();
    const scalar = part => (typeof part === 'string' && part.length > 0 && part.length <= 128) ||
      (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0);
    return value && scalar(value.owner) && scalar(value.revision)
      ? { owner: value.owner, revision: value.revision } : null;
  }
  function sameReadingContext(a, b) {
    return !!a && !!b && a.owner === b.owner && a.revision === b.revision;
  }
  function readingState(source) {
    if (!readingEnabled) return null;
    // Only external authority reads are caught. Their failure is an explicit API refusal.
    try {
      const context = readingContext();
      if (source === null) return { context };
      const selection = identity(), held = frozen(), key = readingSourceIdentity(source);
      return context && typeof key === 'string' && key.length > 0 && key.length <= 128
        ? { context, selection, frozen: held, key } : null;
    } catch {
      return null;
    }
  }
  function readingFailure(status, reason) { return Object.freeze({ status, reason }); }
  function bindReadingPresentation(source, context, associations) {
    const observation = typeof readingPublicationObservation === 'undefined' ? null : readingPublicationObservation;
    const observedAttempt = observation?.bindingOp || 0;
    const observedAdmission = observation?.admission ?? null;
    if (!(source instanceof Source)) return readingFailure('unavailable', 'presentation-unbound');
    const entered = readingEpoch, enteredBinding = bindingEpoch, state = readingState(source);
    if (!state || entered !== readingEpoch || enteredBinding !== bindingEpoch ||
        !sameReadingContext(context, state.context) || source.selection !== state.selection ||
        state.frozen || !Array.isArray(associations)) {
      return readingFailure('unavailable', 'presentation-unbound');
    }
    const ticket = ++bindingEpoch, proofs = readingBodies.get(source);
    readingFinal.delete(source);
    if (!proofs?.length || associations.length !== proofs.length) return readingFailure('unsupported', 'incomplete-body-associations');
    const groups = [], owners = [], usedBodies = new Set(), usedFresh = new Set(), usedWrappers = new Set(), usedControls = new Set();
    const usedSections = new Set(), imageControls = new Map();
    const pseudos = new Map(), translatedHeaders = new Set(), translatedTables = new Set();
    for (const association of associations) {
      const proof = proofs.find(proof => proof.fresh === association?.fresh), body = association?.body;
      if (!proof || usedFresh.has(proof.fresh) || !(body instanceof Element) || !body.isConnected ||
          !preview.contains(body) || usedBodies.has(body) || !Array.isArray(association.owners) ||
          (association.sections !== undefined && !Array.isArray(association.sections)) ||
          (association.images !== undefined && !Array.isArray(association.images))) {
        return readingFailure('unsupported', 'unverified-body-association');
      }
      usedFresh.add(proof.fresh); usedBodies.add(body);
      const targets = new Map(), codeBodies = new Map(), tableBodies = new Set(), controls = new Set(), ownerPairs = new Map(), wrappers = new Map();
      const sections = new Map(), images = new Map();
      for (const pair of association.sections || []) {
        const tree = findReadingTree(proof.tree, pair?.fresh), section = pair?.section;
        if (!tree || !/^H[1-6]$/.test(tree.tag) || sections.has(pair.fresh) ||
            !(pair.header instanceof Element) || !body.contains(pair.header) ||
            !(section instanceof Element) || !section.isConnected || !preview.contains(section) ||
            usedSections.has(section) || pair.header.nextElementSibling !== section ||
            JSON.stringify([...section.attributes].map(attr => [attr.name, attr.value]).sort()) !== pair.attributes) {
          return readingFailure('unsupported', 'unverified-producer-section');
        }
        sections.set(pair.fresh, pair.header);
        usedSections.add(section);
      }
      for (const pair of association.images || []) {
        const tree = findReadingTree(proof.tree, pair?.fresh), image = pair?.body;
        const wrapper = pair?.wrapper, control = pair?.control;
        if (!tree || tree.tag !== 'IMG' || images.has(pair.fresh) ||
            !(image instanceof Element) || image.tagName !== 'IMG' || !body.contains(image) ||
            !(wrapper instanceof Element) || wrapper.tagName !== 'DIV' || !body.contains(wrapper) ||
            usedWrappers.has(wrapper) || image.parentElement !== wrapper ||
            !(control instanceof Element) || control.tagName !== 'BUTTON' ||
            usedControls.has(control) || control.parentElement !== wrapper ||
            wrapper.childNodes.length !== 2 || wrapper.childNodes[0] !== image || wrapper.childNodes[1] !== control ||
            JSON.stringify([...wrapper.attributes].map(attr => [attr.name, attr.value]).sort()) !== pair.attributes ||
            typeof pair.controlMarkup !== 'string' || control.outerHTML !== pair.controlMarkup) {
          return readingFailure('unsupported', 'unverified-image-container');
        }
        images.set(pair.fresh, image);
        wrappers.set(wrapper, image); usedWrappers.add(wrapper);
        controls.add(control); usedControls.add(control);
        imageControls.set(control, pair.controlMarkup);
      }
      const authoredAttributes = new Map();
      for (const change of association.attributes || []) {
        if (!(change?.body instanceof Element) || !body.contains(change.body) ||
            !['id', 'class', 'style', 'tabindex'].includes(change.name) ||
            (change.value !== null && typeof change.value !== 'string') ||
            change.body.getAttribute(change.name) !== change.value) {
          return readingFailure('unsupported', 'unverified-producer-attribute');
        }
        let attributes = authoredAttributes.get(change.body);
        if (!attributes) authoredAttributes.set(change.body, attributes = new Set());
        if (attributes.has(change.name)) return readingFailure('unsupported', 'duplicate-producer-attribute');
        attributes.add(change.name);
      }
      for (const pseudo of association.pseudos || []) {
        if (!(pseudo?.body instanceof Element) || !body.contains(pseudo.body) ||
            !/^H[1-6]$/.test(pseudo.body.tagName) || pseudo.name !== '::before' ||
            getComputedStyle(pseudo.body, pseudo.name).content !== pseudo.content) {
          return readingFailure('unsupported', 'unverified-producer-pseudo');
        }
        pseudos.set(pseudo.body, pseudo.content);
      }
      for (const pair of association.owners) {
        const bound = proof.bindings.find(entry => entry.node === pair?.fresh);
        const descriptor = bound?.descriptor, target = pair?.body;
        if (!descriptor || (!descriptor.readingCode && !descriptor.readingTable) ||
            ownerPairs.has(pair.fresh) || !(target instanceof Element) || !body.contains(target) ||
            !Array.isArray(pair.controls) || !Array.isArray(pair.decorations)) {
          return readingFailure('unsupported', 'unverified-owner-association');
        }
        ownerPairs.set(pair.fresh, pair);
        for (const control of pair.controls) {
          if (!(control instanceof Element) ||
              (control.tagName !== 'BUTTON' && !(pair.overlay === control && control.tagName === 'DIV' &&
                textNodes(control).text === '')) || usedControls.has(control) ||
              (control.parentElement !== target && control.parentElement !== pair.wrapper)) {
            return readingFailure('unsupported', 'unverified-generated-control');
          }
          controls.add(control); usedControls.add(control);
        }
        if (pair.wrapper !== null) {
          const wrapper = pair.wrapper;
          if (!(wrapper instanceof Element) || !wrapper.isConnected || !preview.contains(wrapper) ||
              target.parentElement !== wrapper || usedWrappers.has(wrapper) || wrapper === body ||
              [...wrapper.childNodes].some(node => node !== target && !controls.has(node) &&
                (node.nodeType !== Node.TEXT_NODE || /\S/.test(node.data)))) {
            return readingFailure('unsupported', 'unverified-generated-container');
          }
          usedWrappers.add(wrapper);
          wrappers.set(wrapper, target);
          owners.push({ element: wrapper, start: descriptor.start, end: descriptor.end,
            kind: descriptor.kind, tag: wrapper.tagName, role: 'scroller' });
        }
        if (pair.breakout !== undefined && pair.breakout !== null) {
          if (!descriptor.readingTable || pair.breakout !== pair.wrapper) {
            return readingFailure('unsupported', 'unverified-table-breakout');
          }
          translatedTables.add(pair.wrapper);
        }
        if (descriptor.readingCode) {
          const code = pair.code, decorations = new Set(pair.decorations);
          if (!(code instanceof Element) || code.tagName !== 'CODE' || code.parentElement !== target ||
              textNodes(code).text !== descriptor.readingCode.display || decorations.size !== pair.decorations.length ||
              [...code.querySelectorAll('*')].some(node => !readingHighlight(node) &&
                (node.tagName !== 'SPAN' || !decorations.has(node))) ||
              [...decorations].some(node => node.tagName !== 'SPAN' || !code.contains(node))) {
            return readingFailure('unsupported', 'unverified-final-code');
          }
          const originalCode = proof.tree.node === bound.node ? proof.tree.children.find(child => typeof child !== 'string' && child.tag === 'CODE') :
            findReadingTree(proof.tree, bound.node)?.children.find(child => typeof child !== 'string' && child.tag === 'CODE');
          if (!originalCode) return readingFailure('unsupported', 'unverified-code-source-body');
          codeBodies.set(originalCode.node, { code, display: descriptor.readingCode.display });
        } else {
          if (pair.decorations.length || pair.code !== null) return readingFailure('unsupported', 'unverified-table-decoration');
          tableBodies.add(target);
          if (pair.header !== undefined && pair.header !== null) {
            if (pair.header.tagName !== 'THEAD' || pair.header.parentElement !== target) {
              return readingFailure('unsupported', 'unverified-dynamic-table-header');
            }
            translatedHeaders.add(pair.header);
          }
        }
      }
      const parts = element => {
        const children = [];
        const append = node => {
          if (controls.has(node)) return;
          if (wrappers.has(node)) append(wrappers.get(node));
          else if (node.nodeType === Node.TEXT_NODE) {
            if (typeof children.at(-1) === 'string') children[children.length - 1] += node.data;
            else children.push(node.data);
          } else if (node.nodeType === Node.ELEMENT_NODE && readingHighlight(node)) {
            for (const child of node.childNodes) append(child);
          } else children.push(node);
        };
        for (const child of element.childNodes) append(child);
        return children;
      };
      const match = (tree, element) => {
        if (!(element instanceof Element) || tree.tag !== element.tagName) return false;
        if (sections.has(tree.node) && sections.get(tree.node) !== element) return false;
        if (images.has(tree.node) && images.get(tree.node) !== element) return false;
        targets.set(tree.node, element);
        const code = codeBodies.get(tree.node);
        if (code) return element === code.code && textNodes(element).text === code.display;
        const paired = ownerPairs.get(tree.node);
        if (paired && paired.body !== element) return false;
        const attributes = [...element.attributes].map(attr => [attr.name, attr.value]).sort();
        // Renderer table sizing changes classes. Text/structure, not a class, proves the source association.
        const styled = paired || (/^(?:THEAD|TBODY|TFOOT|TR|TH|TD)$/.test(element.tagName) &&
          [...tableBodies].some(table => table.contains(element)));
        const changes = authoredAttributes.get(element);
        const keep = ([name]) => !(styled && name === 'class') && !changes?.has(name);
        const expectedAttributes = tree.attributes.filter(keep);
        const expectedAttributeValue = JSON.stringify(expectedAttributes);
        const actualAttributes = attributes.filter(keep);
        const actualAttributeValue = JSON.stringify(actualAttributes);
        if (expectedAttributeValue !== actualAttributeValue) {
          if (observation && observedAttempt && observation.active && observation.admission === observedAdmission &&
              observation.attemptAdmission === observedAdmission &&
              observation.attempt === observedAttempt && observation.bindingOp === observedAttempt) {
            if (expectedAttributeValue.length + actualAttributeValue.length > 2048) {
              observation.attrFailure = 'over-bound';
              observation.diagnosticInvalid = true;
            } else {
              const expectedStyle = expectedAttributes.find(([name]) => name === 'style');
              const expectedStyleValue = JSON.stringify(expectedStyle);
              const actualStyle = actualAttributes.find(([name]) => name === 'style');
              const other = pairs => JSON.stringify(pairs.filter(([name]) => name !== 'style'));
              const styleDiffers = expectedStyleValue !== JSON.stringify(actualStyle);
              observation.attrFailure = styleDiffers
                ? (other(expectedAttributes) !== other(actualAttributes) ? 'style-and-other' : 'style')
                : 'other';
              if (styleDiffers) {
                const tag = tree.tag;
                const category = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'LI',
                  'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'SPAN', 'A'].includes(tag)
                  ? tag : 'OTHER';
                const state = pair => !pair ? 'absent' : pair[1] === '' ? 'empty' : 'nonempty';
                // "mapped" records identity inequality, not reuse or association history.
                observation.attrPair = `${category}_${tree.node === element ? 'same' : 'mapped'}_${state(expectedStyle)}_${state(actualStyle)}`;
                if (tree.tag === 'TABLE') projectReadingMeasurement(element, observation, observedAdmission, observedAttempt);
              }
            }
          }
          return false;
        }
        const expected = [];
        for (const child of tree.children) {
          if (typeof child === 'string' && typeof expected.at(-1) === 'string') expected[expected.length - 1] += child;
          else expected.push(child);
        }
        const actual = parts(element);
        return expected.length === actual.length && expected.every((child, index) =>
          typeof child === 'string' ? child === actual[index] : match(child, actual[index]));
      };
      if (!match(proof.tree, body) || textNodes(body).text !== proof.specs.text ||
          proof.bindings.some(({ node, descriptor }) => (descriptor.readingCode || descriptor.readingTable) && !ownerPairs.has(node))) {
        return readingFailure('unsupported', 'final-body-does-not-match-source');
      }
      for (const { node, descriptor } of proof.bindings) {
        const target = targets.get(node);
        if (target && descriptor.view && descriptor.end > descriptor.start && descriptor.view.exact(0) &&
            descriptor.view.exact(descriptor.view.text.trimEnd().length)) {
          owners.push({ element: target, start: descriptor.start, end: descriptor.end,
            kind: descriptor.kind, tag: target.tagName, role: 'body' });
        }
      }
      groups.push({ element: body, ...proof.specs,
        shape: readingShape(body, usedControls), elements: readingElements(body, usedControls) });
    }
    if (!orderedReadingGroups(groups)) return readingFailure('unsupported', 'final-text-order');
    // A callback can replace the binding without publishing. Check both generations after the last callback.
    const finalState = readingState(source);
    if (ticket !== bindingEpoch || entered !== readingEpoch || !finalState || finalState.frozen ||
        !sameReadingContext(state.context, finalState.context) || source.selection !== finalState.selection ||
        state.key !== finalState.key) {
      return readingFailure('unavailable', 'presentation-changed');
    }
    readingFinal.set(source, { groups, owners, context: state.context, key: state.key,
      controls: usedControls, controlParents: new Map([...usedControls].map(node => [node, node.parentElement])),
      imageControls,
      pseudos, translatedHeaders, translatedTables,
      shape: readingShape(preview, usedControls), elements: readingElements(preview, usedControls) });
    return Object.freeze({ status: 'bound' });
  }
  function findReadingTree(tree, node) {
    if (typeof tree === 'string') return null;
    if (tree.node === node) return tree;
    for (const child of tree.children) {
      const found = findReadingTree(child, node);
      if (found) return found;
    }
    return null;
  }
  function orderedReadingGroups(groups) {
    const nodes = textNodes(preview).nodes, positions = new Map(nodes.map((entry, index) => [entry.node, index]));
    let previousNode = -1, previousSource = -1;
    for (const group of groups) {
      const content = textNodes(group.element), first = positions.get(content.nodes[0]?.node);
      if (first === undefined || first <= previousNode) return false;
      previousNode = positions.get(content.nodes[content.nodes.length - 1].node);
      let end = 0;
      for (const run of group.runs) {
        if (!Number.isSafeInteger(run.from) || run.from < end || !run.display.length ||
            content.text.slice(run.from, run.from + run.display.length) !== run.display ||
            run.view.text !== run.display || run.view.at(0) < previousSource) return false;
        end = run.from + run.display.length;
        previousSource = run.view.at(run.display.length);
      }
    }
    return true;
  }
  function publishTextSource(source, context) {
    if (source !== null && !(source instanceof Source)) return readingFailure('unavailable', 'presentation-unbound');
    const entered = readingEpoch, enteredBinding = bindingEpoch, state = readingState(source);
    if (!state || !sameReadingContext(context, state.context) || entered !== readingEpoch || enteredBinding !== bindingEpoch) {
      return readingFailure('unavailable', 'presentation-unbound');
    }
    if (source === null) {
      readingEpoch++;
      publishedText = null;
      return readingFailure('retired', 'explicit-retirement');
    }
    if (source.selection !== state.selection || !preview.isConnected || state.frozen) {
      return readingFailure('unavailable', 'presentation-unbound');
    }
    const epoch = ++readingEpoch;
    publishedText = null;
    const final = readingFinal.get(source);
    if (final && (!sameReadingContext(final.context, state.context) || final.key !== state.key)) return readingFailure('unavailable', 'stale-final-binding');
    if (final && (readingShape(preview, final.controls) !== final.shape ||
        !sameReadingElements(final.elements, preview, final.controls) ||
        [...final.imageControls].some(([node, markup]) => node.outerHTML !== markup))) {
      return readingFailure('unsupported', 'final-presentation-changed');
    }
    if (!final && readingBodies.get(source)?.some(proof => proof.bindings.some(({ descriptor }) =>
      descriptor.readingCode || descriptor.readingTable))) return readingFailure('unsupported', 'final-binding-required');
    const groups = (final?.groups || readingAdoptions.get(source))?.map(group => ({ ...group,
      runs: group.runs.map(run => ({ ...run, view: { text: run.view.text, at: run.view.at, exact: run.view.exact } })) }));
    if (!groups?.length || groups.some(group => !group.element.isConnected ||
        !preview.contains(group.element) || readingShape(group.element, final?.controls) !== group.shape ||
        !sameReadingElements(group.elements, group.element, final?.controls) ||
        textNodes(group.element).text !== group.text) || !orderedReadingGroups(groups)) {
      return readingFailure('unsupported', 'unverified-text-publication');
    }
    const finalState = readingState(source);
    if (epoch !== readingEpoch || enteredBinding !== bindingEpoch || !finalState || finalState.frozen ||
        !sameReadingContext(state.context, finalState.context) || source.selection !== finalState.selection ||
        state.key !== finalState.key) {
      return readingFailure('unavailable', 'presentation-changed');
    }
    const owners = (final?.owners || readingOwners.get(source) || []).map(owner => ({ ...owner }));
    publishedText = { source, groups, owners, context: state.context, epoch,
      controls: final?.controls || new Set(), controlParents: final?.controlParents || new Map(),
      imageControls: final?.imageControls || new Map(),
      pseudos: final?.pseudos || new Map(), translatedHeaders: final?.translatedHeaders || new Set(),
      translatedTables: final?.translatedTables || new Set(),
      shape: readingShape(preview, final?.controls), elements: readingElements(preview, final?.controls), key: state.key };
    return Object.freeze({ status: 'published', sourceKey: publishedText.key });
  }
  function currentReadingPublication(expected) {
    const publication = publishedText, entered = readingEpoch, enteredBinding = bindingEpoch;
    if (!publication) return null;
    const state = readingState(publication.source);
    if (publication !== publishedText || entered !== readingEpoch || enteredBinding !== bindingEpoch) return null;
    if (!state || state.frozen || state.key !== publication.key ||
        publication.source.selection !== state.selection || !preview.isConnected ||
        !sameReadingContext(publication.context, state.context) ||
        readingShape(preview, publication.controls) !== publication.shape ||
        !sameReadingElements(publication.elements, preview, publication.controls) ||
        [...publication.controlParents].some(([node, parent]) => !node.isConnected || node.parentElement !== parent) ||
        [...publication.imageControls].some(([node, markup]) => node.outerHTML !== markup) ||
        publication.owners.some(owner => !owner.element.isConnected || !preview.contains(owner.element) || owner.element.tagName !== owner.tag) ||
        publication.groups.some(group => !group.element.isConnected || !preview.contains(group.element) ||
          readingShape(group.element, publication.controls) !== group.shape || textNodes(group.element).text !== group.text)) {
      if (publishedText === publication && entered === readingEpoch && enteredBinding === bindingEpoch) publishedText = null;
      return null;
    }
    return publication === publishedText && entered === readingEpoch && enteredBinding === bindingEpoch &&
      (expected === undefined || sameReadingContext(state.context, expected)) ? publication : null;
  }
  function splitsReadingScalar(text, offset) {
    return /[\uD800-\uDBFF]/.test(text[offset - 1] || '') && /[\uDC00-\uDFFF]/.test(text[offset] || '');
  }
  function readingContextText(text, start, end) {
    let before = Math.max(0, start - readingLimits.context), after = Math.min(text.length, end + readingLimits.context);
    if (splitsReadingScalar(text, before)) before++;
    if (splitsReadingScalar(text, after)) after--;
    return { before: text.slice(before, start), after: text.slice(end, after) };
  }
  function readingAtom(publication, group, run, index) {
    const view = run.view, text = publication.source.source;
    if (view.text !== run.display || index < 0 || index >= run.display.length) return null;
    let from = index, to = index + (run.display.codePointAt(index) > 0xFFFF ? 2 : 1);
    while (from > 0 && (!view.exact(from) || splitsReadingScalar(run.display, from))) from--;
    while (to < run.display.length && (!view.exact(to) || splitsReadingScalar(run.display, to))) to++;
    if (!view.exact(from) || !view.exact(to) || to - from > readingLimits.display) return null;
    const start = view.at(from), end = view.at(to);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start ||
        end > text.length || end - start > readingLimits.atom ||
        splitsReadingScalar(text, start) || splitsReadingScalar(text, end)) return null;
    return { group, run, from, to, start, end, atom: text.slice(start, end),
      display: run.display.slice(from, to), blockKind: group.element.tagName, runKind: run.kind || 'text' };
  }
  function readingRange(candidate) {
    const content = textNodes(candidate.group.element);
    if (content.text !== candidate.group.text) return null;
    const point = (position, end) => {
      for (const entry of content.nodes) {
        const stop = entry.start + entry.node.length;
        if (position >= entry.start && (position < stop || (end && position === stop))) {
          return { node: entry.node, offset: position - entry.start };
        }
      }
      return null;
    };
    const first = point(candidate.run.from + candidate.from, false);
    const last = point(candidate.run.from + candidate.to, true);
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset);
    return range.toString() === candidate.display ? range : null;
  }
  function readingLayout(parent, scroller, publication, cache = new Map()) {
    if (cache.has(parent)) return cache.get(parent);
    if (!(scroller instanceof Element) || !scroller.isConnected ||
        (scroller !== preview && !scroller.contains(preview)) ||
        !/^(auto|scroll)$/.test(getComputedStyle(scroller).overflowY)) return null;
    const doc = preview.ownerDocument, view = doc?.defaultView;
    if (!view || doc !== document || view.frameElement || view.visualViewport?.scale !== 1) return null;
    const clip = { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
    if (![clip.right, clip.bottom].every(value => Number.isFinite(value) && value > 0)) return null;
    const chain = [], nested = [], rounded = [];
    const ancestry = [];
    for (let node = parent; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none') {
        const hidden = { hidden: true };
        cache.set(parent, hidden);
        return hidden;
      }
      ancestry.push({ node, style });
    }
    // Computed visibility belongs to this text's parent; descendants may override an ancestor's hidden value.
    if (ancestry[0]?.style.visibility === 'hidden') {
      const hidden = { hidden: true };
      cache.set(parent, hidden);
      return hidden;
    }
    let reached = false;
    for (const { node, style } of ancestry) {
      if (node === scroller) reached = true;
      if (['IFRAME', 'SVG', 'MATH', 'CANVAS', 'SCRIPT', 'STYLE', 'TEMPLATE'].includes(node.tagName) ||
          style.display === 'contents' || !['visible', 'hidden'].includes(style.visibility) || Number(style.opacity) !== 1 ||
          (style.transform !== 'none' && !((publication?.translatedHeaders.has(node) &&
            /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*-?(?:\d+(?:\.\d+)?|\.\d+)\)$/.test(style.transform)) ||
            (publication?.translatedTables.has(node) &&
            /^matrix\(1,\s*0,\s*0,\s*1,\s*-(?:\d+(?:\.\d+)?|\.\d+),\s*0\)$/.test(style.transform)))) ||
          style.perspective !== 'none' || style.clipPath !== 'none' ||
          style.clip !== 'auto' || style.maskImage !== 'none' || /paint|strict|content/.test(style.contain) ||
          style.contentVisibility !== 'visible' || style.writingMode !== 'horizontal-tb' ||
          style.position === 'fixed' || style.position === 'sticky' ||
          ['::before', '::after'].some(pseudo => {
            const content = getComputedStyle(node, pseudo).content;
            return !['none', 'normal', '""'].includes(content) &&
              !(pseudo === '::before' && publication?.pseudos.get(node) === content);
          })) return null;
      const box = node.getBoundingClientRect();
      const zoom = scale(node);
      if (!(zoom > 0) || ![zoom, box.left, box.top, box.width, box.height, node.scrollTop, node.scrollLeft].every(Number.isFinite)) return null;
      const xClip = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
      const yClip = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      if ((!xClip && style.overflowX !== 'visible') || (!yClip && style.overflowY !== 'visible')) return null;
      const scrollsY = yClip && node.scrollHeight > node.clientHeight;
      const scrollsX = xClip && node.scrollWidth > node.clientWidth;
      const scrollableY = /^(auto|scroll)$/.test(style.overflowY);
      const scrollableX = /^(auto|scroll)$/.test(style.overflowX);
      // Rewrap can start or stop overflow without changing this source-backed owner.
      if (node !== scroller && !node.contains(scroller) && (scrollsY || scrollsX || scrollableY || scrollableX)) {
        if ((scrollsY && !/^(auto|scroll)$/.test(style.overflowY)) ||
            (scrollsX && !/^(auto|scroll)$/.test(style.overflowX))) return null;
        const owners = publication?.owners.filter(owner => owner.element === node) || [];
        if (owners.length !== 1 || nested.length >= readingLimits.nested) return null;
        const owner = owners[0];
        if (publication.owners.filter(other => other.start === owner.start && other.end === owner.end &&
            other.kind === owner.kind && other.tag === owner.tag && other.role === owner.role).length !== 1) return null;
        nested.push({ scroller: node, start: owner.start, end: owner.end, kind: owner.kind, tag: owner.tag, role: owner.role });
      }
      if (xClip || yClip) {
        const borders = [style.borderLeftWidth, style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth]
          .map(value => typeof value === 'string' && /^\d+(?:\.\d+)?px$/.test(value) ? parseFloat(value) * zoom : NaN);
        if (!borders.every(Number.isFinite)) return null;
        const radii = [style.borderTopLeftRadius, style.borderTopRightRadius,
          style.borderBottomRightRadius, style.borderBottomLeftRadius].map(value => {
          const parts = value.trim().split(/\s+/);
          if (parts.length > 2 || parts.some(part => !/^(?:\d+(?:\.\d+)?|\.\d+)(?:px|%)?$/.test(part))) return null;
          return [parts[0], parts[1] || parts[0]].map((part, axis) =>
            parseFloat(part) * (part.endsWith('%') ? (axis ? box.height : box.width) / 100 : zoom));
        });
        if (radii.some(value => value === null)) return null;
        const factor = Math.min(1, box.width / Math.max(1, radii[0][0] + radii[1][0]),
          box.width / Math.max(1, radii[3][0] + radii[2][0]),
          box.height / Math.max(1, radii[0][1] + radii[3][1]),
          box.height / Math.max(1, radii[1][1] + radii[2][1]));
        radii.forEach(([x, y], index) => {
          const left = index === 0 || index === 3, top = index < 2;
          const borderX = borders[left ? 0 : 2], borderY = borders[top ? 1 : 3];
          const rx = Math.max(0, x * factor - borderX), ry = Math.max(0, y * factor - borderY);
          if (rx && ry) rounded.push({ x: left ? box.left + borderX + rx : box.right - borderX - rx,
            y: top ? box.top + borderY + ry : box.bottom - borderY - ry,
            rx, ry, left, top });
        });
      }
      if (xClip) {
        clip.left = Math.max(clip.left, box.left + node.clientLeft * zoom);
        clip.right = Math.min(clip.right, box.left + (node.clientLeft + node.clientWidth) * zoom);
      }
      if (yClip) {
        clip.top = Math.max(clip.top, box.top + node.clientTop * zoom);
        clip.bottom = Math.min(clip.bottom, box.top + (node.clientTop + node.clientHeight) * zoom);
      }
      chain.push([node, node.scrollTop, node.scrollLeft, box.left, box.top, box.width, box.height, zoom,
        node.clientWidth, node.clientHeight, node.scrollWidth, node.scrollHeight, node.clientLeft, node.clientTop]);
    }
    if (!reached) return null;
    const layout = { clip, chain, nested, rounded };
    cache.set(parent, layout);
    return layout;
  }
  function readingRects(range) {
    const rects = [...range.getClientRects()];
    return rects.some(rect => ![rect.left, rect.right, rect.top, rect.bottom].every(Number.isFinite)) ? null :
      rects.filter(rect => rect.right > rect.left && rect.bottom > rect.top);
  }
  function readingIntersects(rect, clip, vertical = true) {
    return clip.right > clip.left && rect.left < clip.right && rect.right > clip.left &&
      (!vertical || (clip.bottom > clip.top && rect.top < clip.bottom && rect.bottom > clip.top));
  }
  function readingGeometry(range, scroller, requireVisible, publication, candidate, failure = null) {
    const refuse = (stage, details = null) => {
      if (failure) Object.assign(failure, { stage }, details);
      return null;
    };
    if (range.startContainer.parentElement !== range.endContainer.parentElement) return refuse('endpoint-parents');
    const layout = readingLayout(range.startContainer.parentElement, scroller, publication);
    if (!layout || layout.hidden) {
      refuse(layout ? 'hidden-layout' : 'unverifiable-layout');
      return layout;
    }
    const rects = readingRects(range);
    if (!rects) return refuse('nonfinite-fragments');
    // A transformed atom can span lines without an exact interior source boundary.
    // Do not choose one fragment by rectangle order.
    if (rects.length > 1) return refuse('multiple-fragments', { rectCount: rects.length });
    const fragment = rects[0];
    if (!fragment) {
      refuse('no-fragments', { rectCount: 0 });
      return { hidden: true };
    }
    const bounds = () => ({ rectCount: rects.length,
      fragment: Object.freeze({ left: fragment.left, right: fragment.right, top: fragment.top, bottom: fragment.bottom }),
      clip: Object.freeze({ ...layout.clip }) });
    if (requireVisible && !readingIntersects(fragment, layout.clip)) {
      refuse('outside-clip', failure ? bounds() : null);
      return { hidden: true };
    }
    // Text inside the padding clears the real corner arcs; clipped corner text
    // is refused rather than treated as if the rounded clip were rectangular.
    const clippedCorner = readingIntersects(fragment, layout.clip) && layout.rounded.find(corner => [fragment.left, fragment.right].some(x =>
      [fragment.top, fragment.bottom].some(y => (corner.left ? x < corner.x : x > corner.x) &&
        (corner.top ? y < corner.y : y > corner.y) &&
        ((x - corner.x) / corner.rx) ** 2 + ((y - corner.y) / corner.ry) ** 2 > 1)));
    if (clippedCorner) return refuse('rounded-corner', failure
      ? { ...bounds(), corner: Object.freeze({ ...clippedCorner }) } : null);
    if (layout.nested.some(owner => owner.start > candidate.start || owner.end < candidate.end)) {
      return refuse('outside-owner', { nestedCount: layout.nested.length });
    }
    const localTop = element => {
      const row = layout.chain.find(row => row[0] === element);
      return (fragment.top - row[4]) / row[7] - element.clientTop;
    };
    return { ...layout, fragment, nested: layout.nested.map(entry => ({ ...entry, top: localTop(entry.scroller) })),
      top: localTop(scroller) };
  }
  function firstVisibleReadingOffset(node, clip) {
    const range = document.createRange();
    const find = (from, to) => {
      range.setStart(node, from); range.setEnd(node, to);
      const rects = readingRects(range);
      if (!rects) return { unsupported: true };
      if (!rects.some(rect => readingIntersects(rect, clip))) return null;
      const width = node.data.codePointAt(from) > 0xFFFF ? 2 : 1;
      if (to - from === width) return { index: from };
      let middle = (from + to) >>> 1;
      if (splitsReadingScalar(node.data, middle)) middle--;
      if (middle <= from) middle = from + width;
      if (middle >= to) return { unsupported: true };
      return find(from, middle) || find(middle, to);
    };
    return find(0, node.length);
  }
  function readingReceipt(publication, candidate, range, scroller, geometry, alignment) {
    const nested = Object.freeze(geometry.nested.map((entry, index) =>
      Object.freeze({ scroller: entry.scroller, top: alignment.nested[index].top })));
    const receipt = Object.freeze({ range, scroller, alignment, nested });
    readingReceipts.set(receipt, { epoch: publication.epoch, candidate: {
      start: candidate.start, end: candidate.end, atom: candidate.atom, display: candidate.display,
      blockKind: candidate.blockKind, runKind: candidate.runKind,
    }, geometry });
    return receipt;
  }
  function captureVisibleText(scroller) {
    lastReadingCaptureFailure = null;
    const entered = readingEpoch, enteredBinding = bindingEpoch;
    const publication = currentReadingPublication();
    if (!publication) return readingFailure('unavailable', 'presentation-unbound-or-stale');
    const groups = new Map(publication.groups.map(group => [group.element, group])), contents = new Map(), layouts = new Map();
    for (const { node } of textNodes(preview).nodes) {
      const layout = readingLayout(node.parentElement, scroller, publication, layouts);
      if (!layout) return readingFailure('unsupported', 'unverifiable-clipping-chain');
      if (layout.hidden) continue;
      const visible = firstVisibleReadingOffset(node, layout.clip);
      if (!visible) continue;
      if (visible.unsupported) return readingFailure('unsupported', 'unverifiable-text-fragments');
      let element = node.parentElement;
      while (element && element !== preview && !groups.has(element)) element = element.parentElement;
      const group = groups.get(element);
      if (group && !contents.has(group)) contents.set(group, textNodes(group.element));
      const content = contents.get(group);
      const base = content?.nodes.find(entry => entry.node === node)?.start;
      const position = base + visible.index;
      const run = group?.runs.find(run => position >= run.from && position < run.from + run.display.length);
      const candidate = run && readingAtom(publication, group, run, position - run.from);
      if (!candidate) return readingFailure('unsupported', 'visible-text-without-exact-bounded-provenance');
      const failure = { stage: 'range-reconstruction', blockKind: candidate.blockKind, runKind: candidate.runKind };
      const range = readingRange(candidate), geometry = range && readingGeometry(range, scroller, true, publication, candidate, failure);
      if (!geometry || geometry.hidden) {
        lastReadingCaptureFailure = Object.freeze(failure);
        return readingFailure('unsupported', 'unverifiable-atom-fragment');
      }
      if (currentReadingPublication() !== publication || entered !== readingEpoch || enteredBinding !== bindingEpoch) {
        return readingFailure('unavailable', 'presentation-changed');
      }
      const alignment = Object.freeze({ top: geometry.top,
        nested: Object.freeze(geometry.nested.map(({ start, end, kind, tag, role, top }) => Object.freeze({ start, end, kind, tag, role, top }))) });
      const value = Object.freeze({ version: 1, sourceKey: publication.key, start: candidate.start, end: candidate.end,
        atom: candidate.atom, display: candidate.display, ...readingContextText(publication.source.source, candidate.start, candidate.end),
        blockKind: candidate.blockKind, runKind: candidate.runKind, alignment });
      return Object.freeze({ status: 'captured', value,
        receipt: readingReceipt(publication, candidate, range, scroller, geometry, alignment) });
    }
    return readingFailure('missing', 'no-visible-text');
  }
  function validReadingValue(value) {
    const keys = (value, names) => value && typeof value === 'object' &&
      Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
    return keys(value, ['version', 'sourceKey', 'start', 'end', 'atom', 'display', 'before', 'after', 'blockKind', 'runKind', 'alignment']) &&
      value.version === 1 && typeof value.sourceKey === 'string' && value.sourceKey.length > 0 && value.sourceKey.length <= 128 &&
      Number.isSafeInteger(value.start) && value.start >= 0 && Number.isSafeInteger(value.end) && value.end > value.start &&
      typeof value.atom === 'string' && value.atom.length === value.end - value.start && value.atom.length <= readingLimits.atom &&
      typeof value.display === 'string' && value.display.length > 0 && value.display.length <= readingLimits.display &&
      typeof value.before === 'string' && value.before.length <= readingLimits.context &&
      typeof value.after === 'string' && value.after.length <= readingLimits.context &&
      typeof value.blockKind === 'string' && /^[A-Z0-9]{1,16}$/.test(value.blockKind) && ['text', 'code', 'table'].includes(value.runKind) &&
      keys(value.alignment, ['top', 'nested']) && Number.isFinite(value.alignment.top) && Array.isArray(value.alignment.nested) &&
      value.alignment.nested.length <= readingLimits.nested && Array.from(value.alignment.nested).every(entry =>
        keys(entry, ['start', 'end', 'kind', 'tag', 'role', 'top']) &&
        Number.isSafeInteger(entry.start) && entry.start >= 0 && Number.isSafeInteger(entry.end) && entry.end > entry.start &&
        typeof entry.kind === 'string' && /^[a-z_]{1,16}$/.test(entry.kind) &&
        typeof entry.tag === 'string' && /^[A-Z0-9]{1,16}$/.test(entry.tag) && ['body', 'scroller'].includes(entry.role) && Number.isFinite(entry.top));
  }
  function readingCandidates(publication, saved, contextOnly = false) {
    const matches = [];
    for (const group of publication.groups) {
      if (group.element.tagName !== saved.blockKind) continue;
      for (const run of group.runs) for (let index = 0; index < run.display.length;) {
        const candidate = readingAtom(publication, group, run, index);
        index = candidate ? candidate.to : index + (run.display.codePointAt(index) > 0xFFFF ? 2 : 1);
        if (!candidate || candidate.atom !== saved.atom || candidate.display !== saved.display || candidate.runKind !== saved.runKind) continue;
        if (!contextOnly && publication.key === saved.sourceKey) {
          if (candidate.start !== saved.start || candidate.end !== saved.end) continue;
        } else {
          const context = readingContextText(publication.source.source, candidate.start, candidate.end);
          // A short context can reach the old document edge. Preserve its
          // surviving suffix/prefix, then still require uniqueness and the full owner chain.
          const beforeBoundary = saved.before.length < readingLimits.context && saved.before.length === saved.start;
          const beforeMatches = beforeBoundary ? context.before.endsWith(saved.before) : context.before === saved.before;
          const afterMatches = saved.after.length < readingLimits.context
            ? context.after.startsWith(saved.after) : context.after === saved.after;
          if (!beforeMatches || !afterMatches) continue;
        }
        matches.push(candidate);
        if (matches.length > 1) return matches;
      }
    }
    return matches;
  }
  function prepareModeTextCorrespondence(saved, source, key, context) {
    if (!validReadingValue(saved) || !(source instanceof Source) ||
        typeof key !== 'string' || !key.length || key.length > 128) {
      return readingFailure('unsupported', 'invalid-mode-source-pair');
    }
    const entered = readingEpoch, enteredBinding = bindingEpoch;
    const publication = currentReadingPublication(context);
    if (!publication || publication.key !== saved.sourceKey ||
        source.selection !== publication.source.selection) return readingFailure('unavailable', 'mode-origin-stale');
    const candidates = readingCandidates(publication, saved, true);
    if (candidates.length !== 1 || candidates[0].start !== saved.start || candidates[0].end !== saved.end) {
      return readingFailure('unsupported', 'mode-origin-context-not-unique');
    }
    const before = publication.source.source, after = source.source;
    if (before.length === after.length || key === publication.key) return readingFailure('unsupported', 'not-pure-source-indel');
    const insertion = after.length > before.length;
    const shorter = insertion ? before : after, longer = insertion ? after : before;
    const length = longer.length - shorter.length;
    let prefix = 0, suffix = 0;
    while (prefix < shorter.length && shorter[prefix] === longer[prefix]) prefix++;
    while (suffix < shorter.length && shorter[shorter.length - suffix - 1] === longer[longer.length - suffix - 1]) suffix++;
    const first = shorter.length - suffix, lastEnd = prefix + (insertion ? 0 : length);
    if (first > prefix || lastEnd >= saved.start - saved.before.length ||
        saved.alignment.nested.some(owner => [owner.start, owner.end].some(boundary =>
          boundary >= first && boundary <= lastEnd))) {
      return readingFailure('unsupported', 'mode-indel-touches-protected-context-or-owner');
    }
    if (currentReadingPublication(context) !== publication || entered !== readingEpoch || enteredBinding !== bindingEpoch) {
      return readingFailure('unavailable', 'presentation-changed');
    }
    return Object.freeze({ status: 'prepared', correspondence: Object.freeze({
      fromKey: publication.key, toKey: key, at: first,
      oldEnd: first + (insertion ? 0 : length), newEnd: first + (insertion ? length : 0),
    }) });
  }
  function mappedReadingBoundary(mapping, boundary) {
    return boundary < mapping.at ? boundary :
      boundary > mapping.oldEnd ? boundary + mapping.newEnd - mapping.oldEnd : null;
  }
  function validModeCorrespondence(mapping, saved, publication) {
    return mapping && Object.keys(mapping).length === 5 &&
      ['fromKey', 'toKey', 'at', 'oldEnd', 'newEnd'].every(key => Object.hasOwn(mapping, key)) &&
      mapping.fromKey === saved.sourceKey && mapping.toKey === publication.key &&
      [mapping.at, mapping.oldEnd, mapping.newEnd].every(value => Number.isSafeInteger(value) && value >= 0) &&
      ((mapping.oldEnd === mapping.at && mapping.newEnd > mapping.at) ||
       (mapping.newEnd === mapping.at && mapping.oldEnd > mapping.at)) &&
      mapping.newEnd <= publication.source.source.length &&
      mapping.oldEnd < saved.start - saved.before.length &&
      saved.alignment.nested.every(owner => [owner.start, owner.end].every(boundary =>
        mappedReadingBoundary(mapping, boundary) !== null));
  }
  function resolveVisibleText(saved, scroller, context, correspondence = null) {
    if (!validReadingValue(saved)) return readingFailure('unsupported', 'invalid-bounded-value');
    const entered = readingEpoch, enteredBinding = bindingEpoch;
    const publication = currentReadingPublication(context);
    if (!publication) return readingFailure('unavailable', 'presentation-unbound-or-stale');
    if (correspondence && !validModeCorrespondence(correspondence, saved, publication)) {
      return readingFailure('unsupported', 'invalid-mode-correspondence');
    }
    const candidates = readingCandidates(publication, saved);
    if (candidates.length !== 1) return readingFailure(candidates.length ? 'ambiguous' : 'missing', 'verified-text-match');
    const candidate = candidates[0], range = readingRange(candidate);
    if (correspondence && (candidate.start !== mappedReadingBoundary(correspondence, saved.start) ||
        candidate.end !== mappedReadingBoundary(correspondence, saved.end))) {
      return readingFailure('unsupported', 'mode-candidate-interval-changed');
    }
    const geometry = range && readingGeometry(range, scroller, false, publication, candidate);
    if (!geometry || geometry.hidden) return readingFailure('unsupported', 'unverifiable-target-geometry');
    const shift = saved.sourceKey === publication.key ? 0 : candidate.start - saved.start;
    if (geometry.nested.length !== saved.alignment.nested.length || geometry.nested.some((entry, index) => {
      const previous = saved.alignment.nested[index];
      const start = correspondence ? mappedReadingBoundary(correspondence, previous.start) : previous.start + shift;
      const end = correspondence ? mappedReadingBoundary(correspondence, previous.end) : previous.end + shift;
      return entry.start !== start || entry.end !== end ||
        ['kind', 'tag', 'role'].some(key => entry[key] !== previous[key]);
    })) {
      return readingFailure('unsupported', 'nested-owner-chain-changed');
    }
    if (currentReadingPublication(context) !== publication || entered !== readingEpoch || enteredBinding !== bindingEpoch) {
      return readingFailure('unavailable', 'presentation-changed');
    }
    const alignment = Object.freeze({ top: saved.alignment.top,
      nested: Object.freeze(saved.alignment.nested.map(entry => Object.freeze({ start: entry.start, end: entry.end,
        kind: entry.kind, tag: entry.tag, role: entry.role, top: entry.top }))) });
    return Object.freeze({ status: 'resolved', receipt: readingReceipt(publication, candidate, range, scroller, geometry, alignment) });
  }
  function isTextLocationCurrent(receipt) {
    const entered = readingEpoch, enteredBinding = bindingEpoch;
    const sealed = readingReceipts.get(receipt), publication = currentReadingPublication();
    if (!sealed || !publication || sealed.epoch !== publication.epoch) return false;
    const saved = { ...sealed.candidate, sourceKey: publication.key };
    const candidates = readingCandidates(publication, saved);
    if (candidates.length !== 1) return false;
    const range = readingRange(candidates[0]), original = receipt.range;
    if (!range || range.startContainer !== original.startContainer || range.startOffset !== original.startOffset ||
        range.endContainer !== original.endContainer || range.endOffset !== original.endOffset) return false;
    const geometry = readingGeometry(range, receipt.scroller, false, publication, candidates[0]), previous = sealed.geometry;
    return !!geometry && !geometry.hidden &&
      geometry.nested.length === previous.nested.length && geometry.nested.every((entry, index) =>
        ['scroller', 'start', 'end', 'kind', 'tag', 'role'].every(key => entry[key] === previous.nested[index][key])) &&
      ['left', 'right', 'top', 'bottom'].every(key => geometry.fragment[key] === previous.fragment[key] && geometry.clip[key] === previous.clip[key]) &&
      geometry.chain.length === previous.chain.length && geometry.chain.every((row, i) =>
        row.every((part, j) => part === previous.chain[i][j])) && currentReadingPublication() === publication &&
      entered === readingEpoch && enteredBinding === bindingEpoch;
  }
  function sealTextSource(source) {
    if (source !== committed || source.selection !== identity() || source.source !== editor.value) return false;
    const groups = [];
    for (const group of source.editableText) {
      if (!group.element.isConnected || !preview.contains(group.element) ||
          textNodes(group.element).text !== group.text) continue;
      const receipt = Object.freeze({ ...group, tag: group.element.tagName,
        presented: group.element.innerHTML,
        runs: Object.freeze(group.runs.map(run => Object.freeze({ ...run }))),
        owners: Object.freeze(source.captureOwners.filter(owner => owner.block === group.element).map(owner =>
          Object.freeze({ start: owner.start, end: owner.end, body: Object.freeze({ ...owner.captureBody }),
            element: owner.element }))) });
      textReceipts.set(group.element, receipt);
      groups.push(receipt);
    }
    sourceTextReceipts.set(source, Object.freeze({ groups: Object.freeze(groups),
      gaps: Object.freeze(source.captureGaps.map(gap => Object.freeze({ ...gap }))) }));
    return true;
  }
  function normalizedRangeBoundary(node, offset, end) {
    while (node !== preview) {
      const length = node.nodeType === Node.TEXT_NODE ? node.length :
        node.nodeType === Node.ELEMENT_NODE ? node.childNodes.length : 0;
      if (!length || (offset !== 0 && offset !== length)) break;
      const parent = node.parentNode;
      if (!parent || (parent !== preview && !preview.contains(parent))) break;
      const after = offset === length && (offset !== 0 || end);
      offset = [...parent.childNodes].indexOf(node) + (after ? 1 : 0);
      node = parent;
    }
    return { node, offset };
  }
  function captureTextRange(range) {
    if (!usable() || committed.source !== editor.value || !range || range.collapsed ||
        !preview.isConnected || !preview.contains(range.startContainer) ||
        !preview.contains(range.endContainer)) return null;
    const sealed = sourceTextReceipts.get(committed);
    if (!sealed) return null;
    const selected = [], used = new Set(), coverage = [];
    const groups = new Map(sealed.groups.map(group => [group.element, group])), content = new Map();
    const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
    for (const { node } of textNodes(root).nodes) {
      if (range.comparePoint(node, node.length) < 0 || range.comparePoint(node, 0) > 0) continue;
      const from = range.startContainer === node ? range.startOffset : 0;
      const to = range.endContainer === node ? range.endOffset : node.length;
      if (from >= to) continue;
      let container = node.parentNode;
      while (container !== preview && !groups.has(container)) container = container.parentNode;
      const group = groups.get(container);
      if (!group) {
        if (/\S/.test(node.data.slice(from, to))) return null;
        continue;
      }
      if (!used.has(group)) {
        const found = textNodes(group.element);
        content.set(group, { ...found, positions: new Map(found.nodes.map(entry => [entry.node, entry.start])) });
        if (group.element.tagName !== group.tag || group.element.innerHTML !== group.presented ||
            content.get(group).text !== group.text) return null;
        used.add(group);
      }
      const offset = content.get(group).positions.get(node);
      if (offset === undefined) return null;
      let cursor = offset + from;
      const stop = offset + to;
      for (const run of group.runs) {
        const start = Math.max(cursor, run.from), end = Math.min(stop, run.from + run.display.length);
        if (start >= end) continue;
        if (start > cursor && /\S/.test(group.text.slice(cursor, start))) return null;
        if (!run.view.exact(start - run.from) || !run.view.exact(end - run.from)) return null;
        const part = { start: run.view.at(start - run.from), end: run.view.at(end - run.from) };
        if (part.end <= part.start || (selected.length && part.start < selected[selected.length - 1].end)) return null;
        selected.push(part);
        cursor = end;
      }
      if (cursor < stop && /\S/.test(group.text.slice(cursor, stop))) return null;
    }
    if (!selected.length) return null;
    let start = selected[0].start, end = selected[selected.length - 1].end;
    coverage.push(...selected, ...sealed.gaps);
    const normalized = document.createRange();
    const first = normalizedRangeBoundary(range.startContainer, range.startOffset, false);
    const last = normalizedRangeBoundary(range.endContainer, range.endOffset, true);
    normalized.setStart(first.node, first.offset); normalized.setEnd(last.node, last.offset);
    const ownsNode = node => {
      if (!node.isConnected || !preview.contains(node)) return false;
      const other = document.createRange(); other.selectNode(node);
      return normalized.compareBoundaryPoints(Range.START_TO_START, other) <= 0 &&
        normalized.compareBoundaryPoints(Range.END_TO_END, other) >= 0;
    };
    const owners = [...used].flatMap(group => group.owners);
    for (const group of used) for (const owner of group.owners) {
      if (end <= owner.start || start >= owner.end) continue;
      if (!group.element.contains(owner.element)) return null;
      let matched = false;
      for (const leaf of content.get(group).nodes) {
        if (!owner.element.contains(leaf.node)) continue;
        const from = leaf.start, to = from + leaf.node.length;
        for (const run of group.runs) {
          const first = Math.max(from, run.from), last = Math.min(to, run.from + run.display.length);
          if (first >= last) continue;
          if (run.view.at(first - run.from) < owner.body.start ||
              run.view.at(last - run.from) > owner.body.end) return null;
          matched = true;
        }
      }
      if (!matched && owner.body.start !== owner.body.end) return null;
    }
    // Balance a completely selected edge owner, never a partial formatted body.
    let expanded;
    do {
      expanded = false;
      for (const owner of owners) {
        if (start >= owner.body.start && end <= owner.body.end) continue;
        if (!ownsNode(owner.element)) continue;
        if (start === owner.body.start && start > owner.start && end >= owner.end) {
          start = owner.start; expanded = true;
        }
        if (end === owner.body.end && end < owner.end && start <= owner.start) {
          end = owner.end; expanded = true;
        }
      }
    } while (expanded);
    for (const owner of owners) {
      if (end <= owner.start || start >= owner.end) continue;
      if (start >= owner.body.start && end <= owner.body.end) continue;
      if (start > owner.start || end < owner.end || !ownsNode(owner.element)) return null;
      coverage.push({ start: owner.start, end: owner.body.start }, { start: owner.body.end, end: owner.end });
    }
    const splitScalar = offset => /[\uD800-\uDBFF]/.test(committed.source[offset - 1] || '') &&
      /[\uDC00-\uDFFF]/.test(committed.source[offset] || '');
    if (splitScalar(start) || splitScalar(end)) return null;
    coverage.sort((a, b) => a.start - b.start || b.end - a.end);
    let cursor = start;
    for (const part of coverage) {
      if (part.end <= cursor) continue;
      if (part.start > cursor) break;
      cursor = part.end;
      if (cursor >= end) return Object.freeze({ start, end, source: committed.source });
    }
    return null;
  }
  function schedule() {
    if (!active() || frame) return;
    frame = requestAnimationFrame(flush);
  }
  function invalidate() {
    dirty = true;
    pendingNestedWheel = null;
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
  function sourceLineAt(clientX, clientY) {
    if (!usable() || committed.source !== editor.value || !Number.isFinite(clientX) ||
        !Number.isFinite(clientY)) return null;
    const rect = editor.getBoundingClientRect(), style = getComputedStyle(editor);
    const scaleX = rect.width / editor.offsetWidth, scaleY = rect.height / editor.offsetHeight;
    if (!(scaleX > 0) || !(scaleY > 0)) return null;
    const x = (clientX - rect.left) / scaleX - editor.clientLeft;
    const y = (clientY - rect.top) / scaleY - editor.clientTop;
    const paddingTop = parseFloat(style.paddingTop), lineHeight = parseFloat(style.lineHeight);
    if (x < parseFloat(style.paddingLeft) || x >= editor.clientWidth - parseFloat(style.paddingRight) ||
        y < paddingTop || y >= editor.clientHeight - parseFloat(style.paddingBottom) ||
        !Number.isFinite(lineHeight) || lineHeight <= 0) return null;
    const sourceY = sourceGeometry(), starts = [0];
    for (let i = 0; i < committed.source.length; i++) {
      if (committed.source[i] === '\n') starts.push(i + 1);
    }
    const contentY = y + editor.scrollTop;
    let low = 0, high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sourceY(starts[middle]) <= contentY) low = middle + 1;
      else high = middle;
    }
    if (!low || contentY >= sourceY(committed.source.length) + lineHeight) return null;
    const index = low - 1, start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] - 1 : committed.source.length;
    return { start, end };
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
      pendingNestedWheel = null;
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
    pendingNestedWheel = null;
    if (!active() || frozen()) return;
    // A no-motion claim must not retarget a callback queued for the previous driver.
    if (owner !== side && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    owner = side;
    if (side === 'editor') {
      window.dispatchEvent(new Event('editor-scroll-intent'));
    }
  }
  function nestedScroller(target, pane) {
    let nested = null;
    for (let node = target instanceof Element ? target : target.parentElement; node && node !== pane; node = node.parentElement) {
      const max = node.scrollHeight - node.clientHeight;
      if (max <= 1) continue;
      const style = getComputedStyle(node);
      if (!/auto|scroll/.test(style.overflowY)) continue;
      if (/contain|none/.test(style.overscrollBehaviorY)) return 'contained';
      nested = 'chainable';
    }
    return nested;
  }
  for (const [side, pane] of [['editor', editor], ['preview', preview]]) {
    pane.addEventListener('wheel', event => {
      pendingNestedWheel = null;
      if (event.ctrlKey || event.metaKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
          event.defaultPrevented) return;
      const nested = nestedScroller(event.target, pane);
      if (nested) {
        // Native endpoints can differ from rounded DOM ranges. Claim only actual
        // outer travel; the deadline prevents an old wheel owning a later scroll.
        if (nested === 'chainable' && usable()) pendingNestedWheel = {
          side, direction: Math.sign(event.deltaY), top: pane.scrollTop,
          source: committed, selection: identity(), until: performance.now() + 250,
        };
        return;
      }
      claim(side);
    }, { passive: true });
    pane.addEventListener('pointerdown', event => {
      pendingNestedWheel = null;
      if (!nestedScroller(event.target, pane)) claim(side);
    }, { passive: true });
    pane.addEventListener('keydown', event => {
      pendingNestedWheel = null;
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) claim(side);
    });
    pane.addEventListener('scroll', event => {
      if (event.target !== pane) return;
      if (!usable()) { pendingNestedWheel = null; return; }
      const last = side === 'editor' ? lastEditor : lastPreview;
      if (Math.abs(pane.scrollTop - last) < .5) return; // Horizontal scrolling is independent.
      const intent = pendingNestedWheel;
      if (intent && performance.now() > intent.until) pendingNestedWheel = null;
      else if (intent?.side === side && intent.source === committed && intent.selection === identity() &&
          (pane.scrollTop - intent.top) * intent.direction > .5) claim(side);
      if (!owner) owner = side;
      if (side !== owner) return; // A follower never takes ownership from a scroll event.
      stats.scrolls++;
      schedule();
    }, { passive: true });
  }
  document.fonts?.addEventListener('loadingdone', invalidate);
  return {
    source: text => new Source(text),
    bindReadingPresentation,
    publishTextSource,
    captureVisibleText,
    prepareModeTextCorrespondence,
    resolveVisibleText,
    isTextLocationCurrent,
    start() { pendingSource = true; clearGeometry(); },
    commit(source, { textPending = false } = {}) {
      pendingNestedWheel = null;
      if (committed?.selection !== source.selection) owner = 'preview';
      committed = source;
      for (const [table, receipt] of source.editableTables) {
        tableReceipts.set(table, { ...receipt, presented: table.innerHTML });
      }
      pendingSource = false;
      sourceTextReceipts.delete(source);
      if (!textPending) sealTextSource(source);
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
      pendingNestedWheel = null;
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
    isCurrentSource(text) { return !!usable() && committed.source === text; },
    captureTextRange,
    sealTextSource,
    sourceLineAt,
    tableSource(table) {
      if (!usable() || committed.source !== editor.value || !table.isConnected ||
          !preview.contains(table)) return null;
      const receipt = committed.editableTables.get(table);
      const sealed = tableReceipts.get(table);
      return receipt && sealed?.presented === table.innerHTML
        ? { start: receipt.start, end: receipt.end } : null;
    },
    invalidate,
    diagnostics() {
      return { ready: !!usable() && anchors.length > 0, pendingGeometry: dirty || !!frame, owner, anchors: anchors.length,
        lastReadingCaptureFailure,
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
