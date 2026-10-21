import { useCallback, useEffect, useRef, useState } from 'react';
import type { Update } from '@tauri-apps/plugin-updater';
import { Modal } from './Modal';
import { CHECK_UPDATES_EVENT, checkForUpdate, relaunchApp } from '../lib/updater';
import { isDesktop } from '../lib/platform';

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'available'; update: Update }
  | { kind: 'downloading'; update: Update; done: number; total?: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

const SKIP_KEY = 'infohub.update.skip';
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

/** Desktop-only online update: silent check on startup, manual check via CHECK_UPDATES_EVENT. */
export function UpdatePrompt() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const busy = useRef(false);

  const run = useCallback(async (manual: boolean) => {
    if (busy.current) return;
    busy.current = true;
    if (manual) setState({ kind: 'checking' });
    try {
      const update = await checkForUpdate();
      if (update && (manual || localStorage.getItem(SKIP_KEY) !== update.version))
        setState({ kind: 'available', update });
      else setState(manual ? { kind: 'latest' } : { kind: 'idle' });
    } catch (e) {
      // Startup checks fail silently (offline, GitHub blocked); manual checks report.
      setState(manual ? { kind: 'error', message: String(e) } : { kind: 'idle' });
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isDesktop || import.meta.env.DEV) return;
    const timer = setTimeout(() => void run(false), 3000);
    return () => clearTimeout(timer);
  }, [run]);
  useEffect(() => {
    const onManual = () => void run(true);
    window.addEventListener(CHECK_UPDATES_EVENT, onManual);
    return () => window.removeEventListener(CHECK_UPDATES_EVENT, onManual);
  }, [run]);

  async function install(update: Update) {
    let done = 0;
    let total: number | undefined;
    setState({ kind: 'downloading', update, done });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength;
        else if (event.event === 'Progress') done += event.data.chunkLength;
        setState({ kind: 'downloading', update, done, total });
      });
      setState({ kind: 'ready' });
      await relaunchApp();
    } catch (e) {
      setState({ kind: 'error', message: `更新失败：${String(e)}` });
    }
  }

  if (state.kind === 'idle') return null;
  const close = () => {
    if (state.kind !== 'downloading' && state.kind !== 'ready') setState({ kind: 'idle' });
  };
  return (
    <Modal title="客户端更新" onClose={close} className="update-prompt">
      {state.kind === 'checking' && <p>正在检查更新…</p>}
      {state.kind === 'latest' && <p>已是最新版本。</p>}
      {state.kind === 'error' && <p className="error">{state.message}</p>}
      {state.kind === 'available' && (
        <>
          <p>
            发现新版本 <strong>v{state.update.version}</strong>（当前 v{state.update.currentVersion}）
          </p>
          {state.update.body && <pre className="update-notes">{state.update.body}</pre>}
          <div className="inline-actions">
            <button className="primary" onClick={() => void install(state.update)}>
              下载并安装
            </button>
            <button
              onClick={() => {
                localStorage.setItem(SKIP_KEY, state.update.version);
                setState({ kind: 'idle' });
              }}
            >
              跳过此版本
            </button>
            <button onClick={close}>稍后</button>
          </div>
        </>
      )}
      {state.kind === 'downloading' && (
        <>
          <p>
            正在下载 v{state.update.version}：{mb(state.done)} MB
            {state.total ? ` / ${mb(state.total)} MB` : ''}
          </p>
          <progress value={state.done} max={state.total || undefined} style={{ width: '100%' }} />
        </>
      )}
      {state.kind === 'ready' && <p>安装完成，正在重启…</p>}
    </Modal>
  );
}
