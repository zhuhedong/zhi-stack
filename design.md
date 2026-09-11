# InfoHub 设计系统

本项目统一执行 [dosc/Style_Design.md](dosc/Style_Design.md)。该文件是视觉规范；[亮色原型](dosc/infohub_apple_light.html)提供内容布局参考。按用户最新反馈，原型中的外围展示画框与三色窗口按钮不进入产品。服务端使用 PostgreSQL，原型中的演示数据不作为产品事实。

- 全应用采用 Apple Light Glassmorphism；登录、工作台、弹窗共享同一套材质、色彩和字体。
- 工作台保留三栏结构：208px 导航、320px 列表、最大 768px 内容画布。
- 环境光位于应用内部，玻璃材质和次级面板直接铺满视口；蓝色为主操作色，成功、警告和危险色用于状态。
- 使用原生 UI 字体和系统等宽字体，不下载 Web Font；12px 正文、24px/700 H1、14px/600 H2。
- 业务工具栏高度 36px，不承载系统窗口按钮。桌面采用系统原生标题栏与边框，网页不重复绘制交通灯或模拟窗口。
- 操作反馈使用颜色、清晰的焦点边框及加载状态；不使用装饰性入场动画。减少动态效果时关闭空间动画。
- 小屏允许导航收起、内容单列，保持所有操作可达。所有尺寸下都不添加外围展示留白、外圈圆角或窗口投影。

共享样式变量统一在 [tokens.css](tokens.css)，由 `src/index.css` 导入。其余组件引用变量，不单独选择主题。

## Exports

以下为共享样式变量的移植格式；当前应用直接导入 `tokens.css`，修改规范时以该文件为准。

### CSS

```css
/* InfoHub · canonical tokens from dosc/Style_Design.md · Apple Light Glassmorphism */
:root {
  color-scheme: light;
  --color-paper: #f5f5f7;
  --color-window: rgba(255, 255, 255, 0.6);
  --color-sidebar: rgba(255, 255, 255, 0.5);
  --color-list: rgba(255, 255, 255, 0.5);
  --color-panel: rgba(255, 255, 255, 0.4);
  --color-raised: rgba(0, 0, 0, 0.05);
  --color-input: rgba(0, 0, 0, 0.05);
  --color-border: rgba(0, 0, 0, 0.1);
  --color-line: rgba(0, 0, 0, 0.05);
  --color-hover: rgba(0, 0, 0, 0.1);
  --color-border-hover: rgba(0, 0, 0, 0.2);
  --color-text: rgba(0, 0, 0, 0.8);
  --color-strong: #1d1d1f;
  --color-muted: rgba(0, 0, 0, 0.6);
  --color-faint: rgba(0, 0, 0, 0.4);
  --color-accent: #007aff;
  --color-accent-hover: #0066d6;
  --color-accent-ink: #fff;
  --color-blue-text: #007aff;
  --color-blue-tint: rgba(0, 122, 255, 0.08);
  --color-good: #34c759;
  --color-good-ink: #216e39;
  --color-green-tint: rgba(52, 199, 89, 0.1);
  --color-amber: #ffcc00;
  --color-amber-ink: #805b00;
  --color-amber-tint: rgba(255, 204, 0, 0.12);
  --color-danger: #ff3b30;
  --color-danger-ink: #b4231b;
  --color-danger-fill: var(--color-danger);
  --color-rose: var(--color-danger-ink);
  --color-rose-tint: rgba(255, 59, 48, 0.08);
  --color-backdrop: rgba(29, 29, 31, 0.24);
  --color-dialog: rgba(255, 255, 255, 0.9);
  --color-transparent: transparent;
  --color-white: #fff;
  --color-wallpaper-indigo: rgba(165, 180, 252, 0.6);
  --color-wallpaper-sky: rgba(125, 211, 252, 0.6);
  --color-wallpaper-pink: rgba(249, 168, 212, 0.6);
  --color-wallpaper-emerald: rgba(167, 243, 208, 0.6);
  --font-body:
    -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-display: var(--font-body);
  --font-mono:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  --text-base: 12px;
  --text-h1: 24px;
  --text-h2: 14px;
  --text-small: 11px;
  --text-caption: 10px;
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --space-xl: 24px;
  --space-2xl: 32px;
  --radius: 8px;
  --radius-card: 12px;
  --radius-scrollbar: 10px;
  --app-header-height: 36px;
  --toolbar-height: 40px;
  --sidebar-width: 208px;
  --list-width: 320px;
  --canvas-width: 768px;
  --blur-window: 64px;
  --blur-sidebar: 12px;
  --blur-panel: 24px;
  --shadow-window: 0 20px 50px rgba(0, 0, 0, 0.1);
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-primary: 0 2px 8px rgba(0, 122, 255, 0.3);
  --z-raised: 10;
  --z-overlay: 100;
  --z-toast: 500;
  --duration: 120ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
}
```

### Tailwind v4

复制至目标项目的 Tailwind 样式入口。

```css
@theme {
  --color-paper: #f5f5f7;
  --color-window: rgba(255, 255, 255, 0.6);
  --color-sidebar: rgba(255, 255, 255, 0.5);
  --color-list: rgba(255, 255, 255, 0.5);
  --color-panel: rgba(255, 255, 255, 0.4);
  --color-raised: rgba(0, 0, 0, 0.05);
  --color-input: rgba(0, 0, 0, 0.05);
  --color-border: rgba(0, 0, 0, 0.1);
  --color-line: rgba(0, 0, 0, 0.05);
  --color-hover: rgba(0, 0, 0, 0.1);
  --color-border-hover: rgba(0, 0, 0, 0.2);
  --color-text: rgba(0, 0, 0, 0.8);
  --color-strong: #1d1d1f;
  --color-muted: rgba(0, 0, 0, 0.6);
  --color-faint: rgba(0, 0, 0, 0.4);
  --color-accent: #007aff;
  --color-accent-hover: #0066d6;
  --color-accent-ink: #fff;
  --color-blue-text: #007aff;
  --color-blue-tint: rgba(0, 122, 255, 0.08);
  --color-good: #34c759;
  --color-good-ink: #216e39;
  --color-green-tint: rgba(52, 199, 89, 0.1);
  --color-amber: #ffcc00;
  --color-amber-ink: #805b00;
  --color-amber-tint: rgba(255, 204, 0, 0.12);
  --color-danger: #ff3b30;
  --color-danger-ink: #b4231b;
  --color-danger-fill: #ff3b30;
  --color-rose: #b4231b;
  --color-rose-tint: rgba(255, 59, 48, 0.08);
  --color-backdrop: rgba(29, 29, 31, 0.24);
  --color-dialog: rgba(255, 255, 255, 0.9);
  --color-transparent: transparent;
  --color-white: #fff;
  --color-wallpaper-indigo: rgba(165, 180, 252, 0.6);
  --color-wallpaper-sky: rgba(125, 211, 252, 0.6);
  --color-wallpaper-pink: rgba(249, 168, 212, 0.6);
  --color-wallpaper-emerald: rgba(167, 243, 208, 0.6);
  --font-body:
    -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-display:
    -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-mono:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  --text-base: 12px;
  --text-h1: 24px;
  --text-h2: 14px;
  --text-small: 11px;
  --text-caption: 10px;
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 12px;
  --spacing-lg: 16px;
  --spacing-xl: 24px;
  --spacing-2xl: 32px;
  --radius-card: 12px;
  --radius-scrollbar: 10px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
}
```

### DTCG JSON

颜色保留透明度和 sRGB 分量；布局尺寸、字体与缓动采用具名类型。

```json
{
  "color-paper": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.9607843137254902, 0.9607843137254902, 0.9686274509803922],
      "alpha": 1
    }
  },
  "color-window": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [1, 1, 1],
      "alpha": 0.6
    }
  },
  "color-sidebar": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [1, 1, 1],
      "alpha": 0.5
    }
  },
  "color-list": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [1, 1, 1],
      "alpha": 0.5
    }
  },
  "color-panel": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [1, 1, 1],
      "alpha": 0.4
    }
  },
  "color-raised": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0, 0],
      "alpha": 0.05
    }
  },
  "color-input": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0, 0],
      "alpha": 0.05
    }
  },
  "color-border": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0, 0],
      "alpha": 0.1
    }
  },
  "color-line": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0, 0],
      "alpha": 0.05
    }
  },
  "color-hover": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0, 0],
      "alpha": 0.1
    }
  },
  "color-border-hover": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0, 0],
      "alpha": 0.2
    }
  },
  "color-text": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0, 0],
      "alpha": 0.8
    }
  },
  "color-strong": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.11372549019607843, 0.11372549019607843, 0.12156862745098039],
      "alpha": 1
    }
  },
  "color-muted": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0, 0],
      "alpha": 0.6
    }
  },
  "color-faint": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0, 0],
      "alpha": 0.4
    }
  },
  "color-accent": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0.47843137254901963, 1],
      "alpha": 1
    }
  },
  "color-accent-hover": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0.4, 0.8392156862745098],
      "alpha": 1
    }
  },
  "color-accent-ink": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [1, 1, 1],
      "alpha": 1
    }
  },
  "color-blue-text": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0.47843137254901963, 1],
      "alpha": 1
    }
  },
  "color-blue-tint": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0.47843137254901963, 1],
      "alpha": 0.08
    }
  },
  "color-good": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.20392156862745098, 0.7803921568627451, 0.34901960784313724],
      "alpha": 1
    }
  },
  "color-good-ink": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.12941176470588237, 0.43137254901960786, 0.2235294117647059],
      "alpha": 1
    }
  },
  "color-green-tint": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.20392156862745098, 0.7803921568627451, 0.34901960784313724],
      "alpha": 0.1
    }
  },
  "color-amber": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [1, 0.8, 0],
      "alpha": 1
    }
  },
  "color-amber-ink": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.5019607843137255, 0.3568627450980392, 0],
      "alpha": 1
    }
  },
  "color-amber-tint": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [1, 0.8, 0],
      "alpha": 0.12
    }
  },
  "color-danger": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [1, 0.23137254901960785, 0.18823529411764706],
      "alpha": 1
    }
  },
  "color-danger-ink": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.7058823529411765, 0.13725490196078433, 0.10588235294117647],
      "alpha": 1
    }
  },
  "color-danger-fill": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [1, 0.23137254901960785, 0.18823529411764706],
      "alpha": 1
    }
  },
  "color-rose": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.7058823529411765, 0.13725490196078433, 0.10588235294117647],
      "alpha": 1
    }
  },
  "color-rose-tint": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [1, 0.23137254901960785, 0.18823529411764706],
      "alpha": 0.08
    }
  },
  "color-backdrop": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.11372549019607843, 0.11372549019607843, 0.12156862745098039],
      "alpha": 0.24
    }
  },
  "color-dialog": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [1, 1, 1],
      "alpha": 0.9
    }
  },
  "color-transparent": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0, 0, 0],
      "alpha": 0
    }
  },
  "color-white": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [1, 1, 1],
      "alpha": 1
    }
  },
  "color-wallpaper-indigo": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.6470588235294118, 0.7058823529411765, 0.9882352941176471],
      "alpha": 0.6
    }
  },
  "color-wallpaper-sky": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.49019607843137253, 0.8274509803921568, 0.9882352941176471],
      "alpha": 0.6
    }
  },
  "color-wallpaper-pink": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.9764705882352941, 0.6588235294117647, 0.8313725490196079],
      "alpha": 0.6
    }
  },
  "color-wallpaper-emerald": {
    "$type": "color",
    "$value": {
      "colorSpace": "srgb",
      "components": [0.6549019607843137, 0.9529411764705882, 0.8156862745098039],
      "alpha": 0.6
    }
  },
  "font-body": {
    "$type": "fontFamily",
    "$value": [
      "-apple-system",
      "BlinkMacSystemFont",
      "SF Pro Display",
      "Segoe UI",
      "Roboto",
      "Helvetica",
      "Arial",
      "sans-serif"
    ]
  },
  "font-display": {
    "$type": "fontFamily",
    "$value": [
      "-apple-system",
      "BlinkMacSystemFont",
      "SF Pro Display",
      "Segoe UI",
      "Roboto",
      "Helvetica",
      "Arial",
      "sans-serif"
    ]
  },
  "font-mono": {
    "$type": "fontFamily",
    "$value": [
      "ui-monospace",
      "SFMono-Regular",
      "Menlo",
      "Monaco",
      "Consolas",
      "Liberation Mono",
      "Courier New",
      "monospace"
    ]
  },
  "text-base": {
    "$type": "dimension",
    "$value": {
      "value": 12,
      "unit": "px"
    }
  },
  "text-h1": {
    "$type": "dimension",
    "$value": {
      "value": 24,
      "unit": "px"
    }
  },
  "text-h2": {
    "$type": "dimension",
    "$value": {
      "value": 14,
      "unit": "px"
    }
  },
  "text-small": {
    "$type": "dimension",
    "$value": {
      "value": 11,
      "unit": "px"
    }
  },
  "text-caption": {
    "$type": "dimension",
    "$value": {
      "value": 10,
      "unit": "px"
    }
  },
  "space-xs": {
    "$type": "dimension",
    "$value": {
      "value": 4,
      "unit": "px"
    }
  },
  "space-sm": {
    "$type": "dimension",
    "$value": {
      "value": 8,
      "unit": "px"
    }
  },
  "space-md": {
    "$type": "dimension",
    "$value": {
      "value": 12,
      "unit": "px"
    }
  },
  "space-lg": {
    "$type": "dimension",
    "$value": {
      "value": 16,
      "unit": "px"
    }
  },
  "space-xl": {
    "$type": "dimension",
    "$value": {
      "value": 24,
      "unit": "px"
    }
  },
  "space-2xl": {
    "$type": "dimension",
    "$value": {
      "value": 32,
      "unit": "px"
    }
  },
  "radius": {
    "$type": "dimension",
    "$value": {
      "value": 8,
      "unit": "px"
    }
  },
  "radius-card": {
    "$type": "dimension",
    "$value": {
      "value": 12,
      "unit": "px"
    }
  },
  "radius-scrollbar": {
    "$type": "dimension",
    "$value": {
      "value": 10,
      "unit": "px"
    }
  },
  "ease-out": {
    "$type": "cubicBezier",
    "$value": [0.16, 1, 0.3, 1]
  },
  "ease-in": {
    "$type": "cubicBezier",
    "$value": [0.7, 0, 0.84, 0]
  },
  "ease-in-out": {
    "$type": "cubicBezier",
    "$value": [0.65, 0, 0.35, 1]
  }
}
```

### shadcn/ui 变量映射

以下供使用 `oklch(var(--primary))` 读取颜色的项目，已保留玻璃材质透明度。

```css
:root {
  --background: 97.0714% 0.00265 286.3504;
  --foreground: 23.1576% 0.003805 286.0989;
  --card: 100% 0 0 / 0.4;
  --card-foreground: 23.1576% 0.003805 286.0989;
  --popover: 100% 0 0 / 0.9;
  --popover-foreground: 23.1576% 0.003805 286.0989;
  --primary: 60.2765% 0.217712 257.4239;
  --primary-foreground: 100% 0 0;
  --secondary: 0% 0 0 / 0.05;
  --secondary-foreground: 0% 0 0 / 0.8;
  --muted: 0% 0 0 / 0.05;
  --muted-foreground: 0% 0 0 / 0.6;
  --accent: 60.2765% 0.217712 257.4239;
  --accent-foreground: 100% 0 0;
  --destructive: 65.4215% 0.232135 28.6592;
  --destructive-foreground: 100% 0 0;
  --border: 0% 0 0 / 0.1;
  --input: 0% 0 0 / 0.1;
  --ring: 60.2765% 0.217712 257.4239;
  --radius: 8px;
}
```
