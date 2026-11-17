(function () {
'use strict';

const spaces = new Set(['original', 'editor', 'lexer']);
const span = (start, end) => ({ start, end });
const horizontal = char => char === ' ' || char === '\t';

function validate(input, start) {
  if (!input || typeof input.text !== 'string' || !spaces.has(input.space)) {
    throw new TypeError('Expected an explicit table-source Snapshot');
  }
  if (!Number.isInteger(start) || start < 0 || start > input.text.length ||
      (start > 0 && input.text[start - 1] !== '\n' &&
        !(start === 1 && input.text.charCodeAt(0) === 0xfeff))) {
    throw new RangeError('Expected a physical-line boundary in the Snapshot');
  }
}

function lineAt(text, start) {
  const lf = text.indexOf('\n', start);
  const next = lf < 0 ? text.length : lf + 1;
  const end = lf < 0 ? next : lf - (text[lf - 1] === '\r' ? 1 : 0);
  return { start, end, next };
}

function skipHorizontal(text, start, end) {
  while (start < end && horizontal(text[start])) start++;
  return start;
}

function skipPadding(text, start) {
  while (start < text.length) {
    if (horizontal(text[start]) || text[start] === '\n') start++;
    else if (text[start] === '\r' && text[start + 1] === '\n') start += 2;
    else break;
  }
  return start;
}

function trimEnd(text, start, end) {
  while (end > start && horizontal(text[end - 1])) end--;
  return end;
}

function ticksEnd(text, start, end) {
  while (start < end && text[start] === '`') start++;
  return start;
}

function openingAt(text, slotStart, line) {
  const start = skipHorizontal(text, slotStart, line.end);
  const markerEnd = ticksEnd(text, start, line.end);
  if (markerEnd - start < 3) return null;
  let cursor = skipHorizontal(text, markerEnd, line.end);
  const labelStart = cursor;
  while (cursor < line.end && !/\s|`/.test(text[cursor])) cursor++;
  const labelEnd = cursor;
  cursor = skipHorizontal(text, cursor, line.end);
  if (cursor !== line.end) return null;
  return {
    opening: span(start, line.end),
    marker: span(start, markerEnd),
    label: labelEnd > labelStart ? span(labelStart, labelEnd) : null,
    openingEol: span(line.end, line.next),
    width: markerEnd - start
  };
}

function closerAt(text, line, width, table, padded = false) {
  const end = ticksEnd(text, line.start, line.end);
  if (end - line.start < width) return null;
  const after = padded ? skipPadding(text, end) : skipHorizontal(text, end, line.end);
  if (table ? text[after] !== '|' : after !== line.end) return null;
  return { end, after };
}

const tableFenceIndexes = new WeakMap();

function tableFenceIndex(input) {
  const { text, space } = input;
  const cached = tableFenceIndexes.get(input);
  if (cached && cached.text === text && cached.space === space) return cached.index;
  const index = new Map();
  const same = [];
  const padded = [];
  let cursor = text.length - 1;
  // Failed speculative openers share this pass instead of each rescanning EOF.
  while (cursor >= 0) {
    const end = text.lastIndexOf('`', cursor) + 1;
    if (!end) break;
    let start = end - 1;
    while (start > 0 && text[start - 1] === '`') start--;
    cursor = start - 1;
    const width = end - start;
    if (width < 3) continue;
    index.set(start, { same: same[width] || null, padded: padded[width] || null });
    if (start > 0 && text[start - 1] !== '\n') continue;
    const line = lineAt(text, start);
    const closer = closerAt(text, line, width, true, true);
    if (!closer) continue;
    const result = { ...closer, line,
      rowLine: lineAt(text, text.lastIndexOf('\n', closer.after - 1) + 1) };
    for (let required = 3; required <= width; required++) {
      padded[required] = result;
      if (closer.after <= line.end) same[required] = result;
    }
  }
  tableFenceIndexes.set(input, { text, space, index });
  return index;
}

function rowOpening(text, slotStart, line, padded) {
  const start = padded ? skipPadding(text, slotStart) : slotStart;
  const openingLine = start > line.end ? lineAt(text, start) : line;
  const opening = openingAt(text, start, openingLine);
  return opening && opening.openingEol.end > opening.openingEol.start
    ? { opening, vertical: start > line.end } : null;
}

function finishFence(text, opening, closingLine, markerEnd) {
  let bodyEnd = closingLine.start;
  if (bodyEnd > opening.openingEol.end) {
    bodyEnd--;
    if (text[bodyEnd - 1] === '\r') bodyEnd--;
  }
  return {
    ...opening,
    body: span(opening.openingEol.end, bodyEnd),
    closingEol: span(bodyEnd, closingLine.start),
    closing: span(closingLine.start, markerEnd)
  };
}

function unfinishedFence(opening, end) {
  return {
    ...opening,
    body: span(opening.openingEol.end, end),
    closingEol: span(end, end),
    closing: null
  };
}

function complete(input, value, next) {
  return { input, kind: 'complete', value, next };
}

function literal(input, start, next, fences, code, at) {
  return { input, kind: 'literal', span: span(start, next), fences,
    diagnostic: { code, at }, next };
}

function inlineCell(text, start, end) {
  const contentStart = skipHorizontal(text, start, end);
  return { kind: 'inline', slot: span(start, end),
    content: span(contentStart, trimEnd(text, contentStart, end)), fence: null };
}

function rowFences(row) {
  return row.cells.filter(cell => cell.kind === 'raw').map(cell => cell.fence);
}

function readRow(input, start, bodyColumns) {
  validate(input, start);
  if (bodyColumns !== undefined && (!Number.isSafeInteger(bodyColumns) || bodyColumns <= 0)) {
    throw new TypeError('Expected a positive safe integer BODY column constraint');
  }
  return readRowAt(input, start, false, bodyColumns === undefined ? null : bodyColumns);
}

const paddedRows = new WeakSet();

function readRowAt(input, start, allowPlain, columns = null, padded = true,
  headerContinuation = false) {
  const text = input.text;
  if (start === text.length) return null;
  let line = lineAt(text, start);
  const first = skipHorizontal(text, start, line.end);
  if (first === line.end) return null;
  const leadingPipe = text[first] === '|' ? span(first, first + 1) : null;
  const rawEligible = first === start && leadingPipe !== null;
  const cells = [];
  const separators = [];
  const fences = [];
  let trailingPipe = null;
  let slotStart = leadingPipe ? first + 1 : start;
  let cursor = slotStart;
  let sawPipe = leadingPipe !== null;
  let speculative = false;

  while (true) {
    let candidate = rawEligible ? rowOpening(text, slotStart, line, padded) : null;
    const choices = candidate && tableFenceIndex(input).get(candidate.opening.marker.start);
    const closer = choices && choices[padded ? 'padded' : 'same'];
    if (candidate && candidate.vertical && !closer) {
      if (speculative) {
        return readRowAt(input, start, allowPlain, columns, headerContinuation ? padded : false);
      }
      candidate = null;
    }
    let cell = null;
    if (candidate) {
      const { opening } = candidate;
      if (!closer) {
        if (speculative) {
          return readRowAt(input, start, allowPlain, columns, headerContinuation ? padded : false);
        }
        fences.push(unfinishedFence(opening, text.length));
        return literal(input, start, text.length, fences, 'missing-fence', opening.marker);
      }
      speculative = speculative || candidate.vertical || closer.after > closer.line.end;
      const fence = finishFence(text, opening, closer.line, closer.end);
      fences.push(fence);
      cell = { kind: 'raw', slot: span(slotStart, closer.after),
        content: span(opening.marker.start, closer.end), fence };
      line = closer.rowLine;
      cursor = closer.after;
    } else {
      // Only escaped pipes are data in an ordinary GFM cell, including code spans.
      while (cursor < line.end) {
        if (text[cursor] === '\\') {
          cursor += Math.min(2, line.end - cursor);
        } else if (text[cursor] === '|') {
          break;
        } else {
          cursor++;
        }
      }
    }

    if (cursor === line.end) {
      cells.push(cell || inlineCell(text, slotStart, cursor));
      break;
    }
    sawPipe = true;
    cells.push(cell || inlineCell(text, slotStart, cursor));
    const pipe = span(cursor, cursor + 1);
    if (skipHorizontal(text, cursor + 1, line.end) === line.end) {
      const possible = padded && rawEligible &&
        (headerContinuation || (columns !== null && cells.length < columns))
        ? rowOpening(text, cursor + 1, line, true) : null;
      const nextCloser = possible && possible.vertical &&
        tableFenceIndex(input).get(possible.opening.marker.start).padded;
      if (!nextCloser) {
        trailingPipe = pipe;
        break;
      }
    }
    separators.push(pipe);
    slotStart = cursor + 1;
    cursor = slotStart;
  }

  if (!sawPipe && !allowPlain) return null;
  const row = { span: span(start, line.end), ending: span(line.end, line.next),
    leadingPipe, trailingPipe, separators, cells };
  if (speculative && (!trailingPipe || (columns !== null && cells.length !== columns))) {
    return readRowAt(input, start, allowPlain, columns, headerContinuation ? padded : false);
  }
  if (fences.length && !trailingPipe) {
    return literal(input, start, line.next, fences, 'columns', row.span);
  }
  if (speculative) paddedRows.add(row);
  return complete(input, row, line.next);
}

function delimiterAlign(text, row) {
  const align = [];
  for (const cell of row.cells) {
    if (cell.kind !== 'inline') return null;
    const value = text.slice(cell.content.start, cell.content.end);
    if (!/^:?-+:?$/.test(value)) return null;
    align.push(value.startsWith(':') ? (value.endsWith(':') ? 'center' : 'left')
      : (value.endsWith(':') ? 'right' : null));
  }
  return align;
}

function readPlainBodyRun(input, start, nativePlainBodyRun) {
  const { text, space } = input;
  const lines = [];
  let next = start;
  while (next < text.length) {
    const line = lineAt(text, next);
    if (skipHorizontal(text, next, line.end) === line.end ||
        text.slice(next, line.end).includes('|')) break;
    lines.push(line);
    next = line.next;
  }
  if (!lines.length) return null;
  const requestedSpan = span(start, next);
  const request = { input, span: requestedSpan };
  const response = nativePlainBodyRun(request);
  let returnedRequest;
  let rowCount;
  if (response !== null) {
    if (!response || typeof response !== 'object') {
      throw new TypeError('Expected a native plain-body receipt or null');
    }
    ({ request: returnedRequest, rowCount } = response);
  }
  if (request.input !== input || input.text !== text || input.space !== space ||
      request.span !== requestedSpan || requestedSpan.start !== start || requestedSpan.end !== next) {
    throw new TypeError('Native plain-body request and Snapshot must remain unchanged');
  }
  if (response === null) return null;
  if (returnedRequest !== request) {
    throw new TypeError('Expected the identical native plain-body request');
  }
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0 || rowCount > lines.length) {
    throw new RangeError('Expected a native plain-body row count within the requested run');
  }
  const rows = [];
  for (let index = 0; index < rowCount; index++) {
    const line = lines[index];
    rows.push({ span: span(line.start, line.end), ending: span(line.end, line.next),
      leadingPipe: null, trailingPipe: null, separators: [],
      cells: [inlineCell(text, line.start, line.end)] });
  }
  return { rows, next: lines[rowCount - 1].next, partial: rowCount < lines.length };
}

function readTable(input, start, { nativePlainBodyRun } = {}) {
  validate(input, start);
  if (nativePlainBodyRun !== undefined && typeof nativePlainBodyRun !== 'function') {
    throw new TypeError('Expected a native plain-body callback');
  }
  return readTableAt(input, start, nativePlainBodyRun, true);
}

function readTableHeader(input, start) {
  validate(input, start);
  return readTableHeaderAt(input, start, true).result;
}

function readTableHeaderAt(input, start, padded, headerContinuation = padded) {
  // Only a matching delimiter can commit continuation past a HEADER pipe.
  const headerRead = readRowAt(input, start, true, null, padded, headerContinuation);
  if (!headerRead || headerRead.kind === 'literal') return { result: headerRead, padded };
  const header = headerRead.value;
  const fences = rowFences(header);
  const plainHeader = !header.leadingPipe && !header.trailingPipe && !header.separators.length;
  // A single-column GFM delimiter need not contain a pipe.
  const delimiterRead = readRowAt(input, headerRead.next, true, null, false);
  if (delimiterRead && delimiterRead.kind === 'literal') {
    if (paddedRows.has(header)) {
      return readTableHeaderAt(input, start, headerContinuation ? padded : false, false);
    }
    if (plainHeader) return { result: null, padded };
    return { result: literal(input, start, delimiterRead.next, fences.concat(delimiterRead.fences),
      delimiterRead.diagnostic.code, delimiterRead.diagnostic.at), padded };
  }
  const delimiter = delimiterRead && delimiterRead.value;
  const align = delimiter && delimiterAlign(input.text, delimiter);
  if (!align || align.length !== header.cells.length) {
    if (paddedRows.has(header)) {
      return readTableHeaderAt(input, start, headerContinuation ? padded : false, false);
    }
    if (plainHeader) return { result: null, padded };
    const delimiterFences = delimiter ? rowFences(delimiter) : [];
    if (!fences.length && !delimiterFences.length) return { result: null, padded };
    const line = lineAt(input.text, headerRead.next);
    const at = delimiter ? delimiter.span : span(line.start, line.end);
    return { result: literal(input, start, delimiterRead ? delimiterRead.next : line.next,
      fences.concat(delimiterFences), align ? 'columns' : 'table-delimiter', at), padded };
  }
  return { result: complete(input, { span: span(start, delimiter.span.end),
    ending: delimiter.ending, header, delimiter, align }, delimiterRead.next), padded };
}

function readTableAt(input, start, nativePlainBodyRun, padded) {
  const context = readTableHeaderAt(input, start, padded);
  const head = context.result;
  if (!head || head.kind === 'literal') return head;
  padded = context.padded;
  const { header, delimiter, align } = head.value;
  const fences = rowFences(header);
  const rows = [];
  let last = delimiter;
  let next = head.next;
  while (next < input.text.length) {
    const result = readRowAt(input, next, false, header.cells.length, padded);
    if (!result) {
      if (header.cells.length !== 1 || !nativePlainBodyRun) break;
      const plain = readPlainBodyRun(input, next, nativePlainBodyRun);
      if (!plain) break;
      for (const row of plain.rows) rows.push(row);
      last = plain.rows[plain.rows.length - 1];
      next = plain.next;
      if (plain.partial) break;
      continue;
    }
    if (result.kind === 'literal') {
      return literal(input, start, result.next, fences.concat(result.fences),
        result.diagnostic.code, result.diagnostic.at);
    }
    const row = result.value;
    const raw = rowFences(row);
    for (const fence of raw) fences.push(fence);
    if (raw.length && row.cells.length !== header.cells.length) {
      return literal(input, start, result.next, fences, 'columns', row.span);
    }
    rows.push(row);
    last = row;
    next = result.next;
  }
  return complete(input, { span: span(start, last.span.end), ending: last.ending,
    header, delimiter, rows, align, hasRaw: fences.length > 0 }, next);
}

function readCell(input) {
  validate(input, 0);
  const text = input.text;
  const start = skipPadding(text, 0);
  const first = lineAt(text, start);
  const markerEnd = ticksEnd(text, start, first.end);
  if (markerEnd - start < 3) return null;
  const opening = openingAt(text, start, first);
  const marker = span(start, markerEnd);
  if (!opening || first.next === first.end) {
    return literal(input, 0, text.length, [], 'cell-envelope', marker);
  }
  let line = lineAt(text, first.next);
  while (line.start < text.length) {
    const collision = closerAt(text, line, opening.width, true, true);
    if (collision) {
      return literal(input, 0, text.length, [unfinishedFence(opening, text.length)],
        'cell-envelope', span(line.start, line.end));
    }
    const closer = closerAt(text, line, opening.width, false);
    if (closer) {
      const fence = finishFence(text, opening, line, closer.end);
      const after = skipPadding(text, closer.end);
      if (after !== text.length) {
        return literal(input, 0, text.length, [fence], 'cell-envelope',
          span(after, text.length));
      }
      return complete(input, { kind: 'raw', slot: span(0, text.length),
        content: span(start, closer.end), fence }, text.length);
    }
    line = lineAt(text, line.next);
  }
  return literal(input, 0, text.length, [unfinishedFence(opening, text.length)],
    'cell-envelope', marker);
}

const tableSource = { readRow, readTable, readCell, readTableHeader };
if (typeof module !== 'undefined' && module.exports) module.exports = tableSource;
if (typeof window !== 'undefined') window.MarkalooTableSource = tableSource;
})();
