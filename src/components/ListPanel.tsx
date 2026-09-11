import { Inbox, LoaderCircle, Search, Star, X } from 'lucide-react';
import { useState, type RefObject } from 'react';
import { categories, categoryName, dateLabel, type Dimension, type Item, type Pillar } from '../types';
export function ListPanel({
  pillar,
  items,
  total,
  dimensions,
  selectedId,
  query,
  category,
  global,
  loading,
  error,
  searchRef,
  onSelect,
  onQuery,
  onCategory,
  onGlobal,
  onMore,
  onRetry,
  onMenu,
  sort,
  view,
  onSort,
  onView,
  onOrganize,
  filterSummary,
  onClearFilters,
}: {
  pillar: Pillar;
  items: Item[];
  total: number;
  dimensions: Dimension[];
  selectedId: string | null;
  query: string;
  category: string;
  global: boolean;
  loading: boolean;
  error: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onSelect: (item: Item) => void;
  onQuery: (value: string) => void;
  onCategory: (value: string) => void;
  onGlobal: (v: boolean) => void;
  onMore: () => void;
  onRetry: () => void;
  onMenu: (item: Item, x: number, y: number) => void;
  sort: string;
  view: string;
  onSort: (value: string) => void;
  onView: (value: string) => void;
  onOrganize: (ids: string[]) => void;
  filterSummary: string;
  onClearFilters: () => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const scope = JSON.stringify([pillar, category, query, global, view, filterSummary]);
  const [selection, setSelection] = useState({ scope, ids: [] as string[] });
  const checked = selection.scope === scope ? selection.ids : [];
  const setChecked = (ids: string[]) => setSelection({ scope, ids });
  const options = { ...categories[pillar] };
  if (pillar === 'repo')
    for (const d of dimensions.filter((d) => d.kind === pillar)) options[d.category] = d.category || '未标注';
  return (
    <section className="list-panel" aria-label="资产列表">
      <div className="list-tools">
        <div className="search-input">
          <Search size={14} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="检索标题、Host、正文或标签…"
            aria-label="检索资产"
          />
          {query && (
            <button className="icon-button" aria-label="清空搜索" onClick={() => onQuery('')}>
              <X size={12} />
            </button>
          )}
        </div>
        <div className="list-filter">
          <button className={category === 'all' ? 'selected' : ''} onClick={() => onCategory('all')}>
            全部
          </button>
          {Object.entries(options).map(([v, l]) => (
            <button
              key={v}
              disabled={global}
              className={category === v ? 'selected' : ''}
              onClick={() => onCategory(v)}
            >
              {l}
            </button>
          ))}
        </div>
        <label className="search-scope">
          <input type="checkbox" checked={global} onChange={(e) => onGlobal(e.target.checked)} />
          搜索全部资产分类{loading && <LoaderCircle size={12} className="spin" />}
        </label>
        <div className="library-options">
          <select
            aria-label="资料视图"
            value={view}
            onChange={(e) => {
              onView(e.target.value);
              setChecked([]);
            }}
          >
            <option value="all">全部资料</option>
            <option value="recent">最近访问</option>
            <option value="frequent">常用资料</option>
            <option value="later">稍后读</option>
            <option value="archived">已归档</option>
          </select>
          <select aria-label="排序方式" value={sort} onChange={(e) => onSort(e.target.value)}>
            <option value="relevance">相关度</option>
            <option value="updated">最近更新</option>
            <option value="created">最近收录</option>
            <option value="title">标题</option>
          </select>
          <button
            onClick={() => {
              setSelecting((v) => !v);
              setChecked([]);
            }}
          >
            {selecting ? '完成选择' : '多选'}
          </button>
        </div>
        {selecting && (
          <div className="library-options">
            <button onClick={() => setChecked(items.slice(0, 200).map((i) => i.id))}>选择已加载项</button>
            <button disabled={!checked.length} onClick={() => onOrganize(checked)}>
              整理 {checked.length} 项
            </button>
          </div>
        )}
        {filterSummary && (
          <div className="library-options">
            <span>{filterSummary}</span>
            <button aria-label="清除项目和标签筛选" onClick={onClearFilters}>
              <X size={12} />
            </button>
          </div>
        )}
      </div>
      <div className="list-stream">
        {error && (
          <div className="list-error error">
            {error}
            <button onClick={onRetry}>重试</button>
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="list-empty">
            <Inbox size={26} />
            <strong>{query || category !== 'all' ? '没有匹配的条目' : '这里还没有资产'}</strong>
            <span>{query ? '试试其他关键词或搜索全部分类' : '通过顶部按钮收录或新建资料'}</span>
          </div>
        )}
        {items.map((item) => (
          <div className="list-item-row" key={item.id}>
            {selecting && (
              <input
                className="asset-check"
                type="checkbox"
                aria-label={`选择 ${item.title}`}
                checked={checked.includes(item.id)}
                disabled={!checked.includes(item.id) && checked.length >= 200}
                onChange={(e) =>
                  setChecked(
                    e.target.checked ? [...checked, item.id] : checked.filter((id) => id !== item.id),
                  )
                }
              />
            )}
            <button
              key={item.id}
              className={'list-item ' + (selectedId === item.id ? 'selected' : '')}
              onClick={() => onSelect(item)}
              onContextMenu={(event) => {
                event.preventDefault();
                onMenu(item, event.clientX, event.clientY);
              }}
              aria-pressed={selectedId === item.id}
            >
              <div className="list-item-meta">
                <span className={'badge ' + item.kind}>{categoryName(item)}</span>
                <small className="mono">{dateLabel(item.updatedAt)}</small>
              </div>
              <h3>{item.title}</h3>
              <p>
                {item.matchSnippet ||
                  item.summary ||
                  item.project ||
                  (item.kind === 'credential' ? '加密资产 · 点击查看连接属性' : item.url)}
              </p>
              <div className="list-item-foot">
                <span>
                  {item.kind === 'repo'
                    ? '★ ' + (item.data.stars?.toLocaleString() || '—')
                    : item.tags.slice(0, 3).join(' · ') || item.project || '未添加标签'}
                </span>
                {item.favorite && <Star size={12} className="starred" />}
              </div>
            </button>
          </div>
        ))}
        {items.length < total && (
          <button className="load-more" disabled={loading} onClick={onMore}>
            加载更多（{total - items.length}）
          </button>
        )}
      </div>
      <footer className="list-footer">
        <span>
          显示 {items.length} / {total} 项
        </span>
        <span className="mono">J / K 快速导航</span>
      </footer>
    </section>
  );
}
