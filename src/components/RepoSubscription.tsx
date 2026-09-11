import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Markdown } from './Markdown';
import { SourceLink } from './SourceLink';

export interface Subscription {
  item_id?: string;
  title?: string;
  enabled: boolean;
  interval_hours: number;
  revision: number;
  next_check_at?: string;
  last_checked_at?: string;
  checking?: boolean;
  last_error?: string;
  unread: boolean;
  signature?: string;
  snapshot: { latestRelease?: string; releaseNotes?: string; releaseUrl?: string; pushedAt?: string };
}
interface Check {
  id: string;
  status: string;
  message: string;
  created_at: string;
}
export function RepoSubscription({ itemId }: { itemId: string }) {
  const [data, setData] = useState<{ subscription: Subscription; checks: Check[] } | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        const value = await api<{ subscription: Subscription; checks: Check[] }>(
          `/items/${itemId}/subscription`,
          { signal: abort.signal },
        );
        if (!abort.signal.aborted && value.subscription) setData(value);
      } catch (e) {
        if (!abort.signal.aborted) setError(errorMessage(e));
      }
    }
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [itemId, tick]);
  async function action(path: string, body?: object, method = 'POST') {
    setBusy(true);
    setError('');
    try {
      await api(`/items/${itemId}/subscription${path}`, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      setTick((v) => v + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const subscription = data?.subscription;
  return (
    <section className="repo-subscription">
      <div className="section-title">
        <h3>仓库更新订阅 {subscription?.unread && <span className="badge repo">有未读更新</span>}</h3>
        <button
          disabled={!subscription || busy}
          onClick={() => {
            if (subscription)
              void action(
                '',
                {
                  enabled: !subscription.enabled,
                  intervalHours: subscription.interval_hours,
                  revision: subscription.revision,
                },
                'PUT',
              );
          }}
        >
          {subscription?.enabled ? '暂停订阅' : '订阅更新'}
        </button>
      </div>
      <p className="muted">
        服务端定时检查版本和代码推送，更新记录独立保存。需要更新 README 时，可使用顶部同步。
      </p>
      {subscription?.enabled && (
        <div className="inline-actions">
          <label>
            检查间隔
            <select
              aria-label="检查间隔"
              disabled={busy}
              value={subscription.interval_hours}
              onChange={(event) =>
                void action(
                  '',
                  {
                    enabled: true,
                    intervalHours: Number(event.target.value),
                    revision: subscription.revision,
                  },
                  'PUT',
                )
              }
            >
              {[1, 6, 12, 24, 72, 168].map((hours) => (
                <option key={hours} value={hours}>
                  {hours} 小时
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy || subscription.checking} onClick={() => void action('/check')}>
            {subscription.checking ? '正在检查…' : '立即检查'}
          </button>
        </div>
      )}
      {subscription?.last_checked_at && (
        <p className="muted">
          上次检查：{new Date(subscription.last_checked_at).toLocaleString()}
          {subscription.enabled && subscription.next_check_at
            ? ` · 下次：${new Date(subscription.next_check_at).toLocaleString()}`
            : ''}
        </p>
      )}
      {subscription?.last_error && <p className="error">{subscription.last_error}</p>}
      {subscription?.unread && (
        <div className="subscription-update">
          <div className="section-title">
            <strong>{subscription.snapshot.latestRelease || '代码有新推送'}</strong>
            <button
              disabled={busy}
              onClick={() => void action('/seen', { signature: subscription.signature })}
            >
              标记这次更新已读
            </button>
          </div>
          {subscription.snapshot.pushedAt && (
            <p className="muted">最近推送：{new Date(subscription.snapshot.pushedAt).toLocaleString()}</p>
          )}
          {subscription.snapshot.releaseUrl && (
            <SourceLink href={subscription.snapshot.releaseUrl}>查看发布页面</SourceLink>
          )}
          {subscription.snapshot.releaseNotes && <Markdown text={subscription.snapshot.releaseNotes} />}
        </div>
      )}
      {!!data?.checks.length && (
        <details>
          <summary>最近检查记录（保留 100 次，展示最近 20 次）</summary>
          {data.checks.map((check) => (
            <p className="muted" key={check.id}>
              {new Date(check.created_at).toLocaleString()} ·{' '}
              {check.status === 'success' ? '成功' : check.status === 'partial' ? '部分成功' : '失败'}{' '}
              {check.message}
            </p>
          ))}
        </details>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
          <button onClick={() => setTick((v) => v + 1)}>刷新</button>
        </p>
      )}
    </section>
  );
}
