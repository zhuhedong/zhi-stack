// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthScreen } from '../src/components/AuthScreen';
import { ServerSettings } from '../src/components/ServerSettings';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  configureServer: vi.fn(),
  checkServerConnection: vi.fn(),
  setToken: vi.fn(),
}));
vi.mock('../src/lib/platform', () => ({ isDesktop: true }));
vi.mock('../src/lib/api', () => ({
  ...mocks,
  API_BASE: 'http://127.0.0.1:3210/api',
  errorMessage: (e: Error) => e.message,
}));
vi.mock('../src/lib/server', async (original) => ({
  ...(await original<typeof import('../src/lib/server')>()),
  checkServerConnection: mocks.checkServerConnection,
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.api.mockResolvedValue({ initialized: true, database: 'PostgreSQL', version: '0.1.0' });
  mocks.checkServerConnection.mockResolvedValue(true);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function fill(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test('desktop login can change its server without reusing the typed master password', async () => {
  await act(async () => root.render(<AuthScreen onLogin={vi.fn()} />));
  await fill(host.querySelector('input[type="password"]')!, 'Do-not-send-to-new-server');
  await click('服务连接设置');
  await fill(host.querySelector('[aria-label="服务端地址"]')!, 'https://new.example.com');
  await click('保存并连接');
  expect(mocks.configureServer).toHaveBeenCalledWith('https://new.example.com');
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
  expect(mocks.api.mock.calls.filter(([path]) => path.startsWith('/auth/'))).toHaveLength(0);
  expect(mocks.api.mock.calls.filter(([path]) => path === '/health')).toHaveLength(2);
});

test('testing a server does not save it; editing the address clears the previous success message', async () => {
  const saved = vi.fn();
  await act(async () => root.render(<ServerSettings onClose={vi.fn()} onSaved={saved} />));
  await click('测试连接');
  expect(host.textContent).toContain('连接成功');
  expect(mocks.configureServer).not.toHaveBeenCalled();
  await fill(host.querySelector('[aria-label="服务端地址"]')!, 'https://another.example.com');
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(saved).not.toHaveBeenCalled();
});

test('invalid health responses keep master-password submission disabled', async () => {
  mocks.api.mockResolvedValue({ initialized: true });
  await act(async () => root.render(<AuthScreen onLogin={vi.fn()} />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('有效的 InfoHub');
  expect(host.querySelector<HTMLButtonElement>('.auth-submit')!.disabled).toBe(true);
  await click('服务连接设置');
  expect(host.querySelector('[aria-label="服务端地址"]')).not.toBeNull();
});
