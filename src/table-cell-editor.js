"use strict";

window.MarkalooTableCells = (() => {
  const { normalise, sourceView, projectContainer, spliceInput, serializeCell,
    prepareCell, markdownCode, codeSources, codeDelimiters, typingSlice } = window.MarkalooInlineFormatting;
  const fail = key => { throw new Error(key); };
  const Mode = Object.freeze({
    INSERT: 'insert',
    UPDATE_TABLE: 'update-table',
    UPDATE_ROWS: 'update-rows',
  });

  function validateMode(mode) {
    if (!Object.values(Mode).includes(mode)) fail('tableCells.mode');
  }

  function validateUpdateMode(mode) {
    validateMode(mode);
    if (mode === Mode.INSERT) fail('tableCells.mode');
  }

  function lineLayout(line, start) {
    const pipes = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '|') continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) pipes.push(i);
    }
    const leadingPipe = /^\s*\|/.test(line) ? pipes.shift() : null;
    const trailingPipe = /\|\s*$/.test(line) && pipes.at(-1) === line.lastIndexOf('|')
      ? pipes.pop() : null;
    const from = leadingPipe === null ? 0 : leadingPipe + 1;
    const to = trailingPipe === null ? line.length : trailingPipe;
    const boundaries = [from - 1, ...pipes, to];
    const slots = boundaries.slice(1).map((end, i) => {
      const begin = boundaries[i] + 1, raw = line.slice(begin, end);
      const leading = /^[ \t]*/.exec(raw)[0].length;
      const trailing = /[ \t]*$/.exec(raw)[0].length;
      return { rawStart: start + (i === 0 && leadingPipe === null ? begin + leading : begin),
        rawEnd: start + end, cell: { start: start + begin + leading,
        end: start + Math.max(begin + leading, end - trailing),
        text: raw.trim().replace(/\\\|/g, '|') } };
    });
    return { slots, cells: slots.map(slot => slot.cell), leadingPipe, trailingPipe };
  }

  function cellsInLine(line, start) {
    return lineLayout(line, start).cells;
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
    const expected = template.innerHTML, attribute = 'data-markaloo-cell-source';
    const marker = 'markaloo-cell-end-';
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
    const tables = [], otherTables = [], blocks = [];
    let cursor = bom, htmlCoveredUntil = bom;
    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
      const token = tokens[tokenIndex];
      if (!text.startsWith(token.raw, cursor)) fail('tableCells.mapping');
      const start = cursor;
      cursor += token.raw.length;
      blocks.push({ start, end: cursor, type: token.type, raw: token.raw });
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
      tables.push({ start, end: start + token.raw.trimEnd().length, rows: actual, delimiter: rows[1],
        token, writable });
    }
    if (cursor !== text.length) fail('tableCells.mapping');
    return { source, view, tables, otherTables, blocks, links };
  }

  function resolveSourceLine(model, line, mode) {
    validateMode(mode);
    if (mode !== Mode.UPDATE_TABLE) fail('tableCells.mode');
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
    return { mode, model, table, rows: table.rows };
  }

  function resolvePreviewTable(model, node, viewer, sourceFor, mode) {
    validateMode(mode);
    if (mode !== Mode.UPDATE_TABLE) fail('tableCells.mode');
    if (!node || !viewer.contains(node)) fail('tableCells.click');
    const descriptor = sourceFor(node);
    if (!descriptor) fail('tableCells.mapping');
    const table = model.tables.find(item => item.start === descriptor.start && item.end === descriptor.end);
    if (!table?.writable) fail('tableCells.unsupported');
    if (node.rows.length !== table.rows.length) fail('tableCells.mapping');
    return { mode, model, table, rows: table.rows };
  }

  function resolveSource(model, start, end, mode) {
    validateUpdateMode(mode);
    if (start === end) fail('tableCells.select');
    if (mode === Mode.UPDATE_ROWS && !model.view.text.slice(start, end).trim()) fail('tableCells.select');
    const intersects = item => start < item.end && end > item.start;
    if (model.otherTables.some(item => item.uncertain && intersects(item))) fail('tableCells.mapping');
    const tables = model.tables.filter(intersects);
    const count = tables.length + model.otherTables.filter(intersects).length;
    if (count > 1) fail('tableCells.multiple');
    if (!count) fail('tableCells.select');
    if (!tables.length || !tables[0].writable) fail('tableCells.unsupported');
    const table = tables[0], rows = mode === Mode.UPDATE_ROWS ? table.rows.filter(intersects) : table.rows;
    if (!rows.length) fail('tableCells.rows');
    if (mode === Mode.UPDATE_ROWS && !rows.some(row => row.cells.some(cell =>
      start < cell.end && end > cell.start &&
      model.view.text.slice(Math.max(start, cell.start), Math.min(end, cell.end)).trim()))) fail('tableCells.select');
    return { mode, model, table, rows };
  }

  function resolvePreview(model, range, viewer, sourceFor, mode) {
    validateUpdateMode(mode);
    if (!range || range.collapsed || !viewer.contains(range.commonAncestorContainer)) fail('tableCells.select');
    if (mode === Mode.UPDATE_ROWS && !range.toString().trim()) fail('tableCells.select');
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
    const rows = mode === Mode.UPDATE_ROWS ? table.rows.filter((row, i) => intersects(domRows[i])) : table.rows;
    if (!rows.length) fail('tableCells.rows');
    return { mode, model, table, rows };
  }

  function replaceCells(target, edits, marked, protect) {
    validateUpdateMode(target?.mode);
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

  const validCellSource = text => typeof text === 'string' &&
    !/[\r\n]/.test(text) && !/(^|[^\\])(?:\\\\)*\|/.test(text);

  function insertTable(model, offset, rows, marked, protect, mode) {
    validateMode(mode);
    if (mode !== Mode.INSERT) fail('tableCells.mode');
    if (!Array.isArray(model?.tables) || !Array.isArray(model?.otherTables) ||
        !Array.isArray(model?.blocks) || !Number.isSafeInteger(offset) ||
        offset < 0 || offset > model.view.text.length || !Array.isArray(rows) ||
        !rows.length || !Array.isArray(rows[0]) || !rows[0].length ||
        rows.some(row => !Array.isArray(row) || row.length !== rows[0].length ||
          row.some(text => !validCellSource(text)))) fail('tableCells.invalid');
    const lines = rows.map(row => '| ' + row.join(' | ') + ' |');
    lines.splice(1, 0, '| ' + rows[0].map(() => '---').join(' | ') + ' |');
    const markdown = lines.join('\n'), before = model.view.text.slice(0, offset),
      after = model.view.text.slice(offset);
    const padding = text => text ? text.startsWith('\n\n') ? '' :
      text.startsWith('\n') ? '\n' : '\n\n' : '';
    const leading = before ? before.endsWith('\n\n') ? '' :
      before.endsWith('\n') ? '\n' : '\n\n' : '';
    const trailing = padding(after);
    const replacement = leading + markdown + trailing;
    const source = spliceInput(model.source, offset, offset, replacement);
    const checked = index(source, marked, protect), start = offset + leading.length;
    const table = checked.tables.find(item => item.start === start);
    const expected = rows.map(row => row.map(text => text.trim().replace(/\\\|/g, '|')));
    if (!table?.writable || checked.tables.length !== model.tables.length + 1 ||
        JSON.stringify(table.rows.map(row => row.cells.map(cell => cell.text))) !== JSON.stringify(expected) ||
        table.token.align.some(alignment => alignment !== null)) fail('tableCells.insertPosition');
    const delta = replacement.length;
    const unchanged = (old, current) => old.length === current.length && old.every((item, i) => {
      const other = current[i], shift = item.start >= offset ? delta : 0;
      return other && other.start === item.start + shift && other.end === item.end + shift &&
        other.kind === item.kind && other.uncertain === item.uncertain &&
        checked.view.text.slice(other.start, other.end) === model.view.text.slice(item.start, item.end);
    });
    // Blank-line padding may change whitespace tokens, never surrounding blocks.
    const content = blocks => blocks.filter(item => item.type !== 'space')
      .map(item => [item.type, item.raw.trimEnd()]);
    if (!unchanged(model.tables, checked.tables.filter(item => item !== table)) ||
        !unchanged(model.otherTables, checked.otherTables) ||
        JSON.stringify(content(model.blocks)) !== JSON.stringify(content(checked.blocks.filter(item =>
          item.type !== 'table' || item.start !== start))) ||
        model.source.startsWith('\uFEFF') && !source.startsWith('\uFEFF')) {
      fail('tableCells.insertPosition');
    }
    return { source, cursor: offset + replacement.length };
  }

  function replaceRows(target, edits, order, marked, protect, deletedRows = []) {
    validateUpdateMode(target?.mode);
    if (!Array.isArray(order) || !Array.isArray(deletedRows)) fail('tableCells.invalid');
    if (!deletedRows.length && Array.isArray(target?.rows) && order.length === target.rows.length &&
        order.every((entry, i) => entry?.original === target.rows[i])) {
      return replaceCells(target, edits, marked, protect);
    }
    if (!Array.isArray(target?.model?.tables) || !Array.isArray(target?.table?.rows)) {
      fail('tableCells.invalid');
    }
    const { model, table, rows } = target;
    if (!model?.tables.includes(table) || !table.writable || !table.delimiter ||
        !Array.isArray(rows) || !rows.length || !Array.isArray(edits)) fail('tableCells.invalid');
    const first = table.rows.indexOf(rows[0]), last = first + rows.length - 1;
    if (first < 0 || rows.some((row, i) => row !== table.rows[first + i])) fail('tableCells.invalid');
    const deleted = new Set();
    for (const row of deletedRows) {
      if (!rows.includes(row) || row === table.rows[0] || deleted.has(row)) fail('tableCells.invalid');
      deleted.add(row);
    }
    const edited = new Map(), ids = new Set();
    for (const edit of edits) {
      if (!edit || !rows.some(row => !deleted.has(row) && row.cells.includes(edit.cell)) ||
          edited.has(edit.cell) || !validCellSource(edit.text)) fail('tableCells.invalid');
      edited.set(edit.cell, edit.text);
    }
    let original = 0;
    for (const entry of order) {
      if (!entry || typeof entry !== 'object') fail('tableCells.invalid');
      if (entry.original) {
        while (deleted.has(rows[original])) original++;
        if (entry.original !== rows[original++]) fail('tableCells.invalid');
      } else {
        if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
            !Array.isArray(entry.cells) || entry.cells.length !== table.rows[0].cells.length) fail('tableCells.invalid');
        for (const text of entry.cells) if (!validCellSource(text)) fail('tableCells.invalid');
        ids.add(entry.id);
      }
    }
    while (deleted.has(rows[original])) original++;
    if (original !== rows.length || first === 0 && order[0]?.original !== table.rows[0]) {
      fail('tableCells.invalid');
    }
    const { source, view } = model;
    const physicalEnd = (row, text = view.text) => {
      const newline = text.indexOf('\n', row.start);
      return newline < 0 ? text.length : newline;
    };
    const endingAt = point => {
      const newline = view.text[point] === '\n' ? point :
        view.text.lastIndexOf('\n', point - 1);
      return newline < 0 ? '\n' : source.slice(view.offsets[newline], view.offsets[newline + 1]);
    };
    const afterLine = row => {
      const end = physicalEnd(row);
      return end < view.text.length ? end + 1 : end;
    };
    const finalLine = rows.at(-1) === table.rows[0] ? table.delimiter : rows.at(-1);
    const end = afterLine(finalLine), terminated = view.text[end - 1] === '\n';
    const chunks = [source.slice(0, view.offsets[rows[0].start])];
    let separated = true;
    for (let i = 0; i < order.length;) {
      const row = order[i].original;
      if (row) {
        // Keep physical row bytes; only its edited cell spans may change.
        // Attaching the delimiter to the header also forbids inserting before it.
        let cursor = view.offsets[row.start];
        for (const cell of row.cells) {
          if (!edited.has(cell)) continue;
          const start = view.offsets[cell.start], finish = view.offsets[cell.end];
          if (start < cursor || finish < start) fail('tableCells.invalid');
          chunks.push(source.slice(cursor, start), edited.get(cell));
          cursor = finish;
        }
        const finish = afterLine(row === table.rows[0] ? table.delimiter : row);
        chunks.push(source.slice(cursor, view.offsets[finish]));
        separated = view.text[finish - 1] === '\n';
        i++;
      } else {
        const added = [];
        while (i < order.length && !order[i].original) {
          added.push('| ' + order[i++].cells.join(' | ') + ' |');
        }
        const next = order[i]?.original || table.rows[last + 1];
        const ending = endingAt(next ? next.start : physicalEnd(finalLine));
        if (!separated) chunks.push(ending);
        chunks.push(added.join(ending));
        separated = !!next || terminated;
        if (separated) chunks.push(ending);
      }
    }
    chunks.push(source.slice(view.offsets[end]));
    const candidate = chunks.join(''), checked = index(candidate, marked, protect);
    const actual = checked.tables[model.tables.indexOf(table)];
    const textOf = text => text.trim().replace(/\\\|/g, '|');
    const expected = [...table.rows.slice(0, first), ...order.map(entry => entry.original || entry),
      ...table.rows.slice(last + 1)].map(row => row.cells.map(cell =>
        typeof cell === 'string' ? textOf(cell) : edited.has(cell) ? textOf(edited.get(cell)) : cell.text));
    if (!actual?.writable || actual.start !== table.start ||
        checked.tables.length !== model.tables.length ||
        JSON.stringify(actual.rows.map(row => row.cells.map(cell => cell.text))) !== JSON.stringify(expected) ||
        JSON.stringify(actual.token.align) !== JSON.stringify(table.token.align) ||
        checked.view.text.slice(actual.delimiter.start, physicalEnd(actual.delimiter, checked.view.text)) !==
          view.text.slice(table.delimiter.start, physicalEnd(table.delimiter))) {
      fail('tableCells.invalid');
    }
    const delta = checked.view.text.length - view.text.length;
    const unchanged = (before, after) => before.length === after.length && before.every((item, i) => {
      const other = after[i], shift = item.start > table.start ? delta : 0;
      return other && other.start === item.start + shift && other.end === item.end + shift &&
        other.kind === item.kind && other.uncertain === item.uncertain &&
        (!item.token || other.token?.raw === item.token.raw &&
          JSON.stringify(other.rows.map(row => row.cells.map(cell => cell.text))) ===
          JSON.stringify(item.rows.map(row => row.cells.map(cell => cell.text)))) &&
        checked.view.text.slice(other.start, other.end) === view.text.slice(item.start, item.end);
    });
    if (!unchanged(model.tables.filter(item => item !== table), checked.tables.filter(item => item !== actual)) ||
        !unchanged(model.otherTables, checked.otherTables)) fail('tableCells.invalid');
    return candidate;
  }

  function replaceStructure(target, edits, order, columns, marked, protect, deletedRows = [], deletedColumns = []) {
    validateMode(target?.mode);
    if (target.mode !== Mode.UPDATE_TABLE) fail('tableCells.columnsScope');
    const { model, table } = target;
    if (!model?.tables.includes(table) || !table.writable ||
        !Array.isArray(target.rows) || target.rows.length !== table.rows.length ||
        target.rows.some((row, i) => row !== table.rows[i]) ||
        !Array.isArray(columns) || !columns.length || !Array.isArray(order) || !order.length ||
        !Array.isArray(edits) || !Array.isArray(deletedColumns)) fail('tableCells.invalid');
    const count = table.rows[0].cells.length, ids = new Set(), deleted = new Set();
    for (const column of deletedColumns) {
      if (!Number.isSafeInteger(column) || column < 0 || column >= count || deleted.has(column)) {
        fail('tableCells.invalid');
      }
      deleted.add(column);
    }
    const positions = Array(count).fill(null);
    const gaps = Array.from({ length: count + 1 }, () => []);
    let lastOriginal = -1;
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i];
      if (!column || typeof column.id !== 'string' || !column.id || ids.has(column.id)) fail('tableCells.invalid');
      ids.add(column.id);
      if (column.originalIndex !== undefined) {
        const original = column.originalIndex;
        if (!Number.isSafeInteger(original) || original <= lastOriginal || original >= count ||
            deleted.has(original)) fail('tableCells.invalid');
        positions[original] = i;
        lastOriginal = original;
      } else gaps[lastOriginal + 1].push(i);
    }
    if (positions.some((position, original) => position === null && !deleted.has(original)) ||
        order.some(entry => !entry || entry.original && !table.rows.includes(entry.original) ||
        !Array.isArray(entry.cells) ||
        entry.cells.length !== columns.length || entry.cells.some(text => !validCellSource(text)))) {
      fail('tableCells.invalid');
    }
    for (const edit of edits) {
      if (!edit || table.rows.some(row => row.cells.some((cell, column) =>
          cell === edit.cell && deleted.has(column)))) fail('tableCells.invalid');
    }
    const changed = deleted.size > 0 || columns.some(column => column.originalIndex === undefined);
    const stageCells = entry => positions.map((position, original) => {
      if (position !== null) return entry.cells[position];
      const cell = entry.original?.cells[original];
      return cell ? model.source.slice(model.view.offsets[cell.start], model.view.offsets[cell.end]) : '';
    });
    const projected = order.map(entry => entry.original ? { original: entry.original } :
      { id: entry.id, cells: stageCells(entry) });
    // Never adopt the staging source. Unsupported projections leave the draft intact.
    let stageSource;
    try { stageSource = replaceRows(target, edits, projected, marked, protect, deletedRows); }
    catch (error) {
      if (!changed || error.message !== 'tableCells.invalid') throw error;
      throw new Error('tableCells.columnProjection', { cause: error });
    }
    const stage = index(stageSource, marked, protect), staged = stage.tables[model.tables.indexOf(table)];
    const textOf = text => text.trim().replace(/\\\|/g, '|');
    if (!staged?.writable || staged.start !== table.start ||
        staged.rows.length !== order.length ||
        JSON.stringify(staged.rows.map(row => row.cells.map(cell => cell.text))) !==
          JSON.stringify(order.map(entry => stageCells(entry).map(textOf))) ||
        JSON.stringify(staged.token.align) !== JSON.stringify(table.token.align)) fail('tableCells.invalid');
    if (!changed) return stageSource;

    const owners = [];
    for (let gap = 0; gap <= count; gap++) {
      for (const position of gaps[gap]) owners.push({ position });
      if (gap < count) owners.push({ original: gap, position: positions[gap] });
    }
    const patches = [];
    const lines = [{ row: staged.rows[0], entry: order[0] }, { row: staged.delimiter, entry: null },
      ...staged.rows.slice(1).map((row, i) => ({ row, entry: order[i + 1] }))];
    for (const { row, entry } of lines) {
      const newline = stage.view.text.indexOf('\n', row.start);
      const end = newline < 0 ? stage.view.text.length : newline;
      let line = stage.view.text.slice(row.start, end);
      const layout = lineLayout(line, row.start);
      // Physical slots must agree with the index; never invent parser-padded cells.
      if (layout.slots.length !== count ||
          JSON.stringify(layout.cells) !== JSON.stringify(row.cells)) fail('tableCells.invalid');
      const insertions = [];
      for (let gap = 0; gap <= count; gap++) {
        if (!gaps[gap].length) continue;
        const values = gaps[gap].map(position => entry ? entry.cells[position] : '---');
        if (gap < count) {
          const prefix = gap === 0 && layout.leadingPipe === null ? '| ' : ' ';
          insertions.push({ at: layout.slots[gap].rawStart - row.start, gap,
            text: prefix + values.join(' | ') + ' |' });
        } else {
          // Missing outer pipes must become explicit, including empty edge cells.
          insertions.push({ at: layout.slots.at(-1).rawEnd - row.start, gap,
            text: ' | ' + values.join(' | ') + ' ' + (layout.trailingPipe === null ? '|' : '') });
        }
      }
      // Empty edge slots can put two gaps at one offset; splice the later gap first.
      for (const patch of insertions.sort((a, b) => b.at - a.at || b.gap - a.gap)) {
        line = line.slice(0, patch.at) + patch.text + line.slice(patch.at);
      }
      const expanded = lineLayout(line, 0);
      const stagedValues = entry ? stageCells(entry).map(textOf) : row.cells.map(cell => cell.text);
      const expected = owners.map(owner => owner.original !== undefined
        ? stagedValues[owner.original]
        : entry ? textOf(entry.cells[owner.position]) : '---');
      if (expanded.slots.length !== owners.length ||
          JSON.stringify(expanded.cells.map(cell => cell.text)) !== JSON.stringify(expected)) {
        fail('tableCells.invalid');
      }
      // A surviving separator beside an empty cell is not an outer pipe.
      // Capture ownership and indentation before removing any physical slots.
      const leading = expanded.leadingPipe !== null, trailing = expanded.trailingPipe !== null;
      const indent = leading ? expanded.leadingPipe : expanded.slots[0].rawStart;
      const cuts = [];
      for (let i = 0; i < owners.length;) {
        if (!deleted.has(owners[i].original)) { i++; continue; }
        const first = i;
        while (i < owners.length && deleted.has(owners[i].original)) i++;
        if (i < owners.length) {
          cuts.push({ start: expanded.slots[first].rawStart, end: expanded.slots[i].rawStart });
        } else {
          const start = expanded.slots[first].rawStart - 1;
          if (first === 0 || line[start] !== '|') fail('tableCells.invalid');
          cuts.push({ start, end: expanded.slots[i - 1].rawEnd });
        }
      }
      let previous = line.length;
      for (const cut of cuts.sort((a, b) => b.start - a.start)) {
        if (cut.start < indent || cut.end > previous || cut.end <= cut.start) fail('tableCells.invalid');
        line = line.slice(0, cut.start) + line.slice(cut.end);
        previous = cut.start;
      }
      const firstText = entry ? textOf(entry.cells[0]) : '---';
      const lastText = entry ? textOf(entry.cells.at(-1)) : '---';
      if (!leading && (columns.length === 1 || deleted.has(0) || !firstText)) {
        line = line.slice(0, indent) + '|' + line.slice(indent);
      }
      if (!trailing && (columns.length === 1 || deleted.has(count - 1) || !lastText)) {
        const slashes = /\\*$/.exec(line)[0].length;
        line += (slashes % 2 ? ' ' : '') + '|';
      }
      const final = lineLayout(line, 0);
      const finalExpected = entry ? entry.cells.map(textOf) : columns.map(column =>
        column.originalIndex === undefined ? '---' : row.cells[column.originalIndex].text);
      if (final.slots.length !== columns.length ||
          JSON.stringify(final.cells.map(cell => cell.text)) !== JSON.stringify(finalExpected)) {
        fail('tableCells.invalid');
      }
      patches.push({ start: row.start, end, text: line });
    }
    patches.sort((a, b) => a.start - b.start);
    const chunks = [];
    let cursor = 0;
    for (const patch of patches) {
      const point = stage.view.offsets[patch.start], end = stage.view.offsets[patch.end];
      if (!Number.isSafeInteger(point) || point < cursor || !Number.isSafeInteger(end) || end < point) {
        fail('tableCells.invalid');
      }
      chunks.push(stageSource.slice(cursor, point), patch.text);
      cursor = end;
    }
    chunks.push(stageSource.slice(cursor));
    const candidate = chunks.join(''), checked = index(candidate, marked, protect);
    const actual = checked.tables[model.tables.indexOf(table)];
    const alignment = columns.map(column => column.originalIndex === undefined ? null :
      table.token.align[column.originalIndex]);
    if (!actual?.writable || actual.start !== table.start || checked.tables.length !== model.tables.length ||
        JSON.stringify(actual.rows.map(row => row.cells.map(cell => cell.text))) !==
          JSON.stringify(order.map(entry => entry.cells.map(textOf))) ||
        JSON.stringify(actual.token.align) !== JSON.stringify(alignment)) fail('tableCells.invalid');
    const afterTable = (item, view) => {
      const final = item.rows.at(-1) === item.rows[0] ? item.delimiter : item.rows.at(-1);
      const newline = view.text.indexOf('\n', final.start);
      return newline < 0 ? view.text.length : newline + 1;
    };
    if (candidate.slice(0, checked.view.offsets[actual.start]) !==
          model.source.slice(0, model.view.offsets[table.start]) ||
        candidate.slice(checked.view.offsets[afterTable(actual, checked.view)]) !==
          model.source.slice(model.view.offsets[afterTable(table, model.view)])) fail('tableCells.invalid');
    const delta = checked.view.text.length - model.view.text.length;
    const unchanged = (before, after) => before.length === after.length && before.every((item, i) => {
      const other = after[i], shift = item.start > table.start ? delta : 0;
      return other && other.start === item.start + shift && other.end === item.end + shift &&
        other.kind === item.kind && other.uncertain === item.uncertain &&
        checked.view.text.slice(other.start, other.end) === model.view.text.slice(item.start, item.end);
    });
    if (!unchanged(model.tables.filter(item => item !== table), checked.tables.filter(item => item !== actual)) ||
        !unchanged(model.otherTables, checked.otherTables)) fail('tableCells.invalid');
    return candidate;
  }

  return { Mode, validateMode, normalise, index, resolveSource, resolvePreview, resolveSourceLine, resolvePreviewTable,
    replaceCells, replaceRows, replaceStructure, insertTable, spliceInput, serializeCell, prepareCell, markdownCode, codeSources, codeDelimiters, typingSlice };
})();
