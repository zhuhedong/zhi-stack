import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Radar, LockKeyhole, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, API_BASE, errorMessage, setToken } from '../lib/api';
import { BrandIcon } from './BrandIcon';
import { isDesktop } from '../lib/platform';
import { ServerSettings } from './ServerSettings';
import { RestoreForm } from './DataManager';
import { Modal } from './Modal';
import { serverInitialized } from '../lib/server';
import { DeploymentSteps } from './DeploymentSteps';

export function AuthScreen({
  onLogin,
  initialServerSettings = false,
}: {
  onLogin: () => void;
  initialServerSettings?: boolean;
}) {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [settings, setSettings] = useState(initialServerSettings);
  const [restore, setRestore] = useState(false);
  const [deploymentGuide, setDeploymentGuide] = useState(false);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => {
    let alive = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    api<unknown>('/health', { signal: abort.signal })
      .then((v) => {
        if (alive) {
          setInitialized(serverInitialized(v));
          setError('');
        }
      })
      .catch((e) => {
        if (alive) setError(abort.signal.aborted ? '连接超时，请检查服务地址和网络。' : errorMessage(e));
      })
      .finally(() => clearTimeout(timer));
    return () => {
      alive = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [refresh]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (initialized === null) return;
    if (!initialized && password !== confirm) {
      setError('两次输入的主密码不一致');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api<{ token: string }>(initialized ? '/auth/login' : '/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setToken(result.token);
      setPassword('');
      setConfirm('');
      onLogin();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <header className="auth-brand">
        <BrandIcon />
        <strong>InfoHub</strong>
        <span>开发者数字工作台</span>
      </header>
      <main className="auth-layout">
        <div className="auth-intro">
          <div className="intro-rule" />
          <h1>
            让知识、代码和资产，
            <br />
            各就其位。
          </h1>
          <p>
            从一篇值得留下的文章，到一个正在开发的项目。
            <br />
            在自己的工作台里，保存上下文，继续手头的工作。
          </p>
          <div className="intro-features">
            <span>
              <BookOpen />
              文章与离线阅读
            </span>
            <span>
              <Radar />
              开源项目与实践笔记
            </span>
            <span>
              <LockKeyhole />
              凭证与接口调试
            </span>
          </div>
          <div className="intro-foot">
            <ShieldCheck size={15} />
            <span>PostgreSQL 持久化 · 主密码保护凭证</span>
          </div>
        </div>
        <section className="auth-form">
          <BrandIcon size={48} className="auth-app-icon" />
          <h2>
            {initialized === null
              ? '正在连接工作台'
              : initialized === false
                ? '创建你的工作台'
                : '回到你的工作台'}
          </h2>
          <p className="muted">
            {initialized === null
              ? '正在确认服务状态…'
              : initialized === false
                ? '设置主密码，用于登录和加密你的资产凭证。'
                : '输入主密码，登录并解锁密码库。'}
          </p>
          <form onSubmit={submit}>
            <label>
              主密码
              <input
                autoFocus
                type="password"
                value={password}
                minLength={initialized === false ? 12 : 1}
                maxLength={1024}
                required
                autoComplete={initialized === true ? 'current-password' : 'new-password'}
                placeholder={initialized === false ? '至少 12 个字符' : '输入主密码'}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {initialized === false && (
              <>
                <label>
                  确认主密码
                  <input
                    type="password"
                    value={confirm}
                    required
                    minLength={12}
                    autoComplete="new-password"
                    placeholder="再次输入主密码"
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </label>
                <p className="form-hint">请妥善保存主密码。它无法找回，丢失后将无法解密已保存的凭证。</p>
              </>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button className="primary auth-submit" disabled={busy || initialized === null}>
              {busy ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={16} />}
              {busy
                ? '正在解锁…'
                : initialized === null
                  ? '连接中…'
                  : initialized === false
                    ? '创建并进入工作台'
                    : '解锁工作台'}
            </button>
          </form>
          {initialized === null && error && (
            <button className="text-button" onClick={() => setRefresh((v) => v + 1)}>
              <RefreshCw size={13} />
              重新连接服务
            </button>
          )}
          <div className="auth-server mono">服务地址：{API_BASE}</div>
          <button className="text-button" disabled={busy} onClick={() => setDeploymentGuide(true)}>
            首次连接与部署指南
          </button>
          {initialized === false && (
            <button className="text-button" disabled={busy} onClick={() => setRestore(true)}>
              从已有备份恢复工作台
            </button>
          )}
          {isDesktop && (
            <button className="text-button" disabled={busy} onClick={() => setSettings(true)}>
              服务连接设置
            </button>
          )}
        </section>
      </main>
      <footer className="auth-footer">
        InfoHub / Personal workspace<span>你的资料，持续积累。</span>
      </footer>
      {settings && isDesktop && (
        <ServerSettings
          onClose={() => setSettings(false)}
          onSaved={() => {
            setSettings(false);
            setInitialized(null);
            setPassword('');
            setConfirm('');
            setError('');
            setRefresh((value) => value + 1);
          }}
        />
      )}
      {restore && (
        <Modal
          title="恢复已有工作台"
          onClose={() => {
            if (!restoring) setRestore(false);
          }}
        >
          <div className="modal-body">
            <RestoreForm
              initialized={false}
              onBusy={setRestoring}
              onRestored={() => {
                setRestore(false);
                setInitialized(null);
                setRefresh((value) => value + 1);
              }}
            />
          </div>
        </Modal>
      )}
      {deploymentGuide && (
        <Modal title="首次连接与部署" onClose={() => setDeploymentGuide(false)}>
          <div className="modal-body">
            <DeploymentSteps />
          </div>
        </Modal>
      )}
    </div>
  );
}
