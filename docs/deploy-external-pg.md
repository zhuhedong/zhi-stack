# 使用远程或云 PostgreSQL 部署 InfoHub

适用于你已经部署 PG、只需要部署 InfoHub 应用的场景。使用 [compose.external-pg.yaml](../compose.external-pg.yaml) 连接另一台服务器或云数据库；该文件只包含应用服务，通过 Docker 默认网络访问 PG，不创建第二个 PG 服务或数据库数据卷。

本机没有 Docker Engine，尚未执行容器构建、远程 PG 连接和 HTTPS 部署验收。配置检查不等同于远程部署成功。

## 1. 准备已有 PG 的连接信息

需要 PG 主机名、端口、数据库名、用户名、密码以及实例要求的 SSL 设置。优先使用从应用服务器可访问的数据库连接地址；云数据库内网地址要求应用服务器具备对应的内网连接。

PG 的白名单/访问规则应允许 **InfoHub 应用服务器实际连接 PG 时使用的来源 IP**。桌面客户端只连接 InfoHub HTTP API，由 InfoHub 服务访问数据库。

在现有 PG 实例中准备一个 InfoHub 专用数据库，例如 `infohub`。程序启动自动执行 SQLx 迁移，账号需要在目标数据库的 `public` schema 中创建和修改表的权限；使用该专用数据库的所有者账号即可。程序不会自动创建数据库。

如果尚未准备专用账号和数据库，可以让 PG 管理员在 `psql` 中执行以下首次创建操作；已准备的账号或库直接复用：

```text
CREATE ROLE infohub LOGIN;
\password infohub
CREATE DATABASE infohub OWNER infohub;
```

`\password` 交互式设置密码。这是在已有实例中创建业务数据库，不会部署另一个 PG 实例。[PostgreSQL 数据库创建说明](https://www.postgresql.org/docs/current/sql-createdatabase.html)

## 2. 填写应用部署配置

将项目源码上传到应用服务器，例如 `/opt/infohub`。首次部署时复制模板：

```bash
cd /opt/infohub
cp .env.external-pg.example .env.external-pg
chmod 600 .env.external-pg
```

已有 `.env.external-pg` 时直接编辑，不要用模板覆盖。示例：

```dotenv
PGHOST=your-postgres-host.example.com
PGPORT=5432
PGUSER=infohub
PGPASSWORD='替换为已有数据库账号的密码'
PGDATABASE=infohub
PGSSLMODE=verify-full
INFOHUB_BIND_IP=127.0.0.1
INFOHUB_PORT=3210
ALLOWED_ORIGINS=https://infohub.example.com,http://tauri.localhost,https://tauri.localhost,tauri://localhost
GITHUB_TOKEN=
ALLOWED_PRIVATE_HOSTS=
RUST_LOG=infohub_server=info
FILE_STORAGE=local
```

将 PG 地址、端口、用户名、密码、数据库名和应用域名替换为实际值。`PGHOST` 只填数据库主机名或 IP，不带 `https://`、端口或 `/api`；端口通过 `PGPORT` 单独填写。远程 PG 地址不应填 `127.0.0.1`，因为本配置中它表示应用容器自身。

连接使用分项 PG 变量，不需要对密码做 URL 编码；含 `$`、`#` 的值可按 Compose `.env` 规则用单引号保留字面值。[Compose 环境变量说明](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)

此独立部署文件向容器传入上述变量，不使用默认 `compose.yaml` 的 `POSTGRES_PASSWORD`，也不传入宿主机的 `DATABASE_URL`。`ALLOWED_PRIVATE_HOSTS` 只控制文章采集和 API 调试的 HTTP 目标，不控制 PG 连接。

附件和文章图片默认保存在应用服务器的持久文件卷中，容器内目录为 `/data/files`；PG 只存文件信息和位置。也可使用 Cloudflare R2，配置、旧文件自动迁移和备份步骤见 [文件存储说明](file-storage.md)。首次升级前停止旧版应用并备份 PG，然后选择存储位置。

## 3. 按 PG 要求配置 SSL

模板默认 `PGSSLMODE=verify-full`，要求 TLS，并校验证书及数据库主机名。数据库供应商提供专用 CA 证书时，使用下面的附加配置挂载该证书。[PostgreSQL SSL 模式说明](https://www.postgresql.org/docs/current/libpq-ssl.html)

| 模式          | 行为与适用条件                                                                  |
| ------------- | ------------------------------------------------------------------------------- |
| `verify-full` | TLS、证书链及主机名校验；按供应商要求准备可信 CA                                |
| `require`     | 必须使用 TLS，SQLx 此模式不验证证书身份；仅在供应商连接要求和网络条件适合时选用 |
| `prefer`      | 优先 TLS，服务端不支持时可能回退明文；仅用于明确允许此行为的网络                |
| `disable`     | 不使用 TLS；用于明确配置为非 TLS 的可信内网 PG                                  |

SQLx 当前版本从环境读取 `PGSSLMODE` 和 `PGSSLROOTCERT`，本次增加的是 Compose 变量传递和证书挂载。拼写按上表填写。

如果供应商要求自有 CA：把其 PEM 根证书保存到应用服务器，例如项目下的 `pg-ca.pem`，确保应用容器可读，并在 `.env.external-pg` 加入：

```dotenv
PG_CA_FILE=./pg-ca.pem
```

这应是供应商提供的 CA 公共证书；使用 [compose.external-pg.ca.yaml](../compose.external-pg.ca.yaml) 后，文件只读挂载到容器，`PGSSLROOTCERT` 指向该文件。不存在的证书路径会报错，不会自动创建目录。该附加文件不包含客户端私钥或双向 TLS 客户端证书配置。

## 4. 检查并启动

**普通连接：** 单独指定 `compose.external-pg.yaml`，不要同时合并默认的 `compose.yaml`。

```bash
docker compose --env-file .env.external-pg -f compose.external-pg.yaml config --quiet
docker compose --env-file .env.external-pg -f compose.external-pg.yaml up -d --build
docker compose --env-file .env.external-pg -f compose.external-pg.yaml ps
```

已用 GitHub Actions 发布镜像时，在 `.env.external-pg` 设置 `INFOHUB_IMAGE=ghcr.io/<账号>/zhi-stack:latest`，把上面的 `up -d --build` 换成 `pull` 再 `up -d`，步骤见 [Docker 部署与 GitHub 自动构建镜像](deploy-docker.md)。

**需要挂载 CA 时：** 使用下面这一组命令，后续更新也保留同样的两个 `-f` 参数。

```bash
docker compose --env-file .env.external-pg -f compose.external-pg.yaml -f compose.external-pg.ca.yaml config --quiet
docker compose --env-file .env.external-pg -f compose.external-pg.yaml -f compose.external-pg.ca.yaml up -d --build
```

应用完成 PG 连接、数据库迁移及旧文件导出校验后才开始监听 HTTP；旧文件较多时首次启动需要更久。默认宿主机端口为 `3210`，健康检查：

```bash
curl -fsS http://127.0.0.1:3210/api/health
```

新建的空数据库应返回 `initialized: false`、`database: "PostgreSQL"` 和服务版本；已有 InfoHub 数据库保留原初始化状态及资产。首次进入工作台设置的主密码与 PG 账号密码是两个不同的密码。

查看日志：

```bash
docker compose --env-file .env.external-pg -f compose.external-pg.yaml logs --tail=100 app
```

使用 CA 附加文件部署时，查看日志也使用相同的两个 `-f` 参数。

| 现象                     | 核对内容                                                             |
| ------------------------ | -------------------------------------------------------------------- |
| 连接超时或被拒绝         | PG 地址/端口、应用服务器到 PG 的网络、云数据库白名单或服务端访问规则 |
| 密码认证失败             | `PGUSER`、`PGPASSWORD` 与数据库账号状态                              |
| 证书不可信或主机名不匹配 | 供应商 CA、证书有效期、`PGHOST` 是否使用证书对应的地址；修正连接配置 |
| CA 文件读取失败          | 宿主机文件路径、文件可读权限、是否使用 CA 附加文件启动               |
| 数据库不存在             | `PGDATABASE` 对应的库是否已经创建                                    |
| 无权创建表/schema        | 数据库所有者或 schema 的迁移权限                                     |
| 应用持续重启             | 先查看日志；PG 连接或迁移失败时服务不会进入就绪状态                  |

## 5. 配置 HTTP 与桌面访问

容器内固定监听 `0.0.0.0:3210`；宿主机默认发布到 `127.0.0.1:3210`，用于同一宿主机上的 Caddy/Nginx 转发。`INFOHUB_BIND_IP` 和 `INFOHUB_PORT` 控制宿主机的 HTTP 入口，与 PG 连接地址无关。

使用域名时，反向代理到 `http://127.0.0.1:3210`，例如对外地址 `https://infohub.example.com`。在 `ALLOWED_ORIGINS` 中保留桌面来源，并加入你的 Web 来源。

只在内网直接连接应用时，可将 `INFOHUB_BIND_IP` 改成应用服务器具体内网 IP 或 `0.0.0.0`，再用相同 Compose 命令应用配置。修改 `INFOHUB_PORT` 后，健康检查和反向代理需使用对应端口。

桌面端在登录页「服务连接设置」填写 `https://infohub.example.com`，测试后保存；地址保存在本机，不需要因更换服务器重新构建，也不需要逐个修改桌面 CSP。已登录时可点击顶部「更换服务器」。`VITE_API_URL` 仅作为打包时的默认地址。详见 [README 桌面端配置](../README.md#桌面端)。

## 6. 更新与数据备份

在同一目录更新源码后，用相同环境文件和 Compose 文件重新执行 `up -d --build`；使用 CA 时保留附加文件参数。

业务记录保存在现有远程 PG 中；附件和图片保存在应用服务器的 `infohub_files` 文件卷或所配置的 R2 Bucket。备份需要覆盖完整 InfoHub 数据库（包括 `vault_config`、`items`、`media`、`attachments`、`file_objects` 和迁移记录）及对应文件存储。只备份 PG 无法恢复文件。停止应用写入后备份两部分并成套恢复，保留文件卷；不要使用 `down -v` 删除数据卷。详见 [文件存储与恢复](file-storage.md)。
