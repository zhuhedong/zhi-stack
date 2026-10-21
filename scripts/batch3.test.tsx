// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi, beforeEach } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { path: string; init?: RequestInit }[] = [];
let handler: (path: string, init?: RequestInit) => unknown = () => ({});
vi.mock('../src/lib/api', () => ({
  errorMessage: (e: unknown) => String(e),
  api: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return handler(path, init);
  },
}));
beforeEach(() => {
  calls.length = 0;
});
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
function input(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

test('scheduled backups: first enable needs password, restore needs confirmation phrase', async () => {
  const { ScheduledBackups } = await import('../src/components/ScheduledBackups');
  const { ConfirmationProvider } = await import('../src/components/ConfirmationProvider');
  const status = {
    schedule: {
      enabled: false,
      intervalHours: 24,
      keep: 7,
      targets: ['storage'],
      nextRunAt: '2026-10-21T00:00:00Z',
      lastRunAt: null,
      lastStatus: 'never',
      lastMessage: '',
      running: false,
      hasKey: false,
    },
    backups: [{ id: 'b1', target: 'storage', name: 'x', size: 2048, createdAt: '2026-10-20T00:00:00Z' }],
    storage: 'local',
    dirAvailable: false,
    serviceKey: true,
  };
  handler = () => status;
  const restored = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () =>
    createRoot(host).render(
      <ConfirmationProvider>
        <ScheduledBackups onRestored={restored} />
      </ConfirmationProvider>,
    ),
  );
  await flush();
  const enable = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  await act(async () => enable.click());
  const save = [...host.querySelectorAll('button')].find((b) => b.textContent === '保存设置')!;
  expect(save.disabled).toBe(true);
  const dir = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')][2];
  expect(dir.disabled).toBe(true);
  await act(async () => input(host.querySelector<HTMLInputElement>('input[type=password]')!, 'pw'));
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  await flush();
  const put = calls.find((c) => c.init?.method === 'PUT')!;
  expect(put.path).toBe('/backup/schedule');
  expect(JSON.parse(String(put.init!.body))).toMatchObject({
    enabled: true,
    password: 'pw',
    targets: ['storage'],
  });

  const open = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('从此备份恢复'))!;
  await act(async () => open.click());
  const fields = [...host.querySelectorAll<HTMLInputElement>('.feed-form input')];
  await act(async () => {
    input(fields[0], 'cur');
    input(fields[1], 'old');
  });
  const go = [...host.querySelectorAll('button')].find((b) => b.textContent === '恢复并替换当前数据')!;
  expect(go.disabled).toBe(true);
  await act(async () => input(fields[2], '恢复并替换'));
  expect(go.disabled).toBe(false);
  await act(async () => go.click());
  await flush();
  const post = calls.find((c) => c.path === '/backup/scheduled/b1/restore')!;
  expect(JSON.parse(String(post.init!.body))).toEqual({
    currentPassword: 'cur',
    password: 'old',
    confirm: '恢复并替换',
  });
  expect(restored).toHaveBeenCalled();
});
