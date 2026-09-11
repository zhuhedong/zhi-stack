# 设计资料

当前实现采用 **Apple Light Glassmorphism**。规范按以下顺序使用：

产品使用系统原生窗口。HTML 原型里的外围留白、悬浮圆角画框和三色按钮是展示构图，实际应用不复制这些部分；详见 `Style_Design.md` 的产品窗口约定。

| 文件                                                 | 用途与状态                                         |
| ---------------------------------------------------- | -------------------------------------------------- |
| [Style_Design.md](Style_Design.md)                   | 当前有效：颜色、字体、材质、尺寸与窗口交互规范     |
| [infohub_apple_light.html](infohub_apple_light.html) | 当前有效：三栏布局和交互参考；数据及网络操作为演示 |
| [color_palette.html](color_palette.html)             | 历史深色配色，已停用                               |
| [apple_glass_palette.html](apple_glass_palette.html) | 历史深色玻璃材质，已停用                           |

如原型示例文案与正式实现冲突，以用户要求和功能实现为准：服务端使用 PostgreSQL，敏感字段采用 AES-256-GCM 加密，不使用 SQLite。共享样式变量位于根目录 [tokens.css](../tokens.css)，实施约定见 [design.md](../design.md)。

`dosc` 为原始资料目录名，保留以避免已有链接失效。项目说明和验收记录位于 [docs](../docs/README.md)。
