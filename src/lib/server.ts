import { isDesktop } from './platform';

const STORAGE_KEY = 'infohub.server-url';
const configured = import.meta.env.VITE_API_URL as string | undefined;
export const DEFAULT_API_BASE = isDesktop ? '' : (configured || '/api').replace(/\/+$/, '');

export type ClientConfig = { serverUrl: string | null; configPath: string; error: string | null };

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
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    value.trim().length > 4096 ||
    // eslint-disable-next-line no-control-regex -- Reject characters silently discarded by URL parsing.
    /[\u0000-\u001f\u007f]/.test(value.trim())
  )
    throw new Error('服务地址只支持 HTTP 或 HTTPS，不能包含账号、密码、查询参数或片段');
  let path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/api')) path += '/api';
  url.pathname = path;
  return url.toString().replace(/\/$/, '');
}

export function previousServerUrl(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizeServerUrl(saved) : '';
  } catch {
    return '';
  }
}

async function configCommand(command: string, args?: Record<string, unknown>): Promise<ClientConfig> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<ClientConfig>(command, args);
  } catch (error) {
    throw new Error(typeof error === 'string' ? error : '无法访问本机配置文件，请检查目录权限');
  }
}

export async function loadServerConfig(): Promise<ClientConfig> {
  if (!isDesktop) return { serverUrl: DEFAULT_API_BASE, configPath: '', error: null };
  const config = await configCommand('load_client_config');
  return { ...config, serverUrl: config.serverUrl ? normalizeServerUrl(config.serverUrl) : null };
}

export async function saveServerUrl(value: string): Promise<ClientConfig> {
  if (!isDesktop) throw new Error('服务地址设置用于桌面客户端；浏览器使用当前站点的服务');
  const normalized = normalizeServerUrl(value);
  const config = await configCommand('save_client_config', { serverUrl: normalized });
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The configuration file has already been saved; removing the old cache is optional.
  }
  return config;
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
