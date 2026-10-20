# 部署（Docker / 1Panel / 已有 PostgreSQL）

本文合并了原 `deploy-docker.md` 与 `deploy-external-pg.md`。所有部署都只用一个 [compose.yaml](../compose.yaml) 和一个 `.env`（由 [.env.example](../.env.example) 复制）。

InfoHub 服务端镜像包含 Rust API 和已构建的前端页面，监听 `0.0.0.0:3210`。PostgreSQL、附件磁盘/R2、主密码都不打进镜像。推送到 GitHub 后，Actions 会构建镜像并发布到 GitHub Container Registry（GHCR）；服务器只拉取镜像，不必安装 Node 或 Rust 工具链。

本仓库尚未在真实云主机上跑过完整 Docker 验收。按下面步骤部署后，以 `GET /api/health` 和首次设置主密码作为就绪标准。

镜像由 [Dockerfile](../Dockerfile) 构建：前端 `npm ci && npm run build`，服务端 `cargo build --release --locked`，运行用户 UID `10001`。工作流见 [.github/workflows/docker-image.yml](../.github/workflows/docker-image.yml)。

## 1. 在 GitHub 上自动生成镜像

1. 把本仓库推到 GitHub（公开或私有均可）。
2. 打开仓库 **Settings → Actions → General → Workflow permissions**，选择 **Read and write permissions**，保存。这是 `GITHUB_TOKEN` 写入 GHCR 所必需的。
3. 默认分支推送到 `main` 或 `master`、打 `v*` 标签，或在 Actions 里手动运行 **Docker image**。
4. 构建成功后，镜像地址为：

```text
ghcr.io/<github用户或组织>/<仓库名>
```

仓库名会转成小写。例如 GitHub 仓库 `YourName/zhi-stack` 对应 `ghcr.io/yourname/zhi-stack`。

| 触发 | 标签 |
| ---- | ---- |
| 默认分支 | `latest`、`sha-<短SHA>`、分支名 |
| 标签 `v1.2.3` | `1.2.3`、`1.2`、`sha-<短SHA>` |
| 手动运行 | 当前分支对应的标签 |

当前工作流只构建 **linux/amd64**。需要 ARM 服务器时，在工作流的 `platforms` 中自行增加 `linux/arm64`（构建时间会明显变长）。

### 第一次发布后把包设为可用

GHCR 包默认是私有的。打开 GitHub 用户或组织的 **Packages**，进入刚生成的包：

- 私有部署：保持 Private，服务器用下面的登录令牌拉取。
- 公开拉取：Package settings → Change visibility → Public。

私有包需要服务器登录。在 GitHub **Settings → Developer settings → Personal access tokens** 创建 classic token，勾选 `read:packages`（组织仓库可能还需要 SSO 授权）。不要把这个令牌写进镜像或前端。

```bash
echo YOUR_GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

登录信息保存在该机器的 Docker 凭据里，以后 `docker compose pull` 可直接使用。

## 2. 一个 compose.yaml，三种部署

在 `.env` 里用 `COMPOSE_PROFILES` 选择**一种**：

| `COMPOSE_PROFILES` | 启动的服务 | 数据库配置 |
| ------------------ | ---------- | ---------- |
| `bundled`（默认） | `postgres` + `app` | 只填 `POSTGRES_PASSWORD`，`DATABASE_URL` 自动生成 |
| `external` | `app-external` | 填 `DATABASE_URL` 指向已有 PG |
| `1panel` | `app-1panel`（加入 `1panel-network`） | 填 `DATABASE_URL`，主机名用 1Panel 的 PG 容器名 |

```bash
cp .env.example .env && chmod 600 .env
# 编辑 .env：至少改 COMPOSE_PROFILES，以及 POSTGRES_PASSWORD 或 DATABASE_URL
docker compose up -d --build        # 已设置 INFOHUB_IMAGE 时改用：docker compose pull && docker compose up -d
docker compose logs --tail=100 app  # external / 1panel 时服务名为 app-external / app-1panel
curl -fsS http://127.0.0.1:${INFOHUB_PORT:-3210}/api/health
```

- 密码仍为 `.env.example` 中的占位值时，服务拒绝启动并在日志里说明原因。
- `bundled` 模式下 `POSTGRES_PASSWORD` 会原样拼进 `DATABASE_URL`，请只用字母和数字（推荐 `openssl rand -hex 24`）；含 `@`、`#`、`:` 等特殊字符会导致连不上数据库。
- 自带 PG 不再映射宿主机 5432 端口。需要本机调试时，自己建 `compose.override.yaml` 加 `ports: ['127.0.0.1:5432:5432']`。
- 宿主机端口由 `INFOHUB_BIND_IP` / `INFOHUB_PORT` 决定；容器内固定 `0.0.0.0:3210`、`/app/dist`、`/data/files`，不要改。
- 启动日志会打印一份不含密钥的“生效配置”，排查配置问题先看这里。

### 首次初始化令牌

未初始化的实例在启动日志中打印一次性 `setup_token`（或使用 `.env` 里的 `SETUP_TOKEN`）。浏览器/桌面首次设置主密码、或向空实例恢复备份时都要填写它，防止别人抢先初始化。初始化完成后令牌失效。

```bash
docker compose logs app | grep setup_token
```

### 已有 PostgreSQL（external）

```dotenv
COMPOSE_PROFILES=external
DATABASE_URL=postgres://infohub:URL编码后的密码@db.example.com:5432/infohub?sslmode=verify-full
```

数据库需提前建好，用户要有建表权限（启动时自动迁移）。`sslmode` 可选 `disable`、`require`、`verify-ca`、`verify-full`。迁移会尝试启用 `pg_trgm` 扩展给搜索加索引；托管数据库不允许时会跳过，功能不受影响。

**供应商自有 CA**：把 PEM 证书放到项目下 `certs/pg-ca.pem`（或用 `PG_CA_DIR` 指定目录，挂载到 `/run/infohub/certs`），然后：

```dotenv
DATABASE_URL=postgres://infohub:密码@db.example.com:5432/infohub?sslmode=verify-full&sslrootcert=/run/infohub/certs/pg-ca.pem
```

### 反向代理与跨域

### 网页界面模式（WEB_UI）

| 值 | 行为 |
| --- | --- |
| `full`（默认） | 与以前一致：同一进程提供 `FRONTEND_DIR` 里的完整网页版 |
| `landing` | 只在 `/` 和 `/index.html` 提供内置于程序的静态介绍页（产品简介、桌面客户端下载、版本号）；其他非 `/api` 路径（网页路由、`/assets/*` 等）一律 404 |
| `off` | 不提供任何网页内容，非 `/api` 路径一律 404 |

- `LANDING_DOWNLOAD_URL`：可选，覆盖介绍页"下载桌面客户端"按钮地址（必须是 http/https）；不设置时按钮指向内置的 `/download` 下载页（推荐）。
- `DOWNLOAD_BASE_URL`：可选，`/download` 页安装包的地址前缀，默认 `https://github.com/zhuhedong/zhi-stack/releases/latest/download`；国内可换成镜像/OSS 地址，目录下需放同名文件（`InfoHub_macos_aarch64.dmg` 等）。
- `/download` 页根据浏览器的 User-Agent / `Sec-CH-UA-Platform` 判断系统并给出对应安装包，支持 `?os=mac|win|linux` 手动指定；无 JavaScript。
- `landing`/`off` 下 `ALLOWED_ORIGINS` 默认不再包含本机端口、Vite 和 `PUBLIC_URL`，只保留 Tauri 桌面端来源（`tauri://localhost` 等）：现有桌面端在 WebView 里用 fetch 调 API，依赖 CORS。显式设置的值仍然生效。
- `/api/*` 在所有模式下不变。`/api/health` 仍返回 `initialized`，桌面客户端要靠它决定显示"创建主密码"还是"登录"。
- 注意：`landing`/`off` 下没有网页版，**首次初始化（创建主密码、使用初始化令牌）和从备份恢复都只能通过桌面客户端完成**。
- Docker / compose 无需改动，镜像里的 `dist` 在这两种模式下只是不再被读取。只要在 `.env` 里加上 `WEB_UI=landing` 后重启即可。
- 1Panel：在应用或容器的“环境变量”里添加 `WEB_UI=landing`（可再加 `LANDING_DOWNLOAD_URL=https://...`）并重建容器；网站反代配置不变，访问域名会看到介绍页，桌面客户端填写同一地址即可连接。

对外请用 Caddy / Nginx / 1Panel 网站终止 TLS，反代到 `http://127.0.0.1:3210`。把站点地址写进 `PUBLIC_URL=https://infohub.example.com`，它会自动加入允许的来源；默认来源已包含本机端口、Vite 开发端口和 Tauri 桌面端。只有需要完全自定义时才设置 `ALLOWED_ORIGINS`。

反代后登录限流按客户端 IP 计算。把反代的 IP 写进 `TRUSTED_PROXIES`（例如 `127.0.0.1`），服务才会采用 `X-Forwarded-For` 中的真实地址；不填则按连接地址计算。

## 3. 用 1Panel 部署

1Panel 的环境变量写在**编排的 `.env`**，不是写在容器内部。

1. **容器 → 编排 → 创建编排**，编排文件粘贴仓库里的 [compose.yaml](../compose.yaml)。
2. 同一页 **环境变量** 按 `KEY=VALUE` 每行填写（见下例）。
3. 在 1Panel 应用商店装 PostgreSQL，创建库和用户（例如 `infohub`），在 **容器** 列表复制该 PG 的**容器名**作为 `DATABASE_URL` 的主机名。不要用 `127.0.0.1`（那是容器自己）。同机 Docker 网络用 `sslmode=disable`。
4. 主密码不是环境变量。容器起来后在 1Panel 容器日志里找到 `setup_token`，打开站点首次设置时填写。

```dotenv
COMPOSE_PROFILES=1panel
INFOHUB_IMAGE=ghcr.io/zhuhedong/zhi-stack:latest
DATABASE_URL=postgres://infohub:数据库用户密码@postgresql:5432/infohub?sslmode=disable
INFOHUB_BIND_IP=127.0.0.1
INFOHUB_PORT=3210
PUBLIC_URL=https://infohub.example.com
TRUSTED_PROXIES=127.0.0.1
FILE_STORAGE=r2
R2_ENDPOINT=https://你的账户ID.r2.cloudflarestorage.com
R2_BUCKET=infohub-files
R2_ACCESS_KEY_ID=你的AccessKeyID
R2_SECRET_ACCESS_KEY=你的SecretAccessKey
```

私有 GHCR 镜像先在 **容器 → 配置 → 仓库** 添加 `ghcr.io`（用户名为 GitHub 用户名，密码为有 `read:packages` 的 Token）。

四个 `R2_*` 都要填实，否则容器不会监听 HTTP。`R2_ENDPOINT` 只填账户 S3 地址，不要带 Bucket 名、路径或 `*.r2.dev`。已经用 `local` 存过附件后再改 `r2` 不会自动搬文件，见 [文件存储说明](file-storage.md)。

网站反代：1Panel **网站 → 创建 → 反向代理**，目标 `http://127.0.0.1:3210`。

## 4. 从旧版部署迁移（0.2.2 及以前）

| 旧做法 | 新做法 |
| ------ | ------ |
| `compose.external-pg.yaml` + `.env.external-pg` | `compose.yaml` + `.env`，`COMPOSE_PROFILES=external` |
| `compose.external-pg.ca.yaml` + `PG_CA_FILE` | 证书放进 `certs/`，在 `DATABASE_URL` 加 `sslrootcert=` |
| `compose.1panel.yaml` | `compose.yaml`，`COMPOSE_PROFILES=1panel` |
| `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE` | `DATABASE_URL`。旧变量仍能用（启动日志提示已弃用） |
| 自带 PG 映射 `127.0.0.1:5432` | 默认不映射，需要时用 override |
| 手写 `ALLOWED_ORIGINS` | 可删除，改用 `PUBLIC_URL`；保留也继续生效 |

注意：

- 新的 compose 服务名是 `app-external` / `app-1panel`。从旧文件切换时先用旧文件 `down`（**不要加 `-v`**），再用新文件 `up -d`。数据卷名 `infohub_files` 不变，但 Compose 项目名取自目录名，目录不变即可沿用原卷。
- 旧的 `compose.yaml` 用 `POSTGRES_PASSWORD` 启动的部署：保持 `COMPOSE_PROFILES=bundled` 和原密码即可，数据卷 `infohub_pg` 沿用。

## 5. 常见问题

| 现象 | 处理 |
| ---- | ---- |
| 日志提示“数据库密码仍是示例占位值” | 在 `.env` 中换成真实随机密码（自带 PG 首次启动前就要换） |
| `network 1panel-network not found` | 只在 1Panel 机器上用 `1panel` profile；其他环境用 `external` |
| `docker pull` 403 | 私有包未登录，或 token 缺少 `read:packages` |
| `up --build` 很慢 | 已设置 `INFOHUB_IMAGE` 时不要加 `--build`，先 `pull` 再 `up -d` |
| 健康检查连接失败 | 看 app 日志里的“生效配置”和错误；常见原因是 PG 未就绪、密码错误、文件存储无法写入 |
| 浏览器跨域失败 | 设置 `PUBLIC_URL` 为实际页面地址（含协议和端口） |
| 首次设置提示初始化令牌不正确 | 在 app 日志里找 `setup_token`；重启后若仍未初始化会重新生成 |
| 登录提示“尝试过于频繁” | 同一 IP 连续输错 5 次后按指数退避（最长 15 分钟）；反代后请设置 `TRUSTED_PROXIES` |

相关文件：[Dockerfile](../Dockerfile)、[compose.yaml](../compose.yaml)、[.env.example](../.env.example)、[运维手册](operations.md)。

## 桌面客户端

安装包由 GitHub Actions 自动打包，发布流程和签名配置见 [desktop-release.md](desktop-release.md)。介绍页模式下无需设置 `LANDING_DOWNLOAD_URL`，按钮默认进入 `/download` 下载页。

### 下载页的实时版本与 CSP

`WEB_UI=landing` 时 `/download` 会加载同源脚本 `/download.js`，在访客浏览器里请求 `https://api.github.com/repos/zhuhedong/zhi-stack/releases/latest`（4 秒超时），把页面上的版本号、发布日期和更新日志链接换成最新正式版；请求失败、超时或被限流时保持服务端渲染的版本号。下载链接仍是 `releases/latest/download/...`。

为此 `/download` 单独下发的 CSP 只比全站 `WEB_CSP` 多一项 `connect-src https://api.github.com`；`script-src` 仍是 `'self'`，不允许内联脚本。首页介绍页依旧没有脚本、CSP 不变。CSP 由应用设置；如果反向代理（Caddy / Nginx）自己覆盖了 `Content-Security-Policy`，需要给 `/download` 放行同样的 `connect-src`。
