# 项目完整功能清单

整理日期：2026-09-10。依据当前 React 界面、Rust 路由、PostgreSQL 迁移、Tauri 入口及有效设计资料。

InfoHub 是个人单用户开发者工作台。业务资产分为知识文章、GitHub 项目、服务器与凭证三类；以下将各工作区和公共能力分别展开。“已实现”表示当前代码有对应实现，实际验证范围以 [验收记录](verification.md)、[逐项核查](functional-audit.md) 和 [业务复查](business-review.md) 为准。

## 1. 首次使用与登录

- 连接服务，读取工作台是否已初始化；根据结果进入主密码设置或登录界面。
- 首次设置主密码、二次确认、密码长度检查；已初始化后拒绝重复创建。
- 主密码登录、错误密码提示、提交中状态及防重复提交。
- 显示当前 API 地址；无法连接服务时提供重新连接入口。
- 登录成功进入工作台并解锁当前会话；退出时清除客户端令牌。

依据：[AuthScreen.tsx](../src/components/AuthScreen.tsx)、[auth.rs](../server/src/auth.rs)。

## 2. 会话与金库锁定

- 手动锁定、输入主密码解锁、错误密码拒绝解锁。
- 客户端与服务端均处理 15 分钟无活动锁定；前端活动时同步会话状态。
- 会话最长 8 小时、最多保留 32 个会话；退出只撤销当前会话。
- 令牌保存在客户端内存，服务端保存令牌哈希；刷新、关闭客户端或服务重启后需重新登录。
- 锁定后移除凭证详情、关闭凭证编辑草稿；服务端拒绝凭证读写、凭证附件操作及 HTTP 调试。
- 锁定后仍可使用知识文章和 GitHub 项目；文章草稿不会因锁定凭证而清空。
- 登录失效和金库锁定响应会同步到界面。

依据：[App.tsx](../src/App.tsx)、[auth.rs](../server/src/auth.rs)、[api.ts](../src/lib/api.ts)。

## 3. 工作台、导航与列表

- 三栏工作台：资产导航、资产列表、详情画布；登录、工作台和弹窗共用浅色设计变量。
- 三类资产数量、来源/语言/项目分组及各组实际数量。
- 列表展示分类、更新时间、标题、摘要或项目、标签或 Stars、收藏状态。
- 当前选中项标识、已加载数量/总数、加载更多、列表失败重试及空结果提示。
- 列表条目右键菜单：打开来源、复制标题/链接、收藏、重新同步、编辑属性、删除；锁定时凭证仅提供复制和解锁。
- 小屏展开/关闭导航、列表和详情切换、返回列表、搜索焦点处理。
- 顶部收录、新建、全局检索、锁定/解锁、退出入口。
- 应用内容铺满可用区域；网页业务工具栏不绘制系统窗口按钮。

已在 Chrome 复测 390 px 单栏详情/搜索焦点和 660 px 双栏布局，未覆盖所有尺寸与浏览器。依据：[Sidebar.tsx](../src/components/Sidebar.tsx)、[ListPanel.tsx](../src/components/ListPanel.tsx)、[Header.tsx](../src/components/Header.tsx)。

## 4. 资产新建、属性编辑与删除

- 新建时选择文章、仓库或凭证；编辑已有资产时禁止更换资产类型。
- 编辑标题、分类、所属项目、标签、摘要、来源地址及对应类型的业务字段。
- 手工录入文章正文、仓库本地资料或凭证；凭证表单按协议带出默认字段。
- 标题、URL、数据类型、字段数量等校验；无效提交返回错误。
- 删除前显示确认，删除资产时级联清理附件和离线图片。
- 新建/收录成功后定位新条目；保存和删除后更新列表与分组统计。

删除是永久删除，当前没有回收站。依据：[ItemEditor.tsx](../src/components/ItemEditor.tsx)、[model.rs](../server/src/model.rs)、[routes.rs](../server/src/routes.rs)。

## 5. 项目归档、标签与收藏

- 资产可填写所属项目，编辑时可补全已有项目名称，也可输入新名称。
- 凭证侧边栏按业务项目归档，支持全部项目及未归属项目；可叠加协议类别筛选。
- 标签支持中英文逗号分隔、去除空白和重复项，参与展示与检索。
- 单条资产添加/取消收藏，收藏状态持久化；快捷视图筛选收藏资产。
- 收藏不会丢弃当前正文、笔记或接口参数草稿。
- 同步远程资料时保留项目、标签和收藏状态。

项目和标签目前是资产字段，尚无独立的项目/标签管理页、层级目录或批量重命名。依据：[ItemEditor.tsx](../src/components/ItemEditor.tsx)、[Sidebar.tsx](../src/components/Sidebar.tsx)、[routes.rs](../server/src/routes.rs)。

## 6. 检索、筛选、分页与快捷键

- 按标题、摘要、来源 URL、分类、项目、标签及内容关键词搜索，支持中文和大小写不敏感匹配。
- 文章正文、仓库 README/Release/实践笔记可检索；凭证解锁后可检索 Host 及加密内容。
- 搜索输入防抖、清空搜索、当前分类与全部资产搜索切换。
- 文章来源、仓库语言、凭证协议和项目筛选；仓库语言选项包含实际收录的其他语言。
- 收藏可与检索组合；服务端返回总数与分页数据，前端分批加载。
- 普通列表直接由 PG 分页，不读取全库正文；检索按实际文本匹配路径、引号与换行，搜索过程不持久保存凭证明文。
- 默认按更新时间倒序，使用 ID 保持同时间记录顺序；界面没有其他排序选项。
- `J/K` 导航、`Ctrl/Cmd+F` 全局搜索；输入框之外粘贴 HTTP(S) 链接打开收录表单。

服务端单次返回 1–200 条，前端每批 100 条。当前检索为关键词包含匹配，不包含语义/向量检索。依据：[App.tsx](../src/App.tsx)、[routes.rs](../server/src/routes.rs)。

## 7. 统一链接收录与同步

- 输入 URL 自动识别文章、GitHub 仓库或 OpenAPI，也可指定收录类型。
- 收录时附带项目、标签；提供 GitHub/OpenAPI 示例地址填充。
- 服务端实际下载和解析来源，保存条目与文章图片，返回警告或明确失败原因。
- 收录或同步知识文章时，从正文中的 GitHub 仓库链接自动补录到项目雷达（已存在则跳过，失败记入警告）。
- 非凭证资产按类型和来源地址防止重复收录；失败不会提交不完整的数据库事务。
- 已有资产可手动重新同步，缺少来源地址时提示先填写。
- 文章同步替换远程正文及离线图片；仓库同步更新远程信息并保留本地路径和笔记。
- OpenAPI 同步保留 Base URL、全局 Headers、匹配接口的参数值/启用状态/正文，同时补充新定义。
- 自定义连接字段与备注在同步、内联导入后保留；手动指定文章类型时不因 Swagger 关键词改变分类。

当前通过用户操作触发收录和同步，没有后台任务队列、定时同步或订阅通知。依据：[IngestModal.tsx](../src/components/IngestModal.tsx)、[ingest.rs](../server/src/ingest.rs)、[routes.rs](../server/src/routes.rs)。

## 8. 知识文章与 Markdown 阅读

- 手工创建笔记，保存作者、来源名称、原文地址、摘要、项目、标签与 Markdown 正文。
- 公开 HTML 正文提取、微信正文选择器、通用文章区域识别、来源分类、脚本与无关页面内容清理。
- HTML 转 Markdown，阅读与源码切换，编辑保存，以当前草稿预览。
- Markdown 标题、列表、引用、代码块、链接，以及 GFM 表格、任务列表、删除线展示。
- 导出当前 Markdown，打开原文；正文相对链接按来源 URL 解析。
- 展示已归档图片和失败占位；支持关联附件。

登录墙、验证码、动态渲染和非 UTF-8 页面可能无法抓取。当前没有富文本编辑器或应用级离线缓存。依据：[KnowledgeView.tsx](../src/components/views/KnowledgeView.tsx)、[Markdown.tsx](../src/components/Markdown.tsx)、[ingest.rs](../server/src/ingest.rs)。

## 9. GitHub 项目雷达与 Release

- GitHub 仓库 URL 收录，获取 owner/name、描述、主语言、Topics、默认分支、许可证。
- 展示 Stars、Forks、Watchers 和仓库来源。
- 获取最新 Release 的版本、日期、链接、发布说明，处理没有 Release 的情况。
- 获取并展示 README；仓库相对链接解析到对应目录，外部图片显示来源提示。
- README、版本更新、实践笔记页签切换，打开仓库时默认展示 README；手动同步更新远程信息。
- README/Release 暂时请求失败保留上次成功内容；仓库改名/迁移后使用 GitHub 返回的正式名称。
- 服务端可选配置 `GITHUB_TOKEN` 提高配额或访问已授权仓库；私有仓库尚未实测。

当前只展示最新 Release，没有历史版本列表、更新订阅或完整 Git 操作。依据：[RepoView.tsx](../src/components/views/RepoView.tsx)、[ingest.rs](../server/src/ingest.rs)。

## 10. 本地工作区与实践笔记

- 保存、编辑和复制仓库本地工作区路径。
- Markdown 实践笔记编辑、预览，路径和笔记一起保存；未保存状态提示。
- 桌面入口打开 VS Code、终端或文件管理器；本地命令检查绝对路径与目录是否存在。
- 浏览器提供 VS Code 协议入口和路径复制，终端/文件夹操作提示使用桌面端。
- 手动同步仓库时保留路径和笔记；外部程序启动失败向界面返回实际错误。

尚未实机验证外部软件启动；当前不会自动克隆仓库，也不包含内嵌终端。依据：[RepoView.tsx](../src/components/views/RepoView.tsx)、[workspace.rs](../src-tauri/src/workspace.rs)。

## 11. 服务器与凭证协议模板

| 模板               | 默认连接字段                               |
| ------------------ | ------------------------------------------ |
| REST API / Swagger | Base URL、Swagger URL                      |
| PostgreSQL         | Host、5432 端口、数据库、用户名、密码      |
| MySQL              | Host、3306 端口、数据库、用户名、密码      |
| Redis              | Host、6379 端口、数据库索引、认证密码      |
| MongoDB            | Host、27017 端口、数据库、用户名、密码     |
| Milvus             | Host、19530 端口、用户名、密码、Collection |
| Qdrant             | Host、6333 端口、API Key、Collection       |
| SSH                | Host、22 端口、用户名、密码、私钥          |
| 账号密码           | URL、用户名、密码、备注                    |

- SQL、NoSQL、向量数据库、服务器、账号、HTTP 六类筛选。
- 自定义字符串连接字段新增/删除，表单检查重复字段名。
- 同一个弹窗切换协议/资产类型时保留各自草稿；切回恢复原值，金库锁定清除凭证草稿。
- 连接字段、说明和 API 工作区数据整体加密保存；标题、项目、类别、标签、收藏保留为检索元数据。

依据：[ItemEditor.tsx](../src/components/ItemEditor.tsx)、[model.rs](../server/src/model.rs)。

## 12. 凭证查看与连接工具箱

- 展示协议及连接属性；密码、Token、API Key、私钥等敏感字段默认遮挡。
- 各字段独立显示/隐藏、复制；展示连接说明和自定义字段。
- 生成并复制 psql、mysql、redis-cli、mongosh、ssh 或向量数据库 API 命令。
- 命令进行 Bash 引号处理；SQL/Redis 等命令使用客户端交互输入密码。
- REST 凭证进入接口调试工作区，其他类型显示连接工具箱与附件。

命令面向 Bash/WSL。这里没有数据库连接测试、SQL 编辑器、数据表浏览器或 SSH 登录会话。依据：[CredentialView.tsx](../src/components/views/CredentialView.tsx)、[request.ts](../src/lib/request.ts)。

## 13. OpenAPI 与 Swagger 规范管理

- OpenAPI 3.x、Swagger 2.0，支持 JSON/YAML；从规范 URL、Swagger UI 页面或内联文本导入。
- Swagger UI 配置发现，解析规范实际地址。
- 解析 Base URL、接口方法、路径、描述、标签、Path/Query/Header、请求正文示例。
- 支持路径级和操作级 servers、服务地址变量默认值；支持 OpenAPI 3 URL 编码表单及 Swagger 2 formData 基础示例。
- 支持本地 `$ref`、默认值/示例、路径级与操作级参数合并、递归模型的有限深度示例。
- 缺失引用、外部引用和不支持的版本返回错误；Swagger 2 使用声明的 Content-Type。
- 重新同步接口规范，按方法和路径匹配已有接口，合并新定义与旧参数值。

外部 `$ref` 需要先合并到单个规范；不是完整的 OpenAPI 建模、校验或规范导出平台。依据：[ingest.rs](../server/src/ingest.rs)、[routes.rs](../server/src/routes.rs)。

## 14. 接口目录与请求参数

- 接口目录选择、搜索、添加、删除；编辑方法、路径和接口说明。
- 支持 GET、POST、PUT、PATCH、DELETE、HEAD、OPTIONS、TRACE。
- Base URL 编辑；Path/Query 参数新增、删除、键名/值/说明编辑；Query 启停。
- 单个接口可覆盖基础地址；地址自带的查询参数会保留，编辑路径会同步生成对应 Path 输入项。
- Path 占位替换及发送前必填检查，中文和特殊字符编码。
- 原始请求正文编辑、JSON 格式化、错误提示；GET/HEAD 不发送正文。
- Headers、Params、Body 页签；保存参数到加密凭证。

当前没有自动构造 multipart 文件正文、多环境变量、前后置脚本或接口批量执行器。依据：[ApiWorkbench.tsx](../src/components/ApiWorkbench.tsx)、[PairEditor.tsx](../src/components/PairEditor.tsx)、[request.ts](../src/lib/request.ts)。

## 15. 全局请求头与接口覆盖

- 每个 REST 资产拥有独立的“全局请求头”页签；新增、修改、删除、启用/停用全局 Header。
- 全局 Header 应用于该资产下所有接口，支持值及说明编辑、敏感值显隐。
- 每个接口可添加专属 Header；同名匹配不区分大小写，启用的专属值覆盖全局值。
- 合并视图区分“全局继承”和“接口专属”；停用专属覆盖后恢复全局值。
- 在接口页编辑继承的全局 Header，会影响同一 REST 资产的其他接口；随“保存参数”持久化。
- 合并结果同时用于真实请求和实时 cURL。

“全局”范围为当前 REST 资产，不是整个应用所有凭证共享。依据：[RequestHeaders.tsx](../src/components/RequestHeaders.tsx)、[ApiWorkbench.tsx](../src/components/ApiWorkbench.tsx)。

## 16. HTTP 调试、cURL 与响应

- 根据当前 URL、参数、Headers 和 Body 实时生成完整 cURL，支持复制；HEAD 使用 `--head`。
- Rust 服务端发送真实请求，必须登录且解锁；指定内网目标可通过主机白名单放行。
- 展示 HTTP 状态码、响应头、耗时、字节大小、正文与空响应状态；HTTP 错误码如实展示。
- JSON 响应格式化；文本响应与二进制响应分别下载，二进制保留原始字节。
- 请求中状态；切换接口或更改参数后忽略旧响应，避免结果串到其他接口。
- 请求正文上限 2 MB、响应上限 8 MB、请求超时 30 秒；调试请求不自动跟随重定向。

响应保留在当前界面状态，未持久保存请求历史或响应历史；尚无手动取消请求按钮。依据：[ApiWorkbench.tsx](../src/components/ApiWorkbench.tsx)、[routes.rs](../server/src/routes.rs)、[net.rs](../server/src/net.rs)。

## 17. 附件与白皮书

- 三类资产均可挂载附件，REST 工作区有独立附件页签。
- 多文件选择并依次上传，显示文件数量、名称和大小；单文件最大 10 MB。
- 下载原始内容并保留文件名，支持中文名称；删除前确认，上传/下载期间显示忙碌状态。
- 凭证附件先加密再存入服务器磁盘或 Cloudflare R2，PG 只保存文件信息和位置；金库锁定后禁止列举、上传、下载和删除。
- 删除资产时级联删除附件；普通文章和仓库附件不受金库锁定影响。

尚无附件预览、备注编辑、文件夹管理、全文索引或直接调用本地程序打开附件。多文件上传不是整体事务，前面已上传成功的文件会保留。依据：[Attachments.tsx](../src/components/Attachments.tsx)、[routes.rs](../server/src/routes.rs)。

## 18. 文章图片与媒体归档

- 抓取图片实际字节并保存到服务器磁盘或 Cloudflare R2，在 PG 记录来源地址、MIME、SHA-256 和存储位置。
- 单篇最多归档 30 张 PNG/JPEG/GIF/WebP，文章内相同来源图片复用。
- 正文使用受登录保护的媒体地址，前端鉴权读取后展示并按需加载。
- 未归档或失败的图片显示占位和提示；外部 SVG 不作为活动内容执行。
- 重抓文章更新媒体；删除文章清理关联图片。

归档后可脱离文章来源阅读，但仍需要 InfoHub 服务、PG 和文件存储。GitHub README 的外部图片不会通过此流程自动归档。依据：[Markdown.tsx](../src/components/Markdown.tsx)、[ingest.rs](../server/src/ingest.rs)、[routes.rs](../server/src/routes.rs)。

## 19. 复制、导出与下载

- 复制单个凭证字段、连接命令、工作区路径和完整 cURL；成功反馈或失败提示。
- 导出当前文章 Markdown；当前未保存的正文也可以导出。
- Markdown 不附带离线图片包，内部媒体引用仍依赖 InfoHub 登录读取。
- 下载附件、HTTP 文本响应 `.txt`、二进制响应 `.bin`。
- 下载生成的临时 Blob URL 在使用后释放。

当前没有全库导入/导出、ZIP 打包、凭证批量导出或 OpenAPI 规范导出。复制仅写入系统剪贴板，没有“30 秒后自动清除”的实际实现。依据：[api.ts](../src/lib/api.ts)、[KnowledgeView.tsx](../src/components/views/KnowledgeView.tsx)、[ApiWorkbench.tsx](../src/components/ApiWorkbench.tsx)。

## 20. 草稿、冲突处理与操作反馈

- 文章、实践笔记、API 参数、新建/编辑弹窗和收录表单记录未保存状态。
- 切换资产、取消表单、退出或关闭时提供相应的未保存保护；提交期间限制关闭或重复操作。
- 保存失败保留当前草稿；服务端用 revision 检测旧版本提交，拒绝覆盖较新记录。
- 保存期间继续输入，后续内容仍为未保存；旧异步操作不清除其他资产的草稿。
- 断网、认证失效、锁定、校验失败、重复收录、冲突、上游错误等有对应反馈。
- Toast 操作提示支持自动消失和手动关闭；弹窗使用原生 dialog、首个输入框聚焦和 Escape 关闭处理。
- 输入及按钮有基础语义标签，状态/错误使用相应辅助阅读语义。

草稿没有写入本地持久存储，不提供崩溃恢复、自动保存或版本历史。Toast 不是持久通知中心。原生关闭保护尚待实机验收，未进行完整无障碍审计。依据：[App.tsx](../src/App.tsx)、[useDraft.ts](../src/lib/useDraft.ts)、[Modal.tsx](../src/components/Modal.tsx)、[error.rs](../server/src/error.rs)。

## 21. PostgreSQL 持久化与数据一致性

- `vault_config`：主密码随机盐、加密校验值、初始化时间。
- `items`：三类资产、检索元数据、JSONB 正文或凭证密文、收藏、revision 与时间戳。
- `attachments`：资产附件的文件名、大小、类型、加密标记和存储引用。
- `media`：文章图片来源、类型、哈希和存储引用。
- `file_objects`：磁盘/R2 存储位置、文件大小、校验哈希及持久清理队列，不存文件内容。
- 支持旧版 PG 文件自动迁移到磁盘/R2，逐文件读取校验后移除二进制字段；失败可重启续迁。
- 自动执行 SQLx 迁移；连接池、连接超时、事务保存、外键级联删除、来源唯一约束及索引。
- 服务重启后记录保持，可重新登录解密凭证；不使用运行时模拟数据或 SQLite。

当前没有备份/恢复 API、定时备份脚本或存储切换向导。备份需覆盖完整 PG 数据库（含金库配置）和对应磁盘/R2 文件；连接池不是高可用或自动故障切换。依据：[数据库迁移](../server/migrations/0002_external_files.sql)、[文件管理](../server/src/files.rs)、[文件存储说明](file-storage.md)。

## 22. 网络与服务端安全

- 主密码使用 Argon2id 派生密钥；凭证和凭证附件使用 AES-256-GCM，结合记录上下文验证密文完整性。
- 业务 API Bearer 鉴权；初始化、登录、健康状态为公开入口；认证尝试限流。
- 收录及调试限制 HTTP(S) 协议，拒绝 URL 内嵌用户名/密码；检查解析地址并固定连接目标。
- 默认阻止内网、环回及保留地址，允许配置精确主机白名单；采集重定向重新验证，跨源移除敏感请求头。
- 检查请求 Header，限制正文、响应和上传大小。
- CORS 来源限制，API `no-store`，`nosniff`、禁止页面被框架嵌入、Referrer 限制；桌面 CSP。
- 数据库错误在服务端记录，前端显示概括错误；上游连接失败不回显可能包含密钥的 URL。

当前没有多人权限、操作审计日志、主密码修改/找回流程或端到端多设备密钥管理。依据：[auth.rs](../server/src/auth.rs)、[crypto.rs](../server/src/crypto.rs)、[net.rs](../server/src/net.rs)、[lib.rs](../server/src/lib.rs)。

## 23. 配置、服务运行与部署

| 配置                                                           | 当前用途                     |
| -------------------------------------------------------------- | ---------------------------- |
| `DATABASE_URL` 或 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` | PostgreSQL 连接              |
| `BIND_ADDR`                                                    | Rust 服务监听地址            |
| `FRONTEND_DIR`                                                 | 服务端静态网页目录           |
| `ALLOWED_ORIGINS`                                              | Web/桌面客户端跨域来源       |
| `ALLOWED_PRIVATE_HOSTS`                                        | 采集与调试允许访问的内网主机 |
| `GITHUB_TOKEN`                                                 | GitHub API 访问凭据          |
| `VITE_API_URL`                                                 | 前端构建时指定 API 地址      |
| `RUST_LOG`                                                     | 服务端日志过滤级别           |
| `POSTGRES_PASSWORD`                                            | Docker Compose 的 PG 密码    |
| `FILE_STORAGE`                                                 | `local` 默认磁盘或 `r2`      |
| `LOCAL_STORAGE_PATH`                                           | 直接运行时的磁盘文件目录     |
| `R2_ENDPOINT` / `R2_BUCKET`                                    | R2 账户 S3 端点和 Bucket     |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`                    | 服务端 R2 对象读写凭据       |

- 本地独立 PG 启动脚本：数据目录、随机连接密码、首次 `.env` 创建、实例复用与退出处理。
- 前端开发代理、生产构建、Rust 服务静态文件托管及 SPA 回退。
- 健康/初始化状态接口、启动存储读写自检、服务日志、Ctrl+C 与 Linux SIGTERM 优雅关闭。
- Dockerfile、应用与 PG 的 Compose 配置、数据库健康检查、命名数据卷和重启策略。
- 已有远程 PG 时可用独立 [compose.external-pg.yaml](../compose.external-pg.yaml) 只部署应用；支持分项 PG 连接、SSL 模式及可选 CA 证书挂载，步骤见 [使用已有 PG 部署](deploy-external-pg.md)。此模式未做容器实跑验收。
- 桌面登录页及顶部提供服务连接设置，可测试连接、保存到本机、恢复默认地址；更换服务器清除原会话和密码，无需重新打包。
- Tauri 开发与构建流程；桌面 CSP 支持配置的 HTTP/HTTPS 服务，服务端 CORS 保留桌面来源。

服务端设置通过环境变量和配置文件完成；桌面服务地址已有独立设置弹窗。日志不是可检索的运维平台。Docker 和远程 HTTPS 部署尚未实际验收。依据：[main.rs](../server/src/main.rs)、[ServerSettings.tsx](../src/components/ServerSettings.tsx)、[compose.yaml](../compose.yaml)、[运行说明](../README.md)。

## 24. 桌面窗口与品牌图标

- Tauri 原生标题栏、系统最小化/最大化/关闭、窗口拖拽和尺寸调整；默认窗口 1440×900，最小 800×600。
- 接入未保存内容关闭保护，提供受路径和协议校验的本地工作区/外部链接命令。
- Web 与桌面共用同一套服务 API；桌面嵌入生产前端。
- 蓝白 iH 品牌标记用于登录、工作台、网页 favicon 和桌面程序。
- SVG 主稿、小尺寸稿、单色稿，PNG、ICO、ICNS、Apple Touch 与 Windows Store 资源。
- 图标重新生成、实际尺寸预览、Windows EXE 七档图标资源校验；只修改图标也会触发资源重编译。

已有 Windows debug EXE 构建记录；没有完成 MSI/NSIS 安装卸载、签名和跨机器验证。桌面端仍需独立运行服务与 PG；未提供托盘、自动更新或后端一键托管。macOS 图标资源不表示 macOS 客户端已经验收。依据：[Tauri 配置](../src-tauri/tauri.conf.json)、[桌面入口](../src-tauri/src/lib.rs)、[图标说明](../assets/brand/README.md)。

## 25. 测试、验收与开发辅助

- 前端 TypeScript/Vite 构建、oxlint；Rust 单元测试和 Clippy。
- React 组件交互回归：编辑草稿、异步保存、锁定、接口切换、附件、快捷键等。
- 请求编译及连接命令检查：编码、Header 合并、cURL、协议命令。
- 真实 PG 集成脚本：创建隔离测试库、启动本地 HTTP 来源、执行真实服务验证，结束后清理测试数据。
- 可选公开 GitHub 网络验收及保持隔离验收页面的运行模式。
- 历史验收通过 21 组 PG 集成、37 项单元/组件检查；图标有独立构建与资源检查流程。

2026-09-10 复查验收：磁盘 22 组、R2 协议 23 组 PG 集成检查；磁盘迁移/恢复 5 组、R2 迁移/启动 4 组；9 项服务端单元测试、22 项原有 React 组件测试、8 项连接和设置测试通过。R2 使用本地签名校验服务，未连接真实 Cloudflare 账号。修复和待验范围见 [复查报告](architecture-review.md)。

## 服务端接口清单

共 15 个路径、20 个“方法 + 路径”组合。除前三个公开入口外，均要求登录。金库限制由实际处理的资产类型决定。

| 方法   | 路径                          | 功能及附加条件                                         |
| ------ | ----------------------------- | ------------------------------------------------------ |
| GET    | `/api/health`                 | 数据库连接/初始化状态、服务版本；无需登录              |
| POST   | `/api/auth/setup`             | 首次设置主密码并创建会话；无需登录                     |
| POST   | `/api/auth/login`             | 主密码登录；无需登录                                   |
| POST   | `/api/auth/logout`            | 撤销当前会话                                           |
| GET    | `/api/session`                | 当前会话与金库状态                                     |
| POST   | `/api/vault/lock`             | 锁定当前会话金库                                       |
| POST   | `/api/vault/unlock`           | 主密码校验后解锁                                       |
| GET    | `/api/items`                  | 检索、筛选、分页、总数、分组统计；凭证仅返回公开元数据 |
| POST   | `/api/items`                  | 创建资产；创建凭证要求解锁                             |
| GET    | `/api/items/{id}`             | 详情；凭证详情要求解锁                                 |
| PUT    | `/api/items/{id}`             | 更新资产，检查 revision；凭证更新要求解锁              |
| DELETE | `/api/items/{id}`             | 永久删除及关联清理；删除凭证要求解锁                   |
| POST   | `/api/items/{id}/refresh`     | 重新采集同步；凭证同步要求解锁                         |
| POST   | `/api/ingest`                 | 收录文章、GitHub 或 OpenAPI；收录为凭证要求解锁        |
| POST   | `/api/probe`                  | 服务端发送 HTTP 请求；要求解锁                         |
| GET    | `/api/items/{id}/attachments` | 附件列表；凭证附件要求解锁                             |
| POST   | `/api/items/{id}/attachments` | 上传附件；凭证附件要求解锁                             |
| GET    | `/api/attachments/{id}`       | 下载附件；凭证附件要求解锁                             |
| DELETE | `/api/attachments/{id}`       | 删除附件；凭证附件要求解锁                             |
| GET    | `/api/media/{id}`             | 鉴权读取文章归档图片                                   |

路由依据：[server/src/lib.rs](../server/src/lib.rs)。收藏通过资产更新接口保存，统计由列表接口返回；没有另外的收藏、统计或项目 CRUD 路由。

## 原型提示与当前实现的差异

| 原型或容易混淆的名称   | 当前实际情况                                                   |
| ---------------------- | -------------------------------------------------------------- |
| “复制后 30 秒自动清除” | 原型有此提示；正式代码只复制，未实现自动清除                   |
| 附件“在本地打开”       | 原型为提示操作；正式版提供下载，未调用系统程序打开附件         |
| “GitHub 项目雷达”      | 仓库资料和最新 Release 的手动同步，没有订阅/推送后台           |
| “离线阅读”             | 正文在 PG、图片在服务端磁盘/R2；服务端不可用时没有本地缓存阅读 |
| “业务项目”             | 资产上的项目归档字段，没有独立项目实体、成员、任务或看板       |
| “AI 向量”              | Milvus/Qdrant 凭证模板，不包含 AI 对话、向量检索或知识库推理   |
| “通知”                 | 短暂操作反馈，不包含消息中心或系统通知订阅                     |
| “版本冲突”             | 乐观并发保护，不包含历史版本回看、差异合并或回滚               |
| “桌面打包”             | 已构建 debug EXE；独立服务/PG、安装器和分发仍需各自处理        |

这些差异不记作已实现功能，也不表示已确定新增需求。原型依据：[亮色交互原型](../dosc/infohub_apple_light.html)。

仓库中的 `src-tauri/src/db.rs`、`crypto.rs`、`net.rs` 没有接入当前桌面入口；`src/store/mockData.ts` 是空模块。它们不构成另一套已启用的本地数据库、加密、采集或模拟数据功能。
