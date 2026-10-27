"use strict";

// Source offsets remain UTF-16, like textarea selections and DOM ranges.
window.FoliaTableCells = (() => {
  const normalise = text => text.replace(/\r\n?/g, '\n');
  const fail = key => { throw new Error(key); };

  function sourceView(source) {
    const offsets = [];
    let text = '';
    for (let i = 0; i < source.length; i++) {
      offsets.push(i);
      if (source[i] === '\r') {
        text += '\n';
        if (source[i + 1] === '\n') i++;
      } else text += source[i];
    }
    offsets.push(source.length);
    return { text, offsets };
  }

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

  function projectContainer(raw, text, start) {
    const lines = raw.split('\n'), children = text.split('\n'), offsets = [];
    let cursor = start;
    for (let i = 0; i < children.length; i++) {
      const line = lines[i], child = children[i];
      if (line === undefined || !line.endsWith(child)) return null;
      const from = cursor + line.length - child.length;
      for (let j = 0; j < child.length; j++) offsets.push(from + j);
      if (i < children.length - 1) offsets.push(cursor + line.length);
      cursor += line.length + 1;
    }
    if (lines.slice(children.length).some(line => line.trim())) return null;
    offsets.push(cursor - 1);
    return offsets;
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

  function spliceInput(source, start, end, inserted) {
    const view = sourceView(source);
    if (!Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end < start || end > view.text.length) fail('tableCells.invalid');
    const from = view.offsets[start], to = view.offsets[end];
    const before = source.slice(0, from), after = source.slice(to);
    const ending = before.match(/\r\n|\r|\n/g)?.at(-1) || after.match(/\r\n|\r|\n/)?.[0] || '\n';
    return before + normalise(inserted).replace(/\n/g, ending) + after;
  }

  // Only edited cells are serialized. Original Markdown spelling belongs to
  // unchanged cells; HTML entities keep new text inert inside Markdown tables.
  const cellPartAttribute = 'data-folia-cell-part';
  const inlineTags = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'DEL', 'S', 'CODE', 'SPAN',
    'SUB', 'SUP', 'BR', 'IMG', 'KBD', 'MARK', 'U', 'SMALL', 'ABBR', 'Q', 'CITE']);
  const inlineAttributes = ['href', 'src', 'alt', 'title', 'style', 'class', 'width', 'height',
    'data-note-id', 'data-note-title', 'data-note-content', 'data-note-color'];

  function expandCellText(text, transform) {
    const replacements = [];
    let delta = 0;
    const expanded = transform(text, (alias, glyph, sourceStart) => {
      const start = sourceStart - delta;
      replacements.push({ start, end: start + glyph.length, sourceStart, sourceEnd: sourceStart + alias.length, alias });
      delta += alias.length - glyph.length;
    });
    const sourceOffset = offset => {
      let adjustment = 0;
      for (const replacement of replacements) {
        if (offset <= replacement.start) break;
        if (offset < replacement.end) fail('tableCells.cellType');
        adjustment += replacement.sourceEnd - replacement.sourceStart - replacement.end + replacement.start;
      }
      return offset + adjustment;
    };
    return { expanded, replacements, sourceOffset };
  }

  function prepareCell(element, text, raw, marked, links, transform, sanitize, captureContext) {
    const fragments = new Map(), namespace = crypto.randomUUID(), stack = [];
    const source = raw.toLowerCase();
    const privateAttribute = name => {
      let candidate = name;
      while (source.includes(candidate)) candidate = name + '-' + crypto.randomUUID();
      return candidate;
    };
    // Authored data attributes remain source. Generated fragments share their
    // cell's collision-free metadata names, including native history markers.
    const cellPartAttribute = captureContext?.partAttribute || privateAttribute('data-folia-cell-part');
    const codeAttribute = captureContext?.codeAttribute || privateAttribute('data-folia-cell-code');
    const { expanded, replacements, sourceOffset } = expandCellText(text, transform);
    const ranges = new WeakMap(), bodies = new WeakMap();
    const locate = (tokens, source, offsets) => {
      let cursor = 0;
      for (const token of tokens) {
        if (source.slice(cursor, cursor + token.raw.length) !== token.raw) fail('tableCells.cellType');
        const positions = offsets.slice(cursor, cursor + token.raw.length + 1);
        ranges.set(token, positions);
        if (token.tokens) {
          let from = 0;
          if (['strong', 'em', 'del'].includes(token.type)) from = (token.raw.length - token.text.length) / 2;
          else if (token.type === 'link' || token.type === 'image') {
            from = token.raw.startsWith('![') ? 2 : /^[<[]/.test(token.raw) ? 1 : 0;
          }
          const childOffsets = [positions[from]];
          let at = from;
          for (const char of token.text) {
            if (['link', 'image'].includes(token.type) && token.raw[at] === '\\' &&
                /[[\]]/.test(token.raw[at + 1]) && char === token.raw[at + 1]) at++;
            if (token.raw.slice(at, at + char.length) !== char) fail('tableCells.cellType');
            for (let i = 0; i < char.length; i++) childOffsets.push(positions[++at]);
          }
          bodies.set(token, { offsets: childOffsets, prefix: from });
          locate(token.tokens, token.text, childOffsets);
        }
        cursor += token.raw.length;
      }
      if (cursor !== source.length) fail('tableCells.cellType');
    };
    const renderer = new marked.Renderer();
    const tableEscape = value => value.replace(/\|/g, '\\|');
    const register = fragment => {
      const id = namespace + '-' + fragments.size;
      fragment.origin = namespace;
      fragments.set(id, fragment);
      return id;
    };
    const sourceRange = (positions, from = 0, to = positions.length - 1) =>
      ({ sourceStart: sourceOffset(positions[from]), sourceEnd: sourceOffset(positions[to]) });
    const textUnits = (value, positions) => {
      const units = [];
      let from = 0;
      for (const char of value) {
        const range = sourceRange(positions, from, from + char.length);
        const original = text.slice(range.sourceStart, range.sourceEnd);
        units.push({ from, to: from + char.length, ...range, raw: tableEscape(original),
          atomic: original !== char });
        from += char.length;
      }
      if (units.map(unit => unit.raw).join('') !==
          tableEscape(text.slice(sourceOffset(positions[0]), sourceOffset(positions.at(-1))))) fail('tableCells.cellType');
      return units;
    };
    const original = token => {
      const positions = ranges.get(token);
      return tableEscape(text.slice(sourceOffset(positions[0]), sourceOffset(positions.at(-1))));
    };
    const appendText = (node, value, positions) => {
      let at = 0;
      for (const replacement of replacements) {
        const from = positions.indexOf(replacement.start), to = positions.indexOf(replacement.end);
        if (from < 0 || to < 0) continue;
        node.append(document.createTextNode(value.slice(at, from)));
        const emoji = document.createElement('span');
        emoji.textContent = value.slice(from, to);
        emoji.setAttribute(cellPartAttribute, register({ kind: 'emoji', raw: replacement.alias,
          sourceStart: replacement.sourceStart, sourceEnd: replacement.sourceEnd }));
        node.append(emoji);
        at = to;
      }
      node.append(document.createTextNode(value.slice(at)));
    };
    for (const kind of ['codespan', 'strong', 'em', 'del', 'link', 'image', 'br', 'text']) {
      const render = renderer[kind];
      renderer[kind] = function (token) {
        const html = document.createElement('div');
        html.innerHTML = render.call(this, token);
        let node = html.firstElementChild;
        if (kind === 'text') {
          node = document.createElement('span');
          if (token.type === 'text' && !token.tokens) {
            const positions = ranges.get(token);
            const atoms = [];
            for (const match of token.text.matchAll(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi)) {
              atoms.push({ from: match.index, to: match.index + match[0].length, kind: 'escape',
                ...sourceRange(positions, match.index, match.index + match[0].length),
                raw: tableEscape(text.slice(sourceOffset(positions[match.index]),
                  sourceOffset(positions[match.index + match[0].length]))) });
            }
            for (const replacement of replacements) {
              const from = positions.indexOf(replacement.start), to = positions.indexOf(replacement.end);
              if (from >= 0 && to >= 0) atoms.push({ from, to, kind: 'emoji', raw: replacement.alias,
                sourceStart: replacement.sourceStart, sourceEnd: replacement.sourceEnd });
            }
            for (let at = 0; at < token.text.length; at++) {
              if (!/[[\]]/.test(token.text[at])) continue;
              const range = sourceRange(positions, at, at + 1);
              const raw = text.slice(range.sourceStart, range.sourceEnd);
              if (raw === '\\' + token.text[at] && !atoms.some(atom => atom.from <= at && at < atom.to)) {
                atoms.push({ from: at, to: at + 1, kind: 'escape', raw, ...range });
              }
            }
            atoms.sort((a, b) => a.from - b.from);
            const appendPlain = (from, to) => {
              if (from === to) return;
              const plain = document.createElement('span');
              plain.innerHTML = render.call(this, { ...token, text: token.text.slice(from, to) });
              if (atoms.length) {
                plain.setAttribute(cellPartAttribute, register({ kind: 'text',
                  ...sourceRange(positions, from, to),
                  units: textUnits(plain.textContent, positions.slice(from, to + 1)),
                  raw: tableEscape(text.slice(sourceOffset(positions[from]), sourceOffset(positions[to]))) }));
                node.append(plain);
              } else node.append(...plain.childNodes);
            };
            let at = 0;
            for (const atom of atoms) {
              appendPlain(at, atom.from);
              const captured = document.createElement('span');
              captured.innerHTML = render.call(this, { ...token, text: token.text.slice(atom.from, atom.to) });
              captured.setAttribute(cellPartAttribute, register({ kind: atom.kind, raw: atom.raw,
                sourceStart: atom.sourceStart, sourceEnd: atom.sourceEnd }));
              node.append(captured);
              at = atom.to;
            }
            appendPlain(at, token.text.length);
          } else node.append(...html.childNodes);
          html.replaceChildren(node);
        } else if (!node || html.childNodes.length !== 1) fail('tableCells.cellType');
        if (kind === 'codespan') {
          const edge = /^`+/.exec(token.raw)[0].length;
          const from = edge + (token.raw.length - 2 * edge - token.text.length) / 2;
          node.replaceChildren();
          appendText(node, token.text, ranges.get(token).slice(from, from + token.text.length + 1));
        }
        const body = bodies.get(token);
        node.setAttribute(cellPartAttribute, register({
          kind: kind === 'text' && token.type === 'escape' ? 'escape' : kind,
          raw: original(token),
          ...sourceRange(ranges.get(token)),
          ...(body ? { bodyOffset: body.prefix, bodyRange: sourceRange(body.offsets),
            delimiter: ['strong', 'em', 'del'].includes(kind) ? token.raw.slice(0, body.prefix) : undefined } : {}),
          ...(kind === 'text' && token.type === 'text' && !node.children.length
            ? { units: textUnits(node.textContent, ranges.get(token)) } : {}),
        }));
        return html.innerHTML;
      };
    }
    renderer.html = token => {
      if (/^<!--[\s\S]*-->$/.test(token.text)) {
        return '<span ' + cellPartAttribute + '="' + register({ kind: 'comment', raw: original(token),
          ...sourceRange(ranges.get(token)) }) + '"></span>';
      }
      const opening = /^<([a-z][\w-]*)\b/i.exec(token.text);
      const closing = /^<\/([a-z][\w-]*)\s*>$/i.exec(token.text);
      if (closing) {
        const fragment = stack.pop();
        if (!fragment || fragment.tag !== closing[1].toUpperCase()) fail('tableCells.cellType');
        fragment.closing = original(token);
        fragment.closingRange = sourceRange(ranges.get(token));
        return token.text;
      }
      if (!opening || !inlineTags.has(opening[1].toUpperCase())) fail('tableCells.cellType');
      const fragment = { kind: 'html', tag: opening[1].toUpperCase(),
        opening: original(token), closing: '', openingRange: sourceRange(ranges.get(token)) };
      const id = register(fragment);
      if (!['BR', 'IMG'].includes(fragment.tag)) stack.push(fragment);
      const end = token.text.lastIndexOf('>');
      return token.text.slice(0, end).replace(/\/\s*$/, '') +
        ' ' + cellPartAttribute + '="' + id + '">';
    };
    const inlineTokens = source => {
      const lexer = new marked.Lexer({ ...marked.defaults, tokenizer: null });
      lexer.tokens.links = links;
      return lexer.inlineTokens(source);
    };
    const tokens = inlineTokens(expanded);
    locate(tokens, expanded, Array.from({ length: expanded.length + 1 }, (_, index) => index));
    element.innerHTML = sanitize(marked.Parser.parseInline(tokens, { ...marked.defaults, renderer }));
    if (stack.length) fail('tableCells.cellType');
    const attributes = node => [...node.attributes].filter(attr =>
      attr.name !== cellPartAttribute && attr.name !== codeAttribute)
      .map(attr => [attr.name, attr.value]);
    for (const node of element.querySelectorAll('[' + cellPartAttribute + ']')) {
      const fragment = fragments.get(node.getAttribute(cellPartAttribute));
      if (!fragment || fragment.initial !== undefined) fail('tableCells.cellType');
      fragment.initial = node.outerHTML;
      fragment.initialText = node.textContent;
      fragment.attributes = JSON.stringify(attributes(node));
      if (['text', 'escape', 'emoji'].includes(fragment.kind) && !node.children.length && !fragment.units) {
        fragment.units = [{ from: 0, to: fragment.initialText.length, raw: fragment.raw, atomic: true,
          sourceStart: fragment.sourceStart, sourceEnd: fragment.sourceEnd }];
      }
    }
    if ([...fragments.values()].some(fragment => fragment.initial === undefined)) fail('tableCells.cellType');
    const rules = new marked.Lexer({ ...marked.defaults, tokenizer: null }).tokenizer.rules;
    const delimiterRules = rules.inline;
    const repairSource = (source, pieces, seams, normalized = false, orientation) => {
      let input = '';
      const offsets = [0];
      for (let i = 0; i < source.length; i++) {
        if (source[i] === '\\' && source[i + 1] === '|') i++;
        input += source[i];
        offsets.push(i + 1);
      }
      const expandedText = expandCellText(input, transform);
      const { expanded, replacements } = expandedText;
      const sourceOffset = offset => offsets[expandedText.sourceOffset(offset)];
      const sites = new Set(), normalize = new Set(), missing = new Set(), tokens = [];
      const owners = new Int32Array(source.length);
      pieces.forEach((piece, index) => owners.fill(index, piece.start, piece.end));
      const crossesSeam = (from, to) => seams.some(seam => from <= seam && seam <= to);
      const unprotected = at => at >= 0 && at < source.length && !pieces[owners[at]].protected;
      const addSites = candidates => {
        for (const at of candidates) if (unprotected(at)) sites.add(at);
      };
      const frames = pieces.filter(piece =>
        ['strong', 'em', 'del'].includes(piece.tokenType) && piece.children).map(piece => ({
          ...piece, bodyStart: piece.start + piece.bodyOffset,
          bodyEnd: piece.start + piece.bodyOffset + piece.children.reduce((size, child) => size + child.source.length, 0),
        }));
      // Rewriting one family in a fully wrapped nest can reverse EM/STRONG
      // ownership when its delimiters combine with the other family's run.
      const retainDelimiters = new Set(frames.filter(frame => frames.some(other => other !== frame &&
        ((frame.bodyStart === other.start && frame.bodyEnd === other.end) ||
          (other.bodyStart === frame.start && other.bodyEnd === frame.end)))).map(frame => frame.owner));
      const before = at => at > 1 && /[\uDC00-\uDFFF]/.test(source[at - 1]) &&
        /[\uD800-\uDBFF]/.test(source[at - 2]) ? at - 2 : at - 1;
      const character = at => at < 0 || at >= source.length ? '' : String.fromCodePoint(source.codePointAt(at));
      const contains = (parent, child) => parent.start < child.start && child.end < parent.end;
      const repairEdge = (piece, closing) => {
        let outer = frames.find(frame => frame.start === piece.start && frame.owner === piece.owner), parent;
        if (!outer) return;
        while ((parent = frames.find(frame => contains(frame, outer) &&
            (closing ? frame.bodyEnd === outer.end : frame.bodyStart === outer.start)))) outer = parent;
        let inner = outer, child;
        while ((child = frames.find(frame => contains(inner, frame) && source[frame.start] === source[outer.start] &&
            (closing ? frame.end === inner.bodyEnd : frame.start === inner.bodyStart)))) inner = child;
        const inside = closing ? before(inner.bodyEnd) : inner.bodyStart;
        const outside = closing ? outer.end : before(outer.start);
        const innerChar = character(inside), outerChar = character(outside);
        if (!innerChar || !outerChar || delimiterRules.punctuation.test(outerChar)) return;
        // Nested owners can share one lexical delimiter run. Mixed markers
        // remain separate runs; only Marked decides whether the result parses.
        const run = closing ? source.slice(inner.bodyEnd, outer.end) : source.slice(outer.start, inner.bodyStart);
        const rule = outer.tokenType === 'del' ? delimiterRules.delLDelim : delimiterRules.emStrongLDelim;
        const match = rule.exec(run + innerChar);
        const intraword = source[outer.start] === '_' && rules.other.unicodeAlphaNumeric.test(outerChar);
        if (!(match?.[1] || match?.[3] || intraword)) return;
        if (unprotected(outside) && (outerChar.length === 1 || unprotected(outside + 1))) sites.add(outside);
      };
      for (const item of replacements) {
        const from = offsets[item.sourceStart], to = offsets[item.sourceEnd];
        if (crossesSeam(from, to)) {
          const candidates = [from, to - 1].filter(at => source[at] === ':' && unprotected(at));
          if (candidates.length) sites.add(candidates[0]);
        }
      }
      const parsed = inlineTokens(expanded);
      locate(parsed, expanded, Array.from({ length: expanded.length + 1 }, (_, index) => index));
      const collect = list => {
        for (const token of list) {
          const positions = ranges.get(token).map(sourceOffset);
          tokens.push({ token, from: positions[0], to: positions.at(-1), positions });
          if (token.tokens) collect(token.tokens);
        }
      };
      collect(parsed);
      for (const { token, from, to, positions: offsets } of tokens) {
        const owner = pieces[owners[from]];
        if (token.type === 'text' || !crossesSeam(from, to) ||
            (owner?.protected && to <= owner.end)) continue;
        const positions = chars => {
          const result = [];
          for (let index = 0; index < token.raw.length; index++) {
            if (chars.includes(token.raw[index])) result.push(offsets[index]);
          }
          return result;
        };
        if (token.type === 'link' || token.type === 'image') {
          if (/^!?\[/.test(token.raw)) {
            const brackets = positions('[').filter(unprotected);
            if (brackets.length) addSites(brackets);
            else addSites(pieces.filter(piece =>
              piece.tokenType === 'link' && piece.start === from && piece.end < to &&
              source[piece.end] === '(').map(piece => piece.end));
          } else {
            const punctuation = /^(?:<?(?:https?|ftp)):\/\//i.test(token.raw) ? token.raw.indexOf(':')
              : /^www\./i.test(token.raw) ? 3
              : token.href.startsWith('mailto:') ? token.raw.indexOf('@') : -1;
            const candidates = token.raw.startsWith('<') ? positions('<') : [];
            if (punctuation !== -1) candidates.push(offsets[punctuation]);
            addSites(candidates);
          }
        } else {
          const delimiters = { escape: '\\', codespan: '`', strong: '*_', em: '*_', del: '~' }[token.type];
          if (delimiters) {
            const opening = new RegExp('^[' + delimiters.replace(/\\/g, '\\\\') + ']+').exec(token.raw)[0].length;
            const closing = token.type === 'escape' ? 0 :
              new RegExp('[' + delimiters + ']+$').exec(token.raw)[0].length;
            const closeFrom = offsets[token.raw.length - closing];
            const tail = closing && seams.some(seam => closeFrom <= seam && seam <= to);
            const begin = tail ? closeFrom : from;
            const end = tail ? to : offsets[opening];
            addSites(positions(delimiters).filter(at => begin <= at && at < end));
          } else if (token.type === 'br' || token.type === 'html') {
            addSites(positions(token.type === 'br' ? '\r\n' : '<>:@.[\\`*_'));
          }
        }
      }
      for (const piece of pieces) {
        if (!piece.tokenType || tokens.some(item => item.from === piece.start &&
            item.to === piece.end && item.token.type === piece.tokenType)) continue;
        missing.add(piece.owner);
        if (tokens.some(item => item.from < piece.end && piece.start < item.to &&
            [...sites].some(site => item.from <= site && site < item.to))) continue;
        normalize.add(piece.owner);
        if (!normalized || !['strong', 'em', 'del'].includes(piece.tokenType) || !piece.children) continue;
        repairEdge(piece, false);
        repairEdge(piece, true);
      }
      const delimiters = new Map();
      if (orientation !== undefined) {
        // Plan an entire touching sibling group so changing one marker cannot
        // move the collision to its other edge. Retained nests anchor the plan.
        const parents = new Map();
        for (const frame of frames.filter(frame => ['em', 'strong'].includes(frame.tokenType))) {
          if (!parents.has(frame.parent)) parents.set(frame.parent, []);
          parents.get(frame.parent).push(frame);
        }
        const fixedFamily = frame => {
          let opening = '', closing = '', inner = frame;
          do {
            opening += source.slice(inner.start, inner.bodyStart);
            closing = source.slice(inner.bodyEnd, inner.end) + closing;
            inner = frames.find(child => child.parent === inner.owner &&
              child.start === inner.bodyStart && child.end === inner.bodyEnd);
          } while (inner);
          const first = /^(\*+|_+)/.exec(opening)?.[0][0];
          const last = /(\*+|_+)$/.exec(closing)?.[0][0];
          return first && first === last ? Number(first === '_') : null;
        };
        const plan = group => {
          if (!group.length) return;
          const strikeNeighbors = frames.filter(frame => frame.tokenType === 'del' &&
            frame.parent === group[0].parent &&
            (frame.end === group[0].start || frame.start === group.at(-1).end));
          const boundaries = [...group.slice(1).map(frame => frame.start), ...strikeNeighbors.map(frame =>
            frame.end === group[0].start ? frame.end : frame.start)];
          if (!boundaries.some(at => seams.includes(at)) ||
              ![...group, ...strikeNeighbors].some(frame => missing.has(frame.owner))) return;
          const fixed = group.flatMap((frame, index) => retainDelimiters.has(frame.owner)
            ? [{ index, family: fixedFamily(frame) }] : []);
          if (fixed.some(item => item.family === null)) return;
          const phase = fixed.length ? fixed[0].family ^ (fixed[0].index % 2)
            : Number(source[group[0].start] === '_') ^ orientation;
          if (fixed.some(item => (phase ^ (item.index % 2)) !== item.family)) return;
          group.forEach((frame, index) => {
            if (!retainDelimiters.has(frame.owner)) {
              delimiters.set(frame.owner, ((phase ^ (index % 2)) ? '_' : '*')
                .repeat(frame.tokenType === 'strong' ? 2 : 1));
            }
          });
        };
        for (const siblings of parents.values()) {
          let group = [];
          for (const frame of siblings) {
            if (group.length && group.at(-1).end !== frame.start) { plan(group); group = []; }
            group.push(frame);
          }
          plan(group);
        }
      }
      return { sites, normalize, retainDelimiters, delimiters };
    };
    return { fragments, raw, links, initial: element.innerHTML, attributes, transform, repairSource,
      partAttribute: cellPartAttribute, codeAttribute,
      origin: namespace, sourceLength: text.length };
  }

  const oddCodePipe = /(^|[^\\])(?:\\\\)*\\\|/;

  function markdownCode(text) {
    if (/[\r\n]/.test(text)) fail('tableCells.cellType');
    if (!text) return null;
    // GFM removes one slash before a table pipe. An odd literal slash run
    // cannot round-trip there as a code span; a semantic code tag can.
    if (oddCodePipe.test(text)) return null;
    const length = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length)) + 1;
    const delimiter = '`'.repeat(length);
    const padding = /^`|`$/.test(text) || (/^ .* $/.test(text) && /[^ ]/.test(text)) ? ' ' : '';
    return delimiter + padding + text.replace(/\|/g, '\\|') + padding + delimiter;
  }

  const encodeCellText = text => text.replace(/[&<>"'\\`*_[\]{}|~\r\n]/g,
      char => '&#' + char.charCodeAt(0) + ';');

  function cellTextPieces(node, provenance) {
    if (node.nodeType === Node.TEXT_NODE) return [{ text: node.data }];
    if (node.nodeType !== Node.ELEMENT_NODE) return [{ node }];
    const id = provenance ? node.getAttribute(provenance.partAttribute || cellPartAttribute) : null;
    const fragment = id ? provenance?.fragments.get(id) : null;
    if (id && !fragment) fail('tableCells.cellType');
    if (!['text', 'escape', 'emoji'].includes(fragment?.kind)) return [{ node }];
    if (node.tagName !== 'SPAN' ||
        JSON.stringify(provenance.attributes(node)) !== fragment.attributes) fail('tableCells.cellType');
    if (!fragment.units) return [...node.childNodes].flatMap(child => cellTextPieces(child, provenance));
    const text = node.textContent, initial = fragment.initialText;
    let prefix = 0, suffix = 0;
    while (prefix < initial.length && prefix < text.length && initial[prefix] === text[prefix]) prefix++;
    while (suffix < initial.length - prefix && suffix < text.length - prefix &&
        initial[initial.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
    const retained = [
      ...fragment.units.filter(unit => unit.to <= prefix).map(unit => ({ unit, from: unit.from, to: unit.to })),
      ...fragment.units.filter(unit => unit.from >= initial.length - suffix).map(unit =>
        ({ unit, from: text.length - initial.length + unit.from, to: text.length - initial.length + unit.to })),
    ];
    const pieces = [];
    const appendText = (from, to) => {
      let cursor = from;
      for (const item of retained) {
        if (item.from < from || item.to > to) continue;
        if (cursor < item.from) pieces.push({ text: text.slice(cursor, item.from) });
        pieces.push({ text: text.slice(item.from, item.to), raw: item.unit.raw,
          atomic: item.unit.atomic, origin: fragment.origin, kind: fragment.kind,
          from: item.unit.sourceStart, to: item.unit.sourceEnd });
        cursor = item.to;
      }
      if (cursor < to) pieces.push({ text: text.slice(cursor, to) });
    };
    let offset = 0, start = 0;
    for (const child of node.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE) {
        appendText(start, offset);
        pieces.push(...cellTextPieces(child, provenance));
        start = offset + child.textContent.length;
      }
      offset += child.textContent.length;
    }
    appendText(start, offset);
    return pieces;
  }

  function codeSources(element, provenance) {
    const pieces = [...element.childNodes].flatMap(node => cellTextPieces(node, provenance));
    const unsupported = reason => ({ kind: 'unrepresentable', reason });
    if (pieces.some(piece => piece.node)) return unsupported('structural-code-body');
    let text = '', html = '';
    for (const piece of pieces) {
      const display = piece.text.replace(/\r\n?|\n/g, ' ');
      const emoji = piece.kind === 'emoji' && piece.raw !== undefined;
      text += emoji ? piece.raw : display;
      html += emoji || (piece.kind === 'escape' && piece.raw !== undefined && display === piece.text &&
        /^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);$/i.test(piece.raw))
        ? piece.raw : encodeCellText(display);
    }
    // HTML text decodes retained entities; Markdown code intentionally does not.
    // Establish the desired display before trying either source representation.
    if (!text) return unsupported('empty-code');
    const intended = document.createElement('code');
    intended.innerHTML = provenance ? provenance.transform(html) : html;
    if (intended.children.length) return unsupported('structural-code-body');
    const markdown = markdownCode(text), htmlSource = '<code>' + html + '</code>';
    let replacedEmoji = false;
    const transformed = provenance
      ? provenance.transform(text, () => { replacedEmoji = true; }) : text;
    const result = { body: text, text: intended.textContent };
    if (oddCodePipe.test(text)) {
      return { ...result, kind: 'exception', reason: 'odd-backslash-pipe', source: htmlSource };
    }
    if (markdown !== null && transformed === intended.textContent) {
      return { ...result, kind: 'markdown', source: markdown };
    }
    if (replacedEmoji && transformed !== intended.textContent) {
      return { ...result, kind: 'exception', reason: 'literal-emoji', source: htmlSource };
    }
    return unsupported('semantic-mismatch');
  }

  function codeDelimiters(element, provenance, range, inserted = '') {
    const collect = node => cellTextPieces(node, provenance).flatMap(piece => {
      if (!piece.node) return [piece];
      return [{ boundary: piece.node, edge: 0 },
        ...(piece.node.nodeName === 'CODE' ? [{ skip: piece.node.textContent }] :
          [...piece.node.childNodes].flatMap(collect)),
        { boundary: piece.node, edge: piece.node.childNodes.length }];
    });
    const pieces = [...element.childNodes].flatMap(collect);
    const prefix = document.createRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(range.startContainer, range.startOffset);
    const text = prefix.toString(), limit = text.length, runs = [], literalTicks = [];
    let position = 0, slashes = 0, run = null, syntax = '';
    const append = (visible, raw, owner) => {
      // Literalized source ticks cannot open or close a newly recognized span.
      // This aligned parser view never supplies its content to CODE or source.
      syntax += visible === raw ? visible : visible.replace(/`/g, (tick, index) => {
        literalTicks.push({ index: position + index, origin: owner.origin, from: owner.from, to: owner.to });
        return 'x';
      });
      if (visible === raw) {
        for (let index = 0; index < visible.length; index++) {
          const char = visible[index];
          if (char === '`' && !(slashes % 2)) {
            if (run && run.index + run.length === position + index) run.length++;
            else runs.push(run = { index: position + index, length: 1 });
          } else run = null;
          slashes = char === '\\' ? slashes + 1 : 0;
        }
      } else {
        run = null;
        const trailing = /\\*$/.exec(raw)[0].length;
        slashes = trailing === raw.length ? slashes + trailing : trailing;
      }
      position += visible.length;
    };
    for (const piece of pieces) {
      if (piece.boundary) {
        if (position < limit || position === limit &&
            prefix.comparePoint(piece.boundary, piece.edge) <= 0) {
          slashes = 0;
          run = null;
        }
        continue;
      }
      if (piece.skip !== undefined) {
        if (position === limit) break;
        const visible = piece.skip.slice(0, limit - position);
        syntax += visible;
        position += visible.length;
        slashes = 0;
        run = null;
        continue;
      }
      if (!piece.text.length) continue;
      const length = Math.min(piece.text.length, limit - position);
      if (length <= 0) break;
      const raw = piece.raw ?? piece.text;
      // Capture intact atoms before slicing the proposed typing prefix.
      if (length < piece.text.length && (piece.atomic || raw !== piece.text)) {
        return { text: text + inserted, syntax: text + inserted, runs: [], literalTicks: [] };
      }
      append(piece.text.slice(0, length), length === piece.text.length ? raw : raw.slice(0, length), piece);
      if (length < piece.text.length) break;
    }
    const parent = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer : range.startContainer.parentElement;
    if (position === limit) {
      if (parent.closest('code')) syntax += inserted;
      else append(inserted, inserted);
    }
    if (syntax.length !== text.length + inserted.length) fail('tableCells.mapping');
    return { text: text + inserted, syntax, runs, literalTicks };
  }

  function serializeCell(element, provenance, escapeBoundary = false, delimiterOrientation) {
    // Sourceless serialization is a DOM comparison key, never commit authority.
    const sourceMode = !!provenance;
    const encode = encodeCellText;
    const literal = text => {
      const encoded = encode(text).replace(/((?:https?|ftp)):\/\//gi, '$1&#58;//')
        .replace(/www\./gi, 'www&#46;').replace(/@/g, '&#64;');
      const aliases = [];
      provenance?.transform(encoded, alias => aliases.push(alias));
      return aliases.reduce((value, alias) => value.replaceAll(alias, '&#58;' + alias.slice(1)), encoded);
    };
    const adjacent = (left, right) => left?.raw !== undefined && right?.raw !== undefined && left.origin !== undefined &&
      left.origin === right.origin && left.to === right.from;
    const owned = (source, fragment, node, tokenType, parts, bodyOffset = fragment?.bodyOffset) => {
      if (source === '') return [];
      if (parts) {
        const body = parts.map(piece => piece.source).join('');
        if (!Number.isInteger(bodyOffset) || source.slice(bodyOffset, bodyOffset + body.length) !== body) {
          fail('tableCells.cellType');
        }
      }
      return [{ source, raw: source, owner: node, origin: fragment?.origin,
        from: fragment?.sourceStart, to: fragment?.sourceEnd, protected: true, tokenType,
        children: parts, bodyOffset, bodyRange: fragment?.bodyRange }];
    };
    const encodeParts = (parts, sites, offset = 0) => parts.flatMap(piece => {
      const start = offset;
      offset += piece.source.length;
      if (piece.children) {
        const children = encodeParts(piece.children, sites, start + piece.bodyOffset);
        const bodyLength = piece.children.reduce((size, child) => size + child.source.length, 0);
        const source = piece.source.slice(0, piece.bodyOffset) + children.map(child => child.source).join('') +
          piece.source.slice(piece.bodyOffset + bodyLength);
        return [{ ...piece, source, raw: source, children }];
      }
      const result = [];
      const append = (from, to, source = piece.source.slice(from, to), protectedPart = piece.protected) => {
        if (from === to) return;
        const mapped = Number.isInteger(piece.from) && piece.to - piece.from === piece.source.length;
        result.push({ ...piece, source, raw: source, protected: protectedPart,
          from: mapped ? piece.from + from : undefined, to: mapped ? piece.from + to : undefined });
      };
      let from = 0;
      for (let at = 0; at < piece.source.length; at++) {
        if (!sites.has(start + at)) continue;
        if (piece.protected) fail('tableCells.cellType');
        append(from, at);
        append(at, at + 1, '&#' + piece.source.charCodeAt(at) + ';', true);
        from = at + 1;
      }
      if (!from) return [piece];
      append(from, piece.source.length);
      return result;
    });
    const balanceLabel = parts => {
      const opening = [], sites = new Set();
      const scan = (parts, offset = 0) => {
        for (const piece of parts) {
          if (piece.children) scan(piece.children, offset + piece.bodyOffset);
          else if (!piece.protected) {
            for (let at = 0; at < piece.source.length; at++) {
              if (piece.source[at] === '[') opening.push(offset + at);
              else if (piece.source[at] === ']' && opening.pop() === undefined) sites.add(offset + at);
            }
          }
          offset += piece.source.length;
        }
      };
      scan(parts);
      for (const at of opening) sites.add(at);
      return sites.size ? encodeParts(parts, sites) : parts;
    };
    const children = element => {
      const pieces = [...element.childNodes].flatMap(node => cellTextPieces(node, provenance))
        .flatMap(piece => piece.node ? visit(piece.node) :
          [{ ...piece, source: piece.raw === undefined ? literal(piece.text) : piece.raw, protected: !!piece.atomic }]);
      if (!normalized.size) return pieces;
      const result = [];
      const mergeable = piece => ['strong', 'em', 'del'].includes(piece.tokenType) &&
        piece.children && !provenance.attributes(piece.owner).length;
      for (let index = 0; index < pieces.length; index++) {
        const piece = pieces[index];
        if (!mergeable(piece)) { result.push(piece); continue; }
        const group = [piece];
        const parts = [...piece.children];
        let last = piece;
        while (index + 1 < pieces.length && pieces[index + 1].tokenType === piece.tokenType &&
            mergeable(pieces[index + 1])) {
          last = pieces[++index];
          group.push(last);
          parts.push(...last.children);
        }
        if (!group.some(item => normalized.has(item.owner))) { result.push(...group); continue; }
        const fragment = { ...provenance.fragments.get(piece.owner.getAttribute(provenance.partAttribute || cellPartAttribute)),
          sourceEnd: last.to, bodyRange: { sourceStart: piece.bodyRange.sourceStart,
            sourceEnd: last.bodyRange.sourceEnd } };
        result.push(...formatting(fragment, parts, piece.owner, true));
      }
      return result;
    };
    const formatting = (fragment, parts, node, normalizeDelimiter = normalized.has(node)) => {
      let marker = delimiters.get(node) || fragment.delimiter || (fragment.kind === 'del' ? '~~' :
        (fragment.raw.startsWith('_') ? '_' : '*').repeat(fragment.kind === 'strong' ? 2 : 1));
      if (!delimiters.has(node) && normalizeDelimiter && !retainDelimiters.has(node) && /^_{1,2}$/.test(marker)) {
        marker = '*'.repeat(marker.length);
      }
      const body = parts.map(piece => piece.source).join('');
      const leading = /^\s+/.exec(body)?.[0].length || 0;
      const trailing = body.length - (/\s+$/.exec(body)?.[0].length || 0);
      const sites = new Set();
      for (let at = 0; at < body.length; at++) {
        if ((at < leading || at >= trailing) && /\s/.test(body[at])) sites.add(at);
      }
      const encoded = sites.size ? encodeParts(parts, sites) : parts;
      return owned(marker + encoded.map(piece => piece.source).join('') + marker,
        fragment, node, fragment.kind, encoded, marker.length);
    };
    let normalized = new Set(), retainDelimiters = new Set(), delimiters = new Map();
    const visit = node => {
      if (node.nodeType === Node.COMMENT_NODE) return [];
      if (node.nodeType !== Node.ELEMENT_NODE || !inlineTags.has(node.tagName)) fail('tableCells.cellType');
      if ([...node.attributes].some(attr => /^on/i.test(attr.name))) fail('tableCells.cellType');
      const part = provenance ? node.getAttribute(provenance.partAttribute || cellPartAttribute) : null;
      const fragment = part ? provenance?.fragments.get(part) : null;
      if (part && !fragment) fail('tableCells.cellType');
      if (sourceMode && node.tagName === 'CODE' &&
          !(fragment?.kind === 'codespan' ||
            (fragment?.kind === 'html' && fragment.tag === 'CODE') ||
            fragment?.generatedCode === true)) {
        fail('tableCells.cellType');
      }
      const sameAttributes = fragment &&
        JSON.stringify(provenance.attributes(node)) === fragment.attributes;
      const changed = fragment && node.outerHTML !== fragment.initial;
      if (sameAttributes && (normalized.has(node) || changed) && ['link', 'image'].includes(fragment.kind)) {
        const attribute = name => encode(node.getAttribute(name) || '').replace(/:/g, '&#58;');
        const destination = (fragment.kind === 'image'
          ? encode(node.getAttribute('data-original-src') || node.getAttribute('src') || '').replace(/:/g, '&#58;')
          : attribute('href')).replace(/[ \t]/g, char => '&#' + char.charCodeAt(0) + ';');
        const parts = fragment.kind === 'image' ? undefined : balanceLabel(children(node));
        const label = parts ? parts.map(piece => piece.source).join('') : attribute('alt');
        const title = node.hasAttribute('title') ? ' "' + attribute('title') + '"' : '';
        return owned((fragment.kind === 'image' ? '!' : '') +
          '[' + label + '](<' + destination + '>' + title + ')', fragment, node, fragment.kind, parts, 1);
      }
      if (sameAttributes && (normalized.has(node) || delimiters.has(node) || changed) &&
          ['strong', 'em', 'del'].includes(fragment.kind)) {
        const parts = children(node);
        return formatting(fragment, parts, node);
      }
      if (fragment?.raw !== undefined && node.outerHTML === fragment.initial) {
        const parts = ['strong', 'em', 'del', 'link'].includes(fragment.kind) ? children(node) : undefined;
        return owned(fragment.raw, fragment, node,
          ['codespan', 'strong', 'em', 'del', 'link', 'image', 'br'].includes(fragment.kind) ? fragment.kind : undefined,
          parts);
      }
      if (fragment?.kind === 'comment') return [...owned(fragment.raw, fragment, node), ...children(node)];
      const attributes = [...node.attributes].filter(attr => inlineAttributes.includes(attr.name));
      if (node.tagName === 'CODE' && (fragment?.kind !== 'html' || fragment.generatedCode)) {
        const source = attributes.length
          ? { kind: 'unrepresentable', reason: 'unsupported-code-attributes' } : codeSources(node, provenance);
        if (source.kind !== 'unrepresentable' && source.text === node.textContent) {
          return owned(source.source, fragment, node, source.kind === 'markdown' ? 'codespan' : undefined);
        }
        if (sourceMode) fail('tableCells.cellType');
      }
      const open = '<' + node.localName + attributes.map(attr =>
        ' ' + attr.name + '="' + encode(attr.name === 'src'
          ? node.getAttribute('data-original-src') || attr.value : attr.value) + '"').join('') + '>';
      if (fragment?.kind === 'html' &&
          JSON.stringify(provenance.attributes(node)) === fragment.attributes) {
        return [...owned(fragment.opening, { origin: fragment.origin, ...fragment.openingRange }, node),
          ...children(node), ...owned(fragment.closing, { origin: fragment.origin, ...fragment.closingRange }, node)];
      }
      return [...owned(open, undefined, node), ...(['BR', 'IMG'].includes(node.tagName) ? [] :
        [...children(node), ...owned('</' + node.localName + '>', undefined, node)])];
    };
    let pieces = children(element), result = pieces.map(piece => piece.source).join('');
    if (escapeBoundary && provenance) {
      const mapping = pieces => {
        const entries = [], seams = [];
        const locate = (parts, offset, frame) => {
          for (const [index, piece] of parts.entries()) {
            if (index ? !adjacent(parts[index - 1], piece) :
              piece.origin !== frame.origin || piece.from !== frame.from) seams.push(offset);
            entries.push({ ...piece, parent: frame.owner, start: offset, end: offset + piece.source.length });
            if (piece.children) locate(piece.children, offset + piece.bodyOffset,
              { owner: piece.owner, origin: piece.origin,
                from: piece.bodyRange.sourceStart, to: piece.bodyRange.sourceEnd });
            offset += piece.source.length;
          }
          const last = parts.at(-1);
          if (!last || last.origin !== frame.origin || last.to !== frame.to) seams.push(offset);
        };
        locate(pieces, 0, { origin: provenance.origin, from: 0, to: provenance.sourceLength });
        return { entries, seams, source: pieces.map(piece => piece.source).join('') };
      };
      let map = mapping(pieces);
      let repair = provenance.repairSource(map.source, map.entries, map.seams);
      normalized = repair.normalize;
      retainDelimiters = repair.retainDelimiters;
      if (normalized.size) {
        pieces = children(element);
        map = mapping(pieces);
        repair = provenance.repairSource(map.source, map.entries, map.seams, true, delimiterOrientation);
      } else if (delimiterOrientation !== undefined) {
        repair = provenance.repairSource(map.source, map.entries, map.seams, true, delimiterOrientation);
      }
      if (repair.delimiters.size) {
        delimiters = repair.delimiters;
        pieces = children(element);
        map = mapping(pieces);
        repair = provenance.repairSource(map.source, map.entries, map.seams, true);
      }
      result = '';
      for (let at = 0; at < map.source.length; at++) {
        if (!repair.sites.has(at)) { result += map.source[at]; continue; }
        const point = map.source.codePointAt(at);
        result += '&#' + point + ';';
        if (point > 0xFFFF) at++;
      }
    }
    result = result.replace(/^[ \t]+|[ \t]+$/g, spaces =>
      [...spaces].map(char => '&#' + char.charCodeAt(0) + ';').join(''));
    if (/^(?:#{1,6}(?:\s|$)|[-+]\s|\d{1,9}[.)]\s|[-=]{3,}\s*$|!!!)/.test(result)) {
      result = '&#' + result.charCodeAt(0) + ';' + result.slice(1);
    }
    return result;
  }
  return { normalise, index, resolveSource, resolvePreview, resolveSourceLine, resolvePreviewTable,
    replaceCells, spliceInput, serializeCell,
    prepareCell, markdownCode, codeSources, codeDelimiters };
})();
