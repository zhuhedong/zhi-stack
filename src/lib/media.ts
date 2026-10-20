const MEDIA = /^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function archivedMediaPath(src?: string) {
  const path = src?.split(/[?#]/)[0];
  return path && MEDIA.test(path) ? path.slice(4) : '';
}
