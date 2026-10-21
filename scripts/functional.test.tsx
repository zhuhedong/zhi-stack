// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { formatDateTime } from '../src/lib/format';
import { markdownSnippet, stripLeadingTitle } from '../src/lib/markdownText';
import { preferredPillar, type Dimension } from '../src/types';
import { matchProjects, ProjectInput } from '../src/components/ProjectInput';
import { markRestored, restoredPending, setToken, storedToken, takeRestored } from '../src/lib/api';

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
  sessionStorage.clear();
});

test('formats dates in zh-CN 24h form', () => {
  const text = formatDateTime(new Date(2026, 9, 21, 11, 15, 33));
  expect(text).toBe('2026/10/21 11:15:33');
  expect(text).not.toMatch(/AM|PM/);
  expect(formatDateTime('not a date')).toBe('—');
  expect(formatDateTime(null)).toBe('—');
});

test('drops a leading H1 that repeats the title, in both heading styles', () => {
  expect(stripLeadingTitle('# Rust 指南\n\n正文', 'Rust 指南')).toBe('正文');
  expect(stripLeadingTitle('Rust 指南\n=====\n\n正文', 'Rust 指南')).toBe('正文');
  expect(stripLeadingTitle('# 另一个标题\n正文', 'Rust 指南')).toBe('# 另一个标题\n正文');
  expect(stripLeadingTitle('正文', '')).toBe('正文');
});

test('snippets drop code fences and markdown syntax', () => {
  const s = markdownSnippet('… return f"hi {name}"\n```\n\n结尾 **加粗** [链接](https://x) `code`\n```rust');
  expect(s).not.toContain('```');
  expect(s).toBe('… return f"hi {name}" 结尾 加粗 链接 code');
  expect(markdownSnippet('结尾。 ![文章插图](/api/media/525b3a94-ac7d…')).toBe('结尾。 …');
  expect(markdownSnippet('看 [文档](https://exa…')).toBe('看 文档…');
});

test('opens the first pillar with content, preferring articles', () => {
  const d = (kind: Dimension['kind'], count: number) =>
    ({ kind, category: '', project: '', count }) as Dimension;
  expect(preferredPillar([d('knowledge', 1), d('credential', 1)], 'credential')).toBe('credential');
  expect(preferredPillar([d('repo', 2), d('knowledge', 1)], 'credential')).toBe('knowledge');
  expect(preferredPillar([d('repo', 2)], 'knowledge')).toBe('repo');
  expect(preferredPillar([], 'knowledge')).toBe('knowledge');
});

test('project suggestions match partially and out of order', () => {
  const names = ['功能测试项目', '支付网关', 'Infra Platform'];
  expect(matchProjects(names, '功能测试')).toEqual(['功能测试项目']);
  expect(matchProjects(names, '测试')).toEqual(['功能测试项目']);
  expect(matchProjects(names, 'ifp')).toEqual(['Infra Platform']);
  expect(matchProjects(names, 'PLAT')).toEqual(['Infra Platform']);
  expect(matchProjects(names, '')).toHaveLength(3);
});

test('ProjectInput offers and picks a fuzzy match', () => {
  let picked = '';
  function Harness() {
    const [value, setValue] = useState('');
    picked = value;
    return <ProjectInput value={value} projects={['功能测试项目', '支付网关']} onChange={setValue} />;
  }
  act(() => root.render(<Harness />));
  const input = host.querySelector('input')!;
  act(() => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, '测试');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const options = [...host.querySelectorAll('[role=option]')].map((o) => o.textContent);
  expect(options).toEqual(['功能测试项目']);
  act(() => {
    host.querySelector('[role=option]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  expect(picked).toBe('功能测试项目');
});

test('session token survives reload state in sessionStorage and can be cleared', () => {
  setToken('abc');
  expect(storedToken()).toBe('abc');
  setToken('');
  expect(storedToken()).toBe('');
  expect(restoredPending()).toBe(false);
  markRestored();
  expect(restoredPending()).toBe(true);
  expect(takeRestored()).toBe(true);
  expect(takeRestored()).toBe(false);
});
