import {
  ArrowLeft,
  Edit3,
  ExternalLink,
  Inbox,
  History,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Star,
  Trash2,
} from 'lucide-react';
import { categoryName, dateLabel, type Item } from '../types';
import { KnowledgeView } from './views/KnowledgeView';
import { RepoView } from './views/RepoView';
import { CredentialView } from './views/CredentialView';
import { SourceLink } from './SourceLink';
import { RelatedItems } from './RelatedItems';
export function Workspace({
  item,
  selectedKind,
  loading,
  error,
  unlocked,
  busy,
  viewEpoch,
  onEdit,
  onDelete,
  onRefresh,
  onHistory,
  onOpen,
  onStar,
  onBack,
  onUnlock,
  onCreate,
  onSaved,
  onDirty,
  notify,
}: {
  item: Item | null;
  selectedKind?: string;
  loading: boolean;
  error: string;
  unlocked: boolean;
  busy: boolean;
  viewEpoch: number;
  onEdit: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onHistory: () => void;
  onOpen: (item: Pick<Item, 'id' | 'kind'>) => void;
  onStar: () => void;
  onBack: () => void;
  onUnlock: () => void;
  onCreate: () => void;
  onSaved: (item: Item) => void;
  onDirty: (dirty: boolean) => void;
  notify: (message: string) => void;
}) {
  const locked = selectedKind === 'credential' && !unlocked;
  return (
    <main className="workspace">
      <div className="workspace-toolbar">
        <div className="workspace-meta">
          <button className="icon-button back-button" onClick={onBack} aria-label="返回资产列表">
            <ArrowLeft size={16} />
          </button>
          {item ? (
            <>
              <span className={'badge ' + item.kind}>{categoryName(item)}</span>
              <span className="project-source">
                {item.project || item.data.sourceName || item.data.owner || '个人工作台'}
              </span>
              <span className="muted mono toolbar-date">{dateLabel(item.updatedAt)}</span>
            </>
          ) : (
            <span className="muted">资产工作区</span>
          )}
        </div>
        {item && !locked && (
          <div className="workspace-actions">
            <button
              className="icon-button"
              aria-label="版本历史"
              title="版本历史"
              disabled={busy}
              onClick={onHistory}
            >
              <History size={14} />
            </button>
            {item.url && (
              <SourceLink
                className="icon-button"
                href={item.url}
                target="_blank"
                rel="noreferrer"
                title="查看来源"
                aria-label="查看来源"
              >
                <ExternalLink size={14} />
              </SourceLink>
            )}
            <button
              className={'icon-button ' + (item.favorite ? 'starred' : '')}
              title={item.favorite ? '取消收藏' : '收藏'}
              aria-label={item.favorite ? '取消收藏' : '收藏'}
              disabled={busy}
              onClick={onStar}
            >
              <Star size={14} />
            </button>
            <button aria-label="重新同步" disabled={busy} onClick={onRefresh}>
              <RefreshCw size={13} className={busy ? 'spin' : ''} />
              <span>重新同步</span>
            </button>
            <button aria-label="编辑属性" disabled={busy} onClick={onEdit}>
              <Edit3 size={13} />
              <span>编辑属性</span>
            </button>
            <button
              disabled={busy}
              className="icon-button danger-text"
              aria-label="删除条目"
              onClick={onDelete}
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
      {locked ? (
        <div className="workspace-empty">
          <LockKeyhole size={36} />
          <h2>金库已锁定</h2>
          <p>输入主密码，查看连接凭证并使用接口工作区。</p>
          <button className="primary" onClick={onUnlock}>
            解锁密码库
          </button>
        </div>
      ) : loading ? (
        <div className="workspace-empty">
          <LoaderCircle className="spin" size={24} />
          <p>正在读取资产…</p>
        </div>
      ) : error ? (
        <div className="workspace-empty">
          <p className="error" role="alert">
            {error}
          </p>
        </div>
      ) : !item ? (
        <div className="workspace-empty">
          <Inbox size={38} />
          <h2>把有用的资料留下来</h2>
          <p>选择左侧条目查看详情，或新建第一条资产。</p>
          <button className="primary" onClick={onCreate}>
            新建资产条目
          </button>
        </div>
      ) : (
        <div className="workspace-scroll" key={item.id + ':' + viewEpoch} inert={busy}>
          <RelatedItems item={item} onOpen={onOpen} />
          {item.kind === 'knowledge' ? (
            <KnowledgeView item={item} onSaved={onSaved} onDirty={onDirty} />
          ) : item.kind === 'repo' ? (
            <RepoView item={item} onSaved={onSaved} onDirty={onDirty} notify={notify} />
          ) : (
            <CredentialView item={item} onSaved={onSaved} onDirty={onDirty} notify={notify} />
          )}
        </div>
      )}
    </main>
  );
}
