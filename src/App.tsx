import { Form } from './components/Form';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, CircleAlert, LoaderCircle, LockKeyhole, X } from 'lucide-react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { ListPanel } from './components/ListPanel';
import { Workspace } from './components/Workspace';
import { AuthScreen } from './components/AuthScreen';
import { DataManager } from './components/DataManager';
import { VersionHistory } from './components/VersionHistory';
import { OrganizePanel, type SavedFilter } from './components/OrganizePanel';
import { TaskCenter } from './components/TaskCenter';
import { GettingStarted } from './components/GettingStarted';
import { ItemEditor } from './components/ItemEditor';
import { IngestModal } from './components/IngestModal';
import { Modal } from './components/Modal';
import { AppFrame } from './components/AppFrame';
import { ContextMenu, type MenuCommand } from './components/ContextMenu';
import { openSource } from './components/SourceLink';
import { isDesktop } from './lib/platform';
import { api, copyText, errorMessage, saveItem, setToken } from './lib/api';
import { useConfirm } from './lib/confirmation';
import type { Item, ListResult, Pillar } from './types';
const InsightsPanel = lazy(() =>
  import('./components/InsightsPanel').then((module) => ({ default: module.InsightsPanel })),
);
const ProjectHub = lazy(() =>
  import('./components/ProjectHub').then((module) => ({ default: module.ProjectHub })),
);

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const confirm = useConfirm(authenticated);
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
  const [view, setView] = useState('all');
  const [sort, setSort] = useState('relevance');
  const [scopeProject, setScopeProject] = useState<string | undefined>(undefined);
  const [tagFilter, setTagFilter] = useState<string | undefined>(undefined);
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [result, setResult] = useState<ListResult>({ items: [], total: 0, dimensions: [], unlocked: true });
  const [limit, setLimit] = useState(100);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [tick, setTick] = useState(0);
  const [detailTick, setDetailTick] = useState(0);
  const [viewEpoch, setViewEpoch] = useState(0);
  const [guideTick, setGuideTick] = useState(0);
  const [activity, setActivity] = useState({ active: 0, completed: 0, unread: 0 });
  const completedRef = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<
    | 'add'
    | 'edit'
    | 'ingest'
    | 'unlock'
    | 'delete'
    | 'data'
    | 'history'
    | 'projects'
    | 'organize'
    | 'tasks'
    | 'insights'
    | null
  >(null);
  const [contextMenu, setContextMenu] = useState<{ item: Item; x: number; y: number } | null>(null);
  const [editItem, setEditItem] = useState<Item | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Item | null>(null);
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
  const mayLeave = async () =>
    !dirtyRef.current ||
    (await confirm({
      title: '放弃未保存的修改',
      description: '当前内容尚未保存，确认放弃修改并继续？',
      confirmLabel: '放弃修改',
      cancelLabel: '继续编辑',
      danger: true,
    }));
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
    setContextMenu(null);
    setModal((value) =>
      value === 'data' ||
      value === 'history' ||
      value === 'organize' ||
      value === 'tasks' ||
      value === 'insights'
        ? null
        : value,
    );
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 220);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    let stayOnExpired = false;
    let checkingExpiry = false;
    let active = true;
    const expired = async () => {
      if (stayOnExpired || checkingExpiry) return;
      checkingExpiry = true;
      if (
        (dirtyRef.current || modalDraftRef.current.dirty) &&
        !(await confirm({
          title: '登录已过期',
          description: '会话已失效，重新登录将离开当前编辑。可以先留下来复制未保存的内容。',
          confirmLabel: '重新登录',
          cancelLabel: '保留当前编辑',
        }))
      ) {
        checkingExpiry = false;
        if (!active) return;
        stayOnExpired = true;
        notify('会话已失效。请先保存本地内容，然后重新登录。', true);
        return;
      }
      if (!active) return;
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
      active = false;
      window.removeEventListener('infohub:notice', notice);
      window.removeEventListener('infohub:unauthorized', expired);
      window.removeEventListener('infohub:locked', lockUi);
    };
  }, [authenticated, lockUi, notify, confirm]);
  useEffect(() => {
    if (!authenticated || !unlocked) return;
    let timer: ReturnType<typeof setTimeout>;
    let lastActivity = Date.now();
    let lastSynced = lastActivity;
    let locking = false;
    const abort = new AbortController();
    const reset = () => {
      lastActivity = Date.now();
      clearTimeout(timer);
      timer = setTimeout(
        async () => {
          if (locking || abort.signal.aborted) return;
          locking = true;
          try {
            if (
              wouldLoseCredentialDraft() &&
              !(await confirm({
                title: '锁定密码库',
                description: '已长时间未操作。锁定密码库将离开当前凭证编辑，未保存的修改会丢失。',
                confirmLabel: '放弃修改并锁定',
                cancelLabel: '继续编辑',
                danger: true,
              }))
            ) {
              if (!abort.signal.aborted) reset();
              return;
            }
            if (abort.signal.aborted) return;
            await api('/vault/lock', { method: 'POST' });
            if (!abort.signal.aborted) lockUi();
          } catch {
            if (!abort.signal.aborted) notify('锁定金库失败，当前会话仍保持解锁。', true);
          } finally {
            locking = false;
          }
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
  }, [authenticated, unlocked, lockUi, notify, confirm]);
  useEffect(() => {
    // Browsers require their own prompt when a page is refreshed or closed.
    // The desktop window uses the application dialog below.
    if (isDesktop) return;
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || modalDraftRef.current.dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, []);
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    let closing = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const currentWindow = getCurrentWindow();
        const stop = await currentWindow.onCloseRequested(async (event) => {
          if (closing) {
            event.preventDefault();
            return;
          }
          if (!dirtyRef.current && !modalDraftRef.current.dirty) return;
          event.preventDefault();
          closing = true;
          try {
            const accepted = await confirm({
              title: '关闭 InfoHub',
              description: '当前内容尚未保存，确认放弃修改并关闭窗口？',
              confirmLabel: '放弃修改并关闭',
              cancelLabel: '继续编辑',
              danger: true,
            });
            if (accepted && !disposed) await currentWindow.destroy();
          } catch {
            if (!disposed) notify('窗口未能关闭，请稍后重试。', true);
          } finally {
            closing = false;
          }
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
  }, [confirm, notify]);
  useEffect(() => {
    if (!authenticated) return;
    const abort = new AbortController();
    const scope = [
      pillar,
      category,
      dimension,
      String(global),
      String(favorite),
      search,
      view,
      sort,
      scopeProject,
      tagFilter,
    ].join('\0');
    const scopeChanged = listScopeRef.current !== scope;
    listScopeRef.current = scope;
    const params = new URLSearchParams({ limit: '100', q: search, view, sort });
    if (!global) {
      params.set('kind', pillar);
      if (pillar === 'credential') {
        if (dimension !== 'all') params.set('project', dimension);
        if (category !== 'all') params.set('category', category);
      } else if (category !== 'all' || dimension !== 'all')
        params.set('category', category !== 'all' ? category : dimension);
    }
    if (favorite) params.set('favorite', 'true');
    if (scopeProject !== undefined) params.set('project', scopeProject);
    if (tagFilter !== undefined) params.set('tag', tagFilter);
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
  }, [
    authenticated,
    pillar,
    category,
    dimension,
    global,
    favorite,
    search,
    view,
    sort,
    scopeProject,
    tagFilter,
    limit,
    tick,
    unlocked,
    lockUi,
  ]);
  const canReadSelected = selected?.kind !== 'credential' || unlocked;
  useEffect(() => {
    if (!authenticated) return;
    const abort = new AbortController();
    async function poll() {
      try {
        const value = await api<{ active: number; completed: number; unread: number }>('/activity', {
          signal: abort.signal,
        });
        if (abort.signal.aborted || typeof value.completed !== 'number') return;
        setActivity(value);
        if (completedRef.current !== null && completedRef.current !== value.completed) setTick((v) => v + 1);
        completedRef.current = value.completed;
      } catch {
        /* A visible list or task view exposes connection errors. */
      }
    }
    void poll();
    const timer = setInterval(() => {
      if (!document.hidden) void poll();
    }, 30000);
    return () => {
      abort.abort();
      clearInterval(timer);
      completedRef.current = null;
    };
  }, [authenticated]);
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
  const selectItem = async (next: Pick<Item, 'id' | 'kind'>) => {
    if (selected?.id !== next.id && !(await mayLeave())) return;
    if (selected?.id !== next.id) {
      clearDraft();
      setSelected({ id: next.id, kind: next.kind });
      void api(`/items/${next.id}/visit`, { method: 'POST' })
        .then(() => setGuideTick((v) => v + 1))
        .catch(() => {});
    } else if (detailError) {
      setDetailTick((v) => v + 1);
    }
    setMobileDetail(true);
  };
  const switchPillar = async (next: Pillar) => {
    if (!(await mayLeave())) return;
    clearDraft();
    setPillar(next);
    setSelected(null);
    setItem(null);
    setCategory('all');
    setDimension('all');
    setQuery('');
    setGlobal(false);
    setFavorite(false);
    setView('all');
    setScopeProject(undefined);
    setTagFilter(undefined);
    setLimit(100);
    setSidebarOpen(false);
    setMobileDetail(false);
  };
  const add = async () => {
    if (!(await mayLeave())) return;
    if (pillar === 'credential' && !unlocked) showModal('unlock');
    else showModal('add');
  };
  const ingest = async () => {
    if (!(await mayLeave())) return;
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
      if (modal || document.querySelector('dialog[open]')) return;
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
    const paste = async (event: ClipboardEvent) => {
      if (
        modal ||
        document.querySelector('dialog[open]') ||
        (event.target instanceof Element &&
          event.target.closest('input,textarea,select,[contenteditable=true]'))
      )
        return;
      const text = event.clipboardData?.getData('text').trim() || '';
      if (/^https?:\/\/\S+$/.test(text)) {
        event.preventDefault();
        if (!(await mayLeave())) return;
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
    setView('all');
    setScopeProject(undefined);
    setTagFilter(undefined);
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
    setEditItem(null);
    setViewEpoch((v) => v + 1);
    setDetailTick((v) => v + 1);
  }
  async function refreshItem() {
    if (!item || !(await mayLeave())) return;
    await refreshEntry(item);
  }
  async function star() {
    if (!item) return;
    await starEntry(item);
  }
  async function fullItem(entry: Item) {
    return api<Item>('/items/' + entry.id);
  }
  async function starEntry(entry: Item) {
    setBusy(true);
    try {
      const full = await fullItem(entry);
      const updated = await saveItem({ ...full, favorite: !full.favorite }, full.id);
      saved(updated);
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function refreshEntry(entry: Item) {
    if (selected?.id !== entry.id && !(await mayLeave())) return;
    if (
      entry.kind === 'knowledge' &&
      !(await confirm({
        title: '重新同步文章',
        description: '重新同步会更新正文和图片，当前内容将保留在“版本历史”中，可随时恢复。',
        confirmLabel: '继续同步',
      }))
    )
      return;
    setBusy(true);
    try {
      const result = await api<{ item: Item; warnings: string[] }>('/items/' + entry.id + '/refresh', {
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
  function listCommands(entry: Item): MenuCommand[] {
    const lockedCred = entry.kind === 'credential' && !unlocked;
    const commands: MenuCommand[] = [];
    if (entry.url) commands.push({ id: 'open', label: '打开来源' });
    commands.push({ id: 'copy-title', label: '复制标题' });
    if (entry.url) commands.push({ id: 'copy-url', label: '复制链接' });
    if (lockedCred) {
      commands.push({ id: 'unlock', label: '解锁密码库' });
      return commands;
    }
    commands.push({ id: 'star', label: entry.favorite ? '取消收藏' : '收藏' });
    if (entry.url) commands.push({ id: 'refresh', label: '重新同步' });
    commands.push({ id: 'edit', label: '编辑属性' });
    commands.push({ id: 'delete', label: '删除', danger: true });
    return commands;
  }
  async function openListMenu(entry: Item, x: number, y: number) {
    if (selected?.id !== entry.id && !(await mayLeave())) return;
    if (selected?.id !== entry.id) {
      clearDraft();
      setSelected({ id: entry.id, kind: entry.kind });
    }
    setContextMenu({ item: entry, x, y });
  }
  async function runListCommand(id: string) {
    const entry = contextMenu?.item;
    setContextMenu(null);
    if (!entry) return;
    try {
      if (id === 'open' && entry.url) {
        await openSource(entry.url);
        return;
      }
      if (id === 'copy-title') {
        await copyText(entry.title);
        notify('标题已复制');
        return;
      }
      if (id === 'copy-url' && entry.url) {
        await copyText(entry.url);
        notify('链接已复制');
        return;
      }
      if (id === 'unlock') {
        showModal('unlock');
        return;
      }
      if (entry.kind === 'credential' && !unlocked) return;
      if (id === 'star') {
        await starEntry(entry);
        return;
      }
      if (id === 'refresh') {
        await refreshEntry(entry);
        return;
      }
      if (id === 'edit') {
        if (selected?.id !== entry.id && !(await mayLeave())) return;
        const full = await fullItem(entry);
        setEditItem(full);
        setSelected({ id: full.id, kind: full.kind });
        setItem(full);
        showModal('edit');
        return;
      }
      if (id === 'delete') {
        setPendingDelete(entry);
        showModal('delete');
      }
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function lock() {
    if (!unlocked) {
      showModal('unlock');
      return;
    }
    if (selected?.kind === 'credential' && !(await mayLeave())) return;
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
    if (!(await mayLeave())) return;
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
    const target = pendingDelete || item;
    if (!target) return;
    setBusy(true);
    setModalError('');
    try {
      await api('/items/' + target.id, { method: 'DELETE' });
      clearDraft();
      setModal(null);
      setPendingDelete(null);
      if (selected?.id === target.id) {
        setSelected(null);
        setItem(null);
        setMobileDetail(false);
      }
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
        onManage={async () => {
          if (await mayLeave()) showModal('data');
        }}
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
      <GettingStarted
        tick={tick + guideTick}
        onIngest={ingest}
        onProjects={async () => {
          if (await mayLeave()) showModal('projects');
        }}
        onSearch={focusSearch}
      />
      <div className="app-body">
        <Sidebar
          onTasks={async () => {
            if (await mayLeave()) showModal('tasks');
          }}
          onInsights={async () => {
            if (await mayLeave()) showModal('insights');
          }}
          taskCount={activity.active + activity.unread}
          onProjects={async () => {
            if (await mayLeave()) showModal('projects');
          }}
          onOrganize={async () => {
            if (await mayLeave()) {
              setBatchIds([]);
              showModal('organize');
            }
          }}
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
          view={view}
          sort={sort}
          onView={(value) => {
            setView(value);
            setLimit(100);
          }}
          onSort={(value) => {
            setSort(value);
            setLimit(100);
          }}
          onOrganize={async (ids) => {
            if (await mayLeave()) {
              setBatchIds(ids);
              showModal('organize');
            }
          }}
          filterSummary={[
            scopeProject !== undefined ? `项目：${scopeProject || '未归属'}` : '',
            tagFilter ? `标签：${tagFilter}` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
          onClearFilters={() => {
            setScopeProject(undefined);
            setTagFilter(undefined);
          }}
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
          onMenu={openListMenu}
        />
        <Workspace
          onOpen={selectItem}
          onHistory={async () => {
            if (await mayLeave()) showModal('history');
          }}
          item={item}
          selectedKind={selected?.kind}
          loading={detailLoading}
          error={detailError}
          unlocked={unlocked}
          busy={busy}
          viewEpoch={viewEpoch}
          onEdit={async () => {
            if (await mayLeave()) {
              setEditItem(null);
              showModal('edit');
            }
          }}
          onDelete={() => {
            setPendingDelete(null);
            showModal('delete');
          }}
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
      {(modal === 'add' || (modal === 'edit' && (editItem || item))) && (
        <ItemEditor
          item={modal === 'edit' ? editItem || item! : undefined}
          pillar={pillar}
          unlocked={unlocked}
          onDraft={modalDraft}
          projects={[...new Set(result.dimensions.map((d) => d.project).filter(Boolean))]}
          onClose={() => {
            setModal(null);
            setEditItem(null);
          }}
          onSaved={modal === 'edit' ? edited : created}
        />
      )}
      {modal === 'data' && (
        <DataManager
          onClose={() => setModal(null)}
          onChanged={reload}
          onRestored={() => {
            setModal(null);
            setToken('');
            setAuthenticated(false);
            setItem(null);
            setSelected(null);
            clearDraft();
            notify('恢复完成，请使用备份时的主密码登录。');
          }}
        />
      )}
      {modal === 'history' && item && (
        <VersionHistory
          item={item}
          onClose={() => setModal(null)}
          onRestored={(updated) => {
            setModal(null);
            saved(updated);
            clearDraft();
            setViewEpoch((v) => v + 1);
            notify('已恢复历史版本，恢复前的内容也已保留。');
          }}
        />
      )}
      {modal === 'projects' && (
        <Suspense
          fallback={
            <Modal title="项目总览" onClose={() => setModal(null)}>
              <div className="modal-body">正在加载项目…</div>
            </Modal>
          }
        >
          <ProjectHub
            onClose={() => setModal(null)}
            onChanged={() => {
              clearDraft();
              reload();
              setDetailTick((v) => v + 1);
            }}
            onOpen={(entry) => {
              clearDraft();
              setGlobal(true);
              setScopeProject(entry.project);
              setQuery('');
              setCategory('all');
              setDimension('all');
              setView('all');
              setTagFilter(undefined);
              setFavorite(false);
              setLimit(100);
              selectItem(entry);
              setModal(null);
            }}
          />
        </Suspense>
      )}
      {modal === 'organize' && (
        <OrganizePanel
          ids={batchIds}
          filters={{
            kind: global ? undefined : pillar,
            q: query,
            category: global
              ? undefined
              : category !== 'all'
                ? category
                : pillar !== 'credential' && dimension !== 'all'
                  ? dimension
                  : undefined,
            project:
              scopeProject ??
              (!global && pillar === 'credential' && dimension !== 'all' ? dimension : undefined),
            favorite: favorite || undefined,
            view,
            sort,
            tag: tagFilter,
          }}
          onClose={() => setModal(null)}
          onChanged={() => {
            clearDraft();
            reload();
            setDetailTick((v) => v + 1);
          }}
          onApply={(filter: SavedFilter) => {
            setModal(null);
            setGlobal(!filter.kind);
            if (['knowledge', 'repo', 'credential'].includes(filter.kind || ''))
              setPillar(filter.kind as Pillar);
            setQuery(filter.q || '');
            setCategory(filter.category || 'all');
            setDimension('all');
            setScopeProject(filter.project ?? undefined);
            setFavorite(!!filter.favorite);
            setView(filter.view || 'all');
            setSort(filter.sort || 'relevance');
            setTagFilter(filter.tag ?? undefined);
            setLimit(100);
          }}
        />
      )}
      {modal === 'ingest' && (
        <IngestModal
          initialUrl={ingestUrl}
          unlocked={unlocked}
          onClose={() => setModal(null)}
          onQueued={() => {
            showModal('tasks');
            reload();
            notify('已加入收录队列，可以关闭窗口，稍后在“任务与更新”查看结果。');
          }}
          onDraft={modalDraft}
        />
      )}
      {modal === 'tasks' && (
        <TaskCenter
          unlocked={unlocked}
          onClose={() => {
            setModal(null);
            reload();
          }}
          onChanged={reload}
          onOpen={(entry) => {
            clearDraft();
            setView('all');
            setScopeProject(undefined);
            setTagFilter(undefined);
            setGlobal(true);
            setQuery('');
            selectItem(entry);
            setModal(null);
            reload();
          }}
        />
      )}
      {modal === 'insights' && (
        <Suspense
          fallback={
            <Modal title="使用与反馈" onClose={() => setModal(null)}>
              <p className="modal-body">正在加载…</p>
            </Modal>
          }
        >
          <InsightsPanel
            unlocked={unlocked}
            onDraft={modalDraft}
            onClose={() => setModal(null)}
            onShowGuide={() => {
              setGuideTick((v) => v + 1);
              setModal(null);
            }}
          />
        </Suspense>
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
          <Form onSubmit={unlock}>
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
          </Form>
        </Modal>
      )}
      {modal === 'delete' && (pendingDelete || item) && (
        <Modal
          title="删除资产"
          onClose={() => {
            if (!busy) {
              setModal(null);
              setPendingDelete(null);
            }
          }}
        >
          <div className="modal-body">
            <p>将「{(pendingDelete || item)!.title}」移入回收站？</p>
            <p className="muted">正文、离线图片、附件和历史版本都会保留，可在“数据与安全”中恢复。</p>
            {modalError && (
              <div className="error" role="alert">
                {modalError}
              </div>
            )}
          </div>
          <div className="modal-foot">
            <button
              disabled={busy}
              onClick={() => {
                setModal(null);
                setPendingDelete(null);
              }}
            >
              取消
            </button>
            <button className="danger" disabled={busy} onClick={() => void remove()}>
              移入回收站
            </button>
          </div>
        </Modal>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          commands={listCommands(contextMenu.item)}
          onPick={(id) => void runListCommand(id)}
          onClose={() => setContextMenu(null)}
        />
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
