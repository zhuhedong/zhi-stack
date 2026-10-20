import { lazy, Suspense, type ComponentProps } from 'react';

// react-markdown and remark-gfm are only needed when a document is shown, so
// they live in their own chunk instead of the initial bundle.
const MarkdownImpl = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));

export function Markdown(props: ComponentProps<typeof MarkdownImpl>) {
  return (
    <Suspense fallback={<div className="markdown-loading muted">正在加载…</div>}>
      <MarkdownImpl {...props} />
    </Suspense>
  );
}
