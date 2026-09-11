// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../src/App';
import { KnowledgeView } from '../src/components/views/KnowledgeView';
import { ApiWorkbench } from '../src/components/ApiWorkbench';
import { AuthScreen } from '../src/components/AuthScreen';
import { ItemEditor } from '../src/components/ItemEditor';
import { IngestModal } from '../src/components/IngestModal';
import { RepoView } from '../src/components/views/RepoView';
import { Attachments } from '../src/components/Attachments';
import { Markdown, archivedMediaPath } from '../src/components/Markdown';
import { emptyEndpoint } from '../src/lib/request';
import type { Item } from '../src/types';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  saveItem: vi.fn(),
  copyText: vi.fn(),
  downloadBlob: vi.fn(),
  exportText: vi.fn(),
  request: vi.fn(),
  desktopAction: vi.fn(),
}));
vi.mock('../src/lib/api', () => ({
  ...mocks,
  API_BASE: '/api',
  setToken: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));

let host: HTMLDivElement;
let root: Root;
const item = (kind: Item['kind'] = 'knowledge'): Item => ({
  id: kind,
  kind,
  title: kind === 'knowledge' ? '验收文章' : '验收接口',
  category: kind === 'knowledge' ? 'note' : 'http',
  project: '测试项目',
  tags: [],
  summary: '',
  url: 'https://example.com/articles/start',
  favorite: false,
  revision: 1,
  createdAt: '2026-09-09T00:00:00Z',
  updatedAt: '2026-09-09T00:00:00Z',
  data:
    kind === 'knowledge'
      ? { content: 'initial' }
      : {
          fields: { baseUrl: 'https://example.com' },
          swaggerEndpoints: [
            { ...emptyEndpoint(), path: '/first' },
            { ...emptyEndpoint(), path: '/second' },
          ],
        },
});
function button(name: string) {
  const found = [...host.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  );
  if (!found) throw new Error('Button not found: ' + name);
  return found;
}
function input(label: string) {
  const field =
    host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[aria-label="${label}"]`,
    ) ||
    [...host.querySelectorAll('label')]
      .find((l) => l.textContent?.trim() === label)
      ?.querySelector('input,textarea,select');
  if (!field) throw new Error('Field not found: ' + label);
  return field as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}
async function fill(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : field instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function render(ui: ReactNode) {
  await act(async () => root.render(ui));
}
async function submit() {
  await act(async () =>
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
function unload() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.saveItem.mockReset();
  mocks.api.mockImplementation(async (path: string) => {
    if (path === '/health') return { initialized: true, database: 'PostgreSQL', version: '0.1.0' };
    if (path === '/auth/login') return { token: 'test-token' };
    if (path.endsWith('/attachments')) return [];
    if (path.startsWith('/items?')) {
      const kind = new URLSearchParams(path.split('?')[1]).get('kind');
      const items = [item(), item('credential')].filter((i) => !kind || i.kind === kind);
      return {
        items,
        total: items.length,
        unlocked: true,
        dimensions: [
          { kind: 'knowledge', category: 'note', project: '测试项目', count: 1 },
          { kind: 'credential', category: 'http', project: '测试项目', count: 1 },
        ],
      };
    }
    if (path.startsWith('/items/')) return item(path.endsWith('credential') ? 'credential' : 'knowledge');
    return { unlocked: true };
  });
  vi.spyOn(window, 'confirm').mockReturnValue(false);
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('new-item drafts block window close and switching to credentials is cleared by vault lock', async () => {
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  await click('知识与文章1');
  await click('新建资产');
  await fill(host.querySelector<HTMLSelectElement>('dialog select')!, 'credential');
  await fill(input('资产名称'), 'sensitive draft');
  expect(unload()).toBe(true);
  await act(async () => window.dispatchEvent(new Event('infohub:locked')));
  expect(host.querySelector('dialog')).toBeNull();
  expect(host.textContent).not.toContain('sensitive draft');
  expect(unload()).toBe(false);
});

test('locking the vault preserves an unsaved article and its close guard', async () => {
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  await click('知识与文章1');
  await act(async () => host.querySelector<HTMLButtonElement>('.list-item')!.click());
  await click('Markdown');
  await fill(input('Markdown 正文'), 'unsaved article');
  await act(async () => window.dispatchEvent(new Event('infohub:locked')));
  expect(input('Markdown 正文').value).toBe('unsaved article');
  expect(unload()).toBe(true);
});

test('editing during save remains dirty and the next save uses the latest revision', async () => {
  const pending = deferred<Item>();
  mocks.saveItem.mockReturnValueOnce(pending.promise);
  const onDirty = vi.fn();
  function Harness() {
    const [value, setValue] = useState(item());
    return <KnowledgeView item={value} onSaved={setValue} onDirty={onDirty} />;
  }
  await render(<Harness />);
  await click('Markdown');
  await fill(input('Markdown 正文'), 'first save');
  await click('保存修改');
  await fill(input('Markdown 正文'), 'later edits');
  await act(async () => pending.resolve({ ...item(), revision: 2, data: { content: 'first save' } }));
  expect(button('保存修改').disabled).toBe(false);
  expect(onDirty).toHaveBeenLastCalledWith(true);
  mocks.saveItem.mockResolvedValue({ ...item(), revision: 3, data: { content: 'later edits' } });
  await click('保存修改');
  expect(mocks.saveItem.mock.lastCall?.[0].revision).toBe(2);
  expect(mocks.saveItem.mock.lastCall?.[0].data.content).toBe('later edits');
  expect(button('已保存').disabled).toBe(true);
});

test('finishing a save after navigation does not clear another view draft', async () => {
  const pending = deferred<Item>();
  mocks.saveItem.mockReturnValue(pending.promise);
  const onDirty = vi.fn(),
    onSaved = vi.fn();
  await render(<KnowledgeView item={item()} onSaved={onSaved} onDirty={onDirty} />);
  await click('Markdown');
  await fill(input('Markdown 正文'), 'pending');
  await click('保存修改');
  await render(<p>Other view</p>);
  await act(async () => pending.resolve({ ...item(), revision: 2 }));
  expect(onSaved).not.toHaveBeenCalled();
  expect(onDirty).toHaveBeenLastCalledWith(true);
});

test('responses from a previously selected endpoint never appear under another endpoint', async () => {
  const pending = deferred<unknown>();
  mocks.api.mockImplementation(() => pending.promise);
  await render(
    <ApiWorkbench item={item('credential')} onSaved={vi.fn()} onDirty={vi.fn()} notify={vi.fn()} />,
  );
  await click('发送请求');
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.endpoint')[1].click());
  await act(async () =>
    pending.resolve({ status: 200, body: 'response from first', headers: {}, size: 19, durationMs: 1 }),
  );
  expect(input('接口路径').value).toBe('/second');
  expect(host.textContent).not.toContain('response from first');
  const send = host.querySelector<HTMLButtonElement>('.send-probe')!;
  expect(send.disabled).toBe(false);
  expect(send.textContent).toContain('发送请求');
  expect(send.textContent).not.toContain('请求中');
});

test('an in-flight probe superseded by switching endpoints re-enables Send', async () => {
  const pending = deferred<unknown>();
  mocks.api.mockImplementation(() => pending.promise);
  await render(
    <ApiWorkbench item={item('credential')} onSaved={vi.fn()} onDirty={vi.fn()} notify={vi.fn()} />,
  );
  await click('发送请求');
  expect(host.querySelector<HTMLButtonElement>('.send-probe')?.disabled).toBe(true);
  expect(host.querySelector('.send-probe')?.textContent).toContain('请求中');
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.endpoint')[1].click());
  const send = host.querySelector<HTMLButtonElement>('.send-probe')!;
  expect(send.disabled).toBe(false);
  expect(send.textContent).toContain('发送请求');
  expect(send.textContent).not.toContain('请求中');
  await act(async () =>
    pending.resolve({ status: 200, body: 'stale-after-switch', headers: {}, size: 18, durationMs: 1 }),
  );
  expect(send.disabled).toBe(false);
  expect(host.textContent).not.toContain('stale-after-switch');
});

test('binary response download preserves every original byte', async () => {
  mocks.api.mockResolvedValue({
    status: 200,
    body: '',
    bodyBase64: 'AP8BAg==',
    headers: {},
    size: 4,
    durationMs: 1,
  });
  await render(
    <ApiWorkbench item={item('credential')} onSaved={vi.fn()} onDirty={vi.fn()} notify={vi.fn()} />,
  );
  await click('发送请求');
  await click('下载响应');
  const [blob, name] = mocks.downloadBlob.mock.lastCall!;
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
  expect([...new Uint8Array(bytes)]).toEqual([0, 255, 1, 2]);
  expect(name).toBe('response.bin');
});

test('article relative links resolve against the captured source', async () => {
  await render(
    <KnowledgeView
      item={{ ...item(), data: { content: '[Related](../guide#intro)' } }}
      onSaved={vi.fn()}
      onDirty={vi.fn()}
    />,
  );
  expect(host.querySelector('a')?.href).toBe('https://example.com/guide#intro');
});

test('all credential presets expose the correct fields and locked forms cannot choose credentials', async () => {
  await render(
    <ItemEditor
      pillar="credential"
      unlocked
      onDraft={vi.fn()}
      projects={[]}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  const selects = host.querySelectorAll('select');
  const expected: Record<string, string[]> = {
    rest_api: ['baseUrl', 'swaggerUrl'],
    postgresql: ['host', 'port', 'database', 'username', 'password'],
    mysql: ['host', 'port', 'database', 'username', 'password'],
    redis: ['host', 'port', 'dbIndex', 'authPassword'],
    mongodb: ['host', 'port', 'database', 'username', 'password'],
    milvus: ['host', 'port', 'username', 'password', 'collection'],
    qdrant: ['host', 'port', 'apiKey', 'collection'],
    ssh: ['host', 'port', 'username', 'password', 'privateKey'],
    account: ['url', 'username', 'password', 'notes'],
  };
  for (const [type, fields] of Object.entries(expected)) {
    await fill(selects[1], type);
    expect(
      [...host.querySelectorAll('[aria-label^="删除属性 "]')].map((b) =>
        b.getAttribute('aria-label')!.replace('删除属性 ', ''),
      ),
    ).toEqual(fields);
  }
  await render(
    <ItemEditor
      key="locked"
      pillar="knowledge"
      unlocked={false}
      onDraft={vi.fn()}
      projects={[]}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(host.querySelector<HTMLOptionElement>('option[value="credential"]')?.disabled).toBe(true);
});

test('new-item cancel and ingest cancel keep entered content when discard is declined', async () => {
  const close = vi.fn();
  await render(
    <ItemEditor
      pillar="knowledge"
      unlocked
      onDraft={vi.fn()}
      projects={[]}
      onClose={close}
      onSaved={vi.fn()}
    />,
  );
  await fill(input('文章标题'), 'draft');
  await click('取消');
  expect(close).not.toHaveBeenCalled();
  await render(
    <IngestModal initialUrl="https://example.com" onDraft={vi.fn()} onClose={close} onSaved={vi.fn()} />,
  );
  await click('取消');
  expect(close).not.toHaveBeenCalled();
  expect(window.confirm).toHaveBeenCalledTimes(2);
});

test('initialization rejects mismatched confirmation before sending the master password', async () => {
  mocks.api.mockResolvedValue({ initialized: false, database: 'PostgreSQL', version: '0.1.0' });
  await render(<AuthScreen onLogin={vi.fn()} />);
  await fill(input('主密码'), 'a-valid-test-password');
  await fill(input('确认主密码'), 'different-test-password');
  await submit();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('两次输入的主密码不一致');
  expect(mocks.api).toHaveBeenCalledTimes(1);
});

test('global headers, per-endpoint overrides and disabled headers control the actual request', async () => {
  const value = item('credential');
  value.data.globalHeaders = [{ key: 'Authorization', value: 'global-value', enabled: true }];
  mocks.api.mockResolvedValue({ status: 200, body: 'ok', headers: {}, size: 2, durationMs: 1 });
  await render(<ApiWorkbench item={value} onSaved={vi.fn()} onDirty={vi.fn()} notify={vi.fn()} />);
  await fill(input('全局 Header值 Authorization'), 'updated-global');
  await click('添加专属 Header');
  await fill(input('接口 Header键名 1'), 'authorization');
  await fill(input('接口 Header值 authorization'), 'local-value');
  await click('发送请求');
  expect(JSON.parse(mocks.api.mock.lastCall![1].body).headers).toEqual([
    { key: 'authorization', value: 'local-value', enabled: true, desc: '' },
  ]);
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="接口 Header启用 authorization"]')!.click(),
  );
  await click('发送请求');
  expect(JSON.parse(mocks.api.mock.lastCall![1].body).headers[0].value).toBe('updated-global');
  await click('删除接口 Header authorization');
  expect(host.querySelector('[aria-label="接口 Header值 authorization"]')).toBeNull();
});

test('body formatting reports invalid JSON, formats valid JSON and GET sends no body', async () => {
  const value = item('credential');
  value.data.swaggerEndpoints![0].method = 'POST';
  mocks.api.mockResolvedValue({ status: 200, body: 'ok', headers: {}, size: 2, durationMs: 1 });
  await render(<ApiWorkbench item={value} onSaved={vi.fn()} onDirty={vi.fn()} notify={vi.fn()} />);
  await click('Body');
  await fill(input('请求正文'), '{bad');
  await click('格式化 JSON');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('JSON 格式无效');
  await fill(input('请求正文'), '{"ok":true}');
  await click('格式化 JSON');
  expect(input('请求正文').value).toBe('{\n  "ok": true\n}');
  await fill(input('HTTP 方法'), 'GET');
  await click('发送请求');
  expect(JSON.parse(mocks.api.mock.lastCall![1].body).body).toBeUndefined();
});

test('custom credential fields and tags are saved, and editing an existing item keeps its kind', async () => {
  const saved = vi.fn();
  mocks.saveItem.mockResolvedValue(item('credential'));
  await render(
    <ItemEditor
      pillar="credential"
      unlocked
      onDraft={vi.fn()}
      projects={[]}
      onClose={vi.fn()}
      onSaved={saved}
    />,
  );
  await fill(input('资产名称'), 'custom credential');
  await fill(input('标签'), '后端， PG, demo');
  await fill(input('自定义属性名称'), 'accessToken');
  await click('添加属性');
  const label = [...host.querySelectorAll('label')].find((l) => l.textContent?.startsWith('accessToken'))!;
  await fill(label.querySelector('input')!, 'dummy-token');
  expect(label.querySelector('input')?.type).toBe('password');
  await submit();
  expect(mocks.saveItem.mock.lastCall![0].data.fields.accessToken).toBe('dummy-token');
  expect(mocks.saveItem.mock.lastCall![0].tags).toEqual(['后端', 'PG', 'demo']);
  expect(saved).toHaveBeenCalledOnce();
  await render(
    <ItemEditor
      key="edit"
      item={item('credential')}
      pillar="credential"
      unlocked
      onDraft={vi.fn()}
      projects={[]}
      onClose={vi.fn()}
      onSaved={saved}
    />,
  );
  expect(host.querySelector('select')?.disabled).toBe(true);
});

test('repository canvas opens on README rather than release notes', async () => {
  const value = {
    ...item(),
    kind: 'repo' as const,
    data: { readme: '# Hello repo', latestRelease: 'v9', releaseNotes: 'breaking changelog' },
  };
  await render(<RepoView item={value} onSaved={vi.fn()} onDirty={vi.fn()} notify={vi.fn()} />);
  expect(button('README').className).toContain('active');
  expect(host.querySelector('.markdown h1')?.textContent).toBe('Hello repo');
  expect(host.textContent).not.toContain('breaking changelog');
});

test('repository notes preview and workspace path save together', async () => {
  const value = {
    ...item(),
    id: 'repo',
    kind: 'repo' as const,
    category: 'Rust',
    data: { localWorkspacePath: 'D:/work', cookbookNotes: 'initial' },
  };
  const saved = vi.fn();
  mocks.saveItem.mockResolvedValue({ ...value, revision: 2 });
  await render(<RepoView item={value} onSaved={saved} onDirty={vi.fn()} notify={vi.fn()} />);
  await fill(input('本地工作区路径'), 'D:/work/中文 path');
  await click('实践笔记');
  await fill(input('实践笔记'), '# Saved notes');
  await click('预览');
  expect(host.querySelector('.markdown h1')?.textContent).toBe('Saved notes');
  await click('保存工作区与笔记');
  expect(mocks.saveItem.mock.lastCall![0].data.localWorkspacePath).toBe('D:/work/中文 path');
  expect(mocks.saveItem.mock.lastCall![0].data.cookbookNotes).toBe('# Saved notes');
  expect(saved).toHaveBeenCalledOnce();
});

test('a failed save keeps the draft and exposes the actual error for retry', async () => {
  mocks.saveItem.mockRejectedValue(new Error('条目已在其他窗口修改'));
  await render(<KnowledgeView item={item()} onSaved={vi.fn()} onDirty={vi.fn()} />);
  await click('Markdown');
  await fill(input('Markdown 正文'), 'retain this');
  await click('保存修改');
  expect(input('Markdown 正文').value).toBe('retain this');
  expect(button('保存修改').disabled).toBe(false);
  expect(host.querySelector('[role=alert]')?.textContent).toContain('其他窗口修改');
});

test('J/K navigation selects assets while modified shortcuts are left to the system', async () => {
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true }),
    ),
  );
  expect(host.querySelector('.list-item[aria-pressed=true]')).toBeNull();
  await act(async () =>
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })),
  );
  expect(host.querySelector('.list-item[aria-pressed=true]')).not.toBeNull();
});

test('15 minutes of inactivity asks before dropping a credential draft', async () => {
  vi.useFakeTimers();
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  await click('知识与文章1');
  await click('新建资产');
  await fill(host.querySelector<HTMLSelectElement>('dialog select')!, 'credential');
  await fill(input('资产名称'), 'private draft');
  await act(async () => vi.advanceTimersByTime(15 * 60 * 1000));
  expect(window.confirm).toHaveBeenCalled();
  expect(host.querySelector('dialog')).not.toBeNull();
  expect(input('资产名称').value).toBe('private draft');
  expect(mocks.api).not.toHaveBeenCalledWith('/vault/lock', { method: 'POST' });
  expect(unload()).toBe(true);
});

test('attachment controls upload multipart data, download the stored name and confirm deletion', async () => {
  const file = { id: 'file-id', name: '接口说明.txt', mime: 'text/plain', size: 4 };
  mocks.api.mockResolvedValueOnce([]).mockResolvedValueOnce(file).mockResolvedValue(undefined);
  mocks.request.mockResolvedValue({ blob: async () => new Blob(['data']) });
  await render(<Attachments id="article-id" />);
  const upload = host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(upload, 'files', {
    value: [new File(['data'], file.name, { type: 'text/plain' })],
    configurable: true,
  });
  await act(async () => upload.dispatchEvent(new Event('change', { bubbles: true })));
  expect(mocks.api.mock.calls[1][0]).toBe('/items/article-id/attachments');
  expect(mocks.api.mock.calls[1][1].body.get('file').name).toBe(file.name);
  await click('下载 ' + file.name);
  expect(mocks.request).toHaveBeenCalledWith('/attachments/file-id');
  expect(mocks.downloadBlob.mock.lastCall![1]).toBe(file.name);
  await click('删除 ' + file.name);
  expect(mocks.api).toHaveBeenCalledTimes(2);
  vi.mocked(window.confirm).mockReturnValue(true);
  await click('删除 ' + file.name);
  expect(mocks.api).toHaveBeenLastCalledWith('/attachments/file-id', { method: 'DELETE' });
  expect(host.querySelector('.file-row')).toBeNull();
});

test('ingestion sends selected type, project and tags and cannot close during collection', async () => {
  const pending = deferred<unknown>();
  const saved = vi.fn(),
    close = vi.fn();
  mocks.api.mockReturnValue(pending.promise);
  await render(
    <IngestModal
      initialUrl="https://example.com/article"
      onDraft={vi.fn()}
      onClose={close}
      onSaved={saved}
    />,
  );
  await fill(host.querySelector('select')!, 'knowledge');
  await fill(input('所属项目'), '验收项目');
  await fill(input('标签'), 'Rust，PG');
  await submit();
  expect(JSON.parse(mocks.api.mock.lastCall![1].body)).toEqual({
    url: 'https://example.com/article',
    kind: 'knowledge',
    project: '验收项目',
    tags: ['Rust', 'PG'],
  });
  expect(button('取消').disabled).toBe(true);
  await click('关闭对话框');
  expect(close).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ item: item(), warnings: ['一张图片未保存'] }));
  expect(saved).toHaveBeenCalledWith(item(), ['一张图片未保存']);
});

test('Ctrl+F selects global search and pasting a URL opens the ingestion form', async () => {
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  await act(async () =>
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }),
    ),
  );
  expect(host.querySelector<HTMLInputElement>('.search-scope input')?.checked).toBe(true);
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'https://example.com/pasted' } });
  await act(async () => document.body.dispatchEvent(paste));
  expect(input('目标 URL').value).toBe('https://example.com/pasted');
});

test('Markdown export contains the current draft and preview uses the same content', async () => {
  await render(<KnowledgeView item={item()} onSaved={vi.fn()} onDirty={vi.fn()} />);
  await click('Markdown');
  await fill(input('Markdown 正文'), '# Exported draft');
  await click('导出');
  expect(mocks.exportText).toHaveBeenCalledWith('# Exported draft', '验收文章.md');
  await click('流畅精读');
  expect(host.querySelector('.markdown h1')?.textContent).toBe('Exported draft');
});

test('workspace launch errors are visible and never report a false successful launch', async () => {
  mocks.desktopAction.mockRejectedValue(new Error('打开终端和文件夹需要 InfoHub 桌面版'));
  const value = { ...item(), kind: 'repo' as const, data: { localWorkspacePath: 'D:/work' } };
  await render(<RepoView item={value} onSaved={vi.fn()} onDirty={vi.fn()} notify={vi.fn()} />);
  await click('启动终端');
  expect(mocks.desktopAction).toHaveBeenCalledWith('terminal', 'D:/work');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('需要 InfoHub 桌面版');
});

test('changing a route creates editable path parameters and sends through the endpoint server', async () => {
  await render(
    <ApiWorkbench item={item('credential')} onSaved={vi.fn()} onDirty={vi.fn()} notify={vi.fn()} />,
  );
  await fill(input('接口路径'), '/orders/{orderId}');
  await fill(input('当前接口服务地址（留空使用基础地址）'), 'https://orders.example/v2?key=fixed');
  await click('发送请求');
  expect(host.textContent).toContain('请填写路径参数 {orderId}');
  expect(mocks.api).not.toHaveBeenCalledWith('/probe', expect.anything());
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('.parameter-tabs button')]
      .find((b) => b.textContent?.startsWith('Params'))!
      .click(),
  );
  const parameter = [...host.querySelectorAll<HTMLInputElement>('input')].find((i) => i.value === 'orderId')!;
  expect(parameter).toBeTruthy();
  await fill(input('Path 参数值 1'), '订单/a&b');
  mocks.api.mockResolvedValue({ status: 200, body: 'ok', headers: {}, size: 2, durationMs: 1 });
  await click('发送请求');
  const sent = JSON.parse(mocks.api.mock.lastCall![1].body);
  expect(sent.url).toBe('https://orders.example/v2/orders/%E8%AE%A2%E5%8D%95%2Fa%26b?key=fixed');
});

test('switching credential protocols and asset kinds retains the form draft', async () => {
  await render(
    <ItemEditor
      pillar="credential"
      unlocked
      projects={[]}
      onDraft={vi.fn()}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  await fill(input('协议 / 类型'), 'postgresql');
  await fill(input('Host / IP'), 'db.example');
  await fill(input('端口'), '55432');
  await fill(input('协议 / 类型'), 'mysql');
  expect(input('Host / IP').value).toBe('db.example');
  expect(input('端口').value).toBe('3306');
  await fill(input('协议 / 类型'), 'postgresql');
  expect(input('端口').value).toBe('55432');
  await fill(input('资产类型'), 'knowledge');
  await fill(input('Markdown 正文'), '保留文章草稿');
  await fill(input('资产类型'), 'credential');
  expect(input('Host / IP').value).toBe('db.example');
  await fill(input('资产类型'), 'knowledge');
  expect(input('Markdown 正文').value).toBe('保留文章草稿');
});

test('vault locking closes an OpenAPI collection draft and rechecks the list with locked search scope', async () => {
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  await click('收录抓取');
  await fill(input('内容类型'), 'credential');
  await fill(input('目标 URL'), 'https://example.com/private/openapi.json');
  const listsBefore = mocks.api.mock.calls.filter(([path]) => path.startsWith('/items?')).length;
  await act(async () => window.dispatchEvent(new Event('infohub:locked')));
  expect(host.querySelector('dialog')).toBeNull();
  expect(mocks.api.mock.calls.filter(([path]) => path.startsWith('/items?')).length).toBeGreaterThan(
    listsBefore,
  );
});

test('favoriting an article preserves its unsaved text and advances the next save revision', async () => {
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  await click('知识与文章1');
  await act(async () => host.querySelector<HTMLButtonElement>('.list-item')!.click());
  await click('Markdown');
  await fill(input('Markdown 正文'), '正文草稿还没有保存');
  mocks.saveItem.mockResolvedValueOnce({ ...item(), favorite: true, revision: 2 });
  await click('收藏');
  expect(window.confirm).not.toHaveBeenCalled();
  expect(input('Markdown 正文').value).toBe('正文草稿还没有保存');
  expect(unload()).toBe(true);
  mocks.saveItem.mockResolvedValueOnce({
    ...item(),
    favorite: true,
    revision: 3,
    data: { content: '正文草稿还没有保存' },
  });
  await click('保存修改');
  expect(mocks.saveItem.mock.lastCall![0].revision).toBe(2);
  expect(mocks.saveItem.mock.lastCall![0].favorite).toBe(true);
  expect(mocks.saveItem.mock.lastCall![0].data.content).toBe('正文草稿还没有保存');
});

test('locked vault cannot start OpenAPI ingest without unlock', async () => {
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  await act(async () => window.dispatchEvent(new Event('infohub:locked')));
  await click('收录抓取');
  expect(host.querySelector<HTMLOptionElement>('option[value="credential"]')?.disabled).toBe(true);
  await fill(input('内容类型'), 'credential');
  await fill(input('目标 URL'), 'https://example.com/openapi.json');
  const ingestCalls = () => mocks.api.mock.calls.filter(([path]) => path === '/ingest').length;
  const before = ingestCalls();
  await submit();
  expect(ingestCalls()).toBe(before);
  expect(host.querySelector('[role=alert]')?.textContent).toContain('金库已锁定');
});

test('session expiry with a dirty article draft does not drop the text without confirm', async () => {
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  await click('知识与文章1');
  await act(async () => host.querySelector<HTMLButtonElement>('.list-item')!.click());
  await click('Markdown');
  await fill(input('Markdown 正文'), 'keep this draft');
  await act(async () => window.dispatchEvent(new Event('infohub:unauthorized')));
  expect(window.confirm).toHaveBeenCalled();
  expect(input('Markdown 正文').value).toBe('keep this draft');
  expect(host.querySelector('h2')?.textContent).not.toBe('回到你的工作台');
});

test('a failed vault lock keeps the current session', async () => {
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  const fallback = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/vault/lock') throw new Error('锁定失败');
    return fallback(path, options);
  });
  await click('金库已解锁');
  expect(host.textContent).toContain('锁定失败');
  expect(host.querySelector('.toast')?.getAttribute('role')).toBe('alert');
  expect(host.querySelector('.toast-error')).not.toBeNull();
  expect(host.querySelector('[aria-label="金库已解锁"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="收录抓取"]')).not.toBeNull();
  expect(host.textContent).not.toContain('回到你的工作台');
});

test('a failed list reload does not keep the previous filter rows', async () => {
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  expect(host.querySelector('.list-item')).not.toBeNull();
  const fallback = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path.startsWith('/items?') && path.includes('q=')) throw new Error('列表失败');
    return fallback(path, options);
  });
  await fill(input('检索资产'), 'no-such-item');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(host.querySelector('[role=alert], .list-error')?.textContent).toContain('列表失败');
  expect(host.querySelector('.list-item')).toBeNull();
});

test('re-clicking the selected item after a detail error refetches', async () => {
  let details = 0;
  const fallback = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/items/knowledge') {
      details += 1;
      if (details === 1) throw new Error('详情失败');
      return item();
    }
    return fallback(path, options);
  });
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  await click('知识与文章1');
  await act(async () => host.querySelector<HTMLButtonElement>('.list-item')!.click());
  expect(host.querySelector('[role=alert]')?.textContent).toContain('详情失败');
  await act(async () => host.querySelector<HTMLButtonElement>('.list-item')!.click());
  expect(details).toBe(2);
  expect(host.querySelector('h1')?.textContent).toBe('验收文章');
});

test('two overlapping probes on the same endpoint keep only the later response', async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  let calls = 0;
  mocks.api.mockImplementation(() => (++calls === 1 ? first.promise : second.promise));
  await render(
    <ApiWorkbench item={item('credential')} onSaved={vi.fn()} onDirty={vi.fn()} notify={vi.fn()} />,
  );
  const send = () => host.querySelector<HTMLButtonElement>('.send-probe')!;
  await act(async () => {
    send().click();
    send().click();
  });
  await act(async () =>
    second.resolve({ status: 200, body: 'later-body', headers: {}, size: 11, durationMs: 1 }),
  );
  await act(async () =>
    first.resolve({ status: 200, body: 'stale-body', headers: {}, size: 10, durationMs: 4 }),
  );
  expect(host.textContent).toContain('later-body');
  expect(host.textContent).not.toContain('stale-body');
});

test('attachment upload started on one item does not appear after switching items', async () => {
  const pending = deferred<{ id: string; name: string; mime: string; size: number }>();
  mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path.endsWith('/attachments') && options?.method === 'POST') return pending.promise;
    if (path.endsWith('/attachments')) return [];
    return [];
  });
  await render(<Attachments id="article-id" />);
  const upload = host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(upload, 'files', {
    value: [new File(['data'], '接口说明.txt', { type: 'text/plain' })],
    configurable: true,
  });
  await act(async () => upload.dispatchEvent(new Event('change', { bubbles: true })));
  const post = mocks.api.mock.calls.find(([path, options]) => path === '/items/article-id/attachments' && options?.method === 'POST');
  expect(post).toBeTruthy();
  await render(<Attachments id="other-id" />);
  expect(post![1].signal.aborted).toBe(true);
  await act(async () => pending.resolve({ id: 'file-id', name: '接口说明.txt', mime: 'text/plain', size: 4 }));
  expect(host.querySelector('.file-row')).toBeNull();
});

test('saving an existing item title does not reset favorite search or category', async () => {
  mocks.saveItem.mockResolvedValue({ ...item(), title: '改过的标题', revision: 2 });
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  await click('知识与文章1');
  await click('个人笔记');
  await click('加星收藏');
  await act(async () => host.querySelector<HTMLButtonElement>('.list-item')!.click());
  await click('编辑属性');
  await fill(input('文章标题'), '改过的标题');
  await submit();
  expect(
    [...host.querySelectorAll('.dimension-item.active')].some((el) =>
      el.textContent?.includes('加星收藏'),
    ),
  ).toBe(true);
  expect(host.querySelector('.list-filter .selected')?.textContent).toContain('个人笔记');
});

test('archived media URLs must be a media UUID and cannot traverse to other APIs', async () => {
  expect(archivedMediaPath('/api/media/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(
    '/media/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  );
  expect(archivedMediaPath('/api/media/../items/knowledge')).toBe('');
  expect(archivedMediaPath('/api/media/not-a-uuid')).toBe('');
  mocks.request.mockResolvedValue({ blob: async () => new Blob(['x']) });
  await render(<Markdown text={'![](/api/media/../items/knowledge)'} />);
  expect(mocks.request).not.toHaveBeenCalled();
});

test('a failed refresh uses an error toast instead of the success style', async () => {
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  await click('知识与文章1');
  await act(async () => host.querySelector<HTMLButtonElement>('.list-item')!.click());
  const fallback = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (typeof path === 'string' && path.endsWith('/refresh')) throw new Error('同步失败');
    return fallback(path, options);
  });
  await click('重新同步');
  const toast = host.querySelector('.toast');
  expect(toast?.textContent).toContain('同步失败');
  expect(toast?.getAttribute('role')).toBe('alert');
  expect(toast?.className).toContain('toast-error');
  expect(toast?.querySelector('svg.lucide-circle-alert, .toast-error svg')).not.toBeNull();
});

test('switching asset kind does not keep the previous filter rows', async () => {
  const pending = deferred<{
    items: Item[];
    total: number;
    unlocked: boolean;
    dimensions: { kind: string; category: string; project: string; count: number }[];
  }>();
  let knowledgeLists = 0;
  const fallback = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path.startsWith('/items?') && path.includes('kind=knowledge')) {
      knowledgeLists += 1;
      if (knowledgeLists === 1) return pending.promise;
    }
    return fallback(path, options);
  });
  await render(<App />);
  await fill(input('主密码'), 'test-password');
  await submit();
  expect(host.textContent).toContain('验收接口');
  await click('知识与文章1');
  expect(host.querySelector('.list-item')).toBeNull();
  expect(host.textContent).not.toContain('验收接口');
  await act(async () =>
    pending.resolve({
      items: [item()],
      total: 1,
      unlocked: true,
      dimensions: [
        { kind: 'knowledge', category: 'note', project: '测试项目', count: 1 },
        { kind: 'credential', category: 'http', project: '测试项目', count: 1 },
      ],
    }),
  );
  expect(host.textContent).toContain('验收文章');
  expect(host.textContent).not.toContain('验收接口');
});

test('switching REST to PostgreSQL isolates OpenAPI drafts and restores them on return', async () => {
  const restItem: Item = {
    ...item('credential'),
    title: '验收接口',
    data: {
      typeKey: 'rest_api',
      fields: { baseUrl: 'https://api.example', swaggerUrl: 'https://api.example/openapi.json' },
      importSpec: '{"openapi":"3.0.3","info":{"title":"T"}}',
      swaggerEndpoints: [{ ...emptyEndpoint(), path: '/kept' }],
      globalHeaders: [{ key: 'X-Token', value: 'abc', enabled: true }],
    },
  };
  mocks.saveItem.mockResolvedValue(restItem);
  await render(
    <ItemEditor
      item={restItem}
      pillar="credential"
      unlocked
      onDraft={vi.fn()}
      projects={[]}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(input('OpenAPI 规范').value).toContain('openapi');
  await fill(input('协议 / 类型'), 'postgresql');
  expect(host.querySelector('[aria-label="OpenAPI 规范"]')).toBeNull();
  await submit();
  const postgres = mocks.saveItem.mock.lastCall![0];
  expect(postgres.data.typeKey).toBe('postgresql');
  expect(postgres.data.swaggerEndpoints).toBeUndefined();
  expect(postgres.data.globalHeaders).toBeUndefined();
  expect(postgres.data.importSpec).toBeUndefined();
  await fill(input('协议 / 类型'), 'rest_api');
  expect(input('OpenAPI 规范').value).toContain('openapi');
  await submit();
  const restored = mocks.saveItem.mock.lastCall![0];
  expect(restored.data.importSpec).toContain('openapi');
  expect(restored.data.swaggerEndpoints[0].path).toBe('/kept');
  expect(restored.data.globalHeaders[0].key).toBe('X-Token');
});

test('dirty API parameters stay saveable on the attachments tab', async () => {
  mocks.saveItem.mockResolvedValue(item('credential'));
  await render(
    <ApiWorkbench item={item('credential')} onSaved={vi.fn()} onDirty={vi.fn()} notify={vi.fn()} />,
  );
  await fill(input('接口路径'), '/updated');
  await click('附件与白皮书');
  expect(button('保存参数').disabled).toBe(false);
  await click('保存参数');
  expect(mocks.saveItem.mock.lastCall![0].data.swaggerEndpoints[0].path).toBe('/updated');
});

test('markdown fragment links stay in-page', async () => {
  await render(<Markdown text="See [Install](#install) then [docs](https://example.com/guide)" />);
  const [fragment, external] = [...host.querySelectorAll('a')];
  expect(fragment.getAttribute('href')).toBe('#install');
  expect(fragment.getAttribute('target')).toBeNull();
  expect(external.getAttribute('href')).toBe('https://example.com/guide');
  expect(external.getAttribute('target')).toBe('_blank');
});

test('article body can be saved from the reading view and stores the chosen mode', async () => {
  mocks.saveItem.mockResolvedValue({ ...item(), revision: 2, data: { content: 'from reading', readerMode: 'flow' } });
  await render(<KnowledgeView item={item()} onSaved={vi.fn()} onDirty={vi.fn()} />);
  await click('Markdown');
  await fill(input('Markdown 正文'), 'from reading');
  await click('流畅精读');
  expect(host.querySelector('.markdown')).not.toBeNull();
  await click('保存修改');
  expect(mocks.saveItem.mock.lastCall![0].data.content).toBe('from reading');
  expect(mocks.saveItem.mock.lastCall![0].data.readerMode).toBe('flow');
});

test('stored reading mode is restored when the article is shown again', async () => {
  await render(
    <KnowledgeView
      item={{ ...item(), data: { content: '# Stored', readerMode: 'markdown' } }}
      onSaved={vi.fn()}
      onDirty={vi.fn()}
    />,
  );
  expect(input('Markdown 正文').value).toBe('# Stored');
  expect(button('Markdown').className).toContain('active');
});
