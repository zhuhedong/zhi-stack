export type Pillar = 'knowledge' | 'repo' | 'credential';
export interface Pair {
  key: string;
  value: string;
  enabled: boolean;
  desc?: string;
}
export interface Endpoint {
  baseUrl?: string;
  requestWarning?: string;
  method: string;
  path: string;
  summary: string;
  tag: string;
  customHeaders: Pair[];
  queryParams: Pair[];
  pathParams: Pair[];
  requestBody: string;
}
export interface ItemData {
  content?: string;
  author?: string;
  sourceName?: string;
  imagesCount?: number;
  readerMode?: 'flow' | 'markdown';
  owner?: string;
  repoName?: string;
  stars?: number;
  forks?: number;
  watchers?: number;
  license?: string;
  latestRelease?: string;
  releaseDate?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  readme?: string;
  defaultBranch?: string;
  localWorkspacePath?: string;
  cookbookNotes?: string;
  typeKey?: string;
  fields?: Record<string, string>;
  globalHeaders?: Pair[];
  swaggerEndpoints?: Endpoint[];
  description?: string;
  spec?: unknown;
  importSpec?: string;
}
export interface ItemInput {
  kind: Pillar;
  title: string;
  category: string;
  project: string;
  tags: string[];
  summary: string;
  url: string;
  data: ItemData;
  favorite: boolean;
  revision?: number;
}
export interface Item extends ItemInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface Dimension {
  kind: Pillar;
  category: string;
  project: string;
  count: number;
}
export interface ListResult {
  items: Item[];
  total: number;
  dimensions: Dimension[];
  unlocked: boolean;
}
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}
export interface ProbeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyBase64?: string | null;
  durationMs: number;
  size: number;
}
export const pillarNames: Record<Pillar, string> = {
  knowledge: '知识与文章',
  repo: 'GitHub 项目雷达',
  credential: '服务器与密码库',
};
export const categories: Record<Pillar, Record<string, string>> = {
  knowledge: { wechat: '微信公众号', forum: '技术论坛', blog: '架构博客', note: '个人笔记' },
  repo: { Rust: 'Rust', Go: 'Go', TypeScript: 'TypeScript', Python: 'Python' },
  credential: {
    http: 'REST / Swagger',
    sql: 'SQL 数据库',
    nosql: '缓存 NoSQL',
    vector: 'AI 向量',
    server: '服务器',
    account: '账号密码',
  },
};
export const categoryName = (item: Pick<Item, 'kind' | 'category'>) =>
  categories[item.kind][item.category] || item.category || '未分类';
export const dateLabel = (value?: string) =>
  value
    ? new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : '—';
export const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
