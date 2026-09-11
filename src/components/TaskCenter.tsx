import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import type { Item } from '../types';
import type { Subscription } from './RepoSubscription';
import { Modal } from './Modal';
interface Job {
  id: string;
  encrypted: boolean;
  input?: { url: string; kind: string; project: string };
  output?: { title?: string; kind?: Item['kind']; error?: string; warnings?: string[] };
  itemId?: string;
  status: string;
  phase: string;
  attempts: number;
  createdAt: string;
}
const statuses: Record<string, string> = {
  queued: '排队中',
  waiting_unlock: '等待解锁',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
export function TaskCenter({
  unlocked,
  onClose,
  onOpen,
  onChanged,
}: {
  unlocked: boolean;
  onClose: () => void;
  onOpen: (item: Item) => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState('jobs');
  const [page, setPage] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        const [a, b] = await Promise.all([
          api<Job[]>(`/jobs?offset=${page * 200}`, { signal: abort.signal }),
          api<Subscription[]>('/subscriptions', { signal: abort.signal }),
        ]);
        if (!abort.signal.aborted) {
          setJobs(Array.isArray(a) ? a : []);
          setSubscriptions(Array.isArray(b) ? b : []);
          setError('');
        }
      } catch (e) {
        if (!abort.signal.aborted) setError(errorMessage(e));
      }
    }
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 3000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [tick, unlocked, page]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      setTick((v) => v + 1);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function open(id: string) {
    return action(async () => onOpen(await api<Item>('/items/' + id)));
  }
  return (
    <Modal
      title="任务与更新"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="tabs maintenance-tabs">
        <button className={tab === 'jobs' ? 'active' : ''} onClick={() => setTab('jobs')}>
          收录任务
        </button>
        <button className={tab === 'updates' ? 'active' : ''} onClick={() => setTab('updates')}>
          仓库更新 {subscriptions.filter((s) => s.unread).length || ''}
        </button>
        <button onClick={() => setTick((v) => v + 1)}>刷新</button>
      </div>
      <div className="modal-body maintenance-body">
        {tab === 'jobs' ? (
          <>
            <p className="muted">
              关闭窗口后任务会继续。服务重启后公开文章和仓库会自动恢复；自动识别和 OpenAPI
              任务需要登录解锁。取消后已经保存的资料会保留。
            </p>
            {jobs.map((job) => (
              <div className="task-record" key={job.id}>
                <div className="section-title">
                  <strong>{job.output?.title || job.input?.url || '加密收录任务'}</strong>
                  <span className={job.status === 'failed' ? 'danger-text' : 'muted'}>
                    {statuses[job.status]}
                  </span>
                </div>
                <p className="muted">
                  {job.phase} · 已执行 {job.attempts} 次 · {new Date(job.createdAt).toLocaleString()}
                </p>
                {job.output?.error && <p className="error">{job.output.error}</p>}
                {job.output?.warnings?.map((warning, i) => (
                  <p className="muted" key={i}>
                    {warning}
                  </p>
                ))}
                <div className="inline-actions">
                  {job.itemId && (
                    <button
                      disabled={busy || (job.encrypted && !unlocked)}
                      onClick={() => void open(job.itemId!)}
                    >
                      打开已收录资料
                    </button>
                  )}
                  {['queued', 'waiting_unlock', 'running'].includes(job.status) ? (
                    <button
                      disabled={busy || (job.encrypted && !unlocked)}
                      onClick={() => void action(() => api(`/jobs/${job.id}/cancel`, { method: 'POST' }))}
                    >
                      取消任务
                    </button>
                  ) : (
                    <>
                      {job.status !== 'succeeded' && (
                        <button
                          disabled={busy || (job.encrypted && !unlocked)}
                          onClick={() => void action(() => api(`/jobs/${job.id}/retry`, { method: 'POST' }))}
                        >
                          重试任务
                        </button>
                      )}
                      <button
                        disabled={busy || (job.encrypted && !unlocked)}
                        onClick={() => void action(() => api(`/jobs/${job.id}`, { method: 'DELETE' }))}
                      >
                        移除任务记录
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {!jobs.length && <p className="inline-empty">还没有收录任务。通过顶部“收录抓取”提交来源链接。</p>}
          </>
        ) : (
          <>
            {subscriptions.map((subscription) => (
              <div className="task-record" key={subscription.item_id}>
                <div className="section-title">
                  <strong>{subscription.title}</strong>
                  <span className="muted">
                    {subscription.unread ? '未读更新' : subscription.enabled ? '订阅中' : '已暂停'}
                  </span>
                </div>
                <p>
                  {subscription.snapshot.latestRelease || '暂无版本更新'}{' '}
                  {subscription.checking ? ' · 正在检查…' : ''}
                </p>
                {subscription.last_error && <p className="error">{subscription.last_error}</p>}
                <button disabled={busy} onClick={() => void open(subscription.item_id!)}>
                  打开仓库与更新
                </button>
              </div>
            ))}
            {!subscriptions.length && (
              <p className="inline-empty">在仓库详情中开启订阅，定时查看版本与代码推送。</p>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {tab === 'jobs' && (
          <div className="inline-actions">
            <button disabled={page === 0} onClick={() => setPage((v) => v - 1)}>
              上一页任务
            </button>
            <span>第 {page + 1} 页</span>
            <button disabled={jobs.length < 200} onClick={() => setPage((v) => v + 1)}>
              下一页任务
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
