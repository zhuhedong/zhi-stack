import { useEffect, useState } from 'react';
import { Link2, Plus, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { pillarNames, type Item, type ListResult } from '../types';
interface Related {
  id: string;
  kind: Item['kind'];
  title: string;
  label: string;
}
export function RelatedItems({
  item,
  onOpen,
}: {
  item: Item;
  onOpen: (item: Pick<Item, 'id' | 'kind'>) => void;
}) {
  const [related, setRelated] = useState<Related[]>([]);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Item[]>([]);
  const [label, setLabel] = useState('相关资料');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    const result = await api<Related[]>(`/items/${item.id}/relations`);
    setRelated(Array.isArray(result) ? result : []);
  }
  useEffect(() => {
    const abort = new AbortController();
    void api<Related[]>(`/items/${item.id}/relations`, { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setRelated(Array.isArray(result) ? result : []);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorMessage(e));
      });
    return () => abort.abort();
  }, [item.id]);
  useEffect(() => {
    if (!adding) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void api<ListResult>('/items?' + new URLSearchParams({ q: query, limit: '20' }), {
        signal: abort.signal,
      })
        .then((result) =>
          setOptions(
            (result.items || []).filter(
              (candidate) => candidate.id !== item.id && !related.some((r) => r.id === candidate.id),
            ),
          ),
        )
        .catch((e) => {
          if (!abort.signal.aborted) setError(errorMessage(e));
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [adding, query, item.id, related]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="related-items">
      <div className="section-title">
        <h3>
          <Link2 size={14} />
          关联资料
        </h3>
        <button className="text-button" onClick={() => setAdding((v) => !v)}>
          <Plus size={13} />
          {adding ? '收起' : '关联资产'}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {related.map((r) => (
        <div className="related-row" key={r.id + r.label}>
          <button onClick={() => onOpen(r)}>
            {r.title}
            <small>{r.label}</small>
          </button>
          <button
            className="icon-button"
            aria-label={`移除关联 ${r.title}`}
            disabled={busy}
            onClick={() =>
              void action(() => api(`/items/${item.id}/relations/${r.id}`, { method: 'DELETE' }))
            }
          >
            <X size={12} />
          </button>
        </div>
      ))}
      {adding && (
        <div className="relation-picker">
          <label>
            查找资产
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="标题、标签或正文关键词"
            />
          </label>
          <label>
            关联说明
            <input maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          {options.map((candidate) => (
            <button
              key={candidate.id}
              disabled={busy || !label.trim()}
              onClick={() =>
                void action(async () => {
                  await api(`/items/${item.id}/relations`, {
                    method: 'POST',
                    body: JSON.stringify({ targetId: candidate.id, label }),
                  });
                  setAdding(false);
                })
              }
            >
              {candidate.title}
              <small>{pillarNames[candidate.kind]}</small>
            </button>
          ))}
          {options.length === 0 && <p className="muted">没有可关联的匹配资产。</p>}
        </div>
      )}
    </section>
  );
}
