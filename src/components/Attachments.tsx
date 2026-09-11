import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Download, File, LoaderCircle, Paperclip, Trash2 } from 'lucide-react';
import type { Attachment } from '../types';
import { sizeLabel } from '../types';
import { api, downloadBlob, errorMessage, request } from '../lib/api';
export function Attachments({ id }: { id: string }) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const uploadAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    api<Attachment[]>(`/items/${id}/attachments`, { signal: abort.signal })
      .then((v) => {
        if (active) setFiles(v);
      })
      .catch((e) => {
        if (active && !abort.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      abort.abort();
      uploadAbort.current?.abort();
    };
  }, [id]);
  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files || []);
    e.target.value = '';
    if (!chosen.length) return;
    const itemId = id;
    const controller = new AbortController();
    uploadAbort.current?.abort();
    uploadAbort.current = controller;
    setBusy(true);
    setError('');
    try {
      for (const file of chosen) {
        if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB`);
        const body = new FormData();
        body.append('file', file);
        const saved = await api<Attachment>(`/items/${itemId}/attachments`, {
          method: 'POST',
          body,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setFiles((v) => [saved, ...v]);
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function download(file: Attachment) {
    setBusy(true);
    try {
      downloadBlob(await (await request(`/attachments/${file.id}`)).blob(), file.name);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(file: Attachment) {
    if (!window.confirm(`永久删除附件“${file.name}”？`)) return;
    setBusy(true);
    try {
      await api(`/attachments/${file.id}`, { method: 'DELETE' });
      setFiles((v) => v.filter((f) => f.id !== file.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="attachments">
      <div className="section-title">
        <h3>
          附件与白皮书 <span className="muted">{files.length}</span>
        </h3>
        <label className={`button primary ${busy ? 'disabled' : ''}`}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <Paperclip size={14} />}挂载附件
          <input type="file" multiple className="sr-only" disabled={busy} onChange={upload} />
        </label>
      </div>
      <p className="form-hint">单个文件最多 10 MB。凭证附件随密码库一同加密。</p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <p className="muted">正在读取附件…</p>
      ) : files.length === 0 ? (
        <div className="inline-empty">还没有附件，可添加接口文档、配置说明或白皮书。</div>
      ) : (
        <div className="file-list">
          {files.map((file) => (
            <div className="file-row" key={file.id}>
              <File size={18} />
              <div>
                <strong>{file.name}</strong>
                <small>{sizeLabel(file.size)}</small>
              </div>
              <button
                className="icon-button"
                disabled={busy}
                aria-label={`下载 ${file.name}`}
                onClick={() => void download(file)}
              >
                <Download size={15} />
              </button>
              <button
                className="icon-button danger-text"
                disabled={busy}
                aria-label={`删除 ${file.name}`}
                onClick={() => void remove(file)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
