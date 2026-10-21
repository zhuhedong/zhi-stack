import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api, copyText, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useConfirm } from '../lib/confirmation';

interface Token {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  expired: boolean;
}

/** Personal API tokens: create (shown once), list and revoke. */
export function ApiTokens() {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const confirm = useConfirm();
  useEffect(() => {
    let live = true;
    api<{ tokens: Token[] }>('/tokens')
      .then((v) => live && setTokens(v.tokens))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [version]);
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      setVersion((v) => v + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const origin = typeof location === 'undefined' ? '' : location.origin;
  return (
    <div className="api-tokens">
      <div className="section-title">
        <h3>
          <KeyRound size={14} /> 个人 API 令牌
        </h3>
      </div>
      <p className="muted">
        用于脚本、命令行和 MCP 客户端（{origin}
        /api/mcp）。令牌只显示一次，服务端只保存哈希；令牌无法读取凭据的加密字段，也不能修改、删除条目或导出备份。用法见
        docs/api-tokens.md。
      </p>
      <div className="feed-form-row">
        <label>
          名称
          <input value={name} placeholder="例如：Claude Desktop" onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          有效期
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="30">30 天</option>
            <option value="90">90 天</option>
            <option value="365">1 年</option>
            <option value="">永不过期</option>
          </select>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked disabled /> 读取
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />{' '}
          写入（收录链接、新建笔记）
        </label>
        <button
          className="primary"
          disabled={busy || !name.trim()}
          onClick={() =>
            void act(async () => {
              const result = await api<{ token: string }>('/tokens', {
                method: 'POST',
                body: JSON.stringify({
                  name,
                  scopes: write ? ['read', 'write'] : ['read'],
                  expiresInDays: days ? Number(days) : null,
                }),
              });
              setCreated(result.token);
              setName('');
            })
          }
        >
          创建令牌
        </button>
      </div>
      {created && (
        <div className="token-created" role="status">
          <strong>请立即复制，关闭后无法再次查看：</strong>
          <code>{created}</code>
          <div className="inline-actions">
            <button onClick={() => void copyText(created)}>复制</button>
            <button onClick={() => setCreated(null)}>我已保存</button>
          </div>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {tokens?.map((t) => (
        <div className="task-record" key={t.id}>
          <div className="section-title">
            <strong>
              {t.name} <code className="muted">{t.prefix}…</code>
            </strong>
            <span className={t.revokedAt || t.expired ? 'muted' : 'good'}>
              {t.revokedAt ? '已撤销' : t.expired ? '已过期' : t.scopes.join(' + ')}
            </span>
          </div>
          <p className="muted">
            创建于 {formatDateTime(t.createdAt)}
            {t.expiresAt ? ` · 到期 ${formatDateTime(t.expiresAt)}` : ' · 永不过期'}
            {t.lastUsedAt ? ` · 最近使用 ${formatDateTime(t.lastUsedAt)}` : ' · 从未使用'}
          </p>
          {!t.revokedAt && (
            <div className="inline-actions">
              <button
                className="danger"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (
                      !(await confirm({
                        title: '撤销令牌',
                        description: `撤销“${t.name}”后，使用它的脚本和 MCP 客户端将立即失效。`,
                        confirmLabel: '撤销',
                      }))
                    )
                      return;
                    await api(`/tokens/${t.id}`, { method: 'DELETE' });
                  })
                }
              >
                撤销
              </button>
            </div>
          )}
        </div>
      ))}
      {tokens && !tokens.length && <p className="inline-empty">还没有 API 令牌。</p>}
    </div>
  );
}
