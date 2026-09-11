import { useState } from 'react';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import type { Pair } from '../types';
export function PairEditor({
  title,
  pairs,
  onChange,
  path = false,
}: {
  title: string;
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
  path?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const change = (index: number, patch: Partial<Pair>) =>
    onChange(pairs.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  return (
    <div className="pair-editor">
      <div className="section-title">
        <h3>
          {title} <span className="muted">{pairs.length}</span>
        </h3>
        <div className="inline-actions">
          <button
            className="icon-button"
            aria-label={visible ? '隐藏敏感参数' : '显示敏感参数'}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            className="text-button"
            onClick={() => onChange([...pairs, { key: '', value: '', enabled: true, desc: '' }])}
          >
            <Plus size={13} />
            添加
          </button>
        </div>
      </div>
      {pairs.length === 0 ? (
        <p className="inline-empty compact">尚未设置{title}。</p>
      ) : (
        <div className="pair-table">
          <div className="pair-table-labels">
            <span />
            <span>键名</span>
            <span>值</span>
            <span>说明</span>
            <span />
          </div>
          {pairs.map((p, i) => (
            <div className="pair-row" key={i}>
              <input
                aria-label={title + '启用 ' + (i + 1)}
                type="checkbox"
                checked={path || p.enabled}
                disabled={path}
                onChange={(e) => change(i, { enabled: e.target.checked })}
              />
              <input
                aria-label={title + '键名 ' + (i + 1)}
                value={p.key}
                placeholder="Key"
                onChange={(e) => change(i, { key: e.target.value })}
              />
              <input
                aria-label={title + '值 ' + (i + 1)}
                value={p.value}
                placeholder="Value"
                type={
                  !visible && /authorization|token|password|secret|api.?key|cookie/i.test(p.key)
                    ? 'password'
                    : 'text'
                }
                onChange={(e) => change(i, { value: e.target.value })}
              />
              <input
                aria-label={title + '说明 ' + (i + 1)}
                className="pair-desc"
                value={p.desc || ''}
                placeholder="说明"
                onChange={(e) => change(i, { desc: e.target.value })}
              />
              <button
                className="icon-button"
                aria-label={title + '删除 ' + (i + 1)}
                onClick={() => onChange(pairs.filter((_, j) => j !== i))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
