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

import { dedupe, htmlToMarkdown, parseCsv, parseImport, splitPostmanUrl } from '../src/lib/importers';

test('CSV parser handles quotes, commas and newlines', () => {
  expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\r\n')).toEqual([
    ['a', 'b'],
    ['x, y', 'say "hi"\nthere'],
  ]);
});

test('browser bookmarks and Pocket exports become articles; folders become tags', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>书签栏</H3><DL><p><DT><H3>Rust</H3><DL><p>
    <DT><A HREF="https://tokio.rs/?utm_source=x#top" ADD_DATE="1">Tokio</A>
    <DT><A HREF="javascript:alert(1)">bad</A></DL></DL>
    <DT><A HREF="https://example.com/" TAGS="a,b">Ex</A></DL>`;
  const result = parseImport('bookmarks.html', html);
  expect(result.format).toBe('bookmarks');
  expect(result.candidates.map((c) => [c.item.title, c.item.url, c.item.tags])).toEqual([
    ['Tokio', 'https://tokio.rs/', ['Rust']],
    ['Ex', 'https://example.com/', ['a', 'b']],
  ]);
  expect(result.candidates[0].linkOnly).toBe(true);
  const csv = parseImport(
    'pocket.csv',
    'title,url,time_added,tags,status\nHello,https://a.example/p,1,x|y,unread\n',
  );
  expect(csv.format).toBe('pocket');
  expect(csv.candidates[0].item.tags).toEqual(['x', 'y']);
});

test('Omnivore and Wallabag JSON keep bodies; HTML is converted, never kept raw', () => {
  const omnivore = parseImport(
    'omnivore.json',
    JSON.stringify([
      {
        title: 'O',
        url: 'https://o.example/1',
        labels: [{ name: 'L' }],
        description: 'd',
        content: '# Body',
      },
    ]),
  );
  expect(omnivore.format).toBe('omnivore');
  expect(omnivore.candidates[0].item).toMatchObject({
    tags: ['L'],
    summary: 'd',
    data: { content: '# Body' },
  });
  const wallabag = parseImport(
    'wallabag.json',
    JSON.stringify([
      {
        is_archived: 0,
        title: 'W',
        url: 'https://w.example/',
        tags: ['t'],
        content:
          '<h2>标题</h2><p>正文 <a href="https://x.example">链接</a><script>alert(1)</script><img src="javascript:x" onerror="x"></p>',
      },
    ]),
  );
  expect(wallabag.format).toBe('wallabag');
  expect(wallabag.candidates[0].item.data.content).toBe('## 标题\n\n正文 [链接](https://x.example/)');
  expect(htmlToMarkdown('<pre><code>a < b</code></pre>')).toBe('```\na < b\n```');
});

test('Bitwarden and 1Password exports become encrypted-vault account items', () => {
  const bw = parseImport(
    'bitwarden.json',
    JSON.stringify({
      encrypted: false,
      folders: [],
      items: [
        {
          type: 1,
          name: 'GitHub',
          notes: 'n',
          login: {
            username: 'me',
            password: 'pw',
            totp: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
            uris: [{ uri: 'https://github.com/login' }],
          },
          fields: [{ name: 'PIN', value: '1234' }],
        },
        { type: 2, name: 'secure note' },
      ],
    }),
  );
  expect(bw.format).toBe('bitwarden');
  expect(bw.candidates).toHaveLength(1);
  expect(bw.candidates[0].key).toBe('vault|github|github.com|me');
  expect(bw.candidates[0].item).toMatchObject({
    kind: 'credential',
    category: 'account',
    url: '',
    data: {
      typeKey: 'account',
      fields: {
        username: 'me',
        password: 'pw',
        PIN: '1234',
        totp: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
      },
    },
  });
  expect(() => parseImport('bw.json', JSON.stringify({ encrypted: true, items: [] }))).toThrow(/未加密/);
  const bwCsv = parseImport(
    'bw.csv',
    'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Mail,,,,https://mail.example,u,p,\n',
  );
  expect(bwCsv.candidates[0].item.data.fields).toMatchObject({ url: 'https://mail.example', password: 'p' });
  const op = parseImport(
    '1password.csv',
    'Title,Url,Username,Password,OTPAuth,Notes\nAWS,aws.amazon.com,root,s3cret,,备注\n',
  );
  expect(op.format).toBe('onepassword');
  expect(op.candidates[0].key).toBe('vault|aws|aws.amazon.com|root');
});

test('Postman v2.1 collections become an API workbench item', () => {
  const collection = {
    info: {
      name: 'Shop API',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
    variable: [
      { key: 'baseUrl', value: 'https://api.shop.example' },
      { key: 'token', value: 'abc' },
    ],
    item: [
      {
        name: 'Users',
        item: [
          {
            name: 'Get user',
            request: {
              method: 'GET',
              url: { raw: '{{baseUrl}}/users/:id?expand=1', query: [{ key: 'expand', value: '1' }] },
            },
          },
          {
            name: 'Create',
            request: {
              method: 'POST',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: { mode: 'raw', raw: '{"a":1}' },
              url: '{{baseUrl}}/users',
            },
          },
        ],
      },
      { name: 'Health', request: { method: 'GET', url: 'https://status.example/health' } },
    ],
  };
  const result = parseImport('shop.postman_collection.json', JSON.stringify(collection));
  expect(result.format).toBe('postman');
  const item = result.candidates[0].item;
  expect(item).toMatchObject({ kind: 'credential', category: 'http', title: 'Shop API' });
  expect(item.data.fields!.baseUrl).toBe('{{baseUrl}}');
  expect(item.data.globalHeaders).toEqual([
    { key: 'Authorization', value: 'Bearer {{token}}', enabled: true },
  ]);
  expect(item.data.environments![0].variables.map((v) => v.key)).toEqual(['baseUrl', 'token']);
  const [get, create, health] = item.data.swaggerEndpoints!;
  expect(get).toMatchObject({
    method: 'GET',
    path: '/users/{id}',
    tag: 'Users',
    pathParams: [{ key: 'id' }],
    queryParams: [{ key: 'expand', value: '1' }],
  });
  expect(create).toMatchObject({ method: 'POST', requestBody: '{"a":1}' });
  expect(health.baseUrl).toBe('https://status.example');
  expect(splitPostmanUrl('https://h.example:8080/a/:b?c=d%20e')).toEqual({
    base: 'https://h.example:8080',
    path: '/a/{b}',
    query: [{ key: 'c', value: 'd e', enabled: true }],
  });
});

test('dedupe marks existing items and repeats within the file', () => {
  const { candidates } = parseImport(
    'b.html',
    '<DL><DT><A HREF="https://a.example/">A</A><DT><A HREF="https://a.example/#x">A again</A><DT><A HREF="https://b.example/">B</A></DL>',
  );
  expect(dedupe(candidates, new Set(['url:https://b.example/'])).map((r) => r.duplicate)).toEqual([
    '',
    'file',
    'existing',
  ]);
  expect(() => parseImport('x.txt', 'hello')).toThrow(/无法识别/);
});
