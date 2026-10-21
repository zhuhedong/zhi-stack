// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import { diffLines, diffStats, withContext } from '../src/lib/diff';
import { VersionDiff } from '../src/components/VersionDiff';
import type { Item } from '../src/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('line diff finds added, removed and unchanged lines', () => {
  const ops = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  expect(ops).toEqual([
    { type: 'same', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'add', text: 'B' },
    { type: 'same', text: 'c' },
    { type: 'same', text: 'd' },
    { type: 'add', text: 'e' },
  ]);
  expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
  expect(diffStats(diffLines('same', 'same'))).toEqual({ added: 0, removed: 0 });
});

test('long unchanged runs collapse into gaps', () => {
  const before = Array.from({ length: 20 }, (_, i) => 'line ' + i).join('\n');
  const after = before.replace('line 10', 'changed');
  const rows = withContext(diffLines(before, after), 2);
  expect(rows[0]).toEqual({ type: 'gap', count: 8 });
  expect(rows.filter((r) => r.type === 'gap')).toHaveLength(2);
});

test('VersionDiff shows changed fields and body lines in Chinese', () => {
  const base = {
    id: '1',
    kind: 'knowledge',
    title: '旧标题',
    category: 'blog',
    project: '',
    tags: [],
    summary: '',
    url: '',
    favorite: false,
    revision: 1,
    data: { content: '第一行\n第二行' },
  } as unknown as Item;
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() =>
    root.render(
      <VersionDiff
        before={base}
        after={{ ...base, title: '新标题', data: { content: '第一行\n第二行改' } }}
      />,
    ),
  );
  expect(host.textContent).toContain('标题旧标题新标题');
  expect(host.querySelector('.diff-del')?.textContent).toContain('第二行');
  expect(host.querySelector('.diff-add')?.textContent).toContain('第二行改');
  expect(host.textContent).toContain('+1');
  act(() => root.unmount());
});
