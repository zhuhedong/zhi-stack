// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});
const health = { initialized: true, database: 'PostgreSQL', version: '0.1.0' };

test('desktop server preferences normalize origins and proxy prefixes and survive a relaunch', async () => {
  const connection = await import('../src/lib/api');
  connection.configureServer(' https://example.com/ ');
  expect(connection.API_BASE).toBe('https://example.com/api');
  connection.configureServer('https://example.com/infohub/api/');
  expect(connection.API_BASE).toBe('https://example.com/infohub/api');
  vi.resetModules();
  expect((await import('../src/lib/api')).API_BASE).toBe('https://example.com/infohub/api');
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.resetModules();
  expect((await import('../src/lib/api')).API_BASE).toBe('/api');
});

test('invalid server URLs never replace the saved endpoint or clear an existing session', async () => {
  const connection = await import('../src/lib/api');
  connection.configureServer('https://example.com');
  connection.setToken('existing-session');
  for (const invalid of [
    'javascript:alert(1)',
    'file:///secret',
    'https://user:password@example.com',
    'https://example.com?token=secret',
    'https://example.com#api',
    'localhost:3210',
  ])
    expect(() => connection.configureServer(invalid)).toThrow();
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
  expect(connection.API_BASE).toBe('http://127.0.0.1:3210/api');
  await expect(checkServerConnection('https://not-infohub.example.com')).rejects.toThrow('有效的 InfoHub');
});

test('switching servers clears authentication and discards late unauthorized responses from the old server', async () => {
  const connection = await import('../src/lib/api');
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
  connection.configureServer('https://new.example.com');
  finish(new Response('{}', { status: 401 }));
  await rejected;
  await connection.request('/items');
  expect(fetcher.mock.calls[1][0]).toBe('https://new.example.com/api/items');
  expect(fetcher.mock.calls[1][1].headers.has('Authorization')).toBe(false);
  expect(unauthorized).not.toHaveBeenCalled();
  window.removeEventListener('infohub:unauthorized', unauthorized);
});

test('a failed preference write leaves the working connection intact', async () => {
  const connection = await import('../src/lib/api');
  connection.configureServer('https://original.example.com');
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw new DOMException('Storage disabled', 'QuotaExceededError');
  };
  try {
    expect(() => connection.configureServer('https://new.example.com')).toThrow('无法保存服务地址');
    expect(connection.API_BASE).toBe('https://original.example.com/api');
  } finally {
    Storage.prototype.setItem = original;
  }
});

test('responses from a previous login cannot expose data or log out the new session', async () => {
  const connection = await import('../src/lib/api');
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
