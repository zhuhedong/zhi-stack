import { useEffect, useState } from 'react';
import { requestUpdateCheck } from '../lib/updater';

/** "客户端更新" tab in 数据与安全 (desktop only). */
export function UpdateSettings() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    void import('@tauri-apps/api/app').then(({ getVersion }) => getVersion().then(setVersion));
  }, []);
  return (
    <div>
      <h3>客户端更新</h3>
      <p className="muted">
        当前版本 {version ? `v${version}` : '…'}。启动时会自动检查 GitHub 上的最新版本。
      </p>
      <button onClick={requestUpdateCheck}>检查更新</button>
    </div>
  );
}
