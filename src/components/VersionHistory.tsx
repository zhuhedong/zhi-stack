import { useEffect, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import type { Item } from '../types';
import { Modal } from './Modal';
import { Markdown } from './Markdown';
import { useConfirm } from '../lib/confirmation';

interface Version {
  id: string;
  revision: number;
  reason: string;
  createdAt: string;
  title: string;
}
export function VersionHistory({
  item,
  onClose,
  onRestored,
}: {
  item: Item;
  onClose: () => void;
  onRestored: (item: Item) => void;
}) {
  const confirm = useConfirm(item.id);
  const [versions, setVersions] = useState<Version[]>([]);
  const [preview, setPreview] = useState<Item | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await api<Version[]>(`/items/${item.id}/versions`);
        if (alive) setVersions(result || []);
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [item.id]);
  async function inspect(id: string) {
    setBusy(true);
    setError('');
    setPreview(null);
    setSelected(id);
    try {
      setPreview(await api<Item>(`/items/${item.id}/versions/${id}`));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (
      !selected ||
      !(await confirm({
        title: '恢复历史版本',
        description: '将当前资料恢复到所选版本？当前版本会保留在版本历史中。',
        confirmLabel: '恢复版本',
      }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      onRestored(
        await api<Item>(`/items/${item.id}/versions/${selected}/restore`, {
          method: 'POST',
          body: JSON.stringify({ revision: item.revision }),
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="版本历史"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="modal-body">
        <p className="muted">
          {item.title} · 当前版本 {item.revision}。保存、同步和删除前的内容自动保留。
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {versions.length === 0 && (
          <p className="inline-empty">
            <History size={20} /> 暂无历史版本；下次修改时会保留当前内容。
          </p>
        )}
        <div className="version-list">
          {versions.map((v) => (
            <button
              key={v.id}
              disabled={busy}
              aria-pressed={selected === v.id}
              onClick={() => void inspect(v.id)}
            >
              <strong>版本 {v.revision}</strong>
              <span>
                {(
                  {
                    edit: '编辑前',
                    sync: '同步前',
                    trash: '删除前',
                    'restore-version': '恢复前',
                    'restore-trash': '移出回收站前',
                  } as Record<string, string>
                )[v.reason] || v.reason}
              </span>
              <small>{new Date(v.createdAt).toLocaleString()}</small>
            </button>
          ))}
        </div>
        {preview && (
          <section className="version-preview">
            <h3>{preview.title}</h3>
            <p className="muted">
              项目：{preview.project || '未归属'} · 标签：{preview.tags.join('、') || '无'}
            </p>
            {preview.kind === 'credential' ? (
              <p>此版本包含当时的连接字段、请求头和接口参数，始终加密保存。</p>
            ) : (
              <Markdown
                text={preview.data.content || preview.data.cookbookNotes || preview.data.readme || '暂无正文'}
              />
            )}
            <button className="primary" disabled={busy} onClick={() => void restore()}>
              <RotateCcw size={14} />
              恢复到此版本
            </button>
          </section>
        )}
      </div>
    </Modal>
  );
}
