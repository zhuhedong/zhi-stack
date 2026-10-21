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

test('chaining: JSON path, header, regex extraction and assertions', async () => {
  const { evaluate, parsePath, queryJson, applyVariables } = await import('../src/lib/chaining');
  expect(parsePath('$.data.items[0]["a b"][*].id')).toEqual(['data', 'items', 0, 'a b', '*', 'id']);
  expect(() => parsePath('data.x')).toThrow();
  expect(() => parsePath('$.a;alert(1)')).toThrow();
  const doc = { data: { token: 'T1', items: [{ id: 1 }, { id: 2 }], empty: null }, 中文: '值' };
  expect(queryJson(doc, '$.data.items[-1].id')).toEqual([2]);
  expect(queryJson(doc, '$.data.items.length')).toEqual([2]);
  expect(queryJson(doc, '$.constructor')).toEqual([]);
  expect(queryJson(doc, '$.data.__proto__')).toEqual([]);
  const response = {
    status: 201,
    headers: { 'X-Request-Id': 'rid-9', 'content-type': 'application/json' },
    body: JSON.stringify(doc),
    durationMs: 42,
  };
  const outcome = evaluate(
    response,
    [
      { id: '1', enabled: true, source: 'json', expr: '$.data.token', variable: 'token' },
      { id: '2', enabled: true, source: 'header', expr: 'x-request-id', variable: 'rid' },
      { id: '3', enabled: true, source: 'json', expr: '$.data.items[*].id', variable: 'ids' },
      { id: '4', enabled: true, source: 'regex', expr: '"token":"(\\w+)"', variable: 'raw' },
      { id: '5', enabled: true, source: 'json', expr: '$.missing', variable: 'm' },
      { id: '6', enabled: false, source: 'json', expr: '$.data', variable: 'off' },
      { id: '7', enabled: true, source: 'json', expr: '$.中文', variable: 'zh' },
    ],
    [
      { id: 'a', enabled: true, source: 'status', expr: '', op: 'eq', value: '201' },
      { id: 'b', enabled: true, source: 'json', expr: '$.data.items.length', op: 'gt', value: '1' },
      { id: 'c', enabled: true, source: 'time', expr: '', op: 'lt', value: '10' },
      { id: 'd', enabled: true, source: 'json', expr: '$.nope', op: 'notExists', value: '' },
      { id: 'e', enabled: true, source: 'header', expr: 'content-type', op: 'matches', value: '/JSON/i' },
      { id: 'f', enabled: true, source: 'regex', expr: '(', op: 'exists', value: '' },
    ],
  );
  expect(outcome.variables).toEqual([
    { name: 'token', value: 'T1' },
    { name: 'rid', value: 'rid-9' },
    { name: 'ids', value: '[1,2]' },
    { name: 'raw', value: 'T1' },
    { name: 'zh', value: '值' },
  ]);
  expect(outcome.errors).toHaveLength(1);
  expect(outcome.assertions.map((a) => a.passed)).toEqual([true, true, false, true, true, false]);
  expect(outcome.assertions[5].message).toBeTruthy();
  const notJson = evaluate(
    { ...response, body: '<html>' },
    [{ id: '1', enabled: true, source: 'json', expr: '$.a', variable: 'a' }],
    [],
  );
  expect(notJson.errors[0]).toContain('JSON');
  type V = { key: string; value: string; enabled: boolean };
  const vars: V[] = [{ key: 'token', value: 'old', enabled: false }];
  expect(
    applyVariables(
      vars,
      [
        { name: 'token', value: 'new' },
        { name: 'rid', value: 'r' },
      ],
      (key, value) => ({ key, value, enabled: true }),
    ),
  ).toEqual([
    { key: 'token', value: 'new', enabled: true },
    { key: 'rid', value: 'r', enabled: true },
  ]);
});

test('chaining: worker evaluates and times out runaway patterns', async () => {
  const listeners: ((e: MessageEvent) => void)[] = [];
  let terminated = 0;
  let hang = false;
  class FakeWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror = null;
    constructor() {
      listeners.length = 0;
    }
    async postMessage(message: unknown) {
      if (hang) return;
      const self = {
        postMessage: (data: unknown) => this.onmessage?.({ data } as MessageEvent),
        onmessage: null as unknown,
      };
      vi.stubGlobal('self', self);
      vi.resetModules();
      await import('../src/lib/chaining.worker');
      (self.onmessage as (e: MessageEvent) => void)({ data: message } as MessageEvent);
      vi.stubGlobal('self', window);
    }
    terminate() {
      terminated++;
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  const { evaluateInWorker } = await import('../src/lib/chaining');
  const response = { status: 200, headers: {}, body: '{"a":1}', durationMs: 1 };
  const out = await evaluateInWorker(
    response,
    [{ id: '1', enabled: true, source: 'json', expr: '$.a', variable: 'a' }],
    [],
  );
  expect(out.variables).toEqual([{ name: 'a', value: '1' }]);
  expect(terminated).toBe(1);
  hang = true;
  vi.useFakeTimers();
  const pending = evaluateInWorker(response, [], []);
  vi.advanceTimersByTime(2500);
  await expect(pending).rejects.toThrow('超时');
  expect(terminated).toBe(2);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const collection = () =>
  ({
    id: 'c1',
    title: '订单服务',
    summary: '',
    data: {
      fields: { baseUrl: 'https://api.example.com/v1' },
      globalHeaders: [{ key: 'Authorization', value: 'Bearer secret-token', enabled: true }],
      environments: [
        {
          id: 'e1',
          name: '测试',
          variables: [
            { key: 'userId', value: '42', enabled: true },
            { key: 'apiToken', value: 'tok-secret', enabled: true },
          ],
        },
      ],
      activeEnvironment: 'e1',
      swaggerEndpoints: [
        {
          method: 'POST',
          path: '/login',
          summary: '登录',
          tag: '认证',
          customHeaders: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
          queryParams: [],
          pathParams: [],
          requestBody: '{"name":"a"}',
          extractions: [{ id: 'x', enabled: true, source: 'json', expr: '$.data.token', variable: 'token' }],
          assertions: [{ id: 'y', enabled: true, source: 'status', expr: '', op: 'eq', value: '200' }],
        },
        {
          method: 'GET',
          path: '/orders/{id}?expand=items',
          summary: '订单详情',
          tag: '订单',
          customHeaders: [{ key: 'X-Trace', value: '{{trace}}', enabled: true }],
          queryParams: [{ key: 'lang', value: 'zh', enabled: true, desc: '语言' }],
          pathParams: [{ key: 'id', value: '{{userId}}', enabled: true }],
          requestBody: '',
        },
        {
          method: 'DELETE',
          path: '/orders/{id}',
          summary: '删除订单',
          tag: '订单',
          customHeaders: [],
          queryParams: [],
          pathParams: [{ key: 'id', value: '1', enabled: true }],
          requestBody: '',
        },
      ],
    },
  }) as unknown as import('../src/types').Item;

test('api export: OpenAPI 3 document', async () => {
  const { toOpenApi } = await import('../src/lib/apiExport');
  const doc = toOpenApi(collection());
  expect(doc.openapi).toBe('3.0.3');
  expect(doc.servers).toEqual([{ url: 'https://api.example.com/v1' }]);
  expect(Object.keys(doc.paths).sort()).toEqual(['/login', '/orders/{id}']);
  const get = doc.paths['/orders/{id}'].get as {
    parameters: { name: string; in: string; example?: string }[];
  };
  expect(get.parameters.map((p) => `${p.in}:${p.name}`)).toEqual([
    'path:id',
    'query:expand',
    'query:lang',
    'header:Authorization',
    'header:X-Trace',
  ]);
  expect(get.parameters.find((p) => p.name === 'Authorization')!.example).toBe('{{Authorization}}');
  expect(JSON.stringify(doc)).not.toContain('secret');
  expect(Object.keys(doc.paths['/orders/{id}'])).toEqual(['get', 'delete']);
  const login = doc.paths['/login'].post as {
    requestBody: { content: Record<string, { example: unknown }> };
  };
  expect(login.requestBody.content['application/json'].example).toEqual({ name: 'a' });
  const ids = Object.values(doc.paths).flatMap((m) =>
    Object.values(m).map((o) => (o as { operationId: string }).operationId),
  );
  expect(new Set(ids).size).toBe(ids.length);
  expect(JSON.stringify(toOpenApi(collection(), { includeSecrets: true }))).toContain('secret-token');
});

test('api export: Postman v2.1 collection with tests from assertions', async () => {
  const { toPostman } = await import('../src/lib/apiExport');
  const doc = toPostman(collection()) as unknown as {
    info: { schema: string };
    item: {
      name: string;
      item: { name: string; request: Record<string, any>; event?: { script: { exec: string[] } }[] }[];
    }[];
    variable: { key: string; value: string }[];
  };
  expect(doc.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
  expect(doc.item.map((f) => f.name)).toEqual(['认证', '订单']);
  const detail = doc.item[1].item[0].request;
  expect(detail.url.raw).toBe('{{baseUrl}}/orders/:id?expand=items&lang=zh');
  expect(detail.url.variable).toEqual([{ key: 'id', value: '{{userId}}' }]);
  expect(detail.header.find((h: { key: string }) => h.key === 'Authorization').value).toBe(
    '{{Authorization}}',
  );
  const login = doc.item[0].item[0];
  expect(login.request.body).toEqual({
    mode: 'raw',
    raw: '{"name":"a"}',
    options: { raw: { language: 'json' } },
  });
  const exec = login.event![0].script.exec.join('\n');
  expect(exec).toContain('pm.environment.set("token"');
  expect(exec).toContain('pm.response.json().data.token');
  expect(exec).toContain('pm.test(');
  expect(doc.variable).toEqual([
    { key: 'baseUrl', value: 'https://api.example.com/v1' },
    { key: 'userId', value: '42' },
    { key: 'apiToken', value: '' },
  ]);
  // Generated test code must be valid JavaScript.
  for (const line of login.event![0].script.exec) expect(() => new Function('pm', line)).not.toThrow();
});

test('notification settings: create channel payload and edit keeps blank secrets out', async () => {
  const { NotificationSettings } = await import('../src/components/NotificationSettings');
  const { ConfirmationProvider } = await import('../src/components/ConfirmationProvider');
  const channels = [
    {
      id: 'n1',
      name: '团队群',
      kind: 'dingtalk',
      enabled: true,
      config: {},
      secret: {
        urlHost: 'oapi.dingtalk.com',
        hasUrl: true,
        hasSigning: true,
        hasBotToken: false,
        hasPassword: false,
      },
      lastStatus: 'success',
      lastError: '',
    },
  ];
  handler = (path, init) =>
    init?.method ? { id: 'n2' } : path === '/notifications/channels' ? { channels } : {};
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () =>
    createRoot(host).render(
      <ConfirmationProvider>
        <NotificationSettings />
      </ConfirmationProvider>,
    ),
  );
  await flush();
  expect(host.textContent).toContain('oapi.dingtalk.com');
  expect(host.textContent).toContain('已配置签名');
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
  await act(async () => button('添加通知渠道').click());
  const inputs = () => [...host.querySelectorAll<HTMLInputElement>('.feed-form input')];
  await act(async () => {
    input(inputs()[0], '企微群');
    input(inputs()[2], 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k');
  });
  await act(async () => button('保存').click());
  await flush();
  const post = calls.find((c) => c.init?.method === 'POST')!;
  expect(JSON.parse(String(post.init!.body))).toEqual({
    name: '企微群',
    kind: 'wecom',
    enabled: true,
    config: {},
    secret: { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' },
  });
  await act(async () => button('编辑').click());
  expect(host.textContent).toContain('留空保持不变');
  await act(async () => button('保存').click());
  await flush();
  const put = calls.find((c) => c.init?.method === 'PUT')!;
  expect(put.path).toBe('/notifications/channels/n1');
  expect(JSON.parse(String(put.init!.body)).secret).toEqual({});
});
