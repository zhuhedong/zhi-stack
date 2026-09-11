import { Form } from './Form';
import { useEffect, useState } from 'react';
import { api, errorMessage, exportText } from '../lib/api';
import { usePersistentDraft } from '../lib/usePersistentDraft';
import { DraftNotice } from './DraftNotice';
import { Modal } from './Modal';
import { useConfirm } from '../lib/confirmation';
interface Usage {
  preferences: { usage_enabled: boolean; usage_since: string };
  totals: { event: string; count: number }[];
  daily: { date: string; count: number }[];
  activeDays7: number;
  reusedAssets30: number;
  firstValueSeconds: number | null;
}
interface Feedback {
  id: string;
  category: string;
  message: string;
  rating?: number;
  resolved: boolean;
  createdAt: string;
}
const categories: Record<string, string> = { usability: '使用不顺手', bug: '功能故障', idea: '改进建议' };
export function InsightsPanel({
  unlocked,
  onClose,
  onShowGuide,
  onDraft,
}: {
  unlocked: boolean;
  onClose: () => void;
  onShowGuide: () => void;
  onDraft: (dirty: boolean, kind?: 'credential') => void;
}) {
  const confirm = useConfirm();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [tick, setTick] = useState(0);
  const [tab, setTab] = useState('usage');
  const [message, setMessage] = useState('');
  const [category, setCategory] = useState('usability');
  const [rating, setRating] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const value = { message, category, rating };
  useEffect(() => {
    onDraft(!!message, 'credential');
  }, [message, onDraft]);
  useEffect(() => () => onDraft(false), [onDraft]);
  const persistence = usePersistentDraft({
    scope: 'feedback',
    kind: 'credential',
    value,
    dirty: !!message && unlocked,
    onRestore: (draft) => {
      setMessage(draft.message);
      setCategory(draft.category);
      setRating(draft.rating);
    },
  });
  useEffect(() => {
    const abort = new AbortController();
    void api<Usage>('/usage', { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted && value.preferences) setUsage(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorMessage(e));
      });
    if (unlocked)
      void api<Feedback[]>('/feedback', { signal: abort.signal })
        .then((value) => {
          if (!abort.signal.aborted) setFeedback(Array.isArray(value) ? value : []);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(errorMessage(e));
        });
    return () => abort.abort();
  }, [tick, unlocked]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      setTick((v) => v + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const count = (event: string) => usage?.totals.find((total) => total.event === event)?.count || 0;
  const max = Math.max(1, ...(usage?.daily.map((day) => day.count) || []));
  return (
    <Modal
      title="使用与反馈"
      onClose={async () => {
        if (
          !busy &&
          (!message ||
            (await confirm({
              title: '关闭反馈编辑',
              description: '反馈尚未提交，确认关闭编辑？已保存的恢复草稿会保留。',
              confirmLabel: '关闭编辑',
              cancelLabel: '继续编辑',
            })))
        )
          onClose();
      }}
      wide
    >
      <div className="tabs maintenance-tabs">
        <button className={tab === 'usage' ? 'active' : ''} onClick={() => setTab('usage')}>
          本工作台使用情况
        </button>
        <button className={tab === 'feedback' ? 'active' : ''} onClick={() => setTab('feedback')}>
          反馈记录
        </button>
      </div>
      <div className="modal-body maintenance-body">
        {tab === 'usage' && usage && (
          <>
            <p className="muted">
              统计只保存在此服务端，保留 180
              天；不记录密码、正文、搜索词、请求参数或响应。以下指标来自本工作台，不能代表其他用户或留存率。
            </p>
            <label className="search-scope">
              <input
                type="checkbox"
                checked={usage.preferences.usage_enabled}
                disabled={busy}
                onChange={(event) =>
                  void action(() =>
                    api('/usage', { method: 'PUT', body: JSON.stringify({ enabled: event.target.checked }) }),
                  )
                }
              />
              记录本工作台的使用事件
            </label>
            <div className="usage-metrics">
              {[
                ['近 7 天活跃日期', `${usage.activeDays7} 天`],
                ['近 30 天重复打开的资料', `${usage.reusedAssets30} 条`],
                ['搜索请求', `${count('search')} 次`],
                ['已完成收录任务', `${count('ingest_completed')} 次`],
                ['返回响应的调试请求', `${count('request_sent')} 次`],
                [
                  '首次价值耗时',
                  usage.firstValueSeconds === null
                    ? '暂无完整记录'
                    : `${Math.ceil(usage.firstValueSeconds / 60)} 分钟`,
                ],
              ].map(([label, text]) => (
                <div key={label}>
                  <span className="muted">{label}</span>
                  <strong>{text}</strong>
                </div>
              ))}
            </div>
            <details>
              <summary>指标口径</summary>
              <p className="muted">
                时间窗口为最近 30 天（活跃日期为 7 天），按 UTC
                日期统计。重复打开指同一资料在窗口内被打开至少两次。首次价值耗时为保留记录中首次登录到首次新建或收录完成的时间；关闭统计、清理记录、历史数据导入会影响完整性。搜索按检索接口请求计数。
              </p>
            </details>
            {!!usage.daily.length && (
              <div className="usage-days" aria-label="最近 30 天事件数量">
                {usage.daily.map((day) => (
                  <div key={day.date}>
                    <time>{day.date}</time>
                    <meter min={0} max={max} value={day.count} aria-label={`${day.date} 事件数量`} />
                    <span>{day.count}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="inline-actions">
              <button onClick={() => exportText(JSON.stringify(usage, null, 2), 'infohub-usage.json')}>
                导出统计数据
              </button>
              <button
                disabled={busy}
                onClick={async () => {
                  if (
                    await confirm({
                      title: '清空使用统计',
                      description: '清空全部使用统计？资料和阅读记录会保留，已清空的统计无法恢复。',
                      confirmLabel: '清空统计',
                      danger: true,
                    })
                  )
                    void action(() =>
                      api('/usage', { method: 'DELETE', body: JSON.stringify({ confirm: '清空统计' }) }),
                    );
                }}
              >
                清空统计
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await api('/onboarding', { method: 'PUT', body: JSON.stringify({ hidden: false }) });
                    onShowGuide();
                  })
                }
              >
                重新打开使用引导
              </button>
            </div>
          </>
        )}
        {tab === 'feedback' && (
          <>
            {unlocked ? (
              <>
                <DraftNotice draft={persistence} />
                <Form
                  className="maintenance-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action(async () => {
                      await api('/feedback', {
                        method: 'POST',
                        body: JSON.stringify({ message, category, rating: rating ? Number(rating) : null }),
                      });
                      await persistence.clear(value);
                      setMessage('');
                      setRating('');
                    });
                  }}
                >
                  <p className="muted">反馈加密保存在本工作台。导出后可自行分享给维护者。</p>
                  <label>
                    问题类型
                    <select
                      value={category}
                      disabled={busy}
                      onChange={(event) => setCategory(event.target.value)}
                    >
                      {Object.entries(categories).map(([key, name]) => (
                        <option key={key} value={key}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    反馈内容
                    <textarea
                      required
                      value={message}
                      disabled={busy}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder="当时要完成什么、遇到了什么、希望如何改进"
                    />
                  </label>
                  <label>
                    本次使用评分
                    <select
                      value={rating}
                      disabled={busy}
                      onChange={(event) => setRating(event.target.value)}
                    >
                      <option value="">暂不评分</option>
                      {[1, 2, 3, 4, 5].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <button className="primary" disabled={busy || !message.trim()}>
                    保存反馈
                  </button>
                </Form>
                <button
                  disabled={!feedback.length}
                  onClick={() => exportText(JSON.stringify(feedback, null, 2), 'infohub-feedback.json')}
                >
                  导出反馈记录
                </button>
                {feedback.map((entry) => (
                  <div className="task-record" key={entry.id}>
                    <div className="section-title">
                      <strong>
                        {categories[entry.category]} · {entry.resolved ? '已解决' : '待处理'}
                      </strong>
                      <small>{new Date(entry.createdAt).toLocaleString()}</small>
                    </div>
                    <p className="feedback-message">{entry.message}</p>
                    <div className="inline-actions">
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(() =>
                            api(`/feedback/${entry.id}`, {
                              method: 'PUT',
                              body: JSON.stringify({ resolved: !entry.resolved }),
                            }),
                          )
                        }
                      >
                        {entry.resolved ? '重新打开' : '标记已解决'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: '删除反馈',
                              description: '删除这条反馈记录？删除后无法恢复。',
                              confirmLabel: '删除反馈',
                              danger: true,
                            })
                          )
                            void action(() => api(`/feedback/${entry.id}`, { method: 'DELETE' }));
                        }}
                      >
                        删除反馈
                      </button>
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <p className="info">解锁密码库后可编辑和查看加密反馈。</p>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
