"use strict";

(function (root, build) {
  const api = build(typeof module === 'object' && module.exports
    ? require('./table-source') : root.MarkalooTableSource);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarkalooTableMarked = api;
})(globalThis, function (source) {
  const messages = Object.freeze({
    'tableCells.missingFence': 'This code fence is not closed. Add a matching closing fence and a pipe. The unchanged source is shown below.',
    'tableCells.rawTableInvalid': 'This fenced table needs a delimiter row and matching columns. The unchanged source is shown below.',
    'tableCells.nativeBoundary': 'This fenced table crosses a Markdown block boundary. The unchanged source is shown below.',
    'tableCells.cellEnvelope': 'Keep one complete code fence in the cell. Only spaces, tabs and blank lines may sit outside it. Use a longer outer fence if a code line would close the cell.',
  });
  const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rowsOf = table => [table.header, ...table.rows];
  const rootBoundary = (text, at) => {
    if (at === 0 || at === 1 && text[0] === '\uFEFF') return true;
    if (text[at - 1] !== '\n') return false;
    let before = at - 2;
    while (before >= 0 && /[ \t\r]/.test(text[before])) before--;
    return before < 0 || text[before] === '\n' || before === 0 && text[0] === '\uFEFF';
  };

  const mayHaveRaw = text => /(?:^|\n)\uFEFF?\|[^\r\n]*(?:\r?\n[ \t]*)*`{3}/.test(text);

  function observeBlocks(parser, input) {
    const spans = [];
    let before, valid = true;
    const close = (end, tokens) => {
      if (!before || end <= before.start || before.tokens !== tokens ||
          tokens[before.count - 1] !== before.last) {
        valid = false;
        return;
      }
      let token = null, acceptedEnd = null;
      if (tokens.length === before.count + 1) {
        token = tokens.at(-1);
        acceptedEnd = end;
        if (token.raw.length !== end - before.start) valid = false;
      } else if (tokens.length !== before.count || before.last?.raw.length < before.rawLength) {
        valid = false;
      } else if (before.last?.raw.length > before.rawLength) {
        token = before.last;
      }
      // An omitted block severs ownership even if a later iteration appends
      // to the same token. Keep the initial acceptance separate from extensions.
      const last = spans.at(-1);
      if (last?.token === token && last.end === before.start) last.end = end;
      else spans.push({ start: before.start, end, token, acceptedEnd });
    };
    // Marked runs the last registered block extension first. Observe the root
    // suffix before any recognizer runs, without claiming or clipping it.
    parser.use({ extensions: [{
      name: 'markalooBlockConsumption',
      level: 'block',
      tokenizer(remaining, tokens) {
        if (tokens !== this.lexer.tokens) return;
        const start = input.length - remaining.length;
        if (before) close(start, tokens);
        else if (remaining !== input || tokens.length) valid = false;
        const last = tokens.at(-1);
        before = { start, tokens, count: tokens.length, last, rawLength: last?.raw.length };
      },
    }] });
    // A silent early exit is not evidence that the final suffix was consumed.
    const tokens = parser.lexer(input, { ...parser.defaults, silent: false });
    if (input.length) close(input.length, tokens);
    return valid ? { tokens, spans } : null;
  }

  function createTableReader(input, marked) {
    const text = input.text, space = input.space, receipts = new Map();
    let tables;
    const analyse = () => {
      if (tables) return;
      const entries = [], delimiters = new Map(), chunks = [];
      const native = nativeParser(marked), fences = new marked.Lexer(native.defaults).tokenizer;
      const normalized = text.replace(/\r\n?/g, '\n');
      let normalizedAt = text[0] === '\uFEFF' ? 1 : 0;
      let projected = 0, scannedHeader = 0, candidate = null;
      for (let at = text[0] === '\uFEFF' ? 1 : 0; at < text.length;) {
        const lf = text.indexOf('\n', at), next = lf < 0 ? text.length : lf + 1;
        const end = lf < 0 ? next : lf - (text[lf - 1] === '\r' ? 1 : 0);
        const line = text.slice(at, end);
        const fence = /^[ \t]*[`~]{3}/.test(line) &&
          fences.fences(normalized.slice(normalizedAt));
        if (fence) {
          // Use native fence ownership before looking for tables inside it.
          let end = at;
          for (let i = 0; i < fence.raw.length; i++, end++) {
            if (text[end] === '\r' && text[end + 1] === '\n') end++;
          }
          entries.push({ start: at, end, raw: false, projected });
          chunks.push(fence.raw);
          projected += fence.raw.length;
          normalizedAt += fence.raw.length;
          candidate = null;
          at = end;
          continue;
        }
        if (!line.trim()) candidate = null;
        if (rootBoundary(text, at) && at >= scannedHeader) {
          const header = source.readTableHeader(input, at);
          candidate = header?.kind === 'complete' ? header : null;
          if (candidate) {
            scannedHeader = header.next;
            const delimiter = header.value.delimiter;
            // Raw headers also allow the provider's plain one-column delimiter.
            if (header.value.header.cells.some(cell => cell.kind === 'raw') &&
                !text.slice(delimiter.span.start, delimiter.span.end).includes('|')) {
              delimiters.set(delimiter.span.start, '| ' + header.value.align.map(alignment =>
                alignment === 'center' ? ':---:' : alignment === 'left' ? ':---'
                  : alignment === 'right' ? '---:' : '---').join(' | ') + ' |');
            }
          }
        }
        let read = null;
        if (candidate && at === candidate.value.header.span.start) {
          const row = candidate.value.header;
          read = { kind: 'complete', value: row, next: row.ending.end };
        } else if (candidate && line[0] === '|') {
          // Width enables projection/protection, never native table authority.
          const body = at >= candidate.value.delimiter.ending.end;
          read = body ? source.readRow(input, at, candidate.value.header.cells.length)
            : source.readRow(input, at);
        }
        const raw = read && (read.kind === 'literal' || read.value.cells.some(cell => cell.kind === 'raw'));
        const entry = { start: at, end: raw ? read.next : next, raw: !!raw, projected };
        let value = delimiters.get(at) || line.replace(/\r/g, '\n');
        if (raw) {
          value = read.kind === 'complete' ? '| ' + read.value.cells.map(() => 'cell').join(' | ') + ' |'
            : '<!-- opaque unfinished table row -->';
        }
        const endingStart = raw && read.kind === 'complete' ? read.value.ending.start : end;
        const ending = text.slice(endingStart, entry.end).endsWith('\n') ? '\n' : '';
        value += ending;
        chunks.push(value);
        projected += value.length;
        entries.push(entry);
        normalizedAt += text.slice(at, entry.end).replace(/\r\n?/g, '\n').length;
        at = entry.end;
      }
      const trace = observeBlocks(native, chunks.join(''));
      const byProjection = new Map(entries.map((entry, index) => [entry.projected, index]));
      tables = new Map();
      if (!trace) return;
      const certified = new Set();
      for (const { start, token, acceptedEnd } of trace.spans) {
        if (token?.type !== 'table' || acceptedEnd === null) continue;
        const first = byProjection.get(start), rowCount = token.rows.length + 2;
        if (first === undefined) continue;
        const rows = entries.slice(first, first + rowCount);
        if (rows.length !== rowCount || rows.at(-1).projected >= acceptedEnd ||
            entries[first + rowCount]?.projected < acceptedEnd) continue;
        const table = { rows, byStart: new Map(rows.map((row, index) => [row.start, index])),
          end: rows[rows.length - 1].end };
        tables.set(rows[0].start, table);
        rows.forEach(row => certified.add(row));
      }
      // An uncertified replacement might have changed later native context.
      const barrier = entries.find(entry => entry.raw && !certified.has(entry))?.start ?? text.length;
      for (const [start, table] of tables) if (table.end > barrier) tables.delete(start);
    };
    const refusal = start => ({ kind: 'refusal', input, span: { start, end: text.length },
      next: text.length, diagnostic: { code: 'native-boundary', at: { start, end: text.length } } });
    return (start = 0) => {
      if (input.text !== text || input.space !== space) throw new Error('Bound table Snapshot changed');
      if (receipts.has(start)) return receipts.get(start);
      const read = source.readTable(input, start, { nativePlainBodyRun(request) {
        analyse();
        const table = tables.get(start);
        if (!table || request.input !== input) return null;
        const first = table.byStart.get(request.span.start);
        if (first === undefined || first < 2) return null;
        let rowCount = 0;
        for (let i = first; i < table.rows.length; i++) {
          const row = table.rows[i];
          if (row.start >= request.span.end) break;
          if (row.raw || row.end > request.span.end) break;
          rowCount++;
        }
        return rowCount ? { request, rowCount } : null;
      } });
      let result = read;
      if (read?.kind === 'complete') {
        analyse();
        const table = tables.get(start);
        if (!table || table.end !== read.next) {
          result = read.value.hasRaw || table?.rows.some(row => row.raw) ? refusal(start) : null;
        }
      }
      receipts.set(start, result);
      return result;
    };
  }

  function extension({ annotate, marked } = {}) {
    const roots = new WeakMap();
    const mark = (kind, span, html, token) => {
      if (!annotate) return html;
      const output = annotate(kind,
        { start: span.start - token.at, end: span.end - token.at }, html, token);
      if (typeof output !== 'string') throw new TypeError('Raw table annotation must return HTML');
      return output;
    };
    return {
      name: 'markalooRawTable',
      level: 'block',
      childTokens: ['inlineChildren'],
      tokenizer(remaining, tokens) {
        let state = roots.get(this.lexer);
        if (!state) {
          const input = { text: remaining, space: 'lexer' };
          state = { tokens, input, read: mayHaveRaw(remaining) ? createTableReader(input, marked) : null };
          roots.set(this.lexer, state);
        }
        if (state.tokens !== tokens || !state.read) return;
        const { input } = state, at = input.text.length - remaining.length;
        const start = at === 0 && remaining[0] === '\uFEFF' ? 1 : at;
        if (!rootBoundary(input.text, start)) return;
        if (at < 0 || input.text.slice(at) !== remaining) {
          throw new Error('Raw table lexer input is not an immutable suffix');
        }
        const read = state.read(start);
        if (!read || read.kind === 'complete' && !read.value.hasRaw) return;
        const token = { type: 'markalooRawTable', raw: input.text.slice(at, read.next),
          at, syntax: read, inlineCells: [] };
        if (read.kind !== 'complete') return token;
        const table = read.value;
        const cellToken = (cell, row, column) => {
          const raw = input.text.slice(cell.content.start, cell.content.end);
          const item = { type: 'markalooRawTableCell', raw,
            text: cell.kind === 'raw' ? raw : raw.replace(/\\\|/g, '|'),
            header: row === 0, align: table.align[column], syntax: cell, tokens: [] };
          if (cell.kind === 'inline') {
            item.tokens = this.lexer.inline(item.text, []);
            token.inlineCells.push(item);
          }
          return item;
        };
        const width = table.header.cells.length;
        const rows = rowsOf(table).map((row, r) => {
          const cells = row.cells.slice(0, width).map((cell, c) => cellToken(cell, r, c));
          // Native GFM pads ordinary rows; padding has no source receipt.
          while (cells.length < width) cells.push(null);
          return cells;
        });
        token.header = rows[0];
        token.rows = rows.slice(1);
        token.align = table.align;
        // Inline queues finish after block lexing; expose their actual tokens
        // only when the public walker asks for children.
        Object.defineProperty(token, 'inlineChildren', {
          enumerable: true, get: () => token.inlineCells.flatMap(cell => cell.tokens),
        });
        return token;
      },
      renderer(token) {
        const read = token.syntax, text = read.input.text;
        if (read.kind !== 'complete') {
          const warning = messages[read.kind === 'refusal' ? 'tableCells.nativeBoundary'
            : read.diagnostic.code === 'missing-fence' ? 'tableCells.missingFence' : 'tableCells.rawTableInvalid'];
          return mark('literal', read.span,
            '<div class="table-source-warning" role="note"><p>' + escape(warning) +
            '</p><pre><code>' + escape(text.slice(read.span.start, read.span.end)) +
            '</code></pre></div>\n', token);
        }
        const table = read.value;
        const cellHtml = (cell, row, column) => {
          const syntax = cell?.syntax, tag = row === 0 ? 'th' : 'td';
          let html = '';
          if (syntax?.kind === 'raw') {
            const fence = syntax.fence;
            const label = fence.label ? text.slice(fence.label.start, fence.label.end).toLowerCase() : '';
            const grammars = globalThis.Prism?.languages;
            const language = /^[\w-]+$/.test(label) && grammars &&
              Object.hasOwn(grammars, label) && grammars[label] &&
              typeof grammars[label] === 'object' ? label : null;
            const code = '<code class="table-fenced-code' + (language ? ' language-' + language : '') +
              '">' + escape(text.slice(fence.body.start, fence.body.end)) + '</code>';
            html = mark('code', fence.body,
              '<pre class="table-fenced-code-block">' + code + '</pre>', token);
          } else if (cell) html = this.parser.parseInline(cell.tokens);
          const alignment = table.align[column];
          const result = '<' + tag + (alignment ? ' align="' + alignment + '"' : '') +
            '>' + html + '</' + tag + '>\n';
          return syntax ? mark('cell', syntax.content, result, token) : result;
        };
        const rowHtml = (row, cells, r) => mark('row', row.span,
          '<tr>\n' + cells.map((cell, c) => cellHtml(cell, r, c)).join('') + '</tr>\n', token);
        let html = '<table>\n<thead>\n' + rowHtml(table.header, token.header, 0) + '</thead>\n';
        if (table.rows.length) html += '<tbody>\n' + table.rows.map((row, i) =>
          rowHtml(row, token.rows[i], i + 1)).join('') + '</tbody>\n';
        return mark('table', table.span, html + '</table>\n', token);
      },
    };
  }

  function nativeParser(marked) {
    return new marked.Marked({ ...marked.defaults, extensions: null,
      hooks: null, renderer: null, tokenizer: null, walkTokens: null });
  }

  function rawHtmlDiscovery(rawHtmlFence, input) {
    const flags = rawHtmlFence.flags.replace(/[gy]/g, '');
    const search = new RegExp(rawHtmlFence.source, flags);
    const atStart = new RegExp(rawHtmlFence.source, flags + 'y');
    const rootSearch = input === undefined ? null : new RegExp(rawHtmlFence.source, flags + 'g');
    const roots = new WeakMap();
    return {
      name: 'markalooRawHtmlDiscovery',
      level: 'block',
      start(value) {
        const state = roots.get(this.lexer);
        if (!state?.root) return search.exec(value)?.index;
        // Marked asks about the current root suffix minus its first character.
        // Reuse the next match even when a native token takes precedence over it.
        const at = input.length - value.length;
        if (state.next < at) {
          rootSearch.lastIndex = at;
          state.next = rootSearch.exec(input)?.index ?? Infinity;
        }
        return state.next - at;
      },
      tokenizer(value, tokens) {
        if (rootSearch) {
          let state = roots.get(this.lexer);
          if (!state) roots.set(this.lexer, state = { next: -1 });
          state.root = tokens === this.lexer.tokens;
        }
        atStart.lastIndex = 0;
        const match = atStart.exec(value);
        if (match) return { type: 'markalooRawHtmlDiscovery', raw: match[0] };
      },
      renderer: () => '',
    };
  }

  function create(marked, options) {
    const parser = nativeParser(marked);
    const discovery = options?.rawHtmlFence ? [rawHtmlDiscovery(options.rawHtmlFence, options.rawHtmlInput)] : [];
    parser.use({ extensions: [...discovery, extension({ ...options, marked })] });
    return parser;
  }

  function lexWithSpans(marked, input) {
    return observeBlocks(create(marked), input);
  }

  function explicitFence(raw) {
    const opener = /^ {0,3}(`{3,})[^`\n]*\n/.exec(raw);
    if (!opener) return null;
    const closer = /^ {0,3}(`{3,}) *$/.exec(raw.slice(raw.lastIndexOf('\n') + 1));
    return closer && closer[1].length >= opener[1].length ? opener[0].length : null;
  }

  function quotedFenceBodyStart(quote, raw) {
    let code = quote, depth = 0;
    while (code?.type === 'blockquote') {
      depth++;
      code = code.tokens.at(-1);
    }
    if (code?.type !== 'code') return null;
    const fenced = code.raw.replace(/\n+$/, '');
    if (explicitFence(fenced) === null) return null;
    // Only the final child can redirect past the quote. Verify its exact
    // source lines; a lazy continuation is not evidence that a fence closed.
    const lines = raw.split('\n').slice(-fenced.split('\n').length);
    const markers = new RegExp(`^(?: {0,3}>[ \\t]?){${depth}}`);
    if (lines.some(line => !markers.test(line)) ||
        lines.map(line => line.replace(markers, '')).join('\n') !== fenced) return null;
    return raw.length - lines.join('\n').length + lines[0].length + 1;
  }

  function closedBacktickFenceEnd(marked, text, offset, rawHtmlFence) {
    if (!text.includes('```')) return offset;
    const bom = Number(text[0] === '\uFEFF');
    const input = text.slice(bom);
    const trace = observeBlocks(create(marked, { rawHtmlFence, rawHtmlInput: input }), input);
    const span = trace?.spans.find(({ start, acceptedEnd }) =>
      acceptedEnd !== null && offset >= bom + start && offset < bom + acceptedEnd);
    if (!span) return offset;
    const start = bom + span.start, end = bom + span.acceptedEnd, raw = text.slice(start, end);
    const body = span.token?.type === 'code' ? explicitFence(raw) :
      span.token?.type === 'blockquote' ? quotedFenceBodyStart(span.token, raw) : null;
    return body !== null && offset >= start + body ? end + Number(text[end] === '\n') : offset;
  }

  function protectedRanges(text, marked, rawHtmlFence) {
    if (!mayHaveRaw(text)) return [];
    const offsets = [], parts = [];
    for (let i = 0; i < text.length; i++) {
      offsets.push(i);
      if (text[i] === '\r') {
        parts.push('\n');
        if (text[i + 1] === '\n') i++;
      } else parts.push(text[i]);
    }
    offsets.push(text.length);
    // Register the raw recognizer last so it sees the initial root input even
    // when an opaque app block is the first token.
    const parser = create(marked, { rawHtmlFence });
    const ranges = [];
    for (const token of parser.lexer(parts.join(''))) {
      if (token.type !== 'markalooRawTable') continue;
      const read = token.syntax;
      const spans = read.kind !== 'complete' ? [read.span] : rowsOf(read.value)
        .flatMap(row => row.cells.filter(cell => cell.kind === 'raw')
          .map(cell => ({ start: cell.fence.opening.start, end: cell.fence.closing.end })));
      for (const span of spans) ranges.push({ start: offsets[span.start], end: offsets[span.end] });
    }
    return ranges;
  }

  return { extension, create, createTableReader, lexWithSpans, closedBacktickFenceEnd, protectedRanges, messages };
});
