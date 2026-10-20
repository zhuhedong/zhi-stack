import { useEffect, useState } from 'react';
import { isDesktop } from './platform';

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
const KEY = 'infohub.theme';
const media = () => window.matchMedia?.('(prefers-color-scheme: dark)');

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}
export const resolveTheme = (pref: ThemePref): Theme =>
  pref === 'system' ? (media()?.matches ? 'dark' : 'light') : pref;

async function syncWindow(pref: ThemePref) {
  if (!isDesktop) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    // null = follow the OS; keeps native title bar / traffic lights in sync.
    await getCurrentWindow().setTheme(pref === 'system' ? null : pref);
  } catch {
    /* older runtime or permission missing: CSS theme still applies */
  }
}

/** Applies the theme to <html>. Called before first render to avoid a flash. */
export function applyTheme(pref: ThemePref = readThemePref()) {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(pref);
  root.dataset.themePref = pref;
  void syncWindow(pref);
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  useEffect(() => {
    applyTheme(pref);
    try {
      if (pref === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch {
      /* storage unavailable */
    }
    if (pref !== 'system') return;
    const mq = media();
    const onChange = () => applyTheme('system');
    mq?.addEventListener?.('change', onChange);
    return () => mq?.removeEventListener?.('change', onChange);
  }, [pref]);
  return [pref, setPref] as const;
}
