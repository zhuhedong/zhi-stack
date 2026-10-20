# InfoHub 样式设计规范 (UI/UX Style Guide)

本规范文档（Design System）确立了 InfoHub 桌面端的视觉契约。全站严格遵循 **Apple Light Glassmorphism (亮色毛玻璃)** 设计语言，通过高度克制的色彩、通透的亚克力材质和极细的物理边框，打造原生极客感。

> 产品窗口约定（按用户反馈修正）：HTML 原型外围的桌面展示留白、悬浮画框和红黄绿按钮仅用于展示，不进入实际应用。浏览器内容铺满视口；Tauri 使用系统原生标题栏和窗口按钮，内容铺满客户区。下述玻璃材质和环境光属于应用内部，不再绘制第二层窗口。

---

## 1. 核心材质系统 (Materials & Textures)

InfoHub 放弃了传统的纯色区块叠加，转而采用“环境光 + 半透明容器 + 物理边框”的三层物理空间叠加逻辑。

### 1.1 环境流光背景 (Ambient Wallpaper)

应用的最底层通过高斯模糊的色块融合产生类似 macOS 的动态屏保效果（在 Tailwind 中通过 `mix-blend-multiply` 融合）。

- **底色 (Base)**: `#f5f5f7` (macOS 默认浅色灰)
- **极光色块**:
  - Indigo: `bg-indigo-300/60 blur-[120px]`
  - Sky Blue: `bg-sky-300/60 blur-[100px]`
  - Pink: `bg-pink-300/60 blur-[80px]`
  - Emerald: `bg-emerald-200/60 blur-[100px]`

### 1.2 亚克力毛玻璃 (Acrylic Glass)

UI 层叠的容器全部使用带有背景模糊的半透明材质，透出底层环境光。

- **主窗体容器**: `bg-white/60` + `backdrop-blur-3xl`
- **次级面板 (侧边栏/列表)**: `bg-white/40` 或 `bg-white/50` + `backdrop-blur-md` 或 `xl`
- **悬停态 (Hover / Active)**: 不再使用白色蒙层，统一使用 `bg-black/5` 到 `bg-black/10` 模拟黑色透明阴影覆盖。

### 1.3 边框与阴影 (Borders & Shadows)

- **微晶边框**: 所有容器、分割线必须使用 `border-black/5` 或 `border-black/10`，营造出极细的物理缝隙（Hairline）。
- **空间投影**: 原型中的主窗口悬浮投影仅用于展示，实际应用外层不添加投影、边框或圆角。弹窗可使用 `shadow-[0_20px_50px_rgba(0,0,0,0.1)]`；内部内容区仅使用极弱的 `shadow-sm`。

---

## 2. 色彩规范 (Color Palette)

系统极其克制对彩色的大面积使用，彩色仅作为状态指示灯、主操作和重要警示的点缀；系统窗口控件由操作系统绘制。

### 2.1 文本色阶 (Typography Colors)

- **Primary (标题/极重要文本)**: `#1d1d1f` 或 `text-black/90`
- **Secondary (正文/二级标题)**: `text-black/80`
- **Tertiary (补充说明/列表摘要)**: `text-black/60`
- **Quaternary (占位符/极次要提示)**: `text-black/40` 或 `text-black/30`

### 2.2 品牌与语义色 (Semantic Colors)

强制采用 Apple 原生标准色标：

- **Apple Blue (品牌主交互色)**: `#007AFF`
  - 用于：主按钮、激活状态图标、活跃链接。
  - 主按钮样式：`bg-[#007AFF] text-white shadow-[0_2px_8px_rgba(0,122,255,0.3)]`
- **Apple Green (成功/安全指示)**: `#34C759` (部分 UI 微调为 `#27C93F` 或 Tailwind `emerald-500`)
  - 用于：金库解锁指示灯、环境就绪 Tag、Mac 绿灯。
- **Apple Yellow (警告/挂起)**: `#FFCC00` (Mac 黄灯调优为 `#FFBD2E`)
- **Apple Red (危险/关闭)**: `#FF3B30` (Mac 红灯调优为 `#FF5F56`)

---

## 3. 字体排版系统 (Typography)

由于是桌面端应用，字体栈 (Font Stack) 必须直接调用操作系统的原生 UI 字体，拒绝引入外部 Web Font 拖累性能。

### 3.1 全局字体栈 (Global Font Family)

```css
font-family:
  -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
```

_（中文字体在 macOS 自动回退到 PingFang SC，Windows 回退到 Microsoft YaHei）_

### 3.2 代码与等宽字体 (Monospace)

用于 API 路径、密码参数、日期、快捷键标记等极客信息展示。

```css
font-family:
  ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
```

### 3.3 字号规范 (Font Sizes)

系统采用小字号极客紧凑排版，一屏内可展示极大信息密度。

- **全局基准字号**: `text-xs` (12px)
- **一级标题 (H1)**: `text-2xl font-bold` (24px)
- **二级标题 (H2)**: `text-sm font-semibold` (14px)
- **标签/徽章/辅助信息**: `text-[10px]` 或 `text-[11px]`

---

## 4. 关键组件原子库 (Component Tokens)

### 4.1 业务工具栏与原生窗口

- **业务工具栏高度**: `h-9` (36px)，放置导航、收录、新建、检索和金库操作。
- **原生窗口**: Tauri 开启系统装饰（`decorations: true`），关闭窗口透明（`transparent: false`）。系统负责标题栏、拖拽、边缘缩放和最小化/最大化/关闭按钮。
- **HTML 内容**: 浏览器和桌面客户区均铺满，不渲染红黄绿窗口按钮，不给业务工具栏添加 `data-tauri-drag-region`。

### 4.2 搜索栏 / 捷径按钮 (Shortcut Inputs)

- **常态**: `bg-white/50 border border-black/10 text-black/60`。
- **悬停态**: `hover:border-black/20 text-black/80`。
- **快捷键标记 (kbd)**: `text-[9px] font-mono opacity-60`。

### 4.3 表单与输入框 (Inputs & Selects)

针对 API 调试台和配置项：

- **底色与边框**: `bg-black/5 border border-black/10 rounded-lg`。
- **焦点态 (Focus)**: 去除默认 outline，通过 `focus:border-[#007AFF]` 提供强交互反馈。

### 4.4 滚动条 (Scrollbar)

彻底隐藏 Windows/浏览器 丑陋的默认滚动条，重写为悬浮静音样式：

```css
::-webkit-scrollbar {
  width: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.1);
  border-radius: 10px;
}
```
