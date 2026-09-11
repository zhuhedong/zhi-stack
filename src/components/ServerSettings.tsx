import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { API_BASE, configureServer, errorMessage } from '../lib/api';
import { checkServerConnection, DEFAULT_API_BASE } from '../lib/server';
import { Modal } from './Modal';
import { DeploymentSteps } from './DeploymentSteps';

export function ServerSettings({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [address, setAddress] = useState(API_BASE);
  const [tab, setTab] = useState('connect');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
    setBusy(true);
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
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    try {
      configureServer(address);
      onSaved();
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  return (
    <Modal title="服务连接" onClose={onClose}>
      <div className="tabs maintenance-tabs">
        <button type="button" className={tab === 'connect' ? 'active' : ''} onClick={() => setTab('connect')}>
          连接已有服务
        </button>
        <button type="button" className={tab === 'deploy' ? 'active' : ''} onClick={() => setTab('deploy')}>
          自行部署
        </button>
      </div>
      {tab === 'deploy' ? (
        <div className="modal-body">
          <DeploymentSteps />
        </div>
      ) : (
        <form onSubmit={save}>
          <div className="modal-body">
            <label>
              服务端地址
              <input
                autoFocus
                aria-label="服务端地址"
                type="url"
                required
                value={address}
                disabled={busy}
                placeholder="https://infohub.example.com"
                onChange={(event) => change(event.target.value)}
              />
            </label>
            <p className="form-hint">
              填写 InfoHub 服务地址，可省略末尾的 /api。地址保存在本机，下次打开自动使用。
            </p>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => change(DEFAULT_API_BASE)}
            >
              恢复默认地址
            </button>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            {message && <p role="status">{message}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button type="button" disabled={busy} onClick={() => void testConnection()}>
              {busy && <LoaderCircle className="spin" size={14} />}
              {busy ? '正在测试…' : '测试连接'}
            </button>
            <button className="primary" disabled={busy}>
              保存并连接
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
