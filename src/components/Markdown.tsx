import { useEffect, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { request } from '../lib/api';
import { SourceLink } from './SourceLink';

const MEDIA = /^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function archivedMediaPath(src?: string) {
  const path = src?.split(/[?#]/)[0];
  return path && MEDIA.test(path) ? path.slice(4) : '';
}

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
            href?.startsWith('#') ? <a href={href}>{children}</a> : <SourceLink href={href}>{children}</SourceLink>,
          img: ({ src, alt }) => <ArchivedImage key={src} src={src} alt={alt} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
