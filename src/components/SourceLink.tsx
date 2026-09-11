import type { ComponentProps } from 'react';
export function SourceLink({ href, onClick, ...props }: ComponentProps<'a'>) {
  if (href?.startsWith('#')) return <a {...props} href={href} onClick={onClick} />;
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        onClick?.(event);
        if (href && '__TAURI_INTERNALS__' in window) {
          event.preventDefault();
          void import('@tauri-apps/api/core')
            .then(({ invoke }) => invoke('open_external_url', { url: href }))
            .catch((error) =>
              window.dispatchEvent(new CustomEvent('infohub:notice', { detail: String(error) })),
            );
        }
      }}
    />
  );
}
