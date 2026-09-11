import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, CircleAlert, LoaderCircle, LockKeyhole, X } from 'lucide-react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { ListPanel } from './components/ListPanel';
import { Workspace } from './components/Workspace';
import { AuthScreen } from './components/AuthScreen';
import { ItemEditor } from './components/ItemEditor';
import { IngestModal } from './components/IngestModal';
import { Modal } from './components/Modal';
import { AppFrame } from './components/AppFrame';
import { isDesktop } from './lib/platform';
import { api, errorMessage, saveItem, setToken } from './lib/api';
import type { Item, ListResult, Pillar } from './types';

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [serverSettings, setServerSettings] = useState(false);
  const [unlocked, setUnlocked] = useState(true);
  const [pillar, setPillar] = useState<Pillar>('credential');
  const [selected, setSelected] = useState<{ id: string; kind: Pillar } | null>(null);
  const [item, setItem] = useState<Item | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [dimension, setDimension] = useState('all');
  const [global, setGlobal] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [result, setResult] = useState<ListResult>({ items: [], total: 0, dimensions: [], unlocked: true });
  const [limit, setLimit] = useState(100);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [tick, setTick] = useState(0);
  const [detailTick, setDetailTick] = useState(0);
  const [viewEpoch, setViewEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'add' | 'edit' | 'ingest' | 'unlock' | 'delete' | null>(null);
  const [ingestUrl, setIngestUrl] = useState('');
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [password, setPassword] = useState('');
  const [modalError, setModalError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const dirtyRef = useRef(false);
  const modalDraftRef = useRef<{ dirty: boolean; kind?: Pillar }>({ dirty: false });
  const unlockedRef = useRef(true);
  const selectedKindRef = useRef<Pillar | undefined>(undefined);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const listScopeRef = useRef('');
  const setDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
  }, []);
  const modalDraft = useCallback((dirty: boolean, kind?: Pillar) => {
    modalDraftRef.current = { dirty, kind };
  }, []);
  useEffect(() => {
    unlockedRef.current = unlocked;
  }, [unlocked]);
  useEffect(() => {
    selectedKindRef.current = selected?.kind;
    selectedIdRef.current = selected?.id;
  }, [selected]);
  const notify = useCallback((message: string, error = false) => setToast({ text: message, error }), []);
  const reload = () => setTick((t) => t + 1);
  const mayLeave = () => !dirtyRef.current || window.confirm('当前内容尚未保存，放弃修改并继续？');
  const clearDraft = () => {
    dirtyRef.current = false;
  };
  const showModal = (value: typeof modal) => {
    setModalError('');
    setPassword('');
    setModal(value);
  };
  const wouldLoseCredentialDraft = () =>
    (modalDraftRef.current.dirty && modalDraftRef.current.kind === 'credential') ||
    (dirtyRef.current && selectedKindRef.current === 'credential');
  const lockUi = useCallback(() => {
    if (!unlockedRef.current) return;
    unlockedRef.current = false;
    setUnlocked(false);
    setItem((v) => (v?.kind === 'credential' ? null : v));
    if (modalDraftRef.current.kind === 'credential') {
      modalDraftRef.current = { dirty: false };
      setModal(null);
    }
    setPassword('');
    if (selectedKindRef.current === 'credential') {
      dirtyRef.current = false;
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 220);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    let stayOnExpired = false;
    const expired = () => {
      if (stayOnExpired) return;
      if (
        (dirtyRef.current || modalDraftRef.current.dirty) &&
        !window.confirm('会话已失效，放弃未保存内容并重新登录？')
      ) {
        stayOnExpired = true;
        notify('会话已失效。请先保存本地内容，然后重新登录。', true);
        return;
      }
      setToken('');
      setAuthenticated(false);
      setItem(null);
      setSelected(null);
      setModal(null);
      setResult({ items: [], total: 0, dimensions: [], unlocked: false });
      dirtyRef.current = false;
      modalDraftRef.current = { dirty: false };
      setBusy(false);
    };
    const notice = (event: Event) => notify((event as CustomEvent<string>).detail, true);
    window.addEventListener('infohub:notice', notice);
    window.addEventListener('infohub:unauthorized', expired);
    window.addEventListener('infohub:locked', lockUi);
    return () => {
      window.removeEventListener('infohub:notice', notice);
      window.removeEventListener('infohub:unauthorized', expired);
      window.removeEventListener('infohub:locked', lockUi);
    };
  }, [lockUi, notify]);
  useEffect(() => {
    if (!authenticated || !unlocked) return;
    let timer: ReturnType<typeof setTimeout>;
    let lastActivity = Date.now();
    let lastSynced = lastActivity;
    const abort = new AbortController();
    const reset = () => {
      lastActivity = Date.now();
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          if (
            wouldLoseCredentialDraft() &&
            !window.confirm('已长时间未操作。锁定金库将放弃未保存的凭证修改，继续锁定？')
          ) {
            reset();
            return;
          }
          void api('/vault/lock', { method: 'POST' })
            .then(() => lockUi())
            .catch(() => notify('锁定金库失败，当前会话仍保持解锁。', true));
        },
        15 * 60 * 1000,
      );
    };
    reset();
    const heartbeat = setInterval(() => {
      if (lastActivity <= lastSynced || document.hidden) return;
      lastSynced = lastActivity;
      void api<{ unlocked: boolean }>('/session', { signal: abort.signal })
        .then((session) => {
          if (!abort.signal.aborted && !session.unlocked) lockUi();
        })
        .catch(() => {});
    }, 60_000);
    window.addEventListener('pointerdown', reset);
    window.addEventListener('keydown', reset);
    return () => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      abort.abort();
      window.removeEventListener('pointerdown', reset);
      window.removeEventListener('keydown', reset);
    };
  }, [authenticated, unlocked, lockUi, notify]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || modalDraftRef.current.dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, []);
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const stop = await getCurrentWindow().onCloseRequested((event) => {
          if (
            (dirtyRef.current || modalDraftRef.current.dirty) &&
            !window.confirm('当前内容尚未保存，放弃修改并关闭窗口？')
          )
            event.preventDefault();
        });
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        if (!disposed)
          window.dispatchEvent(
            new CustomEvent('infohub:notice', { detail: '窗口关闭保护未能启用，请在关闭前保存修改。' }),
          );
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    const abort = new AbortController();
    const scope = [pillar, category, dimension, String(global), String(favorite), search].join('\0');
    const scopeChanged = listScopeRef.current !== scope;
    listScopeRef.current = scope;
    const params = new URLSearchParams({ limit: '100', q: search });
    if (!global) {
      params.set('kind', pillar);
      if (pillar === 'credential') {
        if (dimension !== 'all') params.set('project', dimension);
        if (category !== 'all') params.set('category', category);
      } else if (category !== 'all' || dimension !== 'all')
        params.set('category', category !== 'all' ? category : dimension);
    }
    if (favorite) params.set('favorite', 'true');
    async function load() {
      setListLoading(true);
      setListError('');
      if (scopeChanged) setResult((current) => ({ ...current, items: [], total: 0 }));
      try {
        let value: ListResult;
        const items: Item[] = [];
        do {
          params.set('offset', String(items.length));
          value = await api<ListResult>('/items?' + params, { signal: abort.signal });
          items.push(...value.items);
        } while (items.length < limit && items.length < value.total && value.items.length > 0);
        if (!abort.signal.aborted) {
          setResult({ ...value, items });
          if (!value.unlocked) lockUi();
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          setListError(errorMessage(e));
          setResult((current) => ({ ...current, items: [], total: 0 }));
        }
      } finally {
        if (!abort.signal.aborted) setListLoading(false);
      }
    }
    void load();
    return () => abort.abort();
  }, [authenticated, pillar, category, dimension, global, favorite, search, limit, tick, unlocked, lockUi]);
  const canReadSelected = selected?.kind !== 'credential' || unlocked;
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      if (!authenticated || !selected || !canReadSelected) {
        setItem(null);
        setDetailLoading(false);
        return;
      }
      setItem(null);
      setDetailLoading(true);
      setDetailError('');
      try {
        const value = await api<Item>('/items/' + selected.id, { signal: abort.signal });
        if (!abort.signal.aborted) setItem(value);
      } catch (e) {
        if (!abort.signal.aborted) setDetailError(errorMessage(e));
      } finally {
        if (!abort.signal.aborted) setDetailLoading(false);
      }
    }
    void load();
    return () => abort.abort();
  }, [authenticated, selected, canReadSelected, detailTick]);
  const selectItem = (next: Item) => {
    if (selected?.id !== next.id && !mayLeave()) return;
    if (selected?.id !== next.id) {
      clearDraft();
      setSelected({ id: next.id, kind: next.kind });
    } else if (detailError) {
      setDetailTick((v) => v + 1);
    }
    setMobileDetail(true);
  };
  const switchPillar = (next: Pillar) => {
    if (!mayLeave()) return;
    clearDraft();
    setPillar(next);
    setSelected(null);
    setItem(null);
    setCategory('all');
    setDimension('all');
    setQuery('');
    setGlobal(false);
    setFavorite(false);
    setLimit(100);
    setSidebarOpen(false);
    setMobileDetail(false);
  };
  const add = () => {
    if (!mayLeave()) return;
    if (pillar === 'credential' && !unlocked) showModal('unlock');
    else showModal('add');
  };
  const ingest = () => {
    if (!mayLeave()) return;
    setIngestUrl('');
    showModal('ingest');
  };
  const focusSearch = () => {
    setGlobal(true);
    setMobileDetail(false);
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  useEffect(() => {
    if (!authenticated) return;
    const keydown = (event: KeyboardEvent) => {
      if (modal) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        focusSearch();
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest('input,textarea,select,[contenteditable=true]')
      )
        return;
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        ['j', 'k'].includes(event.key) &&
        result.items.length
      ) {
        event.preventDefault();
        const index = result.items.findIndex((i) => i.id === selected?.id);
        selectItem(
          result.items[Math.min(result.items.length - 1, Math.max(0, index + (event.key === 'j' ? 1 : -1)))],
        );
      }
    };
    const paste = (event: ClipboardEvent) => {
      if (
        modal ||
        (event.target instanceof Element &&
          event.target.closest('input,textarea,select,[contenteditable=true]'))
      )
        return;
      const text = event.clipboardData?.getData('text').trim() || '';
      if (/^https?:\/\/\S+$/.test(text) && mayLeave()) {
        event.preventDefault();
        setIngestUrl(text);
        showModal('ingest');
      }
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('paste', paste);
    };
  });
  function saved(updated: Item) {
    setItem((current) => (current?.id === updated.id ? updated : current));
    reload();
  }
  function created(updated: Item, warnings?: string[]) {
    clearDraft();
    setModal(null);
    setPillar(updated.kind);
    setCategory('all');
    setDimension('all');
    setQuery('');
    setGlobal(false);
    setFavorite(false);
    setSelected({ id: updated.id, kind: updated.kind });
    setMobileDetail(true);
    setViewEpoch((v) => v + 1);
    setDetailTick((v) => v + 1);
    reload();
    if (warnings?.length) notify('已收录。' + warnings.join('；'));
  }
  function edited(updated: Item) {
    clearDraft();
    setModal(null);
    saved(updated);
    setViewEpoch((v) => v + 1);
    setDetailTick((v) => v + 1);
  }
  async function refreshItem() {
    if (!item || !mayLeave()) return;
    setBusy(true);
    try {
      const result = await api<{ item: Item; warnings: string[] }>('/items/' + item.id + '/refresh', {
        method: 'POST',
      });
      saved(result.item);
      if (selectedIdRef.current === result.item.id) {
        clearDraft();
        setViewEpoch((v) => v + 1);
      }
      notify(result.warnings.length ? '已同步。' + result.warnings.join('；') : '已同步最新内容');
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function star() {
    if (!item) return;
    setBusy(true);
    try {
      const updated = await saveItem({ ...item, favorite: !item.favorite }, item.id);
      saved(updated);
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function lock() {
    if (!unlocked) {
      showModal('unlock');
      return;
    }
    if (selected?.kind === 'credential' && !mayLeave()) return;
    setBusy(true);
    try {
      await api('/vault/lock', { method: 'POST' });
      lockUi();
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function logout(openSettings = false) {
    if (!mayLeave()) return;
    try {
      await api('/auth/logout', { method: 'POST', signal: AbortSignal.timeout(5000) });
    } catch {
      /* Locally forget the token even if the network is down. */
    }
    setToken('');
    setAuthenticated(false);
    setServerSettings(openSettings);
    setSelected(null);
    setItem(null);
    clearDraft();
    setModal(null);
  }
  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setModalError('');
    try {
      await api('/vault/unlock', { method: 'POST', body: JSON.stringify({ password }) });
      setUnlocked(true);
      setModal(null);
      setPassword('');
      reload();
    } catch (e) {
      setModalError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!item) return;
    setBusy(true);
    setModalError('');
    try {
      await api('/items/' + item.id, { method: 'DELETE' });
      clearDraft();
      setModal(null);
      setSelected(null);
      setItem(null);
      setMobileDetail(false);
      reload();
    } catch (e) {
      setModalError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!authenticated)
    return (
      <AppFrame>
        <AuthScreen
          initialServerSettings={serverSettings}
          onLogin={() => {
            setServerSettings(false);
            setAuthenticated(true);
            setUnlocked(true);
            setResult({ items: [], total: 0, dimensions: [], unlocked: true });
            reload();
          }}
        />
      </AppFrame>
    );
  return (
    <AppFrame showDetail={mobileDetail}>
      <Header
        unlocked={unlocked}
        busy={busy}
        onIngest={ingest}
        onAdd={add}
        onSearch={focusSearch}
        onLock={() => void lock()}
        onLogout={() => void logout()}
        onServerSettings={() => void logout(true)}
        onMenu={() => setSidebarOpen((v) => !v)}
      />
      <div className="app-body">
        <Sidebar
          pillar={pillar}
          dimensions={result.dimensions}
          dimension={dimension}
          favorite={favorite}
          open={sidebarOpen}
          onPillar={switchPillar}
          onDimension={(d) => {
            setDimension(d);
            setCategory('all');
            setGlobal(false);
            setLimit(100);
            setSidebarOpen(false);
          }}
          onFavorite={() => setFavorite((v) => !v)}
          onClose={() => setSidebarOpen(false)}
        />
        <ListPanel
          pillar={pillar}
          items={result.items}
          total={result.total}
          dimensions={result.dimensions}
          selectedId={selected?.id || null}
          query={query}
          category={category}
          global={global}
          loading={listLoading}
          error={listError}
          searchRef={searchRef}
          onSelect={selectItem}
          onQuery={(v) => {
            setQuery(v);
            setLimit(100);
          }}
          onCategory={(v) => {
            setCategory(v);
            if (pillar !== 'credential') setDimension('all');
            setLimit(100);
          }}
          onGlobal={setGlobal}
          onMore={() => setLimit((v) => v + 100)}
          onRetry={reload}
        />
        <Workspace
          item={item}
          selectedKind={selected?.kind}
          loading={detailLoading}
          error={detailError}
          unlocked={unlocked}
          busy={busy}
          viewEpoch={viewEpoch}
          onEdit={() => {
            if (mayLeave()) showModal('edit');
          }}
          onDelete={() => showModal('delete')}
          onRefresh={() => void refreshItem()}
          onStar={() => void star()}
          onBack={() => setMobileDetail(false)}
          onUnlock={() => showModal('unlock')}
          onCreate={add}
          onSaved={saved}
          onDirty={setDirty}
          notify={notify}
        />
      </div>
      {(modal === 'add' || (modal === 'edit' && item)) && (
        <ItemEditor
          item={modal === 'edit' ? item! : undefined}
          pillar={pillar}
          unlocked={unlocked}
          onDraft={modalDraft}
          projects={[...new Set(result.dimensions.map((d) => d.project).filter(Boolean))]}
          onClose={() => setModal(null)}
          onSaved={modal === 'edit' ? edited : created}
        />
      )}
      {modal === 'ingest' && (
        <IngestModal
          initialUrl={ingestUrl}
          unlocked={unlocked}
          onClose={() => setModal(null)}
          onSaved={created}
          onDraft={modalDraft}
        />
      )}
      {modal === 'unlock' && (
        <Modal
          title="解锁密码库"
          onClose={() => {
            if (!busy) {
              setModal(null);
              setPassword('');
            }
          }}
        >
          <form onSubmit={unlock}>
            <div className="modal-body">
              <div className="unlock-description">
                <LockKeyhole size={24} />
                <p>输入主密码，解密当前会话中的资产凭证。</p>
              </div>
              <label>
                主密码
                <input
                  autoFocus
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              {modalError && (
                <div className="error" role="alert">
                  {modalError}
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setModal(null);
                  setPassword('');
                }}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                {busy && <LoaderCircle className="spin" size={13} />}解锁金库
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'delete' && item && (
        <Modal
          title="删除资产"
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          <div className="modal-body">
            <p>永久删除「{item.title}」及其离线图片和附件？</p>
            <p className="muted">此操作无法撤销。</p>
            {modalError && (
              <div className="error" role="alert">
                {modalError}
              </div>
            )}
          </div>
          <div className="modal-foot">
            <button disabled={busy} onClick={() => setModal(null)}>
              取消
            </button>
            <button className="danger" disabled={busy} onClick={() => void remove()}>
              永久删除
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div
          className={'toast' + (toast.error ? ' toast-error' : '')}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <CircleAlert size={15} /> : <Check size={15} />}
          <span>{toast.text}</span>
          <button className="icon-button" aria-label="关闭通知" onClick={() => setToast(null)}>
            <X size={13} />
          </button>
        </div>
      )}
    </AppFrame>
  );
}

export default App;
