import { useEffect, useState } from 'react';
import { BellRing, Send, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useConfirm } from '../lib/confirmation';

type Kind = 'webhook' | 'wecom' | 'dingtalk' | 'feishu' | 'telegram' | 'email';
interface Channel {
  id: string;
  name: string;
  kind: Kind;
  enabled: boolean;
  config: Record<string, string | number>;
  secret: {
    urlHost: string;
    hasUrl: boolean;
    hasSigning: boolean;
    hasBotToken: boolean;
    hasPassword: boolean;
  };
  lastSentAt?: string | null;
  lastStatus: string;
  lastError: string;
}
const kinds: Record<Kind, string> = {
  webhook: '通用 Webhook（JSON）',
  wecom: '企业微信群机器人',
  dingtalk: '钉钉群机器人',
  feishu: '飞书群机器人',
  telegram: 'Telegram Bot',
  email: '邮件（SMTP）',
};
const signingHint: Partial<Record<Kind, string>> = {
  webhook: '签名密钥（可选，用于 X-InfoHub-Signature: sha256=HMAC）',
  dingtalk: '加签密钥（可选，安全设置选择“加签”时填写 SEC…）',
  feishu: '签名校验密钥（可选）',
};
const blank = () => ({
  name: '',
  kind: 'wecom' as Kind,
  enabled: true,
  url: '',
  signing: '',
  botToken: '',
  chatId: '',
  host: '',
  port: '',
  security: 'starttls',
  username: '',
  password: '',
  from: '',
  to: '',
});
type Form = ReturnType<typeof blank>;

/** Settings for out-of-app release notifications. */
export function NotificationSettings() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);
  const confirm = useConfirm();
  useEffect(() => {
    let live = true;
    api<{ channels: Channel[] }>('/notifications/channels')
      .then((value) => live && setChannels(value.channels))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [version]);
  async function act(work: () => Promise<string | void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const note = await work();
      if (note) setMessage(note);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function edit(channel: Channel) {
    setEditing(channel.id);
    setForm({
      ...blank(),
      name: channel.name,
      kind: channel.kind,
      enabled: channel.enabled,
      chatId: String(channel.config.chatId || ''),
      host: String(channel.config.host || ''),
      port: channel.config.port ? String(channel.config.port) : '',
      security: String(channel.config.security || 'starttls'),
      username: String(channel.config.username || ''),
      from: String(channel.config.from || ''),
      to: String(channel.config.to || ''),
    });
  }
  function payload(f: Form) {
    const secret: Record<string, string> = {};
    // Blank secret fields on edit keep the stored value.
    if (f.url) secret.url = f.url;
    if (f.signing) secret.signing = f.signing;
    if (f.botToken) secret.botToken = f.botToken;
    if (f.password) secret.password = f.password;
    const config =
      f.kind === 'telegram'
        ? { chatId: f.chatId }
        : f.kind === 'email'
          ? {
              host: f.host,
              ...(f.port ? { port: Number(f.port) } : {}),
              security: f.security,
              username: f.username,
              from: f.from,
              to: f.to,
            }
          : {};
    return { name: f.name, kind: f.kind, enabled: f.enabled, config, secret };
  }
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const keep = editing ? '（留空保持不变）' : '';
  const field = (label: string, key: keyof Form, type = 'text', placeholder = '') => (
    <label>
      {label}
      <input
        type={type}
        autoComplete="off"
        value={String(form![key])}
        placeholder={placeholder}
        onChange={(e) => set({ [key]: e.target.value } as Partial<Form>)}
      />
    </label>
  );
  return (
    <div className="notification-settings">
      <div className="section-title">
        <h3>
          <BellRing size={14} /> 发布通知
        </h3>
        {!form && (
          <button
            className="primary"
            onClick={() => {
              setEditing(null);
              setForm(blank());
            }}
          >
            添加通知渠道
          </button>
        )}
      </div>
      <p className="muted">
        已订阅的 GitHub 仓库发布新版本时，服务端会向下列渠道推送消息（首次检查不推送）。Webhook
        地址、机器人密钥、Bot Token 与 SMTP
        密码使用服务端服务密钥加密保存，不会再返回到浏览器；这些配置不包含在备份中。
      </p>
      {form && (
        <div className="feed-form">
          <div className="feed-form-row">
            {field('名称', 'name', 'text', '例如：团队群')}
            <label>
              类型
              <select
                value={form.kind}
                disabled={!!editing}
                onChange={(e) => set({ kind: e.target.value as Kind })}
              >
                {Object.entries(kinds).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              启用
            </label>
          </div>
          {['webhook', 'wecom', 'dingtalk', 'feishu'].includes(form.kind) && (
            <>
              {field(
                'Webhook 地址' + keep,
                'url',
                'password',
                form.kind === 'wecom'
                  ? 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'
                  : form.kind === 'dingtalk'
                    ? 'https://oapi.dingtalk.com/robot/send?access_token=…'
                    : form.kind === 'feishu'
                      ? 'https://open.feishu.cn/open-apis/bot/v2/hook/…'
                      : 'https://example.com/hooks/infohub',
              )}
              {signingHint[form.kind] && field(signingHint[form.kind]! + keep, 'signing', 'password')}
            </>
          )}
          {form.kind === 'telegram' && (
            <div className="feed-form-row">
              {field('Bot Token' + keep, 'botToken', 'password', '123456:ABC…')}
              {field('Chat ID', 'chatId', 'text', '-100…')}
            </div>
          )}
          {form.kind === 'email' && (
            <>
              <div className="feed-form-row">
                {field('SMTP 服务器', 'host', 'text', 'smtp.example.com')}
                {field('端口', 'port', 'number', form.security === 'tls' ? '465' : '587')}
                <label>
                  加密
                  <select value={form.security} onChange={(e) => set({ security: e.target.value })}>
                    <option value="starttls">STARTTLS</option>
                    <option value="tls">SSL/TLS</option>
                    <option value="none">不加密</option>
                  </select>
                </label>
              </div>
              <div className="feed-form-row">
                {field('用户名', 'username')}
                {field('密码 / 授权码' + keep, 'password', 'password')}
              </div>
              <div className="feed-form-row">
                {field('发件人', 'from', 'text', 'InfoHub <bot@example.com>')}
                {field('收件人（逗号分隔）', 'to', 'text', 'me@example.com')}
              </div>
            </>
          )}
          <div className="inline-actions">
            <button
              className="primary"
              disabled={busy || !form.name.trim()}
              onClick={() =>
                void act(async () => {
                  if (editing)
                    await api(`/notifications/channels/${editing}`, {
                      method: 'PUT',
                      body: JSON.stringify(payload(form)),
                    });
                  else
                    await api('/notifications/channels', {
                      method: 'POST',
                      body: JSON.stringify(payload(form)),
                    });
                  setForm(null);
                  setEditing(null);
                  return '通知渠道已保存，可点击“发送测试”验证。';
                })
              }
            >
              保存
            </button>
            <button
              onClick={() => {
                setForm(null);
                setEditing(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {message && (
        <p className="info" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {channels?.map((c) => (
        <div className="task-record" key={c.id}>
          <div className="section-title">
            <strong>
              {c.name} <span className="muted">· {kinds[c.kind]}</span>
            </strong>
            <span className={c.lastStatus === 'failed' ? 'danger-text' : c.enabled ? 'good' : 'muted'}>
              {!c.enabled
                ? '已停用'
                : c.lastStatus === 'success'
                  ? '正常'
                  : c.lastStatus === 'failed'
                    ? '发送失败'
                    : '未发送'}
            </span>
          </div>
          <p className="muted">
            {c.kind === 'telegram'
              ? `Chat ${c.config.chatId}`
              : c.kind === 'email'
                ? `${c.config.host}:${c.config.port} → ${c.config.to}`
                : c.secret.urlHost || '未配置地址'}
            {c.secret.hasSigning ? ' · 已配置签名' : ''}
            {c.lastSentAt ? ` · 上次发送 ${formatDateTime(c.lastSentAt)}` : ''}
            {c.lastError ? ` · ${c.lastError}` : ''}
          </p>
          <div className="inline-actions">
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api(`/notifications/channels/${c.id}/test`, { method: 'POST' });
                  return `已向“${c.name}”发送测试消息。`;
                })
              }
            >
              <Send size={13} /> 发送测试
            </button>
            <button disabled={busy} onClick={() => edit(c)}>
              编辑
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  if (
                    !(await confirm({
                      title: '删除通知渠道',
                      description: `删除“${c.name}”？`,
                      confirmLabel: '删除',
                    }))
                  )
                    return;
                  await api(`/notifications/channels/${c.id}`, { method: 'DELETE' });
                })
              }
            >
              <Trash2 size={13} /> 删除
            </button>
          </div>
        </div>
      ))}
      {channels && !channels.length && !form && <p className="inline-empty">还没有通知渠道。</p>}
    </div>
  );
}
