import type { Item } from '../types';

/** Saved articles for offline reading (opt-in per device, Cache Storage). */
const CACHE = 'infohub-articles';
const FLAG = 'infohub.offlineReading';
const INDEX = '/offline/index.json';
const MAX_ITEMS = 200;
const MAX_CHARS = 2_000_000;
export interface OfflineEntry {
  id: string;
  title: string;
  url: string;
  project: string;
  tags: string[];
  updatedAt: string;
  savedAt: string;
  chars: number;
}
export interface OfflineArticle extends OfflineEntry {
  content: string;
  author?: string;
}
export const offlineSupported = () => typeof caches !== 'undefined' && !('__TAURI_INTERNALS__' in window);
export const offlineEnabled = () => offlineSupported() && localStorage.getItem(FLAG) === '1';
const entryUrl = (id: string) => `/offline/items/${encodeURIComponent(id)}.json`;
async function readIndex(cache: Cache): Promise<OfflineEntry[]> {
  const hit = await cache.match(INDEX);
  if (!hit) return [];
  try {
    return (await hit.json()) as OfflineEntry[];
  } catch {
    return [];
  }
}
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

/** Stores an opened article (knowledge items only; credentials are never cached). */
export async function saveOffline(item: Item): Promise<boolean> {
  if (!offlineEnabled() || item.kind !== 'knowledge') return false;
  const content = String(item.data?.content || '');
  if (!content || content.length > MAX_CHARS) return false;
  const cache = await caches.open(CACHE);
  const entry: OfflineEntry = {
    id: item.id,
    title: item.title,
    url: item.url,
    project: item.project,
    tags: item.tags,
    updatedAt: item.updatedAt,
    savedAt: new Date().toISOString(),
    chars: content.length,
  };
  const article: OfflineArticle = { ...entry, content, author: item.data?.author };
  await cache.put(entryUrl(item.id), json(article));
  const index = [entry, ...(await readIndex(cache)).filter((e) => e.id !== item.id)];
  for (const evicted of index.splice(MAX_ITEMS)) await cache.delete(entryUrl(evicted.id));
  await cache.put(INDEX, json(index));
  return true;
}
export async function listOffline(): Promise<OfflineEntry[]> {
  if (!offlineSupported()) return [];
  return readIndex(await caches.open(CACHE));
}
export async function readOffline(id: string): Promise<OfflineArticle | null> {
  if (!offlineSupported()) return null;
  const hit = await (await caches.open(CACHE)).match(entryUrl(id));
  return hit ? ((await hit.json()) as OfflineArticle) : null;
}
export async function removeOffline(id: string) {
  const cache = await caches.open(CACHE);
  await cache.delete(entryUrl(id));
  await cache.put(INDEX, json((await readIndex(cache)).filter((e) => e.id !== id)));
}
export async function setOfflineEnabled(enabled: boolean) {
  if (enabled) localStorage.setItem(FLAG, '1');
  else {
    localStorage.removeItem(FLAG);
    if (offlineSupported()) await caches.delete(CACHE);
  }
}

/** Registers the service worker (web builds only, never in the desktop shell or dev server). */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || '__TAURI_INTERNALS__' in window || import.meta.env.DEV) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* Offline support is optional. */
    });
  });
}

/** URL shared to the installed app (Web Share Target) or handed over by the bookmarklet. */
export function sharedUrl(search: string): string {
  const params = new URLSearchParams(search);
  const candidates = [params.get('save'), params.get('url'), ...(params.get('text') || '').split(/\s+/)];
  for (const value of candidates) {
    const text = value?.trim() || '';
    if (!text || text.length > 2048) continue;
    try {
      const url = new URL(text);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    } catch {
      /* Not a URL. */
    }
  }
  return '';
}
