# Docker 部署与 GitHub 自动构建镜像

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

## 2. 本机构建（可选）

不经过 GHCR、在本机直接编镜像：

```bash
docker build -t infohub:local .
```

或让 Compose 构建：

```bash
# 先在 .env 中设置 POSTGRES_PASSWORD
docker compose up --build -d
curl -fsS http://127.0.0.1:3210/api/health
```

构建上下文已由 [.dockerignore](../.dockerignore) 排除 `node_modules`、`server/target`、`src-tauri` 等，避免把本机产物打进镜像。

## 3. 用 GHCR 镜像部署（应用 + PostgreSQL）

适合一台新服务器，由 Compose 同时启动 PostgreSQL 17 和应用。把仓库克隆到服务器（只需要 Compose 文件和环境变量，不需要在服务器上编译）。

```bash
git clone https://github.com/<你的账号>/zhi-stack.git /opt/infohub
cd /opt/infohub
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，至少设置数据库密码和镜像名：

```dotenv
POSTGRES_PASSWORD='替换为独立的数据库密码'
INFOHUB_IMAGE=ghcr.io/<你的账号小写>/zhi-stack:latest
ALLOWED_ORIGINS=https://infohub.example.com,http://tauri.localhost,https://tauri.localhost,tauri://localhost
GITHUB_TOKEN=
ALLOWED_PRIVATE_HOSTS=
FILE_STORAGE=local
```

`POSTGRES_PASSWORD` 是 PostgreSQL 账号密码，不是 InfoHub 主密码。主密码在浏览器第一次打开工作台时设置。

```bash
docker compose pull
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3210/api/health
```

不要加 `--build`，否则服务器会忽略已拉取的 GHCR 镜像、重新本地编译。默认只把 `127.0.0.1:3210` 和 `127.0.0.1:5432` 映射到宿主机，给本机反向代理用；不要把 PostgreSQL 端口暴露到公网。

数据卷：

| 卷 | 容器路径 | 内容 |
| -- | -------- | ---- |
| `infohub_pg` | PostgreSQL 数据目录 | 库表、金库配置、资产正文、文件元数据 |
| `infohub_files` | `/data/files` | 附件和文章图片 |

备份需要同时覆盖这两个卷（或对应的 R2 Bucket）。见 [附件与文章图片存储](file-storage.md)。

## 4. 用 GHCR 镜像对接已有 PostgreSQL

已有远程或云数据库时，不要使用默认 `compose.yaml`。复制模板并填写连接：

```bash
cp .env.external-pg.example .env.external-pg
chmod 600 .env.external-pg
```

在 `.env.external-pg` 中增加：

```dotenv
INFOHUB_IMAGE=ghcr.io/<你的账号小写>/zhi-stack:latest
```

数据库需预先存在，账号具备迁移权限。然后：

```bash
docker compose --env-file .env.external-pg -f compose.external-pg.yaml pull
docker compose --env-file .env.external-pg -f compose.external-pg.yaml up -d
curl -fsS http://127.0.0.1:3210/api/health
```

SSL、CA 证书挂载、桌面跨域见 [使用已有 PostgreSQL 部署](deploy-external-pg.md)。该文件只启动应用，不创建第二个 PG。

## 5. HTTPS 反向代理

容器内固定 `BIND_ADDR=0.0.0.0:3210`。对外请用 Caddy 或 Nginx 终止 TLS，反代到 `http://127.0.0.1:3210`。把站点来源写入 `ALLOWED_ORIGINS`（逗号分隔，不要末尾斜杠），并保留桌面来源 `http://tauri.localhost,https://tauri.localhost,tauri://localhost`。

Caddy 示例：

```caddy
infohub.example.com {
    reverse_proxy 127.0.0.1:3210
}
```

浏览器打开 `https://infohub.example.com`。桌面客户端在登录页「服务连接设置」填写同一地址即可，不必重新打包。

采集或调试内网 API 时，把精确主机名或 IP 写入 `ALLOWED_PRIVATE_HOSTS`，不要使用通配符。

## 6. 升级镜像

```bash
cd /opt/infohub
docker compose pull
docker compose up -d
```

使用外部 PG 时带上同样的 `--env-file` 和 `-f`。命名卷会保留。升级前建议停止应用并备份 PG 与文件卷。旧版把附件存在 PG 字节字段时，新镜像启动会自动迁到磁盘或 R2，见 [文件存储说明](file-storage.md)。

查看应用日志：

```bash
docker compose logs --tail=100 -f app
```

健康接口应返回 JSON：`initialized`（是否已设主密码）、`database` 为 `PostgreSQL`、以及服务版本。

## 7. 常见问题

| 现象 | 处理 |
| ---- | ---- |
| Actions 能构建但 Packages 里没有包 | 确认 Workflow permissions 为读写；查看 job 是否 `push: true` |
| `docker pull` 403 | 私有包未登录，或 token 缺少 `read:packages` |
| `denied: requested access to the resource is denied` | 镜像名大小写或仓库名与 Packages 不一致 |
| `up --build` 很慢 / 在服务器上编译 | 已设置 `INFOHUB_IMAGE` 时不要加 `--build`，先 `pull` 再 `up -d` |
| 健康检查连接失败 | 看 `app` 日志；常见原因是 PG 未就绪、密码错误、文件存储无法写入 |
| 浏览器跨域失败 | `ALLOWED_ORIGINS` 必须包含实际页面来源，含协议和端口 |
| 桌面连不上 | 服务 CORS 保留 `tauri.localhost`；客户端填写的是 HTTPS 站点而不是 PG 地址 |

相关文件：[Dockerfile](../Dockerfile)、[compose.yaml](../compose.yaml)、[compose.external-pg.yaml](../compose.external-pg.yaml)、[运行说明](../README.md)。
