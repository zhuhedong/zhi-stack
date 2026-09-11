import { Form } from './Form';
import { useEffect, useState, type FormEvent } from 'react';
import { ArchiveRestore, Download, KeyRound, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { api, downloadBlob, errorMessage, request, setToken } from '../lib/api';
import type { Item } from '../types';
import { Modal } from './Modal';

interface Run {
  id: string;
  operation: string;
  status: string;
  size: number | null;
  created_at: string;
  message: string;
}
export function RestoreForm({
  initialized,
  onRestored,
  onBusy,
}: {
  initialized: boolean;
  onRestored: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function restore(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    onBusy?.(true);
    setError('');
    const data = new FormData();
    data.set('password', password);
    data.set('currentPassword', current);
    data.set('confirm', confirm);
    data.set('backup', file);
    try {
      await api('/backup/restore', { method: 'POST', body: data });
      setToken('');
      setPassword('');
      setCurrent('');
      // Local non-sensitive draft caches belong to the previous database state.
      for (const key of Object.keys(localStorage))
        if (key.startsWith('infohub:draft:')) localStorage.removeItem(key);
      onRestored();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  }
  return (
    <Form onSubmit={restore} className="maintenance-form">
      <fieldset disabled={busy}>
        <legend>从完整备份恢复</legend>
        <p className="muted">
          {initialized
            ? '恢复会替换当前工作台，请先下载当前数据的备份。'
            : '将文章、凭证、附件和历史版本恢复到这个工作台。'}{' '}
          文件和记录全部校验成功后才会提交。
        </p>
        <label>
          备份文件
          <input
            type="file"
            accept=".infohub"
            required
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <label>
          备份时的主密码
          <input
            type="password"
            autoComplete="off"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {initialized && (
          <label>
            当前工作台主密码
            <input
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
        )}
        <label>
          输入“恢复并替换”确认
          <input value={confirm} required pattern="恢复并替换" onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="danger" disabled={!file || confirm !== '恢复并替换'}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <ArchiveRestore size={14} />}
          {busy ? '正在校验并恢复…' : '恢复备份'}
        </button>
      </fieldset>
    </Form>
  );
}

export function DataManager({
  onClose,
  onChanged,
  onRestored,
}: {
  onClose: () => void;
  onChanged: () => void;
  onRestored: () => void;
}) {
  const [tab, setTab] = useState('backup');
  const [runs, setRuns] = useState<Run[]>([]);
  const [trash, setTrash] = useState<Item[]>([]);
  const [password, setPassword] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [purge, setPurge] = useState<Item | null>(null);
  const [purgeText, setPurgeText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function load() {
    try {
      if (tab === 'backup') setRuns((await api<Run[]>('/backup/runs')) || []);
      if (tab === 'trash') setTrash((await api<Item[]>('/trash')) || []);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    if (tab === 'backup')
      void api<Run[]>('/backup/runs', { signal: abort.signal })
        .then((value) => {
          if (!abort.signal.aborted) setRuns(Array.isArray(value) ? value : []);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(errorMessage(e));
        });
    if (tab === 'trash')
      void api<Item[]>('/trash', { signal: abort.signal })
        .then((value) => {
          if (!abort.signal.aborted) setTrash(Array.isArray(value) ? value : []);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(errorMessage(e));
        });
    return () => abort.abort();
  }, [tab]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="数据与安全"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="tabs maintenance-tabs" role="tablist" aria-label="数据管理">
        {Object.entries({ backup: '备份与恢复', trash: '回收站', security: '主密码' }).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            disabled={busy}
            onClick={() => {
              setTab(key);
              setError('');
              setMessage('');
              setPassword('');
              setNext('');
              setConfirm('');
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="modal-body maintenance-body" aria-busy={busy}>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="info">
            {message}
          </p>
        )}
        {tab === 'backup' && (
          <>
            <Form
              className="maintenance-form"
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  const response = await request('/backup/export', {
                    method: 'POST',
                    body: JSON.stringify({ password }),
                  });
                  downloadBlob(
                    await response.blob(),
                    `infohub-${new Date().toISOString().slice(0, 10)}.infohub`,
                  );
                  setPassword('');
                  setMessage('备份已校验并开始下载。请确认浏览器已完成保存，并保管好备份时的主密码。');
                  await load();
                });
              }}
            >
              <h3>完整加密备份</h3>
              <p className="muted">
                包含全部资产、图片、附件、版本和草稿。备份可恢复到新的服务器和文件存储。
              </p>
              <label>
                当前主密码
                <input
                  type="password"
                  value={password}
                  required
                  autoComplete="current-password"
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <button className="primary" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}下载完整备份
              </button>
            </Form>
            <div className="run-list">
              <h3>最近操作</h3>
              {runs.length === 0 ? (
                <p className="muted">还没有备份记录。</p>
              ) : (
                runs.map((run) => (
                  <div className="maintenance-row" key={run.id}>
                    <span>
                      {run.operation === 'backup' ? '备份' : '恢复'} ·{' '}
                      {new Date(run.created_at).toLocaleString()}
                    </span>
                    <strong>
                      {
                        (
                          {
                            success: '已完成',
                            running: '处理中',
                            failed: '失败',
                            interrupted: '已中断',
                          } as Record<string, string>
                        )[run.status]
                      }
                    </strong>
                  </div>
                ))
              )}
            </div>
            <RestoreForm initialized onRestored={onRestored} onBusy={setBusy} />
          </>
        )}
        {tab === 'trash' && (
          <>
            <p className="muted">删除的资产保留正文、附件和历史版本。恢复后返回原项目；永久删除无法撤销。</p>
            <button disabled={busy} onClick={() => void load()}>
              <RefreshCw size={13} />
              刷新回收站
            </button>
            {trash.length === 0 && <p className="inline-empty">回收站为空。</p>}
            {trash.map((item) => (
              <div className="maintenance-row" key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <p className="muted">
                    {item.project || '未归属项目'} · {new Date(item.updatedAt).toLocaleString()}
                  </p>
                </div>
                <div className="inline-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api(`/trash/${item.id}/restore`, { method: 'POST' });
                        await load();
                        onChanged();
                        setMessage('资产已恢复。');
                      })
                    }
                  >
                    <ArchiveRestore size={13} />
                    恢复
                  </button>
                  <button
                    disabled={busy}
                    className="danger-text"
                    onClick={() => {
                      setPurge(item);
                      setPurgeText('');
                    }}
                  >
                    <Trash2 size={13} />
                    永久删除
                  </button>
                </div>
              </div>
            ))}
            {purge && (
              <Form
                className="maintenance-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    await api(`/trash/${purge.id}`, {
                      method: 'DELETE',
                      body: JSON.stringify({ confirm: purgeText }),
                    });
                    setPurge(null);
                    await load();
                    onChanged();
                  });
                }}
              >
                <p>永久删除「{purge.title}」及全部附件、图片和版本？</p>
                <label>
                  输入“永久删除”确认
                  <input
                    required
                    pattern="永久删除"
                    value={purgeText}
                    onChange={(e) => setPurgeText(e.target.value)}
                  />
                </label>
                <div className="inline-actions">
                  <button type="button" disabled={busy} onClick={() => setPurge(null)}>
                    取消
                  </button>
                  <button className="danger" disabled={busy || purgeText !== '永久删除'}>
                    确认永久删除
                  </button>
                </div>
              </Form>
            )}
          </>
        )}
        {tab === 'security' && (
          <Form
            className="maintenance-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (next !== confirm) {
                setError('两次新密码不一致');
                return;
              }
              void action(async () => {
                const result = await api<{ token: string }>('/vault/password', {
                  method: 'POST',
                  body: JSON.stringify({ currentPassword: password, newPassword: next }),
                });
                setToken(result.token);
                setPassword('');
                setNext('');
                setConfirm('');
                setMessage(
                  '主密码已更换，凭证、附件、历史和草稿已重新加密，其他会话已退出。以前的备份仍使用备份时的密码。',
                );
              });
            }}
          >
            <h3>更换主密码</h3>
            <p className="muted">全部加密数据校验成功后才会切换密码。操作过程中请保持页面打开。</p>
            <label>
              当前主密码
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              新主密码
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={next}
                disabled={busy}
                onChange={(e) => setNext(e.target.value)}
              />
            </label>
            <label>
              再次输入新主密码
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={confirm}
                disabled={busy}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            <button className="primary" disabled={busy}>
              <KeyRound size={14} />
              {busy ? '正在重新加密…' : '更换主密码'}
            </button>
          </Form>
        )}
      </div>
    </Modal>
  );
}
