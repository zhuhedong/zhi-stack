import { Plus, Trash2 } from 'lucide-react';
import {
  opLabels,
  sourceLabels,
  type AssertOp,
  type Assertion,
  type ChainOutcome,
  type Extraction,
  type RuleSource,
} from '../lib/chaining';

const sources = Object.keys(sourceLabels) as RuleSource[];
const ops = Object.keys(opLabels) as AssertOp[];
const placeholder = (source: RuleSource) =>
  source === 'json'
    ? '$.data.token'
    : source === 'header'
      ? 'X-Request-Id'
      : source === 'regex'
        ? 'token=(\\w+)'
        : '—';

/** Editor for post-response extraction (chaining) and assertion rules. */
export function ChainRules({
  extractions,
  assertions,
  onExtractions,
  onAssertions,
  outcome,
}: {
  extractions: Extraction[];
  assertions: Assertion[];
  onExtractions: (rules: Extraction[]) => void;
  onAssertions: (rules: Assertion[]) => void;
  outcome?: ChainOutcome | null;
}) {
  const patchE = (i: number, patch: Partial<Extraction>) =>
    onExtractions(extractions.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const patchA = (i: number, patch: Partial<Assertion>) =>
    onAssertions(assertions.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const sourceSelect = (value: RuleSource, change: (s: RuleSource) => void, label: string) => (
    <select aria-label={label} value={value} onChange={(e) => change(e.target.value as RuleSource)}>
      {sources.map((s) => (
        <option key={s} value={s}>
          {sourceLabels[s]}
        </option>
      ))}
    </select>
  );
  return (
    <div className="chain-rules">
      <p className="muted">
        响应返回后按规则提取变量写入当前环境，后续请求可用 {'{{变量名}}'}{' '}
        引用；断言用于检查响应。规则是声明式的，在浏览器独立 Worker 中执行，不运行任何脚本代码。
      </p>
      <div className="section-title">
        <h3>
          提取变量 <span className="muted">{extractions.length}</span>
        </h3>
        <button
          className="text-button"
          onClick={() =>
            onExtractions([
              ...extractions,
              { id: crypto.randomUUID(), enabled: true, source: 'json', expr: '', variable: '' },
            ])
          }
        >
          <Plus size={13} /> 添加
        </button>
      </div>
      {extractions.map((r, i) => (
        <div className="chain-row" key={r.id}>
          <input
            type="checkbox"
            aria-label={'启用提取 ' + (i + 1)}
            checked={r.enabled}
            onChange={(e) => patchE(i, { enabled: e.target.checked })}
          />
          {sourceSelect(r.source, (source) => patchE(i, { source }), '提取来源 ' + (i + 1))}
          <input
            aria-label={'提取表达式 ' + (i + 1)}
            value={r.expr}
            disabled={r.source === 'status' || r.source === 'time'}
            placeholder={placeholder(r.source)}
            onChange={(e) => patchE(i, { expr: e.target.value })}
          />
          <span className="muted">→</span>
          <input
            aria-label={'变量名 ' + (i + 1)}
            value={r.variable}
            placeholder="变量名"
            onChange={(e) => patchE(i, { variable: e.target.value })}
          />
          <button
            className="icon-button"
            aria-label={'删除提取 ' + (i + 1)}
            onClick={() => onExtractions(extractions.filter((_, j) => j !== i))}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div className="section-title">
        <h3>
          断言 <span className="muted">{assertions.length}</span>
        </h3>
        <button
          className="text-button"
          onClick={() =>
            onAssertions([
              ...assertions,
              { id: crypto.randomUUID(), enabled: true, source: 'status', expr: '', op: 'eq', value: '200' },
            ])
          }
        >
          <Plus size={13} /> 添加
        </button>
      </div>
      {assertions.map((r, i) => {
        const result = outcome?.assertions.find((a) => a.id === r.id);
        return (
          <div className="chain-row" key={r.id}>
            <input
              type="checkbox"
              aria-label={'启用断言 ' + (i + 1)}
              checked={r.enabled}
              onChange={(e) => patchA(i, { enabled: e.target.checked })}
            />
            {sourceSelect(r.source, (source) => patchA(i, { source }), '断言来源 ' + (i + 1))}
            <input
              aria-label={'断言表达式 ' + (i + 1)}
              value={r.expr}
              disabled={r.source === 'status' || r.source === 'time'}
              placeholder={placeholder(r.source)}
              onChange={(e) => patchA(i, { expr: e.target.value })}
            />
            <select
              aria-label={'断言条件 ' + (i + 1)}
              value={r.op}
              onChange={(e) => patchA(i, { op: e.target.value as AssertOp })}
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {opLabels[op]}
                </option>
              ))}
            </select>
            <input
              aria-label={'期望值 ' + (i + 1)}
              value={r.value}
              disabled={r.op === 'exists' || r.op === 'notExists'}
              placeholder="期望值"
              onChange={(e) => patchA(i, { value: e.target.value })}
            />
            <span
              className={result ? (result.passed ? 'good' : 'danger-text') : 'muted'}
              title={result?.message || result?.actual}
            >
              {result ? (result.passed ? '通过' : '失败') : ''}
            </span>
            <button
              className="icon-button"
              aria-label={'删除断言 ' + (i + 1)}
              onClick={() => onAssertions(assertions.filter((_, j) => j !== i))}
            >
              <Trash2 size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Compact result summary shown above the response. */
export function ChainSummary({ outcome }: { outcome: ChainOutcome }) {
  const failed = outcome.assertions.filter((a) => !a.passed);
  if (!outcome.variables.length && !outcome.assertions.length && !outcome.errors.length) return null;
  return (
    <div className="chain-summary" role="status">
      {outcome.assertions.length > 0 && (
        <span className={failed.length ? 'danger-text' : 'good'}>
          断言 {outcome.assertions.length - failed.length}/{outcome.assertions.length} 通过
        </span>
      )}
      {outcome.variables.map((v) => (
        <span key={v.name} className="chain-var">
          {v.name} = {v.value.length > 40 ? v.value.slice(0, 40) + '…' : v.value}
        </span>
      ))}
      {failed.map((a) => (
        <span key={a.id} className="danger-text">
          ✗ {a.label}（实际：{a.message || a.actual}）
        </span>
      ))}
      {outcome.errors.map((e) => (
        <span key={e} className="danger-text">
          {e}
        </span>
      ))}
    </div>
  );
}
