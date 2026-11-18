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

  function htmlTableRegions(raw, render, owned = [{ start: 0, end: raw.length }]) {
    const template = document.createElement('template');
    template.innerHTML = render(raw);
    if (!template.content.querySelector('table')) return [];
    const expected = template.innerHTML, attribute = 'data-markaloo-cell-source';
    const marker = 'markaloo-cell-end-';
    if (owned.some(({ start, end }) => {
      const part = raw.slice(start, end);
      return part.includes(attribute) || part.includes(marker);
    })) return null;
    const starts = [], ends = [];
    let annotated = '', copied = 0;
    for (const { start, end } of owned) {
      annotated += raw.slice(copied, start) +
        raw.slice(start, end).replace(/<table(?=[\t\n\f\r />])|<\/table[\t\n\f\r ]*>/gi, (tag, offset) => {
          if (tag[1] !== '/') {
            starts.push(start + offset);
            return tag + ' ' + attribute + '="' + (starts.length - 1) + '"';
          }
          ends.push(start + offset + tag.length);
          return tag + '<!--' + marker + (ends.length - 1) + '-->';
        });
      copied = end;
    }
    template.innerHTML = render(annotated + raw.slice(copied));
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
    const view = sourceView(source), syntax = Object.freeze({ text: source, space: 'original' });
    const adapter = window.MarkalooTableMarked;
    if (typeof adapter?.lexWithSpans !== 'function') fail('tableCells.mapping');
    const readTable = adapter.createTableReader(syntax, marked);
    const bom = view.text[0] === '\uFEFF' ? 1 : 0;
    const rawProviderOwns = ({ token, start, acceptedEnd }) =>
      token.at === start && token.syntax.next === acceptedEnd;
    const discover = adapter.lexWithSpans(marked, view.text.slice(bom));
    if (!discover) fail('tableCells.mapping');
    let text = '', copied = 0;
    const mask = value => {
      const result = protect(value, match => match.replace(/[^\n]/g, ' '));
      if (result.length !== value.length) fail('tableCells.mapping');
      return result;
    };
    // Raw fences and malformed literal regions are opaque even to Mermaid and HTML extraction.
    for (const span of discover.spans) {
      if (span.acceptedEnd === null || span.token?.type !== 'markalooRawTable') continue;
      if (!rawProviderOwns(span)) fail('tableCells.mapping');
      const start = bom + span.start, end = bom + span.acceptedEnd;
      text += mask(view.text.slice(copied, start)) + view.text.slice(start, end);
      copied = end;
    }
    text += mask(view.text.slice(copied));
    const trace = adapter.lexWithSpans(marked, text.slice(bom));
    if (!trace) fail('tableCells.mapping');
    const { tokens, spans } = trace;
    const links = tokens.links;
    const tables = [], otherTables = [], blocks = [];
    let cursor = bom, htmlCoveredUntil = bom;
    const gapTo = end => {
      const raw = text.slice(cursor, end);
      if (raw) blocks.push({ start: cursor, end, type: 'space', raw });
      cursor = end;
    };
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i], { token, acceptedEnd } = span;
      if (!token || token.type === 'space') continue;
      if (acceptedEnd === null) {
        // A detached LF belongs to the physical gap, not the preceding block.
        if (/[^\n]/.test(text.slice(bom + span.start, bom + span.end))) fail('tableCells.mapping');
        continue;
      }
      const start = bom + span.start, end = bom + span.end;
      const raw = text.slice(start, end);
      gapTo(start);
      cursor = end;
      blocks.push({ start, end, type: token.type, raw });
      if (token.type === 'markalooRawTable') {
        const receipt = readTable(view.offsets[start]);
        if (!rawProviderOwns(span) || !receipt ||
            receipt.next !== view.offsets[bom + acceptedEnd] ||
            text.slice(start, bom + acceptedEnd) !== normalise(source.slice(view.offsets[start], receipt.next))) {
          fail('tableCells.mapping');
        }
        if (receipt.kind === 'literal' || receipt.kind === 'refusal') {
          otherTables.push({ start, end: editorOffset(view, receipt.span.end), uncertain: true, syntax: receipt });
          continue;
        }
        const row = value => ({
          start: editorOffset(view, value.span.start), end: editorOffset(view, value.span.end), syntax: value,
          cells: value.cells.map(cell => ({
            start: editorOffset(view, cell.content.start), end: editorOffset(view, cell.content.end),
            text: cell.kind === 'raw' ? normalise(source.slice(cell.content.start, cell.content.end)) :
              source.slice(cell.content.start, cell.content.end).replace(/\\\|/g, '|'),
            syntax: cell,
          })),
        });
        const value = receipt.value;
        const logicalRows = [value.header, ...value.rows].map(row);
        tables.push({ start, end: editorOffset(view, value.span.end), rows: logicalRows,
          delimiter: { ...row(value.delimiter), delimiter: true }, token,
          writable: logicalRows.every(row => row.cells.length === value.header.cells.length), syntax: receipt });
        continue;
      }
      if (token.type !== 'table') {
        const hasTable = item => item.type === 'table' ||
          (item.type === 'html' && /<table[\s>]/i.test(item.raw)) ||
          (item.tokens || []).some(hasTable) || (item.items || []).some(hasTable);
        if (!hasTable(token)) continue;
        if (token.type === 'blockquote' || token.type === 'list') {
          let itemStart = start;
          const items = token.type === 'list' ? token.items : [token];
          for (const item of items) {
            const itemRaw = item === token ? raw : item.raw;
            const itemEnd = itemStart + itemRaw.length;
            if (itemEnd > end) {
              if (itemStart < end) otherTables.push({ start: itemStart, end, uncertain: true });
              break;
            }
            const offsets = text.startsWith(itemRaw, itemStart) &&
              projectContainer(itemRaw, item.text, itemStart);
            let child;
            if (offsets) {
              child = index(item.text, marked, value => value);
              const actual = [...child.tables.map(table => ({ ...table, raw: table.token.raw.trimEnd() })),
                ...child.otherTables.filter(table => table.kind === 'markdown')].sort((a, b) => a.start - b.start);
              if (JSON.stringify(actual.map(table => table.raw)) !==
                  JSON.stringify(markdownTables(item.tokens || []))) child = null;
            }
            if (!child) otherTables.push({ start: itemStart, end: itemEnd, uncertain: true });
            else {
              for (const table of [...child.tables, ...child.otherTables]) {
                otherTables.push({ ...table, kind: table.kind || 'markdown',
                  raw: table.raw || table.token?.raw.trimEnd(),
                  start: offsets[table.start], end: offsets[table.end - 1] + 1 });
              }
            }
            itemStart = itemEnd;
          }
        } else {
          if (start < htmlCoveredUntil) continue;
          const render = raw => {
            const renderer = adapter.create(marked), parsed = renderer.lexer(raw);
            parsed.links = links;
            return renderer.parser(parsed);
          };
          let htmlEnd = end, regions = htmlTableRegions(raw, render);
          const owned = [{ start: 0, end: end - start }];
          // Blank lines can split one raw HTML table across Markdown tokens.
          // Keep the context intact but never annotate tags in an omitted gap.
          for (let next = i + 1; regions === null && next < spans.length; next++) {
            const later = spans[next];
            if (!later.token || later.acceptedEnd === null) continue;
            const from = bom + later.start;
            htmlEnd = bom + later.end;
            owned.push({ start: from - start, end: htmlEnd - start });
            if (/<\/table[\s>]/i.test(text.slice(from, htmlEnd))) {
              regions = htmlTableRegions(text.slice(start, htmlEnd), render, owned);
            }
          }
          htmlCoveredUntil = htmlEnd;
          if (regions === null) otherTables.push({ start, end: htmlEnd, uncertain: true });
          else for (const region of regions) {
            otherTables.push({ kind: 'html', start: start + region.start, end: start + region.end });
          }
        }
        continue;
      }
      const rows = [];
      let offset = start;
      // Keep native row layout, but bound it by the lexer acceptance, not by
      // trailing whitespace that Marked may later append to the public token.
      const tableSource = text.slice(start, bom + acceptedEnd).trimEnd();
      const lines = tableSource.split('\n');
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
      tables.push({ start, end: start + tableSource.length, rows: actual, delimiter: rows[1],
        token, writable });
      const table = tables.at(-1), originalStart = view.offsets[start];
      const receipt = originalStart === 0 || originalStart === 1 && source[0] === '\uFEFF' ||
        source[originalStart - 1] === '\n' ?
        readTable(originalStart) : null;
      if (receipt?.kind === 'refusal') {
        tables.pop();
        otherTables.push({ start, end: editorOffset(view, receipt.span.end), uncertain: true, syntax: receipt });
        cursor = text.length;
        blocks.at(-1).end = cursor;
        blocks.at(-1).raw = text.slice(start);
        break;
      }
      if (receipt?.kind === 'complete' && receipt.value.rows.length + 1 === actual.length) {
        table.syntax = receipt;
        const originalRows = [receipt.value.header, ...receipt.value.rows];
        actual.forEach((row, i) => {
          row.syntax = originalRows[i];
          row.cells.forEach((cell, c) => { cell.syntax = originalRows[i].cells[c]; });
        });
        const delimiter = table.delimiter, originalDelimiter = receipt.value.delimiter;
        delimiter.syntax = originalDelimiter;
        if (view.offsets[delimiter.start] === originalDelimiter.span.start &&
            delimiter.cells.length === originalDelimiter.cells.length &&
            delimiter.cells.every((cell, i) => {
              const { content } = originalDelimiter.cells[i];
              return view.offsets[cell.start] === content.start && view.offsets[cell.end] === content.end;
            })) {
          delimiter.cells.forEach((cell, i) => { cell.syntax = originalDelimiter.cells[i]; });
        }
      }
    }
    gapTo(text.length);
    return { source, view, syntax, tables, otherTables, blocks, links };
  }

  function editorOffset(view, original) {
    let low = 0, high = view.offsets.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2), value = view.offsets[middle];
      if (value === original) return middle;
      if (value < original) low = middle + 1;
      else high = middle - 1;
    }
    fail('tableCells.mapping');
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
    if (logicalOperation(target, edits)) {
      return replaceLogical(target, edits, null, null, marked, protect);
    }
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

  function cellSource(text, existingRaw = false) {
    if (typeof text !== 'string') fail('tableCells.invalid');
    // The literal popup validates its envelope; ordinary one-line Markdown may begin with backticks.
    const receipt = existingRaw || /[\r\n]/.test(text) ?
      window.MarkalooTableSource.readCell({ text, space: 'editor' }) : null;
    if (receipt?.kind === 'literal') {
      const error = new Error('tableCells.invalid');
      error.diagnostic = receipt.diagnostic;
      throw error;
    }
    if (receipt?.kind === 'complete') {
      return { raw: true, source: text.slice(receipt.value.slot.start, receipt.value.slot.end),
        text: normalise(text.slice(receipt.value.content.start, receipt.value.content.end)) };
    }
    if (!validCellSource(text)) fail('tableCells.invalid');
    return { raw: false, source: text, text: text.trim().replace(/\\\|/g, '|') };
  }

  function logicalOperation(target, edits = [], order = []) {
    if (!Array.isArray(edits)) fail('tableCells.invalid');
    return !!target?.table?.syntax?.value?.hasRaw ||
      edits.some(edit => cellSource(edit?.text).raw) ||
      (order || []).some(entry => Array.isArray(entry?.cells) && entry.cells.some(text => cellSource(text).raw));
  }

  function validateLogicalTarget(target) {
    const { model, table, rows } = target || {};
    if (!model?.tables.includes(table) || !table.writable || table.syntax?.kind !== 'complete' ||
        table.syntax.input !== model.syntax || model.syntax.text !== model.source ||
        !Array.isArray(rows) || !rows.length || new Set(rows).size !== rows.length ||
        rows.some(row => !table.rows.includes(row) || !row.syntax ||
          row.cells.some((cell, i) => cell.syntax !== row.syntax.cells[i]))) fail('tableCells.invalid');
  }

  function sourceEnding(model, row) {
    const span = row.syntax.ending;
    return model.source.slice(span.start, span.end) || model.source.match(/\r\n|\r|\n/)?.[0] || '\n';
  }

  function validateLogicalAdoption(target, candidate, expected, alignment, marked, protect) {
    const { model, table } = target, checked = index(candidate, marked, protect);
    const actual = checked.tables[model.tables.indexOf(table)], before = table.syntax.value;
    if (!actual?.writable || actual.start !== table.start ||
        checked.tables.length !== model.tables.length ||
        JSON.stringify(actual.rows.map(row => row.cells.map(cell => cell.text))) !== JSON.stringify(expected) ||
        JSON.stringify(actual.token.align) !== JSON.stringify(alignment) ||
        actual.syntax?.input !== checked.syntax) fail('tableCells.invalid');
    const after = actual.syntax.value;
    if (candidate.slice(0, after.span.start) !== model.source.slice(0, before.span.start) ||
        candidate.slice(after.ending.end) !== model.source.slice(before.ending.end)) fail('tableCells.invalid');
    const delta = checked.view.text.length - model.view.text.length;
    const unchanged = (old, current) => old.length === current.length && old.every((item, i) => {
      const other = current[i], shift = item.start > table.start ? delta : 0;
      return other && other.start === item.start + shift && other.end === item.end + shift &&
        other.kind === item.kind && other.uncertain === item.uncertain &&
        checked.view.text.slice(other.start, other.end) === model.view.text.slice(item.start, item.end);
    });
    const outsideBlocks = (value, item) => value.blocks.filter(block => block.type !== 'space' &&
      (block.end <= item.start || block.start > item.end)).map(block => [block.type, block.raw]);
    if (!unchanged(model.tables.filter(item => item !== table), checked.tables.filter(item => item !== actual)) ||
        !unchanged(model.otherTables, checked.otherTables) ||
        JSON.stringify(outsideBlocks(model, table)) !== JSON.stringify(outsideBlocks(checked, actual))) {
      fail('tableCells.invalid');
    }
    return candidate;
  }

  function replaceLogical(target, edits, order, columns, marked, protect, deletedRows = [], deletedColumns = []) {
    validateLogicalTarget(target);
    const { model, table, rows } = target;
    if (!Array.isArray(edits) || !Array.isArray(deletedRows) || !Array.isArray(deletedColumns)) {
      fail('tableCells.invalid');
    }
    const deleted = new Set(deletedRows), edited = new Map(), width = table.rows[0].cells.length;
    if (deleted.size !== deletedRows.length || deletedRows.some(row => !rows.includes(row) || row === table.rows[0])) {
      fail('tableCells.invalid');
    }
    for (const edit of edits) {
      if (!edit || !rows.some(row => !deleted.has(row) && row.cells.includes(edit.cell)) || edited.has(edit.cell)) {
        fail('tableCells.invalid');
      }
      edited.set(edit.cell, cellSource(edit.text, edit.cell.syntax.kind === 'raw'));
    }
    const first = order ? table.rows.indexOf(rows[0]) : 0, last = first + rows.length - 1;
    if (order && (rows.some((row, i) => row !== table.rows[first + i]) || !Array.isArray(order))) {
      fail('tableCells.invalid');
    }
    const retained = new Set(), ids = new Set();
    const entries = order || table.rows.map(original => ({ original }));
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') fail('tableCells.invalid');
      if (entry.original) {
        if (!(order ? rows : table.rows).includes(entry.original) ||
            deleted.has(entry.original) || retained.has(entry.original)) fail('tableCells.invalid');
        retained.add(entry.original);
      } else {
        if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || !Array.isArray(entry.cells)) {
          fail('tableCells.invalid');
        }
        ids.add(entry.id);
      }
    }
    if (order && (retained.size !== rows.length - deleted.size ||
        first === 0 && entries[0]?.original !== table.rows[0])) fail('tableCells.invalid');
    let projected = Array.from({ length: width }, (_, originalIndex) => ({ originalIndex }));
    const removed = new Set(deletedColumns);
    if (columns) {
      if (!columns.length || removed.size !== deletedColumns.length ||
          deletedColumns.some(column => !Number.isSafeInteger(column) || column < 0 || column >= width)) {
        fail('tableCells.invalid');
      }
      const names = new Set(), originals = new Set();
      for (const column of columns) {
        if (!column || typeof column.id !== 'string' || !column.id || names.has(column.id)) fail('tableCells.invalid');
        names.add(column.id);
        if (column.originalIndex !== undefined) {
          const at = column.originalIndex;
          if (!Number.isSafeInteger(at) || at < 0 || at >= width || removed.has(at) || originals.has(at)) {
            fail('tableCells.invalid');
          }
          originals.add(at);
        }
      }
      if (originals.size + removed.size !== width || edits.some(edit =>
        table.rows.some(row => row.cells.some((cell, c) => cell === edit.cell && removed.has(c))))) {
        fail('tableCells.invalid');
      }
      projected = columns;
    } else if (removed.size) fail('tableCells.invalid');
    const columnChange = projected.length !== width ||
      projected.some((column, i) => column.originalIndex !== i);
    if (columnChange) {
      const { delimiter } = table;
      if (delimiter.syntax !== table.syntax.value.delimiter || delimiter.cells.length !== width ||
          delimiter.cells.some((cell, i) => cell.syntax !== delimiter.syntax.cells[i])) fail('tableCells.invalid');
    }
    const originalText = cell => cell.syntax.kind === 'raw' ?
      normalise(model.source.slice(cell.syntax.content.start, cell.syntax.content.end)) : cell.text;
    const values = entry => {
      if (entry.cells !== undefined &&
          (!Array.isArray(entry.cells) || entry.cells.length !== projected.length)) fail('tableCells.invalid');
      return projected.map((column, at) => {
        const cell = entry.original?.cells[column.originalIndex];
        const value = cell ? edited.get(cell) || { raw: cell.syntax.kind === 'raw',
          source: model.source.slice(cell.syntax.content.start, cell.syntax.content.end), text: originalText(cell) } :
          cellSource(entry.cells?.[at]);
        if (entry.cells && cellSource(entry.cells[at], cell?.syntax.kind === 'raw').text !== value.text) {
          fail('tableCells.invalid');
        }
        return value;
      });
    };
    const expectedRows = entries.map(values);
    const body = (row, entryValues, delimiter = false) => {
      if (!row) return '| ' + entryValues.map(value => value.source).join(' | ') + ' |';
      const receipt = row.syntax;
      if (!receipt || receipt.cells.length !== width) fail('tableCells.invalid');
      if (!columnChange) {
        let cursor = receipt.span.start, text = '';
        row.cells.forEach((cell, i) => {
          const changed = delimiter ? null : edited.get(cell);
          if (!changed) return;
          text += model.source.slice(cursor, cell.syntax.content.start) + entryValues[i].source;
          cursor = cell.syntax.content.end;
        });
        text += model.source.slice(cursor, receipt.span.end);
        if (entryValues.some(value => value.raw)) {
          if (!receipt.leadingPipe) text = '|' + text;
          if (!receipt.trailingPipe) text += (/\\$/.test(text) ? ' ' : '') + '|';
        }
        return text;
      }
      const slots = projected.map((column, at) => {
        const cell = row.cells[column.originalIndex], value = entryValues[at];
        if (!cell) return ' ' + value.source + ' ';
        const span = cell.syntax;
        if (delimiter || !edited.has(cell)) return model.source.slice(span.slot.start, span.slot.end);
        return model.source.slice(span.slot.start, span.content.start) + value.source +
          model.source.slice(span.content.end, span.slot.end);
      });
      let leading = model.source.slice(receipt.span.start, receipt.cells[0].slot.start);
      let trailing = model.source.slice(receipt.cells.at(-1).slot.end, receipt.span.end);
      const raw = entryValues.some(value => value.raw);
      if (!leading && (raw || projected.length === 1 || !entryValues[0].text ||
          projected[0].originalIndex !== 0)) leading = '|';
      if (!trailing && (raw || projected.length === 1 || !entryValues.at(-1).text ||
          projected.at(-1).originalIndex !== width - 1)) {
        trailing = (/\\$/.test(slots.at(-1)) ? ' ' : '') + '|';
      }
      return leading + slots.join('|') + trailing;
    };
    const headerValues = projected.map(column => ({ raw: false,
      source: column.originalIndex === undefined ? '---' : table.delimiter.cells[column.originalIndex].text,
      text: column.originalIndex === undefined ? '---' : table.delimiter.cells[column.originalIndex].text }));
    const allEntries = order ? [...table.rows.slice(0, first).map(original => ({ original })),
      ...entries, ...table.rows.slice(last + 1).map(original => ({ original }))] : entries;
    const selectedOriginals = entries.filter(entry => entry.original).map(entry => entry.original);
    const reordered = !!order && selectedOriginals.some((row, i) =>
      row !== rows.filter(value => !deleted.has(value))[i]);
    const final = order ? (rows.at(-1) === table.rows[0] ? table.delimiter : rows.at(-1)) :
      (table.rows.at(-1) === table.rows[0] ? table.delimiter : table.rows.at(-1));
    const start = order ? rows[0].syntax.span.start : table.syntax.value.span.start;
    const end = final.syntax.ending.end, terminated = final.syntax.ending.end > final.syntax.ending.start;
    const pieces = [model.source.slice(0, start)];
    entries.forEach((entry, i) => {
      pieces.push(body(entry.original, expectedRows[i]));
      let physical = entry.original;
      if (entry.original === table.rows[0]) {
        pieces.push(model.source.slice(entry.original.syntax.ending.start, entry.original.syntax.ending.end));
        pieces.push(body(table.delimiter, headerValues, true));
        physical = table.delimiter;
      }
      const slot = reordered ? rows[Math.min(i, rows.length - 1)] : physical;
      const boundary = slot === table.rows[0] ? table.delimiter : slot;
      const ending = boundary ? model.source.slice(boundary.syntax.ending.start, boundary.syntax.ending.end) : '';
      const needsEnding = i < entries.length - 1 || terminated;
      pieces.push(needsEnding ? ending || sourceEnding(model, physical || rows[0]) : '');
    });
    pieces.push(model.source.slice(end));
    const expected = allEntries.map(entry => {
      const at = entries.indexOf(entry);
      return at >= 0 ? expectedRows[at].map(value => value.text) :
        entry.original.cells.map(originalText);
    });
    return validateLogicalAdoption(target, pieces.join(''), expected, projected.map(column =>
      column.originalIndex === undefined ? null : table.token.align[column.originalIndex]), marked, protect);
  }

  function insertTable(model, offset, rows, marked, protect, mode) {
    validateMode(mode);
    if (mode !== Mode.INSERT) fail('tableCells.mode');
    if (!Array.isArray(model?.tables) || !Array.isArray(model?.otherTables) ||
        !Array.isArray(model?.blocks) || !Number.isSafeInteger(offset) ||
        offset < 0 || offset > model.view.text.length || !Array.isArray(rows) ||
        !rows.length || !Array.isArray(rows[0]) || !rows[0].length ||
        rows.some(row => !Array.isArray(row) || row.length !== rows[0].length)) fail('tableCells.invalid');
    const values = rows.map(row => row.map(text => cellSource(text)));
    const lines = values.map(row => '| ' + row.map(value => normalise(value.source)).join(' | ') + ' |');
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
    const expected = values.map(row => row.map(value => value.text));
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
          !['table', 'markalooRawTable'].includes(item.type) || item.start !== start))) ||
        model.source.startsWith('\uFEFF') && !source.startsWith('\uFEFF')) {
      fail('tableCells.insertPosition');
    }
    return { source, cursor: offset + replacement.length };
  }

  function replaceRows(target, edits, order, marked, protect, deletedRows = []) {
    validateUpdateMode(target?.mode);
    if (!Array.isArray(order) || !Array.isArray(deletedRows)) fail('tableCells.invalid');
    if (logicalOperation(target, edits, order)) {
      if (!deletedRows.length && order.length === target.rows.length &&
          order.every((entry, i) => entry?.original === target.rows[i])) {
        return replaceLogical(target, edits, null, null, marked, protect);
      }
      return replaceLogical(target, edits, order, null, marked, protect, deletedRows);
    }
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
    const retained = new Set();
    for (const entry of order) {
      if (!entry || typeof entry !== 'object') fail('tableCells.invalid');
      if (entry.original) {
        if (!rows.includes(entry.original) || deleted.has(entry.original) || retained.has(entry.original)) {
          fail('tableCells.invalid');
        }
        retained.add(entry.original);
      } else {
        if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
            !Array.isArray(entry.cells) || entry.cells.length !== table.rows[0].cells.length) fail('tableCells.invalid');
        for (const text of entry.cells) if (!validCellSource(text)) fail('tableCells.invalid');
        ids.add(entry.id);
      }
    }
    if (retained.size !== rows.length - deleted.size ||
        first === 0 && order[0]?.original !== table.rows[0]) {
      fail('tableCells.invalid');
    }
    const originals = order.filter(entry => entry.original).map(entry => entry.original);
    const expectedOriginals = rows.filter(row => !deleted.has(row));
    const reordered = originals.some((row, i) => row !== expectedOriginals[i]);
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
        if (!separated) chunks.push(endingAt(row.start));
        let cursor = view.offsets[row.start];
        for (const cell of row.cells) {
          if (!edited.has(cell)) continue;
          const start = view.offsets[cell.start], finish = view.offsets[cell.end];
          if (start < cursor || finish < start) fail('tableCells.invalid');
          chunks.push(source.slice(cursor, start), edited.get(cell));
          cursor = finish;
        }
        const physical = row === table.rows[0] ? table.delimiter : row;
        const finish = reordered ? physicalEnd(physical) : afterLine(physical);
        chunks.push(source.slice(cursor, view.offsets[finish]));
        separated = view.text[finish - 1] === '\n';
        if (reordered && (i < order.length - 1 || terminated)) {
          // Separators belong to destination slots, including an unterminated EOF.
          const slot = rows[Math.min(i, rows.length - 1)];
          chunks.push(endingAt(physicalEnd(slot === table.rows[0] ? table.delimiter : slot)));
          separated = true;
        }
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
    if (logicalOperation(target, edits, order)) {
      if (!Array.isArray(order) || !Array.isArray(columns) || !Array.isArray(target.rows) ||
          target.rows.length !== target.table.rows.length ||
          target.rows.some((row, i) => row !== target.table.rows[i]) ||
          order.some(entry => !Array.isArray(entry?.cells))) fail('tableCells.invalid');
      return replaceLogical(target, edits, order, columns, marked, protect, deletedRows, deletedColumns);
    }
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
        if (!Number.isSafeInteger(original) || original < 0 || original >= count || positions[original] !== null ||
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
    const reordered = columns.some((column, i) => column.originalIndex !== undefined &&
      columns.slice(0, i).some(before => before.originalIndex > column.originalIndex));
    const changed = deleted.size > 0 || columns.some(column => column.originalIndex === undefined) || reordered;
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
          layout.cells.some((cell, i) => cell.start !== row.cells[i]?.start ||
            cell.end !== row.cells[i].end || cell.text !== row.cells[i].text)) fail('tableCells.invalid');
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
      if (reordered) {
        const remaining = lineLayout(line, 0), survivors = owners.filter(owner => !deleted.has(owner.original));
        if (remaining.slots.length !== survivors.length) fail('tableCells.invalid');
        const slots = new Map(survivors.map((owner, i) => [owner.position,
          line.slice(remaining.slots[i].rawStart, remaining.slots[i].rawEnd)]));
        const ordered = columns.map((_column, position) => {
          const raw = slots.get(position);
          if (typeof raw !== 'string') fail('tableCells.invalid');
          return raw + (/\\*$/.exec(raw)[0].length % 2 ? ' ' : '');
        });
        // Explicit outer pipes keep moved empty or backslash-ending edge cells structural.
        line = line.slice(0, indent) + '|' + ordered.join('|') + '|' +
          (remaining.trailingPipe === null ? '' : line.slice(remaining.trailingPipe + 1));
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
