import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { isDesktop, isMac } from '../lib/platform';

type AppWindow = Awaited<ReturnType<typeof loadWindow>>;
async function loadWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

/** Custom title-bar buttons for frameless desktop windows (Windows / Linux). */
export function WindowControls() {
  const [win, setWin] = useState<AppWindow | null>(null);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isDesktop || isMac) return;
    let stop: (() => void) | undefined;
    let disposed = false;
    void loadWindow().then(async (w) => {
      if (disposed) return;
      setWin(w);
      setMaximized(await w.isMaximized());
      stop = await w.onResized(async () => setMaximized(await w.isMaximized()));
      if (disposed) stop();
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  if (!isDesktop || isMac) return null;
  return (
    <div className="window-controls" role="group" aria-label="窗口控制">
      <button aria-label="最小化" title="最小化" onClick={() => void win?.minimize()}>
        <Minus size={14} />
      </button>
      <button
        aria-label={maximized ? '还原' : '最大化'}
        title={maximized ? '还原' : '最大化'}
        onClick={() => void win?.toggleMaximize()}
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button className="close" aria-label="关闭" title="关闭" onClick={() => void win?.close()}>
        <X size={15} />
      </button>
    </div>
  );
}
