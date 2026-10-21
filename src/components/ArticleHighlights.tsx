import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Highlighter, LocateFixed, MessageSquareText, Trash2, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { anchorFor, locate, offsetAtPoint, rangeFor, textOf, type Anchor } from '../lib/anchoring';
import { formatDateTime } from '../lib/format';

export interface HighlightRecord extends Anchor {
  id: string;
  color: HighlightColor;
  note: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';
const highlightColors: [HighlightColor, string][] = [
  ['yellow', '黄色'],
  ['green', '绿色'],
  ['blue', '蓝色'],
  ['pink', '粉色'],
  ['purple', '紫色'],
];
type Highlights = { set(name: string, value: unknown): void; delete(name: string): void };
const registry = (): Highlights | null =>
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
    ? (CSS as unknown as { highlights: Highlights }).highlights
    : null;

/** Highlights + notes on the rendered article (children). */
export function ArticleHighlights({ itemId, children }: { itemId: string; children: ReactNode }) {
  const scope = useRef<HTMLDivElement>(null);
  const [records, setRecords] = useState<HighlightRecord[]>([]);
  const [positions, setPositions] = useState<Record<string, number | null>>({});
  const [pending, setPending] = useState<{ anchor: Anchor; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; note: string; color: HighlightColor } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api<HighlightRecord[]>(`/items/${itemId}/highlights`)
      .then((rows) => live && setRecords(Array.isArray(rows) ? rows : []))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [itemId]);

  // Re-anchor whenever the rendered article or the highlight list changes.
  const relocate = useCallback(() => {
    const root = scope.current;
    if (!root) return;
    const text = textOf(root);
    setPositions(Object.fromEntries(records.map((r) => [r.id, locate(text, r)])));
  }, [records]);
  useLayoutEffect(() => {
    relocate();
    const root = scope.current;
    if (!root || typeof MutationObserver === 'undefined') return;
    let timer = 0;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(relocate, 80);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [relocate]);
  useEffect(() => {
    const css = registry();
    const root = scope.current;
    if (!css || !root) return;
    for (const [color] of highlightColors) {
      const ranges = records
        .filter((r) => r.color === color && positions[r.id] != null)
        .map((r) => rangeFor(root, positions[r.id]!, positions[r.id]! + r.quote.length))
        .filter((r): r is Range => !!r);
      css.set('ih-' + color, new Highlight(...ranges));
    }
    return () => highlightColors.forEach(([color]) => css.delete('ih-' + color));
  }, [records, positions]);

  function onSelect(event: React.MouseEvent | React.KeyboardEvent) {
    const root = scope.current;
    const selection = window.getSelection();
    if (!root || !selection) return;
    if (selection.isCollapsed || !selection.rangeCount) {
      setPending(null);
      if ('clientX' in event) {
        const at = offsetAtPoint(root, event.clientX, event.clientY);
        const hit =
          at == null
            ? undefined
            : records.find(
                (r) =>
                  positions[r.id] != null && at >= positions[r.id]! && at < positions[r.id]! + r.quote.length,
              );
        if (hit) setEditing({ id: hit.id, note: hit.note, color: hit.color });
      }
      return;
    }
    const range = selection.getRangeAt(0);
    const anchor = anchorFor(root, range);
    if (!anchor || anchor.quote.length > 5000) return setPending(null);
    const rect = range.getBoundingClientRect?.() ?? { left: 0, width: 0, top: 60 };
    setPending({ anchor, x: rect.left + rect.width / 2, y: rect.top });
  }
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const create = (color: HighlightColor, withNote: boolean) =>
    act(async () => {
      if (!pending) return;
      const created = await api<HighlightRecord>(`/items/${itemId}/highlights`, {
        method: 'POST',
        body: JSON.stringify({ ...pending.anchor, color, note: '' }),
      });
      setRecords((rows) => [...rows, created].sort((a, b) => a.startOffset - b.startOffset));
      setPending(null);
      window.getSelection()?.removeAllRanges();
      if (withNote) setEditing({ id: created.id, note: '', color });
    });
  const saveEdit = () =>
    act(async () => {
      if (!editing) return;
      const current = records.find((r) => r.id === editing.id)!;
      const updated = await api<HighlightRecord>(`/highlights/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ color: editing.color, note: editing.note, revision: current.revision }),
      });
      setRecords((rows) => rows.map((r) => (r.id === updated.id ? updated : r)));
      setEditing(null);
    });
  const remove = (id: string) =>
    act(async () => {
      await api(`/highlights/${id}`, { method: 'DELETE' });
      setRecords((rows) => rows.filter((r) => r.id !== id));
      setEditing(null);
    });
  function reveal(record: HighlightRecord) {
    const root = scope.current;
    const at = positions[record.id];
    if (!root || at == null) return;
    const range = rangeFor(root, at, at + record.quote.length);
    const element = range?.startContainer.parentElement;
    element?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    const selection = window.getSelection();
    if (range && selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  const editingRecord = editing && records.find((r) => r.id === editing.id);
  return (
    <>
      <div ref={scope} className="highlight-scope" onMouseUp={onSelect} onKeyUp={onSelect}>
        {children}
      </div>
      {pending && (
        <div
          className="highlight-toolbar"
          role="toolbar"
          aria-label="划线"
          style={{ left: pending.x, top: Math.max(8, pending.y - 44) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <Highlighter size={13} />
          {highlightColors.map(([color, label]) => (
            <button
              key={color}
              className={'swatch hl-' + color}
              aria-label={`${label}划线`}
              title={`${label}划线`}
              disabled={busy}
              onClick={() => void create(color, false)}
            />
          ))}
          <button className="text-button" disabled={busy} onClick={() => void create('yellow', true)}>
            <MessageSquareText size={13} /> 划线并写笔记
          </button>
        </div>
      )}
      {editing && editingRecord && (
        <div className="highlight-editor" role="dialog" aria-label="编辑划线笔记">
          <div className="section-title">
            <strong>划线笔记</strong>
            <button className="icon-button" aria-label="关闭" onClick={() => setEditing(null)}>
              <X size={13} />
            </button>
          </div>
          <blockquote className={'hl-quote hl-' + editing.color}>{editingRecord.quote}</blockquote>
          <div className="inline-actions" role="radiogroup" aria-label="颜色">
            {highlightColors.map(([color, label]) => (
              <button
                key={color}
                role="radio"
                aria-checked={editing.color === color}
                aria-label={label}
                className={'swatch hl-' + color + (editing.color === color ? ' active' : '')}
                onClick={() => setEditing({ ...editing, color })}
              />
            ))}
          </div>
          <textarea
            aria-label="笔记内容"
            rows={4}
            autoFocus
            placeholder="写下想法、疑问或待办…"
            value={editing.note}
            onChange={(e) => setEditing({ ...editing, note: e.target.value })}
          />
          <div className="inline-actions">
            <button className="primary" disabled={busy} onClick={() => void saveEdit()}>
              保存
            </button>
            <button className="danger" disabled={busy} onClick={() => void remove(editing.id)}>
              <Trash2 size={13} /> 删除划线
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="highlight-list" aria-label="划线与笔记">
        <div className="section-title">
          <h3>
            <Highlighter size={14} /> 划线与笔记 {records.length || ''}
          </h3>
          <span className="muted">选中正文即可划线</span>
        </div>
        {records.map((record) => {
          const lost = positions[record.id] === null;
          return (
            <div key={record.id} className={'highlight-record' + (lost ? ' lost' : '')}>
              <blockquote className={'hl-quote hl-' + record.color}>{record.quote}</blockquote>
              {record.note && <p className="highlight-note">{record.note}</p>}
              <div className="inline-actions">
                <small className="muted">
                  {lost ? '原文已变化，未能在正文中定位' : formatDateTime(record.updatedAt)}
                </small>
                {!lost && (
                  <button className="text-button" onClick={() => reveal(record)}>
                    <LocateFixed size={12} /> 定位
                  </button>
                )}
                <button
                  className="text-button"
                  onClick={() => setEditing({ id: record.id, note: record.note, color: record.color })}
                >
                  <MessageSquareText size={12} /> {record.note ? '编辑笔记' : '添加笔记'}
                </button>
              </div>
            </div>
          );
        })}
        {!records.length && (
          <p className="inline-empty">在“流畅精读”中选中文字，选择颜色即可划线并添加笔记。</p>
        )}
      </section>
    </>
  );
}
