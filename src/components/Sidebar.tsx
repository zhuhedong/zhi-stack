import { BookOpen, ChevronRight, Folder, Radar, Layers, LockKeyhole, ShieldCheck, Star } from 'lucide-react';
import { categories, pillarNames, type Dimension, type Pillar } from '../types';
const icons = { knowledge: BookOpen, repo: Radar, credential: LockKeyhole };
export function Sidebar({
  pillar,
  dimensions,
  dimension,
  favorite,
  open,
  onPillar,
  onDimension,
  onFavorite,
  onClose,
  onProjects,
  onOrganize,
  onTasks,
  onInsights,
  taskCount,
}: {
  pillar: Pillar;
  dimensions: Dimension[];
  dimension: string;
  favorite: boolean;
  open: boolean;
  onPillar: (p: Pillar) => void;
  onDimension: (d: string) => void;
  onFavorite: () => void;
  onClose: () => void;
  onProjects: () => void;
  onOrganize: () => void;
  onTasks: () => void;
  onInsights: () => void;
  taskCount: number;
}) {
  const counts = (kind: Pillar) => dimensions.filter((d) => d.kind === kind).reduce((n, d) => n + d.count, 0);
  const groups = new Map<string, number>();
  for (const d of dimensions.filter((d) => d.kind === pillar)) {
    const key = pillar === 'credential' ? d.project : d.category;
    groups.set(key, (groups.get(key) || 0) + d.count);
  }
  return (
    <>
      {open && <button className="sidebar-scrim" aria-label="关闭导航" onClick={onClose} />}
      <aside className={'sidebar ' + (open ? 'is-open' : '')}>
        <div>
          <div className="nav-label">三大核心资产</div>
          <button className="nav-item" onClick={onProjects}>
            <Folder size={15} />
            <span>项目总览</span>
          </button>
          <nav aria-label="资产分类">
            {(Object.keys(pillarNames) as Pillar[]).map((p) => {
              const Icon = icons[p];
              return (
                <button
                  className={'nav-item ' + p + (pillar === p ? ' active' : '')}
                  aria-current={pillar === p ? 'page' : undefined}
                  key={p}
                  onClick={() => onPillar(p)}
                >
                  <Icon size={15} />
                  <span>{pillarNames[p]}</span>
                  <small className="mono">{counts(p)}</small>
                </button>
              );
            })}
          </nav>
          <div className="dimension-tree">
            <div className="nav-label">
              {pillar === 'credential' ? '按业务项目' : pillar === 'knowledge' ? '按内容来源' : '按开发语言'}
            </div>
            <button
              className={'dimension-item ' + (dimension === 'all' ? 'active' : '')}
              onClick={() => onDimension('all')}
            >
              <Layers size={13} />
              <span>全部{pillar === 'credential' ? '项目' : pillar === 'knowledge' ? '来源' : '语言'}</span>
              <small>{counts(pillar)}</small>
            </button>
            {[...groups].map(([key, count]) => (
              <button
                className={'dimension-item ' + (dimension === key ? 'active' : '')}
                key={key}
                onClick={() => onDimension(key)}
              >
                {pillar === 'credential' ? <Folder size={13} /> : <ChevronRight size={12} />}
                <span>
                  {pillar === 'credential' ? key || '未归属项目' : categories[pillar][key] || key || '未分类'}
                </span>
                <small>{count}</small>
              </button>
            ))}
          </div>
          <div className="dimension-tree">
            <div className="nav-label">快捷视图</div>
            <button className="dimension-item" onClick={onTasks}>
              <Radar size={13} />
              <span>任务与更新</span>
              {taskCount > 0 && <small>{taskCount}</small>}
            </button>
            <button className="dimension-item" onClick={onInsights}>
              <BookOpen size={13} />
              <span>使用与反馈</span>
            </button>
            <button className="dimension-item" onClick={onOrganize}>
              <Layers size={13} />
              <span>筛选与标签</span>
            </button>
            <button className={'dimension-item ' + (favorite ? 'active' : '')} onClick={onFavorite}>
              <Star size={13} />
              <span>加星收藏</span>
              {favorite && <span className="good">✓</span>}
            </button>
          </div>
        </div>
        <div className="sidebar-bottom">
          <ShieldCheck size={16} />
          <div>
            <strong>属于你的数字资产</strong>
            <p>凭证加密 · 资源持久保存</p>
          </div>
          <div className="storage-row">
            <span>服务端存储</span>
            <span className="mono">PostgreSQL</span>
          </div>
          <div className="storage-row">
            <span>凭证加密</span>
            <span className="good mono">AES-256-GCM</span>
          </div>
        </div>
      </aside>
    </>
  );
}
