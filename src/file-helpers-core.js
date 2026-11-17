(function () {
// ============================================
// file-helpers-core.js - Shared File Helpers
// ============================================

/**
 * Supported file extensions
 */
const SUPPORTED_EXTENSIONS = {
  markdown: ['.md', '.markdown', '.mdown', '.mkd', '.mkdn'],
  mermaid: ['.mmd', '.mermaid'],
};

// Cost model for estimateRenderUnits(). Both constants are FITTED to
// measurements in bench/BASELINE.md and should be re-derived, not adjusted by
// taste, if the renderer's cost profile changes.
//
// MS_PER_UNIT is the conservative end of the seven profiles (lists, 47us);
// the median is nearer 34us, so the estimate errs toward warning early, which
// is the correct direction for a guard. FENCED_LINE_DISCOUNT is why the `code`
// profile - 38415 of its 48019 lines inside fences - is not mistaken for the
// most expensive document in the corpus when it is nearly the cheapest.
const MS_PER_UNIT = 0.047;
const FENCED_LINE_DISCOUNT = 0.8;

const tableSource = typeof module !== 'undefined' && module.exports
  ? require('./table-source')
  : window.MarkalooTableSource;

// A document predicted to take longer than this to become readable is treated
// as large. At 10s this is roughly 2.1 MB of dense tables, 4.9 MB of mixed
// content, or 35 MB of prose - it targets documents that are expensive, not
// documents that are merely long.
const LARGE_DOC_BUDGET_MS = 10000;

// Node uses different path.extname separators by OS. The browser has no Node
// process after isolation; navigator.platform keeps its native filename rules.
const isWindowsPath = typeof process !== 'undefined' &&
  typeof process.platform === 'string'
  ? process.platform === 'win32'
  : navigator.platform.startsWith('Win');

// Trailing separators do not change the name; a leading dot alone is not an
// extension, but the second dot in ..mmd is.
function fileExtension(filePath) {
  if (typeof filePath !== 'string') {
    throw new TypeError('The "path" argument must be of type string');
  }
  let end = filePath.length;
  while (end > 0 && (filePath[end - 1] === '/' ||
    (isWindowsPath && filePath[end - 1] === '\\'))) {
    end--;
  }
  let start = filePath.lastIndexOf('/', end - 1);
  if (isWindowsPath) {
    start = Math.max(start, filePath.lastIndexOf('\\', end - 1));
    // C:.mmd is a drive-relative dotfile, not a name with a .mmd extension.
    if (start === -1 && /^[A-Za-z]:/.test(filePath)) {
      start = 1;
    }
  }
  const name = filePath.slice(start + 1, end);
  const dot = name.lastIndexOf('.');
  return dot > 0 && name !== '..' ? name.slice(dot).toLowerCase() : '';
}

/**
 * Check if file is a Mermaid diagram file
 * @param {string} filePath - Path to the file
 * @returns {boolean}
 */
function isMermaidFile(filePath) {
  const ext = fileExtension(filePath);
  return SUPPORTED_EXTENSIONS.mermaid.includes(ext);
}

/**
 * Check if file is a Markdown file (or viewable format: mermaid)
 * @param {string} filePath - Path to the file
 * @returns {boolean}
 */
function isMarkdownFile(filePath) {
  const ext = fileExtension(filePath);
  return SUPPORTED_EXTENSIONS.markdown.includes(ext) ||
         SUPPORTED_EXTENSIONS.mermaid.includes(ext);
}

/**
 * Wrap content in mermaid code block if it's a mermaid file
 * @param {string} content - File content
 * @param {string} filePath - Path to the file
 * @returns {string} Wrapped or original content
 */
function wrapMermaidContent(content, filePath) {
  if (isMermaidFile(filePath)) {
    // Check if already wrapped in mermaid code block
    const trimmed = content.trim();
    if (trimmed.startsWith('```mermaid') || trimmed.startsWith('~~~mermaid')) {
      return content; // Already wrapped
    }
    // Wrap in mermaid code block
    return '```mermaid\n' + content + '\n```';
  }
  return content;
}

/**
 * Remove BOM (Byte Order Mark) if present
 * @param {string} content - File content
 * @returns {string} Content without BOM
 */
function removeBOM(content) {
  if (content && content.charCodeAt(0) === 0xFEFF) {
    return content.substring(1);
  }
  return content;
}

function utf8ByteLength(content) {
  if (typeof content !== 'string') {
    throw new TypeError('UTF-8 byte counting requires a string');
  }
  let bytes = content.length;
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if (code <= 0x7f) continue;
    if (code <= 0x7ff) {
      bytes += 1;
      continue;
    }
    bytes += 2;
    // A pair encodes as four bytes; isolated surrogates encode as U+FFFD.
    if (code >= 0xd800 && code <= 0xdbff &&
        content.charCodeAt(index + 1) >= 0xdc00 &&
        content.charCodeAt(index + 1) <= 0xdfff) {
      index += 1;
    }
  }
  return bytes;
}

function countOrdinaryRenderSegment(content, start, end, state) {
  let { lines, pipes, fencedLines, inFence, atLineStart, fenceRun, lineHasContent } = state;
  for (let i = start; i < end; i++) {
    const c = content.charCodeAt(i);
    if (c === 10) {
      lines++;
      if (inFence) fencedLines++;
      if (fenceRun >= 3) {
        inFence = !inFence;
        if (inFence) fencedLines++;
      }
      atLineStart = true;
      fenceRun = 0;
      lineHasContent = false;
      continue;
    }
    if (c === 96 && atLineStart) {
      fenceRun++;
      continue;
    }
    if ((c === 32 || c === 9) && !lineHasContent) continue;
    atLineStart = false;
    lineHasContent = true;
    if (c === 124 && !inFence) pipes++;
  }
  Object.assign(state, { lines, pipes, fencedLines, inFence, atLineStart, fenceRun, lineHasContent });
}

/**
 * Estimate how much work rendering a document will be, WITHOUT parsing it.
 *
 * Byte count is not usable for this. Measured across the seven benchmark
 * profiles at an identical 1 MB, render time spans 260ms to 3353ms - a 12.9x
 * spread - because bytes measure how much text was typed, not how many nodes it
 * becomes. Counting lines instead is worse still (26.9x): a fenced code
 * block is thousands of cheap lines, a table is few but expensive ones.
 *
 * What does predict cost is block count plus table cells, with lines inside
 * fenced code discounted because they skip inline parsing. That scores 1.7x
 * across all seven profiles, including the four it was not fitted on. See
 * bench/BASELINE.md, "Byte count is the wrong trigger for the size guard".
 *
 * The character pass and shared raw-row lookahead are O(n). Raw logical rows
 * stay undiscounted: their internal ticks must not change document-fence state.
 * Ordinary document fences still exclude their pipes from the cell count.
 *
 * @param {string} content - Raw markdown
 * @returns {{units: number, lines: number, fencedLines: number, pipes: number}}
 */
function estimateRenderUnits(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return { units: 0, lines: 0, fencedLines: 0, pipes: 0 };
  }
  const state = { lines: 1, pipes: 0, fencedLines: 0, inFence: false,
    atLineStart: true, fenceRun: 0, lineHasContent: false };
  const input = { text: content, space: 'original' };
  // This is only a cheap physical-line hint. The shared reader owns grammar.
  const mayHaveRaw = content.includes('```') && (content.startsWith('|') ||
    content.startsWith('\uFEFF|') || content.includes('\n|'));
  const candidates = mayHaveRaw ? /(?:^\uFEFF?|\n)\|[^\n]*```/g : null;
  let next = 0;
  let match;
  while (candidates && (match = candidates.exec(content)) !== null) {
    const start = match.index + (content[match.index] === '|' ? 0 : 1);
    countOrdinaryRenderSegment(content, next, start, state);
    next = start;
    if (state.inFence) continue;
    if (!tableSource || typeof tableSource.readRow !== 'function') {
      throw new Error('Load table-source.js before estimating raw table render cost');
    }
    const row = tableSource.readRow(input, start);
    if (row && (row.kind === 'literal' ||
        row.value.cells.some(cell => cell.kind === 'raw'))) {
      for (let index = start; index < row.next; index++) {
        const char = content.charCodeAt(index);
        if (char === 10) state.lines++;
        else if (char === 124) state.pipes++;
      }
      next = row.next;
      state.atLineStart = true;
      state.fenceRun = 0;
      state.lineHasContent = false;
      // Include the consumed newline as the hint for an adjacent raw row.
      candidates.lastIndex = next - 1;
    }
  }
  countOrdinaryRenderSegment(content, next, content.length, state);
  const { lines, pipes, fencedLines } = state;
  const units = Math.max(0, lines - FENCED_LINE_DISCOUNT * fencedLines + pipes);
  return { units, lines, fencedLines, pipes };
}

/**
 * Predicted time-to-readable in milliseconds.
 * @param {string} content - Raw markdown
 * @returns {number}
 */
function estimateRenderMs(content) {
  return estimateRenderUnits(content).units * MS_PER_UNIT;
}

/**
 * Would this document take longer than the budget to become readable?
 * @param {string} content - Raw markdown
 * @param {number} [budgetMs] - Override the default budget
 * @returns {{large: boolean, estimatedMs: number, units: number}}
 */
function isLargeDocument(content, budgetMs = LARGE_DOC_BUDGET_MS) {
  const { units } = estimateRenderUnits(content);
  const estimatedMs = units * MS_PER_UNIT;
  return { large: estimatedMs > budgetMs, estimatedMs, units };
}

const fileHelpersCore = {
  SUPPORTED_EXTENSIONS,
  MS_PER_UNIT,
  FENCED_LINE_DISCOUNT,
  LARGE_DOC_BUDGET_MS,
  isMermaidFile,
  isMarkdownFile,
  wrapMermaidContent,
  removeBOM,
  utf8ByteLength,
  estimateRenderUnits,
  estimateRenderMs,
  isLargeDocument
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = fileHelpersCore;
}
if (typeof window !== 'undefined') {
  window.MarkalooFileHelpers = fileHelpersCore;
}
})();
