import { useMemo, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { api, errorMessage, saveItem } from '../lib/api';
import {
  dedupe,
  formatNames,
  hostOf,
  parseImport,
  vaultFormat,
  type ImportCandidate,
  type ImportResult,
} from '../lib/importers';

type Row = { candidate: ImportCandidate; duplicate: '' | 'existing' | 'file'; selected: boolean };
const MAX_FILE = 50 * 1024 * 1024;

/** 数据与安全 → 导入: parse locally, preview with dedupe, then create items. */
export function ImportCenter({ onChanged }: { onChanged: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState('');
  const [project, setProject] = useState('');
  const [fetchFullText, setFetchFullText] = useState(false);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const selected = rows.filter((r) => r.selected);
  const isVault = result ? vaultFormat(result.format) : false;
  const linkOnly = selected.filter((r) => r.candidate.linkOnly).length;

  async function choose(picked: File) {
    setError('');
    setMessage('');
    setResult(null);
    setRows([]);
    setFileName(picked.name);
    if (picked.size > MAX_FILE) return setError('文件超过 50 MB');
    setBusy(true);
    try {
      const parsed = parseImport(picked.name, await picked.text());
      const urls = parsed.candidates.filter((c) => c.item.kind === 'knowledge').map((c) => c.item.url);
      const existing = await api<{ urls: string[]; vault: string[]; unlocked: boolean }>('/import/existing', {
        method: 'POST',
        body: JSON.stringify({ urls: urls.slice(0, 20000) }),
      });
      const keys = new Set([...existing.urls.map((u) => 'url:' + u), ...existing.vault]);
      setLocked(vaultFormat(parsed.format) && !existing.unlocked);
      setResult(parsed);
      setRows(dedupe(parsed.candidates, keys).map((r) => ({ ...r, selected: !r.duplicate })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    setBusy(true);
    setError('');
    setMessage('');
    let created = 0;
    let queued = 0;
    const failures: string[] = [];
    setProgress({ done: 0, total: selected.length });
    for (const [index, row] of selected.entries()) {
      const item = { ...row.candidate.item, project: project.trim() || row.candidate.item.project };
      try {
        if (fetchFullText && row.candidate.linkOnly) {
          await api('/jobs', {
            method: 'POST',
            body: JSON.stringify({
              url: item.url,
              kind: 'knowledge',
              project: item.project,
              tags: item.tags,
              requestId: crypto.randomUUID(),
            }),
          });
          queued++;
        } else {
          await saveItem(item);
          created++;
        }
        setRows((list) =>
          list.map((r) => (r === row ? { ...r, selected: false, duplicate: 'existing' } : r)),
        );
      } catch (e) {
        failures.push(`${item.title}：${errorMessage(e)}`);
        if (/解锁|锁定/.test(errorMessage(e))) break;
      }
      setProgress({ done: index + 1, total: selected.length });
    }
    setBusy(false);
    onChanged();
    setMessage(
      `已导入 ${created} 条${queued ? `，${queued} 条已加入收录队列` : ''}${failures.length ? `，${failures.length} 条失败` : ''}。`,
    );
    if (failures.length) setError(failures.slice(0, 5).join('\n') + (failures.length > 5 ? '\n…' : ''));
  }
  const counts = useMemo(
    () => ({
      existing: rows.filter((r) => r.duplicate === 'existing').length,
      file: rows.filter((r) => r.duplicate === 'file').length,
    }),
    [rows],
  );
  return (
    <div className="maintenance-form import-center">
      <p className="muted">
        支持 Pocket（HTML/CSV）、Omnivore（JSON）、Wallabag（JSON）、浏览器书签 HTML、Bitwarden（未加密
        JSON/CSV）、1Password CSV 和 Postman Collection
        v2.1。文件只在本机解析；账号密码通过与手动新建相同的接口写入，在服务端以 AES-256-GCM 加密保存。
      </p>
      <div className="inline-actions">
        <button className="primary" type="button" disabled={busy} onClick={() => file.current?.click()}>
          <FileUp size={14} /> 选择导出文件
        </button>
        {fileName && <span className="mono muted">{fileName}</span>}
        <input
          ref={file}
          type="file"
          hidden
          accept=".html,.htm,.json,.csv,.txt"
          aria-label="导入文件"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = '';
            if (picked) void choose(picked);
          }}
        />
      </div>
      {result && (
        <>
          <p className="info" role="status">
            识别为 {formatNames[result.format]}：共 {rows.length} 条
            {counts.existing ? `，${counts.existing} 条已存在` : ''}
            {counts.file ? `，${counts.file} 条在文件中重复` : ''}，已选择 {selected.length} 条。
          </p>
          {result.warnings.map((w) => (
            <p className="muted" key={w}>
              {w}
            </p>
          ))}
          {locked && <p className="error">导入密码库或接口集合前请先解锁密码库。</p>}
          <div className="feed-form-row">
            <label>
              归入项目（可选）
              <input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder="保留原文件中的分组"
              />
            </label>
            {!isVault && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={fetchFullText}
                  onChange={(e) => setFetchFullText(e.target.checked)}
                />
                没有正文的 {linkOnly} 条排队抓取全文（每批最多 100 条进行中）
              </label>
            )}
          </div>
          <div className="import-preview" role="table" aria-label="导入预览">
            <div className="import-row head" role="row">
              <input
                type="checkbox"
                aria-label="全选"
                checked={rows.length > 0 && rows.every((r) => r.selected || r.duplicate)}
                onChange={(e) =>
                  setRows((list) => list.map((r) => ({ ...r, selected: e.target.checked && !r.duplicate })))
                }
              />
              <span>标题</span>
              <span>{isVault ? '网站 / 类型' : '地址'}</span>
              <span>状态</span>
            </div>
            {rows.slice(0, 500).map((row, index) => (
              <label className={'import-row' + (row.duplicate ? ' dup' : '')} role="row" key={index}>
                <input
                  type="checkbox"
                  checked={row.selected}
                  onChange={(e) =>
                    setRows((list) =>
                      list.map((r, i) => (i === index ? { ...r, selected: e.target.checked } : r)),
                    )
                  }
                />
                <span className="import-title">{row.candidate.item.title}</span>
                <span className="mono muted import-url">
                  {row.candidate.item.kind === 'knowledge'
                    ? row.candidate.item.url
                    : row.candidate.item.category === 'http'
                      ? `${row.candidate.item.data.swaggerEndpoints?.length || 0} 个接口`
                      : hostOf(row.candidate.item.data.fields?.url || '') || '—'}
                </span>
                <span className={row.duplicate ? 'muted' : 'good'}>
                  {row.duplicate === 'existing' ? '已存在' : row.duplicate === 'file' ? '文件内重复' : '新增'}
                </span>
              </label>
            ))}
            {rows.length > 500 && <p className="muted">仅预览前 500 条；导入会处理全部已选条目。</p>}
          </div>
          <div className="inline-actions">
            <button
              className="primary"
              type="button"
              disabled={busy || !selected.length || locked}
              onClick={() => void run()}
            >
              {busy && progress
                ? `正在导入 ${progress.done}/${progress.total}…`
                : `导入所选 ${selected.length} 条`}
            </button>
          </div>
        </>
      )}
      {message && (
        <p className="info" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error" role="alert" style={{ whiteSpace: 'pre-wrap' }}>
          {error}
        </p>
      )}
    </div>
  );
}
