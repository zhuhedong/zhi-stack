export const isDesktop = '__TAURI_INTERNALS__' in window;
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const shortcutModifier = isMac ? '⌘' : 'Ctrl';
