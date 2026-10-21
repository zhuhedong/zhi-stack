/** Text-quote anchoring for highlights: an anchor is a quote, a little context
 * around it and its offset in the article's rendered text. */
export interface Anchor {
  quote: string;
  prefix: string;
  suffix: string;
  startOffset: number;
}
export const CONTEXT = 32;

/** Text nodes of a container in document order (the basis for all offsets). */
export function textNodes(root: Node): Text[] {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}
export function textOf(root: Node): string {
  return textNodes(root)
    .map((n) => n.data)
    .join('');
}

/** Anchor for a DOM range inside `root`, or null when it is empty/outside. */
export function anchorFor(root: Node, range: Range): Anchor | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  let offset = 0;
  let start = -1;
  let end = -1;
  for (const node of textNodes(root)) {
    if (node === range.startContainer) start = offset + range.startOffset;
    if (node === range.endContainer) end = offset + range.endOffset;
    offset += node.data.length;
  }
  // Element boundaries (e.g. triple-click selections): measure via a prefix range.
  if (start < 0 || end < 0) {
    const before = root.ownerDocument!.createRange();
    before.selectNodeContents(root);
    if (start < 0) {
      before.setEnd(range.startContainer, range.startOffset);
      start = before.toString().length;
    }
    if (end < 0) {
      before.setEnd(range.endContainer, range.endOffset);
      end = before.toString().length;
    }
  }
  const text = textOf(root);
  // Trim surrounding whitespace so a sloppy selection still yields a clean quote.
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end <= start) return null;
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
    startOffset: start,
  };
}

function commonSuffix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Where the anchor's quote is in `text` now: its stored offset when that still
 * matches, otherwise the occurrence with the best context match (ties go to the
 * one closest to the old offset). Null when the quote no longer exists.
 */
export function locate(text: string, anchor: Anchor): number | null {
  const { quote, prefix, suffix, startOffset } = anchor;
  if (!quote) return null;
  const exact =
    text.slice(startOffset, startOffset + quote.length) === quote &&
    text.slice(Math.max(0, startOffset - prefix.length), startOffset) === prefix;
  if (exact) return startOffset;
  let best: number | null = null;
  let bestScore = -Infinity;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const context =
      commonSuffix(text.slice(Math.max(0, at - prefix.length), at), prefix) +
      commonPrefix(text.slice(at + quote.length, at + quote.length + suffix.length), suffix);
    const score = context * 1000 - Math.abs(at - startOffset) / 1000;
    if (score > bestScore) {
      bestScore = score;
      best = at;
    }
  }
  return best;
}

/** DOM range covering [start, end) of the container's text. */
export function rangeFor(root: Node, start: number, end: number): Range | null {
  const range = root.ownerDocument!.createRange();
  let offset = 0;
  let started = false;
  for (const node of textNodes(root)) {
    const length = node.data.length;
    if (!started && start <= offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

/** Text offset under a viewport point (for clicking an existing highlight). */
export function offsetAtPoint(root: Node, x: number, y: number): number | null {
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) {
    node = position.offsetNode;
    offset = position.offset;
  } else {
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || !root.contains(node)) return null;
  let total = 0;
  for (const text of textNodes(root)) {
    if (text === node) return total + offset;
    total += text.data.length;
  }
  return null;
}
