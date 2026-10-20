import { useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { highlight, languageLabel } from '../lib/highlight';


/** Copy-to-clipboard button reading the text of the sibling <pre>. */
export function CopyButton({ text }: { text: () => string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="code-copy"
      aria-label={done ? '已复制' : '复制代码'}
      title={done ? '已复制' : '复制代码'}
      onClick={() => {
        void navigator.clipboard?.writeText(text()).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
      <span>{done ? '已复制' : '复制'}</span>
    </button>
  );
}

/** Frame around a <pre>: language label + copy button. */
export function CodeFrame({ language, children }: { language?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const label = languageLabel(language);
  return (
    <div className="code-frame" ref={box}>
      <div className="code-frame-bar">
        <span className="code-lang">{label || '文本'}</span>
        <CopyButton text={() => box.current?.querySelector('pre')?.textContent || ''} />
      </div>
      {children}
    </div>
  );
}

/** Standalone highlighted code (API responses, curl, etc.). */
export function CodeBlock({
  code,
  language,
  className = '',
  framed = false,
}: {
  code: string;
  language?: string;
  className?: string;
  framed?: boolean;
}) {
  const highlighted = highlight(code, language);
  const pre = (
    <pre className={className}>
      <code className={highlighted ? `hljs language-${language}` : undefined}>{highlighted ?? code}</code>
    </pre>
  );
  return framed ? <CodeFrame language={language}>{pre}</CodeFrame> : pre;
}
