# 功能验收记录

## 2026-09-10 业务功能复查

复查其他业务功能后，已修复列表全量读取、特殊字符搜索、接口地址/表单请求、同步字段丢失、收藏丢弃草稿及旧会话响应干扰。真实 PG 集成 24 组、追加公开 GitHub 后 25 组通过；Rust 13、业务组件 26、请求编译 6、连接/会话 9、Tauri 3 项，共 57 项通过。前端、服务端和桌面程序构建通过，Clippy 与 lint 通过。Chrome 实际验证了调试、收藏草稿、GitHub 同步保留笔记、文章编辑与导出、锁定/解锁、分页及窄屏交互。详情见 [业务复查](business-review.md)。

## 2026-09-10 存储与部署复查

后续复查发现并修复了路径标识、慢删除超时、存储就绪检查、公开目录配置、临时文件回收、默认 CORS 和桌面连接设置等问题。最新执行结果：磁盘集成 22 组、R2 协议集成 23 组、磁盘迁移/恢复 5 组、R2 迁移/启动 4 组；服务端单元测试 9 项、原有 React 组件 22 项、连接和设置 8 项通过。前端构建、lint 和服务端 Clippy 通过，详细证据与外部环境待验项目见 [复查报告](architecture-review.md)。

## 2026-09-10 文件存储改造

附件和文章图片已改存服务器磁盘或 Cloudflare R2，PG 保留元数据及文件清理队列。以下为本次实际执行结果，后面的 2026-09-09 记录保留为历史验收。

| 检查                                         | 结果      |
| -------------------------------------------- | --------- |
| 磁盘存储 + 真实 PG 业务集成                  | 22 组通过 |
| R2 SDK + 本地 S3 签名校验服务 + 真实 PG 集成 | 22 组通过 |
| 旧 PG 文件迁移到磁盘                         | 3 组通过  |
| 旧 PG 文件迁移到 R2 协议服务                 | 3 组通过  |
| 服务端单元测试                               | 9 项通过  |
| Rust 构建、Clippy 全 targets 警告视为错误    | 通过      |

验证了磁盘/R2 实际字节、凭证附件密文、10 MiB 边界、文件丢失及损坏、鉴权与金库锁定、重启持久化、图片重抓清理、级联删除、失败上传不生成附件记录、删除失败的持久重试、回滚孤立文件清理、旧字段移除、原密文迁移及错误存储位置拒绝启动。R2 迁移测试还验证写入失败、读取校验失败时保留 PG 原始文件。

所有测试使用隔离数据库和临时文件目录，结束后清理。未连接真实 Cloudflare 账号，未运行 Docker 或远程部署。配置和复现命令见 [文件存储说明](file-storage.md)。

## 2026-09-09 完整功能验收

验收日期：2026-09-09。环境：Windows、Node.js 22.23.2、Rust stable、真实 PostgreSQL 18.4。设计依据为 dosc/ 的有效规范及用户关于原生窗口的最新要求。

本轮逐项检查并修复问题。完整清单见[逐项功能核查](functional-audit.md)。自动检查全部通过；修复后的完整浏览器点击验收、原生窗口操作仍有环境限制，不能据此认定所有实机操作已通过。

## 实际执行结果

| 检查                                              | 结果                                      |
| ------------------------------------------------- | ----------------------------------------- |
| PostgreSQL 集成测试，含真实 GitHub 抓取           | **21 组通过**                             |
| React 组件交互及异步回归（Vitest / jsdom）        | **22 项通过**                             |
| 请求编码、Header、cURL、各类连接命令              | **4 项通过**                              |
| 服务端加密、网络、OpenAPI、会话单元测试           | **8 项通过**                              |
| 桌面路径、操作名、外部链接协议校验                | **3 项通过**                              |
| TypeScript / Vite 生产构建、oxlint                | 通过                                      |
| 服务端和桌面端 Clippy，全部 targets，警告视为错误 | 通过                                      |
| npm run tauri -- build --debug --no-bundle        | 通过，生成 src-tauri/target/debug/app.exe |

合计 21 组真实 PG 集成检查及 37 项单元/组件检查。组件测试使用模拟 API 和 jsdom，验证实际 React 事件和状态；集成测试验证真实服务、HTTP 请求、PG 数据及持久化。两者不可代替原生 GUI 实测。

集成检查包含 205 条分页、组合筛选、10 MB 附件字节和超限拒绝、凭证密文、各项锁定访问路径、嵌套错误引用、同步新增参数、二进制响应、文章图片级联删除、退出会话、重启持久化、公开 GitHub 元数据与 README。测试独立建库，结束后已清理；业务库保持未初始化，未写入测试账号或资产。

## 本轮浏览器与桌面验证

- 实际登录隔离工作台，打开 PG 凭证，显示密码，点击复制连接命令；锁定后凭证详情移除，能切换文章分类。
- 登录页 DOM 未发现模拟窗口控件，应用宽度铺满视口。源码没有 WindowControls、三色窗口按钮或拖拽区域；Tauri 使用 decorations: true、transparent: false。
- 后续 Chrome 报告扩展 UI 阻止自动化，因此**本轮未完成修复后的全流程浏览器点击及响应式复测**。组件回归不记作浏览器实测。
- Windows GUI 自动化连接报 native pipe 不存在，因此**未实机点击最小化、最大化、关闭，未实际启动 VS Code、终端或文件管理器**。已完成源码检查、路径校验测试及程序构建。
- 产物是嵌入生产前端的 debug 可执行文件；未生成或安装 MSI/NSIS。机器无 Docker，未执行 Compose 部署。

历史设计检查与布局测量见[设计核查](design-review.md)，不作为本轮未执行项目的通过依据。

## 复现命令

```powershell
npm run test:ui
npm run test:request
npm run test:server
cargo test --manifest-path src-tauri/Cargo.toml
npm run lint
cargo clippy --manifest-path server/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run tauri -- build --debug --no-bundle
```

真实 PG 验收需启动 PostgreSQL，并配置有建库权限的 DATABASE_URL：

```powershell
cargo build --manifest-path server/Cargo.toml
$env:RUN_NETWORK_TESTS = '1'
npm run test:integration
```

不设置 RUN_NETWORK_TESTS 时执行 20 组本地集成检查；设置为 1 时增加真实 GitHub 检查。协议模板验证字段、持久化和命令生成，脚本不会连接用户的真实数据库、SSH 或业务 API。
