"use strict";

const assert = require('node:assert/strict');
const marked = require(process.env.MARKALOO_MARKED_PATH || '../libs/vendor/marked.min.js');
const tables = require('../src/table-marked');
const { cases } = require('./fixtures/table-code-literals');
let passed = 0, failed = 0;
const test = (name, body) => {
  try { body(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
};
const ticks = '`'.repeat(4);
const snippet = (body, language = 'rust', eol = '\n') =>
  ticks + language + eol + body.replace(/\n/g, eol) + eol + ticks;
const row = cells => '| ' + cells.join(' | ') + ' |';
const wrap = (cells, eol = '\n') => row(['left', 'middle', 'right']) + eol +
  '| --- | :---: | ---: |' + eol + row(cells) + eol;
const decode = text => text.replace(/&(amp|lt|gt|quot);/g,
  (match, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[entity]);
const bodies = html => [...html.matchAll(/<code class="table-fenced-code[^"]*">([\s\S]*?)<\/code>/g)]
  .map(match => decode(match[1]));

for (const fixture of cases) for (const eol of ['\n', '\r\n']) test(
  fixture.id + (eol === '\n' ? ' LF' : ' CRLF'), () => {
    const fenced = snippet(fixture.body, fixture.language, eol);
    const text = '# Before' + eol + eol + wrap(['neighbor', fenced, 'outside'], eol) + eol + '# After';
    const parser = tables.create(marked), tokens = parser.lexer(text);
    assert.equal(tokens.filter(token => token.type === 'markalooRawTable').length, 1);
    const html = parser.parser(tokens);
    assert.deepEqual(bodies(html), [fixture.body]);
    assert.equal((html.match(/<td/g) || []).length, 3);
    assert.equal((html.match(/<h1/g) || []).length, 2);
    assert.ok(!html.includes('<script>') && !html.includes('<img src='));
    const ranges = tables.protectedRanges(text, marked);
    assert.equal(ranges.length, 1);
    assert.equal(text.slice(ranges[0].start, ranges[0].end), fenced);
  });

test('raw header, multiple cells, unknown and unlabelled bodies share one interpretation', () => {
  const text = row([snippet('A | B', ''), 'name', snippet(':smile: <b>literal</b>', 'unknown')]) +
    '\n| --- | --- | --- |\n' + row(['value', snippet('~~~mermaid\nA-->B', 'mermaid'), 'end']) + '\n';
  const parser = tables.create(marked);
  assert.deepEqual(bodies(parser.parse(text)),
    ['A | B', ':smile: <b>literal</b>', '~~~mermaid\nA-->B']);
  assert.equal(tables.protectedRanges(text, marked).length, 3);
});

test('ordinary cells resolve definitions declared after the table', () => {
  const text = wrap(['[later][target]', snippet('raw'), 'last']) +
    '\n[target]: https://example.invalid/ref "owned"\n';
  assert.match(tables.create(marked).parse(text),
    /<a href="https:\/\/example\.invalid\/ref" title="owned">later<\/a>/);
});

test('a raw header can use the single-column unframed delimiter', () => {
  const text = row([snippet('A | B')]) + '\n---\n| neighbor |\n';
  assert.deepEqual(bodies(tables.create(marked).parse(text)), ['A | B']);
});

for (const ordinary of ['| only |', '| first | second | EXTRA_ONLY |']) test(
  'ordinary row keeps native header width: ' + ordinary, () => {
    const text = row([snippet('raw'), 'other']) + '\n| --- | ---: |\n' + ordinary + '\n';
    const annotations = [], parser = tables.create(marked, { annotate(kind, span, html) {
      if (kind === 'cell') annotations.push(span);
      return html;
    } });
    const tokens = parser.lexer(text), receipt = tokens[0].syntax.value;
    const originalCount = ordinary.includes('EXTRA_ONLY') ? 3 : 1;
    assert.equal(receipt.rows[0].cells.length, originalCount);
    const html = parser.parser(tokens), body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
    const native = new marked.Marked().parse('| left | other |\n| --- | ---: |\n' + ordinary + '\n');
    assert.equal(body.trim(), native.match(/<tbody>([\s\S]*?)<\/tbody>/)[1].trim());
    assert.equal(annotations.length, 2 + Math.min(originalCount, 2));
    assert.ok(!html.includes('EXTRA_ONLY'));
  });

test('a native single-column unframed header can precede a raw body row', () => {
  const prefix = 'Header\n| --- |\n';
  assert.equal(new marked.Marked().lexer(prefix)[0].type, 'table');
  const text = prefix + row([snippet('A | B')]) + '\n';
  assert.deepEqual(bodies(tables.create(marked).parse(text)), ['A | B']);
});

test('a document-initial BOM stays outside absolute table receipts and literal code', () => {
  const fenced = snippet('\uFEFFbody | data'), text = '\uFEFF' + wrap(['first', fenced, 'last']);
  const parser = tables.create(marked), token = parser.lexer(text)[0];
  assert.equal(token.type, 'markalooRawTable');
  assert.equal(token.syntax.input.text, text);
  assert.equal(token.syntax.value.span.start, 1);
  assert.deepEqual(bodies(parser.parser([token])), ['\uFEFFbody | data']);
  const ranges = tables.protectedRanges(text, marked);
  assert.equal(ranges.length, 1);
  assert.equal(text.slice(ranges[0].start, ranges[0].end), fenced);
});

for (const eol of ['\n', '\r\n']) for (const column of [0, 1, 2]) test(
  `padded body column ${column + 1} ${eol === '\n' ? 'LF' : 'CRLF'} keeps literal spans`, () => {
    const body = '\uFEFFdata \u{1f642} | <script>literal</script>\n@@@html\n:smile:\n@@@';
    const fenced = snippet(body, 'rust', eol);
    const cells = ['first', 'middle', 'last'];
    cells[column] = ' \t' + eol + '\t' + eol + '  ' + fenced + ' \t' + eol + '\t' + eol + ' ';
    const prefix = '\uFEFF' + eol + eol + '# Before \u{1f642}' + eol + eol;
    assert.equal(new marked.Marked({ ...marked.defaults }).lexer(prefix)
      .filter(token => token.type === 'heading').length, 1);
    const text = prefix + wrap(cells, eol) + eol + '# After';
    const annotations = [], parser = tables.create(marked, { annotate(kind, span, html, token) {
      annotations.push({ kind, span, at: token.at });
      return html;
    } });
    const tokens = parser.lexer(text), raw = tokens.filter(token => token.type === 'markalooRawTable');
    assert.equal(raw.length, 1);
    assert.equal(raw[0].syntax.kind, 'complete');
    assert.equal(raw[0].syntax.value.rows.length, 1);
    const html = parser.parser(tokens);
    assert.deepEqual(bodies(html), [body]);
    assert.equal((html.match(/<td/g) || []).length, 3);
    assert.equal((html.match(/<h1/g) || []).length, 2);
    assert.ok(!html.includes('<script>') && !html.includes('table-source-warning'));
    const code = annotations.filter(entry => entry.kind === 'code');
    assert.equal(code.length, 1);
    const lexerText = raw[0].syntax.input.text;
    assert.equal(lexerText.slice(code[0].at + code[0].span.start, code[0].at + code[0].span.end), body);
    const source = tables.createTableReader({ text, space: 'original' }, marked)(prefix.length);
    assert.equal(source.kind, 'complete');
    const cell = source.value.rows[0].cells[column];
    assert.equal(text.slice(cell.content.start, cell.content.end), fenced);
    assert.equal(text.slice(cell.fence.body.start, cell.fence.body.end), body.replace(/\n/g, eol));
    const ranges = tables.protectedRanges(text, marked);
    assert.equal(ranges.length, 1);
    assert.equal(text.slice(ranges[0].start, ranges[0].end), fenced);
  });

for (const eol of ['\n', '\r\n']) test(
  `padding discovery preserves separate native blocks ${eol === '\n' ? 'LF' : 'CRLF'}`, () => {
    for (const lastRow of ['| first | middle | last |', '| first | ']) {
      const text = ['| A | B | C |', '| --- | --- | --- |', lastRow, '',
        '```rust', 'separate | body', '```', ''].join(eol);
      assert.equal(tables.create(marked).parse(text),
        new marked.Marked({ ...marked.defaults }).parse(text));
      assert.deepEqual(tables.protectedRanges(text, marked), []);
    }
  });

test('padded raw rows after native plain runs reuse first-slot authority', () => {
  for (const header of ['Only', '| Only |']) for (const eol of ['\n', '\r\n']) {
    const body = '\uFEFFliteral | data\n  ````\nstill body';
    const fenced = snippet(body, 'rust', eol);
    const text = [header, '| --- |', 'plain before',
      row([' \t' + eol + '\t' + fenced + eol + ' \t']), 'plain after'].join(eol);
    const input = { text, space: 'original' }, receipt = tables.createTableReader(input, marked)();
    assert.equal(receipt.kind, 'complete');
    assert.equal(receipt.next, text.length);
    assert.equal(receipt.value.rows.length, 3);
    assert.equal(text.slice(receipt.value.rows[1].cells[0].content.start,
      receipt.value.rows[1].cells[0].content.end), fenced);
    assert.deepEqual(bodies(tables.create(marked).parse(text)), [body]);
    const ranges = tables.protectedRanges(text, marked);
    assert.equal(ranges.length, 1);
    assert.equal(text.slice(ranges[0].start, ranges[0].end), fenced);
  }
});

test('projection width changes with each provider table receipt', () => {
  const text = [3, 1, 2].map(width => {
    const cells = Array.from({ length: width }, () => 'neighbor');
    cells[width - 1] = ' \n\t' + snippet('body ' + width) + '\n ';
    return row(cells.map((cell, index) => 'Header ' + index)) + '\n' +
      row(cells.map(() => '---')) + '\n' + row(cells);
  }).join('\n\n');
  const parser = tables.create(marked), tokens = parser.lexer(text);
  const raw = tokens.filter(token => token.type === 'markalooRawTable');
  assert.equal(raw.length, 3);
  assert.deepEqual(raw.map(token => token.syntax.value.header.cells.length), [3, 1, 2]);
  assert.deepEqual(bodies(parser.parser(tokens)), ['body 3', 'body 1', 'body 2']);
});

test('wider plain-body gaps retain refusal and literal protection, not table authority', () => {
  for (const width of [2, 3]) for (const eol of ['\n', '\r\n']) {
    for (const padded of [false, true]) {
      const fenced = snippet('@@@html\n<script>literal | data</script>\n@@@', 'rust', eol);
      const cells = Array.from({ length: width }, () => 'neighbor');
      cells[width - 1] = padded ? ' \t' + eol + fenced + eol + '\t ' : fenced;
      const text = [row(cells.map((cell, index) => 'Header ' + index)),
        row(cells.map(() => '---')), 'plain', row(cells)].join(eol);
      const receipt = tables.createTableReader({ text, space: 'original' }, marked)();
      assert.equal(receipt.kind, 'refusal');
      assert.equal(receipt.diagnostic.code, 'native-boundary');
      assert.deepEqual(receipt.span, { start: 0, end: text.length });
      const html = tables.create(marked).parse(text);
      assert.match(html, /Markdown block boundary/);
      assert.deepEqual(bodies(html), []);
      assert.ok(!html.includes('<script>'));
      assert.deepEqual(tables.protectedRanges(text, marked), [{ start: 0, end: text.length }]);
    }
  }
});

test('a complete BODY row cannot reopen its final pipe for a later fence', () => {
  for (const eol of ['\n', '\r\n']) {
    const text = ['| A | B | C |', '| --- | --- | --- |', '| one | two | three |', '',
      '```rust', 'separate | body', '``` |', ''].join(eol);
    assert.equal(tables.create(marked).parse(text),
      new marked.Marked({ ...marked.defaults }).parse(text));
    assert.deepEqual(tables.protectedRanges(text, marked), []);
  }
});

test('ordinary document fences keep raw-looking tables literal before later raw tables', () => {
  for (const outer of ['~~~text | literal', '`````text | literal']) for (const eol of ['\n', '\r\n']) {
    const closer = outer.startsWith('~') ? '~~~' : '`````';
    const ordinary = '| Header |\n| --- |\n| value |\n\n' + outer +
      '\n\n| Header |\n| --- |\n| \n' + snippet('inside | ordinary fence') +
      ' |\n' + closer + '\n\n';
    const text = (ordinary + '| Header |\n| --- |\n' + row([snippet('actual | body')]))
      .replace(/\n/g, eol);
    const parser = tables.create(marked), tokens = parser.lexer(text);
    const raw = tokens.filter(token => token.type === 'markalooRawTable');
    assert.equal(raw.length, 1);
    assert.equal(raw[0].syntax.kind, 'complete');
    const html = parser.parser(tokens);
    assert.deepEqual(bodies(html), ['actual | body']);
    assert.ok(html.startsWith(new marked.Marked({ ...marked.defaults }).parse(ordinary)));
    const ranges = tables.protectedRanges(text, marked);
    assert.equal(ranges.length, 1);
    assert.equal(text.slice(ranges[0].start, ranges[0].end), snippet('actual | body', 'rust', eol));
  }
});

for (const eol of ['\n', '\r\n']) for (const column of [0, 1, 2]) test(
  `padded header column ${column + 1} ${eol === '\n' ? 'LF' : 'CRLF'} keeps literal spans`, () => {
    const body = '\uFEFFheader \u{1f642} | <script>literal</script>\n:smile:';
    const fenced = snippet(body, 'unknown', eol), cells = ['first', 'middle', 'last'];
    cells[column] = ' \t' + eol + '\t' + eol + fenced + ' \t' + eol + ' ';
    const prefix = '# Before' + eol + eol;
    const text = prefix + row(cells) + eol + '| --- | :---: | ---: |' + eol +
      row(['one', 'two', 'three']) + eol + eol + '# After';
    const calls = [], parser = tables.create(marked, { annotate(kind, span, html, token) {
      if (kind === 'code') calls.push({ span, token });
      return html;
    } });
    const tokens = parser.lexer(text), raw = tokens.filter(token => token.type === 'markalooRawTable');
    assert.equal(raw.length, 1);
    assert.equal(raw[0].syntax.kind, 'complete');
    const html = parser.parser(tokens);
    assert.deepEqual(bodies(html), [body]);
    assert.equal((html.match(/<th(?:\s|>)/g) || []).length, 3);
    assert.equal((html.match(/<td(?:\s|>)/g) || []).length, 3);
    assert.equal((html.match(/<h1/g) || []).length, 2);
    assert.ok(!html.includes('<script>') && !html.includes('table-source-warning'));
    assert.equal(calls.length, 1);
    const { span, token } = calls[0];
    assert.equal(token.syntax.input.text.slice(token.at + span.start, token.at + span.end), body);
    const input = { text, space: 'original' }, receipt = tables.createTableReader(input, marked)(prefix.length);
    assert.equal(receipt.kind, 'complete');
    assert.equal(receipt.input, input);
    const cell = receipt.value.header.cells[column];
    assert.equal(text.slice(cell.content.start, cell.content.end), fenced);
    assert.equal(text.slice(cell.fence.body.start, cell.fence.body.end), body.replace(/\n/g, eol));
    const ranges = tables.protectedRanges(text, marked);
    assert.equal(ranges.length, 1);
    assert.equal(text.slice(ranges[0].start, ranges[0].end), fenced);
  });

for (const eol of ['\n', '\r\n']) {
  const ending = eol === '\n' ? 'LF' : 'CRLF';
  test(`multiple vertically padded header cells share the canonical receipt ${ending}`, () => {
    const cells = ['left | literal', 'middle \u{1f642}', 'right <b>literal</b>']
      .map(body => ' \t' + eol + snippet(body, 'rust', eol) + eol + '\t ');
    const text = row(cells) + eol + '| --- | --- | --- |' + eol + row(['a', 'b', 'c']) + eol;
    const input = { text, space: 'original' }, receipt = tables.createTableReader(input, marked)();
    assert.equal(receipt.kind, 'complete');
    assert.equal(receipt.next, text.length);
    assert.equal(receipt.input, input);
    assert.deepEqual(receipt.value.header.cells.map(cell => cell.kind), ['raw', 'raw', 'raw']);
    assert.deepEqual(bodies(tables.create(marked).parse(text)),
      ['left | literal', 'middle \u{1f642}', 'right <b>literal</b>']);
    assert.equal(tables.protectedRanges(text, marked).length, 3);
  });

  test(`H1 canonical padded header stays opaque before independent ordinary code ${ending}`, () => {
    const text = ['| a |', '', '````x', '```inner', 'payload', '```` |',
      '| --- | --- |', '| c | d |', '', '```outer', 'outside', '```', ''].join(eol);
    const parser = tables.create(marked), tokens = parser.lexer(text);
    const raw = tokens.filter(token => token.type === 'markalooRawTable');
    assert.equal(raw.length, 1);
    assert.equal(raw[0].syntax.kind, 'complete');
    assert.equal(raw[0].syntax.value.header.cells.length, 2);
    assert.equal(tokens.filter(token => token.type === 'code').length, 1);
    assert.equal(tokens.find(token => token.type === 'code').text, 'outside');
    assert.deepEqual(bodies(parser.parser(tokens)), ['```inner\npayload']);
    const ranges = tables.protectedRanges(text, marked);
    assert.equal(ranges.length, 1);
    assert.equal(text.slice(ranges[0].start, ranges[0].end),
      ['````x', '```inner', 'payload', '````'].join(eol));
  });

  test(`H2 failed header width restores native blocks and later table ${ending}`, () => {
    const text = ['| a |', '', '```x', 'b', '```', '', '|', '| --- |', '',
      '```independent', 'kept', '```', '', '| h |', '| --- |', '| v |', ''].join(eol);
    const native = new marked.Marked({ ...marked.defaults });
    const nativeTables = native.lexer(text).filter(token => token.type === 'table');
    assert.deepEqual(nativeTables.at(-1).header.map(cell => cell.text), ['h']);
    assert.deepEqual(nativeTables.at(-1).rows.map(cells => cells.map(cell => cell.text)), [['v']]);
    const parser = tables.create(marked), tokens = parser.lexer(text);
    assert.equal(tokens.filter(token => token.type === 'markalooRawTable').length, 0);
    assert.deepEqual(tokens.filter(token => token.type === 'table'), nativeTables);
    assert.equal(parser.parser(tokens), native.parse(text));
    assert.deepEqual(tables.protectedRanges(text, marked), []);
  });

  test(`H3 completed BODY cannot steal an independent fence as a new header ${ending}`, () => {
    const text = ['| h |', '| --- |', '| v |', '', '```x', 'outside', '```', '',
      '|', '| --- | --- |', '| p | q |', ''].join(eol);
    const parser = tables.create(marked), tokens = parser.lexer(text);
    assert.equal(tokens.filter(token => token.type === 'markalooRawTable').length, 0);
    assert.equal(tokens[0].type, 'table');
    assert.equal(tokens[0].rows.length, 1);
    assert.equal(tokens.find(token => token.type === 'code').text, 'outside');
    assert.equal(parser.parser(tokens), new marked.Marked({ ...marked.defaults }).parse(text));
    assert.deepEqual(tables.protectedRanges(text, marked), []);
  });

  test(`H4 duplicate header inside a tilde fence cannot capture the outside receipt ${ending}`, () => {
    const block = ['| a |', '', '```x', 'b', '```', '', '|', '| --- | --- |',
      '| c | d |', ''].join(eol);
    const prefix = '~~~~' + eol + block + '~~~~' + eol + eol;
    const text = prefix + block, input = { text, space: 'original' };
    assert.equal(new marked.Marked({ ...marked.defaults }).lexer(text)[0].type, 'code');
    const parser = tables.create(marked), tokens = parser.lexer(text);
    const raw = tokens.filter(token => token.type === 'markalooRawTable');
    assert.equal(raw.length, 1);
    assert.equal(raw[0].syntax.kind, 'complete');
    assert.equal(raw[0].at, prefix.replace(/\r\n/g, '\n').length);
    const html = parser.parser(tokens);
    assert.deepEqual(bodies(html), ['b']);
    assert.ok(html.startsWith(new marked.Marked({ ...marked.defaults }).parse(prefix)));
    const receipt = tables.createTableReader(input, marked)(prefix.length);
    assert.equal(receipt.kind, 'complete');
    assert.equal(receipt.input, input);
    assert.equal(receipt.value.span.start, prefix.length);
    assert.equal(receipt.next, text.length);
    const start = prefix.length + ('| a |' + eol + eol).length;
    assert.deepEqual(tables.protectedRanges(text, marked),
      [{ start, end: start + ['```x', 'b', '```'].join(eol).length }]);
  });
}

test('metadata spans are token-relative and do not alter visible HTML', () => {
  const text = '# Before\n\n' + wrap(['first', snippet('body'), 'last']);
  const plain = tables.create(marked).parse(text), calls = [];
  const html = tables.create(marked, { annotate(kind, span, html, token) {
    calls.push({ kind, span, token });
    return html.replace(/^<([a-z][\w-]*)/,
      match => match + ' data-test-span="' + kind + ':' + span.start + ':' + span.end + '"');
  } }).parse(text);
  assert.equal(html.replace(/ data-test-span="[^"]*"/g, ''), plain);
  const code = calls.find(call => call.kind === 'code');
  assert.ok(code && code.token.at > 0);
  assert.equal(text.slice(code.token.at + code.span.start, code.token.at + code.span.end), 'body');
  assert.equal(calls.find(call => call.kind === 'table').token.syntax.input.space, 'lexer');
  assert.equal(tables.create(marked).parse(text), plain);
});

test('missing closer renders the exact literal remainder with a clear warning', () => {
  const text = '| ```rust\nA | B\n\n# Not recovery\n<script>literal</script>';
  const html = tables.create(marked).parse(text);
  assert.match(html, /table-source-warning/);
  assert.match(html, /code fence is not closed/);
  assert.ok(!html.includes('<script>'));
  const encoded = /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(html);
  assert.ok(encoded);
  assert.equal(decode(encoded[1]), text);
  assert.deepEqual(tables.protectedRanges(text, marked), [{ start: 0, end: text.length }]);
});

test('ordinary tables and fenced documents retain native rendering', () => {
  for (const text of ['| A | B |\n| --- | --- |\n| one | two |\n',
    '```rust\n| ```unknown\nbody\n``` |\n```\n']) {
    const expected = new marked.Marked({ ...marked.defaults }).parse(text);
    assert.equal(tables.create(marked).parse(text), expected);
    assert.deepEqual(tables.protectedRanges(text, marked), []);
  }
});

test('nested containers cannot create custom raw table tokens', () => {
  const text = wrap(['first', snippet('body'), 'last']);
  for (const nested of [text.split('\n').map(line => '> ' + line).join('\n'),
    '- item\n\n' + text.split('\n').map(line => '  ' + line).join('\n')]) {
    const parser = tables.create(marked), tokens = parser.lexer(nested);
    parser.walkTokens(tokens, token => assert.notEqual(token.type, 'markalooRawTable'));
  }
});

test('opaque info labels cannot become markup or enable language guessing', () => {
  const html = tables.create(marked).parse(wrap(['first', snippet('<b>&lt;</b>', 'x"><img'), 'last']));
  assert.deepEqual(bodies(html), ['<b>&lt;</b>']);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('language-'));
});

test('raw discovery respects app HTML blocks without losing root coordinates', () => {
  const rawHtml = /@@@html(?:\([^)\r\n]*\))?[ \t]*[\r\n]+([\s\S]*?)[\r\n][ \t]*@@@[ \t]*/g;
  const outside = '@@@html\n| ```rust\nthis is HTML data\n@@@\n\n';
  const fenced = snippet('@@@html\n<b>literal</b>\n@@@\n\n:smile:');
  const text = outside + wrap(['first', fenced, 'last']);
  const ranges = tables.protectedRanges(text, marked, rawHtml);
  assert.equal(ranges.length, 1);
  assert.equal(text.slice(ranges[0].start, ranges[0].end), fenced);
  assert.ok(ranges[0].start > outside.length);
});

test('one shared reader preserves native plain bodies in every supplied coordinate space', () => {
  for (const header of ['Only', '| Only |']) for (const eol of ['\n', '\r\n']) {
    for (const bom of ['', '\uFEFF']) for (const space of ['original', 'editor', 'lexer']) {
      const input = { text: bom + [header, '| --- |', 'plain \u{1f642}'].join(eol), space };
      const read = tables.createTableReader(input, marked)(bom.length);
      assert.equal(read.kind, 'complete');
      assert.equal(read.input, input);
      assert.equal(read.input.space, space);
      assert.equal(read.value.rows.length, 1);
      const cell = read.value.rows[0].cells[0];
      assert.equal(input.text.slice(cell.content.start, cell.content.end), 'plain \u{1f642}');
      assert.equal(read.next, input.text.length);
    }
  }
});

test('raw and plain native rows interleave without sharing an inline-definition queue', () => {
  const body = '[not-a-definition]: https://example.invalid/raw\n:smile: | data';
  for (const eol of ['\n', '\r\n']) for (const final of ['', eol]) {
    const text = ['| Only |', '| --- |', 'plain', row([snippet(body, 'rust', eol)]),
      'after', '| [later][target] |', 'last'].join(eol) + final;
    const read = tables.createTableReader({ text, space: 'original' }, marked)();
    assert.equal(read.kind, 'complete');
    assert.equal(read.value.rows.length, 5);
    assert.equal(read.next, text.length);
    const parser = tables.create(marked), tokens = parser.lexer(text + eol + eol +
      '[target]: https://example.invalid/real\n');
    assert.equal(tokens.filter(token => token.type === 'markalooRawTable').length, 1);
    assert.deepEqual(bodies(parser.parser(tokens)), [body]);
    assert.equal(tokens.links['not-a-definition'], undefined);
    assert.equal(tokens.links.target.href, 'https://example.invalid/real');
    assert.match(parser.parser(tokens), /href="https:\/\/example\.invalid\/real"/);
  }
});

test('pipe-bearing native block stops refuse opaquely instead of resuming a raw table', () => {
  for (const boundary of ['# Heading | boundary', '- list | boundary',
    '```text | boundary', '<div data-value="a|b">']) {
    const prefix = '# Before\n\n';
    const candidate = ['| Only |', '| --- |', row([snippet(':smile:\n@@@html\n<script>literal</script>\n@@@')]),
      'plain', boundary, '', row([snippet('later')])].join('\n');
    const text = prefix + candidate, input = { text, space: 'original' };
    const read = tables.createTableReader(input, marked)(prefix.length);
    assert.equal(read.kind, 'refusal', boundary);
    assert.equal(read.input, input);
    assert.equal(read.diagnostic.code, 'native-boundary');
    assert.deepEqual(read.span, { start: prefix.length, end: text.length });
    const parser = tables.create(marked), tokens = parser.lexer(text);
    assert.equal(tokens[0].type, 'heading');
    const token = tokens.find(token => token.type === 'markalooRawTable');
    assert.equal(token.syntax.kind, 'refusal');
    const html = parser.parser(tokens);
    assert.match(html, /Markdown block boundary/);
    assert.ok(!html.includes('<script>') && !html.includes('table-fenced-code'));
    assert.equal(decode(/<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(html)[1]), candidate);
    assert.deepEqual(tables.protectedRanges(text, marked), [{ start: prefix.length, end: text.length }]);
  }
});

test('ordinary pipe-bearing block boundaries retain unextended native behavior', () => {
  for (const boundary of ['# Heading | boundary', '- list | boundary', '```text | boundary\n```',
    '<div data-value="a|b">\n</div>']) {
    const text = '| Only |\n| --- |\nplain\n' + boundary;
    assert.equal(tables.create(marked).parse(text), new marked.Marked({ ...marked.defaults }).parse(text));
    assert.deepEqual(tables.protectedRanges(text, marked), []);
  }
});

test('real final-newline lookahead distinguishes a plain div row from an HTML block', () => {
  for (const raw of [false, true]) for (const final of ['', '\n']) {
    const text = '| Only |\n| --- |\n' + (raw ? row([snippet('opaque | body')]) + '\n' : '') + '<div' + final;
    const read = tables.createTableReader({ text, space: 'original' }, marked)();
    assert.equal(read.kind, 'complete');
    assert.equal(read.value.rows.length, Number(raw) + Number(!final));
    assert.equal(read.next, final ? text.indexOf('<div') : text.length);
    if (raw) assert.deepEqual(bodies(tables.create(marked).parse(text)), ['opaque | body']);
  }
});

test('bound readers reject changed Snapshots and analyse a full input only once', () => {
  let lexes = 0;
  const namespace = { ...marked, Marked: class extends marked.Marked {
    lexer(text, options) { lexes++; return super.lexer(text, options); }
  } };
  const text = Array.from({ length: 40 }, (_, i) => '| H' + i + ' |\n| --- |\nplain' + i + '\n\n').join('');
  const input = { text, space: 'original' }, read = tables.createTableReader(input, namespace);
  for (let at = 0; at < text.length;) {
    const result = read(at);
    assert.equal(result.kind, 'complete');
    assert.equal(read(at), result);
    at = text.indexOf('| H', result.next);
    if (at < 0) break;
  }
  assert.equal(lexes, 1);
  input.space = 'editor';
  assert.throws(() => read(0), /Snapshot changed/);
  input.space = 'original';
  input.text += 'changed';
  assert.throws(() => read(0), /Snapshot changed/);
});

console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
