import type { ComponentProps } from 'react';

export async function openSource(href: string) {
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_external_url', { url: href });
    return;
  }
  window.open(href, '_blank', 'noopener,noreferrer');
}

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
          void openSource(href).catch((error) =>
            window.dispatchEvent(new CustomEvent('infohub:notice', { detail: String(error) })),
          );
        }
      }}
    />
  );
}
