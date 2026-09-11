import { useState } from 'react';
import { Check, Code2, Download, FileText, Image, Save } from 'lucide-react';
import type { Item } from '../../types';
import { dateLabel } from '../../types';
import { errorMessage, exportText, saveItem } from '../../lib/api';
import { Markdown } from '../Markdown';
import { Attachments } from '../Attachments';
import { useDraft } from '../../lib/useDraft';
export function KnowledgeView({
  item,
  onSaved,
  onDirty,
}: {
  item: Item;
  onSaved: (item: Item) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const storedMode = item.data.readerMode === 'markdown' ? 'markdown' : 'flow';
  const [mode, setMode] = useState<'flow' | 'markdown'>(storedMode);
  const [text, setText] = useState(item.data.content || '');
  const draft = useDraft(onDirty);
  const { dirty } = draft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setReaderMode = (next: 'flow' | 'markdown') => {
    setMode(next);
    if (next !== storedMode) draft.change();
  };
  async function save() {
    const snapshot = draft.snapshot();
    setBusy(true);
    setError('');
    try {
      const updated = await saveItem(
        { ...item, data: { ...item.data, content: text, readerMode: mode } },
        item.id,
      );
      if (draft.saved(snapshot)) onSaved(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="canvas article-canvas">
      <div className="content-title">
        <div className="title-tags">
          {item.tags.map((t) => (
            <span className="tag" key={t}>
              {t}
            </span>
          ))}
        </div>
        <h1>{item.title}</h1>
        <div className="content-meta">
          <span>{item.data.author || '未填写作者'}</span>
          <span>{item.data.sourceName || '个人笔记'}</span>
          <span>{dateLabel(item.updatedAt)}</span>
          <span>
            <Image size={12} />
            {item.data.imagesCount || 0} 张离线图片
          </span>
        </div>
      </div>
      <div className="reader-toolbar">
        <div className="segmented">
          <button className={mode === 'flow' ? 'active' : ''} onClick={() => setReaderMode('flow')}>
            <FileText size={13} />
            流畅精读
          </button>
          <button className={mode === 'markdown' ? 'active' : ''} onClick={() => setReaderMode('markdown')}>
            <Code2 size={13} />
            Markdown
          </button>
        </div>
        <button className={dirty ? 'primary' : ''} disabled={!dirty || busy} onClick={() => void save()}>
          {dirty ? <Save size={13} /> : <Check size={13} />}
          {busy ? '保存中…' : dirty ? '保存修改' : '已保存'}
        </button>
        <button className="text-button" onClick={() => exportText(text, item.title + '.md')}>
          <Download size={13} />
          导出
        </button>
      </div>
      {item.summary && <blockquote className="article-summary">{item.summary}</blockquote>}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {mode === 'flow' ? (
        <Markdown baseUrl={item.url || undefined} text={text || '暂无正文。切换到 Markdown 添加内容。'} />
      ) : (
        <section className="markdown-editor">
          <div className="section-title">
            <h3>Markdown 源码</h3>
          </div>
          <textarea
            aria-label="Markdown 正文"
            className="mono"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              draft.change();
            }}
          />
        </section>
      )}
      <Attachments id={item.id} />
    </div>
  );
}
