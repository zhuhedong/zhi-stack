import { useEffect, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeCodeHighlight } from '../lib/highlight';
import { CodeFrame } from './CodeBlock';
import { request } from '../lib/api';
import { SourceLink } from './SourceLink';
import { archivedMediaPath } from '../lib/media';

function ArchivedImage({ src, alt }: { src?: string; alt?: string }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const media = archivedMediaPath(src);
  useEffect(() => {
    let active = true;
    let object = '';
    const abort = new AbortController();
    if (media)
      request(media, { signal: abort.signal })
        .then((r) => r.blob())
        .then((b) => {
          if (active) {
            object = URL.createObjectURL(b);
            setUrl(object);
          }
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    return () => {
      active = false;
      abort.abort();
      if (object) URL.revokeObjectURL(object);
    };
  }, [media]);
  if (failed || !media)
    return <span className="image-placeholder">{alt || '外部图片'} · 可在原文中查看</span>;
  return url ? (
    <img src={url} alt={alt || '文章插图'} loading="lazy" />
  ) : (
    <span className="image-placeholder">正在读取图片…</span>
  );
}
export function Markdown({ text, baseUrl }: { text: string; baseUrl?: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeCodeHighlight]}
        urlTransform={(value) => {
          const safe = defaultUrlTransform(value);
          if (!safe || safe.startsWith('#')) return safe;
          if (archivedMediaPath(safe)) return safe.split(/[?#]/)[0];
          if (safe.startsWith('/api/media/')) return '';
          if (!baseUrl) return safe;
          try {
            return new URL(safe, baseUrl).toString();
          } catch {
            return '';
          }
        }}
        components={{
          a: ({ href, children }) =>
            href?.startsWith('#') ? (
              <a href={href}>{children}</a>
            ) : (
              <SourceLink href={href}>{children}</SourceLink>
            ),
          pre: ({ children, node }) => {
            const code = node?.children.find((c) => c.type === 'element' && c.tagName === 'code');
            const cls = code && code.type === 'element' ? code.properties?.className : undefined;
            const lang = (Array.isArray(cls) ? cls : [])
              .map(String)
              .find((c) => c.startsWith('language-'))
              ?.slice('language-'.length);
            return (
              <CodeFrame language={lang}>
                <pre>{children}</pre>
              </CodeFrame>
            );
          },
          img: ({ src, alt }) => <ArchivedImage key={src} src={src} alt={alt} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
