import { lazy, Suspense, type ComponentProps } from 'react';

// Highlighting grammars load on demand in their own chunk.
const Impl = lazy(() => import('./CodeBlock').then((m) => ({ default: m.CodeBlock })));

export function Code(props: ComponentProps<typeof Impl>) {
  return (
    <Suspense
      fallback={
        <pre className={props.className}>
          <code>{props.code}</code>
        </pre>
      }
    >
      <Impl {...props} />
    </Suspense>
  );
}

