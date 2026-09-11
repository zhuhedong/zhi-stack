import { useState } from 'react';
import { Braces, Check, Copy, Download, LoaderCircle, Plus, Save, Send, Trash2 } from 'lucide-react';
import type { Endpoint, Item, ItemData } from '../types';
import { sizeLabel } from '../types';
import { copyText, downloadBlob, errorMessage, exportText, saveItem } from '../lib/api';
import { buildCurl, buildRequest, emptyEndpoint, endpointPath, mergeHeaders } from '../lib/request';
import { PairEditor } from './PairEditor';
import { Attachments } from './Attachments';
import { RequestHeaders } from './RequestHeaders';
import { useDraft } from '../lib/useDraft';
import { usePersistentDraft } from '../lib/usePersistentDraft';
import { DraftNotice } from './DraftNotice';
import { ApiEnvironments } from './ApiEnvironments';
import { RequestHistory } from './RequestHistory';
import { useProbe } from '../lib/useProbe';

export function ApiWorkbench({
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
  const [data, setData] = useState<ItemData>(() => structuredClone(item.data));
  const [tab, setTab] = useState('swagger');
  const [epTab, setEpTab] = useState('headers');
  const [index, setIndex] = useState(0);
  const [search, setSearch] = useState('');
  const draft = useDraft(onDirty);
  const { dirty } = draft;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const probe = useProbe(item.id);
  const { sending, response } = probe;
  const [responseTab, setResponseTab] = useState('body');
  const persistence = usePersistentDraft({
    scope: `api:${item.id}`,
    kind: 'credential',
    itemId: item.id,
    revision: item.revision,
    value: data,
    dirty,
    onRestore: (value) => {
      setData(value);
      draft.change();
      invalidateProbe();
    },
  });
  const endpoints = data.swaggerEndpoints || [];
  const ep = endpoints[index];
  const invalidateProbe = () => {
    probe.reset();
  };
  const update = (patch: Partial<ItemData>) => {
    setData((v) => ({ ...v, ...patch }));
    draft.change();
    invalidateProbe();
  };
  const changeEndpoint = (patch: Partial<Endpoint>) =>
    update({ swaggerEndpoints: endpoints.map((e, i) => (i === index ? { ...e, ...patch } : e)) });
  let curl = '';
  try {
    if (ep) curl = buildCurl(data, ep);
  } catch (e) {
    curl = '# ' + errorMessage(e);
  }
  let responseBody = response?.body || '';
  try {
    responseBody = JSON.stringify(JSON.parse(responseBody), null, 2);
  } catch {
    /* Preserve non-JSON response bodies. */
  }
  async function save() {
    const snapshot = draft.snapshot();
    setSaving(true);
    setError('');
    try {
      const updated = await saveItem({ ...item, data }, item.id);
      await persistence.clear(data);
      if (draft.saved(snapshot)) onSaved(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  async function send() {
    if (!ep) return;
    setError('');
    try {
      if (ep.requestWarning && !ep.requestBody && !['GET', 'HEAD'].includes(ep.method))
        throw new Error(ep.requestWarning);
      await probe.run(
        buildRequest(data, ep),
        data.environments?.find((env) => env.id === data.activeEnvironment)?.name || '默认',
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function copy() {
    try {
      await copyText(curl);
      notify('cURL 命令已复制（适用于 Bash / WSL）');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="api-workbench">
      <DraftNotice draft={persistence} />
      <div className="environment-bar">
        <label>
          当前环境
          <select
            aria-label="当前环境"
            value={data.activeEnvironment || ''}
            onChange={(event) => update({ activeEnvironment: event.target.value })}
          >
            <option value="">默认（原始值）</option>
            {(data.environments || []).map((env) => (
              <option key={env.id} value={env.id}>
                {env.name || '未命名环境'}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setTab('environments')}>管理环境</button>
      </div>
      <div className="tabs main-tabs">
        <button className={tab === 'swagger' ? 'active' : ''} onClick={() => setTab('swagger')}>
          接口与参数 <span>{endpoints.length}</span>
        </button>
        <button className={tab === 'headers' ? 'active' : ''} onClick={() => setTab('headers')}>
          全局请求头 <span>{data.globalHeaders?.length || 0}</span>
        </button>
        <button className={tab === 'attachments' ? 'active' : ''} onClick={() => setTab('attachments')}>
          附件与白皮书
        </button>
        <button
          className={tab === 'history' ? 'active' : ''}
          onClick={() => {
            invalidateProbe();
            setTab('history');
          }}
        >
          请求历史
        </button>
      </div>
      {(error || probe.error) && (
        <div className="error" role="alert">
          {error || probe.error}
        </div>
      )}
      {tab === 'environments' ? (
        <ApiEnvironments data={data} onChange={update} />
      ) : tab === 'history' ? (
        <RequestHistory itemId={item.id} />
      ) : tab === 'attachments' ? (
        <Attachments id={item.id} />
      ) : tab === 'headers' ? (
        <>
          <p className="form-hint">
            全局请求头应用于所有接口。接口专属 Header 以相同键名覆盖全局值（不区分大小写）。
          </p>
          <PairEditor
            title="全局 Header"
            pairs={data.globalHeaders || []}
            onChange={(p) => update({ globalHeaders: p })}
          />
        </>
      ) : (
        <>
          <label className="base-url">
            服务基础地址 <span className="mono">Base URL</span>
            <input
              className="mono"
              value={data.fields?.baseUrl || ''}
              onChange={(e) => update({ fields: { ...data.fields, baseUrl: e.target.value } })}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <div className="section-title">
            <h3>接口目录</h3>
            <div className="inline-actions">
              <input
                className="endpoint-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="筛选接口…"
                aria-label="筛选接口"
              />
              <button
                className="text-button"
                onClick={() => {
                  update({ swaggerEndpoints: [...endpoints, emptyEndpoint()] });
                  setIndex(endpoints.length);
                }}
              >
                <Plus size={13} />
                添加接口
              </button>
            </div>
          </div>
          <div className="endpoint-list">
            {endpoints.length === 0 ? (
              <div className="inline-empty">还没有接口。可同步 Swagger、粘贴规范，或添加一个接口。</div>
            ) : (
              endpoints
                .map((endpoint, i) => ({ endpoint, i }))
                .filter(({ endpoint }) =>
                  (endpoint.path + endpoint.summary + endpoint.method + endpoint.tag)
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map(({ endpoint, i }) => (
                  <button
                    className={'endpoint ' + (i === index ? 'active' : '')}
                    key={i}
                    onClick={() => {
                      invalidateProbe();
                      setIndex(i);
                      setError('');
                    }}
                  >
                    <span className={'method ' + endpoint.method.toLowerCase()}>{endpoint.method}</span>
                    <code>{endpoint.path}</code>
                    <small>{endpoint.summary}</small>
                  </button>
                ))
            )}
          </div>
          {ep && (
            <section className="request-editor">
              <div className="request-heading">
                <div className="request-route">
                  <select
                    value={ep.method}
                    aria-label="HTTP 方法"
                    onChange={(e) => changeEndpoint({ method: e.target.value })}
                  >
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                  <input
                    className="mono"
                    value={ep.path}
                    aria-label="接口路径"
                    onChange={(e) => changeEndpoint(endpointPath(ep, e.target.value))}
                  />
                  <button
                    className="icon-button danger-text"
                    title="删除当前接口"
                    aria-label="删除当前接口"
                    onClick={() => {
                      update({ swaggerEndpoints: endpoints.filter((_, i) => i !== index) });
                      setIndex(Math.max(0, index - 1));
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <button className="primary send-probe" disabled={sending} onClick={() => void send()}>
                  {sending ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}
                  {sending ? '请求中…' : '发送请求'}
                </button>
                {sending && <button onClick={probe.cancel}>取消请求</button>}
              </div>
              <label className="base-url">
                当前接口服务地址（留空使用基础地址）
                <input
                  className="mono"
                  value={ep.baseUrl || ''}
                  onChange={(e) => changeEndpoint({ baseUrl: e.target.value })}
                  placeholder={data.fields?.baseUrl || 'https://api.example.com'}
                />
              </label>
              {ep.requestWarning && <p className="form-hint">{ep.requestWarning}</p>}
              <input
                className="endpoint-summary"
                value={ep.summary}
                aria-label="接口说明"
                onChange={(e) => changeEndpoint({ summary: e.target.value })}
                placeholder="接口说明"
              />
              <div className="tabs parameter-tabs">
                <button className={epTab === 'headers' ? 'active' : ''} onClick={() => setEpTab('headers')}>
                  Headers <span>{mergeHeaders(data.globalHeaders || [], ep.customHeaders).length}</span>
                </button>
                <button className={epTab === 'params' ? 'active' : ''} onClick={() => setEpTab('params')}>
                  Params <span>{ep.queryParams.length + ep.pathParams.length}</span>
                </button>
                <button className={epTab === 'body' ? 'active' : ''} onClick={() => setEpTab('body')}>
                  Body
                </button>
              </div>
              {epTab === 'params' && (
                <>
                  <PairEditor
                    title="Path 参数"
                    path
                    pairs={ep.pathParams}
                    onChange={(p) => changeEndpoint({ pathParams: p })}
                  />
                  <PairEditor
                    title="Query 参数"
                    pairs={ep.queryParams}
                    onChange={(p) => changeEndpoint({ queryParams: p })}
                  />
                </>
              )}
              {epTab === 'headers' && (
                <RequestHeaders
                  global={data.globalHeaders || []}
                  custom={ep.customHeaders}
                  onGlobalChange={(pairs) => update({ globalHeaders: pairs })}
                  onCustomChange={(pairs) => changeEndpoint({ customHeaders: pairs })}
                />
              )}
              {epTab === 'body' && (
                <div className="body-editor">
                  <div className="section-title">
                    <h3>请求正文</h3>
                    <button
                      className="text-button"
                      disabled={!ep.requestBody}
                      onClick={() => {
                        try {
                          changeEndpoint({
                            requestBody: JSON.stringify(JSON.parse(ep.requestBody), null, 2),
                          });
                          setError('');
                        } catch {
                          setError('JSON 格式无效，请检查引号、逗号和括号');
                        }
                      }}
                    >
                      <Braces size={13} />
                      格式化 JSON
                    </button>
                  </div>
                  {['GET', 'HEAD'].includes(ep.method) && (
                    <p className="form-hint">{ep.method} 请求不会发送正文。</p>
                  )}
                  <textarea
                    aria-label="请求正文"
                    className="mono"
                    spellCheck={false}
                    value={ep.requestBody}
                    onChange={(e) => changeEndpoint({ requestBody: e.target.value })}
                    placeholder={'{\n  "key": "value"\n}'}
                  />
                </div>
              )}
              <div className="section-title curl-title">
                <h3>
                  实时 cURL <span className="muted">Bash / WSL</span>
                </h3>
                <button className="text-button" onClick={() => void copy()}>
                  <Copy size={13} />
                  复制完整命令
                </button>
              </div>
              <pre className="curl-preview">
                <code>{curl}</code>
              </pre>
              <div className="response-panel">
                <div className="section-title">
                  <h3>响应结果</h3>
                  {response && (
                    <div className="response-metrics">
                      <span className={response.status < 400 ? 'good' : 'danger-text'}>
                        HTTP {response.status}
                      </span>
                      <span>{response.durationMs} ms</span>
                      <span>{sizeLabel(response.size)}</span>
                      <button
                        className="icon-button"
                        aria-label="下载响应"
                        onClick={() => {
                          if (response.bodyBase64 != null) {
                            const bytes = Uint8Array.from(atob(response.bodyBase64), (char) =>
                              char.charCodeAt(0),
                            );
                            downloadBlob(
                              new Blob([bytes], { type: 'application/octet-stream' }),
                              'response.bin',
                            );
                          } else exportText(response.body, 'response.txt');
                        }}
                      >
                        <Download size={13} />
                      </button>
                    </div>
                  )}
                </div>
                {response ? (
                  <>
                    <div className="tabs">
                      <button
                        className={responseTab === 'body' ? 'active' : ''}
                        onClick={() => setResponseTab('body')}
                      >
                        Body
                      </button>
                      <button
                        className={responseTab === 'headers' ? 'active' : ''}
                        onClick={() => setResponseTab('headers')}
                      >
                        Headers
                      </button>
                    </div>
                    <pre className="response-body">
                      {responseTab === 'body'
                        ? response.bodyBase64 != null
                          ? '二进制响应，请下载查看原始文件。'
                          : responseBody || '（空响应）'
                        : JSON.stringify(response.headers, null, 2)}
                    </pre>
                  </>
                ) : (
                  <div className="inline-empty compact">
                    {sending ? '正在等待目标服务响应…' : '发送请求后，在这里查看实际响应。'}
                  </div>
                )}
              </div>
            </section>
          )}
        </>
      )}
      <div className="save-bar">
        <span className="muted">{dirty ? '参数有未保存的修改' : '参数已保存到密码库'}</span>
        <button className={dirty ? 'primary' : ''} disabled={!dirty || saving} onClick={() => void save()}>
          {dirty ? <Save size={13} /> : <Check size={13} />}
          {saving ? '保存中…' : '保存参数'}
        </button>
      </div>
    </div>
  );
}
