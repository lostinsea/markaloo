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
