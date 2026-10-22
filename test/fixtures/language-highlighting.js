"use strict";

// Deliberately separate from the frozen theme census: its token partition is
// part of the historical palette oracle, not a language-coverage fixture.
const cases = [
  {
    language: "rust", aliases: [],
    source: [
      "/* outer /* nested */ comment */",
      "fn borrow<'a>(value: &'a str) -> &'a str {",
      '    let escaped = "<script>window.syntaxInjected=true</script>&";',
      '    let raw = r##"<b>raw & \\"quoted\\"</b>"##;',
      '    println!("{}", raw); // a line comment',
      "    value",
      "}",
    ].join("\n"),
    probes: [
      ["keyword", "fn"], ["lifetime-annotation", "'a"],
      ["string", 'r##"<b>raw & \\"quoted\\"</b>"##'],
      ["macro", "println!"], ["comment", "/* outer /* nested */ comment */"],
    ],
  },
  {
    language: "go", aliases: [],
    source: 'package main\nimport "fmt"\nfunc main() { fmt.Println("<go>&") }\n',
    probes: [["keyword", "package"], ["keyword", "func"], ["string", '"<go>&"']],
  },
  {
    language: "php", aliases: [],
    source: '<article class="sample"><?php $message = "<php>&"; echo $message; ?></article>',
    probes: [["keyword", "echo"], ["variable", "$message"], ["attr-name", "class"]],
  },
  {
    language: "ruby", aliases: ["rb"],
    source: 'class Example\n  def greet(name)\n    puts "<ruby>& #{name}"\n  end\nend',
    probes: [["keyword", "class"], ["keyword", "def"], ["class-name", "Example"]],
  },
  {
    language: "swift", aliases: [],
    source: 'struct Example {\n  let message: String = "<swift>&"\n  func greet() { print(message) }\n}',
    probes: [["keyword", "struct"], ["keyword", "let"], ["string", '"<swift>&"']],
  },
  {
    language: "kotlin", aliases: ["kt", "kts"],
    source: 'data class Example(val name: String)\nfun main() { val message = "<kotlin>&"; println(message) }',
    probes: [["keyword", "class"], ["keyword", "fun"], ["keyword", "val"]],
  },
  {
    language: "dart", aliases: [],
    source: 'class Example {\n  final String message = "<dart>&";\n  void greet() { print(message); }\n}',
    probes: [["keyword", "class"], ["keyword", "final"], ["string", '"<dart>&"']],
  },
  {
    language: "r", aliases: [],
    source: '# R witness\nmessage <- "<r>&"\nif (TRUE) { print(message) }\n',
    probes: [["comment", "# R witness"], ["keyword", "if"], ["string", '"<r>&"']],
  },
  {
    language: "powershell", aliases: [],
    source: '# PowerShell witness\nfunction Get-Greeting { param($Name) Write-Output "<powershell>& $Name" }\n',
    probes: [["keyword", "function"], ["variable", "$Name"], ["comment", "# PowerShell witness"]],
  },
  {
    language: "yaml", aliases: ["yml"],
    source: '# YAML witness\nname: "<yaml>&"\nenabled: true\nitems:\n  - first\n',
    probes: [["key", "name"], ["boolean", "true"], ["string", '"<yaml>&"']],
  },
  {
    language: "toml", aliases: [],
    source: '# TOML witness\n[server]\nname = "<toml>&"\nenabled = true\nport = 8080\n',
    probes: [["table", "server"], ["boolean", "true"], ["string", '"<toml>&"']],
  },
  {
    language: "markdown", aliases: ["md"],
    source: [
      "---", 'title: "<markdown>&"', "enabled: true", "---", "",
      "# Nested markdown", "", "**strong text** and `inline source`.", "",
      "```rust", 'fn nested() { println!("<nested>&"); }', "```",
    ].join("\n"),
    probes: [["title", "# Nested markdown"], ["bold", "**strong text**"],
      ["front-matter", 'title: "<markdown>&"\nenabled: true']],
  },
];

const controls = [
  { language: "not-a-language", source: 'fn plain() { "<unknown>&" }\n<script>not markup</script>' },
  { language: "", source: 'fn plain() { "<unlabelled>&" }\n<b>not markup</b>' },
  { language: "dockerfile", source: "FROM ignored:latest\nRUN echo excluded" },
];
const rustEdges = [
  { label: "rust-incomplete-string", source: 'fn unfinished() { let text = "unterminated' },
  { label: "rust-incomplete-comment", source: "fn comment() {} /* unterminated nested /* comment" },
  { label: "rust-long-line", source: 'fn long_line() { let value = "' +
    "<long>&".repeat(1800) + '"; println!("{}", value); }' },
].map(entry => ({ ...entry, language: "rust", canonical: "rust", probes: [["keyword", "fn"]] }));
const inline = 'let inline = "<inline>&";';
const heading = "Additional official language coverage";
const fence = entry => "~~~~" + entry.language + "\n" + entry.source.replace(/\n?$/, "\n") + "~~~~";
const blocks = cases.flatMap(entry => [entry.language, ...entry.aliases]
  .map(language => ({ ...entry, language, canonical: entry.language }))).concat(rustEdges, controls);
const markdown = "# " + heading + "\n\nUnrelated editable witness.\n\n" +
  "`" + inline + "`\n\n" + blocks.map(fence).join("\n\n") + "\n\n" +
  Array.from({ length: 35 }, (_, i) => "Language tail paragraph " + i + ". " +
    "A source position must stay attached to its rendered text. ".repeat(5)).join("\n\n") + "\n";

module.exports = {
  cases, controls, rustEdges, inline, heading, blocks, markdown,
  componentOrder: ["rust", "go", "markup-templating", "php", "ruby", "swift",
    "kotlin", "dart", "r", "powershell", "yaml", "toml", "markdown"],
};
