import { useState } from 'react';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import type { Pair } from '../types';
import { secretField } from '../lib/fields';

export function RequestHeaders({
  global,
  custom,
  onGlobalChange,
  onCustomChange,
}: {
  global: Pair[];
  custom: Pair[];
  onGlobalChange: (pairs: Pair[]) => void;
  onCustomChange: (pairs: Pair[]) => void;
}) {
  const [visible, setVisible] = useState(false);
  const overrides = new Set(
    custom.filter((h) => h.enabled && h.key.trim()).map((h) => h.key.trim().toLowerCase()),
  );
  const rows = [
    ...global
      .map((pair, index) => ({ pair, index, inherited: true }))
      .filter(({ pair }) => !overrides.has(pair.key.trim().toLowerCase())),
    ...custom.map((pair, index) => ({ pair, index, inherited: false })),
  ];
  function change(inherited: boolean, index: number, patch: Partial<Pair>) {
    const current = inherited ? global : custom;
    (inherited ? onGlobalChange : onCustomChange)(
      current.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)),
    );
  }
  return (
    <div className="request-headers">
      <div className="section-title">
        <h3>合并请求头</h3>
        <div className="inline-actions">
          <button
            className="icon-button"
            aria-label={visible ? '隐藏请求头敏感值' : '显示请求头敏感值'}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            className="text-button"
            onClick={() => onCustomChange([...custom, { key: '', value: '', enabled: true, desc: '' }])}
          >
            <Plus size={13} />
            添加专属 Header
          </button>
        </div>
      </div>
      <p className="form-hint">
        全局值应用于所有接口；启用的同名专属 Header 覆盖全局值。这里对全局值的修改会随“保存参数”一同保存。
      </p>
      {!rows.length ? (
        <p className="inline-empty compact">尚未设置请求头。</p>
      ) : (
        <div className="effective-headers">
          {rows.map(({ pair, index, inherited }) => {
            const scope = inherited ? '全局 Header' : '接口 Header';
            const name = pair.key || String(index + 1);
            return (
              <div className="effective-header" key={scope + index}>
                <input
                  type="checkbox"
                  checked={pair.enabled}
                  aria-label={scope + '启用 ' + name}
                  onChange={(e) => change(inherited, index, { enabled: e.target.checked })}
                />
                <div className="header-key">
                  <input
                    className="mono"
                    aria-label={scope + '键名 ' + (index + 1)}
                    value={pair.key}
                    placeholder="Header 名称"
                    onChange={(e) => change(inherited, index, { key: e.target.value })}
                  />
                  <span className={'header-scope' + (inherited ? ' inherited' : '')}>
                    {inherited ? '全局继承' : '接口专属'}
                  </span>
                </div>
                <input
                  className="mono"
                  type={!visible && secretField(pair.key) ? 'password' : 'text'}
                  aria-label={scope + '值 ' + name}
                  value={pair.value}
                  placeholder="值"
                  onChange={(e) => change(inherited, index, { value: e.target.value })}
                />
                <button
                  className="icon-button"
                  aria-label={'删除' + scope + ' ' + name}
                  onClick={() =>
                    (inherited ? onGlobalChange : onCustomChange)(
                      (inherited ? global : custom).filter((_, i) => i !== index),
                    )
                  }
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
