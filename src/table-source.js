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

function closerAt(text, line, width, table) {
  const end = ticksEnd(text, line.start, line.end);
  if (end - line.start < width) return null;
  const after = skipHorizontal(text, end, line.end);
  if (table ? text[after] !== '|' : after !== line.end) return null;
  return { end, after };
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

function readRow(input, start) {
  validate(input, start);
  return readRowAt(input, start, false);
}

function readRowAt(input, start, allowPlain) {
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

  while (true) {
    const opening = rawEligible ? openingAt(text, slotStart, line) : null;
    let cell = null;
    if (opening && line.next > line.end) {
      let closingLine = lineAt(text, line.next);
      let closer = null;
      while (closingLine.start < text.length) {
        closer = closerAt(text, closingLine, opening.width, true);
        if (closer) break;
        closingLine = lineAt(text, closingLine.next);
      }
      if (!closer) {
        fences.push(unfinishedFence(opening, text.length));
        return literal(input, start, text.length, fences, 'missing-fence', opening.marker);
      }
      const fence = finishFence(text, opening, closingLine, closer.end);
      fences.push(fence);
      cell = { kind: 'raw', slot: span(slotStart, closer.after),
        content: span(opening.marker.start, closer.end), fence };
      line = closingLine;
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
      trailingPipe = pipe;
      break;
    }
    separators.push(pipe);
    slotStart = cursor + 1;
    cursor = slotStart;
  }

  if (!sawPipe && !allowPlain) return null;
  const row = { span: span(start, line.end), ending: span(line.end, line.next),
    leadingPipe, trailingPipe, separators, cells };
  if (fences.length && !trailingPipe) {
    return literal(input, start, line.next, fences, 'columns', row.span);
  }
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
  const headerRead = readRowAt(input, start, true);
  if (!headerRead || headerRead.kind === 'literal') return headerRead;
  const header = headerRead.value;
  const fences = rowFences(header);
  const plainHeader = !header.leadingPipe && !header.trailingPipe && !header.separators.length;
  // A single-column GFM delimiter need not contain a pipe.
  const delimiterRead = readRowAt(input, headerRead.next, true);
  if (delimiterRead && delimiterRead.kind === 'literal') {
    if (plainHeader) return null;
    return literal(input, start, delimiterRead.next, fences.concat(delimiterRead.fences),
      delimiterRead.diagnostic.code, delimiterRead.diagnostic.at);
  }
  const delimiter = delimiterRead && delimiterRead.value;
  const align = delimiter && delimiterAlign(input.text, delimiter);
  if (!align || align.length !== header.cells.length) {
    if (plainHeader) return null;
    const delimiterFences = delimiter ? rowFences(delimiter) : [];
    if (!fences.length && !delimiterFences.length) return null;
    const line = lineAt(input.text, headerRead.next);
    const at = delimiter ? delimiter.span : span(line.start, line.end);
    return literal(input, start, delimiterRead ? delimiterRead.next : line.next,
      fences.concat(delimiterFences), align ? 'columns' : 'table-delimiter', at);
  }
  const rows = [];
  let last = delimiter;
  let next = delimiterRead.next;
  while (next < input.text.length) {
    const result = readRow(input, next);
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
  const first = lineAt(text, 0);
  const start = skipHorizontal(text, 0, first.end);
  const markerEnd = ticksEnd(text, start, first.end);
  if (markerEnd - start < 3) return null;
  const opening = openingAt(text, 0, first);
  const marker = span(start, markerEnd);
  if (!opening || first.next === first.end) {
    return literal(input, 0, text.length, [], 'cell-envelope', marker);
  }
  let line = lineAt(text, first.next);
  while (line.start < text.length) {
    const collision = closerAt(text, line, opening.width, true);
    if (collision) {
      return literal(input, 0, text.length, [unfinishedFence(opening, text.length)],
        'cell-envelope', span(line.start, line.end));
    }
    const closer = closerAt(text, line, opening.width, false);
    if (closer) {
      const fence = finishFence(text, opening, line, closer.end);
      if (line.next !== text.length) {
        return literal(input, 0, text.length, [fence], 'cell-envelope',
          span(line.next, text.length));
      }
      return complete(input, { kind: 'raw', slot: span(0, line.end),
        content: span(start, closer.end), fence }, line.next);
    }
    line = lineAt(text, line.next);
  }
  return literal(input, 0, text.length, [unfinishedFence(opening, text.length)],
    'cell-envelope', marker);
}

const tableSource = { readRow, readTable, readCell };
if (typeof module !== 'undefined' && module.exports) module.exports = tableSource;
if (typeof window !== 'undefined') window.MarkalooTableSource = tableSource;
})();
