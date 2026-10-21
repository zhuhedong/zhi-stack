export type DiffOp = { type: 'same' | 'add' | 'del'; text: string };

/** Line diff (LCS). Inputs beyond `limit` lines per side fall back to a whole-block replace. */
export function diffLines(before: string, after: string, limit = 3000): DiffOp[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Trim common head/tail so typical small edits stay cheap.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: DiffOp[] = a.slice(0, head).map((text) => ({ type: 'same', text }));
  if (midA.length > limit || midB.length > limit) {
    out.push(...midA.map((text) => ({ type: 'del' as const, text })));
    out.push(...midB.map((text) => ({ type: 'add' as const, text })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ type: 'same', text: midA[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: 'del', text: midA[i++] });
      else out.push({ type: 'add', text: midB[j++] });
    }
    while (i < n) out.push({ type: 'del', text: midA[i++] });
    while (j < m) out.push({ type: 'add', text: midB[j++] });
  }
  out.push(...a.slice(a.length - tail).map((text) => ({ type: 'same' as const, text })));
  return out;
}

export function diffStats(ops: DiffOp[]) {
  return {
    added: ops.filter((o) => o.type === 'add').length,
    removed: ops.filter((o) => o.type === 'del').length,
  };
}

/** Collapse long unchanged runs, keeping `context` lines around each change. */
export function withContext(ops: DiffOp[], context = 3): (DiffOp | { type: 'gap'; count: number })[] {
  const keep = ops.map(() => false);
  ops.forEach((op, i) => {
    if (op.type === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffOp | { type: 'gap'; count: number })[] = [];
  let gap = 0;
  ops.forEach((op, i) => {
    if (keep[i]) {
      if (gap) out.push({ type: 'gap', count: gap });
      gap = 0;
      out.push(op);
    } else gap++;
  });
  if (gap) out.push({ type: 'gap', count: gap });
  return out;
}
