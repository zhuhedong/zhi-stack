# 桌面客户端自动打包与发布

工作流：`.github/workflows/desktop-release.yml`，基于 Tauri 2（`tauri` 2.11 / `@tauri-apps/cli` 2.11），使用 `tauri-apps/tauri-action@v0`。

| 触发 | 做什么 |
| --- | --- |
| 推送到 main | 读取版本号；如果 `v<版本号>` 还没有发布，四个平台打包并**自动发布** Release（附自动生成的更新说明）；已经发布过（没有改版本号）就只跑几秒的检查，直接跳过 |
| 手动推送 `v*` 标签 | 同上，标签必须等于 `v<版本号>` |
| 手动运行（Actions → Desktop release → Run workflow） | 四个平台打包，安装包作为工作流 Artifacts 上传（保留 90 天）；勾选 `release` 时同时发布 Release；`tag` 可填 `v0.0.0-ci-test` 这类带 `-` 的测试标签，会发布成预发布版本 |
| PR 修改了 `src-tauri/`、`src/`、`package*.json` 或本工作流 | 只在 Linux 上做一次 `tauri build --no-bundle` 编译检查，不打包不发布 |

发布过程：先创建**草稿** Release，四个平台都成功后，最后一个 job 才把它改为已发布（此时才创建标签）。任何平台失败，草稿保留、运行失败；修复后再推一次 main（或重跑）会复用这个草稿，并清理掉旧的安装包。

标签由工作流用 `GITHUB_TOKEN` 创建，GitHub 不会因此再触发新的运行，所以不会重复打包。同一个提交的 main 推送和标签推送会排队执行，后执行的那次看到已发布就跳过。

产物：

| 平台 | 产物 |
| --- | --- |
| macOS arm64（`aarch64-apple-darwin`） | `.dmg`、`.app.tar.gz` |
| macOS x64（`x86_64-apple-darwin`） | `.dmg`、`.app.tar.gz` |
| Windows x64 | `.msi`、`-setup.exe`（NSIS） |
| Linux x64（ubuntu-22.04 构建，依赖 webkit2gtk-4.1） | `.deb`、`.AppImage` |

## 发布步骤

1. 改版本号（三处必须一致，不一致工作流直接失败）：
   ```bash
   npm run version:bump 0.2.3
   ```
   它会同时改 `package.json`（和锁文件）、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`（和锁文件）。
2. 提交、开 PR、合并到 main。
3. 等 Actions 跑完（约 10–20 分钟），**Releases** 页面就会出现已发布的 `v0.2.3`，不需要手动操作。
4. 下载地址：`https://github.com/zhuhedong/zhi-stack/releases/latest`。

## 介绍页下载按钮

服务端 `WEB_UI=landing` 时，建议在 `.env` 里设置：

```
# 无需设置：介绍页按钮默认进入 /download，发布流程会额外上传不带版本号的
# InfoHub_macos_aarch64.dmg 等文件，releases/latest/download/<文件名> 始终指向最新版
```

然后 `docker compose up -d` 重启。注意：服务器在中国大陆时，访问者打开 GitHub 可能较慢。

## 代码签名（可选）

不配置任何 Secret 也能构建，只是安装包未签名：macOS 会提示“无法验证开发者”（右键 → 打开，或 `xattr -dr com.apple.quarantine InfoHub.app`），Windows SmartScreen 会提示未知发布者。

在仓库 **Settings → Secrets and variables → Actions** 中添加（存在才会启用）：

| Secret | 用途 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 证书导出的 `.p12`，再 `base64` 编码 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_SIGNING_IDENTITY` | 如 `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 公证用：Apple ID、App 专用密码、团队 ID（三者都有才公证） |
| `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri 更新器签名密钥（`npx tauri signer generate` 生成）。目前项目没有启用 updater 插件，预留给以后自动更新使用 |

Windows 代码签名未接入：需要购买代码签名证书（或使用 Azure Trusted Signing），再在 `tauri.conf.json` 的 `bundle.windows` 中配置，届时再扩展工作流。

需要 Apple 开发者账号（年费）才能签名和公证 macOS 安装包。
