import { useCallback, useEffect, useRef, useState } from 'react';
import { api, API_BASE, errorMessage } from './api';
import type { Pillar } from '../types';

interface Stored<T> {
  payload: T;
  baseRevision?: number;
  generation: number;
  updatedAt: string;
}
interface Context {
  generation: number;
  queue: Promise<void>;
  savedSignature: string;
}
interface DraftState<T> {
  id: string;
  ready: boolean;
  recovery: Stored<T> | null;
  status: string;
  error: string;
}
function deviceId() {
  try {
    let id = localStorage.getItem('infohub:draft-device');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('infohub:draft-device', id);
    }
    return id;
  } catch {
    return 'browser';
  }
}
export function usePersistentDraft<T>({
  scope,
  kind,
  itemId,
  revision,
  value,
  dirty,
  onRestore,
}: {
  scope: string;
  kind: Pillar;
  itemId?: string;
  revision?: number;
  value: T;
  dirty: boolean;
  onRestore: (value: T) => void;
}) {
  const [device] = useState(deviceId);
  const id = `${device}:${scope}:${kind}`;
  const key = `infohub:draft:${API_BASE}:${id}`;
  const path = `/drafts/${encodeURIComponent(id)}`;
  const signature = JSON.stringify(value);
  const latest = useRef({ id, signature });
  const contexts = useRef(new Map<string, Context>());
  const active = useRef(false);
  const [state, setState] = useState<DraftState<T>>({
    id: '',
    ready: false,
    recovery: null,
    status: '',
    error: '',
  });
  const [retry, setRetry] = useState(0);
  const ready = state.id === id && state.ready;
  const recovery = state.id === id ? state.recovery : null;
  const getContext = useCallback(() => {
    let context = contexts.current.get(id);
    if (!context) {
      context = { generation: 0, queue: Promise.resolve(), savedSignature: '' };
      contexts.current.set(id, context);
    }
    return context;
  }, [id]);
  const update = useCallback(
    (patch: Partial<DraftState<T>>) => {
      if (active.current && latest.current.id === id)
        setState((previous) => ({
          ...(previous.id === id ? previous : { id, ready: false, recovery: null, status: '', error: '' }),
          ...patch,
        }));
    },
    [id],
  );
  useEffect(() => {
    latest.current = { id, signature };
  }, [id, signature]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    const context = getContext();
    void (async () => {
      let cached: Stored<T> | null = null;
      if (kind !== 'credential') {
        try {
          cached = JSON.parse(localStorage.getItem(key) || 'null') as Stored<T> | null;
        } catch {
          /* Storage may be disabled. */
        }
      }
      let candidate = cached;
      let error = '';
      try {
        const result = await api<Stored<T>>(path);
        if (!current) return;
        const remote =
          result && typeof result.generation === 'number' && 'payload' in result ? result : undefined;
        context.generation = remote?.generation ?? 0;
        candidate =
          cached && (!remote || Date.parse(cached.updatedAt) > Date.parse(remote.updatedAt))
            ? cached
            : (remote ?? null);
      } catch (e) {
        if ((e as { status?: number }).status !== 404) error = '读取恢复草稿失败：' + errorMessage(e);
      }
      if (current)
        update({
          ready: true,
          recovery:
            candidate && JSON.stringify(candidate.payload) !== latest.current.signature ? candidate : null,
          error,
          status: '',
        });
    })();
    return () => {
      current = false;
    };
  }, [getContext, key, path, kind, update]);

  useEffect(() => {
    const context = getContext();
    if (!dirty || signature === context.savedSignature || recovery) return;
    // Credentials/Headers never enter localStorage. Their server copies are encrypted.
    let cacheError = '';
    if (kind !== 'credential') {
      try {
        localStorage.setItem(
          key,
          JSON.stringify({
            payload: JSON.parse(signature),
            baseRevision: revision,
            generation: context.generation,
            updatedAt: new Date().toISOString(),
          }),
        );
      } catch {
        cacheError = '本机草稿缓存不可用，已尝试保存到服务端。';
      }
    }
    if (!ready) return;
    const timer = setTimeout(() => {
      update({ status: '正在保存恢复草稿…' });
      context.queue = context.queue.then(async () => {
        if (signature === context.savedSignature) return;
        try {
          const result = await api<{ generation: number }>(path, {
            method: 'PUT',
            body: JSON.stringify({
              kind,
              itemId,
              baseRevision: revision,
              payload: JSON.parse(signature),
              generation: context.generation,
            }),
          });
          if (result) context.generation = result.generation;
          update({ status: '恢复草稿已保存 · 正式内容仍需点击保存', error: cacheError });
        } catch (e) {
          update({ status: '', error: '恢复草稿尚未同步：' + errorMessage(e) });
        }
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [dirty, signature, ready, recovery, retry, kind, key, path, itemId, revision, getContext, update]);

  async function clear(savedValue?: T) {
    if (latest.current.id !== id) return;
    const expected = savedValue === undefined ? latest.current.signature : JSON.stringify(savedValue);
    if (expected !== latest.current.signature) return;
    const context = getContext();
    context.savedSignature = expected;
    try {
      localStorage.removeItem(key);
    } catch {
      /* Optional local cache. */
    }
    context.queue = context.queue.then(async () => {
      try {
        await api(`${path}?generation=${context.generation}`, { method: 'DELETE' });
        context.generation = 0;
        update({ recovery: null, error: '', status: '' });
      } catch (e) {
        update({ error: '恢复草稿清理失败：' + errorMessage(e) });
      }
    });
    await context.queue;
  }
  return {
    recovery,
    status: state.id === id ? state.status : '',
    error: state.id === id ? state.error : '',
    conflict: !!recovery && recovery.baseRevision !== undefined && recovery.baseRevision !== revision,
    recover() {
      if (recovery) {
        getContext().savedSignature = '';
        onRestore(recovery.payload);
        update({ recovery: null });
      }
    },
    discard() {
      void clear();
    },
    retry() {
      const context = getContext();
      context.queue = context.queue.then(async () => {
        try {
          const remote = await api<Stored<T>>(path);
          if (!active.current || latest.current.id !== id) return;
          if (remote && typeof remote.generation === 'number') {
            context.generation = remote.generation;
            if (JSON.stringify(remote.payload) !== latest.current.signature) {
              update({ recovery: remote, error: '' });
              return;
            }
          }
          setRetry((v) => v + 1);
        } catch (e) {
          if (!active.current || latest.current.id !== id) return;
          if ((e as { status?: number }).status === 404) {
            context.generation = 0;
            setRetry((v) => v + 1);
          } else update({ error: '草稿重试失败：' + errorMessage(e) });
        }
      });
    },
    clear,
  };
}
