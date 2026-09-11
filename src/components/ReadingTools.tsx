import { useEffect, useState } from 'react';
import { Bookmark, Check, Save } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { usePersistentDraft } from '../lib/usePersistentDraft';
import { DraftNotice } from './DraftNotice';
import type { Item } from '../types';
interface ReadingState {
  later: boolean;
  progress: number;
  annotation: string;
  revision: number;
}
export function ReadingTools({ item, onDirty }: { item: Item; onDirty: (dirty: boolean) => void }) {
  const [state, setState] = useState<ReadingState>({
    later: false,
    progress: 0,
    annotation: '',
    revision: 0,
  });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const persistence = usePersistentDraft({
    scope: `annotation:${item.id}`,
    kind: item.kind,
    itemId: item.id,
    revision: state.revision,
    value: state,
    dirty,
    onRestore: (value) => {
      setState({ ...value, revision: state.revision });
      setDirty(true);
    },
  });
  useEffect(() => {
    let alive = true;
    void api<ReadingState>(`/items/${item.id}/state`)
      .then((value) => {
        if (alive && typeof value.progress === 'number') setState(value);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      })
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [item.id]);
  async function save(next = state) {
    setBusy(true);
    setError('');
    try {
      await api(`/items/${item.id}/state`, { method: 'PUT', body: JSON.stringify(next) });
      await persistence.clear(state);
      setState({ ...next, revision: next.revision + 1 });
      setDirty(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="reading-tools">
      <div className="section-title">
        <h3>阅读与批注</h3>
        <div className="inline-actions">
          <button
            disabled={busy || !ready}
            aria-pressed={state.later}
            onClick={() => void save({ ...state, later: !state.later })}
          >
            <Bookmark size={13} />
            {state.later ? '移出稍后读' : '稍后读'}
          </button>
          <button disabled={busy || !ready} onClick={() => void save({ ...state, progress: 100 })}>
            <Check size={13} />
            标记已读
          </button>
        </div>
      </div>
      {ready && <DraftNotice draft={persistence} />}
      <label>
        阅读进度 {state.progress}%
        <input
          disabled={busy || !ready}
          type="range"
          min={0}
          max={100}
          step={5}
          value={state.progress}
          onChange={(e) => {
            setState({ ...state, progress: Number(e.target.value) });
            setDirty(true);
          }}
        />
      </label>
      <label>
        独立批注
        <textarea
          disabled={busy || !ready}
          value={state.annotation}
          onChange={(e) => {
            setState({ ...state, annotation: e.target.value });
            setDirty(true);
          }}
          placeholder="个人想法保存在这里，重新同步原文时会保留。"
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button disabled={!dirty || busy} onClick={() => void save()}>
        <Save size={13} />
        {busy ? '保存中…' : '保存阅读记录'}
      </button>
    </section>
  );
}
