# 附件与文章图片存储

PG 保存资产正文、凭证密文和文件元数据；**附件、文章图片的文件内容保存在服务器磁盘或 Cloudflare R2**。默认使用服务器磁盘。两种模式都由 InfoHub API 鉴权后读写，桌面端继续连接原服务地址，不需要直连磁盘、R2 或 PG。

## 默认：服务器磁盘

直接运行 Rust 服务时，在项目根目录 `.env` 中设置：

```dotenv
FILE_STORAGE=local
LOCAL_STORAGE_PATH=.local/files
```

生产环境直接运行二进制时，建议设置固定绝对路径，例如 `LOCAL_STORAGE_PATH=/var/lib/infohub/files`，并让服务运行账号拥有该目录的读写权限。相对路径基于服务启动时的工作目录。

使用已有远程 PG 的 Docker 部署，在 `.env.external-pg` 中保留：

```dotenv
FILE_STORAGE=local
```

[compose.external-pg.yaml](../compose.external-pg.yaml) 将服务器上的 Docker 命名卷 `infohub_files` 挂载到容器的 `/data/files`。实际卷名带 Compose 项目前缀，例如 `infohub_infohub_files`；更新或重建容器会复用该卷。容器以 UID 10001 运行，镜像已创建具有写入权限的目录。Compose 固定使用 `/data/files`，不读取 `.env` 中的 `LOCAL_STORAGE_PATH`。

如需指定宿主机目录，将 Compose 的应用 `volumes` 改为 `/srv/infohub/files:/data/files`，提前创建宿主机目录并授予 UID 10001 读写权限；已有卷内文件需要先完整复制到该目录。容器内路径继续保留 `/data/files`。

文件按下面的路径存放，不使用用户上传的文件名拼接磁盘路径：

```text
/data/files/
  .infohub-storage-id
  attachments/<附件 UUID>
  media/<图片 UUID>
```

原文件名、MIME、所属条目、大小、加密标记存入 PG。文件内容不在客户端安装目录或 PG 中。文件目录位于 `FRONTEND_DIR` 内时服务会拒绝启动；也不要通过 Nginx 或其他静态服务公开这个目录。`.infohub-storage-id` 是固定存储标识，备份和复制目录时必须一并保留。

## 可选：Cloudflare R2

创建一个私有 R2 Bucket，并创建限定到该 Bucket 的对象读写凭据。使用 S3 API 的 **Access Key ID / Secret Access Key**，不是 Cloudflare 全局 API Key。端点为账户的 R2 S3 地址；客户端固定使用区域 `auto` 和 AWS SigV4 签名。[Cloudflare R2 Rust 接入说明](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-rust/)、[R2 S3 API 兼容说明](https://developers.cloudflare.com/r2/api/s3/api/)

在服务端 `.env` 或 Docker 的 `.env.external-pg` 填写：

```dotenv
FILE_STORAGE=r2
R2_ENDPOINT=https://你的账户ID.r2.cloudflarestorage.com
R2_BUCKET=infohub-files
R2_ACCESS_KEY_ID=你的AccessKeyID
R2_SECRET_ACCESS_KEY=你的SecretAccessKey
```

`R2_ENDPOINT` 不带 Bucket 路径、查询参数或公共下载域名；特殊管辖区使用 Cloudflare 实际提供的 S3 端点。Bucket 无需开启公开访问或配置浏览器 CORS，因为文件经过服务端传输。R2 密钥只配置在服务端，不能放进 `VITE_*` 或桌面安装包。生产端点要求 HTTPS；`R2_ALLOW_HTTP=true` 只用于直接启动二进制的本地协议测试，Compose 不传入此变量。

更新部署：

```bash
docker compose --env-file .env.external-pg -f compose.external-pg.yaml up -d --build
docker compose --env-file .env.external-pg -f compose.external-pg.yaml logs --tail=100 app
curl -fsS http://127.0.0.1:3210/api/health
```

使用 PG CA 附加配置时，命令继续保留 `-f compose.external-pg.ca.yaml`。每次启动都会写入、读回校验并删除一个很小的 `checks/<UUID>` 对象，确认实际读写和删除权限；新库也执行检查。检查失败时不会开始监听 HTTP。失败检查记录进入持久清理队列，不含用户文件内容；修正同一 Bucket 的权限后会重试清理。错误端点上的失败检查不会阻止修正端点配置，无法再访问的旧检查对象需由该存储的管理员清理。

## 从旧版 PG 文件字段升级

1. 停止旧版应用进程/容器，备份完整 PG 数据库；保持数据库服务运行。旧版应用不能与新版同时访问正在升级的库。
2. 在首次启动新版前选择目标存储，准备可写磁盘目录或 R2 凭据。可直接从旧版 PG 迁移到任意一种存储。
3. 启动新版。程序保留旧字段，逐个复制原文件，重新读取目标文件并校验大小和 SHA-256，然后更新引用、清空对应旧文件内容。
4. 每张文件表全部完成后，删除旧文件二进制字段并将存储引用设为必填，最后开始提供 HTTP 服务。

凭证附件复制的是原始 AES-256-GCM 密文，无需输入主密码；原 UUID 和加密上下文不变，原密码继续用于解密。PG 的 `items.secret`、`vault_config` 仍保存凭证和金库必要密文，它们不是文件内容。

迁移失败时服务不会开始监听；尚未成功校验的原文件内容仍保留在 PG，已经完成的文件保留在目标存储。修复权限、空间或网络后使用**同一存储配置**重启，程序继续迁移。迁移中断期间需要同时保留 PG 和目标文件。完成后的旧版本无法使用新表结构；回退旧版需恢复升级前的完整备份。删除字段后旧物理页的空间由 PostgreSQL 后续清理回收。

文件已存在后，程序会检查存储位置标识：本地标识来自目录里的 `.infohub-storage-id`，R2 标识由端点和 Bucket 生成。完整复制本地目录（含标识文件）后可以修改路径；同一路径挂到新的空磁盘、丢失标识文件或误改 Bucket 会阻止启动。上一版本使用绝对路径哈希的本地存储，会在逐个校验所有被引用文件后自动升级固定标识。更换 R2 密钥而不更换端点/Bucket 不影响文件引用。

当前提供的是 **PG 文件内容到磁盘/R2 的自动迁移**及本地目录整体搬迁；磁盘和 R2 之间切换、跨 Bucket 迁移还没有专用工具，不能只改 `FILE_STORAGE`。磁盘恢复到新主机时可调整绝对路径，但必须恢复完整目录（含隐藏的标识文件）及对应 PG。多个应用实例使用磁盘模式时必须共享同一物理文件存储，不能仅配置相同路径；当前会话仍在单进程内，不提供多实例高可用部署。

## 删除、失败处理与备份

- 上传完成后才创建可下载的附件记录；普通附件保留原始字节，凭证附件先加密再写入磁盘/R2。每个附件最多 10 MiB。
- 下载和图片读取校验大小及 SHA-256；缺失、损坏或存储不可用返回明确的服务错误。凭证附件在金库锁定时不可访问。
- 删除附件、删除资产、重抓图片时，在同一 PG 事务内记录文件清理任务，提交后通知专用后台任务删除实际文件，HTTP 返回不等待远程删除。后台允许存储请求完成自身的超时/重试过程，失败保留队列，每分钟及重启后重试。
- 上传取消、图片批量写入中断或数据库事务回滚留下的未引用文件有一小时保护期，之后由同一队列清理；进程被终止时遗留的本地原子写入临时文件也随对应对象清理。磁盘写入在提交文件引用前显式刷盘。不要在 Bucket 上配置会自动删除仍被使用对象的过期规则。
- 备份必须同时覆盖完整 PG（含 `file_objects`、金库和迁移记录）以及完整磁盘文件目录或 R2 对象。**只备份 PG 无法恢复附件和图片。** 为保持对应关系，停止应用写入后备份两部分；恢复时也成套恢复。
- Docker 更新使用 `up -d --build`；不要用 `down -v` 清理持久文件卷。R2 由独立 Bucket 持久保存。

## 验证方式

需要已运行 PG、`DATABASE_URL` 和可建测试库的账号：

```powershell
cargo build --manifest-path server/Cargo.toml
cargo test --manifest-path server/Cargo.toml
node scripts/integration.mjs
node scripts/integration.mjs --r2
node scripts/storage-migration.mjs
node scripts/storage-migration.mjs --r2
```

测试创建隔离数据库和临时文件目录，结束后仅清理自身数据。R2 模式使用校验 AWS SigV4 签名的本地 S3 测试服务，覆盖读写删除、失败重试和迁移校验，**不等同于已连接真实 Cloudflare 账号**。当前环境没有 Docker Engine，也未完成真实 R2 Bucket 或远程部署验收。
