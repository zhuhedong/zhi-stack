import {
  Database,
  Download,
  LockKeyhole,
  LockKeyholeOpen,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings2,
} from 'lucide-react';
import { isDesktop, shortcutModifier } from '../lib/platform';
import { BrandIcon } from './BrandIcon';
export function Header({
  unlocked,
  busy,
  onIngest,
  onAdd,
  onSearch,
  onLock,
  onLogout,
  onMenu,
  onServerSettings,
  onManage,
}: {
  unlocked: boolean;
  busy: boolean;
  onIngest: () => void;
  onAdd: () => void;
  onSearch: () => void;
  onLock: () => void;
  onLogout: () => void;
  onMenu: () => void;
  onServerSettings: () => void;
  onManage: () => void;
}) {
  return (
    <header className="app-header">
      <div className="header-brand">
        <button className="icon-button mobile-menu" onClick={onMenu} aria-label="展开导航">
          <Menu size={18} />
        </button>
        <BrandIcon />
        <strong>
          InfoHub <span className="brand-subtitle">开发者数字工作台</span>
        </strong>
        <span className="database-status">
          <Database size={12} />
          PostgreSQL
        </span>
      </div>
      <div className="header-create">
        <button className="primary" aria-label="收录抓取" onClick={onIngest}>
          <Download size={13} />
          <span>收录抓取</span>
          <kbd>{shortcutModifier} V</kbd>
        </button>
        <button aria-label="新建资产" onClick={onAdd}>
          <Plus size={14} />
          <span>新建资产</span>
        </button>
      </div>
      <div className="header-actions">
        <button
          className="icon-button"
          aria-label="数据与安全"
          title="数据与安全"
          disabled={busy}
          onClick={onManage}
        >
          <Database size={14} />
        </button>
        {isDesktop && (
          <button
            className="icon-button"
            disabled={busy}
            aria-label="更换服务器"
            title="更换服务器"
            onClick={onServerSettings}
          >
            <Settings2 size={14} />
          </button>
        )}
        <button className="global-search" aria-label="全局检索" onClick={onSearch}>
          <Search size={13} />
          <span>全局检索</span>
          <kbd>{shortcutModifier} F</kbd>
        </button>
        <button
          className={unlocked ? 'vault-button good' : 'vault-button warning-text'}
          aria-label={unlocked ? '金库已解锁' : '金库已锁定'}
          disabled={busy}
          onClick={onLock}
        >
          {unlocked ? <LockKeyholeOpen size={13} /> : <LockKeyhole size={13} />}
          <span>{unlocked ? '金库已解锁' : '金库已锁定'}</span>
        </button>
        <button className="icon-button logout" aria-label="退出登录" title="退出登录" onClick={onLogout}>
          <LogOut size={14} />
        </button>
      </div>
    </header>
  );
}
