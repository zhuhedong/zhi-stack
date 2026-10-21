import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { healthReport, type CredentialSecret, type HealthFinding } from '../lib/passwords';
import { fieldNames } from '../lib/fields';
import type { Item, ListResult } from '../types';

const isPasswordField = (key: string) => /password|passwd|pwd|口令|密码/i.test(key);

/** Weak / reused / old passwords. Decrypted values stay in this tab's memory and are never sent anywhere. */
export function PasswordHealth() {
  const [findings, setFindings] = useState<HealthFinding[] | null>(null);
  const [checked, setChecked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run() {
    setBusy(true);
    setError('');
    setFindings(null);
    try {
      const items: Item[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = await api<ListResult>(`/items?kind=credential&limit=200&offset=${offset}`);
        items.push(...page.items);
        if (page.items.length < 200) break;
      }
      const secrets: CredentialSecret[] = [];
      for (const summary of items) {
        const item = await api<Item>('/items/' + summary.id);
        for (const [key, value] of Object.entries(item.data.fields || {}))
          if (isPasswordField(key) && value)
            secrets.push({
              itemId: item.id,
              title: item.title,
              field: fieldNames[key] || key,
              value,
              updatedAt: item.updatedAt,
            });
      }
      setChecked(secrets.length);
      setFindings(healthReport(secrets));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const count = (pick: (f: HealthFinding) => unknown) => findings?.filter(pick).length ?? 0;
  return (
    <div className="maintenance-form password-health">
      <p className="muted">
        在本机解密后检查弱密码、重复使用和超过一年未更新的密码。明文只在当前页面内存中比较，不会发送或保存到任何地方。
      </p>
      <div className="inline-actions">
        <button className="primary" type="button" disabled={busy} onClick={() => void run()}>
          <ShieldAlert size={14} /> {busy ? '正在检查…' : findings ? '重新检查' : '开始检查'}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {findings && (
        <>
          <div className="health-summary" role="status">
            <span>已检查 {checked} 个密码</span>
            <span className={count((f) => f.weak) ? 'danger-text' : 'good'}>
              弱密码 {count((f) => f.weak)}
            </span>
            <span className={count((f) => f.reusedWith) ? 'danger-text' : 'good'}>
              重复使用 {count((f) => f.reusedWith)}
            </span>
            <span className={count((f) => f.ageDays) ? 'warning-text' : 'good'}>
              超过一年未更新 {count((f) => f.ageDays)}
            </span>
          </div>
          {findings.map((finding) => (
            <div className="task-record" key={finding.itemId + finding.field}>
              <div className="section-title">
                <strong>{finding.title}</strong>
                <span className="muted">{finding.field}</span>
              </div>
              {finding.weak && (
                <p className="danger-text">
                  {finding.weak.label}（约 {finding.weak.bits} 位熵）
                  {finding.weak.reasons.length ? '：' + finding.weak.reasons.join('、') : ''}
                </p>
              )}
              {finding.reusedWith && <p className="danger-text">与 {finding.reusedWith.join('、')} 相同</p>}
              {finding.ageDays && (
                <p className="warning-text">{Math.floor(finding.ageDays / 30)} 个月未更新</p>
              )}
            </div>
          ))}
          {!findings.length && <p className="inline-empty">没有发现问题。</p>}
        </>
      )}
    </div>
  );
}
