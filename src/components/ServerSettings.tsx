import { Form } from './Form';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { API_BASE, configureServer, errorMessage } from '../lib/api';
import { checkServerConnection, type ClientConfig } from '../lib/server';
import { Modal } from './Modal';
import { DeploymentSteps } from './DeploymentSteps';

export function ServerSettings({
  onClose,
  onSaved,
  initialAddress = API_BASE,
  configPath = '',
  initialError = '',
  inline = false,
}: {
  onClose?: () => void;
  onSaved: (config: ClientConfig) => void;
  initialAddress?: string;
  configPath?: string;
  initialError?: string;
  inline?: boolean;
}) {
  const [address, setAddress] = useState(initialAddress);
  const [tab, setTab] = useState('connect');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function change(value: string) {
    setAddress(value);
    setError('');
    setMessage('');
  }
  async function testConnection() {
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    setBusy('test');
    setError('');
    setMessage('');
    try {
      const initialized = await checkServerConnection(address, controller.signal);
      if (!controller.signal.aborted)
        setMessage(initialized ? '连接成功，可以使用主密码登录。' : '连接成功，首次使用时需要创建主密码。');
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          error instanceof DOMException && error.name === 'TimeoutError'
            ? '连接超时，请检查服务地址和网络。'
            : errorMessage(error),
        );
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    setBusy('save');
    setError('');
    setMessage('');
    try {
      const config = await configureServer(address);
      if (!controller.signal.aborted) onSaved(config);
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  const content = (
    <div className={inline ? 'server-settings-inline' : undefined}>
      <div className="tabs maintenance-tabs">
        <button
          type="button"
          disabled={!!busy}
          className={tab === 'connect' ? 'active' : ''}
          onClick={() => setTab('connect')}
        >
          连接已有服务
        </button>
        <button
          type="button"
          disabled={!!busy}
          className={tab === 'deploy' ? 'active' : ''}
          onClick={() => setTab('deploy')}
        >
          自行部署
        </button>
      </div>
      {tab === 'deploy' ? (
        <div className="modal-body">
          <DeploymentSteps />
        </div>
      ) : (
        <Form onSubmit={save}>
          <div className="modal-body">
            <label>
              服务端地址
              <input
                autoFocus
                aria-label="服务端地址"
                type="url"
                required
                value={address}
                disabled={!!busy}
                placeholder="https://infohub.example.com"
                onChange={(event) => change(event.target.value)}
              />
            </label>
            <p className="form-hint">
              填写 InfoHub 服务地址，可省略末尾的 /api。保存到本机配置文件后，下次启动自动连接。
            </p>
            {configPath && (
              <details className="server-config-location">
                <summary>配置文件位置</summary>
                <code>{configPath}</code>
              </details>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            {message && <p role="status">{message}</p>}
          </div>
          <div className="modal-foot">
            {onClose && (
              <button type="button" disabled={!!busy} onClick={onClose}>
                取消
              </button>
            )}
            <button type="button" disabled={!!busy} onClick={() => void testConnection()}>
              {busy === 'test' && <LoaderCircle className="spin" size={14} />}
              {busy === 'test' ? '正在测试…' : '测试连接'}
            </button>
            <button className="primary" disabled={!!busy}>
              {busy === 'save' && <LoaderCircle className="spin" size={14} />}
              {busy === 'save' ? '正在保存…' : '保存并连接'}
            </button>
          </div>
        </Form>
      )}
    </div>
  );
  return inline ? (
    content
  ) : (
    <Modal
      title="服务连接"
      onClose={() => {
        if (!busy) onClose?.();
      }}
    >
      {content}
    </Modal>
  );
}
