export const fieldNames: Record<string, string> = {
  baseUrl: 'Base URL',
  swaggerUrl: 'OpenAPI / Swagger URL',
  host: 'Host / IP',
  port: '端口',
  database: '数据库名称',
  username: '登录用户名',
  password: '密码',
  authPassword: '认证密码',
  dbIndex: '数据库索引',
  collection: 'Collection',
  apiKey: 'API Key',
  privateKey: 'SSH 私钥',
  url: '登录地址',
  notes: '备注',
};
export const secretField = (key: string) =>
  /password|secret|token|api[-_]?key|private[-_]?key|authorization|cookie/i.test(key);
