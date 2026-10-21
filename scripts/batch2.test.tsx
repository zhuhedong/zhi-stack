// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi, beforeEach } from 'vitest';
import { anchorFor, locate, rangeFor, textOf } from '../src/lib/anchoring';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { path: string; init?: RequestInit }[] = [];
let stored: unknown[] = [];
vi.mock('../src/lib/api', () => ({
  errorMessage: (e: unknown) => String(e),
  api: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (!init?.method) return stored;
    if (init.method === 'POST')
      return {
        id: 'new',
        revision: 1,
        note: '',
        createdAt: '',
        updatedAt: '',
        ...JSON.parse(String(init.body)),
      };
    return {};
  },
}));
beforeEach(() => {
  calls.length = 0;
  stored = [];
});

function html(markup: string) {
  const root = document.createElement('div');
  root.innerHTML = markup;
  document.body.append(root);
  return root;
}

test('anchors capture quote, context and offset across element boundaries', () => {
  const root = html('<p>第一段讲<b>调度器</b>。</p><p>第二段讲工作窃取。</p>');
  const range = document.createRange();
  const b = root.querySelector('b')!.firstChild!;
  range.setStart(b, 0);
  range.setEnd(root.querySelectorAll('p')[1].firstChild!, 2);
  const anchor = anchorFor(root, range)!;
  expect(anchor.quote).toBe('调度器。第二');
  expect(anchor.prefix).toBe('第一段讲');
  expect(anchor.startOffset).toBe(4);
  expect(rangeFor(root, 4, 4 + anchor.quote.length)!.toString()).toBe('调度器。第二');
  root.remove();
});

test('locate keeps exact positions and re-anchors moved or duplicated quotes', () => {
  const anchor = { quote: '窃取', prefix: '工作', suffix: '模型', startOffset: 6 };
  expect(locate('调度器采用工作窃取模型', anchor)).toBe(7);
  expect(locate('前言：窃取。调度器采用工作窃取模型。再谈窃取', anchor)).toBe(13);
  expect(locate('全文已改写', anchor)).toBeNull();
  const exact = { quote: 'ab', prefix: 'x', suffix: '', startOffset: 1 };
  expect(locate('xab ab', exact)).toBe(1);
});

test('selecting text offers colors and saves an anchored highlight; lost ones are flagged', async () => {
  const { ArticleHighlights } = await import('../src/components/ArticleHighlights');
  stored = [
    {
      id: 'h1',
      quote: '不存在的句子',
      prefix: '',
      suffix: '',
      startOffset: 0,
      color: 'blue',
      note: '旧笔记',
      revision: 1,
      createdAt: '',
      updatedAt: '2026-10-21T04:00:00Z',
    },
  ];
  const host = html('');
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ArticleHighlights itemId="item-1">
        <article>
          <p>Tokio 的调度器采用工作窃取模型。</p>
        </article>
      </ArticleHighlights>,
    );
  });
  expect(host.textContent).toContain('划线与笔记 1');
  expect(host.textContent).toContain('原文已变化，未能在正文中定位');
  expect(host.textContent).toContain('旧笔记');
  const scope = host.querySelector('.highlight-scope')!;
  const text = scope.querySelector('p')!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 12);
  range.setEnd(text, 16);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => {
    scope.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  const green = host.querySelector<HTMLButtonElement>('[aria-label="绿色划线"]')!;
  expect(green).toBeTruthy();
  await act(async () => green.click());
  const post = calls.find((c) => c.init?.method === 'POST')!;
  expect(post.path).toBe('/items/item-1/highlights');
  expect(JSON.parse(String(post.init!.body))).toMatchObject({
    quote: '工作窃取',
    prefix: 'Tokio 的调度器采用',
    suffix: '模型。',
    startOffset: 12,
    color: 'green',
  });
  expect(host.textContent).toContain('划线与笔记 2');
  expect(textOf(scope)).toBe('Tokio 的调度器采用工作窃取模型。');
  act(() => root.unmount());
  host.remove();
});
