/** Workbench root that serves the web UI for the configured API (".../api" → "..."). */
export function workbenchBase(
  apiBase: string,
  here = globalThis.location?.href ?? 'http://localhost/',
): string {
  const url = new URL(apiBase || '/api', here);
  url.pathname = url.pathname.replace(/\/api\/?$/, '/') || '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Bookmarklet source. It carries no token: it only opens this instance's
 * workbench in a small window, where the normal login/session applies.
 */
export function bookmarkletCode(base: string): string {
  const target = JSON.stringify(base);
  return (
    'javascript:(()=>{' +
    `const b=${target};` +
    "const u=b+'?save='+encodeURIComponent(location.href);" +
    "const w=window.open(u,'infohub-save','width=560,height=720');" +
    'if(!w)location.href=u;' +
    '})();'
  );
}

/** URL handed over by the bookmarklet (`?save=`), if it is a plausible http(s) link. */
export function pendingSaveUrl(search: string): string {
  const value = new URLSearchParams(search).get('save')?.trim() || '';
  if (!value || value.length > 2048) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}
