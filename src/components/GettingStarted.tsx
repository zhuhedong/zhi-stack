import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
interface Progress {
  hidden: boolean;
  created: boolean;
  organized: boolean;
  reused: boolean;
}
export function GettingStarted({
  tick,
  onIngest,
  onProjects,
  onSearch,
}: {
  tick: number;
  onIngest: () => void;
  onProjects: () => void;
  onSearch: () => void;
}) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    void api<Progress>('/onboarding', { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted && typeof value.created === 'boolean') setProgress(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorMessage(e));
      });
    return () => abort.abort();
  }, [tick]);
  if (!progress || progress.hidden) return null;
  const steps = [
    { done: progress.created, title: '收录第一条资料', action: onIngest },
    { done: progress.organized, title: '归入手头的项目', action: onProjects },
    { done: progress.reused, title: '再次找到并打开', action: onSearch },
  ];
  const complete = steps.every((step) => step.done);
  async function hide() {
    try {
      await api('/onboarding', { method: 'PUT', body: JSON.stringify({ hidden: true }) });
      setProgress((value) => (value ? { ...value, hidden: true } : value));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <aside className="getting-started" aria-label="首次使用引导">
      <strong>{complete ? '已完成首次工作流' : '开始使用工作台'}</strong>
      <div className="getting-started-steps">
        {steps.map((step, index) => (
          <button key={step.title} onClick={step.action} className={step.done ? 'good' : ''}>
            {step.done ? <Check size={13} /> : <span>{index + 1}</span>}
            {step.title}
          </button>
        ))}
      </div>
      <button className="icon-button" aria-label="收起首次使用引导" onClick={() => void hide()}>
        <X size={13} />
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
