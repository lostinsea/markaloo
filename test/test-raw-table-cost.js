'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const source = require('../src/table-source');
const helpers = require('../src/file-helpers-core');
const { cases } = require('./fixtures/table-code-literals');
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

function undiscounted(text) {
  const lines = 1 + (text.match(/\n/g) || []).length;
  const pipes = (text.match(/\|/g) || []).length;
  return { units: lines + pipes, lines, fencedLines: 0, pipes };
}

function rawTable(body, width = 4) {
  const fence = '`'.repeat(width);
  return '| ' + fence + 'rust\n' + body + '\n' + fence + ' | neighbor |\n| --- | --- |\n';
}

test('closed raw rows count every line and pipe without ordinary-fence discount', () => {
  const text = rawTable('A | B\n```\n# heading\n\n| nested | row |\n~~~\n😀');
  assert.equal(source.readTable({ text, space: 'original' }, 0).kind, 'complete');
  assert.deepEqual(helpers.estimateRenderUnits(text), undiscounted(text));
  assert.deepEqual(helpers.estimateRenderUnits(text.replace(/\n/g, '\r\n')),
    undiscounted(text));
});

test('missing closer remains undiscounted through EOF, including blank-line false recovery', () => {
  const text = '| ```sql\nSELECT \'a|b\';\n\n| next | table |\n| --- | --- |\n``` \nprose\n| tail |\n';
  const read = source.readRow({ text, space: 'original' }, 0);
  assert.equal(read.kind, 'literal');
  assert.equal(read.diagnostic.code, 'missing-fence');
  assert.equal(read.next, text.length);
  assert.deepEqual(helpers.estimateRenderUnits(text), undiscounted(text));
});

test('lookahead begun inside a row counts earlier inline pipes once, in every raw column', () => {
  for (const position of [0, 1, 2]) {
    const cells = ['left', 'middle', 'right'];
    cells[position] = '````rust\n```\nA|B\n````';
    const text = '| ' + cells.join(' | ') + ' |\n| - | - | - |\n';
    assert.equal(source.readTable({ text, space: 'original' }, 0).kind, 'complete');
    assert.deepEqual(helpers.estimateRenderUnits(text), undiscounted(text));
  }
  const text = '| prose ```literal | ```sql\nA|B\n``` | ```json\nC|D\n``` |\n| - | - | - |\n';
  assert.equal(source.readTable({ text, space: 'original' }, 0).kind, 'complete');
  assert.deepEqual(helpers.estimateRenderUnits(text), undiscounted(text));
});

test('adjacent raw rows each keep authority over their complete physical windows', () => {
  const text = '| ```x\nfirst | body\n``` |\n| - |\n' +
    '| ```y\n```\nsecond | body\n``` |\n| ```z\n```\nthird | body\n``` |\n';
  const read = source.readTable({ text, space: 'original' }, 0);
  assert.equal(read.kind, 'complete');
  assert.equal(read.value.rows.length, 2);
  assert.deepEqual(helpers.estimateRenderUnits(text), undiscounted(text));
});

test('closed malformed width and delimiter do not turn raw ticks into document fences', () => {
  for (const text of [
    rawTable('one|two').replace('| --- | --- |', '| --- |'),
    rawTable('one|two').replace('| --- | --- |', 'not a delimiter'),
    '| a | b |\n| - | - |\n| ```sql\nA|B\n``` |\n',
    '| ```sql\nA|B\n``` | unframed\n'
  ]) {
    assert.equal(source.readTable({ text, space: 'original' }, 0).kind, 'literal');
    assert.deepEqual(helpers.estimateRenderUnits(text), undiscounted(text));
  }
});

test('raw body markers never leak into surrounding ordinary document-fence state', () => {
  const ordinary = '```text\ninside | ordinary\n```\n';
  const raw = rawTable('```\nopaque | body\n~~~~\n```not a closer');
  const text = ordinary + '\n' + raw + '\n' + ordinary + 'outside | pipe\n';
  const expected = undiscounted(text);
  expected.fencedLines = 6;
  expected.pipes -= 2;
  expected.units = expected.lines - 0.8 * expected.fencedLines + expected.pipes;
  assert.deepEqual(helpers.estimateRenderUnits(text), expected);
});

test('raw-looking rows inside ordinary fences stay ordinary fenced content', () => {
  const text = '~~~text\n' + rawTable('A|B') + '~~~\n';
  // The existing guard deliberately tracks backticks only. This control uses
  // a backtick outer fence without any interior closing-looking line.
  const backticks = '```text\n| ```rust\nA|B\n| not | a raw closer |\n```\n';
  const result = helpers.estimateRenderUnits(backticks);
  assert.equal(result.pipes, 0);
  assert.equal(result.fencedLines, 5);
  assert.ok(helpers.estimateRenderUnits(text).pipes > 0);
});

test('ordinary inputs preserve the existing estimator behavior and thresholds', () => {
  assert.deepEqual(helpers.estimateRenderUnits(''), { units: 0, lines: 0, fencedLines: 0, pipes: 0 });
  assert.deepEqual(helpers.estimateRenderUnits('plain\ntext'), { units: 2, lines: 2, fencedLines: 0, pipes: 0 });
  assert.deepEqual(helpers.estimateRenderUnits('| a | b |\n| - | - |\n'), {
    units: 9, lines: 3, fencedLines: 0, pipes: 6
  });
  assert.deepEqual(helpers.estimateRenderUnits('```\na|b\n```\n'), {
    units: 1.5999999999999996, lines: 4, fencedLines: 3, pipes: 0
  });
  const text = rawTable('A|B');
  const units = undiscounted(text).units;
  const estimatedMs = units * helpers.MS_PER_UNIT;
  assert.equal(helpers.estimateRenderMs(text), estimatedMs);
  assert.deepEqual(helpers.isLargeDocument(text, estimatedMs), { large: false, estimatedMs, units });
  assert.equal(helpers.isLargeDocument(text, estimatedMs - 0.001).large, true);
});

test('all immutable multilingual bodies stay undiscounted, never evaluated', () => {
  for (const item of cases) {
    const text = rawTable(item.body);
    assert.equal(source.readTable({ text, space: 'original' }, 0).kind, 'complete', item.id);
    assert.deepEqual(helpers.estimateRenderUnits(text), undiscounted(text), item.id);
  }
});

test('ordinary trailing-pipe table and later independent fence retain separate cost windows', () => {
  for (const eol of ['\n', '\r\n']) {
    for (const gap of [eol, ' \t' + eol + eol]) {
      const table = '| Name |' + eol + '| --- |' + eol + '| value |' + eol;
      const tail = gap + '```rust' + eol + 'independent | body' + eol + '```' + eol;
      const text = table + tail;
      const read = source.readTable({ text, space: 'original' }, 0);
      assert.equal(read.value.hasRaw, false);
      assert.equal(read.next, table.length);
      const expected = undiscounted(text);
      expected.fencedLines = 3;
      expected.pipes--;
      expected.units = expected.lines - 0.8 * expected.fencedLines + expected.pipes;
      assert.deepEqual(helpers.estimateRenderUnits(text), expected);
    }
  }
});

test('raw first-cell openers after exterior blank lines remain wholly undiscounted', () => {
  for (const eol of ['\n', '\r\n']) {
    const body = '😀 | 日本語' + eol + '| opaque | data |' + eol +
      ' ``` | indented data';
    const text = '| \t' + eol + eol + '\t```unknown' + eol + body + eol +
      '``` | neighbor |' + eol + '| --- | --- |' + eol;
    assert.deepEqual(helpers.estimateRenderUnits(text), undiscounted(text));
  }
});

test('failed new whitespace lookahead preserves ordinary document-fence classification', () => {
  for (const tail of ['A|B\nnot closed\n', 'A|B\n```\nprose | not a suffix\n']) {
    const text = '| \n\n```rust\n' + tail;
    const read = source.readRow({ text, space: 'original' }, 0);
    assert.equal(read.kind, 'complete');
    assert.equal(read.next, '| \n'.length);
    assert.equal(read.value.cells[0].kind, 'inline');
    const control = helpers.estimateRenderUnits('  ' + text.slice(2));
    assert.ok(control.fencedLines > 0);
    assert.deepEqual(helpers.estimateRenderUnits(text), {
      ...control, pipes: control.pipes + 1, units: control.units + 1
    });
  }
});

test('shared header context protects padded BODY windows in every column with unframed headers too', () => {
  for (const eol of ['\n', '\r\n']) {
    for (const header of ['| A | B | C |', 'A | B | C']) {
      for (const position of [0, 1, 2]) {
        const cells = [' left ', ' middle ', ' right '];
        cells[position] = ' \t' + eol + eol + '````rust' + eol +
          '```' + eol + '😀 | opaque' + eol + '````' + eol + '\t';
        const text = header + eol + '| - | - | - |' + eol +
          '|' + cells.join('|') + '|' + eol;
        const read = source.readTable({ text, space: 'original' }, 0);
        assert.equal(read.kind, 'complete');
        assert.equal(read.value.rows[0].cells[position].kind, 'raw');
        assert.deepEqual(helpers.estimateRenderUnits(text), undiscounted(text));
      }
    }
  }
});

test('plain native boundaries never grant multi-column authority but keep raw costs conservative', () => {
  for (const eol of ['\n', '\r\n']) {
    for (const width of [1, 2, 3]) {
      const prefix = '|' + ' H |'.repeat(width) + eol +
        '|' + ' - |'.repeat(width) + eol;
      const cells = Array(width).fill(' left ');
      cells[width - 1] = ' ' + eol + eol + '````rust' + eol +
        '```' + eol + '😀 | data' + eol + '````' + eol + '\t';
      const text = prefix + 'plain' + eol + '|' + cells.join('|') + '|' + eol;
      const input = { text, space: 'original' };
      const preliminary = source.readTable(input, 0);
      assert.equal(preliminary.next, prefix.length);
      let callbacks = 0;
      const read = source.readTable(input, 0, { nativePlainBodyRun(request) {
        callbacks++;
        return { request, rowCount: 1 };
      } });
      assert.equal(callbacks, width === 1 ? 1 : 0);
      assert.equal(read.next, width === 1 ? text.length : prefix.length);
      assert.equal(read.value.hasRaw, width === 1);
      assert.deepEqual(helpers.estimateRenderUnits(text), undiscounted(text));
    }
  }
});

test('terminal pipes and blank or ordinary-fence boundaries cannot reuse an old BODY width', () => {
  for (const eol of ['\n', '\r\n']) {
    const table = '| A | B | C |' + eol + '| - | - | - |' + eol +
      '| one | two | three |' + eol;
    const tail = eol + '| value | ' + eol + eol + '```text' + eol +
      'ordinary | body' + eol + '``` | independent |' + eol;
    const text = table + tail;
    const expected = undiscounted(text);
    expected.fencedLines = 3;
    expected.pipes -= 3;
    expected.units = expected.lines - 0.8 * expected.fencedLines + expected.pipes;
    assert.deepEqual(helpers.estimateRenderUnits(text), expected);
    const fenced = table + '```x|label' + eol + '| ```rust' + eol +
      'opaque | data' + eol + '```' + eol;
    const control = helpers.estimateRenderUnits('```x|label' + eol + '| ```rust' + eol +
      'opaque | data' + eol + '```' + eol);
    assert.equal(control.fencedLines, 4);
    assert.equal(control.pipes, 1, 'only the opener label pipe precedes the ordinary fence');
    const before = helpers.estimateRenderUnits(table);
    assert.deepEqual(helpers.estimateRenderUnits(fenced), {
      units: before.units + control.units - 1,
      lines: before.lines + control.lines - 1,
      pipes: before.pipes + control.pipes,
      fencedLines: control.fencedLines
    });
  }
});

test('complete padded HEADER witnesses protect every column and multiple cells without fence-state leaks', () => {
  for (const eol of ['\n', '\r\n']) {
    const body = '```' + eol + '😀 | data' + eol + ' ``` | indented';
    const slot = ' \t' + eol + eol + '````rust' + eol + body + eol + '````' + eol + '\t';
    for (const positions of [[0], [1], [2], [0, 1, 2]]) {
      const cells = [' left ', ' middle ', ' right '];
      for (const position of positions) cells[position] = slot;
      const raw = '|' + cells.join('|') + '|' + eol + '| - | - | - |' + eol;
      const read = source.readTableHeader({ text: raw, space: 'original' }, 0);
      assert.equal(read && read.kind, 'complete');
      assert.deepEqual(helpers.estimateRenderUnits(raw), undiscounted(raw));
      assert.deepEqual(helpers.estimateRenderUnits('\uFEFF' + raw), undiscounted('\uFEFF' + raw));
      const ordinary = '```text' + eol + 'ordinary | code' + eol + '```' + eol + eol;
      const text = ordinary + raw + eol + ordinary;
      const expected = undiscounted(text);
      expected.fencedLines = 6;
      expected.pipes -= 2;
      expected.units = expected.lines - 0.8 * expected.fencedLines + expected.pipes;
      assert.deepEqual(helpers.estimateRenderUnits(text), expected);
    }
  }
});

test('failed HEADER witnesses leave independent document fences and ordinary table costs intact', () => {
  for (const eol of ['\n', '\r\n']) {
    const first = '| left |' + eol + eol;
    const block = '```x' + eol + 'ordinary | data' + eol + '```' + eol;
    for (const text of [
      first + block + '| right |' + eol + '| - | - |' + eol,
      first + block + '| right |' + eol + '| - | invalid | - |' + eol,
      first + block + '| right |' + eol + eol + block + '| - | - | - |' + eol,
      first + '```x' + eol + 'unclosed | data' + eol
    ]) {
      assert.equal(source.readTableHeader({ text, space: 'original' }, 0), null);
      const control = helpers.estimateRenderUnits(text.replace('| left |', '  left  '));
      assert.ok(control.fencedLines > 0, 'the independent ordinary fence was counted');
      assert.deepEqual(helpers.estimateRenderUnits(text), {
        ...control, pipes: control.pipes + 2, units: control.units + 2
      });
    }
    const ordinary = '| A | B |' + eol + '| - | - |' + eol + '| one | two |' + eol;
    const text = ordinary + eol + block + '| neighbor |' + eol + '| - | - |' + eol;
    assert.equal(source.readTable({ text, space: 'original' }, 0).next, ordinary.length);
    const expected = undiscounted(text);
    expected.fencedLines = 3;
    expected.pipes--;
    expected.units = expected.lines - 0.8 * expected.fencedLines + expected.pipes;
    assert.deepEqual(helpers.estimateRenderUnits(text), expected);
  }
});

test('Root H1 H2 H3 chronology and H4 repeated text keep conservative exact guard counts', () => {
  const cases = [
    { fencedLines: 3, text: '| a |\n\n````x\n```inner\npayload\n```` |\n| --- | --- |\n' +
      '| c | d |\n\n```outer\noutside\n```\n' },
    { fencedLines: 6, text: '| a |\n\n```x\nb\n```\n\n|\n| --- |\n\n' +
      '```independent\nkept\n```\n\n| h |\n| --- |\n| v |\n' },
    { fencedLines: 3, text: '| h |\n| --- |\n| v |\n\n```x\noutside\n```\n\n' +
      '|\n| --- | --- |\n| p | q |\n' },
    { fencedLines: 0, text: '~~~~\n| a |\n\n```x\nb\n```\n\n|\n| --- | --- |\n| c | d |\n' +
      '~~~~\n\n| a |\n\n```x\nb\n```\n\n|\n| --- | --- |\n| c | d |\n' }
  ];
  for (const eol of ['\n', '\r\n']) {
    for (const [index, item] of cases.entries()) {
      const text = item.text.replace(/\n/g, eol);
      const expected = undiscounted(text);
      expected.fencedLines = item.fencedLines;
      expected.units = expected.lines - 0.8 * expected.fencedLines + expected.pipes;
      assert.deepEqual(helpers.estimateRenderUnits(text), expected, 'H' + (index + 1));
    }
  }
});

test('raw first row after a document BOM keeps its ticks out of ordinary fence state', () => {
  const text = '\uFEFF' + rawTable('```\nA|B\n~~~') + '\n```text\nordinary | code\n```\n';
  const expected = undiscounted(text);
  expected.fencedLines = 3;
  expected.pipes--;
  expected.units = expected.lines - 0.8 * expected.fencedLines + expected.pipes;
  assert.deepEqual(helpers.estimateRenderUnits(text), expected);
});

test('browser global uses shared recognition, with explicit missing-provider failure', () => {
  const code = fs.readFileSync(require.resolve('../src/file-helpers-core'), 'utf8');
  let calls = 0;
  const context = { window: { MarkalooTableSource: {
    readRow(input, start, bodyColumns) {
      calls++;
      return source.readRow(input, start, bodyColumns);
    },
    readTableHeader(input, start) {
      calls++;
      return source.readTableHeader(input, start);
    }
  } }, navigator: { platform: 'Win32' } };
  vm.runInNewContext(code, context);
  const text = rawTable('| ```x\n'.repeat(1000) + 'tail|data');
  for (const candidate of [text, '| \n\t\n' + text.slice(2)]) {
    calls = 0;
    const actual = context.window.MarkalooFileHelpers.estimateRenderUnits(candidate);
    assert.deepEqual({ ...actual }, undiscounted(candidate));
    assert.equal(calls, 1, 'one shared header receipt must protect the whole raw window');
  }
  const missing = { window: {}, navigator: { platform: 'Win32' } };
  vm.runInNewContext(code, missing);
  assert.throws(() => missing.window.MarkalooFileHelpers.estimateRenderUnits(rawTable('A')),
    /Load table-source/);
});

test('disabling raw-window recognition exposes the undercount while ordinary controls remain exact', () => {
  const code = fs.readFileSync(require.resolve('../src/file-helpers-core'), 'utf8');
  const anchor = "if (row && (row.kind === 'literal' ||";
  assert.equal(code.split(anchor).length, 2, 'sensitivity anchor resolves exactly once');
  const context = { window: { MarkalooTableSource: source }, navigator: { platform: 'Win32' } };
  vm.runInNewContext(code.replace(anchor, "if (false && (row.kind === 'literal' ||"), context);
  const mutant = context.window.MarkalooFileHelpers;
  const text = rawTable('```\nopaque | body\n```not a closer');
  const incomplete = '| ```x\nopaque\n```\nmore | data\n';
  for (const candidate of [text, incomplete]) {
    const expected = undiscounted(candidate);
    const actual = mutant.estimateRenderUnits(candidate);
    assert.ok(actual.units < expected.units, 'removing the guard must undercount this witness');
    assert.notDeepEqual({ ...actual }, expected);
  }
  for (const control of ['plain\ntext', '| a | b |\n| - | - |\n', '```\nA|B\n```\n']) {
    assert.deepEqual({ ...mutant.estimateRenderUnits(control) }, helpers.estimateRenderUnits(control));
  }
});

if (process.argv.includes('--measure')) {
  const baselineArg = process.argv.find(arg => arg.startsWith('--baseline-core='));
  let baseline = null;
  let candidate = helpers;
  if (baselineArg) {
    const context = { window: {}, navigator: { platform: 'Win32' } };
    vm.runInNewContext(fs.readFileSync(baselineArg.slice('--baseline-core='.length), 'utf8'), context);
    baseline = context.window.MarkalooFileHelpers;
    const candidateContext = { window: { MarkalooTableSource: source },
      navigator: { platform: 'Win32' } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/file-helpers-core'), 'utf8'),
      candidateContext);
    candidate = candidateContext.window.MarkalooFileHelpers;
  }
  const profiles = {
    closed: size => rawTable('A|B 😀\n'.repeat(size)),
    malformed: size => rawTable('A|B 😀\n'.repeat(size)).replace('| --- | --- |', '| - |'),
    incomplete: size => '| ````sql\n' + '| ```inner\nA|B 😀\n'.repeat(size),
    surrounding: size => '```text\nA|B\n```\n\n' + rawTable('A|B 😀\n'.repeat(size)) +
      '\n```text\nA|B\n```\n',
    paddedClosed: size => '| \n\t\n' + rawTable('A|B 😀\n'.repeat(size)).slice(2),
    paddedBody: size => '| A | B |\n| - | - |\n| left | \n\n````rust\n' +
      'A|B 😀\n'.repeat(size) + '````\n\t|\n',
    paddedHeader: size => '| left |\n\n````rust\n' +
      'A|B 😀\n'.repeat(size) + '````\n\t| right |\n| - | - | - |\n',
    paddedHeaderFailedProbes: size => '| left |\n\n```label\nunclosed\n'.repeat(size),
    paddedFailedProbes: size => '| \n\n```label\nunclosed\n'.repeat(size),
    ordinaryProse: size => 'ordinary prose without a table\n'.repeat(size),
    ordinaryTables: size => '| a | b | c |\n| - | - | - |\n'.repeat(size),
    ordinaryTablesWithFence: size => '```text\nordinary\n```\n\n' +
      '| a | b | c |\n| - | - | - |\n'.repeat(size),
    ordinaryCode: size => '```text\n' + 'a|b\n'.repeat(size) + '```\n'
  };
  for (const [profile, build] of Object.entries(profiles)) {
    for (const size of [8192, 32768]) {
      const text = build(size);
      const expected = helpers.estimateRenderUnits(text);
      if (baseline && profile.startsWith('ordinary')) {
        assert.deepEqual({ ...baseline.estimateRenderUnits(text) }, expected);
      }
      const measurements = {};
      for (const [name, estimator] of Object.entries({ candidate, ...(baseline ? { baseline } : {}) })) {
        const samples = [];
        for (let warmup = 0; warmup < 3; warmup++) estimator.estimateRenderUnits(text);
        for (let rep = 0; rep < 9; rep++) {
          const start = performance.now();
          const actual = estimator.estimateRenderUnits(text);
          samples.push(performance.now() - start);
          if (name === 'candidate') assert.deepEqual({ ...actual }, expected);
        }
        samples.sort((a, b) => a - b);
        measurements[name] = { samples: samples.length, p50Ms: samples[4], p95Ms: samples[8] };
      }
      console.log(JSON.stringify({ profile, utf16: text.length, measurements, result: expected }));
    }
  }
}

console.log(`raw-table-cost: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
