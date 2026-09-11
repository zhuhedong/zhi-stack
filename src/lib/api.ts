import type { Item, ItemInput } from '../types';
import { vscodeFileUrl } from './request';
import { saveServerUrl, serverUrl } from './server';

let token = '';
export let API_BASE = serverUrl();
let connectionRevision = 0;
export function configureServer(value: string) {
  API_BASE = saveServerUrl(value);
  token = '';
  connectionRevision++;
}
function ensureCurrent(revision: number) {
  if (revision !== connectionRevision) throw new DOMException('服务连接或登录会话已更换', 'AbortError');
}
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export function setToken(value: string) {
  if (token !== value) connectionRevision++;
  token = value;
}
export async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const revision = connectionRevision;
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
  } catch (error) {
    ensureCurrent(revision);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('无法连接服务端，请检查服务是否启动及 API 地址。', 0);
  }
  ensureCurrent(revision);
  if (!response.ok) {
    const text = await response.text();
    ensureCurrent(revision);
    let message = `请求失败（HTTP ${response.status}）`;
    try {
      message = (JSON.parse(text) as { error: string }).error || message;
    } catch {
      if (response.status === 413) message = '上传内容过大，附件最多 10 MB';
    }
    if (response.status === 401 && !path.startsWith('/auth/') && path !== '/vault/unlock')
      window.dispatchEvent(new Event('infohub:unauthorized'));
    if (response.status === 423) window.dispatchEvent(new Event('infohub:locked'));
    throw new ApiError(message, response.status);
  }
  return response;
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const revision = connectionRevision;
  const response = await request(path, options);
  const result = response.status === 204 ? undefined : await response.json();
  ensureCurrent(revision);
  return result as T;
}
export const saveItem = (item: ItemInput, id?: string) =>
  api<Item>(id ? `/items/${id}` : '/items', { method: id ? 'PUT' : 'POST', body: JSON.stringify(item) });
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
export async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function exportText(text: string, name: string) {
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), name);
}
export async function desktopAction(action: 'vscode' | 'terminal' | 'folder', path: string) {
  if (!path.trim()) throw new Error('请先填写并保存本地工作区路径');
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_workspace', { action, path });
  } else if (action === 'vscode') {
    window.location.href = vscodeFileUrl(path);
  } else throw new Error('打开终端和文件夹需要 InfoHub 桌面版；浏览器中可复制工作区路径');
}
