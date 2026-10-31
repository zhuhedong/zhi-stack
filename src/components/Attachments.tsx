import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Download, Eye, File, LoaderCircle, Paperclip, Trash2, X } from 'lucide-react';
import type { Attachment } from '../types';
import { sizeLabel } from '../types';
import { api, downloadBlob, errorMessage, request } from '../lib/api';
import { useConfirm } from '../lib/confirmation';
export function Attachments({ id }: { id: string }) {
  const confirm = useConfirm(id);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<
    { file: Attachment; text: string; url: string; kind: 'text' | 'image' | 'pdf' } | null
  >(null);
  const uploadAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);
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
  function canPreview(file: Attachment) {
    return file.mime.startsWith('text/') || file.mime === 'application/json' || file.mime === 'application/pdf' || file.mime.startsWith('image/');
  }
  async function previewFile(file: Attachment) {
    if (!canPreview(file)) return;
    setBusy(true);
    setError('');
    try {
      const response = await request(`/attachments/${file.id}/preview`);
      if (file.mime.startsWith('text/') || file.mime === 'application/json') {
        setPreview({ file, text: await response.text(), url: '', kind: 'text' });
      } else {
        const kind = file.mime === 'application/pdf' ? 'pdf' : 'image';
        setPreview({ file, text: '', url: URL.createObjectURL(await response.blob()), kind });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
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
    const uploaded: Attachment[] = [];
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
        uploaded.push(saved);
        if (!controller.signal.aborted) setFiles((v) => [saved, ...v]);
      }
    } catch (error) {
      // A multi-file selection is presented as one operation. Remove files
      // that already reached the server when a later file fails, so a failed
      // batch does not silently leave a half-uploaded set behind.
      const rollback = await Promise.allSettled(
        uploaded.map((file) => api(`/attachments/${file.id}`, { method: 'DELETE' })),
      );
      const rollbackFailed = rollback.some((result) => result.status === 'rejected');
      if (uploaded.length) {
        const ids = new Set(uploaded.map((file) => file.id));
        setFiles((current) => current.filter((file) => !ids.has(file.id)));
      }
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        if (rollbackFailed) setError('上传已停止，但部分附件未能自动回滚，请检查附件列表。');
        return;
      }
      if (rollbackFailed) {
        setError('上传失败，部分附件未能自动回滚，请检查附件列表。');
        return;
      }
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
    if (
      !(await confirm({
        title: '删除附件',
        description: `永久删除附件「${file.name}」？删除后无法恢复。`,
        confirmLabel: '删除附件',
        danger: true,
      }))
    )
      return;
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
              {canPreview(file) && (
                <button
                  className="icon-button"
                  disabled={busy}
                  aria-label={`预览 ${file.name}`}
                  onClick={() => void previewFile(file)}
                >
                  <Eye size={15} />
                </button>
              )}
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
      {preview && (
        <section className="attachment-preview" aria-label={`预览 ${preview.file.name}`}>
          <div className="section-title">
            <h4>{preview.file.name}</h4>
            <button className="icon-button" aria-label="关闭预览" onClick={() => setPreview(null)}>
              <X size={15} />
            </button>
          </div>
          {preview.kind === 'text' ? (
            <pre>{preview.text}</pre>
          ) : preview.kind === 'image' ? (
            <img src={preview.url} alt={preview.file.name} />
          ) : (
            <iframe title={preview.file.name} src={preview.url} />
          )}
        </section>
      )}
    </section>
  );
}
