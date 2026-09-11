import { useState } from 'react';
import { Code2, Copy, ExternalLink, FolderOpen, GitFork, Save, Star, Terminal, Users } from 'lucide-react';
import type { Item } from '../../types';
import { dateLabel } from '../../types';
import { copyText, desktopAction, errorMessage, saveItem } from '../../lib/api';
import { Markdown } from '../Markdown';
import { Attachments } from '../Attachments';
import { SourceLink } from '../SourceLink';
import { useDraft } from '../../lib/useDraft';
export function RepoView({
  item,
  onSaved,
  onDirty,
  notify,
}: {
  item: Item;
  onSaved: (item: Item) => void;
  onDirty: (dirty: boolean) => void;
  notify: (message: string) => void;
}) {
  const [path, setPath] = useState(item.data.localWorkspacePath || '');
  const [notes, setNotes] = useState(item.data.cookbookNotes || '');
  const [tab, setTab] = useState('readme');
  const [preview, setPreview] = useState(false);
  const draft = useDraft(onDirty);
  const { dirty } = draft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = () => {
    draft.change();
  };
  async function save() {
    const snapshot = draft.snapshot();
    setBusy(true);
    setError('');
    try {
      const updated = await saveItem(
        { ...item, data: { ...item.data, localWorkspacePath: path, cookbookNotes: notes } },
        item.id,
      );
      if (draft.saved(snapshot)) onSaved(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function open(action: 'vscode' | 'terminal' | 'folder') {
    try {
      await desktopAction(action, path);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="canvas">
      <div className="content-title">
        <div className="title-tags">
          <span className="badge repo">{item.category}</span>
          <span className="muted mono">{item.data.license || '未标注许可证'}</span>
        </div>
        <h1>{item.title}</h1>
        <p className="content-description">{item.summary}</p>
        <div className="repo-stats">
          <span>
            <Star size={14} />
            {item.data.stars?.toLocaleString() || '—'} stars
          </span>
          <span>
            <GitFork size={14} />
            {item.data.forks?.toLocaleString() || '—'} forks
          </span>
          <span>
            <Users size={14} />
            {item.data.watchers?.toLocaleString() || '—'} watching
          </span>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <section className="workspace-card">
        <div className="section-title">
          <h3>
            <FolderOpen size={15} />
            本地开发工作区
          </h3>
          <button
            className="text-button"
            onClick={() =>
              void copyText(path)
                .then(() => notify('路径已复制'))
                .catch((e) => setError(errorMessage(e)))
            }
            disabled={!path}
          >
            <Copy size={12} />
            复制路径
          </button>
        </div>
        <input
          className="mono"
          aria-label="本地工作区路径"
          placeholder="D:/develop/my-project"
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            change();
          }}
        />
        <div className="workspace-buttons">
          <button className="primary" disabled={!path} onClick={() => void open('vscode')}>
            <Code2 size={14} />
            VS Code 打开
          </button>
          <button disabled={!path} onClick={() => void open('terminal')}>
            <Terminal size={14} />
            启动终端
          </button>
          <button disabled={!path} onClick={() => void open('folder')}>
            <FolderOpen size={14} />
            文件管理器
          </button>
        </div>
      </section>
      <div className="tabs">
        <button className={tab === 'readme' ? 'active' : ''} onClick={() => setTab('readme')}>
          README
        </button>
        <button className={tab === 'release' ? 'active' : ''} onClick={() => setTab('release')}>
          版本更新
        </button>
        <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
          实践笔记
        </button>
      </div>
      {tab === 'release' && (
        <section>
          <div className="section-title">
            <h3>
              {item.data.latestRelease || '暂无 Release'}{' '}
              <span className="muted">{dateLabel(item.data.releaseDate)}</span>
            </h3>
            {item.data.releaseUrl && (
              <SourceLink
                className="text-button"
                href={item.data.releaseUrl}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={13} />
                发布页
              </SourceLink>
            )}
          </div>
          <Markdown text={item.data.releaseNotes || '这个仓库尚未发布版本，或版本信息尚未同步。'} />
        </section>
      )}
      {tab === 'readme' && (
        <Markdown
          baseUrl={item.url ? item.url + '/blob/' + (item.data.defaultBranch || 'main') + '/' : undefined}
          text={item.data.readme || '暂无 README，可通过顶部“重新同步”获取。'}
        />
      )}
      {tab === 'notes' && (
        <section>
          <div className="section-title">
            <h3>实践与避坑笔记</h3>
            <button onClick={() => setPreview((v) => !v)}>{preview ? '编辑' : '预览'}</button>
          </div>
          {preview ? (
            <Markdown text={notes || '暂无笔记'} />
          ) : (
            <textarea
              className="notes-editor mono"
              aria-label="实践笔记"
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                change();
              }}
              placeholder="# 记录这个项目的使用方式与实践经验"
            />
          )}
        </section>
      )}
      <div className="save-bar">
        <span className="muted">{dirty ? '工作区或笔记有未保存的修改' : '工作区与笔记已保存'}</span>
        <button className="primary" disabled={!dirty || busy} onClick={() => void save()}>
          <Save size={14} />
          {busy ? '保存中…' : '保存工作区与笔记'}
        </button>
      </div>
      <Attachments id={item.id} />
    </div>
  );
}
