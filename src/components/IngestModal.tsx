import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import { Modal } from './Modal';
import { api, errorMessage } from '../lib/api';
import type { Item, Pillar } from '../types';
export function IngestModal({
  initialUrl,
  unlocked = true,
  onClose,
  onSaved,
  onDraft,
}: {
  initialUrl: string;
  unlocked?: boolean;
  onClose: () => void;
  onSaved: (item: Item, warnings?: string[]) => void;
  onDraft: (dirty: boolean, kind?: Pillar) => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [kind, setKind] = useState('');
  const [project, setProject] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const dirty = !!(url || kind || project || tags);
  useEffect(() => {
    onDraft(dirty || busy, kind === 'credential' ? 'credential' : undefined);
  }, [dirty, busy, kind, onDraft]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      onDraft(false);
    };
  }, [onDraft]);
  const close = () => {
    if (!busy && (!dirty || window.confirm('收录信息尚未保存，放弃这些内容？'))) onClose();
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (kind === 'credential' && !unlocked) {
      setError('金库已锁定，请先解锁后再收录 OpenAPI');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api<{ item: Item; warnings: string[] }>('/ingest', {
        method: 'POST',
        body: JSON.stringify({
          url,
          kind,
          project,
          tags: tags
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      });
      if (active.current) onSaved(result.item, result.warnings);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="收录文章、项目或 OpenAPI" onClose={close}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <p className="muted">
            粘贴来源链接，自动识别文章、GitHub 仓库和 OpenAPI 规范。文章正文与可下载图片会保存到你的工作台。
          </p>
          <label>
            目标 URL
            <input
              autoFocus
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/tokio-rs/axum"
              disabled={busy}
            />
          </label>
          <label>
            内容类型
            <select
              aria-label="内容类型"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              disabled={busy}
            >
              <option value="">自动识别</option>
              <option value="knowledge">知识与文章</option>
              <option value="repo">GitHub 仓库</option>
              <option value="credential" disabled={!unlocked}>
                OpenAPI / Swagger
              </option>
            </select>
          </label>
          <div className="form-grid">
            <label>
              所属项目
              <input value={project} onChange={(e) => setProject(e.target.value)} disabled={busy} />
            </label>
            <label>
              标签
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="用逗号分隔"
                disabled={busy}
              />
            </label>
          </div>
          <div className="ingest-examples">
            <span>试用公开来源</span>
            <button type="button" disabled={busy} onClick={() => setUrl('https://github.com/tokio-rs/axum')}>
              Axum 仓库
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setUrl('https://petstore3.swagger.io/api/v3/openapi.json')}
            >
              Petstore OpenAPI
            </button>
          </div>
          {busy && (
            <div className="info" role="status">
              <LoaderCircle className="spin" size={16} />
              <span>正在读取来源、整理正文与资源。图片较多时可能需要几分钟，请保持窗口打开。</span>
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            <Download size={14} />
            {busy ? '正在收录…' : '开始收录'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
