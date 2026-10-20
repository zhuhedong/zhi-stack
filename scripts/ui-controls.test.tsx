// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Select } from '../src/components/ui/Select';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

function Demo({ log }: { log: string[] }) {
  const [v, setV] = useState('b');
  return (
    <Select aria-label="排序" value={v} onChange={(e) => (log.push(e.target.value), setV(e.target.value))}>
      <option value="a">Alpha</option>
      <option value="b">Beta</option>
      <option value="c" disabled>
        Gamma
      </option>
      <option value="d">Delta</option>
    </Select>
  );
}
const key = (el: Element, k: string) =>
  act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));

test('custom select: keyboard open, skip disabled, choose fires native change', async () => {
  const log: string[] = [];
  await act(async () => root.render(<Demo log={log} />));
  const trigger = host.querySelector<HTMLButtonElement>('.ui-select-trigger')!;
  expect(trigger.textContent).toContain('Beta');
  expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
  key(trigger, 'ArrowDown');
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelectorAll('[role=option]').length).toBe(4);
  key(trigger, 'ArrowDown'); // skips disabled Gamma -> Delta
  expect(document.querySelector('.ui-option.active')?.textContent).toContain('Delta');
  key(trigger, 'Enter');
  expect(log).toEqual(['d']);
  expect(trigger.textContent).toContain('Delta');
  expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('d');
  expect(document.querySelector('[role=listbox]')).toBeNull();
});

test('custom select: Escape closes, typeahead jumps', async () => {
  const log: string[] = [];
  await act(async () => root.render(<Demo log={log} />));
  const trigger = host.querySelector<HTMLButtonElement>('.ui-select-trigger')!;
  key(trigger, 'Enter');
  key(trigger, 'a');
  expect(document.querySelector('.ui-option.active')?.textContent).toContain('Alpha');
  key(document.body, 'Escape');
  expect(document.querySelector('[role=listbox]')).toBeNull();
  expect(log).toEqual([]);
});

import { FilterTabs } from '../src/components/FilterTabs';
function TabsDemo({ log }: { log: string[] }) {
  const [v, setV] = useState('all');
  return (
    <FilterTabs
      value={v}
      onChange={(x) => (log.push(x), setV(x))}
      tabs={[
        { value: 'all', label: '全部' },
        { value: 'http', label: 'REST' },
        { value: 'vector', label: 'AI 向量' },
      ]}
    />
  );
}
test('filter tabs: tablist semantics and arrow/Home/End navigation', async () => {
  const log: string[] = [];
  await act(async () => root.render(<TabsDemo log={log} />));
  const list = host.querySelector('[role=tablist]')!;
  expect(host.querySelectorAll('[role=tab]').length).toBe(3);
  expect(host.querySelector('.list-filter .selected')?.textContent).toBe('全部');
  key(list, 'ArrowRight');
  key(list, 'End');
  key(list, 'ArrowRight');
  key(list, 'ArrowLeft');
  expect(log).toEqual(['http', 'vector', 'all', 'vector']);
  expect(host.querySelector('[aria-selected=true]')?.textContent).toBe('AI 向量');
});

import { Markdown } from '../src/components/Markdown';
import { CodeBlock } from '../src/components/CodeBlock';
import { HIGHLIGHT_LIMIT } from '../src/lib/highlight';
import { guessLanguage } from '../src/lib/guessLanguage';
test('markdown code blocks are highlighted with label and copy button; unknown languages stay plain', async () => {
  const md = '```rust\nfn main() { let x = 1; }\n```\n\n```brainfuck\n+++.\n```';
  await act(async () => root.render(<Markdown text={md} />));
  const frames = host.querySelectorAll('.code-frame');
  expect(frames.length).toBe(2);
  expect(frames[0].querySelector('.code-lang')?.textContent).toBe('Rust');
  expect(frames[0].querySelector('code.hljs .hljs-keyword')?.textContent).toBe('fn');
  expect(frames[0].querySelector('.code-copy')).not.toBeNull();
  expect(frames[1].querySelector('.hljs-keyword')).toBeNull();
  expect(frames[1].querySelector('pre')?.textContent).toContain('+++.');
  expect(host.querySelector('[style]')).toBeNull();
});
test('response highlighting: json detected, oversized bodies stay plain', async () => {
  expect(guessLanguage('{"a":1}')).toBe('json');
  expect(guessLanguage('plain', 'text/plain')).toBeUndefined();
  expect(guessLanguage('<a/>', 'application/xml')).toBe('xml');
  await act(async () => root.render(<CodeBlock code={'{"ok":true}'} language="json" />));
  expect(host.querySelector('.hljs-attr')?.textContent).toBe('"ok"');
  const big = '{"k":"' + 'x'.repeat(HIGHLIGHT_LIMIT) + '"}';
  await act(async () => root.render(<CodeBlock code={big} language="json" />));
  expect(host.querySelector('.hljs-attr')).toBeNull();
});
