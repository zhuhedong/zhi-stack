# 个人 API 令牌、命令行与 MCP

在 **数据与安全 → API 令牌** 中创建令牌。令牌形如 `ihp_` + 64 位十六进制，只在创建时显示一次；服务端仅保存其 SHA-256，可随时撤销，可设置有效期。

## 权限范围

| 权限    | 可访问的接口                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`  | `GET /api/items`（列表与搜索）、`GET /api/items/{id}`、`GET /api/items/{id}/highlights`、`GET /api/tags`、`GET /api/projects`、`GET /api/jobs`、`POST /api/mcp`（只读工具） |
| `write` | `POST /api/items`（新建条目）、`POST /api/jobs`（收录链接）、MCP 写入工具                                                                                                   |

令牌**不携带金库密钥**：凭据中的加密字段永远不可见，也无法新建需要加密的凭据。令牌不能修改或删除条目，不能导出/恢复备份、修改主密码或管理其他令牌（这些接口只接受登录会话）。令牌不包含在备份中，恢复备份后需重新创建。

## curl

```bash
export INFOHUB_URL=https://hub.example.com
export INFOHUB_TOKEN=ihp_xxxxxxxx   # 不要提交到仓库

# 搜索（支持中文短词，空格分隔的多个词需同时匹配）
curl -s -H "Authorization: Bearer $INFOHUB_TOKEN" \
  "$INFOHUB_URL/api/items?q=$(printf '调度' | jq -sRr @uri)&limit=10"

# 读取条目
curl -s -H "Authorization: Bearer $INFOHUB_TOKEN" "$INFOHUB_URL/api/items/<id>"

# 收录链接（write）
curl -s -X POST -H "Authorization: Bearer $INFOHUB_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://example.com/post\",\"kind\":\"\",\"project\":\"\",\"tags\":[],\"requestId\":\"$(uuidgen)\"}" \
  "$INFOHUB_URL/api/jobs"

# 新建笔记（write）
curl -s -X POST -H "Authorization: Bearer $INFOHUB_TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"knowledge","title":"会议纪要","category":"note","data":{"content":"# 要点\n- …"}}' \
  "$INFOHUB_URL/api/items"
```

## 命令行

`cli/infohub.mjs` 只依赖 Node 18+：

```bash
node cli/infohub.mjs search 调度器 --kind knowledge
node cli/infohub.mjs get <id>
node cli/infohub.mjs save https://github.com/tokio-rs/tokio --kind repo --tag rust
echo '# 想法' | node cli/infohub.mjs note "随手记" - --project 个人
```

## MCP

服务端在 `POST /api/mcp` 提供 MCP（Streamable HTTP 传输，仅 JSON 响应，无服务器推送流），协议版本 `2025-06-18`（兼容 `2025-03-26`、`2024-11-05`）。工具：

- `search_items` `{query, kind?, project?, limit?}` — 搜索资料库
- `get_item` `{id}` — 读取条目正文（Markdown，超过 5 万字截断）
- `save_url` `{url, kind?, project?, tags?}` — 收录链接（需要 `write`）
- `create_note` `{title, content, project?, tags?}` — 新建笔记（需要 `write`）

支持远程 HTTP MCP 与自定义请求头的客户端配置示例：

```json
{
  "mcpServers": {
    "infohub": {
      "url": "https://hub.example.com/api/mcp",
      "headers": { "Authorization": "Bearer ihp_xxxxxxxx" }
    }
  }
}
```

只支持 stdio 的客户端可通过 `npx mcp-remote https://hub.example.com/api/mcp --header "Authorization: Bearer ${INFOHUB_TOKEN}"` 桥接。

手动测试：

```bash
curl -s -X POST -H "Authorization: Bearer $INFOHUB_TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_items","arguments":{"query":"调度"}}}' \
  "$INFOHUB_URL/api/mcp"
```
