import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { categories, pillarNames, type Item, type ItemInput, type Pillar } from '../types';
import { errorMessage, saveItem } from '../lib/api';
import { fieldNames, secretField } from '../lib/fields';

const presets: Record<string, { label: string; category: string; fields: Record<string, string> }> = {
  rest_api: { label: 'REST API / Swagger', category: 'http', fields: { baseUrl: '', swaggerUrl: '' } },
  postgresql: {
    label: 'PostgreSQL',
    category: 'sql',
    fields: { host: '', port: '5432', database: '', username: '', password: '' },
  },
  mysql: {
    label: 'MySQL / 兼容协议',
    category: 'sql',
    fields: { host: '', port: '3306', database: '', username: '', password: '' },
  },
  redis: {
    label: 'Redis',
    category: 'nosql',
    fields: { host: '', port: '6379', dbIndex: '0', authPassword: '' },
  },
  mongodb: {
    label: 'MongoDB',
    category: 'nosql',
    fields: { host: '', port: '27017', database: '', username: '', password: '' },
  },
  milvus: {
    label: 'Milvus',
    category: 'vector',
    fields: { host: '', port: '19530', username: '', password: '', collection: '' },
  },
  qdrant: {
    label: 'Qdrant',
    category: 'vector',
    fields: { host: '', port: '6333', apiKey: '', collection: '' },
  },
  ssh: {
    label: 'SSH 服务器',
    category: 'server',
    fields: { host: '', port: '22', username: 'root', password: '', privateKey: '' },
  },
  account: {
    label: '账号与密码',
    category: 'account',
    fields: { url: '', username: '', password: '', notes: '' },
  },
};
export function ItemEditor({
  item,
  pillar,
  unlocked,
  onDraft,
  projects,
  onClose,
  onSaved,
}: {
  item?: Item;
  pillar: Pillar;
  unlocked: boolean;
  onDraft: (dirty: boolean, kind?: Pillar) => void;
  projects: string[];
  onClose: () => void;
  onSaved: (item: Item) => void;
}) {
  const [form, setForm] = useState<ItemInput>(() =>
    item
      ? structuredClone(item)
      : {
          kind: pillar,
          title: '',
          category: pillar === 'credential' ? 'http' : pillar === 'knowledge' ? 'note' : 'Rust',
          project: '',
          tags: [],
          summary: '',
          url: '',
          favorite: false,
          data:
            pillar === 'credential'
              ? {
                  typeKey: 'rest_api',
                  fields: { ...presets.rest_api.fields },
                  globalHeaders: [],
                  swaggerEndpoints: [],
                }
              : {},
        },
  );
  const [tagText, setTagText] = useState(item?.tags.join(', ') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [customKey, setCustomKey] = useState('');
  const kindDrafts = useRef<Partial<Record<Pillar, Pick<ItemInput, 'category' | 'data'>>>>({});
  const protocolDrafts = useRef<Record<string, ItemInput['data']>>({});
  useEffect(() => {
    if (!unlocked) {
      delete kindDrafts.current.credential;
      protocolDrafts.current = {};
    }
  }, [unlocked]);
  const active = useRef(true);
  useEffect(() => {
    onDraft(dirty || busy, form.kind);
  }, [dirty, busy, form.kind, onDraft]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      onDraft(false);
    };
  }, [onDraft]);
  const change = (patch: Partial<ItemInput>) => {
    setForm((v) => ({ ...v, ...patch }));
    setDirty(true);
  };
  const data = (patch: Partial<ItemInput['data']>) => change({ data: { ...form.data, ...patch } });
  const close = () => {
    if (!busy && (!dirty || window.confirm('尚有未保存的内容，放弃这些修改？'))) onClose();
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const saved = await saveItem(
        {
          ...form,
          data: persistableCredentialData(form.data, form.kind),
          tags: tagText
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
        },
        item?.id,
      );
      if (active.current) onSaved(saved);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={item ? '编辑资产属性' : '新建资产条目'} onClose={close} wide>
      <form onSubmit={submit}>
        <fieldset className="form-fields" disabled={busy}>
          <div className="modal-body">
            <div className="form-grid">
              <label>
                资产类型
                <select
                  aria-label="资产类型"
                  value={form.kind}
                  disabled={!!item}
                  onChange={(e) => {
                    const kind = e.target.value as Pillar;
                    kindDrafts.current[form.kind] = { category: form.category, data: form.data };
                    const previous = kindDrafts.current[kind];
                    change({
                      kind,
                      category:
                        previous?.category ||
                        (kind === 'credential' ? 'http' : kind === 'knowledge' ? 'note' : 'Rust'),
                      data:
                        previous?.data ||
                        (kind === 'credential'
                          ? {
                              typeKey: 'rest_api',
                              fields: { ...presets.rest_api.fields },
                              globalHeaders: [],
                              swaggerEndpoints: [],
                            }
                          : {}),
                    });
                  }}
                >
                  {Object.entries(pillarNames).map(([v, label]) => (
                    <option key={v} value={v} disabled={v === 'credential' && !unlocked}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {form.kind === 'credential' ? (
                <label>
                  协议 / 类型
                  <select
                    aria-label="协议 / 类型"
                    value={form.data.typeKey || 'rest_api'}
                    onChange={(e) => {
                      const preset = presets[e.target.value];
                      const previousKey = form.data.typeKey || 'rest_api';
                      protocolDrafts.current[previousKey] = structuredClone(form.data);
                      const snapshot = protocolDrafts.current[e.target.value];
                      const fields =
                        snapshot?.fields ||
                        Object.fromEntries(
                          Object.entries(preset.fields).map(([key, value]) => [
                            key,
                            key !== 'port' ? (form.data.fields?.[key] ?? value) : value,
                          ]),
                        );
                      change({
                        category: preset.category,
                        data: protocolData(e.target.value, fields, snapshot, form.data),
                      });
                    }}
                  >
                    {Object.entries(presets).map(([v, p]) => (
                      <option key={v} value={v}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label>
                  {form.kind === 'repo' ? '主要语言' : '文章来源'}
                  {form.kind === 'repo' ? (
                    <input value={form.category} onChange={(e) => change({ category: e.target.value })} />
                  ) : (
                    <select value={form.category} onChange={(e) => change({ category: e.target.value })}>
                      {Object.entries(categories.knowledge).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              )}
              <label className="span-2">
                {form.kind === 'knowledge' ? '文章标题' : '资产名称'}
                <input
                  autoFocus
                  value={form.title}
                  onChange={(e) => change({ title: e.target.value })}
                  required
                  maxLength={500}
                  placeholder="为这条资料起一个便于查找的名字"
                />
              </label>
              <label>
                所属项目
                <input
                  list="project-options"
                  value={form.project}
                  onChange={(e) => change({ project: e.target.value })}
                  placeholder="选择或输入项目名称"
                />
                <datalist id="project-options">
                  {projects.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </datalist>
              </label>
              <label>
                标签
                <input
                  value={tagText}
                  onChange={(e) => {
                    setTagText(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="Rust, 后端, 生产环境"
                />
              </label>
              {form.kind !== 'credential' && (
                <label className="span-2">
                  来源 URL
                  <input
                    type="url"
                    value={form.url}
                    onChange={(e) => change({ url: e.target.value })}
                    placeholder="https://"
                  />
                </label>
              )}
              <label className="span-2">
                {form.kind === 'credential' ? '备注（加密保存）' : '摘要'}
                <textarea
                  rows={2}
                  value={form.kind === 'credential' ? form.data.description || '' : form.summary}
                  onChange={(e) =>
                    form.kind === 'credential'
                      ? data({ description: e.target.value })
                      : change({ summary: e.target.value })
                  }
                />
              </label>
            </div>
            {form.kind === 'credential' && (
              <>
                <div className="section-title">
                  <h3>连接属性</h3>
                  <span className="good">AES-256-GCM 加密</span>
                </div>
                <div className="form-grid">
                  {Object.entries(form.data.fields || {}).map(([key, value]) => (
                    <label key={key} className={key === 'privateKey' ? 'span-2' : ''}>
                      {fieldNames[key] || key}
                      <div className="input-action">
                        {key === 'privateKey' ? (
                          <textarea
                            rows={3}
                            value={value}
                            onChange={(e) => data({ fields: { ...form.data.fields, [key]: e.target.value } })}
                          />
                        ) : (
                          <input
                            type={secretField(key) ? 'password' : 'text'}
                            value={value}
                            autoComplete="off"
                            onChange={(e) => data({ fields: { ...form.data.fields, [key]: e.target.value } })}
                          />
                        )}
                        <button
                          type="button"
                          className="icon-button"
                          title={`删除属性 ${key}`}
                          aria-label={`删除属性 ${key}`}
                          onClick={() => {
                            const fields = { ...form.data.fields };
                            delete fields[key];
                            data({ fields });
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="add-field">
                  <input
                    aria-label="自定义属性名称"
                    placeholder="自定义属性名称"
                    value={customKey}
                    onChange={(e) => setCustomKey(e.target.value)}
                  />
                  <button
                    type="button"
                    disabled={!customKey.trim() || Object.hasOwn(form.data.fields || {}, customKey.trim())}
                    onClick={() => {
                      data({ fields: { ...form.data.fields, [customKey.trim()]: '' } });
                      setCustomKey('');
                    }}
                  >
                    <Plus size={13} />
                    添加属性
                  </button>
                </div>
                {form.category === 'http' && (
                  <label>
                    导入 OpenAPI 规范（可选，JSON / YAML）
                    <textarea
                      aria-label="OpenAPI 规范"
                      className="mono"
                      rows={5}
                      value={form.data.importSpec || ''}
                      onChange={(e) => data({ importSpec: e.target.value })}
                      placeholder="粘贴 OpenAPI 3.x 或 Swagger 2.0 规范，保存时生成接口列表"
                    />
                  </label>
                )}
              </>
            )}
            {form.kind === 'knowledge' && (
              <>
                <div className="form-grid">
                  <label>
                    作者
                    <input
                      value={form.data.author || ''}
                      onChange={(e) => data({ author: e.target.value })}
                    />
                  </label>
                  <label>
                    来源名称
                    <input
                      value={form.data.sourceName || ''}
                      onChange={(e) => data({ sourceName: e.target.value })}
                    />
                  </label>
                </div>
                <label>
                  Markdown 正文
                  <textarea
                    aria-label="Markdown 正文"
                    className="mono"
                    rows={10}
                    value={form.data.content || ''}
                    onChange={(e) => data({ content: e.target.value })}
                    placeholder="# 从这里开始记录"
                  />
                </label>
              </>
            )}
            {form.kind === 'repo' && (
              <>
                <label>
                  本地工作区路径
                  <input
                    className="mono"
                    value={form.data.localWorkspacePath || ''}
                    onChange={(e) => data({ localWorkspacePath: e.target.value })}
                    placeholder="D:/develop/my-project"
                  />
                </label>
                <label>
                  实践笔记
                  <textarea
                    rows={6}
                    value={form.data.cookbookNotes || ''}
                    onChange={(e) => data({ cookbookNotes: e.target.value })}
                  />
                </label>
              </>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
          </div>
          <div className="modal-foot">
            <button type="button" onClick={close} disabled={busy}>
              取消
            </button>
            <button className="primary" disabled={busy}>
              {busy && <LoaderCircle size={14} className="spin" />}
              {busy ? '正在保存…' : '保存资产'}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

const REST_ONLY = ['importSpec', 'swaggerEndpoints', 'globalHeaders', 'spec'] as const;

function protocolData(
  typeKey: string,
  fields: Record<string, string>,
  snapshot: ItemInput['data'] | undefined,
  current: ItemInput['data'],
): ItemInput['data'] {
  const shared: ItemInput['data'] = {
    typeKey,
    fields,
    description: current.description,
    sourceUrl: current.sourceUrl,
  };
  if (typeKey !== 'rest_api') return shared;
  return {
    ...shared,
    importSpec: snapshot?.importSpec || '',
    swaggerEndpoints: snapshot?.swaggerEndpoints || [],
    globalHeaders: snapshot?.globalHeaders || [],
    spec: snapshot?.spec,
  };
}

function persistableCredentialData(data: ItemInput['data'], kind: Pillar): ItemInput['data'] {
  if (kind !== 'credential' || !data.typeKey || data.typeKey === 'rest_api') return data;
  const next = { ...data };
  for (const key of REST_ONLY) delete next[key];
  return next;
}
