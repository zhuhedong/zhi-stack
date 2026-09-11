# InfoHub 开发者数字工作台

按照 [Apple Light 设计规范](dosc/Style_Design.md)和[亮色交互原型](dosc/infohub_apple_light.html)实现，使用 React + TypeScript 前端、Rust / Axum 服务端和 PostgreSQL。浏览器和 Tauri 桌面客户端使用同一套 HTTP API。业务记录和文件元数据保存在 PG；附件、文章图片保存在服务器磁盘或 Cloudflare R2，默认使用磁盘，运行时不使用 SQLite 或模拟数据。

设计文件的有效版本见 [设计资料说明](dosc/README.md)。浅色玻璃材质、系统字体、颜色和尺寸统一由 [tokens.css](tokens.css) 管理；修复及验收记录见 [设计核查](docs/design-review.md)。

## 已实现的功能

| 模块           | 功能                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作台         | Apple Light 玻璃三栏布局、动态统计、来源/语言/项目筛选、协议分类、跨分类搜索、正文与标签检索、收藏、分页、J/K 导航、Ctrl/Cmd+F 搜索、粘贴链接收录                                         |
| 知识与文章     | 微信/论坛/博客 HTML 正文提取、转换 Markdown、图片离线归档、阅读/源码切换、编辑保存、Markdown 导出、来源跳转、重新抓取、附件                                                               |
| GitHub 项目    | 仓库元数据、Stars/Forks/Watchers、许可证、最新 Release、README、版本同步、工作区路径、实践笔记与预览                                                                                      |
| 服务器与密码库 | PostgreSQL、MySQL、Redis、MongoDB、Milvus、Qdrant、SSH、账号密码，项目归档、自定义连接属性、密码显隐和复制、连接命令                                                                      |
| REST API       | OpenAPI 3.x / Swagger 2.0 JSON、YAML、Swagger UI 导入，接口列表，Path/Query/Headers/Body 编辑，全局 Header 继承与覆盖，JSON 格式化，实时 cURL，真实 HTTP 调试，响应头/状态/耗时/大小/正文 |
| 安全与附件     | 首次设置主密码、登录、退出、会话锁定与解锁、Argon2id 密钥派生、AES-256-GCM 认证加密、凭证附件加密、上传/下载/删除、并发修改冲突检测                                                       |
| 桌面集成       | 系统原生窗口边框、最小化/最大化/关闭和拖拽、未保存关闭保护，以及打开 VS Code、终端、文件管理器和来源链接                                                                                  |

当前定位为个人单用户工作台。主密码同时用于登录及派生凭证密钥；不包含多人协作、账号邀请或云端密码找回。

当前功能及验证范围见 [完整清单](docs/feature-list.md)和[业务功能复查](docs/business-review.md)。复查已修复同步字段丢失、收藏草稿丢失、接口服务地址/表单编码及列表全量读取等问题。

## 本机快速启动

需要 Node.js 22.12+、Rust 工具链；Tauri 在 Windows 上还需要 MSVC 和 WebView2。

```powershell
npm install
```

### 方式一：项目内独立 PostgreSQL

没有 Docker 或现有 PG 时，可以直接运行真正的 PostgreSQL 本地实例：

```powershell
npm run db:dev
```

保持这个终端运行。脚本在项目的 `.local/postgres` 保存数据库，默认监听 `127.0.0.1:55432`，随机生成数据库密码，首次自动创建 `.env`，不会覆盖已有 `.env`。Windows 使用 PG 自带的 `pg_ctl` 启动，兼容管理员终端；不安装系统服务，也不创建系统用户。Linux/macOS 请以普通用户运行。

另开终端启动服务：

```powershell
npm run server
```

再开终端启动前端：

```powershell
npm run dev
```

打开 **http://127.0.0.1:5173/**。首次访问设置自己的主密码。数据库初始为空，可以收录公开 GitHub 链接、文章，或新建资产。主密码与 PG 连接密码是两回事。

前端开发代理固定指向 `http://127.0.0.1:3210/api`。生产构建后也可直接访问 Rust 服务提供的页面：

```powershell
npm run build
npm run server
```

地址为 **http://127.0.0.1:3210/**。

### 方式二：现有 PostgreSQL

复制 `.env.example` 为 `.env`，填写 `DATABASE_URL`。数据库需预先存在，数据库用户需要建表和迁移权限。推荐 PG 15+。服务启动会自动执行 `server/migrations/` 下的 SQLx 迁移。

```dotenv
DATABASE_URL=postgres://your_user:your_url_encoded_password@127.0.0.1:5432/infohub
BIND_ADDR=127.0.0.1:3210
```

连接 URL 中的特殊字符应做 URL 编码；也可不设置 `DATABASE_URL`，改用 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`。然后运行 `npm run server` 与 `npm run dev`。

**已有远程 PG，只用 Docker 部署应用**：使用独立文件 [compose.external-pg.yaml](compose.external-pg.yaml)。复制 [.env.external-pg.example](.env.external-pg.example) 为 `.env.external-pg` 并填写已有数据库连接，然后执行：

```bash
docker compose --env-file .env.external-pg -f compose.external-pg.yaml up -d --build
```

该文件只启动应用，通过 Docker 默认网络连接远程 PG，支持 `PGSSLMODE` 和可选 CA 证书挂载。数据库需提前准备好，账户需有迁移权限。网络、SSL、检查命令和访问配置见 [使用已有 PG 部署](docs/deploy-external-pg.md)。

### 方式三：Docker Compose

在 `.env` 中设置独立的 `POSTGRES_PASSWORD`，然后启动应用和数据库：

```powershell
docker compose up --build -d
```

访问 **http://127.0.0.1:3210/**。Compose 使用 PostgreSQL 17 和命名数据卷 `infohub_pg`，默认只向本机开放端口。应用直接接收 PG 连接变量，因此密码中的特殊字符不需要 URL 编码。

生产环境建议由 GitHub Actions 构建镜像并推送到 GHCR，服务器只拉取镜像，不必在机上编译。步骤见 [Docker 部署与 GitHub 自动构建镜像](docs/deploy-docker.md)。

仅启动数据库用于本地开发：

```powershell
docker compose up -d postgres
```

此时将 `DATABASE_URL` 配置为 Compose 中的数据库信息。

## 桌面端

先保持 PG 和 Rust 服务运行，再执行：

```powershell
npm run tauri -- dev
```

打包桌面程序：

```powershell
npm run tauri -- build
```

桌面端默认连接 `http://127.0.0.1:3210/api`。在登录页点击「服务连接设置」，填写如 `https://infohub.example.com`，可测试连接、保存或恢复默认地址；末尾 `/api` 自动补齐。已登录时，顶部「更换服务器」会退出当前会话并打开设置，未保存的修改仍有离开保护。地址保存在本机，下次启动自动使用，**更换服务地址不需要重新打包**。`VITE_API_URL` 仍可作为打包时的默认地址。

PG 无需直接暴露给桌面客户端。服务端 `ALLOWED_ORIGINS` 保留 `http://tauri.localhost,https://tauri.localhost,tauri://localhost`；两份 Compose 的默认来源均已包含桌面端。桌面 CSP 支持用户配置的 HTTP/HTTPS 服务，不需要逐个修改域名。浏览器版使用当前站点或构建时配置的 API，不读取桌面地址偏好。切换服务会清除会话令牌及输入的主密码，连接测试不发送登录凭据。

浏览器版支持 VS Code 协议链接及路径复制；浏览器不能直接打开本地终端/文件夹，对应按钮会提示使用桌面版。桌面命令检查路径是否为真实存在的绝对目录，不把路径拼进 shell 命令。

应用内容直接铺满可用区域，不带原型展示用的外围留白、悬浮圆角画框或红黄绿按钮。网页顶部 36px 是业务工具栏。桌面程序使用系统原生标题栏（`decorations: true`、`transparent: false`），由系统处理拖拽、最小化、最大化和关闭；Windows 的窗口按钮在右上角。浏览器版也不渲染桌面窗口按钮。

## 配置与数据

| 配置项                                      | 用途                                                              |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`                              | PostgreSQL 连接串；优先于分项 PG 变量                             |
| `BIND_ADDR`                                 | 服务监听地址，默认 `127.0.0.1:3210`                               |
| `FRONTEND_DIR`                              | 前端构建目录，默认 `dist`                                         |
| `ALLOWED_ORIGINS`                           | 允许跨源访问 API 的前端源，以逗号分隔                             |
| `ALLOWED_PRIVATE_HOSTS`                     | 允许采集/调试的内网主机，精确匹配主机名或 IP，以逗号分隔          |
| `GITHUB_TOKEN`                              | 可选，提高 GitHub 请求配额，或读取已授权的私有仓库                |
| `VITE_API_URL`                              | 可选，前端构建时指定 API 地址，需包含 `/api`                      |
| `FILE_STORAGE`                              | 文件后端，`local`（默认）或 `r2`                                  |
| `LOCAL_STORAGE_PATH`                        | 磁盘目录，直接运行默认 `.local/files`；Compose 固定 `/data/files` |
| `R2_ENDPOINT` / `R2_BUCKET`                 | R2 S3 账户端点与私有 Bucket                                       |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 仅服务端使用的 R2 对象读写凭据                                    |

内网 API 示例：

```dotenv
ALLOWED_PRIVATE_HOSTS=api.internal.example,10.0.1.24,127.0.0.1
```

仅列出需要访问的主机。服务端检查 DNS 解析及重定向目标，并固定解析结果连接；接口调试不自动跟随重定向。默认拒绝内网/环回/保留网段。HTTP 请求必须先登录且解锁金库。

凭证的连接属性、密码、Headers、接口参数和正文整体加密；标题、协议、项目名、标签和收藏状态作为检索元数据保存。锁定后服务端禁止读取/修改凭证和凭证附件、禁止 HTTP 调试；仍能管理文章和开源项目。客户端关闭、刷新或服务重启后需重新登录；会话最长 8 小时，15 分钟无活动时锁定金库。不要在标题或标签中填写密码。

PG 中的 `vault_config` 保存随机盐和加密校验值，不保存主密码或固定密钥。主密码丢失后无法解密凭证。备份需要同时覆盖完整 PG 数据库（包括 `vault_config`、`items`、`media`、`attachments`、`file_objects`）及磁盘文件目录或 R2 对象。本地开发数据目录和 `.env` 已加入忽略规则。对外部署请配置 HTTPS 反向代理。

旧版 PG 附件和图片会在新版启动时自动复制到配置的文件存储，读取校验后移除文件二进制字段。升级前停止旧应用并备份数据库。Docker 默认将持久文件卷挂载到 `/data/files`，容器更新后保留文件；迁移、R2 配置和恢复步骤见 [附件与文章图片存储](docs/file-storage.md)。

## 采集与协议边界

- 文章采集针对可直接访问的 HTML 页面。登录墙、验证码、动态渲染正文、非 UTF-8 页面可能无法直接采集；会显示具体失败原因，可以改用 Markdown 手工收录。
- 单次文章最多下载 30 张 PNG/JPEG/GIF/WebP 图片；失败图片会标记并返回提示，不会声称已离线保存。外部 SVG 不作为活动内容执行。
- GitHub README 的外部图片显示为来源提示；文章图片由服务端从磁盘/R2 鉴权读取。README 相对链接解析到仓库目录。
- OpenAPI 支持本地 `$ref`、路径与操作参数合并、JSON 请求示例及 Swagger UI 配置发现；外部 `$ref` 请先打包到一个规范文件。工作区以原始文本编辑请求正文，不自动构造 multipart 文件请求。
- 单个上游响应限制为 8 MB；附件单文件限制 10 MB；HTTP 超时 30 秒。cURL 与连接命令面向 Bash/WSL；SQL、Redis 连接命令通过客户端交互输入密码。
- 重新同步会更新远程正文/版本/接口定义，同时保留工作区路径、实践笔记、全局 Header 和已有接口的参数值；本地编辑过的文章正文会被远程版本覆盖，界面会对未保存修改进行提醒。

## 检查与验收

本次实际检查结果及浏览器验收范围见 [验收记录](docs/verification.md)。

```powershell
npm run build
npm run lint
npm run test:request
npm run test:ui
npm run test:connection
npm run test:server
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path server/Cargo.toml --all-targets -- -D warnings
cargo check --manifest-path src-tauri/Cargo.toml
```

真实 PostgreSQL 集成验收（需已启动 PG，并先构建服务可执行文件）：

```powershell
cargo build --manifest-path server/Cargo.toml
npm run test:integration
```

脚本创建随机命名的独立测试数据库、隔离文件目录及本地 HTTP 测试站点，执行 22 组检查，包括认证、205 条记录分页、中文搜索、并发冲突、数据库密文、各项锁定权限、10 MB 附件边界、外部文件与加密字节、离线图片、文件缺失/损坏、垃圾文件清理、OpenAPI 同步新增参数、二进制响应和重启持久化。结束后只删除脚本自己创建的测试数据库和文件，不修改业务库。测试用户需有 CREATE DATABASE 权限。另有 22 项 React 组件回归检查，覆盖草稿保护、异步保存、接口切换、附件操作等；完整范围见 [逐项功能核查](docs/functional-audit.md)。

`node scripts/integration.mjs --r2` 使用本地 S3 协议服务验证 R2 SDK 签名、文件读写、失败清理重试；`node scripts/storage-migration.mjs` 和追加 `--r2` 的同一脚本验证旧 PG 文件迁移、校验失败保留原数据及重启恢复。测试不表示真实 Cloudflare 账号已配置，详见 [文件存储验证](docs/file-storage.md#验证方式)。

可选 `RUN_NETWORK_TESTS=1` 会追加真实 GitHub 采集验证；`node scripts/integration.mjs --keep` 保持隔离验收页面在 `http://127.0.0.1:3211`，测试凭据写入 `.local/verification.json`，Ctrl+C 或创建其中指定的 `stopFile` 文件会清理隔离数据并退出。

## 目录

- `src/`：React 界面、API 客户端、Markdown 与请求编译。
- `server/src/`：认证/会话、AES 加密、PG CRUD、网络访问、内容采集和 OpenAPI 解析。
- `server/migrations/`：数据库迁移，启动自动应用。
- `src-tauri/src/workspace.rs`：经过路径验证的本地工作区操作。
- `scripts/`：本地 PG 启动、真实 PG 集成验收、请求编译测试。
- `compose.yaml` / `Dockerfile`：PG + 服务端 + 前端部署配置。

实现参考：[Axum 官方文档](https://docs.rs/axum/0.8.9/axum/)、[SQLx 官方文档](https://docs.rs/sqlx/0.8.6/sqlx/)、[GitHub REST API](https://docs.github.com/en/rest/repos/contents)、[PostgreSQL pg_ctl](https://www.postgresql.org/docs/17/app-pg-ctl.html)。
