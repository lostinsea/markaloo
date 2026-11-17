'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = require('../src/table-source');
let passed = 0;
const failures = [];

function test(name, run) {
  try {
    run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}
const snapshot = (text, space = 'original') => Object.freeze({ text, space });
const cut = (input, receipt) => input.text.slice(receipt.start, receipt.end);
const pair = receipt => [receipt.start, receipt.end];

test('frozen contract exact UTF-16 receipts and snapshot identity', () => {
  const input = snapshot('| ```x\nA|B\n``` |\n| --- |\n');
  const read = source.readTable(input, 0);
  assert.equal(read.input, input);
  assert.equal(read.kind, 'complete');
  assert.equal(read.next, 25);
  const table = read.value;
  const row = table.header;
  const cell = row.cells[0];
  const expected = {
    table: [0, 24], tableEnding: [24, 25], header: [0, 16], headerEnding: [16, 17],
    cellSlot: [1, 15], cellContent: [2, 14], opening: [2, 6], marker: [2, 5],
    label: [5, 6], openingEol: [6, 7], body: [7, 10], closingEol: [10, 11],
    closing: [11, 14], leadingPipe: [0, 1], trailingPipe: [15, 16], delimiter: [17, 24]
  };
  const actual = {
    table: table.span, tableEnding: table.ending, header: row.span, headerEnding: row.ending,
    cellSlot: cell.slot, cellContent: cell.content, ...cell.fence,
    leadingPipe: row.leadingPipe, trailingPipe: row.trailingPipe, delimiter: table.delimiter.span
  };
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(pair(actual[key]), value, key);
  assert.deepEqual(row.separators, []);
});

test('empty bodies and structural separator ownership', () => {
  for (const [middle, body, closingEol] of [
    ['', '', ''], ['\n', '', '\n'], ['A\n', 'A', '\n'], ['\nA\n\n', '\nA\n', '\n']
  ]) {
    const input = snapshot('| ```\n' + middle + '``` |\n| - |\n');
    const cell = source.readTable(input, 0).value.header.cells[0];
    assert.equal(cut(input, cell.fence.body), body);
    assert.equal(cut(input, cell.fence.closingEol), closingEol);
    assert.ok(cell.fence.openingEol.end <= cell.fence.closingEol.start);
  }
});

test('CRLF, non-BMP, all coordinate spaces and offset starts stay exact', () => {
  const text = 'prefix\r\n\r\n| \t```c# \t\r\n😀 日本語 | Привет\r\n``` \t| tail |\r\n| --- | :---: |\r\n';
  for (const space of ['original', 'editor', 'lexer']) {
    const input = snapshot(text, space);
    const read = source.readTable(input, 10);
    assert.equal(read.input, input);
    assert.equal(read.kind, 'complete');
    const cell = read.value.header.cells[0];
    assert.equal(cut(input, cell.slot), ' \t```c# \t\r\n😀 日本語 | Привет\r\n``` \t');
    assert.equal(cut(input, cell.content), '```c# \t\r\n😀 日本語 | Привет\r\n```');
    assert.equal(cut(input, cell.fence.body), '😀 日本語 | Привет');
    assert.equal(cut(input, cell.fence.openingEol), '\r\n');
    assert.equal(cut(input, cell.fence.closingEol), '\r\n');
    assert.equal(read.next, text.length);
    assert.deepEqual(read.value.align, [null, 'center']);
  }
});

test('any header/body column and multiple raw cells per logical row', () => {
  const input = snapshot('| ```rust\na | b\n``` | Name | ```unknown\n:smile: <tag> @@@html\n``` |\n' +
    '| --- | --- | --- |\n| left | ```\nplain | data\n``` | right |\n');
  const read = source.readTable(input, 0);
  assert.equal(read.kind, 'complete');
  assert.deepEqual(read.value.header.cells.map(cell => cell.kind), ['raw', 'inline', 'raw']);
  assert.deepEqual(read.value.rows[0].cells.map(cell => cell.kind), ['inline', 'raw', 'inline']);
  assert.equal(read.value.header.separators.length, 2);
  assert.equal(read.value.hasRaw, true);
  for (const position of [0, 1, 2]) {
    const cells = ['a', 'b', 'c'];
    cells[position] = '```sql\nSELECT \'a|b\';\n```';
    const row = source.readRow(snapshot('| ' + cells.join(' | ') + ' |\n'), 0);
    assert.equal(row.value.cells[position].kind, 'raw', String(position));
    assert.equal(row.value.cells.length, 3);
  }
});

test('longer outer fences and indented closer-looking lines stay opaque', () => {
  const body = '``` | shorter\n ``` ` indented\n\n# heading\n@@@html\n<script>x</script>\n~~~\n😀';
  const input = snapshot('| ````application/json\n' + body + '\n````` \t| next |\n| - | - |');
  const read = source.readTable(input, 0);
  assert.equal(read.kind, 'complete');
  const fence = read.value.header.cells[0].fence;
  assert.equal(cut(input, fence.body), body);
  assert.equal(fence.width, 4);
  assert.equal(cut(input, fence.closing), '`````');
  assert.equal(cut(input, fence.label), 'application/json');
});

test('unknown, unlabelled, mermaid and opaque token labels are syntax, not a lookup', () => {
  for (const label of ['', 'unknown', 'mermaid', 'c#', 'c++', 'application/json', '日本語', 'x|y']) {
    const input = snapshot('| ```' + label + '\nA|B\n``` |\n| - |');
    const read = source.readTable(input, 0);
    assert.equal(read.kind, 'complete', label);
    assert.equal(cut(input, read.value.header.cells[0].fence.body), 'A|B');
  }
});

test('ordinary rows and tables return complete results; non-candidates return null', () => {
  for (const text of ['a | b', '| a | b |', ' | a | b | ', '| a\\|b | c |', '| `a|b` | c |']) {
    const read = source.readRow(snapshot(text), 0);
    assert.equal(read.kind, 'complete', text);
    assert.ok(read.value.cells.every(cell => cell.kind === 'inline'));
  }
  const ordinary = source.readTable(snapshot('left | right\n:--- | ---:\na | b\n\nnext'), 0);
  assert.equal(ordinary.kind, 'complete');
  assert.equal(ordinary.value.hasRaw, false);
  assert.deepEqual(ordinary.value.align, ['left', 'right']);
  assert.equal(ordinary.value.rows.length, 1);
  for (const text of ['', ' \t\n', 'plain prose\n']) {
    assert.equal(source.readRow(snapshot(text), 0), null);
    assert.equal(source.readTable(snapshot(text), 0), null);
    assert.equal(source.readCell(snapshot(text)), null);
  }
  assert.equal(source.readTable(snapshot('a | b\nnot a delimiter\n'), 0), null);
});

test('non-openers stay inline rather than swallowing subsequent lines', () => {
  for (const text of ['| prose ```rust', 'left | ```rust', '| ~~~rust', '| ```rust extra',
    '| ```ru`st', ' | ```rust']) {
    const read = source.readRow(snapshot(text + '\nbody\n'), 0);
    assert.equal(read.kind, 'complete', text);
    assert.ok(read.value.cells.every(cell => cell.kind === 'inline'), text);
    assert.equal(read.next, text.length + 1);
  }
});

test('single-column delimiter can be unframed without making plain text a row candidate', () => {
  for (const header of ['| a |', '| ```x\nA\n``` |']) {
    const text = header + '\n :---: \n';
    const input = snapshot(text);
    const read = source.readTable(input, 0);
    assert.equal(read.kind, 'complete');
    assert.deepEqual(read.value.align, ['center']);
    assert.equal(cut(input, read.value.delimiter.cells[0].content), ':---:');
    assert.equal(read.next, text.length);
  }
  assert.equal(source.readRow(snapshot('---\n'), 0), null);
});

test('one-column ordinary header binds raw body receipts without parsing native eligibility', () => {
  const text = 'Header\n| --- |\n| ````rust\nA | B\n```` |\n';
  const input = snapshot(text);
  const read = source.readTable(input, 0);
  assert.equal(read.kind, 'complete');
  assert.equal(read.value.hasRaw, true);
  assert.deepEqual(pair(read.value.header.span), [0, 6]);
  assert.deepEqual(pair(read.value.header.cells[0].content), [0, 6]);
  assert.equal(read.value.header.leadingPipe, null);
  assert.equal(cut(input, read.value.rows[0].cells[0].fence.body), 'A | B');
  assert.equal(source.readRow(snapshot('Header\n'), 0), null);
  assert.equal(source.readTable(snapshot('prose\n| ```x\nunclosed'), 0), null);
  assert.equal(source.readTable(snapshot('prose\nnot a delimiter\n'), 0), null);
});

test('native plain-body capability is opt-in and does not change other public readers', () => {
  const input = snapshot('Only\n| --- |\nplain\n| ```x\nraw\n``` |\n');
  const without = source.readTable(input, 0);
  assert.equal(without.value.rows.length, 0);
  assert.equal(without.next, input.text.indexOf('plain'));
  assert.deepEqual(source.readTable(input, 0, {}), without);
  assert.equal(source.readRow(snapshot('plain\n'), 0), null);
  assert.equal(source.readCell(snapshot('plain\n')), null);
  const options = { nativePlainBodyRun() { throw new Error('not a plain one-column body run'); } };
  for (const text of ['A | B\n- | -\nplain\n', '| A |\n| - |\n',
    '| A |\n| - |\n \t\nplain\n', '| A |\n| - |\nescaped\\|pipe\n',
    'not a table\nplain\n']) {
    assert.deepEqual(source.readTable(snapshot(text), 0, options),
      source.readTable(snapshot(text), 0));
  }
  for (const nativePlainBodyRun of [null, false, 1, 'callback', {}]) {
    assert.throws(() => source.readTable(input, 0, { nativePlainBodyRun }), TypeError);
  }
});

test('native plain runs preserve snapshot space, BOM, Unicode, padding and physical endings', () => {
  for (const space of ['original', 'editor', 'lexer']) {
    for (const eol of ['\n', '\r\n']) {
      for (const final of ['', eol]) {
        const prefix = '\uFEFFOnly' + eol + '| --- |' + eol;
        const first = ' \t😀 日本語 \t' + eol + 'second' + eol;
        const raw = '| ```x' + eol + 'raw | opaque' + eol + '``` |' + eol;
        const tail = 'final' + final;
        const input = snapshot(prefix + first + raw + tail, space);
        const requests = [];
        const read = source.readTable(input, 1, { nativePlainBodyRun(request) {
          assert.equal(request.input, input);
          requests.push(request);
          return { request, rowCount: requests.length === 1 ? 2 : 1 };
        } });
        assert.equal(read.input, input);
        assert.equal(read.input.space, space);
        assert.equal(read.kind, 'complete');
        assert.equal(read.value.hasRaw, true);
        assert.equal(read.next, input.text.length);
        assert.equal(read.value.rows.length, 4);
        assert.deepEqual(pair(requests[0].span), [prefix.length, prefix.length + first.length]);
        assert.deepEqual(pair(requests[1].span),
          [prefix.length + first.length + raw.length, input.text.length]);
        const [row, second, rawRow, last] = read.value.rows;
        assert.equal(cut(input, row.cells[0].slot), ' \t😀 日本語 \t');
        assert.equal(cut(input, row.cells[0].content), '😀 日本語');
        assert.equal(cut(input, row.ending), eol);
        assert.equal(row.leadingPipe, null);
        assert.equal(row.trailingPipe, null);
        assert.deepEqual(row.separators, []);
        assert.equal(cut(input, second.cells[0].content), 'second');
        assert.equal(cut(input, rawRow.cells[0].fence.body), 'raw | opaque');
        assert.equal(cut(input, last.ending), final);
        assert.deepEqual(read.value.ending, last.ending);
        assert.equal(read.value.span.end, input.text.length - final.length);
      }
    }
  }
});

test('native null and prefix receipts stop the whole table without later raw-row resumption', () => {
  const prefix = '| H |\n| - |\n';
  const run = 'first\n# heading\noutside\n';
  const input = snapshot(prefix + run + '| ```x\nlater raw\n``` |\n');
  for (const rowCount of [null, 1, 2]) {
    let calls = 0;
    const read = source.readTable(input, 0, { nativePlainBodyRun(request) {
      calls++;
      assert.equal(cut(input, request.span), run);
      return rowCount === null ? null : { request, rowCount };
    } });
    assert.equal(calls, 1);
    assert.equal(read.value.rows.length, rowCount || 0);
    assert.equal(read.value.hasRaw, false);
    assert.equal(read.next, prefix.length + (rowCount === null ? 0 :
      run.split('\n').slice(0, rowCount).join('\n').length + 1));
  }
  const finalBlank = snapshot(prefix + 'one\n\nnot this row\n');
  let calls = 0;
  const read = source.readTable(finalBlank, 0, { nativePlainBodyRun(request) {
    calls++;
    assert.equal(cut(finalBlank, request.span), 'one\n');
    return { request, rowCount: 1 };
  } });
  assert.equal(calls, 1);
  assert.equal(read.next, prefix.length + 'one\n'.length);
});

test('native receipts reject copied authority, invalid counts and non-receipt results', () => {
  const input = snapshot('Only\n| - |\none\ntwo\n');
  for (const rowCount of [undefined, null, 0, -1, 0.5, 3, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 1, '1', 1n]) {
    assert.throws(() => source.readTable(input, 0, {
      nativePlainBodyRun: request => ({ request, rowCount })
    }), RangeError, String(rowCount));
  }
  for (const receipt of [
    () => undefined, () => false, () => 'receipt', () => 1, () => ({}),
    request => ({ request: { ...request }, rowCount: 1 }),
    request => ({ request: { input: { ...request.input }, span: request.span }, rowCount: 1 }),
    request => ({ request: { input: request.input, span: { ...request.span } }, rowCount: 1 }),
    request => Promise.resolve({ request, rowCount: 1 })
  ]) {
    assert.throws(() => source.readTable(input, 0, { nativePlainBodyRun: receipt }), TypeError);
  }
  let stale;
  const options = { nativePlainBodyRun(request) {
    const returned = stale || request;
    stale = request;
    return { request: returned, rowCount: 2 };
  } };
  assert.equal(source.readTable(input, 0, options).value.rows.length, 2);
  assert.throws(() => source.readTable(input, 0, options), TypeError);
  const error = new Error('native oracle failure');
  assert.throws(() => source.readTable(input, 0, {
    nativePlainBodyRun() { throw error; }
  }), caught => caught === error);
});

test('native callbacks cannot change Snapshot text/space or request/span authority', () => {
  for (const mutate of [
    request => { request.input.text += 'changed'; },
    request => { request.input.space = 'editor'; },
    request => { request.input = { ...request.input }; },
    request => { request.span = { ...request.span }; },
    request => { request.span.start++; },
    request => { request.span.end--; }
  ]) {
    for (const refused of [false, true]) {
      const input = { text: 'Only\n| - |\none\ntwo\n', space: 'original' };
      assert.throws(() => source.readTable(input, 0, { nativePlainBodyRun(request) {
        mutate(request);
        return refused ? null : { request, rowCount: 1 };
      } }), TypeError);
    }
  }
  for (const field of ['request', 'rowCount']) {
    const input = { text: 'Only\n| - |\none\n', space: 'original' };
    assert.throws(() => source.readTable(input, 0, { nativePlainBodyRun(request) {
      return { get request() {
        if (field === 'request') input.text += 'changed';
        return request;
      }, get rowCount() {
        if (field === 'rowCount') request.span = { ...request.span };
        return 1;
      } };
    } }), TypeError);
  }
});

test('missing closer consumes to EOF, including blanks and later table-looking content', () => {
  const text = '| a |\n| - |\n| ```rust\nx\n\n| other |\n| --- |\n';
  const input = snapshot(text);
  const read = source.readTable(input, 0);
  assert.equal(read.kind, 'literal');
  assert.equal(read.diagnostic.code, 'missing-fence');
  assert.deepEqual(pair(read.span), [0, text.length]);
  assert.equal(read.next, text.length);
  assert.equal(read.fences[0].closing, null);
  assert.equal(read.fences[0].body.end, text.length);
  assert.deepEqual(pair(read.fences[0].closingEol), [text.length, text.length]);
  assert.equal(cut(input, read.diagnostic.at), '```');
});

test('closed invalid delimiter and raw row width stop at the exact offending row', () => {
  const header = '| ```x\nA\n``` |\n';
  for (const tail of ['', 'not delimiter\nignored\n', '\nignored\n']) {
    const input = snapshot(header + tail);
    const read = source.readTable(input, 0);
    assert.equal(read.kind, 'literal');
    assert.equal(read.diagnostic.code, 'table-delimiter');
    assert.equal(read.next, header.length + (tail ? tail.indexOf('\n') + 1 : 0));
  }
  const mismatch = source.readTable(snapshot(header + '| - | - |\nignored\n'), 0);
  assert.equal(mismatch.diagnostic.code, 'columns');
  const bad = '| a | b |\n| - | - |\n| ```x\nA\n``` |\n';
  const read = source.readTable(snapshot(bad + 'ignored\n'), 0);
  assert.equal(read.diagnostic.code, 'columns');
  assert.equal(read.next, bad.length);
  const unframedEnd = source.readRow(snapshot('| ```x\nA\n``` | tail\nlater\n'), 0);
  assert.equal(unframedEnd.diagnostic.code, 'columns');
  assert.equal(unframedEnd.next, '| ```x\nA\n``` | tail\n'.length);
});

test('readCell preserves padding and consumes at most one final clipboard newline', () => {
  for (const eol of ['\n', '\r\n']) {
    for (const final of ['', eol]) {
      const text = ' \t```c++' + eol + '😀 | data' + eol + '```` \t' + final;
      const input = snapshot(text, 'editor');
      const read = source.readCell(input);
      assert.equal(read.kind, 'complete');
      assert.equal(read.input, input);
      assert.equal(read.next, text.length);
      assert.equal(cut(input, read.value.slot), text.slice(0, text.length - final.length));
      assert.equal(cut(input, read.value.content), '```c++' + eol + '😀 | data' + eol + '````');
      assert.equal(cut(input, read.value.fence.body), '😀 | data');
    }
  }
});

test('readCell rejects malformed envelopes and identifies table-closer collisions', () => {
  for (const text of ['```x extra\nA\n```', '```x', '```x\nA',
    '```x\nA\n```\n\n', '```x\nA\n```\nprose', '```x\nA\n ```',
    '```x\nA\n```\n \t']) {
    const read = source.readCell(snapshot(text));
    assert.equal(read.kind, 'literal', text);
    assert.equal(read.diagnostic.code, 'cell-envelope');
  }
  const input = snapshot('```sql\nSELECT 1;\n``` | reserved\n```');
  const read = source.readCell(input);
  assert.equal(read.kind, 'literal');
  assert.equal(cut(input, read.diagnostic.at), '``` | reserved');
  assert.equal(source.readCell(snapshot('````sql\n``` | reserved\n````')).kind, 'complete');
  assert.equal(source.readCell(snapshot('prose\n```x\nA\n```')), null);
});

test('browser global is DOM-free and has the same public functions', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/table-source'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.window.MarkalooTableSource), ['readRow', 'readTable', 'readCell']);
  assert.equal(context.window.MarkalooTableSource.readCell({ text: '```\nx\n```', space: 'lexer' }).kind,
    'complete');
});

test('invalid snapshots and non-boundary starts fail explicitly', () => {
  for (const input of [null, {}, { text: '', space: 'implicit' }]) {
    assert.throws(() => source.readCell(input), TypeError);
  }
  for (const start of [undefined, null, NaN, -1, 1, 100]) {
    assert.throws(() => source.readRow(snapshot('a | b'), start), RangeError);
    assert.throws(() => source.readTable(snapshot('a | b'), start), RangeError);
  }
});

test('equal text in different snapshots never shares result authority', () => {
  const text = '| ```x\n😀\n``` |\n| - |\n';
  const first = snapshot(text);
  const second = snapshot(text);
  assert.notEqual(first, second);
  for (const read of [input => source.readRow(input, 0), input => source.readTable(input, 0)]) {
    const a = read(first);
    const b = read(second);
    assert.equal(a.input, first);
    assert.equal(b.input, second);
    assert.notEqual(a.input, b.input);
    assert.deepEqual(a.value, b.value);
  }
});

test('document BOM boundary retains the full original snapshot and absolute raw receipts', () => {
  const plain = '| ```x\r\n😀|日本語\r\n``` |\r\n| --- |\r\n';
  const input = snapshot('\uFEFF' + plain);
  const read = source.readTable(input, 1);
  assert.equal(read.input, input);
  assert.equal(read.kind, 'complete');
  assert.equal(read.value.span.start, 1);
  assert.equal(read.next, input.text.length);
  const row = source.readRow(input, 1);
  assert.equal(row.input, input);
  assert.equal(row.value.leadingPipe.start, 1);
  const cell = row.value.cells[0];
  assert.equal(cut(input, cell.fence.body), '😀|日本語');
  assert.equal(cell.fence.body.start, 1 + plain.indexOf('😀'));
  assert.equal(cut(input, cell.slot), ' ```x\r\n😀|日本語\r\n``` ');
  assert.throws(() => source.readRow(snapshot('x' + plain), 1), RangeError);
  assert.throws(() => source.readRow(snapshot('\uFEFFx' + plain), 2), RangeError);
  assert.equal(source.readCell(snapshot('\uFEFF```x\nA\n```')), null);
});

test('closed over-width rows, mixed EOL and retained completed fence receipts', () => {
  const text = '| A | B |\r\n| - | - |\n| ```x\r\none\n``` | ```y\n😀\r\n``` | extra |\r\nsuffix';
  const input = snapshot(text);
  const read = source.readTable(input, 0);
  assert.equal(read.kind, 'literal');
  assert.equal(read.input, input);
  assert.equal(read.diagnostic.code, 'columns');
  assert.equal(cut(input, read.fences[0].body), 'one');
  assert.equal(cut(input, read.fences[0].openingEol), '\r\n');
  assert.equal(cut(input, read.fences[0].closingEol), '\n');
  assert.equal(cut(input, read.fences[1].body), '😀');
  assert.equal(cut(input, read.fences[1].closingEol), '\r\n');
  assert.equal(read.next, text.indexOf('suffix'));
  const missing = snapshot('| ```x\nok\n``` | ```y\nunclosed\n\n');
  const incomplete = source.readRow(missing, 0);
  assert.equal(incomplete.fences.length, 2);
  assert.notEqual(incomplete.fences[0].closing, null);
  assert.equal(incomplete.fences[1].closing, null);
  assert.equal(incomplete.next, missing.text.length);
});

test('immutable shared multilingual corpus is literal data in tables and popup envelopes', () => {
  const { cases } = require('./fixtures/table-code-literals');
  assert.deepEqual(cases.map(item => item.language), ['csharp', 'rust', 'json', 'sql']);
  for (const item of cases) {
    for (const eol of ['\n', '\r\n']) {
      const body = item.body.replace(/\n/g, eol);
      const envelope = '````' + item.language + eol + body + eol + '````';
      const cellInput = snapshot(envelope, 'editor');
      const cell = source.readCell(cellInput);
      assert.equal(cell.kind, 'complete', item.id);
      assert.equal(cut(cellInput, cell.value.fence.body), body);
      for (const position of [0, 1, 2]) {
        const cells = ['left', 'middle', 'right'];
        cells[position] = envelope;
        const input = snapshot('| ' + cells.join(' | ') + ' |' + eol +
          '| --- | --- | --- |' + eol);
        const table = source.readTable(input, 0);
        assert.equal(table.kind, 'complete', item.id);
        assert.equal(cut(input, table.value.header.cells[position].fence.body), body);
      }
    }
  }
});

console.log(`raw-table-source: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
