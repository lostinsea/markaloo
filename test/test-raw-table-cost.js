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
  const text = '| ```sql\nSELECT \'a|b\';\n\n| next | table |\n| --- | --- |\n``` \n| tail |\n';
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
    readRow(input, start) {
      calls++;
      return source.readRow(input, start);
    }
  } }, navigator: { platform: 'Win32' } };
  vm.runInNewContext(code, context);
  const text = rawTable('| ```x\n'.repeat(1000) + 'tail|data');
  const actual = context.window.MarkalooFileHelpers.estimateRenderUnits(text);
  assert.deepEqual({ ...actual }, undiscounted(text));
  assert.equal(calls, 1, 'opaque body lines must never restart shared lookahead');
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
    ordinaryProse: size => 'ordinary prose without a table\n'.repeat(size),
    ordinaryTables: size => '| a | b | c |\n| - | - | - |\n'.repeat(size),
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
