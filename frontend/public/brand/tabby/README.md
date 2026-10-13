# Tabby A2 品牌资产

已批准方案为「A2 队列 T」：六个圆角模块组成 T 与右下尾块。完整符号保持原稿的 16 单位模块、6 单位间隙、2 单位圆角；仅收紧画布留白。所有 Logo SVG 为真实矢量，字标已转换为路径，不依赖已安装字体。

## 网站使用

- 页头、页尾：`/brand/tabby/logo-horizontal-color.svg`（橙色标记、炭黑字标）；单色用途用 `logo-horizontal-black.svg`。水平画布为 `237 × 80`，必须保持比例；标记按字标大写 T 的顶线与基线对齐，不使用 y 下伸部作为对齐边界。
- 独立符号：`/brand/tabby/symbol-color.svg` 或 `symbol-black.svg`，画布 `80 × 80`；建议网页显示 22 px 及以上。
- 深色背景：对应 `*-white.svg` / PNG。Color 版为橙色符号与炭黑字标，wordmark-color 仅含炭黑字标。
- 浏览器：`favicon.svg`，辅以 `favicon-32.png`、`favicon.ico`。favicon 使用暖白固定底，浅色及深色标签页均可辨识。
- iOS / PWA：`apple-touch-icon.png`、`app-icon-192.png`、`app-icon-512.png`；需要系统遮罩裁切时用 `maskable-512.png`。
- 报名头像：`brand-square.png`（1024 px）；透明符号与竖排 Logo 可用于海报或演示。
- 分享卡片：`social-card.png`（1200 × 630），另有完全矢量 SVG。

## 颜色与尺寸

| 用途 | 色值 |
| --- | --- |
| 品牌橙 | `#ff5900` |
| 炭黑 | `#202020` |
| 暖白底 | `#f1f0ee` |
| 反白 | `#ffffff` |

符号清晰区：实际图形外围至少一个模块宽度（16 / 60 图形宽度），网页紧凑页头可由布局补齐。水平 Logo 建议至少 96 px 宽；竖排至少 80 px 宽；字标至少 56 px 宽。favicon 16 px 使用专用像素版：保留全部六个模块，模块 4 px、间隙 1 px、圆角 .5 px；不将完整稿缩得过小。通用 `favicon.png` 为 64 px。

普通 App 图标由平台提供裁切；图形占画布 64%。Maskable 图形占 50%，包含全部圆角模块的外接方形也位于中央直径 80% 的安全圆内。图标与分享卡背景为实色暖白；符号、水平/竖排 Logo、字标 PNG 的背景透明。

使用批准比例与颜色，不拉伸、旋转、拼接模块或添加描边、阴影、渐变。反白文件的几何与批准稿一致，适合深色底。

## 字体许可与重建

字标基于仓库已有 Inter Variable，`wght=550`、`opsz=32`，保留字体 Kerning 并光学收紧字距。字体为 SIL Open Font License 1.1；原许可完整附于 `Inter-LICENSE.txt`。输出 SVG 全部使用轮廓路径，显示无需下载字体。

```sh
python3 -m pip install cairosvg Pillow 'fonttools[woff]'
python3 scripts/generate-tabby-brand.py
```

脚本仅从仓库字体与已批准的几何数据生成资产，无外部 API 调用。资产校验尺寸、透明度、图形与 ICO 尺寸均可从 `asset-manifest.json` 和文件本身复查。PNG 均小于 2 MB。

## 完整文件清单

下表每个基础名均包含 `.svg` 和 `.png` 两种文件；PNG 尺寸列为实际输出尺寸。

| 基础名 | PNG 尺寸 | 背景 |
| --- | --- | --- |
| `symbol-color` | 1024 × 1024 | 透明 |
| `logo-horizontal-color` | 2000 × 675 | 透明 |
| `logo-stacked-color` | 1024 × 1024 | 透明 |
| `wordmark-color` | 2000 × 904 | 透明 |
| `symbol-black` | 1024 × 1024 | 透明 |
| `logo-horizontal-black` | 2000 × 675 | 透明 |
| `logo-stacked-black` | 1024 × 1024 | 透明 |
| `wordmark-black` | 2000 × 904 | 透明 |
| `symbol-white` | 1024 × 1024 | 透明 |
| `logo-horizontal-white` | 2000 × 675 | 透明 |
| `logo-stacked-white` | 1024 × 1024 | 透明 |
| `wordmark-white` | 2000 × 904 | 透明 |
| `favicon-16` | 16 × 16 | 暖白 |
| `favicon-32` | 32 × 32 | 暖白 |
| `favicon-48` | 48 × 48 | 暖白 |
| `favicon` | 64 × 64 | 暖白 |
| `apple-touch-icon` | 180 × 180 | 暖白 |
| `app-icon-192` | 192 × 192 | 暖白 |
| `app-icon-512` | 512 × 512 | 暖白 |
| `maskable-512` | 512 × 512 | 暖白 |
| `brand-square` | 1024 × 1024 | 暖白 |
| `social-card` | 1200 × 630 | 暖白 |

另有 `favicon.ico`（16 / 32 / 48 px）、`asset-manifest.json`（尺寸、用途、SHA-256）、`Inter-LICENSE.txt`（字体原始许可）与本文件。
