import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';
import type { CompiledRequest } from './request';
import type { ProbeResult } from '../types';

export function useProbe(itemId: string) {
  const active = useRef<{ id: string; abort: AbortController } | null>(null);
  const generation = useRef(0);
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<ProbeResult | null>(null);
  const [error, setError] = useState('');
  const [finished, setFinished] = useState(0);
  function stop() {
    generation.current++;
    const running = active.current;
    active.current = null;
    if (!running) return Promise.resolve();
    running.abort.abort();
    return api(`/items/${itemId}/requests/${running.id}/cancel`, { method: 'POST' });
  }
  useEffect(
    () => () => {
      generation.current++;
      const running = active.current;
      if (running) {
        running.abort.abort();
        void api(`/items/${itemId}/requests/${running.id}/cancel`, { method: 'POST' }).catch(() => {});
        active.current = null;
      }
    },
    [itemId],
  );
  async function run(request: CompiledRequest, environment = '默认') {
    if (active.current) return;
    const token = ++generation.current;
    const current = { id: crypto.randomUUID(), abort: new AbortController() };
    active.current = current;
    setSending(true);
    setError('');
    setResponse(null);
    try {
      const result = await api<ProbeResult>('/probe', {
        method: 'POST',
        signal: current.abort.signal,
        body: JSON.stringify({ ...request, itemId, requestId: current.id, environment }),
      });
      if (generation.current === token) setResponse(result);
    } catch (e) {
      if (generation.current === token) setError(errorMessage(e));
    } finally {
      if (generation.current === token) {
        active.current = null;
        setSending(false);
        setFinished((v) => v + 1);
      }
    }
  }
  function cancel() {
    const operation = stop();
    const token = generation.current;
    setSending(false);
    setResponse(null);
    setError('已停止等待；已送达目标服务的操作无法撤回。');
    void operation
      .then(() => {
        if (generation.current === token) setFinished((v) => v + 1);
      })
      .catch((e) => {
        if (generation.current === token) setError('已停止本地等待，服务端取消未确认：' + errorMessage(e));
      });
  }
  function reset() {
    const operation = stop();
    setSending(false);
    setResponse(null);
    setError('');
    void operation.catch(() => {});
  }
  return { sending, response, error, finished, run, cancel, reset };
}
