import { useEffect, useState } from 'react';
import { ArrowLeft, Trash2, WifiOff } from 'lucide-react';
import { Modal } from './Modal';
import { Markdown } from './LazyMarkdown';
import { formatDateTime } from '../lib/format';
import {
  listOffline,
  readOffline,
  removeOffline,
  type OfflineArticle,
  type OfflineEntry,
} from '../lib/offline';

/** Reads articles saved on this device without contacting the server. */
export function OfflineReader({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<OfflineEntry[] | null>(null);
  const [article, setArticle] = useState<OfflineArticle | null>(null);
  const [query, setQuery] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    void listOffline().then((list) => live && setEntries(list));
    return () => {
      live = false;
    };
  }, [version]);
  const q = query.trim().toLowerCase();
  const shown = (entries || []).filter(
    (e) => !q || e.title.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)),
  );
  return (
    <Modal title={article ? article.title : '离线阅读'} onClose={onClose} wide>
      <div className="modal-body offline-reader">
        {article ? (
          <>
            <div className="inline-actions">
              <button onClick={() => setArticle(null)}>
                <ArrowLeft size={13} /> 返回列表
              </button>
              <span className="muted">
                保存于 {formatDateTime(article.savedAt)}
                {article.url ? ` · ${article.url}` : ''}
              </span>
            </div>
            <article className="reader-article">
              <Markdown text={article.content} baseUrl={article.url || undefined} />
            </article>
          </>
        ) : (
          <>
            <p className="muted">
              <WifiOff size={13} />{' '}
              以下文章保存在此设备的浏览器中，无需连接服务即可阅读（图片和附件需联网）。打开文章时自动保存最近
              200 篇。
            </p>
            <input
              aria-label="筛选离线文章"
              placeholder="按标题或标签筛选"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {shown.map((e) => (
              <div className="task-record" key={e.id}>
                <div className="section-title">
                  <button className="text-button" onClick={() => void readOffline(e.id).then(setArticle)}>
                    <strong>{e.title}</strong>
                  </button>
                  <button
                    className="icon-button"
                    aria-label={'移除离线文章 ' + e.title}
                    onClick={() => void removeOffline(e.id).then(() => setVersion((v) => v + 1))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <p className="muted">
                  {e.project ? e.project + ' · ' : ''}
                  {e.tags.length ? e.tags.join('、') + ' · ' : ''}
                  {Math.max(1, Math.round(e.chars / 400))} 分钟 · 保存于 {formatDateTime(e.savedAt)}
                </p>
              </div>
            ))}
            {entries && !shown.length && (
              <p className="inline-empty">{entries.length ? '没有匹配的文章。' : '还没有离线保存的文章。'}</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
