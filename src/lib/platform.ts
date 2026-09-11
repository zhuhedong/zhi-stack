export const isDesktop = '__TAURI_INTERNALS__' in window;
export const shortcutModifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
