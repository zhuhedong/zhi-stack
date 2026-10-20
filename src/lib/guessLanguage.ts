/** Best-effort language guess for API payloads. */
export function guessLanguage(text: string, contentType?: string): string | undefined {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('html') || ct.includes('xml')) return 'xml';
  if (ct.includes('yaml')) return 'yaml';
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      return undefined;
    }
  }
  if (t.startsWith('<')) return 'xml';
  return undefined;
}
