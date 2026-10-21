import { Code } from './Code';
import { guessLanguage } from '../lib/guessLanguage';

const headerValue = (headers: unknown, name: string): string | undefined => {
  if (!headers || typeof headers !== 'object') return undefined;
  const hit = Object.entries(headers as Record<string, unknown>).find(([k]) => k.toLowerCase() === name);
  return hit ? String(hit[1]) : undefined;
};
import { Select } from './ui/Select';
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
import { applyVariables, evaluateInWorker, type ChainOutcome } from '../lib/chaining';
import { ChainRules, ChainSummary } from './ChainRules';
import { ListOrdered } from 'lucide-react';

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
  const [outcome, setOutcome] = useState<ChainOutcome | null>(null);
  const [sequence, setSequence] = useState<{ label: string; ok: boolean; note: string }[] | null>(null);
  const [sequenceRunning, setSequenceRunning] = useState(false);
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
    setOutcome(null);
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
  /** Sends one endpoint, then runs its extraction/assertion rules and stores extracted variables. */
  async function execute(current: ItemData, target: Endpoint) {
    if (target.requestWarning && !target.requestBody && !['GET', 'HEAD'].includes(target.method))
      throw new Error(target.requestWarning);
    const result = await probe.run(
      buildRequest(current, target),
      current.environments?.find((env) => env.id === current.activeEnvironment)?.name || '默认',
    );
    if (!result) return { data: current, outcome: null };
    const rules =
      (target.extractions || []).some((r) => r.enabled) || (target.assertions || []).some((r) => r.enabled);
    if (!rules) return { data: current, outcome: null, status: result.status };
    const evaluated = await evaluateInWorker(
      {
        status: result.status,
        headers: result.headers,
        body: result.bodyBase64 != null ? '' : result.body,
        durationMs: result.durationMs,
      },
      target.extractions || [],
      target.assertions || [],
    );
    let next = current;
    if (evaluated.variables.length) {
      const environments = [...(current.environments || [])];
      let active = environments.findIndex((env) => env.id === current.activeEnvironment);
      if (active < 0) {
        environments.push({ id: crypto.randomUUID(), name: '运行时变量', variables: [] });
        active = environments.length - 1;
      }
      environments[active] = {
        ...environments[active],
        variables: applyVariables(environments[active].variables, evaluated.variables, (key, value) => ({
          key,
          value,
          enabled: true,
          desc: '由响应提取',
        })),
      };
      next = { ...current, environments, activeEnvironment: environments[active].id };
      setData(next);
      draft.change();
    }
    return { data: next, outcome: evaluated, status: result.status };
  }
  async function send() {
    if (!ep) return;
    setError('');
    setOutcome(null);
    setSequence(null);
    try {
      setOutcome((await execute(data, ep)).outcome);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  /** Runs every endpoint in list order, chaining extracted variables; stops at the first failure. */
  async function runSequence() {
    setError('');
    setOutcome(null);
    setSequenceRunning(true);
    const log: { label: string; ok: boolean; note: string }[] = [];
    setSequence(log);
    let current = data;
    try {
      for (const [i, target] of endpoints.entries()) {
        setIndex(i);
        const label = `${target.method} ${target.path}`;
        try {
          const step = await execute(current, target);
          current = step.data;
          const failed = step.outcome
            ? step.outcome.assertions.filter((a) => !a.passed).length + step.outcome.errors.length
            : 0;
          const ok = step.status !== undefined && failed === 0;
          log.push({
            label,
            ok,
            note:
              step.status === undefined
                ? '请求未完成'
                : `HTTP ${step.status}` +
                  (step.outcome
                    ? ` · 断言 ${step.outcome.assertions.filter((a) => a.passed).length}/${step.outcome.assertions.length}`
                    : '') +
                  (step.outcome?.variables.length
                    ? ` · 提取 ${step.outcome.variables.map((v) => v.name).join(', ')}`
                    : '') +
                  (failed
                    ? ' · ' +
                      [
                        ...step.outcome!.errors,
                        ...step.outcome!.assertions.filter((a) => !a.passed).map((a) => '✗ ' + a.label),
                      ].join('；')
                    : ''),
          });
          setSequence([...log]);
          setOutcome(step.outcome);
          if (!ok) break;
        } catch (e) {
          log.push({ label, ok: false, note: errorMessage(e) });
          setSequence([...log]);
          break;
        }
      }
    } finally {
      setSequenceRunning(false);
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
          <Select
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
          </Select>
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
                  <Select
                    value={ep.method}
                    aria-label="HTTP 方法"
                    onChange={(e) => changeEndpoint({ method: e.target.value })}
                  >
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </Select>
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
                {endpoints.length > 1 && (
                  <button
                    disabled={sending || sequenceRunning}
                    title="按列表顺序依次发送全部接口，并在请求之间传递提取的变量；任一请求失败或断言不通过即停止"
                    onClick={() => void runSequence()}
                  >
                    <ListOrdered size={14} />
                    按顺序运行全部
                  </button>
                )}
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
                <button className={epTab === 'chain' ? 'active' : ''} onClick={() => setEpTab('chain')}>
                  提取 / 断言 <span>{(ep.extractions?.length || 0) + (ep.assertions?.length || 0)}</span>
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
              {epTab === 'chain' && (
                <ChainRules
                  extractions={ep.extractions || []}
                  assertions={ep.assertions || []}
                  onExtractions={(extractions) => changeEndpoint({ extractions })}
                  onAssertions={(assertions) => changeEndpoint({ assertions })}
                  outcome={outcome}
                />
              )}
              {sequence && (
                <div className="chain-sequence" role="status">
                  <h3>按顺序运行{sequenceRunning ? '中…' : '结果'}</h3>
                  {sequence.map((step, i) => (
                    <div key={i} className={step.ok ? 'good' : 'danger-text'}>
                      {step.ok ? '✓' : '✗'} {i + 1}. {step.label} — {step.note}
                    </div>
                  ))}
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
              <Code className="curl-preview" code={curl} language="bash" />
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
                    {outcome && <ChainSummary outcome={outcome} />}
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
                    {responseTab === 'body' ? (
                      response.bodyBase64 != null || !responseBody ? (
                        <pre className="response-body">
                          {response.bodyBase64 != null ? '二进制响应，请下载查看原始文件。' : '（空响应）'}
                        </pre>
                      ) : (
                        <Code
                          className="response-body"
                          code={responseBody}
                          language={guessLanguage(
                            responseBody,
                            headerValue(response.headers, 'content-type'),
                          )}
                        />
                      )
                    ) : (
                      <Code
                        className="response-body"
                        code={JSON.stringify(response.headers, null, 2)}
                        language="json"
                      />
                    )}
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
