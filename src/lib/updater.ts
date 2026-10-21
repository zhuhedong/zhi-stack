import type { Update } from '@tauri-apps/plugin-updater';
import { isDesktop } from './platform';

export const CHECK_UPDATES_EVENT = 'infohub:check-updates';

/** Ask the global UpdatePrompt to run a manual check (shows "already latest" too). */
export function requestUpdateCheck() {
  window.dispatchEvent(new Event(CHECK_UPDATES_EVENT));
}

export async function checkForUpdate(): Promise<Update | null> {
  if (!isDesktop) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  return check({ timeout: 30_000 });
}

export async function relaunchApp() {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
