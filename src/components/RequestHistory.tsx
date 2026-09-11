import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useProbe } from '../lib/useProbe';
import type { CompiledRequest } from '../lib/request';
import type { ProbeResult } from '../types';

interface Entry {
  id: string;
  status: string;
  createdAt: string;
  method?: string;
  url?: string;
  environment?: string;
  httpStatus?: number;
  durationMs?: number;
}
interface RecordValue {
  id: string;
  status: string;
  request?: CompiledRequest;
  response?: ProbeResult;
  error?: string;
  environment?: string;
}
const statuses: Record<string, string> = {
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '服务中断',
};
export function RequestHistory({ itemId }: { itemId: string }) {
  const [page, setPage] = useState(0);
  const [tick, setTick] = useState(0);
  const [rows, setRows] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<RecordValue | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const probe = useProbe(itemId);
  useEffect(() => {
    const abort = new AbortController();
    void api<{ items: Entry[]; total: number }>(`/items/${itemId}/requests?offset=${page * 50}`, {
      signal: abort.signal,
    })
      .then((value) => {
        if (!abort.signal.aborted) {
          setRows(value.items || []);
          setTotal(value.total || 0);
          setError('');
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorMessage(e));
      });
    return () => abort.abort();
  }, [itemId, page, tick, probe.finished]);
  async function open(id: string) {
    setBusy(true);
    probe.reset();
    setError('');
    try {
      setSelected(await api<RecordValue>(`/items/${itemId}/requests/${id}`));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    if (!window.confirm('删除这条请求及响应历史？')) return;
    setBusy(true);
    try {
      await api(`/items/${itemId}/requests/${id}`, { method: 'DELETE' });
      setSelected(null);
      setTick((v) => v + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="request-history">
      <div className="section-title">
        <h3>请求历史 · {total} 条</h3>
        <button onClick={() => setTick((v) => v + 1)}>刷新记录</button>
      </div>
      <p className="form-hint">
        历史包含当时的环境变量值和响应，使用主密码加密保存。重放会发送记录中的原始请求。
      </p>
      {rows.map((row) => (
        <button
          className="history-row"
          disabled={busy || probe.sending}
          key={row.id}
          onClick={() => void open(row.id)}
        >
          <span>
            <strong>
              {row.method || '请求'} {row.url || '已取消'}
            </strong>
            <small>
              {row.environment || '默认'} · {new Date(row.createdAt).toLocaleString()} ·{' '}
              {statuses[row.status] || row.status}
              {row.httpStatus ? ` · HTTP ${row.httpStatus}` : ''}
            </small>
          </span>
        </button>
      ))}
      {!rows.length && <p className="muted">发送请求后会在这里记录结果。</p>}
      <div className="inline-actions">
        <button disabled={page === 0} onClick={() => setPage((v) => v - 1)}>
          上一页
        </button>
        <button disabled={(page + 1) * 50 >= total} onClick={() => setPage((v) => v + 1)}>
          下一页
        </button>
      </div>
      {selected && (
        <div className="history-preview">
          <div className="section-title">
            <h3>历史详情</h3>
            <div className="inline-actions">
              <button disabled={busy || probe.sending} onClick={() => void remove(selected.id)}>
                删除历史
              </button>
              {selected.request && (
                <button
                  className="primary"
                  disabled={busy || probe.sending}
                  onClick={() => void probe.run(selected.request!, selected.environment)}
                >
                  发送相同请求
                </button>
              )}
              {probe.sending && <button onClick={probe.cancel}>取消请求</button>}
            </div>
          </div>
          <pre className="response-body">{JSON.stringify(selected.request || {}, null, 2)}</pre>
          <h4>{probe.response ? '本次响应' : '历史响应'}</h4>
          {(probe.response || selected.response)?.truncated && (
            <p className="info">
              这条历史已截断：最多保留前 1 MB 文本，编码过大时会进一步缩短；较大的二进制响应未保留。
            </p>
          )}
          <pre className="response-body">
            {JSON.stringify(
              probe.response || selected.response || { error: selected.error || statuses[selected.status] },
              null,
              2,
            )}
          </pre>
        </div>
      )}
      {(error || probe.error) && (
        <p className="error" role="alert">
          {error || probe.error}
        </p>
      )}
    </section>
  );
}
