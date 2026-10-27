"use strict";

window.FoliaTableCells = (() => {
  const { normalise, sourceView, projectContainer, spliceInput, serializeCell,
    prepareCell, markdownCode, codeSources, codeDelimiters, typingSlice } = window.FoliaInlineFormatting;
  const fail = key => { throw new Error(key); };

  function cellsInLine(line, start) {
    const pipes = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '|') continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) pipes.push(i);
    }
    const from = /^\s*\|/.test(line) ? pipes.shift() + 1 : 0;
    const to = /\|\s*$/.test(line) && pipes.at(-1) === line.lastIndexOf('|')
      ? pipes.pop() : line.length;
    const boundaries = [from - 1, ...pipes, to];
    return boundaries.slice(1).map((end, i) => {
      const begin = boundaries[i] + 1, raw = line.slice(begin, end);
      const leading = /^[ \t]*/.exec(raw)[0].length;
      const trailing = /[ \t]*$/.exec(raw)[0].length;
      return { start: start + begin + leading,
        end: start + Math.max(begin + leading, end - trailing),
        text: raw.trim().replace(/\\\|/g, '|') };
    });
  }

  function markdownTables(tokens) {
    return tokens.flatMap(token => token.type === 'table' ? [token.raw.trimEnd()] :
      markdownTables(token.tokens || []).concat(
        (token.items || []).flatMap(item => markdownTables(item.tokens || []))));
  }

  function htmlTableRegions(raw, render) {
    const template = document.createElement('template');
    template.innerHTML = render(raw);
    if (!template.content.querySelector('table')) return [];
    const expected = template.innerHTML, attribute = 'data-folia-cell-source';
    const marker = 'folia-cell-end-';
    if (raw.includes(attribute) || raw.includes(marker)) return null;
    const starts = [], ends = [];
    const annotated = raw.replace(/<table(?=[\t\n\f\r />])|<\/table[\t\n\f\r ]*>/gi, (tag, offset) => {
      if (tag[1] !== '/') {
        starts.push(offset);
        return tag + ' ' + attribute + '="' + (starts.length - 1) + '"';
      }
      ends.push(offset + tag.length);
      return tag + '<!--' + marker + (ends.length - 1) + '-->';
    });
    template.innerHTML = render(annotated);
    const regions = [];
    for (const table of template.content.querySelectorAll('table')) {
      const id = table.getAttribute(attribute), after = table.nextSibling;
      // Markdown tables rendered within this HTML window have no raw tag.
      // Their source regions are already established by the Markdown lexer.
      if (id === null) continue;
      const closing = after?.nodeType === Node.COMMENT_NODE &&
        new RegExp('^' + marker + '(\\d+)$').exec(after.data);
      if (!/^\d+$/.test(id) || !closing ||
          starts[Number(id)] === undefined || ends[Number(closing[1])] === undefined) return null;
      regions.push({ start: starts[Number(id)], end: ends[Number(closing[1])] });
      table.removeAttribute(attribute);
    }
    const comments = document.createTreeWalker(template.content, NodeFilter.SHOW_COMMENT);
    const removed = [];
    for (let node; (node = comments.nextNode());) {
      if (new RegExp('^' + marker + '\\d+$').test(node.data)) removed.push(node);
    }
    removed.forEach(node => node.remove());
    // The browser, not the tag candidates, establishes actual HTML identity.
    // Refuse annotations that changed any content or repaired its structure.
    return template.innerHTML === expected ? regions : null;
  }

  function index(source, marked, protect) {
    const view = sourceView(source);
    let text = view.text;
    const bom = text[0] === '\uFEFF' ? 1 : 0;
    // Use the renderer's own protected-block extraction. Keep every offset.
    text = protect(text, match => match.replace(/[^\n]/g, ' '));
    const input = text.slice(bom), lexer = new marked.Lexer({ ...marked.defaults, tokenizer: null });
    const definitions = [], blockTokens = lexer.blockTokens, definition = lexer.tokenizer.def;
    let depth = 0;
    lexer.blockTokens = function (...args) {
      depth++;
      try { return blockTokens.apply(this, args); } finally { depth--; }
    };
    lexer.tokenizer.def = function (remaining) {
      const token = definition.call(this, remaining);
      if (token && depth === 1 && !['paragraph', 'text'].includes(lexer.tokens.at(-1)?.type)) {
        const start = input.length - remaining.length;
        if (input.slice(start) !== remaining) fail('tableCells.mapping');
        definitions.push({ start, end: start + token.raw.length });
      }
      return token;
    };
    let tokens = lexer.lex(input);
    const links = tokens.links;
    if (definitions.length) {
      // Observe consumed definitions before Marked merges surrounding newline
      // tokens. Its returned raw strings are not a source partition in that case.
      let cursor = 0, masked = '';
      for (const span of definitions) {
        masked += input.slice(cursor, span.start) + input.slice(span.start, span.end).replace(/[^\n]/g, ' ');
        cursor = span.end;
      }
      masked += input.slice(cursor);
      text = text.slice(0, bom) + masked;
      const clean = new marked.Lexer({ ...marked.defaults, tokenizer: null });
      clean.tokens.links = links;
      tokens = clean.lex(masked);
    }
    const tables = [], otherTables = [];
    let cursor = bom, htmlCoveredUntil = bom;
    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
      const token = tokens[tokenIndex];
      if (!text.startsWith(token.raw, cursor)) fail('tableCells.mapping');
      const start = cursor;
      cursor += token.raw.length;
      if (token.type !== 'table') {
        const hasTable = item => item.type === 'table' ||
          (item.type === 'html' && /<table[\s>]/i.test(item.raw)) ||
          (item.tokens || []).some(hasTable) || (item.items || []).some(hasTable);
        if (!hasTable(token)) continue;
        if (token.type === 'blockquote' || token.type === 'list') {
          let itemStart = start;
          const items = token.type === 'list' ? token.items : [token];
          for (const item of items) {
            const offsets = text.startsWith(item.raw, itemStart) &&
              projectContainer(item.raw, item.text, itemStart);
            let child;
            if (offsets) {
              child = index(item.text, marked, value => value);
              const actual = [...child.tables.map(table => ({ ...table, raw: table.token.raw.trimEnd() })),
                ...child.otherTables.filter(table => table.kind === 'markdown')].sort((a, b) => a.start - b.start);
              if (JSON.stringify(actual.map(table => table.raw)) !==
                  JSON.stringify(markdownTables(item.tokens || []))) child = null;
            }
            if (!child) otherTables.push({ start: itemStart, end: itemStart + item.raw.length, uncertain: true });
            else {
              for (const table of [...child.tables, ...child.otherTables]) {
                otherTables.push({ ...table, kind: table.kind || 'markdown',
                  raw: table.raw || table.token?.raw.trimEnd(),
                  start: offsets[table.start], end: offsets[table.end - 1] + 1 });
              }
            }
            itemStart += item.raw.length;
          }
        } else {
          if (start < htmlCoveredUntil) continue;
          const render = raw => {
            const parser = new marked.Lexer({ ...marked.defaults, tokenizer: null });
            parser.tokens.links = links;
            return marked.parser(parser.lex(raw));
          };
          let end = cursor, regions = htmlTableRegions(token.raw, render);
          // Blank lines can split one raw HTML table across Markdown tokens.
          // Do not strand its uncertainty on only the opening tag.
          for (let next = tokenIndex + 1; regions === null && next < tokens.length; next++) {
            end += tokens[next].raw.length;
            if (/<\/table[\s>]/i.test(tokens[next].raw)) {
              regions = htmlTableRegions(text.slice(start, end), render);
            }
          }
          htmlCoveredUntil = end;
          if (regions === null) otherTables.push({ start, end, uncertain: true });
          else for (const region of regions) {
            otherTables.push({ kind: 'html', start: start + region.start, end: start + region.end });
          }
        }
        continue;
      }
      const rows = [];
      let offset = start;
      const lines = token.raw.trimEnd().split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        rows.push({ start: offset, end: offset + line.length,
          cells: cellsInLine(line, offset), delimiter: i === 1 });
        offset += line.length + 1;
      }
      const actual = rows.filter(row => !row.delimiter);
      const expected = [token.header, ...token.rows];
      const writable = actual.length === expected.length && actual.every((row, r) =>
        row.cells.length === expected[r].length && row.cells.every((cell, c) =>
          cell.text === expected[r][c].text));
      tables.push({ start, end: start + token.raw.trimEnd().length, rows: actual,
        token, writable });
    }
    if (cursor !== text.length) fail('tableCells.mapping');
    return { source, view, tables, otherTables, links };
  }

  function resolveSourceLine(model, line) {
    if (!line || !Number.isSafeInteger(line.start) || !Number.isSafeInteger(line.end) ||
        line.start < 0 || line.end < line.start || line.end > model.view.text.length) fail('tableCells.click');
    const text = model.view.text, newline = text.indexOf('\n', line.start);
    if ((line.start && text[line.start - 1] !== '\n') ||
        line.end !== (newline < 0 ? text.length : newline)) fail('tableCells.click');
    const intersects = item => line.start < item.end && line.end > item.start;
    if (model.otherTables.some(item => intersects(item))) fail('tableCells.unsupported');
    const table = model.tables.find(intersects);
    if (!table) fail('tableCells.click');
    if (!table.writable) fail('tableCells.unsupported');
    return { model, table, rows: table.rows };
  }

  function resolvePreviewTable(model, node, viewer, sourceFor) {
    if (!node || !viewer.contains(node)) fail('tableCells.click');
    const descriptor = sourceFor(node);
    if (!descriptor) fail('tableCells.mapping');
    const table = model.tables.find(item => item.start === descriptor.start && item.end === descriptor.end);
    if (!table?.writable) fail('tableCells.unsupported');
    if (node.rows.length !== table.rows.length) fail('tableCells.mapping');
    return { model, table, rows: table.rows };
  }

  function resolveSource(model, start, end, rowsOnly) {
    if (start === end) fail('tableCells.select');
    if (rowsOnly && !model.view.text.slice(start, end).trim()) fail('tableCells.select');
    const intersects = item => start < item.end && end > item.start;
    if (model.otherTables.some(item => item.uncertain && intersects(item))) fail('tableCells.mapping');
    const tables = model.tables.filter(intersects);
    const count = tables.length + model.otherTables.filter(intersects).length;
    if (count > 1) fail('tableCells.multiple');
    if (!count) fail('tableCells.select');
    if (!tables.length || !tables[0].writable) fail('tableCells.unsupported');
    const table = tables[0], rows = rowsOnly ? table.rows.filter(intersects) : table.rows;
    if (!rows.length) fail('tableCells.rows');
    if (rowsOnly && !rows.some(row => row.cells.some(cell =>
      start < cell.end && end > cell.start &&
      model.view.text.slice(Math.max(start, cell.start), Math.min(end, cell.end)).trim()))) fail('tableCells.select');
    return { model, table, rows };
  }

  function resolvePreview(model, range, viewer, sourceFor, rowsOnly) {
    if (!range || range.collapsed || !viewer.contains(range.commonAncestorContainer)) fail('tableCells.select');
    if (rowsOnly && !range.toString().trim()) fail('tableCells.select');
    const intersects = node => {
      const probe = document.createRange();
      probe.selectNode(node);
      return range.compareBoundaryPoints(Range.END_TO_START, probe) < 0 &&
        range.compareBoundaryPoints(Range.START_TO_END, probe) > 0;
    };
    const tables = [...viewer.querySelectorAll('table')].filter(intersects);
    if (tables.length > 1) fail('tableCells.multiple');
    if (!tables.length) fail('tableCells.select');
    const node = tables[0], descriptor = sourceFor(node);
    if (!descriptor) fail('tableCells.mapping');
    const table = model.tables.find(item => item.start === descriptor.start && item.end === descriptor.end);
    if (!table?.writable) fail('tableCells.unsupported');
    // A selection of the table node itself may have parent boundaries.
    if (!node.contains(range.commonAncestorContainer)) {
      const selection = range.cloneContents();
      selection.querySelectorAll('table').forEach(el => el.remove());
      if (selection.textContent.trim() ||
          selection.querySelector('img, button, svg, iframe, input, hr, video, audio, canvas, object, embed, textarea, select')) {
        fail('tableCells.select');
      }
    }
    const domRows = [...node.rows];
    if (domRows.length !== table.rows.length) fail('tableCells.mapping');
    const rows = rowsOnly ? table.rows.filter((row, i) => intersects(domRows[i])) : table.rows;
    if (!rows.length) fail('tableCells.rows');
    return { model, table, rows };
  }

  function replaceCells(target, edits, marked, protect) {
    const { model } = target;
    const ordered = edits.slice().sort((a, b) => a.cell.start - b.cell.start);
    let cursor = 0, previousEnd = 0, candidate = '';
    for (const { cell, text } of ordered) {
      if (!target.rows.some(row => row.cells.includes(cell)) || cell.start < previousEnd ||
          /[\r\n]/.test(text) || /(^|[^\\])(?:\\\\)*\|/.test(text)) fail('tableCells.invalid');
      candidate += model.source.slice(cursor, model.view.offsets[cell.start]) + text;
      cursor = model.view.offsets[cell.end];
      previousEnd = cell.end;
    }
    candidate += model.source.slice(cursor);
    const checked = index(candidate, marked, protect);
    const table = checked.tables.find(item => item.start === target.table.start);
    if (!table?.writable || checked.tables.length !== model.tables.length ||
        table.rows.length !== target.table.rows.length ||
        table.rows.some((row, i) => row.cells.length !== target.table.rows[i].cells.length)) fail('tableCells.invalid');
    return candidate;
  }

  return { normalise, index, resolveSource, resolvePreview, resolveSourceLine, resolvePreviewTable,
    replaceCells, spliceInput, serializeCell, prepareCell, markdownCode, codeSources, codeDelimiters, typingSlice };
})();
