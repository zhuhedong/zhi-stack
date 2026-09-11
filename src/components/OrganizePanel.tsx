import { Form } from './Form';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Modal } from './Modal';
export interface SavedFilter {
  kind?: string;
  q?: string;
  category?: string;
  project?: string;
  favorite?: boolean;
  view?: string;
  sort?: string;
  tag?: string;
}
interface View {
  id: string;
  name: string;
  filters: SavedFilter | null;
}
export function OrganizePanel({
  ids,
  filters,
  onClose,
  onChanged,
  onApply,
}: {
  ids: string[];
  filters: SavedFilter;
  onClose: () => void;
  onChanged: () => void;
  onApply: (filter: SavedFilter) => void;
}) {
  const [tab, setTab] = useState(ids.length ? 'batch' : 'views');
  const [views, setViews] = useState<View[]>([]);
  const [tags, setTags] = useState<{ name: string; count: number }[]>([]);
  const [name, setName] = useState('');
  const [project, setProject] = useState('');
  const [tagText, setTagText] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function load() {
    const [a, b] = await Promise.all([
      api<View[]>('/views'),
      api<{ name: string; count: number }[]>('/tags'),
    ]);
    setViews(Array.isArray(a) ? a : []);
    setTags(Array.isArray(b) ? b : []);
  }
  useEffect(() => {
    let alive = true;
    void Promise.all([api<View[]>('/views'), api<{ name: string; count: number }[]>('/tags')])
      .then(([a, b]) => {
        if (alive) {
          setViews(Array.isArray(a) ? a : []);
          setTags(Array.isArray(b) ? b : []);
        }
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      await load();
      onChanged();
      setMessage('已保存。');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function batch(patch: object) {
    return action(() => api('/items/batch', { method: 'POST', body: JSON.stringify({ ids, ...patch }) }));
  }
  return (
    <Modal
      title="整理资料"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="tabs maintenance-tabs">
        {Object.entries({ views: '保存的筛选', tags: '标签管理', batch: `批量操作（${ids.length}）` }).map(
          ([key, label]) => (
            <button
              key={key}
              disabled={busy || (key === 'batch' && !ids.length)}
              className={tab === key ? 'active' : ''}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ),
        )}
      </div>
      <div className="modal-body">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="info" role="status">
            {message}
          </p>
        )}
        {tab === 'views' && (
          <>
            <Form
              className="maintenance-form"
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  await api('/views', { method: 'POST', body: JSON.stringify({ name, filters }) });
                  setName('');
                });
              }}
            >
              <label>
                保存当前筛选
                <input
                  value={name}
                  maxLength={200}
                  required
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：支付项目的接口资料"
                />
              </label>
              <p className="muted">保存分类、项目、搜索词和排序。筛选条件会加密保存，解锁后可使用。</p>
              <button className="primary" disabled={busy}>
                保存筛选
              </button>
            </Form>
            {views.length === 0 && <p className="inline-empty">还没有保存的筛选。</p>}
            {views.map((view) => (
              <div className="maintenance-row" key={view.id}>
                <button
                  disabled={!view.filters || busy}
                  onClick={() => {
                    if (view.filters) onApply(view.filters);
                  }}
                >
                  {view.name}
                  {!view.filters && ' · 请先解锁'}
                </button>
                <button
                  disabled={busy}
                  className="danger-text"
                  onClick={() => void action(() => api(`/views/${view.id}`, { method: 'DELETE' }))}
                >
                  删除
                </button>
              </div>
            ))}
          </>
        )}
        {tab === 'tags' && (
          <Form
            className="maintenance-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await api('/tags/merge', {
                  method: 'POST',
                  body: JSON.stringify({ from: selectedTags, to: tagText }),
                });
                setSelectedTags([]);
                setTagText('');
              });
            }}
          >
            <p className="muted">选择一个标签可重命名；选择多个可合并。资产上的标签会一起更新。</p>
            <div className="tag-checks">
              {tags.map((tag) => (
                <label className="search-scope" key={tag.name}>
                  <input
                    type="checkbox"
                    checked={selectedTags.includes(tag.name)}
                    disabled={busy}
                    onChange={(e) =>
                      setSelectedTags(
                        e.target.checked
                          ? [...selectedTags, tag.name]
                          : selectedTags.filter((t) => t !== tag.name),
                      )
                    }
                  />
                  {tag.name} <small>{tag.count}</small>
                </label>
              ))}
            </div>
            <label>
              合并后的标签
              <input
                required
                maxLength={100}
                disabled={busy}
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
              />
            </label>
            <button className="primary" disabled={busy || !selectedTags.length}>
              合并或重命名
            </button>
          </Form>
        )}
        {tab === 'batch' && (
          <div className="maintenance-form">
            <p>已选择 {ids.length} 条资产，操作同时应用到这些条目。</p>
            <label>
              所属项目
              <input
                value={project}
                disabled={busy}
                onChange={(e) => setProject(e.target.value)}
                placeholder="留空可移出原项目"
              />
            </label>
            <button disabled={busy} onClick={() => void batch({ project })}>
              移动到此项目
            </button>
            <label>
              添加标签
              <input
                value={tagText}
                disabled={busy}
                onChange={(e) => setTagText(e.target.value)}
                placeholder="逗号分隔"
              />
            </label>
            <button
              disabled={busy || !tagText.trim()}
              onClick={() =>
                void batch({
                  addTags: tagText
                    .split(/[,，]/)
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
            >
              批量添加标签
            </button>
            <button
              disabled={busy || !tagText.trim()}
              onClick={() =>
                void batch({
                  removeTags: tagText
                    .split(/[,，]/)
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
            >
              批量移除标签
            </button>
            <div className="inline-actions">
              <button disabled={busy} onClick={() => void batch({ archived: true })}>
                归档所选资产
              </button>
              <button disabled={busy} onClick={() => void batch({ archived: false })}>
                移出归档
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
