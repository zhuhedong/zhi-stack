# 桌面客户端自动打包与发布

工作流：`.github/workflows/desktop-release.yml`，基于 Tauri 2（`tauri` 2.11 / `@tauri-apps/cli` 2.11），使用 `tauri-apps/tauri-action@v0`。

| 触发 | 做什么 |
| --- | --- |
| 推送 `v*` 标签 | 四个平台全量打包，创建/更新同名 **草稿** Release 并上传安装包 |
| 手动运行（Actions → Desktop release → Run workflow） | 四个平台全量打包，安装包作为工作流 Artifacts 上传（保留 90 天） |
| PR 修改了 `src-tauri/`、`src/`、`package*.json` 或本工作流 | 只在 Linux 上做一次 `tauri build --no-bundle` 编译检查，不打包不发布 |

产物：

| 平台 | 产物 |
| --- | --- |
| macOS arm64（`aarch64-apple-darwin`） | `.dmg`、`.app.tar.gz` |
| macOS x64（`x86_64-apple-darwin`） | `.dmg`、`.app.tar.gz` |
| Windows x64 | `.msi`、`-setup.exe`（NSIS） |
| Linux x64（ubuntu-22.04 构建，依赖 webkit2gtk-4.1） | `.deb`、`.AppImage` |

## 发布步骤

1. 同步修改三处版本号（必须一致，工作流第一步会检查，不一致直接失败）：
   - `package.json` 的 `version`
   - `src-tauri/tauri.conf.json` 的 `version`
   - `src-tauri/Cargo.toml` 的 `version`（顺手 `cargo update -p app --manifest-path src-tauri/Cargo.toml` 更新锁文件）
2. 提交并合并到 main，然后打标签，**标签必须是 `v` + 版本号**：
   ```bash
   git tag v0.2.3
   git push origin v0.2.3
   ```
3. 等 Actions 跑完（约 20–30 分钟），到 **Releases** 页面找到草稿 `v0.2.3`，检查安装包，编辑说明后点 **Publish release**。
4. 下载地址：`https://github.com/zhuhedong/zhi-stack/releases/latest`（只指向已发布、非草稿的最新 Release）。

同一个标签重跑工作流会更新同一个草稿 Release，不会重复创建。

## 介绍页下载按钮

服务端 `WEB_UI=landing` 时，建议在 `.env` 里设置：

```
LANDING_DOWNLOAD_URL=https://github.com/zhuhedong/zhi-stack/releases/latest
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
