import { useEffect, useState } from 'react';
import { listOffline, offlineEnabled, offlineSupported, setOfflineEnabled } from '../lib/offline';
import { OfflineReader } from './OfflineReader';

/** Per-device offline reading switch and PWA install notes. */
export function OfflineSettings() {
  const [enabled, setEnabled] = useState(offlineEnabled);
  const [count, setCount] = useState(0);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    let live = true;
    void listOffline().then((list) => live && setCount(list.length));
    return () => {
      live = false;
    };
  }, [enabled, reading]);
  if (!offlineSupported())
    return <p className="muted">当前环境不支持离线阅读（桌面客户端或浏览器不支持 Cache Storage）。</p>;
  return (
    <div className="offline-settings">
      <h3>离线阅读</h3>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const next = e.target.checked;
            void setOfflineEnabled(next).then(() => setEnabled(next));
          }}
        />
        在此设备上保存打开过的文章，供离线阅读
      </label>
      <p className="muted">
        仅保存文章与笔记（不含凭据），存放在此浏览器的缓存中且未加密，任何能使用此浏览器的人都可以在登录页打开“离线阅读”。共享设备请勿开启；关闭开关会立即删除已保存的文章。
      </p>
      {enabled && (
        <div className="inline-actions">
          <span className="muted">已保存 {count} 篇</span>
          <button disabled={!count} onClick={() => setReading(true)}>
            打开离线阅读
          </button>
        </div>
      )}
      <h3>安装为应用</h3>
      <p className="muted">
        在 Chrome / Edge
        地址栏点击“安装”，或在手机浏览器菜单中选择“添加到主屏幕”。安装后可从系统分享菜单把链接直接分享给
        InfoHub 收录。
      </p>
      {reading && <OfflineReader onClose={() => setReading(false)} />}
    </div>
  );
}
