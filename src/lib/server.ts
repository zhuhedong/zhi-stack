import { isDesktop } from './platform';

const STORAGE_KEY = 'infohub.server-url';
const configured = import.meta.env.VITE_API_URL as string | undefined;
export const DEFAULT_API_BASE = (configured || (isDesktop ? 'http://127.0.0.1:3210/api' : '/api')).replace(
  /\/+$/,
  '',
);

export function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请输入完整的 HTTP 或 HTTPS 服务地址');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes('\\')
  )
    throw new Error('服务地址只支持 HTTP 或 HTTPS，不能包含账号、密码、查询参数或片段');
  let path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/api')) path += '/api';
  url.pathname = path;
  return url.toString().replace(/\/$/, '');
}

export function serverUrl(): string {
  if (isDesktop) {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return normalizeServerUrl(saved);
    } catch {
      /* A missing or invalid preference falls back to the packaged default. */
    }
  }
  return DEFAULT_API_BASE;
}

export function saveServerUrl(value: string): string {
  if (!isDesktop) throw new Error('服务地址设置用于桌面客户端；浏览器使用当前站点的服务');
  const normalized = normalizeServerUrl(value);
  try {
    localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    throw new Error('无法保存服务地址，请检查本机存储权限');
  }
  return normalized;
}

export function serverInitialized(health: unknown): boolean {
  const value = health as { database?: unknown; initialized?: unknown; version?: unknown } | null;
  if (
    value?.database !== 'PostgreSQL' ||
    typeof value?.initialized !== 'boolean' ||
    typeof value?.version !== 'string'
  )
    throw new Error('该地址没有返回有效的 InfoHub 服务状态，请检查地址和反向代理');
  return value.initialized;
}

export async function checkServerConnection(value: string, signal?: AbortSignal): Promise<boolean> {
  const address = normalizeServerUrl(value);
  const timeout = AbortSignal.timeout(5000);
  const response = await fetch(address + '/health', {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`服务检查失败（HTTP ${response.status}）`);
  return serverInitialized(await response.json());
}
