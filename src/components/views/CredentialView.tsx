import { useState } from 'react';
import { Copy, Eye, EyeOff, LockKeyhole, Terminal } from 'lucide-react';
import type { Item } from '../../types';
import { copyText, errorMessage } from '../../lib/api';
import { connectionCommand } from '../../lib/request';
import { ApiWorkbench } from '../ApiWorkbench';
import { Attachments } from '../Attachments';
import { fieldNames, secretField } from '../../lib/fields';
export function CredentialView({
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
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  async function copy(text: string, label: string) {
    try {
      await copyText(text);
      notify(label + '已复制');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="canvas credential-canvas">
      <div className="content-title">
        <div className="title-tags">
          <span className="project-label">{item.project || '未归属项目'}</span>
          <span className="tag mono">{item.data.typeKey || item.category}</span>
        </div>
        <h1>{item.title}</h1>
        {item.data.description && <p className="content-description">{item.data.description}</p>}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {item.category === 'http' ? (
        <ApiWorkbench item={item} onSaved={onSaved} onDirty={onDirty} notify={notify} />
      ) : (
        <>
          <div className="section-title">
            <h3>
              <LockKeyhole size={14} />
              连接属性
            </h3>
            <span className="good">AES-256-GCM 加密保护</span>
          </div>
          <div className="credential-fields">
            {Object.entries(item.data.fields || {}).map(([key, value]) => (
              <label key={key}>
                {fieldNames[key] || key}
                <div className="input-action">
                  <input
                    className="mono"
                    type={secretField(key) && !visible[key] ? 'password' : 'text'}
                    value={value}
                    readOnly
                  />
                  {secretField(key) && (
                    <button
                      className="icon-button"
                      aria-label={(visible[key] ? '隐藏' : '显示') + (fieldNames[key] || key)}
                      onClick={() => setVisible((v) => ({ ...v, [key]: !v[key] }))}
                    >
                      {visible[key] ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  )}
                  <button
                    className="icon-button"
                    disabled={!value}
                    aria-label={'复制' + (fieldNames[key] || key)}
                    onClick={() => void copy(value, fieldNames[key] || key)}
                  >
                    <Copy size={13} />
                  </button>
                </div>
              </label>
            ))}
          </div>
          <div className="connection-tools">
            <button
              className="primary"
              disabled={!connectionCommand(item.data)}
              onClick={() => void copy(connectionCommand(item.data), '连接命令')}
            >
              <Terminal size={14} />
              复制连接命令
            </button>
            <span className="form-hint">Bash / WSL 命令；数据库密码由客户端交互输入。</span>
          </div>
          <Attachments id={item.id} />
        </>
      )}
    </div>
  );
}
