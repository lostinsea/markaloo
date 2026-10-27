"use strict";

// Source offsets remain UTF-16, like textarea selections and DOM ranges.
window.FoliaInlineFormatting = (() => {
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
  const immutable = record => {
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) immutable(value);
    }
    return Object.freeze(record);
  };

  // The parser owns recognition in the complete candidate document. The
  // source policy only certifies character mappings; it never searches for a
  // selected occurrence or promotes authored HTML into an editable owner.
  function documentFrames(source, marked) {
    const lexer = new marked.Lexer({ ...marked.defaults, tokenizer: null });
    const definitions = [], original = lexer.tokenizer.def, block = lexer.blockTokens;
    let depth = 0;
    lexer.blockTokens = function (...args) {
      depth++;
      try { return block.apply(this, args); } finally { depth--; }
    };
    lexer.tokenizer.def = function (remaining) {
      const token = original.call(this, remaining);
      if (token && depth === 1) {
        const start = source.length - remaining.length;
        if (source.slice(start) === remaining) definitions.push({ start, end: start + token.raw.length });
      }
      return token;
    };
    let tokens = lexer.lex(source), input = source;
    if (definitions.length) {
      // Mask each interval once, preserving UTF-16 width and line boundaries.
      // Per-character searches over all definitions made every raw input
      // proportional to source length times reference count.
      const chunks = [];
      let cursor = 0;
      for (const { start, end } of definitions.sort((left, right) => left.start - right.start)) {
        if (end <= cursor) continue;
        const from = Math.max(cursor, start);
        chunks.push(source.slice(cursor, from), source.slice(from, end).replace(/[^\n]/g, ' '));
        cursor = end;
      }
      chunks.push(source.slice(cursor));
      input = chunks.join('');
      const clean = new marked.Lexer({ ...marked.defaults, tokenizer: null });
      clean.tokens.links = tokens.links;
      tokens = clean.lex(input);
    }
    const frames = [];
    const walk = (list, text, offsets, inline = false) => {
      let cursor = 0, htmlDepth = 0;
      for (const token of list || []) {
        if (!token.raw || token.type === 'checkbox') continue;
        if (text.slice(cursor, cursor + token.raw.length) !== token.raw) return;
        const positions = offsets.slice(cursor, cursor + token.raw.length + 1);
        cursor += token.raw.length;
        if (inline && token.type === 'html') {
          if (/^<\//.test(token.raw)) htmlDepth = Math.max(0, htmlDepth - 1);
          else if (/^<[a-z]/i.test(token.raw) && !/\/>$/.test(token.raw) &&
              !/^<(?:br|img|hr|input|wbr)(?:\s|>)/i.test(token.raw)) htmlDepth++;
        }
        if (inline && !htmlDepth && ['strong', 'em', 'codespan'].includes(token.type)) {
          const edge = token.type === 'codespan' ? /^`+/.exec(token.raw)[0].length :
            (token.raw.length - token.text.length) / 2;
          const body = token.raw.slice(edge, -edge);
          const padding = token.type === 'codespan' && /^ .* $/.test(body) && /[^ ]/.test(body) ? 1 : 0;
          if (positions.every((value, index) => !index || value === positions[index - 1] + 1)) {
            frames.push({ type: token.type, start: positions[0], end: positions.at(-1),
              bodyStart: positions[edge + padding], bodyEnd: positions[positions.length - 1 - edge - padding] });
          }
        }
        if (htmlDepth || token.type === 'html' || token.type === 'code' || token.type === 'codespan' ||
            token.type === 'image' || token.type === 'table') continue;
        if (token.items) { walk(token.items, token.raw, positions); continue; }
        if (!token.tokens) continue;
        if (['blockquote', 'list_item'].includes(token.type)) {
          const projected = projectContainer(token.raw, token.text, 0);
          if (projected) walk(token.tokens, token.text, projected.map(at => positions[at]));
          continue;
        }
        let from = 0;
        if (['strong', 'em', 'del'].includes(token.type)) from = (token.raw.length - token.text.length) / 2;
        else if (token.type === 'heading') {
          const heading = /^ {0,3}#{1,6}[ \t]+/.exec(token.raw);
          from = heading ? heading[0].length : 0;
        } else if (token.type === 'link') {
          from = token.raw.startsWith('[') ? 1 : token.raw.startsWith('<') ? 1 : 0;
        }
        if (typeof token.text !== 'string' || token.raw.slice(from, from + token.text.length) !== token.text) continue;
        walk(token.tokens, token.text, positions.slice(from, from + token.text.length + 1), true);
      }
    };
    walk(tokens, input, Array.from({ length: input.length + 1 }, (_, at) => at));
    return frames;
  }

  function rawMarkdownPolicy({ source, start, end, marked, protect = value => value }) {
    const frames = value => documentFrames(protect(source.slice(0, start) + value + source.slice(end),
      match => match.replace(/[^\n]/g, ' ')), marked)
      .filter(frame => frame.start >= start && frame.end <= start + value.length)
      .map(frame => Object.fromEntries(Object.entries(frame).map(([key, value]) =>
        [key, typeof value === 'number' ? value - start : value])));
    return {
      raw: true, frames,
      matches(value, element, provenance) {
        const mapped = serializeCell(element, provenance, false, undefined, true);
        const actual = mapped.entries.filter(piece => ['strong', 'em', 'codespan'].includes(piece.tokenType));
        const recognized = frames(value);
        if (actual.some(piece => !recognized.some(frame =>
          frame.type === piece.tokenType && frame.start === piece.start && frame.end === piece.end))) return false;
        const expected = document.createElement('div');
        renderRawPieces(expected, value, actual.map(piece => ({
          type: piece.tokenType, start: piece.start, end: piece.end,
          bodyStart: piece.start + piece.bodyOffset,
          bodyEnd: piece.end - (piece.source.length - piece.bodyOffset -
            (piece.children ? piece.children.reduce((sum, child) => sum + child.source.length, 0) :
              piece.owner.textContent.length)),
        })));
        const key = root => {
          const copy = root.cloneNode(true);
          copy.querySelectorAll('[' + provenance.partAttribute + ']').forEach(node => {
            if (provenance.fragments.get(node.getAttribute(provenance.partAttribute))?.kind === 'boundary') node.remove();
          });
          copy.querySelectorAll('span').forEach(node => node.replaceWith(...node.childNodes));
          copy.querySelectorAll('*').forEach(node => {
            for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
          });
          copy.normalize();
          return copy.innerHTML;
        };
        return key(expected) === key(element);
      },
    };
  }

  function renderRawPieces(element, source, frames, capture) {
    const append = (parent, from, to) => {
      let at = from;
      const children = frames.filter(frame => frame.start >= from && frame.end <= to &&
        !frames.some(other => other !== frame && from <= other.start && other.start < frame.start &&
          other.end > frame.end && other.end <= to));
      for (const frame of children) {
        appendText(parent, at, frame.start);
        const node = document.createElement({ strong: 'strong', em: 'em', codespan: 'code' }[frame.type]);
        append(node, frame.bodyStart, frame.bodyEnd);
        parent.append(node);
        capture?.(node, frame.type, frame.start, frame.end, frame.bodyStart, frame.bodyEnd);
        at = frame.end;
      }
      appendText(parent, at, to);
    };
    const appendText = (parent, from, to) => {
      if (from === to) return;
      const node = document.createElement('span');
      node.textContent = source.slice(from, to);
      parent.append(node);
      capture?.(node, 'text', from, to);
    };
    element.replaceChildren();
    append(element, 0, source.length);
  }

  function prepareRaw(element, source, marked, context) {
    const fragments = new Map(), origin = crypto.randomUUID();
    const partAttribute = context.partAttribute || 'data-folia-inline-part-' + crypto.randomUUID();
    const codeAttribute = context.codeAttribute || 'data-folia-inline-history-' + crypto.randomUUID();
    const policy = context.policy;
    const attributes = node => [...node.attributes].filter(attr =>
      attr.name !== partAttribute && attr.name !== codeAttribute).map(attr => [attr.name, attr.value]);
    const frames = context.literal ? [] : context.generated ? documentFrames(source, marked) : policy.frames(source);
    renderRawPieces(element, source, frames, (node, kind, from, to, bodyStart, bodyEnd) => {
      const id = crypto.randomUUID(), raw = source.slice(from, to);
      node.setAttribute(partAttribute, id);
      fragments.set(id, {
        kind, origin, raw, sourceStart: from, sourceEnd: to,
        ...(kind !== 'text' ? {
          bodyOffset: bodyStart - from, bodyRange: { sourceStart: bodyStart, sourceEnd: bodyEnd },
          delimiter: source.slice(from, bodyStart),
        } : {
          units: Array.from(raw, char => char).reduce((units, char) => {
            const at = units.at(-1)?.to || 0;
            units.push({ from: at, to: at + char.length, raw: char,
              sourceStart: from + at, sourceEnd: from + at + char.length });
            return units;
          }, []),
        }),
        initialText: node.textContent, initial: node.outerHTML, attributes: JSON.stringify(attributes(node)),
      });
    });
    return { fragments, origin, raw: source, initial: element.innerHTML, attributes, policy,
      links: {}, transform: value => value, partAttribute, codeAttribute, sourceLength: source.length };
  }

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
    if (captureContext?.policy?.raw) return prepareRaw(element, raw, marked, captureContext);
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
      // Same-capture nests retain their authored delimiter family. A new
      // cross-capture frame may need another family to preserve its ancestry.
      const retainDelimiters = new Set(frames.filter(frame => frames.some(other => other !== frame &&
        other.origin === frame.origin &&
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
        for (const frame of frames) {
          if (!['em', 'strong'].includes(frame.tokenType) || frame.origin === namespace ||
              retainDelimiters.has(frame.owner) || delimiters.has(frame.owner)) continue;
          const parent = frames.find(other => other.owner === frame.parent);
          if (parent && ['em', 'strong'].includes(parent.tokenType) &&
              (parent.bodyStart === frame.start || parent.bodyEnd === frame.end) &&
              (missing.has(frame.owner) || missing.has(parent.owner))) {
            delimiters.set(frame.owner, (orientation ? '_' : '*').repeat(frame.tokenType === 'strong' ? 2 : 1));
          }
        }
      }
      return { sites, normalize, retainDelimiters, delimiters };
    };
    return { fragments, raw, links, initial: element.innerHTML, attributes, transform, repairSource,
      partAttribute: cellPartAttribute, codeAttribute,
      origin: namespace, sourceLength: text.length };
  }

  const oddCodePipe = /(^|[^\\])(?:\\\\)*\\\|/;

  function markdownCode(text, raw = false) {
    if (!raw && /[\r\n]/.test(text)) fail('tableCells.cellType');
    if (!text) return null;
    // GFM removes one slash before a table pipe. An odd literal slash run
    // cannot round-trip there as a code span; a semantic code tag can.
    if (!raw && oddCodePipe.test(text)) return null;
    const length = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length)) + 1;
    const delimiter = '`'.repeat(length);
    const padding = /^`|`$/.test(text) || (/^ .* $/.test(text) && /[^ ]/.test(text)) ? ' ' : '';
    return delimiter + padding + (raw ? text : text.replace(/\|/g, '\\|')) + padding + delimiter;
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
    if (provenance?.policy?.raw) {
      const body = pieces.map(piece => piece.raw ?? piece.text).join('');
      const source = markdownCode(body, true);
      return source === null ? unsupported('empty-code') :
        { kind: 'markdown', body, text: pieces.map(piece => piece.text).join(''), source,
          bodyOffset: (source.length - body.length) / 2 };
    }
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

  function codeDelimiters(element, provenance, range, inserted = '', marker = '`') {
    const punctuation = text => text.replace(/[\p{P}\p{S}]/gu, char => '!'.repeat(char.length));
    const collect = node => cellTextPieces(node, provenance).flatMap(piece => {
      if (!piece.node) return [piece];
      return [{ boundary: piece.node, edge: 0 },
        ...(piece.node.nodeName === 'CODE' || marker === '*' ? [{ skip: piece.node.textContent }] :
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
      syntax += visible === raw ? visible : marker === '*' ? punctuation(visible) : visible.replace(/`/g, (tick, index) => {
        literalTicks.push({ index: position + index, origin: owner.origin, from: owner.from, to: owner.to });
        return 'x';
      });
      if (visible === raw) {
        for (let index = 0; index < visible.length; index++) {
          const char = visible[index];
          if (char === marker && !(slashes % 2)) {
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
        syntax += marker === '*' ? punctuation(visible) : visible;
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

  function typingSlice(element, provenance, from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 ||
        to < from || to > element.textContent.length) fail('tableCells.mapping');
    const result = document.createDocumentFragment();
    let position = 0;
    for (const piece of [...element.childNodes].flatMap(node => cellTextPieces(node, provenance))) {
      const length = piece.node ? piece.node.textContent.length : piece.text.length;
      const start = position;
      position += length;
      if (!length && piece.node) {
        if (from <= start && start <= to) result.append(piece.node.cloneNode(true));
        continue;
      }
      if (position <= from || start >= to) continue;
      const first = Math.max(from, start) - start, last = Math.min(to, position) - start;
      if (piece.node) {
        if (first || last !== length) return null;
        result.append(piece.node.cloneNode(true));
        continue;
      }
      if (piece.raw !== undefined && (piece.atomic || piece.raw !== piece.text) &&
          (first || last !== length)) return null;
      const text = piece.text.slice(first, last);
      if (piece.raw === undefined) { result.append(document.createTextNode(text)); continue; }
      const raw = first || last !== length ? piece.raw.slice(first, last) : piece.raw;
      const sourceStart = piece.from + (piece.raw === piece.text ? first : 0);
      const sourceEnd = piece.to - (piece.raw === piece.text ? length - last : 0);
      const span = document.createElement('span'), id = crypto.randomUUID();
      span.setAttribute(provenance.partAttribute, id);
      span.textContent = text;
      // Retained source atoms keep their original spelling and source origin,
      // even when a new formatting frame takes only part of their old carrier.
      provenance.fragments.set(id, { kind: piece.kind || 'text', origin: piece.origin,
        raw, sourceStart, sourceEnd, initialText: text, initial: span.outerHTML, attributes: '[]',
        units: [{ from: 0, to: text.length, raw, atomic: !!piece.atomic, sourceStart, sourceEnd }] });
      result.append(span);
    }
    return result;
  }

  function serializeCell(element, provenance, escapeBoundary = false, delimiterOrientation, details = false) {
    // Sourceless serialization is a DOM comparison key, never commit authority.
    const sourceMode = !!provenance;
    const raw = provenance?.policy?.raw;
    const encode = encodeCellText;
    const literal = text => {
      if (raw) return text;
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
      const encoded = !raw && sites.size ? encodeParts(parts, sites) : parts;
      return owned(marker + encoded.map(piece => piece.source).join('') + marker,
        fragment, node, fragment.kind, encoded, marker.length);
    };
    let normalized = new Set(), retainDelimiters = new Set(), delimiters = new Map();
    if (raw && delimiterOrientation !== undefined) {
      for (const node of element.querySelectorAll('strong,em')) {
        const owner = provenance.fragments.get(node.getAttribute(provenance.partAttribute));
        if (owner?.generatedInline) delimiters.set(node,
          (delimiterOrientation ? '*' : '_').repeat(owner.kind === 'strong' ? 2 : 1));
      }
    }
    const visit = node => {
      if (node.nodeType === Node.COMMENT_NODE) return [];
      if (node.nodeType !== Node.ELEMENT_NODE || !inlineTags.has(node.tagName)) fail('tableCells.cellType');
      if ([...node.attributes].some(attr => /^on/i.test(attr.name))) fail('tableCells.cellType');
      const part = provenance ? node.getAttribute(provenance.partAttribute || cellPartAttribute) : null;
      const fragment = part ? provenance?.fragments.get(part) : null;
      if (part && !fragment) fail('tableCells.cellType');
      if (raw && !fragment) {
        if (node.tagName === 'SPAN' && !node.attributes.length) return children(node);
        if (node.tagName === 'BR' && !node.attributes.length) return [{ source: '\n' }];
        fail('tableCells.cellType');
      }
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
          return owned(source.source, fragment, node, source.kind === 'markdown' ? 'codespan' : undefined,
            undefined, source.bodyOffset ?? fragment?.bodyOffset);
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
    if (raw) return details ? mapping(pieces) : result;
    if (escapeBoundary && provenance) {
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
  function serializeSurface(input, provenance, { marked, transform, sanitize }) {
    if (!(provenance?.fragments instanceof Map) || typeof provenance.attributes !== 'function') fail('tableCells.cellType');
    const serialized = serializeCell(input, provenance);
    if (provenance.policy?.raw) {
      if (provenance.policy.matches(serialized, input, provenance)) return serialized;
      // Only generated frames may change delimiter family. Authored source and
      // arbitrary raw punctuation never become table-style entity escapes.
      for (const orientation of [0, 1]) {
        const bounded = serializeCell(input, provenance, false, orientation);
        if (provenance.policy.matches(bounded, input, provenance)) return bounded;
      }
      fail('tableCells.cellType');
    }
    const checked = document.createElement('div');
    checked.innerHTML = sanitize(input.innerHTML);
    if (checked.innerHTML !== input.innerHTML) fail('tableCells.cellType');
    const canonical = root => {
      const copy = root.cloneNode(true);
      copy.querySelectorAll('[style]').forEach(node => node.setAttribute('style', node.style.cssText));
      copy.querySelectorAll('[' + provenance.partAttribute + ']').forEach(node => {
        const fragment = provenance.fragments.get(node.getAttribute(provenance.partAttribute));
        if (['text', 'escape', 'emoji', 'comment'].includes(fragment?.kind)) node.replaceWith(...node.childNodes);
        else node.removeAttribute(provenance.partAttribute);
      });
      copy.querySelectorAll('[' + provenance.codeAttribute + ']').forEach(node => node.removeAttribute(provenance.codeAttribute));
      copy.normalize();
      for (const parent of [copy, ...copy.querySelectorAll('*')].reverse()) {
        for (const node of [...parent.children]) {
          let next = node.nextSibling;
          while (['STRONG', 'EM', 'DEL'].includes(node.tagName) && !node.attributes.length &&
              next?.nodeType === Node.ELEMENT_NODE && next.tagName === node.tagName && !next.attributes.length) {
            node.append(...next.childNodes);
            next.remove();
            next = node.nextSibling;
          }
        }
      }
      copy.normalize();
      return serializeCell(copy);
    };
    const expected = canonical(input);
    const matches = source => {
      const lexer = new marked.Lexer({ ...marked.defaults, tokenizer: null });
      lexer.tokens.links = provenance.links || {};
      const rendered = document.createElement('div');
      rendered.innerHTML = marked.Parser.parseInline(lexer.inlineTokens(transform(source.replace(/\\\|/g, '|'))));
      checked.innerHTML = sanitize(rendered.innerHTML);
      const safe = canonical(checked);
      return safe === canonical(rendered) && safe === expected;
    };
    if (matches(serialized)) return serialized;
    const bounded = serializeCell(input, provenance, true);
    if (bounded !== serialized && matches(bounded)) return bounded;
    for (const orientation of [0, 1]) {
      const alternate = serializeCell(input, provenance, true, orientation);
      if (alternate !== serialized && alternate !== bounded && matches(alternate)) return alternate;
    }
    fail('tableCells.cellType');
  }

  function attachDialogContainment({ element, documentEditor, isCurrent }) {
    const editable = target => target?.closest?.('[contenteditable="true"],textarea,input');
    const keydown = event => {
      if (!isCurrent()) return;
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && !event.isComposing && !editable(event.target) &&
          !['a', 'c', 'enter'].includes(event.key.toLowerCase())) event.preventDefault();
    };
    const beforeinput = event => {
      if (!isCurrent() || !event.cancelable || !element.contains(document.activeElement) ||
          !['historyUndo', 'historyRedo'].includes(event.inputType)) return;
      // Chromium can route native history to the last editing host even
      // while a footer button owns focus, including the underlying textarea.
      if (event.target === documentEditor || !editable(document.activeElement)) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    element.addEventListener('keydown', keydown);
    document.addEventListener('beforeinput', beforeinput, true);
    return () => {
      element.removeEventListener('keydown', keydown);
      document.removeEventListener('beforeinput', beforeinput, true);
    };
  }

  function attachInlineEditor({ element, ownership, sourcePolicy = {}, marked, transform, sanitize,
    isCurrent, reportError, clearError = () => {}, documentEditor }) {
    const cell = { input: element, provenance: ownership }, listeners = [];
    const boundaries = (root, fragments) => {
      if (!ownership.policy?.raw) return;
      const boundary = node => node?.nodeType === Node.ELEMENT_NODE &&
        (fragments.get(node.getAttribute(ownership.partAttribute)) ||
          ownership.fragments.get(node.getAttribute(ownership.partAttribute)))?.kind === 'boundary';
      const create = () => {
        const node = document.createElement('span'), id = crypto.randomUUID();
        node.setAttribute(ownership.partAttribute, id);
        node.contentEditable = 'false';
        fragments.set(id, { kind: 'boundary', raw: '', initial: node.outerHTML,
          attributes: JSON.stringify(ownership.attributes(node)) });
        return node;
      };
      // Zero-text native atoms bound the surface. Without them Blink preserves
      // the old first inline carrier around an insertHTML replacement, cloning
      // its source identity when the carrier ends in preserved newlines.
      if (!boundary(root.firstChild)) root.prepend(create());
      if (!boundary(root.lastChild)) root.append(create());
    };
    boundaries(element, ownership.fragments);
    for (const [part, record] of ownership.fragments) ownership.fragments.set(part, immutable(record));
    const dependencies = { marked, transform, sanitize };
    let historyCarets = new WeakMap(), pendingHistory = null;
    let disposed = false;
    const current = () => !disposed && isCurrent();
    const listen = (target, type, callback, options) => {
      target.addEventListener(type, callback, options);
      listeners.push(() => target.removeEventListener(type, callback, options));
    };
    const forInput = event => current() && !cell.converting &&
      (event.target === element || element.contains(event.target)) ? cell : null;
    const context = (event, outsideCode = false) => {
      if (!forInput(event)) return null;
      const selection = getSelection();
      if (selection.rangeCount !== 1) return null;
      const range = selection.getRangeAt(0);
      if (!element.contains(range.commonAncestorContainer)) return null;
      const node = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
      return outsideCode && node.closest('code') ? null : { cell, range, selection };
    };
    const textPoint = (input, offset) => {
      const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
      let last = null;
      for (let node; (node = walker.nextNode());) {
        if (offset < node.data.length) return { node, offset };
        offset -= node.data.length;
        last = node;
      }
      return last && offset === 0 ? { node: last, offset: last.data.length } : null;
    };
    const prefix = range => {
      const before = document.createRange();
      before.selectNodeContents(element);
      before.setEnd(range.startContainer, range.startOffset);
      return before.toString();
    };
    const pathTo = (root, original) => {
      const path = [];
      for (let node = original; node !== root; node = node.parentNode) {
        if (!node?.parentNode) fail('tableCells.mapping');
        path.push([...node.parentNode.childNodes].indexOf(node));
      }
      return path.reverse();
    };
    const nodeAt = (root, path) => path.reduce((node, at) => node.childNodes[at], root);
    const rangeState = (root, range) => immutable({
      start: pathTo(root, range.startContainer), startOffset: range.startOffset,
      end: pathTo(root, range.endContainer), endOffset: range.endOffset,
    });
    const historyIdentity = () => element.firstChild || element;
    const restoreRange = (root, state) => {
      const range = document.createRange();
      range.setStart(nodeAt(root, state.start), state.startOffset);
      range.setEnd(nodeAt(root, state.end), state.endOffset);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    };
    const caretFrom = (proposed, range) => restoreRange(element, rangeState(proposed, range));
    const caretAfter = node => {
      const range = document.createRange();
      range.setStartAfter(node); range.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    };
    const proposedContents = (range, replacement, inserted) => {
      const proposed = element.cloneNode(true);
      const copied = original => {
        const path = [];
        for (let node = original; node !== element; node = node.parentNode) {
          path.push([...node.parentNode.childNodes].indexOf(node));
        }
        return path.reverse().reduce((node, at) => node.childNodes[at], proposed);
      };
      const candidate = document.createRange();
      candidate.setStart(copied(range.startContainer), range.startOffset);
      candidate.setEnd(copied(range.endContainer), range.endOffset);
      const copy = replacement.cloneNode(true), tail = copy.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? copy.lastChild : copy;
      candidate.deleteContents(); candidate.insertNode(copy);
      candidate.setStartAfter(tail); candidate.collapse(true);
      inserted?.(candidate, copy);
      return proposed;
    };
    const replaceContents = (ctx, proposed, fragments, restoreCaret) => {
      boundaries(proposed, fragments);
      proposed.normalize();
      const operation = { ...ownership, fragments: new Map([...ownership.fragments, ...fragments]) };
      // Context-ineligible syntax stays raw. Refusal happens before native
      // mutation, including inside external CODE, fences and authored HTML.
      try { serializeSurface(proposed, operation, dependencies); }
      catch (error) {
        if (ownership.policy?.raw) return false;
        throw error;
      }
      // Records belong to the editing lifetime, not just the live tree: native
      // Undo can restore any earlier captured DOM state.
      for (const [part, fragment] of fragments) ownership.fragments.set(part, immutable(fragment));
      const range = document.createRange();
      range.selectNodeContents(element);
      ctx.selection.removeAllRanges(); ctx.selection.addRange(range);
      const before = element.innerHTML;
      const beforeNode = historyIdentity(), beforeCaret = rangeState(element, ctx.range);
      cell.converting = true;
      try {
        if (!document.execCommand('insertHTML', false, proposed.innerHTML) ||
            element.innerHTML !== proposed.innerHTML) {
          document.execCommand('undo');
          if (element.innerHTML !== before) element.innerHTML = before;
          fail('tableCells.cellType');
        }
        restoreCaret();
        // Blink restores the engine's select-all range on Undo. Associate its
        // original/corrected selections with this native replacement only:
        // exact reattached nodes certify the operation, not equal HTML.
        // Weak keys/references retain neither markup copies nor history trees.
        const afterNode = historyIdentity();
        if (afterNode !== beforeNode) historyCarets.set(afterNode, immutable({
          beforeNode: new WeakRef(beforeNode), beforeCaret,
          afterCaret: rangeState(element, getSelection().getRangeAt(0)),
        }));
        clearError();
      } finally { cell.converting = false; }
      return true;
    };
    const insertInline = (ctx, node, range, fragments) => {
      const id = node.getAttribute(ownership.codeAttribute);
      return replaceContents(ctx, proposedContents(range, node), fragments, () => {
        const matches = element.querySelectorAll('[' + ownership.codeAttribute + '="' + id + '"]');
        if (matches.length !== 1 || matches[0].tagName !== node.tagName) fail('tableCells.cellType');
        caretAfter(matches[0]);
      });
    };
    const rememberTyping = (range, data, collapsed, committed = false) => {
      const { text, runs } = codeDelimiters(element, ownership, range, committed ? '' : data);
      const before = data.length ? text.slice(0, -data.length) : text;
      let active = collapsed && cell.activeCode?.expectedPrefix === before ? cell.activeCode : null;
      if (active && before.length === active.start + active.length && /^`+$/.test(data)) {
        const extended = runs.find(run => run.index === active.start && run.index + run.length === text.length);
        active = extended ? { start: extended.index, length: extended.length } : null;
      }
      if (!active) {
        const introduced = runs.find(run => run.index + run.length > before.length);
        if (introduced) active = { start: introduced.index, length: introduced.length };
      }
      cell.activeCode = active ? { ...active, expectedPrefix: text } : null;
    };
    const codeToken = (range, inserted) => {
      if (!range.collapsed) return null;
      const { text, syntax, runs } = codeDelimiters(element, ownership, range);
      if (!(text + inserted).endsWith('`')) return null;
      for (const match of runs) {
        const point = textPoint(element, match.index);
        if (!point || point.node.parentElement.closest('code')) continue;
        const candidate = document.createRange();
        candidate.setStart(point.node, point.offset);
        candidate.setEnd(range.startContainer, range.startOffset);
        const fragment = candidate.cloneContents();
        if ([...fragment.querySelectorAll('*')].some(node => {
          const captured = ownership.fragments.get(node.getAttribute(ownership.partAttribute));
          return node.tagName !== 'SPAN' || !['text', 'escape', 'emoji'].includes(captured?.kind);
        })) continue;
        const source = candidate.toString() + inserted, projected = syntax.slice(match.index) + inserted;
        const lexer = new marked.Lexer({ ...marked.defaults, tokenizer: null });
        const tokens = lexer.inlineTokens(projected);
        if (tokens.length === 1 && tokens[0].type === 'codespan' && tokens[0].raw === projected) {
          const edge = match.length, inner = source.slice(edge, -edge);
          const padding = inner.startsWith(' ') && inner.endsWith(' ') && /[^ ]/.test(inner) ? 1 : 0;
          const from = edge + padding, to = source.length - edge - padding, existing = candidate.toString().length;
          const start = textPoint(element, match.index + Math.min(from, existing));
          const end = textPoint(element, match.index + Math.min(to, existing));
          if (!start || !end) fail('tableCells.cellType');
          const bodyRange = document.createRange();
          bodyRange.setStart(start.node, start.offset); bodyRange.setEnd(end.node, end.offset);
          const body = bodyRange.cloneContents();
          if (to > Math.max(from, existing)) body.append(document.createTextNode(source.slice(Math.max(from, existing), to)));
          return { body, range: candidate };
        }
        if (cell.activeCode?.expectedPrefix === text + inserted && cell.activeCode.start === match.index) return null;
      }
      return null;
    };
    const prepareGenerated = (holder, source, operation = ownership) =>
      prepareCell(holder, ownership.policy?.raw ? source : source.replace(/\\\|/g, '|'), source,
        marked, operation.links, transform, sanitize, { ...operation, generated: true });
    const formatCode = (ctx, code) => {
      cell.activeCode = null;
      const holder = document.createElement('div'), id = crypto.randomUUID();
      const sources = codeSources(code.body, ownership);
      if (sources.kind === 'unrepresentable') fail('tableCells.cellType');
      const capture = prepareGenerated(holder, sources.source);
      const node = holder.firstElementChild;
      if (node?.tagName !== 'CODE' || holder.childNodes.length !== 1 || node.textContent !== sources.text) fail('tableCells.cellType');
      node.setAttribute(ownership.codeAttribute, id);
      const fragment = capture.fragments.get(node.getAttribute(ownership.partAttribute));
      fragment.generatedCode = true;
      fragment.initial = node.outerHTML;
      insertInline(ctx, node, code.range, capture.fragments);
    };
    const formatEmphasis = ctx => {
      const { range } = ctx;
      if (!range.collapsed) return;
      let scope = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
      while (scope !== element) {
        const owner = ownership.fragments.get(scope.getAttribute(ownership.partAttribute));
        if (owner && !['text', 'escape', 'emoji'].includes(owner.kind)) break;
        scope = scope.parentElement;
      }
      const before = codeDelimiters(scope, ownership, range, '', '*');
      if (!before.text.endsWith('*')) return;
      const end = document.createRange(); end.selectNodeContents(scope); end.collapse(false);
      const full = codeDelimiters(scope, ownership, end, '', '*');
      const lexer = new marked.Lexer({ ...marked.defaults, tokenizer: null });
      lexer.tokens.links = ownership.links;
      let match = null;
      const locate = (tokens, offset) => {
        for (const token of tokens) {
          if (['strong', 'em'].includes(token.type)) {
            const edge = (token.raw.length - token.text.length) / 2, marker = token.raw.slice(0, edge);
            if (offset + token.raw.length === before.text.length && /^\*+$/.test(marker) &&
                before.runs.some(run => run.index === offset)) { match = { token, offset }; return; }
            locate(token.tokens, offset + edge);
            if (match) return;
          }
          offset += token.raw.length;
        }
      };
      locate(lexer.inlineTokens(full.syntax), 0);
      if (!match) return;
      const operation = { ...ownership, fragments: new Map(ownership.fragments) };
      const build = (token, offset) => {
        const edge = (token.raw.length - token.text.length) / 2, marker = token.raw.slice(0, edge);
        const holder = document.createElement('div'), capture = prepareGenerated(holder, marker + 'x' + marker, operation);
        const node = holder.firstElementChild;
        if (holder.childNodes.length !== 1 || node?.tagName !== (token.type === 'strong' ? 'STRONG' : 'EM')) fail('tableCells.cellType');
        for (const [part, fragment] of capture.fragments) operation.fragments.set(part,
          ['strong', 'em'].includes(fragment.kind) ? { ...fragment, generatedInline: true } : fragment);
        node.replaceChildren();
        let position = offset + edge, start = position;
        const append = to => {
          if (to === start) return true;
          const slice = typingSlice(scope, operation, start, to);
          if (!slice) return false;
          node.append(slice); return true;
        };
        for (const child of token.tokens) {
          if (['strong', 'em'].includes(child.type) && child.raw.startsWith('*')) {
            if (!append(position)) return null;
            const nested = build(child, position);
            if (!nested) return null;
            node.append(nested);
            position += child.raw.length; start = position;
          } else position += child.raw.length;
        }
        return append(position) ? node : null;
      };
      const node = build(match.token, match.offset);
      if (!node) return;
      node.setAttribute(ownership.codeAttribute, crypto.randomUUID());
      const first = textPoint(scope, match.offset);
      if (!first) fail('tableCells.cellType');
      const replacement = range.cloneRange(); replacement.setStart(first.node, first.offset);
      const owners = root => {
        const counts = new Map();
        for (const node of root.querySelectorAll('[' + ownership.partAttribute + ']')) {
          const part = node.getAttribute(ownership.partAttribute), fragment = ownership.fragments.get(part);
          if (fragment && !['text', 'escape', 'emoji'].includes(fragment.kind)) counts.set(part, (counts.get(part) || 0) + 1);
        }
        return counts;
      };
      const retained = owners(node), consumed = owners(replacement.cloneContents());
      if (retained.size !== consumed.size || [...consumed].some(([part, count]) => retained.get(part) !== count)) return;
      const fragments = new Map([...operation.fragments].filter(([part]) => !ownership.fragments.has(part)));
      cell.activeCode = null;
      insertInline(ctx, node, replacement, fragments);
    };
    const formatTyped = (ctx, data) => {
      const code = codeToken(ctx.range, '');
      try {
        if (code) formatCode(ctx, code);
        else if (data?.endsWith('*')) formatEmphasis(ctx);
      } catch (error) { reportError(error); }
    };
    const replaceCapturedText = (ctx, data) => {
      const { range, selection } = ctx;
      if (range.collapsed) return false;
      const boundary = (node, offset, end) => {
        while (node !== element) {
          const length = node.nodeType === Node.TEXT_NODE ? node.length : node.childNodes.length;
          if (offset !== (end ? length : 0)) break;
          const parent = node.parentNode;
          offset = [...parent.childNodes].indexOf(node) + (end ? 1 : 0); node = parent;
        }
        return { node, offset };
      };
      const start = boundary(range.startContainer, range.startOffset, false);
      const end = boundary(range.endContainer, range.endOffset, true);
      const owner = [...element.querySelectorAll('[' + ownership.partAttribute + ']')].find(node => {
        const fragment = ownership.fragments.get(node.getAttribute(ownership.partAttribute));
        if (!fragment || !['STRONG', 'B', 'EM', 'I', 'DEL', 'S'].includes(node.tagName)) return false;
        const from = boundary(node, 0, false), to = boundary(node, node.childNodes.length, true);
        return start.node === from.node && start.offset === from.offset && end.node === to.node && end.offset === to.offset;
      });
      if (!owner) return false;
      const copy = owner.cloneNode(true);
      const copied = original => {
        const path = [];
        for (let node = original; node !== owner; node = node.parentNode) {
          path.push([...node.parentNode.childNodes].indexOf(node));
        }
        return path.reverse().reduce((node, at) => node.childNodes[at], copy);
      };
      const from = owner.contains(range.startContainer)
        ? { node: copied(range.startContainer), offset: range.startOffset }
        : textPoint(copy, 0) || { node: copy, offset: 0 };
      const to = owner.contains(range.endContainer)
        ? { node: copied(range.endContainer), offset: range.endOffset }
        : textPoint(copy, copy.textContent.length) || { node: copy, offset: copy.childNodes.length };
      const changed = document.createRange();
      changed.setStart(from.node, from.offset); changed.setEnd(to.node, to.offset);
      const text = document.createTextNode(data);
      changed.deleteContents(); changed.insertNode(text);
      changed.setStart(text, data.length); changed.collapse(true);
      const inside = rangeState(copy, changed);
      const replacement = document.createRange(); replacement.selectNode(owner);
      let caret;
      const proposed = proposedContents(replacement, copy, (endpoint, inserted) => {
        caret = endpoint.cloneRange();
        caret.setStart(nodeAt(inserted, inside.start), inside.startOffset); caret.collapse(true);
      });
      return replaceContents(ctx, proposed, new Map(), () => caretFrom(proposed, caret));
    };
    const insertPlain = (ctx, text) => {
      const literal = document.createElement('div');
      const captured = ownership.policy?.raw
        ? prepareRaw(literal, text, marked, { ...ownership, literal: true }) : null;
      const replacement = captured ? literal.firstChild || document.createTextNode('') : document.createTextNode(text);
      let caret;
      const proposed = proposedContents(ctx.range, replacement, endpoint => { caret = endpoint.cloneRange(); });
      const fragments = captured?.fragments || new Map();
      const operation = { ...ownership, fragments: new Map([...ownership.fragments, ...fragments]) };
      if (ownership.policy?.raw) {
        const source = serializeCell(proposed, operation);
        if (!ownership.policy.matches(source, proposed, operation)) {
          const point = { node: caret.startContainer, offset: caret.startOffset };
          const before = document.createRange();
          before.selectNodeContents(proposed); before.setEnd(point.node, point.offset);
          const prefix = document.createElement('div'); prefix.append(before.cloneContents());
          const prefixMap = serializeCell(prefix, operation, false, undefined, true);
          const fullMap = serializeCell(proposed, operation, false, undefined, true);
          let sourceOffset = prefixMap.source.length;
          for (let node = point.node.nodeType === Node.ELEMENT_NODE ? point.node : point.node.parentElement;
            node && node !== proposed; node = node.parentElement) {
            const part = node.getAttribute(ownership.partAttribute);
            const partial = prefixMap.entries.find(entry =>
              entry.owner?.getAttribute(ownership.partAttribute) === part && entry.tokenType);
            const full = fullMap.entries.find(entry => entry.owner === node && entry.tokenType);
            if (!partial || !full) continue;
            const body = partial.children ? partial.children.reduce((sum, child) => sum + child.source.length, 0)
              : partial.owner.textContent.length;
            sourceOffset -= partial.source.length - partial.bodyOffset - body;
            sourceOffset += full.bodyOffset - partial.bodyOffset;
          }
          const capture = prepareCell(proposed, source, source, marked, {}, transform, sanitize, ownership);
          // Raw input can invalidate a semantic owner. Recover its source in
          // this native transaction instead of dropping input or inventing HTML.
          return replaceContents(ctx, proposed, capture.fragments, () => {
            const node = [...element.querySelectorAll('[' + ownership.partAttribute + ']')].find(node => {
              const part = capture.fragments.get(node.getAttribute(ownership.partAttribute));
              return part?.kind === 'text' && part.sourceStart <= sourceOffset && sourceOffset <= part.sourceEnd;
            });
            const part = node && capture.fragments.get(node.getAttribute(ownership.partAttribute));
            const point = node && textPoint(node, sourceOffset - part.sourceStart);
            if (!point) fail('tableCells.mapping');
            const range = document.createRange();
            range.setStart(point.node, point.offset); range.collapse(true);
            getSelection().removeAllRanges(); getSelection().addRange(range);
          });
        }
      }
      return replaceContents(ctx, proposed, fragments, () => caretFrom(proposed, caret));
    };
    listen(element, 'beforeinput', event => {
      if (!current()) { if (event.cancelable) event.preventDefault(); return; }
      if (cell.converting) return;
      if (['historyUndo', 'historyRedo'].includes(event.inputType)) {
        const node = historyIdentity();
        pendingHistory = { node, operation: historyCarets.get(node) };
        cell.activeCode = null;
        return;
      }
      pendingHistory = null;
      const ctx = context(event, true);
      if (!ctx || event.inputType !== 'insertText') cell.activeCode = null;
      if (cell.composing || event.isComposing || !event.cancelable) return;
      if (ownership.policy?.raw && event.inputType === 'insertText' && typeof event.data === 'string') {
        event.preventDefault();
        const selected = context(event);
        if (selected) try {
          if (ctx) rememberTyping(ctx.range, event.data, ctx.range.collapsed);
          if (!insertPlain(selected, normalise(event.data))) fail('tableCells.cellType');
          const next = context({ target: element }, true);
          if (next) formatTyped(next, event.data);
        } catch (error) { reportError(error); }
        return;
      }
      if (ownership.policy?.raw && ['insertParagraph', 'insertLineBreak'].includes(event.inputType)) {
        event.preventDefault();
        const selected = context(event);
        if (selected) try { insertPlain(selected, '\n'); } catch (error) { reportError(error); }
        return;
      }
      if (!ctx || event.inputType !== 'insertText' || typeof event.data !== 'string') return;
      const { range } = ctx;
      rememberTyping(range, event.data, range.collapsed);
      if (!range.collapsed) {
        try {
          if (replaceCapturedText(ctx, event.data)) {
            event.preventDefault();
            const next = context({ target: element }, true);
            if (next) formatTyped(next, event.data);
            return;
          }
        } catch (error) { event.preventDefault(); reportError(error); return; }
      }
      const previous = range.collapsed && range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer.childNodes[range.startOffset - 1] : null;
      if (previous?.matches?.('code,strong,em,b,i') &&
          ownership.fragments.has(previous.getAttribute(ownership.partAttribute))) {
        event.preventDefault();
        try { insertPlain(ctx, event.data); }
        catch (error) { reportError(error); }
        const next = context({ target: element }, true);
        if (next) formatTyped(next, event.data);
        return;
      }
      const code = codeToken(range, event.data);
      if (!code) return;
      // Raw-source context refusal must leave the closing text in place.
      if (ownership.policy?.raw) return;
      event.preventDefault();
      try { formatCode(ctx, code); } catch (error) { reportError(error); }
    });
    listen(element, 'input', event => {
      if (!forInput(event) || cell.composing || event.isComposing) return;
      if (['historyUndo', 'historyRedo'].includes(event.inputType)) {
        const identity = historyIdentity(), previous = pendingHistory;
        pendingHistory = null;
        const operation = event.inputType === 'historyUndo' ? previous?.operation : historyCarets.get(identity);
        const matched = operation && (event.inputType === 'historyUndo'
          ? operation.beforeNode.deref() === identity && previous.node !== identity
          : operation.beforeNode.deref() === previous?.node && previous.node !== identity);
        if (matched) restoreRange(element, event.inputType === 'historyUndo' ? operation.beforeCaret : operation.afterCaret);
        return;
      }
      const ctx = context(event, true);
      if (ctx && event.inputType === 'insertText') formatTyped(ctx, event.data);
    });
    listen(element, 'compositionstart', () => { cell.composing = true; cell.activeCode = null; });
    listen(element, 'compositionend', event => {
      cell.composing = false;
      const revision = cell.compositionRevision = (cell.compositionRevision || 0) + 1;
      queueMicrotask(() => {
        if (!current() || cell.composing || cell.compositionRevision !== revision) return;
        const ctx = context({ target: element }, true);
        if (!ctx || typeof event.data !== 'string' || !event.data.length) return;
        if (prefix(ctx.range).endsWith(event.data)) rememberTyping(ctx.range, event.data, false, true);
        formatTyped(ctx, event.data);
      });
    });
    for (const type of ['focusout', 'pointerdown']) listen(element, type, () => { cell.activeCode = null; });
    listen(element, 'keydown', event => {
      event.stopPropagation();
      if (/^(?:Arrow|Home$|End$|Page|Tab$)/.test(event.key)) cell.activeCode = null;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
        event.preventDefault(); reportError(new Error('tableCells.formatShortcuts')); return;
      }
      if (!event.isComposing) sourcePolicy.keydown?.(event);
    });
    const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    listen(element, 'paste', event => {
      event.preventDefault();
      const ctx = context(event);
      if (!ctx) { reportError(new Error('tableCells.stale')); return; }
      const plain = event.clipboardData.getData('text/plain');
      if (ownership.policy?.raw) {
        try { insertPlain(ctx, normalise(plain)); } catch (error) { reportError(error); }
        return;
      }
      const codeAt = node => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement).closest('code');
      const code = codeAt(ctx.range.startContainer), end = codeAt(ctx.range.endContainer);
      const part = code?.getAttribute(ownership.partAttribute), owner = part && ownership.fragments.get(part);
      const markdown = code && code === end && element.contains(code) &&
        (owner?.kind === 'codespan' || owner?.generatedCode === true) &&
        element.querySelectorAll('[' + ownership.partAttribute + '="' + part + '"]').length === 1;
      const html = markdown ? escape(plain.replace(/\r\n?|\n/g, ' ')) : plain.split(/\r\n?|\n/).map(escape).join('<br>');
      if (!document.execCommand('insertHTML', false, html)) reportError(new Error('tableCells.cellType'));
    });
    listen(element, 'drop', event => event.preventDefault());
    listen(element, 'click', event => { if (event.target.closest('a')) event.preventDefault(); });
    listen(element, 'auxclick', event => event.preventDefault());
    listen(element, 'wheel', event => {
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); event.stopPropagation(); }
    }, { passive: false });
    listen(document, 'beforeinput', event => {
      if (current() && element.contains(document.activeElement) && event.target === documentEditor &&
          event.isTrusted && event.cancelable && ['historyUndo', 'historyRedo'].includes(event.inputType)) {
        event.preventDefault(); event.stopPropagation();
      }
    }, true);
    return {
      readSource() { if (!current()) fail('tableCells.stale'); return serializeSurface(element, ownership, dependencies); },
      reset() { pendingHistory = null; cell.activeCode = null; cell.composing = false; cell.compositionRevision = (cell.compositionRevision || 0) + 1; },
      dispose() { disposed = true; pendingHistory = null; historyCarets = new WeakMap(); listeners.splice(0).forEach(remove => remove()); },
    };
  }

  return { normalise, sourceView, projectContainer, spliceInput, serializeCell,
    prepareCell, markdownCode, codeSources, codeDelimiters, typingSlice,
    attachInlineEditor, attachDialogContainment, serializeSurface, rawMarkdownPolicy, documentFrames };
})();
