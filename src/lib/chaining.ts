/**
 * Declarative response processing for the API workbench: variable extraction
 * (for chaining requests) and assertions. Nothing here evaluates user code —
 * rules are data interpreted by a fixed evaluator, run in a dedicated worker so
 * a pathological regular expression cannot freeze the page (the worker is
 * terminated on timeout). The CSP forbids eval, which this design never needs.
 */
export type RuleSource = 'json' | 'header' | 'status' | 'regex' | 'time';
export interface Extraction {
  id: string;
  enabled: boolean;
  source: RuleSource;
  /** JSON path (`$.data.items[0].id`), header name or regex with a capture group. */
  expr: string;
  variable: string;
}
export type AssertOp = 'eq' | 'ne' | 'contains' | 'exists' | 'notExists' | 'lt' | 'gt' | 'matches';
export interface Assertion {
  id: string;
  enabled: boolean;
  source: RuleSource;
  expr: string;
  op: AssertOp;
  value: string;
}
export interface ChainResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}
export interface ChainOutcome {
  variables: { name: string; value: string }[];
  errors: string[];
  assertions: { id: string; label: string; passed: boolean; actual: string; message: string }[];
}
export const opLabels: Record<AssertOp, string> = {
  eq: '等于',
  ne: '不等于',
  contains: '包含',
  exists: '存在',
  notExists: '不存在',
  lt: '小于',
  gt: '大于',
  matches: '匹配正则',
};
export const sourceLabels: Record<RuleSource, string> = {
  json: 'JSON 路径',
  header: '响应头',
  status: '状态码',
  regex: '正文正则',
  time: '耗时 ms',
};

const MAX_PATH_SEGMENTS = 64;
const MAX_PATTERN = 500;
const MAX_VALUE = 64 * 1024;

/** Parses `$.a.b[0]["c d"][*]` into segments. `*` maps over arrays/objects. */
export function parsePath(path: string): (string | number)[] {
  let rest = path.trim();
  if (!rest.startsWith('$')) throw new Error('JSON 路径需以 $ 开头，例如 $.data.token');
  rest = rest.slice(1);
  const out: (string | number)[] = [];
  while (rest) {
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\.([A-Za-z_$\u00a0-\uffff][\w$\u00a0-\uffff-]*|\*)/))) out.push(m[1]);
    else if ((m = rest.match(/^\[(\d+)\]/))) out.push(Number(m[1]));
    else if ((m = rest.match(/^\[-(\d+)\]/))) out.push(-Number(m[1]));
    else if ((m = rest.match(/^\[\*\]/))) out.push('*');
    else if ((m = rest.match(/^\[(["'])((?:\\.|(?!\1).)*)\1\]/))) out.push(m[2].replace(/\\(.)/g, '$1'));
    else throw new Error('无法解析的 JSON 路径：' + path);
    rest = rest.slice(m[0].length);
    if (out.length > MAX_PATH_SEGMENTS) throw new Error('JSON 路径过长');
  }
  return out;
}
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
export function queryJson(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const segment of parsePath(path)) {
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || typeof value !== 'object') continue;
      if (segment === '*') next.push(...(Array.isArray(value) ? value : Object.values(value)));
      else if (typeof segment === 'number') {
        if (!Array.isArray(value)) continue;
        const index = segment < 0 ? value.length + segment : segment;
        if (index >= 0 && index < value.length) next.push(value[index]);
      } else if (!Array.isArray(value) && own(value, segment))
        next.push((value as Record<string, unknown>)[segment]);
      else if (Array.isArray(value) && segment === 'length') next.push(value.length);
    }
    current = next;
  }
  return current;
}
const stringify = (value: unknown) =>
  value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
function compile(pattern: string) {
  if (pattern.length > MAX_PATTERN) throw new Error('正则表达式过长');
  const m = pattern.match(/^\/(.*)\/([imsu]*)$/s);
  return m ? new RegExp(m[1], m[2]) : new RegExp(pattern);
}
/** Returns the selected value, or undefined when it does not exist. */
export function select(
  response: ChainResponse,
  source: RuleSource,
  expr: string,
  parsed?: { json?: unknown; ok: boolean },
) {
  switch (source) {
    case 'status':
      return String(response.status);
    case 'time':
      return String(response.durationMs);
    case 'header': {
      const name = expr.trim().toLowerCase();
      const hit = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name);
      return hit?.[1];
    }
    case 'regex': {
      const m = response.body.match(compile(expr));
      return m ? (m[1] ?? m[0]) : undefined;
    }
    case 'json': {
      if (!parsed?.ok) throw new Error('响应不是有效的 JSON');
      const hits = queryJson(parsed.json, expr);
      if (!hits.length) return undefined;
      return stringify(expr.includes('*') ? hits : hits[0]);
    }
  }
}
export function evaluate(
  response: ChainResponse,
  extractions: Extraction[],
  assertions: Assertion[],
): ChainOutcome {
  const parsed: { json?: unknown; ok: boolean } = { ok: false };
  try {
    parsed.json = JSON.parse(response.body);
    parsed.ok = true;
  } catch {
    /* Non-JSON bodies only fail JSON rules. */
  }
  const outcome: ChainOutcome = { variables: [], errors: [], assertions: [] };
  for (const rule of extractions) {
    if (!rule.enabled || !rule.variable.trim()) continue;
    const name = rule.variable.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
      outcome.errors.push('无效的变量名：' + name);
      continue;
    }
    try {
      const value = select(response, rule.source, rule.expr, parsed);
      if (value === undefined)
        outcome.errors.push(`提取 ${name} 失败：${sourceLabels[rule.source]} ${rule.expr} 不存在`);
      else if (value.length > MAX_VALUE) outcome.errors.push(`提取 ${name} 失败：值超过 64 KB`);
      else outcome.variables.push({ name, value });
    } catch (e) {
      outcome.errors.push(`提取 ${name} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const rule of assertions) {
    if (!rule.enabled) continue;
    const label = `${sourceLabels[rule.source]}${rule.expr ? ' ' + rule.expr : ''} ${opLabels[rule.op]}${['exists', 'notExists'].includes(rule.op) ? '' : ' ' + rule.value}`;
    try {
      const actual = select(response, rule.source, rule.expr, parsed);
      const expected = rule.value;
      const number = (v: string | undefined) => (v === undefined || v.trim() === '' ? NaN : Number(v));
      let passed: boolean;
      switch (rule.op) {
        case 'exists':
          passed = actual !== undefined;
          break;
        case 'notExists':
          passed = actual === undefined;
          break;
        case 'eq':
          passed = actual === expected;
          break;
        case 'ne':
          passed = actual !== expected;
          break;
        case 'contains':
          passed = actual !== undefined && actual.includes(expected);
          break;
        case 'lt':
          passed = number(actual) < number(expected);
          break;
        case 'gt':
          passed = number(actual) > number(expected);
          break;
        case 'matches':
          passed = actual !== undefined && compile(expected).test(actual);
          break;
      }
      outcome.assertions.push({
        id: rule.id,
        label,
        passed,
        actual: actual === undefined ? '（不存在）' : actual.slice(0, 200),
        message: '',
      });
    } catch (e) {
      outcome.assertions.push({
        id: rule.id,
        label,
        passed: false,
        actual: '',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return outcome;
}

/** Writes extracted variables into the environment, adding missing keys. */
export function applyVariables<T extends { key: string; value: string; enabled: boolean }>(
  variables: T[],
  extracted: { name: string; value: string }[],
  make: (key: string, value: string) => T,
): T[] {
  const result = [...variables];
  for (const { name, value } of extracted) {
    const at = result.findIndex((v) => v.key.trim() === name);
    if (at >= 0) result[at] = { ...result[at], value, enabled: true };
    else result.push(make(name, value));
  }
  return result;
}

const TIMEOUT_MS = 2000;
/** Runs `evaluate` in a module worker; terminates it if it does not finish quickly. */
export function evaluateInWorker(
  response: ChainResponse,
  extractions: Extraction[],
  assertions: Assertion[],
): Promise<ChainOutcome> {
  if (typeof Worker === 'undefined') return Promise.resolve(evaluate(response, extractions, assertions));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./chaining.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('提取/断言执行超时（2 秒），请检查正则表达式'));
    }, TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<ChainOutcome | { error: string }>) => {
      clearTimeout(timer);
      worker.terminate();
      if ('error' in event.data) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || '提取/断言执行失败'));
    };
    worker.postMessage({ response, extractions, assertions });
  });
}
