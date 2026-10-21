import type { Endpoint, ItemInput, Pair } from '../types';

/** One record that an import file would create. */
export interface ImportCandidate {
  item: ItemInput;
  /** Dedupe key: normalized URL for articles, title+url(+username) for vault items. */
  key: string;
  /** Article without a body: can be queued for full-text collection instead. */
  linkOnly?: boolean;
}
export interface ImportResult {
  format: ImportFormat;
  candidates: ImportCandidate[];
  warnings: string[];
}
export type ImportFormat =
  'pocket' | 'omnivore' | 'wallabag' | 'bookmarks' | 'bitwarden' | 'onepassword' | 'postman';
export const formatNames: Record<ImportFormat, string> = {
  pocket: 'Pocket 导出',
  omnivore: 'Omnivore 导出',
  wallabag: 'Wallabag 导出',
  bookmarks: '浏览器书签 (HTML)',
  bitwarden: 'Bitwarden 导出',
  onepassword: '1Password CSV',
  postman: 'Postman Collection v2.1',
};
export const vaultFormat = (format: ImportFormat) => ['bitwarden', 'onepassword', 'postman'].includes(format);

/** RFC 4180 CSV (quoted fields, embedded newlines, doubled quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  return rows;
}
function records(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return rows.map((row) => Object.fromEntries(keys.map((k, i) => [k, (row[i] ?? '').trim()])));
}
const pick = (row: Record<string, string>, ...names: string[]) =>
  names.map((n) => row[n]).find((v) => v !== undefined && v !== '') ?? '';

export function normalizeUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return '';
  }
}
const cleanTags = (tags: string[]) =>
  [...new Set(tags.map((t) => t.trim()).filter((t) => t && t.length <= 100))].slice(0, 50);
function article(
  title: string,
  url: string,
  tags: string[],
  extra: { content?: string; summary?: string; author?: string; source: string; project?: string },
): ImportCandidate | null {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  const content = extra.content?.trim() || '';
  return {
    key: 'url:' + normalized,
    linkOnly: !content,
    item: {
      kind: 'knowledge',
      title: (title.trim() || normalized).slice(0, 500),
      category: 'blog',
      project: extra.project || '',
      tags: cleanTags(tags),
      summary: (extra.summary || '').slice(0, 2000),
      url: normalized,
      favorite: false,
      data: { content, author: extra.author || '', sourceName: extra.source },
    },
  };
}

/** Minimal HTML → Markdown for imported article bodies (Wallabag). Raw HTML is never kept. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').replace(/\s+/g, ' ');
    if (!(node instanceof Element)) return '';
    const inner = () => [...node.childNodes].map(walk).join('');
    switch (node.tagName) {
      case 'SCRIPT':
      case 'STYLE':
        return '';
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
        return `\n\n${'#'.repeat(Number(node.tagName[1]))} ${inner().trim()}\n\n`;
      case 'P':
      case 'DIV':
      case 'SECTION':
      case 'ARTICLE':
        return `\n\n${inner().trim()}\n\n`;
      case 'BR':
        return '\n';
      case 'LI':
        return `\n- ${inner().trim()}`;
      case 'STRONG':
      case 'B':
        return `**${inner()}**`;
      case 'EM':
      case 'I':
        return `*${inner()}*`;
      case 'CODE':
        return node.parentElement?.tagName === 'PRE' ? inner() : '`' + inner() + '`';
      case 'PRE':
        return '\n\n```\n' + (node.textContent || '').trim() + '\n```\n\n';
      case 'BLOCKQUOTE':
        return '\n\n> ' + inner().trim().replace(/\n/g, '\n> ') + '\n\n';
      case 'A': {
        const href = normalizeUrl(node.getAttribute('href') || '');
        return href ? `[${inner().trim()}](${href})` : inner();
      }
      case 'IMG': {
        const src = normalizeUrl(node.getAttribute('src') || '');
        return src ? `![${node.getAttribute('alt') || ''}](${src})` : '';
      }
      default:
        return inner();
    }
  };
  return walk(doc.body)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Netscape bookmark HTML (browsers, Pocket's legacy export). Folders become tags. */
function parseBookmarks(text: string, source: string, folderTags: boolean): ImportCandidate[] {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const out: ImportCandidate[] = [];
  for (const link of doc.querySelectorAll('a[href]')) {
    const folders: string[] = [];
    for (let dl = link.closest('dl'); dl; dl = dl.parentElement?.closest('dl') ?? null) {
      const heading = dl.previousElementSibling?.matches('h3, dt')
        ? dl.previousElementSibling.querySelector('h3') || dl.previousElementSibling
        : null;
      if (heading?.tagName === 'H3' && heading.textContent?.trim())
        folders.unshift(heading.textContent.trim());
    }
    const tags = (link.getAttribute('tags') || '').split(',');
    if (folderTags)
      tags.push(
        ...folders.filter((f) => !/^(书签栏|bookmarks bar|bookmarks toolbar|other bookmarks)$/i.test(f)),
      );
    const candidate = article(link.textContent || '', link.getAttribute('href') || '', tags, { source });
    if (candidate) out.push(candidate);
  }
  return out;
}

function bitwardenItems(json: {
  encrypted?: boolean;
  items?: {
    type?: number;
    name?: string;
    notes?: string | null;
    login?: { username?: string; password?: string; totp?: string; uris?: { uri?: string }[] };
    fields?: { name?: string; value?: string }[];
  }[];
}): ImportCandidate[] {
  if (json.encrypted)
    throw new Error('这是加密的 Bitwarden 导出，请在 Bitwarden 中选择“.json（未加密）”或 .csv 重新导出');
  return (json.items || [])
    .filter((entry) => entry.type === 1 || entry.login)
    .map((entry) =>
      vaultAccount({
        title: entry.name || '',
        url: entry.login?.uris?.[0]?.uri || '',
        username: entry.login?.username || '',
        password: entry.login?.password || '',
        totp: entry.login?.totp || '',
        notes: entry.notes || '',
        extra: Object.fromEntries(
          (entry.fields || []).filter((f) => f.name).map((f) => [f.name!, f.value || '']),
        ),
        source: 'Bitwarden',
      }),
    );
}
function vaultAccount(input: {
  title: string;
  url: string;
  username: string;
  password: string;
  totp: string;
  notes: string;
  extra?: Record<string, string>;
  source: string;
}): ImportCandidate {
  const fields: Record<string, string> = {
    url: input.url,
    username: input.username,
    password: input.password,
    notes: input.notes,
  };
  if (input.totp) fields.totp = input.totp;
  for (const [key, value] of Object.entries(input.extra || {}).slice(0, 80))
    if (!Object.hasOwn(fields, key)) fields[key] = value;
  const title = (input.title.trim() || hostOf(input.url) || input.username || '未命名账号').slice(0, 500);
  return {
    key: ['vault', title.toLowerCase(), hostOf(input.url), input.username.toLowerCase()].join('|'),
    item: {
      kind: 'credential',
      title,
      category: 'account',
      project: '',
      tags: [],
      summary: '',
      url: '',
      favorite: false,
      data: { typeKey: 'account', fields, description: `从 ${input.source} 导入` },
    },
  };
}
export function hostOf(url: string) {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : 'https://' + url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

interface PostmanItem {
  name?: string;
  item?: PostmanItem[];
  request?: {
    method?: string;
    url?: string | { raw?: string; query?: { key?: string; value?: string; disabled?: boolean }[] };
    header?: { key?: string; value?: string; disabled?: boolean }[];
    body?: { mode?: string; raw?: string };
    description?: string;
    auth?: PostmanAuth;
  };
}
interface PostmanAuth {
  type?: string;
  bearer?: { key: string; value: string }[];
  apikey?: { key: string; value: string }[];
}
const authValue = (list: { key: string; value: string }[] | undefined, key: string) =>
  list?.find((entry) => entry.key === key)?.value ?? '';
function authHeaders(auth: PostmanAuth | undefined): Pair[] {
  if (auth?.type === 'bearer')
    return [{ key: 'Authorization', value: 'Bearer ' + authValue(auth.bearer, 'token'), enabled: true }];
  if (auth?.type === 'apikey' && authValue(auth.apikey, 'in') !== 'query')
    return [
      {
        key: authValue(auth.apikey, 'key') || 'X-API-Key',
        value: authValue(auth.apikey, 'value'),
        enabled: true,
      },
    ];
  return [];
}
/** Split a Postman URL into base and path ("{{host}}/users/:id?x=1"). */
export function splitPostmanUrl(raw: string): { base: string; path: string; query: Pair[] } {
  const [withoutQuery, queryString = ''] = raw.trim().split(/\?(.*)/s);
  const match = withoutQuery.match(/^(\{\{[^}]+\}\}|[a-z][a-z0-9+.-]*:\/\/[^/]+)(.*)$/i);
  const base = match ? match[1] : '';
  let path = match ? match[2] : withoutQuery;
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, '/{$1}');
  const query = queryString
    ? queryString
        .split('&')
        .filter(Boolean)
        .map((part) => {
          const [key, value = ''] = part.split(/=(.*)/s);
          return { key: decodeURIComponent(key), value: decodeURIComponent(value), enabled: true };
        })
    : [];
  return { base, path, query };
}
function parsePostman(json: {
  info?: { name?: string; schema?: string; description?: string };
  item?: PostmanItem[];
  variable?: { key?: string; value?: unknown }[];
  auth?: PostmanAuth;
}): ImportCandidate[] {
  const endpoints: (Endpoint & { _base: string })[] = [];
  const visit = (items: PostmanItem[], folder: string) => {
    for (const entry of items) {
      if (entry.item) visit(entry.item, entry.name || folder);
      else if (entry.request && endpoints.length < 2000) {
        const request = entry.request;
        const raw = typeof request.url === 'string' ? request.url : request.url?.raw || '';
        const { base, path, query } = splitPostmanUrl(raw);
        const method = (request.method || 'GET').toUpperCase();
        const fromObject =
          typeof request.url === 'object' && request.url.query
            ? request.url.query.map((q) => ({ key: q.key || '', value: q.value || '', enabled: !q.disabled }))
            : query;
        endpoints.push({
          _base: base,
          method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)
            ? method
            : 'GET',
          path,
          summary: entry.name || path,
          tag: folder,
          customHeaders: [
            ...(request.header || []).map((h) => ({
              key: h.key || '',
              value: h.value || '',
              enabled: !h.disabled,
            })),
            ...authHeaders(request.auth),
          ],
          queryParams: fromObject,
          pathParams: [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => ({
            key: m[1],
            value: '',
            enabled: true,
          })),
          requestBody: request.body?.mode === 'raw' ? request.body.raw || '' : '',
        });
      }
    }
  };
  visit(json.item || [], '');
  const counts = new Map<string, number>();
  for (const ep of endpoints) counts.set(ep._base, (counts.get(ep._base) || 0) + 1);
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const swaggerEndpoints: Endpoint[] = endpoints.map(({ _base, ...ep }) => {
    if (_base === main) return ep;
    if (/^https?:\/\//i.test(_base)) return { ...ep, baseUrl: _base };
    return {
      ...ep,
      requestWarning: `原 Postman 地址前缀 ${_base || '（空）'} 与集合主地址不同，请检查 Base URL`,
    };
  });
  const variables = (json.variable || [])
    .filter((v) => v.key)
    .map((v) => ({
      key: v.key!,
      value: typeof v.value === 'string' ? v.value : JSON.stringify(v.value ?? ''),
      enabled: true,
    }));
  const environmentId = 'postman';
  const title = (json.info?.name || 'Postman 集合').slice(0, 500);
  return [
    {
      key: 'api|' + title.toLowerCase(),
      item: {
        kind: 'credential',
        title,
        category: 'http',
        project: '',
        tags: ['postman'],
        summary: '',
        url: '',
        favorite: false,
        data: {
          typeKey: 'rest_api',
          fields: { baseUrl: main, swaggerUrl: '' },
          description: json.info?.description || '从 Postman 导入',
          globalHeaders: authHeaders(json.auth),
          swaggerEndpoints,
          environments: variables.length ? [{ id: environmentId, name: 'Postman 变量', variables }] : [],
          activeEnvironment: variables.length ? environmentId : undefined,
        },
      },
    },
  ];
}

/** Detect the format from the file name and content, then parse it. Pure client-side. */
export function parseImport(name: string, text: string): ImportResult {
  const lower = name.toLowerCase();
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  const warnings: string[] = [];
  const done = (format: ImportFormat, list: (ImportCandidate | null)[]): ImportResult => {
    const candidates = list.filter((c): c is ImportCandidate => !!c);
    if (!candidates.length) throw new Error(`${formatNames[format]}中没有可导入的条目`);
    return { format, candidates, warnings };
  };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new Error('JSON 格式无效');
    }
    const object = json as Record<string, unknown>;
    if (
      !Array.isArray(json) &&
      String((object.info as { schema?: string })?.schema || '').includes('collection/v2')
    ) {
      if (!String((object.info as { schema?: string }).schema).includes('v2.1'))
        warnings.push('按 v2.1 格式解析 v2.0 集合，部分字段可能缺失');
      return done('postman', parsePostman(object));
    }
    if (!Array.isArray(json) && Array.isArray(object.items) && ('encrypted' in object || 'folders' in object))
      return done('bitwarden', bitwardenItems(object));
    if (Array.isArray(json)) {
      const first = (json[0] || {}) as Record<string, unknown>;
      if (
        'is_archived' in first ||
        'reading_time' in first ||
        ('content' in first && 'tags' in first && !('labels' in first))
      )
        return done(
          'wallabag',
          json.map(
            (entry: {
              title?: string;
              url?: string;
              content?: string;
              tags?: (string | { label?: string })[];
            }) =>
              article(
                entry.title || '',
                entry.url || '',
                (entry.tags || []).map((t) => (typeof t === 'string' ? t : t.label || '')),
                {
                  content: entry.content ? htmlToMarkdown(entry.content) : '',
                  source: 'Wallabag',
                },
              ),
          ),
        );
      return done(
        'omnivore',
        json.map(
          (entry: {
            title?: string;
            url?: string;
            originalUrl?: string;
            description?: string;
            author?: string;
            labels?: (string | { name?: string })[];
            content?: string;
          }) =>
            article(
              entry.title || '',
              entry.url || entry.originalUrl || '',
              (entry.labels || []).map((l) => (typeof l === 'string' ? l : l.name || '')),
              {
                summary: entry.description,
                author: entry.author,
                content: entry.content,
                source: 'Omnivore',
              },
            ),
        ),
      );
    }
    throw new Error('无法识别的 JSON 导出：支持 Omnivore、Wallabag、Bitwarden（未加密）和 Postman v2.1');
  }
  if (/<!doctype netscape-bookmark-file|<dl|<a\s/i.test(trimmed.slice(0, 4000))) {
    const pocket = /pocket/i.test(lower) || /ril_export|<title>pocket export/i.test(trimmed.slice(0, 2000));
    return done(
      pocket ? 'pocket' : 'bookmarks',
      parseBookmarks(trimmed, pocket ? 'Pocket' : '浏览器书签', !pocket),
    );
  }
  const rows = records(trimmed);
  const header = Object.keys(rows[0] || {});
  if (header.includes('login_password') || header.includes('login_username'))
    return done(
      'bitwarden',
      rows
        .filter((r) => !r.type || r.type === 'login')
        .map((r) =>
          vaultAccount({
            title: r.name,
            url: r.login_uri?.split(/[\n,]/)[0] || '',
            username: r.login_username,
            password: r.login_password,
            totp: r.login_totp,
            notes: r.notes,
            source: 'Bitwarden',
          }),
        ),
    );
  if (header.includes('password') && header.some((h) => ['title', 'name'].includes(h)))
    return done(
      'onepassword',
      rows.map((r) =>
        vaultAccount({
          title: pick(r, 'title', 'name'),
          url: pick(r, 'url', 'website', 'login url', 'urls'),
          username: pick(r, 'username', 'user name', 'email'),
          password: r.password,
          totp: pick(r, 'otpauth', 'one-time password', 'totp'),
          notes: pick(r, 'notes', 'notesplain'),
          source: '1Password',
        }),
      ),
    );
  if (header.includes('url') && (header.includes('time_added') || header.includes('title')))
    return done(
      'pocket',
      rows.map((r) => article(r.title || '', r.url, (r.tags || '').split('|'), { source: 'Pocket' })),
    );
  throw new Error(
    '无法识别的文件：请选择 Pocket / Omnivore / Wallabag 导出、浏览器书签 HTML、Bitwarden JSON/CSV、1Password CSV 或 Postman v2.1 集合',
  );
}

/** Mark candidates already present (existing keys) or repeated within the file. */
export function dedupe(candidates: ImportCandidate[], existing: Set<string>) {
  const seen = new Set<string>();
  return candidates.map((candidate) => {
    const duplicate = existing.has(candidate.key) ? 'existing' : seen.has(candidate.key) ? 'file' : '';
    seen.add(candidate.key);
    return { candidate, duplicate } as const;
  });
}
