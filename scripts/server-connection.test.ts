// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ClientConfig } from '../src/lib/server';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => native);
let disk: ClientConfig;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  disk = {
    serverUrl: null,
    configPath: 'C:/Users/test/AppData/Roaming/local.zhistack.infohub/config.json',
    error: null,
  };
  native.invoke.mockImplementation(async (command: string, args?: { serverUrl: string }) => {
    if (command === 'save_client_config') disk = { ...disk, serverUrl: args!.serverUrl };
    return { ...disk };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});
const health = { initialized: true, database: 'PostgreSQL', version: '0.2.0' };

test('a desktop without a configuration never connects to a default or cached server', async () => {
  localStorage.setItem('infohub.server-url', 'https://legacy.example/api');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const connection = await import('../src/lib/api');
  expect(connection.API_BASE).toBe('');
  expect((await connection.initializeServer()).serverUrl).toBeNull();
  await expect(connection.request('/health')).rejects.toThrow('请先填写并保存');
  expect(fetcher).not.toHaveBeenCalled();
  expect((await import('../src/lib/server')).previousServerUrl()).toBe('https://legacy.example/api');
});

test('desktop configuration normalizes URLs and loads the saved file after a relaunch', async () => {
  const connection = await import('../src/lib/api');
  localStorage.setItem('infohub.server-url', 'https://legacy.example/api');
  await connection.configureServer(' https://example.com/ ');
  expect(connection.API_BASE).toBe('https://example.com/api');
  expect(native.invoke).toHaveBeenCalledWith('save_client_config', { serverUrl: 'https://example.com/api' });
  await connection.configureServer('https://example.com/infohub/api/');
  expect(connection.API_BASE).toBe('https://example.com/infohub/api');
  expect(localStorage.getItem('infohub.server-url')).toBeNull();
  vi.resetModules();
  const reopened = await import('../src/lib/api');
  expect(reopened.API_BASE).toBe('');
  await reopened.initializeServer();
  expect(reopened.API_BASE).toBe('https://example.com/infohub/api');
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.resetModules();
  native.invoke.mockClear();
  const browser = await import('../src/lib/api');
  await browser.initializeServer();
  expect(browser.API_BASE).toBe('/api');
  expect(native.invoke).not.toHaveBeenCalled();
});

test('invalid server URLs never replace the saved endpoint or clear an existing session', async () => {
  const connection = await import('../src/lib/api');
  await connection.configureServer('https://example.com');
  connection.setToken('existing-session');
  for (const invalid of [
    'javascript:alert(1)',
    'file:///secret',
    'https://user:password@example.com',
    'https://example.com?token=secret',
    'https://example.com#api',
    'https://example.com?',
    'https://example.com#',
    'https://exam\nple.com',
    'localhost:3210',
  ])
    await expect(connection.configureServer(invalid)).rejects.toThrow();
  const fetcher = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  await connection.request('/items');
  expect(fetcher.mock.calls[0][0]).toBe('https://example.com/api/items');
  expect(fetcher.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer existing-session');
});

test('connection checks omit secrets and cookies and reject redirects and non-InfoHub responses', async () => {
  const connection = await import('../src/lib/api');
  const { checkServerConnection } = await import('../src/lib/server');
  connection.setToken('private-session');
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(health)))
    .mockResolvedValueOnce(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  expect(await checkServerConnection('https://new.example.com')).toBe(true);
  const [address, options] = fetcher.mock.calls[0];
  expect(address).toBe('https://new.example.com/api/health');
  expect(options.credentials).toBe('omit');
  expect(options.redirect).toBe('error');
  expect(options.headers).toBeUndefined();
  expect(options.body).toBeUndefined();
  expect(connection.API_BASE).toBe('');
  expect(native.invoke).not.toHaveBeenCalled();
  await expect(checkServerConnection('https://not-infohub.example.com')).rejects.toThrow('有效的 InfoHub');
});

test('switching servers clears authentication and discards late unauthorized responses from the old server', async () => {
  const connection = await import('../src/lib/api');
  await connection.configureServer('https://old.example.com');
  connection.setToken('old-private-session');
  let finish!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  const unauthorized = vi.fn();
  window.addEventListener('infohub:unauthorized', unauthorized);
  const pending = connection.request('/items');
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await connection.configureServer('https://new.example.com');
  finish(new Response('{}', { status: 401 }));
  await rejected;
  await connection.request('/items');
  expect(fetcher.mock.calls[1][0]).toBe('https://new.example.com/api/items');
  expect(fetcher.mock.calls[1][1].headers.has('Authorization')).toBe(false);
  expect(unauthorized).not.toHaveBeenCalled();
  window.removeEventListener('infohub:unauthorized', unauthorized);
});

test('a failed configuration file write leaves the working connection and session intact', async () => {
  const connection = await import('../src/lib/api');
  await connection.configureServer('https://original.example.com');
  connection.setToken('existing-session');
  native.invoke.mockRejectedValueOnce('无法保存本机配置文件，原配置已保留，请检查文件权限');
  await expect(connection.configureServer('https://new.example.com')).rejects.toThrow('原配置已保留');
  expect(connection.API_BASE).toBe('https://original.example.com/api');
  expect(disk.serverUrl).toBe('https://original.example.com/api');
  const fetcher = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  await connection.request('/items');
  expect(fetcher.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer existing-session');
});

test('a delayed configuration read cannot overwrite a newly saved connection', async () => {
  const connection = await import('../src/lib/api');
  let finish!: (config: ClientConfig) => void;
  native.invoke.mockImplementationOnce(
    () =>
      new Promise<ClientConfig>((resolve) => {
        finish = resolve;
      }),
  );
  const loading = connection.initializeServer();
  const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalled());
  await connection.configureServer('https://new.example.com');
  finish({ ...disk, serverUrl: 'https://old.example.com/api' });
  await rejected;
  expect(connection.API_BASE).toBe('https://new.example.com/api');
});

test('responses from a previous login cannot expose data or log out the new session', async () => {
  const connection = await import('../src/lib/api');
  await connection.configureServer('https://example.com');
  for (const status of [200, 401, 423]) {
    connection.setToken('old-session');
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const unauthorized = vi.fn(),
      locked = vi.fn();
    window.addEventListener('infohub:unauthorized', unauthorized);
    window.addEventListener('infohub:locked', locked);
    const pending = connection.api('/items');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    connection.setToken('new-session');
    finish(new Response('{"secret":"old response"}', { status }));
    await rejected;
    expect(unauthorized).not.toHaveBeenCalled();
    expect(locked).not.toHaveBeenCalled();
    window.removeEventListener('infohub:unauthorized', unauthorized);
    window.removeEventListener('infohub:locked', locked);
  }
});
