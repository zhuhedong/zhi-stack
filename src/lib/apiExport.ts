import type { Endpoint, Item, Pair } from '../types';
import { mergeHeaders } from './request';
import type { Assertion, Extraction } from './chaining';

/** Header/variable names whose values are treated as secrets on export. */
export const SENSITIVE = /authorization|token|password|passwd|secret|api.?key|cookie|session|signature/i;
export interface ExportOptions {
  /** Include values of sensitive headers/variables (off by default). */
  includeSecrets?: boolean;
}
const mask = (pair: Pair, options: ExportOptions) =>
  !options.includeSecrets &&
  SENSITIVE.test(pair.key) &&
  pair.value &&
  !/^\{\{[^{}]+\}\}$/.test(pair.value.trim())
    ? `{{${pair.key.replace(/[^A-Za-z0-9_.-]/g, '_')}}}`
    : pair.value;
function splitPath(path: string): { route: string; query: Pair[] } {
  const at = path.indexOf('?');
  return at < 0
    ? { route: path, query: [] as Pair[] }
    : {
        route: path.slice(0, at),
        query: [...new URLSearchParams(path.slice(at + 1))].map(([key, value]) => ({
          key,
          value,
          enabled: true,
        })),
      };
}
const contentType = (headers: Pair[]) =>
  headers
    .find((h) => h.key.toLowerCase() === 'content-type')
    ?.value.split(';')[0]
    .trim();
function parsedBody(body: string) {
  try {
    return { json: true, value: JSON.parse(body) as unknown };
  } catch {
    return { json: false, value: body };
  }
}
const endpoints = (item: Item) => item.data.swaggerEndpoints || [];
const variables = (item: Item) =>
  item.data.environments?.find((env) => env.id === item.data.activeEnvironment)?.variables ||
  item.data.environments?.[0]?.variables ||
  [];

/** Builds an OpenAPI 3.0.3 document from the workbench collection. */
export function toOpenApi(item: Item, options: ExportOptions = {}) {
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();
  const baseUrl = item.data.fields?.baseUrl?.trim();
  for (const ep of endpoints(item)) {
    const { route, query } = splitPath(ep.path);
    const headers = mergeHeaders(item.data.globalHeaders || [], ep.customHeaders);
    const parameters: Record<string, unknown>[] = [];
    const routeKeys = [...route.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
    for (const key of routeKeys) {
      const p = ep.pathParams.find((pair) => pair.key === key);
      parameters.push({
        name: key,
        in: 'path',
        required: true,
        schema: { type: 'string' },
        ...(p?.value ? { example: p.value } : {}),
        ...(p?.desc ? { description: p.desc } : {}),
      });
    }
    for (const p of [...query, ...ep.queryParams].filter((p) => p.key)) {
      parameters.push({
        name: p.key,
        in: 'query',
        required: false,
        schema: { type: 'string' },
        ...(p.value ? { example: mask(p, options) } : {}),
        ...(p.desc ? { description: p.desc } : {}),
      });
    }
    for (const h of headers.filter(
      (h) => !['content-type', 'accept', 'content-length'].includes(h.key.toLowerCase()),
    )) {
      parameters.push({
        name: h.key,
        in: 'header',
        required: false,
        schema: { type: 'string' },
        ...(h.value ? { example: mask(h, options) } : {}),
        ...(h.desc ? { description: h.desc } : {}),
      });
    }
    const operation: Record<string, unknown> = {
      summary: ep.summary,
      tags: [ep.tag || '默认'],
      operationId: `${ep.method.toLowerCase()}_${route.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root'}`,
      ...(parameters.length ? { parameters } : {}),
      responses: { default: { description: '响应' } },
    };
    if (ep.baseUrl?.trim()) operation.servers = [{ url: ep.baseUrl.trim() }];
    tags.add(ep.tag || '默认');
    if (ep.requestBody && !['GET', 'HEAD'].includes(ep.method)) {
      const body = parsedBody(ep.requestBody);
      const media = contentType(headers) || (body.json ? 'application/json' : 'text/plain');
      operation.requestBody = { content: { [media]: { example: body.value } } };
    }
    const key = route || '/';
    paths[key] = { ...(paths[key] || {}), [ep.method.toLowerCase()]: operation };
  }
  // Distinct operationIds are required by the spec.
  const seen = new Map<string, number>();
  for (const methods of Object.values(paths))
    for (const op of Object.values(methods) as { operationId: string }[]) {
      const n = seen.get(op.operationId) || 0;
      seen.set(op.operationId, n + 1);
      if (n) op.operationId += '_' + (n + 1);
    }
  return {
    openapi: '3.0.3',
    info: {
      title: item.title || 'API',
      version: String(
        (item.data.spec as { info?: { version?: string } } | undefined)?.info?.version || '1.0.0',
      ),
      ...(item.summary ? { description: item.summary } : {}),
    },
    ...(baseUrl ? { servers: [{ url: baseUrl }] } : {}),
    tags: [...tags].map((name) => ({ name })),
    paths,
  };
}

const js = (value: string) => JSON.stringify(value);
function jsonAccess(path: string) {
  // `$.a.b[0]["c"]` → `.a.b[0]["c"]` — only emitted when it is a plain accessor path.
  const rest = path.trim().slice(1);
  return /^(\.[A-Za-z_$][\w$]*|\[\d+\]|\[("[^"\\]*")\])*$/.test(rest) ? rest : null;
}
function selector(source: string, expr: string) {
  switch (source) {
    case 'status':
      return 'String(pm.response.code)';
    case 'time':
      return 'String(pm.response.responseTime)';
    case 'header':
      return `pm.response.headers.get(${js(expr.trim())})`;
    case 'regex':
      return `((m) => (m ? (m[1] ?? m[0]) : undefined))(pm.response.text().match(new RegExp(${js(expr)})))`;
    case 'json': {
      const access = jsonAccess(expr);
      if (access === null) return null;
      return `((v) => (v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v)))((() => { try { return pm.response.json()${access}; } catch (e) { return undefined; } })())`;
    }
  }
  return null;
}
/** Postman test script equivalent to the declarative rules (best effort; unsupported rules become comments). */
export function postmanTests(extractions: Extraction[] = [], assertions: Assertion[] = []) {
  const lines: string[] = [];
  for (const r of extractions.filter((r) => r.enabled && r.variable.trim())) {
    const sel = selector(r.source, r.expr);
    if (!sel) lines.push(`// 未转换的提取规则：${r.source} ${r.expr} → ${r.variable}`);
    else lines.push(`pm.environment.set(${js(r.variable.trim())}, ${sel});`);
  }
  for (const r of assertions.filter((r) => r.enabled)) {
    const sel = selector(r.source, r.expr);
    if (!sel) {
      lines.push(`// 未转换的断言：${r.source} ${r.expr} ${r.op} ${r.value}`);
      continue;
    }
    const expected = js(r.value);
    const check = {
      eq: `actual === ${expected}`,
      ne: `actual !== ${expected}`,
      contains: `actual !== undefined && actual.includes(${expected})`,
      exists: 'actual !== undefined && actual !== null',
      notExists: 'actual === undefined || actual === null',
      lt: `Number(actual) < Number(${expected})`,
      gt: `Number(actual) > Number(${expected})`,
      matches: `actual !== undefined && new RegExp(${js(r.value.replace(/^\/(.*)\/[a-z]*$/s, '$1'))}).test(actual)`,
    }[r.op];
    lines.push(
      `pm.test(${js(`${r.source} ${r.expr} ${r.op} ${r.value}`.replace(/\s+/g, ' ').trim())}, () => { const actual = ${sel}; pm.expect(${check}).to.be.true; });`,
    );
  }
  return lines;
}

function postmanRequest(item: Item, ep: Endpoint, options: ExportOptions) {
  const { route, query } = splitPath(ep.path);
  const headers = mergeHeaders(item.data.globalHeaders || [], ep.customHeaders);
  const host = ep.baseUrl?.trim() || '{{baseUrl}}';
  const segments = route
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/^\{([^{}]+)\}$/, ':$1'));
  const allQuery = [...query, ...ep.queryParams].filter((p) => p.key);
  const qs = allQuery
    .filter((p) => p.enabled)
    .map((p) => `${p.key}=${mask(p, options)}`)
    .join('&');
  const request: Record<string, unknown> = {
    method: ep.method,
    header: headers.map((h) => ({
      key: h.key,
      value: mask(h, options),
      ...(h.desc ? { description: h.desc } : {}),
    })),
    url: {
      raw: `${host.replace(/\/+$/, '')}/${segments.join('/')}${qs ? '?' + qs : ''}`,
      host: [host.replace(/\/+$/, '')],
      path: segments,
      ...(allQuery.length
        ? {
            query: allQuery.map((p) => ({
              key: p.key,
              value: mask(p, options),
              ...(p.enabled ? {} : { disabled: true }),
            })),
          }
        : {}),
      ...(ep.pathParams.length
        ? { variable: ep.pathParams.map((p) => ({ key: p.key, value: p.value })) }
        : {}),
    },
    description: ep.summary,
  };
  if (ep.requestBody && !['GET', 'HEAD'].includes(ep.method)) {
    const json = parsedBody(ep.requestBody).json;
    request.body = {
      mode: 'raw',
      raw: ep.requestBody,
      ...(json ? { options: { raw: { language: 'json' } } } : {}),
    };
  }
  const tests = postmanTests(ep.extractions, ep.assertions);
  return {
    name: ep.summary || `${ep.method} ${ep.path}`,
    request,
    ...(tests.length
      ? { event: [{ listen: 'test', script: { type: 'text/javascript', exec: tests } }] }
      : {}),
  };
}

/** Builds a Postman Collection v2.1 (folders per tag, `{{baseUrl}}` collection variable). */
export function toPostman(item: Item, options: ExportOptions = {}) {
  const folders = new Map<string, unknown[]>();
  for (const ep of endpoints(item)) {
    const tag = ep.tag || '默认';
    folders.set(tag, [...(folders.get(tag) || []), postmanRequest(item, ep, options)]);
  }
  const vars: { key: string; value: string }[] = [{ key: 'baseUrl', value: item.data.fields?.baseUrl || '' }];
  for (const v of variables(item))
    if (v.enabled && v.key.trim() && v.key.trim() !== 'baseUrl')
      vars.push({
        key: v.key.trim(),
        value: options.includeSecrets || !SENSITIVE.test(v.key) ? v.value : '',
      });
  return {
    info: {
      _postman_id: item.id,
      name: item.title || 'API',
      ...(item.summary ? { description: item.summary } : {}),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [...folders]
      .map(([name, items]) => (folders.size === 1 && name === '默认' ? items : [{ name, item: items }]))
      .flat(),
    variable: vars,
  };
}
