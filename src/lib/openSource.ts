export async function openSource(href: string) {
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_external_url', { url: href });
    return;
  }
  window.open(href, '_blank', 'noopener,noreferrer');
}
