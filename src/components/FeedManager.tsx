import { useEffect, useRef, useState } from 'react';
import { api, downloadBlob, errorMessage, request } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useConfirm } from '../lib/confirmation';
import { Form } from './Form';

export interface Feed {
  id: string;
  url: string;
  title: string;
  siteUrl: string;
  project: string;
  tags: string[];
  enabled: boolean;
  intervalMinutes: number;
  lastCheckedAt?: string | null;
  checking: boolean;
  lastError: string;
  collected: number;
}
const intervals: [number, string][] = [
  [15, '每 15 分钟'],
  [60, '每小时'],
  [360, '每 6 小时'],
  [1440, '每天'],
  [10080, '每周'],
];

/** RSS/Atom 订阅：新文章自动进入收录队列。 */
export function FeedManager({ onChanged }: { onChanged: () => void }) {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [url, setUrl] = useState('');
  const [project, setProject] = useState('');
  const [interval, setInterval_] = useState(60);
  const [backfill, setBackfill] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [tick, setTick] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  useEffect(() => {
    const abort = new AbortController();
    const load = () =>
      api<Feed[]>('/feeds', { signal: abort.signal })
        .then((rows) => !abort.signal.aborted && setFeeds(Array.isArray(rows) ? rows : []))
        .catch((e) => !abort.signal.aborted && setError(errorMessage(e)));
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [tick]);
  async function action(work: () => Promise<string | void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const note = await work();
      if (note) setMessage(note);
      setTick((v) => v + 1);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="muted">
        订阅博客或资讯的 RSS / Atom
        地址。服务端按设定间隔检查，新文章会作为“知识”自动进入收录队列；抓取同样经过内网地址保护。
      </p>
      <Form
        className="feed-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            const result = await api<{ feed: Feed; entries: number; queued: number }>('/feeds', {
              method: 'POST',
              body: JSON.stringify({
                url: url.trim(),
                project: project.trim(),
                intervalMinutes: interval,
                backfill,
              }),
            });
            setUrl('');
            return `已订阅“${result.feed.title || result.feed.url}”：当前 ${result.entries} 篇${
              result.queued ? `，已收录最近 ${result.queued} 篇` : '，之后的新文章会自动收录'
            }。`;
          });
        }}
      >
        <label>
          订阅地址
          <input
            type="url"
            required
            placeholder="https://example.com/feed.xml"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <div className="feed-form-row">
          <label>
            归入项目
            <input value={project} placeholder="可选" onChange={(e) => setProject(e.target.value)} />
          </label>
          <label>
            检查间隔
            <select value={interval} onChange={(e) => setInterval_(Number(e.target.value))}>
              {intervals.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            立即收录
            <select value={backfill} onChange={(e) => setBackfill(Number(e.target.value))}>
              <option value={0}>只收录以后的新文章</option>
              <option value={3}>最近 3 篇</option>
              <option value={10}>最近 10 篇</option>
            </select>
          </label>
        </div>
        <div className="inline-actions">
          <button className="primary" disabled={busy || !url.trim()}>
            {busy ? '正在读取订阅源…' : '添加订阅'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const response = await request('/feeds/opml');
                downloadBlob(await response.blob(), 'infohub-feeds.opml');
              })
            }
          >
            导出 OPML
          </button>
          <button type="button" disabled={busy} onClick={() => file.current?.click()}>
            导入 OPML
          </button>
          <input
            ref={file}
            type="file"
            accept=".opml,.xml,text/xml,text/x-opml"
            hidden
            onChange={(e) => {
              const picked = e.target.files?.[0];
              e.target.value = '';
              if (!picked) return;
              void action(async () => {
                const result = await api<{ added: number; skipped: number; invalid: number }>('/feeds/opml', {
                  method: 'POST',
                  body: await picked.text(),
                });
                return `导入 ${result.added} 个订阅源${result.skipped ? `，${result.skipped} 个已存在` : ''}${
                  result.invalid ? `，${result.invalid} 个地址无效` : ''
                }。导入的订阅只收录之后的新文章。`;
              });
            }}
          />
        </div>
      </Form>
      {message && (
        <p role="status" className="info">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {feeds.map((feed) => (
        <div className="task-record" key={feed.id}>
          <div className="section-title">
            <strong>{feed.title || feed.url}</strong>
            <span className="muted">{feed.checking ? '正在检查…' : feed.enabled ? '订阅中' : '已暂停'}</span>
          </div>
          <p className="muted mono feed-url">{feed.url}</p>
          <p className="muted">
            {intervals.find(([v]) => v === feed.intervalMinutes)?.[1] ?? `每 ${feed.intervalMinutes} 分钟`} ·
            已收录 {feed.collected} 篇{feed.project ? ` · 项目：${feed.project}` : ''}
            {feed.lastCheckedAt ? ` · 上次检查 ${formatDateTime(feed.lastCheckedAt)}` : ' · 尚未检查'}
          </p>
          {feed.lastError && <p className="error">{feed.lastError}</p>}
          <div className="inline-actions">
            <button
              disabled={busy || !feed.enabled}
              onClick={() =>
                void action(async () => {
                  await api(`/feeds/${feed.id}/check`, { method: 'POST' });
                  return '已安排立即检查。';
                })
              }
            >
              立即检查
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(() =>
                  api(`/feeds/${feed.id}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                      enabled: !feed.enabled,
                      intervalMinutes: feed.intervalMinutes,
                      project: feed.project,
                      tags: feed.tags,
                    }),
                  }).then(() => undefined),
                )
              }
            >
              {feed.enabled ? '暂停' : '恢复'}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  if (
                    !(await confirm({
                      title: '取消订阅',
                      description: `取消订阅“${feed.title || feed.url}”？已收录的文章会保留。`,
                      confirmLabel: '取消订阅',
                    }))
                  )
                    return;
                  await api(`/feeds/${feed.id}`, { method: 'DELETE' });
                  return '已取消订阅，已收录的文章保留。';
                })
              }
            >
              取消订阅
            </button>
          </div>
        </div>
      ))}
      {!feeds.length && <p className="inline-empty">还没有订阅源。添加一个 RSS / Atom 地址开始自动收录。</p>}
    </>
  );
}
