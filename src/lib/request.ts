import type { Endpoint, ItemData, Pair } from '../types';
export function vscodeFileUrl(path: string) {
  const normalized = path.replace(/\\/g, '/');
  return (
    'vscode://file/' +
    normalized
      .split('/')
      .map((part, index) => (index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
      .join('/')
  );
}
export const emptyEndpoint = (): Endpoint => ({
  method: 'GET',
  path: '/',
  summary: '新接口',
  tag: '自定义',
  customHeaders: [],
  queryParams: [],
  pathParams: [],
  requestBody: '',
});
export function mergeHeaders(global: Pair[], custom: Pair[]) {
  const result = new Map<string, Pair>();
  for (const h of [...global, ...custom]) {
    if (h.enabled && h.key.trim()) result.set(h.key.trim().toLowerCase(), { ...h, key: h.key.trim() });
  }
  return [...result.values()];
}
export function buildRequest(data: ItemData, ep: Endpoint) {
  if (!ep.path.startsWith('/') || ep.path.includes('\\') || ep.path.includes('#'))
    throw new Error('接口路径必须以 / 开头，不能包含反斜杠或 # 片段');
  const path = ep.path.replace(/\{([^}]+)\}/g, (placeholder, key: string) => {
    const parameter = ep.pathParams.find((p) => p.key === key);
    if (!parameter?.value) throw new Error('请填写路径参数 ' + placeholder);
    return encodeURIComponent(parameter.value);
  });
  let url: URL;
  try {
    url = new URL(ep.baseUrl?.trim() || data.fields?.baseUrl?.trim() || '');
  } catch {
    throw new Error('请填写有效的 Base URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL 只支持 HTTP / HTTPS');
  if (url.username || url.password || url.hash) throw new Error('Base URL 不能包含用户名、密码或 # 片段');
  const queryStart = path.indexOf('?');
  const route = queryStart < 0 ? path : path.slice(0, queryStart);
  url.pathname = url.pathname.replace(/\/+$/, '') + route;
  if (queryStart >= 0)
    for (const [key, value] of new URLSearchParams(path.slice(queryStart + 1)))
      url.searchParams.append(key, value);
  for (const p of ep.queryParams) if (p.enabled && p.key) url.searchParams.append(p.key, p.value);
  return {
    url: url.toString(),
    method: ep.method,
    headers: mergeHeaders(data.globalHeaders || [], ep.customHeaders),
    body: ['GET', 'HEAD'].includes(ep.method) ? undefined : ep.requestBody || undefined,
  };
}
export function endpointPath(ep: Endpoint, path: string): Partial<Endpoint> {
  const keys = [...new Set([...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]))];
  return {
    path,
    pathParams: keys.map(
      (key) => ep.pathParams.find((p) => p.key === key) || { key, value: '', enabled: true },
    ),
  };
}
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function buildCurl(data: ItemData, ep: Endpoint) {
  const req = buildRequest(data, ep);
  return [
    `curl ${req.method === 'HEAD' ? '--head' : '-X ' + req.method} ${shellQuote(req.url)}`,
    ...req.headers.map((h) => `  -H ${shellQuote(`${h.key}: ${h.value}`)}`),
    ...(req.body ? [`  --data-raw ${shellQuote(req.body)}`] : []),
  ].join(' \\\n');
}
export function connectionCommand(data: ItemData) {
  const f = data.fields || {};
  const q = shellQuote;
  switch (data.typeKey) {
    case 'mysql':
      return `mysql --host=${q(f.host || '')} --port=${q(f.port || '3306')} --user=${q(f.username || '')} --password ${q(f.database || '')}`;
    case 'postgresql':
      return `psql --host=${q(f.host || '')} --port=${q(f.port || '5432')} --username=${q(f.username || '')} --dbname=${q(f.database || '')} --password`;
    case 'redis':
      return `redis-cli -h ${q(f.host || '')} -p ${q(f.port || '6379')} -n ${q(f.dbIndex || '0')} --askpass`;
    case 'ssh':
      return `ssh -p ${q(f.port || '22')} ${q(`${f.username || 'root'}@${f.host || ''}`)}`;
    case 'mongodb':
      return `mongosh ${q(`mongodb://${f.host || ''}:${f.port || '27017'}/${f.database || ''}`)} --username ${q(f.username || '')} --password`;
    case 'milvus':
      return `curl ${q(`http://${f.host || ''}:${f.port || '19530'}/v2/vectordb/collections/list`)} -H 'Content-Type: application/json' -H ${q(`Authorization: Bearer ${f.username || ''}:${f.password || ''}`)} --data '{}'`;
    case 'qdrant':
      return `curl ${q(`http://${f.host || ''}:${f.port || '6333'}/collections`)} -H ${q(`api-key: ${f.apiKey || ''}`)}`;
    default:
      return f.url || f.host || '';
  }
}
