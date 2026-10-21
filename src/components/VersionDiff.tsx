import { useMemo } from 'react';
import type { Item } from '../types';
import { diffLines, diffStats, withContext } from '../lib/diff';

/** Text that represents an item's body for comparison. */
export function comparableText(item: Item): string {
  return item.data.content || item.data.cookbookNotes || item.data.readme || '';
}
function Field({ label, before, after }: { label: string; before: string; after: string }) {
  if (before === after) return null;
  return (
    <div className="diff-field">
      <span className="diff-field-label">{label}</span>
      <del>{before || '（空）'}</del>
      <ins>{after || '（空）'}</ins>
    </div>
  );
}
/** Inline line diff from an old version (`before`) to the current item (`after`). */
export function VersionDiff({ before, after }: { before: Item; after: Item }) {
  const ops = useMemo(() => diffLines(comparableText(before), comparableText(after)), [before, after]);
  const stats = diffStats(ops);
  const rows = withContext(ops);
  const metaSame =
    before.title === after.title &&
    before.project === after.project &&
    before.tags.join('、') === after.tags.join('、') &&
    before.summary === after.summary;
  return (
    <section className="version-diff" aria-label="版本对比">
      <p className="muted">
        所选版本 → 当前版本 · <span className="diff-add-count">+{stats.added}</span>{' '}
        <span className="diff-del-count">−{stats.removed}</span> 行
      </p>
      {!metaSame && (
        <div className="diff-fields">
          <Field label="标题" before={before.title} after={after.title} />
          <Field label="项目" before={before.project} after={after.project} />
          <Field label="标签" before={before.tags.join('、')} after={after.tags.join('、')} />
          <Field label="摘要" before={before.summary} after={after.summary} />
        </div>
      )}
      {stats.added + stats.removed === 0 ? (
        <p className="inline-empty">正文没有变化。</p>
      ) : (
        <pre className="diff-lines">
          {rows.map((row, i) =>
            row.type === 'gap' ? (
              <div key={i} className="diff-gap">
                ⋯ 省略 {row.count} 行未变化内容
              </div>
            ) : (
              <div key={i} className={'diff-' + row.type}>
                <span className="diff-sign" aria-hidden="true">
                  {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}
                </span>
                <span className="sr-only">
                  {row.type === 'add' ? '新增：' : row.type === 'del' ? '删除：' : ''}
                </span>
                {row.text || ' '}
              </div>
            ),
          )}
        </pre>
      )}
    </section>
  );
}
