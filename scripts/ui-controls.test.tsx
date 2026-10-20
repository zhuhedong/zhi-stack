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
