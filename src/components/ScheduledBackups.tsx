import { useEffect, useState } from 'react';
import { CalendarClock, RotateCcw, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { sizeLabel } from '../types';
import { useConfirm } from '../lib/confirmation';

interface Status {
  schedule: {
    enabled: boolean;
    intervalHours: number;
    keep: number;
    targets: string[];
    nextRunAt: string;
    lastRunAt?: string | null;
    lastStatus: string;
    lastMessage: string;
    running: boolean;
    hasKey: boolean;
  };
  backups: { id: string; target: string; name: string; size: number; createdAt: string }[];
  storage: string;
  dirAvailable: boolean;
  serviceKey: boolean;
}
const intervals: [number, string][] = [
  [6, '每 6 小时'],
  [12, '每 12 小时'],
  [24, '每天'],
  [72, '每 3 天'],
  [168, '每周'],
];

/** 定时自动备份: schedule, status, list and restore. */
export function ScheduledBackups({ onRestored }: { onRestored: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [form, setForm] = useState({ enabled: false, intervalHours: 24, keep: 7, targets: ['storage'] });
  const [password, setPassword] = useState('');
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restore, setRestore] = useState({ currentPassword: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [tick, setTick] = useState(0);
  const confirm = useConfirm();
  useEffect(() => {
    let live = true;
    const load = () =>
      api<Status>('/backup/schedule')
        .then((value) => {
          if (!live) return;
          setStatus(value);
          if (tick === 0) setForm(value.schedule);
        })
        .catch((e) => live && setError(errorMessage(e)));
    void load();
    const timer = window.setInterval(() => !document.hidden && void load(), 5000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [tick]);
  async function act(work: () => Promise<string | void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const note = await work();
      if (note) setMessage(note);
      setTick((v) => v + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!status) return error ? <p className="error">{error}</p> : null;
  const s = status.schedule;
  const needsPassword = form.enabled && !s.hasKey;
  const toggleTarget = (target: string, on: boolean) =>
    setForm({
      ...form,
      targets: on ? [...new Set([...form.targets, target])] : form.targets.filter((t) => t !== target),
    });
  return (
    <section className="scheduled-backups">
      <div className="section-title">
        <h3>
          <CalendarClock size={14} /> 定时自动备份
        </h3>
        <span className={s.lastStatus === 'failed' ? 'danger-text' : s.enabled ? 'good' : 'muted'}>
          {s.running ? '正在备份…' : s.enabled ? '已启用' : '未启用'}
        </span>
      </div>
      <p className="muted">
        服务端按间隔生成与手动备份相同格式的加密备份，并自动清理超出保留份数的旧备份。备份使用启用（或最近一次修改主密码）时的主密码加密；主密码派生的密钥由服务端服务密钥再加密保存，不保存主密码本身。
      </p>
      {!status.serviceKey && (
        <p className="error">
          服务端无法读取或创建服务密钥（INFOHUB_SERVICE_KEY / 密钥文件），定时备份不可用。
        </p>
      )}
      <div className="feed-form-row">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          启用定时备份
        </label>
        <label>
          间隔
          <select
            value={form.intervalHours}
            onChange={(e) => setForm({ ...form, intervalHours: Number(e.target.value) })}
          >
            {intervals.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          保留份数
          <input
            type="number"
            min={1}
            max={100}
            value={form.keep}
            onChange={(e) => setForm({ ...form, keep: Number(e.target.value) })}
          />
        </label>
      </div>
      <div className="feed-form-row">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.targets.includes('storage')}
            onChange={(e) => toggleTarget('storage', e.target.checked)}
          />
          文件存储（{status.storage === 'r2' ? 'Cloudflare R2' : '服务器本地文件存储'}）
        </label>
        <label className="checkbox-row" title={status.dirAvailable ? '' : '服务端需配置 BACKUP_DIR'}>
          <input
            type="checkbox"
            disabled={!status.dirAvailable}
            checked={form.targets.includes('dir')}
            onChange={(e) => toggleTarget('dir', e.target.checked)}
          />
          本地目录 BACKUP_DIR{status.dirAvailable ? '' : '（未配置）'}
        </label>
      </div>
      <label>
        主密码{needsPassword ? '（首次启用必填）' : '（可选，填写后用当前主密码重新生成备份密钥）'}
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <div className="inline-actions">
        <button
          className="primary"
          disabled={busy || (needsPassword && !password) || !form.targets.length}
          onClick={() =>
            void act(async () => {
              await api('/backup/schedule', { method: 'PUT', body: JSON.stringify({ ...form, password }) });
              setPassword('');
              return form.enabled ? '定时备份设置已保存。' : '已停用定时备份。';
            })
          }
        >
          保存设置
        </button>
        <button
          disabled={busy || !s.hasKey || s.running}
          onClick={() =>
            void act(async () => {
              await api('/backup/schedule/run', { method: 'POST' });
              return '已开始备份，完成后会出现在下方列表。';
            })
          }
        >
          立即备份
        </button>
      </div>
      <p className="muted">
        {s.lastRunAt
          ? `上次：${formatDateTime(s.lastRunAt)}（${s.lastStatus === 'success' ? '成功' : '失败'}）`
          : '尚未执行'}
        {s.lastMessage ? ` · ${s.lastMessage}` : ''}
        {s.enabled ? ` · 下次：${formatDateTime(s.nextRunAt)}` : ''}
      </p>
      {message && (
        <p className="info" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status.backups.map((b) => (
        <div className="task-record" key={b.id}>
          <div className="section-title">
            <strong>{formatDateTime(b.createdAt)}</strong>
            <span className="muted">
              {b.target === 'storage' ? (status.storage === 'r2' ? 'R2' : '文件存储') : 'BACKUP_DIR'} ·{' '}
              {sizeLabel(b.size)}
            </span>
          </div>
          {restoring === b.id ? (
            <div className="feed-form">
              <label>
                当前主密码
                <input
                  type="password"
                  value={restore.currentPassword}
                  onChange={(e) => setRestore({ ...restore, currentPassword: e.target.value })}
                />
              </label>
              <label>
                备份时的主密码
                <input
                  type="password"
                  value={restore.password}
                  onChange={(e) => setRestore({ ...restore, password: e.target.value })}
                />
              </label>
              <label>
                输入“恢复并替换”确认
                <input
                  value={restore.confirm}
                  onChange={(e) => setRestore({ ...restore, confirm: e.target.value })}
                />
              </label>
              <div className="inline-actions">
                <button
                  className="danger"
                  disabled={
                    busy || restore.confirm !== '恢复并替换' || !restore.password || !restore.currentPassword
                  }
                  onClick={() =>
                    void act(async () => {
                      await api(`/backup/scheduled/${b.id}/restore`, {
                        method: 'POST',
                        body: JSON.stringify(restore),
                      });
                      onRestored();
                    })
                  }
                >
                  恢复并替换当前数据
                </button>
                <button onClick={() => setRestoring(null)}>取消</button>
              </div>
            </div>
          ) : (
            <div className="inline-actions">
              <button
                disabled={busy}
                onClick={() => {
                  setRestore({ currentPassword: '', password: '', confirm: '' });
                  setRestoring(b.id);
                }}
              >
                <RotateCcw size={13} /> 从此备份恢复
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (
                      !(await confirm({
                        title: '删除备份',
                        description: '删除这份定时备份文件？',
                        confirmLabel: '删除',
                      }))
                    )
                      return;
                    await api(`/backup/scheduled/${b.id}`, { method: 'DELETE' });
                  })
                }
              >
                <Trash2 size={13} /> 删除
              </button>
            </div>
          )}
        </div>
      ))}
      {!status.backups.length && <p className="inline-empty">还没有定时备份。</p>}
    </section>
  );
}
