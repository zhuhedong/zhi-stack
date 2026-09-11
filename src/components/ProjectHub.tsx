import { Form } from './Form';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, Folder, Plus } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { pillarNames, type Item } from '../types';
import { Modal } from './Modal';
import { useConfirm } from '../lib/confirmation';

interface Project {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  revision: number;
  count?: number;
}
export function ProjectHub({
  onClose,
  onOpen,
  onChanged,
}: {
  onClose: () => void;
  onOpen: (item: Item) => void;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [archived, setArchived] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    const result = await api<Project[]>('/projects');
    setProjects(Array.isArray(result) ? result : []);
  }
  useEffect(() => {
    let alive = true;
    void api<Project[]>('/projects')
      .then((result) => {
        if (alive) setProjects(Array.isArray(result) ? result : []);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  const dirty =
    editing &&
    (name !== (selected?.name || '') ||
      description !== (selected?.description || '') ||
      archived !== (selected?.archived || false));
  const mayLeave = async () =>
    !dirty ||
    (await confirm({
      title: '离开项目编辑',
      description: '未保存的项目名称、说明及归档状态会丢失，确认放弃修改？',
      confirmLabel: '放弃修改',
      cancelLabel: '继续编辑',
      danger: true,
    }));
  async function select(id: string) {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ project: Project; items: Item[] }>(`/projects/${id}`);
      setSelected(result.project);
      setItems(result.items);
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function edit(project: Project | null) {
    if (!(await mayLeave())) return;
    setSelected(project);
    setName(project?.name || '');
    setDescription(project?.description || '');
    setArchived(project?.archived || false);
    setEditing(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const project = await api<Project>(selected ? `/projects/${selected.id}` : '/projects', {
        method: selected ? 'PUT' : 'POST',
        body: JSON.stringify({ name, description, archived, revision: selected?.revision }),
      });
      await load();
      await select(project.id);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="项目总览"
      onClose={async () => {
        if (!busy && (await mayLeave())) onClose();
      }}
      wide
    >
      <div className="modal-body project-hub">
        <aside className="project-index">
          <button className="primary" disabled={busy} onClick={() => edit(null)}>
            <Plus size={14} />
            创建项目
          </button>
          <label className="search-scope">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            显示归档项目
          </label>
          {projects
            .filter((p) => showArchived || !p.archived)
            .map((p) => (
              <button
                key={p.id}
                disabled={busy}
                className={selected?.id === p.id ? 'selected' : ''}
                onClick={async () => {
                  if (await mayLeave()) void select(p.id);
                }}
              >
                <Folder size={14} />
                <span>{p.name}</span>
                <small>{p.count || 0}</small>
              </button>
            ))}
          {projects.length === 0 && <p className="muted">创建一个项目，把资料、代码和连接放在一起。</p>}
        </aside>
        <section className="project-detail">
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {editing ? (
            <Form className="maintenance-form" onSubmit={save}>
              <h3>{selected ? '编辑项目' : '新项目'}</h3>
              <label>
                项目名称
                <input required value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                项目说明
                <textarea
                  value={description}
                  disabled={busy}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="记录目标、当前进展和下次开始的位置"
                />
              </label>
              <label className="search-scope">
                <input
                  type="checkbox"
                  checked={archived}
                  disabled={busy}
                  onChange={(e) => setArchived(e.target.checked)}
                />
                归档项目
              </label>
              <p className="muted">重命名会更新所属资产；归档项目仍保留全部资料。</p>
              <button className="primary" disabled={busy}>
                保存项目
              </button>
            </Form>
          ) : selected ? (
            <>
              <div className="section-title">
                <h2>{selected.name}</h2>
                <button disabled={busy} onClick={() => edit(selected)}>
                  编辑项目
                </button>
              </div>
              {selected.description && <p className="project-description">{selected.description}</p>}
              {Object.entries(pillarNames).map(([kind, label]) => (
                <section className="project-assets" key={kind}>
                  <h3>
                    {label} <span className="muted">{items.filter((i) => i.kind === kind).length}</span>
                  </h3>
                  {items
                    .filter((i) => i.kind === kind)
                    .map((item) => (
                      <button className="project-asset" key={item.id} onClick={() => onOpen(item)}>
                        <div>
                          <strong>{item.title}</strong>
                          <p className="muted">{item.summary || item.tags.join(' · ') || item.category}</p>
                        </div>
                        <ArrowUpRight size={14} />
                      </button>
                    ))}
                  {!items.some((i) => i.kind === kind) && (
                    <p className="muted">收录或编辑资产时选择「{selected.name}」即可归入此处。</p>
                  )}
                </section>
              ))}
            </>
          ) : (
            <div className="inline-empty">
              <Folder size={28} />
              <p>选择项目，继续手头的工作。</p>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
