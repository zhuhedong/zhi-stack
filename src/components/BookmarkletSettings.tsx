import { useEffect, useRef, useState } from 'react';
import { Bookmark, Copy } from 'lucide-react';
import { API_BASE, copyText } from '../lib/api';
import { bookmarkletCode, workbenchBase } from '../lib/bookmarklet';

/** 一键收藏: how to install the bookmarklet for this instance. */
export function BookmarkletSettings() {
  const base = workbenchBase(API_BASE);
  const code = bookmarkletCode(base);
  const link = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);
  // React refuses javascript: URLs in JSX, so the draggable link gets its href here.
  useEffect(() => {
    link.current?.setAttribute('href', code);
  }, [code]);
  return (
    <div className="maintenance-form bookmarklet-settings">
      <h3>一键收藏（书签小工具）</h3>
      <p className="muted">
        在任意网页点击这个书签，会在小窗口里打开本工作台的收录表单并自动填好当前网址。书签里不含任何令牌或密码，
        使用的是你在该窗口中的正常登录会话。
      </p>
      <p>
        <a
          ref={link}
          className="primary bookmarklet-link"
          draggable
          onClick={(e) => e.preventDefault()}
          title="把我拖到浏览器书签栏"
        >
          <Bookmark size={14} /> 收藏到 InfoHub
        </a>
      </p>
      <ol className="bookmarklet-steps">
        <li>显示浏览器书签栏（Chrome / Edge：Ctrl+Shift+B；Safari：⌘⇧B）。</li>
        <li>把上面的“收藏到 InfoHub”链接拖到书签栏；或新建书签，把网址设为下方代码。</li>
        <li>在想收藏的网页上点击书签；首次使用需在弹出的窗口里输入主密码登录，窗口未关闭前不用重复登录。</li>
      </ol>
      <label>
        书签代码
        <textarea readOnly rows={4} value={code} className="mono" onFocus={(e) => e.currentTarget.select()} />
      </label>
      <button
        type="button"
        onClick={() =>
          void copyText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <Copy size={14} /> {copied ? '已复制' : '复制书签代码'}
      </button>
      <p className="form-hint">
        书签会打开 <span className="mono">{base}</span>。该地址需要以完整网页版运行（WEB_UI=full）；
        如果服务端设为介绍页模式（landing），书签只能打开介绍页。
      </p>
    </div>
  );
}
