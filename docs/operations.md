# InfoHub 0.2 运维手册

0.2 增加版本历史、回收站、加密整库备份、持久收录任务、仓库订阅、项目与 API 工作区。服务启动时执行迁移；更新前先保留数据库、文件和旧程序。一个工作台只运行一个服务进程，多个客户端连接同一服务；后台任务恢复按这一部署方式实现。

## 第一次安装

Windows 发布包包含桌面安装程序、独立桌面程序和 `server/` 服务目录。桌面程序不内置 PostgreSQL。

1. 先准备 PostgreSQL，创建独立数据库和具备迁移权限的账号。
2. 将 `server/.env.example` 复制为 `server/.env`，填写 `DATABASE_URL` 或 PG 连接变量；配置文件仅保存在自己的机器上。
3. 本地文件模式配置 `FILE_STORAGE=local` 和绝对路径 `LOCAL_STORAGE_PATH`。这个目录必须和数据库一起保留。R2 配置参见源码中的 `docs/file-storage.md`。
4. 在 PowerShell 执行 `server/start-server.ps1`。需要长期运行时，由服务管理器维护此进程及其工作目录。
5. 浏览器打开 `http://127.0.0.1:3210`。健康检查通过后创建主密码；已有 `.infohub` 备份也可在首次设置页恢复。
6. 运行桌面安装程序，在“服务连接设置”中测试服务地址。远程连接使用部署者提供的 HTTPS 地址。

Docker 从项目源码按 `docs/deploy-docker.md` 部署。应用镜像发布工作流现在依赖产品验收工作流通过；本轮未把代码推送到远端、未发布镜像。镜像路径和域名应使用自己实际部署的值。

## 备份与恢复

日常在“数据与安全”导出 `.infohub` 文件。它包含主密码配置、所有资产及回收站、历史版本、图片与附件、草稿、项目关联、阅读状态、保存筛选、请求历史、收录任务、订阅检查、使用设置及反馈。文件使用备份时的主密码加密。下载成功后仍应在干净实例做一次恢复演练；生成记录不能证明浏览器已经保存文件。

恢复至已有工作台需要当前工作台密码、备份密码，以及输入“恢复并替换”。先完整验证文件，再在事务内替换数据；旧会话失效，使用备份时的主密码重新登录。文件会写入目标实例的新存储键，因此可以从磁盘迁到 R2，或从 R2 恢复到磁盘。

备份不含机器上的 `.env`、数据库账号、R2 密钥、反向代理配置；这些由部署者单独保管。更换主密码后，旧备份继续使用旧密码。

### 命令行维护

脚本需要 Node.js 22.23 或 24。发布包中的 `scripts/maintenance.mjs` 没有 npm 依赖；脚本不会打印主密码和会话令牌。密码从进程环境读取，不要作为命令行参数传入。

```powershell
$env:INFOHUB_URL = 'http://127.0.0.1:3210'
$secret = Read-Host '当前工作台主密码' -AsSecureString
$env:INFOHUB_PASSWORD = [Net.NetworkCredential]::new('', $secret).Password
node scripts/maintenance.mjs status
node scripts/maintenance.mjs backup --file 'D:\Backups\infohub-before-update.infohub'
Remove-Item Env:INFOHUB_PASSWORD
```

备份输出字节数和 SHA-256，拒绝覆盖已有文件。下载中断时移除本次临时文件。默认恢复上传上限 2 GiB，可用服务端 `MAX_BACKUP_BYTES` 调整；单条记录上限 16 MiB。

恢复到已启动的空实例：

```powershell
$env:INFOHUB_URL = 'http://127.0.0.1:3211'
$secret = Read-Host '备份时的主密码' -AsSecureString
$env:INFOHUB_BACKUP_PASSWORD = [Net.NetworkCredential]::new('', $secret).Password
node scripts/maintenance.mjs restore --file 'D:\Backups\infohub-before-update.infohub' --confirm 恢复并替换
Remove-Item Env:INFOHUB_BACKUP_PASSWORD
```

恢复到已有实例时还必须设置 `INFOHUB_PASSWORD` 为目标当前密码。脚本与界面调用相同的校验和事务恢复接口。

## 从 0.1 升级到 0.2

0.1 没有整库备份 API，不能直接使用下面的自动升级脚本。首次升级流程：

1. 停止应用写入并保留 0.1 程序或镜像。
2. 对旧 PostgreSQL 做可恢复快照或 `pg_dump`，同时快照 `LOCAL_STORAGE_PATH`；使用 R2 时保留对应对象。数据库与文件快照必须来自同一停写时间。
3. 先把快照恢复到隔离数据库和独立文件目录，用 0.2 启动，检查数量、附件字节、凭证解密及图片。仓库提供旧存储迁移验收，不能替代自己的数据演练。
4. 实际服务替换为 0.2，指向原有 PG 和文件目录，等待迁移与健康检查完成。
5. 核对凭证、文章图片和附件，立刻导出第一份 0.2 加密备份。

如需回退，停止 0.2，用旧快照恢复到独立数据位置，再运行 0.1。不要让旧程序直接使用已经迁移到 0.2 的数据库，也不要手动删除迁移记录。

## 0.2 之后的镜像升级与回退

`scripts/release-ops.mjs upgrade` 适用于已支持整库备份的版本，以及采用 `INFOHUB_IMAGE` 变量的 Compose 部署。需要 Node、Docker、当前主密码和明确版本标签/摘要。

```text
node scripts/release-ops.mjs upgrade --image ghcr.io/your-account/zhi-stack:0.2.0 --compose compose.yaml --env-file .env --base https://infohub.example.com --backup-dir ./private-backups
```

该脚本先完成加密备份并写出恢复记录，之后拉取镜像，将实际镜像 ID 用于 Compose，仅更新 app 服务，等待目标版本健康检查。自定义标签或摘要需增加 `--expect-version 0.2.0`。它不会清理旧镜像、数据库或文件卷。首次从 0.1 升级应按上一节操作。

升级失败时保留恢复记录；不自动把旧程序接回新结构的数据库。用记录中的 `oldImage` 在独立 PG、文件目录和端口启动原版本的空实例，然后执行：

```text
node scripts/release-ops.mjs rollback --record ./private-backups/record.json --recovery-url http://127.0.0.1:3211 --confirm 恢复并替换
```

设置 `INFOHUB_BACKUP_PASSWORD` 后运行。脚本核对备份 SHA-256、目标版本和空工作台状态，恢复完成后再由部署者验证并切换客户端地址或反向代理。备份移动位置时可加 `--file NEW_PATH`。这保留了升级后原实例，便于核对升级期间的新数据。

## 后台任务、订阅与存储

- 收录队列在 PG 持久化，每个工作台串行执行，最多 100 个待处理任务。文章与仓库可以在客户端关闭后继续；自动识别和 OpenAPI 的输入及结果加密，重启后等待已登录的解锁会话。提交重试携带同一请求编号，不重复创建任务。
- 采集完成的主资产和任务检查点同时提交；重启后继续处理文中仓库。取消不删除已经完成提交的资料。阶段表示实际步骤，不显示虚构百分比。
- 仓库订阅每 1–168 小时检查版本与推送；默认 24 小时。未读状态与笔记独立，检查不会覆盖 README 或实践笔记。每仓库保留最近 100 次检查，界面展示最近 20 次。
- GitHub 默认 API 为 `https://api.github.com`。`GITHUB_API_BASE` 仅在使用受信任的兼容 API 网关或隔离验收服务时设置；若设置了 `GITHUB_TOKEN`，请求会带给该网关。自定义内网网关还需显式加入 `ALLOWED_PRIVATE_HOSTS`。
- 删除资产只是移入回收站；永久删除后无引用文件由清理队列回收。历史版本引用的旧图片会保留。没有引用的暂存文件在宽限期后清理。
- 请求历史加密。当前请求最多接收 8 MiB 响应，历史最多保留前 1 MiB 文本并限制编码大小；较大二进制不会保留在历史，界面会显示截断说明。取消不能撤销已被目标服务执行的写入。

## 发布验收

```text
npm ci
npm run verify:release
```

完整检查需要可建库的测试 PG，通过 `DATABASE_URL` 指定。测试只创建随机命名的隔离数据库和文件目录，不使用现有工作台数据。Windows 还检查 Tauri 单元测试与 Clippy。报告位于 `.local/verification/latest.json`，记录源码摘要和每项退出状态。

在有 Docker 的环境再执行 `npm run verify:release -- --docker`。CI 会运行非 root 容器启动、重启、加密备份和空容器恢复。Windows 打包运行 `scripts/make-release.ps1`，要求当前源码有通过的完整报告，生成安装程序、服务端、前端和校验清单。

浏览器/原生窗口、第二台机器安装、真实云主机/R2、实际参与者试用仍需要对应环境的真实记录。自动化接口检查不能替代这些验收。
